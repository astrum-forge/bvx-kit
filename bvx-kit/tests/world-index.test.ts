import { describe, expect, it } from '@jest/globals';
import { MortonKey } from '../src/lib/math/morton-key.js';
import { VoxelIndex } from '../src/lib/engine/voxel-index.js';
import { WorldIndex } from '../src/lib/engine/world-index.js';

/**
 * Provides 100% Coverage for morton-key.ts
 */
describe('WorldIndex', () => {

    const indexMapping = [
        {
            coord: [0, 0, 0],
            vIndex: VoxelIndex.from(0, 0, 0, 0, 0, 0),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [1, 1, 1],
            vIndex: VoxelIndex.from(0, 0, 0, 1, 1, 1),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [2, 2, 2],
            vIndex: VoxelIndex.from(0, 0, 0, 2, 2, 2),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [3, 3, 3],
            vIndex: VoxelIndex.from(0, 0, 0, 3, 3, 3),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [4, 4, 4],
            vIndex: VoxelIndex.from(1, 1, 1, 0, 0, 0),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [5, 5, 5],
            vIndex: VoxelIndex.from(1, 1, 1, 1, 1, 1),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [6, 6, 6],
            vIndex: VoxelIndex.from(1, 1, 1, 2, 2, 2),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [7, 7, 7],
            vIndex: VoxelIndex.from(1, 1, 1, 3, 3, 3),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [8, 8, 8],
            vIndex: VoxelIndex.from(2, 2, 2, 0, 0, 0),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [9, 9, 9],
            vIndex: VoxelIndex.from(2, 2, 2, 1, 1, 1),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [10, 10, 10],
            vIndex: VoxelIndex.from(2, 2, 2, 2, 2, 2),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [11, 11, 11],
            vIndex: VoxelIndex.from(2, 2, 2, 3, 3, 3),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [12, 12, 12],
            vIndex: VoxelIndex.from(3, 3, 3, 0, 0, 0),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [13, 13, 13],
            vIndex: VoxelIndex.from(3, 3, 3, 1, 1, 1),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [14, 14, 14],
            vIndex: VoxelIndex.from(3, 3, 3, 2, 2, 2),
            mIndex: MortonKey.from(0, 0, 0)
        },
        {
            coord: [15, 15, 15],
            vIndex: VoxelIndex.from(3, 3, 3, 3, 3, 3),
            mIndex: MortonKey.from(0, 0, 0)
        }
    ];

    it('.constructor() - world key coordinate mapping', () => {
        // check all zeros
        for (let i = 0; i < indexMapping.length; i++) {
            const index = indexMapping[i];

            const worldIndex = WorldIndex.from(index.coord[0], index.coord[1], index.coord[2]);

            expect(worldIndex.chunkIndex.cmp(index.mIndex)).toBe(true);
            expect(worldIndex.voxelIndex.cmp(index.vIndex)).toBe(true);
        }

        // check next stage up
        for (let i = 0; i < indexMapping.length; i++) {
            const index = indexMapping[i];

            const worldIndex = WorldIndex.from(index.coord[0] + 16, index.coord[1] + 16, index.coord[2] + 16);

            expect(worldIndex.chunkIndex.cmp(index.mIndex.add(MortonKey.from(1, 1, 1)))).toBe(true);
            expect(worldIndex.voxelIndex.cmp(index.vIndex)).toBe(true);
        }
    });
});