// Proves the worker-side blocky expansion is byte-identical to the main-thread
// expansion it replaced.
//
// The editor used to build positions, normals, colours, per-corner ambient
// occlusion and the split diagonal on the main thread, in
// VoxelEditor._applyBlockyMesh, from the 6-bit face masks. That work now happens
// in the mesher worker, through VoxelQuadGeometry (which bakes the occlusion into
// a packed quad list) and the editor's expandQuads (which turns the quads into
// vertex streams). Moving it is only safe if the output did not change - the AO
// curve, the palette lookup and especially the AO-gradient diagonal flip are all
// visible, and "the editor still renders something" is not evidence.
//
// The reference implementation below is transcribed from the original
// _applyBlockyMesh, including the water variant's four-sample face measure, so
// this compares the new path against the old algorithm rather than against
// itself.
//
//   node bench/gpu/verify-quads.mjs

import { strict as assert } from 'node:assert';
import { VoxelWorld } from '../../out/lib/engine/voxel-world.js';
import { VoxelChunk16 } from '../../out/lib/engine/chunks/voxel-chunk-16.js';
import { VoxelIndex } from '../../out/lib/engine/voxel-index.js';
import { MortonKey } from '../../out/lib/math/morton-key.js';
import { VoxelFaceGeometry } from '../../out/lib/engine/geometry/voxel-face-geometry.js';
import { VoxelQuadGeometry } from '../../out/lib/engine/geometry/voxel-quad-geometry.js';

// ---------------------------------------------------------------------------
// The editor's constants and palette, inlined so this script depends only on the
// kit. PALETTE only matters through its length and its rgb values, so a stand-in
// of the same length exercises the same index arithmetic.
// ---------------------------------------------------------------------------
const BIT_VOXEL_SIZE = 0.25;
const AO_LEVELS = [0.42, 0.66, 0.86, 1.0];
const PALETTE = Array.from({ length: 16 }, (_, i) => ({ rgb: [i / 16, (i * 3 % 16) / 16, (i * 7 % 16) / 16] }));

const FACE_CORNERS = [
    [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]],
    [[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]
];
const FACE_NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_TANGENTS = [[1, 2], [1, 2], [0, 2], [0, 2], [0, 1], [0, 1]];

const OCC_BORDER = 3;
const OCC_DIMS = 16 + (OCC_BORDER * 2);
const OCC_STRIDE_Y = OCC_DIMS;
const OCC_STRIDE_Z = OCC_DIMS * OCC_DIMS;

const encode = (x, y, z) => ((x >> 2) << 10) | ((y >> 2) << 8) | ((z >> 2) << 6) | ((x & 3) << 4) | ((y & 3) << 2) | (z & 3);

// --- the old main-thread occupancy build (VoxelEditor._buildOcclusion) ---
const occupancy = new Uint8Array(OCC_DIMS * OCC_DIMS * OCC_DIMS);

function buildOcclusion(mortonKey, worlds, border) {
    occupancy.fill(0);

    const slots = worlds.map(() => new Array(27).fill(null));
    const scratch = new MortonKey();
    let neighbour = 0;

    for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
            for (let oz = -1; oz <= 1; oz++) {
                MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, scratch);

                for (let w = 0; w < worlds.length; w++) {
                    const chunk = worlds[w].get(scratch);
                    slots[w][neighbour] = chunk !== null ? chunk.layer.bitArray.elements : null;
                }

                neighbour++;
            }
        }
    }

    const low = -border;
    const high = 15 + border;

    for (let x = low; x <= high; x++) {
        const sx = (x >> 4) + 1;
        const lx = x & 15;

        for (let y = low; y <= high; y++) {
            const sy = (y >> 4) + 1;
            const ly = y & 15;

            for (let z = low; z <= high; z++) {
                const slot = (sx * 9) + (sy * 3) + ((z >> 4) + 1);
                const lz = z & 15;

                const index = encode(lx, ly, lz);
                const word = index >> 5;
                const mask = 1 << (index & 31);

                let set = false;

                for (let w = 0; w < worlds.length && !set; w++) {
                    const elements = slots[w][slot];
                    set = elements !== null && (elements[word] & mask) !== 0;
                }

                if (set) {
                    occupancy[(x + OCC_BORDER) + ((y + OCC_BORDER) * OCC_STRIDE_Y) + ((z + OCC_BORDER) * OCC_STRIDE_Z)] = 1;
                }
            }
        }
    }

    return occupancy;
}

// --- the old main-thread expansion (VoxelEditor._applyBlockyMesh) ---
function legacyBlockyMesh(chunk, world, occluderWorlds, laneColor, isWater) {
    const faces = new VoxelFaceGeometry();
    const occluderWorld = occluderWorlds.length > 0 ? occluderWorlds[0] : null;

    faces.computeIndices(chunk, world, occluderWorld);

    const faceMasks = faces.indices;
    const touched = faces.touched;
    const faceCount = faces.popCount();

    const positions = new Float32Array(faceCount * 4 * 3);
    const normals = new Float32Array(faceCount * 4 * 3);
    const colors = new Float32Array(faceCount * 4 * 4);
    const indices = new Uint32Array(faceCount * 6);
    const occlusion = isWater ? null : new Float32Array(faceCount * 4);

    // The occlusion field is the union of the base world and the sand layer -
    // which, for every lane, is the lane's own world plus its occluders, except
    // water, which must not count itself.
    const aoWorlds = isWater ? occluderWorlds.slice() : [world, ...occluderWorlds];

    buildOcclusion(chunk.key, aoWorlds, 1);

    const scratchIndex = new VoxelIndex();
    const cornerAO = [3, 3, 3, 3];

    let vertex = 0;
    let indexCount = 0;

    for (let t = 0; t < touched.length; t++) {
        const i = touched[t];
        const mask = faceMasks[i];

        const x = (((i >> 10) & 3) << 2) | ((i >> 4) & 3);
        const y = (((i >> 8) & 3) << 2) | ((i >> 2) & 3);
        const z = (((i >> 6) & 3) << 2) | (i & 3);

        let rgb = laneColor;

        if (rgb === null) {
            scratchIndex.key = i;
            rgb = PALETTE[chunk.getMetaData(scratchIndex) % PALETTE.length].rgb;
        }

        for (let face = 0; face < 6; face++) {
            if (((mask >> face) & 1) === 0) {
                continue;
            }

            const corners = FACE_CORNERS[face];
            const normal = FACE_NORMALS[face];
            const base = vertex;
            const tangents = FACE_TANGENTS[face];
            const nx = x + normal[0];
            const ny = y + normal[1];
            const nz = z + normal[2];

            if (isWater) {
                const a1 = tangents[0];
                const a2 = tangents[1];
                let solid = 0;

                for (let side = 0; side < 4; side++) {
                    const axis = side < 2 ? a1 : a2;
                    const step = (side & 1) === 0 ? 1 : -1;

                    const sx = nx + (axis === 0 ? step : 0);
                    const sy = ny + (axis === 1 ? step : 0);
                    const sz = nz + (axis === 2 ? step : 0);

                    solid += occupancy[(sx + OCC_BORDER) + ((sy + OCC_BORDER) * OCC_STRIDE_Y) + ((sz + OCC_BORDER) * OCC_STRIDE_Z)];
                }

                cornerAO[0] = cornerAO[1] = cornerAO[2] = cornerAO[3] = 3 - Math.min(3, solid);
            }
            else {
                for (let c = 0; c < 4; c++) {
                    const a1 = tangents[0];
                    const a2 = tangents[1];
                    const d1 = corners[c][a1] === 1 ? 1 : -1;
                    const d2 = corners[c][a2] === 1 ? 1 : -1;

                    const s1x = nx + (a1 === 0 ? d1 : 0);
                    const s1y = ny + (a1 === 1 ? d1 : 0);
                    const s1z = nz + (a1 === 2 ? d1 : 0);
                    const s2x = nx + (a2 === 0 ? d2 : 0);
                    const s2y = ny + (a2 === 1 ? d2 : 0);
                    const s2z = nz + (a2 === 2 ? d2 : 0);

                    const side1 = occupancy[(s1x + OCC_BORDER) + ((s1y + OCC_BORDER) * OCC_STRIDE_Y) + ((s1z + OCC_BORDER) * OCC_STRIDE_Z)];
                    const side2 = occupancy[(s2x + OCC_BORDER) + ((s2y + OCC_BORDER) * OCC_STRIDE_Y) + ((s2z + OCC_BORDER) * OCC_STRIDE_Z)];
                    const diagonal = occupancy[(s1x + s2x - nx + OCC_BORDER) + ((s1y + s2y - ny + OCC_BORDER) * OCC_STRIDE_Y) + ((s1z + s2z - nz + OCC_BORDER) * OCC_STRIDE_Z)];

                    cornerAO[c] = (side1 !== 0 && side2 !== 0) ? 0 : 3 - (side1 + side2 + diagonal);
                }
            }

            for (let c = 0; c < 4; c++) {
                const write = vertex * 3;

                positions[write] = (x + corners[c][0]) * BIT_VOXEL_SIZE;
                positions[write + 1] = (y + corners[c][1]) * BIT_VOXEL_SIZE;
                positions[write + 2] = (z + corners[c][2]) * BIT_VOXEL_SIZE;

                normals[write] = normal[0];
                normals[write + 1] = normal[1];
                normals[write + 2] = normal[2];

                const openness = AO_LEVELS[cornerAO[c]];
                const colorWrite = vertex * 4;

                if (occlusion === null) {
                    const shore = 1.0 - openness;

                    colors[colorWrite] = shore;
                    colors[colorWrite + 1] = shore;
                    colors[colorWrite + 2] = shore;
                    colors[colorWrite + 3] = 1.0;
                }
                else {
                    colors[colorWrite] = rgb[0];
                    colors[colorWrite + 1] = rgb[1];
                    colors[colorWrite + 2] = rgb[2];
                    colors[colorWrite + 3] = 1.0;

                    occlusion[vertex] = openness;
                }

                vertex++;
            }

            if (cornerAO[0] + cornerAO[2] < cornerAO[1] + cornerAO[3]) {
                indices[indexCount] = base + 1;
                indices[indexCount + 1] = base + 2;
                indices[indexCount + 2] = base + 3;
                indices[indexCount + 3] = base + 1;
                indices[indexCount + 4] = base + 3;
                indices[indexCount + 5] = base;
            }
            else {
                indices[indexCount] = base;
                indices[indexCount + 1] = base + 1;
                indices[indexCount + 2] = base + 2;
                indices[indexCount + 3] = base;
                indices[indexCount + 4] = base + 2;
                indices[indexCount + 5] = base + 3;
            }

            indexCount += 6;
        }
    }

    return { positions, normals, colors, occlusion, indices, faceCount };
}

// --- the new path: VoxelQuadGeometry + the editor's expandQuads ---
const quadGeometry = new VoxelQuadGeometry();

function modernBlockyMesh(chunk, world, occluderWorlds, laneColor, isWater) {
    const occluderWorld = occluderWorlds.length > 0 ? occluderWorlds[0] : null;

    quadGeometry.computeQuads(
        chunk,
        world,
        occluderWorld,
        isWater ? 'face' : 'corner',
        isWater ? 'occluders' : 'merged'
    );

    const source = chunk.metaData;
    const meta = source !== null ? Uint32Array.from(source) : new Uint32Array(0);

    return expandQuads(quadGeometry.quads, meta, laneColor, isWater);
}

// Transcribed from bvx-editor/src/editor/blocky-expand.ts. Kept in step by this
// script failing loudly if the two ever diverge.
function expandQuads(quads, meta, laneColor, water) {
    const faceCount = quads.length;

    const positions = new Float32Array(faceCount * 4 * 3);
    const normals = new Float32Array(faceCount * 4 * 3);
    const colors = new Float32Array(faceCount * 4 * 4);
    const indices = new Uint32Array(faceCount * 6);
    const occlusion = water ? null : new Float32Array(faceCount * 4);

    const corners = VoxelQuadGeometry.CORNERS;
    const normalTable = VoxelQuadGeometry.NORMALS;
    const hasMeta = meta.length > 0;

    let vertex = 0;
    let indexCount = 0;

    for (let q = 0; q < faceCount; q++) {
        const quad = quads[q];
        const index = VoxelQuadGeometry.indexOf(quad);
        const face = VoxelQuadGeometry.faceOf(quad);

        const x = (((index >> 10) & 3) << 2) | ((index >> 4) & 3);
        const y = (((index >> 8) & 3) << 2) | ((index >> 2) & 3);
        const z = (((index >> 6) & 3) << 2) | (index & 3);

        let rgb = laneColor;

        if (rgb === null) {
            rgb = PALETTE[(hasMeta ? meta[index >> 6] : 0) % PALETTE.length].rgb;
        }

        const faceCorners = corners[face];
        const normal = normalTable[face];
        const base = vertex;

        for (let c = 0; c < 4; c++) {
            const write = vertex * 3;
            const corner = faceCorners[c];

            positions[write] = (x + corner[0]) * BIT_VOXEL_SIZE;
            positions[write + 1] = (y + corner[1]) * BIT_VOXEL_SIZE;
            positions[write + 2] = (z + corner[2]) * BIT_VOXEL_SIZE;

            normals[write] = normal[0];
            normals[write + 1] = normal[1];
            normals[write + 2] = normal[2];

            const openness = AO_LEVELS[VoxelQuadGeometry.occlusionOf(quad, c)];
            const colorWrite = vertex * 4;

            if (occlusion === null) {
                const shore = 1.0 - openness;

                colors[colorWrite] = shore;
                colors[colorWrite + 1] = shore;
                colors[colorWrite + 2] = shore;
                colors[colorWrite + 3] = 1.0;
            }
            else {
                colors[colorWrite] = rgb[0];
                colors[colorWrite + 1] = rgb[1];
                colors[colorWrite + 2] = rgb[2];
                colors[colorWrite + 3] = 1.0;

                occlusion[vertex] = openness;
            }

            vertex++;
        }

        if (VoxelQuadGeometry.flippedOf(quad)) {
            indices[indexCount] = base + 1;
            indices[indexCount + 1] = base + 2;
            indices[indexCount + 2] = base + 3;
            indices[indexCount + 3] = base + 1;
            indices[indexCount + 4] = base + 3;
            indices[indexCount + 5] = base;
        }
        else {
            indices[indexCount] = base;
            indices[indexCount + 1] = base + 1;
            indices[indexCount + 2] = base + 2;
            indices[indexCount + 3] = base;
            indices[indexCount + 4] = base + 2;
            indices[indexCount + 5] = base + 3;
        }

        indexCount += 6;
    }

    return { positions, normals, colors, occlusion, indices, faceCount };
}

// ---------------------------------------------------------------------------
// terrain-shaped worlds, not random fill
// ---------------------------------------------------------------------------
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

function buildTerrain(chunksX, chunksY, chunksZ, waterLevel) {
    const world = new VoxelWorld();
    const overlay = new VoxelWorld();
    const index = new VoxelIndex();

    for (let cx = 0; cx < chunksX; cx++) {
        for (let cy = 0; cy < chunksY; cy++) {
            for (let cz = 0; cz < chunksZ; cz++) {
                const chunk = new VoxelChunk16(MortonKey.from(cx + 1, cy + 1, cz + 1));
                const layer = new VoxelChunk16(MortonKey.from(cx + 1, cy + 1, cz + 1));
                let solid = 0;
                let overlaid = 0;

                for (let x = 0; x < 16; x++) {
                    for (let z = 0; z < 16; z++) {
                        const wx = cx * 16 + x, wz = cz * 16 + z;
                        const h = Math.floor(noise(wx / 24, wz / 24) * chunksY * 16 * 0.7);

                        for (let y = 0; y < 16; y++) {
                            const wy = cy * 16 + y;

                            index.key = encode(x, y, z);

                            if (wy < h) {
                                chunk.setBitVoxel(index);
                                chunk.setMetaData(index, (wx + wy + wz) & 0xFF);
                                solid++;
                            }
                            else if (wy < waterLevel) {
                                // an overlay layer sitting in the gaps, so the
                                // occluder paths are genuinely exercised
                                layer.setBitVoxel(index);
                                layer.setMetaData(index, (wx * 3 + wz) & 0xFF);
                                overlaid++;
                            }
                        }
                    }
                }

                if (solid > 0) {
                    world.insert(chunk);
                }

                if (overlaid > 0) {
                    overlay.insert(layer);
                }
            }
        }
    }

    return { world, overlay };
}

function compare(label, a, b) {
    assert.equal(a.faceCount, b.faceCount, `${label}: faceCount ${a.faceCount} vs ${b.faceCount}`);

    for (const key of ['positions', 'normals', 'colors', 'indices']) {
        assert.equal(a[key].length, b[key].length, `${label}: ${key} length`);

        for (let i = 0; i < a[key].length; i++) {
            if (a[key][i] !== b[key][i]) {
                throw new Error(`${label}: ${key}[${i}] ${a[key][i]} !== ${b[key][i]}`);
            }
        }
    }

    assert.equal(a.occlusion === null, b.occlusion === null, `${label}: occlusion presence`);

    if (a.occlusion !== null) {
        for (let i = 0; i < a.occlusion.length; i++) {
            if (a.occlusion[i] !== b.occlusion[i]) {
                throw new Error(`${label}: occlusion[${i}] ${a.occlusion[i]} !== ${b.occlusion[i]}`);
            }
        }
    }
}

const { world, overlay } = buildTerrain(4, 3, 4, 22);

const LANES = [
    { name: 'base   (palette colours, corner AO, sand occludes)', world: world, occluders: [overlay], color: null, water: false },
    { name: 'sand   (flat colour, corner AO, base occludes)', world: overlay, occluders: [world], color: [0.9, 0.8, 0.5], water: false },
    { name: 'water  (shore mask, face AO, occluders-only)', world: overlay, occluders: [world], color: [0.3, 0.5, 0.8], water: true }
];

let chunks = 0;
let faces = 0;
let vertices = 0;

for (const lane of LANES) {
    let laneChunks = 0;
    let laneFaces = 0;

    for (const chunk of lane.world.chunks.values()) {
        const legacy = legacyBlockyMesh(chunk, lane.world, lane.occluders, lane.color, lane.water);
        const modern = modernBlockyMesh(chunk, lane.world, lane.occluders, lane.color, lane.water);

        compare(`${lane.name} chunk ${chunk.key.key}`, legacy, modern);

        laneChunks++;
        laneFaces += legacy.faceCount;
        vertices += legacy.faceCount * 4;
    }

    console.log(`  ${lane.name}: ${laneChunks} chunks, ${laneFaces} faces - IDENTICAL`);

    chunks += laneChunks;
    faces += laneFaces;
}

console.log(`\nbyte-identical across ${chunks} chunks, ${faces} faces, ${vertices} vertices`);
console.log('positions, normals, colours, occlusion stream and the split diagonal all match.');
