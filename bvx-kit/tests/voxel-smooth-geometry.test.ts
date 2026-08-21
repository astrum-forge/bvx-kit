import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelSmoothGeometry } from "../src/lib/engine/geometry/voxel-smooth-geometry.js";

/**
 * Provides coverage for voxel-smooth-geometry.ts
 */
describe('VoxelSmoothGeometry', () => {

    /**
     * Welds mesh vertices by position and verifies that every undirected edge is
     * shared by exactly 2 triangles with opposite directions - the mesh forms a
     * closed, watertight and consistently wound surface.
     */
    const expectWatertight = (vertices: Float32Array[], indices: Uint32Array[]): void => {
        // weld vertices across all provided meshes by quantized position
        const welded = new Map<string, number>();
        const meshOffsets: number[][] = [];
        let weldCount = 0;

        for (let m = 0; m < vertices.length; m++) {
            const verts = vertices[m];
            const map: number[] = [];

            for (let i = 0; i < verts.length; i += 3) {
                const key = `${Math.round(verts[i] * 4096)},${Math.round(verts[i + 1] * 4096)},${Math.round(verts[i + 2] * 4096)}`;

                let index = welded.get(key);

                if (index === undefined) {
                    index = weldCount;
                    welded.set(key, index);
                    weldCount++;
                }

                map.push(index);
            }

            meshOffsets.push(map);
        }

        // count directed edge usage across all triangles
        const edgeUse = new Map<string, number>();

        for (let m = 0; m < indices.length; m++) {
            const inds = indices[m];
            const map = meshOffsets[m];

            for (let i = 0; i < inds.length; i += 3) {
                const a = map[inds[i]];
                const b = map[inds[i + 1]];
                const c = map[inds[i + 2]];

                for (const [p, q] of [[a, b], [b, c], [c, a]]) {
                    const key = `${p}>${q}`;
                    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
                }
            }
        }

        // every directed edge must appear exactly once, and its reverse must exist -
        // this proves the surface is closed with consistent winding
        for (const [key, count] of edgeUse) {
            expect(count).toEqual(1);

            const [p, q] = key.split(">");
            expect(edgeUse.get(`${q}>${p}`)).toEqual(1);
        }
    };

    /**
     * Computes the signed volume of a closed mesh - positive for meshes wound
     * counter-clockwise when viewed from the outside (right-handed convention).
     */
    const signedVolume = (vertices: Float32Array, indices: Uint32Array): number => {
        let volume = 0.0;

        for (let i = 0; i < indices.length; i += 3) {
            const ia = indices[i] * 3;
            const ib = indices[i + 1] * 3;
            const ic = indices[i + 2] * 3;

            const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
            const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
            const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];

            volume += (ax * ((by * cz) - (bz * cy))) + (ay * ((bz * cx) - (bx * cz))) + (az * ((bx * cy) - (by * cx)));
        }

        return volume / 6.0;
    };

    it('.computeGeometry() - empty chunk produces no geometry', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        const geometry = new VoxelSmoothGeometry();
        geometry.computeGeometry(chunk, world);

        expect(geometry.vertexCount).toEqual(0);
        expect(geometry.indexCount).toEqual(0);
        expect(geometry.vertices.length).toEqual(0);
        expect(geometry.normals.length).toEqual(0);
        expect(geometry.indices.length).toEqual(0);
    });

    it('.computeGeometry() - single BitVoxel produces a closed outward mesh', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // a single BitVoxel in the middle of the chunk
        chunk.setBitVoxel(VoxelIndex.from(2, 2, 2, 1, 1, 1));

        const geometry = new VoxelSmoothGeometry();
        geometry.computeGeometry(chunk, world);

        expect(geometry.vertexCount).toBeGreaterThan(0);
        expect(geometry.indexCount).toBeGreaterThan(0);
        expect(geometry.indexCount % 3).toEqual(0);

        // all indices must reference valid vertices
        const indices = geometry.indices;

        for (let i = 0; i < indices.length; i++) {
            expect(indices[i]).toBeLessThan(geometry.vertexCount);
        }

        // all normals must be unit length
        const normals = geometry.normals;

        for (let i = 0; i < normals.length; i += 3) {
            const length = Math.sqrt((normals[i] * normals[i]) + (normals[i + 1] * normals[i + 1]) + (normals[i + 2] * normals[i + 2]));

            expect(Math.abs(length - 1.0)).toBeLessThan(1e-5);
        }

        // the mesh must form a closed, consistently wound surface
        expectWatertight([geometry.vertices], [geometry.indices]);

        // default winding must be outward counter-clockwise (positive volume)
        expect(signedVolume(geometry.vertices, geometry.indices)).toBeGreaterThan(0);

        // BitVoxel (2,2,2)+(1,1,1) has absolute coordinate (9,9,9), its center in
        // output space is at (9.5, 9.5, 9.5) * 0.25 - normals must point away from it
        const vertices = geometry.vertices;
        const center = 9.5 * 0.25;

        for (let i = 0; i < vertices.length; i += 3) {
            const dot = (normals[i] * (vertices[i] - center)) + (normals[i + 1] * (vertices[i + 1] - center)) + (normals[i + 2] * (vertices[i + 2] - center));

            expect(dot).toBeGreaterThan(0);
        }
    });

    it('.computeGeometry() - flipped winding produces an inward mesh', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        chunk.setBitVoxel(VoxelIndex.from(2, 2, 2, 1, 1, 1));

        const geometry = new VoxelSmoothGeometry();
        geometry.computeGeometry(chunk, world, 0, true);

        // flipped winding must produce a negative signed volume
        expect(signedVolume(geometry.vertices, geometry.indices)).toBeLessThan(0);
    });

    it('.computeGeometry() - chunk seams are watertight with no duplicate quads', () => {
        const world = new VoxelWorld();
        const chunkA = new VoxelChunk0(MortonKey.from(1, 1, 1));
        const chunkB = new VoxelChunk0(MortonKey.from(2, 1, 1));

        world.insert(chunkA);
        world.insert(chunkB);

        // a solid 4x4x4 BitVoxel cube spanning the seam between the two chunks -
        // absolute BitVoxel x 14..17 (14,15 in chunkA and 0,1 in chunkB)
        for (let x = 14; x < 18; x++) {
            for (let y = 6; y < 10; y++) {
                for (let z = 6; z < 10; z++) {
                    const chunk = x < 16 ? chunkA : chunkB;
                    const lx = x & 15;

                    chunk.setBitVoxel(VoxelIndex.from(lx >> 2, y >> 2, z >> 2, lx & 3, y & 3, z & 3));
                }
            }
        }

        const geometryA = new VoxelSmoothGeometry();
        const geometryB = new VoxelSmoothGeometry();

        geometryA.computeGeometry(chunkA, world);
        geometryB.computeGeometry(chunkB, world);

        expect(geometryA.indexCount).toBeGreaterThan(0);
        expect(geometryB.indexCount).toBeGreaterThan(0);

        // chunkB's mesh is emitted in its own chunk-local space - offset it by the
        // chunk size (4.0 units) so both meshes share one coordinate space
        const verticesB = new Float32Array(geometryB.vertices);

        for (let i = 0; i < verticesB.length; i += 3) {
            verticesB[i] += 4.0;
        }

        // the combined mesh must form a single closed surface - any duplicated or
        // missing seam quad would break the exactly-once directed edge property
        expectWatertight([geometryA.vertices, verticesB], [geometryA.indices, geometryB.indices]);
    });

    it('.computeGeometry() - smoothing passes produce a smaller closed mesh', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // a solid 8x8x8 BitVoxel cube in the middle of the chunk
        for (let x = 4; x < 12; x++) {
            for (let y = 4; y < 12; y++) {
                for (let z = 4; z < 12; z++) {
                    chunk.setBitVoxel(VoxelIndex.from(x >> 2, y >> 2, z >> 2, x & 3, y & 3, z & 3));
                }
            }
        }

        const sharp = new VoxelSmoothGeometry();
        const smooth = new VoxelSmoothGeometry();

        sharp.computeGeometry(chunk, world, 0);
        smooth.computeGeometry(chunk, world, 2);

        expect(smooth.vertexCount).toBeGreaterThan(0);

        // the smoothed mesh must remain closed and consistently wound
        expectWatertight([smooth.vertices], [smooth.indices]);

        // smoothing rounds corners away, reducing the enclosed volume
        const sharpVolume = signedVolume(sharp.vertices, sharp.indices);
        const smoothVolume = signedVolume(smooth.vertices, smooth.indices);

        expect(smoothVolume).toBeGreaterThan(0);
        expect(smoothVolume).toBeLessThan(sharpVolume);
    });

    it('.computeGeometry() - diagonally touching BitVoxels resolve degenerate normals', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // two BitVoxels touching only at a corner - the surface cell between them
        // has a perfectly symmetric occupancy mask with a zero field gradient,
        // exercising the triangle-accumulated normal fallback
        chunk.setBitVoxel(VoxelIndex.from(2, 2, 2, 0, 0, 0));
        chunk.setBitVoxel(VoxelIndex.from(2, 2, 2, 1, 1, 1));

        const geometry = new VoxelSmoothGeometry();
        geometry.computeGeometry(chunk, world);

        expect(geometry.vertexCount).toBeGreaterThan(0);

        // every normal must still come out unit length
        const normals = geometry.normals;

        for (let i = 0; i < normals.length; i += 3) {
            const length = Math.sqrt((normals[i] * normals[i]) + (normals[i + 1] * normals[i + 1]) + (normals[i + 2] * normals[i + 2]));

            expect(Math.abs(length - 1.0)).toBeLessThan(1e-5);
        }
    });

    it('.computeGeometry() - repeated computes on one instance are deterministic', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        chunk.setBitVoxel(VoxelIndex.from(1, 2, 3, 0, 1, 2));
        chunk.setBitVoxel(VoxelIndex.from(1, 2, 3, 1, 1, 2));

        const geometry = new VoxelSmoothGeometry();

        geometry.computeGeometry(chunk, world);

        const firstVertices = new Float32Array(geometry.vertices);
        const firstIndices = new Uint32Array(geometry.indices);

        geometry.computeGeometry(chunk, world);

        expect(new Float32Array(geometry.vertices)).toEqual(firstVertices);
        expect(new Uint32Array(geometry.indices)).toEqual(firstIndices);
    });
});
