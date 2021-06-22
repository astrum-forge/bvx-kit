import { HashGrid } from '../src/containers/hash-grid';
import { MortonKey } from '../src/math/morton-key';
import { LinearKey } from '../src/math/linear-key';

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
});