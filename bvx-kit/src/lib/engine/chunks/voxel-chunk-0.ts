import { VoxelIndex } from "../voxel-index.js";
import { VoxelChunk } from "./voxel-chunk.js";

/**
 * This Voxel chunk stores 0 bits (no data) for all meta-data
 */
export class VoxelChunk0 extends VoxelChunk {

    /**
     * Returns the number of meta-data bits stored per voxel (always 0).
     */
    public override get metaBits(): number {
        return 0;
    }

    /**
     * Returns the meta-data storage for this chunk (always null as no
     * meta-data is stored).
     */
    public override get metaData(): Uint8Array | Uint16Array | Uint32Array | null {
        return null;
    }

    /**
     * Sets the 0-bit meta-data for a specific voxel, identified by the provided VoxelIndex.
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
