import { describe, expect, it } from '@jest/globals';
import { BitOps } from '../src/lib/util/bit-ops.js';

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

    it('.maskForBits() - 0 to 32', () => {
        let endValue: number = 0;

        for (let i = 0; i < 32; i++) {
            expect(BitOps.maskForBits(i)).toBe(endValue);

            endValue = (endValue * 2) + 1;
        }
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

    it('.flattenCoord2() - 2D coordinate flattening check', () => {
        expect(BitOps.flattenCoord2(0, 0, 2)).toBe(0);
        expect(BitOps.flattenCoord2(1, 1, 2)).toBe(5);
        expect(BitOps.flattenCoord2(2, 2, 2)).toBe(10);
        expect(BitOps.flattenCoord2(3, 3, 2)).toBe(15);
        expect(BitOps.flattenCoord2(3, 0, 2)).toBe(12);
        expect(BitOps.flattenCoord2(0, 3, 2)).toBe(3);
    });

    it('.flattenCoord3() - 3D coordinate flattening check', () => {
        expect(BitOps.flattenCoord3(0, 0, 0, 2)).toBe(0);
        expect(BitOps.flattenCoord3(1, 1, 1, 2)).toBe(21);
        expect(BitOps.flattenCoord3(2, 2, 2, 2)).toBe(42);
        expect(BitOps.flattenCoord3(3, 3, 3, 2)).toBe(63);
        expect(BitOps.flattenCoord3(3, 3, 0, 2)).toBe(60);
        expect(BitOps.flattenCoord3(3, 0, 3, 2)).toBe(51);
        expect(BitOps.flattenCoord3(0, 3, 3, 2)).toBe(15);
    });
});