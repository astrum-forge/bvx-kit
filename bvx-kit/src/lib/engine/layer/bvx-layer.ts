import { BitArray } from "../../containers/bit-array.js";
import { VoxelIndex } from "../voxel-index.js";
import { BitOps } from "../../util/bit-ops.js";

/**
 * BVXLayer manages a 16x16x16 chunk of BitVoxels, for a total of 4096 BitVoxels.
 * Each BitVoxel requires only 1 bit for storage, and the entire layer consumes 4096 bits 
 * (512 bytes) of memory. The BVXLayer provides methods to manipulate and query individual 
 * or groups of BitVoxels efficiently.
 */
export class BVXLayer {
    /**
     * Dimensions of the BVXLayer: 16 voxels per side (16x16x16).
     */
    public static readonly DIMS: number = 16;

    /**
     * Total number of BitVoxels in the layer (16x16x16 = 4096 BitVoxels).
     */
    public static readonly SIZE: number = BVXLayer.DIMS * BVXLayer.DIMS * BVXLayer.DIMS;

    /**
     * Primary storage for BitVoxels, implemented as a BitArray.
     * This array holds the on/off state of each BitVoxel.
     */
    private readonly _bitVoxels: BitArray;

    constructor() {
        // Allocates storage for 4096 BitVoxels (stored in 128 32-bit integers).
        this._bitVoxels = new BitArray(BVXLayer.SIZE / 32);
    }

    /**
     * Returns the total number of set (enabled) BitVoxels in this layer.
     * Uses a fast population count (popCount) operation.
     */
    public get length(): number {
        return this._bitVoxels.popCount();
    }

    /**
     * Fills all 64 BitVoxels in the Voxel identified by the given VoxelIndex.
     * This is a faster operation compared to setting each BitVoxel individually.
     * 
     * @param key - The VoxelIndex representing the Voxel to fill.
     */
    public fill(key: VoxelIndex): void {
        const vxIndex: number = key.vKey * 2; // Each Voxel occupies 2 32-bit integers.
        const allFullBits = 0xFFFFFFFF; // Set all 32 bits to 1 (filled).

        const elements: Uint32Array = this._bitVoxels.elements;
        elements[vxIndex] = allFullBits;
        elements[vxIndex + 1] = allFullBits;
    }

    /**
     * Empties all 64 BitVoxels in the Voxel identified by the given VoxelIndex.
     * This is more efficient than unsetting each BitVoxel individually.
     * 
     * @param key - The VoxelIndex representing the Voxel to empty.
     */
    public empty(key: VoxelIndex): void {
        const vxIndex: number = key.vKey * 2; // Each Voxel occupies 2 32-bit integers.
        const allEmptyBits = 0x00000000; // Set all 32 bits to 0 (empty).

        const elements: Uint32Array = this._bitVoxels.elements;
        elements[vxIndex] = allEmptyBits;
        elements[vxIndex + 1] = allEmptyBits;
    }

    /**
     * Sets a specific BitVoxel to the ON (1) state, based on the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex representing the specific BitVoxel to set.
     */
    public set(key: VoxelIndex): void {
        this._bitVoxels.setBitAt(key.key);
    }

    /**
     * Unsets (turns off) a specific BitVoxel to the OFF (0) state, based on the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex representing the specific BitVoxel to unset.
     */
    public unset(key: VoxelIndex): void {
        this._bitVoxels.unsetBitAt(key.key);
    }

    /**
     * Toggles a specific BitVoxel between ON (1) and OFF (0) states, based on the previous state.
     * 
     * @param key - The VoxelIndex representing the specific BitVoxel to toggle.
     */
    public toggle(key: VoxelIndex): void {
        this._bitVoxels.toggleBitAt(key.key);
    }

    /**
     * Returns the current state (ON or OFF) of the specified BitVoxel.
     * 
     * @param key - The VoxelIndex representing the specific BitVoxel to query.
     * @returns - 1 if the BitVoxel is ON, 0 if it is OFF.
     */
    public get(key: VoxelIndex): number {
        return this._bitVoxels.bitAt(key.key);
    }

    /**
     * Counts the number of set (enabled) BitVoxels within the specified Voxel.
     * A Voxel contains 64 BitVoxels (4x4x4).
     * 
     * @param key - The VoxelIndex representing the Voxel to query.
     * @returns - The number of set BitVoxels (between 0 and 64 inclusive).
     */
    public count(key: VoxelIndex): number {
        const vxIndex: number = key.vKey * 2; // Each Voxel occupies 2 32-bit integers.
        const elements: Uint32Array = this._bitVoxels.elements;

        // Count the number of set bits in both 32-bit integers for this Voxel.
        return BitOps.popCount(elements[vxIndex]) + BitOps.popCount(elements[vxIndex + 1]);
    }
}
