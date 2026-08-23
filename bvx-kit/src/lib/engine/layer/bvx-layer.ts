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
     * Number of 32-bit elements the occupancy storage occupies (4096 bits).
     */
    public static readonly ELEMENTS: number = BVXLayer.SIZE / 32;

    /**
     * Number of bytes the occupancy storage occupies.
     */
    public static readonly BYTE_LENGTH: number = BVXLayer.ELEMENTS * 4;

    /**
     * Primary storage for BitVoxels, implemented as a BitArray.
     * This array holds the on/off state of each BitVoxel.
     */
    private readonly _bitVoxels: BitArray;

    /**
     * Constructs a new BVXLayer.
     *
     * @param buffer - (Optional) Externally-owned storage to view. When null, storage
     * is allocated. See ChunkStorage.
     * @param byteOffset - (Optional) Byte offset into the provided buffer. Must be a
     * multiple of 4.
     */
    constructor(buffer: ArrayBufferLike | null = null, byteOffset = 0) {
        // Allocates or views storage for 4096 BitVoxels (stored in 128 32-bit integers).
        this._bitVoxels = new BitArray(BVXLayer.ELEMENTS, buffer, byteOffset);
    }

    /**
     * Returns the total number of set (enabled) BitVoxels in this layer.
     * Uses a fast population count (popCount) operation.
     */
    public get length(): number {
        return this._bitVoxels.popCount();
    }

    /**
     * Returns true when no BitVoxel in this layer is set.
     *
     * A uniform layer needs no geometry and no neighbour sampling, which is what makes
     * this worth asking - in a world with real depth most chunks are entirely solid
     * ground or entirely air. See BitArray.uniformState for the cost.
     */
    public get isEmpty(): boolean {
        return this._bitVoxels.uniformState === BitArray.EMPTY;
    }

    /**
     * Returns true when every BitVoxel in this layer is set.
     */
    public get isFull(): boolean {
        return this._bitVoxels.uniformState === BitArray.FULL;
    }

    /**
     * Returns whether this layer is entirely empty, entirely full, or a mix of the two.
     *
     * @returns - BitArray.EMPTY, BitArray.FULL or BitArray.MIXED.
     */
    public get uniformState(): number {
        return this._bitVoxels.uniformState;
    }

    /**
     * Returns the underlying BitArray that stores the BitVoxel states.
     * Useful for direct buffer access such as serialization, transfer
     * between threads or high-performance geometry generation.
     */
    public get bitArray(): BitArray {
        return this._bitVoxels;
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
     * NOTE: This operates on the BitArray storage directly as the 12-bit VoxelIndex
     * key is guaranteed to be within the bounds of the layer, skipping redundant
     * bounds checks in this hot path.
     *
     * @param key - The VoxelIndex representing the specific BitVoxel to set.
     */
    public set(key: VoxelIndex): void {
        const pos: number = key.key;
        const elements: Uint32Array = this._bitVoxels.elements;
        elements[pos >> 5] |= (1 << (pos & 31));
    }

    /**
     * Unsets (turns off) a specific BitVoxel to the OFF (0) state, based on the provided VoxelIndex.
     *
     * NOTE: This operates on the BitArray storage directly as the 12-bit VoxelIndex
     * key is guaranteed to be within the bounds of the layer, skipping redundant
     * bounds checks in this hot path.
     *
     * @param key - The VoxelIndex representing the specific BitVoxel to unset.
     */
    public unset(key: VoxelIndex): void {
        const pos: number = key.key;
        const elements: Uint32Array = this._bitVoxels.elements;
        elements[pos >> 5] &= ~(1 << (pos & 31));
    }

    /**
     * Toggles a specific BitVoxel between ON (1) and OFF (0) states, based on the previous state.
     *
     * NOTE: This operates on the BitArray storage directly as the 12-bit VoxelIndex
     * key is guaranteed to be within the bounds of the layer, skipping redundant
     * bounds checks in this hot path.
     *
     * @param key - The VoxelIndex representing the specific BitVoxel to toggle.
     */
    public toggle(key: VoxelIndex): void {
        const pos: number = key.key;
        const elements: Uint32Array = this._bitVoxels.elements;
        elements[pos >> 5] ^= (1 << (pos & 31));
    }

    /**
     * Returns the current state (ON or OFF) of the specified BitVoxel.
     *
     * NOTE: This operates on the BitArray storage directly as the 12-bit VoxelIndex
     * key is guaranteed to be within the bounds of the layer, skipping redundant
     * bounds checks in this hot path.
     *
     * @param key - The VoxelIndex representing the specific BitVoxel to query.
     * @returns - 1 if the BitVoxel is ON, 0 if it is OFF.
     */
    public get(key: VoxelIndex): number {
        const pos: number = key.key;
        const elements: Uint32Array = this._bitVoxels.elements;
        return (elements[pos >> 5] >>> (pos & 31)) & 1;
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
