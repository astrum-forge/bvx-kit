import MortonKey from '../src/math/morton-key';

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

    it('.from() - min values', () => {
        expect(() => clazz.from(minX, minY, minZ)).not.toThrow(Error);
    });

    it('.from() - max values', () => {
        expect(() => clazz.from(maxX, maxY, maxZ)).not.toThrow(Error);
    });

    it('.from() - negative values', () => {
        expect(() => clazz.from(minX - 1, minY, minZ)).toThrow(Error);
        expect(() => clazz.from(minX, minY - 1, minZ)).toThrow(Error);
        expect(() => clazz.from(minX, minY, minZ - 1)).toThrow(Error);
    });

    it('.from() - overflow values', () => {
        expect(() => clazz.from(maxX + 1, maxY, maxZ)).toThrow(Error);
        expect(() => clazz.from(maxX, maxY + 1, maxZ)).toThrow(Error);
        expect(() => clazz.from(maxX, maxY, maxZ + 1)).toThrow(Error);
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

});