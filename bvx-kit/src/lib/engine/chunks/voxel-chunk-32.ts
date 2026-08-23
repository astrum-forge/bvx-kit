import { MortonKey } from "../../math/morton-key.js";
import { VoxelIndex } from "../voxel-index.js";
import { VoxelChunk } from "./voxel-chunk.js";
import { ChunkStorage } from "./chunk-storage.js";

/**
 * VoxelChunk32 extends the base VoxelChunk functionality by allowing each voxel 
 * to store 32 bits of meta-data. This provides additional information per voxel,
 * such as custom attributes, voxel types, or other user-defined properties.
 */
export class VoxelChunk32 extends VoxelChunk {

    /**
     * Number of bytes the meta-data storage occupies (32 bits per voxel).
     */
    public static readonly META_BYTE_LENGTH: number = (VoxelChunk.SIZE * 32) / 8;

    /**
     * An ArrayBuffer to store the 32-bit meta-data for all voxels in the chunk.
     * Each VoxelChunk contains 64 voxels, and each voxel stores 32 bits (4 bytes) of meta-data.
     */
    private readonly _metaDataBuffer: ArrayBufferLike;

    /**
     * A Uint32Array view of the ArrayBuffer that holds the meta-data for each voxel.
     * Each voxel's meta-data is represented by 32 bits (1 Uint32 value).
     */
    private readonly _metaData: Uint32Array;

    /**
     * Constructs a VoxelChunk32 with a 32-bit meta-data buffer for each voxel.
     *
     * @param key - The MortonKey representing the chunk's location in the voxel map.
     * @param storage - (Optional) Externally-owned storage for this chunk's data. When
     * null, the chunk allocates and owns its own storage. See ChunkStorage.
     */
    constructor(key: MortonKey, storage: ChunkStorage | null = null) {
        super(key, storage);

        // Allocate or view enough space for 32 bits of meta-data per voxel in the chunk (64 voxels).
        if (storage !== null) {
            this._metaDataBuffer = storage.buffer;
            this._metaData = new Uint32Array(storage.buffer, storage.metaByteOffset, VoxelChunk.SIZE);
        }
        else {
            this._metaDataBuffer = new ArrayBuffer(VoxelChunk32.META_BYTE_LENGTH);
            this._metaData = new Uint32Array(this._metaDataBuffer);
        }
    }

    /**
     * Returns the number of meta-data bits stored per voxel (always 32).
     */
    public override get metaBits(): number {
        return 32;
    }

    /**
     * Returns the Uint32Array view of the meta-data storage for this chunk.
     * Useful for direct buffer access such as serialization or transfer
     * between threads.
     */
    public override get metaData(): Uint32Array {
        return this._metaData;
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
