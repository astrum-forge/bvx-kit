import { LinearKey } from '../src/math/linear-key';
import { MortonKey } from '../src/math/morton-key';
import { VoxelIndex } from '../src/engine/voxel-index';

/**
 * Provides 100% Coverage for morton-key.ts
 */
describe('VoxelIndex', () => {
    const clazz = VoxelIndex;

    const randomX = 1;
    const randomY = 2;
    const randomZ = 3;

    const minX = 0;
    const minY = 0;
    const minZ = 0;

    const maxX = 3;
    const maxY = 3;
    const maxZ = 3;

    it('.constructor() - random key', () => {
        const mk = new clazz(randomX);

        expect(mk.key).toBe(randomX);
    });

    it('.match() - except vx and x to match', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);

        expect(key.x).toBe(key.vx);
        expect(key.y).toBe(key.vy);
        expect(key.z).toBe(key.vz);
    });

    it('.copy() - copy equality', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);

        const key2 = key.copy();

        expect(key.vx).toBe(key2.vx);
        expect(key.vy).toBe(key2.vy);
        expect(key.vz).toBe(key2.vz);

        expect(key.bx).toBe(key2.bx);
        expect(key.by).toBe(key2.by);
        expect(key.bz).toBe(key2.bz);
    });

    it('.clone() - copy equality', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);

        const key2 = key.clone();

        expect(key.vx).toBe(key2.vx);
        expect(key.vy).toBe(key2.vy);
        expect(key.vz).toBe(key2.vz);

        expect(key.bx).toBe(key2.bx);
        expect(key.by).toBe(key2.by);
        expect(key.bz).toBe(key2.bz);
    });

    it('.cmp() - comparison check', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);
        const key2 = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);
        const key3 = clazz.from(randomY, randomZ, randomX, randomY, randomZ, randomX);

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
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);
        const key2 = MortonKey.from(randomX, randomY, randomZ);

        expect(key.cmp(key2)).toBe(true);
        expect(key2.cmp(key)).toBe(true);
    });

    it('.from() - min values', () => {
        const key = clazz.from(minX, minY, minZ, minX, minY, minZ);

        expect(key.vx).toBe(minX);
        expect(key.vy).toBe(minY);
        expect(key.vz).toBe(minZ);

        expect(key.bx).toBe(minX);
        expect(key.by).toBe(minY);
        expect(key.bz).toBe(minZ);
    });

    it('.from() - max values', () => {
        const key = clazz.from(maxX, maxY, maxZ, maxX, maxY, maxZ);

        expect(key.vx).toBe(maxX);
        expect(key.vy).toBe(maxY);
        expect(key.vz).toBe(maxZ);

        expect(key.bx).toBe(maxX);
        expect(key.by).toBe(maxY);
        expect(key.bz).toBe(maxZ);
    });

    it('.from() - underflow values', () => {
        const key = clazz.from(minX - 1, minY, minZ, minX - 1, minY, minZ);

        expect(key.vx).toBe(maxX);
        expect(key.vy).toBe(minY);
        expect(key.vz).toBe(minZ);

        expect(key.bx).toBe(maxX);
        expect(key.by).toBe(minY);
        expect(key.bz).toBe(minZ);

        const key2 = clazz.from(minX, minY - 1, minZ, minX, minY - 1, minZ);

        expect(key2.vx).toBe(minX);
        expect(key2.vy).toBe(maxY);
        expect(key2.vz).toBe(minZ);

        expect(key2.bx).toBe(minX);
        expect(key2.by).toBe(maxY);
        expect(key2.bz).toBe(minZ);

        const key3 = clazz.from(minX, minY, minZ - 1, minX, minY, minZ - 1);

        expect(key3.vx).toBe(minX);
        expect(key3.vy).toBe(minY);
        expect(key3.vz).toBe(maxZ);

        expect(key3.bx).toBe(minX);
        expect(key3.by).toBe(minY);
        expect(key3.bz).toBe(maxZ);
    });

    it('.from() - overflow values', () => {
        const key = clazz.from(maxX + 1, maxY, maxZ, maxX + 1, maxY, maxZ);

        expect(key.vx).toBe(minX);
        expect(key.vy).toBe(maxY);
        expect(key.vz).toBe(maxZ);

        expect(key.bx).toBe(minX);
        expect(key.by).toBe(maxY);
        expect(key.bz).toBe(maxZ);

        const key2 = clazz.from(maxX, maxY + 1, maxZ, maxX, maxY + 1, maxZ);

        expect(key2.vx).toBe(maxX);
        expect(key2.vy).toBe(minY);
        expect(key2.vz).toBe(maxZ);

        expect(key2.bx).toBe(maxX);
        expect(key2.by).toBe(minY);
        expect(key2.bz).toBe(maxZ);

        const key3 = clazz.from(maxX, maxY, maxZ + 1, maxX, maxY, maxZ + 1);

        expect(key3.vx).toBe(maxX);
        expect(key3.vy).toBe(maxY);
        expect(key3.vz).toBe(minZ);

        expect(key3.bx).toBe(maxX);
        expect(key3.by).toBe(maxY);
        expect(key3.bz).toBe(minZ);
    });

    it('.from(0, 0, 0, 0, 0, 0) - x, y, z, u, v, w values', () => {
        const key = clazz.from(minX, minY, minZ, minX, minY, minZ);

        expect(key.vx).toBe(minX);
        expect(key.vy).toBe(minY);
        expect(key.vz).toBe(minZ);

        expect(key.bx).toBe(minX);
        expect(key.by).toBe(minY);
        expect(key.bz).toBe(minZ);
    });

    it('.from(3, 3, 3) - x, y, z, u, v, w values', () => {
        const key = clazz.from(maxX, maxY, maxZ, maxX, maxY, maxZ);

        expect(key.bx).toBe(maxX);
        expect(key.by).toBe(maxY);
        expect(key.bz).toBe(maxZ);

        expect(key.vx).toBe(maxX);
        expect(key.vy).toBe(maxY);
        expect(key.vz).toBe(maxZ);
    });

    it('.from() - x(0-3), y(0-3), z(0-3), u(0-3), v(0-3), w(0-3) values', () => {
        const min = 0;
        const max = 3;

        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    const key = clazz.from(x, y, z, x, y, z);

                    expect(key.vx).toBe(x);
                    expect(key.vy).toBe(y);
                    expect(key.vz).toBe(z);

                    expect(key.bx).toBe(x);
                    expect(key.by).toBe(y);
                    expect(key.bz).toBe(z);
                }
            }
        }
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

    it('set & get .vx .vy .vz .bx .by .bz - random values', () => {
        const key = new clazz();

        key.vx = randomX;
        key.vy = randomY;
        key.vz = randomZ;

        key.bx = randomX;
        key.by = randomY;
        key.bz = randomZ;

        expect(key.vx).toBe(randomX);
        expect(key.vy).toBe(randomY);
        expect(key.vz).toBe(randomZ);

        expect(key.bx).toBe(randomX);
        expect(key.by).toBe(randomY);
        expect(key.bz).toBe(randomZ);
    });

    it('set & get .vx .vy .vz .bx .by .bz - min values', () => {
        const key = new clazz();

        key.vx = minX;
        key.vy = minY;
        key.vz = minZ;

        key.bx = minX;
        key.by = minY;
        key.bz = minZ;

        expect(key.vx).toBe(minX);
        expect(key.vy).toBe(minY);
        expect(key.vz).toBe(minZ);

        expect(key.bx).toBe(minX);
        expect(key.by).toBe(minY);
        expect(key.bz).toBe(minZ);
    });

    it('set & get .vx .vy .vz .bx .by .bz - max values', () => {
        const key = new clazz();

        key.vx = maxX;
        key.vy = maxY;
        key.vz = maxZ;

        key.bx = maxX;
        key.by = maxY;
        key.bz = maxZ;

        expect(key.vx).toBe(maxX);
        expect(key.vy).toBe(maxY);
        expect(key.vz).toBe(maxZ);

        expect(key.bx).toBe(maxX);
        expect(key.by).toBe(maxY);
        expect(key.bz).toBe(maxZ);
    });

    it('get .vKey .bKey - check validity', () => {
        const keyMinMin = clazz.from(minX, minY, minZ, minX, minY, minZ);

        expect(keyMinMin.vKey).toBe(0);
        expect(keyMinMin.bKey).toBe(0);

        const keyMaxMax = clazz.from(maxX, maxY, maxZ, maxX, maxY, maxZ);

        expect(keyMaxMax.vKey).toBe(63);
        expect(keyMaxMax.bKey).toBe(63);

        const keyMinMax = clazz.from(minX, minY, minZ, maxX, maxY, maxZ);

        expect(keyMinMax.vKey).toBe(0);
        expect(keyMinMax.bKey).toBe(63);

        const keyMaxMin = clazz.from(maxX, maxY, maxZ, minX, minY, minZ);

        expect(keyMaxMin.vKey).toBe(63);
        expect(keyMaxMin.bKey).toBe(0);

        const keyOnes = clazz.from(1, 1, 1, 1, 1, 1);

        expect(keyOnes.vKey).toBe(21);
        expect(keyOnes.bKey).toBe(21);

        const keyTwos = clazz.from(2, 2, 2, 2, 2, 2);

        expect(keyTwos.vKey).toBe(42);
        expect(keyTwos.bKey).toBe(42);
    });
});