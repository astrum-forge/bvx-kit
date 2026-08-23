import { MortonKey } from "../../math/morton-key.js";
import { VoxelWorld } from "../voxel-world.js";
import { PhysicsVoxelChunk } from "./physics-voxel-chunk.js";
import { VoxelPhysics } from "./voxel-physics.js";

/**
 * Parameters controlling the behaviour of a VoxelPhysicsLayer. Granular
 * materials and liquids share one solver and differ only by these values -
 * see the VoxelPhysics.SAND and VoxelPhysics.WATER presets.
 */
export interface VoxelPhysicsParams {
    /**
     * Whether grains blocked from falling straight down may fall into the four
     * diagonally-down neighbouring cells. Produces piling/sloping behaviour for
     * granular materials. Defaults to true.
     */
    slide?: boolean;

    /**
     * Whether grains blocked from falling may flow laterally along a surface
     * toward a reachable drop-off. Produces liquid spreading and pooling.
     * Flow is deliberately restricted to reachable drop-offs (see flowDistance)
     * so pools settle into a fully dormant state instead of jittering forever -
     * changes near a dormant pool re-level it through chained vacancy wakes.
     * Defaults to false.
     */
    flow?: boolean;

    /**
     * How many cells a flowing grain scans (and may travel) laterally per tick
     * looking for a drop-off. Higher values level pools faster. Clamped to
     * 1-15. Defaults to 8. Only used when flow is enabled.
     */
    flowDistance?: number;

    /**
     * The relative density of the material. A grain falling straight down into
     * a cell occupied by a lower-density layer displaces it - the two grains
     * swap cells, so sand sinks through water while the water bubbles upward.
     * The static base world never swaps. Defaults to 1.
     */
    density?: number;
}

/**
 * Lateral candidate offsets shared by the slide and flow movement rules.
 */
const LATERAL_X: number[] = [1, -1, 0, 0];
const LATERAL_Z: number[] = [0, 0, 1, -1];

/**
 * VoxelPhysicsLayer simulates one falling-grain material (sand, dirt, water)
 * as a BitVoxel layer on top of a static base VoxelWorld. Layers are created
 * via VoxelPhysics.addLayer() and stepped via VoxelPhysics.update().
 *
 * The layer owns a private VoxelWorld of PhysicsVoxelChunks holding its
 * BitVoxel occupancy, so all existing machinery (VoxelFaceGeometry,
 * VoxelSmoothGeometry, BVXSerializer, VoxelRaycaster) works on `layer.world`
 * unchanged, and the base engine carries zero cost when physics is not used.
 *
 * Performance model:
 *
 * - Only "active" BitVoxels are simulated. A grain that cannot move goes
 *   dormant and costs nothing until a nearby cell changes and wakes it.
 * - Active chunks sweep bottom-up so falling columns compact one cell per
 *   tick together, and per-tick moved masks guarantee at most one move per
 *   grain per tick.
 * - All occupancy checks against the base world and every layer are raw
 *   32-bit word reads through per-chunk neighbourhood caches.
 * - Movement direction choices rotate by a deterministic cell/tick hash, so
 *   simulations are unbiased and fully reproducible.
 */
export class VoxelPhysicsLayer {
    /**
     * Mask isolating the interleaved y bits of a MortonKey. Because Morton
     * interleaving preserves per-axis bit order, comparing masked keys orders
     * chunks by their y coordinate without decoding.
     */
    private static readonly MORTON_Y_MASK: number = 0x12492492;

    /**
     * Precomputed per-axis lookup tables for swept-chunk-local coordinates in
     * the -16 to 31 range (offset by +16). The neighbourhood cache slot and
     * the BitVoxel index are both separable per axis, so the hot-path cell
     * addressing reduces to three table reads and two adds/ors per value.
     */
    private static readonly _SLOT_X: Int8Array = VoxelPhysicsLayer._BuildSlotTable(9);
    private static readonly _SLOT_Y: Int8Array = VoxelPhysicsLayer._BuildSlotTable(3);
    private static readonly _SLOT_Z: Int8Array = VoxelPhysicsLayer._BuildSlotTable(1);
    private static readonly _IDX_X: Int16Array = VoxelPhysicsLayer._BuildIndexTable(10, 4);
    private static readonly _IDX_Y: Int16Array = VoxelPhysicsLayer._BuildIndexTable(8, 2);
    private static readonly _IDX_Z: Int16Array = VoxelPhysicsLayer._BuildIndexTable(6, 0);

    /**
     * The 32 storage word indices containing each vy row (index = vy * 32 + i),
     * and the per-word bit mask isolating one by row within a word. Together
     * they let the sweep visit only the active bits of a y-plane instead of
     * testing all 256 cells.
     */
    private static readonly _PLANE_WORDS: Uint8Array = VoxelPhysicsLayer._BuildPlaneWords();
    private static readonly _PLANE_MASKS: Int32Array = VoxelPhysicsLayer._BuildPlaneMasks();

    /**
     * Builds the per-vy storage word table (see _PLANE_WORDS). A BitVoxel index
     * decomposes as (vx << 10 | vy << 8 | vz << 6 | bx << 4 | by << 2 | bz), so
     * a storage word (index >> 5) has the layout (vx << 5 | vy << 3 | vz << 1 | bxHi).
     */
    private static _BuildPlaneWords(): Uint8Array {
        const table: Uint8Array = new Uint8Array(4 * 32);

        for (let vy = 0; vy < 4; vy++) {
            let write: number = vy * 32;

            for (let vx = 0; vx < 4; vx++) {
                for (let vz = 0; vz < 4; vz++) {
                    for (let bxHi = 0; bxHi < 2; bxHi++) {
                        table[write] = (vx << 5) | (vy << 3) | (vz << 1) | bxHi;
                        write++;
                    }
                }
            }
        }

        return table;
    }

    /**
     * Builds the per-by word bit masks (see _PLANE_WORDS). The low 5 bits of a
     * BitVoxel index are (bxLo << 4 | by << 2 | bz), so one by row occupies
     * bits (by * 4 .. by * 4 + 3) and (16 + by * 4 .. 16 + by * 4 + 3).
     */
    private static _BuildPlaneMasks(): Int32Array {
        const table: Int32Array = new Int32Array(4);

        for (let by = 0; by < 4; by++) {
            table[by] = (0x0F << (by * 4)) | (0x0F << (16 + (by * 4)));
        }

        return table;
    }

    /**
     * Builds a per-axis neighbourhood cache slot table (see _SLOT_X).
     */
    private static _BuildSlotTable(multiplier: number): Int8Array {
        const table: Int8Array = new Int8Array(48);

        for (let c = -16; c <= 31; c++) {
            table[c + 16] = ((c >> 4) + 1) * multiplier;
        }

        return table;
    }

    /**
     * Builds a per-axis BitVoxel index component table (see _IDX_X).
     */
    private static _BuildIndexTable(highShift: number, lowShift: number): Int16Array {
        const table: Int16Array = new Int16Array(48);

        for (let c = -16; c <= 31; c++) {
            const local: number = c & 15;

            table[c + 16] = ((local >> 2) << highShift) | ((local & 3) << lowShift);
        }

        return table;
    }

    /**
     * The coordinating VoxelPhysics instance this layer belongs to.
     */
    private readonly _physics: VoxelPhysics;

    /**
     * The VoxelWorld holding this layer's BitVoxels (PhysicsVoxelChunks).
     */
    private readonly _world: VoxelWorld;

    /**
     * Fast chunk access by encoded MortonKey, mirroring the world contents.
     */
    private readonly _chunks: Map<number, PhysicsVoxelChunk>;

    /**
     * Encoded MortonKeys of chunks containing active (possibly moving) grains.
     */
    private readonly _activeChunks: Set<number>;

    /**
     * Encoded MortonKeys of chunks whose contents changed since the last
     * drainDirtyChunks() call - the renderer's remesh list.
     */
    private readonly _dirty: Set<number>;

    /**
     * Behaviour parameters (see VoxelPhysicsParams).
     */
    private readonly _slide: boolean;
    private readonly _flow: boolean;
    private readonly _flowDistance: number;
    private readonly _density: number;

    /**
     * Reusable MortonKey for chunk lookups.
     */
    private readonly _tmpKey: MortonKey = new MortonKey();

    /**
     * Incrementally maintained totals - the number of grains in the layer and
     * the number of those currently active. Their difference (dormant grains)
     * gates the lateral flow-line wake scans.
     */
    private _grainTotal = 0;
    private _activeTotal = 0;

    /**
     * Per-sweep neighbourhood caches - 27 slots covering the swept chunk and
     * its neighbours. _cacheBase holds the base world's BitVoxel storage,
     * _cacheChunks/_cacheElems hold every layer's chunks and storages, indexed
     * by the layer's position in VoxelPhysics.layers.
     */
    private readonly _cacheBase: (Uint32Array | null)[] = new Array<Uint32Array | null>(27);
    private _cacheChunks: (PhysicsVoxelChunk | null)[][] = [];
    private _cacheElems: (Uint32Array | null)[][] = [];

    /**
     * Per-sweep context - the swept chunk's coordinates, the layer list, this
     * layer's index within it, the simulation bounds and the current tick.
     */
    private _ctxChunkX = 0;
    private _ctxChunkY = 0;
    private _ctxChunkZ = 0;
    private _ctxLayers: readonly VoxelPhysicsLayer[] = [];
    private _ctxOwnIndex = 0;
    private _ctxTick = 0;
    private _ctxMinX = 0;
    private _ctxMinY = 0;
    private _ctxMinZ = 0;
    private _ctxMaxX = 0;
    private _ctxMaxY = 0;
    private _ctxMaxZ = 0;

    /**
     * The simulation bounds translated into swept-chunk-local coordinates,
     * refreshed per swept chunk so hot-path bounds checks avoid computing
     * global coordinates.
     */
    private _ctxLoX = 0;
    private _ctxLoY = 0;
    private _ctxLoZ = 0;
    private _ctxHiX = 0;
    private _ctxHiY = 0;
    private _ctxHiZ = 0;

    /**
     * Constructs a new physics layer. Use VoxelPhysics.addLayer() instead of
     * constructing layers directly - the layer must be registered with the
     * coordinator to participate in the simulation.
     *
     * @param physics - The coordinating VoxelPhysics instance.
     * @param params - The behaviour parameters for this layer.
     */
    constructor(physics: VoxelPhysics, params: VoxelPhysicsParams | null = null) {
        this._physics = physics;
        this._world = new VoxelWorld();
        this._chunks = new Map<number, PhysicsVoxelChunk>();
        this._activeChunks = new Set<number>();
        this._dirty = new Set<number>();

        this._slide = params?.slide ?? true;
        this._flow = params?.flow ?? false;
        this._flowDistance = Math.min(15, Math.max(1, (params?.flowDistance ?? 8) | 0));
        this._density = params?.density ?? 1;
    }

    /**
     * Returns the VoxelWorld holding this layer's BitVoxels. Fully compatible
     * with the geometry generators, serializer and raycaster - render or save
     * it like any other world. Treat it as read-only: mutate through the
     * layer's set()/unset() so the simulation bookkeeping stays consistent.
     */
    public get world(): VoxelWorld {
        return this._world;
    }

    /**
     * Whether this layer's grains may fall diagonally (see VoxelPhysicsParams).
     */
    public get slide(): boolean {
        return this._slide;
    }

    /**
     * Whether this layer's grains may flow laterally (see VoxelPhysicsParams).
     */
    public get flow(): boolean {
        return this._flow;
    }

    /**
     * The lateral drop-off scan distance of this layer (see VoxelPhysicsParams).
     */
    public get flowDistance(): number {
        return this._flowDistance;
    }

    /**
     * The relative density of this layer (see VoxelPhysicsParams).
     */
    public get density(): number {
        return this._density;
    }

    /**
     * Returns the total number of grains (set BitVoxels) in this layer.
     * NOTE: This is an O(chunks) pop-count and should not be called in hot paths.
     */
    public get length(): number {
        let counter = 0;

        for (const chunk of this._chunks.values()) {
            counter += chunk.length;
        }

        return counter;
    }

    /**
     * Returns the number of active (possibly moving) grains in this layer.
     * Dormant scenes report 0 and cost nothing to update.
     */
    public get activeCount(): number {
        return this._activeTotal;
    }

    /**
     * Returns whether this layer holds any dormant (settled) grains. Used
     * internally to gate lateral flow-line wake scans.
     */
    public get hasDormantGrains(): boolean {
        return this._grainTotal > this._activeTotal;
    }

    /**
     * Adds a grain at the provided global BitVoxel coordinates. The grain is
     * created awake and will begin falling on the next update.
     *
     * @param x - The global x-coordinate in BitVoxel space.
     * @param y - The global y-coordinate in BitVoxel space.
     * @param z - The global z-coordinate in BitVoxel space.
     * @returns - True if the grain was placed, false if outside the simulation bounds.
     */
    public set(x: number, y: number, z: number): boolean {
        const physics: VoxelPhysics = this._physics;

        if (x < physics.minX || x > physics.maxX || y < physics.minY || y > physics.maxY || z < physics.minZ || z > physics.maxZ) {
            return false;
        }

        const chunk: PhysicsVoxelChunk = this._EnsureChunk(x >> 4, y >> 4, z >> 4);
        const index: number = VoxelPhysicsLayer._Encode(x & 15, y & 15, z & 15);
        const word: number = index >> 5;
        const mask: number = 1 << (index & 31);
        const elements: Uint32Array = chunk.layer.bitArray.elements;

        if ((elements[word] & mask) === 0) {
            elements[word] |= mask;
            this._grainTotal++;
        }

        this._Activate(chunk, index);
        this._dirty.add(chunk.key.key);

        return true;
    }

    /**
     * Removes the grain at the provided global BitVoxel coordinates, waking any
     * surrounding grains that may now be able to move into the vacancy.
     *
     * @param x - The global x-coordinate in BitVoxel space.
     * @param y - The global y-coordinate in BitVoxel space.
     * @param z - The global z-coordinate in BitVoxel space.
     * @returns - True if a grain was removed, false if none was present.
     */
    public unset(x: number, y: number, z: number): boolean {
        const chunk: PhysicsVoxelChunk | undefined = this._chunks.get(MortonKey.from(x >> 4, y >> 4, z >> 4, this._tmpKey).key);

        if (!chunk) {
            return false;
        }

        const index: number = VoxelPhysicsLayer._Encode(x & 15, y & 15, z & 15);
        const word: number = index >> 5;
        const mask: number = 1 << (index & 31);
        const elements: Uint32Array = chunk.layer.bitArray.elements;

        if ((elements[word] & mask) === 0) {
            return false;
        }

        elements[word] &= ~mask;
        this._grainTotal--;

        // clear the active flag if the grain was awake
        const activeElements: Uint32Array = chunk.active.elements;

        if ((activeElements[word] & mask) !== 0) {
            activeElements[word] &= ~mask;
            chunk.activeCount--;
            this._activeTotal--;
        }

        this._dirty.add(chunk.key.key);

        // the vacancy may free surrounding grains in every layer
        this._physics.wakeRegion(x - 1, y, z - 1, x + 1, y + 1, z + 1);

        return true;
    }

    /**
     * Returns the state of the grain at the provided global BitVoxel
     * coordinates (1 if present, 0 otherwise).
     *
     * @param x - The global x-coordinate in BitVoxel space.
     * @param y - The global y-coordinate in BitVoxel space.
     * @param z - The global z-coordinate in BitVoxel space.
     * @returns - 1 if a grain is present, 0 otherwise.
     */
    public get(x: number, y: number, z: number): number {
        const chunk: PhysicsVoxelChunk | undefined = this._chunks.get(MortonKey.from(x >> 4, y >> 4, z >> 4, this._tmpKey).key);

        if (!chunk) {
            return 0;
        }

        const index: number = VoxelPhysicsLayer._Encode(x & 15, y & 15, z & 15);

        return (chunk.layer.bitArray.elements[index >> 5] >>> (index & 31)) & 1;
    }

    /**
     * Moves the encoded MortonKeys of every chunk whose contents changed since
     * the previous call into the provided set - the renderer's remesh list.
     *
     * @param optres - (Optional) A pre-allocated Set to store the result, reducing allocations.
     * @returns - The new or provided Set containing the dirty chunk keys.
     */
    public drainDirtyChunks(optres: Set<number> | null = null): Set<number> {
        optres = optres ?? new Set<number>();

        for (const key of this._dirty) {
            optres.add(key);
        }

        this._dirty.clear();

        return optres;
    }

    /**
     * Copies the BitVoxel contents of the provided world into this layer -
     * the restore path for layer data saved via BVXSerializer.saveWorld(layer.world).
     * All imported grains are created awake, as the solver bookkeeping is not
     * part of the serialized data. Existing grains are kept (merge semantics) -
     * call clear() first for a clean restore.
     *
     * @param world - The world holding the BitVoxels to import.
     */
    public importWorld(world: VoxelWorld): void {
        for (const chunk of world.chunks.values()) {
            const key: MortonKey = chunk.key;
            const target: PhysicsVoxelChunk = this._EnsureChunk(key.x, key.y, key.z);
            const targetElements: Uint32Array = target.layer.bitArray.elements;
            const sourceElements: Uint32Array = chunk.layer.bitArray.elements;

            for (let i = 0; i < targetElements.length; i++) {
                targetElements[i] |= sourceElements[i];
            }

            this._dirty.add(target.key.key);
        }

        this._grainTotal = this.length;

        this.wakeAll();
    }

    /**
     * Removes every grain from the layer, reporting all previously occupied
     * chunks as dirty so renderers can release their meshes.
     */
    public clear(): void {
        for (const key of this._chunks.keys()) {
            this._dirty.add(key);
        }

        for (const chunk of this._chunks.values()) {
            this._world.remove(chunk.key);
        }

        this._chunks.clear();
        this._activeChunks.clear();

        this._grainTotal = 0;
        this._activeTotal = 0;
    }

    /**
     * Wakes every grain in the layer. Useful after loading serialized layer
     * data, where the solver bookkeeping is not persisted.
     */
    public wakeAll(): void {
        this._activeTotal = 0;

        for (const chunk of this._chunks.values()) {
            const elements: Uint32Array = chunk.layer.bitArray.elements;
            const activeElements: Uint32Array = chunk.active.elements;

            activeElements.set(elements);
            chunk.activeCount = chunk.length;

            this._activeTotal += chunk.activeCount;

            if (chunk.activeCount > 0) {
                this._activeChunks.add(chunk.key.key);
            }
        }
    }

    /**
     * Wakes the grain at the provided global BitVoxel coordinates if one is
     * present and dormant. Called by VoxelPhysics.wakeRegion().
     *
     * @param x - The global x-coordinate in BitVoxel space.
     * @param y - The global y-coordinate in BitVoxel space.
     * @param z - The global z-coordinate in BitVoxel space.
     */
    public wake(x: number, y: number, z: number): void {
        const chunk: PhysicsVoxelChunk | undefined = this._chunks.get(MortonKey.from(x >> 4, y >> 4, z >> 4, this._tmpKey).key);

        if (!chunk) {
            return;
        }

        const index: number = VoxelPhysicsLayer._Encode(x & 15, y & 15, z & 15);

        if ((chunk.layer.bitArray.elements[index >> 5] & (1 << (index & 31))) !== 0) {
            this._Activate(chunk, index);
        }
    }

    /**
     * Advances this layer by one simulation tick. Called by
     * VoxelPhysics.update() - not intended for direct use, as layers must
     * step in the coordinator's density order for displacement to behave.
     *
     * @param tick - The global simulation tick counter.
     * @param maxMoves - (Optional) Stop the sweep once this many grains have moved.
     * 0 or less means no limit. See VoxelPhysics.update() for the semantics.
     * @returns - The number of grains that moved this tick.
     */
    public step(tick: number, maxMoves = 0): number {
        if (this._activeChunks.size === 0) {
            return 0;
        }

        const physics: VoxelPhysics = this._physics;
        const layers: readonly VoxelPhysicsLayer[] = physics.layers;

        // (re)size the per-layer cache tables when layers were added
        if (this._cacheChunks.length !== layers.length) {
            this._cacheChunks = [];
            this._cacheElems = [];

            for (let i = 0; i < layers.length; i++) {
                this._cacheChunks.push(new Array<PhysicsVoxelChunk | null>(27));
                this._cacheElems.push(new Array<Uint32Array | null>(27));
            }
        }

        // sweep context shared by the per-cell helpers
        this._ctxLayers = layers;
        this._ctxOwnIndex = layers.indexOf(this);
        this._ctxTick = tick;
        this._ctxMinX = physics.minX;
        this._ctxMinY = physics.minY;
        this._ctxMinZ = physics.minZ;
        this._ctxMaxX = physics.maxX;
        this._ctxMaxY = physics.maxY;
        this._ctxMaxZ = physics.maxZ;

        // sweep chunks bottom-up so grains falling across chunk borders keep
        // moving one cell every tick with no boundary stalls
        const keys: number[] = Array.from(this._activeChunks);
        keys.sort((a, b) => (a & VoxelPhysicsLayer.MORTON_Y_MASK) - (b & VoxelPhysicsLayer.MORTON_Y_MASK));

        let moves = 0;

        for (let i = 0; i < keys.length; i++) {
            const key: number = keys[i];
            const chunk: PhysicsVoxelChunk | undefined = this._chunks.get(key);

            if (!chunk || chunk.activeCount <= 0) {
                this._activeChunks.delete(key);

                continue;
            }

            moves += this._SweepChunk(chunk, tick);

            // fully dormant chunks leave the active set - empty ones also leave
            // the world so renderers can release their meshes
            if (chunk.activeCount <= 0) {
                this._activeChunks.delete(key);

                if (chunk.length === 0) {
                    this._world.remove(chunk.key);
                    this._chunks.delete(key);
                    this._dirty.add(key);
                }
            }

            // Out of budget. The chunks not reached stay in the active set with their
            // grains still awake, so the next tick resumes from here - the collapse
            // takes more ticks rather than one long one.
            if (maxMoves > 0 && moves >= maxMoves) {
                break;
            }
        }

        return moves;
    }

    /**
     * Encodes local chunk coordinates (0-15 per axis) into a BitVoxel index
     * matching the VoxelIndex key layout.
     */
    private static _Encode(x: number, y: number, z: number): number {
        return ((x >> 2) << 10) | ((y >> 2) << 8) | ((z >> 2) << 6) | ((x & 3) << 4) | ((y & 3) << 2) | (z & 3);
    }

    /**
     * Returns the existing chunk at the provided chunk coordinates, creating
     * and registering a new one when missing.
     */
    private _EnsureChunk(chunkX: number, chunkY: number, chunkZ: number): PhysicsVoxelChunk {
        const key: MortonKey = MortonKey.from(chunkX, chunkY, chunkZ, this._tmpKey);
        const existing: PhysicsVoxelChunk | undefined = this._chunks.get(key.key);

        if (existing) {
            return existing;
        }

        const chunk: PhysicsVoxelChunk = new PhysicsVoxelChunk(key.clone());

        this._world.insert(chunk);
        this._chunks.set(key.key, chunk);

        return chunk;
    }

    /**
     * Marks the grain at the provided BitVoxel index of the chunk as active,
     * registering the chunk with the active set.
     */
    private _Activate(chunk: PhysicsVoxelChunk, index: number): void {
        const word: number = index >> 5;
        const mask: number = 1 << (index & 31);
        const activeElements: Uint32Array = chunk.active.elements;

        if ((activeElements[word] & mask) !== 0) {
            return;
        }

        activeElements[word] |= mask;
        chunk.activeCount++;
        this._activeTotal++;

        this._activeChunks.add(chunk.key.key);
    }

    /**
     * Fills the 27-slot neighbourhood caches for the swept chunk - the base
     * world storage plus every layer's chunks and storages.
     */
    private _FillCaches(chunkX: number, chunkY: number, chunkZ: number): void {
        const base: VoxelWorld = this._physics.base;
        const layers: readonly VoxelPhysicsLayer[] = this._ctxLayers;
        const key: MortonKey = this._tmpKey;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const slot: number = ((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1);

                    MortonKey.from(chunkX + ox, chunkY + oy, chunkZ + oz, key);

                    const baseChunk = base.get(key);
                    this._cacheBase[slot] = baseChunk !== null ? baseChunk.layer.bitArray.elements : null;

                    for (let l = 0; l < layers.length; l++) {
                        const layerChunk: PhysicsVoxelChunk | undefined = layers[l]._chunks.get(key.key);

                        this._cacheChunks[l][slot] = layerChunk ?? null;
                        this._cacheElems[l][slot] = layerChunk ? layerChunk.layer.bitArray.elements : null;
                    }
                }
            }
        }
    }

    /**
     * Returns true when the cell at the provided swept-chunk-local coordinates
     * (each in -16 to 31) is within the simulation bounds and unoccupied by
     * the base world and every layer.
     */
    private _IsOpen(lx: number, ly: number, lz: number): boolean {
        // outside the simulation bounds is solid - the floor and walls
        if (lx < this._ctxLoX || lx > this._ctxHiX || ly < this._ctxLoY || ly > this._ctxHiY || lz < this._ctxLoZ || lz > this._ctxHiZ) {
            return false;
        }

        const slot: number = VoxelPhysicsLayer._SLOT_X[lx + 16] + VoxelPhysicsLayer._SLOT_Y[ly + 16] + VoxelPhysicsLayer._SLOT_Z[lz + 16];
        const index: number = VoxelPhysicsLayer._IDX_X[lx + 16] | VoxelPhysicsLayer._IDX_Y[ly + 16] | VoxelPhysicsLayer._IDX_Z[lz + 16];
        const word: number = index >> 5;
        const mask: number = 1 << (index & 31);

        const base: Uint32Array | null = this._cacheBase[slot];

        if (base !== null && (base[word] & mask) !== 0) {
            return false;
        }

        const layerCount: number = this._ctxLayers.length;

        for (let l = 0; l < layerCount; l++) {
            const elements: Uint32Array | null = this._cacheElems[l][slot];

            if (elements !== null && (elements[word] & mask) !== 0) {
                return false;
            }
        }

        return true;
    }

    /**
     * Returns the index of the lower-density layer occupying the cell at the
     * provided swept-chunk-local coordinates, or -1 when the cell is empty,
     * out of bounds, held by the base world or held by an equal-or-denser layer.
     */
    private _FindLighterOccupant(lx: number, ly: number, lz: number): number {
        if (lx < this._ctxLoX || lx > this._ctxHiX || ly < this._ctxLoY || ly > this._ctxHiY || lz < this._ctxLoZ || lz > this._ctxHiZ) {
            return -1;
        }

        const slot: number = VoxelPhysicsLayer._SLOT_X[lx + 16] + VoxelPhysicsLayer._SLOT_Y[ly + 16] + VoxelPhysicsLayer._SLOT_Z[lz + 16];
        const index: number = VoxelPhysicsLayer._IDX_X[lx + 16] | VoxelPhysicsLayer._IDX_Y[ly + 16] | VoxelPhysicsLayer._IDX_Z[lz + 16];
        const word: number = index >> 5;
        const mask: number = 1 << (index & 31);

        // the static base world never swaps
        const base: Uint32Array | null = this._cacheBase[slot];

        if (base !== null && (base[word] & mask) !== 0) {
            return -1;
        }

        const layers: readonly VoxelPhysicsLayer[] = this._ctxLayers;

        for (let l = 0; l < layers.length; l++) {
            const elements: Uint32Array | null = this._cacheElems[l][slot];

            if (elements !== null && (elements[word] & mask) !== 0) {
                return (l !== this._ctxOwnIndex && layers[l]._density < this._density) ? l : -1;
            }
        }

        return -1;
    }

    /**
     * Wakes any grain of any layer at the provided swept-chunk-local
     * coordinates, using the neighbourhood caches.
     */
    private _WakeLocal(lx: number, ly: number, lz: number): void {
        const slot: number = VoxelPhysicsLayer._SLOT_X[lx + 16] + VoxelPhysicsLayer._SLOT_Y[ly + 16] + VoxelPhysicsLayer._SLOT_Z[lz + 16];
        const index: number = VoxelPhysicsLayer._IDX_X[lx + 16] | VoxelPhysicsLayer._IDX_Y[ly + 16] | VoxelPhysicsLayer._IDX_Z[lz + 16];
        const word: number = index >> 5;
        const mask: number = 1 << (index & 31);

        const layers: readonly VoxelPhysicsLayer[] = this._ctxLayers;

        for (let l = 0; l < layers.length; l++) {
            const elements: Uint32Array | null = this._cacheElems[l][slot];

            if (elements !== null && (elements[word] & mask) !== 0) {
                layers[l]._Activate(this._cacheChunks[l][slot] as PhysicsVoxelChunk, index);
            }
        }
    }

    /**
     * Wakes the neighbourhood around a vacated cell at the provided
     * swept-chunk-local coordinates - the cells above and diagonally above
     * (which may fall or slide into the vacancy) and the lateral cells (which
     * may flow into it). When flow layers exist, dormant grains further along
     * the lateral axes are woken too, as the vacancy may have cleared their
     * scan path to a drop-off.
     */
    private _WakeVacancy(lx: number, ly: number, lz: number): void {
        this._WakeLocal(lx, ly + 1, lz);
        this._WakeLocal(lx + 1, ly + 1, lz);
        this._WakeLocal(lx - 1, ly + 1, lz);
        this._WakeLocal(lx, ly + 1, lz + 1);
        this._WakeLocal(lx, ly + 1, lz - 1);
        this._WakeLocal(lx + 1, ly, lz);
        this._WakeLocal(lx - 1, ly, lz);
        this._WakeLocal(lx, ly, lz + 1);
        this._WakeLocal(lx, ly, lz - 1);

        // lateral wake propagation for flow layers - the vacancy may sit on the
        // scan path of a dormant grain (at its own level) or may be the drop
        // cell a dormant grain one level up can now reach. Skipped entirely
        // while every flow grain is already awake, as there is nothing to wake.
        const physics: VoxelPhysics = this._physics;
        const maxFlow: number = physics.maxFlowDistance;

        if (maxFlow > 1 && physics.flowWakeNeeded) {
            this._WakeFlowLines(lx, ly, lz, maxFlow);
            this._WakeFlowLines(lx, ly + 1, lz, maxFlow);
        }
    }

    /**
     * Scans outward along the four lateral axes from the provided
     * swept-chunk-local cell, waking the first flow-layer grain found in each
     * direction. Empty cells are skipped, any occupied or out-of-bounds cell
     * ends the direction - chained vacancy wakes propagate from there.
     */
    private _WakeFlowLines(lx: number, ly: number, lz: number, maxReach: number): void {
        const layers: readonly VoxelPhysicsLayer[] = this._ctxLayers;

        const gx: number = (this._ctxChunkX << 4) + lx;
        const gy: number = (this._ctxChunkY << 4) + ly;
        const gz: number = (this._ctxChunkZ << 4) + lz;

        // out of vertical bounds - nothing can flow at this level
        if (gy < this._ctxMinY || gy > this._ctxMaxY) {
            return;
        }

        for (let d = 0; d < 4; d++) {
            const dx: number = LATERAL_X[d];
            const dz: number = LATERAL_Z[d];

            // hoist the bounds check - clamp the reach at the region walls
            let reachLimit: number = maxReach;

            if (dx > 0) {
                reachLimit = Math.min(reachLimit, this._ctxMaxX - gx);
            }
            else if (dx < 0) {
                reachLimit = Math.min(reachLimit, gx - this._ctxMinX);
            }
            else if (dz > 0) {
                reachLimit = Math.min(reachLimit, this._ctxMaxZ - gz);
            }
            else {
                reachLimit = Math.min(reachLimit, gz - this._ctxMinZ);
            }

            // distance 1 is covered by the direct wakes in _WakeVacancy
            const slotY: number = VoxelPhysicsLayer._SLOT_Y[ly + 16];
            const idxY: number = VoxelPhysicsLayer._IDX_Y[ly + 16];

            for (let reach = 2; reach <= reachLimit; reach++) {
                const nx: number = lx + (dx * reach);
                const nz: number = lz + (dz * reach);

                const slot: number = VoxelPhysicsLayer._SLOT_X[nx + 16] + slotY + VoxelPhysicsLayer._SLOT_Z[nz + 16];
                const index: number = VoxelPhysicsLayer._IDX_X[nx + 16] | idxY | VoxelPhysicsLayer._IDX_Z[nz + 16];
                const word: number = index >> 5;
                const mask: number = 1 << (index & 31);

                // the base world walls off the direction
                const base: Uint32Array | null = this._cacheBase[slot];

                if (base !== null && (base[word] & mask) !== 0) {
                    break;
                }

                // wake the first grain encountered - flow layers only - and end
                // the direction, as any grain blocks scan paths behind it
                let occupied = false;

                for (let l = 0; l < layers.length; l++) {
                    const elements: Uint32Array | null = this._cacheElems[l][slot];

                    if (elements !== null && (elements[word] & mask) !== 0) {
                        occupied = true;

                        if (layers[l]._flow) {
                            layers[l]._Activate(this._cacheChunks[l][slot] as PhysicsVoxelChunk, index);
                        }
                    }
                }

                if (occupied) {
                    break;
                }
            }
        }
    }

    /**
     * Returns this layer's chunk covering the provided swept-chunk-local
     * coordinates, creating it (and updating the caches) when missing.
     */
    private _EnsureChunkLocal(lx: number, ly: number, lz: number): PhysicsVoxelChunk {
        const slot: number = (((lx >> 4) + 1) * 3 + ((ly >> 4) + 1)) * 3 + ((lz >> 4) + 1);
        const ownIndex: number = this._ctxOwnIndex;

        let chunk: PhysicsVoxelChunk | null = this._cacheChunks[ownIndex][slot];

        if (chunk === null) {
            chunk = this._EnsureChunk(this._ctxChunkX + (lx >> 4), this._ctxChunkY + (ly >> 4), this._ctxChunkZ + (lz >> 4));

            this._cacheChunks[ownIndex][slot] = chunk;
            this._cacheElems[ownIndex][slot] = chunk.layer.bitArray.elements;
        }

        return chunk;
    }

    /**
     * Moves the grain at the swept-chunk-local source cell into the target
     * cell, transferring the active flag, marking the grain as moved for this
     * tick, recording dirty chunks and waking the vacated neighbourhood.
     */
    private _MoveGrain(chunk: PhysicsVoxelChunk, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
        const fromIndex: number = VoxelPhysicsLayer._Encode(fx, fy, fz);
        const fromWord: number = fromIndex >> 5;
        const fromMask: number = 1 << (fromIndex & 31);

        // vacate the source cell
        chunk.layer.bitArray.elements[fromWord] &= ~fromMask;
        chunk.active.elements[fromWord] &= ~fromMask;
        chunk.activeCount--;
        this._activeTotal--;

        // occupy the target cell, keeping the grain awake but blocked from
        // moving again this tick
        const target: PhysicsVoxelChunk = this._EnsureChunkLocal(tx, ty, tz);
        const targetIndex: number = VoxelPhysicsLayer._Encode(tx & 15, ty & 15, tz & 15);
        const targetWord: number = targetIndex >> 5;
        const targetMask: number = 1 << (targetIndex & 31);

        target.layer.bitArray.elements[targetWord] |= targetMask;
        target.movedForTick(this._ctxTick)[targetWord] |= targetMask;

        this._Activate(target, targetIndex);

        this._dirty.add(chunk.key.key);
        this._dirty.add(target.key.key);

        this._WakeVacancy(fx, fy, fz);
    }

    /**
     * Swaps the grain at the swept-chunk-local source cell with the
     * lower-density grain of another layer at the target cell - displacement,
     * e.g. sand sinking through water while the water rises.
     */
    private _SwapGrain(chunk: PhysicsVoxelChunk, otherIndex: number, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
        const other: VoxelPhysicsLayer = this._ctxLayers[otherIndex] as VoxelPhysicsLayer;
        const tick: number = this._ctxTick;

        const fromIndex: number = VoxelPhysicsLayer._Encode(fx, fy, fz);
        const fromWord: number = fromIndex >> 5;
        const fromMask: number = 1 << (fromIndex & 31);

        const targetSlot: number = (((tx >> 4) + 1) * 3 + ((ty >> 4) + 1)) * 3 + ((tz >> 4) + 1);
        const targetIndex: number = VoxelPhysicsLayer._Encode(tx & 15, ty & 15, tz & 15);
        const targetWord: number = targetIndex >> 5;
        const targetMask: number = 1 << (targetIndex & 31);

        // this layer's grain sinks from the source cell into the target cell
        chunk.layer.bitArray.elements[fromWord] &= ~fromMask;
        chunk.active.elements[fromWord] &= ~fromMask;
        chunk.activeCount--;
        this._activeTotal--;

        const ownTarget: PhysicsVoxelChunk = this._EnsureChunkLocal(tx, ty, tz);

        ownTarget.layer.bitArray.elements[targetWord] |= targetMask;
        ownTarget.movedForTick(tick)[targetWord] |= targetMask;

        this._Activate(ownTarget, targetIndex);

        this._dirty.add(chunk.key.key);
        this._dirty.add(ownTarget.key.key);

        // the displaced grain rises from the target cell into the source cell -
        // its chunk is guaranteed to exist as its grain occupies the target
        const otherSource: PhysicsVoxelChunk = this._cacheChunks[otherIndex][targetSlot] as PhysicsVoxelChunk;

        otherSource.layer.bitArray.elements[targetWord] &= ~targetMask;

        if ((otherSource.active.elements[targetWord] & targetMask) !== 0) {
            otherSource.active.elements[targetWord] &= ~targetMask;
            otherSource.activeCount--;
            other._activeTotal--;
        }

        const otherTarget: PhysicsVoxelChunk = other._EnsureChunk(this._ctxChunkX + (fx >> 4), this._ctxChunkY + (fy >> 4), this._ctxChunkZ + (fz >> 4));

        otherTarget.layer.bitArray.elements[fromWord] |= fromMask;
        otherTarget.movedForTick(tick)[fromWord] |= fromMask;

        other._Activate(otherTarget, fromIndex);

        other._dirty.add(otherSource.key.key);
        other._dirty.add(otherTarget.key.key);

        // refresh the sweeping layer's cache for the other layer's new chunk
        this._cacheChunks[otherIndex][13] = otherTarget;
        this._cacheElems[otherIndex][13] = otherTarget.layer.bitArray.elements;
    }

    /**
     * Attempts a lateral flow move for the grain at the provided
     * swept-chunk-local cell. The grain scans up to flowDistance cells along
     * each lateral axis (rotated by the deterministic hash) and moves to the
     * first surface cell with a drop below it. When no straight-line drop is
     * reachable, a second pass allows a single perpendicular turn along each
     * path so pools level around corners. When nothing is reachable the grain
     * settles - which is what keeps level pools fully dormant.
     *
     * @returns - True when the grain moved.
     */
    private _TryFlow(chunk: PhysicsVoxelChunk, x: number, y: number, z: number, hash: number): boolean {
        const flowDistance: number = this._flowDistance;

        // phase 1 - straight-line scan for a drop-off
        for (let c = 0; c < 4; c++) {
            const d: number = (hash + c) & 3;
            const dx: number = LATERAL_X[d];
            const dz: number = LATERAL_Z[d];

            for (let reach = 1; reach <= flowDistance; reach++) {
                const nx: number = x + (dx * reach);
                const nz: number = z + (dz * reach);

                // a blocked cell walls off this direction
                if (!this._IsOpen(nx, y, nz)) {
                    break;
                }

                // flow to the first surface cell with a drop below it
                if (this._IsOpen(nx, y - 1, nz)) {
                    this._MoveGrain(chunk, x, y, z, nx, y, nz);

                    return true;
                }
            }
        }

        // phase 2 - allow one perpendicular turn along each straight path, so
        // drops around a corner remain reachable
        for (let c = 0; c < 4; c++) {
            const d: number = (hash + c) & 3;
            const dx: number = LATERAL_X[d];
            const dz: number = LATERAL_Z[d];

            // the perpendicular axis of this direction
            const px: number = dz !== 0 ? 1 : 0;
            const pz: number = dx !== 0 ? 1 : 0;

            for (let reach = 1; reach <= flowDistance; reach++) {
                const nx: number = x + (dx * reach);
                const nz: number = z + (dz * reach);

                if (!this._IsOpen(nx, y, nz)) {
                    break;
                }

                // scan both perpendicular directions from this path cell
                for (let side = -1; side <= 1; side += 2) {
                    for (let turn = 1; turn <= flowDistance; turn++) {
                        const tx: number = nx + (px * side * turn);
                        const tz: number = nz + (pz * side * turn);

                        if (!this._IsOpen(tx, y, tz)) {
                            break;
                        }

                        if (this._IsOpen(tx, y - 1, tz)) {
                            this._MoveGrain(chunk, x, y, z, tx, y, tz);

                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    /**
     * Simulates one tick for a single chunk - the solver's hot loop. Sweeps
     * bottom-up over the active grains, moving each at most one cell.
     */
    private _SweepChunk(chunk: PhysicsVoxelChunk, tick: number): number {
        const chunkKey: MortonKey = chunk.key;

        this._ctxChunkX = chunkKey.x;
        this._ctxChunkY = chunkKey.y;
        this._ctxChunkZ = chunkKey.z;

        // simulation bounds in swept-chunk-local coordinates
        this._ctxLoX = this._ctxMinX - (this._ctxChunkX << 4);
        this._ctxLoY = this._ctxMinY - (this._ctxChunkY << 4);
        this._ctxLoZ = this._ctxMinZ - (this._ctxChunkZ << 4);
        this._ctxHiX = this._ctxMaxX - (this._ctxChunkX << 4);
        this._ctxHiY = this._ctxMaxY - (this._ctxChunkY << 4);
        this._ctxHiZ = this._ctxMaxZ - (this._ctxChunkZ << 4);

        this._FillCaches(this._ctxChunkX, this._ctxChunkY, this._ctxChunkZ);

        const ownElements: Uint32Array = chunk.layer.bitArray.elements;
        const activeElements: Uint32Array = chunk.active.elements;
        const moved: Uint32Array = chunk.movedForTick(tick);

        const planeWords: Uint8Array = VoxelPhysicsLayer._PLANE_WORDS;
        const planeMasks: Int32Array = VoxelPhysicsLayer._PLANE_MASKS;

        // alternate the coarse sweep direction per tick to avoid directional bias
        const reversed: boolean = (tick & 1) !== 0;

        const gox: number = this._ctxChunkX << 4;
        const goy: number = this._ctxChunkY << 4;
        const goz: number = this._ctxChunkZ << 4;

        const slide: boolean = this._slide;
        const flow: boolean = this._flow;

        let moves = 0;

        // bottom-up so a falling column compacts together within one tick. Only
        // words containing active plane bits are visited - dormant regions are
        // skipped at word granularity.
        for (let y = 0; y < 16; y++) {
            const planeBase: number = (y >> 2) * 32;
            const planeMask: number = planeMasks[y & 3];

            for (let i = 0; i < 32; i++) {
                const word: number = planeWords[planeBase + (reversed ? 31 - i : i)];

                // active grains of this y-plane that have not moved this tick
                let bits: number = activeElements[word] & planeMask & ~moved[word];

                while (bits !== 0) {
                    const lowestBit: number = bits & -bits;
                    bits ^= lowestBit;

                    const bit: number = 31 - Math.clz32(lowestBit);
                    const mask: number = lowestBit;

                    // decode the cell coordinates from the word/bit layout
                    const x: number = (((word >> 5) & 3) << 2) | ((word & 1) << 1) | ((bit >> 4) & 1);
                    const z: number = (((word >> 1) & 3) << 2) | (bit & 3);

                    // stale active flag - the grain was removed externally
                    if ((ownElements[word] & mask) === 0) {
                        activeElements[word] &= ~mask;
                        chunk.activeCount--;
                        this._activeTotal--;

                        continue;
                    }

                    // 1) fall straight down
                    if (this._IsOpen(x, y - 1, z)) {
                        this._MoveGrain(chunk, x, y, z, x, y - 1, z);
                        moves++;

                        continue;
                    }

                    // 2) displace a lower-density grain below (sink through it)
                    const lighter: number = this._FindLighterOccupant(x, y - 1, z);

                    if (lighter >= 0) {
                        this._SwapGrain(chunk, lighter, x, y, z, x, y - 1, z);
                        moves++;

                        continue;
                    }

                    // deterministic per-cell/tick rotation of candidate directions
                    const hash: number = (Math.imul(gox + x, 0x9E3779B1) ^ Math.imul(goy + y, 0x85EBCA77) ^ Math.imul(goz + z, 0xC2B2AE3D) ^ Math.imul(tick, 0x27D4EB2F)) >>> 0;

                    // 3) slide diagonally down
                    let didMove = false;

                    if (slide) {
                        for (let c = 0; c < 4; c++) {
                            const d: number = (hash + c) & 3;
                            const nx: number = x + LATERAL_X[d];
                            const nz: number = z + LATERAL_Z[d];

                            if (this._IsOpen(nx, y - 1, nz)) {
                                this._MoveGrain(chunk, x, y, z, nx, y - 1, nz);
                                didMove = true;

                                break;
                            }
                        }
                    }

                    if (didMove) {
                        moves++;

                        continue;
                    }

                    // 4) flow laterally along the surface toward a reachable
                    // drop-off. Restricting flow to reachable drops lets level
                    // pools settle into a fully dormant state - changes
                    // re-level them through chained vacancy wakes.
                    if (flow) {
                        didMove = this._TryFlow(chunk, x, y, z, hash);
                    }

                    if (didMove) {
                        moves++;

                        continue;
                    }

                    // 5) nowhere to go - settle until a nearby cell changes
                    activeElements[word] &= ~mask;
                    chunk.activeCount--;
                    this._activeTotal--;

                    // a newly dormant flow grain requires flow-line wakes for
                    // the remainder of this tick
                    if (flow) {
                        this._physics.notifyFlowSettled();
                    }
                }
            }
        }

        return moves;
    }
}
