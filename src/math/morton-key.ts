import { BitOps } from "../util/bit-ops";
import { Key } from "./key";

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
 * Values exceeding these tolerances will wrap around, for example
 * 1024 becomes 0
 * 1025 becomes 1
 * 
 * Negative values will also wrap around, for example
 * -1 becomes 1023
 * -2 becomes 1022
 * 
 * See: https://en.wikipedia.org/wiki/Z-order_curve
 * 
 * MortonKeys are slower to operate than LinearKeys however they provide
 * a much better data-distribution when used as a hash-key for inserting items
 * randomly into a dictionary or hash-map. This can be important for Server-side
 * data lookups.
 */
export class MortonKey implements Key {
    /**
     * Each component (x, y, z) can hold 10 bits of data for a total of 30 bits
     */
    private static readonly KEY_MASK: number = BitOps.maskForBits(10);

    private static readonly X3_MASK: number = 0x9249249;
    private static readonly Y3_MASK: number = 0x12492492;
    private static readonly Z3_MASK: number = 0x24924924;

    private static readonly XY3_MASK: number = MortonKey.X3_MASK | MortonKey.Y3_MASK;
    private static readonly XZ3_MASK: number = MortonKey.X3_MASK | MortonKey.Z3_MASK;
    private static readonly YZ3_MASK: number = MortonKey.Y3_MASK | MortonKey.Z3_MASK;

    private _key: number = 0;

    constructor(key: number = 0) {
        this._key = key | 0;
    }

    public static from(x: number, y: number, z: number, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mask: number = MortonKey.KEY_MASK;

        const cx: number = MortonKey._EncodePart(x & mask);
        const cy: number = MortonKey._EncodePart(y & mask);
        const cz: number = MortonKey._EncodePart(z & mask);

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

        const sumX: number = (a._key | MortonKey.YZ3_MASK) + (b._key & MortonKey.X3_MASK);
        const sumY: number = (a._key | MortonKey.XZ3_MASK) + (b._key & MortonKey.Y3_MASK);
        const sumZ: number = (a._key | MortonKey.XY3_MASK) + (b._key & MortonKey.Z3_MASK);

        optres._key = (sumX & MortonKey.X3_MASK) | (sumY & MortonKey.Y3_MASK) | (sumZ & MortonKey.Z3_MASK);

        return optres;
    }

    public static sub(a: MortonKey, b: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const subX: number = (a._key & MortonKey.X3_MASK) - (b._key & MortonKey.X3_MASK);
        const subY: number = (a._key & MortonKey.Y3_MASK) - (b._key & MortonKey.Y3_MASK);
        const subZ: number = (a._key & MortonKey.Z3_MASK) - (b._key & MortonKey.Z3_MASK);

        optres._key = (subX & MortonKey.X3_MASK) | (subY & MortonKey.Y3_MASK) | (subZ & MortonKey.Z3_MASK);

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

    public add(other: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || this;

        MortonKey.add(this, other, optres);

        return optres;
    }

    public sub(other: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || this;

        MortonKey.sub(this, other, optres);

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

    public incX(optres: MortonKey | null = null): MortonKey {
        return MortonKey.incX(this, optres || this);
    }

    public incY(optres: MortonKey | null = null): MortonKey {
        return MortonKey.incY(this, optres || this);
    }

    public incZ(optres: MortonKey | null = null): MortonKey {
        return MortonKey.incZ(this, optres || this);
    }

    public decX(optres: MortonKey | null = null): MortonKey {
        return MortonKey.decX(this, optres || this);
    }

    public decY(optres: MortonKey | null = null): MortonKey {
        return MortonKey.decY(this, optres || this);
    }

    public decZ(optres: MortonKey | null = null): MortonKey {
        return MortonKey.decZ(this, optres || this);
    }

    public copy(optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        optres._key = this._key;

        return optres;
    }

    public clone(): MortonKey {
        return new MortonKey(this._key);
    }

    public cmp(other: Key): boolean {
        if (other instanceof MortonKey) {
            return this._key === other.key;
        }

        return this.x === other.x && this.y === other.y && this.z === other.z;
    }
}