import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { VoxelSmoothGeometry } from "../src/lib/engine/geometry/voxel-smooth-geometry.js";
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

        expect(BVXMesher.transferables(faces).length).toEqual(2);
        expect(BVXMesher.transferables(smooth).length).toEqual(3);
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
});
