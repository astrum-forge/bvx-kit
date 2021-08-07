import { BitArray } from "../../containers/bit-array";
import { VoxelIndex } from "../voxel-index";
import { BitOps } from "../../util/bit-ops";

/**
 * A single BVX Layer manages a chunk of 16x16x16 BitVoxels for a total of 4096 BitVoxels.
 * 
 * Each BitVoxel requires 1 bit of data for storage. this layer requires 4096 bits or 512
 * bytes worth of storage
 */
export class BVXLayer {
    public static readonly DIMS: number = 16;
    public static readonly SIZE: number = BVXLayer.DIMS * BVXLayer.DIMS * BVXLayer.DIMS;

    /**
     * Primary storage for BitVoxels
     */
    private readonly _bitVoxels: BitArray;

    constructor() {
        // allocate bitvoxels as a bit-array
        this._bitVoxels = new BitArray(BVXLayer.SIZE / 32);
    }

    /**
     * Counts the number of set BitVoxels contained in this layer reference.
     * This uses BitOps.popCount() operation which should compute the results very fast.
     */
    public get length(): number {
        return this._bitVoxels.popCount();
    }

    /**
     * Fills the provided Voxel with enabled BitVoxels. This is much faster
     * than individually filling a Voxel using a looped coordinate.
     * 
     * This operation is performed on a group of 64 BitVoxels belonging to a Voxel
     * @param key - The Voxel Index
     */
    public fill(key: VoxelIndex): void {
        const vxIndex: number = key.vKey * 2;
        const allFullBits: number = 0xFFFFFFFF;

        const elements: Uint32Array = this._bitVoxels.elements;
        elements[vxIndex] = allFullBits;
        elements[vxIndex + 1] = allFullBits;
    }

    /**
     * Empties the provided Voxel with disabled BitVoxels. This is
     * much faster than individually emptying a Voxel using a looped coordinate.
     * 
     * This operation is performed on a group of 64 BitVoxels belonging to a Voxel
     * @param key - The Voxel Index
     */
    public empty(key: VoxelIndex): void {
        const vxIndex: number = key.vKey * 2;
        const allEmptyBits: number = 0x00000000;

        const elements: Uint32Array = this._bitVoxels.elements;
        elements[vxIndex] = allEmptyBits;
        elements[vxIndex + 1] = allEmptyBits;
    }

    /**
     * Sets the BitVoxel to the 1/ON state at provided position
     * @param key - The Voxel Index
     */
    public set(key: VoxelIndex): void {
        this._bitVoxels.setBitAt(key.key);
    }

    /**
     * Unsets the BitVoxel to the 0/OFF state at provided position
     * @param key - The Voxel Index
     */
    public unset(key: VoxelIndex): void {
        this._bitVoxels.unsetBitAt(key.key);
    }

    /**
     * Toggle the BitVoxel to the ON/OFF States based on previous state
     * @param key - The Voxel Index
     */
    public toggle(key: VoxelIndex): void {
        this._bitVoxels.toggleBitAt(key.key);
    }

    /**
     * Returns the current state of the requested BitVoxel
     * @param key - The Voxel Index
     * @returns - 1 if ON or 0 if OFF
     */
    public get(key: VoxelIndex): number {
        return this._bitVoxels.bitAt(key.key);
    }

    /**
     * Counts the number of SET BitVoxels for a particular Voxel
     * @param key - The Voxel key to use in local coordinates
     * @returns number of SET BitVoxels between [0-64] inclusive
     */
    public count(key: VoxelIndex): number {
        const vxIndex: number = key.vKey * 2;
        const elements: Uint32Array = this._bitVoxels.elements;

        return BitOps.popCount(elements[vxIndex]) + BitOps.popCount(elements[vxIndex + 1]);
    }
}