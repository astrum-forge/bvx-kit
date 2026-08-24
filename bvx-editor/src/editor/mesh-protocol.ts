import type { ChunkNeighbourhood, MesherPayload, MesherRequest, MesherRequestBase, MesherResponse, MesherResponseBase } from "@astrum-forge/bvx-kit";
import type { BlockyMesh } from "./blocky-expand";

/**
 * Request to build a fully expanded blocky mesh for one chunk.
 *
 * The kit's own "quads" request stops at the packed quad list, because the
 * expansion past that point needs the editor's palette and occlusion curve.
 * This request carries those, so the whole job - face visibility, ambient
 * occlusion, and the vertex streams - completes inside the worker and the main
 * thread only uploads the result.
 *
 * It extends MesherRequestBase so the kit's pool can carry it: the pool is generic over
 * the request type and takes `transferables` and `keyOf` hooks for exactly this.
 */
export interface BlockyMeshRequest extends MesherRequestBase {
    type: "blocky";

    /**
     * The chunk and its 26 neighbours. Always a `neighbourhood` payload here - the
     * editor has the live world in hand and packing one costs 1.2 us against BVW1's
     * 17.2, all of it on the thread that is trying to render.
     */
    payload: MesherPayload;

    /**
     * A flat colour for the whole lane, or null to take each voxel's colour from
     * its meta-data through the palette.
     */
    laneColor: readonly number[] | null;

    /**
     * Whether this is the water lane. Water takes a coarser per-face occlusion
     * measure, samples it from the occluders alone so it does not shade itself,
     * and spends it on the vertex colour as a shoreline mask.
     */
    water: boolean;
}

/**
 * A fully expanded blocky mesh, ready to upload.
 */
export interface BlockyMeshResponse extends MesherResponseBase, BlockyMesh {
    type: "blocky";
}

/**
 * Everything the editor's mesher worker accepts - the kit's own request types
 * plus the editor's expanded blocky request.
 */
export type EditorMeshRequest = MesherRequest | BlockyMeshRequest;

/**
 * Everything the editor's mesher worker returns.
 */
export type EditorMeshResponse = MesherResponse | BlockyMeshResponse;

/**
 * The occupancy buffers of a neighbourhood payload, for the pool to recycle.
 */
export function payloadOccupancy(payload: MesherPayload): ChunkNeighbourhood[] {
    if (payload.kind !== "neighbourhood") {
        return [];
    }

    return payload.occluders !== undefined ? [payload.chunk, payload.occluders] : [payload.chunk];
}

/**
 * Collects the transferable buffers of an editor request, so the neighbourhood
 * occupancy moves rather than being cloned.
 */
export function editorRequestTransferables(request: EditorMeshRequest): ArrayBuffer[] {
    const buffers: ArrayBuffer[] = [];

    for (const neighbourhood of payloadOccupancy(request.payload)) {
        buffers.push(neighbourhood.occupancy.buffer as ArrayBuffer);
    }

    if (request.payload.kind === "snapshot") {
        buffers.push(request.payload.world.buffer as ArrayBuffer);

        if (request.payload.occluders !== undefined) {
            buffers.push(request.payload.occluders.buffer as ArrayBuffer);
        }
    }

    return buffers.filter((buffer, index) => buffer.byteLength > 0 && buffers.indexOf(buffer) === index);
}

/**
 * Collects the transferable buffers of a blocky response, so the vertex streams
 * move rather than being cloned.
 */
export function blockyTransferables(response: BlockyMeshResponse): ArrayBuffer[] {
    const buffers: ArrayBuffer[] = [
        response.positions.buffer as ArrayBuffer,
        response.normals.buffer as ArrayBuffer,
        response.colors.buffer as ArrayBuffer,
        response.indices.buffer as ArrayBuffer
    ];

    if (response.occlusion !== null) {
        buffers.push(response.occlusion.buffer as ArrayBuffer);
    }

    if (response.recycle !== undefined) {
        for (const occupancy of response.recycle) {
            buffers.push(occupancy.buffer as ArrayBuffer);
        }
    }

    // a chunk with no visible faces allocates zero-length buffers; transferring
    // one is pointless, and postMessage rejects the same buffer twice - which is
    // exactly what several zero-length allocations can collapse into
    return buffers.filter((buffer, index) => buffer.byteLength > 0 && buffers.indexOf(buffer) === index);
}
