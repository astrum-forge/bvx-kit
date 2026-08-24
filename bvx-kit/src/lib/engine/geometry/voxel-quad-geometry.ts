import { MortonKey } from "../../math/morton-key.js";
import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { VoxelWorld } from "../voxel-world.js";
import { VoxelFaceGeometry } from "./voxel-face-geometry.js";

/**
 * How per-corner ambient occlusion is derived for each emitted quad.
 *
 * - "corner": the standard three-sample test per corner - the two edge neighbours
 *   and the diagonal, in the layer the face looks into. Twelve samples per quad.
 * - "face": four samples around the face, giving one level shared by all four
 *   corners. A quarter of the cost, for surfaces that only need a coarse "how
 *   enclosed is this face" measure rather than per-corner shading.
 * - "none": every corner reports fully open. No occupancy field is built at all.
 */
export type QuadOcclusion = "corner" | "face" | "none";

/**
 * Which occupancy the ambient occlusion samples.
 *
 * - "merged": the union of the meshed world and the occluder world. Correct when
 *   the lane's own cells should shade each other, which is the usual case.
 * - "occluders": the occluder world alone. Correct for a layer that must not
 *   occlude itself - a water surface takes its shoreline measure from the solids
 *   around it, and counting neighbouring water as solid would flood the measure.
 */
export type QuadOcclusionSource = "merged" | "occluders";

/**
 * VoxelQuadGeometry turns a chunk's visible BitVoxel faces into a compact list of
 * packed quads, one 32-bit word each, with ambient occlusion baked in.
 *
 * It exists because the 6-bit face masks VoxelFaceGeometry produces are only half
 * of what a renderer needs. Expanding them into positions, normals and per-corner
 * occlusion is the expensive half, and doing it in the consumer means doing it
 * wherever the consumer happens to run - which, for the reference editor, was the
 * main thread. A quad list is small enough to hand across a worker boundary
 * (4 bytes per visible face against roughly 200 for an expanded vertex quad), so
 * the whole job can be done off-thread and the result transferred.
 *
 * The encoding carries no colour, material or vertex positions. Positions are
 * implied by the BitVoxel index and the face direction; material lives in the
 * chunk's meta-data, which a consumer holding the chunk reads with
 * `chunk.getMetaData()` at `index >> 6`. Keeping those out is what lets one word
 * describe a quad regardless of how wide the chunk's meta-data is.
 *
 * ## Packed quad layout
 *
 * ```
 * bits  0-11  BitVoxel index (0-4095), the VoxelIndex key layout
 * bits 12-14  face direction, matching VoxelFaceGeometry.X_POS_INDEX .. Z_NEG_INDEX
 * bits 15-16  corner 0 openness (0 = fully occluded, 3 = fully open)
 * bits 17-18  corner 1 openness
 * bits 19-20  corner 2 openness
 * bits 21-22  corner 3 openness
 * bit  23     diagonal flip - split the quad 1-2-3 / 1-3-0 rather than 0-1-2 / 0-2-3
 * bits 24-31  reserved, always zero
 * ```
 *
 * Corners are ordered by CORNERS[face], counter-clockwise seen from outside.
 */
export class VoxelQuadGeometry {
    /**
     * Bit positions of each field in a packed quad word.
     */
    public static readonly INDEX_SHIFT: number = 0;
    public static readonly FACE_SHIFT: number = 12;
    public static readonly OCCLUSION_SHIFT: number = 15;
    public static readonly FLIP_SHIFT: number = 23;

    /**
     * Masks for each field in a packed quad word.
     */
    public static readonly INDEX_MASK: number = 0xFFF;
    public static readonly FACE_MASK: number = 0x7;
    public static readonly OCCLUSION_MASK: number = 0x3;

    /**
     * The largest number of visible faces a chunk can produce. A checkerboard of
     * set BitVoxels exposes all six faces of half of them.
     */
    public static readonly MAX_QUADS: number = (BVXLayer.SIZE / 2) * 6;

    /**
     * The four corners of each face in BitVoxel-local units, counter-clockwise
     * seen from outside the voxel, indexed by the face bit index.
     */
    public static readonly CORNERS: readonly (readonly (readonly number[])[])[] = [
        [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]], // +x
        [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]], // -x
        [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], // +y
        [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]], // -y
        [[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]], // +z
        [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]  // -z
    ];

    /**
     * The outward normal of each face, indexed by the face bit index.
     */
    public static readonly NORMALS: readonly (readonly number[])[] = [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ];

    /**
     * The two axes each face spans, indexed by the face bit index. The occlusion
     * sampling steps along these.
     */
    public static readonly TANGENTS: readonly (readonly number[])[] = [
        [1, 2], [1, 2], [0, 2], [0, 2], [0, 1], [0, 1]
    ];

    /**
     * The occupancy field is one chunk plus a one-cell border, which is exactly
     * the reach of the corner test - a corner samples one cell out along each
     * tangent from the cell the face looks into.
     */
    private static readonly FIELD_BORDER: number = 1;
    private static readonly FIELD_DIMS: number = BVXLayer.DIMS + (VoxelQuadGeometry.FIELD_BORDER * 2);
    private static readonly FIELD_STRIDE_Y: number = VoxelQuadGeometry.FIELD_DIMS;
    private static readonly FIELD_STRIDE_Z: number = VoxelQuadGeometry.FIELD_DIMS * VoxelQuadGeometry.FIELD_DIMS;

    /**
     * Scratch MortonKey for the neighbourhood gather.
     */
    private static readonly TMP_KEY: MortonKey = new MortonKey();

    /**
     * The face visibility pass. Owned rather than passed in so the fast paths and
     * scratch buffers it holds are reused across calls.
     */
    private readonly _faces: VoxelFaceGeometry;

    /**
     * Packed quad words, valid up to _count.
     */
    private readonly _quads: Uint32Array;

    /**
     * The number of valid entries in _quads.
     */
    private _count: number;

    /**
     * Occupancy of the chunk plus a one-cell border, one byte per cell.
     */
    private readonly _field: Uint8Array;

    /**
     * The 3x3x3 neighbourhood of BitVoxel storages the field build reads. Held
     * across calls so the hot path allocates nothing.
     */
    private readonly _worldElements: (Uint32Array | null)[];
    private readonly _occluderElements: (Uint32Array | null)[];

    constructor() {
        this._faces = new VoxelFaceGeometry();
        this._quads = new Uint32Array(VoxelQuadGeometry.MAX_QUADS);
        this._count = 0;
        this._field = new Uint8Array(VoxelQuadGeometry.FIELD_DIMS * VoxelQuadGeometry.FIELD_DIMS * VoxelQuadGeometry.FIELD_DIMS);
        this._worldElements = new Array<Uint32Array | null>(27).fill(null);
        this._occluderElements = new Array<Uint32Array | null>(27).fill(null);
    }

    /**
     * Returns the packed quads produced by the last computeQuads() call, in
     * ascending BitVoxel index and then ascending face order.
     *
     * The returned view is only valid until the next computeQuads() call.
     */
    public get quads(): Uint32Array {
        return this._quads.subarray(0, this._count);
    }

    /**
     * Returns the number of quads produced by the last computeQuads() call. This
     * is also the number of visible faces.
     */
    public get count(): number {
        return this._count;
    }

    /**
     * Returns the face visibility pass, for a caller that also wants the raw
     * 6-bit masks. Valid until the next computeQuads() call.
     */
    public get faces(): VoxelFaceGeometry {
        return this._faces;
    }

    /**
     * Extracts the BitVoxel index from a packed quad word.
     */
    public static indexOf(quad: number): number {
        return quad & VoxelQuadGeometry.INDEX_MASK;
    }

    /**
     * Extracts the face direction from a packed quad word.
     */
    public static faceOf(quad: number): number {
        return (quad >>> VoxelQuadGeometry.FACE_SHIFT) & VoxelQuadGeometry.FACE_MASK;
    }

    /**
     * Extracts one corner's occlusion level (0-3) from a packed quad word.
     *
     * @param quad - The packed quad word.
     * @param corner - The corner index, 0-3, ordered by CORNERS[face].
     */
    public static occlusionOf(quad: number, corner: number): number {
        return (quad >>> (VoxelQuadGeometry.OCCLUSION_SHIFT + (corner << 1))) & VoxelQuadGeometry.OCCLUSION_MASK;
    }

    /**
     * Returns whether the quad should be split along its 1-3 diagonal rather than
     * its 0-2 diagonal.
     *
     * Splitting along the diagonal that matches the occlusion gradient is what
     * avoids the classic ambient-occlusion interpolation artefact, where a quad
     * with one dark corner reads as a triangle rather than a smooth falloff.
     */
    public static flippedOf(quad: number): boolean {
        return ((quad >>> VoxelQuadGeometry.FLIP_SHIFT) & 1) !== 0;
    }

    /**
     * Computes the packed quad list for the provided chunk.
     *
     * Face visibility comes from VoxelFaceGeometry and follows exactly the same
     * rules, including the occluder culling: a face is emitted only when the
     * neighbouring cell is empty in both the meshed world and the occluder world.
     *
     * @param center - The VoxelChunk to generate quads for.
     * @param world - The VoxelWorld used to query neighbouring chunks.
     * @param occluders - (Optional) A VoxelWorld whose occupancy additionally
     * culls faces and, depending on source, contributes to the occlusion field.
     * @param occlusion - (Optional) How per-corner occlusion is derived. Defaults
     * to "corner".
     * @param source - (Optional) Which occupancy the occlusion samples. Defaults
     * to "merged".
     */
    public computeQuads(
        center: VoxelChunk,
        world: VoxelWorld,
        occluders: VoxelWorld | null = null,
        occlusion: QuadOcclusion = "corner",
        source: QuadOcclusionSource = "merged"
    ): void {
        this._count = 0;

        const faces: VoxelFaceGeometry = this._faces;

        faces.computeIndices(center, world, occluders);

        const touched: Uint16Array = faces.touched;

        if (touched.length === 0) {
            return;
        }

        if (occlusion !== "none") {
            this._buildField(center.key, world, occluders, source, touched);
        }

        const masks: Uint8Array = faces.indices;
        const quads: Uint32Array = this._quads;
        const corners: readonly (readonly (readonly number[])[])[] = VoxelQuadGeometry.CORNERS;
        const normals: readonly (readonly number[])[] = VoxelQuadGeometry.NORMALS;
        const tangents: readonly (readonly number[])[] = VoxelQuadGeometry.TANGENTS;

        let count = 0;

        for (let t = 0; t < touched.length; t++) {
            const index: number = touched[t];
            const mask: number = masks[index];

            // decode the BitVoxel local coordinates from the VoxelIndex key layout
            const x: number = (((index >> 10) & 3) << 2) | ((index >> 4) & 3);
            const y: number = (((index >> 8) & 3) << 2) | ((index >> 2) & 3);
            const z: number = (((index >> 6) & 3) << 2) | (index & 3);

            for (let face = 0; face < 6; face++) {
                if (((mask >> face) & 1) === 0) {
                    continue;
                }

                let ao0 = 3;
                let ao1 = 3;
                let ao2 = 3;
                let ao3 = 3;

                if (occlusion !== "none") {
                    const normal: readonly number[] = normals[face];
                    const nx: number = x + normal[0];
                    const ny: number = y + normal[1];
                    const nz: number = z + normal[2];
                    const axes: readonly number[] = tangents[face];

                    if (occlusion === "face") {
                        ao0 = ao1 = ao2 = ao3 = this._faceLevel(nx, ny, nz, axes[0], axes[1]);
                    }
                    else {
                        const faceCorners: readonly (readonly number[])[] = corners[face];

                        ao0 = this._cornerLevel(nx, ny, nz, axes[0], axes[1], faceCorners[0]);
                        ao1 = this._cornerLevel(nx, ny, nz, axes[0], axes[1], faceCorners[1]);
                        ao2 = this._cornerLevel(nx, ny, nz, axes[0], axes[1], faceCorners[2]);
                        ao3 = this._cornerLevel(nx, ny, nz, axes[0], axes[1], faceCorners[3]);
                    }
                }

                const flip: number = (ao0 + ao2) < (ao1 + ao3) ? 1 : 0;

                quads[count] = index
                    | (face << VoxelQuadGeometry.FACE_SHIFT)
                    | (ao0 << VoxelQuadGeometry.OCCLUSION_SHIFT)
                    | (ao1 << (VoxelQuadGeometry.OCCLUSION_SHIFT + 2))
                    | (ao2 << (VoxelQuadGeometry.OCCLUSION_SHIFT + 4))
                    | (ao3 << (VoxelQuadGeometry.OCCLUSION_SHIFT + 6))
                    | (flip << VoxelQuadGeometry.FLIP_SHIFT);

                count++;
            }
        }

        this._count = count;
    }

    /**
     * Returns the per-corner occlusion level for one corner of a face.
     *
     * The two edge neighbours and the diagonal are sampled in the layer the face
     * looks into. Two set edge neighbours enclose the corner completely whatever
     * the diagonal holds, which is the special case that keeps an inside corner
     * from reading lighter than the wall beside it.
     */
    private _cornerLevel(nx: number, ny: number, nz: number, a1: number, a2: number, corner: readonly number[]): number {
        const d1: number = corner[a1] === 1 ? 1 : -1;
        const d2: number = corner[a2] === 1 ? 1 : -1;

        const s1x: number = nx + (a1 === 0 ? d1 : 0);
        const s1y: number = ny + (a1 === 1 ? d1 : 0);
        const s1z: number = nz + (a1 === 2 ? d1 : 0);
        const s2x: number = nx + (a2 === 0 ? d2 : 0);
        const s2y: number = ny + (a2 === 1 ? d2 : 0);
        const s2z: number = nz + (a2 === 2 ? d2 : 0);

        const side1: number = this._sample(s1x, s1y, s1z);
        const side2: number = this._sample(s2x, s2y, s2z);
        const diagonal: number = this._sample(s1x + s2x - nx, s1y + s2y - ny, s1z + s2z - nz);

        return (side1 !== 0 && side2 !== 0) ? 0 : 3 - (side1 + side2 + diagonal);
    }

    /**
     * Returns one occlusion level shared by all four corners of a face, from the
     * four cells edge-adjacent to the cell the face looks into.
     */
    private _faceLevel(nx: number, ny: number, nz: number, a1: number, a2: number): number {
        let solid = 0;

        for (let side = 0; side < 4; side++) {
            const axis: number = side < 2 ? a1 : a2;
            const step: number = (side & 1) === 0 ? 1 : -1;

            solid += this._sample(
                nx + (axis === 0 ? step : 0),
                ny + (axis === 1 ? step : 0),
                nz + (axis === 2 ? step : 0)
            );
        }

        return 3 - Math.min(3, solid);
    }

    /**
     * Reads the occupancy field at chunk-local BitVoxel coordinates, which may run
     * one cell outside the chunk in any direction.
     */
    private _sample(x: number, y: number, z: number): number {
        const border: number = VoxelQuadGeometry.FIELD_BORDER;

        return this._field[(x + border) + ((y + border) * VoxelQuadGeometry.FIELD_STRIDE_Y) + ((z + border) * VoxelQuadGeometry.FIELD_STRIDE_Z)];
    }

    /**
     * Fills the occupancy field for the chunk at the provided key - its cells plus
     * a one-cell border, as the union of the meshed world and the occluder world,
     * or the occluder world alone.
     */
    private _buildField(key: MortonKey, world: VoxelWorld, occluders: VoxelWorld | null, source: QuadOcclusionSource, touched: Uint16Array): void {
        const field: Uint8Array = this._field;

        // Cleared in full rather than only the sub-box the border writes. One
        // fill(0) over the whole buffer is a single vectorised memset; clearing a
        // narrower box means many short fills and measures far worse.
        field.fill(0);

        // The AO taps only ever sample within 2 cells of a face-bearing BitVoxel -
        // one step to the face-adjacent cell, one more for the corner offsets - so
        // only the touched list's bounding box needs populating. The full walk is a
        // fixed 5,832 cells however little geometry exists, which for the sparse
        // chunks physics churn remeshes is nearly all of its cost.
        let minX = 15, minY = 15, minZ = 15;
        let maxX = 0, maxY = 0, maxZ = 0;

        for (let t = 0; t < touched.length; t++) {
            const index: number = touched[t];

            const tx: number = (((index >> 10) & 3) << 2) | ((index >> 4) & 3);
            const ty: number = (((index >> 8) & 3) << 2) | ((index >> 2) & 3);
            const tz: number = (((index >> 6) & 3) << 2) | (index & 3);

            minX = tx < minX ? tx : minX;
            minY = ty < minY ? ty : minY;
            minZ = tz < minZ ? tz : minZ;
            maxX = tx > maxX ? tx : maxX;
            maxY = ty > maxY ? ty : maxY;
            maxZ = tz > maxZ ? tz : maxZ;
        }

        const worldElements: (Uint32Array | null)[] = this._worldElements;
        const occluderElements: (Uint32Array | null)[] = this._occluderElements;
        const scratch: MortonKey = VoxelQuadGeometry.TMP_KEY;

        // A layer that must not occlude itself takes the field from the occluders
        // alone - the own world is gathered as empty rather than skipped, so the
        // sampling loop below stays branch-identical either way.
        const includeOwn: boolean = source === "merged";

        let neighbour = 0;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    MortonKey.from(key.x + ox, key.y + oy, key.z + oz, scratch);

                    const ownChunk: VoxelChunk | null = includeOwn ? world.get(scratch) : null;
                    const occluderChunk: VoxelChunk | null = occluders !== null ? occluders.get(scratch) : null;

                    worldElements[neighbour] = ownChunk !== null ? ownChunk.layer.bitArray.elements : null;
                    occluderElements[neighbour] = occluderChunk !== null ? occluderChunk.layer.bitArray.elements : null;
                    neighbour++;
                }
            }
        }

        const border: number = VoxelQuadGeometry.FIELD_BORDER;
        const low: number = Math.max(-border, minX - 2);
        const high: number = Math.min((BVXLayer.DIMS - 1) + border, maxX + 2);
        const lowY: number = Math.max(-border, minY - 2);
        const highY: number = Math.min((BVXLayer.DIMS - 1) + border, maxY + 2);
        const lowZ: number = Math.max(-border, minZ - 2);
        const highZ: number = Math.min((BVXLayer.DIMS - 1) + border, maxZ + 2);

        // the border stays under a chunk wide, so (coord >> 4) + 1 still lands on
        // the right slot of the 3x3x3 neighbourhood for every cell sampled
        for (let x = low; x <= high; x++) {
            const sx: number = (x >> 4) + 1;
            const lx: number = x & 15;

            for (let y = lowY; y <= highY; y++) {
                const sy: number = (y >> 4) + 1;
                const ly: number = y & 15;

                for (let z = lowZ; z <= highZ; z++) {
                    const slot: number = (sx * 9) + (sy * 3) + ((z >> 4) + 1);
                    const lz: number = z & 15;

                    const index: number = ((lx >> 2) << 10) | ((ly >> 2) << 8) | ((lz >> 2) << 6) | ((lx & 3) << 4) | ((ly & 3) << 2) | (lz & 3);
                    const word: number = index >> 5;
                    const mask: number = 1 << (index & 31);

                    const own: Uint32Array | null = worldElements[slot];
                    const occluder: Uint32Array | null = occluderElements[slot];

                    if ((own !== null && (own[word] & mask) !== 0) || (occluder !== null && (occluder[word] & mask) !== 0)) {
                        field[(x + border) + ((y + border) * VoxelQuadGeometry.FIELD_STRIDE_Y) + ((z + border) * VoxelQuadGeometry.FIELD_STRIDE_Z)] = 1;
                    }
                }
            }
        }
    }
}
