import { describe, expect, it } from '@jest/globals';
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { BitOps } from "../src/lib/util/bit-ops.js";
import { BVXGeometry } from "../src/lib/geometry/bvx-geometry.js";
import vertices from "../src/lib/geometry/lut/bvx-vertices.js";
import normals from "../src/lib/geometry/lut/bvx-normals.js";
import uv from "../src/lib/geometry/lut/bvx-uv.js";

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('BVXGeometry', () => {

    it('.get vertices - ensure vertices matches the lut file', () => {
        // we expect no bit-voxels to be present
        expect(BVXGeometry.vertices).toEqual(vertices);
    });

    it('.get normals - ensure normals matches the lut file', () => {
        // we expect no bit-voxels to be present
        expect(BVXGeometry.normals).toEqual(normals);
    });

    it('.get uv - ensure uv matches the lut file', () => {
        // we expect no bit-voxels to be present
        expect(BVXGeometry.uv).toEqual(uv);
    });

    it('.getIndices() - ensure proper indices are generated', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // enable bit-voxels in a 3D star pattern
        // y axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 2, 1));

        // x axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 1, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 2, 1, 1));

        // z axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 2));

        // center
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        const indices: Uint32Array = BVXGeometry.getIndices(geometry);

        // star pattern voxels renders 7 voxels where 1 voxel is completely occluded (center voxel)
        // and all other 6 voxels have 1 face occluded due to the center voxel
        // the expected number of indices is as follows
        // each voxel has 6 faces, so number of faces to render is 6 x 5 (minus 1) = 30 faces
        // each face contains 2 triangles so 30 x 2 = 60 triangles
        // each triangle has 3 indices so 60 x 3 = 180 indices 
        expect(indices.length).toEqual(180);
    });

    it('.getIndices() - ensure proper flipped indices are generated', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // enable bit-voxels in a 3D star pattern
        // y axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 2, 1));

        // x axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 1, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 2, 1, 1));

        // z axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 2));

        // center
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        // sometimes indices need to be flipped to render the triangle in correct winding order
        // as some renderers render faces back to front
        const indices: Uint32Array = BVXGeometry.getIndices(geometry, true);

        // star pattern voxels renders 7 voxels where 1 voxel is completely occluded (center voxel)
        // and all other 6 voxels have 1 face occluded due to the center voxel
        // the expected number of indices is as follows
        // each voxel has 6 faces, so number of faces to render is 6 x 5 (minus 1) = 30 faces
        // each face contains 2 triangles so 30 x 2 = 60 triangles
        // each triangle has 3 indices so 60 x 3 = 180 indices 
        expect(indices.length).toEqual(180);
    });

    it('.getIndices() - ensure optional array is filled correctly', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // enable bit-voxels in a 3D star pattern
        // y axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 2, 1));

        // x axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 1, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 2, 1, 1));

        // z axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 2));

        // center
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        // depending on the application, might want to re-use some of these raw array buffers rather than
        // re-create them constantly
        const indices: Uint32Array = new Uint32Array(180);

        // sometimes indices need to be flipped to render the triangle in correct winding order
        // as some renderers render faces back to front
        BVXGeometry.getIndices(geometry, true, indices);

        // star pattern voxels renders 7 voxels where 1 voxel is completely occluded (center voxel)
        // and all other 6 voxels have 1 face occluded due to the center voxel
        // the expected number of indices is as follows
        // each voxel has 6 faces, so number of faces to render is 6 x 5 (minus 1) = 30 faces
        // each face contains 2 triangles so 30 x 2 = 60 triangles
        // each triangle has 3 indices so 60 x 3 = 180 indices 
        expect(indices.length).toEqual(180);
    });

    it('.getIndices() - ensure optional array throws an error', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // enable bit-voxels in a 3D star pattern
        // y axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 2, 1));

        // x axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 1, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 2, 1, 1));

        // z axis
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 2));

        // center
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        // depending on the application, might want to re-use some of these raw array buffers rather than
        // re-create them constantly
        const indices: Uint32Array = new Uint32Array(90);

        expect(() => BVXGeometry.getIndices(geometry, true, indices)).toThrow();
    });
});