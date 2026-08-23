import { MortonKey } from "../../math/morton-key.js";
import { VoxelIndex } from "../voxel-index.js";
import { VoxelChunk } from "./voxel-chunk.js";
import { ChunkStorage } from "./chunk-storage.js";

/**
 * VoxelChunk8 extends the base VoxelChunk by allowing each voxel to store 
 * 8 bits (1 byte) of meta-data. This is useful for applications where limited
 * meta-data per voxel is sufficient, such as flags or small property sets.
 */
export class VoxelChunk8 extends VoxelChunk {

    /**
     * Number of bytes the meta-data storage occupies (8 bits per voxel).
     */
    public static readonly META_BYTE_LENGTH: number = (VoxelChunk.SIZE * 8) / 8;

    /**
     * An ArrayBuffer to store the 8-bit meta-data for all voxels in the chunk.
     * Each VoxelChunk contains 64 voxels, and each voxel stores 8 bits (1 byte) of meta-data.
     */
    private readonly _metaDataBuffer: ArrayBufferLike;

    /**
     * A Uint8Array view of the ArrayBuffer that holds the meta-data for each voxel.
     * Each voxel's meta-data is represented by 8 bits (1 byte).
     */
    private readonly _metaData: Uint8Array;

    /**
     * Constructs a VoxelChunk8 with a 8-bit meta-data buffer for each voxel.
     *
     * @param key - The MortonKey representing the chunk's location in the voxel map.
     * @param storage - (Optional) Externally-owned storage for this chunk's data. When
     * null, the chunk allocates and owns its own storage. See ChunkStorage.
     */
    constructor(key: MortonKey, storage: ChunkStorage | null = null) {
        super(key, storage);

        // Allocate or view enough space for 8 bits of meta-data per voxel in the chunk (64 voxels).
        if (storage !== null) {
            this._metaDataBuffer = storage.buffer;
            this._metaData = new Uint8Array(storage.buffer, storage.metaByteOffset, VoxelChunk.SIZE);
        }
        else {
            this._metaDataBuffer = new ArrayBuffer(VoxelChunk8.META_BYTE_LENGTH);
            this._metaData = new Uint8Array(this._metaDataBuffer);
        }
    }

    /**
     * Returns the number of meta-data bits stored per voxel (always 8).
     */
    public override get metaBits(): number {
        return 8;
    }

    /**
     * Returns the Uint8Array view of the meta-data storage for this chunk.
     * Useful for direct buffer access such as serialization or transfer
     * between threads.
     */
    public override get metaData(): Uint8Array {
        return this._metaData;
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
