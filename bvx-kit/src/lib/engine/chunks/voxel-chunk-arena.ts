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
 * Layout is contiguous regions rather than interleaved per-chunk slots, so every stride
 * stays naturally aligned regardless of the meta-data width:
 *
 * ```
 * [ versions: capacity x 4 B ][ occupancy: capacity x 512 B ][ meta-data: capacity x metaByteLength ]
 * ```
 *
 * The version region exists only when the arena is constructed with `versioned` set.
 *
 * Slots are recycled through a free list, so releasing a chunk that streamed out of
 * range is a push rather than a reallocation.
 *
 * ## Concurrency
 *
 * The arena hands out memory. Whether concurrent access to it is safe depends entirely
 * on which of the following the caller uses, and the difference is not a matter of
 * degree - two of them are sound and one is not.
 *
 * **1. Publish by message (sound, no atomics, no version region).** Writing an agent's
 * plain stores into shared memory and then posting a message establishes a
 * happens-before edge between the writer and the receiver of that message: the writes
 * are ordered before the send, and the send before the receiving agent's reads. This
 * is the host-synchronizes-with relation the ECMAScript memory model requires the host
 * to supply, and HTML supplies it for postMessage. So a worker that reads arena slots
 * *only* in response to a request naming them, and an owner that does not touch those
 * slots until the response comes back, race on nothing. This is the cheapest correct
 * protocol and the one BVXMesherPool's arena requests use.
 *
 * The edge is pairwise and it is not a lease. It orders the writes made *before* the
 * message; it says nothing about writes made after it. An owner that keeps editing a
 * chunk while a worker meshes it is racing again.
 *
 * **2. Versioned reads (sound, costs a version region and a retry).** For an owner that
 * cannot stop writing, construct the arena `versioned` and bracket every mutation in
 * beginWrite/endWrite. A reader then wraps its read in readStable, which re-checks the
 * version and retries if the slot changed underneath it. See readStable for exactly
 * what this does and does not promise.
 *
 * **3. Neither (not sound).** Reading a slot from another agent with no message edge
 * and no version check has no ordering guarantee at all. A reader can observe some of
 * a chunk's 128 occupancy words updated and the rest stale - a chunk that never existed
 * - and nothing bounds how long it keeps seeing the old values. Individual 32-bit words
 * do not tear, because every access to occupancy goes through a Uint32Array of matching
 * width, but word-level integrity is not chunk-level integrity.
 *
 * See VoxelChunkArena.isShared for detecting whether an arena is cross-thread at all;
 * SharedArrayBuffer requires cross-origin isolation and is not always available.
 */
export class VoxelChunkArena {
    /**
     * Bytes of version counter per slot, when the arena is versioned.
     */
    private static readonly VERSION_BYTE_LENGTH: number = 4;

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
     * Byte offset at which the occupancy region begins.
     */
    private readonly _layerRegionOffset: number;

    /**
     * Byte offset at which the meta-data region begins.
     */
    private readonly _metaRegionOffset: number;

    /**
     * The per-slot version counters, or null when the arena is not versioned.
     * Int32Array because Atomics does not operate on a Uint32Array in every engine's
     * older builds and the sign is never observed - only equality and parity.
     */
    private readonly _versions: Int32Array | null;

    /**
     * Whether each slot is currently allocated. Kept so release() can reject a slot
     * that is not held, which is the difference between a caught mistake and two live
     * chunks silently aliasing the same memory.
     */
    private readonly _allocated: Uint8Array;

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
     * @param versioned - (Optional) Whether to reserve the per-slot version region.
     * @returns - The required buffer length in bytes.
     */
    public static byteLengthFor(capacity: number, metaByteLength: number, versioned = false): number {
        const versions: number = versioned ? capacity * VoxelChunkArena.VERSION_BYTE_LENGTH : 0;

        return versions + (capacity * BVXLayer.BYTE_LENGTH) + (capacity * metaByteLength);
    }

    /**
     * Constructs a new arena.
     *
     * @param capacity - The number of chunk slots. Must be greater than 0.
     * @param metaByteLength - Bytes of meta-data per chunk. Use the concrete chunk
     * type's META_BYTE_LENGTH, or 0 for VoxelChunk0. Must be a multiple of 4 so that
     * every slot stays aligned for the widest meta-data view.
     * @param buffer - (Optional) Existing storage to use, typically a SharedArrayBuffer.
     * Must be at least byteLengthFor(capacity, metaByteLength, versioned) bytes. When
     * null, an ArrayBuffer of exactly that size is allocated.
     * @param versioned - (Optional) Reserve a per-slot version counter, enabling
     * beginWrite/endWrite/readStable. Costs 4 bytes per slot. Defaults to false.
     * @throws - Error if the arguments are invalid or the provided buffer is too small.
     */
    constructor(capacity: number, metaByteLength: number, buffer: ArrayBufferLike | null = null, versioned = false) {
        if (capacity <= 0) {
            throw new Error(`VoxelChunkArena.constructor(number, number, ArrayBufferLike, boolean) - capacity must be greater than 0, was ${capacity}`);
        }

        // A slot must start on a 4-byte boundary for a Uint32Array meta-data view, and
        // every supported meta-data width (0, 64, 128, 256 bytes) already satisfies it.
        if (metaByteLength < 0 || (metaByteLength % 4) !== 0) {
            throw new Error(`VoxelChunkArena.constructor(number, number, ArrayBufferLike, boolean) - metaByteLength must be a non-negative multiple of 4, was ${metaByteLength}`);
        }

        const required: number = VoxelChunkArena.byteLengthFor(capacity, metaByteLength, versioned);

        if (buffer !== null && buffer.byteLength < required) {
            throw new RangeError(`VoxelChunkArena.constructor(number, number, ArrayBufferLike, boolean) - buffer of ${buffer.byteLength} bytes is too small, ${required} required`);
        }

        this._buffer = buffer ?? new ArrayBuffer(required);
        this._capacity = capacity;
        this._metaByteLength = metaByteLength;
        this._layerRegionOffset = versioned ? capacity * VoxelChunkArena.VERSION_BYTE_LENGTH : 0;
        this._metaRegionOffset = this._layerRegionOffset + (capacity * BVXLayer.BYTE_LENGTH);
        this._versions = versioned ? new Int32Array(this._buffer, 0, capacity) : null;
        this._allocated = new Uint8Array(capacity);
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
     * cross-origin isolation, which GitHub Pages cannot serve headers for and which any
     * page embedding non-cooperating third-party content cannot have - so this reports
     * what the arena actually got rather than what was asked for. Build the non-shared
     * path as the one that always works and treat sharing as an optimisation.
     */
    public get isShared(): boolean {
        return typeof SharedArrayBuffer !== "undefined" && this._buffer instanceof SharedArrayBuffer;
    }

    /**
     * Returns true when this arena reserves per-slot version counters, and therefore
     * supports beginWrite, endWrite, version and readStable.
     */
    public get isVersioned(): boolean {
        return this._versions !== null;
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
     * Returns whether the provided slot is currently allocated.
     *
     * @param slot - The slot index, 0 to capacity - 1.
     * @returns - True when the slot is held, false when it is free or out of range.
     */
    public isAllocated(slot: number): boolean {
        return slot >= 0 && slot < this._capacity && this._allocated[slot] === 1;
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
            layerByteOffset: this._layerRegionOffset + (slot * BVXLayer.BYTE_LENGTH),
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
            this._allocated[recycled] = 1;

            return recycled;
        }

        if (this._next >= this._capacity) {
            return -1;
        }

        const slot: number = this._next;

        this._next++;
        this._allocated[slot] = 1;

        return slot;
    }

    /**
     * Returns a slot to the free list. The caller must have discarded every chunk view
     * over it first - the arena cannot detect a view that outlives its slot, and a stale
     * one will silently read and write whatever chunk is placed there next.
     *
     * Releasing a slot that is not currently allocated throws rather than pushing a
     * duplicate onto the free list. A duplicate would be handed out twice and produce
     * two live chunks aliasing the same memory, which is not a failure that shows up
     * anywhere near its cause.
     *
     * @param slot - The slot index to release.
     * @throws - RangeError if the slot is out of range.
     * @throws - Error if the slot is not currently allocated.
     */
    public release(slot: number): void {
        if (slot < 0 || slot >= this._capacity) {
            throw new RangeError(`VoxelChunkArena.release(number) - slot ${slot} is outside the arena capacity of ${this._capacity}`);
        }

        if (this._allocated[slot] !== 1) {
            throw new Error(`VoxelChunkArena.release(number) - slot ${slot} is not allocated; releasing it twice would hand the same memory to two chunks`);
        }

        this._allocated[slot] = 0;
        this._free.push(slot);
    }

    /**
     * Zeroes a slot's occupancy and meta-data.
     *
     * The occupancy fill goes through a Uint32Array rather than a Uint8Array because
     * every other access to that memory - BitArray, the solver, the serializer - is
     * 32-bit. The ECMAScript memory model's guarantee that a racing read observes a
     * whole old or whole new value, rather than a byte-level splice of the two, holds
     * only while both sides use views of the same width.
     *
     * @param slot - The slot index to clear.
     * @throws - RangeError if the slot is out of range.
     */
    public clear(slot: number): void {
        const storage: ChunkStorage = this.storageAt(slot);

        new Uint32Array(this._buffer, storage.layerByteOffset, BVXLayer.ELEMENTS).fill(0);

        if (this._metaByteLength > 0) {
            new Uint32Array(this._buffer, storage.metaByteOffset, this._metaByteLength / 4).fill(0);
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

    /**
     * Returns the current version counter of a slot. Odd means a write is in progress.
     *
     * @param slot - The slot index.
     * @returns - The version counter.
     * @throws - Error if the arena is not versioned.
     * @throws - RangeError if the slot is out of range.
     */
    public version(slot: number): number {
        const versions: Int32Array = this._RequireVersions("version");

        if (slot < 0 || slot >= this._capacity) {
            throw new RangeError(`VoxelChunkArena.version(number) - slot ${slot} is outside the arena capacity of ${this._capacity}`);
        }

        return Atomics.load(versions, slot);
    }

    /**
     * Opens a write on a slot, making its version odd so that a concurrent readStable
     * discards whatever it sees. Pair with endWrite.
     *
     * @param slot - The slot index being written.
     * @throws - Error if the arena is not versioned.
     * @throws - RangeError if the slot is out of range.
     */
    public beginWrite(slot: number): void {
        const versions: Int32Array = this._RequireVersions("beginWrite");

        if (slot < 0 || slot >= this._capacity) {
            throw new RangeError(`VoxelChunkArena.beginWrite(number) - slot ${slot} is outside the arena capacity of ${this._capacity}`);
        }

        Atomics.add(versions, slot, 1);
    }

    /**
     * Closes a write on a slot, making its version even again and publishing the writes
     * that came between. Pair with beginWrite.
     *
     * @param slot - The slot index that was written.
     * @throws - Error if the arena is not versioned.
     * @throws - RangeError if the slot is out of range.
     */
    public endWrite(slot: number): void {
        const versions: Int32Array = this._RequireVersions("endWrite");

        if (slot < 0 || slot >= this._capacity) {
            throw new RangeError(`VoxelChunkArena.endWrite(number) - slot ${slot} is outside the arena capacity of ${this._capacity}`);
        }

        Atomics.add(versions, slot, 1);
    }

    /**
     * Runs a read against a slot and returns its result only if the slot did not change
     * while the read was running.
     *
     * This is a seqlock. The reader's own loads are ordinary, non-atomic reads that may
     * genuinely race a concurrent writer - what makes that safe is not that the race is
     * absent but that its outcome is bounded. Every access to arena occupancy is through
     * a 32-bit view, so a racing read observes whole old or whole new words rather than
     * a byte-level mixture of the two, and the version check then discards any result
     * that could have been assembled from more than one write. The read callback must
     * therefore tolerate seeing an inconsistent mixture of words without throwing,
     * looping forever or allocating unboundedly - it will simply be run again.
     *
     * @param slot - The slot index to read.
     * @param read - The read to perform. May be called more than once.
     * @param attempts - (Optional) How many times to retry before giving up. Defaults to 8.
     * @returns - The read's result, or null if the slot was still changing after every
     * attempt. A caller that must have a value should fall back to asking the owning
     * agent for one rather than looping here forever.
     * @throws - Error if the arena is not versioned.
     * @throws - RangeError if the slot is out of range.
     */
    public readStable<T>(slot: number, read: (storage: ChunkStorage) => T, attempts = 8): T | null {
        const versions: Int32Array = this._RequireVersions("readStable");

        if (slot < 0 || slot >= this._capacity) {
            throw new RangeError(`VoxelChunkArena.readStable(number, function, number) - slot ${slot} is outside the arena capacity of ${this._capacity}`);
        }

        const storage: ChunkStorage = this.storageAt(slot);

        for (let attempt = 0; attempt < attempts; attempt++) {
            const before: number = Atomics.load(versions, slot);

            // odd means a write is open - no point reading yet
            if ((before & 1) !== 0) {
                continue;
            }

            const result: T = read(storage);

            if (Atomics.load(versions, slot) === before) {
                return result;
            }
        }

        return null;
    }

    /**
     * Throws a consistent error when a version operation is used on an arena that has
     * no version region.
     */
    private _RequireVersions(operation: string): Int32Array {
        const versions: Int32Array | null = this._versions;

        if (versions === null) {
            throw new Error(`VoxelChunkArena.${operation}() - this arena is not versioned; construct it with versioned = true`);
        }

        return versions;
    }
}
