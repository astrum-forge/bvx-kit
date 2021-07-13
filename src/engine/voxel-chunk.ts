import { BitArray } from "../containers/bit-array";
import { MortonKey } from "../math/morton-key";
import { BitOps } from "../util/bit-ops";
import { VoxelIndex } from "./voxel-index";

/**
 * A single VoxelChunk manages a group of voxels and their states for a specific
 * location in a 3D Voxel map. The internals are designed to be easy to transmit and
 * store in a virtual server or on local disk.
 * 
 * VoxelChunk stores 64 Voxels where each voxel contains 80 bits of data
 *  - 64 bits are the BitVoxel states that dictates how geometry is drawn
 *  - 16 bits are user-defined meta-data that can be stored on a per-voxel basis
 * 
 * Each VoxelChunk stores 64 voxels and 4096 bit-voxels. Geometry is generated according
 * to the makeup of the bit-voxels which provides 2^64 different geometry configurations on
 * a per Voxel basis
 */
export class VoxelChunk {
    /**
     * Represents the size of a VoxelChunk as if it were a cube. The size is as follows
     * voxelsCount = SIZE^3
     * bitVoxelsCount = (SIZE^3) x 64
     */
    public static readonly SIZE: number = 4;
    public static readonly BVX_SUBDIV: number = 4;

    /**
     * Each Voxel has 4x4x4 BitVoxels hence we need to allocate 64 bits per voxel
     * that stores the BitVoxel states
     * 
     * Total Bit Size would be SIZE^3 x 64
     */
    private readonly _bitVoxels: BitArray;

    /**
     * Each Voxel allows for 1x16 bit meta-data. Meta-Data is user-specific data
     * stored on a per-voxel basis. This can be game data or whatever
     * 
     * Total Meta-Data Bit Size would be SIZE^3 x 16
     */
    private readonly _metaData: Uint16Array;
    private readonly _metaDataBuffer: ArrayBuffer;

    /**
     * The Key that used to know where in local-coordinates the current VoxelChunk
     * resides in. The Key is used to find the Neighbouring chunks for queries.
     */
    private readonly _key: MortonKey;

    constructor(key: MortonKey) {
        const size: number = VoxelChunk.SIZE;
        const bvxSize: number = VoxelChunk.BVX_SUBDIV;

        const size3: number = size * size * size;
        const bvxSize3: number = bvxSize * bvxSize * bvxSize;

        // allocate bitvoxels as a bit-array
        this._bitVoxels = new BitArray((size3 * bvxSize3) / 32);

        // allocate buffers - bits to bytes
        this._metaDataBuffer = new ArrayBuffer((size3 * 16) / 8);
        this._metaData = new Uint16Array(this._metaDataBuffer);

        this._key = key;
    }

    /**
     * Returns the Index Key for this VoxelChunk
     */
    public get key(): MortonKey {
        return this._key;
    }

    /**
     * Sets the meta-data for the provided Voxel Index
     * @param key - The Voxel Index to set the meta-data
     * @param meta - The 16 bit meta-data to set
     */
    public setMetaData(key: VoxelIndex, meta: number): void {
        this._metaData[key.vKey] = meta;
    }

    /**
     * Returns the encoded meta-data for the provided Voxel Index
     * @param key - The Voxel Index
     * @returns - The 16 bit encoded meta-data
     */
    public getMetaData(key: VoxelIndex): number {
        return this._metaData[key.vKey];
    }

    /**
     * Sets the BitVoxel to the 1/ON state at provided position
     * @param key - The Voxel Index
     */
    public setBitVoxel(key: VoxelIndex): void {
        this._bitVoxels.setBitAt(key.key);
    }

    /**
     * Fills the provided Voxel with enabled BitVoxels. This is much faster
     * than individually filling a Voxel using a looped coordinate.
     * @param key - The Voxel Index
     */
    public fillVoxel(key: VoxelIndex): void {
        const vxIndex: number = key.vKey * 2;
        const allFullBits: number = 0xFFFFFFFF;

        const elements: Uint32Array = this._bitVoxels.elements;
        elements[vxIndex] = allFullBits;
        elements[vxIndex + 1] = allFullBits;
    }

    /**
     * Empties the provided Voxel with disabled BitVoxels. This is
     * much faster than individually emptying a Voxel using a looped coordinate.
     * @param key - The Voxel Index
     */
    public emptyVoxel(key: VoxelIndex): void {
        const vxIndex: number = key.vKey * 2;
        const allEmptyBits: number = 0x00000000;

        const elements: Uint32Array = this._bitVoxels.elements;
        elements[vxIndex] = allEmptyBits;
        elements[vxIndex + 1] = allEmptyBits;
    }

    /**
     * Unsets the BitVoxel to the 0/OFF state at provided position
     * @param key - The Voxel Index
     */
    public unsetBitVoxel(key: VoxelIndex): void {
        this._bitVoxels.unsetBitAt(key.key);
    }

    /**
     * Toggle the BitVoxel to the ON/OFF States based on previous state
     * @param key - The Voxel Index
     */
    public toggleBitVoxel(key: VoxelIndex): void {
        this._bitVoxels.toggleBitAt(key.key);
    }

    /**
     * Returns the current state of the requested BitVoxel
     * @param key - The Voxel Index
     * @returns - 1 if ON or 0 if OFF
     */
    public getBitVoxel(key: VoxelIndex): number {
        return this._bitVoxels.bitAt(key.key);
    }

    /**
     * Counts the number of SET BitVoxels for a particular Voxel
     * @param key - The Voxel key to use in local coordinates
     * @returns number of SET BitVoxels between [0-64] inclusive
     */
    public getBitVoxelCount(key: VoxelIndex): number {
        const vxIndex: number = key.vKey * 2;
        const elements: Uint32Array = this._bitVoxels.elements;

        return BitOps.popCount(elements[vxIndex]) + BitOps.popCount(elements[vxIndex + 1]);
    }

    /**
     * Counts the number of set BitVoxels contained in this VoxelChunk reference.
     * This uses BitOps.popCount() operation which should compute the results very fast.
     */
    public get length(): number {
        return this._bitVoxels.popCount();
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