import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { VoxelSmoothGeometry, type SmoothOcclusionMode } from "../src/lib/engine/geometry/voxel-smooth-geometry.js";
import { VoxelQuadGeometry } from "../src/lib/engine/geometry/voxel-quad-geometry.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { BVXGeometry } from "../src/lib/geometry/bvx-geometry.js";
import { BVXSerializer } from "../src/lib/serialize/bvx-serializer.js";
import { BVXMesher, MesherResponse, MesherRequest } from "../src/lib/worker/bvx-mesher.js";
import { BVXWorkerHost, MesherScope } from "../src/lib/worker/bvx-worker-host.js";

/**
 * Provides coverage for bvx-mesher.ts and bvx-worker-host.ts
 */
describe('BVXMesher', () => {

    /**
     * Builds a small world with a single populated chunk and returns the world
     * along with the chunk.
     */
    const buildWorld = () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 2, 1, 1));

        world.insert(chunk);

        return { world: world, chunk: chunk };
    };

    it('.process() - faces request matches direct geometry generation', () => {
        const { world, chunk } = buildWorld();
        const mesher = new BVXMesher();

        const response = mesher.process({
            id: 7,
            type: "faces",
            chunkKey: chunk.key.key,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        });

        expect(response.id).toEqual(7);
        expect(response.type).toEqual("faces");
        expect(response.chunkKey).toEqual(chunk.key.key);

        // compare against geometry generated directly on this thread
        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        if (response.type === "faces") {
            expect(new Uint8Array(response.faceMasks)).toEqual(new Uint8Array(geometry.indices));
            expect(new Uint32Array(response.indices)).toEqual(BVXGeometry.getIndices(geometry, false));
        }
    });

    it('.process() - smooth request matches direct geometry generation', () => {
        const { world, chunk } = buildWorld();
        const mesher = new BVXMesher();

        const response = mesher.process({
            id: 9,
            type: "smooth",
            chunkKey: chunk.key.key,
            smoothing: 1,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        });

        expect(response.id).toEqual(9);
        expect(response.type).toEqual("smooth");

        // compare against geometry generated directly on this thread
        const geometry = new VoxelSmoothGeometry();
        geometry.computeGeometry(chunk, world, 1, false);

        if (response.type === "smooth") {
            expect(new Float32Array(response.vertices)).toEqual(new Float32Array(geometry.vertices));
            expect(new Float32Array(response.normals)).toEqual(new Float32Array(geometry.normals));
            expect(new Uint32Array(response.indices)).toEqual(new Uint32Array(geometry.indices));
        }
    });

    it('.process() - unknown chunk keys produce empty geometry', () => {
        const { world } = buildWorld();
        const mesher = new BVXMesher();
        const missingKey = MortonKey.from(9, 9, 9).key;

        const faces = mesher.process({
            id: 1,
            type: "faces",
            chunkKey: missingKey,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        });

        const smooth = mesher.process({
            id: 2,
            type: "smooth",
            chunkKey: missingKey,
            smoothing: 0,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        });

        if (faces.type === "faces") {
            expect(faces.faceMasks.length).toEqual(0);
            expect(faces.indices.length).toEqual(0);
        }

        if (smooth.type === "smooth") {
            expect(smooth.vertices.length).toEqual(0);
            expect(smooth.indices.length).toEqual(0);
        }
    });

    it('.process() - indices: false skips the triangle indices but keeps the masks', () => {
        const { world, chunk } = buildWorld();
        const mesher = new BVXMesher();

        const base: MesherRequest = {
            id: 1,
            type: "faces",
            chunkKey: chunk.key.key,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        };

        const withIndices = mesher.process(base);
        const without = mesher.process({ ...base, indices: false, world: BVXSerializer.saveWorld(world) });

        if (withIndices.type !== "faces" || without.type !== "faces") {
            throw new Error("expected faces responses");
        }

        // the opted-out response carries no indices at all
        expect(withIndices.indices.length).toBeGreaterThan(0);
        expect(without.indices.length).toEqual(0);

        // everything a renderer building its own index buffer needs is unchanged
        expect(without.faceCount).toEqual(withIndices.faceCount);
        expect(Array.from(without.touched)).toEqual(Array.from(withIndices.touched));
        expect(Array.from(without.faceMasks)).toEqual(Array.from(withIndices.faceMasks));

        // and the empty buffer is not offered up for transfer
        expect(BVXMesher.transferables(without).length).toEqual(2);
    });

    it('.transferables() - collects the response buffers', () => {
        const { world, chunk } = buildWorld();
        const mesher = new BVXMesher();

        const faces = mesher.process({
            id: 1,
            type: "faces",
            chunkKey: chunk.key.key,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        });

        const smooth = mesher.process({
            id: 2,
            type: "smooth",
            chunkKey: chunk.key.key,
            smoothing: 0,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        });

        // faceMasks, touched and indices
        expect(BVXMesher.transferables(faces).length).toEqual(3);
        expect(BVXMesher.transferables(smooth).length).toEqual(3);
    });

    /**
     * Fills a box of BitVoxels (inclusive min, exclusive max) into a chunk.
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

    /**
     * Snapshots a chunk and its 26 neighbours from the provided world, exactly as
     * an application driving the mesher per chunk does.
     */
    const snapshot = (world: VoxelWorld, key: MortonKey): Uint8Array | null => {
        const region = new VoxelWorld();
        const scratch = new MortonKey();
        let count = 0;

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const chunk = world.get(MortonKey.from(key.x + ox, key.y + oy, key.z + oz, scratch));

                    if (chunk !== null) {
                        region.insert(chunk);
                        count++;
                    }
                }
            }
        }

        return count > 0 ? BVXSerializer.saveWorld(region) : null;
    };

    it('.process() - smooth occluded lane meshes chunks it holds no voxels at, seam-correct', () => {
        // Water running up to a chunk border with no water in the neighbouring
        // chunk. The patch's taper continues into that chunk, so the lane meshes
        // the merged set - the mesher must supply an empty centre chunk there, and
        // the chunk holding the water must yield the shared seam to it rather than
        // emitting it as well.
        const mesher = new BVXMesher();

        // both border directions - the water in the lower chunk tapering up into
        // the empty one, and in the upper chunk tapering down into it. The second
        // is the case where a meshed chunk's NEGATIVE neighbour is occluder-only,
        // which is what decides seam ownership.
        const placements: [boolean, number][] = [[true, 1], [false, 1], [true, 2], [false, 2], [true, 3], [false, 3]];

        for (const [waterInLowerChunk, smoothing] of placements) {
            const keyA = MortonKey.from(1, 1, 1);
            const keyB = MortonKey.from(2, 1, 1);

            const terrain = new VoxelWorld();
            const terrainA = new VoxelChunk0(keyA.clone());
            const terrainB = new VoxelChunk0(keyB.clone());

            terrain.insert(terrainA);
            terrain.insert(terrainB);
            fillBox(terrainA, 0, 2, 0, 16, 6, 16);
            fillBox(terrainB, 0, 2, 0, 16, 6, 16);

            const water = new VoxelWorld();

            if (waterInLowerChunk) {
                const waterA = new VoxelChunk0(keyA.clone());

                water.insert(waterA);
                fillBox(waterA, 6, 6, 4, 16, 8, 12);
            }
            else {
                const waterB = new VoxelChunk0(keyB.clone());

                water.insert(waterB);
                fillBox(waterB, 0, 6, 4, 10, 8, 12);
            }

            // mesh both lanes over the merged chunk set
            const meshLane = (own: VoxelWorld, occluders: VoxelWorld | null, mode: SmoothOcclusionMode) => {
                const positions = new Set<string>();
                const triangles: string[][] = [];

                for (const key of [keyA, keyB]) {
                    const worldSnapshot = snapshot(own, key);

                    if (worldSnapshot === null) {
                        continue;
                    }

                    const request: MesherRequest = {
                        id: 0,
                        type: "smooth",
                        chunkKey: key.key,
                        smoothing: smoothing,
                        flipped: false,
                        world: worldSnapshot
                    };

                    if (occluders !== null) {
                        const occluderSnapshot = snapshot(occluders, key);

                        if (occluderSnapshot !== null) {
                            request.occluders = occluderSnapshot;
                            request.occlusionMode = mode;
                        }
                    }

                    const response = mesher.process(request);

                    if (response.type !== "smooth") {
                        continue;
                    }

                    // world space, quantized to absorb the last-bit difference
                    // between the two chunks' local-space seam computations
                    const local: string[] = [];

                    for (let i = 0; i < response.vertices.length; i += 3) {
                        const p = `${Math.round((response.vertices[i] + (key.x * 4)) * 4096)},${Math.round((response.vertices[i + 1] + (key.y * 4)) * 4096)},${Math.round((response.vertices[i + 2] + (key.z * 4)) * 4096)}`;

                        local.push(p);
                        positions.add(p);
                    }

                    for (let i = 0; i < response.indices.length; i += 3) {
                        triangles.push([local[response.indices[i]], local[response.indices[i + 1]], local[response.indices[i + 2]]]);
                    }
                }

                return { positions: positions, triangles: triangles };
            };

            const terrainMesh = meshLane(terrain, null, "primary");
            const waterMesh = meshLane(water, terrain, "overlay");

            expect(waterMesh.triangles.length).toBeGreaterThan(0);

            // no seam quad may be emitted by both chunks
            const seen = new Set<string>();

            for (const triangle of waterMesh.triangles) {
                const key = Array.from(triangle).sort().join("/");

                expect(seen.has(key)).toEqual(false);
                seen.add(key);
            }

            // the patch rim must land exactly on the terrain surface
            const edgeUse = new Map<string, number>();

            for (const [a, b, c] of waterMesh.triangles) {
                for (const [p, q] of [[a, b], [b, c], [c, a]]) {
                    const edge = p < q ? `${p}|${q}` : `${q}|${p}`;

                    edgeUse.set(edge, (edgeUse.get(edge) ?? 0) + 1);
                }
            }

            let rimCount = 0;

            for (const [edge, count] of edgeUse) {
                if (count !== 1) {
                    continue;
                }

                rimCount++;

                for (const position of edge.split("|")) {
                    expect(terrainMesh.positions.has(position)).toEqual(true);
                }
            }

            expect(rimCount).toBeGreaterThan(0);
        }
    });

    it('BVXWorkerHost.attach() - processes messages through a worker-like scope', () => {
        const { world, chunk } = buildWorld();

        // a minimal fake worker scope, standing in for a real Web Worker
        const posted: { message: MesherResponse, transfer?: ArrayBuffer[] }[] = [];

        const scope: MesherScope = {
            onmessage: null,
            postMessage: (message: MesherResponse, transfer?: ArrayBuffer[]): void => {
                posted.push({ message: message, transfer: transfer });
            }
        };

        new BVXWorkerHost().attach(scope);

        expect(scope.onmessage).not.toBeNull();

        const request: MesherRequest = {
            id: 42,
            type: "smooth",
            chunkKey: chunk.key.key,
            smoothing: 0,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        };

        (scope.onmessage as (event: { data: MesherRequest }) => void)({ data: request });

        expect(posted.length).toEqual(1);
        expect(posted[0].message.id).toEqual(42);
        expect(posted[0].message.type).toEqual("smooth");
        expect(posted[0].transfer?.length).toEqual(3);
    });
    it('.process() - the faces response carries the touched list and face count', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        // three isolated BitVoxels, fully exposed
        chunk.setBitVoxel(VoxelIndex.from(0, 0, 0, 1, 1, 1));
        chunk.setBitVoxel(VoxelIndex.from(2, 2, 2, 0, 0, 0));
        chunk.setBitVoxel(VoxelIndex.from(3, 3, 3, 3, 3, 3));
        world.insert(chunk);

        const mesher = new BVXMesher();
        const response = mesher.process({
            id: 1,
            type: "faces",
            chunkKey: chunk.key.key,
            flipped: false,
            world: BVXSerializer.saveWorld(world)
        });

        if (response.type !== "faces") {
            throw new Error("expected a faces response");
        }

        expect(response.faceCount).toEqual(18);
        expect(response.touched.length).toEqual(3);

        // the touched list must be ascending and agree with the mask buffer
        let nonZero = 0;

        for (let i = 0; i < response.faceMasks.length; i++) {
            if (response.faceMasks[i] !== 0) {
                nonZero++;
            }
        }

        expect(nonZero).toEqual(response.touched.length);

        for (let t = 0; t < response.touched.length; t++) {
            expect(response.faceMasks[response.touched[t]]).toEqual(63);

            if (t > 0) {
                expect(response.touched[t]).toBeGreaterThan(response.touched[t - 1]);
            }
        }
    });

    it('.process() - quads request matches direct quad generation', () => {
        const { world, chunk } = buildWorld();
        const mesher = new BVXMesher();

        const response = mesher.process({
            id: 11,
            type: "quads",
            chunkKey: chunk.key.key,
            world: BVXSerializer.saveWorld(world)
        });

        expect(response.id).toEqual(11);
        expect(response.type).toEqual("quads");

        const reference = new VoxelQuadGeometry();

        reference.computeQuads(chunk, world);

        if (response.type === "quads") {
            expect(response.chunkKey).toEqual(chunk.key.key);
            expect(Array.from(response.quads)).toEqual(Array.from(reference.quads));

            // VoxelChunk0 carries no meta-data, so the response reports none
            expect(response.meta.length).toEqual(0);
        }
    });

    it('.process() - quads request reports meta-data for a chunk that has it', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(2, 2, 2));

        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));
        chunk.setMetaData(VoxelIndex.from(1, 1, 1, 1, 1, 1), 0xABCD1234);

        world.insert(chunk);

        const mesher = new BVXMesher();

        const response = mesher.process({
            id: 12,
            type: "quads",
            chunkKey: chunk.key.key,
            world: BVXSerializer.saveWorld(world)
        });

        if (response.type === "quads") {
            expect(response.meta.length).toEqual(64);

            // a quad resolves its material as meta[index >> 6]
            const quad = response.quads[0];
            const index = VoxelQuadGeometry.indexOf(quad);

            expect(response.meta[index >> 6]).toEqual(0xABCD1234);
        }
    });

    it('.process() - quads request on an unknown chunk returns empty buffers', () => {
        const { world } = buildWorld();
        const mesher = new BVXMesher();

        const response = mesher.process({
            id: 13,
            type: "quads",
            chunkKey: MortonKey.from(9, 9, 9).key,
            world: BVXSerializer.saveWorld(world)
        });

        if (response.type === "quads") {
            expect(response.quads.length).toEqual(0);
            expect(response.meta.length).toEqual(0);
        }

        // an empty response contributes no transferables
        expect(BVXMesher.transferables(response).length).toEqual(0);
    });

    it('.transferables() - a quads response transfers its two buffers', () => {
        const { world, chunk } = buildWorld();
        const mesher = new BVXMesher();

        const response = mesher.process({
            id: 14,
            type: "quads",
            chunkKey: chunk.key.key,
            world: BVXSerializer.saveWorld(world)
        });

        const buffers = BVXMesher.transferables(response);

        // VoxelChunk0 has no meta-data, so only the quad buffer is transferred
        expect(buffers.length).toEqual(1);

        if (response.type === "quads") {
            expect(buffers[0]).toBe(response.quads.buffer);
        }
    });
});
