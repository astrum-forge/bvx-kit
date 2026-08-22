import {
    ArcRotateCamera,
    Color3,
    Color4,
    ColorCurves,
    DefaultRenderingPipeline,
    DirectionalLight,
    Engine,
    HemisphericLight,
    Matrix,
    Mesh,
    MeshBuilder,
    Scene,
    ShadowGenerator,
    StandardMaterial,
    Vector3,
    VertexData
} from "@babylonjs/core";
import { GhibliToonPlugin, GhibliWaterPlugin, createSky } from "./ghibli";
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
    type MesherRequest,
    type MesherResponse,
    type VoxelChunk
} from "@astrumforge/bvx-kit";
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
export type RenderMode = "blocky" | "smooth";

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
 * The size of one BitVoxel in world units, matching the bvx-kit geometry space
 * (4 BitVoxels per 1.0 unit Voxel, 16 BitVoxels per 4.0 unit chunk).
 */
const BIT_VOXEL_SIZE = 0.25;

/**
 * The editable region in chunks per axis (8 x 8 x 8 chunks = 128 BitVoxels per axis).
 */
const REGION_CHUNKS = 8;

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
 * Flat colours for the physics lanes.
 */
const SAND_COLOR: [number, number, number] = [0.91, 0.76, 0.44];
const WATER_COLOR: [number, number, number] = [0.28, 0.56, 0.92];

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
 * The two tangent axes of each face (the axes the face spans), indexed by the
 * VoxelFaceGeometry face bit index. Used by the ambient occlusion baking.
 */
const FACE_TANGENTS: number[][] = [
    [1, 2], [1, 2], [0, 2], [0, 2], [0, 1], [0, 1]
];

/**
 * Vertex brightness for the 4 baked ambient occlusion levels (0 = fully
 * occluded corner, 3 = fully open).
 */
const AO_LEVELS: number[] = [0.55, 0.72, 0.86, 1.0];

/**
 * Occupancy buffer dimensions - one chunk plus a 1-cell border (18^3 cells,
 * offset by +1 per axis).
 */
const OCC_DIMS = 18;
const OCC_STRIDE_Y = OCC_DIMS;
const OCC_STRIDE_Z = OCC_DIMS * OCC_DIMS;

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
    private readonly _engine: Engine;
    private readonly _scene: Scene;
    private readonly _camera: ArcRotateCamera;
    private readonly _pool: MesherPool;
    private readonly _resizeObserver: ResizeObserver;
    private _shadows!: ShadowGenerator;

    // direction toward the sun - drives the water glints and the sky dome
    private _sunDirection!: Vector3;

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

    // hover cursor
    private readonly _cursor: Mesh;
    private readonly _cursorMaterial: StandardMaterial;

    // shared scratch objects to avoid per-event allocations
    private readonly _scratchKey = new MortonKey();
    private readonly _scratchIndex = new VoxelIndex();
    private readonly _scratchDirty = new Set<number>();
    private readonly _scratchPropagate = new Set<number>();

    // reusable occupancy buffer for ambient occlusion baking - one chunk plus a
    // 1-cell border, holding the union of base world and sand occupancy
    private readonly _occupancy = new Uint8Array(OCC_DIMS * OCC_DIMS * OCC_DIMS);

    // throttled stats publishing - _statsDirty marks a dropped publish that the
    // render loop flushes once the throttle window has passed
    private _statsTimer = 0;
    private _statsDirty = false;

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

    constructor(canvas: HTMLCanvasElement) {
        this._canvas = canvas;
        this._engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false }, true);
        this._scene = new Scene(this._engine);
        this._pool = new MesherPool();

        const scene = this._scene;

        // right-handed to match the counter-clockwise outward winding produced
        // by the bvx-kit geometry generators with flipped = false
        scene.useRightHandedSystem = true;
        scene.clearColor = Color4.FromHexString("#bfdcecff");

        // orbit camera - all navigation input is handled manually (see the
        // pointer/wheel handlers) so mouse and trackpad devices both get
        // predictable, production-grade controls
        const regionUnits = REGION * BIT_VOXEL_SIZE;
        const target = new Vector3(regionUnits / 2, regionUnits / 8, regionUnits / 2);

        this._camera = new ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, regionUnits * 1.1, target, scene);
        this._camera.minZ = 0.05;

        // lighting - a blue sky dome with warm ground bounce, a warm
        // shadow-casting sun and a faint cool fill from the opposite side. The
        // toon ramps in the Ghibli plugins are tuned to this rig's intensities.
        const ambient = new HemisphericLight("ambient", new Vector3(0.2, 1.0, 0.3), scene);
        ambient.intensity = 0.55;
        ambient.diffuse = new Color3(0.68, 0.80, 0.95);
        ambient.groundColor = new Color3(0.50, 0.47, 0.38);
        ambient.specular = Color3.Black();

        const key = new DirectionalLight("key", new Vector3(-0.55, -0.8, -0.35), scene);
        key.intensity = 1.15;
        key.diffuse = new Color3(1.0, 0.94, 0.78);
        key.position = new Vector3(regionUnits * 1.2, regionUnits * 1.6, regionUnits * 1.1);

        const fill = new DirectionalLight("fill", new Vector3(0.6, -0.25, 0.5), scene);
        fill.intensity = 0.12;
        fill.diffuse = new Color3(0.55, 0.65, 0.90);
        fill.specular = Color3.Black();

        // direction toward the sun, shared by the water glints and the sky
        this._sunDirection = key.direction.negate().normalize();

        // soft (PCF) shadows from the key light
        this._shadows = new ShadowGenerator(2048, key);
        this._shadows.usePercentageCloserFiltering = true;
        this._shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
        this._shadows.bias = 0.0008;
        this._shadows.normalBias = 0.02;

        // a soft meadow ground plane anchors the scene and catches shadows,
        // shaded with the same toon ramp as the voxels
        const ground = MeshBuilder.CreateGround("ground", { width: regionUnits * 6, height: regionUnits * 6 }, scene);
        ground.position.set(regionUnits / 2, -0.02, regionUnits / 2);
        ground.isPickable = false;
        ground.receiveShadows = true;

        const groundMaterial = new StandardMaterial("ground-mat", scene);
        groundMaterial.diffuseColor = Color3.FromHexString("#94bd72");
        groundMaterial.specularColor = Color3.Black();
        ground.material = groundMaterial;

        new GhibliToonPlugin(groundMaterial);

        // the gradient sky dome with drifting clouds and the sun
        createSky(scene, new Vector3(regionUnits / 2, 0, regionUnits / 2), this._sunDirection);

        // soft atmospheric haze toward the horizon colour, starting well
        // beyond the editable region
        scene.fogMode = Scene.FOGMODE_LINEAR;
        scene.fogStart = regionUnits * 2.5;
        scene.fogEnd = regionUnits * 6;
        scene.fogColor = Color3.FromHexString("#dfe8dd");

        // post-processing - anti-aliasing, gentle contrast/saturation, a soft
        // bloom for the water glints and a light vignette
        const pipeline = new DefaultRenderingPipeline("post", false, scene, [this._camera]);
        pipeline.fxaaEnabled = true;
        pipeline.bloomEnabled = true;
        pipeline.bloomThreshold = 0.85;
        pipeline.bloomWeight = 0.18;
        pipeline.bloomKernel = 48;
        pipeline.bloomScale = 0.5;
        pipeline.imageProcessingEnabled = true;
        pipeline.imageProcessing.contrast = 1.06;
        pipeline.imageProcessing.exposure = 1.02;
        pipeline.imageProcessing.vignetteEnabled = true;
        pipeline.imageProcessing.vignetteWeight = 1.1;
        pipeline.imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);

        const curves = new ColorCurves();
        curves.globalSaturation = 18;
        pipeline.imageProcessing.colorCurvesEnabled = true;
        pipeline.imageProcessing.colorCurves = curves;

        this._buildGrid();

        // renderable lanes - each lists the worlds that occlude its hidden
        // geometry at layer interfaces. The opaque lanes (base, sand) occlude
        // each other and partition their shared smooth surface via the
        // primary/secondary mode pairing. Water lists both opaque lanes so its
        // hidden contact skin is culled, while nothing lists water - the
        // ground stays visible through the translucent surface.
        this._baseLane = this._makeLane("base", () => this._world, null, 1.0, [(): VoxelWorld => this._sand.world], "primary");
        this._sandLane = this._makeLane("sand", () => this._sand.world, SAND_COLOR, 1.0, [(): VoxelWorld => this._world], "secondary");
        this._waterLane = this._makeLane("water", () => this._water.world, WATER_COLOR, 0.55, [(): VoxelWorld => this._world, (): VoxelWorld => this._sand.world], "overlay");
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

            if (this._statsDirty && performance.now() - this._statsTimer >= 250) {
                this._publishStats(true);
            }
        });

        this._engine.runRenderLoop(() => scene.render());
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
        this._remeshAll();
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

        let ticks = 0;
        let moves = 0;

        while (this._physicsAccumulator >= tickMillis && ticks < PHYSICS_MAX_TICKS_PER_FRAME) {
            moves += this._physics.update();
            this._physicsAccumulator -= tickMillis;
            ticks++;
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
            this._requestMesh(lane, key);
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
            this._requestMesh(lane, key);
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
                this._requestMesh(lane, key);
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

        // gentle rolling terrain with height-banded colours - sand around the
        // waterline, grass above, stone and snow on the peaks
        for (let x = 0; x < REGION; x++) {
            for (let z = 0; z < REGION; z++) {
                const nx = x / REGION;
                const nz = z / REGION;

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

        // a floating blobby island
        const island: [number, number, number, number, number][] = [
            [40, 30, 74, 9, 10], [58, 34, 48, 7, 12], [86, 32, 84, 6, 3]
        ];

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
    private _makeLane(id: string, world: () => VoxelWorld, color: [number, number, number] | null, alpha: number, occluders: (() => VoxelWorld)[], occlusionMode: SmoothOcclusionMode): MeshLane {
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

        return {
            id: id,
            world: world,
            meshes: new Map<number, Mesh>(),
            triangles: new Map<number, number>(),
            inFlight: new Set<number>(),
            dirtyAgain: new Set<number>(),
            color: color,
            material: material,
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
                this._shadows.removeShadowCaster(mesh);
                mesh.dispose();
            }

            lane.meshes.clear();
            lane.triangles.clear();
            lane.inFlight.clear();
            lane.dirtyAgain.clear();
        }

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
                this._requestMesh(lane, key);
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
            this._publishStats(true);
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
            this._requestMesh(this._baseLane, key);
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
            this._requestMesh(this._baseLane, key);
        }

        // restored base occupancy occludes the sand and water lanes
        this._remeshOccluded([this._sandLane, this._waterLane], new Set(snapshots.keys()));

        this._publishStats(true);
    }

    // ---------------------------------------------------------------- meshing

    /**
     * Queues a meshing request for a chunk of the provided lane. If a request
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
        const request: MesherRequest = this._renderMode === "blocky"
            ? { id: 0, type: "faces", chunkKey: chunkKey, flipped: true, world: snapshot }
            : { id: 0, type: "smooth", chunkKey: chunkKey, smoothing: this._smoothing, flipped: true, world: snapshot };

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
     * Applies a meshing response to the chunk's renderable mesh.
     */
    private _onMeshResponse(lane: MeshLane, response: MesherResponse): void {
        const chunkKey = response.chunkKey;

        lane.inFlight.delete(chunkKey);

        // the render mode changed while the request was in flight - the mode
        // switch already queued fresh requests, drop this stale response
        const expected = this._renderMode === "blocky" ? "faces" : "smooth";

        if (response.type === expected) {
            if (response.type === "faces") {
                this._applyBlockyMesh(lane, chunkKey, response.faceMasks);
            }
            else {
                this._applySmoothMesh(lane, chunkKey, response.vertices, response.normals, response.indices);
            }
        }

        // the chunk was edited again while the request was running
        if (lane.dirtyAgain.delete(chunkKey)) {
            this._requestMesh(lane, chunkKey);
        }

        this._publishStats(false);
    }

    /**
     * Fills the reusable occupancy buffer for the chunk at the provided key -
     * the chunk's cells plus a 1-cell border, as the union of the base world
     * and the sand layer. Used to bake per-vertex ambient occlusion.
     */
    private _buildOcclusion(mortonKey: MortonKey): Uint8Array {
        const occupancy = this._occupancy;

        occupancy.fill(0);

        // gather the 3x3x3 neighbourhood of BitVoxel storages for both worlds
        const baseElements: (Uint32Array | null)[] = [];
        const sandElements: (Uint32Array | null)[] = [];

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    MortonKey.from(mortonKey.x + ox, mortonKey.y + oy, mortonKey.z + oz, this._scratchKey);

                    const baseChunk = this._world.get(this._scratchKey);
                    const sandChunk = this._sand.world.get(this._scratchKey);

                    baseElements.push(baseChunk !== null ? baseChunk.layer.bitArray.elements : null);
                    sandElements.push(sandChunk !== null ? sandChunk.layer.bitArray.elements : null);
                }
            }
        }

        for (let x = -1; x <= 16; x++) {
            const sx = (x >> 4) + 1;
            const lx = x & 15;

            for (let y = -1; y <= 16; y++) {
                const sy = (y >> 4) + 1;
                const ly = y & 15;

                for (let z = -1; z <= 16; z++) {
                    const slot = (sx * 9) + (sy * 3) + ((z >> 4) + 1);
                    const lz = z & 15;

                    const index = ((lx >> 2) << 10) | ((ly >> 2) << 8) | ((lz >> 2) << 6) | ((lx & 3) << 4) | ((ly & 3) << 2) | (lz & 3);
                    const word = index >> 5;
                    const mask = 1 << (index & 31);

                    const base = baseElements[slot];
                    const sand = sandElements[slot];

                    if ((base !== null && (base[word] & mask) !== 0) || (sand !== null && (sand[word] & mask) !== 0)) {
                        occupancy[(x + 1) + ((y + 1) * OCC_STRIDE_Y) + ((z + 1) * OCC_STRIDE_Z)] = 1;
                    }
                }
            }
        }

        return occupancy;
    }

    /**
     * Builds a compact blocky mesh from the 6-bit face masks - one coloured quad
     * per visible BitVoxel face.
     */
    private _applyBlockyMesh(lane: MeshLane, chunkKey: number, faceMasks: Uint8Array): void {
        const mortonKey = new MortonKey(chunkKey);
        const chunk = lane.world().get(mortonKey);

        // count the visible faces to size the buffers exactly
        let faceCount = 0;

        for (let i = 0; i < faceMasks.length; i++) {
            let mask = faceMasks[i];

            while (mask !== 0) {
                mask &= mask - 1;
                faceCount++;
            }
        }

        if (faceCount === 0 || chunk === null) {
            this._disposeOrClear(lane, chunkKey);

            return;
        }

        const positions = new Float32Array(faceCount * 4 * 3);
        const normals = new Float32Array(faceCount * 4 * 3);
        const colors = new Float32Array(faceCount * 4 * 4);
        const indices = new Uint32Array(faceCount * 6);

        // baked corner ambient occlusion - skipped for translucent water
        const occupancy = lane !== this._waterLane ? this._buildOcclusion(mortonKey) : null;
        const cornerAO: number[] = [3, 3, 3, 3];

        let vertex = 0;
        let indexCount = 0;

        for (let i = 0; i < faceMasks.length; i++) {
            const mask = faceMasks[i];

            if (mask === 0) {
                continue;
            }

            // decode the BitVoxel local coordinates from the VoxelIndex key layout
            const x = (((i >> 10) & 3) << 2) | ((i >> 4) & 3);
            const y = (((i >> 8) & 3) << 2) | ((i >> 2) & 3);
            const z = (((i >> 6) & 3) << 2) | (i & 3);

            // flat lane colour, or the Voxel colour from meta-data
            let rgb = lane.color;

            if (rgb === null) {
                this._scratchIndex.key = i;
                rgb = PALETTE[chunk.getMetaData(this._scratchIndex) % PALETTE.length].rgb;
            }

            for (let face = 0; face < 6; face++) {
                if (((mask >> face) & 1) === 0) {
                    continue;
                }

                const corners = FACE_CORNERS[face];
                const normal = FACE_NORMALS[face];
                const base = vertex;

                // ambient occlusion per corner - each corner samples the two
                // edge neighbours and the diagonal neighbour in the layer the
                // face looks into
                if (occupancy !== null) {
                    const tangents = FACE_TANGENTS[face];
                    const nx = x + normal[0];
                    const ny = y + normal[1];
                    const nz = z + normal[2];

                    for (let c = 0; c < 4; c++) {
                        const a1 = tangents[0];
                        const a2 = tangents[1];
                        const d1 = corners[c][a1] === 1 ? 1 : -1;
                        const d2 = corners[c][a2] === 1 ? 1 : -1;

                        const s1x = nx + (a1 === 0 ? d1 : 0);
                        const s1y = ny + (a1 === 1 ? d1 : 0);
                        const s1z = nz + (a1 === 2 ? d1 : 0);
                        const s2x = nx + (a2 === 0 ? d2 : 0);
                        const s2y = ny + (a2 === 1 ? d2 : 0);
                        const s2z = nz + (a2 === 2 ? d2 : 0);

                        const side1 = occupancy[(s1x + 1) + ((s1y + 1) * OCC_STRIDE_Y) + ((s1z + 1) * OCC_STRIDE_Z)];
                        const side2 = occupancy[(s2x + 1) + ((s2y + 1) * OCC_STRIDE_Y) + ((s2z + 1) * OCC_STRIDE_Z)];
                        const diagonal = occupancy[(s1x + s2x - nx + 1) + ((s1y + s2y - ny + 1) * OCC_STRIDE_Y) + ((s1z + s2z - nz + 1) * OCC_STRIDE_Z)];

                        cornerAO[c] = (side1 !== 0 && side2 !== 0) ? 0 : 3 - (side1 + side2 + diagonal);
                    }
                }
                else {
                    cornerAO[0] = cornerAO[1] = cornerAO[2] = cornerAO[3] = 3;
                }

                for (let c = 0; c < 4; c++) {
                    const write = vertex * 3;

                    positions[write] = (x + corners[c][0]) * BIT_VOXEL_SIZE;
                    positions[write + 1] = (y + corners[c][1]) * BIT_VOXEL_SIZE;
                    positions[write + 2] = (z + corners[c][2]) * BIT_VOXEL_SIZE;

                    normals[write] = normal[0];
                    normals[write + 1] = normal[1];
                    normals[write + 2] = normal[2];

                    const brightness = AO_LEVELS[cornerAO[c]];
                    const colorWrite = vertex * 4;

                    colors[colorWrite] = rgb[0] * brightness;
                    colors[colorWrite + 1] = rgb[1] * brightness;
                    colors[colorWrite + 2] = rgb[2] * brightness;
                    colors[colorWrite + 3] = 1.0;

                    vertex++;
                }

                // split the quad along the diagonal that matches the occlusion
                // gradient, avoiding the classic interpolation artifact
                if (cornerAO[0] + cornerAO[2] < cornerAO[1] + cornerAO[3]) {
                    indices[indexCount] = base + 1;
                    indices[indexCount + 1] = base + 2;
                    indices[indexCount + 2] = base + 3;
                    indices[indexCount + 3] = base + 1;
                    indices[indexCount + 4] = base + 3;
                    indices[indexCount + 5] = base;
                }
                else {
                    indices[indexCount] = base;
                    indices[indexCount + 1] = base + 1;
                    indices[indexCount + 2] = base + 2;
                    indices[indexCount + 3] = base;
                    indices[indexCount + 4] = base + 2;
                    indices[indexCount + 5] = base + 3;
                }

                indexCount += 6;
            }
        }

        this._uploadMesh(lane, chunkKey, mortonKey, positions, normals, colors, indices);
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

        const mortonKey = new MortonKey(chunkKey);

        const vertexCount = vertices.length / 3;
        const colors = new Float32Array(vertexCount * 4);

        // crevice ambient occlusion from the surrounding occupancy - skipped
        // for translucent water
        const occupancy = lane !== this._waterLane ? this._buildOcclusion(mortonKey) : null;

        const creviceAO = (cx: number, cy: number, cz: number): number => {
            if (occupancy === null) {
                return 1.0;
            }

            // count the solid corners of the vertex's surface cell - the more
            // enclosed the cell, the darker the vertex
            let solid = 0;

            for (let corner = 0; corner < 8; corner++) {
                const sx = Math.min(16, Math.max(-1, cx + (corner & 1)));
                const sy = Math.min(16, Math.max(-1, cy + ((corner >> 1) & 1)));
                const sz = Math.min(16, Math.max(-1, cz + ((corner >> 2) & 1)));

                solid += occupancy[(sx + 1) + ((sy + 1) * OCC_STRIDE_Y) + ((sz + 1) * OCC_STRIDE_Z)];
            }

            return 1.0 - (Math.max(0, solid - 2) * 0.05);
        };

        if (lane.color !== null) {
            // flat lane colour with crevice shading
            const [r, g, b] = lane.color;

            for (let i = 0; i < vertexCount; i++) {
                const read = i * 3;

                const ao = creviceAO(
                    Math.floor(vertices[read] / BIT_VOXEL_SIZE - 0.5),
                    Math.floor(vertices[read + 1] / BIT_VOXEL_SIZE - 0.5),
                    Math.floor(vertices[read + 2] / BIT_VOXEL_SIZE - 0.5)
                );

                const write = i * 4;

                colors[write] = r * ao;
                colors[write + 1] = g * ao;
                colors[write + 2] = b * ao;
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
                const px = vertices[read] / BIT_VOXEL_SIZE - 0.5;
                const py = vertices[read + 1] / BIT_VOXEL_SIZE - 0.5;
                const pz = vertices[read + 2] / BIT_VOXEL_SIZE - 0.5;

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

                const ao = creviceAO(cx, cy, cz);
                const write = i * 4;

                colors[write] = rgb[0] * ao;
                colors[write + 1] = rgb[1] * ao;
                colors[write + 2] = rgb[2] * ao;
                colors[write + 3] = 1.0;
            }
        }

        this._uploadMesh(lane, chunkKey, mortonKey, vertices, normals, colors, indices);
    }

    /**
     * Creates or updates the renderable mesh for a chunk of the provided lane.
     */
    private _uploadMesh(lane: MeshLane, chunkKey: number, mortonKey: MortonKey, positions: Float32Array, normals: Float32Array, colors: Float32Array, indices: Uint32Array): void {
        let mesh = lane.meshes.get(chunkKey);

        if (!mesh) {
            mesh = new Mesh(`${lane.id}-${chunkKey}`, this._scene);

            mesh.material = lane.material;
            mesh.isPickable = false;
            mesh.receiveShadows = true;

            // translucent water does not cast shadows
            if (lane !== this._waterLane) {
                this._shadows.addShadowCaster(mesh);
            }

            lane.meshes.set(chunkKey, mesh);
        }

        mesh.position.set(mortonKey.x * 16 * BIT_VOXEL_SIZE, mortonKey.y * 16 * BIT_VOXEL_SIZE, mortonKey.z * 16 * BIT_VOXEL_SIZE);

        const data = new VertexData();

        data.positions = positions;
        data.normals = normals;
        data.colors = colors;
        data.indices = indices;

        data.applyToMesh(mesh, true);

        lane.triangles.set(chunkKey, indices.length / 3);
    }

    /**
     * Disposes the mesh of a chunk that no longer has visible geometry.
     */
    private _disposeOrClear(lane: MeshLane, chunkKey: number): void {
        const mesh = lane.meshes.get(chunkKey);

        if (mesh) {
            this._shadows.removeShadowCaster(mesh);
            mesh.dispose();
            lane.meshes.delete(chunkKey);
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
            sandGrains: this._sand.length,
            waterGrains: this._water.length,
            activeGrains: this._sand.activeCount + this._water.activeCount
        });
    }

    private _notifyHistory(): void {
        this.onHistoryChanged?.(this._undoStack.length > 0, this._redoStack.length > 0);
    }
}
