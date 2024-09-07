import vertices from "./lut/bvx-vertices.js";
import normals from "./lut/bvx-normals.js";
import indices from "./lut/bvx-indices.js";
import indicesFlipped from "./lut/bvx-indices-flipped.js";
import uv from "./lut/bvx-uv.js";
import { VoxelFaceGeometry } from "../engine/geometry/voxel-face-geometry.js";

/**
 * BVXGeometry is responsible for computing and providing renderable geometry data 
 * for BitVoxel visualization. It provides access to static vertex, normal, and UV arrays
 * and methods for generating renderable indices used in a rendering engine.
 */
export class BVXGeometry {

    /**
     * Provides the vertex data for a chunk of 16x16x16 BitVoxels (4x4x4 Voxels).
     * 
     * This array contains the precomputed vertex positions for each voxel in the chunk.
     * 
     * @returns - A Float32Array containing the vertex positions.
     * 
     * NOTE: The returned array is a static reference and should not be modified directly.
     */
    public static get vertices(): Float32Array {
        return vertices;
    }

    /**
     * Provides the normal vectors for each vertex in a chunk of 16x16x16 BitVoxels (4x4x4 Voxels).
     * 
     * The normals define the direction each face of the voxel is facing, used for lighting calculations.
     * 
     * @returns - A Float32Array containing the normal vectors.
     * 
     * NOTE: The returned array is a static reference and should not be modified directly.
     */
    public static get normals(): Float32Array {
        return normals;
    }

    /**
     * Provides the UV mapping data for a chunk of 16x16x16 BitVoxels (4x4x4 Voxels).
     * 
     * Each voxel face has its own UV coordinates, which define how textures are mapped to each face.
     * 
     * @returns - A Float32Array containing the UV coordinates for each voxel face.
     * 
     * NOTE: The returned array is a static reference and should not be modified directly. 
     * Modifications should be done externally for different textures.
     */
    public static get uv(): Float32Array {
        return uv;
    }

    /**
     * Generates the indices array for rendering a computed Voxel geometry. The indices define 
     * how the vertices are connected to form triangles for rendering purposes. 
     * 
     * This method creates an index buffer based on the voxel face geometry, 
     * mapping the voxel configuration to the correct set of triangles.
     * 
     * @param geometry - The VoxelFaceGeometry containing the voxel configuration.
     * @param flipped - Whether to use flipped indices for rendering.
     * @param optres - (Optional) A pre-allocated Uint32Array for the results to reduce allocations.
     * 
     * @returns - A Uint32Array containing the indices for rendering the voxel faces.
     * 
     * NOTE: The generated indices are used in conjunction with the vertex and normal arrays for rendering.
     */
    public static getIndices(geometry: VoxelFaceGeometry, flipped: boolean = false, optres: Uint32Array | null = null): Uint32Array {
        const numberOfFaces: number = geometry.popCount();
        const numberOfIndices: number = numberOfFaces * 6; // 6 indices per face (2 triangles per face)
        const result = optres || new Uint32Array(numberOfIndices);

        // Ensure the provided result buffer has the correct length
        if (result.length !== numberOfIndices) {
            throw new RangeError("BVXGeometry.getIndices() - optional parameter does not have a valid length, expected " + numberOfIndices + " but was " + result.length);
        }

        const geometryIndices: Uint8Array = geometry.indices;
        const length: number = geometryIndices.length;
        const renderableIndices: Array<Uint32Array> = flipped ? indicesFlipped : indices;

        let counter = 0;

        for (let index: number = 0; index < length; index++) {
            const gi: number = geometryIndices[index];

            // Skip if the voxel face is not active (0 means no voxel face)
            if (gi === 0) {
                continue;
            }

            // Retrieve the corresponding set of indices for the current voxel configuration
            const configuration: Uint32Array = renderableIndices[gi];
            const clength: number = configuration.length;

            // Offset the indices by the voxel's position and add to the result array
            for (let cindex: number = 0; cindex < clength; cindex++) {
                result[counter] = configuration[cindex] + (index * 24);
                counter++;
            }
        }

        return result;
    }
}
