/**
 * Proves and prices the shared-arena path against the snapshot protocol.
 *
 * Two things are measured, both per meshed chunk:
 *
 * - what the main thread spends preparing a request
 * - what the worker spends before it can start meshing
 *
 * Round-trip wall clock is deliberately not the headline. It is dominated by
 * scheduling noise, and the cost that actually bounds streaming throughput is the
 * main thread's share - the report's whole 25-chunks-per-frame budget comes from it.
 *
 * Run `npm run build-ts` first.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
    MortonKey, VoxelWorld, VoxelChunk16, VoxelChunkArena,
    VoxelFaceGeometry, BVXGeometry, BVXSerializer
} from "../../out/index.js";
import { surfaceHeight, DIMS, time } from "../geometry/workloads.mjs";

const RADIUS = 1;
const SPAN = (RADIUS * 2) + 1;
const CHUNK_COUNT = SPAN * SPAN * SPAN;

// ---- build the same terrain twice: once self-allocating, once in a shared arena ----

function fillTerrain(chunk, cx, cy, cz) {
    const elements = chunk.layer.bitArray.elements;

    for (let x = 0; x < DIMS; x++) {
        for (let z = 0; z < DIMS; z++) {
            const surface = surfaceHeight(cx * DIMS + x, cz * DIMS + z);

            for (let y = 0; y < DIMS; y++) {
                if (cy * DIMS + y > surface) {
                    continue;
                }

                const index = ((x >> 2) << 10) | ((y >> 2) << 8) | ((z >> 2) << 6) | ((x & 3) << 4) | ((y & 3) << 2) | (z & 3);

                elements[index >> 5] |= (1 << (index & 31));
            }
        }
    }
}

const CENTER = { x: 8, y: 2, z: 8 };

// the ordinary world, chunks owning their own storage
const ownedWorld = new VoxelWorld();

for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dz = -RADIUS; dz <= RADIUS; dz++) {
            const cx = CENTER.x + dx;
            const cy = CENTER.y + dy;
            const cz = CENTER.z + dz;
            const chunk = new VoxelChunk16(MortonKey.from(cx, cy, cz));

            fillTerrain(chunk, cx, cy, cz);
            ownedWorld.insert(chunk);
        }
    }
}

// the same world in a SharedArrayBuffer arena
const sharedSupported = typeof SharedArrayBuffer !== "undefined";
const metaBytes = VoxelChunk16.META_BYTE_LENGTH;
const backing = sharedSupported
    ? new SharedArrayBuffer(VoxelChunkArena.byteLengthFor(CHUNK_COUNT, metaBytes))
    : null;

const arena = new VoxelChunkArena(CHUNK_COUNT, metaBytes, backing);
const arenaWorld = new VoxelWorld();
const slots = [];

for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dz = -RADIUS; dz <= RADIUS; dz++) {
            const cx = CENTER.x + dx;
            const cy = CENTER.y + dy;
            const cz = CENTER.z + dz;
            const key = MortonKey.from(cx, cy, cz);
            const slot = arena.allocate();
            const chunk = arena.build(slot, (storage) => new VoxelChunk16(key.clone(), storage));

            fillTerrain(chunk, cx, cy, cz);
            arenaWorld.insert(chunk);
            slots.push([key.key, slot]);
        }
    }
}

const centerKey = MortonKey.from(CENTER.x, CENTER.y, CENTER.z);

console.log(`arena: ${CHUNK_COUNT} chunks, ${arena.buffer.byteLength} B backing, shared=${arena.isShared}\n`);

// ---- correctness: both worlds must mesh identically ----

const ownedGeometry = new VoxelFaceGeometry();
const arenaGeometry = new VoxelFaceGeometry();

ownedGeometry.computeIndices(ownedWorld.get(centerKey), ownedWorld);
arenaGeometry.computeIndices(arenaWorld.get(centerKey), arenaWorld);

const ownedIndices = BVXGeometry.getIndices(ownedGeometry, false);
const arenaIndices = BVXGeometry.getIndices(arenaGeometry, false);

if (ownedGeometry.popCount() !== arenaGeometry.popCount() || ownedIndices.length !== arenaIndices.length) {
    throw new Error("arena world does not mesh identically to the owned world");
}

for (let i = 0; i < ownedIndices.length; i++) {
    if (ownedIndices[i] !== arenaIndices[i]) {
        throw new Error(`arena world index buffer differs at ${i}`);
    }
}

console.log(`identical geometry from both worlds: ${ownedGeometry.popCount()} faces\n`);

// ---- cost per meshed chunk, by side ----

const ownedCenter = ownedWorld.get(centerKey);
const arenaCenter = arenaWorld.get(centerKey);

const snapshotEncode = time(() => BVXSerializer.saveWorld(ownedWorld));
const snapshot = BVXSerializer.saveWorld(ownedWorld);
const snapshotDecode = time(() => BVXSerializer.loadWorld(snapshot));

// Meshing is timed against both storage kinds. Typed-array reads out of a
// SharedArrayBuffer are not guaranteed to cost the same as reads out of a plain
// ArrayBuffer, and an arena that made every mesh slower would not be worth the
// transport it saves - so this is measured rather than assumed.
const meshOwned = time(() => {
    ownedGeometry.computeIndices(ownedCenter, ownedWorld);
    BVXGeometry.getIndices(ownedGeometry, false, ownedIndices);
});
const meshOnly = time(() => {
    arenaGeometry.computeIndices(arenaCenter, arenaWorld);
    BVXGeometry.getIndices(arenaGeometry, false, arenaIndices);
});

const snapshotTotal = snapshotEncode + snapshotDecode + meshOwned;
const arenaTotal = meshOnly;

console.log("us per meshed chunk\n");
console.log("  stage                          snapshot     arena");
console.log(`  main thread: serialise         ${snapshotEncode.toFixed(2).padStart(8)}  ${"0.00".padStart(8)}`);
console.log(`  worker: decode                 ${snapshotDecode.toFixed(2).padStart(8)}  ${"0.00".padStart(8)}`);
console.log(`  worker: mesh                   ${meshOwned.toFixed(2).padStart(8)}  ${meshOnly.toFixed(2).padStart(8)}`);
console.log(`  total                          ${snapshotTotal.toFixed(2).padStart(8)}  ${arenaTotal.toFixed(2).padStart(8)}`);
console.log(`\n  transport is ${((snapshotEncode + snapshotDecode) / snapshotTotal * 100).toFixed(0)}% of the snapshot path, and the arena deletes it`);
console.log(`  main-thread cost per chunk falls ${snapshotEncode.toFixed(2)} -> 0.00 us`);
console.log(`  meshing out of ${arena.isShared ? "shared" : "plain"} arena storage vs owned storage: ${(meshOnly / meshOwned).toFixed(2)}x`);

// ---- liveness: a real worker thread meshing from shared memory ----

if (!sharedSupported) {
    console.log("\nSharedArrayBuffer unavailable - skipping the cross-thread check");

    process.exit(0);
}

const worker = new Worker(fileURLToPath(new URL("./mesh.worker.mjs", import.meta.url)));

const call = (message, transfer) => new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage(message, transfer);
});

console.log("\ncross-thread check");

const attached = await call({
    type: "attach",
    buffer: arena.buffer,
    capacity: arena.capacity,
    metaByteLength: arena.metaByteLength,
    slots
});

console.log(`  worker attached to ${attached.chunks} chunks, shared=${attached.shared}`);

const before = await call({ type: "mesh-live", chunkKey: centerKey.key });

console.log(`  worker meshed ${before.faces} faces from live state`);

// carve a hole from the main thread, with no message telling the worker about it
const center = arenaWorld.get(centerKey);
const elements = center.layer.bitArray.elements;

for (let i = 0; i < elements.length; i++) {
    elements[i] = 0;
}

const after = await call({ type: "mesh-live", chunkKey: centerKey.key });

console.log(`  main thread emptied the chunk; worker now meshes ${after.faces} faces`);

if (before.faces === 0 || after.faces !== 0) {
    throw new Error(`worker did not observe the main thread's write (${before.faces} -> ${after.faces})`);
}

console.log("  the worker saw a write it was never sent - shared state confirmed");

await worker.terminate();
