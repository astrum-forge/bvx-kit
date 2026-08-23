/**
 * WGSL for the compute-shader smooth mesher, as a string so the kit ships it
 * without a build step and without a DOM or WebGPU runtime dependency. The
 * caller compiles it against a device it owns.
 *
 * The pipeline mirrors VoxelSmoothGeometry exactly, one compute pass per stage:
 *
 *   sample_field   occupancy of the 3x3x3 chunk neighbourhood -> a 0/1 scalar field
 *   blur_x/y/z     one separable 3-tap smoothing pass, run `passes` times
 *   copy_back      returns the ping-ponged result to the field buffer
 *   mark_cells     one dual cell per thread: is it a surface cell, and if so where
 *                  does its vertex sit and which way does it face
 *   scan_cells     exclusive prefix sum over the cell flags
 *   emit_quads     one field edge per thread, appending two triangles per crossing
 *
 * Two details are load-bearing rather than incidental:
 *
 * - **Vertex numbering comes from a prefix sum, not an atomic counter.** The CPU
 *   numbers vertices in ascending cell order, and the index buffer refers to those
 *   numbers. An atomic append would produce a valid mesh with different numbering,
 *   which cannot be compared against the CPU's output. A scan over the cells in
 *   the same order reproduces the numbering exactly, so the two can be diffed.
 * - **The blur is exact.** Weights are 0.25/0.5/0.25 with 0.75/0.25 at the clamped
 *   ends, over inputs that are 0 or 1, so after N passes every value is a multiple
 *   of 2^-6N and needs 6N+1 mantissa bits. At the maximum 3 passes that is 19 of
 *   fp32's 24, so no rounding occurs and the GPU result is bit-identical to the
 *   CPU's. This breaks at 4 passes - see MAX_SMOOTHING.
 */
export const SMOOTH_MESHER_WGSL: string = /* wgsl */ `
const FIELD_DIMS  : u32 = 24u;   // 16 + 2 * MARGIN_MAX
const FIELD_SIZE  : u32 = 13824u;
const CELL_DIMS   : u32 = 17u;
const MAX_CELLS   : u32 = 4913u;
const MAX_INDICES : u32 = 78336u;
const CHUNK_DIMS  : i32 = 16;
const ISO         : f32 = 0.5;
const SCALE       : f32 = 0.25;

// The largest batch one submission can carry. Fixed because the per-chunk
// descriptors live in a uniform buffer, whose array length must be a constant.
const MAX_BATCH   : u32 = 64u;

// per-chunk descriptor stride, in vec4<i32> (32 i32)
const DESC_VEC4S  : u32 = 8u;

// One scratch buffer serves the blur ping-pong and the per-cell vertex data,
// because the two phases never overlap: the blur is finished before any cell is
// marked. Its stride is the larger of the two needs.
const SCRATCH_STRIDE : u32 = 29478u;   // max(FIELD_SIZE, MAX_CELLS * 6)

struct Params {
  chunkCount : u32,
  margin     : u32,
  maxDim     : u32,   // 16 + 2 * margin - the active extent of the field
  flipped    : u32,
};

// Two uniform bindings and eight storage bindings. Eight is WebGPU's default
// maxStorageBuffersPerShaderStage, so this runs on a device requested with no
// raised limits - which is what a renderer hands over.
@group(0) @binding(0) var<uniform>             params    : Params;
@group(0) @binding(1) var<uniform>             desc      : array<vec4<i32>, 512>;  // MAX_BATCH * DESC_VEC4S
@group(0) @binding(2) var<storage, read>       occupancy : array<u32>;
@group(0) @binding(3) var<storage, read_write> field     : array<f32>;
@group(0) @binding(4) var<storage, read_write> scratch   : array<f32>;
@group(0) @binding(5) var<storage, read_write> cellSlot  : array<u32>;  // 0xFFFFFFFF = no vertex
@group(0) @binding(6) var<storage, read_write> vertices  : array<f32>;
@group(0) @binding(7) var<storage, read_write> normals   : array<f32>;
@group(0) @binding(8) var<storage, read_write> indices   : array<u32>;
@group(0) @binding(9) var<storage, read_write> counts    : array<atomic<u32>>; // 2 per chunk

// desc is packed as vec4 because a uniform array's element stride is 16 bytes.
fn descAt(chunk: u32, slot: u32) -> i32 {
  let v = desc[chunk * DESC_VEC4S + (slot >> 2u)];
  let c = slot & 3u;
  if (c == 0u) { return v.x; }
  if (c == 1u) { return v.y; }
  if (c == 2u) { return v.z; }
  return v.w;
}

const NO_VERTEX : u32 = 0xFFFFFFFFu;

// ---------------------------------------------------------------------------
// sample_field - 0/1 occupancy of the chunk and its margin, from the 3x3x3
// neighbourhood of arena slots the descriptor names. A missing chunk reads empty.
// ---------------------------------------------------------------------------
@compute @workgroup_size(256)
fn sample_field(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.x;
  let margin = i32(params.margin);
  let maxDim = i32(params.maxDim);
  let fieldBase = chunk * FIELD_SIZE;

  var i = lid.x;
  loop {
    if (i >= FIELD_SIZE) { break; }

    let fx = i32(i / (FIELD_DIMS * FIELD_DIMS));
    let fy = i32((i / FIELD_DIMS) % FIELD_DIMS);
    let fz = i32(i % FIELD_DIMS);

    var value = 0.0;

    // outside the active box the CPU leaves the buffer at its cleared zero
    if (fx < maxDim && fy < maxDim && fz < maxDim) {
      let sx = fx - margin;
      let sy = fy - margin;
      let sz = fz - margin;

      // arithmetic shift and mask, matching the CPU's sx >> 4 / sx & 15
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
    i = i + 256u;
  }
}

// ---------------------------------------------------------------------------
// blur - one separable 3-tap pass per axis, clamped at the ends of the active
// box exactly as the CPU clamps them.
// ---------------------------------------------------------------------------
fn blur_axis(chunk: u32, lid: u32, axis: u32, readTmp: bool) {
  let base = chunk * FIELD_SIZE;
  let sbase = chunk * SCRATCH_STRIDE;
  let maxDim = params.maxDim;
  let last = maxDim - 1u;
  let total = maxDim * maxDim * maxDim;

  var stride = 1u;
  if (axis == 0u) { stride = FIELD_DIMS * FIELD_DIMS; }
  else if (axis == 1u) { stride = FIELD_DIMS; }

  var n = lid;
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

    n = n + 256u;
  }
}

@compute @workgroup_size(256)
fn blur_x(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.x, lid.x, 0u, false);   // field -> tmp
}

@compute @workgroup_size(256)
fn blur_y(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.x, lid.x, 1u, true);    // tmp -> field
}

@compute @workgroup_size(256)
fn blur_z(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.x, lid.x, 2u, false);   // field -> tmp
}

// the CPU's field.set(scratch) after the three axis passes
@compute @workgroup_size(256)
fn copy_back(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let base = wg.x * FIELD_SIZE;
  let sbase = wg.x * SCRATCH_STRIDE;

  var i = lid.x;
  loop {
    if (i >= FIELD_SIZE) { break; }
    field[base + i] = scratch[sbase + i];
    i = i + 256u;
  }
}

// ---------------------------------------------------------------------------
// mark_cells - one dual cell per thread. Surface cells record their vertex
// position and normal; the flag drives the prefix sum that numbers them.
// ---------------------------------------------------------------------------
@compute @workgroup_size(256)
fn mark_cells(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.x;
  let fieldBase = chunk * FIELD_SIZE;
  let cellBase = chunk * MAX_CELLS;
  let margin = i32(params.margin);
  let fd = i32(FIELD_DIMS);
  let plane = fd * fd;

  var c = lid.x;
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
      c = c + 256u;
      continue;
    }

    var px = 0.0;
    var py = 0.0;
    var pz = 0.0;
    var crossings = 0.0;

    // edges along x - corner pairs (0,1) (2,3) (4,5) (6,7)
    if ((f0 >= ISO) != (f1 >= ISO)) { px = px + (ISO - f0) / (f1 - f0); crossings = crossings + 1.0; }
    if ((f2 >= ISO) != (f3 >= ISO)) { px = px + (ISO - f2) / (f3 - f2); py = py + 1.0; crossings = crossings + 1.0; }
    if ((f4 >= ISO) != (f5 >= ISO)) { px = px + (ISO - f4) / (f5 - f4); pz = pz + 1.0; crossings = crossings + 1.0; }
    if ((f6 >= ISO) != (f7 >= ISO)) { px = px + (ISO - f6) / (f7 - f6); py = py + 1.0; pz = pz + 1.0; crossings = crossings + 1.0; }

    // edges along y - corner pairs (0,2) (1,3) (4,6) (5,7)
    if ((f0 >= ISO) != (f2 >= ISO)) { py = py + (ISO - f0) / (f2 - f0); crossings = crossings + 1.0; }
    if ((f1 >= ISO) != (f3 >= ISO)) { py = py + (ISO - f1) / (f3 - f1); px = px + 1.0; crossings = crossings + 1.0; }
    if ((f4 >= ISO) != (f6 >= ISO)) { py = py + (ISO - f4) / (f6 - f4); pz = pz + 1.0; crossings = crossings + 1.0; }
    if ((f5 >= ISO) != (f7 >= ISO)) { py = py + (ISO - f5) / (f7 - f5); px = px + 1.0; pz = pz + 1.0; crossings = crossings + 1.0; }

    // edges along z - corner pairs (0,4) (1,5) (2,6) (3,7)
    if ((f0 >= ISO) != (f4 >= ISO)) { pz = pz + (ISO - f0) / (f4 - f0); crossings = crossings + 1.0; }
    if ((f1 >= ISO) != (f5 >= ISO)) { pz = pz + (ISO - f1) / (f5 - f1); px = px + 1.0; crossings = crossings + 1.0; }
    if ((f2 >= ISO) != (f6 >= ISO)) { pz = pz + (ISO - f2) / (f6 - f2); py = py + 1.0; crossings = crossings + 1.0; }
    if ((f3 >= ISO) != (f7 >= ISO)) { pz = pz + (ISO - f3) / (f7 - f3); px = px + 1.0; py = py + 1.0; crossings = crossings + 1.0; }

    let inv = 1.0 / crossings;

    let gx = (f1 + f3 + f5 + f7) - (f0 + f2 + f4 + f6);
    let gy = (f2 + f3 + f6 + f7) - (f0 + f1 + f4 + f5);
    let gz = (f4 + f5 + f6 + f7) - (f0 + f1 + f2 + f3);

    let gl = sqrt((gx * gx) + (gy * gy) + (gz * gz));

    var nx = 0.0;
    var ny = 0.0;
    var nz = 0.0;

    if (gl > 1e-8) {
      // the normal points from solid (1) towards empty (0)
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

    cellSlot[cellBase + c] = 1u;   // provisional flag, the scan turns it into a slot

    c = c + 256u;
  }
}

// ---------------------------------------------------------------------------
// scan_cells - exclusive prefix sum over one chunk's 4913 cell flags, then the
// vertex write. One workgroup per chunk; each thread owns a contiguous run.
//
// The scan is what makes vertex numbering match the CPU: the CPU assigns numbers
// walking cells in ascending index, which is exactly the order this sums in.
// ---------------------------------------------------------------------------
const SCAN_THREADS : u32 = 256u;
const SCAN_RUN     : u32 = 20u;   // ceil(4913 / 256)

var<workgroup> scanSums : array<u32, 256>;

@compute @workgroup_size(256)
fn scan_cells(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.x;
  let cellBase = chunk * MAX_CELLS;
  let t = lid.x;

  let start = t * SCAN_RUN;
  var end = start + SCAN_RUN;
  if (end > MAX_CELLS) { end = MAX_CELLS; }

  // phase 1 - each thread counts its own run
  var local = 0u;
  if (start < MAX_CELLS) {
    for (var i = start; i < end; i = i + 1u) {
      if (cellSlot[cellBase + i] != NO_VERTEX) { local = local + 1u; }
    }
  }

  scanSums[t] = local;
  workgroupBarrier();

  // phase 2 - Hillis-Steele inclusive scan over the per-thread counts
  for (var offset = 1u; offset < SCAN_THREADS; offset = offset << 1u) {
    var add = 0u;
    if (t >= offset) { add = scanSums[t - offset]; }
    workgroupBarrier();
    scanSums[t] = scanSums[t] + add;
    workgroupBarrier();
  }

  let total = scanSums[SCAN_THREADS - 1u];

  // exclusive base for this thread's run
  var base = 0u;
  if (t > 0u) { base = scanSums[t - 1u]; }

  // phase 3 - assign slots in order and move the vertex data into place
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

// ---------------------------------------------------------------------------
// emit_quads - one field edge per thread. Every edge whose two samples straddle
// the iso-level connects the four surface cells around it into two triangles.
//
// Triangles are appended atomically, so their ORDER differs from the CPU's while
// the set does not. Order is irrelevant to a draw; vertex numbering, which is
// not, comes from the scan above.
// ---------------------------------------------------------------------------
@compute @workgroup_size(256)
fn emit_quads(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.x;
  let fieldBase = chunk * FIELD_SIZE;
  let cellBase = chunk * MAX_CELLS;
  let indexBase = chunk * MAX_INDICES;

  let margin = i32(params.margin);
  let fd = i32(FIELD_DIMS);
  let cd = i32(CELL_DIMS);
  let neg = u32(descAt(chunk, 27u));

  // 3 axes x 17 edge positions x 16 x 16
  let total = 3u * 17u * 16u * 16u;

  var n = lid.x;
  loop {
    if (n >= total) { break; }

    let axis = n / (17u * 16u * 16u);
    let rest = n % (17u * 16u * 16u);
    let d = i32(rest / (16u * 16u)) - 1;
    let u = i32((rest / 16u) % 16u);
    let v = i32(rest % 16u);

    // the negative seam is owned by the neighbour on that side
    if (d == -1 && ((neg >> axis) & 1u) != 0u) { n = n + 256u; continue; }

    let axisU = select(0u, 1u, axis == 0u);
    let axisV = select(2u, 1u, axis == 2u);

    var e = vec3<i32>(0, 0, 0);
    e[axis] = d;
    e[axisU] = u;
    e[axisV] = v;

    var fieldStride = 1;
    if (axis == 0u) { fieldStride = fd * fd; }
    else if (axis == 1u) { fieldStride = fd; }

    let fi = u32(((e.x + margin) * fd + (e.y + margin)) * fd + (e.z + margin)) + fieldBase;

    let a = field[fi];
    let b = field[fi + u32(fieldStride)];

    let solidA = a >= ISO;
    let solidB = b >= ISO;

    if (solidA == solidB) { n = n + 256u; continue; }

    var strideU = 1;
    if (axisU == 0u) { strideU = cd * cd; }
    else if (axisU == 1u) { strideU = cd; }

    var strideV = 1;
    if (axisV == 1u) { strideV = cd; }

    let cb = i32(cellBase) + ((e.x + 1) * cd + (e.y + 1)) * cd + (e.z + 1);

    let v00 = cellSlot[u32(cb - strideU - strideV)];
    let v10 = cellSlot[u32(cb - strideV)];
    let v11 = cellSlot[u32(cb)];
    let v01 = cellSlot[u32(cb - strideU)];

    // A crossing edge always has four surface cells around it, so this is a
    // guard against a malformed field rather than an expected case.
    if (v00 == NO_VERTEX || v10 == NO_VERTEX || v11 == NO_VERTEX || v01 == NO_VERTEX) {
      n = n + 256u;
      continue;
    }

    // quad winding - faces the empty sample. The y ring has opposite parity.
    var facePositive = solidA;
    if (axis == 1u) { facePositive = !facePositive; }
    if (params.flipped != 0u) { facePositive = !facePositive; }

    let at = atomicAdd(&counts[chunk * 2u + 1u], 6u);

    if (at + 6u <= MAX_INDICES) {
      let o = indexBase + at;

      if (facePositive) {
        indices[o]      = v00;
        indices[o + 1u] = v10;
        indices[o + 2u] = v11;
        indices[o + 3u] = v00;
        indices[o + 4u] = v11;
        indices[o + 5u] = v01;
      } else {
        indices[o]      = v00;
        indices[o + 1u] = v01;
        indices[o + 2u] = v11;
        indices[o + 3u] = v00;
        indices[o + 4u] = v11;
        indices[o + 5u] = v10;
      }
    }

    n = n + 256u;
  }
}
`;
