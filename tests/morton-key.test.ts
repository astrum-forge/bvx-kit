import MortonKey from '../src/math/morton-key';

describe('MortonKey', function () {
    it('MortonKey.from() - min values', function () {
        expect(() => MortonKey.from(0, 0, 0)).not.toThrow(Error);
    });

    it('MortonKey.from() - max values', function () {
        expect(() => MortonKey.from(1023, 1023, 1023)).not.toThrow(Error);
    });

    it('MortonKey.from() - negative values', function () {
        expect(() => MortonKey.from(-1, 0, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, -1, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, 0, -1)).toThrow(Error);
    });

    it('MortonKey.from() - overflow values', function () {
        expect(() => MortonKey.from(1024, 0, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, 1024, 0)).toThrow(Error);
        expect(() => MortonKey.from(0, 0, 1024)).toThrow(Error);
    });

    it('MortonKey.from(0, 0, 0) - x, y, z values', function () {
        const key = MortonKey.from(0, 0, 0);

        expect(key.x).toBe(0);
        expect(key.y).toBe(0);
        expect(key.z).toBe(0);
    });

    it('MortonKey.from(1023, 1023, 1023) - x, y, z values', function () {
        const key = MortonKey.from(1023, 1023, 1023);

        expect(key.x).toBe(1023);
        expect(key.y).toBe(1023);
        expect(key.z).toBe(1023);
    });
});