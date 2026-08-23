import type { MesherRequest, MesherResponse } from "@astrumforge/bvx-kit";
import type { BlockyMesh } from "./blocky-expand";

/**
 * Request to build a fully expanded blocky mesh for one chunk.
 *
 * The kit's own "quads" request stops at the packed quad list, because the
 * expansion past that point needs the editor's palette and occlusion curve.
 * This request carries those, so the whole job - face visibility, ambient
 * occlusion, and the vertex streams - completes inside the worker and the main
 * thread only uploads the result.
 */
export interface BlockyMeshRequest {
    id: number;
    type: "blocky";
    chunkKey: number;

    /**
     * BVW1 snapshot of the chunk and its 26 neighbours.
     */
    world: Uint8Array;

    /**
     * BVW1 snapshot of the occluding lanes over the same neighbourhood.
     */
    occluders?: Uint8Array;

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
export interface BlockyMeshResponse extends BlockyMesh {
    id: number;
    type: "blocky";
    chunkKey: number;
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

    // a chunk with no visible faces allocates zero-length buffers; transferring
    // one is pointless, and postMessage rejects the same buffer twice - which is
    // exactly what several zero-length allocations can collapse into
    return buffers.filter((buffer) => buffer.byteLength > 0);
}
