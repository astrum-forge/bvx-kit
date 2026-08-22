import { MortonKey } from "../../math/morton-key.js";
import { VoxelChunk0 } from "../chunks/voxel-chunk-0.js";
import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelWorld } from "../voxel-world.js";
import { VoxelGeometry } from "./voxel-geometry.js";

/**
 * VoxelFaceGeometry is responsible for generating the geometry index for each BitVoxel
 * within a VoxelChunk. This geometry index determines which faces of the voxel should be
 * rendered based on occlusion by neighboring voxels. Only visible or outer faces are rendered,
 * optimizing the rendering process.
 *
 * The computed geometry index is inserted into a pre-defined LUT (Lookup Table) used by
 * the renderer to generate the actual geometry. This ensures that hidden or fully occluded
 * voxels are not rendered, improving performance.
 */
export class VoxelFaceGeometry extends VoxelGeometry {
    // Constants for the bit positions corresponding to the six possible voxel faces.
    public static readonly X_POS_INDEX: number = 0;
    public static readonly X_NEG_INDEX: number = 1;
    public static readonly Y_POS_INDEX: number = 2;
    public static readonly Y_NEG_INDEX: number = 3;
    public static readonly Z_POS_INDEX: number = 4;
    public static readonly Z_NEG_INDEX: number = 5;

    /**
     * Precomputed neighbour lookup tables, one per face direction (+x, -x, +y, -y, +z, -z).
     *
     * For every one of the 4096 BitVoxel indices, the table stores the index of the
     * neighbouring BitVoxel in that direction. Neighbours within the same chunk are
     * stored as-is (value >= 0). Neighbours that cross into an adjacent chunk are
     * stored as -(wrappedIndex + 1), where wrappedIndex is the BitVoxel index inside
     * the adjacent chunk.
     *
     * These tables replace repeated VoxelIndex encode/decode operations in the hot
     * geometry loop with a single array read.
     */
    private static readonly _NEIGHBOUR_TABLES: Int16Array[] = VoxelFaceGeometry._BuildNeighbourTables();

    /**
     * Temporary MortonKey used to represent voxel chunk positions for neighboring chunk queries.
     */
    private static readonly TMP_MK: MortonKey = new MortonKey();

    /**
     * Placeholder VoxelChunk used when neighboring chunks are not available, ensuring that
     * rendering continues without errors.
     */
    private static readonly TMP_CHUNK: VoxelChunk = new VoxelChunk0(VoxelFaceGeometry.TMP_MK);

    /**
     * Scratch buffers used to merge the own and occluder BitVoxel storages for the
     * center chunk and its 6 face neighbours when meshing with an occluder world.
     */
    private static readonly _MERGE_SCRATCH: Uint32Array[] = [
        new Uint32Array(BVXLayer.SIZE / 32),
        new Uint32Array(BVXLayer.SIZE / 32),
        new Uint32Array(BVXLayer.SIZE / 32),
        new Uint32Array(BVXLayer.SIZE / 32),
        new Uint32Array(BVXLayer.SIZE / 32),
        new Uint32Array(BVXLayer.SIZE / 32),
        new Uint32Array(BVXLayer.SIZE / 32)
    ];

    /**
     * Builds the 6 static neighbour lookup tables used by computeIndices(). This runs
     * once at class initialization time.
     *
     * Each BitVoxel index encodes coordinates as (vx << 10 | vy << 8 | vz << 6 | bx << 4 | by << 2 | bz),
     * which maps to an absolute BitVoxel coordinate of (vx * 4 + bx, vy * 4 + by, vz * 4 + bz)
     * in the 16x16x16 chunk space.
     *
     * @returns - An array of 6 Int16Array tables ordered as +x, -x, +y, -y, +z, -z.
     */
    private static _BuildNeighbourTables(): Int16Array[] {
        const directions: number[][] = [
            [1, 0, 0],  // +x
            [-1, 0, 0], // -x
            [0, 1, 0],  // +y
            [0, -1, 0], // -y
            [0, 0, 1],  // +z
            [0, 0, -1]  // -z
        ];

        const size: number = BVXLayer.SIZE;
        const dims: number = BVXLayer.DIMS;
        const tables: Int16Array[] = new Array<Int16Array>(directions.length);

        for (let d = 0; d < directions.length; d++) {
            const table: Int16Array = new Int16Array(size);

            const dx: number = directions[d][0];
            const dy: number = directions[d][1];
            const dz: number = directions[d][2];

            for (let index = 0; index < size; index++) {
                // decode the BitVoxel index into absolute chunk-space coordinates
                const x: number = (((index >> 10) & 3) << 2) | ((index >> 4) & 3);
                const y: number = (((index >> 8) & 3) << 2) | ((index >> 2) & 3);
                const z: number = (((index >> 6) & 3) << 2) | (index & 3);

                // absolute coordinates of the neighbour, wrapped into chunk-space
                const nx: number = (x + dx) & (dims - 1);
                const ny: number = (y + dy) & (dims - 1);
                const nz: number = (z + dz) & (dims - 1);

                // re-encode the neighbour coordinates into a BitVoxel index
                const neighbourIndex: number = ((nx >> 2) << 10) | ((ny >> 2) << 8) | ((nz >> 2) << 6) | ((nx & 3) << 4) | ((ny & 3) << 2) | (nz & 3);

                // neighbours outside the 0-15 chunk-space belong to the adjacent
                // chunk and are flagged with a negative marker
                const crossesChunk: boolean = (x + dx) < 0 || (x + dx) >= dims || (y + dy) < 0 || (y + dy) >= dims || (z + dz) < 0 || (z + dz) >= dims;

                table[index] = crossesChunk ? -(neighbourIndex + 1) : neighbourIndex;
            }

            tables[d] = table;
        }

        return tables;
    }

    /**
     * Samples the state of the neighbouring BitVoxel for the provided index using a
     * precomputed neighbour table. Reads from the center chunk storage for same-chunk
     * neighbours or from the adjacent chunk storage for cross-chunk neighbours.
     *
     * @param table - The neighbour lookup table for the face direction being sampled.
     * @param index - The BitVoxel index being processed.
     * @param center - The Uint32Array BitVoxel storage of the center chunk.
     * @param next - The Uint32Array BitVoxel storage of the adjacent chunk in the table's direction.
     * @returns - 1 if the neighbouring BitVoxel is ON, 0 if it is OFF.
     */
    private static _SampleState(table: Int16Array, index: number, center: Uint32Array, next: Uint32Array): number {
        const neighbourIndex: number = table[index];

        if (neighbourIndex >= 0) {
            return (center[neighbourIndex >> 5] >>> (neighbourIndex & 31)) & 1;
        }

        const wrappedIndex: number = -neighbourIndex - 1;

        return (next[wrappedIndex >> 5] >>> (wrappedIndex & 31)) & 1;
    }

    /**
     * Returns the BitVoxel storage to sample for one chunk position - the own chunk's
     * storage merged (bitwise OR) with the occluding chunk's storage. When either side
     * is missing, the other side's storage is returned directly without a merge copy.
     *
     * @param own - The own-world chunk at the position (the empty placeholder when missing).
     * @param occluder - The occluder-world chunk at the position, or null when missing.
     * @param scratch - The scratch buffer receiving the merged storage words.
     * @returns - The Uint32Array BitVoxel storage to sample for occlusion.
     */
    private static _MergedElements(own: VoxelChunk, occluder: VoxelChunk | null, scratch: Uint32Array): Uint32Array {
        const ownElements: Uint32Array = own.layer.bitArray.elements;

        if (occluder === null) {
            return ownElements;
        }

        const occluderElements: Uint32Array = occluder.layer.bitArray.elements;

        // the own chunk is the empty placeholder - the occluder stands alone
        if (own === VoxelFaceGeometry.TMP_CHUNK) {
            return occluderElements;
        }

        const length: number = ownElements.length;

        for (let i = 0; i < length; i++) {
            scratch[i] = ownElements[i] | occluderElements[i];
        }

        return scratch;
    }

    /**
     * Computes the geometry indices for all BitVoxels in the given VoxelChunk. The geometry is
     * determined based on the visibility of each voxel's faces, considering the presence of
     * neighboring voxels.
     *
     * Invisible or fully occluded voxels will not be rendered. The geometry index is computed
     * based on face visibility using neighboring chunks when necessary.
     *
     * When an occluder world is provided, its occupancy also culls faces - a face is rendered
     * only when the neighbouring cell is empty in BOTH worlds. Occluder cells never emit
     * geometry of their own. This renders multiple co-located layers (e.g. terrain plus a
     * physics sand layer) without duplicated faces at their interfaces. Occlusion is
     * deliberately one-directional: a transparent layer (water) lists the opaque layers as
     * occluders so its hidden contact faces are culled, while the opaque layers omit the
     * transparent layer so their surfaces stay visible through it.
     *
     * @param center - The VoxelChunk for which geometry is being generated.
     * @param world - The VoxelWorld instance used to query neighboring chunks for boundary checks.
     * @param occluders - (Optional) A VoxelWorld whose occupancy additionally culls faces.
     */
    public computeIndices(center: VoxelChunk, world: VoxelWorld, occluders: VoxelWorld | null = null): void {
        // Reset the internal buffer before computing new geometry.
        this.reset();

        // Local references for reusing objects to reduce allocations.
        const dfChunk: VoxelChunk = VoxelFaceGeometry.TMP_CHUNK;
        const dfKey: MortonKey = VoxelFaceGeometry.TMP_MK;
        const centerKey: MortonKey = center.key;

        // Get neighboring chunks (own and occluder world) - dfKey holds the queried
        // position for both lookups of each direction.
        const xp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incX(), dfChunk);
        const oxp: VoxelChunk | null = occluders !== null ? occluders.get(dfKey) : null;
        const xn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decX(), dfChunk);
        const oxn: VoxelChunk | null = occluders !== null ? occluders.get(dfKey) : null;
        const yp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incY(), dfChunk);
        const oyp: VoxelChunk | null = occluders !== null ? occluders.get(dfKey) : null;
        const yn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decY(), dfChunk);
        const oyn: VoxelChunk | null = occluders !== null ? occluders.get(dfKey) : null;
        const zp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incZ(), dfChunk);
        const ozp: VoxelChunk | null = occluders !== null ? occluders.get(dfKey) : null;
        const zn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decZ(), dfChunk);
        const ozn: VoxelChunk | null = occluders !== null ? occluders.get(dfKey) : null;
        const oc: VoxelChunk | null = occluders !== null ? occluders.get(centerKey.copy(dfKey)) : null;

        // BitVoxel storage of the center chunk - visibility (which BitVoxels emit
        // faces) always comes from the own world only.
        const centerOwnElements: Uint32Array = center.layer.bitArray.elements;

        // Occlusion sampling storage for the center chunk and its neighbours - the
        // own storage merged with the occluder storage where both are present.
        const scratch: Uint32Array[] = VoxelFaceGeometry._MERGE_SCRATCH;
        const centerElements: Uint32Array = VoxelFaceGeometry._MergedElements(center, oc, scratch[0]);
        const xpElements: Uint32Array = VoxelFaceGeometry._MergedElements(xp, oxp, scratch[1]);
        const xnElements: Uint32Array = VoxelFaceGeometry._MergedElements(xn, oxn, scratch[2]);
        const ypElements: Uint32Array = VoxelFaceGeometry._MergedElements(yp, oyp, scratch[3]);
        const ynElements: Uint32Array = VoxelFaceGeometry._MergedElements(yn, oyn, scratch[4]);
        const zpElements: Uint32Array = VoxelFaceGeometry._MergedElements(zp, ozp, scratch[5]);
        const znElements: Uint32Array = VoxelFaceGeometry._MergedElements(zn, ozn, scratch[6]);

        // Precomputed neighbour lookup tables for each face direction.
        const tables: Int16Array[] = VoxelFaceGeometry._NEIGHBOUR_TABLES;
        const tableXP: Int16Array = tables[0];
        const tableXN: Int16Array = tables[1];
        const tableYP: Int16Array = tables[2];
        const tableYN: Int16Array = tables[3];
        const tableZP: Int16Array = tables[4];
        const tableZN: Int16Array = tables[5];

        // The array that holds the computed geometry indices for the chunk.
        const indices: Uint8Array = this.indices;

        // Iterate the own BitVoxel storage word-by-word, skipping empty 32 BitVoxel
        // blocks entirely. This is considerably faster than testing all 4096
        // BitVoxels individually for sparse chunks. Occlusion sampling below reads
        // the merged storages instead, so occluder cells cull faces without ever
        // emitting geometry themselves.
        const wordCount: number = centerOwnElements.length;

        for (let w = 0; w < wordCount; w++) {
            let word: number = centerOwnElements[w];

            // Skip if none of the 32 BitVoxels in this word are set.
            if (word === 0) {
                continue;
            }

            const wordOffset: number = w << 5;

            // Process each set bit in the current word using a bit-scan.
            while (word !== 0) {
                const lowestBit: number = word & -word;
                const index: number = wordOffset + (31 - Math.clz32(lowestBit));
                word ^= lowestBit;

                // Sample the state of the 6 neighbouring BitVoxels.
                const bvxp: number = VoxelFaceGeometry._SampleState(tableXP, index, centerElements, xpElements); // +x face
                const bvxn: number = VoxelFaceGeometry._SampleState(tableXN, index, centerElements, xnElements); // -x face
                const bvyp: number = VoxelFaceGeometry._SampleState(tableYP, index, centerElements, ypElements); // +y face
                const bvyn: number = VoxelFaceGeometry._SampleState(tableYN, index, centerElements, ynElements); // -y face
                const bvzp: number = VoxelFaceGeometry._SampleState(tableZP, index, centerElements, zpElements); // +z face
                const bvzn: number = VoxelFaceGeometry._SampleState(tableZN, index, centerElements, znElements); // -z face

                // A face is rendered only when the neighbouring BitVoxel is OFF.
                indices[index] =
                    ((bvxp ^ 1) << VoxelFaceGeometry.X_POS_INDEX) |
                    ((bvxn ^ 1) << VoxelFaceGeometry.X_NEG_INDEX) |
                    ((bvyp ^ 1) << VoxelFaceGeometry.Y_POS_INDEX) |
                    ((bvyn ^ 1) << VoxelFaceGeometry.Y_NEG_INDEX) |
                    ((bvzp ^ 1) << VoxelFaceGeometry.Z_POS_INDEX) |
                    ((bvzn ^ 1) << VoxelFaceGeometry.Z_NEG_INDEX);
            }
        }
    }
}
