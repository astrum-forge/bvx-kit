import { describe, expect, it } from '@jest/globals';
import { LinearKey } from '../src/lib/math/linear-key.js';
import { MortonKey } from '../src/lib/math/morton-key.js';

/**
 * Provides 100% Coverage for morton-key.ts
 */
describe('MortonKey', () => {
    const clazz = MortonKey;

    const randomX = 57;
    const randomY = 73;
    const randomZ = 91;

    const minX = 0;
    const minY = 0;
    const minZ = 0;

    const maxX = 1023;
    const maxY = 1023;
    const maxZ = 1023;

    it('.constructor() - random key', () => {
        const mk = new clazz(randomX);

        expect(mk.key).toBe(randomX);
    });

    it('.copy() - copy equality', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const key2 = key.copy();

        expect(key.x).toBe(key2.x);
        expect(key.y).toBe(key2.y);
        expect(key.z).toBe(key2.z);
    });

    it('.clone() - copy equality', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const key2 = key.clone();

        expect(key.x).toBe(key2.x);
        expect(key.y).toBe(key2.y);
        expect(key.z).toBe(key2.z);
    });

    it('.cmp() - comparison check', () => {
        const key = clazz.from(randomX, randomY, randomZ);
        const key2 = clazz.from(randomX, randomY, randomZ);
        const key3 = clazz.from(randomY, randomZ, randomX);

        expect(key.cmp(key2)).toBe(true);
        expect(key.cmp(key3)).toBe(false);
        expect(key2.cmp(key)).toBe(true);
        expect(key2.cmp(key3)).toBe(false);
        expect(key3.cmp(key)).toBe(false);
        expect(key3.cmp(key2)).toBe(false);

        // expect self comparisons to all be true
        expect(key.cmp(key)).toBe(true);
        expect(key2.cmp(key2)).toBe(true);
        expect(key3.cmp(key3)).toBe(true);
    });

    it('.cmp() - comparison check against another key', () => {
        const key = clazz.from(randomX, randomY, randomZ);
        const key2 = LinearKey.from(randomX, randomY, randomZ);

        expect(key.cmp(key2)).toBe(true);
        expect(key2.cmp(key)).toBe(true);
    });

    it('.from() - min values', () => {
        const key = clazz.from(minX, minY, minZ);

        expect(key.x).toBe(minX);
        expect(key.y).toBe(minY);
        expect(key.z).toBe(minZ);
    });

    it('.from() - max values', () => {
        const key = clazz.from(maxX, maxY, maxZ);

        expect(key.x).toBe(maxX);
        expect(key.y).toBe(maxY);
        expect(key.z).toBe(maxZ);
    });

    it('.from() - underflow values', () => {
        const key = clazz.from(minX - 1, minY, minZ);

        expect(key.x).toBe(maxX);
        expect(key.y).toBe(minY);
        expect(key.z).toBe(minZ);

        const key2 = clazz.from(minX, minY - 1, minZ);

        expect(key2.x).toBe(minX);
        expect(key2.y).toBe(maxY);
        expect(key2.z).toBe(minZ);

        const key3 = clazz.from(minX, minY, minZ - 1);

        expect(key3.x).toBe(minX);
        expect(key3.y).toBe(minY);
        expect(key3.z).toBe(maxZ);
    });

    it('.from() - underflow wrap values', () => {
        const key = clazz.from(minX - 4, minY, minZ);

        expect(key.x).toBe(maxX - 3);
        expect(key.y).toBe(minY);
        expect(key.z).toBe(minZ);

        const key2 = clazz.from(minX, minY - 4, minZ);

        expect(key2.x).toBe(minX);
        expect(key2.y).toBe(maxY - 3);
        expect(key2.z).toBe(minZ);

        const key3 = clazz.from(minX, minY, minZ - 4);

        expect(key3.x).toBe(minX);
        expect(key3.y).toBe(minY);
        expect(key3.z).toBe(maxZ - 3);
    });

    it('.from() - overflow values', () => {
        const key = clazz.from(maxX + 1, maxY, maxZ);

        expect(key.x).toBe(minX);
        expect(key.y).toBe(maxY);
        expect(key.z).toBe(maxZ);

        const key2 = clazz.from(maxX, maxY + 1, maxZ);

        expect(key2.x).toBe(maxX);
        expect(key2.y).toBe(minY);
        expect(key2.z).toBe(maxZ);

        const key3 = clazz.from(maxX, maxY, maxZ + 1);

        expect(key3.x).toBe(maxX);
        expect(key3.y).toBe(maxY);
        expect(key3.z).toBe(minZ);
    });

    it('.from() - overflow wrap values', () => {
        const key = clazz.from(maxX + 4, maxY, maxZ);

        expect(key.x).toBe(minX + 3);
        expect(key.y).toBe(maxY);
        expect(key.z).toBe(maxZ);

        const key2 = clazz.from(maxX, maxY + 4, maxZ);

        expect(key2.x).toBe(maxX);
        expect(key2.y).toBe(minY + 3);
        expect(key2.z).toBe(maxZ);

        const key3 = clazz.from(maxX, maxY, maxZ + 4);

        expect(key3.x).toBe(maxX);
        expect(key3.y).toBe(maxY);
        expect(key3.z).toBe(minZ + 3);
    });

    it('.from(0, 0, 0) - x, y, z values', () => {
        const key = clazz.from(minX, minY, minZ);

        expect(key.x).toBe(minX);
        expect(key.y).toBe(minY);
        expect(key.z).toBe(minZ);
    });

    it('.from(1023, 1023, 1023) - x, y, z values', () => {
        const key = clazz.from(maxX, maxY, maxZ);

        expect(key.x).toBe(maxX);
        expect(key.y).toBe(maxY);
        expect(key.z).toBe(maxZ);
    });

    it('.from() - x(0-11), y(0-11), z(0-11) values', () => {
        const min = 0;
        const max = 11;

        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    const key = clazz.from(x, y, z);

                    expect(key.x).toBe(x);
                    expect(key.y).toBe(y);
                    expect(key.z).toBe(z);
                }
            }
        }
    });

    it('.from() - x(510-523), y(510-523), z(510-523) values', () => {
        const min = 510;
        const max = 523;

        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    const key = clazz.from(x, y, z);

                    expect(key.x).toBe(x);
                    expect(key.y).toBe(y);
                    expect(key.z).toBe(z);
                }
            }
        }
    });

    it('.from() - x(998-1023), y(998-1023), z(998-1023) values', () => {
        const min = 998;
        const max = 1023;

        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    const key = clazz.from(x, y, z);

                    expect(key.x).toBe(x);
                    expect(key.y).toBe(y);
                    expect(key.z).toBe(z);
                }
            }
        }
    });

    /**
     * TESTS for .incX() - increment coordinates by one at a time
     */
    it('.incX() - class fn', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const newKey = clazz.incX(key);

        expect(key.x).not.toBe(newKey.x);
        expect(key.y).toBe(newKey.y);
        expect(key.z).toBe(newKey.z);

        const newKey2 = clazz.incX(key, new clazz());

        expect(key.x).not.toBe(newKey2.x);
        expect(key.y).toBe(newKey2.y);
        expect(key.z).toBe(newKey2.z);
    });

    it('.incX() - min value', () => {
        const key = clazz.from(minX, randomY, randomZ);

        key.incX();

        expect(key.x).toBe(minX + 1);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    it('.incX() - random value', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        key.incX();

        expect(key.x).toBe(randomX + 1);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    it('.incX() - max value', () => {
        const key = clazz.from(maxX - 1, randomY, randomZ);

        key.incX();

        expect(key.x).toBe(maxX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    it('.incX() - overflow value', () => {
        const key = clazz.from(maxX, randomY, randomZ);

        key.incX();

        expect(key.x).toBe(minX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    /**
     * TESTS for .decX() - decrement coordinates by one at a time
     */
    it('.decX() - class fn', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const newKey = clazz.decX(key);

        expect(key.x).not.toBe(newKey.x);
        expect(key.y).toBe(newKey.y);
        expect(key.z).toBe(newKey.z);

        const newKey2 = clazz.decX(key, new clazz());

        expect(key.x).not.toBe(newKey2.x);
        expect(key.y).toBe(newKey2.y);
        expect(key.z).toBe(newKey2.z);
    });

    it('.decX() - min value', () => {
        const key = clazz.from(minX + 1, randomY, randomZ);

        key.decX();

        expect(key.x).toBe(minX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    it('.decX() - random value', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        key.decX();

        expect(key.x).toBe(randomX - 1);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    it('.decX() - max value', () => {
        const key = clazz.from(maxX, randomY, randomZ);

        key.decX();

        expect(key.x).toBe(maxX - 1);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    it('.decX() - underflow value', () => {
        const key = clazz.from(minX, randomY, randomZ);

        key.decX();

        expect(key.x).toBe(maxX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    /**
     * TESTS for .incY() - increment coordinates by one at a time
     */
    it('.incY() - class fn', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const newKey = clazz.incY(key);

        expect(key.x).toBe(newKey.x);
        expect(key.y).not.toBe(newKey.y);
        expect(key.z).toBe(newKey.z);

        const newKey2 = clazz.incY(key, new clazz());

        expect(key.x).toBe(newKey2.x);
        expect(key.y).not.toBe(newKey2.y);
        expect(key.z).toBe(newKey2.z);
    });

    it('.incY() - min value', () => {
        const key = clazz.from(randomX, minY, randomZ);

        key.incY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(minY + 1);
        expect(key.z).toBe(randomZ);
    });

    it('.incY() - random value', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        key.incY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY + 1);
        expect(key.z).toBe(randomZ);
    });

    it('.incY() - max value', () => {
        const key = clazz.from(randomX, maxY - 1, randomZ);

        key.incY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(maxY);
        expect(key.z).toBe(randomZ);
    });

    it('.incY() - overflow value', () => {
        const key = clazz.from(randomX, maxY, randomZ);

        key.incY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(minY);
        expect(key.z).toBe(randomZ);
    });

    /**
     * TESTS for .decY() - decrement coordinates by one at a time
     */
    it('.decY() - class fn', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const newKey = clazz.decY(key);

        expect(key.x).toBe(newKey.x);
        expect(key.y).not.toBe(newKey.y);
        expect(key.z).toBe(newKey.z);

        const newKey2 = clazz.decY(key, new clazz());

        expect(key.x).toBe(newKey2.x);
        expect(key.y).not.toBe(newKey2.y);
        expect(key.z).toBe(newKey2.z);
    });

    it('.decY() - min value', () => {
        const key = clazz.from(randomX, minY + 1, randomZ);

        key.decY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(minY);
        expect(key.z).toBe(randomZ);
    });

    it('.decY() - random value', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        key.decY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY - 1);
        expect(key.z).toBe(randomZ);
    });

    it('.decY() - max value', () => {
        const key = clazz.from(randomX, maxY, randomZ);

        key.decY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(maxY - 1);
        expect(key.z).toBe(randomZ);
    });

    it('.decY() - underflow value', () => {
        const key = clazz.from(randomX, minY, randomZ);

        key.decY();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(maxY);
        expect(key.z).toBe(randomZ);
    });

    /**
     * TESTS for .incZ() - increment coordinates by one at a time
     */
    it('.incZ() - class fn', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const newKey = clazz.incZ(key);

        expect(key.x).toBe(newKey.x);
        expect(key.y).toBe(newKey.y);
        expect(key.z).not.toBe(newKey.z);

        const newKey2 = clazz.incZ(key, new clazz());

        expect(key.x).toBe(newKey2.x);
        expect(key.y).toBe(newKey2.y);
        expect(key.z).not.toBe(newKey2.z);
    });

    it('.incZ() - min value', () => {
        const key = clazz.from(randomX, randomY, minZ);

        key.incZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(minZ + 1);
    });

    it('.incZ() - random value', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        key.incZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ + 1);
    });

    it('.incZ() - max value', () => {
        const key = clazz.from(randomX, randomY, maxZ - 1);

        key.incZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(maxZ);
    });

    it('.incZ() - overflow value', () => {
        const key = clazz.from(randomX, randomY, maxZ);

        key.incZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(minZ);
    });

    /**
     * TESTS for .decZ() - decrement coordinates by one at a time
     */
    it('.decZ() - class fn', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        const newKey = clazz.decZ(key);

        expect(key.x).toBe(newKey.x);
        expect(key.y).toBe(newKey.y);
        expect(key.z).not.toBe(newKey.z);

        const newKey2 = clazz.decZ(key, new clazz());

        expect(key.x).toBe(newKey2.x);
        expect(key.y).toBe(newKey2.y);
        expect(key.z).not.toBe(newKey2.z);
    });

    it('.decZ() - min value', () => {
        const key = clazz.from(randomX, randomY, minZ + 1);

        key.decZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(minZ);
    });

    it('.decZ() - random value', () => {
        const key = clazz.from(randomX, randomY, randomZ);

        key.decZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ - 1);
    });

    it('.decZ() - max value', () => {
        const key = clazz.from(randomX, randomY, maxZ);

        key.decZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(maxZ - 1);
    });

    it('.decZ() - underflow value', () => {
        const key = clazz.from(randomX, randomY, minZ);

        key.decZ();

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(maxZ);
    });

    it('set & get .x .y .z - random values', () => {
        const key = new clazz();

        key.x = randomX;
        key.y = randomY;
        key.z = randomZ;

        expect(key.x).toBe(randomX);
        expect(key.y).toBe(randomY);
        expect(key.z).toBe(randomZ);
    });

    it('set & get .x .y .z - min values', () => {
        const key = new clazz();

        key.x = minX;
        key.y = minY;
        key.z = minZ;

        expect(key.x).toBe(minX);
        expect(key.y).toBe(minY);
        expect(key.z).toBe(minZ);
    });

    it('set & get .x .y .z - max values', () => {
        const key = new clazz();

        key.x = maxX;
        key.y = maxY;
        key.z = maxZ;

        expect(key.x).toBe(maxX);
        expect(key.y).toBe(maxY);
        expect(key.z).toBe(maxZ);
    });

    it('.add() - class key addition', () => {
        const key1 = clazz.from(randomX, randomY, randomZ);
        const key2 = clazz.from(randomZ, randomX, randomY);

        const add = clazz.add(key1, key2, new clazz());

        expect(add.x).toBe(randomX + randomZ);
        expect(add.y).toBe(randomY + randomX);
        expect(add.z).toBe(randomZ + randomY);

        const add2 = clazz.add(key1, key2);

        expect(add2.x).toBe(randomX + randomZ);
        expect(add2.y).toBe(randomY + randomX);
        expect(add2.z).toBe(randomZ + randomY);
    });

    it('.add() - key addition - independent', () => {
        const key1 = clazz.from(randomX, randomY, randomZ);
        const key2 = clazz.from(randomZ, randomX, randomY);

        const add = key1.add(key2, new clazz());

        expect(add.x).toBe(randomX + randomZ);
        expect(add.y).toBe(randomY + randomX);
        expect(add.z).toBe(randomZ + randomY);
    });

    it('.add() - key addition - dependent', () => {
        const key1 = clazz.from(randomX, randomY, randomZ);
        const key2 = clazz.from(randomZ, randomX, randomY);

        const add = key1.add(key2);

        expect(add.x).toBe(randomX + randomZ);
        expect(add.y).toBe(randomY + randomX);
        expect(add.z).toBe(randomZ + randomY);

        expect(add.x).toBe(key1.x);
        expect(add.y).toBe(key1.y);
        expect(add.z).toBe(key1.z);
    });

    it('.sub() - class key subtraction', () => {
        const key1 = clazz.from(maxX, maxY, maxZ);
        const key2 = clazz.from(randomX, randomY, randomZ);

        const add = clazz.sub(key1, key2, new clazz());

        expect(add.x).toBe(maxX - randomX);
        expect(add.y).toBe(maxY - randomY);
        expect(add.z).toBe(maxZ - randomZ);

        const add2 = clazz.sub(key1, key2);

        expect(add2.x).toBe(maxX - randomX);
        expect(add2.y).toBe(maxY - randomY);
        expect(add2.z).toBe(maxZ - randomZ);
    });

    it('.sub() - key subtraction - independent', () => {
        const key1 = clazz.from(maxX, maxY, maxZ);
        const key2 = clazz.from(randomX, randomY, randomZ);

        const add = key1.sub(key2, new clazz());

        expect(add.x).toBe(maxX - randomX);
        expect(add.y).toBe(maxY - randomY);
        expect(add.z).toBe(maxZ - randomZ);
    });

    it('.sub() - key subtraction - dependent', () => {
        const key1 = clazz.from(maxX, maxY, maxZ);
        const key2 = clazz.from(randomX, randomY, randomZ);

        const add = key1.sub(key2);

        expect(add.x).toBe(maxX - randomX);
        expect(add.y).toBe(maxY - randomY);
        expect(add.z).toBe(maxZ - randomZ);

        expect(add.x).toBe(key1.x);
        expect(add.y).toBe(key1.y);
        expect(add.z).toBe(key1.z);
    });

    it('.toString() - check formatting', () => {
        const key = clazz.from(1, 2, 3);
        const format: string = `MortonKey { key: ${key.key}, x: ${key.x}, y: ${key.y}, z: ${key.z} }`;

        expect(key.toString()).toBe(format);
    });

});