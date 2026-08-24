/**
 * Shared world generation for the smooth-mesher GPU benchmark.
 *
 * Imports the compiled library from `out/`, so run `npm run build-ts` first.
 * Used from both Node (CPU reference) and the browser (GPU + CPU-in-browser).
 */
import { MortonKey, VoxelWorld, VoxelChunk0, VoxelIndex } from "../../out/index.js";

export const DIMS = 16;

/**
 * Deterministic value-noise heightfield in global BitVoxel space, identical to
 * the one bench/geometry uses so numbers stay comparable across harnesses.
 */
export function surfaceHeight(wx, wz) {
    const s = Math.sin(wx * 0.11) * Math.cos(wz * 0.13) + 0.5 * Math.sin(wx * 0.07 + wz * 0.05);

    return 40 + s * 6;
}

/**
 * Builds a terrain world spanning cxN x cyN x czN chunks and returns it along
 * with the classification of every chunk it holds.
 */
export function buildWorld(cxN, cyN, czN) {
    const world = new VoxelWorld();
    const vi = new VoxelIndex();

    const all = [];
    const surface = [];

    for (let cx = 0; cx < cxN; cx++) {
        for (let cy = 0; cy < cyN; cy++) {
            for (let cz = 0; cz < czN; cz++) {
                const chunk = new VoxelChunk0(MortonKey.from(cx, cy, cz));
                const elements = chunk.layer.bitArray.elements;

                let set = 0;

                for (let x = 0; x < DIMS; x++) {
                    for (let z = 0; z < DIMS; z++) {
                        const h = surfaceHeight(cx * DIMS + x, cz * DIMS + z);

                        for (let y = 0; y < DIMS; y++) {
                            if (cy * DIMS + y > h) {
                                continue;
                            }

                            VoxelIndex.from(x >> 2, y >> 2, z >> 2, x & 3, y & 3, z & 3, vi);

                            const pos = vi.key;

                            elements[pos >> 5] |= (1 << (pos & 31));
                            set++;
                        }
                    }
                }

                world.insert(chunk);

                const record = { key: chunk.key, chunk, set };

                all.push(record);

                if (set !== 0 && set !== 4096) {
                    surface.push(record);
                }
            }
        }
    }

    return { world, all, surface };
}
