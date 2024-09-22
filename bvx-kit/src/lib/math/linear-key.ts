import { BitOps } from "../util/bit-ops.js";
import { Key } from "./key.js";

/**
 * Implementation of a 32-bit compact key for encoding 3D coordinates (x, y, z).
 * 
 * Each axis (x, y, z) can encode values between 0 and 1023 (10 bits per axis),
 * wrapping around when values exceed this range. For example:
 *
 * 1024 becomes 0, 1025 becomes 1, and so on.
 * Negative values also wrap around, e.g., -1 becomes 1023, -2 becomes 1022.
 * 
 * This is a cache-inefficient but faster alternative to Morton keys, making it
 * useful for specific performance-sensitive applications.
 */
export class LinearKey implements Key {
    /**
     * A mask that allows each axis (x, y, z) to store up to 10 bits of data,
     * restricting values to the range 0-1023.
     */
    private static readonly KEY_MASK: number = BitOps.maskForBits(10);

    private _key = 0;

    constructor(key = 0) {
        this._key = key | 0;
    }

    /**
     * Creates a new LinearKey from 3D coordinates (x, y, z) and encodes them 
     * into a 32-bit integer key.
     * 
     * @param x - The x-coordinate (0-1023).
     * @param y - The y-coordinate (0-1023).
     * @param z - The z-coordinate (0-1023).
     * @param optres - Optional LinearKey object to store the result, reducing allocations.
     * @returns - The new or modified LinearKey.
     */
    public static from(x: number, y: number, z: number, optres: LinearKey | null = null): LinearKey {
        optres = optres ?? new LinearKey();
        optres._key = LinearKey._Encode(x, y, z);

        return optres;
    }

    /**
     * Encodes 3D coordinates (x, y, z) into a compact 32-bit integer.
     * This method applies a mask to restrict each axis to 10 bits.
     * 
     * @param x - The x-coordinate (0-1023).
     * @param y - The y-coordinate (0-1023).
     * @param z - The z-coordinate (0-1023).
     * @returns - The encoded 32-bit integer.
     */
    private static _Encode(x: number, y: number, z: number): number {
        const mask: number = LinearKey.KEY_MASK;
        const cx: number = (x | 0) & mask;
        const cy: number = (y | 0) & mask;
        const cz: number = (z | 0) & mask;

        return cx << 20 | cy << 10 | cz;
    }

    /**
     * Adds the coordinates of two LinearKeys and returns a new key with the result.
     * 
     * @param a - The first LinearKey.
     * @param b - The second LinearKey.
     * @param optres - Optional LinearKey to store the result.
     * @returns - A new or modified LinearKey with the added values.
     */
    public static add(a: LinearKey, b: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();
        const sumX: number = a.x + b.x;
        const sumY: number = a.y + b.y;
        const sumZ: number = a.z + b.z;
        optres._key = LinearKey._Encode(sumX, sumY, sumZ);

        return optres;
    }

    /**
     * Subtracts the coordinates of two LinearKeys and returns a new key with the result.
     * 
     * @param a - The first LinearKey.
     * @param b - The second LinearKey.
     * @param optres - Optional LinearKey to store the result.
     * @returns - A new or modified LinearKey with the subtracted values.
     */
    public static sub(a: LinearKey, b: LinearKey, optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();
        const subX: number = a.x - b.x;
        const subY: number = a.y - b.y;
        const subZ: number = a.z - b.z;
        optres._key = LinearKey._Encode(subX, subY, subZ);

        return optres;
    }

    // Increment and decrement operations for individual axes
    public static incX(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.from(a.x + 1, a.y, a.z, optres ?? new LinearKey());
    }

    public static decX(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.from(a.x - 1, a.y, a.z, optres ?? new LinearKey());
    }

    public static incY(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.from(a.x, a.y + 1, a.z, optres ?? new LinearKey());
    }

    public static decY(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.from(a.x, a.y - 1, a.z, optres ?? new LinearKey());
    }

    public static incZ(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.from(a.x, a.y, a.z + 1, optres ?? new LinearKey());
    }

    public static decZ(a: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.from(a.x, a.y, a.z - 1, optres ?? new LinearKey());
    }

    /**
     * Adds another LinearKey to this instance, modifying the current key.
     * 
     * @param other - The other LinearKey to add.
     * @param optres - Optional LinearKey to store the result.
     * @returns - The modified LinearKey with the new values.
     */
    public add(other: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.add(this, other, optres ?? this);
    }

    /**
     * Subtracts another LinearKey from this instance, modifying the current key.
     * 
     * @param other - The other LinearKey to subtract.
     * @param optres - Optional LinearKey to store the result.
     * @returns - The modified LinearKey with the new values.
     */
    public sub(other: LinearKey, optres: LinearKey | null = null): LinearKey {
        return LinearKey.sub(this, other, optres ?? this);
    }

    // Accessor and mutator methods for x, y, z coordinates

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

    // Increment and decrement methods for the current key's coordinates
    public incX(optres: LinearKey | null = null): LinearKey {
        return LinearKey.incX(this, optres ?? this);
    }

    public incY(optres: LinearKey | null = null): LinearKey {
        return LinearKey.incY(this, optres ?? this);
    }

    public incZ(optres: LinearKey | null = null): LinearKey {
        return LinearKey.incZ(this, optres ?? this);
    }

    public decX(optres: LinearKey | null = null): LinearKey {
        return LinearKey.decX(this, optres ?? this);
    }

    public decY(optres: LinearKey | null = null): LinearKey {
        return LinearKey.decY(this, optres ?? this);
    }

    public decZ(optres: LinearKey | null = null): LinearKey {
        return LinearKey.decZ(this, optres ?? this);
    }

    /**
     * Copies the current LinearKey into a new or existing LinearKey.
     * 
     * @param optres - Optional LinearKey to store the result.
     * @returns - A copy of the current LinearKey.
     */
    public copy(optres: LinearKey | null = null): LinearKey {
        optres = optres || new LinearKey();
        optres._key = this._key;

        return optres;
    }

    /**
     * Clones the current LinearKey into a new LinearKey instance.
     * 
     * @returns - A new LinearKey that is a clone of the current one.
     */
    public clone(): LinearKey {
        return new LinearKey(this._key);
    }

    /**
     * Compares the current key with another Key.
     * 
     * @param other - The Key to compare with.
     * @returns - True if the two keys are equal, false otherwise.
     */
    public cmp(other: Key): boolean {
        if (other instanceof LinearKey) {
            return this._key === other.key;
        }

        return this.x === other.x && this.y === other.y && this.z === other.z;
    }

    /**
     * Converts the LinearKey to a human-readable string representation.
     * 
     * @returns - A string representation of the key and its x, y, z values.
     */
    toString(): string {
        return `LinearKey { key: ${this.key}, x: ${this.x}, y: ${this.y}, z: ${this.z} }`;
    }
}
