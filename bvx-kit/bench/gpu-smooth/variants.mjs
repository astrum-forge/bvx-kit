/**
 * WGSL generator for the smooth-mesher compute benchmark.
 *
 * `makeWgsl(opts)` emits the shipped shader (all options false) or one of the
 * variants under test, so every measurement runs the same host code against the
 * same buffers and only the kernel text differs.
 *
 * Options:
 *   tiles       - workgroups per chunk for the data-parallel passes. 1 reproduces
 *                 the shipped one-workgroup-per-chunk shape; higher values flatten
 *                 the grid-stride loop across more workgroups. scan_cells always
 *                 runs one workgroup per chunk - its prefix sum needs the whole
 *                 chunk in one workgroup.
 *   branchless  - replace the 12 per-edge `if` blocks in mark_cells with masked
 *                 arithmetic. Bit-identical: a non-crossing edge contributes an
 *                 exact 0.0, and the divide is guarded so a zero denominator
 *                 cannot produce a NaN to multiply by.
 *   descIndex   - replace descAt's four-way if chain with a dynamic vector index.
 *   wgAtomic    - aggregate emit_quads' index reservation in workgroup memory and
 *                 issue one device atomic per workgroup instead of one per quad.
 *   pingpong    - emit the reversed blur entry points so the host can drop
 *                 copy_back on even pass counts.
 */

const HEADER = `
const FIELD_DIMS  : u32 = 24u;
const FIELD_SIZE  : u32 = 13824u;
const CELL_DIMS   : u32 = 17u;
const MAX_CELLS   : u32 = 4913u;
const MAX_INDICES : u32 = 78336u;
const CHUNK_DIMS  : i32 = 16;
const ISO         : f32 = 0.5;
const SCALE       : f32 = 0.25;
const MAX_BATCH   : u32 = 64u;
const DESC_VEC4S  : u32 = 8u;
const SCRATCH_STRIDE : u32 = 29478u;
const NO_VERTEX : u32 = 0xFFFFFFFFu;

struct Params {
  chunkCount : u32,
  margin     : u32,
  maxDim     : u32,
  flipped    : u32,
};

@group(0) @binding(0) var<uniform>             params    : Params;
@group(0) @binding(1) var<uniform>             desc      : array<vec4<i32>, 512>;
@group(0) @binding(2) var<storage, read>       occupancy : array<u32>;
@group(0) @binding(3) var<storage, read_write> field     : array<f32>;
@group(0) @binding(4) var<storage, read_write> scratch   : array<f32>;
@group(0) @binding(5) var<storage, read_write> cellSlot  : array<u32>;
@group(0) @binding(6) var<storage, read_write> vertices  : array<f32>;
@group(0) @binding(7) var<storage, read_write> normals   : array<f32>;
@group(0) @binding(8) var<storage, read_write> indices   : array<u32>;
@group(0) @binding(9) var<storage, read_write> counts    : array<atomic<u32>>;
`;

const DESC_BRANCHED = `
fn descAt(chunk: u32, slot: u32) -> i32 {
  let v = desc[chunk * DESC_VEC4S + (slot >> 2u)];
  let c = slot & 3u;
  if (c == 0u) { return v.x; }
  if (c == 1u) { return v.y; }
  if (c == 2u) { return v.z; }
  return v.w;
}
`;

const DESC_INDEXED = `
fn descAt(chunk: u32, slot: u32) -> i32 {
  return desc[chunk * DESC_VEC4S + (slot >> 2u)][slot & 3u];
}
`;

function sampleField(tiles) {
    return `
@compute @workgroup_size(256)
fn sample_field(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let margin = i32(params.margin);
  let maxDim = i32(params.maxDim);
  let fieldBase = chunk * FIELD_SIZE;

  var i = (wg.x * 256u) + lid.x;
  loop {
    if (i >= FIELD_SIZE) { break; }

    let fx = i32(i / (FIELD_DIMS * FIELD_DIMS));
    let fy = i32((i / FIELD_DIMS) % FIELD_DIMS);
    let fz = i32(i % FIELD_DIMS);

    var value = 0.0;

    if (fx < maxDim && fy < maxDim && fz < maxDim) {
      let sx = fx - margin;
      let sy = fy - margin;
      let sz = fz - margin;

      let cx = sx >> 4u;
      let cy = sy >> 4u;
      let cz = sz >> 4u;
      let lx = u32(sx & 15);
      let ly = u32(sy & 15);
      let lz = u32(sz & 15);

      let slot = ((cx + 1) * 3 + (cy + 1)) * 3 + (cz + 1);
      let arena = descAt(chunk, u32(slot));

      if (arena >= 0) {
        let index = ((lx >> 2u) << 10u) | ((ly >> 2u) << 8u) | ((lz >> 2u) << 6u)
                  | ((lx & 3u) << 4u) | ((ly & 3u) << 2u) | (lz & 3u);
        let word = occupancy[u32(arena) * 128u + (index >> 5u)];

        if (((word >> (index & 31u)) & 1u) != 0u) { value = 1.0; }
      }
    }

    field[fieldBase + i] = value;
    i = i + ${tiles * 256}u;
  }
}
`;
}

function blur(tiles, pingpong) {
    const body = `
fn blur_axis(chunk: u32, start: u32, axis: u32, readTmp: bool) {
  let base = chunk * FIELD_SIZE;
  let sbase = chunk * SCRATCH_STRIDE;
  let maxDim = params.maxDim;
  let last = maxDim - 1u;
  let total = maxDim * maxDim * maxDim;

  var stride = 1u;
  if (axis == 0u) { stride = FIELD_DIMS * FIELD_DIMS; }
  else if (axis == 1u) { stride = FIELD_DIMS; }

  var n = start;
  loop {
    if (n >= total) { break; }

    let x = n / (maxDim * maxDim);
    let y = (n / maxDim) % maxDim;
    let z = n % maxDim;

    var coord = z;
    if (axis == 0u) { coord = x; }
    else if (axis == 1u) { coord = y; }

    let local = ((x * FIELD_DIMS) + y) * FIELD_DIMS + z;
    let index = base + local;
    let sindex = sbase + local;

    var prev = stride;
    var next = stride;
    if (coord == 0u) { prev = 0u; }
    if (coord == last) { next = 0u; }

    if (readTmp) {
      field[index] = (0.25 * scratch[sindex - prev]) + (0.5 * scratch[sindex]) + (0.25 * scratch[sindex + next]);
    } else {
      scratch[sindex] = (0.25 * field[index - prev]) + (0.5 * field[index]) + (0.25 * field[index + next]);
    }

    n = n + ${tiles * 256}u;
  }
}

@compute @workgroup_size(256)
fn blur_x(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, 0u, false);
}

@compute @workgroup_size(256)
fn blur_y(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, 1u, true);
}

@compute @workgroup_size(256)
fn blur_z(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, 2u, false);
}

@compute @workgroup_size(256)
fn copy_back(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let base = wg.y * FIELD_SIZE;
  let sbase = wg.y * SCRATCH_STRIDE;

  var i = (wg.x * 256u) + lid.x;
  loop {
    if (i >= FIELD_SIZE) { break; }
    field[base + i] = scratch[sbase + i];
    i = i + ${tiles * 256}u;
  }
}
`;

    // reversed direction entry points, so an even number of blur passes can land
    // back in `field` with no copy_back at all
    const reversed = pingpong ? `
@compute @workgroup_size(256)
fn blur_x_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, 0u, true);
}

@compute @workgroup_size(256)
fn blur_y_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, 1u, false);
}

@compute @workgroup_size(256)
fn blur_z_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, 2u, true);
}
` : "";

    return body + reversed;
}

const MARK_BRANCHED = `
    if ((f0 >= ISO) != (f1 >= ISO)) { px = px + (ISO - f0) / (f1 - f0); crossings = crossings + 1.0; }
    if ((f2 >= ISO) != (f3 >= ISO)) { px = px + (ISO - f2) / (f3 - f2); py = py + 1.0; crossings = crossings + 1.0; }
    if ((f4 >= ISO) != (f5 >= ISO)) { px = px + (ISO - f4) / (f5 - f4); pz = pz + 1.0; crossings = crossings + 1.0; }
    if ((f6 >= ISO) != (f7 >= ISO)) { px = px + (ISO - f6) / (f7 - f6); py = py + 1.0; pz = pz + 1.0; crossings = crossings + 1.0; }

    if ((f0 >= ISO) != (f2 >= ISO)) { py = py + (ISO - f0) / (f2 - f0); crossings = crossings + 1.0; }
    if ((f1 >= ISO) != (f3 >= ISO)) { py = py + (ISO - f1) / (f3 - f1); px = px + 1.0; crossings = crossings + 1.0; }
    if ((f4 >= ISO) != (f6 >= ISO)) { py = py + (ISO - f4) / (f6 - f4); pz = pz + 1.0; crossings = crossings + 1.0; }
    if ((f5 >= ISO) != (f7 >= ISO)) { py = py + (ISO - f5) / (f7 - f5); px = px + 1.0; pz = pz + 1.0; crossings = crossings + 1.0; }

    if ((f0 >= ISO) != (f4 >= ISO)) { pz = pz + (ISO - f0) / (f4 - f0); crossings = crossings + 1.0; }
    if ((f1 >= ISO) != (f5 >= ISO)) { pz = pz + (ISO - f1) / (f5 - f1); px = px + 1.0; crossings = crossings + 1.0; }
    if ((f2 >= ISO) != (f6 >= ISO)) { pz = pz + (ISO - f2) / (f6 - f2); py = py + 1.0; crossings = crossings + 1.0; }
    if ((f3 >= ISO) != (f7 >= ISO)) { pz = pz + (ISO - f3) / (f7 - f3); px = px + 1.0; py = py + 1.0; crossings = crossings + 1.0; }
`;

// Masked form of the same twelve edges. Every term is multiplied by a 0/1 cross
// flag, so a non-crossing edge contributes exactly 0.0 and the running sums stay
// bit-identical to the branched version. The divide is guarded: a zero denominator
// is replaced by 1.0 before the division, so no NaN is ever produced to multiply by.
const MARK_BRANCHLESS = `
    let s0 = select(0.0, 1.0, f0 >= ISO);
    let s1 = select(0.0, 1.0, f1 >= ISO);
    let s2 = select(0.0, 1.0, f2 >= ISO);
    let s3 = select(0.0, 1.0, f3 >= ISO);
    let s4 = select(0.0, 1.0, f4 >= ISO);
    let s5 = select(0.0, 1.0, f5 >= ISO);
    let s6 = select(0.0, 1.0, f6 >= ISO);
    let s7 = select(0.0, 1.0, f7 >= ISO);

    let c01 = abs(s0 - s1); let c23 = abs(s2 - s3); let c45 = abs(s4 - s5); let c67 = abs(s6 - s7);
    let c02 = abs(s0 - s2); let c13 = abs(s1 - s3); let c46 = abs(s4 - s6); let c57 = abs(s5 - s7);
    let c04 = abs(s0 - s4); let c15 = abs(s1 - s5); let c26 = abs(s2 - s6); let c37 = abs(s3 - s7);

    px = px + (c01 * safeT(f0, f1));
    px = px + (c23 * safeT(f2, f3)); py = py + c23;
    px = px + (c45 * safeT(f4, f5)); pz = pz + c45;
    px = px + (c67 * safeT(f6, f7)); py = py + c67; pz = pz + c67;

    py = py + (c02 * safeT(f0, f2));
    py = py + (c13 * safeT(f1, f3)); px = px + c13;
    py = py + (c46 * safeT(f4, f6)); pz = pz + c46;
    py = py + (c57 * safeT(f5, f7)); px = px + c57; pz = pz + c57;

    pz = pz + (c04 * safeT(f0, f4));
    pz = pz + (c15 * safeT(f1, f5)); px = px + c15;
    pz = pz + (c26 * safeT(f2, f6)); py = py + c26;
    pz = pz + (c37 * safeT(f3, f7)); px = px + c37; py = py + c37;

    crossings = c01 + c23 + c45 + c67 + c02 + c13 + c46 + c57 + c04 + c15 + c26 + c37;
`;

const SAFE_T = `
fn safeT(a: f32, b: f32) -> f32 {
  let d = b - a;
  return (ISO - a) / select(1.0, d, d != 0.0);
}
`;

function markCells(tiles, branchless) {
    return `
@compute @workgroup_size(256)
fn mark_cells(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let fieldBase = chunk * FIELD_SIZE;
  let cellBase = chunk * MAX_CELLS;
  let margin = i32(params.margin);
  let fd = i32(FIELD_DIMS);
  let plane = fd * fd;

  var c = (wg.x * 256u) + lid.x;
  loop {
    if (c >= MAX_CELLS) { break; }

    let cx = i32(c / (CELL_DIMS * CELL_DIMS)) - 1;
    let cy = i32((c / CELL_DIMS) % CELL_DIMS) - 1;
    let cz = i32(c % CELL_DIMS) - 1;

    let b = u32(((cx + margin) * fd + (cy + margin)) * fd + (cz + margin)) + fieldBase;

    let f0 = field[b];
    let f1 = field[b + u32(plane)];
    let f2 = field[b + u32(fd)];
    let f3 = field[b + u32(plane + fd)];
    let f4 = field[b + 1u];
    let f5 = field[b + u32(plane + 1)];
    let f6 = field[b + u32(fd + 1)];
    let f7 = field[b + u32(plane + fd + 1)];

    var mask = 0u;
    if (f0 >= ISO) { mask = mask | 1u; }
    if (f1 >= ISO) { mask = mask | 2u; }
    if (f2 >= ISO) { mask = mask | 4u; }
    if (f3 >= ISO) { mask = mask | 8u; }
    if (f4 >= ISO) { mask = mask | 16u; }
    if (f5 >= ISO) { mask = mask | 32u; }
    if (f6 >= ISO) { mask = mask | 64u; }
    if (f7 >= ISO) { mask = mask | 128u; }

    if (mask == 0u || mask == 255u) {
      cellSlot[cellBase + c] = NO_VERTEX;
      c = c + ${tiles * 256}u;
      continue;
    }

    var px = 0.0;
    var py = 0.0;
    var pz = 0.0;
    var crossings = 0.0;
${branchless ? MARK_BRANCHLESS : MARK_BRANCHED}
    let inv = 1.0 / crossings;

    let gx = (f1 + f3 + f5 + f7) - (f0 + f2 + f4 + f6);
    let gy = (f2 + f3 + f6 + f7) - (f0 + f1 + f4 + f5);
    let gz = (f4 + f5 + f6 + f7) - (f0 + f1 + f2 + f3);

    let gl = sqrt((gx * gx) + (gy * gy) + (gz * gz));

    var nx = 0.0;
    var ny = 0.0;
    var nz = 0.0;

    if (gl > 1e-8) {
      let gi = -1.0 / gl;
      nx = gx * gi;
      ny = gy * gi;
      nz = gz * gi;
    }

    let w = (chunk * SCRATCH_STRIDE) + (c * 6u);

    scratch[w]      = (f32(cx) + (px * inv) + 0.5) * SCALE;
    scratch[w + 1u] = (f32(cy) + (py * inv) + 0.5) * SCALE;
    scratch[w + 2u] = (f32(cz) + (pz * inv) + 0.5) * SCALE;
    scratch[w + 3u] = nx;
    scratch[w + 4u] = ny;
    scratch[w + 5u] = nz;

    cellSlot[cellBase + c] = 1u;

    c = c + ${tiles * 256}u;
  }
}
`;
}

const SCAN = `
const SCAN_THREADS : u32 = 256u;
const SCAN_RUN     : u32 = 20u;

var<workgroup> scanSums : array<u32, 256>;

@compute @workgroup_size(256)
fn scan_cells(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let cellBase = chunk * MAX_CELLS;
  let t = lid.x;

  let start = t * SCAN_RUN;
  var end = start + SCAN_RUN;
  if (end > MAX_CELLS) { end = MAX_CELLS; }

  var local = 0u;
  if (start < MAX_CELLS) {
    for (var i = start; i < end; i = i + 1u) {
      if (cellSlot[cellBase + i] != NO_VERTEX) { local = local + 1u; }
    }
  }

  scanSums[t] = local;
  workgroupBarrier();

  for (var offset = 1u; offset < SCAN_THREADS; offset = offset << 1u) {
    var add = 0u;
    if (t >= offset) { add = scanSums[t - offset]; }
    workgroupBarrier();
    scanSums[t] = scanSums[t] + add;
    workgroupBarrier();
  }

  let total = scanSums[SCAN_THREADS - 1u];

  var base = 0u;
  if (t > 0u) { base = scanSums[t - 1u]; }

  if (start < MAX_CELLS) {
    var slot = base;

    for (var i = start; i < end; i = i + 1u) {
      let cell = cellBase + i;

      if (cellSlot[cell] != NO_VERTEX) {
        let r = (chunk * SCRATCH_STRIDE) + (i * 6u);
        let w = (chunk * MAX_CELLS + slot) * 3u;

        vertices[w]      = scratch[r];
        vertices[w + 1u] = scratch[r + 1u];
        vertices[w + 2u] = scratch[r + 2u];

        normals[w]      = scratch[r + 3u];
        normals[w + 1u] = scratch[r + 4u];
        normals[w + 2u] = scratch[r + 5u];

        cellSlot[cell] = slot;
        slot = slot + 1u;
      }
    }
  }

  if (t == 0u) {
    atomicStore(&counts[chunk * 2u], total);
  }
}
`;

/**
 * The per-edge geometry every emit_quads variant shares. Leaves `emit` true when
 * the edge produces a quad, along with the four corner slots and the winding.
 */
function edgeProbe(indent) {
    const pad = " ".repeat(indent);

    return `
${pad}let axis = n / (17u * 16u * 16u);
${pad}let rest = n % (17u * 16u * 16u);
${pad}let d = i32(rest / (16u * 16u)) - 1;
${pad}let u = i32((rest / 16u) % 16u);
${pad}let v = i32(rest % 16u);

${pad}var emit = true;

${pad}if (d == -1 && ((neg >> axis) & 1u) != 0u) { emit = false; }

${pad}let axisU = select(0u, 1u, axis == 0u);
${pad}let axisV = select(2u, 1u, axis == 2u);

${pad}var e = vec3<i32>(0, 0, 0);
${pad}e[axis] = d;
${pad}e[axisU] = u;
${pad}e[axisV] = v;

${pad}var fieldStride = 1;
${pad}if (axis == 0u) { fieldStride = fd * fd; }
${pad}else if (axis == 1u) { fieldStride = fd; }

${pad}let fi = u32(((e.x + margin) * fd + (e.y + margin)) * fd + (e.z + margin)) + fieldBase;

${pad}let fa = field[fi];
${pad}let fb = field[fi + u32(fieldStride)];

${pad}let solidA = fa >= ISO;
${pad}let solidB = fb >= ISO;

${pad}if (solidA == solidB) { emit = false; }

${pad}var strideU = 1;
${pad}if (axisU == 0u) { strideU = cd * cd; }
${pad}else if (axisU == 1u) { strideU = cd; }

${pad}var strideV = 1;
${pad}if (axisV == 1u) { strideV = cd; }

${pad}let cb = i32(cellBase) + ((e.x + 1) * cd + (e.y + 1)) * cd + (e.z + 1);

${pad}var v00 = NO_VERTEX;
${pad}var v10 = NO_VERTEX;
${pad}var v11 = NO_VERTEX;
${pad}var v01 = NO_VERTEX;

${pad}if (emit) {
${pad}  v00 = cellSlot[u32(cb - strideU - strideV)];
${pad}  v10 = cellSlot[u32(cb - strideV)];
${pad}  v11 = cellSlot[u32(cb)];
${pad}  v01 = cellSlot[u32(cb - strideU)];

${pad}  if (v00 == NO_VERTEX || v10 == NO_VERTEX || v11 == NO_VERTEX || v01 == NO_VERTEX) { emit = false; }
${pad}}

${pad}var facePositive = solidA;
${pad}if (axis == 1u) { facePositive = !facePositive; }
${pad}if (params.flipped != 0u) { facePositive = !facePositive; }
`;
}

function emitQuadsDeviceAtomic(tiles) {
    return `
@compute @workgroup_size(256)
fn emit_quads(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let fieldBase = chunk * FIELD_SIZE;
  let cellBase = chunk * MAX_CELLS;
  let indexBase = chunk * MAX_INDICES;

  let margin = i32(params.margin);
  let fd = i32(FIELD_DIMS);
  let cd = i32(CELL_DIMS);
  let neg = u32(descAt(chunk, 27u));

  let total = 3u * 17u * 16u * 16u;

  var n = (wg.x * 256u) + lid.x;
  loop {
    if (n >= total) { break; }
${edgeProbe(4)}
    if (emit) {
      let at = atomicAdd(&counts[chunk * 2u + 1u], 6u);

      if (at + 6u <= MAX_INDICES) {
        let o = indexBase + at;

        if (facePositive) {
          indices[o] = v00; indices[o + 1u] = v10; indices[o + 2u] = v11;
          indices[o + 3u] = v00; indices[o + 4u] = v11; indices[o + 5u] = v01;
        } else {
          indices[o] = v00; indices[o + 1u] = v01; indices[o + 2u] = v11;
          indices[o + 3u] = v00; indices[o + 4u] = v11; indices[o + 5u] = v10;
        }
      }
    }

    n = n + ${tiles * 256}u;
  }
}
`;
}

// Workgroup-aggregated reservation: every thread counts its own quads, one
// workgroup atomic reserves that thread's contiguous run, and thread 0 issues a
// single device atomic for the whole workgroup. The edge test runs twice, which
// is cheap against the field being resident, and replaces up to thousands of
// device-scope atomics per chunk with one.
function emitQuadsWorkgroupAtomic(tiles) {
    return `
var<workgroup> wgTotal : atomic<u32>;
var<workgroup> wgBase  : u32;

@compute @workgroup_size(256)
fn emit_quads(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let fieldBase = chunk * FIELD_SIZE;
  let cellBase = chunk * MAX_CELLS;
  let indexBase = chunk * MAX_INDICES;

  let margin = i32(params.margin);
  let fd = i32(FIELD_DIMS);
  let cd = i32(CELL_DIMS);
  let neg = u32(descAt(chunk, 27u));

  let total = 3u * 17u * 16u * 16u;
  let start = (wg.x * 256u) + lid.x;

  if (lid.x == 0u) { atomicStore(&wgTotal, 0u); }
  workgroupBarrier();

  var mine = 0u;

  var n = start;
  loop {
    if (n >= total) { break; }
${edgeProbe(4)}
    if (emit) { mine = mine + 6u; }

    n = n + ${tiles * 256}u;
  }

  let localBase = atomicAdd(&wgTotal, mine);

  workgroupBarrier();

  if (lid.x == 0u) {
    wgBase = atomicAdd(&counts[chunk * 2u + 1u], atomicLoad(&wgTotal));
  }

  workgroupBarrier();

  var write = wgBase + localBase;

  n = start;
  loop {
    if (n >= total) { break; }
${edgeProbe(4)}
    if (emit) {
      if (write + 6u <= MAX_INDICES) {
        let o = indexBase + write;

        if (facePositive) {
          indices[o] = v00; indices[o + 1u] = v10; indices[o + 2u] = v11;
          indices[o + 3u] = v00; indices[o + 4u] = v11; indices[o + 5u] = v01;
        } else {
          indices[o] = v00; indices[o + 1u] = v01; indices[o + 2u] = v11;
          indices[o + 3u] = v00; indices[o + 4u] = v11; indices[o + 5u] = v10;
        }
      }

      write = write + 6u;
    }

    n = n + ${tiles * 256}u;
  }
}
`;
}


/**
 * Two clamped 3-tap passes composed into one clamped 5-tap.
 *
 * The composition is only a plain binomial kernel in the interior; the two rows
 * at each end differ, because clamping is not a convolution. Writing those rows
 * out explicitly is what keeps the fused pass bit-identical to running the 3-tap
 * twice. Every weight is a dyadic rational and every input is a multiple of
 * 2^-4, so all intermediates are exact in f32 and summation order cannot change
 * the result.
 *
 *   i = 0      0.625   v0 + 0.3125 v1 + 0.0625 v2
 *   i = 1      0.3125  v0 + 0.375  v1 + 0.25   v2 + 0.0625 v3
 *   interior   0.0625  v[i-2] + 0.25 v[i-1] + 0.375 v[i] + 0.25 v[i+1] + 0.0625 v[i+2]
 *   i = L-2    mirror of i = 1
 *   i = L-1    mirror of i = 0
 */
function blurFused(tiles, pingpong) {
    const body = `
fn blur2_axis(chunk: u32, start: u32, axis: u32, readTmp: bool) {
  let base = chunk * FIELD_SIZE;
  let sbase = chunk * SCRATCH_STRIDE;
  let maxDim = params.maxDim;
  let last = maxDim - 1u;
  let total = maxDim * maxDim * maxDim;

  var stride = 1u;
  if (axis == 0u) { stride = FIELD_DIMS * FIELD_DIMS; }
  else if (axis == 1u) { stride = FIELD_DIMS; }

  var n = start;
  loop {
    if (n >= total) { break; }

    let x = n / (maxDim * maxDim);
    let y = (n / maxDim) % maxDim;
    let z = n % maxDim;

    var coord = z;
    if (axis == 0u) { coord = x; }
    else if (axis == 1u) { coord = y; }

    let local = ((x * FIELD_DIMS) + y) * FIELD_DIMS + z;
    let index = base + local;
    let sindex = sbase + local;
    let read = select(index, sindex, readTmp);

    // the five taps, clamped so the reads stay inside the active box; the
    // weights carry the actual boundary behaviour
    let o1 = stride;
    let o2 = stride * 2u;

    let m2 = read - select(0u, o2, coord >= 2u) - select(0u, o1, coord == 1u);
    let m1 = read - select(0u, o1, coord >= 1u);
    let p1 = read + select(0u, o1, coord < last);
    let p2 = read + select(0u, o2, coord + 2u <= last) + select(0u, o1, coord + 2u == last + 1u);

    var v = 0.0;

    if (readTmp) {
      let a = scratch[m2]; let b = scratch[m1]; let c = scratch[read]; let d = scratch[p1]; let e = scratch[p2];
      v = blur2Weights(a, b, c, d, e, coord, last);
    } else {
      let a = field[m2]; let b = field[m1]; let c = field[read]; let d = field[p1]; let e = field[p2];
      v = blur2Weights(a, b, c, d, e, coord, last);
    }

    if (readTmp) { field[index] = v; } else { scratch[sindex] = v; }

    n = n + ${tiles * 256}u;
  }
}

fn blur2Weights(a: f32, b: f32, c: f32, d: f32, e: f32, coord: u32, last: u32) -> f32 {
  if (coord == 0u)        { return (0.625 * c) + (0.3125 * d) + (0.0625 * e); }
  if (coord == 1u)        { return (0.3125 * b) + (0.375 * c) + (0.25 * d) + (0.0625 * e); }
  if (coord == last)      { return (0.625 * c) + (0.3125 * b) + (0.0625 * a); }
  if (coord == last - 1u) { return (0.3125 * d) + (0.375 * c) + (0.25 * b) + (0.0625 * a); }

  return (0.0625 * a) + (0.25 * b) + (0.375 * c) + (0.25 * d) + (0.0625 * e);
}

@compute @workgroup_size(256)
fn blur2_x(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, 0u, false);
}

@compute @workgroup_size(256)
fn blur2_y(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, 1u, true);
}

@compute @workgroup_size(256)
fn blur2_z(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, 2u, false);
}
`;

    const reversed = pingpong ? `
@compute @workgroup_size(256)
fn blur2_x_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, 0u, true);
}

@compute @workgroup_size(256)
fn blur2_y_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, 1u, false);
}

@compute @workgroup_size(256)
fn blur2_z_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, 2u, true);
}
` : "";

    return body + reversed;
}

/**
 * sample_field restricted to the active box. Samples outside it are never read
 * by any later pass, so writing 24^3 zeroes when the box is 20^3 is dead work.
 */
function sampleFieldActive(tiles) {
    return `
@compute @workgroup_size(256)
fn sample_field_active(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let margin = i32(params.margin);
  let maxDim = params.maxDim;
  let fieldBase = chunk * FIELD_SIZE;
  let total = maxDim * maxDim * maxDim;

  var n = (wg.x * 256u) + lid.x;
  loop {
    if (n >= total) { break; }

    let fx = i32(n / (maxDim * maxDim));
    let fy = i32((n / maxDim) % maxDim);
    let fz = i32(n % maxDim);

    let sx = fx - margin;
    let sy = fy - margin;
    let sz = fz - margin;

    let cx = sx >> 4u;
    let cy = sy >> 4u;
    let cz = sz >> 4u;
    let lx = u32(sx & 15);
    let ly = u32(sy & 15);
    let lz = u32(sz & 15);

    let slot = ((cx + 1) * 3 + (cy + 1)) * 3 + (cz + 1);
    let arena = descAt(chunk, u32(slot));

    var value = 0.0;

    if (arena >= 0) {
      let index = ((lx >> 2u) << 10u) | ((ly >> 2u) << 8u) | ((lz >> 2u) << 6u)
                | ((lx & 3u) << 4u) | ((ly & 3u) << 2u) | (lz & 3u);
      let word = occupancy[u32(arena) * 128u + (index >> 5u)];

      if (((word >> (index & 31u)) & 1u) != 0u) { value = 1.0; }
    }

    field[fieldBase + u32((fx * i32(FIELD_DIMS) + fy) * i32(FIELD_DIMS) + fz)] = value;

    n = n + ${tiles * 256}u;
  }
}
`;
}

export function makeWgsl(opts = {}) {
    const tiles = opts.tiles ?? 1;
    const branchless = opts.branchless ?? false;
    const descIndex = opts.descIndex ?? false;
    const wgAtomic = opts.wgAtomic ?? false;
    const pingpong = opts.pingpong ?? false;
    const fuseBlur = opts.fuseBlur ?? false;
    const activeBox = opts.activeBox ?? false;

    return [
        HEADER,
        descIndex ? DESC_INDEXED : DESC_BRANCHED,
        branchless ? SAFE_T : "",
        sampleField(tiles),
        blur(tiles, pingpong),
        fuseBlur ? blurFused(tiles, pingpong) : "",
        activeBox ? sampleFieldActive(tiles) : "",
        markCells(tiles, branchless),
        SCAN,
        wgAtomic ? emitQuadsWorkgroupAtomic(tiles) : emitQuadsDeviceAtomic(tiles)
    ].join("\n");
}

/**
 * The variant matrix under test. `tiles` is how many workgroups each chunk gets
 * for the data-parallel passes.
 */
export const VARIANTS = [
    { name: "baseline (shipped)", opts: {} },
    { name: "descIndex", opts: { descIndex: true } },
    { name: "branchless mark", opts: { branchless: true } },
    { name: "wg-atomic emit", opts: { wgAtomic: true } },
    { name: "pingpong (no copy_back)", opts: { pingpong: true } },
    { name: "tiles=4", opts: { tiles: 4 } },
    { name: "tiles=8", opts: { tiles: 8 } },
    { name: "tiles=16", opts: { tiles: 16 } },
    { name: "tiles=27", opts: { tiles: 27 } },
    { name: "all: tiles=8", opts: { tiles: 8, branchless: true, descIndex: true, wgAtomic: true, pingpong: true } },
    { name: "all: tiles=16", opts: { tiles: 16, branchless: true, descIndex: true, wgAtomic: true, pingpong: true } },
    { name: "all: tiles=27", opts: { tiles: 27, branchless: true, descIndex: true, wgAtomic: true, pingpong: true } }
];
