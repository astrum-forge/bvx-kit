import MortonKey from '../src/math/morton-key';

describe('MortonKey', () => {
    it('.from() - min values', () => {
        expect(() => MortonKey.from(0, 0, 0)).not.toThrow(Error);
    });

    it('.from() - max values', () => {
        expect(() => MortonKey.from(1023, 1023, 1023)).not.toThrow(Error);
    });

    it('.from() - negative values', () => {
        expect(() => MortonKey.from(-1, 0, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, -1, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, 0, -1)).toThrow(Error);
    });

    it('.from() - overflow values', () => {
        expect(() => MortonKey.from(1024, 0, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, 1024, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, 0, 1024)).toThrow(Error);
    });

    it('.from(0, 0, 0) - x, y, z values', () => {
        const key = MortonKey.from(0, 0, 0);

        expect(key.x).toBe(0);
        expect(key.y).toBe(0);
        expect(key.z).toBe(0);
    });

    it('.from(1023, 1023, 1023) - x, y, z values', () => {
        const key = MortonKey.from(1023, 1023, 1023);

        expect(key.x).toBe(1023);
        expect(key.y).toBe(1023);
        expect(key.z).toBe(1023);
    });

    it('.from() - x(0-11), y(0-11), z(0-11) values', () => {
        const min = 0;
        const max = 11;

        for (let x = min; x < max; x++) {
            for (let y = min; y < max; y++) {
                for (let z = min; z < max; z++) {
                    const key = MortonKey.from(x, y, z);

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
                    const key = MortonKey.from(x, y, z);

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
                    const key = MortonKey.from(x, y, z);

                    expect(key.x).toBe(x);
                    expect(key.y).toBe(y);
                    expect(key.z).toBe(z);
                }
            }
        }
    });

});