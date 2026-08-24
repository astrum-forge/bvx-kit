import { MortonKey } from "../math/morton-key.js";
import { VoxelChunk } from "../engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../engine/voxel-index.js";
import { VoxelWorld } from "../engine/voxel-world.js";
import { VoxelPhysics, VoxelPhysicsOptions, PhysicsStepResult } from "../engine/physics/voxel-physics.js";
import { VoxelPhysicsLayer, VoxelPhysicsParams } from "../engine/physics/voxel-physics-layer.js";
import { BVXSerializer } from "../serialize/bvx-serializer.js";

/**
 * Seeds a runner with a complete simulation. Sent once.
 *
 * The snapshots here are the only bulk data the protocol ever moves. Everything
 * afterwards is edits in and deltas out.
 */
export interface PhysicsAttachRequest {
    /**
     * Caller-defined identifier, echoed back in the response.
     */
    id: number;

    /**
     * The type of request.
     */
    type: "attach";

    /**
     * (Optional) The simulation bounds (see VoxelPhysicsOptions).
     */
    bounds?: VoxelPhysicsOptions;

    /**
     * Parameters for each simulation layer, in the order the caller will address
     * them by index. Use the VoxelPhysics.SAND and VoxelPhysics.WATER presets.
     */
    layers: VoxelPhysicsParams[];

    /**
     * (Optional) BVW1 snapshot of the static collision world.
     */
    base?: Uint8Array;

    /**
     * (Optional) BVW1 snapshot of the initial grain state of each layer, indexed to
     * match `layers`. A null entry starts that layer empty.
     */
    grains?: (Uint8Array | null)[];
}

/**
 * Applies BitVoxel changes to the static collision world - the player digging or
 * building. Grains in and around the change are woken automatically.
 *
 * Coordinates are flat global BitVoxel triples, x, y, z, x, y, z, and so on. Int32Array
 * rather than a plain array so the buffer can be transferred instead of cloned.
 */
export interface PhysicsEditRequest {
    /**
     * Caller-defined identifier, echoed back in the response.
     */
    id: number;

    /**
     * The type of request.
     */
    type: "edit";

    /**
     * (Optional) Coordinate triples of BitVoxels to add to the collision world.
     */
    set?: Int32Array;

    /**
     * (Optional) Coordinate triples of BitVoxels to remove from the collision world.
     */
    unset?: Int32Array;
}

/**
 * Adds or removes grains in one simulation layer.
 */
export interface PhysicsInjectRequest {
    /**
     * Caller-defined identifier, echoed back in the response.
     */
    id: number;

    /**
     * The type of request.
     */
    type: "inject";

    /**
     * Index of the layer to modify, matching the attach request's layer order.
     */
    layer: number;

    /**
     * (Optional) Coordinate triples of grains to add.
     */
    set?: Int32Array;

    /**
     * (Optional) Coordinate triples of grains to remove.
     */
    unset?: Int32Array;
}

/**
 * Advances the simulation and collects what changed.
 */
export interface PhysicsStepRequest {
    /**
     * Caller-defined identifier, echoed back in the response.
     */
    id: number;

    /**
     * The type of request.
     */
    type: "step";

    /**
     * (Optional) The number of simulation ticks to advance. Defaults to 1.
     */
    ticks?: number;

    /**
     * (Optional) Cell-probe budget for the whole call (see VoxelPhysics.update). 0 or
     * less means no limit.
     *
     * A budget paces the call; it does not change the simulation. A tick the budget
     * cuts short is resumed by the next step request, not skipped.
     */
    maxWork?: number;
}

/**
 * Union of all physics runner request types.
 */
export type PhysicsRequest = PhysicsAttachRequest | PhysicsEditRequest | PhysicsInjectRequest | PhysicsStepRequest;

/**
 * What changed in one layer since the previous response.
 */
export interface PhysicsLayerDelta {
    /**
     * Index of the layer this delta belongs to.
     */
    layer: number;

    /**
     * Encoded MortonKeys of chunks that now hold grains, parallel to `chunks`.
     */
    keys: Uint32Array;

    /**
     * BVX1 chunk payloads, parallel to `keys`.
     */
    chunks: Uint8Array[];

    /**
     * Encoded MortonKeys of chunks that no longer exist, so a renderer can release
     * their meshes.
     */
    removed: Uint32Array;
}

/**
 * The result of advancing the simulation.
 */
export interface PhysicsStepResponse {
    /**
     * The identifier of the originating request.
     */
    id: number;

    /**
     * The type of response.
     */
    type: "step";

    /**
     * The simulation tick counter after the call.
     */
    tick: number;

    /**
     * The number of grain movements performed.
     */
    moves: number;

    /**
     * The number of cell probes performed - the quantity maxWork budgets. Divide a
     * measured wall-clock time by this to calibrate a probes-per-millisecond rate.
     */
    work: number;

    /**
     * How many ticks completed.
     */
    ticks: number;

    /**
     * Whether every requested tick finished. False means the budget ran out with a tick
     * still open, which the next step request resumes.
     */
    complete: boolean;

    /**
     * Per-layer changes since the previous step response.
     */
    layers: PhysicsLayerDelta[];
}

/**
 * Acknowledges a request that produces no simulation output.
 */
export interface PhysicsAckResponse {
    /**
     * The identifier of the originating request.
     */
    id: number;

    /**
     * The type of response.
     */
    type: "ack";

    /**
     * The request type being acknowledged.
     */
    request: "attach" | "edit" | "inject";
}

/**
 * A request the runner could not process.
 *
 * A response rather than a thrown exception, for the same reason the mesher gives one:
 * an exception escaping a worker's message handler posts nothing, and a caller waiting
 * on the request id then waits forever. The realistic ways to get one are a step or
 * edit arriving before attach, an inject naming a layer that does not exist, and an
 * attach whose world bytes do not decode.
 */
export interface PhysicsErrorResponse {
    /**
     * The identifier of the originating request, or -1 when the request was too
     * malformed to carry one.
     */
    id: number;

    /**
     * The type of response.
     */
    type: "error";

    /**
     * What went wrong.
     */
    message: string;
}

/**
 * Union of all physics runner response types.
 */
export type PhysicsResponse = PhysicsStepResponse | PhysicsAckResponse | PhysicsErrorResponse;

/**
 * BVXPhysicsRunner owns a VoxelPhysics simulation and drives it from messages. It is
 * free of any DOM or Worker dependency, so the same implementation runs on the main
 * thread, in a Web Worker (see BVXPhysicsHost) or in a Node.js worker thread.
 *
 * ## Why this is not shaped like BVXMesher
 *
 * BVXMesher is stateless: every request carries a world snapshot, and the mesher
 * rebuilds the world, meshes it and throws it away. That cannot work for physics, for
 * three reasons the source makes plain:
 *
 * - The solver's state is not serializable. A PhysicsVoxelChunk carries active and
 *   moved bit masks and the layer carries an active set and a dirty set, none of which
 *   BVXSerializer round-trips - it reconstructs plain VoxelChunk types only.
 * - Round-tripping would destroy dormancy. VoxelPhysicsLayer.importWorld documents that
 *   imported grains arrive awake, so a snapshot-per-tick protocol would wake every grain
 *   every tick and turn a settled pool from free into the most expensive thing running.
 * - The cost is per tick, not per edit. Serializing every layer thirty times a second
 *   is not a budget anyone has.
 *
 * So the runner owns the simulation instead. It is seeded once and afterwards receives
 * only edits and emits only deltas, which means traffic is proportional to what moved.
 * A settled scene sends nothing - the protocol inherits the solver's dormancy rather
 * than fighting it.
 *
 * ## Placing this against the mesher
 *
 * The mesher needs live layer occupancy to cull hidden contact faces between layers
 * (see VoxelFaceGeometry.computeIndices). Putting the solver in one worker and the
 * mesher in another therefore creates a per-tick data dependency between them. The
 * arrangement that avoids it is to let this runner mesh its own dirty chunks - it
 * already holds every layer and the collision world locally, so occluders cost it
 * nothing - and leave the streaming frontier to a separate mesher pool.
 */
export class BVXPhysicsRunner {
    /**
     * The simulation, or null before an attach request.
     */
    private _physics: VoxelPhysics | null;

    /**
     * The registered layers, indexed as the attach request declared them.
     */
    private _layers: VoxelPhysicsLayer[];

    /**
     * Reused key for chunk lookups against the collision world.
     */
    private readonly _key: MortonKey;

    /**
     * Reused index for BitVoxel lookups within a chunk.
     */
    private readonly _index: VoxelIndex;

    /**
     * Reused set for draining a layer's dirty chunks.
     */
    private readonly _drained: Set<number>;

    constructor() {
        this._physics = null;
        this._layers = [];
        this._key = new MortonKey();
        this._index = new VoxelIndex();
        this._drained = new Set<number>();
    }

    /**
     * Returns the simulation, or null before an attach request.
     */
    public get physics(): VoxelPhysics | null {
        return this._physics;
    }

    /**
     * Returns the registered layers, indexed as the attach request declared them.
     */
    public get layers(): readonly VoxelPhysicsLayer[] {
        return this._layers;
    }

    /**
     * Processes a single request and returns the corresponding response.
     *
     * @param request - The PhysicsRequest to process.
     * @returns - The generated PhysicsResponse.
     * @throws - Error if a request other than attach arrives before the runner is attached.
     */
    public process(request: PhysicsRequest): PhysicsResponse {
        if (request.type === "attach") {
            return this._Attach(request);
        }

        const physics: VoxelPhysics | null = this._physics;

        if (physics === null) {
            throw new Error(`BVXPhysicsRunner.process(PhysicsRequest) - received a '${request.type}' request before an 'attach' request`);
        }

        if (request.type === "edit") {
            return this._Edit(physics, request);
        }

        if (request.type === "inject") {
            return this._Inject(request);
        }

        return this._Step(physics, request);
    }

    /**
     * Collects the transferable ArrayBuffers of a PhysicsResponse, for zero-copy
     * postMessage() calls.
     *
     * @param response - The PhysicsResponse to collect buffers from.
     * @returns - The list of transferable ArrayBuffers.
     */
    public static transferables(response: PhysicsResponse): ArrayBuffer[] {
        if (response.type !== "step") {
            return [];
        }

        const buffers: ArrayBuffer[] = [];

        for (let i = 0; i < response.layers.length; i++) {
            const delta: PhysicsLayerDelta = response.layers[i];

            buffers.push(delta.keys.buffer as ArrayBuffer, delta.removed.buffer as ArrayBuffer);

            for (let c = 0; c < delta.chunks.length; c++) {
                buffers.push(delta.chunks[c].buffer as ArrayBuffer);
            }
        }

        return buffers;
    }

    /**
     * Builds the simulation described by an attach request, discarding any previous one.
     */
    private _Attach(request: PhysicsAttachRequest): PhysicsAckResponse {
        const base: VoxelWorld = request.base !== undefined ? BVXSerializer.loadWorld(request.base) : new VoxelWorld();
        const physics: VoxelPhysics = new VoxelPhysics(base, request.bounds ?? null);
        const layers: VoxelPhysicsLayer[] = [];

        for (let i = 0; i < request.layers.length; i++) {
            const layer: VoxelPhysicsLayer = physics.addLayer(request.layers[i]);
            const grains: Uint8Array | null | undefined = request.grains?.[i];

            if (grains !== undefined && grains !== null) {
                layer.importWorld(BVXSerializer.loadWorld(grains));
            }

            layers.push(layer);
        }

        this._physics = physics;
        this._layers = layers;

        return { id: request.id, type: "ack", request: "attach" };
    }

    /**
     * Applies BitVoxel changes to the collision world and wakes what they can reach.
     */
    private _Edit(physics: VoxelPhysics, request: PhysicsEditRequest): PhysicsAckResponse {
        const set: Int32Array | undefined = request.set;
        const unset: Int32Array | undefined = request.unset;

        if (set !== undefined) {
            for (let i = 0; i + 2 < set.length; i += 3) {
                this._SetBase(physics.base, set[i], set[i + 1], set[i + 2], true);
            }
        }

        if (unset !== undefined) {
            for (let i = 0; i + 2 < unset.length; i += 3) {
                this._SetBase(physics.base, unset[i], unset[i + 1], unset[i + 2], false);
            }
        }

        // A change to the collision world does not wake grains on its own - the layers
        // only wake automatically for their own set/unset calls - so the region has to
        // be woken explicitly, which is what VoxelPhysics.wakeRegion exists for.
        this._WakeEdited(physics, set);
        this._WakeEdited(physics, unset);

        return { id: request.id, type: "ack", request: "edit" };
    }

    /**
     * Sets or clears one BitVoxel of the collision world, creating the chunk on demand.
     */
    private _SetBase(base: VoxelWorld, x: number, y: number, z: number, state: boolean): void {
        MortonKey.from(x >> 4, y >> 4, z >> 4, this._key);

        let chunk: VoxelChunk | null = base.get(this._key);

        if (chunk === null) {
            // nothing to clear in a chunk that does not exist
            if (!state) {
                return;
            }

            chunk = new VoxelChunk0(this._key.clone());
            base.insert(chunk);
        }

        const lx: number = x & 15;
        const ly: number = y & 15;
        const lz: number = z & 15;

        VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, this._index);

        if (state) {
            chunk.setBitVoxel(this._index);
        }
        else {
            chunk.unsetBitVoxel(this._index);
        }
    }

    /**
     * Wakes the cells touched by a coordinate list.
     */
    private _WakeEdited(physics: VoxelPhysics, coordinates: Int32Array | undefined): void {
        if (coordinates === undefined) {
            return;
        }

        for (let i = 0; i + 2 < coordinates.length; i += 3) {
            const x: number = coordinates[i];
            const y: number = coordinates[i + 1];
            const z: number = coordinates[i + 2];

            physics.wakeRegion(x, y, z, x, y, z);
        }
    }

    /**
     * Adds or removes grains in one layer.
     */
    private _Inject(request: PhysicsInjectRequest): PhysicsAckResponse {
        const layer: VoxelPhysicsLayer | undefined = this._layers[request.layer];

        if (layer === undefined) {
            throw new RangeError(`BVXPhysicsRunner.process(PhysicsInjectRequest) - no layer at index ${request.layer}`);
        }

        const set: Int32Array | undefined = request.set;
        const unset: Int32Array | undefined = request.unset;

        if (set !== undefined) {
            for (let i = 0; i + 2 < set.length; i += 3) {
                layer.set(set[i], set[i + 1], set[i + 2]);
            }
        }

        if (unset !== undefined) {
            for (let i = 0; i + 2 < unset.length; i += 3) {
                layer.unset(unset[i], unset[i + 1], unset[i + 2]);
            }
        }

        return { id: request.id, type: "ack", request: "inject" };
    }

    /**
     * Advances the simulation and encodes what changed.
     */
    private _Step(physics: VoxelPhysics, request: PhysicsStepRequest): PhysicsStepResponse {
        const result: PhysicsStepResult = physics.update(request.ticks ?? 1, request.maxWork ?? 0);
        const layers: PhysicsLayerDelta[] = [];

        for (let i = 0; i < this._layers.length; i++) {
            layers.push(this._Drain(i, this._layers[i]));
        }

        return {
            id: request.id,
            type: "step",
            tick: result.tick,
            moves: result.moves,
            work: result.work,
            ticks: result.ticks,
            complete: result.complete,
            layers
        };
    }

    /**
     * Encodes one layer's dirty chunks. A dirty key whose chunk is gone from the layer
     * world is reported as removed rather than as an empty payload, so a renderer can
     * release the mesh instead of rebuilding an empty one.
     */
    private _Drain(index: number, layer: VoxelPhysicsLayer): PhysicsLayerDelta {
        const dirty: Set<number> = this._drained;

        dirty.clear();
        layer.drainDirtyChunks(dirty);

        const keys: number[] = [];
        const chunks: Uint8Array[] = [];
        const removed: number[] = [];

        for (const encoded of dirty) {
            this._key.key = encoded;

            const chunk: VoxelChunk | null = layer.world.get(this._key);

            if (chunk === null) {
                removed.push(encoded);

                continue;
            }

            keys.push(encoded);
            chunks.push(BVXSerializer.saveChunk(chunk));
        }

        return {
            layer: index,
            keys: Uint32Array.from(keys),
            chunks,
            removed: Uint32Array.from(removed)
        };
    }
}
