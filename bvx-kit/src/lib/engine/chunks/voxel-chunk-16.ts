import { MortonKey } from "../../math/morton-key.js";
import { VoxelIndex } from "../voxel-index.js";
import { VoxelChunk } from "./voxel-chunk.js";

/**
 * VoxelChunk16 extends the base VoxelChunk by allowing each voxel to store 
 * 16 bits (2 bytes) of meta-data. This allows for compact storage of additional 
 * voxel-related information such as voxel properties or custom flags.
 */
export class VoxelChunk16 extends VoxelChunk {

    /**
     * An ArrayBuffer to store the 16-bit meta-data for all voxels in the chunk.
     * Each VoxelChunk contains 64 voxels, and each voxel stores 16 bits (2 bytes) of meta-data.
     */
    private readonly _metaDataBuffer: ArrayBuffer;

    /**
     * A Uint16Array view of the ArrayBuffer that holds the meta-data for each voxel.
     * Each voxel's meta-data is represented by 16 bits (1 Uint16 value).
     */
    private readonly _metaData: Uint16Array;

    /**
     * Constructs a VoxelChunk16 with a 16-bit meta-data buffer for each voxel.
     * 
     * @param key - The MortonKey representing the chunk's location in the voxel map.
     */
    constructor(key: MortonKey) {
        super(key);

        // Allocate enough space for 16 bits (2 bytes) of meta-data per voxel in the chunk (64 voxels).
        this._metaDataBuffer = new ArrayBuffer((VoxelChunk.SIZE * 16) / 8);
        this._metaData = new Uint16Array(this._metaDataBuffer);
    }

    /**
     * Sets the 16-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @param meta - The 16-bit meta-data value to set for the voxel.
     */
    public override setMetaData(key: VoxelIndex, meta: number): void {
        this._metaData[key.vKey] = meta;
    }

    /**
     * Retrieves the 16-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @returns - The 16-bit meta-data value associated with the voxel.
     */
    public override getMetaData(key: VoxelIndex): number {
        return this._metaData[key.vKey];
    }
}