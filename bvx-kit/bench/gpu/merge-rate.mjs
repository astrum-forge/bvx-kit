// Measures how much single-axis greedy merging could actually remove, given that
// the editor bakes per-corner ambient occlusion and per-Voxel material into every
// quad.
//
// Greedy merging is usually quoted at 5-20x fewer triangles, but those figures come
// from meshers that carry no per-vertex data. Two coplanar faces can only merge when
// they agree about everything a vertex carries: the material and all four corner
// occlusion levels. On terrain with baked AO, most adjacent faces differ in at least
// one corner, so the achievable rate is an open question rather than a known win -
// and it decides whether the feature is worth building.
//
// Three regimes are measured, because they answer different questions:
//
//   AO + material   what the editor would actually get today
//   material only   what it would get if AO moved to the shader
//   geometry only   the usual quoted figure, i.e. the ceiling
//
//   node bench/gpu/merge-rate.mjs

import { VoxelWorld } from '../../out/lib/engine/voxel-world.js';
import { VoxelChunk16 } from '../../out/lib/engine/chunks/voxel-chunk-16.js';
import { VoxelIndex } from '../../out/lib/engine/voxel-index.js';
import { MortonKey } from '../../out/lib/math/morton-key.js';
import { VoxelQuadGeometry } from '../../out/lib/engine/geometry/voxel-quad-geometry.js';

const encode = (x, y, z) => ((x >> 2) << 10) | ((y >> 2) << 8) | ((z >> 2) << 6) | ((x & 3) << 4) | ((y & 3) << 2) | (z & 3);

function hash2(x, y) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    h = Math.imul(h ^ (h >> 13), 1274126177);
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

// Two shapes, because they merge very differently. Terrain is the realistic case;
// flat slabs are the case greedy merging is famous for.
function buildTerrain() {
    const world = new VoxelWorld();
    const idx = new VoxelIndex();

    for (let cx = 0; cx < 4; cx++) {
        for (let cy = 0; cy < 3; cy++) {
            for (let cz = 0; cz < 4; cz++) {
                const chunk = new VoxelChunk16(MortonKey.from(cx + 1, cy + 1, cz + 1));
                let solid = 0;

                for (let x = 0; x < 16; x++) {
                    for (let z = 0; z < 16; z++) {
                        const wx = cx * 16 + x, wz = cz * 16 + z;
                        const h = Math.floor(noise(wx / 24, wz / 24) * 48 * 0.7);

                        for (let y = 0; y < 16; y++) {
                            if (cy * 16 + y < h) {
                                idx.key = encode(x, y, z);
                                chunk.setBitVoxel(idx);
                                // material varies per Voxel by height, as a palette
                                // driven by terrain layers would
                                chunk.setMetaData(idx, ((cy * 16 + y) >> 2) & 0x0F);
                                solid++;
                            }
                        }
                    }
                }

                if (solid > 0) {
                    world.insert(chunk);
                }
            }
        }
    }

    return world;
}

function buildSlabs() {
    const world = new VoxelWorld();
    const idx = new VoxelIndex();

    for (let cx = 0; cx < 4; cx++) {
        for (let cz = 0; cz < 4; cz++) {
            const chunk = new VoxelChunk16(MortonKey.from(cx + 1, 1, cz + 1));

            for (let x = 0; x < 16; x++) {
                for (let z = 0; z < 16; z++) {
                    for (let y = 0; y < 4; y++) {
                        idx.key = encode(x, y, z);
                        chunk.setBitVoxel(idx);
                        chunk.setMetaData(idx, 3);
                    }
                }
            }

            world.insert(chunk);
        }
    }

    return world;
}

// Single-axis greedy merge, counted rather than built. Quads are grouped by
// (face, the two coordinates that do not vary along the merge axis, key), then
// runs of consecutive positions along the axis collapse into one quad.
//
// The merge axis is the first tangent of the face, which is what "merge along one
// axis first" means in practice.
function countMerged(quads, meta, keyOf) {
    const groups = new Map();

    for (const quad of quads) {
        const index = VoxelQuadGeometry.indexOf(quad);
        const face = VoxelQuadGeometry.faceOf(quad);

        const x = (((index >> 10) & 3) << 2) | ((index >> 4) & 3);
        const y = (((index >> 8) & 3) << 2) | ((index >> 2) & 3);
        const z = (((index >> 6) & 3) << 2) | (index & 3);

        const coords = [x, y, z];
        const axis = VoxelQuadGeometry.TANGENTS[face][0];
        const other = [0, 1, 2].filter((a) => a !== axis);

        const bucket = `${face}|${coords[other[0]]}|${coords[other[1]]}|${keyOf(quad, meta, index)}`;
        let list = groups.get(bucket);

        if (list === undefined) {
            list = [];
            groups.set(bucket, list);
        }

        list.push(coords[axis]);
    }

    let merged = 0;

    for (const list of groups.values()) {
        list.sort((a, b) => a - b);

        merged++;

        for (let i = 1; i < list.length; i++) {
            if (list[i] !== list[i - 1] + 1) {
                merged++;
            }
        }
    }

    return merged;
}

const KEYS = {
    'AO + material  (what the editor gets today)': (quad, meta, index) => {
        const ao = (quad >>> VoxelQuadGeometry.OCCLUSION_SHIFT) & 0xFF;
        return `${ao}|${meta.length > 0 ? meta[index >> 6] : 0}`;
    },
    'material only  (if AO moved to the shader)': (quad, meta, index) => `${meta.length > 0 ? meta[index >> 6] : 0}`,
    'geometry only  (the usual quoted ceiling)': () => '0'
};

const geometry = new VoxelQuadGeometry();

for (const [label, world] of [['terrain', buildTerrain()], ['flat slabs', buildSlabs()]]) {
    let raw = 0;
    const totals = Object.fromEntries(Object.keys(KEYS).map((k) => [k, 0]));

    for (const chunk of world.chunks.values()) {
        geometry.computeQuads(chunk, world);

        const quads = Array.from(geometry.quads);
        const source = chunk.metaData;
        const meta = source !== null ? Uint32Array.from(source) : new Uint32Array(0);

        raw += quads.length;

        for (const [key, keyOf] of Object.entries(KEYS)) {
            totals[key] += countMerged(quads, meta, keyOf);
        }
    }

    console.log(`\n${label}: ${raw} quads before merging`);

    for (const [key, count] of Object.entries(totals)) {
        const ratio = raw / count;
        console.log(`  ${key.padEnd(46)} ${String(count).padStart(7)} quads  ${ratio.toFixed(2)}x`);
    }
}

console.log('\nSingle-axis merge, counted per chunk (no cross-chunk merging).');
console.log('A ratio near 1.0 means the feature would remove almost nothing.');
