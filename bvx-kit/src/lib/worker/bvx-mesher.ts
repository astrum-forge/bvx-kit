import { MortonKey } from "../math/morton-key.js";
import { VoxelChunk } from "../engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../engine/chunks/voxel-chunk-0.js";
import { VoxelChunkArena } from "../engine/chunks/voxel-chunk-arena.js";
import { VoxelFaceGeometry } from "../engine/geometry/voxel-face-geometry.js";
import { VoxelSmoothGeometry, SmoothOcclusionMode } from "../engine/geometry/voxel-smooth-geometry.js";
import { VoxelQuadGeometry, QuadOcclusion, QuadOcclusionSource } from "../engine/geometry/voxel-quad-geometry.js";
import { VoxelWorld } from "../engine/voxel-world.js";
import { BVXGeometry } from "../geometry/bvx-geometry.js";
import { BVXSerializer } from "../serialize/bvx-serializer.js";
import {
    ArenaNeighbourhood,
    ChunkNeighbourhood,
    ChunkNeighbourhoodPacker,
    ChunkNeighbourhoodReader
} from "./chunk-neighbourhood.js";

/**
 * How a request delivers the chunk and its 26 neighbours.
 *
 * Three ways, in descending cost on the calling thread. Measured on an M1 over 64
 * surface chunks, per request:
 *
 * | kind | calling thread | worker | note |
 * | --- | ---: | ---: | --- |
 * | `snapshot` | 17.2 us | 6.6 us | BVW1, the 1.x protocol |
 * | `neighbourhood` | 1.2 us | ~1.2 us | a straight copy of the same bytes |
 * | `arena` | ~0 us | ~1.2 us | slot indices only; needs a shared arena |
 *
 * Prefer `neighbourhood`. `snapshot` remains because a request built from stored data,
 * or one that has to cross a boundary that cannot carry typed arrays, already has BVW1
 * bytes in hand and decoding them is cheaper than re-encoding.
 */
export type MesherPayloadKind = "neighbourhood" | "arena" | "snapshot";

/**
 * A neighbourhood delivered as packed occupancy words. The default and the cheapest
 * option that needs no shared memory.
 */
export interface MesherNeighbourhoodPayload {
    kind: "neighbourhood";

    /**
     * The chunk being meshed and its 26 neighbours.
     */
    chunk: ChunkNeighbourhood;

    /**
     * (Optional) The occluding layers' occupancy over the same neighbourhood.
     */
    occluders?: ChunkNeighbourhood;
}

/**
 * A neighbourhood delivered as arena slot indices. Copies nothing, and is only sound
 * over a SharedArrayBuffer arena whose owner honours one of the protocols
 * VoxelChunkArena documents.
 */
export interface MesherArenaPayload {
    kind: "arena";

    /**
     * The chunk being meshed and its 26 neighbours, by arena slot.
     */
    chunk: ArenaNeighbourhood;

    /**
     * (Optional) The occluding layers' slots over the same neighbourhood. Indexes the
     * occluder arena, which may be the same arena.
     */
    occluders?: ArenaNeighbourhood;
}

/**
 * A neighbourhood delivered as a BVW1 binary snapshot - the 1.x protocol.
 */
export interface MesherSnapshotPayload {
    kind: "snapshot";

    /**
     * The encoded MortonKey of the chunk to mesh.
     */
    chunkKey: number;

    /**
     * BVW1 snapshot containing the chunk and its neighbours.
     */
    world: Uint8Array;

    /**
     * (Optional) BVW1 snapshot of the occluding occupancy.
     */
    occluders?: Uint8Array;
}

/**
 * How a request delivers its chunk data.
 */
export type MesherPayload = MesherNeighbourhoodPayload | MesherArenaPayload | MesherSnapshotPayload;

/**
 * Fields every mesh request carries.
 */
export interface MesherRequestBase {
    /**
     * Caller-defined identifier, echoed back in the response.
     */
    id: number;

    /**
     * The chunk and its neighbours (see MesherPayload).
     */
    payload: MesherPayload;
}

/**
 * Request to generate blocky face geometry for a single chunk.
 */
export interface MesherFacesRequest extends MesherRequestBase {
    type: "faces";

    /**
     * Whether to use flipped triangle winding (see BVXGeometry.getIndices).
     */
    flipped: boolean;

    /**
     * (Optional) Whether to build the renderable triangle indices. Defaults to true.
     *
     * Set false by a renderer that assembles its own vertex data from faceMasks and
     * touched - per-face colouring or baked ambient occlusion both force that, because
     * the static BVXGeometry vertex tables carry neither. Such a renderer never reads
     * response.indices, and building it is not free: it is an allocation of
     * faceCount * 6 uint32 that must then be transferred back.
     */
    indices?: boolean;
}

/**
 * Request to generate smooth surface geometry for a single chunk.
 */
export interface MesherSmoothRequest extends MesherRequestBase {
    type: "smooth";

    /**
     * The number of smoothing passes (see VoxelSmoothGeometry.computeGeometry).
     */
    smoothing: number;

    /**
     * Whether to use flipped triangle winding.
     */
    flipped: boolean;

    /**
     * (Optional) How blur-ambiguous surface cells are claimed when meshing with
     * occluders. Defaults to "primary".
     */
    occlusionMode?: SmoothOcclusionMode;
}

/**
 * Request to generate packed blocky quads with ambient occlusion baked in.
 *
 * This is the faces request with the expensive half done as well. A faces response
 * hands back 6-bit masks the caller must still expand into per-corner occlusion and
 * vertex data; a quads response hands back one 32-bit word per visible face with the
 * occlusion already resolved.
 */
export interface MesherQuadsRequest extends MesherRequestBase {
    type: "quads";

    /**
     * (Optional) How per-corner ambient occlusion is derived. Defaults to "corner".
     */
    occlusion?: QuadOcclusion;

    /**
     * (Optional) Which occupancy the ambient occlusion samples. Defaults to "merged".
     */
    occlusionSource?: QuadOcclusionSource;
}

/**
 * Union of all mesher request types.
 */
export type MesherRequest = MesherFacesRequest | MesherSmoothRequest | MesherQuadsRequest;

/**
 * Fields every response carries.
 */
export interface MesherResponseBase {
    /**
     * Which kind of response this is. Declared here rather than only on the concrete
     * types so an application that extends the protocol still produces something the
     * pool can route.
     */
    type: string;

    /**
     * The identifier of the originating request.
     */
    id: number;

    /**
     * The MortonKey (encoded as a number) of the chunk the request named.
     */
    chunkKey: number;

    /**
     * The occupancy buffers the request arrived with, handed straight back so the
     * caller can reuse them instead of allocating the next request's.
     *
     * Present only for a `neighbourhood` payload, whose buffers were transferred into
     * the worker and would otherwise be garbage. A caller that does not want them can
     * ignore the field; the buffers are transferred either way.
     */
    recycle?: Uint32Array[];
}

/**
 * Response containing generated blocky face geometry. The renderer combines the indices
 * with the static BVXGeometry vertex/normal/uv lookup tables.
 */
export interface MesherFacesResponse extends MesherResponseBase {
    type: "faces";

    /**
     * The 6-bit face visibility mask for each of the 4096 BitVoxels.
     */
    faceMasks: Uint8Array;

    /**
     * The BitVoxel indices carrying a non-zero mask, in ascending order.
     *
     * A renderer building its own vertex data should walk this rather than scanning all
     * 4096 entries: most chunks in a world with depth are uniform and produce nothing.
     */
    touched: Uint16Array;

    /**
     * The total number of visible faces across every mask.
     */
    faceCount: number;

    /**
     * Renderable triangle indices, or empty when the request set indices to false.
     */
    indices: Uint32Array;
}

/**
 * Response containing generated smooth surface geometry.
 */
export interface MesherSmoothResponse extends MesherResponseBase {
    type: "smooth";

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
 * Response containing packed blocky quads with baked ambient occlusion.
 */
export interface MesherQuadsResponse extends MesherResponseBase {
    type: "quads";

    /**
     * One packed word per visible face (see VoxelQuadGeometry for the layout), in
     * ascending BitVoxel index and then ascending face order.
     */
    quads: Uint32Array;

    /**
     * The chunk's 64 per-voxel meta-data entries, widened to 32 bits so one response
     * shape serves every chunk width. Empty when the chunk carries no meta-data.
     */
    meta: Uint32Array;
}

/**
 * A request that could not be answered.
 *
 * Meshing is a pure function of its input, so the only way to get one of these is a
 * malformed request - a payload kind the mesher was not configured for, an arena
 * request with no arena bound, an undecodable snapshot. It is a response rather than a
 * thrown exception because a thrown exception inside a worker's message handler posts
 * nothing, and the caller's promise then never settles.
 */
export interface MesherErrorResponse extends MesherResponseBase {
    type: "error";

    /**
     * What went wrong.
     */
    message: string;
}

/**
 * Union of all mesher response types.
 */
export type MesherResponse = MesherFacesResponse | MesherSmoothResponse | MesherQuadsResponse | MesherErrorResponse;

/**
 * BVXMesher turns MesherRequests into MesherResponses. It is free of any DOM or Worker
 * dependency, so the same implementation runs on the main thread, inside a Web Worker
 * (see BVXWorkerHost) or in a Node.js worker thread.
 *
 * Geometry generators and the neighbourhood reader are allocated once per instance and
 * reused, so a long-lived mesher fed `neighbourhood` payloads allocates nothing per
 * request beyond the response buffers themselves.
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

    /**
     * Reusable packed quad generator.
     */
    private readonly _quadGeometry: VoxelQuadGeometry;

    /**
     * Reusable binder for the chunk neighbourhood.
     */
    private readonly _reader: ChunkNeighbourhoodReader;

    /**
     * Reusable binder for the occluder neighbourhood. Separate from _reader because a
     * request binds both at once and one reader owns one world.
     */
    private readonly _occluderReader: ChunkNeighbourhoodReader;

    /**
     * The arena an `arena` payload's slots index into, or null when none is bound.
     */
    private _arena: VoxelChunkArena | null;

    /**
     * The arena an `arena` payload's occluder slots index into. Defaults to _arena.
     */
    private _occluderArena: VoxelChunkArena | null;

    /**
     * Reused key for chunk lookups.
     */
    private readonly _key: MortonKey;

    constructor() {
        this._faceGeometry = new VoxelFaceGeometry();
        this._smoothGeometry = new VoxelSmoothGeometry();
        this._quadGeometry = new VoxelQuadGeometry();
        this._reader = new ChunkNeighbourhoodReader();
        this._occluderReader = new ChunkNeighbourhoodReader();
        this._arena = null;
        this._occluderArena = null;
        this._key = new MortonKey();
    }

    /**
     * Binds the arena that `arena` payloads index into. Until this is called, an arena
     * request is answered with an error response rather than a guess.
     *
     * @param arena - The arena holding the chunk data.
     * @param occluders - (Optional) A separate arena holding the occluding layers.
     * Defaults to the same arena.
     */
    public bindArena(arena: VoxelChunkArena | null, occluders: VoxelChunkArena | null = null): void {
        this._arena = arena;
        this._occluderArena = occluders ?? arena;
    }

    /**
     * The arena currently bound for `arena` payloads, or null.
     */
    public get arena(): VoxelChunkArena | null {
        return this._arena;
    }

    /**
     * Processes a single MesherRequest and returns the corresponding response.
     *
     * Never throws for a malformed request - it answers with a MesherErrorResponse, so
     * a caller waiting on the id always gets something back.
     *
     * @param request - The MesherRequest to process.
     * @returns - The generated MesherResponse.
     */
    public process(request: MesherRequest): MesherResponse {
        const chunkKey: number = BVXMesher.chunkKeyOf(request.payload);

        try {
            return this._Process(request, chunkKey);
        }
        catch (error) {
            return {
                id: request.id,
                type: "error",
                chunkKey: chunkKey,
                message: error instanceof Error ? error.message : String(error),
                recycle: BVXMesher._Recyclable(request.payload)
            };
        }
    }

    /**
     * The encoded MortonKey a payload names.
     *
     * @param payload - The payload to inspect.
     * @returns - The encoded MortonKey.
     */
    public static chunkKeyOf(payload: MesherPayload): number {
        return payload.kind === "snapshot" ? payload.chunkKey : payload.chunk.chunkKey;
    }

    /**
     * Collects the transferable ArrayBuffers of a MesherRequest, for a zero-copy
     * postMessage into a worker.
     *
     * A `neighbourhood` payload's occupancy buffers are transferred; its meta-data view
     * is not, because it aliases the live chunk's storage and detaching it would leave
     * the chunk unusable. An `arena` payload transfers nothing - a SharedArrayBuffer is
     * not transferable and its slot list is small enough that cloning it is free.
     *
     * @param request - The request being sent.
     * @returns - The list of transferable ArrayBuffers.
     */
    public static requestTransferables(request: MesherRequest): ArrayBuffer[] {
        const payload: MesherPayload = request.payload;
        const buffers: ArrayBuffer[] = [];

        if (payload.kind === "neighbourhood") {
            buffers.push(payload.chunk.occupancy.buffer as ArrayBuffer);

            if (payload.occluders !== undefined) {
                buffers.push(payload.occluders.occupancy.buffer as ArrayBuffer);
            }
        }
        else if (payload.kind === "snapshot") {
            buffers.push(payload.world.buffer as ArrayBuffer);

            if (payload.occluders !== undefined) {
                buffers.push(payload.occluders.buffer as ArrayBuffer);
            }
        }

        return BVXMesher._Distinct(buffers);
    }

    /**
     * Collects the transferable ArrayBuffers of a MesherResponse, for a zero-copy
     * postMessage out of a worker.
     *
     * @param response - The MesherResponse to collect buffers from.
     * @returns - The list of transferable ArrayBuffers.
     */
    public static transferables(response: MesherResponse): ArrayBuffer[] {
        const buffers: ArrayBuffer[] = [];

        switch (response.type) {
            case "faces":
                buffers.push(response.faceMasks.buffer as ArrayBuffer, response.touched.buffer as ArrayBuffer, response.indices.buffer as ArrayBuffer);
                break;
            case "quads":
                buffers.push(response.quads.buffer as ArrayBuffer, response.meta.buffer as ArrayBuffer);
                break;
            case "smooth":
                buffers.push(response.vertices.buffer as ArrayBuffer, response.normals.buffer as ArrayBuffer, response.indices.buffer as ArrayBuffer);
                break;
            default:
                break;
        }

        if (response.recycle !== undefined) {
            for (const buffer of response.recycle) {
                buffers.push(buffer.buffer as ArrayBuffer);
            }
        }

        return BVXMesher._Distinct(buffers);
    }

    /**
     * Drops zero-length and duplicate buffers from a transfer list.
     *
     * An empty array is the mesher's answer for "nothing here" and for an index buffer
     * a renderer opted out of. Transferring a zero-length buffer is legal but pointless,
     * and postMessage rejects the same buffer appearing twice - which is exactly what
     * happens if two of these come from one shared empty allocation.
     */
    private static _Distinct(buffers: ArrayBuffer[]): ArrayBuffer[] {
        const seen = new Set<ArrayBuffer>();
        const result: ArrayBuffer[] = [];

        for (const buffer of buffers) {
            if (buffer.byteLength === 0 || seen.has(buffer)) {
                continue;
            }

            seen.add(buffer);
            result.push(buffer);
        }

        return result;
    }

    /**
     * The occupancy buffers a response should hand back for reuse.
     */
    private static _Recyclable(payload: MesherPayload): Uint32Array[] | undefined {
        if (payload.kind !== "neighbourhood") {
            return undefined;
        }

        return payload.occluders !== undefined
            ? [payload.chunk.occupancy, payload.occluders.occupancy]
            : [payload.chunk.occupancy];
    }

    /**
     * Resolves a payload into the chunk to mesh, the world holding its neighbours, and
     * the occluding world.
     */
    private _Bind(payload: MesherPayload): { chunk: VoxelChunk | null; world: VoxelWorld; occluders: VoxelWorld | null; meta: Uint8Array | Uint16Array | Uint32Array | null } {
        if (payload.kind === "neighbourhood") {
            const chunk: VoxelChunk = this._reader.bind(payload.chunk);
            const present: boolean = (payload.chunk.presence & (1 << 13)) !== 0;

            let occluders: VoxelWorld | null = null;

            if (payload.occluders !== undefined) {
                this._occluderReader.bind(payload.occluders);
                occluders = this._occluderReader.world;
            }

            return { chunk: present ? chunk : null, world: this._reader.world, occluders: occluders, meta: payload.chunk.meta };
        }

        if (payload.kind === "arena") {
            const arena: VoxelChunkArena | null = this._arena;

            if (arena === null) {
                throw new Error("BVXMesher.process(MesherRequest) - received an 'arena' payload but no arena is bound; call bindArena() first");
            }

            const chunk: VoxelChunk = this._reader.bindArena(payload.chunk, arena);
            const present: boolean = payload.chunk.slots[13] >= 0;

            let occluders: VoxelWorld | null = null;

            if (payload.occluders !== undefined) {
                const occluderArena: VoxelChunkArena | null = this._occluderArena;

                if (occluderArena === null) {
                    throw new Error("BVXMesher.process(MesherRequest) - received an 'arena' payload with occluders but no occluder arena is bound");
                }

                this._occluderReader.bindArena(payload.occluders, occluderArena);
                occluders = this._occluderReader.world;
            }

            return { chunk: present ? chunk : null, world: this._reader.world, occluders: occluders, meta: null };
        }

        // BVW1 - the 1.x protocol. Rebuilds a world and its chunks per request.
        const world: VoxelWorld = BVXSerializer.loadWorld(payload.world);

        this._key.key = payload.chunkKey;

        const chunk: VoxelChunk | null = world.get(this._key);
        const occluders: VoxelWorld | null = payload.occluders !== undefined ? BVXSerializer.loadWorld(payload.occluders) : null;

        return { chunk: chunk, world: world, occluders: occluders, meta: chunk !== null ? chunk.metaData : null };
    }

    /**
     * Meshes one bound request. Throws only for a malformed payload; process() turns
     * that into an error response.
     */
    private _Process(request: MesherRequest, chunkKey: number): MesherResponse {
        const bound = this._Bind(request.payload);
        const recycle: Uint32Array[] | undefined = BVXMesher._Recyclable(request.payload);

        let chunk: VoxelChunk | null = bound.chunk;

        // With occluders, a layer can own smooth surface in a chunk it holds no voxels
        // at - the tapering rim of an overlay patch, or a contested cell of a partition.
        // Meshing an empty centre chunk emits that surface instead of dropping it, and
        // matches the merged meshed set the seam ownership uses.
        if (chunk === null && request.type === "smooth" && bound.occluders !== null) {
            this._key.key = chunkKey;

            if (bound.occluders.get(this._key) !== null) {
                chunk = request.payload.kind === "snapshot" ? new VoxelChunk0(this._key.clone()) : this._reader.centre;

                bound.world.insert(chunk);
            }
        }

        if (request.type === "quads") {
            if (chunk === null) {
                return { id: request.id, type: "quads", chunkKey: chunkKey, quads: new Uint32Array(0), meta: new Uint32Array(0), recycle: recycle };
            }

            const geometry: VoxelQuadGeometry = this._quadGeometry;

            geometry.computeQuads(chunk, bound.world, bound.occluders, request.occlusion ?? "corner", request.occlusionSource ?? "merged");

            const meta: Uint8Array | Uint16Array | Uint32Array | null = bound.meta;

            return {
                id: request.id,
                type: "quads",
                chunkKey: chunkKey,
                quads: new Uint32Array(geometry.quads),
                meta: meta !== null ? Uint32Array.from(meta) : new Uint32Array(0),
                recycle: recycle
            };
        }

        if (request.type === "faces") {
            if (chunk === null) {
                return {
                    id: request.id,
                    type: "faces",
                    chunkKey: chunkKey,
                    faceMasks: new Uint8Array(0),
                    touched: new Uint16Array(0),
                    faceCount: 0,
                    indices: new Uint32Array(0),
                    recycle: recycle
                };
            }

            const geometry: VoxelFaceGeometry = this._faceGeometry;

            geometry.computeIndices(chunk, bound.world, bound.occluders);

            return {
                id: request.id,
                type: "faces",
                chunkKey: chunkKey,
                faceMasks: new Uint8Array(geometry.indices),
                touched: new Uint16Array(geometry.touched),
                faceCount: geometry.popCount(),
                indices: request.indices === false ? new Uint32Array(0) : BVXGeometry.getIndices(geometry, request.flipped),
                recycle: recycle
            };
        }

        if (chunk === null) {
            return {
                id: request.id,
                type: "smooth",
                chunkKey: chunkKey,
                vertices: new Float32Array(0),
                normals: new Float32Array(0),
                indices: new Uint32Array(0),
                recycle: recycle
            };
        }

        const geometry: VoxelSmoothGeometry = this._smoothGeometry;

        geometry.computeGeometry(chunk, bound.world, request.smoothing, request.flipped, bound.occluders, request.occlusionMode ?? "primary");

        // copy the exact-length views out of the reusable internal buffers so the
        // response owns (and can transfer) its own data
        return {
            id: request.id,
            type: "smooth",
            chunkKey: chunkKey,
            vertices: geometry.vertices.slice(),
            normals: geometry.normals.slice(),
            indices: geometry.indices.slice(),
            recycle: recycle
        };
    }
}

export { ChunkNeighbourhoodPacker, ChunkNeighbourhoodReader };
export type { ChunkNeighbourhood, ArenaNeighbourhood };
