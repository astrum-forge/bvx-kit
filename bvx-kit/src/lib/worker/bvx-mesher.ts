import { MortonKey } from "../math/morton-key.js";
import { VoxelChunk } from "../engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../engine/chunks/voxel-chunk-0.js";
import { VoxelFaceGeometry } from "../engine/geometry/voxel-face-geometry.js";
import { VoxelSmoothGeometry, SmoothOcclusionMode } from "../engine/geometry/voxel-smooth-geometry.js";
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

    /**
     * (Optional) BVW1 binary snapshot of the occluding occupancy - the merged
     * chunks of the other layers whose cells cull hidden faces of this layer
     * (see VoxelFaceGeometry.computeIndices).
     */
    occluders?: Uint8Array;

    /**
     * (Optional) Whether to build the renderable triangle indices. Defaults to
     * true.
     *
     * Set false by a renderer that assembles its own vertex data from faceMasks
     * and touched - per-face colouring or baked ambient occlusion both force
     * that, because the static BVXGeometry vertex tables carry neither. Such a
     * renderer never reads response.indices, and building it is not free: it is
     * an allocation of faceCount * 6 uint32 that must then be transferred back.
     * A busy fluid chunk carries several thousand faces, so the dead buffer runs
     * to well over a hundred kilobytes per response - on a simulation remeshing
     * tens of chunks a frame, megabytes a frame of garbage.
     */
    indices?: boolean;
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

    /**
     * (Optional) BVW1 binary snapshot of the occluding occupancy - the merged
     * chunks of the other layers whose cells cull hidden surface pieces of this
     * layer (see VoxelSmoothGeometry.computeGeometry).
     */
    occluders?: Uint8Array;

    /**
     * (Optional) How blur-ambiguous surface cells are claimed when meshing with
     * occluders (see SmoothOcclusionMode). Defaults to "primary".
     */
    occlusionMode?: SmoothOcclusionMode;
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
     * The BitVoxel indices carrying a non-zero mask, in ascending order
     * (see VoxelGeometry.touched).
     *
     * A renderer building its own vertex data from faceMasks should walk this rather
     * than scanning all 4096 entries: most chunks in a world with depth are uniform
     * and produce nothing, and even a surface chunk typically populates only a few
     * hundred of them.
     */
    touched: Uint16Array;

    /**
     * The total number of visible faces across every mask - what the renderer needs
     * to size its buffers, without counting them itself.
     */
    faceCount: number;

    /**
     * Renderable triangle indices into the static BVXGeometry lookup tables, or
     * empty when the request set indices to false.
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
        const chunkKey: MortonKey = new MortonKey(request.chunkKey);

        let chunk: VoxelChunk | null = world.get(chunkKey);

        // decode the occluding occupancy snapshot when provided
        const occluders: VoxelWorld | null = request.occluders !== undefined ? BVXSerializer.loadWorld(request.occluders) : null;

        // With occluders, a layer can own smooth surface in a chunk it holds no
        // voxels at - the tapering rim of an overlay patch, or a contested cell of
        // a partition. Meshing an empty center chunk emits that surface instead of
        // dropping it, and matches the merged meshed set the seam ownership uses.
        if (chunk === null && request.type === "smooth" && occluders !== null && occluders.get(chunkKey) !== null) {
            chunk = new VoxelChunk0(chunkKey);
            world.insert(chunk);
        }

        if (request.type === "faces") {
            if (chunk === null) {
                return {
                    id: request.id,
                    type: "faces",
                    chunkKey: request.chunkKey,
                    faceMasks: new Uint8Array(0),
                    touched: new Uint16Array(0),
                    faceCount: 0,
                    indices: new Uint32Array(0)
                };
            }

            const geometry: VoxelFaceGeometry = this._faceGeometry;
            geometry.computeIndices(chunk, world, occluders);

            return {
                id: request.id,
                type: "faces",
                chunkKey: request.chunkKey,
                faceMasks: new Uint8Array(geometry.indices),
                touched: new Uint16Array(geometry.touched),
                faceCount: geometry.popCount(),
                indices: request.indices === false
                    ? new Uint32Array(0)
                    : BVXGeometry.getIndices(geometry, request.flipped)
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
        geometry.computeGeometry(chunk, world, request.smoothing, request.flipped, occluders, request.occlusionMode ?? "primary");

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
        const buffers: ArrayBuffer[] = response.type === "faces"
            ? [response.faceMasks.buffer as ArrayBuffer, response.touched.buffer as ArrayBuffer, response.indices.buffer as ArrayBuffer]
            : [response.vertices.buffer as ArrayBuffer, response.normals.buffer as ArrayBuffer, response.indices.buffer as ArrayBuffer];

        // An empty array is the mesher's answer for "nothing here" and for the
        // index buffer a renderer opted out of. Transferring a zero-length
        // buffer is legal but pointless, and postMessage rejects the same
        // buffer appearing twice - which is exactly what happens if two of
        // these ever come from one shared empty allocation.
        return buffers.filter((buffer) => buffer.byteLength > 0);
    }
}
