import { describe, expect, it } from '@jest/globals';
import { BVXPhysicsRunner, PhysicsStepResponse, PhysicsLayerDelta } from "../src/lib/worker/bvx-physics-runner.js";
import { BVXPhysicsHost, PhysicsScope } from "../src/lib/worker/bvx-physics-host.js";
import { PhysicsRequest, PhysicsResponse } from "../src/lib/worker/bvx-physics-runner.js";
import { VoxelPhysics } from "../src/lib/engine/physics/voxel-physics.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { BVXSerializer } from "../src/lib/serialize/bvx-serializer.js";

/**
 * Provides coverage for bvx-physics-runner.ts and bvx-physics-host.ts
 */
describe('BVXPhysicsRunner', () => {

    const BOUNDS = { maxX: 63, maxY: 63, maxZ: 63 };

    /**
     * Attaches a runner with the requested layers over an empty collision world.
     */
    const attached = (layers = [VoxelPhysics.SAND]) => {
        const runner = new BVXPhysicsRunner();

        runner.process({ id: 1, type: "attach", bounds: BOUNDS, layers });

        return runner;
    };

    /**
     * Flattens coordinate triples into the wire format.
     */
    const coords = (...triples: number[][]): Int32Array => {
        return Int32Array.from(triples.flat());
    };

    /**
     * Rebuilds a layer's world from a step response, the way a renderer would.
     */
    const applyDelta = (world: VoxelWorld, delta: PhysicsLayerDelta): void => {
        for (let i = 0; i < delta.removed.length; i++) {
            world.remove(new MortonKey(delta.removed[i]));
        }

        for (let i = 0; i < delta.keys.length; i++) {
            world.insert(BVXSerializer.loadChunk(delta.chunks[i]));
        }
    };

    it('.process() - rejects anything before an attach request', () => {
        const runner = new BVXPhysicsRunner();

        expect(runner.physics).toBeNull();
        expect(() => runner.process({ id: 1, type: "step" })).toThrow(Error);
        expect(() => runner.process({ id: 1, type: "edit", set: coords([0, 0, 0]) })).toThrow(Error);
        expect(() => runner.process({ id: 1, type: "inject", layer: 0, set: coords([0, 0, 0]) })).toThrow(Error);
    });

    it('.process() - attach builds the simulation and its layers', () => {
        const runner = attached([VoxelPhysics.SAND, VoxelPhysics.WATER]);
        const response = runner.process({ id: 7, type: "attach", bounds: BOUNDS, layers: [VoxelPhysics.SAND, VoxelPhysics.WATER] });

        expect(response).toEqual({ id: 7, type: "ack", request: "attach" });
        expect(runner.physics).not.toBeNull();
        expect(runner.layers.length).toEqual(2);
        expect(runner.layers[0].density).toEqual(VoxelPhysics.SAND.density);
        expect(runner.layers[1].flow).toEqual(true);
    });

    it('.process() - attach seeds the collision world and the grain state', () => {
        // a floor two BitVoxels below where the grain starts
        const base = new VoxelWorld();
        const floor = new VoxelChunk0(MortonKey.from(0, 0, 0));

        for (let x = 0; x < 4; x++) {
            for (let z = 0; z < 4; z++) {
                floor.setBitVoxel(VoxelIndex.from(x >> 2, 0, z >> 2, x & 3, 0, z & 3));
            }
        }

        base.insert(floor);

        // an existing grain, three BitVoxels up
        const grains = new VoxelWorld();
        const grainChunk = new VoxelChunk0(MortonKey.from(0, 0, 0));

        grainChunk.setBitVoxel(VoxelIndex.from(0, 0, 0, 1, 3, 1));
        grains.insert(grainChunk);

        const runner = new BVXPhysicsRunner();

        runner.process({
            id: 1,
            type: "attach",
            bounds: BOUNDS,
            layers: [VoxelPhysics.SAND],
            base: BVXSerializer.saveWorld(base),
            grains: [BVXSerializer.saveWorld(grains)]
        });

        expect(runner.layers[0].length).toEqual(1);
        expect(runner.layers[0].get(1, 3, 1)).toEqual(1);

        // it falls, and stops on the seeded floor rather than passing through it
        runner.process({ id: 2, type: "step", ticks: 10 });

        expect(runner.layers[0].get(1, 1, 1)).toEqual(1);
        expect(runner.layers[0].length).toEqual(1);
    });

    it('.process() - inject adds and removes grains', () => {
        const runner = attached();

        runner.process({ id: 2, type: "inject", layer: 0, set: coords([1, 20, 1], [2, 20, 2], [3, 20, 3]) });

        expect(runner.layers[0].length).toEqual(3);

        runner.process({ id: 3, type: "inject", layer: 0, unset: coords([2, 20, 2]) });

        expect(runner.layers[0].length).toEqual(2);
        expect(runner.layers[0].get(2, 20, 2)).toEqual(0);

        expect(() => runner.process({ id: 4, type: "inject", layer: 9, set: coords([0, 0, 0]) })).toThrow(RangeError);
    });

    it('.process() - edit changes the collision world and wakes resting grains', () => {
        const runner = attached();

        // a 3x3 platform - sand slides diagonally, so a single BitVoxel is not
        // stable support and the grain would just roll off it
        const platform: number[][] = [];

        for (let x = 0; x < 3; x++) {
            for (let z = 0; z < 3; z++) {
                platform.push([x, 10, z]);
            }
        }

        runner.process({ id: 2, type: "edit", set: coords(...platform) });
        runner.process({ id: 3, type: "inject", layer: 0, set: coords([1, 11, 1]) });
        runner.process({ id: 4, type: "step", ticks: 20 });

        // it settled on the platform
        expect(runner.layers[0].get(1, 11, 1)).toEqual(1);
        expect(runner.layers[0].activeCount).toEqual(0);

        // remove the platform - the grain must notice and resume falling
        runner.process({ id: 5, type: "edit", unset: coords(...platform) });

        expect(runner.layers[0].activeCount).toBeGreaterThan(0);

        runner.process({ id: 6, type: "step", ticks: 20 });

        expect(runner.layers[0].get(1, 11, 1)).toEqual(0);
        expect(runner.layers[0].get(1, 0, 1)).toEqual(1);
    });

    it('.process() - step reports deltas that reconstruct the layer world', () => {
        const runner = attached();

        runner.process({ id: 2, type: "inject", layer: 0, set: coords([1, 40, 1], [2, 40, 2], [40, 40, 40]) });

        const mirror = new VoxelWorld();

        // drive to rest, applying every delta as a renderer would
        for (let i = 0; i < 200; i++) {
            const response = runner.process({ id: 10 + i, type: "step" }) as PhysicsStepResponse;

            expect(response.type).toEqual("step");
            expect(response.layers.length).toEqual(1);

            applyDelta(mirror, response.layers[0]);

            if (runner.layers[0].activeCount === 0) {
                break;
            }
        }

        expect(runner.layers[0].activeCount).toEqual(0);

        // the mirror matches the runner's own layer world, BitVoxel for BitVoxel
        const source = runner.layers[0].world;
        const index = new VoxelIndex();

        let compared = 0;

        for (const chunk of source.chunks.values()) {
            const mirrored = mirror.get(chunk.key);

            expect(mirrored).not.toBeNull();

            for (let i = 0; i < 4096; i++) {
                index.key = i;

                expect((mirrored as VoxelChunk0).getBitVoxel(index)).toEqual(chunk.getBitVoxel(index));
            }

            compared++;
        }

        expect(compared).toBeGreaterThan(0);
    });

    it('.process() - a settled simulation sends nothing', () => {
        const runner = attached();

        runner.process({ id: 2, type: "inject", layer: 0, set: coords([1, 20, 1]) });

        for (let i = 0; i < 100; i++) {
            runner.process({ id: 10 + i, type: "step" });

            if (runner.layers[0].activeCount === 0) {
                break;
            }
        }

        // dormancy carries through to the protocol - a settled scene has no delta
        const quiet = runner.process({ id: 500, type: "step" }) as PhysicsStepResponse;

        expect(quiet.moves).toEqual(0);
        expect(quiet.layers[0].keys.length).toEqual(0);
        expect(quiet.layers[0].chunks.length).toEqual(0);
        expect(quiet.layers[0].removed.length).toEqual(0);
        expect(BVXPhysicsRunner.transferables(quiet).length).toEqual(2);
    });

    it('.process() - an emptied chunk is reported as removed, not as empty data', () => {
        const runner = attached();

        // a grain alone in a high chunk, which empties as it falls out of it
        runner.process({ id: 2, type: "inject", layer: 0, set: coords([1, 47, 1]) });
        runner.process({ id: 3, type: "step" });

        const highKey = MortonKey.from(0, 2, 0).key;

        let sawRemoval = false;

        for (let i = 0; i < 200; i++) {
            const response = runner.process({ id: 10 + i, type: "step" }) as PhysicsStepResponse;

            for (let r = 0; r < response.layers[0].removed.length; r++) {
                if (response.layers[0].removed[r] === highKey) {
                    sawRemoval = true;
                }
            }

            if (runner.layers[0].activeCount === 0) {
                break;
            }
        }

        expect(sawRemoval).toEqual(true);
    });

    it('.process() - a step budget bounds the work and reports it', () => {
        const runner = attached();
        const grains: number[][] = [];

        for (let x = 0; x < 24; x++) {
            for (let z = 0; z < 24; z++) {
                grains.push([x, 40, z]);
            }
        }

        runner.process({ id: 2, type: "inject", layer: 0, set: coords(...grains) });

        const budgeted = runner.process({ id: 3, type: "step", ticks: 1, maxWork: 200 }) as PhysicsStepResponse;

        // the budget stopped the tick part-way, so nothing completed and the counter
        // has not moved - the next step request resumes it
        expect(budgeted.complete).toEqual(false);
        expect(budgeted.ticks).toEqual(0);
        expect(budgeted.tick).toEqual(0);
        expect(budgeted.work).toBeGreaterThanOrEqual(200);
        expect(budgeted.moves).toBeGreaterThan(0);
        expect(budgeted.moves).toBeLessThan(24 * 24);

        // stepping until it completes advances the counter exactly once
        let guard = 0;

        while (guard < 1000) {
            const next = runner.process({ id: 4, type: "step", ticks: 1, maxWork: 200 }) as PhysicsStepResponse;

            guard++;

            if (next.tick === 1) {
                break;
            }
        }

        expect(guard).toBeLessThan(1000);
        expect((runner.physics as VoxelPhysics).tick).toEqual(1);
    });

    it('.transferables() - collects every delta buffer', () => {
        const runner = attached([VoxelPhysics.SAND, VoxelPhysics.WATER]);

        runner.process({ id: 2, type: "inject", layer: 0, set: coords([1, 40, 1]) });
        runner.process({ id: 3, type: "inject", layer: 1, set: coords([5, 40, 5]) });

        const response = runner.process({ id: 4, type: "step" }) as PhysicsStepResponse;
        const buffers = BVXPhysicsRunner.transferables(response);

        // keys + removed per layer, plus one per changed chunk
        let expected = response.layers.length * 2;

        for (const delta of response.layers) {
            expected += delta.chunks.length;
        }

        expect(buffers.length).toEqual(expected);
        expect(new Set(buffers).size).toEqual(buffers.length);
    });
});

describe('BVXPhysicsHost', () => {

    it('.attach() - processes requests through a worker-shaped scope', () => {
        const posted: PhysicsResponse[] = [];
        const transfers: ArrayBuffer[][] = [];

        const scope: PhysicsScope = {
            onmessage: null,
            postMessage: (message: PhysicsResponse, transfer?: ArrayBuffer[]): void => {
                posted.push(message);
                transfers.push(transfer ?? []);
            }
        };

        const host = new BVXPhysicsHost();

        host.attach(scope);

        expect(scope.onmessage).not.toBeNull();

        const send = (data: PhysicsRequest): void => {
            (scope.onmessage as (event: { data: PhysicsRequest }) => void)({ data });
        };

        send({ id: 1, type: "attach", bounds: { maxX: 63, maxY: 63, maxZ: 63 }, layers: [VoxelPhysics.SAND] });
        send({ id: 2, type: "inject", layer: 0, set: Int32Array.from([1, 20, 1]) });
        send({ id: 3, type: "step" });

        expect(posted.length).toEqual(3);
        expect(posted[0]).toEqual({ id: 1, type: "ack", request: "attach" });
        expect(posted[1]).toEqual({ id: 2, type: "ack", request: "inject" });
        expect(posted[2].type).toEqual("step");
        expect((posted[2] as PhysicsStepResponse).moves).toEqual(1);

        // acks carry nothing, step responses carry their delta buffers
        expect(transfers[0].length).toEqual(0);
        expect(transfers[2].length).toBeGreaterThan(0);
        expect(host.runner.layers.length).toEqual(1);
    });
});
