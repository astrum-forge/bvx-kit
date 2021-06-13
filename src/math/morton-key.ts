/**
 * Implementation for 32 bit 3D MortonKey (Z-order curve) keys.
 * 
 * 32 Bit keys allows encoding 2^10 or 0-1023 values per axis. 
 * Max values per axis becomes (including)
 * 
 * x - min 0, max 1023
 * y - min 0, max 1023
 * z - min 0, max 1023
 * 
 * See: https://en.wikipedia.org/wiki/Z-order_curve
 */
export class MortonKey {
    public static readonly X3_MASK: number = 0x9249249;
    public static readonly Y3_MASK: number = 0x12492492;
    public static readonly Z3_MASK: number = 0x24924924;

    public static readonly XY3_MASK: number = MortonKey.X3_MASK | MortonKey.Y3_MASK;
    public static readonly XZ3_MASK: number = MortonKey.X3_MASK | MortonKey.Z3_MASK;
    public static readonly YZ3_MASK: number = MortonKey.Y3_MASK | MortonKey.Z3_MASK;

    private _key: number = 0;

    constructor(key: number = 0) {
        this._key = key | 0;
    }

    public static from(x: number, y: number, z: number, optres: MortonKey | null = null): MortonKey {
        if (x > 1024 || x < 0) {
            throw new Error("MortonKey.from(x, y, z) - morton key x component must be between 0-1023 (10 bits), was " + x);
        }

        if (y > 1024 || y < 0) {
            throw new Error("MortonKey.from(x, y, z) - morton key y component must be between 0-1023 (10 bits), was " + y);
        }

        if (z > 1024 || z < 0) {
            throw new Error("MortonKey.from(x, y, z) - morton key z component must be between 0-1023 (10 bits), was " + z);
        }

        optres = optres || new MortonKey();

        const cx: number = MortonKey._EncodePart(x);
        const cy: number = MortonKey._EncodePart(y);
        const cz: number = MortonKey._EncodePart(z);

        optres._key = (cz << 2) + (cy << 1) + cx;

        return optres;
    }

    private static _EncodePart(n: number): number {
        const n0: number = (n | 0) & 0x000003ff;

        const n1: number = (n0 ^ (n0 << 16)) & 0xff0000ff;
        const n2: number = (n1 ^ (n1 << 8)) & 0x0300f00f;
        const n3: number = (n2 ^ (n2 << 4)) & 0x030c30c3;
        const n4: number = (n3 ^ (n3 << 2)) & 0x09249249;

        return n4;
    }

    private static _DecodePart(n: number): number {
        const n0: number = (n | 0) & 0x09249249;

        const n1: number = (n0 ^ (n0 >> 2)) & 0x030c30c3;
        const n2: number = (n1 ^ (n1 >> 4)) & 0x0300f00f;
        const n3: number = (n2 ^ (n2 >> 8)) & 0xff0000ff;
        const n4: number = (n3 ^ (n3 >> 16)) & 0x000003ff;

        return n4;
    }

    public static add(a: MortonKey, b: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const sum_x: number = (a._key | MortonKey.YZ3_MASK) + (b._key & MortonKey.X3_MASK);
        const sum_y: number = (a._key | MortonKey.XZ3_MASK) + (b._key & MortonKey.Y3_MASK);
        const sum_z: number = (a._key | MortonKey.XY3_MASK) + (b._key & MortonKey.Z3_MASK);

        optres._key = (sum_x & MortonKey.X3_MASK) | (sum_y & MortonKey.Y3_MASK) | (sum_z & MortonKey.Z3_MASK);

        return optres;
    }

    public static sub(a: MortonKey, b: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const sub_x: number = (a._key & MortonKey.X3_MASK) - (b._key & MortonKey.X3_MASK);
        const sub_y: number = (a._key & MortonKey.Y3_MASK) - (b._key & MortonKey.Y3_MASK);
        const sub_z: number = (a._key & MortonKey.Z3_MASK) - (b._key & MortonKey.Z3_MASK);

        optres._key = (sub_x & MortonKey.X3_MASK) | (sub_y & MortonKey.Y3_MASK) | (sub_z & MortonKey.Z3_MASK);

        return optres;
    }

    public static incX(a: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mortonKey: number = a._key;
        const sum: number = (mortonKey | MortonKey.YZ3_MASK) + 1;
        optres._key = (sum & MortonKey.X3_MASK) | (mortonKey & MortonKey.YZ3_MASK);

        return optres;
    }

    public static decX(a: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mortonKey: number = a._key;
        const diff: number = (mortonKey & MortonKey.X3_MASK) - 1;
        optres._key = (diff & MortonKey.X3_MASK) | (mortonKey & MortonKey.YZ3_MASK);

        return optres;
    }

    public static incY(a: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mortonKey: number = a._key;
        const sum: number = (mortonKey | MortonKey.XZ3_MASK) + 2;
        optres._key = (sum & MortonKey.Y3_MASK) | (mortonKey & MortonKey.XZ3_MASK);

        return optres;
    }

    public static decY(a: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mortonKey: number = a._key;
        const diff: number = (mortonKey & MortonKey.Y3_MASK) - 2;
        optres._key = (diff & MortonKey.Y3_MASK) | (mortonKey & MortonKey.XZ3_MASK);

        return optres;
    }

    public static incZ(a: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mortonKey: number = a._key;
        const sum: number = (mortonKey | MortonKey.XY3_MASK) + 1;
        optres._key = (sum & MortonKey.Z3_MASK) | (mortonKey & MortonKey.XY3_MASK);

        return optres;
    }

    public static decZ(a: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mortonKey: number = a._key;
        const diff: number = (mortonKey & MortonKey.Z3_MASK) - 1;
        optres._key = (diff & MortonKey.Z3_MASK) | (mortonKey & MortonKey.XY3_MASK);

        return optres;
    }

    public get key(): number {
        return this._key;
    }

    public get x(): number {
        return MortonKey._DecodePart(this._key);
    }

    public set x(value: number) {
        MortonKey.from(value, this.y, this.z, this);
    }

    public get y(): number {
        return MortonKey._DecodePart(this._key >> 1);
    }

    public set y(value: number) {
        MortonKey.from(this.x, value, this.z, this);
    }

    public get z(): number {
        return MortonKey._DecodePart(this._key >> 2);
    }

    public set z(value: number) {
        MortonKey.from(this.x, this.y, value, this);
    }

    public incX(): MortonKey {
        return MortonKey.incX(this, this);
    }

    public incY(): MortonKey {
        return MortonKey.incY(this, this);
    }

    public incZ(): MortonKey {
        return MortonKey.incZ(this, this);
    }

    public decX(): MortonKey {
        return MortonKey.decX(this, this);
    }

    public decY(): MortonKey {
        return MortonKey.decY(this, this);
    }

    public decZ(): MortonKey {
        return MortonKey.decZ(this, this);
    }

    public copy(): MortonKey {
        return new MortonKey(this._key);
    }
}