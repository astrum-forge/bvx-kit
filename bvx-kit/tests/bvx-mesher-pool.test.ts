import { describe, expect, it } from '@jest/globals';
import { BVXMesher, MesherRequest, MesherResponse, MesherResponseBase } from "../src/lib/worker/bvx-mesher.js";
import { BVXMesherPool, MesherPoolError, MesherWorker } from "../src/lib/worker/bvx-mesher-pool.js";
import { BVXWorkerHost, MesherReadyMessage } from "../src/lib/worker/bvx-worker-host.js";
import { ChunkNeighbourhoodPacker } from "../src/lib/worker/chunk-neighbourhood.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";

/**
 * Coverage for bvx-mesher-pool.ts.
 *
 * The pool is driven by a fake worker that runs a real BVXWorkerHost, but defers the
 * response by a microtask so the asynchrony the pool has to cope with is real. Ordering,
 * coalescing and cancellation are all observable through it.
 */
describe('BVXMesherPool', () => {

    /**
     * A worker that runs a real host in-process and answers on a microtask.
     */
    class FakeWorker implements MesherWorker {
        public onmessage: ((event: { data: MesherResponseBase | MesherReadyMessage }) => void) | null = null;
        public terminated = false;
        public received = 0;

        private readonly _host: BVXWorkerHost;
        private readonly _scope: { onmessage: ((event: { data: never }) => void) | null; postMessage: (message: never) => void };

        constructor(private readonly _delay: () => Promise<void> = () => Promise.resolve()) {
            this._host = new BVXWorkerHost();

            this._scope = {
                onmessage: null,
                postMessage: (message: never): void => {
                    void this._delay().then(() => {
                        if (!this.terminated && this.onmessage !== null) {
                            this.onmessage({ data: message as unknown as MesherResponse });
                        }
                    });
                }
            };

            this._host.attach(this._scope as never);
        }

        public postMessage(message: unknown): void {
            if (this.terminated) {
                return;
            }

            this.received++;

            void Promise.resolve().then(() => {
                if (!this.terminated && this._scope.onmessage !== null) {
                    this._scope.onmessage({ data: message as never });
                }
            });
        }

        public terminate(): void {
            this.terminated = true;
        }
    }

    const buildWorld = (): { world: VoxelWorld; chunks: VoxelChunk0[] } => {
        const world = new VoxelWorld();
        const chunks: VoxelChunk0[] = [];

        for (let i = 0; i < 8; i++) {
            const chunk = new VoxelChunk0(MortonKey.from(i, 1, 1));

            chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));
            chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 2, 1, 1));

            world.insert(chunk);
            chunks.push(chunk);
        }

        return { world: world, chunks: chunks };
    };

    const request = (pool: BVXMesherPool, packer: ChunkNeighbourhoodPacker, world: VoxelWorld, chunk: VoxelChunk0): MesherRequest => ({
        id: 0,
        type: "faces",
        flipped: false,
        payload: { kind: "neighbourhood", chunk: packer.pack(chunk, world, pool.acquireOccupancy()) }
    });

    it('.submit() - resolves with the response for the submitted chunk', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const response = await pool.submit(request(pool, packer, world, chunks[0]));

        expect(response.type).toEqual("faces");
        expect(response.chunkKey).toEqual(chunks[0].key.key);
        expect(pool.idle).toEqual(true);

        pool.dispose();
    });

    it('.submit() - spreads work across every worker', async () => {
        const workers = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
        const pool = new BVXMesherPool({ workers: workers });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        await Promise.all(chunks.map((chunk) => pool.submit(request(pool, packer, world, chunk))));

        for (const worker of workers) {
            expect(worker.received).toBeGreaterThan(0);
        }

        expect(pool.idle).toEqual(true);

        pool.dispose();
    });

    it('.submit() - a resubmission supersedes the queued job for the same chunk', async () => {
        // one worker held busy on the first request, so everything after it queues
        const worker = new FakeWorker();
        const pool = new BVXMesherPool({ workers: [worker] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const blocking = pool.submit(request(pool, packer, world, chunks[0]));

        const first = pool.submit(request(pool, packer, world, chunks[1]));

        expect(pool.queued).toEqual(1);

        const second = pool.submit(request(pool, packer, world, chunks[1]));

        // still one queued job for that chunk, not two
        expect(pool.queued).toEqual(1);

        const results = await Promise.all([blocking, first, second]);

        // the superseded caller is answered with the surviving job's result rather than
        // left hanging
        expect(results[1]).toBe(results[2]);
        expect(worker.received).toEqual(2);

        pool.dispose();
    });

    it('.cancel() - drops a queued job and rejects its promise', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const blocking = pool.submit(request(pool, packer, world, chunks[0]));
        const doomed = pool.submit(request(pool, packer, world, chunks[1]));

        expect(pool.queued).toEqual(1);
        expect(pool.cancel(BVXMesherPool.keyOf({ id: 0, type: "faces", flipped: false, payload: { kind: "snapshot", chunkKey: chunks[1].key.key, world: new Uint8Array(0) } }))).toEqual(1);
        expect(pool.queued).toEqual(0);

        await expect(doomed).rejects.toThrow("cancelled");
        await blocking;

        pool.dispose();
    });

    it('.cancelAll() - drops everything queued and reclaims its buffers', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const blocking = pool.submit(request(pool, packer, world, chunks[0]));
        const dropped = chunks.slice(1).map((chunk) => pool.submit(request(pool, packer, world, chunk)));

        expect(pool.queued).toEqual(7);
        expect(pool.cancelAll()).toEqual(7);
        expect(pool.queued).toEqual(0);

        // the cancelled requests' buffers came back rather than being lost
        expect(pool.recycledCount).toEqual(7);

        await Promise.all(dropped.map((promise) => expect(promise).rejects.toThrow("cleared")));
        await blocking;

        pool.dispose();
    });

    it('.submit() - an abort signal drops a queued job', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();
        const controller = new AbortController();

        const blocking = pool.submit(request(pool, packer, world, chunks[0]));
        const doomed = pool.submit(request(pool, packer, world, chunks[1]), null, controller.signal);

        expect(pool.queued).toEqual(1);

        controller.abort();

        await expect(doomed).rejects.toThrow("aborted");
        expect(pool.queued).toEqual(0);

        await blocking;

        pool.dispose();
    });

    it('.submit() - an already-aborted signal rejects without queueing', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();
        const controller = new AbortController();

        controller.abort();

        await expect(pool.submit(request(pool, packer, world, chunks[0]), null, controller.signal)).rejects.toThrow("already aborted");
        expect(pool.queued).toEqual(0);

        pool.dispose();
    });

    it('.drain() - resolves once everything outstanding has finished', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker(), new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        for (const chunk of chunks) {
            void pool.submit(request(pool, packer, world, chunk)).catch(() => undefined);
        }

        expect(pool.idle).toEqual(false);

        await pool.drain();

        expect(pool.idle).toEqual(true);
        expect(pool.queued).toEqual(0);
        expect(pool.inFlight).toEqual(0);

        // an idle pool drains immediately
        await pool.drain();

        pool.dispose();
    });

    it('.acquireOccupancy() - reuses the buffers responses hand back', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        expect(pool.recycledCount).toEqual(0);

        const first = pool.acquireOccupancy();

        await pool.submit({
            id: 0,
            type: "faces",
            flipped: false,
            payload: { kind: "neighbourhood", chunk: packer.pack(chunks[0], world, first) }
        });

        expect(pool.recycledCount).toEqual(1);
        expect(pool.acquireOccupancy()).toBe(first);
        expect(pool.recycledCount).toEqual(0);

        pool.dispose();
    });

    it('.submit() - a mesher error rejects the promise rather than hanging', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });

        await expect(pool.submit({
            id: 0,
            type: "faces",
            flipped: false,
            payload: { kind: "arena", chunk: { chunkKey: 0, slots: new Int32Array(27).fill(-1) } }
        })).rejects.toThrow("no arena is bound");

        expect(pool.idle).toEqual(true);

        pool.dispose();
    });

    it('.submit() - the queue cap rejects rather than growing without bound', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()], maxQueued: 2 });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const settled: Promise<unknown>[] = [];

        settled.push(pool.submit(request(pool, packer, world, chunks[0])));
        settled.push(pool.submit(request(pool, packer, world, chunks[1])));
        settled.push(pool.submit(request(pool, packer, world, chunks[2])));

        await expect(pool.submit(request(pool, packer, world, chunks[3]))).rejects.toThrow("at the cap");

        await Promise.all(settled);

        pool.dispose();
    });

    it('.bindArena() - reaches every worker and reports what it got', async () => {
        const workers = [new FakeWorker(), new FakeWorker()];
        const pool = new BVXMesherPool({ workers: workers });

        const answers = await pool.bindArena({
            buffer: new ArrayBuffer(32 * 512),
            capacity: 32,
            metaByteLength: 0
        });

        expect(answers.length).toEqual(2);

        for (const answer of answers) {
            expect(answer.type).toEqual("ready");
            expect(answer.error).toBeUndefined();

            // a plain ArrayBuffer is not shared, and the host says so rather than
            // pretending the worker can see the owner's writes
            expect(answer.shared).toEqual(false);
        }

        pool.dispose();
    });

    it('.bindArena() - reports a failure rather than throwing inside the worker', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });

        const [answer] = await pool.bindArena({
            buffer: new ArrayBuffer(8),
            capacity: 32,
            metaByteLength: 0
        });

        expect(answer.error).toBeDefined();
        expect(answer.error).toContain("too small");

        pool.dispose();
    });

    it('.dispose() - rejects everything outstanding and terminates the workers', async () => {
        const workers = [new FakeWorker()];
        const pool = new BVXMesherPool({ workers: workers });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const inFlight = pool.submit(request(pool, packer, world, chunks[0]));
        const queued = pool.submit(request(pool, packer, world, chunks[1]));

        pool.dispose();

        await expect(queued).rejects.toThrow("cleared");
        await expect(inFlight).rejects.toThrow("disposed");
        await expect(pool.submit(request(pool, packer, world, chunks[2]))).rejects.toThrow("disposed");

        expect(workers[0].terminated).toEqual(true);
    });

    it('.constructor() - rejects an empty worker list', () => {
        expect(() => new BVXMesherPool({ workers: [] })).toThrow();
    });

    it('.keyOf() - keys by geometry type and chunk', () => {
        const key = MortonKey.from(3, 4, 5).key;

        const faces: MesherRequest = { id: 0, type: "faces", flipped: false, payload: { kind: "snapshot", chunkKey: key, world: new Uint8Array(0) } };
        const quads: MesherRequest = { id: 0, type: "quads", payload: { kind: "snapshot", chunkKey: key, world: new Uint8Array(0) } };

        expect(BVXMesherPool.keyOf(faces)).toEqual(BVXMesherPool.keyOf(faces));
        expect(BVXMesherPool.keyOf(faces)).not.toEqual(BVXMesherPool.keyOf(quads));
        expect(BVXMesher.chunkKeyOf(faces.payload)).toEqual(key);
    });

    it('MesherPoolError - tags why a request did not produce a mesh', async () => {
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const reasonOf = async (promise: Promise<unknown>): Promise<MesherPoolError> => {
            try {
                await promise;
            }
            catch (error) {
                return error as MesherPoolError;
            }

            throw new Error("expected the promise to reject");
        };

        // ---- cancelled
        const blocking = pool.submit(request(pool, packer, world, chunks[0]));
        const doomed = pool.submit(request(pool, packer, world, chunks[1]), "lane:1");

        pool.cancel("lane:1");

        const cancelled = await reasonOf(doomed);

        expect(cancelled).toBeInstanceOf(MesherPoolError);
        expect(cancelled.reason).toEqual("cancelled");
        expect(cancelled.key).toEqual("lane:1");
        expect(cancelled.isCancellation).toEqual(true);

        await blocking;

        // ---- aborted
        const controller = new AbortController();
        const held = pool.submit(request(pool, packer, world, chunks[0]));
        const aborting = pool.submit(request(pool, packer, world, chunks[2]), null, controller.signal);

        controller.abort();

        expect((await reasonOf(aborting)).reason).toEqual("aborted");

        await held;

        // ---- the mesher itself failing is NOT a cancellation
        const failed = await reasonOf(pool.submit({
            id: 0,
            type: "faces",
            flipped: false,
            payload: { kind: "arena", chunk: { chunkKey: 0, slots: new Int32Array(27).fill(-1) } }
        }));

        expect(failed.reason).toEqual("failed");
        expect(failed.isCancellation).toEqual(false);
        expect(failed.message).toContain("no arena is bound");

        // ---- the queue cap
        const capped = new BVXMesherPool({ workers: [new FakeWorker()], maxQueued: 1 });
        const settling = [
            capped.submit(request(capped, packer, world, chunks[0])),
            capped.submit(request(capped, packer, world, chunks[1]))
        ];

        expect((await reasonOf(capped.submit(request(capped, packer, world, chunks[2])))).reason).toEqual("rejected");

        await Promise.all(settling);

        capped.dispose();

        // ---- disposal
        const disposing = pool.submit(request(pool, packer, world, chunks[3]));

        pool.dispose();

        expect((await reasonOf(disposing)).isCancellation).toEqual(true);
        expect((await reasonOf(pool.submit(request(pool, packer, world, chunks[4])))).reason).toEqual("disposed");
    });

    it('.submit() - a failure reaches the superseded caller too', async () => {
        // one worker held busy so the second and third requests queue
        const pool = new BVXMesherPool({ workers: [new FakeWorker()] });
        const { world, chunks } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const blocking = pool.submit(request(pool, packer, world, chunks[0]));

        const superseded = pool.submit(request(pool, packer, world, chunks[1]), "same");
        const survivor = pool.submit(request(pool, packer, world, chunks[1]), "same");

        // cancelling the survivor must not leave the superseded caller pending forever
        pool.cancel("same");

        await expect(superseded).rejects.toThrow("cancelled");
        await expect(survivor).rejects.toThrow("cancelled");

        await blocking;

        pool.dispose();
    });

});
