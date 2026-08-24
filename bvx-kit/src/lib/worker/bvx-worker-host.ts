import { BVXMesher, MesherRequest, MesherResponse } from "./bvx-mesher.js";
import { VoxelChunkArena } from "../engine/chunks/voxel-chunk-arena.js";

/**
 * Minimal structural view of a Web Worker global scope. Declared locally so the
 * core library carries no dependency on DOM or WebWorker type libraries and
 * remains renderer and platform agnostic.
 */
export interface MesherScope {
    /**
     * The message handler slot of the worker scope.
     */
    onmessage: ((event: { data: MesherRequest | MesherControl }) => void) | null;

    /**
     * Posts a message (optionally with transferable buffers) back to the caller.
     */
    postMessage(message: MesherResponse | MesherReadyMessage, transfer?: ArrayBuffer[]): void;
}

/**
 * Binds the shared arena that `arena` payloads index into.
 *
 * Sent once, before any arena request. The buffer must be a SharedArrayBuffer for the
 * worker to see the owner's writes; an ArrayBuffer arrives as a copy and the worker will
 * mesh a snapshot frozen at the moment it was sent, which is almost certainly not what
 * was intended - so the host answers with a ready message reporting what it actually got.
 */
export interface MesherBindArenaControl {
    type: "bind-arena";

    /**
     * Caller-defined identifier, echoed back.
     */
    id: number;

    /**
     * The arena's backing buffer.
     */
    buffer: ArrayBufferLike;

    /**
     * The arena's slot capacity.
     */
    capacity: number;

    /**
     * Bytes of meta-data per slot.
     */
    metaByteLength: number;

    /**
     * Whether the arena reserves per-slot version counters.
     */
    versioned?: boolean;

    /**
     * (Optional) A second arena for occluder slots. Defaults to the same arena.
     */
    occluders?: {
        buffer: ArrayBufferLike;
        capacity: number;
        metaByteLength: number;
        versioned?: boolean;
    };
}

/**
 * Control messages a mesher worker understands, alongside mesh requests.
 */
export type MesherControl = MesherBindArenaControl;

/**
 * The host's answer to a control message.
 */
export interface MesherReadyMessage {
    type: "ready";

    /**
     * The identifier of the control message being answered.
     */
    id: number;

    /**
     * Whether the arena the worker received is genuinely shared with the sender. False
     * means the buffer arrived as a copy and arena requests will mesh stale data.
     */
    shared: boolean;

    /**
     * Set when the control message could not be honoured.
     */
    error?: string;
}

/**
 * BVXWorkerHost wires a BVXMesher into a Web Worker global scope. The library
 * deliberately does not construct Workers itself - bundlers and applications
 * have their own conventions for creating worker entry files. Instead, an
 * application provides a tiny worker entry that attaches the host:
 *
 * ```typescript
 * // mesher.worker.ts - the application's worker entry file
 * import { BVXWorkerHost } from '@astrum-forge/bvx-kit';
 *
 * new BVXWorkerHost().attach(self as never);
 * ```
 *
 * The application then posts MesherRequest objects to the Worker and receives
 * MesherResponse objects back, with all geometry buffers transferred rather
 * than copied. BVXMesherPool does exactly that and handles the bookkeeping.
 *
 * ## The host answers every message
 *
 * A message handler that throws posts nothing, and a caller waiting on a request id
 * then waits forever. So this host never lets an exception escape: a malformed request
 * comes back as a MesherErrorResponse carrying the same id, and a failed control
 * message comes back as a ready message with `error` set. Whether the work succeeded is
 * the caller's business; whether it hears back is not.
 *
 * ## The host does no scheduling
 *
 * It processes one message per message, in arrival order, and holds no queue. Pacing,
 * coalescing and cancellation are the caller's - see BVXMesherPool, which implements
 * them without any timer or budget of its own.
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
     * The mesher this host drives, for an application that wants to configure it
     * directly rather than through control messages.
     */
    public get mesher(): BVXMesher {
        return this._mesher;
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

        scope.onmessage = (event: { data: MesherRequest | MesherControl }): void => {
            const message: MesherRequest | MesherControl = event.data;

            if (message.type === "bind-arena") {
                scope.postMessage(this._Bind(message));

                return;
            }

            let response: MesherResponse;

            try {
                response = mesher.process(message);
            }
            catch (error) {
                // process() is written not to throw, so reaching here means something
                // outside the request contract went wrong. It still has to be answered.
                response = {
                    id: message.id,
                    type: "error",
                    chunkKey: 0,
                    message: error instanceof Error ? error.message : String(error)
                };
            }

            try {
                scope.postMessage(response, BVXMesher.transferables(response));
            }
            catch (error) {
                // a response that cannot be posted - a detached buffer, a value the
                // structured clone algorithm rejects - still owes the caller an answer
                scope.postMessage({
                    id: message.id,
                    type: "error",
                    chunkKey: response.chunkKey,
                    message: `response could not be posted: ${error instanceof Error ? error.message : String(error)}`
                });
            }
        };
    }

    /**
     * Rebuilds the arenas an `arena` payload indexes into, over buffers the caller sent.
     */
    private _Bind(message: MesherBindArenaControl): MesherReadyMessage {
        try {
            const arena = new VoxelChunkArena(message.capacity, message.metaByteLength, message.buffer, message.versioned ?? false);

            const occluders = message.occluders !== undefined
                ? new VoxelChunkArena(message.occluders.capacity, message.occluders.metaByteLength, message.occluders.buffer, message.occluders.versioned ?? false)
                : null;

            this._mesher.bindArena(arena, occluders);

            return { type: "ready", id: message.id, shared: arena.isShared };
        }
        catch (error) {
            return {
                type: "ready",
                id: message.id,
                shared: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}
