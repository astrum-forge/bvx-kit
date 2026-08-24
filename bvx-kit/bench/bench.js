/**
 * Micro-benchmark for the bvx-kit hot paths. Run via `npm run bench` which
 * builds the library first - this script imports the compiled output.
 *
 * Not published and not part of the test suite - numbers are indicative only.
 */
import {
    MortonKey,
    VoxelChunk0,
    VoxelChunk16,
    VoxelIndex,
    VoxelWorld,
    VoxelFaceGeometry,
    VoxelSmoothGeometry,
    VoxelPhysics,
    VoxelRay,
    BVXGeometry,
    BVXSerializer
} from "../out/index.js";

/**
 * Deterministic pseudo-random generator for reproducible runs.
 */
const makeRand = (initialSeed) => {
    let seed = initialSeed;

    return () => {
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
        return seed / 0x7FFFFFFF;
    };
};

/**
 * Runs the provided function repeatedly and reports operations per second.
 */
const bench = (name, iterations, fn) => {
    // warmup
    for (let i = 0; i < Math.max(1, (iterations / 10) | 0); i++) {
        fn();
    }

    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
        fn();
    }

    const elapsed = performance.now() - start;
    const opsPerSecond = (iterations / elapsed) * 1000;

    console.log(`${name.padEnd(52)} ${opsPerSecond.toFixed(0).padStart(12)} ops/s  (${(elapsed / iterations).toFixed(4)} ms/op)`);
};

// ---- world setup - a 3x3x3 block of chunks with ~30% random occupancy ----

const rand = makeRand(12345);
const world = new VoxelWorld();
const chunks = [];

for (let cx = 1; cx <= 3; cx++) {
    for (let cy = 1; cy <= 3; cy++) {
        for (let cz = 1; cz <= 3; cz++) {
            const chunk = new VoxelChunk16(MortonKey.from(cx, cy, cz));

            for (let i = 0; i < 4096; i++) {
                if (rand() < 0.3) {
                    chunk.setBitVoxel(new VoxelIndex(i));
                }
            }

            world.insert(chunk);
            chunks.push(chunk);
        }
    }
}

const center = chunks[13];

// ---- BVXLayer single BitVoxel operations ----

const layerChunk = new VoxelChunk0(MortonKey.from(9, 9, 9));
const layerIndex = new VoxelIndex();

bench("BVXLayer set/get/unset/toggle (4096 BitVoxels)", 2000, () => {
    for (let i = 0; i < 4096; i++) {
        layerIndex.key = i;
        layerChunk.setBitVoxel(layerIndex);
        layerChunk.getBitVoxel(layerIndex);
        layerChunk.toggleBitVoxel(layerIndex);
        layerChunk.unsetBitVoxel(layerIndex);
    }
});

// ---- blocky face geometry ----

const faceGeometry = new VoxelFaceGeometry();

bench("VoxelFaceGeometry.computeIndices (30% occupancy)", 2000, () => {
    faceGeometry.computeIndices(center, world);
});

faceGeometry.computeIndices(center, world);

bench("BVXGeometry.getIndices", 2000, () => {
    BVXGeometry.getIndices(faceGeometry, false);
});

// ---- smooth surface geometry ----

const smoothGeometry = new VoxelSmoothGeometry();

bench("VoxelSmoothGeometry.computeGeometry (smoothing 0)", 500, () => {
    smoothGeometry.computeGeometry(center, world, 0);
});

bench("VoxelSmoothGeometry.computeGeometry (smoothing 2)", 500, () => {
    smoothGeometry.computeGeometry(center, world, 2);
});

// ---- raycasting ----

const ray = new VoxelRay().set(16.5, 16.5, 16.5, 63.5, 63.5, 63.5);

bench("VoxelRaycaster.raycast (long diagonal ray)", 20000, () => {
    world.raycaster.raycast(ray);
});

// ---- serialization ----

bench("BVXSerializer.saveChunk", 20000, () => {
    BVXSerializer.saveChunk(center);
});

const savedChunk = BVXSerializer.saveChunk(center);

bench("BVXSerializer.loadChunk", 20000, () => {
    BVXSerializer.loadChunk(savedChunk);
});

const savedWorld = BVXSerializer.saveWorld(world);

console.log(`\nserialized sizes: chunk ${savedChunk.length} bytes (raw 585), world (27 chunks) ${savedWorld.length} bytes`);

// ---- physics ----

{
    // ~32k sand grains + ~16k water grains falling in a 128^3 region
    const physics = new VoxelPhysics(new VoxelWorld(), { maxX: 127, maxY: 127, maxZ: 127 });
    const sand = physics.addLayer(VoxelPhysics.SAND);
    const water = physics.addLayer(VoxelPhysics.WATER);

    const grainRand = makeRand(777);

    for (let i = 0; i < 32768; i++) {
        sand.set((grainRand() * 128) | 0, 64 + ((grainRand() * 63) | 0), (grainRand() * 128) | 0);
    }

    for (let i = 0; i < 16384; i++) {
        water.set((grainRand() * 128) | 0, 32 + ((grainRand() * 31) | 0), (grainRand() * 128) | 0);
    }

    const start = performance.now();

    let ticks = 0;
    let totalMoves = 0;

    // simulate until fully dormant
    while (ticks < 1000) {
        const moves = physics.update();
        totalMoves += moves;
        ticks++;

        if (moves === 0) {
            break;
        }
    }

    const elapsed = performance.now() - start;

    console.log(`\nVoxelPhysics: 48k grains settled in ${ticks} ticks, ${totalMoves} moves, ${elapsed.toFixed(1)} ms total (${(elapsed / ticks).toFixed(3)} ms/tick avg, ${((totalMoves / elapsed) * 1000 / 1e6).toFixed(2)}M moves/s)`);

    const dormantStart = performance.now();

    for (let i = 0; i < 100000; i++) {
        physics.update();
    }

    const dormantElapsed = performance.now() - dormantStart;

    console.log(`VoxelPhysics: dormant update() x100k in ${dormantElapsed.toFixed(1)} ms (${(dormantElapsed * 10).toFixed(2)} ns/update)`);
}
