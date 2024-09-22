import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { VoxelWorld } from "../voxel-world.js";
import { WorldIndex } from "../world-index.js";
import { VoxelRay } from "./voxel-ray.js";

/**
 * VoxelRaycaster allows performing raycasting operations against a VoxelWorld
 * to identify specific voxels. It can be used to select voxels for placement,
 * removal, or modification based on a 3D ray.
 */
export class VoxelRaycaster {
    /**
     * Temporary WorldIndex used internally to avoid unnecessary memory allocations during raycasting.
     */
    private static readonly _TMP_KEY: WorldIndex = new WorldIndex();

    /**
     * Reference to the VoxelWorld that this raycaster operates on.
     */
    private readonly _world: VoxelWorld;

    /**
     * Constructs a VoxelRaycaster for the provided VoxelWorld.
     * 
     * @param world - The VoxelWorld to perform raycasting on.
     */
    constructor(world: VoxelWorld) {
        this._world = world;
    }

    /**
     * Performs a raycast operation in the voxel world using a finite VoxelRay.
     * The ray travels through the voxel grid, checking each voxel to see if it contains a BitVoxel.
     * 
     * @param ray - The VoxelRay that defines the start and end points of the ray.
     * @param optres - (Optional) A pre-allocated WorldIndex object to store the result, reducing allocations.
     * 
     * @returns - Returns the WorldIndex of the first voxel hit by the ray if a voxel is found, otherwise returns null.
     */
    public raycast(ray: VoxelRay, optres: WorldIndex | null = null): WorldIndex | null {
        const cellSize = 1; // Each voxel is treated as a 1x1x1 cell

        // Start and end coordinates of the ray in voxel space
        const x1: number = ray.startX;
        const y1: number = ray.startY;
        const z1: number = ray.startZ;

        const x2: number = ray.endX;
        const y2: number = ray.endY;
        const z2: number = ray.endZ;

        // Current voxel coordinates
        let i: number = Math.floor(x1 / cellSize) | 0;
        let j: number = Math.floor(y1 / cellSize) | 0;
        let k: number = Math.floor(z1 / cellSize) | 0;

        // Target voxel coordinates (end of ray)
        const iend: number = Math.floor(x2 / cellSize) | 0;
        const jend: number = Math.floor(y2 / cellSize) | 0;
        const kend: number = Math.floor(z2 / cellSize) | 0;

        // Step directions for the ray (increment or decrement)
        const di: number = ((x1 < x2) ? 1 : ((x1 > x2) ? -1 : 0));
        const dj: number = ((y1 < y2) ? 1 : ((y1 > y2) ? -1 : 0));
        const dk: number = ((z1 < z2) ? 1 : ((z1 > z2) ? -1 : 0));

        // Delta values represent the step size for the ray traversal
        const deltatx: number = cellSize / Math.abs(x2 - x1);
        const deltaty: number = cellSize / Math.abs(y2 - y1);
        const deltatz: number = cellSize / Math.abs(z2 - z1);

        // Initialize t values for ray traversal
        const minx: number = cellSize * Math.floor(x1 / cellSize);
        const maxx: number = minx + cellSize;
        let tx: number = ((x1 > x2) ? (x1 - minx) : (maxx - x1)) / Math.abs(x2 - x1);

        const miny: number = cellSize * Math.floor(y1 / cellSize);
        const maxy: number = miny + cellSize;
        let ty: number = ((y1 > y2) ? (y1 - miny) : (maxy - y1)) / Math.abs(y2 - y1);

        const minz: number = cellSize * Math.floor(z1 / cellSize);
        const maxz: number = minz + cellSize;
        let tz: number = ((z1 > z2) ? (z1 - minz) : (maxz - z1)) / Math.abs(z2 - z1);

        // Reuse the WorldIndex to avoid allocations
        const worldKey: WorldIndex = VoxelRaycaster._TMP_KEY;
        const world: VoxelWorld = this._world;

        // Ray traversal through the voxel grid
        while (true) {
            // Calculate the current world index from voxel coordinates
            const worldCoord: WorldIndex = WorldIndex.from(i, j, k, worldKey);

            // Get the chunk at the current world coordinate
            const chunk: VoxelChunk | null = world.get(worldCoord.chunkIndex);

            // Check if the current voxel contains a BitVoxel (1 indicates an active voxel)
            if (chunk !== null && chunk.getBitVoxel(worldCoord.voxelIndex) === 1) {
                // Return the world index of the hit voxel
                return WorldIndex.from(i, j, k, optres);
            }

            // Advance the ray to the next voxel
            if (tx <= ty && tx <= tz) {
                if (i === iend) {
                    return null;
                }
                tx += deltatx;
                i += di;
            } else if (ty <= tx && ty <= tz) {
                if (j === jend) {
                    return null;
                }
                ty += deltaty;
                j += dj;
            } else {
                if (k === kend) {
                    return null;
                }
                tz += deltatz;
                k += dk;
            }
        }
    }
}
