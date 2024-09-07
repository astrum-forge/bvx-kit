import { BitOps } from "../util/bit-ops.js";
import { Key } from "./key.js";

/**
 * Implementation of a 32-bit 3D MortonKey (Z-order curve) for compact 3D spatial keys.
 * 
 * MortonKeys map 3D coordinates into a 1D space-filling curve using bitwise interleaving.
 * Each axis (x, y, z) can encode values from 0 to 1023 (2^10), resulting in a 
 * 30-bit key representation. Morton keys provide good spatial locality, which makes
 * them useful in hash-maps and for organizing spatial data.
 * 
 * Max values per axis:
 * 
 * - x: min 0, max 1023
 * - y: min 0, max 1023
 * - z: min 0, max 1023
 * 
 * Values exceeding these limits will wrap around:
 * - 1024 becomes 0, 1025 becomes 1
 * - -1 becomes 1023, -2 becomes 1022
 * 
 * MortonKeys are generally slower to operate on than LinearKeys but provide
 * better spatial data distribution when used as hash keys, especially useful for 
 * server-side data lookups.
 * 
 * For more information: https://en.wikipedia.org/wiki/Z-order_curve
 */
export class MortonKey implements Key {
    /**
     * Each axis (x, y, z) can store up to 10 bits, creating a 30-bit Morton key.
     */
    private static readonly KEY_MASK: number = BitOps.maskForBits(10);

    /**
     * Bitmasks used for interleaving the bits of the x, y, and z coordinates in the Morton encoding.
     */
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

    /**
     * Encodes the given 3D coordinates (x, y, z) into a 32-bit Morton key.
     * 
     * @param x - The x-coordinate (0-1023).
     * @param y - The y-coordinate (0-1023).
     * @param z - The z-coordinate (0-1023).
     * @param optres - Optional MortonKey to reuse, reducing memory allocations.
     * @returns - The new or modified MortonKey.
     */
    public static from(x: number, y: number, z: number, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const mask: number = MortonKey.KEY_MASK;

        const cx: number = MortonKey._EncodePart(x & mask);
        const cy: number = MortonKey._EncodePart(y & mask);
        const cz: number = MortonKey._EncodePart(z & mask);

        optres._key = (cz << 2) + (cy << 1) + cx;

        return optres;
    }

    /**
     * Encodes a single coordinate value into its interleaved form for Morton encoding.
     * 
     * @param n - The 10-bit value to encode.
     * @returns - The interleaved value for Morton encoding.
     */
    private static _EncodePart(n: number): number {
        const n0: number = (n | 0) & 0x000003ff;

        const n1: number = (n0 ^ (n0 << 16)) & 0xff0000ff;
        const n2: number = (n1 ^ (n1 << 8)) & 0x0300f00f;
        const n3: number = (n2 ^ (n2 << 4)) & 0x030c30c3;
        const n4: number = (n3 ^ (n3 << 2)) & 0x09249249;

        return n4;
    }

    /**
     * Decodes an interleaved value back into its original 10-bit coordinate.
     * 
     * @param n - The interleaved value to decode.
     * @returns - The original 10-bit value.
     */
    private static _DecodePart(n: number): number {
        const n0: number = (n | 0) & 0x09249249;

        const n1: number = (n0 ^ (n0 >> 2)) & 0x030c30c3;
        const n2: number = (n1 ^ (n1 >> 4)) & 0x0300f00f;
        const n3: number = (n2 ^ (n2 >> 8)) & 0xff0000ff;
        const n4: number = (n3 ^ (n3 >> 16)) & 0x000003ff;

        return n4;
    }

    /**
     * Adds two MortonKeys together by adding their encoded components (x, y, z).
     * 
     * @param a - The first MortonKey.
     * @param b - The second MortonKey.
     * @param optres - Optional MortonKey to store the result, reducing allocations.
     * @returns - The new or modified MortonKey representing the sum.
     */
    public static add(a: MortonKey, b: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const sumX: number = (a._key | MortonKey.YZ3_MASK) + (b._key & MortonKey.X3_MASK);
        const sumY: number = (a._key | MortonKey.XZ3_MASK) + (b._key & MortonKey.Y3_MASK);
        const sumZ: number = (a._key | MortonKey.XY3_MASK) + (b._key & MortonKey.Z3_MASK);

        optres._key = (sumX & MortonKey.X3_MASK) | (sumY & MortonKey.Y3_MASK) | (sumZ & MortonKey.Z3_MASK);

        return optres;
    }

    /**
     * Subtracts one MortonKey from another by subtracting their encoded components (x, y, z).
     * 
     * @param a - The first MortonKey.
     * @param b - The second MortonKey.
     * @param optres - Optional MortonKey to store the result, reducing allocations.
     * @returns - The new or modified MortonKey representing the difference.
     */
    public static sub(a: MortonKey, b: MortonKey, optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();

        const subX: number = (a._key & MortonKey.X3_MASK) - (b._key & MortonKey.X3_MASK);
        const subY: number = (a._key & MortonKey.Y3_MASK) - (b._key & MortonKey.Y3_MASK);
        const subZ: number = (a._key & MortonKey.Z3_MASK) - (b._key & MortonKey.Z3_MASK);

        optres._key = (subX & MortonKey.X3_MASK) | (subY & MortonKey.Y3_MASK) | (subZ & MortonKey.Z3_MASK);

        return optres;
    }

    // Increment and decrement operations for individual axes
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

    /**
     * Adds another MortonKey to the current instance.
     * 
     * @param other - The other MortonKey to add.
     * @param optres - Optional MortonKey to store the result.
     * @returns - The modified MortonKey with the updated value.
     */
    public add(other: MortonKey, optres: MortonKey | null = null): MortonKey {
        return MortonKey.add(this, other, optres || this);
    }

    /**
     * Subtracts another MortonKey from the current instance.
     * 
     * @param other - The other MortonKey to subtract.
     * @param optres - Optional MortonKey to store the result.
     * @returns - The modified MortonKey with the updated value.
     */
    public sub(other: MortonKey, optres: MortonKey | null = null): MortonKey {
        return MortonKey.sub(this, other, optres || this);
    }

    // Accessor and mutator methods for x, y, z coordinates
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

    // Increment and decrement methods for the current key's coordinates
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

    /**
     * Copies the current MortonKey into a new or existing MortonKey.
     * 
     * @param optres - Optional MortonKey to store the result.
     * @returns - A copy of the current MortonKey.
     */
    public copy(optres: MortonKey | null = null): MortonKey {
        optres = optres || new MortonKey();
        optres._key = this._key;
        return optres;
    }

    /**
     * Clones the current MortonKey into a new MortonKey instance.
     * 
     * @returns - A new MortonKey that is a clone of the current one.
     */
    public clone(): MortonKey {
        return new MortonKey(this._key);
    }

    /**
     * Compares the current MortonKey with another Key.
     * 
     * @param other - The Key to compare with.
     * @returns - True if the two keys are equal, false otherwise.
     */
    public cmp(other: Key): boolean {
        if (other instanceof MortonKey) {
            return this._key === other.key;
        }

        return this.x === other.x && this.y === other.y && this.z === other.z;
    }

    /**
     * Converts the MortonKey to a human-readable string representation.
     * 
     * @returns - A string representation of the key and its x, y, z values.
     */
    toString(): string {
        return `MortonKey - key:${this.key} x:${this.x} y:${this.y} z:${this.z}`;
    }
}
