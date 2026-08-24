/**
 * Worker side of the arena demonstration. Receives the arena's SharedArrayBuffer and
 * the chunk-to-slot assignment once, rebuilds chunk views over that memory, and from
 * then on meshes from live world state - no snapshot, no decode, no per-request
 * allocation.
 */
import { parentPort } from "node:worker_threads";
import { MortonKey, VoxelWorld, VoxelChunk16, VoxelChunkArena, VoxelFaceGeometry, BVXGeometry, BVXSerializer } from "../../out/index.js";

let world = null;
const geometry = new VoxelFaceGeometry();

parentPort.on("message", (message) => {
    // one-time attach: build views over the shared arena
    if (message.type === "attach") {
        const arena = new VoxelChunkArena(message.capacity, message.metaByteLength, message.buffer);

        world = new VoxelWorld();

        for (const [encoded, slot] of message.slots) {
            world.insert(arena.build(slot, (storage) => new VoxelChunk16(new MortonKey(encoded), storage)));
        }

        parentPort.postMessage({ type: "attached", shared: arena.isShared, chunks: message.slots.length });

        return;
    }

    // mesh straight out of shared memory - the request carries only a key
    if (message.type === "mesh-live") {
        const center = world.get(new MortonKey(message.chunkKey));

        geometry.computeIndices(center, world);

        const indices = BVXGeometry.getIndices(geometry, false);

        parentPort.postMessage({ type: "meshed", faces: geometry.popCount(), indices }, [indices.buffer]);

        return;
    }

    // the existing protocol, for comparison: decode a snapshot into fresh objects
    if (message.type === "mesh-snapshot") {
        const decoded = BVXSerializer.loadWorld(message.world);
        const center = decoded.get(new MortonKey(message.chunkKey));

        geometry.computeIndices(center, decoded);

        const indices = BVXGeometry.getIndices(geometry, false);

        parentPort.postMessage({ type: "meshed", faces: geometry.popCount(), indices }, [indices.buffer]);
    }
});
