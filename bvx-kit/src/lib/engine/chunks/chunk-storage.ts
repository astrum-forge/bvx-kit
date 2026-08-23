/**
 * Describes externally-owned storage for a single VoxelChunk - where in a caller's
 * buffer the chunk's occupancy and meta-data live.
 *
 * A VoxelChunk normally allocates its own storage, which costs eight allocations and
 * roughly seven object headers per chunk. Handing it a ChunkStorage instead lets many
 * chunks be packed into one allocation, and lets that allocation be a SharedArrayBuffer
 * so a worker can read live world state directly rather than through a serialized
 * snapshot.
 *
 * Alignment is the caller's responsibility and is validated on construction:
 *
 * - `layerByteOffset` must be a multiple of 4 and leave room for BVXLayer.BYTE_LENGTH
 * - `metaByteOffset` must be a multiple of the chunk's meta-data element size
 *   (1, 2 or 4 bytes) and leave room for its meta-data
 *
 * See VoxelChunkArena for an allocator that satisfies both.
 */
export interface ChunkStorage {
    /**
     * The buffer holding the chunk's data. May be a SharedArrayBuffer.
     */
    readonly buffer: ArrayBufferLike;

    /**
     * Byte offset of the chunk's BitVoxel occupancy within the buffer.
     */
    readonly layerByteOffset: number;

    /**
     * Byte offset of the chunk's meta-data within the buffer. Ignored by chunk types
     * that store no meta-data.
     */
    readonly metaByteOffset: number;
}
