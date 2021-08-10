import { MortonKey } from "../../math/morton-key";
import { BVXLayer } from "../layer/bvx-layer";
import { VoxelIndex } from "../voxel-index";

/**
 * A single VoxelChunk manages a group of voxels and their states for a specific
 * location in a 3D Voxel map. The internals are designed to be easy to transmit and
 * store in a virtual server or on local disk.
 *
 * VoxelChunk stores 64 Voxels where each voxel contains 64 bits of data
 *
 * Each VoxelChunk stores 64 voxels and 4096 bit-voxels. Geometry is generated according
 * to the makeup of the bit-voxels which provides 2^64 different geometry configurations on
 * a per Voxel basis
 */
export class VoxelChunk {
    public static readonly DIMS: number = 4;
    public static readonly SIZE: number = VoxelChunk.DIMS * VoxelChunk.DIMS * VoxelChunk.DIMS;

    /**
     * Each Voxel has 4x4x4 BitVoxels hence we need to allocate 64 bits per voxel
     * that stores the BitVoxel states
     */
    private readonly _layer: BVXLayer;

    /**
     * The Key that used to know where in local-coordinates the current VoxelChunk
     * resides in. The Key is used to find the Neighbouring chunks for queries.
     */
    private readonly _key: MortonKey;

    constructor(key: MortonKey) {
        this._layer = new BVXLayer();
        this._key = key;
    }

    /**
     * Returns the Index Key for this VoxelChunk
     */
    public get key(): MortonKey {
        return this._key;
    }

    /**
     * Counts the number of set BitVoxels contained in this VoxelChunk reference.
     * This uses BitOps.popCount() operation which should compute the results very fast.
     * 
     * This is the same property as VoxelChunk.layer.length
     */
    public get length(): number {
        return this.layer.length;
    }

    /**
     * Returns the backing BitVoxel layer for this Chunk
     */
    public get layer(): BVXLayer {
        return this._layer;
    }

    /**
     * Sets the meta-data for the provided Voxel Index
     * @param key - The Voxel Index to set the meta-data
     * @param meta - The meta-data to set
     */
    public setMetaData(key: VoxelIndex, meta: number): void { };

    /**
     * Returns the encoded meta-data for the provided Voxel Index
     * @param key - The Voxel Index
     * @returns - The encoded meta-data
     */
    public getMetaData(key: VoxelIndex): number { return 0; };

    /**
     * Sets the BitVoxel to the 1/ON state at provided position.
     * This is the same property as VoxelChunk.layer.set
     * @param key - The Voxel Index
     */
    public setBitVoxel(key: VoxelIndex): void {
        this.layer.set(key);
    }

    /**
     * Fills the provided Voxel with enabled BitVoxels. This is much faster
     * than individually filling a Voxel using a looped coordinate.
     * This is the same property as VoxelChunk.layer.fill
     * @param key - The Voxel Index
     */
    public fillVoxel(key: VoxelIndex): void {
        this.layer.fill(key);
    }

    /**
     * Empties the provided Voxel with disabled BitVoxels. This is
     * much faster than individually emptying a Voxel using a looped coordinate.
     * This is the same property as VoxelChunk.layer.empty
     * @param key - The Voxel Index
     */
    public emptyVoxel(key: VoxelIndex): void {
        this.layer.empty(key);
    }

    /**
     * Unsets the BitVoxel to the 0/OFF state at provided position.
     * This is the same property as VoxelChunk.layer.unset
     * @param key - The Voxel Index
     */
    public unsetBitVoxel(key: VoxelIndex): void {
        this.layer.unset(key);
    }

    /**
     * Toggle the BitVoxel to the ON/OFF States based on previous state.
     * This is the same property as VoxelChunk.layer.toggle
     * @param key - The Voxel Index
     */
    public toggleBitVoxel(key: VoxelIndex): void {
        this.layer.toggle(key);
    }

    /**
     * Returns the current state of the requested BitVoxel.
     * This is the same property as VoxelChunk.layer.get
     * @param key - The Voxel Index
     * @returns - 1 if ON or 0 if OFF
     */
    public getBitVoxel(key: VoxelIndex): number {
        return this.layer.get(key);
    }

    /**
     * Counts the number of SET BitVoxels for a particular Voxel.
     * This is the same property as VoxelChunk.layer.count
     * @param key - The Voxel key to use in local coordinates
     * @returns number of SET BitVoxels between [0-64] inclusive
     */
    public getBitVoxelCount(key: VoxelIndex): number {
        return this.layer.count(key);
    }

    /**
     * Check to see if VoxelChunk instances match by comparing the keys
     * @param other - the VoxelChunk to compare with
     * @returns - True if match, false otherwise
     */
    public cmp(other: VoxelChunk | null): boolean {
        return other !== null ? this._key.cmp(other._key) : false;
    }
}