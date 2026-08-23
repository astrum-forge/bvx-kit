import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelChunk } from "./voxel-chunk.js";
import { ChunkStorage } from "./chunk-storage.js";

/**
 * VoxelChunkArena packs the storage of many VoxelChunks into a single buffer and hands
 * out ChunkStorage slots from it.
 *
 * Two things this buys:
 *
 * - **Fewer allocations.** A self-allocating chunk costs two ArrayBuffers plus their
 *   views; an arena chunk costs two views into memory that already exists.
 * - **Cross-thread world state.** Constructed over a SharedArrayBuffer, the same chunk
 *   data is addressable from a worker with no copy, no transfer and no serialization
 *   round trip. That is the whole reason BitArray accepts an injected buffer.
 *
 * Layout is two contiguous regions rather than interleaved per-chunk slots, so both
 * strides stay naturally aligned regardless of the meta-data width:
 *
 * ```
 * [ occupancy: capacity x 512 B ][ meta-data: capacity x metaByteLength ]
 * ```
 *
 * Slots are recycled through a free list, so releasing a chunk that streamed out of
 * range is a push rather than a reallocation.
 *
 * ## Concurrency
 *
 * The arena hands out memory; it does not synchronise access to it. A SharedArrayBuffer
 * arena written by one thread and read by another gives no atomicity and no ordering
 * guarantee - a reader can observe a chunk half-updated. Callers that share an arena
 * across threads must layer their own protocol on top, such as a per-chunk generation
 * counter the reader re-checks after building, or a double buffer. See
 * VoxelChunkArena.isShared for detecting which kind of buffer backs an arena.
 */
export class VoxelChunkArena {
    /**
     * The backing storage for every chunk in this arena.
     */
    private readonly _buffer: ArrayBufferLike;

    /**
     * The maximum number of chunk slots.
     */
    private readonly _capacity: number;

    /**
     * Bytes of meta-data per chunk slot. 0 for a meta-data-free arena.
     */
    private readonly _metaByteLength: number;

    /**
     * Byte offset at which the meta-data region begins.
     */
    private readonly _metaRegionOffset: number;

    /**
     * Slot indices returned by release(), reused before any fresh slot.
     */
    private readonly _free: number[];

    /**
     * The next never-yet-allocated slot index.
     */
    private _next: number;

    /**
     * Computes the byte length a buffer must have to back an arena of the given shape.
     * Use this to size a SharedArrayBuffer before handing it to the constructor.
     *
     * @param capacity - The number of chunk slots.
     * @param metaByteLength - Bytes of meta-data per chunk. Use the concrete chunk
     * type's META_BYTE_LENGTH, or 0 for VoxelChunk0.
     * @returns - The required buffer length in bytes.
     */
    public static byteLengthFor(capacity: number, metaByteLength: number): number {
        return (capacity * BVXLayer.BYTE_LENGTH) + (capacity * metaByteLength);
    }

    /**
     * Constructs a new arena.
     *
     * @param capacity - The number of chunk slots. Must be greater than 0.
     * @param metaByteLength - Bytes of meta-data per chunk. Use the concrete chunk
     * type's META_BYTE_LENGTH, or 0 for VoxelChunk0. Must be a multiple of 4 so that
     * every slot stays aligned for the widest meta-data view.
     * @param buffer - (Optional) Existing storage to use, typically a SharedArrayBuffer.
     * Must be at least byteLengthFor(capacity, metaByteLength) bytes. When null, an
     * ArrayBuffer of exactly that size is allocated.
     * @throws - Error if the arguments are invalid or the provided buffer is too small.
     */
    constructor(capacity: number, metaByteLength: number, buffer: ArrayBufferLike | null = null) {
        if (capacity <= 0) {
            throw new Error(`VoxelChunkArena.constructor(number, number, ArrayBufferLike) - capacity must be greater than 0, was ${capacity}`);
        }

        // A slot must start on a 4-byte boundary for a Uint32Array meta-data view, and
        // every supported meta-data width (0, 64, 128, 256 bytes) already satisfies it.
        if (metaByteLength < 0 || (metaByteLength % 4) !== 0) {
            throw new Error(`VoxelChunkArena.constructor(number, number, ArrayBufferLike) - metaByteLength must be a non-negative multiple of 4, was ${metaByteLength}`);
        }

        const required: number = VoxelChunkArena.byteLengthFor(capacity, metaByteLength);

        if (buffer !== null && buffer.byteLength < required) {
            throw new RangeError(`VoxelChunkArena.constructor(number, number, ArrayBufferLike) - buffer of ${buffer.byteLength} bytes is too small, ${required} required`);
        }

        this._buffer = buffer ?? new ArrayBuffer(required);
        this._capacity = capacity;
        this._metaByteLength = metaByteLength;
        this._metaRegionOffset = capacity * BVXLayer.BYTE_LENGTH;
        this._free = [];
        this._next = 0;
    }

    /**
     * Returns the buffer backing this arena. Post this to a worker to give it addressable
     * access to the same chunk data - a SharedArrayBuffer is shared, an ArrayBuffer is
     * copied or transferred by the usual postMessage rules.
     */
    public get buffer(): ArrayBufferLike {
        return this._buffer;
    }

    /**
     * Returns true when this arena is backed by a SharedArrayBuffer and is therefore
     * addressable from more than one thread.
     *
     * SharedArrayBuffer is not universally available - browsers gate it behind
     * cross-origin isolation - so this reports what the arena actually got rather than
     * what was asked for.
     */
    public get isShared(): boolean {
        return typeof SharedArrayBuffer !== "undefined" && this._buffer instanceof SharedArrayBuffer;
    }

    /**
     * Returns the total number of chunk slots.
     */
    public get capacity(): number {
        return this._capacity;
    }

    /**
     * Returns the number of slots currently allocated.
     */
    public get length(): number {
        return this._next - this._free.length;
    }

    /**
     * Returns the number of slots still available.
     */
    public get available(): number {
        return this._capacity - this.length;
    }

    /**
     * Returns bytes of meta-data per chunk slot.
     */
    public get metaByteLength(): number {
        return this._metaByteLength;
    }

    /**
     * Returns the ChunkStorage for a specific slot, without affecting allocation. Use
     * this to rebuild chunk views over an arena a worker received from another thread,
     * where the slot assignment is known from the sending side.
     *
     * @param slot - The slot index, 0 to capacity - 1.
     * @returns - The ChunkStorage describing that slot.
     * @throws - RangeError if the slot is out of range.
     */
    public storageAt(slot: number): ChunkStorage {
        if (slot < 0 || slot >= this._capacity) {
            throw new RangeError(`VoxelChunkArena.storageAt(number) - slot ${slot} is outside the arena capacity of ${this._capacity}`);
        }

        return {
            buffer: this._buffer,
            layerByteOffset: slot * BVXLayer.BYTE_LENGTH,
            metaByteOffset: this._metaRegionOffset + (slot * this._metaByteLength)
        };
    }

    /**
     * Reserves the next free slot.
     *
     * The returned storage is not cleared - a recycled slot still holds the previous
     * chunk's data. Callers reusing a slot for a new chunk should clear it, which
     * clear() does.
     *
     * @returns - The reserved slot index, or -1 when the arena is full.
     */
    public allocate(): number {
        const recycled: number | undefined = this._free.pop();

        if (recycled !== undefined) {
            return recycled;
        }

        if (this._next >= this._capacity) {
            return -1;
        }

        const slot: number = this._next;

        this._next++;

        return slot;
    }

    /**
     * Returns a slot to the free list. The caller must have discarded every chunk view
     * over it first - the arena cannot detect a view that outlives its slot, and a stale
     * one will silently read and write whatever chunk is placed there next.
     *
     * @param slot - The slot index to release.
     * @throws - RangeError if the slot is out of range.
     */
    public release(slot: number): void {
        if (slot < 0 || slot >= this._capacity) {
            throw new RangeError(`VoxelChunkArena.release(number) - slot ${slot} is outside the arena capacity of ${this._capacity}`);
        }

        this._free.push(slot);
    }

    /**
     * Zeroes a slot's occupancy and meta-data.
     *
     * @param slot - The slot index to clear.
     * @throws - RangeError if the slot is out of range.
     */
    public clear(slot: number): void {
        const storage: ChunkStorage = this.storageAt(slot);

        new Uint8Array(this._buffer, storage.layerByteOffset, BVXLayer.BYTE_LENGTH).fill(0);

        if (this._metaByteLength > 0) {
            new Uint8Array(this._buffer, storage.metaByteOffset, this._metaByteLength).fill(0);
        }
    }

    /**
     * Reserves a slot and constructs a chunk over it.
     *
     * @param slot - The slot to build over, from allocate() or a known assignment.
     * @param factory - Constructs the concrete chunk type from its storage, for example
     * `storage => new VoxelChunk16(key, storage)`.
     * @returns - The constructed VoxelChunk.
     * @throws - RangeError if the slot is out of range.
     */
    public build<T extends VoxelChunk>(slot: number, factory: (storage: ChunkStorage) => T): T {
        return factory(this.storageAt(slot));
    }
}
