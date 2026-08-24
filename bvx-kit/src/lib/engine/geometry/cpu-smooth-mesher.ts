import { SmoothMesher, SmoothMeshRequest, SmoothMeshResidency, SmoothMeshResult } from "./smooth-mesher.js";
import { VoxelSmoothGeometry } from "./voxel-smooth-geometry.js";

/**
 * The reference SmoothMesher - VoxelSmoothGeometry behind the common interface.
 *
 * It accepts every request, so it is always a valid fallback for an accelerated
 * implementation that does not. The geometry generator is allocated once and
 * reused, so a long-lived instance performs no per-request buffer allocations
 * beyond the result copies.
 */
export class CpuSmoothMesher implements SmoothMesher {
    public readonly id: string = "cpu";
    public readonly residency: SmoothMeshResidency = "cpu";

    /**
     * Reusable smooth surface geometry generator.
     */
    private readonly _geometry: VoxelSmoothGeometry;

    constructor() {
        this._geometry = new VoxelSmoothGeometry();
    }

    /**
     * The CPU path is the reference implementation - there is no request it
     * cannot answer.
     */
    public supports(): boolean {
        return true;
    }

    public async mesh(request: SmoothMeshRequest): Promise<SmoothMeshResult> {
        const geometry: VoxelSmoothGeometry = this._geometry;

        geometry.computeGeometry(
            request.chunk,
            request.world,
            request.smoothing,
            request.flipped,
            request.occluders,
            request.occlusionMode
        );

        // copy the exact-length views out of the reusable internal buffers so the
        // result owns its own data
        const vertices: Float32Array = geometry.vertices.slice();
        const normals: Float32Array = geometry.normals.slice();
        const indices: Uint32Array = geometry.indices.slice();

        return {
            residency: "cpu",
            vertexCount: vertices.length / 3,
            indexCount: indices.length,

            // the CPU resolves a degenerate gradient from the adjacent triangles
            // before returning, so nothing is left unresolved
            degenerateNormals: 0,
            vertices: vertices,
            normals: normals,
            indices: indices,
            handle: null
        };
    }

    public dispose(): void {
        // the geometry generator owns only plain typed arrays
    }
}
