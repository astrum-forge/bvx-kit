import { VoxelQuadGeometry } from "@astrumforge/bvx-kit";
import { PALETTE } from "./palette";
import { AO_LEVELS, BIT_VOXEL_SIZE } from "./units";

/**
 * The expanded vertex streams a Babylon mesh is built from.
 */
export interface BlockyMesh {
    positions: Float32Array;
    normals: Float32Array;
    colors: Float32Array;

    /**
     * Per-vertex openness, or null for water - which spends the same measure on
     * its vertex colour instead and would only be uploading a buffer nothing
     * samples.
     */
    occlusion: Float32Array | null;

    indices: Uint32Array;

    /**
     * The number of quads, i.e. visible faces. Two triangles each.
     */
    faceCount: number;
}

/**
 * Expands a packed quad list into the vertex streams the editor uploads.
 *
 * This is the half of blocky meshing that used to run on the main thread, and
 * it is the reason the quad list exists: the work is identical wherever it
 * happens, so it belongs wherever the caller is not blocking on it. It runs in
 * the mesher worker (see mesher.worker.ts) and the main thread only uploads the
 * result.
 *
 * @param quads - Packed quads from VoxelQuadGeometry, one word per visible face.
 * @param meta - The chunk's 64 per-voxel meta-data entries, or an empty array
 * when the chunk carries none.
 * @param laneColor - A flat colour for the whole lane, or null to take each
 * voxel's colour from its meta-data through the palette.
 * @param water - Whether this is the water lane, which bakes a shoreline mask
 * into the vertex colour rather than a separate occlusion stream.
 */
export function expandQuads(quads: Uint32Array, meta: Uint32Array, laneColor: readonly number[] | null, water: boolean): BlockyMesh {
    const faceCount = quads.length;

    const positions = new Float32Array(faceCount * 4 * 3);
    const normals = new Float32Array(faceCount * 4 * 3);
    const colors = new Float32Array(faceCount * 4 * 4);
    const indices = new Uint32Array(faceCount * 6);
    const occlusion = water ? null : new Float32Array(faceCount * 4);

    const corners = VoxelQuadGeometry.CORNERS;
    const normalTable = VoxelQuadGeometry.NORMALS;
    const hasMeta = meta.length > 0;

    let vertex = 0;
    let indexCount = 0;

    for (let q = 0; q < faceCount; q++) {
        const quad = quads[q];
        const index = VoxelQuadGeometry.indexOf(quad);
        const face = VoxelQuadGeometry.faceOf(quad);

        // decode the BitVoxel local coordinates from the VoxelIndex key layout
        const x = (((index >> 10) & 3) << 2) | ((index >> 4) & 3);
        const y = (((index >> 8) & 3) << 2) | ((index >> 2) & 3);
        const z = (((index >> 6) & 3) << 2) | (index & 3);

        // flat lane colour, or the Voxel colour from meta-data. Meta-data is per
        // Voxel rather than per BitVoxel, so the 64-entry table is indexed by the
        // BitVoxel index shifted down past its in-Voxel bits.
        let rgb = laneColor;

        if (rgb === null) {
            rgb = PALETTE[(hasMeta ? meta[index >> 6] : 0) % PALETTE.length].rgb;
        }

        const faceCorners = corners[face];
        const normal = normalTable[face];
        const base = vertex;

        for (let c = 0; c < 4; c++) {
            const write = vertex * 3;
            const corner = faceCorners[c];

            positions[write] = (x + corner[0]) * BIT_VOXEL_SIZE;
            positions[write + 1] = (y + corner[1]) * BIT_VOXEL_SIZE;
            positions[write + 2] = (z + corner[2]) * BIT_VOXEL_SIZE;

            normals[write] = normal[0];
            normals[write + 1] = normal[1];
            normals[write + 2] = normal[2];

            const openness = AO_LEVELS[VoxelQuadGeometry.occlusionOf(quad, c)];
            const colorWrite = vertex * 4;

            if (occlusion === null) {
                // water spends the same measure on surf, not shading
                const shore = 1.0 - openness;

                colors[colorWrite] = shore;
                colors[colorWrite + 1] = shore;
                colors[colorWrite + 2] = shore;
                colors[colorWrite + 3] = 1.0;
            }
            else {
                // albedo stays exactly the palette entry - occlusion rides in its
                // own stream so the toon ramp can spend it on the ambient term
                // alone
                colors[colorWrite] = rgb[0];
                colors[colorWrite + 1] = rgb[1];
                colors[colorWrite + 2] = rgb[2];
                colors[colorWrite + 3] = 1.0;

                occlusion[vertex] = openness;
            }

            vertex++;
        }

        // split the quad along the diagonal that matches the occlusion gradient,
        // avoiding the classic interpolation artifact. VoxelQuadGeometry resolved
        // which diagonal that is when it baked the corner levels.
        if (VoxelQuadGeometry.flippedOf(quad)) {
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

    return {
        positions: positions,
        normals: normals,
        colors: colors,
        occlusion: occlusion,
        indices: indices,
        faceCount: faceCount
    };
}
