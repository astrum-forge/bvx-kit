import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelSmoothGeometry, type SmoothOcclusionMode } from "../src/lib/engine/geometry/voxel-smooth-geometry.js";

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

    /**
     * Fills a box of BitVoxels (inclusive min, exclusive max) into the chunk.
     */
    const fillBox = (chunk: VoxelChunk0, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void => {
        for (let x = minX; x < maxX; x++) {
            for (let y = minY; y < maxY; y++) {
                for (let z = minZ; z < maxZ; z++) {
                    chunk.setBitVoxel(VoxelIndex.from(x >> 2, y >> 2, z >> 2, x & 3, y & 3, z & 3));
                }
            }
        }
    };

    it('.computeGeometry() - occluder-only occupancy produces no geometry', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // the own chunk is empty - all occupancy belongs to the occluders
        const occluders = new VoxelWorld();
        const occluderChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        occluders.insert(occluderChunk);
        fillBox(occluderChunk, 4, 4, 4, 12, 12, 12);

        const geometry = new VoxelSmoothGeometry();
        geometry.computeGeometry(chunk, world, 0, false, occluders);

        // the occluders' surface pieces are skipped and their vertices compacted away
        expect(geometry.indexCount).toEqual(0);
        expect(geometry.vertexCount).toEqual(0);
    });

    it('.computeGeometry() - occluded interface emits no surface', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // an own slab resting on an occluder slab
        fillBox(chunk, 4, 8, 4, 12, 10, 12);

        const occluders = new VoxelWorld();
        const occluderChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        occluders.insert(occluderChunk);
        fillBox(occluderChunk, 4, 6, 4, 12, 8, 12);

        const standalone = new VoxelSmoothGeometry();
        const occluded = new VoxelSmoothGeometry();

        standalone.computeGeometry(chunk, world, 0, false);
        occluded.computeGeometry(chunk, world, 0, false, occluders);

        // the downward-facing interface surface is culled
        expect(occluded.indexCount).toBeGreaterThan(0);
        expect(occluded.indexCount).toBeLessThan(standalone.indexCount);

        // compaction sanity - all indices reference valid vertices, all normals unit
        const indices = occluded.indices;

        for (let i = 0; i < indices.length; i++) {
            expect(indices[i]).toBeLessThan(occluded.vertexCount);
        }

        const normals = occluded.normals;

        for (let i = 0; i < normals.length; i += 3) {
            const length = Math.sqrt((normals[i] * normals[i]) + (normals[i + 1] * normals[i + 1]) + (normals[i + 2] * normals[i + 2]));

            expect(Math.abs(length - 1.0)).toBeLessThan(1e-5);
        }
    });

    it('.computeGeometry() - primary/secondary layers partition one watertight union surface', () => {
        for (const smoothing of [0, 2]) {
            // one solid box split between two mutually-occluding worlds
            const worldA = new VoxelWorld();
            const worldB = new VoxelWorld();
            const merged = new VoxelWorld();

            const chunkA = new VoxelChunk0(MortonKey.from(1, 1, 1));
            const chunkB = new VoxelChunk0(MortonKey.from(1, 1, 1));
            const chunkM = new VoxelChunk0(MortonKey.from(1, 1, 1));

            worldA.insert(chunkA);
            worldB.insert(chunkB);
            merged.insert(chunkM);

            fillBox(chunkA, 4, 4, 4, 8, 10, 12);
            fillBox(chunkB, 8, 4, 4, 12, 10, 12);
            fillBox(chunkM, 4, 4, 4, 12, 10, 12);

            const geometryA = new VoxelSmoothGeometry();
            const geometryB = new VoxelSmoothGeometry();
            const geometryM = new VoxelSmoothGeometry();

            geometryA.computeGeometry(chunkA, worldA, smoothing, false, worldB, "primary");
            geometryB.computeGeometry(chunkB, worldB, smoothing, false, worldA, "secondary");
            geometryM.computeGeometry(chunkM, merged, smoothing, false);

            expect(geometryA.indexCount).toBeGreaterThan(0);
            expect(geometryB.indexCount).toBeGreaterThan(0);

            // both layers contour the identical merged field, so their pieces must
            // sum exactly to the standalone union mesh with no duplicates or holes
            expect(geometryA.indexCount + geometryB.indexCount).toEqual(geometryM.indexCount);

            // the combined mesh must form a single closed, consistently wound surface
            expectWatertight(
                [geometryA.vertices, geometryB.vertices],
                [geometryA.indices, geometryB.indices]
            );
        }
    });

    /**
     * Collects the vertex positions on the open boundary of a mesh - the endpoints
     * of undirected edges used by exactly one triangle.
     */
    const boundaryPositions = (vertices: Float32Array, indices: Uint32Array): string[] => {
        const edgeUse = new Map<string, number>();

        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i];
            const b = indices[i + 1];
            const c = indices[i + 2];

            for (const [p, q] of [[a, b], [b, c], [c, a]]) {
                const key = p < q ? `${p}|${q}` : `${q}|${p}`;

                edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
            }
        }

        const positions = new Set<string>();

        for (const [key, count] of edgeUse) {
            if (count !== 1) {
                continue;
            }

            for (const part of key.split("|")) {
                const v = Number(part) * 3;

                positions.add(`${vertices[v]},${vertices[v + 1]},${vertices[v + 2]}`);
            }
        }

        return Array.from(positions);
    };

    it('.computeGeometry() - overlay patch rim welds exactly onto the occluder surface', () => {
        // a shoreline inside one chunk - a terrain shelf with a raised ridge, and
        // a water pool resting on the shelf against the ridge
        for (const smoothing of [0, 1, 2]) {
            const terrainWorld = new VoxelWorld();
            const terrainChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

            terrainWorld.insert(terrainChunk);
            fillBox(terrainChunk, 3, 2, 3, 13, 6, 13);
            fillBox(terrainChunk, 9, 6, 3, 13, 9, 13);

            const waterWorld = new VoxelWorld();
            const waterChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

            waterWorld.insert(waterChunk);
            fillBox(waterChunk, 3, 6, 3, 9, 8, 13);

            const terrain = new VoxelSmoothGeometry();
            const water = new VoxelSmoothGeometry();

            // the terrain lane meshes standalone - water never occludes it, so the
            // ground stays visible through the translucent surface
            terrain.computeGeometry(terrainChunk, terrainWorld, smoothing, false);
            water.computeGeometry(waterChunk, waterWorld, smoothing, false, terrainWorld, "overlay");

            expect(water.indexCount).toBeGreaterThan(0);
            expect(terrain.indexCount).toBeGreaterThan(0);

            // the water patch is an open surface - it must have a rim
            const rim = boundaryPositions(water.vertices, water.indices);

            expect(rim.length).toBeGreaterThan(0);

            // every rim vertex must coincide EXACTLY with a terrain mesh vertex.
            // Where the water field is zero the merged field is bit-identical to
            // the terrain field, so the contoured vertices match to the last bit -
            // a floating rim (the visible shoreline gap) would fail here.
            const terrainVertices = terrain.vertices;
            const terrainPositions = new Set<string>();

            for (let i = 0; i < terrainVertices.length; i += 3) {
                terrainPositions.add(`${terrainVertices[i]},${terrainVertices[i + 1]},${terrainVertices[i + 2]}`);
            }

            for (const position of rim) {
                expect(terrainPositions.has(position)).toEqual(true);
            }
        }
    });

    /**
     * Meshes the provided chunk keys of a lane and returns the triangles as
     * quantized world-space position triples (a chunk spans 4.0 units).
     *
     * A chunk-seam vertex is computed in each chunk's own local space, so the two
     * world positions differ in the last float bits. Quantizing to 1/4096 of a
     * unit welds that ~1e-7 noise while staying far below any visible gap.
     */
    const meshLaneChunks = (
        keys: MortonKey[],
        world: VoxelWorld,
        smoothing: number,
        occluders: VoxelWorld | null,
        mode: SmoothOcclusionMode
    ): { positions: Set<string>, triangles: string[][] } => {
        const geometry = new VoxelSmoothGeometry();
        const positions = new Set<string>();
        const triangles: string[][] = [];

        for (const key of keys) {
            let chunk = world.get(key);

            // the lane may own surface in a chunk it holds no voxels at - the
            // tapering rim of the patch. BVXMesher does this same substitution.
            if (chunk === null) {
                const empty = new VoxelChunk0(key.clone());

                world.insert(empty);
                chunk = empty;
            }

            geometry.computeGeometry(chunk, world, smoothing, false, occluders, mode);

            const ox = key.x * 4.0;
            const oy = key.y * 4.0;
            const oz = key.z * 4.0;

            const vertices = geometry.vertices;
            const indices = geometry.indices;
            const local: string[] = [];

            for (let i = 0; i < vertices.length; i += 3) {
                const p = `${Math.round((vertices[i] + ox) * 4096)},${Math.round((vertices[i + 1] + oy) * 4096)},${Math.round((vertices[i + 2] + oz) * 4096)}`;

                local.push(p);
                positions.add(p);
            }

            for (let i = 0; i < indices.length; i += 3) {
                triangles.push([local[indices[i]], local[indices[i + 1]], local[indices[i + 2]]]);
            }
        }

        return { positions, triangles };
    };

    /**
     * Returns the vertex positions on the open boundary of a triangle soup - the
     * endpoints of undirected edges used by exactly one triangle.
     */
    const soupRim = (triangles: string[][]): string[] => {
        const edgeUse = new Map<string, number>();

        for (const [a, b, c] of triangles) {
            for (const [p, q] of [[a, b], [b, c], [c, a]]) {
                const key = p < q ? `${p}|${q}` : `${q}|${p}`;

                edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
            }
        }

        const rim = new Set<string>();

        for (const [key, count] of edgeUse) {
            if (count === 1) {
                for (const part of key.split("|")) {
                    rim.add(part);
                }
            }
        }

        return Array.from(rim);
    };

    it('.computeGeometry() - overlay patch rim welds across a chunk border', () => {
        // water running right up to a chunk border, with the neighbouring chunk
        // holding no water at all - the patch's taper continues into it, so the
        // lane must mesh the merged chunk set for the rim to land on the terrain
        for (const smoothing of [1, 2, 3]) {
            const keyA = MortonKey.from(1, 1, 1);
            const keyB = MortonKey.from(2, 1, 1);

            const terrainWorld = new VoxelWorld();
            const terrainA = new VoxelChunk0(keyA.clone());
            const terrainB = new VoxelChunk0(keyB.clone());

            terrainWorld.insert(terrainA);
            terrainWorld.insert(terrainB);
            fillBox(terrainA, 0, 2, 0, 16, 6, 16);
            fillBox(terrainB, 0, 2, 0, 16, 6, 16);

            const waterWorld = new VoxelWorld();
            const waterA = new VoxelChunk0(keyA.clone());

            waterWorld.insert(waterA);
            fillBox(waterA, 6, 6, 4, 16, 8, 12);

            const terrain = meshLaneChunks([keyA, keyB], terrainWorld, smoothing, null, "primary");
            const water = meshLaneChunks([keyA, keyB], waterWorld, smoothing, terrainWorld, "overlay");

            expect(water.triangles.length).toBeGreaterThan(0);

            const rim = soupRim(water.triangles);

            expect(rim.length).toBeGreaterThan(0);

            // no rim vertex may float - each must coincide with a terrain vertex
            for (const position of rim) {
                expect(terrain.positions.has(position)).toEqual(true);
            }
        }
    });

    it('.computeGeometry() - primary/secondary partition stays watertight across a chunk border', () => {
        // one solid body split between two mutually-occluding lanes, arranged so
        // each lane has a chunk the other does not - the partition must still
        // cover the union surface exactly once
        for (const smoothing of [0, 2]) {
            const keyA = MortonKey.from(1, 1, 1);
            const keyB = MortonKey.from(2, 1, 1);

            const groundWorld = new VoxelWorld();
            const groundA = new VoxelChunk0(keyA.clone());

            groundWorld.insert(groundA);
            fillBox(groundA, 4, 4, 4, 16, 8, 12);

            const pileWorld = new VoxelWorld();
            const pileB = new VoxelChunk0(keyB.clone());

            pileWorld.insert(pileB);
            fillBox(pileB, 0, 4, 4, 8, 8, 12);

            const keys = [keyA, keyB];
            const ground = meshLaneChunks(keys, groundWorld, smoothing, pileWorld, "primary");
            const pile = meshLaneChunks(keys, pileWorld, smoothing, groundWorld, "secondary");

            expect(ground.triangles.length).toBeGreaterThan(0);
            expect(pile.triangles.length).toBeGreaterThan(0);

            // the two lanes together must form one closed surface - a lost quad
            // (a hole) or a duplicated one both break the rim being empty
            const combined = soupRim(ground.triangles.concat(pile.triangles));

            expect(combined).toEqual([]);
        }
    });

    it('.computeGeometry() - overlay mode culls hidden pieces without opening the own surface', () => {
        for (const smoothing of [0, 2]) {
            const world = new VoxelWorld();
            const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

            world.insert(chunk);

            // a translucent slab (water) resting on opaque ground
            fillBox(chunk, 4, 8, 4, 12, 10, 12);

            const occluders = new VoxelWorld();
            const occluderChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

            occluders.insert(occluderChunk);
            fillBox(occluderChunk, 2, 4, 2, 14, 8, 14);

            // the union of both worlds, meshed standalone as the reference surface
            const merged = new VoxelWorld();
            const mergedChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

            merged.insert(mergedChunk);
            fillBox(mergedChunk, 4, 8, 4, 12, 10, 12);
            fillBox(mergedChunk, 2, 4, 2, 14, 8, 14);

            const standalone = new VoxelSmoothGeometry();
            const overlaid = new VoxelSmoothGeometry();
            const reference = new VoxelSmoothGeometry();

            standalone.computeGeometry(chunk, world, smoothing, false);
            overlaid.computeGeometry(chunk, world, smoothing, false, occluders, "overlay");
            reference.computeGeometry(mergedChunk, merged, smoothing, false);

            // the exposed skin remains, but the ground-owned pieces of the union
            // surface are never claimed
            expect(overlaid.indexCount).toBeGreaterThan(0);
            expect(overlaid.indexCount).toBeLessThan(reference.indexCount);

            // without blur the ownership rule is exact - only the hidden contact
            // surface is culled from the standalone water mesh
            if (smoothing === 0) {
                expect(overlaid.indexCount).toBeLessThan(standalone.indexCount);
            }

            // compaction sanity - all indices reference valid vertices
            const indices = overlaid.indices;

            for (let i = 0; i < indices.length; i++) {
                expect(indices[i]).toBeLessThan(overlaid.vertexCount);
            }
        }
    });
});
