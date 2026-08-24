import { BitArray } from "../../containers/bit-array.js";
import { MortonKey } from "../../math/morton-key.js";
import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelWorld } from "../voxel-world.js";

/**
 * Controls how a layer claims blur-ambiguous surface cells when meshing with
 * occluders (see VoxelSmoothGeometry.computeGeometry). With field smoothing, a
 * surface crossing can sit on a sample no layer occupies directly - the mode
 * decides which layer emits that piece of the shared union surface:
 *
 * - "primary": claims contested cells when its own field contribution is at
 *   least half of the merged field (ties go to this layer). Use for exactly one
 *   layer of a mutually-occluding pair so the shared surface is partitioned
 *   without duplicates or holes.
 * - "secondary": claims contested cells only when its own contribution strictly
 *   dominates (ties go to the occluders). The counterpart of "primary".
 * - "overlay": claims every surface cell its own blurred field influences at
 *   all, including cells the occluders raw-occupy. Use for transparent layers
 *   rendered on top of the occluding geometry (water over terrain). Claiming
 *   the full influence support is what welds the patch: its rim lands on cells
 *   where this layer's blurred field is zero, and there the merged field is
 *   bit-identical to the occluders' own field, so the rim vertices coincide
 *   exactly with the occluding layer's mesh instead of floating above it.
 */
export type SmoothOcclusionMode = "primary" | "secondary" | "overlay";

/**
 * VoxelSmoothGeometry generates a smooth, renderer-agnostic triangle mesh for the
 * BitVoxels of a VoxelChunk using the Naive Surface Nets algorithm. This is an
 * alternative to the blocky VoxelFaceGeometry + BVXGeometry rendering path.
 *
 * The mesh is computed from a scalar occupancy field sampled from the chunk and
 * its neighbouring chunks. An optional number of smoothing passes blurs the field
 * before contouring, producing progressively softer, blobbier surfaces. With no
 * smoothing the result is the classic surface nets mesh with edge-midpoint
 * crossings.
 *
 * Design notes:
 *
 * - Geometry is emitted in the same coordinate space as BVXGeometry, where a
 *   single Voxel spans 1.0 units and a BitVoxel spans 0.25 units. A chunk covers
 *   0.0 to 4.0 units on each axis.
 * - Chunk seams are watertight. The occupancy field is sampled from neighbouring
 *   chunks so both sides of a seam contour identical data, and seam quads are
 *   emitted by exactly one of the two chunks (ownership goes to the negative-side
 *   chunk when it exists in the world).
 * - Normals are derived from the field gradient at each surface cell, which is
 *   local to the cell and therefore consistent on both sides of a chunk seam.
 * - Like other geometry classes, instances pre-allocate worst-case buffers once
 *   and can be reused across computeGeometry() calls without further allocations.
 */
export class VoxelSmoothGeometry {
    /**
     * The maximum number of supported smoothing passes.
     */
    public static readonly MAX_SMOOTHING: number = 3;

    /**
     * The size of a single BitVoxel in output coordinate space, matching the
     * BVXGeometry lookup tables (4 BitVoxels per 1.0 unit Voxel).
     */
    public static readonly BIT_VOXEL_SIZE: number = 0.25;

    /**
     * The maximum field sampling margin around the chunk. Each smoothing pass
     * consumes one sample of margin, plus one sample for the border surface cells.
     */
    private static readonly _MARGIN_MAX: number = 1 + VoxelSmoothGeometry.MAX_SMOOTHING;

    /**
     * The dimensions of the field sampling buffer at maximum margin.
     */
    private static readonly _FIELD_DIMS: number = BVXLayer.DIMS + (2 * VoxelSmoothGeometry._MARGIN_MAX);

    /**
     * The dimensions of the surface cell grid. Cells with min-corner from -1 to 15
     * on each axis are contoured, which covers the negative seams of the chunk.
     */
    private static readonly _CELL_DIMS: number = BVXLayer.DIMS + 1;

    /**
     * The maximum number of surface cells (and therefore vertices) per chunk.
     */
    private static readonly _MAX_CELLS: number = VoxelSmoothGeometry._CELL_DIMS * VoxelSmoothGeometry._CELL_DIMS * VoxelSmoothGeometry._CELL_DIMS;

    /**
     * The maximum number of indices per chunk. Each of the 3 edge directions has
     * 17x16x16 candidate edges, each emitting at most one quad (6 indices).
     */
    private static readonly _MAX_INDICES: number = 3 * VoxelSmoothGeometry._CELL_DIMS * BVXLayer.DIMS * BVXLayer.DIMS * 6;

    /**
     * The iso-level of the occupancy field. Field values at or above this level
     * are considered inside the surface.
     */
    private static readonly _ISO_LEVEL: number = 0.5;

    /**
     * Temporary MortonKey used for neighbouring chunk queries.
     */
    private static readonly TMP_MK: MortonKey = new MortonKey();

    /**
     * The occupancy field sampled from the chunk and its neighbours. When meshing
     * with occluders this holds the merged (own plus occluder) occupancy.
     */
    private readonly _field: Float32Array;

    /**
     * Scratch buffer used during field smoothing passes.
     */
    private readonly _fieldScratch: Float32Array;

    /**
     * The own-layer occupancy field, blurred identically to the merged field.
     * Only filled when meshing with occluders and at least one smoothing pass -
     * used to resolve ownership of blur-ambiguous surface cells.
     */
    private readonly _ownField: Float32Array;

    /**
     * Unblurred own-layer occupancy per field sample (occluder meshing only).
     */
    private readonly _rawOwn: Uint8Array;

    /**
     * Unblurred merged occupancy per field sample (occluder meshing only).
     */
    private readonly _rawMerged: Uint8Array;

    /**
     * Per surface cell flag marking cells whose 8 field corners carry any
     * own-layer blurred contribution - the influence support of this layer
     * (occluder meshing only, used by the "overlay" mode).
     */
    private readonly _cellInfluenced: Uint8Array;

    /**
     * Whether the most recent field sampling found occluder occupancy in the
     * chunk's neighbourhood - gates all ownership logic and vertex compaction.
     */
    private _occludersActive = false;

    /**
     * How many samples the most recent _SampleField set - the uniform-field early-out
     * compares this against the sampled volume.
     */
    private _sampleSetCount = 0;

    /**
     * The ownership mode for blur-ambiguous surface cells (see SmoothOcclusionMode).
     */
    private _occlusionMode: SmoothOcclusionMode = "primary";

    /**
     * Maps a surface cell to its vertex index, or -1 when the cell has no vertex.
     */
    private readonly _cellVertex: Int32Array;

    /**
     * Vertex positions (3 floats per vertex).
     */
    private readonly _vertices: Float32Array;

    /**
     * Vertex normals (3 floats per vertex).
     */
    private readonly _normals: Float32Array;

    /**
     * Triangle indices (3 indices per triangle).
     */
    private readonly _indices: Uint32Array;

    /**
     * The number of vertices generated by the most recent computeGeometry() call.
     */
    private _vertexCount = 0;

    /**
     * The number of indices generated by the most recent computeGeometry() call.
     */
    private _indexCount = 0;

    /**
     * The number of vertices whose field gradient was degenerate (zero) and
     * require a triangle-accumulated normal fallback.
     */
    private _degenerateNormalCount = 0;

    constructor() {
        const fieldSize: number = VoxelSmoothGeometry._FIELD_DIMS * VoxelSmoothGeometry._FIELD_DIMS * VoxelSmoothGeometry._FIELD_DIMS;

        this._field = new Float32Array(fieldSize);
        this._fieldScratch = new Float32Array(fieldSize);
        this._ownField = new Float32Array(fieldSize);
        this._rawOwn = new Uint8Array(fieldSize);
        this._rawMerged = new Uint8Array(fieldSize);
        this._cellInfluenced = new Uint8Array(VoxelSmoothGeometry._MAX_CELLS);
        this._cellVertex = new Int32Array(VoxelSmoothGeometry._MAX_CELLS);
        this._vertices = new Float32Array(VoxelSmoothGeometry._MAX_CELLS * 3);
        this._normals = new Float32Array(VoxelSmoothGeometry._MAX_CELLS * 3);
        this._indices = new Uint32Array(VoxelSmoothGeometry._MAX_INDICES);
    }

    /**
     * Returns the vertex positions generated by the most recent computeGeometry()
     * call as an exact-length view (3 floats per vertex).
     *
     * NOTE: The returned view aliases an internal buffer that is overwritten by
     * the next computeGeometry() call.
     */
    public get vertices(): Float32Array {
        return this._vertices.subarray(0, this._vertexCount * 3);
    }

    /**
     * Returns the vertex normals generated by the most recent computeGeometry()
     * call as an exact-length view (3 floats per vertex). Normals are normalised.
     *
     * NOTE: The returned view aliases an internal buffer that is overwritten by
     * the next computeGeometry() call.
     */
    public get normals(): Float32Array {
        return this._normals.subarray(0, this._vertexCount * 3);
    }

    /**
     * Returns the triangle indices generated by the most recent computeGeometry()
     * call as an exact-length view (3 indices per triangle).
     *
     * NOTE: The returned view aliases an internal buffer that is overwritten by
     * the next computeGeometry() call.
     */
    public get indices(): Uint32Array {
        return this._indices.subarray(0, this._indexCount);
    }

    /**
     * Returns the number of vertices generated by the most recent
     * computeGeometry() call.
     */
    public get vertexCount(): number {
        return this._vertexCount;
    }

    /**
     * Returns the number of indices generated by the most recent
     * computeGeometry() call.
     */
    public get indexCount(): number {
        return this._indexCount;
    }

    /**
     * Computes a smooth surface mesh for all BitVoxels in the given VoxelChunk.
     * Neighbouring chunks in the VoxelWorld are sampled so the generated surface
     * is watertight across chunk seams.
     *
     * When an occluder world is provided, the surface is contoured from the merged
     * (own plus occluder) occupancy and only the pieces owned by this layer are
     * emitted. Interfaces between the layer and its occluders produce no geometry -
     * they are interior to the merged field - which renders multiple co-located
     * layers (e.g. terrain plus a physics sand layer) without duplicated surfaces.
     * Two mutually-occluding layers contour the identical merged field, so their
     * emitted pieces partition one watertight union surface when meshed with the
     * "primary"/"secondary" mode pairing. Transparent layers (water) should list
     * the opaque layers as occluders with the "overlay" mode, while the opaque
     * layers omit the transparent layer so their surfaces stay visible through it.
     *
     * @param center - The VoxelChunk for which geometry is being generated.
     * @param world - The VoxelWorld instance used to query neighbouring chunks.
     * @param smoothing - (Optional) The number of field smoothing passes between 0
     * and MAX_SMOOTHING. Defaults to 0 (classic surface nets).
     * @param flipped - (Optional) Whether to flip the triangle winding order, for
     * renderers with an opposite front-face convention. Defaults to false.
     * @param occluders - (Optional) A VoxelWorld whose occupancy culls the surface
     * pieces it owns (see above).
     * @param occlusionMode - (Optional) How blur-ambiguous surface cells are
     * claimed (see SmoothOcclusionMode). Defaults to "primary".
     */
    public computeGeometry(center: VoxelChunk, world: VoxelWorld, smoothing = 0, flipped = false, occluders: VoxelWorld | null = null, occlusionMode: SmoothOcclusionMode = "primary"): void {
        this._vertexCount = 0;
        this._indexCount = 0;
        this._degenerateNormalCount = 0;
        this._occlusionMode = occlusionMode;

        const passes: number = Math.min(Math.max(smoothing | 0, 0), VoxelSmoothGeometry.MAX_SMOOTHING);
        const margin: number = 1 + passes;

        // sample the occupancy field from the center chunk and its neighbours
        const negativeNeighbours: boolean[] = this._SampleField(center, world, margin, occluders);

        // Uniform-field early-out. A field that is entirely empty or entirely solid
        // across the sampled region cannot cross the iso level: the blur is clamped to
        // the active region, so a constant field blurs to itself, and contouring a
        // constant field emits nothing. In a world with real depth most chunks are
        // exactly this - open air or buried ground - and without the early-out each
        // one paid nearly the full price of a surface chunk to produce zero output
        // (measured 0.2 ms per solid chunk at smoothing 2).
        const span: number = BVXLayer.DIMS + (margin * 2);

        if (this._sampleSetCount === 0 || this._sampleSetCount === span * span * span) {
            return;
        }

        // blur the field for each smoothing pass
        for (let pass = 0; pass < passes; pass++) {
            this._SmoothField(margin, this._field);
        }

        // blur the own-layer field identically - blurring is linear and all blur
        // arithmetic is exact in floating point (dyadic coefficients on 0/1
        // inputs), so the own fields of mutually-occluding layers sum exactly to
        // the merged field. That exactness is what lets the ownership tests
        // partition without duplicates or holes, and what makes the merged field
        // bit-identical to the occluders' field wherever this field is zero.
        if (this._occludersActive) {
            const ownField: Float32Array = this._ownField;
            const rawOwn: Uint8Array = this._rawOwn;

            for (let i = 0; i < ownField.length; i++) {
                ownField[i] = rawOwn[i];
            }

            for (let pass = 0; pass < passes; pass++) {
                this._SmoothField(margin, ownField);
            }
        }

        // contour the field - generate one vertex per surface cell
        this._ComputeVertices(margin);

        // connect surface cell vertices into quads across sign-change edges
        this._ComputeQuads(margin, negativeNeighbours, flipped);

        // drop the vertices of surface pieces owned by the occluders
        if (this._occludersActive) {
            this._CompactVertices();
        }

        // resolve normals for cells with a degenerate field gradient
        if (this._degenerateNormalCount > 0) {
            this._ComputeFallbackNormals();
        }
    }

    /**
     * Samples the occupancy field for the chunk and a margin of surrounding
     * BitVoxels read from neighbouring chunks. Missing chunks sample as empty.
     * When an occluder world is provided, the field holds the merged occupancy
     * and the raw own/merged occupancy buffers are filled for ownership tests.
     *
     * @param center - The VoxelChunk being contoured.
     * @param world - The VoxelWorld used to query neighbouring chunks.
     * @param margin - The number of samples to read beyond the chunk on each side.
     * @param occluders - The occluder VoxelWorld, or null when meshing standalone.
     * @returns - Existence flags for the -x, -y and -z neighbouring chunks, used
     * for seam quad ownership.
     */
    private _SampleField(center: VoxelChunk, world: VoxelWorld, margin: number, occluders: VoxelWorld | null): boolean[] {
        const dims: number = BVXLayer.DIMS;
        const fieldDims: number = VoxelSmoothGeometry._FIELD_DIMS;
        const field: Float32Array = this._field;

        let setCount = 0;
        const centerKey: MortonKey = center.key;
        const tmpKey: MortonKey = VoxelSmoothGeometry.TMP_MK;

        // gather the 3x3x3 neighbourhood of chunk BitVoxel storages (null = missing)
        // for the own world and, when provided, the occluder world
        const neighbourhood: (Uint32Array | null)[] = new Array<Uint32Array | null>(27);
        const occNeighbourhood: (Uint32Array | null)[] = new Array<Uint32Array | null>(27);

        let occludersActive = false;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const slot: number = ((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1);

                    MortonKey.from(centerKey.x + ox, centerKey.y + oy, centerKey.z + oz, tmpKey);

                    if (occluders !== null) {
                        const occChunk: VoxelChunk | null = occluders.get(tmpKey);

                        occNeighbourhood[slot] = occChunk !== null ? occChunk.layer.bitArray.elements : null;
                        occludersActive = occludersActive || occChunk !== null;
                    }
                    else {
                        occNeighbourhood[slot] = null;
                    }

                    if (ox === 0 && oy === 0 && oz === 0) {
                        neighbourhood[slot] = center.layer.bitArray.elements;

                        continue;
                    }

                    const chunk: VoxelChunk | null = world.get(tmpKey);
                    neighbourhood[slot] = chunk !== null ? chunk.layer.bitArray.elements : null;
                }
            }
        }

        this._occludersActive = occludersActive;

        // Chunk-level uniformity pre-check. When every slot the sampling could read is
        // uniformly solid, or every one is absent or uniformly empty, the sampled field
        // is a constant and computeGeometry's early-out fires on the count alone - the
        // per-sample loop and the field fill are skipped entirely. This is the buried
        // and open-air case, the bulk of a world with real depth. Skipped when an
        // occluder chunk is present: merged fullness is not a chunk-level question.
        if (!occludersActive) {
            let allFull = true;
            let allEmpty = true;

            for (let slot = 0; slot < 27 && (allFull || allEmpty); slot++) {
                const elements: Uint32Array | null = neighbourhood[slot];

                if (elements === null) {
                    allFull = false;

                    continue;
                }

                const state: number = BitArray.uniformState(elements);

                allFull = allFull && state === BitArray.FULL;
                allEmpty = allEmpty && state === BitArray.EMPTY;
            }

            if (allFull || allEmpty) {
                const span: number = dims + (margin * 2);

                this._sampleSetCount = allFull ? span * span * span : 0;

                const negativeSlots: number[] = [4, 10, 12]; // (-1,0,0) (0,-1,0) (0,0,-1)
                const negativeNeighbours: boolean[] = new Array<boolean>(3);

                for (let axis = 0; axis < 3; axis++) {
                    negativeNeighbours[axis] = neighbourhood[negativeSlots[axis]] !== null;
                }

                return negativeNeighbours;
            }
        }

        field.fill(0.0);

        const rawOwn: Uint8Array = this._rawOwn;
        const rawMerged: Uint8Array = this._rawMerged;

        if (occludersActive) {
            rawOwn.fill(0);
            rawMerged.fill(0);
        }

        // fill the field with 0/1 occupancy for samples in [-margin, dims + margin)
        const min: number = -margin;
        const max: number = dims + margin;

        for (let sx = min; sx < max; sx++) {
            const cx: number = sx >> 4;
            const lx: number = sx & 15;

            for (let sy = min; sy < max; sy++) {
                const cy: number = sy >> 4;
                const ly: number = sy & 15;

                for (let sz = min; sz < max; sz++) {
                    const cz: number = sz >> 4;
                    const lz: number = sz & 15;

                    const slot: number = ((cx + 1) * 3 + (cy + 1)) * 3 + (cz + 1);
                    const elements: Uint32Array | null = neighbourhood[slot];
                    const occElements: Uint32Array | null = occNeighbourhood[slot];

                    if (elements === null && occElements === null) {
                        continue;
                    }

                    // BitVoxel index within the owning chunk
                    const index: number = ((lx >> 2) << 10) | ((ly >> 2) << 8) | ((lz >> 2) << 6) | ((lx & 3) << 4) | ((ly & 3) << 2) | (lz & 3);
                    const word: number = index >> 5;
                    const mask: number = 1 << (index & 31);

                    const ownState: number = elements !== null && (elements[word] & mask) !== 0 ? 1 : 0;
                    const occState: number = occElements !== null && (occElements[word] & mask) !== 0 ? 1 : 0;

                    if ((ownState | occState) !== 0) {
                        const fieldIndex: number = ((sx + margin) * fieldDims + (sy + margin)) * fieldDims + (sz + margin);

                        field[fieldIndex] = 1.0;
                        setCount++;

                        if (occludersActive) {
                            rawMerged[fieldIndex] = 1;
                            rawOwn[fieldIndex] = ownState;
                        }
                    }
                }
            }
        }

        this._sampleSetCount = setCount;

        // Existence flags for the negative-side neighbours (seam quad ownership).
        // A chunk held only by the occluders still counts: with occluders a layer
        // can own surface in a chunk it holds no voxels at (the tapering rim of an
        // overlay patch, or a contested cell of a partition), so the meshed set is
        // the merged one. Both sides of every seam evaluate this identically, which
        // is what keeps each seam emitted exactly once.
        const negativeSlots: number[] = [4, 10, 12]; // (-1,0,0) (0,-1,0) (0,0,-1)
        const negativeNeighbours: boolean[] = new Array<boolean>(3);

        for (let axis = 0; axis < 3; axis++) {
            const slot: number = negativeSlots[axis];

            negativeNeighbours[axis] = neighbourhood[slot] !== null || occNeighbourhood[slot] !== null;
        }

        return negativeNeighbours;
    }

    /**
     * Applies a single separable 3-tap blur pass (0.25, 0.5, 0.25) to the provided
     * field along each axis. Buffer edges are clamped - only samples within the
     * active margin remain exact, which is guaranteed by the margin sizing.
     *
     * @param margin - The active field margin, used to bound the blur region.
     * @param field - The field buffer to blur in place.
     */
    private _SmoothField(margin: number, field: Float32Array): void {
        const fieldDims: number = VoxelSmoothGeometry._FIELD_DIMS;
        const scratch: Float32Array = this._fieldScratch;
        const max: number = BVXLayer.DIMS + (2 * margin);

        // Ping-pong between the two buffers rather than copying back after every axis.
        // Three passes is odd, so the result lands in scratch and one copy returns it.
        VoxelSmoothGeometry._BlurX(field, scratch, max, fieldDims);
        VoxelSmoothGeometry._BlurY(scratch, field, max, fieldDims);
        VoxelSmoothGeometry._BlurZ(field, scratch, max, fieldDims);

        field.set(scratch);
    }

    /**
     * Blurs along x, where the clamp depends only on the outermost loop variable and
     * the stride spans a whole plane.
     *
     * The three axis passes are written out separately rather than driven by an axis
     * parameter. A shared loop has to pick the axis coordinate with a ternary and test
     * both clamps on every one of the ~14k samples per pass, and none of that work
     * varies within the inner loop - specialising hoists all of it to the loop that
     * actually changes it.
     *
     * @param src - The field to read.
     * @param dst - The buffer to write the blurred result to.
     * @param max - The exclusive upper bound of the active field region.
     * @param fieldDims - The field's per-axis dimension.
     */
    private static _BlurX(src: Float32Array, dst: Float32Array, max: number, fieldDims: number): void {
        const stride: number = fieldDims * fieldDims;
        const last: number = max - 1;

        for (let x = 0; x < max; x++) {
            // clamped at the low and high edges of the blur axis
            const prevStride: number = x > 0 ? stride : 0;
            const nextStride: number = x < last ? stride : 0;

            for (let y = 0; y < max; y++) {
                const rowStart: number = (x * fieldDims + y) * fieldDims;

                for (let z = 0; z < max; z++) {
                    const index: number = rowStart + z;

                    dst[index] = (0.25 * src[index - prevStride]) + (0.5 * src[index]) + (0.25 * src[index + nextStride]);
                }
            }
        }
    }

    /**
     * Blurs along y, where the clamp depends on the middle loop variable and the
     * stride spans a row. See _BlurX.
     *
     * @param src - The field to read.
     * @param dst - The buffer to write the blurred result to.
     * @param max - The exclusive upper bound of the active field region.
     * @param fieldDims - The field's per-axis dimension.
     */
    private static _BlurY(src: Float32Array, dst: Float32Array, max: number, fieldDims: number): void {
        const last: number = max - 1;

        for (let x = 0; x < max; x++) {
            const planeStart: number = x * fieldDims * fieldDims;

            for (let y = 0; y < max; y++) {
                const prevStride: number = y > 0 ? fieldDims : 0;
                const nextStride: number = y < last ? fieldDims : 0;
                const rowStart: number = planeStart + (y * fieldDims);

                for (let z = 0; z < max; z++) {
                    const index: number = rowStart + z;

                    dst[index] = (0.25 * src[index - prevStride]) + (0.5 * src[index]) + (0.25 * src[index + nextStride]);
                }
            }
        }
    }

    /**
     * Blurs along z, where the clamp depends on the innermost loop variable. Peeling
     * the first and last samples out leaves the interior loop - all but two of every
     * row - completely branch-free. See _BlurX.
     *
     * @param src - The field to read.
     * @param dst - The buffer to write the blurred result to.
     * @param max - The exclusive upper bound of the active field region.
     * @param fieldDims - The field's per-axis dimension.
     */
    private static _BlurZ(src: Float32Array, dst: Float32Array, max: number, fieldDims: number): void {
        const last: number = max - 1;

        for (let x = 0; x < max; x++) {
            const planeStart: number = x * fieldDims * fieldDims;

            for (let y = 0; y < max; y++) {
                const rowStart: number = planeStart + (y * fieldDims);

                // low edge - the previous sample clamps to the sample itself
                dst[rowStart] = (0.75 * src[rowStart]) + (0.25 * src[rowStart + 1]);

                for (let z = 1; z < last; z++) {
                    const index: number = rowStart + z;

                    dst[index] = (0.25 * src[index - 1]) + (0.5 * src[index]) + (0.25 * src[index + 1]);
                }

                // high edge - the next sample clamps to the sample itself
                const end: number = rowStart + last;

                dst[end] = (0.25 * src[end - 1]) + (0.75 * src[end]);
            }
        }
    }

    /**
     * Generates one vertex for every surface cell of the field. A surface cell is
     * a dual cell between 8 field samples whose occupancy states differ. The
     * vertex is placed at the centroid of the iso-level crossings along the cell
     * edges, and its normal is the negated field gradient at the cell.
     *
     * @param margin - The active field margin.
     */
    private _ComputeVertices(margin: number): void {
        const fieldDims: number = VoxelSmoothGeometry._FIELD_DIMS;
        const cellDims: number = VoxelSmoothGeometry._CELL_DIMS;
        const iso: number = VoxelSmoothGeometry._ISO_LEVEL;
        const scale: number = VoxelSmoothGeometry.BIT_VOXEL_SIZE;

        const field: Float32Array = this._field;
        const cellVertex: Int32Array = this._cellVertex;
        const vertices: Float32Array = this._vertices;
        const normals: Float32Array = this._normals;

        // own-layer influence tracking, only when meshing with occluders
        const occludersActive: boolean = this._occludersActive;
        const ownField: Float32Array = this._ownField;
        const cellInfluenced: Uint8Array = this._cellInfluenced;

        cellVertex.fill(-1);

        if (occludersActive) {
            cellInfluenced.fill(0);
        }

        let vertexCount = 0;

        // cells with min-corner from -1 to dims - 1 (inclusive) on each axis
        for (let cx = -1; cx < cellDims - 1; cx++) {
            for (let cy = -1; cy < cellDims - 1; cy++) {
                for (let cz = -1; cz < cellDims - 1; cz++) {
                    const baseIndex: number = ((cx + margin) * fieldDims + (cy + margin)) * fieldDims + (cz + margin);

                    // the 8 corner samples of the dual cell, indexed as dx | dy << 1 | dz << 2
                    const f0: number = field[baseIndex];
                    const f1: number = field[baseIndex + (fieldDims * fieldDims)];
                    const f2: number = field[baseIndex + fieldDims];
                    const f3: number = field[baseIndex + (fieldDims * fieldDims) + fieldDims];
                    const f4: number = field[baseIndex + 1];
                    const f5: number = field[baseIndex + (fieldDims * fieldDims) + 1];
                    const f6: number = field[baseIndex + fieldDims + 1];
                    const f7: number = field[baseIndex + (fieldDims * fieldDims) + fieldDims + 1];

                    // corner occupancy mask - skip cells fully inside or outside
                    const mask: number =
                        (f0 >= iso ? 1 : 0) |
                        (f1 >= iso ? 2 : 0) |
                        (f2 >= iso ? 4 : 0) |
                        (f3 >= iso ? 8 : 0) |
                        (f4 >= iso ? 16 : 0) |
                        (f5 >= iso ? 32 : 0) |
                        (f6 >= iso ? 64 : 0) |
                        (f7 >= iso ? 128 : 0);

                    if (mask === 0 || mask === 255) {
                        continue;
                    }

                    // accumulate the iso-level crossing offsets of the 12 cell edges
                    let px = 0.0;
                    let py = 0.0;
                    let pz = 0.0;
                    let crossings = 0;

                    // edges along x - corner pairs (0,1) (2,3) (4,5) (6,7)
                    if ((f0 >= iso) !== (f1 >= iso)) { const t: number = (iso - f0) / (f1 - f0); px += t; crossings++; }
                    if ((f2 >= iso) !== (f3 >= iso)) { const t: number = (iso - f2) / (f3 - f2); px += t; py += 1.0; crossings++; }
                    if ((f4 >= iso) !== (f5 >= iso)) { const t: number = (iso - f4) / (f5 - f4); px += t; pz += 1.0; crossings++; }
                    if ((f6 >= iso) !== (f7 >= iso)) { const t: number = (iso - f6) / (f7 - f6); px += t; py += 1.0; pz += 1.0; crossings++; }

                    // edges along y - corner pairs (0,2) (1,3) (4,6) (5,7)
                    if ((f0 >= iso) !== (f2 >= iso)) { const t: number = (iso - f0) / (f2 - f0); py += t; crossings++; }
                    if ((f1 >= iso) !== (f3 >= iso)) { const t: number = (iso - f1) / (f3 - f1); py += t; px += 1.0; crossings++; }
                    if ((f4 >= iso) !== (f6 >= iso)) { const t: number = (iso - f4) / (f6 - f4); py += t; pz += 1.0; crossings++; }
                    if ((f5 >= iso) !== (f7 >= iso)) { const t: number = (iso - f5) / (f7 - f5); py += t; px += 1.0; pz += 1.0; crossings++; }

                    // edges along z - corner pairs (0,4) (1,5) (2,6) (3,7)
                    if ((f0 >= iso) !== (f4 >= iso)) { const t: number = (iso - f0) / (f4 - f0); pz += t; crossings++; }
                    if ((f1 >= iso) !== (f5 >= iso)) { const t: number = (iso - f1) / (f5 - f1); pz += t; px += 1.0; crossings++; }
                    if ((f2 >= iso) !== (f6 >= iso)) { const t: number = (iso - f2) / (f6 - f2); pz += t; py += 1.0; crossings++; }
                    if ((f3 >= iso) !== (f7 >= iso)) { const t: number = (iso - f3) / (f7 - f3); pz += t; px += 1.0; py += 1.0; crossings++; }

                    const inv: number = 1.0 / crossings;

                    // vertex position in BitVoxel units - samples sit at coordinate + 0.5
                    const vx: number = (cx + (px * inv) + 0.5) * scale;
                    const vy: number = (cy + (py * inv) + 0.5) * scale;
                    const vz: number = (cz + (pz * inv) + 0.5) * scale;

                    // the field gradient at the cell - local to the 8 samples, which
                    // keeps normals consistent on both sides of a chunk seam
                    const gx: number = (f1 + f3 + f5 + f7) - (f0 + f2 + f4 + f6);
                    const gy: number = (f2 + f3 + f6 + f7) - (f0 + f1 + f4 + f5);
                    const gz: number = (f4 + f5 + f6 + f7) - (f0 + f1 + f2 + f3);

                    const gradientLength: number = Math.sqrt((gx * gx) + (gy * gy) + (gz * gz));

                    const writeIndex: number = vertexCount * 3;

                    vertices[writeIndex] = vx;
                    vertices[writeIndex + 1] = vy;
                    vertices[writeIndex + 2] = vz;

                    if (gradientLength > 1e-8) {
                        // the normal points from solid (1) towards empty (0)
                        const gradientInv: number = -1.0 / gradientLength;

                        normals[writeIndex] = gx * gradientInv;
                        normals[writeIndex + 1] = gy * gradientInv;
                        normals[writeIndex + 2] = gz * gradientInv;
                    }
                    else {
                        // degenerate gradient - resolved from triangle normals later
                        normals[writeIndex] = 0.0;
                        normals[writeIndex + 1] = 0.0;
                        normals[writeIndex + 2] = 0.0;

                        this._degenerateNormalCount++;
                    }

                    const cellIndex: number = ((cx + 1) * cellDims + (cy + 1)) * cellDims + (cz + 1);

                    // flag the cell when any of its 8 corners carries own-layer
                    // field. All blur weights and inputs are non-negative, so a
                    // positive sum means at least one positive corner.
                    if (occludersActive) {
                        const ownSum: number =
                            ownField[baseIndex] +
                            ownField[baseIndex + (fieldDims * fieldDims)] +
                            ownField[baseIndex + fieldDims] +
                            ownField[baseIndex + (fieldDims * fieldDims) + fieldDims] +
                            ownField[baseIndex + 1] +
                            ownField[baseIndex + (fieldDims * fieldDims) + 1] +
                            ownField[baseIndex + fieldDims + 1] +
                            ownField[baseIndex + (fieldDims * fieldDims) + fieldDims + 1];

                        cellInfluenced[cellIndex] = ownSum > 0.0 ? 1 : 0;
                    }

                    cellVertex[cellIndex] = vertexCount;
                    vertexCount++;
                }
            }
        }

        this._vertexCount = vertexCount;
    }

    /**
     * Emits quads for every field edge whose two samples straddle the iso-level.
     * Each quad connects the vertices of the 4 surface cells sharing the edge.
     *
     * Seam ownership: edges on the negative chunk boundary are skipped when the
     * negative-side neighbouring chunk exists, as that chunk emits the identical
     * quad itself. This keeps chunk seams free of duplicate geometry.
     *
     * @param margin - The active field margin.
     * @param negativeNeighbours - Existence flags for the -x, -y and -z neighbours.
     * @param flipped - Whether to flip the triangle winding order.
     */
    private _ComputeQuads(margin: number, negativeNeighbours: boolean[], flipped: boolean): void {
        const dims: number = BVXLayer.DIMS;
        const fieldDims: number = VoxelSmoothGeometry._FIELD_DIMS;
        const cellDims: number = VoxelSmoothGeometry._CELL_DIMS;
        const iso: number = VoxelSmoothGeometry._ISO_LEVEL;

        const field: Float32Array = this._field;
        const cellVertex: Int32Array = this._cellVertex;
        const indices: Uint32Array = this._indices;

        // ownership state - only consulted when meshing with occluders
        const occludersActive: boolean = this._occludersActive;
        const mode: SmoothOcclusionMode = this._occlusionMode;
        const rawOwn: Uint8Array = this._rawOwn;
        const rawMerged: Uint8Array = this._rawMerged;
        const ownField: Float32Array = this._ownField;
        const cellInfluenced: Uint8Array = this._cellInfluenced;

        let indexCount: number = this._indexCount;

        const fieldStrides: number[] = [fieldDims * fieldDims, fieldDims, 1];

        for (let axis = 0; axis < 3; axis++) {
            const fieldStride: number = fieldStrides[axis];

            // the other two axes forming the quad ring around the edge
            const axisU: number = axis === 0 ? 1 : 0;
            const axisV: number = axis === 2 ? 1 : 2;

            // cell map strides for the ring axes
            const strideU: number = axisU === 0 ? cellDims * cellDims : (axisU === 1 ? cellDims : 1);
            const strideV: number = axisV === 1 ? cellDims : 1;

            // edges on the negative seam are owned by the negative-side neighbour
            const skipNegativeSeam: boolean = negativeNeighbours[axis];

            const edge: number[] = [0, 0, 0];

            // the edge axis spans -1 to dims - 1, the ring axes span 0 to dims - 1
            for (let d = -1; d < dims; d++) {
                if (d === -1 && skipNegativeSeam) {
                    continue;
                }

                edge[axis] = d;

                for (let u = 0; u < dims; u++) {
                    edge[axisU] = u;

                    for (let v = 0; v < dims; v++) {
                        edge[axisV] = v;

                        const fieldIndex: number = ((edge[0] + margin) * fieldDims + (edge[1] + margin)) * fieldDims + (edge[2] + margin);

                        const a: number = field[fieldIndex];
                        const b: number = field[fieldIndex + fieldStride];

                        const solidA: boolean = a >= iso;
                        const solidB: boolean = b >= iso;

                        // no surface crosses this edge
                        if (solidA === solidB) {
                            continue;
                        }

                        // the 4 surface cells sharing this edge - the cell map is
                        // offset by +1 so cell -1 maps to slot 0
                        const cellBase: number = ((edge[0] + 1) * cellDims + (edge[1] + 1)) * cellDims + (edge[2] + 1);

                        const c00: number = cellBase - strideU - strideV;
                        const c10: number = cellBase - strideV;
                        const c11: number = cellBase;
                        const c01: number = cellBase - strideU;

                        if (occludersActive) {
                            if (mode === "overlay") {
                                // claim the whole influence support of this layer's
                                // field. Quads outside it have all 4 cells free of
                                // own-layer field, where the merged field is
                                // bit-identical to the occluders' field - so this
                                // patch's rim vertices are exactly the occluding
                                // layer's vertices and the two meshes weld.
                                if (cellInfluenced[c00] === 0 && cellInfluenced[c10] === 0 && cellInfluenced[c11] === 0 && cellInfluenced[c01] === 0) {
                                    continue;
                                }
                            }
                            else {
                                // surface pieces are claimed by the layer occupying
                                // the inside sample of the crossing - raw occupancy
                                // is exact and exclusive, so quads partition without
                                // duplicates. Blur-ambiguous cells (inside the
                                // blurred surface but raw-empty) go to the layer the
                                // primary/secondary pairing designates.
                                const insideIndex: number = solidA ? fieldIndex : fieldIndex + fieldStride;

                                if (rawOwn[insideIndex] === 0) {
                                    // raw-occupied by an occluder - its layer owns it
                                    if (rawMerged[insideIndex] !== 0) {
                                        continue;
                                    }

                                    const own: number = ownField[insideIndex];

                                    if (mode === "primary") {
                                        if ((own * 2) < field[insideIndex]) {
                                            continue;
                                        }
                                    }
                                    else if ((own * 2) <= field[insideIndex]) {
                                        continue;
                                    }
                                }
                            }
                        }

                        const v00: number = cellVertex[c00];
                        const v10: number = cellVertex[c10];
                        const v11: number = cellVertex[c11];
                        const v01: number = cellVertex[c01];

                        // quad winding - faces the empty sample. The y axis ring has
                        // opposite parity to the x and z rings.
                        let facePositive: boolean = solidA;

                        if (axis === 1) {
                            facePositive = !facePositive;
                        }

                        if (flipped) {
                            facePositive = !facePositive;
                        }

                        if (facePositive) {
                            indices[indexCount] = v00;
                            indices[indexCount + 1] = v10;
                            indices[indexCount + 2] = v11;
                            indices[indexCount + 3] = v00;
                            indices[indexCount + 4] = v11;
                            indices[indexCount + 5] = v01;
                        }
                        else {
                            indices[indexCount] = v00;
                            indices[indexCount + 1] = v01;
                            indices[indexCount + 2] = v11;
                            indices[indexCount + 3] = v00;
                            indices[indexCount + 4] = v11;
                            indices[indexCount + 5] = v10;
                        }

                        indexCount += 6;
                    }
                }
            }
        }

        this._indexCount = indexCount;
    }

    /**
     * Drops vertices not referenced by any emitted triangle, compacting the vertex
     * and normal buffers in place and remapping the triangle indices. When meshing
     * with occluders, the merged field contours surface cells for the occluders'
     * pieces too - their unclaimed vertices are removed here.
     */
    private _CompactVertices(): void {
        const vertexCount: number = this._vertexCount;
        const indexCount: number = this._indexCount;
        const vertices: Float32Array = this._vertices;
        const normals: Float32Array = this._normals;
        const indices: Uint32Array = this._indices;

        // reuse the cell-to-vertex map as the remap scratch - its contents are
        // only needed during quad emission, which has already completed
        const remap: Int32Array = this._cellVertex;

        remap.fill(0, 0, vertexCount);

        for (let i = 0; i < indexCount; i++) {
            remap[indices[i]] = 1;
        }

        // assign new indices in ascending vertex order so the in-place copy
        // never overwrites a vertex that is still pending
        let newCount = 0;

        for (let v = 0; v < vertexCount; v++) {
            if (remap[v] === 0) {
                remap[v] = -1;

                continue;
            }

            if (newCount !== v) {
                const read: number = v * 3;
                const write: number = newCount * 3;

                vertices[write] = vertices[read];
                vertices[write + 1] = vertices[read + 1];
                vertices[write + 2] = vertices[read + 2];

                normals[write] = normals[read];
                normals[write + 1] = normals[read + 1];
                normals[write + 2] = normals[read + 2];
            }

            remap[v] = newCount;
            newCount++;
        }

        for (let i = 0; i < indexCount; i++) {
            indices[i] = remap[indices[i]];
        }

        this._vertexCount = newCount;
    }

    /**
     * Resolves normals for vertices whose field gradient was degenerate (zero) by
     * accumulating the geometric normals of their connected triangles.
     */
    private _ComputeFallbackNormals(): void {
        const vertices: Float32Array = this._vertices;
        const normals: Float32Array = this._normals;
        const indices: Uint32Array = this._indices;
        const indexCount: number = this._indexCount;

        for (let i = 0; i < indexCount; i += 3) {
            const ia: number = indices[i] * 3;
            const ib: number = indices[i + 1] * 3;
            const ic: number = indices[i + 2] * 3;

            // skip triangles that touch no degenerate vertices
            const aDegenerate: boolean = normals[ia] === 0.0 && normals[ia + 1] === 0.0 && normals[ia + 2] === 0.0;
            const bDegenerate: boolean = normals[ib] === 0.0 && normals[ib + 1] === 0.0 && normals[ib + 2] === 0.0;
            const cDegenerate: boolean = normals[ic] === 0.0 && normals[ic + 1] === 0.0 && normals[ic + 2] === 0.0;

            if (!aDegenerate && !bDegenerate && !cDegenerate) {
                continue;
            }

            // geometric normal of the triangle
            const abx: number = vertices[ib] - vertices[ia];
            const aby: number = vertices[ib + 1] - vertices[ia + 1];
            const abz: number = vertices[ib + 2] - vertices[ia + 2];

            const acx: number = vertices[ic] - vertices[ia];
            const acy: number = vertices[ic + 1] - vertices[ia + 1];
            const acz: number = vertices[ic + 2] - vertices[ia + 2];

            const nx: number = (aby * acz) - (abz * acy);
            const ny: number = (abz * acx) - (abx * acz);
            const nz: number = (abx * acy) - (aby * acx);

            const length: number = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz));

            if (length <= 1e-12) {
                continue;
            }

            const inv: number = 1.0 / length;

            // accumulate scaled normals into the degenerate vertices only - the
            // final normalisation happens below
            if (aDegenerate) { normals[ia] += nx * inv; normals[ia + 1] += ny * inv; normals[ia + 2] += nz * inv; }
            if (bDegenerate) { normals[ib] += nx * inv; normals[ib + 1] += ny * inv; normals[ib + 2] += nz * inv; }
            if (cDegenerate) { normals[ic] += nx * inv; normals[ic + 1] += ny * inv; normals[ic + 2] += nz * inv; }
        }

        // normalise the accumulated normals
        const vertexCount: number = this._vertexCount;

        for (let i = 0; i < vertexCount; i++) {
            const index: number = i * 3;

            const nx: number = normals[index];
            const ny: number = normals[index + 1];
            const nz: number = normals[index + 2];

            const length: number = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz));

            if (length > 1e-12 && Math.abs(length - 1.0) > 1e-6) {
                const inv: number = 1.0 / length;

                normals[index] = nx * inv;
                normals[index + 1] = ny * inv;
                normals[index + 2] = nz * inv;
            }
            else if (length <= 1e-12) {
                // isolated degenerate vertex - default to an up-facing normal
                normals[index] = 0.0;
                normals[index + 1] = 1.0;
                normals[index + 2] = 0.0;
            }
        }
    }
}
