import { MortonKey } from "../../math/morton-key.js";
import { VoxelIndex } from "../voxel-index.js";
import { VoxelChunk } from "./voxel-chunk.js";

/**
 * VoxelChunk32 extends the base VoxelChunk functionality by allowing each voxel 
 * to store 32 bits of meta-data. This provides additional information per voxel,
 * such as custom attributes, voxel types, or other user-defined properties.
 */
export class VoxelChunk32 extends VoxelChunk {

    /**
     * An ArrayBuffer to store the 32-bit meta-data for all voxels in the chunk.
     * Each VoxelChunk contains 64 voxels, and each voxel stores 32 bits (4 bytes) of meta-data.
     */
    private readonly _metaDataBuffer: ArrayBuffer;

    /**
     * A Uint16Array view of the ArrayBuffer that holds the meta-data for each voxel.
     * Each voxel's meta-data is represented by 32 bits (2 Uint16 values).
     */
    private readonly _metaData: Uint16Array;

    /**
     * Constructs a VoxelChunk32 with a 32-bit meta-data buffer for each voxel.
     * 
     * @param key - The MortonKey representing the chunk's location in the voxel map.
     */
    constructor(key: MortonKey) {
        super(key);

        // Allocate enough space for 32 bits (4 bytes) of meta-data per voxel in the chunk (64 voxels).
        this._metaDataBuffer = new ArrayBuffer((VoxelChunk.SIZE * 32) / 8);
        this._metaData = new Uint16Array(this._metaDataBuffer);
    }

    /**
     * Sets the 32-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @param meta - The 32-bit meta-data value to set for the voxel.
     */
    public override setMetaData(key: VoxelIndex, meta: number): void {
        this._metaData[key.vKey] = meta;
    }

    /**
     * Retrieves the 32-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @returns - The 32-bit meta-data value associated with the voxel.
     */
    public override getMetaData(key: VoxelIndex): number {
        return this._metaData[key.vKey];
    }
}
