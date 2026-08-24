/**
 * WGSL for the compute-shader smooth mesher, as a string so the kit ships it
 * without a build step and without a DOM or WebGPU runtime dependency. The
 * caller compiles it against a device it owns.
 *
 * The pipeline mirrors VoxelSmoothGeometry, one compute pass per stage:
 *
 *   sample_field   occupancy of the 3x3x3 chunk neighbourhood -> a 0/1 scalar field
 *   blur_*         separable smoothing, see "How the blur is scheduled" below
 *   copy_back      returns a ping-ponged result to the field buffer
 *   mark_cells     one dual cell per thread: is it a surface cell, and if so where
 *                  does its vertex sit and which way does it face
 *   scan_cells     exclusive prefix sum over the cell flags
 *   emit_quads     one field edge per thread, appending two triangles per crossing
 *
 * ## The dispatch shape
 *
 * Every pass except scan_cells is dispatched as `(tiles, chunkCount)`: `wg.y` selects
 * the chunk and `wg.x` selects which slice of that chunk's work this workgroup owns.
 * The grid stride comes from `num_workgroups.x`, so the host chooses the tiling without
 * the shader needing a pipeline constant.
 *
 * This matters most at small batches. Dispatching one workgroup per chunk - which is
 * what this shader used to do - runs 256 threads for a single-chunk mesh on hardware
 * that keeps tens of thousands in flight. Measured on an M1 at smoothing 2, tiling to 16
 * workgroups per chunk is worth 2.2x at one chunk and 1.3x at eight, and nothing at all
 * by 32, where 32 workgroups already saturate the device.
 *
 * scan_cells is the exception and always runs one workgroup per chunk: its prefix sum
 * synchronises through workgroup memory, which only orders invocations within a single
 * workgroup.
 *
 * ## How the blur is scheduled
 *
 * Three axis passes flip which buffer holds the field, so an even number of them lands
 * back where it started. The host alternates between the forward entry points and the
 * `_r` ones and emits `copy_back` only when the count is odd - the previous version ran
 * one copy per smoothing pass, which at smoothing 2 was 13% of the pipeline spent moving
 * 13824 floats per chunk for no arithmetic.
 *
 * Pairs of smoothing passes are also fused. Two clamped 3-taps compose into one clamped
 * 5-tap: the interior is the binomial kernel and the two rows at each end need their own
 * weights, because clamping is not a convolution. That halves the blur dispatches and
 * the field traffic they cause, which is the largest single cost in the pipeline.
 *
 * Together the two changes take smoothing 2 from 12 dispatches to 8 and smoothing 3 from
 * 16 to 10, and are worth a further 1.36x and 1.38x at a full batch of 64 on an M1.
 *
 * ## What is exact and what is not
 *
 * **The blur is exact, and the fused form is exact too.** Weights are dyadic rationals
 * over inputs that are 0 or 1, so after N passes every value is a multiple of 2^-6N and
 * needs 6N+1 mantissa bits. At the maximum 3 passes that is 19 of fp32's 24, so no
 * rounding occurs at any point and the fused 5-tap produces bit-identical values to
 * running the 3-tap twice - verified over 64 surface chunks at every smoothing level.
 * This breaks at 4 passes, which is why MAX_SMOOTHING is 3.
 *
 * **The emitted mesh is not bit-identical to the CPU's.** Topology is: vertex count,
 * index count and the set of triangles match exactly at every smoothing level. The
 * numbers differ slightly, because the CPU computes a vertex position in f64 and rounds
 * once on the store to a Float32Array while this computes in f32 throughout. Measured
 * over 64 surface chunks, about 5% of vertex components differ, by at most 4.8e-7 units
 * against a 0.25-unit BitVoxel. Normals agree to within 2 ULP.
 *
 * **There is no degenerate-normal fallback.** A dual cell whose field gradient is zero -
 * two diagonally opposite solid corners is the simple case - gets a zero normal here,
 * where the CPU resolves it from the adjacent triangles afterwards. mark_cells counts
 * those cells into the third count word so the caller is told rather than left to
 * discover it as flat shading.
 *
 * ## Vertex numbering comes from a prefix sum, not an atomic counter
 *
 * The CPU numbers vertices in ascending cell order and the index buffer refers to those
 * numbers. An atomic append would produce a valid mesh with different numbering, which
 * could not be compared against the CPU's output. A scan over the cells in the same
 * order reproduces the numbering exactly.
 *
 * Triangles, by contrast, are appended atomically, so their order differs from the CPU's
 * while the set does not. Order is irrelevant to a draw. A workgroup-aggregated
 * reservation was measured as an alternative and is slower: the second pass over the
 * edge list it needs costs more than the device atomics it removes.
 */
export const SMOOTH_MESHER_WGSL: string = /* wgsl */ `
const FIELD_DIMS  : u32 = 24u;   // 16 + 2 * MARGIN_MAX
const FIELD_SIZE  : u32 = 13824u;
const CELL_DIMS   : u32 = 17u;
const MAX_CELLS   : u32 = 4913u;
const MAX_INDICES : u32 = 78336u;
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

const NO_VERTEX : u32 = 0xFFFFFFFFu;

// Words of per-chunk output: vertex count, index count, degenerate-normal count,
// and one spare that keeps the stride 16-byte aligned.
const COUNT_WORDS : u32 = 4u;

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
@group(0) @binding(9) var<storage, read_write> counts    : array<atomic<u32>>; // COUNT_WORDS per chunk

// desc is packed as vec4 because a uniform array's element stride is 16 bytes.
fn descAt(chunk: u32, slot: u32) -> i32 {
  return desc[chunk * DESC_VEC4S + (slot >> 2u)][slot & 3u];
}

// ---------------------------------------------------------------------------
// sample_field - 0/1 occupancy of the chunk and its margin, from the 3x3x3
// neighbourhood of arena slots the descriptor names. A missing chunk reads empty.
// ---------------------------------------------------------------------------
@compute @workgroup_size(256)
fn sample_field(@builtin(workgroup_id) wg: vec3<u32>,
                @builtin(num_workgroups) nwg: vec3<u32>,
                @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let margin = i32(params.margin);
  let maxDim = i32(params.maxDim);
  let fieldBase = chunk * FIELD_SIZE;
  let stride = nwg.x * 256u;

  var i = (wg.x * 256u) + lid.x;
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
    i = i + stride;
  }
}

// ---------------------------------------------------------------------------
// blur - one separable 3-tap pass per axis, clamped at the ends of the active
// box exactly as the CPU clamps them.
//
// readTmp picks the direction: false reads field and writes scratch, true the
// other way. A triple of passes therefore flips which buffer holds the field,
// and the host alternates so an even number of triples needs no copy back.
// ---------------------------------------------------------------------------
fn blur_axis(chunk: u32, start: u32, stride: u32, axis: u32, readTmp: bool) {
  let base = chunk * FIELD_SIZE;
  let sbase = chunk * SCRATCH_STRIDE;
  let maxDim = params.maxDim;
  let last = maxDim - 1u;
  let total = maxDim * maxDim * maxDim;

  var axisStride = 1u;
  if (axis == 0u) { axisStride = FIELD_DIMS * FIELD_DIMS; }
  else if (axis == 1u) { axisStride = FIELD_DIMS; }

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

    var prev = axisStride;
    var next = axisStride;
    if (coord == 0u) { prev = 0u; }
    if (coord == last) { next = 0u; }

    if (readTmp) {
      field[index] = (0.25 * scratch[sindex - prev]) + (0.5 * scratch[sindex]) + (0.25 * scratch[sindex + next]);
    } else {
      scratch[sindex] = (0.25 * field[index - prev]) + (0.5 * field[index]) + (0.25 * field[index + next]);
    }

    n = n + stride;
  }
}

// ---------------------------------------------------------------------------
// blur2 - two clamped 3-tap passes composed into one clamped 5-tap.
//
// Only the interior is the plain binomial kernel; the two rows at each end carry
// their own weights, because clamping is not a convolution. Writing them out is
// what keeps this bit-identical to running the 3-tap twice.
//
//   i = 0      0.625  v0     + 0.3125 v1     + 0.0625 v2
//   i = 1      0.3125 v0     + 0.375  v1     + 0.25   v2 + 0.0625 v3
//   interior   0.0625 v[i-2] + 0.25   v[i-1] + 0.375  v[i] + 0.25 v[i+1] + 0.0625 v[i+2]
//   i = L-2    mirror of i = 1
//   i = L-1    mirror of i = 0
// ---------------------------------------------------------------------------
fn blur2Weights(a: f32, b: f32, c: f32, d: f32, e: f32, coord: u32, last: u32) -> f32 {
  if (coord == 0u)        { return (0.625 * c) + (0.3125 * d) + (0.0625 * e); }
  if (coord == 1u)        { return (0.3125 * b) + (0.375 * c) + (0.25 * d) + (0.0625 * e); }
  if (coord == last)      { return (0.625 * c) + (0.3125 * b) + (0.0625 * a); }
  if (coord == last - 1u) { return (0.3125 * d) + (0.375 * c) + (0.25 * b) + (0.0625 * a); }

  return (0.0625 * a) + (0.25 * b) + (0.375 * c) + (0.25 * d) + (0.0625 * e);
}

fn blur2_axis(chunk: u32, start: u32, stride: u32, axis: u32, readTmp: bool) {
  let base = chunk * FIELD_SIZE;
  let sbase = chunk * SCRATCH_STRIDE;
  let maxDim = params.maxDim;
  let last = maxDim - 1u;
  let total = maxDim * maxDim * maxDim;

  var axisStride = 1u;
  if (axis == 0u) { axisStride = FIELD_DIMS * FIELD_DIMS; }
  else if (axis == 1u) { axisStride = FIELD_DIMS; }

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

    // the five taps, clamped so every read stays inside the active box; the
    // weights above carry the actual boundary behaviour
    let o1 = axisStride;
    let o2 = axisStride * 2u;

    let m2 = read - select(0u, o2, coord >= 2u) - select(0u, o1, coord == 1u);
    let m1 = read - select(0u, o1, coord >= 1u);
    let p1 = read + select(0u, o1, coord < last);
    let p2 = read + select(0u, o2, coord + 2u <= last) + select(0u, o1, coord + 1u == last);

    if (readTmp) {
      field[index] = blur2Weights(scratch[m2], scratch[m1], scratch[read], scratch[p1], scratch[p2], coord, last);
    } else {
      scratch[sindex] = blur2Weights(field[m2], field[m1], field[read], field[p1], field[p2], coord, last);
    }

    n = n + stride;
  }
}

@compute @workgroup_size(256)
fn blur_x(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 0u, false);
}

@compute @workgroup_size(256)
fn blur_y(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 1u, true);
}

@compute @workgroup_size(256)
fn blur_z(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 2u, false);
}

@compute @workgroup_size(256)
fn blur_x_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 0u, true);
}

@compute @workgroup_size(256)
fn blur_y_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 1u, false);
}

@compute @workgroup_size(256)
fn blur_z_r(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 2u, true);
}

@compute @workgroup_size(256)
fn blur2_x(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 0u, false);
}

@compute @workgroup_size(256)
fn blur2_y(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 1u, true);
}

@compute @workgroup_size(256)
fn blur2_z(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  blur2_axis(wg.y, (wg.x * 256u) + lid.x, nwg.x * 256u, 2u, false);
}

// There are deliberately no reversed fused entry points. Reaching a second fused round
// needs four smoothing passes, and MAX_SMOOTHING is 3 - beyond that the blur stops being
// exact in fp32. Raising MAX_SMOOTHING would mean adding blur2_x_r / _y_r / _z_r here and
// teaching GpuSmoothMesher.passList to alternate them; a test asserts that every entry
// point this module declares is one the schedule can actually reach.

// the CPU's field.set(scratch), needed only when the blur pass count is odd
@compute @workgroup_size(256)
fn copy_back(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let base = wg.y * FIELD_SIZE;
  let sbase = wg.y * SCRATCH_STRIDE;
  let stride = nwg.x * 256u;

  var i = (wg.x * 256u) + lid.x;
  loop {
    if (i >= FIELD_SIZE) { break; }
    field[base + i] = scratch[sbase + i];
    i = i + stride;
  }
}

// ---------------------------------------------------------------------------
// mark_cells - one dual cell per thread. Surface cells record their vertex
// position and normal; the flag drives the prefix sum that numbers them.
//
// The twelve per-edge branches below look like a divergence hazard and are not
// one. Measured on an M1 this pass is 5% of the pipeline, and a branchless
// rewrite using select() and masked accumulation measured slower - it pays for
// twelve divides on every cell instead of only the crossing edges - as well as
// changing the result, because Metal contracts the mask-multiply into an FMA.
// ---------------------------------------------------------------------------
@compute @workgroup_size(256)
fn mark_cells(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let fieldBase = chunk * FIELD_SIZE;
  let cellBase = chunk * MAX_CELLS;
  let margin = i32(params.margin);
  let fd = i32(FIELD_DIMS);
  let plane = fd * fd;
  let stride = nwg.x * 256u;

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
      c = c + stride;
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
    } else {
      // A cell whose gradient vanishes - two diagonally opposite solid corners is
      // the simple case. The CPU resolves these from the adjacent triangles in a
      // later pass; this shader has no such pass, so it counts them instead of
      // leaving a caller to discover the flat shading visually.
      atomicAdd(&counts[(chunk * COUNT_WORDS) + 2u], 1u);
    }

    let w = (chunk * SCRATCH_STRIDE) + (c * 6u);

    scratch[w]      = (f32(cx) + (px * inv) + 0.5) * SCALE;
    scratch[w + 1u] = (f32(cy) + (py * inv) + 0.5) * SCALE;
    scratch[w + 2u] = (f32(cz) + (pz * inv) + 0.5) * SCALE;
    scratch[w + 3u] = nx;
    scratch[w + 4u] = ny;
    scratch[w + 5u] = nz;

    cellSlot[cellBase + c] = 1u;   // provisional flag, the scan turns it into a slot

    c = c + stride;
  }
}

// ---------------------------------------------------------------------------
// scan_cells - exclusive prefix sum over one chunk's 4913 cell flags, then the
// vertex write. One workgroup per chunk; each thread owns a contiguous run.
//
// The scan is what makes vertex numbering match the CPU: the CPU assigns numbers
// walking cells in ascending index, which is exactly the order this sums in.
//
// This is the one pass that cannot be tiled, and at a full batch it is now the
// most expensive single dispatch in the pipeline. Splitting it into a two-level
// scan across workgroups is the next thing worth measuring.
// ---------------------------------------------------------------------------
const SCAN_THREADS : u32 = 256u;
const SCAN_RUN     : u32 = 20u;   // ceil(4913 / 256)

var<workgroup> scanSums : array<u32, 256>;

@compute @workgroup_size(256)
fn scan_cells(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
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
    atomicStore(&counts[chunk * COUNT_WORDS], total);
  }
}

// ---------------------------------------------------------------------------
// emit_quads - one field edge per thread. Every edge whose two samples straddle
// the iso-level connects the four surface cells around it into two triangles.
// ---------------------------------------------------------------------------
@compute @workgroup_size(256)
fn emit_quads(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let chunk = wg.y;
  let fieldBase = chunk * FIELD_SIZE;
  let cellBase = chunk * MAX_CELLS;
  let indexBase = chunk * MAX_INDICES;

  let margin = i32(params.margin);
  let fd = i32(FIELD_DIMS);
  let cd = i32(CELL_DIMS);
  let neg = u32(descAt(chunk, 27u));
  let stride = nwg.x * 256u;

  // 3 axes x 17 edge positions x 16 x 16
  let total = 3u * 17u * 16u * 16u;

  var n = (wg.x * 256u) + lid.x;
  loop {
    if (n >= total) { break; }

    let axis = n / (17u * 16u * 16u);
    let rest = n % (17u * 16u * 16u);
    let d = i32(rest / (16u * 16u)) - 1;
    let u = i32((rest / 16u) % 16u);
    let v = i32(rest % 16u);

    // the negative seam is owned by the neighbour on that side
    if (d == -1 && ((neg >> axis) & 1u) != 0u) { n = n + stride; continue; }

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

    if (solidA == solidB) { n = n + stride; continue; }

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
      n = n + stride;
      continue;
    }

    // quad winding - faces the empty sample. The y ring has opposite parity.
    var facePositive = solidA;
    if (axis == 1u) { facePositive = !facePositive; }
    if (params.flipped != 0u) { facePositive = !facePositive; }

    let at = atomicAdd(&counts[(chunk * COUNT_WORDS) + 1u], 6u);

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

    n = n + stride;
  }
}
`;
