import { BitArray } from "../containers/bit-array";
import { Key } from "../math/key";
import { Voxel } from "./voxel";

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
    public static readonly SIZE = 4;

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
    private readonly _key: Key;

    constructor(key: Key) {
        const size: number = VoxelChunk.SIZE;
        const size3: number = size * size * size;

        // allocate bitvoxels as a bit-array
        this._bitVoxels = new BitArray((size3 * 64) / 32);

        // allocate buffers - bits to bytes
        this._metaDataBuffer = new ArrayBuffer((size3 * 16) / 8);
        this._metaData = new Uint16Array(this._metaDataBuffer);

        this._key = key;
    }

    public get key(): Key {
        return this._key;
    }

    /**
     * Returns a Voxel reference for the provided coordinates. Optionally accepts a Voxel as an argument
     * that will be used to fill the required information. Will throw an Error if requested voxel 
     * coordinates are out of bounds.
     * @param x - The local x coordinate of the voxel in this VoxelChunk
     * @param y - The local y coordinate of the voxel in this VoxelChunk
     * @param z - The local z coordinate of the voxel in this VoxelChunk
     * @param optres - Optional structure to use for the result
     * @returns - Voxel reference that can be used to modify the voxel
     */
    public getVoxel(x: number, y: number, z: number, optres: Voxel | null = null): Voxel {
        const result: Voxel = optres || new Voxel(0, this._metaData, this._bitVoxels);

        return result;
    }
}