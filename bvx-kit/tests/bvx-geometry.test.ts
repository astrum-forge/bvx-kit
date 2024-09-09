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
});