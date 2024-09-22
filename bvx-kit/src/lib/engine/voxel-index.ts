import { BitOps } from "../util/bit-ops.js";
import { Key } from "../math/key.js";

/**
 * VoxelIndex is a 12-bit key that encodes both Voxel and BitVoxel coordinates
 * within a single VoxelChunk. This compact representation allows efficient
 * access to specific voxels and bit voxels inside a chunk.
 * 
 * Each VoxelIndex consists of 6 components (x, y, z for Voxel and u, v, w for BitVoxel),
 * where each component can store 2 bits, resulting in a 12-bit key.
 * This allows addressing up to 4 values (0-3) for each component.
 */
export class VoxelIndex implements Key {
    /**
     * Each component (x, y, z, u, v, w) can store 2 bits of data, limiting the values to 0-3.
     * These masks are used to extract or encode data for each component.
     */
    private static readonly KEY_MASK: number = BitOps.maskForBits(2);
    private static readonly VX_MASK: number = BitOps.maskForBits(6);  // For Voxel keys (x, y, z)
    private static readonly VALUE_MASK: number = BitOps.maskForBits(12); // For full 12-bit key

    private _key = 0;

    constructor(key = 0) {
        this._key = key | 0;
    }

    /**
     * Encodes the 6-component Voxel and BitVoxel coordinates into a single 12-bit key.
     * 
     * @param x - The x-coordinate of the Voxel (0-3).
     * @param y - The y-coordinate of the Voxel (0-3).
     * @param z - The z-coordinate of the Voxel (0-3).
     * @param u - The x-coordinate of the BitVoxel (0-3), default is 0.
     * @param v - The y-coordinate of the BitVoxel (0-3), default is 0.
     * @param w - The z-coordinate of the BitVoxel (0-3), default is 0.
     * @param optres - Optional VoxelIndex to reuse for encoding, minimizing allocations.
     * @returns - A new or modified VoxelIndex containing the encoded values.
     */
    public static from(x: number, y: number, z: number, u = 0, v = 0, w: number = 0, optres: VoxelIndex | null = null): VoxelIndex {
        optres = optres ?? new VoxelIndex();

        optres._key = VoxelIndex._Encode(x, y, z, u, v, w);

        return optres;
    }

    /**
     * Encodes the 6-component (x, y, z, u, v, w) coordinates into a single 12-bit integer.
     * 
     * @param x - The x-coordinate of the Voxel (0-3).
     * @param y - The y-coordinate of the Voxel (0-3).
     * @param z - The z-coordinate of the Voxel (0-3).
     * @param u - The x-coordinate of the BitVoxel (0-3).
     * @param v - The y-coordinate of the BitVoxel (0-3).
     * @param w - The z-coordinate of the BitVoxel (0-3).
     * @returns - The encoded 12-bit integer representing the voxel and bit voxel positions.
     */
    private static _Encode(x: number, y: number, z: number, u: number, v: number, w: number): number {
        const mask: number = VoxelIndex.KEY_MASK;

        const vx: number = (x | 0) & mask;
        const vy: number = (y | 0) & mask;
        const vz: number = (z | 0) & mask;

        const bx: number = (u | 0) & mask;
        const by: number = (v | 0) & mask;
        const bz: number = (w | 0) & mask;

        // Combine the voxel and bit voxel components into a 12-bit key
        return vx << 10 | vy << 8 | vz << 6 | bx << 4 | by << 2 | bz;
    }

    // Accessors and mutators for voxel and bit voxel coordinates

    public get vx(): number {
        return (this._key >> 10) & VoxelIndex.KEY_MASK;
    }

    public set vx(value: number) {
        VoxelIndex.from(value, this.vy, this.vz, this.bx, this.by, this.bz, this);
    }

    public get vy(): number {
        return (this._key >> 8) & VoxelIndex.KEY_MASK;
    }

    public set vy(value: number) {
        VoxelIndex.from(this.vx, value, this.vz, this.bx, this.by, this.bz, this);
    }

    public get vz(): number {
        return (this._key >> 6) & VoxelIndex.KEY_MASK;
    }

    public set vz(value: number) {
        VoxelIndex.from(this.vx, this.vy, value, this.bx, this.by, this.bz, this);
    }

    public get bx(): number {
        return (this._key >> 4) & VoxelIndex.KEY_MASK;
    }

    public set bx(value: number) {
        VoxelIndex.from(this.vx, this.vy, this.vz, value, this.by, this.bz, this);
    }

    public get by(): number {
        return (this._key >> 2) & VoxelIndex.KEY_MASK;
    }

    public set by(value: number) {
        VoxelIndex.from(this.vx, this.vy, this.vz, this.bx, value, this.bz, this);
    }

    public get bz(): number {
        return this._key & VoxelIndex.KEY_MASK;
    }

    public set bz(value: number) {
        VoxelIndex.from(this.vx, this.vy, this.vz, this.bx, this.by, value, this);
    }

    // Additional accessors for Voxel (x, y, z) and key values

    public get x(): number {
        return this.vx;
    }

    public set x(value: number) {
        this.vx = value;
    }

    public get y(): number {
        return this.vy;
    }

    public set y(value: number) {
        this.vy = value;
    }

    public get z(): number {
        return this.vz;
    }

    public set z(value: number) {
        this.vz = value;
    }

    public get key(): number {
        return this._key;
    }

    public set key(value: number) {
        this._key = value & VoxelIndex.VALUE_MASK;
    }

    /**
     * Returns the Voxel key (x, y, z) portion of the 12-bit index.
     * 
     * @returns - The 6-bit Voxel key.
     */
    public get vKey(): number {
        return (this._key >> 6) & VoxelIndex.VX_MASK;
    }

    /**
     * Returns the BitVoxel key (u, v, w) portion of the 12-bit index.
     * 
     * @returns - The 6-bit BitVoxel key.
     */
    public get bKey(): number {
        return this._key & VoxelIndex.VX_MASK;
    }

    /**
     * Compares the current VoxelIndex with another Key.
     * 
     * @param other - The other key to compare with.
     * @returns - True if both keys are identical, false otherwise.
     */
    cmp(other: Key): boolean {
        if (other instanceof VoxelIndex) {
            return this._key === other.key;
        }

        return this.x === other.x && this.y === other.y && this.z === other.z;
    }

    /**
     * Copies the current VoxelIndex into a new or existing VoxelIndex instance.
     * 
     * @param optres - Optional VoxelIndex to reuse, minimizing allocations.
     * @returns - A new or modified VoxelIndex containing the copied values.
     */
    public copy(optres: VoxelIndex | null = null): VoxelIndex {
        optres = optres ?? new VoxelIndex();        optres._key = this._key;
        return optres;
    }

    /**
     * Creates a clone of the current VoxelIndex.
     * 
     * @returns - A new VoxelIndex that is a clone of the current instance.
     */
    clone(): VoxelIndex {
        return new VoxelIndex(this._key);
    }

    /* istanbul ignore next */
    /**
     * Converts the VoxelIndex into a human-readable string representation,
     * useful for debugging purposes.
     * 
     * @returns - A string representing the voxel and bit voxel coordinates.
     */
    toString(): string {
        return "VoxelIndex - vkey:" + this.vKey + " vx:" + this.vx + " vy:" + this.vy + " vz:" + this.vz + " bx:" + this.bx + " by:" + this.by + " bz:" + this.bz;
    }
}
