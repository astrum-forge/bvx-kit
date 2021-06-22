import { BitArray } from '../src/containers/bit-array';

/**
 * Provides 100% Coverage for bit-array.ts
 */
describe('BitArray', () => {
    const TEST_VALUE: number = 2155106839; // 10000000011101000101001000010111
    const EXPTECTED_BITS: number[] = [1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const POP_COUNT: number = 12;
    const LOOP_COUNT: number = 32;

    it('.constructor() - minimum size', () => {
        const bitsd = new BitArray();
        const bits0 = new BitArray(0);
        const bitsn = new BitArray(-1);
        const bits1 = new BitArray(1);
        const bits2 = new BitArray(2);

        expect(bitsd.length).toBe(1);
        expect(bits0.length).toBe(1);
        expect(bitsn.length).toBe(1);
        expect(bits1.length).toBe(1);
        expect(bits2.length).toBe(2);
    });

    it('.popCount() - all zeros', () => {
        const bits = new BitArray(10);

        expect(bits.popCount()).toBe(0);
    });

    it('.popCount() - real values', () => {
        const numValues: number = 10;
        const bits = new BitArray(numValues);
        const array: Uint32Array = bits.elements;

        // sets all elements to the test value
        for (let i: number = 0; i < numValues; i++) {
            array[i] = TEST_VALUE;
        }

        expect(bits.popCount()).toBe(POP_COUNT * numValues);
    });

    it('.bitAt() - check bit correctness', () => {
        const bits = new BitArray(2);
        const array: Uint32Array = bits.elements;
        array[0] = TEST_VALUE;
        array[1] = TEST_VALUE;

        // test first case array[0]
        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(bits.bitAt(i)).toBe(EXPTECTED_BITS[i]);
        }

        // test second case array[1]
        for (let i: number = 0, j: number = LOOP_COUNT; i < LOOP_COUNT; i++, j++) {
            expect(bits.bitAt(j)).toBe(EXPTECTED_BITS[i]);
        }
    });

    it('.bitAt() - overflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.bitAt(0)).not.toThrow(Error);
        expect(() => bits.bitAt((LOOP_COUNT * 2) - 1)).not.toThrow(Error);
        expect(() => bits.bitAt(LOOP_COUNT * 2)).toThrow(Error);
    });

    it('.bitAt() - underflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.bitAt(-1)).toThrow(Error);
    });

    it('.bitInvAt() - check bit correctness', () => {
        const bits = new BitArray(2);
        const array: Uint32Array = bits.elements;
        array[0] = TEST_VALUE;
        array[1] = TEST_VALUE;

        // test first case array[0]
        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(bits.bitInvAt(i)).not.toBe(EXPTECTED_BITS[i]);
        }

        // test second case array[1]
        for (let i: number = 0, j: number = LOOP_COUNT; i < LOOP_COUNT; i++, j++) {
            expect(bits.bitInvAt(j)).not.toBe(EXPTECTED_BITS[i]);
        }
    });

    it('.bitInvAt() - overflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.bitInvAt(0)).not.toThrow(Error);
        expect(() => bits.bitInvAt((LOOP_COUNT * 2) - 1)).not.toThrow(Error);
        expect(() => bits.bitInvAt(LOOP_COUNT * 2)).toThrow(Error);
    });

    it('.bitInvAt() - underflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.bitInvAt(-1)).toThrow(Error);
    });

    it('.setBitAt() - check bit correctness', () => {
        const bits = new BitArray(2);

        for (let i: number = 0; i < LOOP_COUNT * 2; i++) {
            expect(bits.bitAt(i)).toBe(0);
            bits.setBitAt(i)
            expect(bits.bitAt(i)).toBe(1);
        }
    });

    it('.setBitAt() - overflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.setBitAt(0)).not.toThrow(Error);
        expect(() => bits.setBitAt((LOOP_COUNT * 2) - 1)).not.toThrow(Error);
        expect(() => bits.setBitAt(LOOP_COUNT * 2)).toThrow(Error);
    });

    it('.setBitAt() - underflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.setBitAt(-1)).toThrow(Error);
    });

    it('.setBit() - check bit correctness', () => {
        const bits = new BitArray(2);

        for (let i: number = 0; i < LOOP_COUNT * 2; i++) {
            bits.setBit(i, 1)
            expect(bits.bitAt(i)).toBe(1);
            bits.setBit(i, 0)
            expect(bits.bitAt(i)).toBe(0);
        }
    });

    it('.setBit() - overflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.setBit(0, 0)).not.toThrow(Error);
        expect(() => bits.setBit((LOOP_COUNT * 2) - 1, 0)).not.toThrow(Error);
        expect(() => bits.setBit(LOOP_COUNT * 2, 0)).toThrow(Error);
    });

    it('.setBit() - underflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.setBit(-1, 0)).toThrow(Error);
    });

    it('.unsetBitAt() - check bit correctness', () => {
        const bits = new BitArray(2);

        for (let i: number = 0; i < LOOP_COUNT * 2; i++) {
            bits.setBitAt(i)
            expect(bits.bitAt(i)).toBe(1);
            bits.unsetBitAt(i)
            expect(bits.bitAt(i)).toBe(0);
        }
    });

    it('.unsetBitAt() - overflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.unsetBitAt(0)).not.toThrow(Error);
        expect(() => bits.unsetBitAt((LOOP_COUNT * 2) - 1)).not.toThrow(Error);
        expect(() => bits.unsetBitAt(LOOP_COUNT * 2)).toThrow(Error);
    });

    it('.unsetBitAt() - underflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.unsetBitAt(-1)).toThrow(Error);
    });

    it('.toggleBitAt() - check bit correctness', () => {
        const bits = new BitArray(2);

        for (let i: number = 0; i < LOOP_COUNT * 2; i++) {
            bits.toggleBitAt(i)
            expect(bits.bitAt(i)).toBe(1);
            bits.toggleBitAt(i)
            expect(bits.bitAt(i)).toBe(0);
        }
    });

    it('.toggleBitAt() - overflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.toggleBitAt(0)).not.toThrow(Error);
        expect(() => bits.toggleBitAt((LOOP_COUNT * 2) - 1)).not.toThrow(Error);
        expect(() => bits.toggleBitAt(LOOP_COUNT * 2)).toThrow(Error);
    });

    it('.toggleBitAt() - underflow access must throw error', () => {
        const bits = new BitArray(2);

        expect(() => bits.toggleBitAt(-1)).toThrow(Error);
    });
});