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
     * Whether the most recent update() stopped on its move budget rather than
     * running out of work.
     */
    private _budgetExceeded = false;

    /**
     * The largest flowDistance across all registered flow layers, or 0 when no
     * layer flows. Determines how far lateral vacancy wakes must propagate.
     */
    private _maxFlowDistance = 0;

    /**
     * Whether lateral flow-line wakes are required this tick. Only true when a
     * dormant flow-layer grain exists somewhere - with every flow grain awake
     * (or none present), skipping the wake scans is exactly equivalent.
     */
    private _flowWakeNeeded = false;

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
     * Returns whether the most recent update() stopped on its move budget with work
     * still outstanding, rather than because everything that could move had moved.
     *
     * A caller running its own fixed-step accumulator can use this to decide whether
     * to keep ticking - the simulation is behind, not settled.
     */
    public get budgetExceeded(): boolean {
        return this._budgetExceeded;
    }

    /**
     * Returns the largest flowDistance across all registered flow layers, or 0
     * when no layer flows. Used internally to bound lateral vacancy wakes.
     */
    public get maxFlowDistance(): number {
        return this._maxFlowDistance;
    }

    /**
     * Returns whether lateral flow-line wakes are required this tick. Used
     * internally by the layer solvers.
     */
    public get flowWakeNeeded(): boolean {
        return this._flowWakeNeeded;
    }

    /**
     * Notifies the coordinator that a flow-layer grain settled this tick, which
     * enables flow-line wakes for the remainder of the tick. Called internally
     * by the layer solvers.
     */
    public notifyFlowSettled(): void {
        this._flowWakeNeeded = true;
    }

    /**
     * Creates and registers a new simulation layer.
     *
     * @param params - (Optional) The layer behaviour (see VoxelPhysicsParams).
     * Use the VoxelPhysics.SAND and VoxelPhysics.WATER presets for common materials.
     * @returns - The new VoxelPhysicsLayer.
     */
    public addLayer(params: VoxelPhysicsParams | null = null): VoxelPhysicsLayer {
        const layer: VoxelPhysicsLayer = new VoxelPhysicsLayer(this, params);

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
     * Advances the simulation. Each step moves every active grain by at most
     * one cell. Call this from the application's update loop - once per frame
     * or on a fixed timestep. With no active grains the call is effectively free.
     *
     * A collapsing pile wakes a large region at once, so tick cost is spiky - peaks
     * run around ten times the mean. Passing a move budget caps the work a single
     * call performs: the sweep stops once the budget is spent, and the chunks it did
     * not reach stay awake and are swept by the following call. The collapse then
     * resolves over several ticks instead of one long one, which trades a little
     * settling latency for a bounded cost per call.
     *
     * The budget is denominated in grain movements rather than milliseconds so that
     * a given input produces the same simulation on every machine. Cost is close to
     * linear in movements, so a target frame budget converts directly - measure the
     * local movements-per-second once and multiply.
     *
     * When a budget cuts a tick short, the layers that had not yet stepped are skipped
     * for that tick, so cross-layer displacement resolves a tick later than it
     * otherwise would. Check budgetExceeded to detect this.
     *
     * @param steps - (Optional) The number of simulation ticks to advance. Defaults to 1.
     * @param maxMoves - (Optional) Stop once this many grains have moved across the
     * whole call. 0 or less means no limit, which is the default and the previous
     * behaviour.
     * @returns - The total number of grain movements performed.
     */
    public update(steps = 1, maxMoves = 0): number {
        const stepOrder: VoxelPhysicsLayer[] = this._stepOrder;
        const budgeted: boolean = maxMoves > 0;

        let moves = 0;

        this._budgetExceeded = false;

        for (let i = 0; i < steps; i++) {
            const tick: number = this._tick;

            // flow-line wakes are only needed while dormant flow grains exist -
            // a flow grain settling mid-tick re-enables them via notifyFlowSettled()
            this._flowWakeNeeded = false;

            for (let l = 0; l < stepOrder.length; l++) {
                const layer: VoxelPhysicsLayer = stepOrder[l];

                if (layer.flow && layer.hasDormantGrains) {
                    this._flowWakeNeeded = true;

                    break;
                }
            }

            for (let l = 0; l < stepOrder.length; l++) {
                // hand each layer what is left of the budget, so the cap applies
                // across the whole call rather than per layer
                moves += stepOrder[l].step(tick, budgeted ? maxMoves - moves : 0);

                if (budgeted && moves >= maxMoves) {
                    this._budgetExceeded = true;

                    break;
                }
            }

            this._tick++;

            if (this._budgetExceeded) {
                break;
            }
        }

        return moves;
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
