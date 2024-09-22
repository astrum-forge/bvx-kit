import { MortonKey } from "../../math/morton-key.js";
import { BitOps } from "../../util/bit-ops.js";
import { VoxelChunk0 } from "../chunks/voxel-chunk-0.js";
import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { VoxelIndex } from "../voxel-index.js";
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
     * The geometry index for faces uses 6 bits to represent which of the six faces of a 
     * BitVoxel are visible (0-63). 
     */
    private static readonly KEY_MASK: number = BitOps.maskForBits(6);

    /**
     * Temporary VoxelIndex objects used to simplify voxel manipulation during face calculations.
     */
    private static readonly TMP_VI_CENTER: VoxelIndex = new VoxelIndex();
    private static readonly TMP_VI_REF: VoxelIndex = new VoxelIndex();

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
     * Computes the geometry indices for all BitVoxels in the given VoxelChunk. The geometry is 
     * determined based on the visibility of each voxel's faces, considering the presence of 
     * neighboring voxels.
     * 
     * Invisible or fully occluded voxels will not be rendered. The geometry index is computed 
     * based on face visibility using neighboring chunks when necessary.
     * 
     * @param center - The VoxelChunk for which geometry is being generated.
     * @param world - The VoxelWorld instance used to query neighboring chunks for boundary checks.
     */
    public computeIndices(center: VoxelChunk, world: VoxelWorld): void {
        // Reset the internal buffer before computing new geometry.
        this.reset();

        // If the VoxelChunk is empty (no BitVoxels set), exit early as there's nothing to render.
        if (center.length <= 0) {
            return;
        }

        // Local references for reusing objects to reduce allocations.
        const vic: VoxelIndex = VoxelFaceGeometry.TMP_VI_CENTER;
        const dfChunk: VoxelChunk = VoxelFaceGeometry.TMP_CHUNK;
        const dfKey: MortonKey = VoxelFaceGeometry.TMP_MK;
        const centerKey: MortonKey = center.key;

        // Get neighboring chunks or use the default chunk if they are not available.
        const xp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incX(), dfChunk);
        const xn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decX(), dfChunk);
        const yp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incY(), dfChunk);
        const yn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decY(), dfChunk);
        const zp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incZ(), dfChunk);
        const zn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decZ(), dfChunk);

        // The array that holds the computed geometry indices for the chunk.
        const indices: Uint8Array = this.indices;

        // Bit positions for each face in the 6-bit geometry index.
        const xPosIndex: number = VoxelFaceGeometry.X_POS_INDEX;
        const xNegIndex: number = VoxelFaceGeometry.X_NEG_INDEX;
        const yPosIndex: number = VoxelFaceGeometry.Y_POS_INDEX;
        const yNegIndex: number = VoxelFaceGeometry.Y_NEG_INDEX;
        const zPosIndex: number = VoxelFaceGeometry.Z_POS_INDEX;
        const zNegIndex: number = VoxelFaceGeometry.Z_NEG_INDEX;
        const mask: number = VoxelFaceGeometry.KEY_MASK;

        // Loop through all BitVoxels in the chunk (16x16x16 = 4096 BitVoxels).
        const length: number = this.length;

        for (let index = 0; index < length; index++) {
            vic.key = index;

            const bvState: number = center.getBitVoxel(vic);

            // Skip if the BitVoxel is not set (no geometry to render for this voxel).
            if (bvState === 0) {
                continue;
            }

            // Initialize the geometry index for this BitVoxel.
            let geometryIndex: number = indices[index];

            // Compute the face visibility based on neighboring voxels.
            const bvxp = VoxelFaceGeometry._GetBitVoxelXP(vic, center, xp); // +x face
            const bvxn = VoxelFaceGeometry._GetBitVoxelXN(vic, center, xn); // -x face
            const bvyp = VoxelFaceGeometry._GetBitVoxelYP(vic, center, yp); // +y face
            const bvyn = VoxelFaceGeometry._GetBitVoxelYN(vic, center, yn); // -y face
            const bvzp = VoxelFaceGeometry._GetBitVoxelZP(vic, center, zp); // +z face
            const bvzn = VoxelFaceGeometry._GetBitVoxelZN(vic, center, zn); // -z face

            // Update the geometry index based on face visibility.
            geometryIndex = BitOps.setBit(geometryIndex, xPosIndex, (~bvxp) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, xNegIndex, (~bvxn) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, yPosIndex, (~bvyp) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, yNegIndex, (~bvyn) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, zPosIndex, (~bvzp) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, zNegIndex, (~bvzn) & 1);

            // Store the computed geometry index in the array.
            indices[index] = geometryIndex & mask;
        }
    }

    /**
     * Retrieves the state of the BitVoxel on the +x face.
     */
    private static _GetBitVoxelXP(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        let vt: number = index.vx;
        let bt: number = index.bx + 1;

        if (bt > 3) {
            bt = 0;
            vt += 1;

            if (vt > 3) {
                vt = 0;
                return next.getBitVoxel(VoxelIndex.from(vt, index.vy, index.vz, bt, index.by, index.bz, VoxelFaceGeometry.TMP_VI_REF));
            }
        }

        return c.getBitVoxel(VoxelIndex.from(vt, index.vy, index.vz, bt, index.by, index.bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Retrieves the state of the BitVoxel on the -x face.
     */
    private static _GetBitVoxelXN(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        let vt: number = index.vx;
        let bt: number = index.bx - 1;

        if (bt < 0) {
            bt = 3;
            vt -= 1;

            if (vt < 0) {
                vt = 3;
                return next.getBitVoxel(VoxelIndex.from(vt, index.vy, index.vz, bt, index.by, index.bz, VoxelFaceGeometry.TMP_VI_REF));
            }
        }

        return c.getBitVoxel(VoxelIndex.from(vt, index.vy, index.vz, bt, index.by, index.bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Retrieves the state of the BitVoxel on the +y face.
     */
    private static _GetBitVoxelYP(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        let vt: number = index.vy;
        let bt: number = index.by + 1;

        if (bt > 3) {
            bt = 0;
            vt += 1;

            if (vt > 3) {
                vt = 0;
                return next.getBitVoxel(VoxelIndex.from(index.vx, vt, index.vz, index.bx, bt, index.bz, VoxelFaceGeometry.TMP_VI_REF));
            }
        }

        return c.getBitVoxel(VoxelIndex.from(index.vx, vt, index.vz, index.bx, bt, index.bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Retrieves the state of the BitVoxel on the -y face.
     */
    private static _GetBitVoxelYN(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        let vt: number = index.vy;
        let bt: number = index.by - 1;

        if (bt < 0) {
            bt = 3;
            vt -= 1;

            if (vt < 0) {
                vt = 3;
                return next.getBitVoxel(VoxelIndex.from(index.vx, vt, index.vz, index.bx, bt, index.bz, VoxelFaceGeometry.TMP_VI_REF));
            }
        }

        return c.getBitVoxel(VoxelIndex.from(index.vx, vt, index.vz, index.bx, bt, index.bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Retrieves the state of the BitVoxel on the +z face.
     */
    private static _GetBitVoxelZP(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        let vt: number = index.vz;
        let bt: number = index.bz + 1;

        if (bt > 3) {
            bt = 0;
            vt += 1;

            if (vt > 3) {
                vt = 0;
                return next.getBitVoxel(VoxelIndex.from(index.vx, index.vy, vt, index.bx, index.by, bt, VoxelFaceGeometry.TMP_VI_REF));
            }
        }

        return c.getBitVoxel(VoxelIndex.from(index.vx, index.vy, vt, index.bx, index.by, bt, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Retrieves the state of the BitVoxel on the -z face.
     */
    private static _GetBitVoxelZN(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        let vt: number = index.vz;
        let bt: number = index.bz - 1;

        if (bt < 0) {
            bt = 3;
            vt -= 1;

            if (vt < 0) {
                vt = 3;
                return next.getBitVoxel(VoxelIndex.from(index.vx, index.vy, vt, index.bx, index.by, bt, VoxelFaceGeometry.TMP_VI_REF));
            }
        }

        return c.getBitVoxel(VoxelIndex.from(index.vx, index.vy, vt, index.bx, index.by, bt, VoxelFaceGeometry.TMP_VI_REF));
    }
}
