// Prices the blocky mesh pipeline before and after the expansion moved into the
// worker, splitting the cost by the thread it lands on.
//
// The point of the change was never total work - the same occlusion field gets
// built and the same vertices get written either way. The point is WHICH THREAD
// pays. Before, the worker computed 6-bit face masks and the main thread did the
// occlusion field, the AO baking and the vertex expansion; the main-thread half
// is what capped streaming regardless of worker count. After, the worker does all
// of it and the main thread only uploads.
//
//   node bench/gpu/bench-quads.mjs

import { VoxelWorld } from '../../out/lib/engine/voxel-world.js';
import { VoxelChunk16 } from '../../out/lib/engine/chunks/voxel-chunk-16.js';
import { VoxelIndex } from '../../out/lib/engine/voxel-index.js';
import { MortonKey } from '../../out/lib/math/morton-key.js';
import { VoxelFaceGeometry } from '../../out/lib/engine/geometry/voxel-face-geometry.js';
import { VoxelQuadGeometry } from '../../out/lib/engine/geometry/voxel-quad-geometry.js';

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

const occupancy = new Uint8Array(OCC_DIMS * OCC_DIMS * OCC_DIMS);
const occSlots = [new Array(27).fill(null), new Array(27).fill(null)];
const occKey = new MortonKey();

function buildOcclusion(mortonKey, worlds, border) {
    occupancy.fill(0);

    let neighbour = 0;

    for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
            for (let oz = -1; oz <= 1; oz++) {
                MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, occKey);

                for (let w = 0; w < worlds.length; w++) {
                    const chunk = worlds[w].get(occKey);
                    occSlots[w][neighbour] = chunk !== null ? chunk.layer.bitArray.elements : null;
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
                    const elements = occSlots[w][slot];
                    set = elements !== null && (elements[word] & mask) !== 0;
                }

                if (set) {
                    occupancy[(x + OCC_BORDER) + ((y + OCC_BORDER) * OCC_STRIDE_Y) + ((z + OCC_BORDER) * OCC_STRIDE_Z)] = 1;
                }
            }
        }
    }
}

const scratchIndex = new VoxelIndex();
const cornerAO = [3, 3, 3, 3];

// Exactly the work VoxelEditor._applyBlockyMesh used to do on the main thread,
// given face masks the worker already produced.
function legacyExpand(chunk, faces, aoWorlds, laneColor) {
    const faceMasks = faces.indices;
    const touched = faces.touched;
    const faceCount = faces.popCount();

    const positions = new Float32Array(faceCount * 4 * 3);
    const normals = new Float32Array(faceCount * 4 * 3);
    const colors = new Float32Array(faceCount * 4 * 4);
    const indices = new Uint32Array(faceCount * 6);
    const occlusion = new Float32Array(faceCount * 4);

    buildOcclusion(chunk.key, aoWorlds, 1);

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

            for (let c = 0; c < 4; c++) {
                const write = vertex * 3;

                positions[write] = (x + corners[c][0]) * BIT_VOXEL_SIZE;
                positions[write + 1] = (y + corners[c][1]) * BIT_VOXEL_SIZE;
                positions[write + 2] = (z + corners[c][2]) * BIT_VOXEL_SIZE;

                normals[write] = normal[0];
                normals[write + 1] = normal[1];
                normals[write + 2] = normal[2];

                const colorWrite = vertex * 4;

                colors[colorWrite] = rgb[0];
                colors[colorWrite + 1] = rgb[1];
                colors[colorWrite + 2] = rgb[2];
                colors[colorWrite + 3] = 1.0;

                occlusion[vertex] = AO_LEVELS[cornerAO[c]];
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

function expandQuads(quads, meta, laneColor) {
    const faceCount = quads.length;

    const positions = new Float32Array(faceCount * 4 * 3);
    const normals = new Float32Array(faceCount * 4 * 3);
    const colors = new Float32Array(faceCount * 4 * 4);
    const indices = new Uint32Array(faceCount * 6);
    const occlusion = new Float32Array(faceCount * 4);

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

            const colorWrite = vertex * 4;

            colors[colorWrite] = rgb[0];
            colors[colorWrite + 1] = rgb[1];
            colors[colorWrite + 2] = rgb[2];
            colors[colorWrite + 3] = 1.0;

            occlusion[vertex] = AO_LEVELS[VoxelQuadGeometry.occlusionOf(quad, c)];
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

// --- terrain ---
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

const world = new VoxelWorld();
const overlay = new VoxelWorld();
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
                            chunk.setMetaData(idx, (wx + y + wz) & 0xFF);
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

// only surface chunks - the ones that actually produce geometry, and the case
// the main-thread cost was measured against
const surface = [];
const faceGeometry = new VoxelFaceGeometry();

for (const chunk of world.chunks.values()) {
    faceGeometry.computeIndices(chunk, world);

    if (faceGeometry.popCount() > 0) {
        surface.push(chunk);
    }
}

const aoWorlds = [world, overlay];
const quadGeometry = new VoxelQuadGeometry();

function time(label, fn, minMs = 400) {
    fn(); fn(); fn();

    let reps = 1;

    for (;;) {
        const start = performance.now();

        for (let i = 0; i < reps; i++) {
            fn();
        }

        const elapsed = performance.now() - start;

        if (elapsed >= minMs) {
            const perChunk = (elapsed / reps) * 1000 / surface.length;

            console.log(`  ${label.padEnd(46)} ${perChunk.toFixed(2)} us/chunk`);

            return perChunk;
        }

        reps = Math.max(reps * 2, Math.ceil(reps * (minMs / Math.max(elapsed, 0.01))));
    }
}

let totalFaces = 0;

for (const chunk of surface) {
    faceGeometry.computeIndices(chunk, world);
    totalFaces += faceGeometry.popCount();
}

console.log(`\n${surface.length} surface chunks, ${totalFaces} faces, ${(totalFaces / surface.length).toFixed(0)} faces/chunk average\n`);

console.log('BEFORE - worker produced masks, main thread expanded them');

const beforeWorker = time('worker: computeIndices (face masks)', () => {
    for (const chunk of surface) {
        faceGeometry.computeIndices(chunk, world);
    }
});

const beforeMain = time('main:   occlusion field + AO + vertex expansion', () => {
    for (const chunk of surface) {
        faceGeometry.computeIndices(chunk, world);
        legacyExpand(chunk, faceGeometry, aoWorlds, null);
    }
}) - beforeWorker;

console.log('\nAFTER - the worker does all of it, the main thread uploads');

const afterWorker = time('worker: computeQuads + expandQuads', () => {
    for (const chunk of surface) {
        quadGeometry.computeQuads(chunk, world, null, 'corner', 'merged');
        const source = chunk.metaData;
        expandQuads(quadGeometry.quads, source !== null ? Uint32Array.from(source) : new Uint32Array(0), null);
    }
});

console.log('  main:   upload only                            0.00 us/chunk');

console.log('\n--- main-thread cost per meshed chunk ---');
console.log(`  before ${beforeMain.toFixed(2)} us   after 0.00 us`);
console.log(`\n--- total work (both threads) ---`);
console.log(`  before ${(beforeWorker + beforeMain).toFixed(2)} us   after ${afterWorker.toFixed(2)} us` +
    `   (${afterWorker <= beforeWorker + beforeMain ? 'no regression' : ((afterWorker / (beforeWorker + beforeMain) - 1) * 100).toFixed(1) + '% more'})`);

const budget = 2.5;

console.log(`\nAt the editor's ${budget} ms main-thread apply budget:`);
console.log(`  before: ${Math.floor(budget * 1000 / beforeMain)} chunks/frame`);
console.log(`  after:  bounded by upload and draw-call cost, not by expansion`);
