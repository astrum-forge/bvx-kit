import { BitOps } from "../../util/bit-ops";
import { VoxelChunk } from "../voxel-chunk";
import { VoxelWorld } from "../voxel-world";

/**
 * VoxelGeometry is represented as an index to be used against a LUT table
 * for the specific renderable geometry. This was done as this framework is
 * renderer agnostic. Each Renderer will have its own configuration of a LUT
 * table.
 * 
 * Geometry Index is an 8 bit index representing the state of either the faces
 * or edges of nearby BitVoxels. 
 * 
 * - 6 bits (0-63) for face indices
 * - 8 bits (0-255) for edge indices
 * 
 * Re-Use this structure as much as possible to avoid expensive memory allocations.
 * VoxelGeometry is always computed at runtime as Voxel states can change dynamically
 */
export abstract class VoxelGeometry {
    private readonly _geometryIndices: Uint8Array;
    private readonly _geometryIndicesBuffer: ArrayBuffer;

    constructor() {
        const size: number = VoxelChunk.SIZE;
        const bvxSize: number = VoxelChunk.BVX_SUBDIV;

        // we require 8 bits max per geometry index
        // each bit-voxel has its own geometry index
        this._geometryIndicesBuffer = new ArrayBuffer((size * size * size) * (bvxSize * bvxSize * bvxSize));
        this._geometryIndices = new Uint8Array(this._geometryIndicesBuffer);
    }

    public get indices(): Uint8Array {
        return this._geometryIndices;
    }

    public get length(): number {
        return this._geometryIndices.length;
    }

    public get buffer(): ArrayBuffer {
        return this._geometryIndicesBuffer;
    }

    /**
     * Resets the internal buffer to 0
     */
    public reset(): void {
        this._geometryIndices.fill(0);
    }

    /**
     * Standard PopCount that counts the number of set bits in the container
     * @returns - The number of set bits
     */
    public popCount(): number {
        let counter: number = 0;

        const arr: Uint8Array = this._geometryIndices;
        const length: number = arr.length;

        for (let i: number = 0; i < length; i++) {
            counter += BitOps.popCount(arr[i]);
        }

        return counter;
    }

    /**
     * Computes the GeometryIndex using the neighbouring faces for a provided VoxelChunk. Geometry
     * is generated in a way that disallows rendering of fully occluded or invisible bitVoxels.
     * @param center - The VoxelChunk to generate the geometry for
     * @param world - The VoxelWorld instance to be used for near-neighbour queries
     */
    public abstract computeIndices(center: VoxelChunk, world: VoxelWorld): void;
}