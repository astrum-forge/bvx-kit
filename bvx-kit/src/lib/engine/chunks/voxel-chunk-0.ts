import { VoxelIndex } from "../voxel-index.js";
import { VoxelChunk } from "./voxel-chunk.js";

/**
 * This Voxel chunk stores 0 bits (no data) for all meta-data
 */
export class VoxelChunk0 extends VoxelChunk {

    /**
     * Sets the 8-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @param meta - The 0-bit meta-data value to set for the voxel (always sets 0)
     */
    public override setMetaData(_key: VoxelIndex, _meta: number): void { }

    /**
     * Retrieves the 0-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
     * 
     * @param key - The VoxelIndex identifying the voxel.
     * @returns - The 0-bit meta-data value associated with the voxel (always 0)
     */
    public override getMetaData(_key: VoxelIndex): number {
        return 0;
    }
}
