import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { VoxelWorld } from "../voxel-world.js";
import { SmoothOcclusionMode } from "./voxel-smooth-geometry.js";

/**
 * One chunk's smooth-meshing job.
 */
export interface SmoothMeshRequest {
    /**
     * The chunk to contour.
     */
    chunk: VoxelChunk;

    /**
     * The world the chunk belongs to, used for its 26 neighbours.
     */
    world: VoxelWorld;

    /**
     * A world whose occupancy merges into the contoured field and whose layers
     * claim surface pieces, or null to mesh standalone.
     */
    occluders: VoxelWorld | null;

    /**
     * Number of field smoothing passes, 0 to VoxelSmoothGeometry.MAX_SMOOTHING.
     */
    smoothing: number;

    /**
     * Whether to flip the triangle winding.
     */
    flipped: boolean;

    /**
     * How blur-ambiguous surface cells are claimed when meshing with occluders.
     */
    occlusionMode: SmoothOcclusionMode;
}

/**
 * Where a finished smooth mesh lives.
 *
 * - "cpu": the buffers are readable typed arrays the caller owns.
 * - "gpu": the geometry stayed on the device and the caller binds it by handle.
 *   Vertex and index counts are still reported, because a renderer needs them to
 *   issue the draw, but the vertex data itself never crosses back.
 */
export type SmoothMeshResidency = "cpu" | "gpu";

/**
 * A finished smooth mesh.
 */
export interface SmoothMeshResult {
    residency: SmoothMeshResidency;

    /**
     * Number of vertices. Positions and normals both hold three floats each.
     */
    vertexCount: number;

    /**
     * Number of triangle indices.
     */
    indexCount: number;

    /**
     * Vertex positions in chunk-local units, or null when residency is "gpu".
     */
    vertices: Float32Array | null;

    /**
     * Vertex normals, or null when residency is "gpu".
     */
    normals: Float32Array | null;

    /**
     * Triangle indices, or null when residency is "gpu".
     */
    indices: Uint32Array | null;

    /**
     * Opaque handle to the device-resident geometry, or null when residency is
     * "cpu". Its concrete type is the implementation's business; a renderer
     * adapter written against a particular implementation knows how to bind it.
     */
    handle: unknown;
}

/**
 * A smooth-surface mesher.
 *
 * The interface exists so an application can choose where contouring runs
 * without its call sites changing. Two properties make that choice meaningful
 * rather than cosmetic:
 *
 * - **It is asynchronous.** A CPU implementation resolves immediately; a GPU one
 *   has to submit work and cannot answer synchronously. Making the slow case the
 *   shape of the interface means adopting it later is not a rewrite.
 * - **Results carry their residency.** A GPU implementation's output stays on the
 *   device and is bound by handle, because reading it back costs more than the
 *   contouring saved. A caller that genuinely needs the vertices on the CPU must
 *   ask for a CPU mesher; one that only draws them does not care.
 *
 * Implementations are not required to support every request. `supports()` reports
 * what an implementation will accept, so a caller can route the rest to another
 * one rather than discovering a gap at meshing time.
 */
export interface SmoothMesher {
    /**
     * A short identifier for logs and UI, e.g. "cpu" or "webgpu".
     */
    readonly id: string;

    /**
     * Where this implementation leaves its output.
     */
    readonly residency: SmoothMeshResidency;

    /**
     * Whether this implementation can handle the provided request. A caller
     * holding a fallback mesher should consult this and route accordingly.
     */
    supports(request: SmoothMeshRequest): boolean;

    /**
     * Contours one chunk.
     */
    mesh(request: SmoothMeshRequest): Promise<SmoothMeshResult>;

    /**
     * Releases any resources the implementation holds.
     */
    dispose(): void;
}
