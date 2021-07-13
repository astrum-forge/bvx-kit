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

        expect(mk.key).toEqual(randomX);
    });

    it('.match() - expect vx and x to match', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);

        expect(key.x).toEqual(key.vx);
        expect(key.y).toEqual(key.vy);
        expect(key.z).toEqual(key.vz);
    });

    it('.copy() - copy equality', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);

        const key2 = key.copy();

        expect(key.vx).toEqual(key2.vx);
        expect(key.vy).toEqual(key2.vy);
        expect(key.vz).toEqual(key2.vz);

        expect(key.bx).toEqual(key2.bx);
        expect(key.by).toEqual(key2.by);
        expect(key.bz).toEqual(key2.bz);
    });

    it('.clone() - clone equality', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);

        const key2 = key.clone();

        expect(key.vx).toEqual(key2.vx);
        expect(key.vy).toEqual(key2.vy);
        expect(key.vz).toEqual(key2.vz);

        expect(key.bx).toEqual(key2.bx);
        expect(key.by).toEqual(key2.by);
        expect(key.bz).toEqual(key2.bz);
    });

    it('.set key - key equality', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);

        const key2 = new clazz();
        key2.key = key.key;

        expect(key.vx).toEqual(key2.vx);
        expect(key.vy).toEqual(key2.vy);
        expect(key.vz).toEqual(key2.vz);

        expect(key.bx).toEqual(key2.bx);
        expect(key.by).toEqual(key2.by);
        expect(key.bz).toEqual(key2.bz);
    });

    it('.cmp() - comparison check', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);
        const key2 = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);
        const key3 = clazz.from(randomY, randomZ, randomX, randomY, randomZ, randomX);

        expect(key.cmp(key2)).toEqual(true);
        expect(key.cmp(key3)).toEqual(false);
        expect(key2.cmp(key)).toEqual(true);
        expect(key2.cmp(key3)).toEqual(false);
        expect(key3.cmp(key)).toEqual(false);
        expect(key3.cmp(key2)).toEqual(false);

        // expect self comparisons to all be true
        expect(key.cmp(key)).toEqual(true);
        expect(key2.cmp(key2)).toEqual(true);
        expect(key3.cmp(key3)).toEqual(true);
    });

    it('.cmp() - comparison check against another key', () => {
        const key = clazz.from(randomX, randomY, randomZ, randomX, randomY, randomZ);
        const key2 = MortonKey.from(randomX, randomY, randomZ);

        expect(key.cmp(key2)).toEqual(true);
        expect(key2.cmp(key)).toEqual(true);
    });

    it('.from() - expect default BVX values to be zero', () => {
        const key = clazz.from(randomX, randomY, randomZ, 0, 0, 0);
        const key2 = clazz.from(randomX, randomY, randomZ);

        expect(key.cmp(key2)).toEqual(true);
        expect(key2.bx).toEqual(0);
        expect(key2.by).toEqual(0);
        expect(key2.bz).toEqual(0);
    });

    it('.from() - min values', () => {
        const key = clazz.from(minX, minY, minZ, minX, minY, minZ);

        expect(key.vx).toEqual(minX);
        expect(key.vy).toEqual(minY);
        expect(key.vz).toEqual(minZ);

        expect(key.bx).toEqual(minX);
        expect(key.by).toEqual(minY);
        expect(key.bz).toEqual(minZ);
    });

    it('.from() - max values', () => {
        const key = clazz.from(maxX, maxY, maxZ, maxX, maxY, maxZ);

        expect(key.vx).toEqual(maxX);
        expect(key.vy).toEqual(maxY);
        expect(key.vz).toEqual(maxZ);

        expect(key.bx).toEqual(maxX);
        expect(key.by).toEqual(maxY);
        expect(key.bz).toEqual(maxZ);
    });

    it('.from() - underflow values', () => {
        const key = clazz.from(minX - 1, minY, minZ, minX - 1, minY, minZ);

        expect(key.vx).toEqual(maxX);
        expect(key.vy).toEqual(minY);
        expect(key.vz).toEqual(minZ);

        expect(key.bx).toEqual(maxX);
        expect(key.by).toEqual(minY);
        expect(key.bz).toEqual(minZ);

        const key2 = clazz.from(minX, minY - 1, minZ, minX, minY - 1, minZ);

        expect(key2.vx).toEqual(minX);
        expect(key2.vy).toEqual(maxY);
        expect(key2.vz).toEqual(minZ);

        expect(key2.bx).toEqual(minX);
        expect(key2.by).toEqual(maxY);
        expect(key2.bz).toEqual(minZ);

        const key3 = clazz.from(minX, minY, minZ - 1, minX, minY, minZ - 1);

        expect(key3.vx).toEqual(minX);
        expect(key3.vy).toEqual(minY);
        expect(key3.vz).toEqual(maxZ);

        expect(key3.bx).toEqual(minX);
        expect(key3.by).toEqual(minY);
        expect(key3.bz).toEqual(maxZ);
    });

    it('.from() - overflow values', () => {
        const key = clazz.from(maxX + 1, maxY, maxZ, maxX + 1, maxY, maxZ);

        expect(key.vx).toEqual(minX);
        expect(key.vy).toEqual(maxY);
        expect(key.vz).toEqual(maxZ);

        expect(key.bx).toEqual(minX);
        expect(key.by).toEqual(maxY);
        expect(key.bz).toEqual(maxZ);

        const key2 = clazz.from(maxX, maxY + 1, maxZ, maxX, maxY + 1, maxZ);

        expect(key2.vx).toEqual(maxX);
        expect(key2.vy).toEqual(minY);
        expect(key2.vz).toEqual(maxZ);

        expect(key2.bx).toEqual(maxX);
        expect(key2.by).toEqual(minY);
        expect(key2.bz).toEqual(maxZ);

        const key3 = clazz.from(maxX, maxY, maxZ + 1, maxX, maxY, maxZ + 1);

        expect(key3.vx).toEqual(maxX);
        expect(key3.vy).toEqual(maxY);
        expect(key3.vz).toEqual(minZ);

        expect(key3.bx).toEqual(maxX);
        expect(key3.by).toEqual(maxY);
        expect(key3.bz).toEqual(minZ);
    });

    it('.from(0, 0, 0, 0, 0, 0) - x, y, z, u, v, w values', () => {
        const key = clazz.from(minX, minY, minZ, minX, minY, minZ);

        expect(key.vx).toEqual(minX);
        expect(key.vy).toEqual(minY);
        expect(key.vz).toEqual(minZ);

        expect(key.bx).toEqual(minX);
        expect(key.by).toEqual(minY);
        expect(key.bz).toEqual(minZ);
    });

    it('.from(3, 3, 3) - x, y, z, u, v, w values', () => {
        const key = clazz.from(maxX, maxY, maxZ, maxX, maxY, maxZ);

        expect(key.bx).toEqual(maxX);
        expect(key.by).toEqual(maxY);
        expect(key.bz).toEqual(maxZ);

        expect(key.vx).toEqual(maxX);
        expect(key.vy).toEqual(maxY);
        expect(key.vz).toEqual(maxZ);
    });

    it('.from() - x(0-3), y(0-3), z(0-3), u(0-3), v(0-3), w(0-3) values', () => {
        const min = 0;
        const max = 3;

        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    const key = clazz.from(x, y, z, x, y, z);

                    expect(key.vx).toEqual(x);
                    expect(key.vy).toEqual(y);
                    expect(key.vz).toEqual(z);

                    expect(key.bx).toEqual(x);
                    expect(key.by).toEqual(y);
                    expect(key.bz).toEqual(z);
                }
            }
        }
    });

    it('set & get .x .y .z - random values', () => {
        const key = new clazz();

        key.x = randomX;
        key.y = randomY;
        key.z = randomZ;

        expect(key.x).toEqual(randomX);
        expect(key.y).toEqual(randomY);
        expect(key.z).toEqual(randomZ);
    });

    it('set & get .vx .vy .vz .bx .by .bz - random values', () => {
        const key = new clazz();

        key.vx = randomX;
        key.vy = randomY;
        key.vz = randomZ;

        key.bx = randomX;
        key.by = randomY;
        key.bz = randomZ;

        expect(key.vx).toEqual(randomX);
        expect(key.vy).toEqual(randomY);
        expect(key.vz).toEqual(randomZ);

        expect(key.bx).toEqual(randomX);
        expect(key.by).toEqual(randomY);
        expect(key.bz).toEqual(randomZ);
    });

    it('set & get .vx .vy .vz .bx .by .bz - min values', () => {
        const key = new clazz();

        key.vx = minX;
        key.vy = minY;
        key.vz = minZ;

        key.bx = minX;
        key.by = minY;
        key.bz = minZ;

        expect(key.vx).toEqual(minX);
        expect(key.vy).toEqual(minY);
        expect(key.vz).toEqual(minZ);

        expect(key.bx).toEqual(minX);
        expect(key.by).toEqual(minY);
        expect(key.bz).toEqual(minZ);
    });

    it('set & get .vx .vy .vz .bx .by .bz - max values', () => {
        const key = new clazz();

        key.vx = maxX;
        key.vy = maxY;
        key.vz = maxZ;

        key.bx = maxX;
        key.by = maxY;
        key.bz = maxZ;

        expect(key.vx).toEqual(maxX);
        expect(key.vy).toEqual(maxY);
        expect(key.vz).toEqual(maxZ);

        expect(key.bx).toEqual(maxX);
        expect(key.by).toEqual(maxY);
        expect(key.bz).toEqual(maxZ);
    });

    it('get .vKey .bKey - check validity', () => {
        const keyMinMin = clazz.from(minX, minY, minZ, minX, minY, minZ);

        expect(keyMinMin.vKey).toEqual(0);
        expect(keyMinMin.bKey).toEqual(0);

        const keyMaxMax = clazz.from(maxX, maxY, maxZ, maxX, maxY, maxZ);

        expect(keyMaxMax.vKey).toEqual(63);
        expect(keyMaxMax.bKey).toEqual(63);

        const keyMinMax = clazz.from(minX, minY, minZ, maxX, maxY, maxZ);

        expect(keyMinMax.vKey).toEqual(0);
        expect(keyMinMax.bKey).toEqual(63);

        const keyMaxMin = clazz.from(maxX, maxY, maxZ, minX, minY, minZ);

        expect(keyMaxMin.vKey).toEqual(63);
        expect(keyMaxMin.bKey).toEqual(0);

        const keyOnes = clazz.from(1, 1, 1, 1, 1, 1);

        expect(keyOnes.vKey).toEqual(21);
        expect(keyOnes.bKey).toEqual(21);

        const keyTwos = clazz.from(2, 2, 2, 2, 2, 2);

        expect(keyTwos.vKey).toEqual(42);
        expect(keyTwos.bKey).toEqual(42);

        const keyLast = clazz.from(1, 2, 3, 3, 2, 1);

        expect(keyLast.vKey).toEqual(27);
        expect(keyLast.bKey).toEqual(57);
    });
});