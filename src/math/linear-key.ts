/**
 * Implementation for 32 bit 3D LinearKey compact keys.
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
export default class LinearKey {
    public static readonly KEY_MASK: number = 0x3FF;

    private _key: number = 0;

    constructor(key: number = 0) {
        this._key = key | 0;
    }

    public static from(x: number, y: number, z: number, optres: LinearKey | null = null): LinearKey {
        if (x >= 1024 || x < 0) {
            throw new Error("LinearKey.from(x, y, z) - linear key x component must be between 0-1023 (10 bits), was " + x);
        }

        if (y >= 1024 || y < 0) {
            throw new Error("LinearKey.from(x, y, z) - linear key y component must be between 0-1023 (10 bits), was " + y);
        }

        if (z >= 1024 || z < 0) {
            throw new Error("LinearKey.from(x, y, z) - linear key z component must be between 0-1023 (10 bits), was " + z);
        }

        optres = optres || new LinearKey();

        optres._key = LinearKey._Encode(x, y, z);

        return optres;
    }

    private static _Encode(x: number, y: number, z: number): number {
        const cx: number = (x | 0) & LinearKey.KEY_MASK;
        const cy: number = (y | 0) & LinearKey.KEY_MASK;
        const cz: number = (z | 0) & LinearKey.KEY_MASK;

        return cx << 20 | cy << 10 | cz;
    }

    public static add(a: LinearKey, b: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        const sum_x: number = a.x + b.x;
        const sum_y: number = a.y + b.y;
        const sum_z: number = a.z + b.z;

        optres._key = LinearKey._Encode(sum_x, sum_y, sum_z);

        return optres;
    }

    public static sub(a: LinearKey, b: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        const sub_x: number = a.x - b.x;
        const sub_y: number = a.y - b.y;
        const sub_z: number = a.z - b.z;

        optres._key = LinearKey._Encode(sub_x, sub_y, sub_z);

        return optres;
    }

    public static incX(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        optres._key = LinearKey._Encode(a.x + 1, a.y, a.z);

        return optres;
    }

    public static decX(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        optres._key = LinearKey._Encode(a.x - 1, a.y, a.z);

        return optres;
    }

    public static incY(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        optres._key = LinearKey._Encode(a.x, a.y + 1, a.z);

        return optres;
    }

    public static decY(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        optres._key = LinearKey._Encode(a.x, a.y - 1, a.z);

        return optres;
    }

    public static incZ(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        optres._key = LinearKey._Encode(a.x, a.y, a.z + 1);

        return optres;
    }

    public static decZ(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        optres._key = LinearKey._Encode(a.x, a.y, a.z - 1);

        return optres;
    }

    public add(other: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || this;

        LinearKey.add(this, other, optres);

        return optres;
    }

    public sub(other: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || this;

        LinearKey.sub(this, other, optres);

        return optres;
    }

    public get key(): number {
        return this._key;
    }

    public get x(): number {
        return (this._key >> 20) & LinearKey.KEY_MASK;
    }

    public set x(value: number) {
        LinearKey.from(value, this.y, this.z, this);
    }

    public get y(): number {
        return (this._key >> 10) & LinearKey.KEY_MASK;
    }

    public set y(value: number) {
        LinearKey.from(this.x, value, this.z, this);
    }

    public get z(): number {
        return this._key & LinearKey.KEY_MASK;
    }

    public set z(value: number) {
        LinearKey.from(this.x, this.y, value, this);
    }

    public incX(optres: LinearKey | null = null): LinearKey {
        return LinearKey.incX(this, optres || this);
    }

    public incY(optres: LinearKey | null = null): LinearKey {
        return LinearKey.incY(this, optres || this);
    }

    public incZ(optres: LinearKey | null = null): LinearKey {
        return LinearKey.incZ(this, optres || this);
    }

    public decX(optres: LinearKey | null = null): LinearKey {
        return LinearKey.decX(this, optres || this);
    }

    public decY(optres: LinearKey | null = null): LinearKey {
        return LinearKey.decY(this, optres || this);
    }

    public decZ(optres: LinearKey | null = null): LinearKey {
        return LinearKey.decZ(this, optres || this);
    }

    public copy(optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();

        optres._key = this._key;

        return optres;
    }

    public cmp(other: LinearKey): boolean {
        return this._key === other._key;
    }
}