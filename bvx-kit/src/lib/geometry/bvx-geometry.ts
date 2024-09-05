import vertices from "./lut/bvx-vertices.js";
import normals from "./lut/bvx-normals.js";
import indices from "./lut/bvx-indices.js";
import indicesFlipped from "./lut/bvx-indices-flipped.js";
import uv from "./lut/bvx-uv.js";
import { VoxelFaceGeometry } from "../engine/geometry/voxel-face-geometry.js";

/**
 * Allows computing a renderable geometry to visualise BitVoxels in a rendering engine
 */
export class BVXGeometry {

    /**
     * Returns a static vertices array that represents a single chunk of 
     * 4x4x4 Voxels or 16x16x16 BitVoxels.
     * 
     * NOTE: The returned array is a reference and should not be modified
     */
    public static get vertices(): Float32Array {
        return vertices;
    }

    /**
     * Returns a static normals array that represents a single chunk of
     * 4x4x4 Voxels or 16x16x16 BitVoxels.
     *
     * NOTE: The returned array is a reference and should not be modified
     */
    public static get normals(): Float32Array {
        return normals;
    }

    /**
     * Returns a static UV array that represents a single chunk of
     * 4x4x4 Voxels or 16x16x16 BitVoxels.
     * 
     * Each BitVoxel Face has an independent UV map attached. This map
     * needs to be modified externally based on texture.
     * 
     * NOTE: The returned array is a reference and should not be modified
     */
    public static get uv(): Float32Array {
        return uv;
    }

    /**
     * Provided a fully-configured and computed Voxel Geometry, generate the required indices
     * to be used for rendering purposes. These indices will refer to vertex and normal positions
     * as defined in getVertices() and getNormals().
     * 
     * Index computation must be re-done when Voxel Configuration changes
     * 
     * @param geometry - The computed Voxel Geometry to use for generating Renderable Indices
     * @param optres - (optional) results buffer to use, if missing will re-create
     * 
     * @returns - Index Array to be used for Rendering
     */
    public static getIndices(geometry: VoxelFaceGeometry, flipped: boolean = false, optres: Uint32Array | null = null): Uint32Array {
        const numberOfFaces: number = geometry.popCount();
        const numberOfIndices: number = numberOfFaces * 6;
        const result = optres || new Uint32Array(numberOfIndices);

        // we must have enough room to store all our indices
        // each face has 2 triangles and each triangle has 3 indices
        if (result.length !== numberOfIndices) {
            throw new RangeError("BVXGeometry.getIndices() - optional parameter does not have a valid length, expected " + numberOfIndices + " but was " + result.length);
        }

        const geometryIndices: Uint8Array = geometry.indices;
        const length: number = geometryIndices.length;
        const renderableIndices: Array<Uint32Array> = flipped ? indicesFlipped : indices;

        let counter = 0;

        for (let index: number = 0; index < length; index++) {
            const gi: number = geometryIndices[index];

            // there is nothing to render for this index, just skip
            if (gi === 0) {
                continue;
            }

            // otherwise, we need to add and offset indices, check which
            // voxel configuration we want to render
            const configuration: Uint32Array = renderableIndices[gi];
            const clength: number = configuration.length;

            // offset the indices to the desired voxel position and
            // add to the total
            for (let cindex: number = 0; cindex < clength; cindex++) {
                result[counter] = configuration[cindex] + (index * 24);
                counter++;
            }
        }

        return result;
    }
}