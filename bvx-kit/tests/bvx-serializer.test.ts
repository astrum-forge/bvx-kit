import { describe, expect, it } from '@jest/globals';
import { VoxelChunk } from "../src/lib/engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelChunk8 } from "../src/lib/engine/chunks/voxel-chunk-8.js";
import { VoxelChunk16 } from "../src/lib/engine/chunks/voxel-chunk-16.js";
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { BVXSerializer } from "../src/lib/serialize/bvx-serializer.js";

/**
 * Provides coverage for bvx-serializer.ts
 */
describe('BVXSerializer', () => {

    /**
     * Compares two chunks for identical keys, BitVoxel states and meta-data.
     */
    const expectChunksEqual = (a: VoxelChunk, b: VoxelChunk): void => {
        expect(b.key.cmp(a.key)).toBe(true);
        expect(b.metaBits).toEqual(a.metaBits);

        for (let i = 0; i < 4096; i++) {
            const index = new VoxelIndex(i);

            expect(b.getBitVoxel(index)).toEqual(a.getBitVoxel(index));
        }

        for (let i = 0; i < 64; i++) {
            const index = new VoxelIndex(i << 6);

            expect(b.getMetaData(index)).toEqual(a.getMetaData(index));
        }
    };

    /**
     * Deterministic pseudo-random generator so failures are reproducible.
     */
    const makeRand = (initialSeed: number) => {
        let seed = initialSeed;

        return (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
            return seed / 0x7FFFFFFF;
        };
    };

    it('.saveChunk() .loadChunk() - empty chunk round-trip', () => {
        const chunk = new VoxelChunk16(MortonKey.from(1, 2, 3));

        const data = BVXSerializer.saveChunk(chunk);
        const loaded = BVXSerializer.loadChunk(data);

        expect(loaded instanceof VoxelChunk16).toBe(true);
        expectChunksEqual(chunk, loaded);

        // an empty chunk should encode into a handful of bytes only
        expect(data.length).toBeLessThan(16);
    });

    it('.saveChunk() .loadChunk() - full chunk round-trip', () => {
        const chunk = new VoxelChunk8(MortonKey.from(4, 5, 6));

        for (let i = 0; i < 4096; i++) {
            chunk.setBitVoxel(new VoxelIndex(i));
        }

        for (let i = 0; i < 64; i++) {
            chunk.setMetaData(new VoxelIndex(i << 6), 42);
        }

        const data = BVXSerializer.saveChunk(chunk);
        const loaded = BVXSerializer.loadChunk(data);

        expect(loaded instanceof VoxelChunk8).toBe(true);
        expectChunksEqual(chunk, loaded);

        // a fully uniform chunk should RLE-compress far below raw size (512 + 64)
        expect(data.length).toBeLessThan(64);
    });

    it('.saveChunk() .loadChunk() - random chunk round-trip for all chunk types', () => {
        const rand = makeRand(54321);

        const chunks: VoxelChunk[] = [
            new VoxelChunk0(MortonKey.from(1, 1, 1)),
            new VoxelChunk8(MortonKey.from(2, 2, 2)),
            new VoxelChunk16(MortonKey.from(3, 3, 3)),
            new VoxelChunk32(MortonKey.from(4, 4, 4))
        ];

        for (const chunk of chunks) {
            for (let i = 0; i < 4096; i++) {
                if (rand() < 0.5) {
                    chunk.setBitVoxel(new VoxelIndex(i));
                }
            }

            for (let i = 0; i < 64; i++) {
                // write values that exercise the full bit width of each chunk type
                chunk.setMetaData(new VoxelIndex(i << 6), (rand() * 0xFFFFFFFF) >>> 0);
            }

            const data = BVXSerializer.saveChunk(chunk);
            const loaded = BVXSerializer.loadChunk(data);

            expectChunksEqual(chunk, loaded);
        }
    });

    it('.saveChunk() .loadChunk() - sparse chunk stays compact', () => {
        const chunk = new VoxelChunk16(MortonKey.from(7, 7, 7));

        // a single BitVoxel with meta-data
        chunk.setBitVoxel(VoxelIndex.from(1, 2, 3, 0, 1, 2));
        chunk.setMetaData(VoxelIndex.from(1, 2, 3), 12345);

        const data = BVXSerializer.saveChunk(chunk);
        const loaded = BVXSerializer.loadChunk(data);

        expectChunksEqual(chunk, loaded);

        // sparse data should compress far below the raw 576+ byte encoding
        expect(data.length).toBeLessThan(64);
    });

    it('.loadChunk() - rejects invalid data', () => {
        expect(() => BVXSerializer.loadChunk(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(Error);
    });

    it('.loadChunk() - rejects an unknown chunk type', () => {
        const data = BVXSerializer.saveChunk(new VoxelChunk8(MortonKey.from(1, 1, 1)));

        // corrupt the meta bit width byte (offset 4, after the magic)
        data[4] = 7;

        expect(() => BVXSerializer.loadChunk(data)).toThrow(Error);
    });

    it('.loadChunk() - rejects corrupted section data', () => {
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));
        chunk.setBitVoxel(new VoxelIndex(0));

        const data = BVXSerializer.saveChunk(chunk);

        // the layer mode byte sits after magic (4), type (1) and key (4)
        const layerModeOffset = 9;

        // an unknown section mode must be rejected
        const unknownMode = new Uint8Array(data);
        unknownMode[layerModeOffset] = 9;
        expect(() => BVXSerializer.loadChunk(unknownMode)).toThrow(Error);

        // a non-empty meta section on a chunk type that stores no meta-data must
        // be rejected - VoxelChunk0 encodes with an empty meta section at the end
        const badMeta = new Uint8Array(data);
        badMeta[badMeta.length - 1] = 1;
        expect(() => BVXSerializer.loadChunk(badMeta)).toThrow(Error);

        // RLE data that decodes to the wrong element count must be rejected
        const chunk16 = new VoxelChunk16(MortonKey.from(2, 2, 2));
        chunk16.setMetaData(new VoxelIndex(0), 5);

        const data16 = BVXSerializer.saveChunk(chunk16);

        // meta section follows the empty layer section (mode byte only) - its RLE
        // run count is stored as a u16 after the mode byte
        const metaModeOffset = 10;

        expect(data16[metaModeOffset]).toEqual(2);

        const badRuns = new Uint8Array(data16);
        badRuns[metaModeOffset + 1] = 1; // truncate the run count
        expect(() => BVXSerializer.loadChunk(badRuns)).toThrow(Error);
    });

    it('.saveWorld() .loadWorld() - world round-trip', () => {
        const rand = makeRand(98765);
        const world = new VoxelWorld();
        const sourceChunks: VoxelChunk[] = [];

        for (let cx = 0; cx < 3; cx++) {
            for (let cy = 0; cy < 3; cy++) {
                const chunk = new VoxelChunk16(MortonKey.from(cx, cy, 0));

                for (let i = 0; i < 4096; i++) {
                    if (rand() < 0.25) {
                        chunk.setBitVoxel(new VoxelIndex(i));
                    }
                }

                for (let i = 0; i < 64; i++) {
                    chunk.setMetaData(new VoxelIndex(i << 6), (rand() * 0xFFFF) >>> 0);
                }

                world.insert(chunk);
                sourceChunks.push(chunk);
            }
        }

        const data = BVXSerializer.saveWorld(world);
        const loaded = BVXSerializer.loadWorld(data);

        for (const chunk of sourceChunks) {
            const loadedChunk = loaded.get(chunk.key);

            expect(loadedChunk).not.toBeNull();
            expectChunksEqual(chunk, loadedChunk as VoxelChunk);
        }
    });

    it('.loadWorld() - loads into a provided world instance', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk8(MortonKey.from(9, 9, 9));

        chunk.setBitVoxel(VoxelIndex.from(0, 0, 0, 0, 0, 0));
        world.insert(chunk);

        const data = BVXSerializer.saveWorld(world);

        const target = new VoxelWorld();
        const result = BVXSerializer.loadWorld(data, target);

        expect(result).toBe(target);
        expect(target.get(MortonKey.from(9, 9, 9))).not.toBeNull();
    });

    it('.loadWorld() - rejects invalid data', () => {
        expect(() => BVXSerializer.loadWorld(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow(Error);
    });
});
