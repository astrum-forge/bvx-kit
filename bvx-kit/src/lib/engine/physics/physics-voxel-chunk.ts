import { BitArray } from "../../containers/bit-array.js";
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
     * The tick the moved mask was last cleared for. Allows lazy clearing so
     * only chunks that are actually touched pay for the reset.
     */
    private _movedTick = -1;

    constructor(key: MortonKey) {
        super(key);

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
