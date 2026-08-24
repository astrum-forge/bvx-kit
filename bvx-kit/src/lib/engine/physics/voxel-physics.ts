import { VoxelChunkArena } from "../chunks/voxel-chunk-arena.js";
import { VoxelWorld } from "../voxel-world.js";
import { VoxelPhysicsLayer, VoxelPhysicsParams } from "./voxel-physics-layer.js";

/**
 * Options for a VoxelPhysics simulation. All coordinates are inclusive global
 * BitVoxel coordinates. Cells outside the bounds behave as solid, forming the
 * simulation floor and walls - grains rest at minY and cannot leave the region.
 */
export interface VoxelPhysicsOptions {
    /**
     * The minimum simulation bound per axis. Defaults to 0.
     */
    minX?: number;
    minY?: number;
    minZ?: number;

    /**
     * The maximum simulation bound per axis. Defaults to 16383, the full
     * addressable MortonKey space (1024 chunks of 16 BitVoxels).
     */
    maxX?: number;
    maxY?: number;
    maxZ?: number;
}

/**
 * VoxelPhysics coordinates falling-grain simulation layers (sand, dirt,
 * liquids) on top of a static base VoxelWorld. The base world is never
 * modified - it acts as immovable collision geometry - and the existing
 * engine carries zero cost when physics is not used, as the simulation is
 * entirely additive.
 *
 * The simulation is advanced explicitly by the application - typically once
 * per rendering frame or on a fixed timestep:
 *
 * ```typescript
 * const physics = new VoxelPhysics(world, { maxX: 127, maxY: 127, maxZ: 127 });
 * const sand = physics.addLayer(VoxelPhysics.SAND);
 * const water = physics.addLayer(VoxelPhysics.WATER);
 *
 * sand.set(10, 40, 10); // drop a grain of sand
 *
 * // inside the application's update loop:
 * physics.update();
 *
 * // remesh whatever moved - each layer's world renders like any other
 * for (const chunkKey of sand.drainDirtyChunks()) {
 *     remesh(sand.world, chunkKey);
 * }
 * ```
 *
 * Layers interact with one another: every layer's grains collide with the
 * base world and with every other layer, and a denser grain falling onto a
 * lighter one displaces it (sand sinks through water). Layers step in
 * descending density order each tick so displacement resolves consistently.
 */
export class VoxelPhysics {
    /**
     * Parameter preset for granular material such as sand or dirt - falls,
     * slides diagonally into piles and sinks through lighter liquids.
     */
    public static readonly SAND: VoxelPhysicsParams = { slide: true, flow: false, density: 2 };

    /**
     * Parameter preset for liquids such as water - falls, slides and flows
     * laterally toward reachable drop-offs, settling into dormant pools.
     */
    public static readonly WATER: VoxelPhysicsParams = { slide: true, flow: true, flowDistance: 8, density: 1 };

    /**
     * The default maximum simulation bound - the full addressable MortonKey
     * space of 1024 chunks x 16 BitVoxels per axis.
     */
    private static readonly DEFAULT_MAX: number = (1024 * 16) - 1;

    /**
     * The static base world acting as immovable collision geometry.
     */
    private readonly _base: VoxelWorld;

    /**
     * The registered simulation layers in insertion order.
     */
    private readonly _layers: VoxelPhysicsLayer[];

    /**
     * The registered simulation layers in descending density order - the
     * stepping order. Rebuilt when layers are added.
     */
    private readonly _stepOrder: VoxelPhysicsLayer[];

    /**
     * Inclusive simulation bounds in global BitVoxel coordinates.
     */
    private readonly _minX: number;
    private readonly _minY: number;
    private readonly _minZ: number;
    private readonly _maxX: number;
    private readonly _maxY: number;
    private readonly _maxZ: number;

    /**
     * The global simulation tick counter.
     */
    private _tick = 0;

    /**
     * The index into the stepping order of the layer a budgeted call stopped part-way
     * through, so the next call resumes the same tick there. -1 when no tick is open.
     */
    private _resumeLayer = -1;

    /**
     * The largest flowDistance across all registered flow layers, or 0 when no
     * layer flows. Determines how far lateral vacancy wakes must propagate.
     */
    private _maxFlowDistance = 0;

    /**
     * Constructs a new physics simulation over the provided base world.
     *
     * @param base - The static VoxelWorld acting as collision geometry. Never modified.
     * @param options - (Optional) The simulation bounds (see VoxelPhysicsOptions).
     */
    constructor(base: VoxelWorld, options: VoxelPhysicsOptions | null = null) {
        this._base = base;
        this._layers = [];
        this._stepOrder = [];

        this._minX = options?.minX ?? 0;
        this._minY = options?.minY ?? 0;
        this._minZ = options?.minZ ?? 0;
        this._maxX = options?.maxX ?? VoxelPhysics.DEFAULT_MAX;
        this._maxY = options?.maxY ?? VoxelPhysics.DEFAULT_MAX;
        this._maxZ = options?.maxZ ?? VoxelPhysics.DEFAULT_MAX;
    }

    /**
     * Returns the static base world acting as collision geometry.
     */
    public get base(): VoxelWorld {
        return this._base;
    }

    /**
     * Returns the registered simulation layers in insertion order.
     */
    public get layers(): readonly VoxelPhysicsLayer[] {
        return this._layers;
    }

    /**
     * Returns the global simulation tick counter.
     */
    public get tick(): number {
        return this._tick;
    }

    // Inclusive simulation bounds in global BitVoxel coordinates

    public get minX(): number {
        return this._minX;
    }

    public get minY(): number {
        return this._minY;
    }

    public get minZ(): number {
        return this._minZ;
    }

    public get maxX(): number {
        return this._maxX;
    }

    public get maxY(): number {
        return this._maxY;
    }

    public get maxZ(): number {
        return this._maxZ;
    }

    /**
     * Returns whether a tick is part-way through, because a previous update() ran out
     * of budget inside it. The next update() continues that tick before starting a new
     * one, and tick does not advance until it completes.
     */
    public get tickInProgress(): boolean {
        return this._resumeLayer >= 0;
    }

    /**
     * Returns the largest flowDistance across all registered flow layers, or 0
     * when no layer flows. Used internally to bound lateral vacancy wakes.
     */
    public get maxFlowDistance(): number {
        return this._maxFlowDistance;
    }

    /**
     * Creates and registers a new simulation layer.
     *
     * @param params - (Optional) The layer behaviour (see VoxelPhysicsParams).
     * Use the VoxelPhysics.SAND and VoxelPhysics.WATER presets for common materials.
     * @param arena - (Optional) An arena to allocate this layer's chunk occupancy from.
     * Over a SharedArrayBuffer this is what lets a mesher in another agent read the
     * layer's grains with no serialization - the runner posts slot indices and the
     * worker binds views over the same memory. Read VoxelChunkArena's concurrency
     * section first: the arena makes the memory reachable, not the access safe.
     * @returns - The new VoxelPhysicsLayer.
     */
    public addLayer(params: VoxelPhysicsParams | null = null, arena: VoxelChunkArena | null = null): VoxelPhysicsLayer {
        const layer: VoxelPhysicsLayer = new VoxelPhysicsLayer(this, params, arena);

        this._layers.push(layer);

        // maintain the stepping order - densest layers step first so
        // displacement (sinking) resolves before lighter layers move
        this._stepOrder.push(layer);
        this._stepOrder.sort((a, b) => b.density - a.density);

        if (layer.flow) {
            this._maxFlowDistance = Math.max(this._maxFlowDistance, layer.flowDistance);
        }

        return layer;
    }

    /**
     * Advances the simulation. Each tick moves every active grain by at most one cell.
     * Call this from the application's update loop - once per frame or on a fixed
     * timestep. With no active grains the call is effectively free.
     *
     * ## The budget paces the work; it does not change the simulation
     *
     * A collapsing pile wakes a large region at once, so tick cost is spiky - peaks run
     * around ten times the mean. `maxWork` caps what one call performs: the sweep stops
     * once the budget is spent and *records where it stopped*, and the next call
     * continues the same tick from there. The tick counter does not advance until the
     * tick completes.
     *
     * This is the property that matters: for a given world, the sequence of grain
     * movements is identical at every budget. A budget changes how many calls a tick
     * takes, never what the tick computes. Check `complete` to know whether a tick is
     * still open.
     *
     * The budget is denominated in cell probes rather than milliseconds so that a given
     * input produces the same simulation on every machine, and rather than in grain
     * movements because movements do not predict cost - the expensive grains are the
     * ones that do NOT move. A grain with nowhere to go still pays for every probe that
     * discovered as much, and for a flowing layer that search is the most expensive
     * thing the solver does. Measured on a collapsing lake, a tick doing 6,000
     * movements took 10.2 ms while one doing 21,620 took 32.8 ms - a spread no movement
     * budget can bound. Probes are near-perfectly linear in time; convert a target frame
     * time by measuring the local probes-per-millisecond once and multiplying.
     *
     * @param ticks - (Optional) The number of simulation ticks to advance. Defaults to 1.
     * A tick left open by a previous budgeted call is finished first and counts as one
     * of them.
     * @param maxWork - (Optional) Stop once this many cell probes have been performed
     * across the whole call. 0 or less means no limit, which is the default.
     * @returns - What the call achieved (see PhysicsStepResult).
     */
    public update(ticks = 1, maxWork = 0): PhysicsStepResult {
        const stepOrder: VoxelPhysicsLayer[] = this._stepOrder;
        const budgeted: boolean = maxWork > 0;

        let moves = 0;
        let work = 0;
        let completed = 0;

        for (let i = 0; i < ticks; i++) {
            const tick: number = this._tick;

            let interrupted = false;

            const from: number = this._resumeLayer < 0 ? 0 : this._resumeLayer;

            for (let l = from; l < stepOrder.length; l++) {
                const layer: VoxelPhysicsLayer = stepOrder[l];

                // The whole remaining budget goes to each layer in turn. Splitting it
                // between the layers still to step used to be necessary, back when a
                // budget that ran out skipped them: the densest layer could spend
                // everything and leave water - typically the one actually moving - with
                // no tick at all. A resumable sweep removes that failure outright,
                // because the tick is not finished until every layer has stepped, so
                // splitting now only fragments calls that could have completed.
                const remaining: number = budgeted ? Math.max(1, maxWork - work) : 0;

                const finished: boolean = layer.step(tick, remaining);

                moves += layer.movesPerformed;
                work += layer.workPerformed;

                if (!finished) {
                    this._resumeLayer = l;
                    interrupted = true;

                    break;
                }

                if (budgeted && work >= maxWork && l + 1 < stepOrder.length) {
                    // the budget is gone but this layer finished cleanly - resume the
                    // same tick at the next layer
                    this._resumeLayer = l + 1;
                    interrupted = true;

                    break;
                }
            }

            if (interrupted) {
                return { ticks: completed, moves: moves, work: work, complete: false, tick: this._tick };
            }

            this._resumeLayer = -1;
            this._tick++;
            completed++;

            if (budgeted && work >= maxWork && i + 1 < ticks) {
                return { ticks: completed, moves: moves, work: work, complete: false, tick: this._tick };
            }
        }

        return { ticks: completed, moves: moves, work: work, complete: true, tick: this._tick };
    }

    /**
     * Wakes all grains in and directly around the provided region (inclusive
     * global BitVoxel coordinates). Call this after modifying the base world -
     * for example removing ground - so resting grains above and beside the
     * change re-evaluate their support. Layer set()/unset() calls wake
     * automatically and do not require this.
     *
     * @param minX - The minimum x-coordinate of the changed region.
     * @param minY - The minimum y-coordinate of the changed region.
     * @param minZ - The minimum z-coordinate of the changed region.
     * @param maxX - The maximum x-coordinate of the changed region.
     * @param maxY - The maximum y-coordinate of the changed region.
     * @param maxZ - The maximum z-coordinate of the changed region.
     */
    public wakeRegion(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
        // expand by one cell so grains adjacent to the region re-evaluate too
        const lowX: number = Math.max(this._minX, minX - 1);
        const lowY: number = Math.max(this._minY, minY - 1);
        const lowZ: number = Math.max(this._minZ, minZ - 1);
        const highX: number = Math.min(this._maxX, maxX + 1);
        const highY: number = Math.min(this._maxY, maxY + 1);
        const highZ: number = Math.min(this._maxZ, maxZ + 1);

        const layers: VoxelPhysicsLayer[] = this._layers;

        for (let x = lowX; x <= highX; x++) {
            for (let y = lowY; y <= highY; y++) {
                for (let z = lowZ; z <= highZ; z++) {
                    for (let l = 0; l < layers.length; l++) {
                        layers[l].wake(x, y, z);
                    }
                }
            }
        }
    }
}

/**
 * What an update() call achieved.
 */
export interface PhysicsStepResult {
    /**
     * How many ticks completed. A budgeted call that ran out part-way through a tick
     * reports the ticks that did finish, not the one still open.
     */
    ticks: number;

    /**
     * How many grains moved.
     */
    moves: number;

    /**
     * How many cell probes were performed - the quantity maxWork budgets.
     */
    work: number;

    /**
     * Whether every requested tick finished. False means the budget ran out with a tick
     * still open; the next update() continues it, and the simulation is behind rather
     * than settled.
     */
    complete: boolean;

    /**
     * The simulation tick counter after the call.
     */
    tick: number;
}
