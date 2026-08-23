import { BVXMesher } from "@astrumforge/bvx-kit";
import { expandQuads } from "./blocky-expand";
import { blockyTransferables, type BlockyMeshRequest, type EditorMeshRequest, type EditorMeshResponse } from "./mesh-protocol";

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
function processBlocky(request: BlockyMeshRequest): EditorMeshResponse {
    const packed = mesher.process({
        id: request.id,
        type: "quads",
        chunkKey: request.chunkKey,
        world: request.world,
        occluders: request.occluders,

        // Water needs only a coarse "how enclosed is this face" measure to grow
        // surf from, at a quarter of the sampling cost - and it must not count
        // neighbouring water as solid, or a wide body floods its own shoreline.
        occlusion: request.water ? "face" : "corner",
        occlusionSource: request.water ? "occluders" : "merged"
    });

    if (packed.type !== "quads") {
        throw new Error("bvx: quads request returned a non-quads response");
    }

    const mesh = expandQuads(packed.quads, packed.meta, request.laneColor, request.water);

    return {
        id: request.id,
        type: "blocky",
        chunkKey: request.chunkKey,
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

    if (request.type === "blocky") {
        const response = processBlocky(request);

        (self as unknown as Worker).postMessage(response, response.type === "blocky" ? blockyTransferables(response) : []);

        return;
    }

    const response = mesher.process(request);

    (self as unknown as Worker).postMessage(response, BVXMesher.transferables(response));
};
