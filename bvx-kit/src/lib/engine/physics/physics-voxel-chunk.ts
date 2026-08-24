import { BitArray } from "../../containers/bit-array.js";
import { ChunkStorage } from "../chunks/chunk-storage.js";
import { MortonKey } from "../../math/morton-key.js";
import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelChunk0 } from "../chunks/voxel-chunk-0.js";

/**
 * PhysicsVoxelChunk is the chunk type stored in the VoxelWorld of a
 * VoxelPhysicsLayer. It extends the meta-data-free VoxelChunk0 with the
 * per-BitVoxel simulation bookkeeping the solver needs:
 *
 * - an `active` mask marking BitVoxels that may still move and must be
 *   visited by the next simulation step. Settled BitVoxels are skipped
 *   entirely, which is what keeps dormant scenes free.
 * - a `moved` scratch mask marking BitVoxels that already moved during the
 *   current tick, preventing a grain from moving more than one cell per tick.
 *
 * Because this is a regular VoxelChunk, physics worlds remain fully
 * compatible with VoxelFaceGeometry, VoxelSmoothGeometry, BVXSerializer and
 * the VoxelRaycaster with no changes to any of them.
 *
 * ## Shared storage
 *
 * The occupancy can live in a VoxelChunkArena like any other chunk's, which is what
 * lets a mesher in another agent read a layer's grains without the solver serializing
 * them. Pass a ChunkStorage and the BitVoxels are a view into the arena.
 *
 * The `active` and `moved` masks are deliberately **not** shared. They are solver
 * bookkeeping with no meaning outside the tick that produced them, nothing else reads
 * them, and putting them in the arena would double its size for no reader.
 */
export class PhysicsVoxelChunk extends VoxelChunk0 {
    /**
     * Marks BitVoxels that may still move and must be visited by the solver.
     */
    private readonly _active: BitArray;

    /**
     * Marks BitVoxels that already moved during the current tick.
     */
    private readonly _moved: BitArray;

    /**
     * The number of set bits in the active mask. Chunks with a zero count are
     * removed from the solver's active set.
     */
    private _activeCount = 0;

    /**
     * The number of grains (set BitVoxels) in this chunk, maintained incrementally by
     * the owning layer's mutation paths. The constant-time counterpart of length, and
     * with activeCount what makes per-chunk dormancy (grainCount > activeCount) an O(1)
     * question - the gate the flow-line wake scans ask per swept chunk.
     */
    private _grainCount = 0;

    /**
     * The tick the moved mask was last cleared for. Allows lazy clearing so
     * only chunks that are actually touched pay for the reset.
     */
    private _movedTick = -1;

    /**
     * Constructs a new physics chunk.
     *
     * @param key - The MortonKey locating this chunk.
     * @param storage - (Optional) Externally-owned storage for the BitVoxel occupancy,
     * typically an arena slot. The solver's own masks always self-allocate.
     */
    constructor(key: MortonKey, storage: ChunkStorage | null = null) {
        super(key, storage);

        this._active = new BitArray(BVXLayer.SIZE / 32);
        this._moved = new BitArray(BVXLayer.SIZE / 32);
    }

    /**
     * Returns the active mask marking BitVoxels that may still move.
     */
    public get active(): BitArray {
        return this._active;
    }

    /**
     * Returns the number of set bits in the active mask.
     */
    public get activeCount(): number {
        return this._activeCount;
    }

    /**
     * Sets the number of set bits in the active mask. Maintained by the solver.
     */
    public set activeCount(value: number) {
        this._activeCount = value;
    }

    /**
     * Returns the number of grains in this chunk, in constant time. Maintained by the
     * owning layer - unlike length, which pop-counts the storage.
     */
    public get grainCount(): number {
        return this._grainCount;
    }

    /**
     * Sets the number of grains in this chunk. Maintained by the owning layer.
     */
    public set grainCount(value: number) {
        this._grainCount = value;
    }

    /**
     * Returns the moved scratch mask for the provided tick, lazily clearing it
     * when the chunk was last touched on an earlier tick.
     *
     * @param tick - The current simulation tick.
     * @returns - The moved mask, valid for the provided tick.
     */
    public movedForTick(tick: number): Uint32Array {
        const elements: Uint32Array = this._moved.elements;

        if (this._movedTick !== tick) {
            elements.fill(0);
            this._movedTick = tick;
        }

        return elements;
    }
}
