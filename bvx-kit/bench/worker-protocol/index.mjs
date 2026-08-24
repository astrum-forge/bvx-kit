/**
 * What a worker mesh request actually costs.
 *
 * BVXMesher.process() is handed a BVW1 snapshot of the chunk and its 26
 * neighbours, rebuilds a VoxelWorld from it, meshes, and throws the world away.
 * This measures the three parts separately, because the split decides whether
 * moving the workers onto shared memory is worth anything.
 */
import { BVXSerializer, BVXMesher, VoxelWorld, MortonKey, VoxelSmoothGeometry, VoxelFaceGeometry, VoxelQuadGeometry } from "../../out/index.js";
import { buildWorld } from "../gpu-smooth/world.mjs";

const built = buildWorld(14, 5, 14);
const batch = built.surface.slice(0, 64);

function neighbourhoodWorld(record) {
    const world = new VoxelWorld();
    const key = new MortonKey();

    for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
            for (let oz = -1; oz <= 1; oz++) {
                MortonKey.from(record.key.x + ox, record.key.y + oy, record.key.z + oz, key);

                const chunk = built.world.get(key);

                if (chunk !== null) {
                    world.insert(chunk);
                }
            }
        }
    }

    return world;
}

function time(fn, minMs = 400) {
    fn();
    fn();

    let reps = 1;

    for (;;) {
        const start = process.hrtime.bigint();

        for (let i = 0; i < reps; i++) {
            fn();
        }

        const ms = Number(process.hrtime.bigint() - start) / 1e6;

        if (ms >= minMs) {
            return ms / reps;
        }

        reps = Math.max(reps * 2, Math.ceil(reps * (minMs / Math.max(ms, 0.05))));
    }
}

const worlds = batch.map(neighbourhoodWorld);
const snapshots = worlds.map((w) => BVXSerializer.saveWorld(w));

const bytes = snapshots.reduce((a, s) => a + s.byteLength, 0);

console.log(`64 surface chunks, 27-chunk neighbourhood snapshots`);
console.log(`  snapshot size: ${(bytes / batch.length).toFixed(0)} B/request  (${(bytes / 1024).toFixed(1)} KB total)`);
console.log(`  raw occupancy for 27 chunks would be ${27 * 512} B`);
console.log();

const encode = time(() => {
    for (const w of worlds) {
        BVXSerializer.saveWorld(w);
    }
});

const decode = time(() => {
    for (const s of snapshots) {
        BVXSerializer.loadWorld(s);
    }
});

const mesher = new BVXMesher();

// the mesher consumes the snapshot, so hand it a fresh copy each rep
const full = time(() => {
    for (let i = 0; i < batch.length; i++) {
        mesher.process({
            id: i,
            type: "smooth",
            chunkKey: batch[i].key.key,
            smoothing: 2,
            flipped: false,
            world: snapshots[i]
        });
    }
});

const geometry = new VoxelSmoothGeometry();

const meshOnly = time(() => {
    for (let i = 0; i < batch.length; i++) {
        geometry.computeGeometry(batch[i].chunk, worlds[i], 2, false, null, "primary");
    }
});

const copyOut = time(() => {
    for (let i = 0; i < batch.length; i++) {
        geometry.computeGeometry(batch[i].chunk, worlds[i], 2, false, null, "primary");
        geometry.vertices.slice();
        geometry.normals.slice();
        geometry.indices.slice();
    }
});

const n = batch.length;

console.log("per request, us:");
console.log(`  saveWorld  (main thread, per request)   ${(encode * 1000 / n).toFixed(1)}`);
console.log(`  loadWorld  (worker, per request)        ${(decode * 1000 / n).toFixed(1)}`);
console.log(`  smooth mesh only                        ${(meshOnly * 1000 / n).toFixed(1)}`);
console.log(`  smooth mesh + result copies             ${(copyOut * 1000 / n).toFixed(1)}`);
console.log(`  BVXMesher.process end to end            ${(full * 1000 / n).toFixed(1)}`);
console.log();
console.log(`  snapshot overhead as a share of a round trip: ` +
    `${(100 * (encode + decode) / (encode + full)).toFixed(1)}%`);

// --- the same for the blocky paths, which are much cheaper to mesh ----------
const faceGeometry = new VoxelFaceGeometry();
const quadGeometry = new VoxelQuadGeometry();

const faceOnly = time(() => {
    for (let i = 0; i < batch.length; i++) {
        faceGeometry.computeIndices(batch[i].chunk, worlds[i], null);
    }
});

const quadOnly = time(() => {
    for (let i = 0; i < batch.length; i++) {
        quadGeometry.computeQuads(batch[i].chunk, worlds[i], null, "corner", "merged");
    }
});

const faceFull = time(() => {
    for (let i = 0; i < batch.length; i++) {
        mesher.process({
            id: i,
            type: "faces",
            chunkKey: batch[i].key.key,
            flipped: false,
            world: snapshots[i],
            indices: false
        });
    }
});

const quadFull = time(() => {
    for (let i = 0; i < batch.length; i++) {
        mesher.process({
            id: i,
            type: "quads",
            chunkKey: batch[i].key.key,
            world: snapshots[i]
        });
    }
});

console.log("blocky paths, us per request:");
console.log(`  computeIndices only                     ${(faceOnly * 1000 / n).toFixed(1)}`);
console.log(`  BVXMesher 'faces' end to end            ${(faceFull * 1000 / n).toFixed(1)}`);
console.log(`  computeQuads only                       ${(quadOnly * 1000 / n).toFixed(1)}`);
console.log(`  BVXMesher 'quads' end to end            ${(quadFull * 1000 / n).toFixed(1)}`);
console.log();
console.log(`  snapshot overhead, faces: ${(100 * (encode + decode) / (encode + faceFull)).toFixed(1)}%`);
console.log(`  snapshot overhead, quads: ${(100 * (encode + decode) / (encode + quadFull)).toFixed(1)}%`);

// --- what the alternatives cost --------------------------------------------
//
// A shared arena removes the packaging entirely: the request carries 27 slot
// indices and the worker reads the same memory. The middle option is a raw
// neighbourhood copy into a transferable - no RLE, no per-chunk records.
const raw = new Uint32Array(27 * 128);

const rawCopy = time(() => {
    for (let i = 0; i < batch.length; i++) {
        const world = worlds[i];
        const key = new MortonKey();
        const record = batch[i];

        let slot = 0;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    MortonKey.from(record.key.x + ox, record.key.y + oy, record.key.z + oz, key);

                    const chunk = world.get(key);

                    if (chunk !== null) {
                        raw.set(chunk.layer.bitArray.elements, slot * 128);
                    }

                    slot++;
                }
            }
        }
    }
});

const allocCopy = time(() => {
    for (let i = 0; i < batch.length; i++) {
        const buffer = new Uint32Array(27 * 128);
        const world = worlds[i];
        const key = new MortonKey();
        const record = batch[i];

        let slot = 0;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    MortonKey.from(record.key.x + ox, record.key.y + oy, record.key.z + oz, key);

                    const chunk = world.get(key);

                    if (chunk !== null) {
                        buffer.set(chunk.layer.bitArray.elements, slot * 128);
                    }

                    slot++;
                }
            }
        }
    }
});

console.log();
console.log("packaging alternatives, us per request (main thread):");
console.log(`  BVW1 saveWorld (current)                ${(encode * 1000 / n).toFixed(1)}`);
console.log(`  raw 13.8 KB copy into a reused buffer   ${(rawCopy * 1000 / n).toFixed(1)}`);
console.log(`  raw 13.8 KB copy into a fresh buffer    ${(allocCopy * 1000 / n).toFixed(1)}`);
console.log(`  shared arena (27 slot indices)          ~0`);
