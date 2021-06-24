import { CompactArray } from '../src/containers/compact-array';
import { BitOps } from '../src/util/bit-ops';

/**
 * Provides 100% Coverage for bit-array.ts
 */
describe('CompactArray', () => {

    const fillRandom = (min: number, max: number, amount: number) => {
        const array = [];

        for (let i = 0; i < amount; i++) {
            array.push(Math.floor(Math.random() * (max - min + 1)) + min);
        }

        return array;
    };

    const rangeTest = (minBits: number, maxBits: number, minValue: number, maxValue: number, maxSets: number) => {
        const values = fillRandom(minValue, maxValue, 64);

        for (let bits = minBits; bits < maxBits; bits++) {
            for (let vIndex = 0; vIndex < values.length; vIndex++) {
                const array = new CompactArray(maxSets, bits);

                // map the correct value
                const mappedValue = values[vIndex] & BitOps.maskForBits(bits);

                // perform the sets
                for (let index = 0; index < maxSets; index++) {
                    array.set(index, mappedValue);
                }

                // perfrom the gets
                for (let index = 0; index < maxSets; index++) {
                    expect(array.get(index)).toBe(mappedValue);
                }
            }
        }
    };

    it('.constructor() - minimum size', () => {
        // minimum size
        const array0 = new CompactArray(1, 1);

        expect(array0.length).toBe(1);
        expect(array0.bitsPerElement).toBe(1);

        const array1 = new CompactArray(0, 0);

        expect(array1.length).toBe(1);
        expect(array1.bitsPerElement).toBe(1);

        const array2 = new CompactArray(-1, -1);

        expect(array2.length).toBe(1);
        expect(array2.bitsPerElement).toBe(1);

        // overflow
        const array3 = new CompactArray(1, 64);

        expect(array3.length).toBe(1);
        expect(array3.bitsPerElement).toBe(31);

        const array4 = new CompactArray(1, 32);

        expect(array4.length).toBe(1);
        expect(array4.bitsPerElement).toBe(31);

        // irregular
        const array5 = new CompactArray(1, 16);

        expect(array5.length).toBe(1);
        expect(array5.bitsPerElement).toBe(16);
    });

    /**
     * Test all different configurations of storage and ensure there is enough
     * buffer allocation to contain/hold that data
     */
    it('.constructor() - optimum buffer size', () => {
        // 1 bit
        expect(new CompactArray(1, 1).array.length).toBe(1);
        // 4 bits
        expect(new CompactArray(1, 4).array.length).toBe(1);
        // 32 bits
        expect(new CompactArray(1, 32).array.length).toBe(1);
        // 8 bits
        expect(new CompactArray(2, 4).array.length).toBe(1);
        // 32 bits
        expect(new CompactArray(8, 4).array.length).toBe(1);
        // 36 bits
        expect(new CompactArray(9, 4).array.length).toBe(2);
        // 64 bits
        expect(new CompactArray(16, 4).array.length).toBe(2);
        // 68 bits
        expect(new CompactArray(17, 4).array.length).toBe(3);
        // 18 bits
        expect(new CompactArray(3, 6).array.length).toBe(1);
        // 30 bits
        expect(new CompactArray(5, 6).array.length).toBe(1);
        // 36 bits
        expect(new CompactArray(6, 6).array.length).toBe(2);
        // 180 bits
        expect(new CompactArray(30, 6).array.length).toBe(6);
    });

    it('.set & .get - expected error test', () => {
        expect(() => new CompactArray(5, 6).set(0, 6)).not.toThrow(RangeError);
        expect(() => new CompactArray(5, 6).set(5, 6)).not.toThrow(RangeError);
        expect(() => new CompactArray(5, 6).set(-1, 6)).toThrow(RangeError);
        expect(() => new CompactArray(5, 6).set(6, 6)).toThrow(RangeError);

        expect(() => new CompactArray(5, 6).get(0)).not.toThrow(RangeError);
        expect(() => new CompactArray(5, 6).get(5)).not.toThrow(RangeError);
        expect(() => new CompactArray(5, 6).get(-1)).toThrow(RangeError);
        expect(() => new CompactArray(5, 6).get(6)).toThrow(RangeError);
    });

    /*
    it('.set & .get - low range tests (1-8 bits)', () => {
        const minBits = 1;
        const maxBits = 8;

        const minValue = 0;
        const maxValue = BitOps.maskForBits(maxBits);

        const maxSets = 40;

        rangeTest(minBits, maxBits, minValue, maxValue, maxSets);
    });

    it('.set & .get - mid range tests (9-15 bits)', () => {
        const minBits = 9;
        const maxBits = 15;

        const minValue = 0;
        const maxValue = BitOps.maskForBits(maxBits);

        const maxSets = 40;

        rangeTest(minBits, maxBits, minValue, maxValue, maxSets);
    });
    */
});