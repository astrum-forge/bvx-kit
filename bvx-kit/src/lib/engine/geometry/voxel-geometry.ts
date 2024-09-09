import { BitOps } from "../../util/bit-ops.js";
import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelWorld } from "../voxel-world.js";

/**
 * VoxelGeometry represents the renderable geometry of a VoxelChunk. It is designed to be used
 * with a renderer-agnostic lookup table (LUT), allowing different renderers to use their own
 * configurations for voxel rendering. The geometry is computed dynamically based on voxel states.
 * 
 * The geometry is represented by an 8-bit index for each BitVoxel:
 * 
 * - 6 bits are used for face indices, representing which faces of the voxel are visible.
 * - 8 bits can be used for edge indices, representing edge geometry.
 * 
 * This structure is optimized to be reused, avoiding frequent memory allocations and ensuring 
 * efficient voxel state changes at runtime.
 */
export abstract class VoxelGeometry {
    /**
     * The internal buffer storing the 8-bit geometry indices for each BitVoxel.
     * This buffer holds one index per BitVoxel in the BVXLayer (16x16x16 = 4096 BitVoxels).
     */
    private readonly _geometryIndices: Uint8Array;

    /**
     * The underlying ArrayBuffer backing the Uint8Array of geometry indices.
     */
    private readonly _geometryIndicesBuffer: ArrayBuffer;

    constructor() {
        // Each BitVoxel gets one 8-bit index. Allocating an ArrayBuffer to store the geometry.
        this._geometryIndicesBuffer = new ArrayBuffer(BVXLayer.SIZE); // 4096 bytes for 4096 BitVoxels
        this._geometryIndices = new Uint8Array(this._geometryIndicesBuffer);
    }

    /**
     * Returns the geometry indices, which represent the renderable geometry for each BitVoxel.
     * 
     * @returns - A Uint8Array containing the geometry indices for the entire BVXLayer.
     */
    public get indices(): Uint8Array {
        return this._geometryIndices;
    }

    /**
     * Returns the total number of geometry indices (should be equal to the total number of BitVoxels).
     * 
     * @returns - The length of the geometry indices array (4096 for a full BVXLayer).
     */
    public get length(): number {
        return this._geometryIndices.length;
    }

    /**
     * Returns the underlying ArrayBuffer that backs the geometry indices. Useful for direct 
     * buffer manipulation or transfer between threads or systems.
     * 
     * @returns - The ArrayBuffer that contains the geometry data.
     */
    public get buffer(): ArrayBuffer {
        return this._geometryIndicesBuffer;
    }

    /**
     * Resets all geometry indices in the internal buffer to 0. This effectively clears the
     * current geometry, preparing it for recomputation.
     */
    public reset(): void {
        this._geometryIndices.fill(0);
    }

    /**
     * Counts the total number of set bits (non-zero) in the geometry indices array.
     * This provides a quick way to determine how many BitVoxels have geometry that needs
     * to be rendered.
     * 
     * @returns - The number of set bits in the geometry indices.
     */
    public popCount(): number {
        let counter: number = 0;

        const arr: Uint8Array = this._geometryIndices;
        const length: number = arr.length;

        for (let i: number = 0; i < length; i++) {
            counter += BitOps.popCount(arr[i]); // Uses BitOps to count the number of set bits
        }

        return counter;
    }

    /**
     * Abstract method that must be implemented by subclasses to compute the geometry indices
     * for a given VoxelChunk. The geometry is computed based on the visibility of each BitVoxel
     * in the chunk, and hidden/occluded voxels are excluded from rendering.
     * 
     * This method may query neighboring chunks in the VoxelWorld to accurately determine face
     * visibility at the chunk boundaries.
     * 
     * @param center - The VoxelChunk for which the geometry is being computed.
     * @param world - The VoxelWorld containing the chunk and its neighboring chunks.
     */
    public abstract computeIndices(center: VoxelChunk, world: VoxelWorld): void;
}
