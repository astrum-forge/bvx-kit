import { BVXMesher } from "@astrum-forge/bvx-kit";
import { expandQuads } from "./blocky-expand";
import { blockyTransferables, type BlockyMeshRequest, type BlockyMeshResponse, type EditorMeshRequest, type EditorMeshResponse } from "./mesh-protocol";

/**
 * Worker entry point. All geometry generation the editor asks for runs here,
 * off the main thread.
 *
 * This is a hand-written loop rather than BVXWorkerHost because the blocky path
 * does more than the kit's mesher does: it takes the packed quad list through
 * the editor's palette and occlusion curve into finished vertex streams. That
 * expansion used to run on the main thread and was measured at 51 us per chunk,
 * 40% of the whole pipeline, which is what capped streaming regardless of how
 * many workers were meshing. Everything else is passed straight through to the
 * kit's own mesher.
 */
const mesher = new BVXMesher();

/**
 * Handles a blocky request: face visibility and baked occlusion from the kit,
 * then expansion into vertex streams here.
 */
function processBlocky(request: BlockyMeshRequest): BlockyMeshResponse {
    const packed = mesher.process({
        id: request.id,
        type: "quads",
        payload: request.payload,

        // Water needs only a coarse "how enclosed is this face" measure to grow
        // surf from, at a quarter of the sampling cost - and it must not count
        // neighbouring water as solid, or a wide body floods its own shoreline.
        occlusion: request.water ? "face" : "corner",
        occlusionSource: request.water ? "occluders" : "merged"
    });

    if (packed.type !== "quads") {
        throw new Error(`bvx: quads request returned '${packed.type}'` + (packed.type === "error" ? ` - ${packed.message}` : ""));
    }

    const mesh = expandQuads(packed.quads, packed.meta, request.laneColor, request.water);

    return {
        id: request.id,
        type: "blocky",
        chunkKey: packed.chunkKey,

        // the occupancy buffers came in with the request and go straight back, so the
        // pool can hand them to the next one instead of allocating
        recycle: packed.recycle,

        positions: mesh.positions,
        normals: mesh.normals,
        colors: mesh.colors,
        occlusion: mesh.occlusion,
        indices: mesh.indices,
        faceCount: mesh.faceCount
    };
}

self.onmessage = (event: MessageEvent<EditorMeshRequest>): void => {
    const request = event.data;

    // Never let an exception escape: a message handler that throws posts nothing, and
    // the pool then waits on that id forever. Answer with the kit's error response
    // instead, which the pool turns into a rejected promise.
    try {
        if (request.type === "blocky") {
            const response = processBlocky(request);

            (self as unknown as Worker).postMessage(response, blockyTransferables(response));

            return;
        }

        const response: EditorMeshResponse = mesher.process(request);

        (self as unknown as Worker).postMessage(response, BVXMesher.transferables(response));
    }
    catch (error) {
        // Derive the key defensively - a payload malformed enough to make process()
        // throw can make chunkKeyOf() throw too, and an exception from inside this
        // handler is the exact unanswered-promise hang the handler exists to prevent.
        let chunkKey = 0;

        try {
            chunkKey = BVXMesher.chunkKeyOf(request.payload);
        }
        catch {
            // keep 0 - the pool routes by request id, not by chunk key
        }

        // hand the request's occupancy buffers back even on failure, or the pool
        // allocates replacements for every buffer an error strands in this worker
        let recycle: Uint32Array[] | undefined;

        if (request.payload?.kind === "neighbourhood") {
            recycle = request.payload.occluders !== undefined
                ? [request.payload.chunk.occupancy, request.payload.occluders.occupancy]
                : [request.payload.chunk.occupancy];
        }

        (self as unknown as Worker).postMessage({
            id: request.id,
            type: "error",
            chunkKey: chunkKey,
            recycle: recycle,
            message: error instanceof Error ? error.message : String(error)
        }, recycle !== undefined ? recycle.map((view) => view.buffer as ArrayBuffer) : []);
    }
};
