// Shared between the main thread and the workers so the single-thread and
// multi-thread CPU baselines run byte-identical code.
//
// This is a faithful port of bvx-kit's VoxelFaceGeometry.computeIndices as it
// stands after the 23 Aug perf pass: the empty fast path, the solid-buried fast
// path, the solid-shell boundary walk, the word-skip bit scan, and the six
// hand-unrolled direction samples. It is deliberately NOT a strawman - the point
// is to compare a GPU against the optimised CPU code, not against a naive one.

export const WORDS_PER_CHUNK = 128;   // 4096 BitVoxels / 32
export const BVX_PER_CHUNK = 4096;

export const encode = (x, y, z) =>
  ((x >> 2) << 10) | ((y >> 2) << 8) | ((z >> 2) << 6) | ((x & 3) << 4) | ((y & 3) << 2) | (z & 3);

export const NB_TABLES = (() => {
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return dirs.map(([dx, dy, dz]) => {
    const t = new Int16Array(BVX_PER_CHUNK);
    for (let i = 0; i < BVX_PER_CHUNK; i++) {
      const x = (((i >> 10) & 3) << 2) | ((i >> 4) & 3);
      const y = (((i >> 8) & 3) << 2) | ((i >> 2) & 3);
      const z = (((i >> 6) & 3) << 2) | (i & 3);
      const ni = encode((x + dx) & 15, (y + dy) & 15, (z + dz) & 15);
      const cross = (x + dx) < 0 || (x + dx) > 15 || (y + dy) < 0 || (y + dy) > 15 || (z + dz) < 0 || (z + dz) > 15;
      t[i] = cross ? -(ni + 1) : ni;
    }
    return t;
  });
})();

export const MASK_COUNTS = (() => {
  const c = new Uint8Array(64);
  for (let m = 0; m < 64; m++) { let n = 0, v = m; while (v) { n += v & 1; v >>= 1; } c[m] = n; }
  return c;
})();

export const BOUNDARY = (() => {
  const out = [];
  for (let i = 0; i < BVX_PER_CHUNK; i++) {
    const x = (((i >> 10) & 3) << 2) | ((i >> 4) & 3);
    const y = (((i >> 8) & 3) << 2) | ((i >> 2) & 3);
    const z = (((i >> 6) & 3) << 2) | (i & 3);
    if (x === 0 || x === 15 || y === 0 || y === 15 || z === 0 || z === 15) out.push(i);
  }
  return Uint16Array.from(out);
})();

const _EMPTY = new Uint32Array(WORDS_PER_CHUNK);
export const S_EMPTY = 0, S_FULL = 1, S_MIXED = 2;

export function uniformState(arr, off) {
  const first = arr[off];
  if (first !== 0 && first !== -1 && first !== 0xffffffff) return S_MIXED;
  for (let w = 1; w < WORDS_PER_CHUNK; w++) if (arr[off + w] !== first) return S_MIXED;
  return first === 0 ? S_EMPTY : S_FULL;
}

// Mesh chunks [from, to) of a world. Returns {faces, touched}.
export function cpuMeshRange(occ, nb, from, to) {
  const T0 = NB_TABLES[0], T1 = NB_TABLES[1], T2 = NB_TABLES[2];
  const T3 = NB_TABLES[3], T4 = NB_TABLES[4], T5 = NB_TABLES[5];
  const counts = MASK_COUNTS;
  let faces = 0, touched = 0;

  for (let c = from; c < to; c++) {
    const off = c * WORDS_PER_CHUNK;
    const state = uniformState(occ, off);
    if (state === S_EMPTY) continue;

    const s0 = nb[c * 8 + 0], s1 = nb[c * 8 + 1], s2 = nb[c * 8 + 2];
    const s3 = nb[c * 8 + 3], s4 = nb[c * 8 + 4], s5 = nb[c * 8 + 5];
    const o0 = s0 < 0 ? -1 : s0 * WORDS_PER_CHUNK, o1 = s1 < 0 ? -1 : s1 * WORDS_PER_CHUNK;
    const o2 = s2 < 0 ? -1 : s2 * WORDS_PER_CHUNK, o3 = s3 < 0 ? -1 : s3 * WORDS_PER_CHUNK;
    const o4 = s4 < 0 ? -1 : s4 * WORDS_PER_CHUNK, o5 = s5 < 0 ? -1 : s5 * WORDS_PER_CHUNK;

    if (state === S_FULL) {
      const f0 = o0 >= 0 && uniformState(occ, o0) === S_FULL, f1 = o1 >= 0 && uniformState(occ, o1) === S_FULL;
      const f2 = o2 >= 0 && uniformState(occ, o2) === S_FULL, f3 = o3 >= 0 && uniformState(occ, o3) === S_FULL;
      const f4 = o4 >= 0 && uniformState(occ, o4) === S_FULL, f5 = o5 >= 0 && uniformState(occ, o5) === S_FULL;
      if (f0 && f1 && f2 && f3 && f4 && f5) continue;   // solid-buried: free

      const bnd = BOUNDARY, len = bnd.length;
      for (let b = 0; b < len; b++) {
        const i = bnd[b];
        const n0 = T0[i], n1 = T1[i], n2 = T2[i], n3 = T3[i], n4 = T4[i], n5 = T5[i];
        const mask =
          ((n0 < 0 && !f0 ? (o0 < 0 ? 1 : (((occ[o0 + ((~n0) >>> 5)] >>> (~n0 & 31)) & 1) ^ 1)) : 0)) |
          ((n1 < 0 && !f1 ? (o1 < 0 ? 1 : (((occ[o1 + ((~n1) >>> 5)] >>> (~n1 & 31)) & 1) ^ 1)) : 0) << 1) |
          ((n2 < 0 && !f2 ? (o2 < 0 ? 1 : (((occ[o2 + ((~n2) >>> 5)] >>> (~n2 & 31)) & 1) ^ 1)) : 0) << 2) |
          ((n3 < 0 && !f3 ? (o3 < 0 ? 1 : (((occ[o3 + ((~n3) >>> 5)] >>> (~n3 & 31)) & 1) ^ 1)) : 0) << 3) |
          ((n4 < 0 && !f4 ? (o4 < 0 ? 1 : (((occ[o4 + ((~n4) >>> 5)] >>> (~n4 & 31)) & 1) ^ 1)) : 0) << 4) |
          ((n5 < 0 && !f5 ? (o5 < 0 ? 1 : (((occ[o5 + ((~n5) >>> 5)] >>> (~n5 & 31)) & 1) ^ 1)) : 0) << 5);
        if (mask === 0) continue;
        touched++; faces += counts[mask];
      }
      continue;
    }

    for (let w = 0; w < WORDS_PER_CHUNK; w++) {
      let word = occ[off + w];
      if (word === 0) continue;
      const wordOffset = w << 5;
      while (word !== 0) {
        const low = word & -word;
        const i = wordOffset + (31 - Math.clz32(low));
        word ^= low;

        const n0 = T0[i], n1 = T1[i], n2 = T2[i], n3 = T3[i], n4 = T4[i], n5 = T5[i];
        const b0 = n0 >= 0 ? (occ[off + (n0 >>> 5)] >>> (n0 & 31)) & 1 : (o0 < 0 ? 0 : (occ[o0 + ((~n0) >>> 5)] >>> (~n0 & 31)) & 1);
        const b1 = n1 >= 0 ? (occ[off + (n1 >>> 5)] >>> (n1 & 31)) & 1 : (o1 < 0 ? 0 : (occ[o1 + ((~n1) >>> 5)] >>> (~n1 & 31)) & 1);
        const b2 = n2 >= 0 ? (occ[off + (n2 >>> 5)] >>> (n2 & 31)) & 1 : (o2 < 0 ? 0 : (occ[o2 + ((~n2) >>> 5)] >>> (~n2 & 31)) & 1);
        const b3 = n3 >= 0 ? (occ[off + (n3 >>> 5)] >>> (n3 & 31)) & 1 : (o3 < 0 ? 0 : (occ[o3 + ((~n3) >>> 5)] >>> (~n3 & 31)) & 1);
        const b4 = n4 >= 0 ? (occ[off + (n4 >>> 5)] >>> (n4 & 31)) & 1 : (o4 < 0 ? 0 : (occ[o4 + ((~n4) >>> 5)] >>> (~n4 & 31)) & 1);
        const b5 = n5 >= 0 ? (occ[off + (n5 >>> 5)] >>> (n5 & 31)) & 1 : (o5 < 0 ? 0 : (occ[o5 + ((~n5) >>> 5)] >>> (~n5 & 31)) & 1);

        const mask = ((b0 ^ 1)) | ((b1 ^ 1) << 1) | ((b2 ^ 1) << 2) | ((b3 ^ 1) << 3) | ((b4 ^ 1) << 4) | ((b5 ^ 1) << 5);
        if (mask === 0) continue;
        touched++; faces += counts[mask];
      }
    }
  }
  return { faces, touched };
}

// --- world generation: value-noise heightfield, terrain-shaped, not random fill ---
function hash2(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >> 13), 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

export function buildWorld(CX, CY, CZ, shared) {
  const n = CX * CY * CZ;
  const occBytes = n * WORDS_PER_CHUNK * 4;
  const nbBytes = n * 8 * 4;
  const Buf = shared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
  const occ = new Uint32Array(new Buf(occBytes));
  const nb = new Int32Array(new Buf(nbBytes)).fill(-1);
  const slotOf = (cx, cy, cz) =>
    (cx < 0 || cy < 0 || cz < 0 || cx >= CX || cy >= CY || cz >= CZ) ? -1 : (cx * CY + cy) * CZ + cz;

  const maxH = CY * 16;
  const W = CX * 16, D = CZ * 16;
  const height = new Int32Array(W * D);
  for (let wx = 0; wx < W; wx++) for (let wz = 0; wz < D; wz++) {
    let h = 0, amp = 1, freq = 1 / 48, norm = 0;
    for (let o = 0; o < 4; o++) { h += valueNoise(wx * freq, wz * freq) * amp; norm += amp; amp *= 0.5; freq *= 2; }
    height[wx * D + wz] = Math.floor((h / norm) * maxH * 0.55 + maxH * 0.18);
  }

  for (let cx = 0; cx < CX; cx++) for (let cy = 0; cy < CY; cy++) for (let cz = 0; cz < CZ; cz++) {
    const base = slotOf(cx, cy, cz) * WORDS_PER_CHUNK;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const top = Math.min(16, height[(cx * 16 + x) * D + (cz * 16 + z)] - cy * 16);
      for (let y = 0; y < top; y++) {
        const i = encode(x, y, z);
        occ[base + (i >>> 5)] |= (1 << (i & 31)) >>> 0;
      }
    }
  }

  for (let cx = 0; cx < CX; cx++) for (let cy = 0; cy < CY; cy++) for (let cz = 0; cz < CZ; cz++) {
    const s = slotOf(cx, cy, cz) * 8;
    nb[s + 0] = slotOf(cx + 1, cy, cz); nb[s + 1] = slotOf(cx - 1, cy, cz);
    nb[s + 2] = slotOf(cx, cy + 1, cz); nb[s + 3] = slotOf(cx, cy - 1, cz);
    nb[s + 4] = slotOf(cx, cy, cz + 1); nb[s + 5] = slotOf(cx, cy, cz - 1);
  }

  const classes = { empty: 0, full: 0, mixed: 0 };
  for (let c = 0; c < n; c++) {
    const s = uniformState(occ, c * WORDS_PER_CHUNK);
    if (s === S_EMPTY) classes.empty++; else if (s === S_FULL) classes.full++; else classes.mixed++;
  }
  return { occ, nb, count: n, classes };
}

// Dense sub-world of the first `want` chunks matching `pred`, with neighbours
// remapped and out-of-set references cleared to -1 (air, matching the kit's
// placeholder chunk). Used both for the surface-only world and the batch sweep,
// so CPU and GPU always see exactly the same inputs.
export function subWorld(world, keepIdx, shared) {
  const map = new Int32Array(world.count).fill(-1);
  for (let i = 0; i < keepIdx.length; i++) map[keepIdx[i]] = i;
  const n = keepIdx.length;
  const Buf = shared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
  const occ = new Uint32Array(new Buf(n * WORDS_PER_CHUNK * 4));
  const nb = new Int32Array(new Buf(n * 8 * 4)).fill(-1);
  for (let i = 0; i < n; i++) {
    const src = keepIdx[i] * WORDS_PER_CHUNK;
    for (let w = 0; w < WORDS_PER_CHUNK; w++) occ[i * WORDS_PER_CHUNK + w] = world.occ[src + w];
    for (let d = 0; d < 6; d++) {
      const s = world.nb[keepIdx[i] * 8 + d];
      nb[i * 8 + d] = s < 0 ? -1 : map[s];
    }
  }
  const classes = { empty: 0, full: 0, mixed: 0 };
  for (let c = 0; c < n; c++) {
    const s = uniformState(occ, c * WORDS_PER_CHUNK);
    if (s === S_EMPTY) classes.empty++; else if (s === S_FULL) classes.full++; else classes.mixed++;
  }
  return { occ, nb, count: n, classes };
}

export function mixedIndices(world) {
  const out = [];
  for (let c = 0; c < world.count; c++) if (uniformState(world.occ, c * WORDS_PER_CHUNK) === S_MIXED) out.push(c);
  return out;
}
