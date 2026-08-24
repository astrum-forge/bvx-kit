import { BVXLayer } from "../engine/layer/bvx-layer.js";
import { ChunkStorage } from "../engine/chunks/chunk-storage.js";
import { MortonKey } from "../math/morton-key.js";
import { VoxelChunk } from "../engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../engine/chunks/voxel-chunk-0.js";
import { VoxelChunkArena } from "../engine/chunks/voxel-chunk-arena.js";
import { VoxelWorld } from "../engine/voxel-world.js";

/**
 * A chunk and its 26 neighbours, in the form a mesher needs them.
 *
 * ## Why this exists rather than a BVW1 snapshot
 *
 * BVXSerializer's BVW1 format is a *storage* format: it run-length encodes, it writes a
 * record per chunk, and it allocates. Using it to hand a neighbourhood to a worker costs
 * 17.2 us per request on the calling thread against 1.2 us for a straight copy of the
 * same bytes into a reused buffer - measured on an M1 over 64 surface chunks - and the
 * expensive part runs on the thread the worker exists to keep free. For blocky face
 * meshing, where the mesh itself takes 18.3 us, that made packaging 55% of the round
 * trip.
 *
 * So this is deliberately not a format. It is the 27 occupancy blocks laid end to end in
 * one Uint32Array, plus the bookkeeping needed to tell an absent chunk from an empty one,
 * and it is structured-clone friendly with exactly one transferable buffer.
 *
 * ## Absent is not empty
 *
 * `presence` matters and cannot be inferred from the occupancy words. Seam ownership in
 * both the blocky and smooth meshers turns on whether a negative-side neighbour *exists*,
 * not on whether it holds anything, so a chunk of solid air and a chunk that is not in
 * the world produce different geometry.
 */
export interface ChunkNeighbourhood {
    /**
     * The encoded MortonKey of the centre chunk.
     */
    chunkKey: number;

    /**
     * One bit per neighbourhood slot, set when that slot holds a chunk. Slot order is
     * `((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1)` for offsets in -1..1, matching every
     * other 27-slot walk in the kit. The centre is slot 13.
     */
    presence: number;

    /**
     * The BitVoxel occupancy of all 27 slots, `ChunkNeighbourhood.WORDS` per slot, in
     * slot order. Slots whose presence bit is clear hold undefined words and are never
     * read.
     */
    occupancy: Uint32Array;

    /**
     * The centre chunk's per-voxel meta-data, or null when it stores none.
     *
     * Carried because a quads response reports it, not because meshing needs it - no
     * geometry generator reads meta-data. Neighbour meta-data is never carried for the
     * same reason.
     */
    meta: Uint8Array | Uint16Array | Uint32Array | null;
}

/**
 * A chunk and its 26 neighbours named by their slots in a shared arena, for a worker
 * that already holds the arena and needs no bytes sent at all.
 *
 * This is the zero-copy request. It is only sound when the arena is backed by a
 * SharedArrayBuffer *and* the owner honours one of the two protocols
 * VoxelChunkArena documents - publish-by-message, or versioned reads. Sending arena
 * slots to a worker that then reads them on its own schedule is a data race.
 */
export interface ArenaNeighbourhood {
    /**
     * The encoded MortonKey of the centre chunk.
     */
    chunkKey: number;

    /**
     * Arena slot index per neighbourhood slot, in the same slot order as
     * ChunkNeighbourhood.presence. -1 marks a slot with no chunk.
     */
    slots: Int32Array;
}

/**
 * Packs neighbourhoods for sending. Sender side.
 *
 * One packer reuses one occupancy buffer, so a steady-state stream of requests over a
 * recycled buffer allocates nothing. Because the buffer is transferred with the message,
 * a caller that does not get it back must either allocate per request - still 8x cheaper
 * than BVW1 - or recycle through BVXMesherPool, which returns spent buffers.
 */
export class ChunkNeighbourhoodPacker {
    /**
     * The number of slots in a neighbourhood: the chunk and its 26 neighbours.
     */
    public static readonly SLOTS: number = 27;

    /**
     * 32-bit words of occupancy per chunk.
     */
    public static readonly WORDS: number = BVXLayer.ELEMENTS;

    /**
     * Total occupancy words in one neighbourhood.
     */
    public static readonly OCCUPANCY_WORDS: number = ChunkNeighbourhoodPacker.SLOTS * ChunkNeighbourhoodPacker.WORDS;

    /**
     * Reused key for neighbour lookups.
     */
    private readonly _key: MortonKey;

    constructor() {
        this._key = new MortonKey();
    }

    /**
     * Allocates an occupancy buffer of the right length. Use this to prime a recycling
     * pool.
     */
    public static allocate(): Uint32Array {
        return new Uint32Array(ChunkNeighbourhoodPacker.OCCUPANCY_WORDS);
    }

    /**
     * The transferable buffers of a neighbourhood, for a zero-copy postMessage.
     *
     * The meta-data view is deliberately not transferred: it aliases the live chunk's
     * own storage, and detaching that would leave the chunk unusable.
     *
     * @param neighbourhood - The neighbourhood being sent.
     * @returns - The buffers to list as transferables.
     */
    public static transferables(neighbourhood: ChunkNeighbourhood): ArrayBuffer[] {
        return [neighbourhood.occupancy.buffer as ArrayBuffer];
    }

    /**
     * Packs a chunk and its 26 neighbours out of a world.
     *
     * @param chunk - The centre chunk.
     * @param world - The world to read neighbours from.
     * @param occupancy - (Optional) An occupancy buffer to fill, of at least
     * OCCUPANCY_WORDS length. When null a fresh one is allocated. A recycled buffer is
     * not cleared - absent slots keep whatever they held, and are never read because
     * their presence bit is clear.
     * @param includeMeta - (Optional) Whether to carry the centre chunk's meta-data.
     * Defaults to true. Set false for face and smooth requests, whose responses do not
     * report it.
     * @returns - The packed neighbourhood.
     * @throws - RangeError if the provided buffer is too short.
     */
    public pack(chunk: VoxelChunk, world: VoxelWorld, occupancy: Uint32Array | null = null, includeMeta = true): ChunkNeighbourhood {
        const words: number = ChunkNeighbourhoodPacker.WORDS;

        const target: Uint32Array = occupancy ?? ChunkNeighbourhoodPacker.allocate();

        if (target.length < ChunkNeighbourhoodPacker.OCCUPANCY_WORDS) {
            throw new RangeError(`ChunkNeighbourhoodPacker.pack() - occupancy buffer of ${target.length} words is too short, ${ChunkNeighbourhoodPacker.OCCUPANCY_WORDS} required`);
        }

        const key: MortonKey = chunk.key;
        const scratch: MortonKey = this._key;

        let presence = 0;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const slot: number = ((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1);

                    // the centre comes from the argument, so a chunk that is being
                    // meshed before it is inserted still packs correctly
                    const neighbour: VoxelChunk | null = (ox === 0 && oy === 0 && oz === 0)
                        ? chunk
                        : world.get(MortonKey.from(key.x + ox, key.y + oy, key.z + oz, scratch));

                    if (neighbour === null) {
                        continue;
                    }

                    target.set(neighbour.layer.bitArray.elements, slot * words);
                    presence |= (1 << slot);
                }
            }
        }

        return {
            chunkKey: key.key,
            presence: presence,
            occupancy: target,
            meta: includeMeta ? chunk.metaData : null
        };
    }

    /**
     * Names a chunk and its 26 neighbours by arena slot, for a worker holding the same
     * arena. Nothing is copied.
     *
     * @param chunk - The centre chunk.
     * @param world - The world to read neighbours from.
     * @param slotOf - Resolves a chunk to its arena slot index. The caller owns the
     * chunk-to-slot mapping, because the arena does not record it.
     * @param slots - (Optional) An Int32Array of at least SLOTS length to fill.
     * @returns - The arena neighbourhood.
     */
    public packArena(chunk: VoxelChunk, world: VoxelWorld, slotOf: (chunk: VoxelChunk) => number, slots: Int32Array | null = null): ArenaNeighbourhood {
        const target: Int32Array = slots ?? new Int32Array(ChunkNeighbourhoodPacker.SLOTS);

        if (target.length < ChunkNeighbourhoodPacker.SLOTS) {
            throw new RangeError(`ChunkNeighbourhoodPacker.packArena() - slot buffer of ${target.length} is too short, ${ChunkNeighbourhoodPacker.SLOTS} required`);
        }

        target.fill(-1);

        const key: MortonKey = chunk.key;
        const scratch: MortonKey = this._key;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const slot: number = ((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1);

                    const neighbour: VoxelChunk | null = (ox === 0 && oy === 0 && oz === 0)
                        ? chunk
                        : world.get(MortonKey.from(key.x + ox, key.y + oy, key.z + oz, scratch));

                    if (neighbour !== null) {
                        target[slot] = slotOf(neighbour);
                    }
                }
            }
        }

        return { chunkKey: key.key, slots: target };
    }
}

/**
 * Binds a received neighbourhood to a VoxelWorld a mesher can read. Worker side.
 *
 * One reader owns one world, 27 chunk objects and one occupancy buffer, and rebinds them
 * per request, so a worker that meshes for the lifetime of the page allocates nothing per
 * request. The world is built with a bucket count sized for 27 entries rather than the
 * 256-bucket default, because the default's empty bucket array costs more than the index
 * it holds at this size.
 */
export class ChunkNeighbourhoodReader {
    /**
     * The world the bound chunks live in.
     */
    private readonly _world: VoxelWorld;

    /**
     * The 27 reusable chunk views, in slot order. Every one is a VoxelChunk0: no
     * geometry generator reads meta-data, so carrying a wider chunk type here would buy
     * nothing and cost a branch per slot.
     */
    private readonly _chunks: VoxelChunk0[];

    /**
     * The occupancy the chunk views are windows onto. Incoming words are copied in
     * rather than viewed directly, so the reader's chunk objects never have to be
     * rebuilt and the sender's buffer can be handed straight back for recycling.
     */
    private readonly _occupancy: Uint32Array;

    /**
     * Reused key for positioning the chunk views.
     */
    private readonly _key: MortonKey;

    constructor() {
        const slots: number = ChunkNeighbourhoodPacker.SLOTS;
        const words: number = ChunkNeighbourhoodPacker.WORDS;

        this._world = new VoxelWorld(32);
        this._occupancy = new Uint32Array(ChunkNeighbourhoodPacker.OCCUPANCY_WORDS);
        this._chunks = [];
        this._key = new MortonKey();

        const buffer: ArrayBufferLike = this._occupancy.buffer;

        for (let slot = 0; slot < slots; slot++) {
            const storage: ChunkStorage = {
                buffer: buffer,
                layerByteOffset: slot * words * 4,
                metaByteOffset: 0
            };

            this._chunks.push(new VoxelChunk0(new MortonKey(), storage));
        }
    }

    /**
     * The world the most recent bind() populated.
     */
    public get world(): VoxelWorld {
        return this._world;
    }

    /**
     * The centre chunk view, positioned by the most recent bind().
     *
     * Returned whether or not the neighbourhood said the centre was present - an absent
     * centre is zeroed by bind() and simply left out of `world`. A smooth request that
     * has to mesh a chunk this layer holds no voxels in gets its empty chunk from here
     * rather than allocating one.
     */
    public get centre(): VoxelChunk {
        return this._chunks[13];
    }

    /**
     * Binds a received neighbourhood and returns its centre chunk.
     *
     * The returned chunk and the world both alias this reader's internal storage and are
     * invalidated by the next bind() on the same reader. A mesher consumes them
     * synchronously, which is the only supported use.
     *
     * @param neighbourhood - The received neighbourhood.
     * @returns - The centre chunk, positioned at its own key. It is present in
     * `world` only when the neighbourhood said so; an absent centre comes back zeroed
     * and uninserted.
     */
    public bind(neighbourhood: ChunkNeighbourhood): VoxelChunk {
        this._occupancy.set(neighbourhood.occupancy.subarray(0, ChunkNeighbourhoodPacker.OCCUPANCY_WORDS));

        return this._Position(neighbourhood.chunkKey, (slot) => (neighbourhood.presence & (1 << slot)) !== 0);
    }

    /**
     * Binds a neighbourhood named by arena slots, copying each present slot's occupancy
     * out of the arena.
     *
     * The copy is what makes this safe to read after the fact: it happens inside the
     * message handler, where the sender's writes are ordered before it, so the mesh runs
     * against a snapshot rather than against memory the owner may still be editing.
     * A caller that wants a genuinely zero-copy read must use the arena's versioned
     * protocol directly and accept the retry.
     *
     * @param neighbourhood - The received arena neighbourhood.
     * @param arena - The arena the slots index into.
     * @returns - The centre chunk, positioned at its own key.
     */
    public bindArena(neighbourhood: ArenaNeighbourhood, arena: VoxelChunkArena): VoxelChunk {
        const words: number = ChunkNeighbourhoodPacker.WORDS;
        const slots: Int32Array = neighbourhood.slots;
        const buffer: ArrayBufferLike = arena.buffer;

        for (let slot = 0; slot < ChunkNeighbourhoodPacker.SLOTS; slot++) {
            const arenaSlot: number = slots[slot];

            if (arenaSlot < 0) {
                continue;
            }

            const source = new Uint32Array(buffer, arena.storageAt(arenaSlot).layerByteOffset, words);

            this._occupancy.set(source, slot * words);
        }

        return this._Position(neighbourhood.chunkKey, (slot) => slots[slot] >= 0);
    }

    /**
     * Places the present chunk views at their world positions and returns the centre.
     *
     * An absent slot has its occupancy zeroed rather than left holding the previous
     * request's words. It is not inserted into the world, so nothing should read it -
     * but a reader whose state is a pure function of its input cannot leak the previous
     * request into this one, and the fill is bounded at 27 x 512 B.
     *
     * The centre is returned whether or not it is present, zeroed in the absent case.
     * That is what lets a smooth request with occluders mesh a chunk this layer holds no
     * voxels in: the caller inserts the returned chunk itself, exactly as it would have
     * constructed an empty one.
     */
    private _Position(chunkKey: number, present: (slot: number) => boolean): VoxelChunk {
        const world: VoxelWorld = this._world;
        const key: MortonKey = this._key;
        const words: number = ChunkNeighbourhoodPacker.WORDS;

        key.key = chunkKey;

        const cx: number = key.x;
        const cy: number = key.y;
        const cz: number = key.z;

        // Keys are mutated in place, so every chunk has to leave the index before any of
        // them moves - a HashGrid entry is filed under the key's value at insert time.
        world.clear();

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const slot: number = ((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1);
                    const chunk: VoxelChunk0 = this._chunks[slot];

                    MortonKey.from(cx + ox, cy + oy, cz + oz, chunk.key);

                    if (!present(slot)) {
                        this._occupancy.fill(0, slot * words, (slot + 1) * words);

                        continue;
                    }

                    world.insert(chunk);
                }
            }
        }

        return this._chunks[13];
    }
}
