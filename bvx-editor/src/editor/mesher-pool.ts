import type { MesherRequest, MesherResponse } from "@astrumforge/bvx-kit";

/**
 * A small pool of meshing Web Workers. Requests are dispatched round-robin and
 * resolved by their id, keeping all geometry generation off the main thread.
 */
export class MesherPool {
    /**
     * The pooled workers.
     */
    private readonly _workers: Worker[];

    /**
     * Pending request promises keyed by request id.
     */
    private readonly _pending: Map<number, (response: MesherResponse) => void>;

    /**
     * Monotonic id counter for requests.
     */
    private _nextId = 0;

    /**
     * Round-robin dispatch cursor.
     */
    private _cursor = 0;

    constructor(size: number = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1))) {
        this._workers = [];
        this._pending = new Map();

        for (let i = 0; i < size; i++) {
            const worker = new Worker(new URL("./mesher.worker.ts", import.meta.url), { type: "module" });

            worker.onmessage = (event: MessageEvent<MesherResponse>) => {
                const resolve = this._pending.get(event.data.id);

                if (resolve) {
                    this._pending.delete(event.data.id);
                    resolve(event.data);
                }
            };

            this._workers.push(worker);
        }
    }

    /**
     * The number of workers in the pool.
     */
    public get size(): number {
        return this._workers.length;
    }

    /**
     * Dispatches a meshing request to the next worker in the pool. The request id
     * is assigned by the pool - any id on the provided request is overwritten.
     * The request's world and occluder snapshot buffers are transferred, not copied.
     */
    public request(request: MesherRequest): Promise<MesherResponse> {
        request.id = this._nextId++;

        const worker = this._workers[this._cursor];
        this._cursor = (this._cursor + 1) % this._workers.length;

        const transfer: ArrayBuffer[] = [request.world.buffer as ArrayBuffer];

        if (request.occluders !== undefined) {
            transfer.push(request.occluders.buffer as ArrayBuffer);
        }

        return new Promise<MesherResponse>((resolve) => {
            this._pending.set(request.id, resolve);
            worker.postMessage(request, transfer);
        });
    }

    /**
     * Terminates all workers and rejects nothing - pending promises simply never
     * resolve, which is safe as responses are consumed with latest-wins logic.
     */
    public dispose(): void {
        for (const worker of this._workers) {
            worker.terminate();
        }

        this._workers.length = 0;
        this._pending.clear();
    }
}
