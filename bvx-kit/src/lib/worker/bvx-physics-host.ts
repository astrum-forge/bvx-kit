import { BVXPhysicsRunner, PhysicsRequest, PhysicsResponse } from "./bvx-physics-runner.js";

/**
 * Minimal structural view of a Web Worker global scope for the physics runner.
 * Declared locally so the core library carries no dependency on DOM or WebWorker
 * type libraries and remains renderer and platform agnostic.
 */
export interface PhysicsScope {
    /**
     * The message handler slot of the worker scope.
     */
    onmessage: ((event: { data: PhysicsRequest }) => void) | null;

    /**
     * Posts a message (optionally with transferable buffers) back to the caller.
     */
    postMessage(message: PhysicsResponse, transfer?: ArrayBuffer[]): void;
}

/**
 * BVXPhysicsHost wires a BVXPhysicsRunner into a Web Worker global scope. As with
 * BVXWorkerHost the library does not construct Workers itself - an application
 * provides a tiny worker entry that attaches the host:
 *
 * ```typescript
 * // physics.worker.ts - the application's worker entry file
 * import { BVXPhysicsHost } from '@astrumforge/bvx-kit';
 *
 * new BVXPhysicsHost().attach(self as never);
 * ```
 *
 * The runner is long-lived and owns the simulation, so unlike the mesher host this one
 * is stateful: send exactly one attach request before anything else, then edits and
 * steps for the lifetime of the worker.
 *
 * A typical driver posts one step per fixed timestep and applies the deltas:
 *
 * ```typescript
 * worker.onmessage = (event) => {
 *     const response = event.data;
 *
 *     if (response.type !== 'step') {
 *         return;
 *     }
 *
 *     for (const delta of response.layers) {
 *         for (const key of delta.removed) {
 *             releaseMesh(delta.layer, key);
 *         }
 *
 *         for (let i = 0; i < delta.keys.length; i++) {
 *             applyChunk(delta.layer, delta.keys[i], BVXSerializer.loadChunk(delta.chunks[i]));
 *         }
 *     }
 * };
 * ```
 */
export class BVXPhysicsHost {
    /**
     * The runner that owns the simulation and processes incoming requests.
     */
    private readonly _runner: BVXPhysicsRunner;

    constructor() {
        this._runner = new BVXPhysicsRunner();
    }

    /**
     * Returns the runner, for applications that want to inspect the simulation from
     * inside the worker - for example to mesh the layers locally rather than shipping
     * the deltas out.
     */
    public get runner(): BVXPhysicsRunner {
        return this._runner;
    }

    /**
     * Attaches this host to the provided worker scope. Incoming PhysicsRequest
     * messages are processed and their PhysicsResponse posted back with the delta
     * buffers as transferables.
     *
     * @param scope - The worker global scope (self) to attach to.
     */
    public attach(scope: PhysicsScope): void {
        const runner: BVXPhysicsRunner = this._runner;

        scope.onmessage = (event: { data: PhysicsRequest }): void => {
            const request: PhysicsRequest = event.data;

            // a message handler that throws posts nothing, and a caller waiting on the
            // request id then waits forever - so every message gets an answer, however
            // malformed. The realistic throws are a step or edit before attach, an
            // inject naming a missing layer, and attach bytes that do not decode.
            if (request === null || typeof request !== "object") {
                scope.postMessage({ id: -1, type: "error", message: "BVXPhysicsHost - the message is not a PhysicsRequest" });

                return;
            }

            let response: PhysicsResponse;

            try {
                response = runner.process(request);
            }
            catch (error) {
                response = {
                    id: request.id,
                    type: "error",
                    message: error instanceof Error ? error.message : String(error)
                };
            }

            try {
                scope.postMessage(response, BVXPhysicsRunner.transferables(response));
            }
            catch (error) {
                // a response that cannot be posted - a detached buffer, a value the
                // structured clone algorithm rejects - still owes the caller an answer
                scope.postMessage({
                    id: request.id,
                    type: "error",
                    message: `response could not be posted: ${error instanceof Error ? error.message : String(error)}`
                });
            }
        };
    }
}
