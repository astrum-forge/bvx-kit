/**
 * Chunk layouts and the timing helper shared by the geometry benchmarks.
 *
 * Nothing here is published or part of the test suite. It imports the compiled
 * library from `out/`, so run `npm run build-ts` first.
 */
import { MortonKey, VoxelWorld, VoxelChunk16, VoxelIndex } from "../../out/index.js";

export const DIMS = 16;

/**
 * Deterministic value-noise heightfield in global BitVoxel space. Terrain-shaped
 * rather than random fill - random occupancy defeats the word-skipping mesher and
 * produces face counts no real world ever sees.
 */
export function surfaceHeight(wx, wz) {
    const s = Math.sin(wx * 0.11) * Math.cos(wz * 0.13) + 0.5 * Math.sin(wx * 0.07 + wz * 0.05);

    return 40 + s * 6;
}

/**
 * Builds one chunk filled against the heightfield.
 */
function terrainChunk(cx, cy, cz) {
    const chunk = new VoxelChunk16(MortonKey.from(cx, cy, cz));
    const vi = new VoxelIndex();

    for (let x = 0; x < DIMS; x++) {
        for (let z = 0; z < DIMS; z++) {
            const surface = surfaceHeight(cx * DIMS + x, cz * DIMS + z);

            for (let y = 0; y < DIMS; y++) {
                if (cy * DIMS + y > surface) {
                    continue;
                }

                VoxelIndex.from(x >> 2, y >> 2, z >> 2, x & 3, y & 3, z & 3, vi);
                chunk.setBitVoxel(vi);
            }
        }
    }

    return chunk;
}

/**
 * Builds one chunk that is entirely solid or entirely air.
 */
function uniformChunk(cx, cy, cz, solid) {
    const chunk = new VoxelChunk16(MortonKey.from(cx, cy, cz));

    if (solid) {
        const elements = chunk.layer.bitArray.elements;

        for (let i = 0; i < elements.length; i++) {
            elements[i] = 0xFFFFFFFF;
        }
    }

    return chunk;
}

/**
 * Builds a 3x3x3 neighbourhood around a center chunk and returns the center.
 *
 * @param fill - Called with (cx, cy, cz) for each of the 27 positions.
 */
function neighbourhood(cx, cy, cz, fill) {
    const world = new VoxelWorld();

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
                world.insert(fill(cx + dx, cy + dy, cz + dz));
            }
        }
    }

    return { world, center: world.get(MortonKey.from(cx, cy, cz)) };
}

/**
 * The chunk shapes a streaming world actually meshes, and roughly how common each
 * one is in a resident window with real vertical depth.
 *
 * At 1 m per BitVoxel a 1 km x 1 km x 256 m window is 65,536 chunks, of which only
 * the ~4,096 surface columns are mixed. The rest are buried or open-air, which is
 * why those two cases carry most of the aggregate cost.
 */
export const CASES = [
    {
        name: "surface",
        note: "holds the heightfield - the only case that emits geometry",
        build: () => neighbourhood(8, 2, 8, terrainChunk)
    },
    {
        name: "solid-shell",
        note: "solid, but directly under the surface so a neighbour is mixed",
        build: () => neighbourhood(8, 1, 8, (x, y, z) => y >= 2 ? terrainChunk(x, y, z) : uniformChunk(x, y, z, true))
    },
    {
        name: "solid-buried",
        note: "solid with solid neighbours - the common case underground",
        build: () => neighbourhood(8, 0, 8, (x, y, z) => uniformChunk(x, y, z, true))
    },
    {
        name: "air-shell",
        note: "empty, but directly above the surface so a neighbour is mixed",
        build: () => neighbourhood(8, 3, 8, (x, y, z) => y <= 2 ? terrainChunk(x, y, z) : uniformChunk(x, y, z, false))
    },
    {
        name: "air-open",
        note: "empty with empty neighbours - the common case in open sky",
        build: () => neighbourhood(8, 6, 8, (x, y, z) => uniformChunk(x, y, z, false))
    }
];

/**
 * Runs fn repeatedly and returns the mean microseconds per call.
 */
export function time(fn, iters = 20000, warmup = 2000) {
    for (let i = 0; i < warmup; i++) {
        fn();
    }

    const start = process.hrtime.bigint();

    for (let i = 0; i < iters; i++) {
        fn();
    }

    return Number(process.hrtime.bigint() - start) / 1000 / iters;
}
