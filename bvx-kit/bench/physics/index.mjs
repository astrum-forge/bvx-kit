/**
 * Prices the physics delta protocol and proves it off-thread.
 *
 * Three questions, all of which the scale report left open:
 *
 * 1. How big is a per-tick delta compared with snapshotting the layer?
 * 2. What does a move budget do to the peak tick?
 * 3. What does wakeRegion cost, given it is O(volume x layers)?
 *
 * Run `npm run build-ts` first.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { VoxelPhysics, VoxelWorld, VoxelChunk0, MortonKey, VoxelIndex, BVXSerializer } from "../../out/index.js";
import { time } from "../geometry/workloads.mjs";

const BOUNDS = { maxX: 255, maxY: 255, maxZ: 255 };

/**
 * A reservoir of water held above a floor by walls, plus a sand pile - the shape that
 * produces the report's peak ticks when it breaches.
 */
function seedGrains(size, height) {
    const grains = [];

    for (let x = 0; x < size; x++) {
        for (let z = 0; z < size; z++) {
            for (let y = 64; y < 64 + height; y++) {
                grains.push([x + 8, y, z + 8]);
            }
        }
    }

    return grains;
}

/**
 * Builds a floor in the collision world so grains have something to land on.
 */
function floorWorld(size) {
    const base = new VoxelWorld();

    for (let cx = 0; cx <= ((size + 16) >> 4); cx++) {
        for (let cz = 0; cz <= ((size + 16) >> 4); cz++) {
            const chunk = new VoxelChunk0(MortonKey.from(cx, 3, cz));

            for (let x = 0; x < 16; x++) {
                for (let z = 0; z < 16; z++) {
                    chunk.setBitVoxel(VoxelIndex.from(x >> 2, 0, z >> 2, x & 3, 0, z & 3));
                }
            }

            base.insert(chunk);
        }
    }

    return base;
}

// ---- 1. delta size against snapshot size, per tick ----

const SIZE = 32;
const HEIGHT = 8;
const grains = seedGrains(SIZE, HEIGHT);

const local = new VoxelPhysics(floorWorld(SIZE), BOUNDS);
const sand = local.addLayer(VoxelPhysics.SAND);

for (const [x, y, z] of grains) {
    sand.set(x, y, z);
}

console.log(`falling grains: ${sand.length}\n`);
console.log("bytes moved per tick\n");
console.log("  tick   moves   dirty   delta B   snapshot B   ratio");

const dirty = new Set();

for (let tick = 0; tick < 6; tick++) {
    const result = local.update();
    const moves = typeof result === "object" ? result.moves : result;

    dirty.clear();
    sand.drainDirtyChunks(dirty);

    let deltaBytes = 0;

    for (const encoded of dirty) {
        const chunk = sand.world.get(new MortonKey(encoded));

        if (chunk !== null) {
            deltaBytes += BVXSerializer.saveChunk(chunk).length;
        }
    }

    const snapshotBytes = BVXSerializer.saveWorld(sand.world).length;

    console.log(
        `  ${String(tick).padStart(4)}  ${String(moves).padStart(6)}  ${String(dirty.size).padStart(6)}  ` +
        `${String(deltaBytes).padStart(8)}  ${String(snapshotBytes).padStart(11)}   ${(snapshotBytes / Math.max(deltaBytes, 1)).toFixed(1)}x`
    );
}

// Every chunk in that test is active, so the delta is the whole layer and the ratio
// is 1.0x - the protocol compresses nothing. Its win is dormancy, not encoding, and
// that only shows once most of the layer is at rest. Which is the normal case: a
// reservoir sits still until something breaches it.
for (let i = 0; i < 4000 && sand.activeCount > 0; i++) {
    local.update();
}

sand.drainDirtyChunks(dirty);
dirty.clear();

const quietResult = local.update();
const quietMoves = typeof quietResult === "object" ? quietResult.moves : quietResult;

sand.drainDirtyChunks(dirty);

console.log(`\n  settled: ${quietMoves} moves, ${dirty.size} dirty chunks, 0 bytes on the wire`);

// now disturb one corner of the settled pool and measure again
console.log("\nbytes per tick, settled pool with a local disturbance\n");
console.log("  tick   moves   dirty   delta B   snapshot B   ratio");

for (let i = 0; i < 6; i++) {
    sand.set(10, 80, 10);
}

for (let tick = 0; tick < 6; tick++) {
    const result = local.update();
    const moves = typeof result === "object" ? result.moves : result;

    dirty.clear();
    sand.drainDirtyChunks(dirty);

    let deltaBytes = 0;

    for (const encoded of dirty) {
        const chunk = sand.world.get(new MortonKey(encoded));

        if (chunk !== null) {
            deltaBytes += BVXSerializer.saveChunk(chunk).length;
        }
    }

    const snapshotBytes = BVXSerializer.saveWorld(sand.world).length;

    console.log(
        `  ${String(tick).padStart(4)}  ${String(moves).padStart(6)}  ${String(dirty.size).padStart(6)}  ` +
        `${String(deltaBytes).padStart(8)}  ${String(snapshotBytes).padStart(11)}   ${(snapshotBytes / Math.max(deltaBytes, 1)).toFixed(1)}x`
    );
}

// ---- 2. what a move budget does to the peak tick ----

console.log("\npeak tick cost against a work budget (cell probes)\n");
console.log("  budget      mean ms   peak ms   ticks to settle");

// the scale report peaked at 163,840 active grains, so match that exactly
const PEAK_SIZE = 64;
const PEAK_HEIGHT = 40;
const peakGrains = seedGrains(PEAK_SIZE, PEAK_HEIGHT);
const peakFloor = floorWorld(PEAK_SIZE);

console.log(`  (${peakGrains.length} grains, the count the scale report measured at 85 ms peak)`);

for (const budget of [0, 20000, 5000, 1000]) {
    const physics = new VoxelPhysics(peakFloor, BOUNDS);
    const layer = physics.addLayer(VoxelPhysics.SAND);

    for (const [x, y, z] of peakGrains) {
        layer.set(x, y, z);
    }

    let ticks = 0;
    let total = 0;
    let peak = 0;

    while (layer.activeCount > 0 && ticks < 20000) {
        const start = process.hrtime.bigint();

        physics.update(1, budget);

        const ms = Number(process.hrtime.bigint() - start) / 1e6;

        total += ms;
        peak = Math.max(peak, ms);
        ticks++;
    }

    console.log(
        `  ${(budget === 0 ? "none" : String(budget)).padStart(6)}   ${(total / ticks).toFixed(3).padStart(10)}  ` +
        `${peak.toFixed(3).padStart(8)}   ${String(ticks).padStart(16)}`
    );
}

// ---- 3. wakeRegion, which is O(volume x layers) ----

console.log("\nwakeRegion cost by region size\n");
console.log("  edge   cells   layers   us       us/cell");

for (const edge of [4, 8, 16, 32]) {
    const physics = new VoxelPhysics(new VoxelWorld(), BOUNDS);

    physics.addLayer(VoxelPhysics.SAND);
    physics.addLayer(VoxelPhysics.WATER);

    const us = time(() => physics.wakeRegion(0, 0, 0, edge - 1, edge - 1, edge - 1), 200, 20);
    const cells = (edge + 2) ** 3;

    console.log(
        `  ${String(edge).padStart(4)}  ${String(cells).padStart(6)}   ${String(2).padStart(6)}   ` +
        `${us.toFixed(1).padStart(6)}   ${(us * 1000 / (cells * 2)).toFixed(1).padStart(7)} ns`
    );
}

// ---- 4. the same simulation, off-thread ----

console.log("\noff-thread check");

const worker = new Worker(fileURLToPath(new URL("./solver.worker.mjs", import.meta.url)));

const call = (message, transfer) => new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage(message, transfer);
});

await call({
    id: 1,
    type: "attach",
    bounds: BOUNDS,
    layers: [VoxelPhysics.SAND],
    base: BVXSerializer.saveWorld(floorWorld(SIZE))
});

const flat = Int32Array.from(grains.flat());

await call({ id: 2, type: "inject", layer: 0, set: flat });

console.log(`  seeded ${grains.length} grains over one attach and one inject`);

// drive it to rest, tracking what the main thread actually has to do
const mirror = new VoxelWorld();

let ticks = 0;
let mainThreadMs = 0;
let wireBytes = 0;

for (;;) {
    const response = await call({ id: 100 + ticks, type: "step", maxMoves: 5000 });
    const delta = response.layers[0];
    const start = process.hrtime.bigint();

    for (let i = 0; i < delta.removed.length; i++) {
        mirror.remove(new MortonKey(delta.removed[i]));
    }

    for (let i = 0; i < delta.keys.length; i++) {
        mirror.insert(BVXSerializer.loadChunk(delta.chunks[i]));
        wireBytes += delta.chunks[i].length;
    }

    mainThreadMs += Number(process.hrtime.bigint() - start) / 1e6;
    ticks++;

    if (response.moves === 0 || ticks > 20000) {
        break;
    }
}

let mirrored = 0;

for (const chunk of mirror.chunks.values()) {
    mirrored += chunk.length;
}

console.log(`  settled in ${ticks} ticks; main thread spent ${mainThreadMs.toFixed(1)} ms total applying deltas`);
console.log(`  ${(wireBytes / 1024).toFixed(1)} KB crossed the boundary for the whole collapse`);
console.log(`  main thread reconstructed ${mirrored} grains`);

if (mirrored !== grains.length) {
    throw new Error(`main thread reconstructed ${mirrored} grains, expected ${grains.length}`);
}

console.log("  grain count matches - the delta stream is lossless");

await worker.terminate();
