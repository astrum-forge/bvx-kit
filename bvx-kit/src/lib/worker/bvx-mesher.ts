import { MortonKey } from "../math/morton-key.js";
import { VoxelChunk } from "../engine/chunks/voxel-chunk.js";
import { VoxelFaceGeometry } from "../engine/geometry/voxel-face-geometry.js";
import { VoxelSmoothGeometry } from "../engine/geometry/voxel-smooth-geometry.js";
import { VoxelWorld } from "../engine/voxel-world.js";
import { BVXGeometry } from "../../lib/geometry/bvx-geometry.js";
import { BVXSerializer } from "../serialize/bvx-serializer.js";

/**
 * Request to generate blocky face geometry for a single chunk.
 *
 * The world payload is a BVW1 binary snapshot (see BVXSerializer.saveWorld)
 * containing the target chunk and any neighbouring chunks required for seam
 * checks. All request fields are structured-clone friendly, so requests can be
 * posted to a Web Worker as-is with the world buffer as a transferable.
 */
export interface MesherFacesRequest {
    /**
     * Caller-defined identifier, echoed back in the response.
     */
    id: number;

    /**
     * The type of geometry to generate.
     */
    type: "faces";

    /**
     * The MortonKey (encoded as a number) of the chunk to generate geometry for.
     */
    chunkKey: number;

    /**
     * Whether to use flipped triangle winding (see BVXGeometry.getIndices).
     */
    flipped: boolean;

    /**
     * BVW1 binary world snapshot containing the chunk and its neighbours.
     */
    world: Uint8Array;
}

/**
 * Request to generate smooth surface geometry for a single chunk.
 */
export interface MesherSmoothRequest {
    /**
     * Caller-defined identifier, echoed back in the response.
     */
    id: number;

    /**
     * The type of geometry to generate.
     */
    type: "smooth";

    /**
     * The MortonKey (encoded as a number) of the chunk to generate geometry for.
     */
    chunkKey: number;

    /**
     * The number of smoothing passes (see VoxelSmoothGeometry.computeGeometry).
     */
    smoothing: number;

    /**
     * Whether to use flipped triangle winding (see VoxelSmoothGeometry.computeGeometry).
     */
    flipped: boolean;

    /**
     * BVW1 binary world snapshot containing the chunk and its neighbours.
     */
    world: Uint8Array;
}

/**
 * Union of all mesher request types.
 */
export type MesherRequest = MesherFacesRequest | MesherSmoothRequest;

/**
 * Response containing generated blocky face geometry. The renderer combines the
 * indices with the static BVXGeometry vertex/normal/uv lookup tables.
 */
export interface MesherFacesResponse {
    /**
     * The identifier of the originating request.
     */
    id: number;

    /**
     * The type of geometry that was generated.
     */
    type: "faces";

    /**
     * The MortonKey (encoded as a number) of the chunk geometry was generated for.
     */
    chunkKey: number;

    /**
     * The 6-bit face visibility mask for each of the 4096 BitVoxels
     * (see VoxelFaceGeometry.indices).
     */
    faceMasks: Uint8Array;

    /**
     * Renderable triangle indices into the static BVXGeometry lookup tables.
     */
    indices: Uint32Array;
}

/**
 * Response containing generated smooth surface geometry.
 */
export interface MesherSmoothResponse {
    /**
     * The identifier of the originating request.
     */
    id: number;

    /**
     * The type of geometry that was generated.
     */
    type: "smooth";

    /**
     * The MortonKey (encoded as a number) of the chunk geometry was generated for.
     */
    chunkKey: number;

    /**
     * Vertex positions (3 floats per vertex).
     */
    vertices: Float32Array;

    /**
     * Vertex normals (3 floats per vertex).
     */
    normals: Float32Array;

    /**
     * Triangle indices (3 indices per triangle).
     */
    indices: Uint32Array;
}

/**
 * Union of all mesher response types.
 */
export type MesherResponse = MesherFacesResponse | MesherSmoothResponse;

/**
 * BVXMesher processes MesherRequests into MesherResponses. It is intentionally
 * free of any DOM or Worker API dependencies, so the same implementation runs
 * on the main thread, inside a Web Worker (see BVXWorkerHost) or in a Node.js
 * worker thread.
 *
 * Geometry generators are allocated once per BVXMesher instance and reused
 * across requests, so a long-lived instance performs no per-request geometry
 * buffer allocations beyond the response copies.
 */
export class BVXMesher {
    /**
     * Reusable blocky face geometry generator.
     */
    private readonly _faceGeometry: VoxelFaceGeometry;

    /**
     * Reusable smooth surface geometry generator.
     */
    private readonly _smoothGeometry: VoxelSmoothGeometry;

    constructor() {
        this._faceGeometry = new VoxelFaceGeometry();
        this._smoothGeometry = new VoxelSmoothGeometry();
    }

    /**
     * Processes a single MesherRequest and returns the corresponding response.
     * Unknown chunk keys produce a response with empty geometry buffers.
     *
     * @param request - The MesherRequest to process.
     * @returns - The generated MesherResponse.
     */
    public process(request: MesherRequest): MesherResponse {
        // decode the world snapshot - this reconstructs the target chunk and the
        // neighbouring chunks required for seam-correct geometry
        const world: VoxelWorld = BVXSerializer.loadWorld(request.world);
        const chunk: VoxelChunk | null = world.get(new MortonKey(request.chunkKey));

        if (request.type === "faces") {
            if (chunk === null) {
                return {
                    id: request.id,
                    type: "faces",
                    chunkKey: request.chunkKey,
                    faceMasks: new Uint8Array(0),
                    indices: new Uint32Array(0)
                };
            }

            const geometry: VoxelFaceGeometry = this._faceGeometry;
            geometry.computeIndices(chunk, world);

            return {
                id: request.id,
                type: "faces",
                chunkKey: request.chunkKey,
                faceMasks: new Uint8Array(geometry.indices),
                indices: BVXGeometry.getIndices(geometry, request.flipped)
            };
        }

        if (chunk === null) {
            return {
                id: request.id,
                type: "smooth",
                chunkKey: request.chunkKey,
                vertices: new Float32Array(0),
                normals: new Float32Array(0),
                indices: new Uint32Array(0)
            };
        }

        const geometry: VoxelSmoothGeometry = this._smoothGeometry;
        geometry.computeGeometry(chunk, world, request.smoothing, request.flipped);

        // copy the exact-length views out of the reusable internal buffers so the
        // response owns (and can transfer) its own data
        return {
            id: request.id,
            type: "smooth",
            chunkKey: request.chunkKey,
            vertices: geometry.vertices.slice(),
            normals: geometry.normals.slice(),
            indices: geometry.indices.slice()
        };
    }

    /**
     * Collects the transferable ArrayBuffers of a MesherResponse, for zero-copy
     * postMessage() calls from a Web Worker.
     *
     * @param response - The MesherResponse to collect buffers from.
     * @returns - The list of transferable ArrayBuffers.
     */
    public static transferables(response: MesherResponse): ArrayBuffer[] {
        if (response.type === "faces") {
            return [response.faceMasks.buffer as ArrayBuffer, response.indices.buffer as ArrayBuffer];
        }

        return [response.vertices.buffer as ArrayBuffer, response.normals.buffer as ArrayBuffer, response.indices.buffer as ArrayBuffer];
    }
}
