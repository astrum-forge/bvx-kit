import { MortonKey } from "../../math/morton-key.js";
import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelIndex } from "../voxel-index.js";

/**
 * A VoxelChunk represents a group of 64 voxels (4x4x4) and manages their states in a 3D voxel map. 
 * Each voxel in a chunk contains 64 BitVoxels, which can be toggled on or off (1 or 0).
 * 
 * VoxelChunk is designed to be lightweight and easy to transmit or store, making it suitable 
 * for server-side or local storage use. It supports efficient manipulation of BitVoxels and 
 * provides fast access to voxel states and geometry configurations.
 */
export class VoxelChunk {
    /**
     * The dimension of the VoxelChunk: 4 voxels along each axis (4x4x4).
     */
    public static readonly DIMS: number = 4;

    /**
     * The total number of voxels in the chunk (4x4x4 = 64 voxels).
     */
    public static readonly SIZE: number = VoxelChunk.DIMS * VoxelChunk.DIMS * VoxelChunk.DIMS;

    /**
     * Each voxel contains 64 BitVoxels (4x4x4), and the BitVoxel states are stored in a BVXLayer.
     */
    private readonly _layer: BVXLayer;

    /**
     * The MortonKey representing the location of this VoxelChunk in the voxel map.
     * This key is used to identify the chunk and its neighbors for querying and updates.
     */
    private readonly _key: MortonKey;

    /**
     * Constructs a new VoxelChunk for the given location in the voxel map.
     * 
     * @param key - The MortonKey representing the location of this chunk.
     */
    constructor(key: MortonKey) {
        this._layer = new BVXLayer();
        this._key = key;
    }

    /**
     * Returns the MortonKey that identifies this VoxelChunk's location in the voxel map.
     */
    public get key(): MortonKey {
        return this._key;
    }

    /**
     * Returns the number of set (ON) BitVoxels in this VoxelChunk.
     * Uses a fast BitOps.popCount() to calculate the total.
     * 
     * This property is equivalent to accessing `VoxelChunk.layer.length`.
     */
    public get length(): number {
        return this.layer.length;
    }

    /**
     * Returns the BVXLayer that stores the BitVoxel states for this chunk.
     */
    public get layer(): BVXLayer {
        return this._layer;
    }

    /**
     * Sets meta-data for a specific VoxelIndex in the chunk. This allows you to store
     * additional information about a voxel (e.g., properties, flags).
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @param meta - The meta-data to associate with the voxel.
     */
    public setMetaData(key: VoxelIndex, meta: number): void { }

    /**
     * Retrieves the meta-data for a specific VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @returns - The meta-data associated with the voxel.
     */
    public getMetaData(key: VoxelIndex): number {
        return 0;
    }

    /**
     * Sets the BitVoxel at the specified VoxelIndex to the ON (1) state.
     * This is equivalent to calling `VoxelChunk.layer.set`.
     * 
     * @param key - The VoxelIndex identifying the BitVoxel to set.
     */
    public setBitVoxel(key: VoxelIndex): void {
        this.layer.set(key);
    }

    /**
     * Fills all BitVoxels in the specified voxel with the ON (1) state.
     * This is more efficient than setting each BitVoxel individually.
     * Equivalent to `VoxelChunk.layer.fill`.
     * 
     * @param key - The VoxelIndex identifying the voxel to fill.
     */
    public fillVoxel(key: VoxelIndex): void {
        this.layer.fill(key);
    }

    /**
     * Empties all BitVoxels in the specified voxel by setting them to the OFF (0) state.
     * This is more efficient than unsetting each BitVoxel individually.
     * Equivalent to `VoxelChunk.layer.empty`.
     * 
     * @param key - The VoxelIndex identifying the voxel to empty.
     */
    public emptyVoxel(key: VoxelIndex): void {
        this.layer.empty(key);
    }

    /**
     * Unsets the BitVoxel at the specified VoxelIndex to the OFF (0) state.
     * This is equivalent to calling `VoxelChunk.layer.unset`.
     * 
     * @param key - The VoxelIndex identifying the BitVoxel to unset.
     */
    public unsetBitVoxel(key: VoxelIndex): void {
        this.layer.unset(key);
    }

    /**
     * Toggles the state of the BitVoxel at the specified VoxelIndex (ON becomes OFF, and vice versa).
     * This is equivalent to calling `VoxelChunk.layer.toggle`.
     * 
     * @param key - The VoxelIndex identifying the BitVoxel to toggle.
     */
    public toggleBitVoxel(key: VoxelIndex): void {
        this.layer.toggle(key);
    }

    /**
     * Returns the current state of the BitVoxel at the specified VoxelIndex (1 if ON, 0 if OFF).
     * This is equivalent to calling `VoxelChunk.layer.get`.
     * 
     * @param key - The VoxelIndex identifying the BitVoxel to query.
     * @returns - 1 if the BitVoxel is ON, 0 if it is OFF.
     */
    public getBitVoxel(key: VoxelIndex): number {
        return this.layer.get(key);
    }

    /**
     * Counts the number of set (ON) BitVoxels in the voxel identified by the specified VoxelIndex.
     * This is equivalent to calling `VoxelChunk.layer.count`.
     * 
     * @param key - The VoxelIndex identifying the voxel to query.
     * @returns - The number of set BitVoxels in the voxel (between 0 and 64).
     */
    public getBitVoxelCount(key: VoxelIndex): number {
        return this.layer.count(key);
    }

    /**
     * Compares this VoxelChunk with another VoxelChunk to determine if they are the same,
     * based on their MortonKeys.
     * 
     * @param other - The other VoxelChunk to compare with.
     * @returns - True if the chunks have the same key, false otherwise.
     */
    public cmp(other: VoxelChunk | null): boolean {
        return other !== null ? this._key.cmp(other._key) : false;
    }
}
