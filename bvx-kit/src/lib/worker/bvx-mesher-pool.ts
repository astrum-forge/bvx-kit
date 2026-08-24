import { BVXMesher, MesherErrorResponse, MesherRequest, MesherRequestBase, MesherResponse, MesherResponseBase } from "./bvx-mesher.js";
import { ChunkNeighbourhoodPacker } from "./chunk-neighbourhood.js";
import { MesherBindArenaControl, MesherReadyMessage } from "./bvx-worker-host.js";

/**
 * The part of a Web Worker this pool uses. Declared structurally so the kit carries no
 * DOM dependency and so a Node worker_threads worker, or a fake in a test, can stand in.
 */
export interface MesherWorker {
    /**
     * The transfer list is required rather than optional so a DOM Worker satisfies this
     * structurally - its own signature makes the list required on the overload that
     * takes one. The pool always passes an array, empty when there is nothing to move.
     */
    postMessage(message: unknown, transfer: ArrayBuffer[]): void;

    /**
     * The handler slot the pool installs into.
     *
     * Typed loosely on purpose. A mutable property is invariant, so naming the exact
     * event shape here would make the DOM's own `Worker` - whose handler takes a full
     * MessageEvent - fail to satisfy this interface, and every caller would have to
     * wrap their workers in an adapter. The pool reads `event.data` and nothing else.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onmessage: ((event: any) => void) | null;

    /**
     * (Optional) Failure notification. The pool rejects everything assigned to a worker
     * that reports one and stops dispatching to it.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onerror?: ((event: any) => void) | null;

    terminate(): void;
}

/**
 * How a submitted request is identified for coalescing and cancellation.
 *
 * Two requests with the same key are the same job: the later one supersedes the earlier
 * while the earlier is still queued. The default is the geometry type and the chunk key,
 * which is what makes a chunk dirtied three times before the pool reaches it mesh once.
 * Pass your own when a single chunk has more than one distinct job - separate render
 * lanes over the same coordinates, typically.
 */
export type MesherJobKey = string;

/**
 * Options for BVXMesherPool.
 */
export interface BVXMesherPoolOptions<TRequest extends MesherRequestBase = MesherRequest> {
    /**
     * The workers to dispatch to. The pool does not construct them: a Worker's
     * constructor takes a module URL, and how that URL is produced is a bundler
     * convention the kit has no business guessing at.
     *
     * ```typescript
     * const pool = new BVXMesherPool({
     *     workers: Array.from({ length: 4 }, () =>
     *         new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' }))
     * });
     * ```
     */
    workers: MesherWorker[];

    /**
     * How many requests may be outstanding on one worker at a time. Defaults to 1.
     *
     * One is the useful default, and not for throughput: a worker meshes synchronously,
     * so a second request posted to a busy worker sits in its message queue where the
     * pool can no longer cancel or supersede it. Keeping the backlog on this side of the
     * boundary is what makes cancel() and coalescing mean anything. Raise it only if
     * per-message overhead measurably dominates, which at ~250 us of meshing per request
     * it does not.
     */
    inFlightPerWorker?: number;

    /**
     * (Optional) A hard cap on queued requests. submit() rejects beyond it rather than
     * letting an unbounded backlog accumulate. 0 means no cap, which is the default -
     * a caller that paces itself does not need one.
     */
    maxQueued?: number;

    /**
     * (Optional) The transferable buffers of a request. Defaults to
     * BVXMesher.requestTransferables.
     *
     * An application that extends the protocol with its own request type - one carrying
     * a palette, or asking the worker for fully expanded vertex streams - supplies this
     * so its own buffers move rather than being cloned.
     */
    transferables?: (request: TRequest) => ArrayBuffer[];

    /**
     * (Optional) The coalescing key of a request. Defaults to BVXMesherPool.keyOf.
     */
    keyOf?: (request: TRequest) => MesherJobKey;
}

/**
 * Why a submitted request did not produce a mesh.
 *
 * The distinction that matters to a caller is between the first four - which mean the
 * caller's own code decided the work was no longer wanted - and the last two, which mean
 * something went wrong. A renderer should ignore the former silently and surface the
 * latter, and it cannot do that by matching on message strings.
 *
 * - `cancelled`   - `cancel()` or `cancelAll()` dropped it
 * - `superseded`  - a newer request for the same key replaced it while it was queued
 * - `aborted`     - its AbortSignal fired
 * - `disposed`    - the pool was disposed, or the request arrived after that
 * - `rejected`    - the pool refused it: the queue cap was reached
 * - `failed`      - the mesher could not answer it, or the worker died
 */
export type MesherFailureReason = "cancelled" | "superseded" | "aborted" | "disposed" | "rejected" | "failed";

/**
 * The error a rejected submit() carries.
 */
export class MesherPoolError extends Error {
    /**
     * Why the request did not produce a mesh.
     */
    public readonly reason: MesherFailureReason;

    /**
     * The coalescing key of the request, when the pool knew it.
     */
    public readonly key: MesherJobKey | null;

    constructor(reason: MesherFailureReason, message: string, key: MesherJobKey | null = null) {
        super(message);

        this.name = "MesherPoolError";
        this.reason = reason;
        this.key = key;
    }

    /**
     * Whether this rejection means the caller's own code dropped the work, as opposed to
     * something going wrong. A renderer normally ignores these.
     */
    public get isCancellation(): boolean {
        return this.reason === "cancelled" || this.reason === "superseded" || this.reason === "aborted" || this.reason === "disposed";
    }
}

/**
 * A queued or in-flight job.
 */
interface PendingJob<TRequest, TResponse> {
    key: MesherJobKey;
    request: TRequest;
    resolve: (response: TResponse) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

/**
 * A pool of mesher workers with explicit, caller-driven controls.
 *
 * ## What it does not do
 *
 * It owns no timer, no frame budget and no deadline. It never decides when to run. Work
 * moves when the caller submits it and when a worker reports back, and at no other time.
 * Pacing is the application's - it is the only party that knows what else is competing
 * for the frame - and this class exists to give that pacing something to act on:
 *
 * - `submit()` returns a promise, so a caller can await completion or fire and forget
 * - `cancel()` drops queued work that is no longer wanted
 * - coalescing by key means resubmitting a chunk supersedes the queued job for it
 *   rather than queueing a second one
 * - `queued`, `inFlight` and `idle` report the backlog, so a caller can decide whether
 *   to submit more
 * - `drain()` resolves when everything outstanding has finished
 *
 * ## Buffer recycling
 *
 * A `neighbourhood` payload's occupancy buffer is transferred into the worker and comes
 * back on the response. The pool keeps returned buffers and hands them out again through
 * `acquireOccupancy()`, so a steady-state stream of requests allocates nothing:
 *
 * ```typescript
 * const packer = new ChunkNeighbourhoodPacker();
 *
 * const response = await pool.submit({
 *     id: 0,
 *     type: 'quads',
 *     payload: { kind: 'neighbourhood', chunk: packer.pack(chunk, world, pool.acquireOccupancy()) }
 * });
 * ```
 */
export class BVXMesherPool<TRequest extends MesherRequestBase = MesherRequest, TResponse extends MesherResponseBase = MesherResponse> {
    /**
     * The pooled workers.
     */
    private readonly _workers: MesherWorker[];

    /**
     * How many requests are outstanding on each worker, by worker index.
     */
    private readonly _load: number[];

    /**
     * Whether each worker has reported a failure. A dead worker is never dispatched to
     * again - its message port may be gone, and a request posted there would sit
     * unanswered forever with its promise never settling.
     */
    private readonly _dead: boolean[];

    /**
     * The most requests one worker may hold at once.
     */
    private readonly _inFlightPerWorker: number;

    /**
     * The queued-request cap, or 0 for none.
     */
    private readonly _maxQueued: number;

    /**
     * Queued jobs in submission order.
     */
    private readonly _queue: PendingJob<TRequest, TResponse>[];

    /**
     * Queued jobs by key, so a resubmission can supersede one still waiting.
     */
    private readonly _queued: Map<MesherJobKey, PendingJob<TRequest, TResponse>>;

    /**
     * In-flight jobs by request id.
     */
    private readonly _inFlight: Map<number, PendingJob<TRequest, TResponse>>;

    /**
     * Which worker each in-flight request went to, so its load can be released.
     */
    private readonly _assigned: Map<number, number>;

    /**
     * Occupancy buffers returned by responses, waiting to be handed out again.
     */
    private readonly _recycled: Uint32Array[];

    /**
     * Resolvers waiting on drain().
     */
    private readonly _drains: (() => void)[];

    /**
     * Pending answers to control messages, by control id.
     */
    private readonly _ready: Map<number, (message: MesherReadyMessage) => void>;

    /**
     * How a request's transferable buffers are found.
     */
    private readonly _transferables: (request: TRequest) => ArrayBuffer[];

    /**
     * How a request's coalescing key is derived.
     */
    private readonly _keyOf: (request: TRequest) => MesherJobKey;

    /**
     * Monotonic request id, assigned by the pool so ids never collide.
     */
    private _nextId: number;

    /**
     * Whether dispose() has been called.
     */
    private _disposed: boolean;

    constructor(options: BVXMesherPoolOptions<TRequest>) {
        if (options.workers.length === 0) {
            throw new Error("BVXMesherPool.constructor(BVXMesherPoolOptions) - at least one worker is required");
        }

        this._workers = options.workers.slice();
        this._load = new Array<number>(this._workers.length).fill(0);
        this._dead = new Array<boolean>(this._workers.length).fill(false);
        this._inFlightPerWorker = Math.max(1, options.inFlightPerWorker ?? 1);
        this._maxQueued = Math.max(0, options.maxQueued ?? 0);
        this._queue = [];
        this._queued = new Map<MesherJobKey, PendingJob<TRequest, TResponse>>();
        this._inFlight = new Map<number, PendingJob<TRequest, TResponse>>();
        this._assigned = new Map<number, number>();
        this._recycled = [];
        this._drains = [];
        this._ready = new Map<number, (message: MesherReadyMessage) => void>();
        this._nextId = 1;
        this._disposed = false;
        this._transferables = options.transferables ?? ((request) => BVXMesher.requestTransferables(request as unknown as MesherRequest));
        this._keyOf = options.keyOf ?? ((request) => BVXMesherPool.keyOf(request as unknown as MesherRequest));

        for (let i = 0; i < this._workers.length; i++) {
            const worker: MesherWorker = this._workers[i];
            const index: number = i;

            worker.onmessage = (event: { data: MesherResponseBase | MesherReadyMessage }): void => {
                this._Receive(index, event.data);
            };

            if ("onerror" in worker) {
                worker.onerror = (): void => {
                    this._FailWorker(index);
                };
            }
        }
    }

    /**
     * The number of workers.
     */
    public get size(): number {
        return this._workers.length;
    }

    /**
     * The number of requests waiting to be dispatched.
     */
    public get queued(): number {
        return this._queue.length;
    }

    /**
     * The number of requests currently being meshed.
     */
    public get inFlight(): number {
        return this._inFlight.size;
    }

    /**
     * Whether nothing is queued and nothing is outstanding.
     */
    public get idle(): boolean {
        return this._queue.length === 0 && this._inFlight.size === 0;
    }

    /**
     * The default coalescing key for a request: its geometry type and chunk.
     *
     * @param request - The request to key.
     * @returns - The key.
     */
    public static keyOf(request: MesherRequest): MesherJobKey {
        return `${request.type}:${BVXMesher.chunkKeyOf(request.payload)}`;
    }

    /**
     * Hands out an occupancy buffer for a neighbourhood payload, reusing one a response
     * returned when there is one and allocating otherwise.
     *
     * @returns - A buffer of ChunkNeighbourhoodPacker.OCCUPANCY_WORDS length. Its
     * contents are whatever the previous request left behind; pack() overwrites every
     * present slot and the reader zeroes the absent ones.
     */
    public acquireOccupancy(): Uint32Array {
        const recycled: Uint32Array | undefined = this._recycled.pop();

        return recycled ?? ChunkNeighbourhoodPacker.allocate();
    }

    /**
     * The number of recycled occupancy buffers currently held.
     */
    public get recycledCount(): number {
        return this._recycled.length;
    }

    /**
     * Submits a request.
     *
     * The pool assigns the request id; any id already on the request is overwritten, so
     * ids can never collide across callers.
     *
     * @param request - The request to mesh.
     * @param key - (Optional) The coalescing key. Defaults to BVXMesherPool.keyOf.
     * @param signal - (Optional) Cancels the request. A signal aborted while the request
     * is queued drops it; aborted while it is in flight, the worker still finishes - it
     * cannot be interrupted - but the promise rejects and the response is discarded.
     * @returns - The response.
     * @throws - Error if the pool is disposed or the queue cap is reached.
     */
    public submit(request: TRequest, key: MesherJobKey | null = null, signal: AbortSignal | null = null): Promise<TResponse> {
        if (this._disposed) {
            return Promise.reject(new MesherPoolError("disposed", "BVXMesherPool.submit(MesherRequest) - the pool is disposed"));
        }

        if (signal !== null && signal.aborted) {
            return Promise.reject(new MesherPoolError("aborted", "BVXMesherPool.submit(MesherRequest) - the request was already aborted"));
        }

        const jobKey: MesherJobKey = key ?? this._keyOf(request);

        if (this._maxQueued > 0 && this._queue.length >= this._maxQueued && !this._queued.has(jobKey)) {
            return Promise.reject(new MesherPoolError("rejected", `BVXMesherPool.submit(MesherRequest) - ${this._queue.length} requests are already queued, at the cap of ${this._maxQueued}`, jobKey));
        }

        request.id = this._nextId++;

        return new Promise<TResponse>((resolve, reject) => {
            const job: PendingJob<TRequest, TResponse> = {
                key: jobKey,
                request: request,
                resolve: resolve,
                reject: reject,
                signal: signal ?? undefined
            };

            // A resubmission of a job still waiting supersedes it: the newer request
            // carries newer chunk data, so meshing the older one would produce a result
            // that is already wrong. The superseded caller is answered with this job's
            // result rather than left hanging.
            const existing: PendingJob<TRequest, TResponse> | undefined = this._queued.get(jobKey);

            if (existing !== undefined) {
                // the superseded caller is not told it was superseded - it is told the
                // survivor's answer, which is the same chunk meshed from newer data
                const index: number = this._queue.indexOf(existing);

                if (index >= 0) {
                    this._queue.splice(index, 1);
                }

                BVXMesherPool._Unhook(existing);
                this._Reclaim(existing.request);

                const supersededResolve = existing.resolve;
                const supersededReject = existing.reject;

                job.resolve = (response: TResponse): void => {
                    supersededResolve(response);
                    resolve(response);
                };

                // the survivor carries the superseded caller's promise too, so a failure
                // reaches both rather than leaving one of them pending forever
                job.reject = (error: Error): void => {
                    supersededReject(error);
                    reject(error);
                };
            }

            if (signal !== null) {
                job.onAbort = (): void => {
                    this._Abort(job);
                };

                signal.addEventListener("abort", job.onAbort, { once: true });
            }

            this._queued.set(jobKey, job);
            this._queue.push(job);

            this._Pump();
        });
    }

    /**
     * Drops every queued request whose key matches, rejecting their promises. Requests
     * already in flight are not affected - a worker meshing synchronously cannot be
     * interrupted.
     *
     * @param key - The key to drop.
     * @returns - The number of requests dropped: 0 or 1 for the default keying.
     */
    public cancel(key: MesherJobKey): number {
        const job: PendingJob<TRequest, TResponse> | undefined = this._queued.get(key);

        if (job === undefined) {
            return 0;
        }

        const index: number = this._queue.indexOf(job);

        if (index >= 0) {
            this._queue.splice(index, 1);
        }

        this._queued.delete(key);
        BVXMesherPool._Unhook(job);
        this._Reclaim(job.request);

        job.reject(new MesherPoolError("cancelled", `BVXMesherPool.cancel(string) - '${key}' was cancelled`, key));

        this._Settle();

        return 1;
    }

    /**
     * Drops every queued request. In-flight requests still complete.
     *
     * @returns - The number of requests dropped.
     */
    public cancelAll(): number {
        const dropped: number = this._queue.length;

        for (const job of this._queue) {
            this._queued.delete(job.key);
            BVXMesherPool._Unhook(job);
            this._Reclaim(job.request);

            job.reject(new MesherPoolError("cancelled", "BVXMesherPool.cancelAll() - the queue was cleared", job.key));
        }

        this._queue.length = 0;

        this._Settle();

        return dropped;
    }

    /**
     * Resolves once nothing is queued and nothing is in flight. Resolves immediately
     * when the pool is already idle.
     *
     * This waits; it does not push. Call it to find out when the work you submitted is
     * done, not to make it happen sooner.
     */
    public drain(): Promise<void> {
        if (this.idle) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            this._drains.push(resolve);
        });
    }

    /**
     * Sends a bind-arena control message to every worker and resolves once all have
     * answered. Call before submitting any `arena` payload.
     *
     * @param control - The arena description. The id is assigned by the pool.
     * @returns - One ready message per worker, in worker order.
     */
    public bindArena(control: Omit<MesherBindArenaControl, "id" | "type">): Promise<MesherReadyMessage[]> {
        return Promise.all(this._workers.map((worker) => new Promise<MesherReadyMessage>((resolve) => {
            const id: number = this._nextId++;

            this._ready.set(id, resolve);

            worker.postMessage({ type: "bind-arena", id: id, ...control }, []);
        })));
    }

    /**
     * Rejects everything outstanding and terminates every worker.
     */
    public dispose(): void {
        if (this._disposed) {
            return;
        }

        this._disposed = true;

        this.cancelAll();

        for (const job of this._inFlight.values()) {
            BVXMesherPool._Unhook(job);

            job.reject(new MesherPoolError("disposed", "BVXMesherPool.dispose() - the pool was disposed", job.key));
        }

        this._inFlight.clear();
        this._assigned.clear();

        for (const worker of this._workers) {
            worker.onmessage = null;
            worker.terminate();
        }

        this._workers.length = 0;
        this._recycled.length = 0;

        this._Settle();
    }

    /**
     * Removes a job's abort listener.
     */
    private static _Unhook<A, B>(job: PendingJob<A, B>): void {
        if (job.signal !== undefined && job.onAbort !== undefined) {
            job.signal.removeEventListener("abort", job.onAbort);
        }
    }

    /**
     * Takes an abandoned request's occupancy buffers back into the recycling pool. The
     * request was never posted, so the buffers were never transferred and are still
     * usable.
     */
    private _Reclaim(request: TRequest): void {
        const payload = request.payload;

        if (payload.kind !== "neighbourhood") {
            return;
        }

        this._recycled.push(payload.chunk.occupancy);

        if (payload.occluders !== undefined) {
            this._recycled.push(payload.occluders.occupancy);
        }
    }

    /**
     * Drops a job because its signal aborted.
     */
    private _Abort(job: PendingJob<TRequest, TResponse>): void {
        const queued: PendingJob<TRequest, TResponse> | undefined = this._queued.get(job.key);

        if (queued === job) {
            const index: number = this._queue.indexOf(job);

            if (index >= 0) {
                this._queue.splice(index, 1);
            }

            this._queued.delete(job.key);
            this._Reclaim(job.request);
        }

        // an in-flight job stays in _inFlight so the worker's load is released when its
        // response arrives; the response is then dropped
        job.reject(new MesherPoolError("aborted", "BVXMesherPool - the request was aborted", job.key));

        this._Settle();
    }

    /**
     * Dispatches queued work onto workers with spare capacity.
     */
    private _Pump(): void {
        if (this._disposed) {
            return;
        }

        const workers: MesherWorker[] = this._workers;
        const capacity: number = this._inFlightPerWorker;

        for (let index = 0; index < workers.length && this._queue.length > 0; index++) {
            if (this._dead[index]) {
                continue;
            }

            while (this._load[index] < capacity && this._queue.length > 0) {
                const job: PendingJob<TRequest, TResponse> = this._queue.shift() as PendingJob<TRequest, TResponse>;

                this._queued.delete(job.key);

                const id: number = job.request.id;

                this._inFlight.set(id, job);
                this._assigned.set(id, index);
                this._load[index]++;

                try {
                    workers[index].postMessage(job.request, this._transferables(job.request));
                }
                catch (error) {
                    this._inFlight.delete(id);
                    this._assigned.delete(id);
                    this._load[index]--;

                    BVXMesherPool._Unhook(job);

                    job.reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        }
    }

    /**
     * Handles a message from a worker.
     */
    private _Receive(index: number, data: MesherResponseBase | MesherReadyMessage): void {
        if (data.type === "ready") {
            const ready: MesherReadyMessage = data as MesherReadyMessage;
            const resolve = this._ready.get(ready.id);

            if (resolve !== undefined) {
                this._ready.delete(ready.id);
                resolve(ready);
            }

            return;
        }

        const response: MesherResponseBase = data as MesherResponseBase;
        const job: PendingJob<TRequest, TResponse> | undefined = this._inFlight.get(response.id);

        this._inFlight.delete(response.id);
        this._assigned.delete(response.id);
        this._load[index] = Math.max(0, this._load[index] - 1);

        if (response.recycle !== undefined) {
            for (const buffer of response.recycle) {
                this._recycled.push(buffer);
            }
        }

        if (job !== undefined) {
            BVXMesherPool._Unhook(job);

            if (response.type === "error") {
                job.reject(new MesherPoolError("failed", `bvx mesh of chunk ${response.chunkKey} failed: ${(response as MesherErrorResponse).message}`, job.key));
            }
            else {
                job.resolve(response as TResponse);
            }
        }

        this._Pump();
        this._Settle();
    }

    /**
     * Rejects everything assigned to a worker that failed, and stops using it.
     */
    private _FailWorker(index: number): void {
        this._dead[index] = true;

        for (const [id, worker] of this._assigned) {
            if (worker !== index) {
                continue;
            }

            const job: PendingJob<TRequest, TResponse> | undefined = this._inFlight.get(id);

            this._inFlight.delete(id);
            this._assigned.delete(id);

            if (job !== undefined) {
                BVXMesherPool._Unhook(job);

                job.reject(new MesherPoolError("failed", `BVXMesherPool - worker ${index} failed while meshing chunk ${BVXMesher.chunkKeyOf(job.request.payload)}`, job.key));
            }
        }

        this._load[index] = 0;

        // with no live worker left, everything still queued can never run
        if (this._dead.every((dead) => dead)) {
            for (const job of this._queue) {
                this._queued.delete(job.key);
                BVXMesherPool._Unhook(job);
                this._Reclaim(job.request);

                job.reject(new MesherPoolError("failed", "BVXMesherPool - every worker has failed; the queue cannot be served", job.key));
            }

            this._queue.length = 0;
        }

        this._Pump();
        this._Settle();
    }

    /**
     * Resolves any pending drain() once the pool is idle.
     */
    private _Settle(): void {
        if (!this.idle || this._drains.length === 0) {
            return;
        }

        const waiting: (() => void)[] = this._drains.splice(0, this._drains.length);

        for (const resolve of waiting) {
            resolve();
        }
    }
}
