import BitOps from '../src/util/bit-ops';

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('BitOps', () => {

    const FLOAT_SMALL_POSITIVE: number = Number.EPSILON;
    const FLOAT_SMALL_NEGATIVE: number = -Number.EPSILON;
    const FLOAT_ZERO: number = 0.0;

    const TEST_VALUE: number = 7623190; // 00000000011101000101001000010110
    const TEST_VALUE_STR: string = "00000000011101000101001000010110";
    const EXPTECTED_BITS: number[] = [0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    const LOOP_COUNT: number = 32;

    it('.isEqual() - equality tolerance test', () => {
        expect(BitOps.isEqual(FLOAT_ZERO, FLOAT_ZERO)).toBe(true);
        expect(BitOps.isEqual(FLOAT_SMALL_POSITIVE, FLOAT_SMALL_POSITIVE)).toBe(true);
        expect(BitOps.isEqual(FLOAT_SMALL_NEGATIVE, FLOAT_SMALL_NEGATIVE)).toBe(true);
    });

    it('.isEqual() - unequality tolerance test', () => {
        const test: number = 0.000001;

        expect(BitOps.isEqual(test, FLOAT_ZERO)).toBe(false);
        expect(BitOps.isEqual(test, FLOAT_SMALL_POSITIVE)).toBe(false);
        expect(BitOps.isEqual(test, FLOAT_SMALL_NEGATIVE)).toBe(false);

        const test2: number = 0.000001;

        expect(BitOps.isEqual(test, test2)).toBe(true);
    });

    it('.bitAt() - reading bits', () => {
        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(BitOps.bitAt(TEST_VALUE, i)).toBe(EXPTECTED_BITS[i]);
        }
    });

    it('.bitInvAt() - reading inverse bits', () => {
        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(BitOps.bitInvAt(TEST_VALUE, i)).not.toBe(EXPTECTED_BITS[i]);
        }
    });

    it('.setBitAt() - setting bits', () => {
        let testValue = TEST_VALUE;

        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(BitOps.bitAt(TEST_VALUE, i)).toBe(EXPTECTED_BITS[i]);

            testValue = BitOps.setBitAt(testValue, i);

            expect(BitOps.bitAt(testValue, i)).toBe(1);
        }
    });

    it('.unsetBitAt() - unsetting bits', () => {
        let testValue = TEST_VALUE;

        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(BitOps.bitAt(TEST_VALUE, i)).toBe(EXPTECTED_BITS[i]);

            testValue = BitOps.unsetBitAt(testValue, i);

            expect(BitOps.bitAt(testValue, i)).toBe(0);
        }
    });

    it('.toggleBitAt() - toggling bits', () => {
        let testValue = TEST_VALUE;

        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(BitOps.bitAt(TEST_VALUE, i)).toBe(EXPTECTED_BITS[i]);

            // toggle
            testValue = BitOps.toggleBitAt(testValue, i);

            expect(BitOps.bitAt(testValue, i)).not.toBe(EXPTECTED_BITS[i]);

            // toggle again as a final test
            testValue = BitOps.toggleBitAt(testValue, i);

            expect(BitOps.bitAt(TEST_VALUE, i)).toBe(EXPTECTED_BITS[i]);
        }
    });

    it('.setBit() - setting bits manually', () => {
        let testValue = TEST_VALUE;

        for (let i: number = 0; i < LOOP_COUNT; i++) {
            expect(BitOps.bitAt(TEST_VALUE, i)).toBe(EXPTECTED_BITS[i]);

            testValue = BitOps.setBit(testValue, i, 0);

            expect(BitOps.bitAt(testValue, i)).toBe(0);

            testValue = BitOps.setBit(testValue, i, 1);

            expect(BitOps.bitAt(testValue, i)).toBe(1);

            testValue = BitOps.setBit(testValue, i, EXPTECTED_BITS[i]);

            expect(BitOps.bitAt(TEST_VALUE, i)).toBe(EXPTECTED_BITS[i]);
        }
    });

    it('.popCount() - count number of set bits', () => {
        expect(BitOps.popCount(0)).toBe(0);
        expect(BitOps.popCount(TEST_VALUE)).toBe(10);
        expect(BitOps.popCount(0xFFFFFFFF)).toBe(32);
    });

    it('.isPowerOfTwo() - check for power of 2 variables', () => {
        const pow1: number = 1024;
        const pow2: number = 2048;
        const pow3: number = 4096;
        const nPow1: number = 1400;
        const nPow2: number = 3300;
        const nPow3: number = 5010;

        expect(BitOps.isPowerOfTwo(pow1)).toBe(true);
        expect(BitOps.isPowerOfTwo(pow2)).toBe(true);
        expect(BitOps.isPowerOfTwo(pow3)).toBe(true);

        expect(BitOps.isPowerOfTwo(nPow1)).toBe(false);
        expect(BitOps.isPowerOfTwo(nPow2)).toBe(false);
        expect(BitOps.isPowerOfTwo(nPow3)).toBe(false);
    });

    it('.toBitString() - bit string conversion', () => {
        const testString = BitOps.toBitString(TEST_VALUE);

        expect(testString).toBe(TEST_VALUE_STR);
    });

    it('.fromBitString() - bit string reverse conversion', () => {
        const testValue = BitOps.fromBitString(TEST_VALUE_STR);

        expect(testValue).toBe(TEST_VALUE);
    });
});