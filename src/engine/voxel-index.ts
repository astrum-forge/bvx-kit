import { BitOps } from "../util/bit-ops";
import { Key } from "../math/key";

/**
 * Implementation for 12 bit Voxel Index keys. This allows accessing Voxels and BitVoxels
 * in a single VoxelChunk from a single key.
 * 
 * VoxelIndex is a 6 component key where each key uses 2 bits of data for a total of 12 bits
 */
export class VoxelIndex implements Key {
    /**
     * Each component (x, y, z, u, v, w) can hold 2 bits of data for a total of 12 bits
     */
    private static readonly KEY_MASK: number = BitOps.maskForBits(2);
    private static readonly VX_MASK: number = BitOps.maskForBits(6);
    private static readonly VALUE_MASK: number = BitOps.maskForBits(12);

    private _key: number = 0;

    constructor(key: number = 0) {
        this._key = key | 0;
    }

    /**
     * Encodes a 6 component accessor into a single 12 bit key
     * @param x - x position of the Voxel (0-3)
     * @param y - y position of the Voxel (0-3)
     * @param z - z position of the Voxel (0-3)
     * @param u - x position of the BitVoxel (0-3)
     * @param v - y position of the BitVoxel (0-3)
     * @param w - z position of the BitVoxel (0-3)
     * @param optres - The optional VoxelIndex to encode values into
     * @returns - Newly constructed VoxelIndex
     */
    public static from(x: number, y: number, z: number, u: number, v: number, w: number, optres: VoxelIndex | null = null): VoxelIndex {
        optres = optres || new VoxelIndex();

        optres._key = VoxelIndex._Encode(x, y, z, u, v, w);

        return optres;
    }

    private static _Encode(x: number, y: number, z: number, u: number, v: number, w: number): number {
        const mask: number = VoxelIndex.KEY_MASK;

        const vx: number = (x | 0) & mask;
        const vy: number = (y | 0) & mask;
        const vz: number = (z | 0) & mask;

        const bx: number = (u | 0) & mask;
        const by: number = (v | 0) & mask;
        const bz: number = (w | 0) & mask;

        return vx << 10 | vy << 8 | vz << 6 | bx << 4 | by << 2 | bz;
    }

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

    public get vKey(): number {
        return (this._key >> 6) & VoxelIndex.VX_MASK;
    }

    public get bKey(): number {
        return this._key & VoxelIndex.VX_MASK;
    }

    cmp(other: Key): boolean {
        if (other instanceof VoxelIndex) {
            return this._key === other.key;
        }

        return this.x === other.x && this.y === other.y && this.z === other.z;
    }

    public copy(optres: VoxelIndex | null = null): VoxelIndex {
        optres = optres || new VoxelIndex();

        optres._key = this._key;

        return optres;
    }

    clone(): VoxelIndex {
        return new VoxelIndex(this._key);
    }
}