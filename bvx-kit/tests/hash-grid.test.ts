import { describe, expect, it } from '@jest/globals';
import { HashGrid } from '../src/lib/containers/hash-grid.js';
import { MortonKey } from '../src/lib/math/morton-key.js';
import { LinearKey } from '../src/lib/math/linear-key.js';

/**
 * Provides 100% Coverage for hash-grid.ts
 */
describe('HashGrid', () => {

    const rangeTest = (min: number, max: number) => {
        const grid = new HashGrid<MortonKey, LinearKey>();

        // perform the set operation
        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    // set a key-value pair
                    grid.set(MortonKey.from(x, y, z), LinearKey.from(z, x, y));
                }
            }
        }

        // perform the get operation
        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    // get a key-value pair
                    const value: LinearKey | null = grid.get(MortonKey.from(x, y, z));

                    expect(value).not.toBe(null);
                    expect(value ? value.cmp(LinearKey.from(z, x, y)) : false).toBe(true);
                }
            }
        }

        // perform the remove operations
        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    // get a key-value pair
                    const didRemove: boolean = grid.remove(MortonKey.from(x, y, z));

                    expect(didRemove).toBe(true);
                }
            }
        }

        // perform gets on nulls - shouldn't return anything
        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    // get a key-value pair
                    const value: LinearKey | null = grid.get(MortonKey.from(x, y, z));

                    expect(value).toBe(null);
                }
            }
        }
    };

    it('.constructor() - minimum size', () => {
        const grid1 = new HashGrid<MortonKey, number>();
        const grid2 = new HashGrid<MortonKey, number>(-1);
        const grid3 = new HashGrid<MortonKey, number>(0);
        const grid4 = new HashGrid<MortonKey, number>(1);

        expect(grid1.size).toBe(HashGrid.DEFAULT_SIZE);
        expect(grid2.size).toBe(HashGrid.DEFAULT_SIZE);
        expect(grid3.size).toBe(HashGrid.DEFAULT_SIZE);
        expect(grid4.size).toBe(1);
    });

    it('.set & .get & .remove - values, low range', () => {
        const min = 0;
        const max = 11;

        rangeTest(min, max);
    });

    it('.set & .get & .remove - values, mid range', () => {
        const min = 510;
        const max = 523;

        rangeTest(min, max);
    });

    it('.set & .get & .remove - values, high range', () => {
        const min = 998;
        const max = 1023;

        rangeTest(min, max);
    });

    it('.set & .get & .remove - multiple values', () => {
        const grid = new HashGrid<MortonKey, LinearKey>();

        // attempt to get value not set yet
        expect(grid.get(MortonKey.from(1, 1, 1))).toBe(null);

        grid.set(MortonKey.from(1, 1, 1), LinearKey.from(1, 1, 1));

        const value1: LinearKey | null = grid.get(MortonKey.from(1, 1, 1));

        expect(value1 ? value1.cmp(LinearKey.from(1, 1, 1)) : false).toBe(true);

        // set same key a second time, different value
        grid.set(MortonKey.from(1, 1, 1), LinearKey.from(2, 2, 2));

        const value2: LinearKey | null = grid.get(MortonKey.from(1, 1, 1));

        expect(value2 ? value2.cmp(LinearKey.from(2, 2, 2)) : false).toBe(true);

        // remove the previously set value
        const removed: boolean = grid.remove(MortonKey.from(1, 1, 1));

        expect(removed).toBe(true);

        // remove again, this should fail
        const removedAgain: boolean = grid.remove(MortonKey.from(1, 1, 1));

        expect(removedAgain).toBe(false);
    });

    it('.remove - unset container', () => {
        const grid = new HashGrid<MortonKey, LinearKey>();

        const removed: boolean = grid.remove(MortonKey.from(1, 1, 1));

        expect(removed).toBe(false);
    });

    it('.length - counts all stored key-value pairs', () => {
        // a small bucket count forces multiple values into the same bucket
        const grid = new HashGrid<MortonKey, LinearKey>(4);

        expect(grid.length).toBe(0);

        for (let i = 0; i < 16; i++) {
            grid.set(MortonKey.from(i, 0, 0), LinearKey.from(i, 0, 0));
        }

        expect(grid.length).toBe(16);

        // updating an existing key must not change the length
        grid.set(MortonKey.from(0, 0, 0), LinearKey.from(9, 9, 9));

        expect(grid.length).toBe(16);

        grid.remove(MortonKey.from(0, 0, 0));

        expect(grid.length).toBe(15);
    });

    it('.values() .keys() - iterates all stored key-value pairs', () => {
        // a small bucket count forces multiple values into the same bucket
        const grid = new HashGrid<MortonKey, LinearKey>(4);

        const expectedKeys = new Set<number>();

        for (let i = 0; i < 16; i++) {
            const key: MortonKey = MortonKey.from(i, 0, 0);

            grid.set(key, LinearKey.from(i, 0, 0));
            expectedKeys.add(key.key);
        }

        // every stored key must be yielded exactly once
        const seenKeys = new Set<number>();

        for (const key of grid.keys()) {
            expect(expectedKeys.has(key)).toBe(true);
            expect(seenKeys.has(key)).toBe(false);

            seenKeys.add(key);
        }

        expect(seenKeys.size).toBe(16);

        // every stored value must be yielded exactly once
        const seenValues = new Set<number>();

        for (const value of grid.values()) {
            expect(seenValues.has(value.key)).toBe(false);

            seenValues.add(value.key);
        }

        expect(seenValues.size).toBe(16);
    });
});