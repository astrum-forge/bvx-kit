import { MortonKey } from "../../math/morton-key";
import { BitOps } from "../../util/bit-ops";
import { VoxelChunk } from "../voxel-chunk";
import { VoxelIndex } from "../voxel-index";
import { VoxelWorld } from "../voxel-world";
import { VoxelGeometry } from "./voxel-geometry";

/**
 * Geometry Composer that generates a 6 bit LUT index representing the state
 * of each BitVoxel to be rendered. This is done in such a way that BitVoxels
 * completely occluded do not render and only visible/outer faces are rendered.
 * 
 * The computed index needs to be inserted into a pre-defined LUT table for
 * the actual renderable geometry composition.
 */
export class VoxelFaceGeometry extends VoxelGeometry {
    public static readonly X_POS_INDEX: number = 0;
    public static readonly X_NEG_INDEX: number = 1;
    public static readonly Y_POS_INDEX: number = 2;
    public static readonly Y_NEG_INDEX: number = 3;
    public static readonly Z_POS_INDEX: number = 4;
    public static readonly Z_NEG_INDEX: number = 5;

    /**
     * reusable temporary containers to work with VoxelIndex a little easier
     */
    private static readonly TMP_VI_CENTER: VoxelIndex = new VoxelIndex();
    private static readonly TMP_VI_REF: VoxelIndex = new VoxelIndex();

    /**
     * Re-use to get quick query access
     */
    private static readonly TMP_MK: MortonKey = new MortonKey();

    /**
     * Used in-case the Neighbour chunk we want is not actually defined correctly
     */
    private static readonly TMP_CHUNK: VoxelChunk = new VoxelChunk(VoxelFaceGeometry.TMP_MK);

    public computeIndices(center: VoxelChunk, world: VoxelWorld): void {
        // reset the internal buffer
        this.reset();

        // This VoxelChunk has no BitVoxels set (basically empty space)
        // there is nothing to do or render, just return
        // quick exit
        if (center.length <= 0) {
            return;
        }

        // create local variables for quick re-use of these structures
        const vic: VoxelIndex = VoxelFaceGeometry.TMP_VI_CENTER;

        const dfChunk: VoxelChunk = VoxelFaceGeometry.TMP_CHUNK;
        const dfKey: MortonKey = VoxelFaceGeometry.TMP_MK;

        const centerKey: MortonKey = <MortonKey>center.key;

        // get the voxel-chunk neighbours to be used for the edge-queries
        // these are replaced by the default-zero dfChunk if chunks cannot be found
        // in the world. Due to memory constraints some chunks may not be defined
        // and loaded ad-hoc. For those scenarios we just render all the faces
        const xp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incX(), dfChunk);
        const xn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decX(), dfChunk);
        const yp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incY(), dfChunk);
        const yn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decY(), dfChunk);
        const zp: VoxelChunk = world.getOpt(centerKey.copy(dfKey).incZ(), dfChunk);
        const zn: VoxelChunk = world.getOpt(centerKey.copy(dfKey).decZ(), dfChunk);

        // the indices we will be using to write into
        const indices: Uint8Array = this.indices;

        // push the BitVoxel LUT indices onto the stack for quicker access
        const xPosIndex: number = VoxelFaceGeometry.X_POS_INDEX;
        const xNegIndex: number = VoxelFaceGeometry.X_NEG_INDEX;
        const yPosIndex: number = VoxelFaceGeometry.Y_POS_INDEX;
        const yNegIndex: number = VoxelFaceGeometry.Y_NEG_INDEX;
        const zPosIndex: number = VoxelFaceGeometry.Z_POS_INDEX;
        const zNegIndex: number = VoxelFaceGeometry.Z_NEG_INDEX;

        // loop through all bit-voxels and generate the geometry index for each one
        // each VoxelChunk has 4 x 4 x 4 = 64 Voxels
        // each Voxel has 4 x 4 x 4 = 64 BitVoxels
        // therefore each VoxelChunk has 4096 BitVoxels
        for (let index: number = 0; index < 4096; index++) {
            // set the key as the index
            vic.key = index;

            const bvState: number = center.getBitVoxel(vic);

            // nothing to do if bitvoxel does not want to be rendered
            // default GeometryIndex of 0 renders nothing
            if (bvState === 0) {
                continue;
            }

            // otherwise, BitVoxel is in the ON state, we need to figure
            // out which faces of the BV we want to render

            // This is the 6 bit GeometryIndex (GI) for this BitVoxel
            let geometryIndex: number = indices[index];

            // compute the +x state of geometry index from neighbour
            const bvxp = VoxelFaceGeometry._GetBitVoxelXP(vic, center, xp);
            // compute the -x state of geometry index from neighbour
            const bvxn = VoxelFaceGeometry._GetBitVoxelXN(vic, center, xn);
            // compute the +y state of geometry index from neighbour
            const bvyp = VoxelFaceGeometry._GetBitVoxelYP(vic, center, yp);
            // compute the -y state of geometry index from neighbour
            const bvyn = VoxelFaceGeometry._GetBitVoxelYN(vic, center, yn);
            // compute the +z state of geometry index from neighbour
            const bvzp = VoxelFaceGeometry._GetBitVoxelZP(vic, center, zp);
            // compute the -z state of geometry index from neighbour
            const bvzn = VoxelFaceGeometry._GetBitVoxelZN(vic, center, zn);

            // set the required bits so we know which faces we need to render
            geometryIndex = BitOps.setBit(geometryIndex, xPosIndex, (~bvxp) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, xNegIndex, (~bvxn) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, yPosIndex, (~bvyp) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, yNegIndex, (~bvyn) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, zPosIndex, (~bvzp) & 1);
            geometryIndex = BitOps.setBit(geometryIndex, zNegIndex, (~bvzn) & 1);

            // update geometry index for this BitVoxel
            indices[index] = geometryIndex;
        }
    }

    /**
     * Calculates and Returns the BitVoxel state for the +x coordinate from provided target
     */
    private static _GetBitVoxelXP(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        // these are the voxel coordinates (4x4x4)
        const vx: number = index.vx;
        const vy: number = index.vy;
        const vz: number = index.vz;

        // these are the bitvoxel coordinates (4x4x4) relative to voxel
        const bx: number = index.bx;
        const by: number = index.by;
        const bz: number = index.bz;

        // default to center for now unless we decide to switch
        let targetChunk: VoxelChunk = c;

        // we need to figure out which chunk to use to grab the bitvoxel state
        // grab coordinates to use for target coordinate
        let vt: number = vx;
        let bt: number = bx + 1;

        // check bounds for bitvoxel, if out of bounds we need to increment the voxel
        if (bt > 3) {
            bt = 0;

            // increment voxel coordinate lookup as bitvoxel bounds are reached
            vt += 1;

            // if voxel bounds are reached, we need to switch the VoxelChunk target
            if (vt > 3) {
                vt = 0;

                targetChunk = next;
            }
        }

        // return the neighbouring bitvoxel state
        return targetChunk.getBitVoxel(VoxelIndex.from(vt, vy, vz, bt, by, bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Calculates and Returns the BitVoxel state for the -x coordinate from provided target
     */
    private static _GetBitVoxelXN(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        // these are the voxel coordinates (4x4x4)
        const vx: number = index.vx;
        const vy: number = index.vy;
        const vz: number = index.vz;

        // these are the bitvoxel coordinates (4x4x4) relative to voxel
        const bx: number = index.bx;
        const by: number = index.by;
        const bz: number = index.bz;

        // default to center for now unless we decide to switch
        let targetChunk: VoxelChunk = c;

        // we need to figure out which chunk to use to grab the bitvoxel state
        // grab coordinates to use for target coordinate
        let vt: number = vx;
        let bt: number = bx - 1;

        // check bounds for bitvoxel, if out of bounds we need to increment the voxel
        if (bt < 0) {
            bt = 3;

            // increment voxel coordinate lookup as bitvoxel bounds are reached
            vt -= 1;

            // if voxel bounds are reached, we need to switch the VoxelChunk target
            if (vt < 0) {
                vt = 3;

                targetChunk = next;
            }
        }

        // return the neighbouring bitvoxel state
        return targetChunk.getBitVoxel(VoxelIndex.from(vt, vy, vz, bt, by, bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Calculates and Returns the BitVoxel state for the +y coordinate from provided target
     */
    private static _GetBitVoxelYP(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        // these are the voxel coordinates (4x4x4)
        const vx: number = index.vx;
        const vy: number = index.vy;
        const vz: number = index.vz;

        // these are the bitvoxel coordinates (4x4x4) relative to voxel
        const bx: number = index.bx;
        const by: number = index.by;
        const bz: number = index.bz;

        // default to center for now unless we decide to switch
        let targetChunk: VoxelChunk = c;

        // we need to figure out which chunk to use to grab the bitvoxel state
        // grab coordinates to use for target coordinate
        let vt: number = vy;
        let bt: number = by + 1;

        // check bounds for bitvoxel, if out of bounds we need to increment the voxel
        if (bt > 3) {
            bt = 0;

            // increment voxel coordinate lookup as bitvoxel bounds are reached
            vt += 1;

            // if voxel bounds are reached, we need to switch the VoxelChunk target
            if (vt > 3) {
                vt = 0;

                targetChunk = next;
            }
        }

        // return the neighbouring bitvoxel state
        return targetChunk.getBitVoxel(VoxelIndex.from(vx, vt, vz, bx, bt, bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Calculates and Returns the BitVoxel state for the -y coordinate from provided target
     */
    private static _GetBitVoxelYN(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        // these are the voxel coordinates (4x4x4)
        const vx: number = index.vx;
        const vy: number = index.vy;
        const vz: number = index.vz;

        // these are the bitvoxel coordinates (4x4x4) relative to voxel
        const bx: number = index.bx;
        const by: number = index.by;
        const bz: number = index.bz;

        // default to center for now unless we decide to switch
        let targetChunk: VoxelChunk = c;

        // we need to figure out which chunk to use to grab the bitvoxel state
        // grab coordinates to use for target coordinate
        let vt: number = vy;
        let bt: number = by - 1;

        // check bounds for bitvoxel, if out of bounds we need to increment the voxel
        if (bt < 0) {
            bt = 3;

            // increment voxel coordinate lookup as bitvoxel bounds are reached
            vt -= 1;

            // if voxel bounds are reached, we need to switch the VoxelChunk target
            if (vt < 0) {
                vt = 3;

                targetChunk = next;
            }
        }

        // return the neighbouring bitvoxel state
        return targetChunk.getBitVoxel(VoxelIndex.from(vx, vt, vz, bx, bt, bz, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Calculates and Returns the BitVoxel state for the +z coordinate from provided target
     */
    private static _GetBitVoxelZP(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        // these are the voxel coordinates (4x4x4)
        const vx: number = index.vx;
        const vy: number = index.vy;
        const vz: number = index.vz;

        // these are the bitvoxel coordinates (4x4x4) relative to voxel
        const bx: number = index.bx;
        const by: number = index.by;
        const bz: number = index.bz;

        // default to center for now unless we decide to switch
        let targetChunk: VoxelChunk = c;

        // we need to figure out which chunk to use to grab the bitvoxel state
        // grab coordinates to use for target coordinate
        let vt: number = vz;
        let bt: number = bz + 1;

        // check bounds for bitvoxel, if out of bounds we need to increment the voxel
        if (bt > 3) {
            bt = 0;

            // increment voxel coordinate lookup as bitvoxel bounds are reached
            vt += 1;

            // if voxel bounds are reached, we need to switch the VoxelChunk target
            if (vt > 3) {
                vt = 0;

                targetChunk = next;
            }
        }

        // return the neighbouring bitvoxel state
        return targetChunk.getBitVoxel(VoxelIndex.from(vx, vy, vt, bx, by, bt, VoxelFaceGeometry.TMP_VI_REF));
    }

    /**
     * Calculates and Returns the BitVoxel state for the -z coordinate from provided target
     */
    private static _GetBitVoxelZN(index: VoxelIndex, c: VoxelChunk, next: VoxelChunk): number {
        // these are the voxel coordinates (4x4x4)
        const vx: number = index.vx;
        const vy: number = index.vy;
        const vz: number = index.vz;

        // these are the bitvoxel coordinates (4x4x4) relative to voxel
        const bx: number = index.bx;
        const by: number = index.by;
        const bz: number = index.bz;

        // default to center for now unless we decide to switch
        let targetChunk: VoxelChunk = c;

        // we need to figure out which chunk to use to grab the bitvoxel state
        // grab coordinates to use for target coordinate
        let vt: number = vz;
        let bt: number = bz - 1;

        // check bounds for bitvoxel, if out of bounds we need to increment the voxel
        if (bt < 0) {
            bt = 3;

            // increment voxel coordinate lookup as bitvoxel bounds are reached
            vt -= 1;

            // if voxel bounds are reached, we need to switch the VoxelChunk target
            if (vt < 0) {
                vt = 3;

                targetChunk = next;
            }
        }

        // return the neighbouring bitvoxel state
        return targetChunk.getBitVoxel(VoxelIndex.from(vx, vy, vt, bx, by, bt, VoxelFaceGeometry.TMP_VI_REF));
    }
}