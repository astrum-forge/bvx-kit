import { MortonKey } from "../../math/morton-key.js";
import { VoxelIndex } from "../voxel-index.js";
import { VoxelChunk } from "./voxel-chunk.js";

/**
 * VoxelChunk8 extends the base VoxelChunk by allowing each voxel to store 
 * 8 bits (1 byte) of meta-data. This is useful for applications where limited
 * meta-data per voxel is sufficient, such as flags or small property sets.
 */
export class VoxelChunk8 extends VoxelChunk {

    /**
     * An ArrayBuffer to store the 8-bit meta-data for all voxels in the chunk.
     * Each VoxelChunk contains 64 voxels, and each voxel stores 8 bits (1 byte) of meta-data.
     */
    private readonly _metaDataBuffer: ArrayBuffer;

    /**
     * A Uint8Array view of the ArrayBuffer that holds the meta-data for each voxel.
     * Each voxel's meta-data is represented by 8 bits (1 byte).
     */
    private readonly _metaData: Uint8Array;

    /**
     * Constructs a VoxelChunk8 with an 8-bit meta-data buffer for each voxel.
     * 
     * @param key - The MortonKey representing the chunk's location in the voxel map.
     */
    constructor(key: MortonKey) {
        super(key);

        // Allocate enough space for 8 bits (1 byte) of meta-data per voxel in the chunk (64 voxels).
        this._metaDataBuffer = new ArrayBuffer(VoxelChunk.SIZE);
        this._metaData = new Uint8Array(this._metaDataBuffer);
    }

    /**
     * Sets the 8-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @param meta - The 8-bit meta-data value to set for the voxel.
     */
    public override setMetaData(key: VoxelIndex, meta: number): void {
        this._metaData[key.vKey] = meta;
    }

    /**
     * Retrieves the 8-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @returns - The 8-bit meta-data value associated with the voxel.
     */
    public override getMetaData(key: VoxelIndex): number {
        return this._metaData[key.vKey];
    }
}
