import {
    ArcRotateCamera,
    Color3,
    Color4,
    DirectionalLight,
    Engine,
    HemisphericLight,
    Matrix,
    Mesh,
    MeshBuilder,
    Scene,
    StandardMaterial,
    Vector3,
    VertexData
} from "@babylonjs/core";
import {
    BVXSerializer,
    MortonKey,
    VoxelChunk16,
    VoxelIndex,
    VoxelPhysics,
    VoxelPhysicsLayer,
    VoxelWorld,
    type MesherRequest,
    type MesherResponse
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

    // throttled stats publishing
    private _statsTimer = 0;

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
        scene.clearColor = Color4.FromHexString("#14161bff");

        // orbit camera - rotate on middle/right drag, left button is for painting
        const regionUnits = REGION * BIT_VOXEL_SIZE;
        const target = new Vector3(regionUnits / 2, regionUnits / 8, regionUnits / 2);

        this._camera = new ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, regionUnits * 1.1, target, scene);
        this._camera.attachControl(canvas, true);
        this._camera.wheelDeltaPercentage = 0.02;
        this._camera.panningSensibility = 90;
        this._camera.lowerRadiusLimit = 2;
        this._camera.upperRadiusLimit = regionUnits * 4;
        this._camera.upperBetaLimit = Math.PI - 0.05;
        this._camera.minZ = 0.05;

        const pointers = this._camera.inputs.attached["pointers"] as unknown as { buttons: number[] };
        pointers.buttons = [1, 2];

        // lighting - a soft ambient dome plus a key light
        const ambient = new HemisphericLight("ambient", new Vector3(0.2, 1.0, 0.3), scene);
        ambient.intensity = 0.55;
        ambient.groundColor = new Color3(0.22, 0.24, 0.3);

        const key = new DirectionalLight("key", new Vector3(-0.55, -0.8, -0.35), scene);
        key.intensity = 0.85;

        this._buildGrid();

        // renderable lanes
        this._baseLane = this._makeLane("base", () => this._world, null, 1.0);
        this._sandLane = this._makeLane("sand", () => this._sand.world, SAND_COLOR, 1.0);
        this._waterLane = this._makeLane("water", () => this._water.world, WATER_COLOR, 0.55);
        this._lanes = [this._baseLane, this._sandLane, this._waterLane];

        this._setupPhysics();

        // hover cursor box
        this._cursorMaterial = new StandardMaterial("cursor-mat", scene);
        this._cursorMaterial.emissiveColor = Color3.FromHexString("#6c8cff");
        this._cursorMaterial.disableLighting = true;
        this._cursorMaterial.alpha = 0.35;

        this._cursor = MeshBuilder.CreateBox("cursor", { size: 1 }, scene);
        this._cursor.material = this._cursorMaterial;
        this._cursor.isPickable = false;
        this._cursor.isVisible = false;

        // pointer handling for painting
        canvas.addEventListener("pointerdown", this._onPointerDown);
        canvas.addEventListener("pointermove", this._onPointerMove);
        canvas.addEventListener("pointerup", this._onPointerUp);
        canvas.addEventListener("pointerleave", this._onPointerLeave);
        canvas.addEventListener("contextmenu", (event) => event.preventDefault());

        this._resizeObserver = new ResizeObserver(() => this._engine.resize());
        this._resizeObserver.observe(canvas);

        // fixed-step physics driven by the render loop
        scene.onBeforeRenderObservable.add(() => this._updatePhysics());

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
     */
    private _drainPhysicsDirty(): void {
        const dirty = this._scratchDirty;

        dirty.clear();
        this._sand.drainDirtyChunks(dirty);

        for (const key of dirty) {
            this._requestMesh(this._sandLane, key);
        }

        dirty.clear();
        this._water.drainDirtyChunks(dirty);

        for (const key of dirty) {
            this._requestMesh(this._waterLane, key);
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
     * Generates a small demo landscape to explore the editor with.
     */
    public demoScene(): void {
        const world = new VoxelWorld();
        const chunks = new Map<number, VoxelChunk16>();
        const index = this._scratchIndex;

        // gentle rolling terrain with height-banded colours
        for (let x = 0; x < REGION; x++) {
            for (let z = 0; z < REGION; z++) {
                const nx = x / REGION;
                const nz = z / REGION;

                const height = Math.max(1, Math.round(
                    10 +
                    (Math.sin(nx * Math.PI * 3.1) * Math.cos(nz * Math.PI * 2.3) * 7) +
                    (Math.sin((nx + nz) * Math.PI * 5.7) * 2.5)
                ));

                for (let y = 0; y < height && y < REGION; y++) {
                    const colorIndex = y < 5 ? 8 : (y < 9 ? 7 : (y < 13 ? 6 : (y < 16 ? 0 : 1)));

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

        this._resizeObserver.disconnect();
        this._pool.dispose();
        this._engine.dispose();
    }

    // ------------------------------------------------------------------ scene

    /**
     * Creates a renderable lane with its shared material.
     */
    private _makeLane(id: string, world: () => VoxelWorld, color: [number, number, number] | null, alpha: number): MeshLane {
        const material = new StandardMaterial(`lane-mat-${id}`, this._scene);

        material.diffuseColor = Color3.White();
        material.specularColor = alpha < 1.0 ? new Color3(0.25, 0.28, 0.32) : new Color3(0.04, 0.04, 0.05);
        material.alpha = alpha;

        return {
            id: id,
            world: world,
            meshes: new Map<number, Mesh>(),
            triangles: new Map<number, number>(),
            inFlight: new Set<number>(),
            dirtyAgain: new Set<number>(),
            color: color,
            material: material
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
        fineMesh.color = Color3.FromHexString("#262a33");
        fineMesh.isPickable = false;

        const strongMesh = MeshBuilder.CreateLineSystem("grid-strong", { lines: strong }, scene);
        strongMesh.color = Color3.FromHexString("#3a4150");
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
            for (const chunk of lane.world().chunks.values()) {
                this._requestMesh(lane, chunk.key.key);
            }
        }

        this._publishStats(true);
    }

    // --------------------------------------------------------------- painting

    private readonly _onPointerDown = (event: PointerEvent): void => {
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

        // keep receiving move/up events while dragging outside the canvas -
        // guarded as synthetic pointers can reject capture
        try {
            this._canvas.setPointerCapture(event.pointerId);
        }
        catch {
            // ignore - painting still works without capture
        }

        // physics strokes are transient simulation state and not undo-tracked
        const isBaseTool = this._tool === "paint" || this._tool === "erase";

        this._stroke = isBaseTool ? { before: new Map(), after: new Map() } : null;
        this._strokeActive = true;
        this._lastStrokeCell = null;

        if (target.brushCell) {
            this._applyBrush(target.brushCell);
        }
    };

    private readonly _onPointerMove = (event: PointerEvent): void => {
        const target = this._resolveTarget(event);

        this._updateCursor(this._tool === "pick" ? target.pickCell : target.brushCell);

        if (this._strokeActive && target.brushCell) {
            const last = this._lastStrokeCell;
            const cell = target.brushCell;

            // only re-apply when the brush has moved to a new cell
            if (!last || last[0] !== cell[0] || last[1] !== cell[1] || last[2] !== cell[2]) {
                this._applyBrush(cell);
            }
        }
    };

    private readonly _onPointerUp = (event: PointerEvent): void => {
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
                        // never paint solid ground into a cell a grain occupies
                        if (this._sand.get(x, y, z) === 1 || this._water.get(x, y, z) === 1) {
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

                    if (this._world.get(key) !== null) {
                        keys.add(key.key);
                    }
                }
            }
        }

        for (const key of keys) {
            this._requestMesh(this._baseLane, key);
        }
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

                const mesh = this._baseLane.meshes.get(key);

                if (mesh) {
                    mesh.dispose();
                    this._baseLane.meshes.delete(key);
                    this._baseLane.triangles.delete(key);
                }
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

                        if (this._world.get(neighbour) !== null) {
                            keys.add(neighbour.key);
                        }
                    }
                }
            }
        }

        for (const key of keys) {
            this._requestMesh(this._baseLane, key);
        }

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
        const chunk = world.get(mortonKey);

        if (chunk === null) {
            // chunk no longer exists - drop its mesh
            const mesh = lane.meshes.get(chunkKey);

            if (mesh) {
                mesh.dispose();
                lane.meshes.delete(chunkKey);
                lane.triangles.delete(chunkKey);
            }

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

        // flipped winding - BabylonJS treats clockwise faces as front-facing,
        // the opposite of the bvx-kit default counter-clockwise convention
        const request: MesherRequest = this._renderMode === "blocky"
            ? { id: 0, type: "faces", chunkKey: chunkKey, flipped: true, world: snapshot }
            : { id: 0, type: "smooth", chunkKey: chunkKey, smoothing: this._smoothing, flipped: true, world: snapshot };

        this._pool.request(request).then((response) => this._onMeshResponse(lane, response));
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

                for (let c = 0; c < 4; c++) {
                    const write = vertex * 3;

                    positions[write] = (x + corners[c][0]) * BIT_VOXEL_SIZE;
                    positions[write + 1] = (y + corners[c][1]) * BIT_VOXEL_SIZE;
                    positions[write + 2] = (z + corners[c][2]) * BIT_VOXEL_SIZE;

                    normals[write] = normal[0];
                    normals[write + 1] = normal[1];
                    normals[write + 2] = normal[2];

                    const colorWrite = vertex * 4;

                    colors[colorWrite] = rgb[0];
                    colors[colorWrite + 1] = rgb[1];
                    colors[colorWrite + 2] = rgb[2];
                    colors[colorWrite + 3] = 1.0;

                    vertex++;
                }

                indices[indexCount] = base;
                indices[indexCount + 1] = base + 1;
                indices[indexCount + 2] = base + 2;
                indices[indexCount + 3] = base;
                indices[indexCount + 4] = base + 2;
                indices[indexCount + 5] = base + 3;

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

                const write = i * 4;

                colors[write] = rgb[0];
                colors[write + 1] = rgb[1];
                colors[write + 2] = rgb[2];
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
            return;
        }

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
