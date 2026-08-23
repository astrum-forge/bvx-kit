import {
    ArcRotateCamera,
    Color3,
    Color4,
    Material,
    Matrix,
    Mesh,
    MeshBuilder,
    Scene,
    StandardMaterial,
    Vector3,
    VertexBuffer,
    VertexData,
    WebGPUEngine,
    type CascadedShadowGenerator
} from "@babylonjs/core";
import { BVX_AO_KIND, GhibliToonPlugin, GhibliWaterPlugin } from "./ghibli";
import { createRenderStack, type RenderStack } from "./render-stack";
import {
    BVXSerializer,
    MortonKey,
    VoxelChunk0,
    VoxelChunk16,
    VoxelIndex,
    VoxelPhysics,
    VoxelPhysicsLayer,
    VoxelWorld,
    type SmoothOcclusionMode,
    type VoxelChunk
} from "@astrumforge/bvx-kit";
import type { EditorMeshRequest, EditorMeshResponse, BlockyMeshResponse } from "./mesh-protocol";
import { BIT_VOXEL_SIZE } from "./units";
import { MesherPool } from "./mesher-pool";
import { PALETTE } from "./palette";

/**
 * The active editing tool. Paint/erase/pick operate on the static base world,
 * sand/water paint grains into the corresponding physics layer.
 */
export type EditorTool = "paint" | "erase" | "pick" | "sand" | "water";

/**
 * The active rendering mode for BitVoxel geometry.
 */
/**
 * How chunk geometry is rendered.
 *
 * - `blocky` - one shaded quad per visible BitVoxel face
 * - `smooth` - surface nets over the blurred occupancy field
 * - `wireframe` - the outline of each visible face, unlit and unshaded
 *
 * `wireframe` meshes from the same face masks as `blocky`, so the two agree exactly
 * about which faces exist.
 */
export type RenderMode = "blocky" | "smooth" | "wireframe";

/**
 * Live scene statistics published to the UI.
 */
export interface EditorStats {
    chunks: number;
    bitVoxels: number;
    triangles: number;
    workers: number;
    sandGrains: number;
    waterGrains: number;
    activeGrains: number;

    /**
     * Rendered frames per second, smoothed by the engine's own performance
     * monitor.
     */
    fps: number;

    /**
     * Smoothed milliseconds the main thread spends inside a rendered frame -
     * scene traversal, physics, meshing uploads and command encoding. The
     * budget is 16.7 ms at 60 Hz.
     */
    cpuFrameTime: number;

    /**
     * Meshes the scene submitted geometry for in the last frame, after frustum
     * culling. Each is drawn again per shadow cascade and once more into the
     * occlusion pre-pass, so this is the count that batching would divide.
     *
     * Deliberately not BabylonJS's own drawCallsCounter: with
     * compatibilityMode = false the draws are replayed from cached render
     * bundles rather than re-encoded, so that counter reads zero here and would
     * be worse than no number at all.
     */
    drawnMeshes: number;
}

/**
 * A single undoable brush stroke - byte snapshots of every touched base-world
 * chunk before and after the stroke (null = the chunk did not exist). Physics
 * grains are transient simulation state and are not undo-tracked.
 */
interface StrokeRecord {
    before: Map<number, Uint8Array | null>;
    after: Map<number, Uint8Array | null>;
}

/**
 * One renderable world - the base world or a physics layer - with its own
 * meshes, meshing bookkeeping and colouring rules.
 */
interface MeshLane {
    /**
     * Lane identifier, used in mesh names.
     */
    id: string;

    /**
     * Resolves the lane's current VoxelWorld (physics worlds are recreated on
     * scene resets).
     */
    world: () => VoxelWorld;

    /**
     * Renderable mesh and triangle count per chunk key.
     */
    meshes: Map<number, Mesh>;
    triangles: Map<number, number>;

    /**
     * How much each chunk mesh's vertex and index buffers were sized for, which
     * is deliberately more than the geometry that was in them.
     *
     * Babylon's setVerticesData always allocates a new VertexBuffer and releases
     * the old one, so re-uploading a chunk through VertexData.applyToMesh means
     * a fresh set of WebGPU buffers every remesh: measured over a full remesh of
     * this region's 499 chunks, 5,817 device buffer allocations and 38.8 MB.
     * Growing the buffers past what the chunk needs lets the common case take
     * updateVerticesData instead, which writes into the buffer already there.
     */
    capacity: Map<number, { vertices: number, indices: number }>;

    /**
     * Chunks that want a remesh but have not been sent to a worker yet.
     *
     * Nothing is serialized when a chunk is queued - only when the frame's
     * meshing budget reaches it. That is the point: a physics tick can dirty
     * over a hundred chunks at once, and each request costs about 0.17 ms of
     * synchronous serialization on this thread, so honouring a whole drain
     * immediately is a twenty-millisecond stall. Queueing also coalesces - a
     * chunk dirtied on three successive ticks before the budget reaches it is
     * serialized once, from its latest state.
     */
    pending: Set<number>;

    /**
     * Meshing bookkeeping - chunks with a request in flight and chunks that
     * were re-dirtied while their request was still running (latest-wins).
     */
    inFlight: Set<number>;
    dirtyAgain: Set<number>;

    /**
     * Flat vertex colour for the lane, or null to colour from voxel meta-data
     * (the base lane).
     */
    color: [number, number, number] | null;

    /**
     * Shared material for all of the lane's meshes.
     */
    material: StandardMaterial;

    /**
     * Shared unlit line-list material used by the wireframe render mode.
     */
    wireMaterial: StandardMaterial;

    /**
     * Worlds whose occupancy occludes (culls) this lane's hidden geometry at
     * layer interfaces. Resolved lazily, as physics worlds are recreated on
     * scene resets. Occlusion is one-directional - water lists the opaque
     * lanes so its hidden contact faces are culled, while the opaque lanes
     * omit water so the ground stays visible through it.
     */
    occluders: (() => VoxelWorld)[];

    /**
     * How this lane claims blur-ambiguous smooth surface cells (see
     * VoxelSmoothGeometry) - "primary"/"secondary" partition the shared
     * surface between mutually-occluding opaque lanes, "overlay" suits the
     * translucent water skin.
     */
    occlusionMode: SmoothOcclusionMode;
}

/**
 * The editable region in chunks per axis (16 x 16 x 16 chunks = 256 BitVoxels per
 * axis, an eightfold volume increase over the original 8).
 *
 * What makes this affordable is the kit's uniform-chunk fast path: a chunk that is
 * entirely solid or entirely air is now recognised without sampling any of its 4096
 * BitVoxels, so it costs well under a microsecond to mesh instead of ~41. Growing the
 * region mostly adds exactly those chunks - open air above the terrain and solid
 * ground below it - so the cost of the extra volume is close to nothing.
 */
const REGION_CHUNKS = 16;

/**
 * The editable region in BitVoxels per axis.
 */
const REGION = REGION_CHUNKS * 16;

/**
 * The fixed physics timestep in Hz and the catch-up cap per rendered frame.
 */
const PHYSICS_RATE = 30;
const PHYSICS_MAX_TICKS_PER_FRAME = 4;

/**
 * Milliseconds per rendered frame the solver may spend.
 *
 * A collapsing pile wakes a large region at once, so tick cost is spiky - peaks run
 * around ten times the mean, and at the scale this region now allows an unbudgeted
 * tick can take tens of milliseconds and drop a frame.
 *
 * This is a wall-clock budget, converted per tick into the kit's work budget -
 * VoxelPhysics.update's maxWork, denominated in cell probes. Not its move budget,
 * which does not bound the cost: a grain that FAILS to move is not a move but
 * still pays for the probes that discovered it cannot, and for water that search
 * is the most expensive thing the solver does. Measured over a collapsing lake,
 * a tick doing 6,000 moves took 10.2 ms while one doing 21,620 took 32.8 ms.
 * Worse, the old 20,000-move constant was calibrated against a throughput of
 * 2.2-2.5 M moves/s when the measured rate is ~360 K/s, so it authorised roughly
 * 55 ms of solver per frame and never bound anything.
 *
 * Probes are the right unit because they are what the time goes on. Measured over
 * the same collapse, the spread of the per-millisecond rate is 0.15 for probes
 * against 0.53 for moves - three and a half times the predictive power - and
 * capping probes took the worst tick from 26.3 ms to 5.5 ms with nothing over
 * 8 ms, where capping moves at the same mean throughput left a 26 ms peak.
 *
 * Ticks stop as soon as the frame's budget is spent, and whatever stayed awake
 * carries over to the next frame, so a collapse resolves over more frames rather
 * than one long one. Total simulation work is unchanged - only its distribution.
 */
const PHYSICS_BUDGET_MS = 4.0;

/**
 * Starting estimate of solver throughput in cell probes per millisecond, replaced
 * by measurement after the first substantial tick. Deliberately below the ~51,000
 * measured on an M1, so the first spike of a session is under-budgeted rather
 * than over.
 */
const PHYSICS_WORK_PER_MS = 30000;

/**
 * Milliseconds per frame the main thread may spend on meshing, and the share of
 * that the applying half may take before the sending half gets the remainder.
 *
 * These are the numbers that decide whether a physics spike is a slow frame or a
 * freeze. A request costs about 0.17 ms of serialization here before it reaches a
 * worker, and applying a response costs a comparable amount of vertex building
 * plus a replacement of the mesh's GPU buffers. A collapsing water body dirties
 * over a hundred chunks in a single physics tick, so uncapped that drain is
 * upwards of twenty milliseconds landing between two frames.
 *
 * The two are one budget, not two: applying runs first and may use up to
 * MESH_APPLY_BUDGET_MS, then sending runs against what is left of
 * MESH_FRAME_BUDGET_MS. Splitting it this way stops a long backlog of responses
 * from starving new requests entirely, and vice versa.
 *
 * Sized against a 60 Hz frame with the solver alongside: 4 ms of meshing plus
 * PHYSICS_BUDGET_MS leaves the renderer its half of the 16.7 ms. Raising it makes
 * the simulation look more immediate and the frame time spikier; the queue drains
 * in full either way, just over more frames.
 */
const MESH_FRAME_BUDGET_MS = 4.0;
const MESH_APPLY_BUDGET_MS = 2.5;

/**
 * Flat colours for the physics lanes.
 */
const SAND_COLOR: [number, number, number] = [0.91, 0.76, 0.44];
const WATER_COLOR: [number, number, number] = [0.28, 0.56, 0.92];

/**
 * Line colours for the wireframe render mode, one per lane. Bright enough to read
 * against both the sky and the ground plane, and distinct enough to tell the base
 * world from the two physics layers at a glance.
 */
const WIRE_BASE_COLOR = Color3.FromHexString("#e8eef7");
const WIRE_SAND_COLOR = Color3.FromHexString("#ffc94d");
const WIRE_WATER_COLOR = Color3.FromHexString("#5cc8ff");

/**
 * Blocky face corner offsets, indexed by the VoxelFaceGeometry face bit index.
 * Corners are wound clockwise when viewed from outside - BabylonJS treats
 * clockwise faces as front-facing, including in right-handed scenes.
 */
const FACE_CORNERS: number[][][] = [
    [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]], // +x
    [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]], // -x
    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], // +y
    [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]], // -y
    [[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]], // +z
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]  // -z
];

/**
 * Blocky face normals, indexed by the VoxelFaceGeometry face bit index.
 */
const FACE_NORMALS: number[][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
];

/**
 * Occupancy buffer dimensions - one chunk plus a 3-cell border.
 *
 * The border used to be one cell, which is all the blocky path's exact corner
 * test needs. The smooth path samples a blurred copy of this field up to ~1.7
 * cells outside the surface, and reading past the border is what would make a
 * chunk's AO change depending on which chunk it was baked from.
 */
const OCC_BORDER = 3;
const OCC_DIMS = 16 + (OCC_BORDER * 2);
const OCC_STRIDE_Y = OCC_DIMS;
const OCC_STRIDE_Z = OCC_DIMS * OCC_DIMS;

/**
 * Distances along the surface normal, in BitVoxels, that the smooth path
 * samples the blurred occupancy field at, and how much each contributes.
 *
 * Deliberately short range. Broad occlusion is the screen-space pass's job
 * now; what it cannot do - and what a smooth voxel surface most needs - is
 * crisp darkening in the millimetre-scale creases between terrace steps.
 */
const SMOOTH_AO_TAPS: number[] = [0.50, 1.05, 1.65];
const SMOOTH_AO_WEIGHTS: number[] = [0.45, 0.33, 0.22];

/**
 * The sampled-field values that map to "fully open" and "fully enclosed".
 * A flat exposed surface still reads well above zero, because half of the
 * trilinear neighbourhood a hair outside the surface is the surface itself, so
 * the low end is lifted to keep open ground from tinting.
 */
const SMOOTH_AO_OPEN = 0.16;
const SMOOTH_AO_CLOSED = 0.72;

/**
 * The same mapping for the water lane's shoreline mask, read at the vertex
 * rather than swept along the normal. A wider band, because surf should reach
 * a little way out from the bank rather than hug it.
 */
const SHORE_OPEN = 0.02;
const SHORE_CLOSED = 0.55;

/**
 * How far a smooth vertex's colour is pulled toward the average of its
 * one-ring neighbours.
 *
 * Surface-nets vertices take their colour from the nearest solid corner of
 * their cell, which snaps hard from one palette entry to the next along a
 * material boundary and speckles wherever the two interleave. One relaxation
 * pass over the triangle topology turns that into a one-vertex-wide blend -
 * a painted transition rather than a jagged one - for the cost of a single
 * walk over the index buffer.
 */
const SMOOTH_COLOR_RELAX = 0.55;


/**
 * Camera limits.
 */
const CAMERA_MIN_RADIUS = 2;
const CAMERA_MAX_RADIUS = REGION * BIT_VOXEL_SIZE * 4;
const CAMERA_MIN_BETA = 0.05;
const CAMERA_MAX_BETA = Math.PI - 0.05;

/**
 * VoxelEditor owns the BabylonJS scene, the bvx-kit VoxelWorld, the physics
 * simulation and the meshing worker pool. It handles painting, erasing, colour
 * picking, sand/water simulation, undo/redo, save/load and keeps one
 * renderable mesh per chunk per lane up to date.
 */
export class VoxelEditor {
    private readonly _canvas: HTMLCanvasElement;
    private readonly _engine: WebGPUEngine;
    private readonly _scene: Scene;

    private readonly _camera: ArcRotateCamera;
    private readonly _pool: MesherPool;
    private readonly _resizeObserver: ResizeObserver;

    // lights, shadows, ground, sky and the post chain
    private readonly _render: RenderStack;
    private readonly _shadows: CascadedShadowGenerator;

    // direction toward the sun - drives the water glints and the sky dome
    private readonly _sunDirection: Vector3;

    // manual camera navigation state
    private _navMode: "none" | "orbit" | "pan" = "none";
    private _navPointerId = -1;
    private _navLastX = 0;
    private _navLastY = 0;
    private _trackpadUntil = 0;

    // camera framing glide (F key)
    private _cameraGoal: { target: Vector3, radius: number } | null = null;

    private _world: VoxelWorld = new VoxelWorld();

    // physics simulation over the base world
    private _physics!: VoxelPhysics;
    private _sand!: VoxelPhysicsLayer;
    private _water!: VoxelPhysicsLayer;
    private _playing = true;
    private _physicsAccumulator = 0;
    private _physicsWasMoving = false;

    // measured solver throughput in cell probes per millisecond, used to turn the
    // frame's wall-clock physics budget into the work cap VoxelPhysics.update takes
    private _workPerMs = PHYSICS_WORK_PER_MS;

    // renderable lanes - base world plus one per physics layer
    private readonly _baseLane: MeshLane;
    private readonly _sandLane: MeshLane;
    private readonly _waterLane: MeshLane;
    private readonly _lanes: MeshLane[];

    // undo/redo stacks of stroke records (base world only)
    private readonly _undoStack: StrokeRecord[] = [];
    private readonly _redoStack: StrokeRecord[] = [];

    // the stroke currently being painted, if any - physics strokes carry no
    // undo record but are still drag-applied while active
    private _stroke: StrokeRecord | null = null;
    private _strokeActive = false;
    private _lastStrokeCell: [number, number, number] | null = null;

    // the plane the active stroke is locked to. Captured from the face hit on
    // pointer-down so drag-painting stays on that surface instead of stacking
    // toward the camera - the paint-brush behaviour.
    private _strokePlaneAxis = 1;
    private _strokePlaneCoord = 0;

    // editor settings
    private _tool: EditorTool = "paint";
    private _brushSize = 1;
    private _colorIndex = 6;
    private _renderMode: RenderMode = "blocky";
    private _smoothing = 1;
    // Off by default. It is a full extra pass over the scene and measures
    // about 5 ms of a 14 ms frame while a simulation is remeshing - a third of
    // the budget for an effect the baked occlusion already approximates. It is
    // one click away when a still is worth the frame time.
    // On by default. Measured on a heavy sand-and-water pour it costs about
    // 1.3 ms of a 13.9 ms frame - the cheapest of the additions here, and the
    // one that puts contact shading where baking cannot reach.
    private _occlusionEnabled = true;

    // hover cursor
    private readonly _cursor: Mesh;
    private readonly _cursorMaterial: StandardMaterial;

    // shared scratch objects to avoid per-event allocations
    private readonly _scratchKey = new MortonKey();

    // Dedicated key for the mesh-response path. MortonKey.key is settable, so the
    // three _apply*Mesh entry points re-point this instead of allocating one per
    // response. Kept separate from _scratchKey because _buildOcclusion walks the
    // neighbourhood through that one while this is still live.
    private readonly _meshKey = new MortonKey();
    private readonly _scratchIndex = new VoxelIndex();
    private readonly _scratchDirty = new Set<number>();
    private readonly _scratchPropagate = new Set<number>();

    // reusable occupancy buffer for ambient occlusion baking - one chunk plus a
    // 3-cell border, holding the union of base world and sand occupancy
    private readonly _occupancy = new Uint8Array(OCC_DIMS * OCC_DIMS * OCC_DIMS);

    // the 3x3x3 neighbourhood of BitVoxel storages the occupancy build reads,
    // held across calls so the hot path allocates nothing
    private readonly _occlusionBase: (Uint32Array | null)[] = new Array(27).fill(null);
    private readonly _occlusionSand: (Uint32Array | null)[] = new Array(27).fill(null);

    // per-vertex accumulators reused by the smooth colour relaxation pass
    private _relaxColors = new Float32Array(0);
    private _relaxWeights = new Float32Array(0);

    // Worker responses waiting to be turned into meshes, oldest first, and the
    // lane the frame's request budget starts from. Responses are held rather
    // than applied on arrival so a burst of them cannot stall a frame - see
    // _pumpMeshQueue.
    private readonly _readyResponses: { lane: MeshLane, response: EditorMeshResponse }[] = [];
    private _pumpCursor = 0;

    // scratch corners for the chunk bounding box set on every upload
    private readonly _boundsMin = new Vector3();
    private readonly _boundsMax = new Vector3();

    // throttled stats publishing - _statsDirty marks a dropped publish that the
    // render loop flushes once the throttle window has passed
    private _statsTimer = 0;
    private _statsDirty = false;

    // exponentially smoothed main-thread cost of a rendered frame, in ms
    private _cpuFrameTime = 0;

    /**
     * Invoked whenever the scene statistics change.
     */
    public onStats: ((stats: EditorStats) => void) | null = null;

    /**
     * Invoked when the pick tool selects a colour.
     */
    public onColorPicked: ((colorIndex: number) => void) | null = null;

    /**
     * Invoked when the undo/redo stack sizes change.
     */
    public onHistoryChanged: ((canUndo: boolean, canRedo: boolean) => void) | null = null;

    /**
     * Creates an editor on the provided canvas.
     *
     * The engine is WebGPU-only and comes up asynchronously (adapter and device
     * are both promises), which is why construction runs through here rather
     * than a plain `new`. Rejects when the browser has no WebGPU support.
     */
    public static async create(canvas: HTMLCanvasElement): Promise<VoxelEditor> {
        if (!await WebGPUEngine.IsSupportedAsync) {
            throw new Error("navigator.gpu did not return a usable adapter.");
        }

        const engine = await WebGPUEngine.CreateAsync(canvas, {
            // 4x MSAA on the main pass. Practically free on a tile-based GPU
            // and the single largest quality win available to a renderer whose
            // subject is a field of hard-edged cubes.
            antialias: true,
            stencil: false,
            powerPreference: "high-performance",
            adaptToDeviceRatio: true,
            enableGPUDebugMarkers: false,

            // requests every feature the adapter already advertises, which is
            // how the device ends up with timestamp-query and therefore how the
            // inspector gets a real GPU frame time rather than a guess
            enableAllFeatures: true
        });

        return new VoxelEditor(canvas, engine);
    }

    private constructor(canvas: HTMLCanvasElement, engine: WebGPUEngine) {
        this._canvas = canvas;
        this._engine = engine;
        this._scene = new Scene(this._engine);
        this._pool = new MesherPool();

        const scene = this._scene;

        // WebGPU's non-compatibility mode: Babylon records each mesh's draw
        // into a reusable render bundle instead of re-encoding it every frame.
        // This scene is exactly the shape that pays off - around five hundred
        // small static meshes, each drawn again per shadow cascade and once
        // more into the occlusion pre-pass - and it measures about 2.2 ms off
        // a 10.7 ms frame here. The catch is that a cached bundle holds the
        // mesh's buffers, so replacing a chunk's geometry has to invalidate it;
        // _uploadMesh does that explicitly.
        this._engine.compatibilityMode = false;

        // right-handed to match the counter-clockwise outward winding produced
        // by the bvx-kit geometry generators with flipped = false
        scene.useRightHandedSystem = true;

        // nothing in the scene is pickable through Babylon (the editor casts
        // its own rays through the voxel grid), so the per-move scene pick is
        // pure overhead
        scene.skipPointerMovePicking = true;
        scene.skipPointerDownPicking = true;
        scene.skipPointerUpPicking = true;

        // orbit camera - all navigation input is handled manually (see the
        // pointer/wheel handlers) so mouse and trackpad devices both get
        // predictable, production-grade controls
        const regionUnits = REGION * BIT_VOXEL_SIZE;
        const target = new Vector3(regionUnits / 2, regionUnits / 8, regionUnits / 2);

        this._camera = new ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, regionUnits * 1.1, target, scene);

        // A tight depth range. The old 0.05 - 10000 span spread the depth
        // buffer over five orders of magnitude, which is what let the shadow
        // cascades and the water pre-pass fight each other; 0.1 - 8x the
        // region still comfortably contains the sky dome.
        this._camera.minZ = 0.1;
        this._camera.maxZ = regionUnits * 14;

        this._render = createRenderStack(scene, this._camera, regionUnits, this._occlusionEnabled);
        this._shadows = this._render.shadows;
        this._sunDirection = this._render.sunDirection;

        this._buildGrid();

        // renderable lanes - each lists the worlds that occlude its hidden
        // geometry at layer interfaces. The opaque lanes (base, sand) occlude
        // each other and partition their shared smooth surface via the
        // primary/secondary mode pairing. Water lists both opaque lanes so its
        // hidden contact skin is culled, while nothing lists water - the
        // ground stays visible through the translucent surface.
        this._baseLane = this._makeLane("base", () => this._world, null, 1.0, WIRE_BASE_COLOR, [(): VoxelWorld => this._sand.world], "primary");
        this._sandLane = this._makeLane("sand", () => this._sand.world, SAND_COLOR, 1.0, WIRE_SAND_COLOR, [(): VoxelWorld => this._world], "secondary");
        this._waterLane = this._makeLane("water", () => this._water.world, WATER_COLOR, 0.55, WIRE_WATER_COLOR, [(): VoxelWorld => this._world, (): VoxelWorld => this._sand.world], "overlay");
        this._lanes = [this._baseLane, this._sandLane, this._waterLane];

        this._setupPhysics();

        // hover cursor box
        this._cursorMaterial = new StandardMaterial("cursor-mat", scene);
        this._cursorMaterial.emissiveColor = Color3.FromHexString("#6c8cff");
        this._cursorMaterial.disableLighting = true;
        this._cursorMaterial.alpha = 0.22;

        this._cursor = MeshBuilder.CreateBox("cursor", { size: 1 }, scene);
        this._cursor.material = this._cursorMaterial;
        this._cursor.isPickable = false;
        this._cursor.isVisible = false;
        this._cursor.enableEdgesRendering();
        this._cursor.edgesWidth = 1.5;
        this._cursor.edgesColor = Color4.FromHexString("#6c8cffff");

        // pointer handling for painting and navigation
        canvas.addEventListener("pointerdown", this._onPointerDown);
        canvas.addEventListener("pointermove", this._onPointerMove);
        canvas.addEventListener("pointerup", this._onPointerUp);
        canvas.addEventListener("pointerleave", this._onPointerLeave);
        canvas.addEventListener("contextmenu", (event) => event.preventDefault());
        canvas.addEventListener("wheel", this._onWheel, { passive: false });

        this._resizeObserver = new ResizeObserver(() => this._engine.resize());
        this._resizeObserver.observe(canvas);

        // fixed-step physics, camera framing glide and stale-stats flushing
        // driven by the render loop
        scene.onBeforeRenderObservable.add(() => {
            this._updateCameraGoal();
            this._updatePhysics();

            // meshing after physics, so a tick's dirty chunks can be serviced by
            // the same frame that produced them when the budget allows
            this._pumpMeshQueue();

            // republish on a slow cadence even when nothing changed, so the
            // frame-rate readout keeps ticking on an idle scene
            if (performance.now() - this._statsTimer >= (this._statsDirty ? 250 : 500)) {
                this._publishStats(true);
            }
        });

        // The GPU's own frame time would be the number to show here, but Chrome
        // quantises WebGPU timestamp queries to zero unless the developer
        // features flag is set, so the honest measurement available to every
        // user is what the main thread spends producing the frame.
        this._engine.runRenderLoop(() => {
            const started = performance.now();

            scene.render();

            const elapsed = performance.now() - started;

            this._cpuFrameTime = this._cpuFrameTime === 0
                ? elapsed
                : this._cpuFrameTime + ((elapsed - this._cpuFrameTime) * 0.1);
        });
    }

    // ---------------------------------------------------------------- settings

    public get tool(): EditorTool {
        return this._tool;
    }

    public setTool(tool: EditorTool): void {
        this._tool = tool;
        this._updateCursorStyle();
    }

    public get brushSize(): number {
        return this._brushSize;
    }

    public setBrushSize(size: number): void {
        this._brushSize = Math.min(4, Math.max(1, size | 0));
    }

    public get colorIndex(): number {
        return this._colorIndex;
    }

    public setColorIndex(index: number): void {
        this._colorIndex = Math.min(PALETTE.length - 1, Math.max(0, index | 0));
    }

    public get renderMode(): RenderMode {
        return this._renderMode;
    }

    public setRenderMode(mode: RenderMode): void {
        if (this._renderMode === mode) {
            return;
        }

        this._renderMode = mode;
        this._refreshShadowCasters();
        this._remeshAll();
    }

    /**
     * Rebuilds the shadow generator's caster list for the current render mode.
     *
     * Rebuilt wholesale rather than added to and removed from per mesh, because
     * removeShadowCaster scans the list - doing that once per chunk across a region
     * this size would be quadratic.
     */
    private _refreshShadowCasters(): void {
        const renderList = this._shadows.getShadowMap()?.renderList;

        if (!renderList) {
            return;
        }

        renderList.length = 0;

        // a wireframe has no surface to cast from
        if (this._renderMode === "wireframe") {
            return;
        }

        for (const lane of this._lanes) {
            // translucent water does not cast shadows
            if (lane === this._waterLane) {
                continue;
            }

            for (const mesh of lane.meshes.values()) {
                // A chunk that lost its geometry is kept as a hidden mesh rather
                // than disposed (see _disposeOrClear), and its stale geometry
                // with it - so visibility, not presence in the map, is what says
                // whether there is anything here to cast a shadow.
                if (mesh.isVisible) {
                    renderList.push(mesh);
                }
            }
        }
    }

    /**
     * Whether the base world holds no chunks at all.
     */
    public get isEmpty(): boolean {
        // HashGrid.size is the bucket count, which is non-zero from
        // construction; length is the number of chunks actually stored
        return this._world.chunks.length === 0;
    }

    /**
     * Whether the screen-space ambient occlusion pass is running.
     */
    public get occlusionEnabled(): boolean {
        return this._occlusionEnabled;
    }

    public setOcclusionEnabled(enabled: boolean): void {
        if (this._occlusionEnabled === enabled) {
            return;
        }

        this._occlusionEnabled = enabled;
        this._render.setOcclusionEnabled(enabled);
    }

    /**
     * Whether the device supports the screen-space occlusion pass at all.
     */
    public get occlusionSupported(): boolean {
        return this._render.occlusion !== null;
    }

    public get smoothing(): number {
        return this._smoothing;
    }

    public setSmoothing(smoothing: number): void {
        const clamped = Math.min(3, Math.max(0, smoothing | 0));

        if (this._smoothing === clamped) {
            return;
        }

        this._smoothing = clamped;

        if (this._renderMode === "smooth") {
            this._remeshAll();
        }
    }

    // ----------------------------------------------------------------- physics

    /**
     * Whether the physics simulation is advancing.
     */
    public get playing(): boolean {
        return this._playing;
    }

    public setPlaying(playing: boolean): void {
        this._playing = playing;
        this._physicsAccumulator = 0;
    }

    /**
     * Removes all sand and water grains from the scene.
     */
    public clearPhysics(): void {
        this._sand.clear();
        this._water.clear();

        this._drainPhysicsDirty();
        this._publishStats(true);
    }

    /**
     * Recreates the physics simulation over the current base world. Used on
     * construction and whenever the base world instance is replaced.
     */
    private _setupPhysics(): void {
        this._physics = new VoxelPhysics(this._world, {
            maxX: REGION - 1,
            maxY: REGION - 1,
            maxZ: REGION - 1
        });

        this._sand = this._physics.addLayer(VoxelPhysics.SAND);
        this._water = this._physics.addLayer(VoxelPhysics.WATER);
        this._physicsAccumulator = 0;
    }

    /**
     * Advances the physics simulation on a fixed timestep, driven by the render
     * loop, and remeshes whatever moved.
     */
    private _updatePhysics(): void {
        if (!this._playing) {
            return;
        }

        this._physicsAccumulator += this._engine.getDeltaTime();

        const tickMillis = 1000 / PHYSICS_RATE;
        const started = performance.now();

        let ticks = 0;
        let moves = 0;
        let work = 0;
        let elapsed = 0;

        while (this._physicsAccumulator >= tickMillis && ticks < PHYSICS_MAX_TICKS_PER_FRAME) {
            // Convert what is left of the frame's wall-clock budget into a probe
            // cap, at the rate this machine has been managing. Never below a
            // floor: a tick allowed no work cannot make progress, and a stalled
            // solver is worse than a slightly long frame.
            const remaining = Math.max(0.5, PHYSICS_BUDGET_MS - elapsed);
            const allowance = Math.max(20000, Math.round(remaining * this._workPerMs));

            moves += this._physics.update(1, 0, allowance);
            work += this._sand.workPerformed + this._water.workPerformed;

            this._physicsAccumulator -= tickMillis;
            ticks++;

            elapsed = performance.now() - started;

            // the tick ran out of budget with work outstanding, or the frame's
            // time is spent - stop here and let the next frame carry on rather
            // than blowing through the frame time
            if (this._physics.budgetExceeded || elapsed >= PHYSICS_BUDGET_MS) {
                break;
            }
        }

        // Re-estimate throughput from what that actually cost. Smoothed, and only
        // from frames with enough work to be a meaningful sample - a handful of
        // probes is dominated by the per-chunk sweep prologue and would drag the
        // estimate well below the real rate.
        //
        // Clamped at the bottom, because the estimate feeds the allowance that
        // produces the next sample: left free it can ratchet down, each small
        // allowance yielding a small tick yielding a smaller estimate, and never
        // climb back out on its own.
        if (work > 20000 && elapsed > 0.5) {
            const observed = work / elapsed;

            this._workPerMs = Math.max(5000, this._workPerMs + ((observed - this._workPerMs) * 0.25));
        }

        // drop any remaining backlog so slow frames never spiral
        if (this._physicsAccumulator > tickMillis) {
            this._physicsAccumulator = 0;
        }

        if (ticks > 0) {
            this._drainPhysicsDirty();

            // publish while moving, and once more when the simulation settles
            // so the final counts are not left stale
            if (moves > 0) {
                this._physicsWasMoving = true;
                this._publishStats(false);
            }
            else if (this._physicsWasMoving) {
                this._physicsWasMoving = false;
                this._publishStats(true);
            }
        }
    }

    /**
     * Requests remeshes for every physics chunk that changed since the last drain.
     *
     * Occlusion reaches across layers, so sand changes also remesh the lanes it
     * occludes against (base and water). Water changes propagate nowhere - no
     * lane lists water as an occluder, which keeps the most active layer's
     * remesh traffic unchanged.
     */
    private _drainPhysicsDirty(): void {
        const dirty = this._scratchDirty;

        dirty.clear();
        this._sand.drainDirtyChunks(dirty);

        if (dirty.size > 0) {
            this._remeshLaneDirty(this._sandLane, dirty);
            this._remeshOccluded([this._baseLane, this._waterLane], dirty);
        }

        dirty.clear();
        this._water.drainDirtyChunks(dirty);

        if (dirty.size > 0) {
            this._remeshLaneDirty(this._waterLane, dirty);
        }
    }

    /**
     * Queues remeshes for a lane's own dirty chunks plus the neighbouring chunks
     * its surface can reach into. A smooth occluded lane's surface tapers up to
     * the smoothing radius past its own voxels, so a change near a chunk border
     * also changes the neighbour's mesh.
     */
    private _remeshLaneDirty(lane: MeshLane, dirty: ReadonlySet<number>): void {
        for (const key of dirty) {
            this._queueMesh(lane, key);
        }

        if (this._renderMode !== "smooth" || lane.occluders.length === 0) {
            return;
        }

        // the taper spans `smoothing` samples; the extra margin means a grain
        // moving out of taper range is still caught by the tick that moved it,
        // so a neighbour never keeps a stale film
        const reach = this._smoothing + 2;
        const world = lane.world();
        const pending = this._scratchPropagate;

        pending.clear();

        for (const key of dirty) {
            const mortonKey = new MortonKey(key);
            const chunk = world.get(mortonKey);
            const extents = chunk !== null ? this._chunkExtents(chunk) : null;

            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    for (let oz = -1; oz <= 1; oz++) {
                        if ((ox === 0 && oy === 0 && oz === 0) || !this._taperReaches(extents, ox, oy, oz, reach)) {
                            continue;
                        }

                        const neighbour = MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, this._scratchKey);

                        if (!dirty.has(neighbour.key) && this._isLaneMeshable(lane, neighbour)) {
                            pending.add(neighbour.key);
                        }
                    }
                }
            }
        }

        for (const key of pending) {
            this._queueMesh(lane, key);
        }
    }

    /**
     * Conservative per-axis extents of a chunk's set BitVoxels in chunk-local
     * samples, as [minX, maxX, minY, maxY, minZ, maxZ], or null when empty.
     *
     * Derived from the 128 storage words rather than a per-bit scan. A word spans
     * one (vx, vy, vz) voxel and one half of its x range, so x resolves to 2
     * samples and y/z to 4 - coarse, but only ever over-estimates the reach.
     */
    private _chunkExtents(chunk: VoxelChunk): number[] | null {
        const elements = chunk.layer.bitArray.elements;

        let minX = 16, maxX = -1, minY = 16, maxY = -1, minZ = 16, maxZ = -1;

        for (let w = 0; w < elements.length; w++) {
            if (elements[w] === 0) {
                continue;
            }

            const x = (((w >> 5) & 3) << 2) | ((w & 1) << 1);
            const y = ((w >> 3) & 3) << 2;
            const z = ((w >> 1) & 3) << 2;

            if (x < minX) { minX = x; }
            if (x + 1 > maxX) { maxX = x + 1; }
            if (y < minY) { minY = y; }
            if (y + 3 > maxY) { maxY = y + 3; }
            if (z < minZ) { minZ = z; }
            if (z + 3 > maxZ) { maxZ = z + 3; }
        }

        return maxX < 0 ? null : [minX, maxX, minY, maxY, minZ, maxZ];
    }

    /**
     * Returns whether occupancy with the provided extents comes within `reach`
     * samples of the border facing the given neighbour direction - i.e. whether
     * the lane's tapering surface can reach into that neighbouring chunk. Null
     * extents mean the chunk was removed, whose former surface may have reached
     * in any direction.
     */
    private _taperReaches(extents: number[] | null, ox: number, oy: number, oz: number, reach: number): boolean {
        if (extents === null) {
            return true;
        }

        const [minX, maxX, minY, maxY, minZ, maxZ] = extents;

        if (ox > 0 && maxX < 16 - reach) { return false; }
        if (ox < 0 && minX > reach - 1) { return false; }
        if (oy > 0 && maxY < 16 - reach) { return false; }
        if (oy < 0 && minY > reach - 1) { return false; }
        if (oz > 0 && maxZ < 16 - reach) { return false; }
        if (oz < 0 && minZ > reach - 1) { return false; }

        return true;
    }

    /**
     * Queues remeshes in the provided lanes for every chunk whose geometry can
     * be affected by changes inside the given source chunks. Changes reach one
     * BitVoxel outward (plus the smoothing blur radius, always under a chunk),
     * so the source chunks and their 26 neighbours are candidates - only those
     * that exist in the target lane's world are queued.
     */
    private _remeshOccluded(lanes: MeshLane[], sourceKeys: ReadonlySet<number>): void {
        if (sourceKeys.size === 0) {
            return;
        }

        for (const lane of lanes) {
            const pending = this._scratchPropagate;

            pending.clear();

            for (const key of sourceKeys) {
                const mortonKey = new MortonKey(key);

                for (let ox = -1; ox <= 1; ox++) {
                    for (let oy = -1; oy <= 1; oy++) {
                        for (let oz = -1; oz <= 1; oz++) {
                            const neighbour = MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, this._scratchKey);

                            if (this._isLaneMeshable(lane, neighbour)) {
                                pending.add(neighbour.key);
                            }
                        }
                    }
                }
            }

            for (const key of pending) {
                this._queueMesh(lane, key);
            }
        }
    }

    // ---------------------------------------------------------------- file ops

    /**
     * Serializes the scene into compact binary data (.bvx). The container
     * (format BVE2) holds the base world plus the sand and water layers, each
     * framed as a BVXSerializer world payload.
     */
    public save(): Uint8Array {
        const payloads: Uint8Array[] = [
            BVXSerializer.saveWorld(this._world),
            BVXSerializer.saveWorld(this._sand.world),
            BVXSerializer.saveWorld(this._water.world)
        ];

        let total = 5; // magic + payload count

        for (const payload of payloads) {
            total += 4 + payload.length;
        }

        const data = new Uint8Array(total);
        const view = new DataView(data.buffer);

        data[0] = 0x42; // B
        data[1] = 0x56; // V
        data[2] = 0x45; // E
        data[3] = 0x32; // 2
        data[4] = payloads.length;

        let offset = 5;

        for (const payload of payloads) {
            view.setUint32(offset, payload.length, true);
            data.set(payload, offset + 4);
            offset += 4 + payload.length;
        }

        return data;
    }

    /**
     * Replaces the scene with the provided binary data. Accepts both the BVE2
     * container (base + physics layers) and plain BVW1 world data.
     */
    public load(data: Uint8Array): void {
        // BVE2 container - base world plus physics layer payloads
        if (data.length >= 5 && data[0] === 0x42 && data[1] === 0x56 && data[2] === 0x45 && data[3] === 0x32) {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const count = data[4];
            const payloads: Uint8Array[] = [];

            let offset = 5;

            for (let i = 0; i < count; i++) {
                const length = view.getUint32(offset, true);

                payloads.push(data.subarray(offset + 4, offset + 4 + length));
                offset += 4 + length;
            }

            this._replaceWorld(BVXSerializer.loadWorld(payloads[0]));

            if (payloads.length > 1) {
                this._sand.importWorld(BVXSerializer.loadWorld(payloads[1]));
            }

            if (payloads.length > 2) {
                this._water.importWorld(BVXSerializer.loadWorld(payloads[2]));
            }

            this._drainPhysicsDirty();
            this._publishStats(true);

            return;
        }

        // plain BVW1 world data (legacy saves)
        this._replaceWorld(BVXSerializer.loadWorld(data));
    }

    /**
     * Clears the scene to an empty world.
     */
    public newScene(): void {
        this._replaceWorld(new VoxelWorld());
    }

    /**
     * Generates a small demo landscape to explore the editor with - rolling
     * terrain with sandy shores, a lake in the valleys and floating islands.
     */
    public demoScene(): void {
        const world = new VoxelWorld();
        const chunks = new Map<number, VoxelChunk16>();
        const index = this._scratchIndex;

        // the lake fills the valleys up to this height
        const waterLevel = 8;

        const heights = new Int16Array(REGION * REGION);

        // The terrain frequency is anchored to a fixed span rather than to REGION, so
        // a larger editable area gets more hills of the same size instead of the same
        // hills stretched across it.
        const featureSpan = 128;

        // gentle rolling terrain with height-banded colours - sand around the
        // waterline, grass above, stone and snow on the peaks
        for (let x = 0; x < REGION; x++) {
            for (let z = 0; z < REGION; z++) {
                const nx = x / featureSpan;
                const nz = z / featureSpan;

                const height = Math.max(1, Math.round(
                    10 +
                    (Math.sin(nx * Math.PI * 3.1) * Math.cos(nz * Math.PI * 2.3) * 7) +
                    (Math.sin((nx + nz) * Math.PI * 5.7) * 2.5)
                ));

                heights[(x * REGION) + z] = height;

                for (let y = 0; y < height && y < REGION; y++) {
                    const colorIndex = y < waterLevel + 1 ? 5 : (y < 13 ? 6 : (y < 16 ? 7 : 1));

                    this._setBitVoxelInto(world, chunks, x, y, z, colorIndex, index);
                }
            }
        }

        // a floating blobby island, placed proportionally so it stays over the
        // terrain whatever the region size
        const scale = REGION / featureSpan;
        const island: [number, number, number, number, number][] = [
            [40, 30, 74, 9, 10], [58, 34, 48, 7, 12], [86, 32, 84, 6, 3]
        ].map(([cx, cy, cz, radius, colorIndex]) => [
            Math.round(cx * scale), cy, Math.round(cz * scale), radius, colorIndex
        ] as [number, number, number, number, number]);

        for (const [cx, cy, cz, radius, colorIndex] of island) {
            for (let x = cx - radius; x <= cx + radius; x++) {
                for (let y = cy - radius; y <= cy + radius; y++) {
                    for (let z = cz - radius; z <= cz + radius; z++) {
                        const dx = x - cx;
                        const dy = (y - cy) * 1.4;
                        const dz = z - cz;

                        if ((dx * dx) + (dy * dy) + (dz * dz) <= radius * radius) {
                            this._setBitVoxelInto(world, chunks, x, y, z, colorIndex, index);
                        }
                    }
                }
            }
        }

        this._replaceWorld(world);

        // fill the valleys with water grains up to the waterline - the
        // physics settles them into a lake
        for (let x = 0; x < REGION; x++) {
            for (let z = 0; z < REGION; z++) {
                for (let y = heights[(x * REGION) + z]; y < waterLevel; y++) {
                    this._water.set(x, y, z);
                }
            }
        }

        this._drainPhysicsDirty();
        this._publishStats(true);
    }

    /**
     * Reverts the most recent base-world stroke.
     */
    public undo(): void {
        const record = this._undoStack.pop();

        if (!record) {
            return;
        }

        this._redoStack.push(record);
        this._applySnapshots(record.before);
        this._notifyHistory();
    }

    /**
     * Re-applies the most recently undone base-world stroke.
     */
    public redo(): void {
        const record = this._redoStack.pop();

        if (!record) {
            return;
        }

        this._undoStack.push(record);
        this._applySnapshots(record.after);
        this._notifyHistory();
    }

    /**
     * Releases all GPU, worker and DOM resources held by the editor.
     */
    public dispose(): void {
        this._canvas.removeEventListener("pointerdown", this._onPointerDown);
        this._canvas.removeEventListener("pointermove", this._onPointerMove);
        this._canvas.removeEventListener("pointerup", this._onPointerUp);
        this._canvas.removeEventListener("pointerleave", this._onPointerLeave);
        this._canvas.removeEventListener("wheel", this._onWheel);

        this._resizeObserver.disconnect();
        this._pool.dispose();
        this._engine.dispose();
    }

    // ------------------------------------------------------------------ scene

    /**
     * Creates a renderable lane with its shared material.
     */
    private _makeLane(id: string, world: () => VoxelWorld, color: [number, number, number] | null, alpha: number, wireColor: Color3, occluders: (() => VoxelWorld)[], occlusionMode: SmoothOcclusionMode): MeshLane {
        const material = new StandardMaterial(`lane-mat-${id}`, this._scene);

        material.diffuseColor = Color3.White();
        material.specularColor = Color3.Black();
        material.alpha = alpha;

        // translucent lanes are water - the animated Ghibli water shader owns
        // colour, waves, glints, foam and per-pixel opacity. The depth
        // pre-pass keeps overlapping water faces from double-blending.
        if (alpha < 1.0) {
            material.needDepthPrePass = true;

            new GhibliWaterPlugin(material, this._sunDirection);
        }
        // opaque lanes (base voxels, sand) get the painterly toon ramp
        else {
            new GhibliToonPlugin(material);
        }

        // Wireframe counterpart. The index buffer _applyWireframeMesh builds holds
        // edge pairs rather than triangles, so this draws it as a line list.
        //
        // The line colour is emissive rather than per-vertex. With lighting disabled
        // a StandardMaterial's diffuse term contributes nothing, so vertex colours
        // would render black - emissive is the term that survives, and a flat colour
        // per lane is what a plain wireframe wants anyway.
        const wireMaterial = new StandardMaterial(`lane-wire-${id}`, this._scene);

        wireMaterial.emissiveColor = wireColor;
        wireMaterial.diffuseColor = Color3.Black();
        wireMaterial.specularColor = Color3.Black();
        wireMaterial.disableLighting = true;
        wireMaterial.fillMode = Material.LineListDrawMode;

        return {
            id: id,
            world: world,
            meshes: new Map<number, Mesh>(),
            triangles: new Map<number, number>(),
            capacity: new Map<number, { vertices: number, indices: number }>(),
            pending: new Set<number>(),
            inFlight: new Set<number>(),
            dirtyAgain: new Set<number>(),
            color: color,
            material: material,
            wireMaterial: wireMaterial,
            occluders: occluders,
            occlusionMode: occlusionMode
        };
    }

    /**
     * Builds the ground reference grid - fine lines per Voxel, strong lines per chunk.
     */
    private _buildGrid(): void {
        const scene = this._scene;
        const units = REGION * BIT_VOXEL_SIZE;

        const fine: Vector3[][] = [];
        const strong: Vector3[][] = [];

        for (let i = 0; i <= REGION / 4; i++) {
            const p = i * 4 * BIT_VOXEL_SIZE;
            const lines = i % 4 === 0 ? strong : fine;

            lines.push([new Vector3(p, 0, 0), new Vector3(p, 0, units)]);
            lines.push([new Vector3(0, 0, p), new Vector3(units, 0, p)]);
        }

        const fineMesh = MeshBuilder.CreateLineSystem("grid-fine", { lines: fine }, scene);
        fineMesh.color = Color3.FromHexString("#84ab66");
        fineMesh.isPickable = false;

        const strongMesh = MeshBuilder.CreateLineSystem("grid-strong", { lines: strong }, scene);
        strongMesh.color = Color3.FromHexString("#5e854a");
        strongMesh.isPickable = false;
    }

    /**
     * Swaps in a new base world, resets physics, clears history and rebuilds
     * all chunk meshes.
     */
    private _replaceWorld(world: VoxelWorld): void {
        this._world = world;

        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this._stroke = null;
        this._notifyHistory();

        for (const lane of this._lanes) {
            for (const mesh of lane.meshes.values()) {
                this._shadows.removeShadowCaster(mesh, false);
                mesh.dispose();
            }

            lane.meshes.clear();
            lane.triangles.clear();
            lane.capacity.clear();
            lane.pending.clear();
            lane.inFlight.clear();
            lane.dirtyAgain.clear();
        }

        // Responses still in the apply queue belong to the world being replaced,
        // and their lanes' mesh maps have just been emptied - applying them would
        // resurrect meshes for chunks of a world that no longer exists.
        this._readyResponses.length = 0;

        // the physics simulation holds a reference to the base world - recreate
        // it (which also clears all grains)
        this._setupPhysics();

        this._remeshAll();
    }

    /**
     * Queues a remesh for every chunk in every lane.
     */
    private _remeshAll(): void {
        for (const lane of this._lanes) {
            const keys = this._laneMeshKeys(lane);

            // drop meshes for chunks that left the lane's meshed set - switching
            // to blocky shrinks it back to the lane's own chunks
            for (const key of Array.from(lane.meshes.keys())) {
                if (!keys.has(key)) {
                    this._disposeOrClear(lane, key);
                }
            }

            for (const key of keys) {
                this._queueMesh(lane, key);
            }
        }

        this._publishStats(true);
    }

    // --------------------------------------------------------------- painting

    private readonly _onPointerDown = (event: PointerEvent): void => {
        // navigation routing - right-drag or Alt/Option-drag orbits, middle-drag
        // or Alt+Shift-drag pans. This works with mice and with Mac trackpads
        // (Option + one-finger drag).
        const orbit = event.button === 2 || (event.button === 0 && event.altKey && !event.shiftKey);
        const pan = event.button === 1 || (event.button === 0 && event.altKey && event.shiftKey);

        if (orbit || pan) {
            event.preventDefault();

            this._navMode = orbit ? "orbit" : "pan";
            this._navPointerId = event.pointerId;
            this._navLastX = event.clientX;
            this._navLastY = event.clientY;
            this._cameraGoal = null;
            this._cursor.isVisible = false;

            this._capturePointer(event.pointerId);

            return;
        }

        if (event.button !== 0) {
            return;
        }

        const target = this._resolveTarget(event);

        if (this._tool === "pick") {
            if (target.pickCell) {
                const picked = this._getMetaAt(target.pickCell[0], target.pickCell[1], target.pickCell[2]);

                if (picked !== null) {
                    this._colorIndex = picked;
                    this.onColorPicked?.(picked);
                }
            }

            return;
        }

        if (!target.brushCell) {
            return;
        }

        this._capturePointer(event.pointerId);

        // lock the stroke to the plane of the surface hit on pointer-down, so
        // dragging paints along that surface instead of stacking toward the
        // camera. Erase locks onto the hit cells, placement tools onto the
        // adjacent cells.
        if (target.pickCell) {
            const reference = this._tool === "erase" ? target.pickCell : target.brushCell;
            const other = this._tool === "erase" ? target.brushCell : target.pickCell;

            // the face normal axis is the axis where hit and adjacent cell differ
            let axis = 1;

            for (let a = 0; a < 3; a++) {
                if (reference[a] !== other[a]) {
                    axis = a;

                    break;
                }
            }

            this._strokePlaneAxis = axis;
            this._strokePlaneCoord = reference[axis];
        }
        else {
            // ground plane fallback
            this._strokePlaneAxis = 1;
            this._strokePlaneCoord = 0;
        }

        // physics strokes are transient simulation state and not undo-tracked
        const isBaseTool = this._tool === "paint" || this._tool === "erase";

        this._stroke = isBaseTool ? { before: new Map(), after: new Map() } : null;
        this._strokeActive = true;
        this._lastStrokeCell = null;

        this._applyBrush(target.brushCell);
    };

    private readonly _onPointerMove = (event: PointerEvent): void => {
        // camera navigation drag
        if (this._navMode !== "none" && event.pointerId === this._navPointerId) {
            const dx = event.clientX - this._navLastX;
            const dy = event.clientY - this._navLastY;

            this._navLastX = event.clientX;
            this._navLastY = event.clientY;

            if (this._navMode === "orbit") {
                this._orbitCamera(dx, dy);
            }
            else {
                this._panCamera(dx, dy);
            }

            return;
        }

        // while stroking, targets come from the locked stroke plane
        if (this._strokeActive) {
            const cell = this._resolvePlaneTarget(event);

            this._updateCursor(cell);

            if (cell) {
                const last = this._lastStrokeCell;

                // only re-apply when the brush has moved to a new cell
                if (!last || last[0] !== cell[0] || last[1] !== cell[1] || last[2] !== cell[2]) {
                    this._applyBrush(cell);
                }
            }

            return;
        }

        const target = this._resolveTarget(event);

        this._updateCursor(this._tool === "pick" ? target.pickCell : target.brushCell);
    };

    private readonly _onPointerUp = (event: PointerEvent): void => {
        if (this._navMode !== "none" && event.pointerId === this._navPointerId) {
            this._navMode = "none";
            this._navPointerId = -1;

            return;
        }

        if (event.button !== 0) {
            return;
        }

        if (this._stroke) {
            // snapshot the final state of every base chunk the stroke touched
            for (const key of this._stroke.before.keys()) {
                const chunk = this._world.get(new MortonKey(key));
                this._stroke.after.set(key, chunk !== null ? BVXSerializer.saveChunk(chunk) : null);
            }

            if (this._stroke.before.size > 0) {
                this._undoStack.push(this._stroke);

                // cap the history depth
                if (this._undoStack.length > 64) {
                    this._undoStack.shift();
                }

                this._redoStack.length = 0;
                this._notifyHistory();
            }
        }

        this._stroke = null;
        this._strokeActive = false;
        this._lastStrokeCell = null;
    };

    private readonly _onPointerLeave = (): void => {
        this._cursor.isVisible = false;
    };

    /**
     * Wheel/scroll navigation. Classic mouse wheels zoom. Mac trackpads orbit
     * with two-finger scroll, zoom with pinch (delivered as ctrl+wheel) and pan
     * with shift+scroll. Trackpads are recognised by their event signature
     * (horizontal deltas or fine-grained vertical deltas) with a sticky window
     * so fast flings keep routing to orbit.
     */
    private readonly _onWheel = (event: WheelEvent): void => {
        event.preventDefault();

        this._cameraGoal = null;

        // pinch-zoom gestures arrive as wheel events with ctrlKey set
        if (event.ctrlKey || event.metaKey) {
            this._zoomCamera(event.deltaY * 3);

            return;
        }

        if (event.shiftKey) {
            this._panCamera(-event.deltaX * 0.6, -event.deltaY * 0.6);

            return;
        }

        // trackpad signature - pixel-mode deltas that are horizontal, fractional
        // or small. Detection is sticky for a moment so vertical flings with
        // large deltas keep orbiting.
        const now = performance.now();

        if (event.deltaMode === 0 && (event.deltaX !== 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 40)) {
            this._trackpadUntil = now + 1500;
        }

        if (now < this._trackpadUntil) {
            this._orbitCamera(-event.deltaX * 0.75, -event.deltaY * 0.75);

            return;
        }

        this._zoomCamera(event.deltaY);
    };

    /**
     * Requests pointer capture, guarded as synthetic pointers can reject it.
     */
    private _capturePointer(pointerId: number): void {
        try {
            this._canvas.setPointerCapture(pointerId);
        }
        catch {
            // ignore - input still works without capture
        }
    }

    /**
     * Orbits the camera by the provided pointer deltas (pixels).
     */
    private _orbitCamera(dx: number, dy: number): void {
        const camera = this._camera;

        camera.alpha -= dx * 0.0075;
        camera.beta = Math.min(CAMERA_MAX_BETA, Math.max(CAMERA_MIN_BETA, camera.beta - (dy * 0.0075)));
    }

    /**
     * Pans the camera target in view space by the provided pointer deltas
     * (pixels), scaled by the current zoom so panning feels constant on screen.
     */
    private _panCamera(dx: number, dy: number): void {
        const camera = this._camera;
        const scale = camera.radius * 0.0016;

        const right = camera.getDirection(Vector3.Right());
        const up = camera.getDirection(Vector3.Up());

        camera.target.addInPlace(right.scale(-dx * scale)).addInPlace(up.scale(dy * scale));

        // keep the target near the editable region so the camera cannot get lost
        const units = REGION * BIT_VOXEL_SIZE;
        const margin = units * 0.75;

        camera.target.x = Math.min(units + margin, Math.max(-margin, camera.target.x));
        camera.target.y = Math.min(units + margin, Math.max(-margin, camera.target.y));
        camera.target.z = Math.min(units + margin, Math.max(-margin, camera.target.z));
    }

    /**
     * Zooms the camera by the provided wheel delta.
     */
    private _zoomCamera(delta: number): void {
        const camera = this._camera;
        const clamped = Math.min(200, Math.max(-200, delta));

        camera.radius = Math.min(CAMERA_MAX_RADIUS, Math.max(CAMERA_MIN_RADIUS, camera.radius * (1 + (clamped * 0.0012))));
    }

    /**
     * Glides the camera to frame the scene contents (F key). Uses the bounds of
     * every populated chunk, falling back to the editable region when empty.
     */
    public frameContent(): void {
        const units = REGION * BIT_VOXEL_SIZE;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let any = false;

        for (const lane of this._lanes) {
            for (const chunk of lane.world().chunks.values()) {
                const key = chunk.key;

                minX = Math.min(minX, key.x * 4);
                minY = Math.min(minY, key.y * 4);
                minZ = Math.min(minZ, key.z * 4);
                maxX = Math.max(maxX, (key.x + 1) * 4);
                maxY = Math.max(maxY, (key.y + 1) * 4);
                maxZ = Math.max(maxZ, (key.z + 1) * 4);
                any = true;
            }
        }

        if (!any) {
            minX = 0; minY = 0; minZ = 0;
            maxX = units; maxY = units / 4; maxZ = units;
        }

        const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);

        this._cameraGoal = {
            target: new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
            radius: Math.min(CAMERA_MAX_RADIUS, Math.max(CAMERA_MIN_RADIUS, extent * 1.6))
        };
    }

    /**
     * Advances the camera framing glide, if one is active.
     */
    private _updateCameraGoal(): void {
        const goal = this._cameraGoal;

        if (!goal) {
            return;
        }

        const camera = this._camera;

        // mutate the target in place - assigning a new vector goes through
        // ArcRotateCamera.setTarget, which recomputes alpha/beta/radius and
        // fights the glide
        camera.target.copyFrom(Vector3.Lerp(camera.target, goal.target, 0.18));
        camera.radius += (goal.radius - camera.radius) * 0.18;

        if (camera.target.subtract(goal.target).lengthSquared() < 0.0004 && Math.abs(camera.radius - goal.radius) < 0.02) {
            camera.target.copyFrom(goal.target);
            camera.radius = goal.radius;
            this._cameraGoal = null;
        }
    }

    /**
     * Resolves the pointer position onto the active stroke's locked plane,
     * returning the brush cell there or null when the ray runs parallel or the
     * cell is out of the region.
     */
    private _resolvePlaneTarget(event: PointerEvent): [number, number, number] | null {
        const rect = this._canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const ray = this._scene.createPickingRay(x, y, Matrix.Identity(), this._camera);

        // in BitVoxel space
        const origin = [
            ray.origin.x / BIT_VOXEL_SIZE,
            ray.origin.y / BIT_VOXEL_SIZE,
            ray.origin.z / BIT_VOXEL_SIZE
        ];
        const direction = [ray.direction.x, ray.direction.y, ray.direction.z];

        const axis = this._strokePlaneAxis;
        const coord = this._strokePlaneCoord;

        if (Math.abs(direction[axis]) < 1e-8) {
            return null;
        }

        // intersect with the plane through the locked cells' centers
        const t = (coord + 0.5 - origin[axis]) / direction[axis];

        if (t <= 0) {
            return null;
        }

        const cell: [number, number, number] = [
            Math.floor(origin[0] + (direction[0] * t)),
            Math.floor(origin[1] + (direction[1] * t)),
            Math.floor(origin[2] + (direction[2] * t))
        ];

        cell[axis] = coord;

        if (cell[0] < 0 || cell[0] >= REGION || cell[1] < 0 || cell[1] >= REGION || cell[2] < 0 || cell[2] >= REGION) {
            return null;
        }

        return cell;
    }

    /**
     * Resolves the pointer position into brush/pick target cells by casting a
     * ray through the BitVoxel grid.
     */
    private _resolveTarget(event: PointerEvent): { brushCell: [number, number, number] | null, pickCell: [number, number, number] | null } {
        // createPickingRay expects CSS-pixel coordinates relative to the canvas
        const rect = this._canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const ray = this._scene.createPickingRay(x, y, Matrix.Identity(), this._camera);

        // convert into BitVoxel space
        const ox = ray.origin.x / BIT_VOXEL_SIZE;
        const oy = ray.origin.y / BIT_VOXEL_SIZE;
        const oz = ray.origin.z / BIT_VOXEL_SIZE;

        const result = this._castRay(ox, oy, oz, ray.direction.x, ray.direction.y, ray.direction.z);

        if (result.hit) {
            return {
                brushCell: this._tool === "erase" ? result.cell : result.prev,
                pickCell: result.cell
            };
        }

        // no voxel hit - fall back to the ground plane for placement tools. In
        // BitVoxel space the ray is p(t) = origin + direction * t with the same
        // direction, so the plane intersection needs no further unit conversion
        if (this._tool !== "erase" && ray.direction.y < -1e-6) {
            const t = -oy / ray.direction.y;
            const gx = Math.floor(ox + (ray.direction.x * t));
            const gz = Math.floor(oz + (ray.direction.z * t));

            if (gx >= 0 && gx < REGION && gz >= 0 && gz < REGION) {
                return { brushCell: [gx, 0, gz], pickCell: null };
            }
        }

        return { brushCell: null, pickCell: null };
    }

    /**
     * Casts a ray through the BitVoxel grid (Amanatides & Woo traversal),
     * returning the first solid cell (base world or any physics layer) and the
     * empty cell just before it.
     */
    private _castRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number):
        { hit: boolean, cell: [number, number, number], prev: [number, number, number] } {

        // clamp the ray to the editable region's bounding box so the traversal
        // starts at the region instead of walking from the camera
        let tEntry = 0;
        let tExit = Infinity;

        const origins = [ox, oy, oz];
        const directions = [dx, dy, dz];

        for (let a = 0; a < 3; a++) {
            if (Math.abs(directions[a]) < 1e-9) {
                if (origins[a] < -1 || origins[a] > REGION + 1) {
                    return { hit: false, cell: [0, 0, 0], prev: [0, 0, 0] };
                }

                continue;
            }

            const t1 = (-1 - origins[a]) / directions[a];
            const t2 = (REGION + 1 - origins[a]) / directions[a];

            tEntry = Math.max(tEntry, Math.min(t1, t2));
            tExit = Math.min(tExit, Math.max(t1, t2));
        }

        if (tEntry > tExit) {
            return { hit: false, cell: [0, 0, 0], prev: [0, 0, 0] };
        }

        if (tEntry > 0) {
            ox += dx * tEntry;
            oy += dy * tEntry;
            oz += dz * tEntry;
        }

        let x = Math.floor(ox);
        let y = Math.floor(oy);
        let z = Math.floor(oz);

        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;

        const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
        const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
        const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

        let tMaxX = dx !== 0 ? (dx > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX : Infinity;
        let tMaxY = dy !== 0 ? (dy > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY : Infinity;
        let tMaxZ = dz !== 0 ? (dz > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ : Infinity;

        let px = x;
        let py = y;
        let pz = z;

        // traverse up to 3 region diagonals worth of cells
        for (let i = 0; i < REGION * 6; i++) {
            const inside = x >= 0 && x < REGION && y >= 0 && y < REGION && z >= 0 && z < REGION;

            if (inside && this._isSolidAt(x, y, z)) {
                return { hit: true, cell: [x, y, z], prev: [px, py, pz] };
            }

            px = x;
            py = y;
            pz = z;

            if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
                x += stepX;
                tMaxX += tDeltaX;
            }
            else if (tMaxY <= tMaxZ) {
                y += stepY;
                tMaxY += tDeltaY;
            }
            else {
                z += stepZ;
                tMaxZ += tDeltaZ;
            }
        }

        return { hit: false, cell: [0, 0, 0], prev: [0, 0, 0] };
    }

    /**
     * Applies the current brush centered on the provided cell.
     */
    private _applyBrush(center: [number, number, number]): void {
        this._lastStrokeCell = center;

        const size = this._brushSize;
        const low = Math.floor((size - 1) / 2);
        const high = size - 1 - low;

        const touched = new Set<number>();

        let minX = REGION, minY = REGION, minZ = REGION;
        let maxX = 0, maxY = 0, maxZ = 0;
        let physicsTouched = false;

        for (let x = center[0] - low; x <= center[0] + high; x++) {
            for (let y = center[1] - low; y <= center[1] + high; y++) {
                for (let z = center[2] - low; z <= center[2] + high; z++) {
                    if (x < 0 || x >= REGION || y < 0 || y >= REGION || z < 0 || z >= REGION) {
                        continue;
                    }

                    if (this._tool === "sand" || this._tool === "water") {
                        // grains only occupy globally free cells
                        if (!this._isSolidAt(x, y, z)) {
                            const layer = this._tool === "sand" ? this._sand : this._water;

                            layer.set(x, y, z);
                            physicsTouched = true;
                        }

                        continue;
                    }

                    const chunkKey = MortonKey.from(x >> 4, y >> 4, z >> 4, this._scratchKey).key;

                    // snapshot the chunk before its first modification in this stroke
                    if (this._stroke && !this._stroke.before.has(chunkKey)) {
                        const existing = this._world.get(this._scratchKey);
                        this._stroke.before.set(chunkKey, existing !== null ? BVXSerializer.saveChunk(existing) : null);
                    }

                    if (this._tool === "paint") {
                        // painting is purely additive - occupied cells (ground
                        // or grains) are left untouched, so plane-locked
                        // strokes passing under terrain change nothing there
                        if (this._isSolidAt(x, y, z)) {
                            continue;
                        }

                        this._setBitVoxelAt(x, y, z, this._colorIndex);
                    }
                    else {
                        this._unsetBitVoxelAt(x, y, z);

                        // the eraser also removes grains
                        if (this._sand.unset(x, y, z) || this._water.unset(x, y, z)) {
                            physicsTouched = true;
                        }
                    }

                    touched.add(chunkKey);

                    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
                    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
                }
            }
        }

        if (touched.size > 0) {
            this._remeshRegion(touched, minX, minY, minZ, maxX, maxY, maxZ);

            // resting grains near the edit must re-evaluate their support
            this._physics.wakeRegion(minX, minY, minZ, maxX, maxY, maxZ);
        }

        if (physicsTouched) {
            this._drainPhysicsDirty();
        }

        if (touched.size > 0 || physicsTouched) {
            // Throttled, not forced. This runs once per pointermove for the whole
            // length of a drag - about a hundred times a second - and a publish
            // walks every base chunk pop-counting its BitVoxels. Forcing it made
            // dragging the brush pay that walk on every event; the render loop
            // flushes a dropped publish within 250 ms, which no one can see the
            // difference of on a counter readout.
            this._publishStats(false);
        }
    }

    /**
     * Queues remeshes for the edited base chunks plus any existing neighbouring
     * chunks whose geometry can be affected by the edit.
     */
    private _remeshRegion(touched: Set<number>, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
        // geometry changes reach one BitVoxel outward, plus the smoothing blur radius
        const margin = 1 + (this._renderMode === "smooth" ? this._smoothing : 0);

        const chunkMinX = Math.max(0, (minX - margin)) >> 4;
        const chunkMinY = Math.max(0, (minY - margin)) >> 4;
        const chunkMinZ = Math.max(0, (minZ - margin)) >> 4;
        const chunkMaxX = Math.min(REGION - 1, (maxX + margin)) >> 4;
        const chunkMaxY = Math.min(REGION - 1, (maxY + margin)) >> 4;
        const chunkMaxZ = Math.min(REGION - 1, (maxZ + margin)) >> 4;

        const keys = new Set<number>(touched);

        for (let cx = chunkMinX; cx <= chunkMaxX; cx++) {
            for (let cy = chunkMinY; cy <= chunkMaxY; cy++) {
                for (let cz = chunkMinZ; cz <= chunkMaxZ; cz++) {
                    const key = MortonKey.from(cx, cy, cz, this._scratchKey);

                    if (this._isLaneMeshable(this._baseLane, key)) {
                        keys.add(key.key);
                    }
                }
            }
        }

        for (const key of keys) {
            this._queueMesh(this._baseLane, key);
        }

        // base occupancy occludes the sand and water lanes - remesh their
        // chunks around the edit so culled interfaces stay in sync
        this._remeshOccluded([this._sandLane, this._waterLane], touched);
    }

    // ------------------------------------------------------------ voxel access

    /**
     * Returns whether any world (base or physics layer) occupies the provided
     * global BitVoxel coordinates.
     */
    private _isSolidAt(x: number, y: number, z: number): boolean {
        return this._getBitVoxelAt(x, y, z) === 1 || this._sand.get(x, y, z) === 1 || this._water.get(x, y, z) === 1;
    }

    /**
     * Reads a base-world BitVoxel state at global BitVoxel coordinates.
     */
    private _getBitVoxelAt(x: number, y: number, z: number): number {
        const chunk = this._world.get(MortonKey.from(x >> 4, y >> 4, z >> 4, this._scratchKey));

        if (chunk === null) {
            return 0;
        }

        const lx = x & 15;
        const ly = y & 15;
        const lz = z & 15;

        return chunk.getBitVoxel(VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, this._scratchIndex));
    }

    /**
     * Reads the meta-data (palette index) of the Voxel containing the provided
     * global BitVoxel coordinates, or null when no chunk exists there.
     */
    private _getMetaAt(x: number, y: number, z: number): number | null {
        const chunk = this._world.get(MortonKey.from(x >> 4, y >> 4, z >> 4, this._scratchKey));

        if (chunk === null) {
            return null;
        }

        const lx = x & 15;
        const ly = y & 15;
        const lz = z & 15;

        const meta = chunk.getMetaData(VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, this._scratchIndex));

        return meta % PALETTE.length;
    }

    /**
     * Sets a base-world BitVoxel and its Voxel colour at global BitVoxel
     * coordinates, creating the owning chunk on demand.
     */
    private _setBitVoxelAt(x: number, y: number, z: number, colorIndex: number): void {
        const key = MortonKey.from(x >> 4, y >> 4, z >> 4, this._scratchKey);
        let chunk = this._world.get(key);

        if (chunk === null) {
            chunk = new VoxelChunk16(key.clone());
            this._world.insert(chunk);
        }

        const lx = x & 15;
        const ly = y & 15;
        const lz = z & 15;

        const index = VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, this._scratchIndex);

        chunk.setBitVoxel(index);
        chunk.setMetaData(index, colorIndex);
    }

    /**
     * Unsets a base-world BitVoxel at global BitVoxel coordinates.
     */
    private _unsetBitVoxelAt(x: number, y: number, z: number): void {
        const chunk = this._world.get(MortonKey.from(x >> 4, y >> 4, z >> 4, this._scratchKey));

        if (chunk === null) {
            return;
        }

        const lx = x & 15;
        const ly = y & 15;
        const lz = z & 15;

        chunk.unsetBitVoxel(VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, this._scratchIndex));
    }

    /**
     * Demo/bulk variant of _setBitVoxelAt that works against a detached world
     * with a chunk cache, avoiding repeated hash lookups.
     */
    private _setBitVoxelInto(world: VoxelWorld, chunks: Map<number, VoxelChunk16>, x: number, y: number, z: number, colorIndex: number, index: VoxelIndex): void {
        if (x < 0 || x >= REGION || y < 0 || y >= REGION || z < 0 || z >= REGION) {
            return;
        }

        const chunkKey = MortonKey.from(x >> 4, y >> 4, z >> 4, this._scratchKey);
        let chunk = chunks.get(chunkKey.key);

        if (!chunk) {
            chunk = new VoxelChunk16(chunkKey.clone());
            chunks.set(chunkKey.key, chunk);
            world.insert(chunk);
        }

        const lx = x & 15;
        const ly = y & 15;
        const lz = z & 15;

        VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, index);

        chunk.setBitVoxel(index);
        chunk.setMetaData(index, colorIndex);
    }

    /**
     * Restores base chunk byte snapshots (undo/redo), remeshes the affected
     * area and wakes any physics grains resting on the changed geometry.
     */
    private _applySnapshots(snapshots: Map<number, Uint8Array | null>): void {
        for (const [key, data] of snapshots) {
            const mortonKey = new MortonKey(key);

            if (data === null) {
                this._world.remove(mortonKey);
                this._disposeOrClear(this._baseLane, key);
            }
            else {
                this._world.insert(BVXSerializer.loadChunk(data));
            }
        }

        // remesh restored chunks and every existing neighbour around them, and
        // wake grains that may have lost or gained support
        const keys = new Set<number>();

        for (const key of snapshots.keys()) {
            const mortonKey = new MortonKey(key);

            this._physics.wakeRegion(mortonKey.x << 4, mortonKey.y << 4, mortonKey.z << 4, (mortonKey.x << 4) + 15, (mortonKey.y << 4) + 15, (mortonKey.z << 4) + 15);

            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    for (let oz = -1; oz <= 1; oz++) {
                        const neighbour = MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, this._scratchKey);

                        if (this._isLaneMeshable(this._baseLane, neighbour)) {
                            keys.add(neighbour.key);
                        }
                    }
                }
            }
        }

        for (const key of keys) {
            this._queueMesh(this._baseLane, key);
        }

        // restored base occupancy occludes the sand and water lanes
        this._remeshOccluded([this._sandLane, this._waterLane], new Set(snapshots.keys()));

        this._publishStats(true);
    }

    // ---------------------------------------------------------------- meshing

    /**
     * Marks a chunk of the provided lane as wanting a remesh.
     *
     * This is deliberately nothing but a set insertion. Everything expensive -
     * serializing the chunk's neighbourhood, serializing the occluding lanes'
     * occupancy over it, posting to a worker - happens later, in _pumpMeshQueue,
     * under a per-frame time budget.
     *
     * The distinction is what keeps a physics spike off the frame time. A
     * collapsing water body dirties over a hundred chunks in a single tick;
     * turning each one into a request there and then is more than twenty
     * milliseconds of synchronous work between two frames, which is exactly the
     * freeze this indirection removes.
     */
    private _queueMesh(lane: MeshLane, chunkKey: number): void {
        lane.pending.add(chunkKey);
    }

    /**
     * Spends this frame's meshing budget: turns queued chunks into worker
     * requests, and applies whatever the workers have sent back.
     *
     * Both halves are budgeted, because both are unbounded in the amount of work
     * a physics tick can hand them and both run on this thread. Requests cost
     * serialization; responses cost building vertex data and replacing the
     * mesh's GPU buffers. Whatever does not fit stays queued for the next frame,
     * so a spike costs a chunk of terrain being a frame or two stale rather than
     * a dropped frame - and on water, which is where the spikes are, one frame
     * of staleness is invisible.
     *
     * Responses are applied before new requests are sent. A response is work
     * already paid for by a worker and is holding a mesh in a stale state, so it
     * is worth more than starting something new; sending first would also let
     * the in-flight set grow while the apply queue backed up behind it.
     */
    private _pumpMeshQueue(): void {
        const started = performance.now();

        // ---- apply what came back

        const ready = this._readyResponses;

        while (ready.length > 0) {
            if (performance.now() - started >= MESH_APPLY_BUDGET_MS) {
                break;
            }

            const entry = ready.shift()!;

            this._applyMeshResponse(entry.lane, entry.response);
        }

        // ---- send what is queued

        const lanes = this._lanes;
        const laneCount = lanes.length;

        // Rotate which lane goes first each frame. Without this the base lane
        // would take the whole budget for as long as it had work and the water
        // lane - the one actually moving - would never be reached.
        const offset = this._pumpCursor++ % laneCount;

        let sent = 0;

        for (let l = 0; l < laneCount; l++) {
            const lane = lanes[(l + offset) % laneCount];

            if (lane.pending.size === 0) {
                continue;
            }

            // Iterated and deleted in place, no snapshot. Deleting the current
            // entry of a Set under iteration is well defined, and nothing on this
            // path inserts: in-flight chunks are skipped before _requestMesh is
            // called, so its re-queue branch is unreachable from here. Copying
            // instead would allocate an array the size of the whole queue every
            // frame to service a dozen of its entries.
            for (const chunkKey of lane.pending) {
                if (performance.now() - started >= MESH_FRAME_BUDGET_MS) {
                    return;
                }

                // still being meshed - leave it queued, the response handler
                // will pick it up again
                if (lane.inFlight.has(chunkKey)) {
                    continue;
                }

                lane.pending.delete(chunkKey);
                this._requestMesh(lane, chunkKey);
                sent++;
            }
        }

        if (sent > 0) {
            this._statsDirty = true;
        }
    }

    /**
     * Sends a meshing request for a chunk of the provided lane. If a request
     * for the chunk is already in flight, the chunk is re-queued when the
     * response arrives.
     */
    private _requestMesh(lane: MeshLane, chunkKey: number): void {
        if (lane.inFlight.has(chunkKey)) {
            lane.dirtyAgain.add(chunkKey);

            return;
        }

        const world = lane.world();
        const mortonKey = new MortonKey(chunkKey);

        if (!this._isLaneMeshable(lane, mortonKey)) {
            // nothing of this lane can appear here any more - drop its mesh
            this._disposeOrClear(lane, chunkKey);

            return;
        }

        lane.inFlight.add(chunkKey);

        // snapshot the chunk and its 26 neighbours for seam-correct meshing
        const region = new VoxelWorld();

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const neighbour = world.get(MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, this._scratchKey));

                    if (neighbour !== null) {
                        region.insert(neighbour);
                    }
                }
            }
        }

        const snapshot = BVXSerializer.saveWorld(region);

        // snapshot the occluding lanes' occupancy over the same neighbourhood -
        // their cells cull this lane's geometry hidden at layer interfaces
        const occluderSnapshot = this._buildOccluderSnapshot(lane, mortonKey);

        // flipped winding - BabylonJS treats clockwise faces as front-facing,
        // the opposite of the bvx-kit default counter-clockwise convention
        //
        // The three modes ask for three different things. Solid blocky asks for a
        // finished mesh, so the whole expansion - occlusion baking, palette
        // lookup, vertex streams - happens in the worker and the main thread only
        // uploads. Wireframe still wants raw masks, because it draws face edges
        // rather than surfaces and needs no occlusion or colour at all; indices:
        // false because it builds its own line-list index buffer and the mesher's
        // triangle indices would be over a hundred kilobytes per fluid chunk
        // allocated only to be dropped.
        let request: EditorMeshRequest;

        if (this._renderMode === "smooth") {
            request = { id: 0, type: "smooth", chunkKey: chunkKey, smoothing: this._smoothing, flipped: true, world: snapshot };
        }
        else if (this._renderMode === "wireframe") {
            request = { id: 0, type: "faces", chunkKey: chunkKey, flipped: true, world: snapshot, indices: false };
        }
        else {
            request = {
                id: 0,
                type: "blocky",
                chunkKey: chunkKey,
                world: snapshot,
                laneColor: lane.color,
                water: lane === this._waterLane
            };
        }

        if (occluderSnapshot !== null) {
            request.occluders = occluderSnapshot;

            if (request.type === "smooth") {
                request.occlusionMode = lane.occlusionMode;
            }
        }

        this._pool.request(request).then((response) => this._onMeshResponse(lane, response));
    }

    /**
     * Returns whether the lane can hold renderable geometry at the provided chunk
     * position - the lane's meshed set.
     *
     * Without occlusion that is simply where the lane has voxels. Smooth occluded
     * lanes mesh the MERGED set (the lane's chunks plus its occluders'), because a
     * layer can own surface in a chunk it holds no voxels at: the tapering rim of
     * a translucent overlay patch, or a contested cell of a primary/secondary
     * partition. Meshing the merged set is what lets those rims land exactly on
     * the occluding surface rather than floating above it, and bvx-kit derives the
     * same set for chunk-seam ownership so every seam is still emitted once.
     */
    private _isLaneMeshable(lane: MeshLane, mortonKey: MortonKey): boolean {
        if (lane.world().get(mortonKey) !== null) {
            return true;
        }

        // blocky occlusion is exact per BitVoxel - it has no tapering rim, so a
        // chunk without the lane's own voxels can never show its geometry
        if (this._renderMode !== "smooth") {
            return false;
        }

        for (const occluderWorld of lane.occluders) {
            if (occluderWorld().get(mortonKey) !== null) {
                return true;
            }
        }

        return false;
    }

    /**
     * Collects every chunk key of the lane's meshed set (see _isLaneMeshable).
     */
    private _laneMeshKeys(lane: MeshLane): Set<number> {
        const keys = new Set<number>();

        for (const chunk of lane.world().chunks.values()) {
            keys.add(chunk.key.key);
        }

        if (this._renderMode === "smooth") {
            for (const occluderWorld of lane.occluders) {
                for (const chunk of occluderWorld().chunks.values()) {
                    keys.add(chunk.key.key);
                }
            }
        }

        return keys;
    }

    /**
     * Serializes the merged occupancy of the lane's occluding worlds over the
     * chunk's 3x3x3 neighbourhood, or null when no occluder chunks overlap it.
     * Chunks present in a single occluder world are referenced directly - only
     * positions covered by multiple occluders merge into a scratch chunk.
     */
    private _buildOccluderSnapshot(lane: MeshLane, mortonKey: MortonKey): Uint8Array | null {
        if (lane.occluders.length === 0) {
            return null;
        }

        const region = new VoxelWorld();
        let count = 0;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, this._scratchKey);

                    let first: VoxelChunk | null = null;
                    let combined: VoxelChunk0 | null = null;

                    for (const occluderWorld of lane.occluders) {
                        const chunk = occluderWorld().get(this._scratchKey);

                        if (chunk === null) {
                            continue;
                        }

                        if (first === null) {
                            first = chunk;

                            continue;
                        }

                        // a second occluder covers this position - merge into a
                        // fresh chunk so neither source world is mutated
                        if (combined === null) {
                            combined = new VoxelChunk0(first.key.clone());
                            combined.layer.bitArray.elements.set(first.layer.bitArray.elements);
                        }

                        const target = combined.layer.bitArray.elements;
                        const source = chunk.layer.bitArray.elements;

                        for (let i = 0; i < target.length; i++) {
                            target[i] |= source[i];
                        }
                    }

                    const resolved = combined ?? first;

                    if (resolved !== null) {
                        region.insert(resolved);
                        count++;
                    }
                }
            }
        }

        return count > 0 ? BVXSerializer.saveWorld(region) : null;
    }

    /**
     * Takes delivery of a worker's meshing response.
     *
     * Building the vertex data and replacing the mesh's GPU buffers is as
     * expensive as producing the request was, and responses arrive in bursts -
     * four workers finishing a drain of a hundred chunks deliver a hundred
     * promise callbacks with no frame boundary between them. So this only
     * records the response; _pumpMeshQueue applies it under the frame's budget.
     *
     * The chunk leaves the in-flight set here rather than at apply time, so a
     * chunk that changed again is free to be re-requested without waiting for
     * its previous response to be drawn.
     */
    private _onMeshResponse(lane: MeshLane, response: EditorMeshResponse): void {
        lane.inFlight.delete(response.chunkKey);

        this._readyResponses.push({ lane: lane, response: response });
    }

    /**
     * Applies a meshing response to the chunk's renderable mesh.
     */
    private _applyMeshResponse(lane: MeshLane, response: EditorMeshResponse): void {
        const chunkKey = response.chunkKey;

        // the render mode changed while the request was in flight - the mode
        // switch already queued fresh requests, drop this stale response
        const expected = this._renderMode === "smooth" ? "smooth" : this._renderMode === "wireframe" ? "faces" : "blocky";

        if (response.type === expected) {
            if (response.type === "smooth") {
                this._applySmoothMesh(lane, chunkKey, response.vertices, response.normals, response.indices);
            }
            else if (response.type === "faces") {
                this._applyWireframeMesh(lane, chunkKey, response.faceMasks, response.touched, response.faceCount);
            }
            else if (response.type === "blocky") {
                this._applyBlockyMesh(lane, response);
            }
        }

        // the chunk was edited again while the request was running
        if (lane.dirtyAgain.delete(chunkKey)) {
            this._queueMesh(lane, chunkKey);
        }

        this._publishStats(false);
    }

    /**
     * Fills the reusable occupancy buffer for the chunk at the provided key -
     * the chunk's cells plus `border` cells around them, as the union of the
     * base world and the sand layer. Used to bake per-vertex ambient occlusion.
     *
     * The border is a parameter because the two paths need very different
     * reach and this loop is hot: it runs once per remeshed chunk, and a
     * simulation pouring sand and water remeshes tens of chunks per frame.
     * Filling the smooth path's 3-cell border for the blocky path, which never
     * reads past 1, was doubling the work for nothing.
     */
    private _buildOcclusion(mortonKey: MortonKey, border: number): Uint8Array {
        const occupancy = this._occupancy;

        // Cleared in full, not just the sub-box the blocky path's 1-cell border
        // writes. Measured: one fill(0) over the whole 10,648-byte buffer is
        // 0.125 us, because it is a single vectorised memset; clearing only the
        // border-1 box means 324 short fill() calls and costs 5.5 us - 44 times
        // worse. The narrower clear is also unsafe on the smooth path, whose
        // _sampleOcclusionField clamps into cells this call never wrote and needs
        // them zeroed rather than holding a previous chunk's occupancy.
        occupancy.fill(0);

        // Gather the 3x3x3 neighbourhood of BitVoxel storages for both worlds.
        // Into reused slots, not fresh arrays: this runs once per remeshed
        // chunk and a running simulation remeshes tens of chunks per frame, so
        // two short-lived arrays here is a steady drip of garbage through the
        // busiest path in the editor.
        const baseElements = this._occlusionBase;
        const sandElements = this._occlusionSand;

        let neighbour = 0;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, this._scratchKey);

                    const baseChunk = this._world.get(this._scratchKey);
                    const sandChunk = this._sand.world.get(this._scratchKey);

                    baseElements[neighbour] = baseChunk !== null ? baseChunk.layer.bitArray.elements : null;
                    sandElements[neighbour] = sandChunk !== null ? sandChunk.layer.bitArray.elements : null;
                    neighbour++;
                }
            }
        }

        // the border stays under a chunk wide, so (coord >> 4) + 1 still lands
        // on the right slot of the 3x3x3 neighbourhood for every cell sampled
        const low = -border;
        const high = 15 + border;

        for (let x = low; x <= high; x++) {
            const sx = (x >> 4) + 1;
            const lx = x & 15;

            for (let y = low; y <= high; y++) {
                const sy = (y >> 4) + 1;
                const ly = y & 15;

                for (let z = low; z <= high; z++) {
                    const slot = (sx * 9) + (sy * 3) + ((z >> 4) + 1);
                    const lz = z & 15;

                    const index = ((lx >> 2) << 10) | ((ly >> 2) << 8) | ((lz >> 2) << 6) | ((lx & 3) << 4) | ((ly & 3) << 2) | (lz & 3);
                    const word = index >> 5;
                    const mask = 1 << (index & 31);

                    const base = baseElements[slot];
                    const sand = sandElements[slot];

                    if ((base !== null && (base[word] & mask) !== 0) || (sand !== null && (sand[word] & mask) !== 0)) {
                        occupancy[(x + OCC_BORDER) + ((y + OCC_BORDER) * OCC_STRIDE_Y) + ((z + OCC_BORDER) * OCC_STRIDE_Z)] = 1;
                    }
                }
            }
        }

        return occupancy;
    }

    /**
     * Trilinearly samples the occupancy field at chunk-local BitVoxel
     * coordinates, clamped to the buffer.
     *
     * Interpolating between cells is what makes a binary field usable as a
     * continuous occlusion measure - and it is the whole fix for the mottling
     * the old per-cell corner count produced.
     */
    private _sampleOcclusionField(field: Float32Array | Uint8Array, x: number, y: number, z: number): number {
        const limit = OCC_DIMS - 2;

        const fx = Math.min(limit, Math.max(0, x + OCC_BORDER));
        const fy = Math.min(limit, Math.max(0, y + OCC_BORDER));
        const fz = Math.min(limit, Math.max(0, z + OCC_BORDER));

        const ix = fx | 0;
        const iy = fy | 0;
        const iz = fz | 0;

        const tx = fx - ix;
        const ty = fy - iy;
        const tz = fz - iz;

        const base = ix + (iy * OCC_STRIDE_Y) + (iz * OCC_STRIDE_Z);

        const c000 = field[base];
        const c100 = field[base + 1];
        const c010 = field[base + OCC_STRIDE_Y];
        const c110 = field[base + OCC_STRIDE_Y + 1];
        const c001 = field[base + OCC_STRIDE_Z];
        const c101 = field[base + OCC_STRIDE_Z + 1];
        const c011 = field[base + OCC_STRIDE_Z + OCC_STRIDE_Y];
        const c111 = field[base + OCC_STRIDE_Z + OCC_STRIDE_Y + 1];

        const x00 = c000 + ((c100 - c000) * tx);
        const x10 = c010 + ((c110 - c010) * tx);
        const x01 = c001 + ((c101 - c001) * tx);
        const x11 = c011 + ((c111 - c011) * tx);

        const y0 = x00 + ((x10 - x00) * ty);
        const y1 = x01 + ((x11 - x01) * ty);

        return y0 + ((y1 - y0) * tz);
    }

    /**
     * Applies a finished blocky mesh from the worker.
     *
     * Everything this used to do - building the occlusion field, baking per-corner
     * ambient occlusion, resolving palette colours, expanding four vertices per
     * visible face and picking each quad's split diagonal - now happens in the
     * mesher worker (see mesher.worker.ts and blocky-expand.ts). It was measured
     * at 51 us per chunk on the main thread, 40% of the whole pipeline, and it was
     * what capped streaming at a couple of dozen chunks a frame no matter how many
     * workers were meshing. What is left here is the upload.
     */
    private _applyBlockyMesh(lane: MeshLane, response: BlockyMeshResponse): void {
        const chunkKey = response.chunkKey;
        const mortonKey = this._meshKey;

        mortonKey.key = chunkKey;

        // Nothing to draw, or the response outlived the world it was meshed from.
        //
        // The second case is the one worth spelling out: _replaceWorld clears every
        // lane's meshes and in-flight set on load, undo and new-scene, but a request
        // already running in a worker still delivers. Without the live-chunk test
        // that response rebuilds a mesh for a chunk the world no longer holds, and
        // the mesh has no owner left to retire it. The wireframe path makes the same
        // check for the same reason.
        if (response.faceCount === 0 || lane.world().get(mortonKey) === null) {
            this._disposeOrClear(lane, chunkKey);

            return;
        }

        this._uploadMesh(
            lane,
            chunkKey,
            mortonKey,
            response.positions,
            response.normals,
            response.colors,
            response.occlusion,
            response.indices,
            response.faceCount * 2
        );
    }

    /**
     * Builds a wireframe mesh from the 6-bit face masks - the four edges of every
     * visible face, drawn as a line list.
     *
     * This deliberately outlines each face rather than switching the solid material
     * to BabylonJS's wireframe flag. That flag draws the underlying triangles, so
     * every quad gains a diagonal and a flat wall reads as a field of triangles
     * rather than the voxel grid it actually is.
     *
     * Faces come from the same mask buffer the blocky path uses, so the two modes
     * agree exactly about what is visible: interior faces are culled in both.
     */
    private _applyWireframeMesh(lane: MeshLane, chunkKey: number, faceMasks: Uint8Array, touched: Uint16Array, faceCount: number): void {
        const mortonKey = this._meshKey;

        mortonKey.key = chunkKey;

        const chunk = lane.world().get(mortonKey);

        if (faceCount === 0 || chunk === null) {
            this._disposeOrClear(lane, chunkKey);

            return;
        }

        // four corners per face, and four edges joining them
        const positions = new Float32Array(faceCount * 4 * 3);
        const normals = new Float32Array(faceCount * 4 * 3);
        const colors = new Float32Array(faceCount * 4 * 4);
        const indices = new Uint32Array(faceCount * 8);

        // The line colour comes from the lane's emissive wire material, so the vertex
        // colours are left white - they exist only so a mesh reused from the blocky
        // mode does not keep a stale colour buffer that would tint the lines. No
        // occlusion stream: the unlit wire material never samples one, and
        // _uploadMesh drops the buffer outright in this mode rather than uploading
        // a length-matched dummy.
        colors.fill(1.0);

        let vertex = 0;
        let indexCount = 0;

        for (let t = 0; t < touched.length; t++) {
            const i = touched[t];
            const mask = faceMasks[i];

            // decode the BitVoxel local coordinates from the VoxelIndex key layout
            const x = (((i >> 10) & 3) << 2) | ((i >> 4) & 3);
            const y = (((i >> 8) & 3) << 2) | ((i >> 2) & 3);
            const z = (((i >> 6) & 3) << 2) | (i & 3);

            for (let face = 0; face < 6; face++) {
                if (((mask >> face) & 1) === 0) {
                    continue;
                }

                const corners = FACE_CORNERS[face];
                const normal = FACE_NORMALS[face];
                const base = vertex;

                for (let c = 0; c < 4; c++) {
                    const write = vertex * 3;

                    positions[write] = (x + corners[c][0]) * BIT_VOXEL_SIZE;
                    positions[write + 1] = (y + corners[c][1]) * BIT_VOXEL_SIZE;
                    positions[write + 2] = (z + corners[c][2]) * BIT_VOXEL_SIZE;

                    // unused by the unlit wireframe material, but VertexData wants
                    // a full set and the face normal is the honest value
                    normals[write] = normal[0];
                    normals[write + 1] = normal[1];
                    normals[write + 2] = normal[2];

                    vertex++;
                }

                // the four edges around the quad, as line-list pairs. FACE_CORNERS
                // is wound around the face, so consecutive corners share an edge.
                indices[indexCount] = base;
                indices[indexCount + 1] = base + 1;
                indices[indexCount + 2] = base + 1;
                indices[indexCount + 3] = base + 2;
                indices[indexCount + 4] = base + 2;
                indices[indexCount + 5] = base + 3;
                indices[indexCount + 6] = base + 3;
                indices[indexCount + 7] = base;

                indexCount += 8;
            }
        }

        this._uploadMesh(lane, chunkKey, mortonKey, positions, normals, colors, null, indices, faceCount * 2);
    }

    /**
     * Uploads a smooth mesh, colouring each vertex from the lane colour or from
     * the meta-data of the nearest solid BitVoxel of its source surface cell.
     */
    private _applySmoothMesh(lane: MeshLane, chunkKey: number, vertices: Float32Array, normals: Float32Array, indices: Uint32Array): void {
        if (indices.length === 0) {
            this._disposeOrClear(lane, chunkKey);

            return;
        }

        const mortonKey = this._meshKey;

        mortonKey.key = chunkKey;

        const vertexCount = vertices.length / 3;
        const colors = new Float32Array(vertexCount * 4);
        const occlusion = new Float32Array(vertexCount);

        const isWater = lane === this._waterLane;

        // Crevice ambient occlusion from a blurred copy of the surrounding
        // occupancy. This replaces a count of the eight solid corners of the
        // vertex's cell, which was the single largest source of the mottled
        // "dirty" surface: adjacent vertices sit in adjacent cells, and an
        // integer corner count changes by a whole step between them however
        // gently the geometry actually turns.
        //
        // Both lanes read the raw occupancy, trilinearly. An earlier version
        // blurred it first, which was the single most expensive thing the
        // editor did while a simulation ran - about 9 ms of a 32 ms frame - and
        // it turns out to buy nothing: what removed the mottling was the
        // trilinear interpolation, not the blur. Sampling a binary field
        // between its cells is already continuous, and the three taps along the
        // normal give the width the blur was there to provide.
        //
        // Water needs only the 1-cell border, because it reads the field at the
        // vertex rather than sweeping it outward.
        const field = this._buildOcclusion(mortonKey, isWater ? 1 : OCC_BORDER);

        if (lane.color !== null) {
            // flat lane colour
            const [r, g, b] = lane.color;

            for (let i = 0; i < vertexCount; i++) {
                const write = i * 4;

                colors[write] = r;
                colors[write + 1] = g;
                colors[write + 2] = b;
                colors[write + 3] = 1.0;
            }
        }
        else {
            const chunkX = mortonKey.x * 16;
            const chunkY = mortonKey.y * 16;
            const chunkZ = mortonKey.z * 16;

            for (let i = 0; i < vertexCount; i++) {
                const read = i * 3;

                // the surface cell that owns this vertex (min-corner sample)
                const px = (vertices[read] / BIT_VOXEL_SIZE) - 0.5;
                const py = (vertices[read + 1] / BIT_VOXEL_SIZE) - 0.5;
                const pz = (vertices[read + 2] / BIT_VOXEL_SIZE) - 0.5;

                const cx = Math.floor(px);
                const cy = Math.floor(py);
                const cz = Math.floor(pz);

                // pick the closest solid corner of the cell for the colour
                let best = -1;
                let bestDistance = Infinity;

                for (let corner = 0; corner < 8; corner++) {
                    const dx = corner & 1;
                    const dy = (corner >> 1) & 1;
                    const dz = (corner >> 2) & 1;

                    const gx = chunkX + cx + dx;
                    const gy = chunkY + cy + dy;
                    const gz = chunkZ + cz + dz;

                    if (gx < 0 || gy < 0 || gz < 0 || this._getBitVoxelAt(gx, gy, gz) !== 1) {
                        continue;
                    }

                    const distance = ((px - (cx + dx)) ** 2) + ((py - (cy + dy)) ** 2) + ((pz - (cz + dz)) ** 2);

                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = corner;
                    }
                }

                let rgb = PALETTE[0].rgb;

                if (best >= 0) {
                    const meta = this._getMetaAt(chunkX + cx + (best & 1), chunkY + cy + ((best >> 1) & 1), chunkZ + cz + ((best >> 2) & 1));
                    rgb = PALETTE[(meta ?? 0) % PALETTE.length].rgb;
                }

                const write = i * 4;

                colors[write] = rgb[0];
                colors[write + 1] = rgb[1];
                colors[write + 2] = rgb[2];
                colors[write + 3] = 1.0;
            }

            this._relaxSmoothColors(colors, indices, vertexCount);
        }

        for (let i = 0; i < vertexCount; i++) {
            const read = i * 3;

            const px = vertices[read] / BIT_VOXEL_SIZE;
            const py = vertices[read + 1] / BIT_VOXEL_SIZE;
            const pz = vertices[read + 2] / BIT_VOXEL_SIZE;

            let occluded: number;

            if (isWater) {
                // A water surface is flat and faces the sky, so sweeping along
                // its normal finds nothing but air. What matters there is what
                // is beside it, so the field is read where the vertex actually
                // sits - high against a bank, zero in open water.
                occluded = this._sampleOcclusionField(field, px, py, pz);
            }
            else {
                const nx = normals[read];
                const ny = normals[read + 1];
                const nz = normals[read + 2];

                // walk outward along the normal - what is still solid out there
                // is what is occluding this point
                occluded = 0;

                for (let tap = 0; tap < SMOOTH_AO_TAPS.length; tap++) {
                    const distance = SMOOTH_AO_TAPS[tap];

                    occluded += this._sampleOcclusionField(
                        field,
                        px + (nx * distance),
                        py + (ny * distance),
                        pz + (nz * distance)
                    ) * SMOOTH_AO_WEIGHTS[tap];
                }
            }

            const open = isWater ? SHORE_OPEN : SMOOTH_AO_OPEN;
            const closed = isWater ? SHORE_CLOSED : SMOOTH_AO_CLOSED;
            const t = Math.min(1, Math.max(0, (occluded - open) / (closed - open)));

            // smoothstep, so open ground stays exactly open and the falloff
            // into a crease has no visible onset
            const openness = 1.0 - (t * t * (3 - (2 * t)));

            occlusion[i] = openness;

            if (isWater) {
                this._writeShore(colors, i, 1.0 - openness);
            }
        }

        if (isWater) {
            // Sampled at a single point against a binary field, the shoreline
            // mask comes out nearly binary too - present, but with no gradient
            // for the surf to fade along. The same one-ring relaxation the
            // solids use for colour turns it into the soft rim it needs to be,
            // for one walk over the index buffer rather than the several extra
            // field samples per vertex it would otherwise take.
            this._relaxSmoothColors(colors, indices, vertexCount);
        }

        this._uploadMesh(lane, chunkKey, mortonKey, vertices, normals, colors, occlusion, indices, indices.length / 3);
    }

    /**
     * Stores a water vertex's shoreline proximity (0 = open water, 1 = against
     * a bank) in its vertex colour.
     *
     * The water shader composes its colour from depth, fresnel and light and
     * never reads the albedo, so the colour buffer is free real estate on that
     * lane. It is used rather than the dedicated occlusion attribute because
     * the water material runs a depth pre-pass: adding an attribute makes its
     * two passes disagree about the vertex layout, and on WebGPU that does not
     * fail loudly - it invalidates the command encoder and the entire frame,
     * scene and all, silently fails to present.
     */
    private _writeShore(colors: Float32Array, vertex: number, shore: number): void {
        const write = vertex * 4;

        colors[write] = shore;
        colors[write + 1] = shore;
        colors[write + 2] = shore;
        colors[write + 3] = 1.0;
    }

    /**
     * Blends each smooth vertex's colour toward the average of the vertices it
     * shares a triangle edge with.
     *
     * Surface-nets colours are sampled per cell, so a material boundary lands
     * on the mesh as a hard, jagged step. One relaxation pass over the index
     * buffer turns it into a one-vertex-wide gradient without any world
     * lookups - the whole pass is a single walk over the triangles plus a walk
     * over the vertices.
     */
    private _relaxSmoothColors(colors: Float32Array, indices: Uint32Array, vertexCount: number): void {
        if (this._relaxWeights.length < vertexCount) {
            this._relaxColors = new Float32Array(vertexCount * 3);
            this._relaxWeights = new Float32Array(vertexCount);
        }

        const sums = this._relaxColors;
        const weights = this._relaxWeights;

        sums.fill(0, 0, vertexCount * 3);
        weights.fill(0, 0, vertexCount);

        for (let i = 0; i < indices.length; i += 3) {
            for (let edge = 0; edge < 3; edge++) {
                const from = indices[i + edge];
                const to = indices[i + ((edge + 1) % 3)];

                const readTo = to * 4;
                const readFrom = from * 4;
                const writeFrom = from * 3;
                const writeTo = to * 3;

                sums[writeFrom] += colors[readTo];
                sums[writeFrom + 1] += colors[readTo + 1];
                sums[writeFrom + 2] += colors[readTo + 2];
                weights[from]++;

                sums[writeTo] += colors[readFrom];
                sums[writeTo + 1] += colors[readFrom + 1];
                sums[writeTo + 2] += colors[readFrom + 2];
                weights[to]++;
            }
        }

        for (let i = 0; i < vertexCount; i++) {
            const weight = weights[i];

            if (weight === 0) {
                continue;
            }

            const read = i * 3;
            const write = i * 4;
            const inverse = 1 / weight;

            colors[write] += (((sums[read] * inverse) - colors[write]) * SMOOTH_COLOR_RELAX);
            colors[write + 1] += (((sums[read + 1] * inverse) - colors[write + 1]) * SMOOTH_COLOR_RELAX);
            colors[write + 2] += (((sums[read + 2] * inverse) - colors[write + 2]) * SMOOTH_COLOR_RELAX);
        }
    }

    /**
     * Creates or updates the renderable mesh for a chunk of the provided lane.
     */
    private _uploadMesh(lane: MeshLane, chunkKey: number, mortonKey: MortonKey, positions: Float32Array, normals: Float32Array, colors: Float32Array, occlusion: Float32Array | null, indices: Uint32Array, triangles: number): void {
        const wire = this._renderMode === "wireframe";

        let mesh = lane.meshes.get(chunkKey);

        if (!mesh) {
            mesh = new Mesh(`${lane.id}-${chunkKey}`, this._scene);

            mesh.isPickable = false;

            // a mesh created while in wireframe mode joins no shadow map; the
            // mode switch rebuilds the caster list wholesale either way
            if (!wire && lane !== this._waterLane) {
                this._shadows.addShadowCaster(mesh, false);
            }

            lane.meshes.set(chunkKey, mesh);
        }

        // a mesh emptied by _disposeOrClear and refilled here comes back visible
        mesh.isVisible = true;

        // meshes survive a render-mode switch, so the material is reassigned on
        // every upload rather than only at creation
        mesh.material = wire ? lane.wireMaterial : lane.material;
        mesh.receiveShadows = !wire;

        mesh.position.set(mortonKey.x * 16 * BIT_VOXEL_SIZE, mortonKey.y * 16 * BIT_VOXEL_SIZE, mortonKey.z * 16 * BIT_VOXEL_SIZE);

        // Only the materials that actually read the baked occlusion get it. The
        // water shader takes its shoreline from the vertex colour and the
        // wireframe material is unlit, so uploading a whole extra vertex buffer
        // for them is a GPU allocation per chunk per remesh that nothing ever
        // samples - and water is the lane a running simulation remeshes hardest.
        const wantsOcclusion = occlusion !== null && !wire && lane !== this._waterLane;

        const vertexCount = positions.length / 3;
        const stored = lane.capacity.get(chunkKey);

        // Reuse the buffers already on the mesh when the new geometry fits them
        // and the attribute set has not changed. This is the path that matters:
        // setVerticesData always allocates a fresh VertexBuffer and frees the old
        // one, so without it every remesh of every chunk churns its whole set of
        // device buffers, and a simulation remeshes tens of chunks a frame.
        const reusable = stored !== undefined
            && mesh.geometry !== null
            && vertexCount <= stored.vertices
            && indices.length <= stored.indices
            && wantsOcclusion === mesh.isVerticesDataPresent(BVX_AO_KIND);

        if (reusable) {
            // updateExtends false throughout: it would recompute the bounds from
            // the buffer's full capacity rather than the live vertices, reading
            // the unwritten tail as a run of zeroes and dragging every chunk's
            // box back to its local origin. They are set explicitly below.
            mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false);
            mesh.updateVerticesData(VertexBuffer.NormalKind, normals, false);
            mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false);

            if (wantsOcclusion) {
                mesh.updateVerticesData(BVX_AO_KIND, occlusion!, false);
            }

            // Babylon tracks the geometry's vertex count separately from the
            // buffers, and updateVerticesData does not revise it - it was set when
            // the buffers were created, to their padded capacity. Left alone it
            // disagrees with the data now in them, and everything that sizes a read
            // from it (getVerticesData, refreshBoundingInfo, the SubMesh rebuild
            // just below) then runs off the end of the live vertices. The draw
            // itself is index-driven and would not notice, which is exactly what
            // makes this worth correcting rather than leaving latent.
            const geometry = mesh.geometry!;

            // Written through a cast because Babylon exposes no setter for it.
            // The public route, setVerticesBuffer(buffer, totalVertices), takes the
            // count but also re-derives the bounding extent from the padded buffer
            // and walks every mesh sharing the geometry resetting caches - all of
            // which this path either does itself or does not want.
            (geometry as unknown as { _totalVertices: number })._totalVertices = vertexCount;

            // Geometry.updateIndices writes into the existing index buffer and,
            // when the count changed, rebuilds the mesh's global SubMesh from the
            // new length - which is what keeps the draw from running off the end
            // of the live geometry into the slack. It reads the vertex count set
            // above, so that assignment has to come first.
            geometry.updateIndices(indices, 0, false);

            this._setChunkBounds(mesh, positions, vertexCount);
        }
        else {
            // Grow with slack, so a chunk whose face count drifts up and down -
            // which is every chunk a fluid passes through - stops reallocating
            // after the first couple of remeshes.
            const capacity = {
                vertices: Math.max(64, Math.ceil(vertexCount * 1.5)),
                indices: Math.max(96, Math.ceil(indices.length * 1.5))
            };

            const data = new VertexData();

            data.positions = this._padded(positions, capacity.vertices * 3);
            data.normals = this._padded(normals, capacity.vertices * 3);
            data.colors = this._padded(colors, capacity.vertices * 4);

            // Index padding repeats index 0 rather than being left at zero for a
            // different reason than the vertex streams: these are degenerate
            // triangles the SubMesh excludes anyway, and 0 is guaranteed to be a
            // vertex that exists.
            data.indices = this._paddedIndices(indices, capacity.indices);

            data.applyToMesh(mesh, true);

            // VertexData only understands Babylon's own vertex kinds, so the
            // occlusion stream is attached separately - after applyToMesh, which
            // rebuilds the geometry whenever the vertex count changes.
            if (wantsOcclusion) {
                mesh.setVerticesData(BVX_AO_KIND, this._padded(occlusion!, capacity.vertices), true, 1);
            }
            else if (mesh.isVerticesDataPresent(BVX_AO_KIND)) {
                mesh.removeVerticesData(BVX_AO_KIND);
            }

            // The padding is slack, not geometry. applyToMesh took the geometry's
            // vertex count from the padded buffers, so correct it to the live
            // count for the same reason the reuse path does, then bring the
            // SubMesh back to the live counts and set the bounds from the live
            // vertices.
            (mesh.geometry as unknown as { _totalVertices: number })._totalVertices = vertexCount;

            const sub = mesh.subMeshes.length > 0 ? mesh.subMeshes[0] : null;

            if (sub !== null) {
                sub.indexStart = 0;
                sub.indexCount = indices.length;
                sub.verticesStart = 0;
                sub.verticesCount = vertexCount;
            }

            this._setChunkBounds(mesh, positions, vertexCount);

            lane.capacity.set(chunkKey, capacity);
        }

        // A chunk never moves once placed, so its world matrix is computed here
        // rather than every frame for every one of the region's meshes.
        //
        // After the geometry, and on every upload, both of which matter. The
        // frustum test reads the bounding box in world space, and that is
        // produced by transforming the *local* box - which does not exist until
        // the vertices are applied, and changes whenever they are replaced.
        // Freezing before that leaves every chunk's culling bounds sitting at
        // the origin, and since all of them then share one box, whole regions
        // of the world blink out at whatever camera angles put that box off
        // screen. freezeWorldMatrix() unfreezes and recomputes internally, so
        // calling it repeatedly is safe.
        mesh.freezeWorldMatrix();

        // the engine runs in non-compatibility mode, where a mesh's draw is
        // cached as a render bundle that holds its buffers - the geometry this
        // upload just replaced is exactly what such a bundle would still be
        // pointing at
        mesh.resetDrawCache();

        lane.triangles.set(chunkKey, triangles);
    }

    /**
     * Copies the provided data into a buffer of exactly `length`, leaving the
     * tail at zero. Used to size a chunk's vertex streams past the geometry in
     * them so later remeshes can write in place.
     */
    private _padded(data: Float32Array, length: number): Float32Array {
        if (data.length === length) {
            return data;
        }

        const out = new Float32Array(length);

        out.set(data);

        return out;
    }

    /**
     * As _padded, for an index buffer - the tail repeats index 0 so every value
     * in the buffer addresses a vertex that exists, even though the SubMesh
     * excludes the padding from the draw.
     */
    private _paddedIndices(indices: Uint32Array, length: number): Uint32Array {
        if (indices.length === length) {
            return indices;
        }

        const out = new Uint32Array(length);

        out.set(indices);

        return out;
    }

    /**
     * Sets a chunk mesh's local bounding box from its live vertices.
     *
     * Needed because the vertex buffers are larger than the geometry in them, so
     * Babylon's own extent pass - which reads the buffer's full capacity - would
     * fold the unwritten tail's zeroes into the box and pull it back toward the
     * chunk's local origin. An over-large box costs culling accuracy; a box
     * anchored at the origin makes chunks vanish at camera angles that put that
     * corner off screen, which is the failure the frozen world matrix below was
     * already written to avoid.
     */
    private _setChunkBounds(mesh: Mesh, positions: Float32Array, vertexCount: number): void {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        const limit = vertexCount * 3;

        for (let i = 0; i < limit; i += 3) {
            const x = positions[i];
            const y = positions[i + 1];
            const z = positions[i + 2];

            if (x < minX) { minX = x; }
            if (x > maxX) { maxX = x; }
            if (y < minY) { minY = y; }
            if (y > maxY) { maxY = y; }
            if (z < minZ) { minZ = z; }
            if (z > maxZ) { maxZ = z; }
        }

        if (minX > maxX) {
            return;
        }

        const min = this._boundsMin.set(minX, minY, minZ);
        const max = this._boundsMax.set(maxX, maxY, maxZ);

        mesh.getBoundingInfo().reConstruct(min, max);
    }

    /**
     * Retires the mesh of a chunk that no longer has visible geometry.
     *
     * Hidden and emptied rather than disposed, and kept in the lane's map. A
     * chunk losing its geometry is not a rare event during a simulation - a
     * water body draining empties chunks at the same rate it fills others - and
     * disposal is where that gets expensive. Every dispose is four linear scans
     * over lists that are now region-sized: the shadow map's caster list twice
     * (once from removeShadowCaster, once from dispose's own walk of the scene's
     * lights), then scene.meshes and scene.rootNodes. Creating the replacement
     * pays another. For water-lane meshes, which are never casters at all, the
     * caster scans walk the entire list to find nothing.
     *
     * Keeping the mesh costs one entry in each of those lists and an empty draw
     * that culls immediately, and the next _uploadMesh refills it in place.
     */
    private _disposeOrClear(lane: MeshLane, chunkKey: number): void {
        const mesh = lane.meshes.get(chunkKey);

        if (mesh) {
            // Hidden, and nothing else. Not disposed, and its geometry not
            // released either, because both of those churn DrawWrappers - and a
            // DrawWrapper disposal decrements the refcount of the per-pass effect
            // it held. A lane that momentarily empties in full, which is exactly
            // what a water body does when a tunnel drains it, can take that
            // refcount to zero and throw the compiled pipelines away; the next
            // chunk to refill then blocks the frame recompiling them. That is a
            // hundreds-of-milliseconds stall, and the only mechanism in this
            // renderer capable of one.
            //
            // The cost of holding on is the vertex buffers of whatever the chunk
            // last contained, for a mesh count bounded by the region. That is a
            // trade worth making, and the buffers are what the chunk will be
            // refilled into anyway.
            mesh.isVisible = false;
        }

        lane.triangles.delete(chunkKey);
    }

    // ------------------------------------------------------------------ cursor

    /**
     * Positions and sizes the hover cursor over the current brush target.
     */
    private _updateCursor(cell: [number, number, number] | null): void {
        if (!cell || this._tool === "pick") {
            this._cursor.isVisible = this._tool === "pick" && cell !== null;

            if (cell && this._tool === "pick") {
                this._positionCursor(cell, 1);
            }

            return;
        }

        this._positionCursor(cell, this._brushSize);
        this._cursor.isVisible = true;
    }

    private _positionCursor(center: [number, number, number], size: number): void {
        const low = Math.floor((size - 1) / 2);

        const minX = center[0] - low;
        const minY = center[1] - low;
        const minZ = center[2] - low;

        this._cursor.scaling.setAll(size * BIT_VOXEL_SIZE * 1.002);
        this._cursor.position.set(
            (minX + size / 2) * BIT_VOXEL_SIZE,
            (minY + size / 2) * BIT_VOXEL_SIZE,
            (minZ + size / 2) * BIT_VOXEL_SIZE
        );
    }

    private _updateCursorStyle(): void {
        const colors: Record<EditorTool, string> = {
            paint: "#6c8cff",
            erase: "#e8593f",
            pick: "#f2a83b",
            sand: "#e8c26f",
            water: "#478fea"
        };

        this._cursorMaterial.emissiveColor = Color3.FromHexString(colors[this._tool]);
        this._cursor.edgesColor = Color4.FromHexString(colors[this._tool] + "ff");
    }

    // ------------------------------------------------------------------- stats

    /**
     * Publishes scene statistics to the UI. Unforced publishes are throttled so
     * the running simulation does not spam React re-renders.
     */
    private _publishStats(force: boolean): void {
        if (!this.onStats) {
            return;
        }

        const now = performance.now();

        if (!force && now - this._statsTimer < 250) {
            this._statsDirty = true;

            return;
        }

        this._statsDirty = false;
        this._statsTimer = now;

        let bitVoxels = 0;
        let chunks = 0;

        for (const chunk of this._world.chunks.values()) {
            bitVoxels += chunk.length;
            chunks++;
        }

        let triangles = 0;

        for (const lane of this._lanes) {
            for (const count of lane.triangles.values()) {
                triangles += count;
            }
        }

        this.onStats({
            chunks: chunks,
            bitVoxels: bitVoxels,
            triangles: triangles,
            workers: this._pool.size,
            sandGrains: this._sand.grainCount,
            waterGrains: this._water.grainCount,
            activeGrains: this._sand.activeCount + this._water.activeCount,
            fps: this._engine.getFps(),
            cpuFrameTime: this._cpuFrameTime,
            drawnMeshes: this._scene.getActiveMeshes().length
        });
    }

    private _notifyHistory(): void {
        this.onHistoryChanged?.(this._undoStack.length > 0, this._redoStack.length > 0);
    }
}
