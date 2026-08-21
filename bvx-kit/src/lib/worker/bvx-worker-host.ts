import { BVXMesher, MesherRequest, MesherResponse } from "./bvx-mesher.js";

/**
 * Minimal structural view of a Web Worker global scope. Declared locally so the
 * core library carries no dependency on DOM or WebWorker type libraries and
 * remains renderer and platform agnostic.
 */
export interface MesherScope {
    /**
     * The message handler slot of the worker scope.
     */
    onmessage: ((event: { data: MesherRequest }) => void) | null;

    /**
     * Posts a message (optionally with transferable buffers) back to the caller.
     */
    postMessage(message: MesherResponse, transfer?: ArrayBuffer[]): void;
}

/**
 * BVXWorkerHost wires a BVXMesher into a Web Worker global scope. The library
 * deliberately does not construct Workers itself - bundlers and applications
 * have their own conventions for creating worker entry files. Instead, an
 * application provides a tiny worker entry that attaches the host:
 *
 * ```typescript
 * // mesher.worker.ts - the application's worker entry file
 * import { BVXWorkerHost } from '@astrumforge/bvx-kit';
 *
 * new BVXWorkerHost().attach(self as never);
 * ```
 *
 * The application then posts MesherRequest objects to the Worker and receives
 * MesherResponse objects back, with all geometry buffers transferred rather
 * than copied.
 */
export class BVXWorkerHost {
    /**
     * The mesher instance that processes incoming requests.
     */
    private readonly _mesher: BVXMesher;

    constructor() {
        this._mesher = new BVXMesher();
    }

    /**
     * Attaches this host to the provided worker scope. Incoming MesherRequest
     * messages are processed and their MesherResponse posted back with the
     * geometry buffers as transferables.
     *
     * @param scope - The worker global scope (self) to attach to.
     */
    public attach(scope: MesherScope): void {
        const mesher: BVXMesher = this._mesher;

        scope.onmessage = (event: { data: MesherRequest }): void => {
            const response: MesherResponse = mesher.process(event.data);

            scope.postMessage(response, BVXMesher.transferables(response));
        };
    }
}
