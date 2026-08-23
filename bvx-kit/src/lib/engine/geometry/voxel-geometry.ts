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

    /**
     * The BitVoxel indices that carry geometry, in ascending order. Maintained by
     * computeIndices() so consumers and reset() can touch only the populated entries
     * rather than walking all 4096. A chunk cannot have more than SIZE of them.
     */
    private readonly _touched: Uint16Array;

    /**
     * The number of valid entries in _touched.
     */
    private _touchedCount: number;

    /**
     * Running total of set face bits across all populated entries - the value
     * popCount() reports. Accumulated during computeIndices() so the count never
     * requires a pass over the index buffer.
     */
    private _faceCount: number;

    constructor() {
        // Each BitVoxel gets one 8-bit index. Allocating an ArrayBuffer to store the geometry.
        this._geometryIndicesBuffer = new ArrayBuffer(BVXLayer.SIZE); // 4096 bytes for 4096 BitVoxels
        this._geometryIndices = new Uint8Array(this._geometryIndicesBuffer);
        this._touched = new Uint16Array(BVXLayer.SIZE);
        this._touchedCount = 0;
        this._faceCount = 0;
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
     * Returns the BitVoxel indices that carry geometry, in ascending order. Iterating
     * this instead of the full 4096-entry index buffer makes consumers proportional to
     * the geometry produced rather than to the chunk size, which matters because most
     * chunks in a large world are empty or fully enclosed and produce nothing.
     *
     * The returned view is only valid until the next computeIndices() or reset() call,
     * and only describes geometry written by computeIndices() - it does not track
     * direct writes to the indices array.
     *
     * @returns - A Uint16Array view of the populated BitVoxel indices.
     */
    public get touched(): Uint16Array {
        return this._touched.subarray(0, this._touchedCount);
    }

    /**
     * Returns the number of BitVoxel indices that carry geometry.
     */
    public get touchedCount(): number {
        return this._touchedCount;
    }

    /**
     * Returns the full-capacity touched list for a computeIndices() implementation to
     * fill. The write contract is deliberately open-coded rather than wrapped in a
     * per-BitVoxel method call: the geometry loop runs once per set BitVoxel, up to
     * 4096 times per chunk, and a call at that frequency costs more than the pass it
     * replaces.
     *
     * An implementation must:
     *
     * - write a non-zero mask to indices[i] and append i to this buffer, in ascending i
     * - leave zero masks alone entirely - reset() has already zeroed the buffer, so a
     *   fully enclosed BitVoxel costs nothing beyond its neighbour sampling
     * - call commit() once with the final counts
     *
     * @returns - The Uint16Array to append populated BitVoxel indices to.
     */
    protected get touchedBuffer(): Uint16Array {
        return this._touched;
    }

    /**
     * Publishes the results of a computeIndices() pass. Called once at the end of the
     * pass with the totals accumulated in its loop locals.
     *
     * @param touchedCount - The number of entries written to the touched buffer.
     * @param faceCount - The total number of set face bits across those entries.
     */
    protected commit(touchedCount: number, faceCount: number): void {
        this._touchedCount = touchedCount;
        this._faceCount = faceCount;
    }

    /**
     * Resets all geometry indices in the internal buffer to 0. This effectively clears the
     * current geometry, preparing it for recomputation.
     *
     * Only the entries populated by the previous computation are cleared, so the cost is
     * proportional to the geometry that was produced rather than to the chunk size.
     */
    public reset(): void {
        const indices: Uint8Array = this._geometryIndices;
        const touched: Uint16Array = this._touched;
        const count: number = this._touchedCount;

        for (let i = 0; i < count; i++) {
            indices[touched[i]] = 0;
        }

        this._touchedCount = 0;
        this._faceCount = 0;
    }

    /**
     * Counts the total number of set bits (non-zero) in the geometry indices array.
     * This provides a quick way to determine how many BitVoxels have geometry that needs
     * to be rendered.
     *
     * The count is accumulated as geometry is emitted, so this is a constant-time read
     * rather than a pass over the index buffer.
     *
     * @returns - The number of set bits in the geometry indices.
     */
    public popCount(): number {
        return this._faceCount;
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
     * @param occluders - (Optional) A VoxelWorld whose occupancy additionally culls
     * geometry hidden behind co-located layers (see VoxelFaceGeometry.computeIndices).
     */
    public abstract computeIndices(center: VoxelChunk, world: VoxelWorld, occluders?: VoxelWorld | null): void;
}
