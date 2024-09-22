import { MortonKey } from "../math/morton-key.js";
import { VoxelChunk } from "./chunks/voxel-chunk.js";
import { VoxelIndex } from "./voxel-index.js";

/**
 * WorldIndex class provides a way to compute and access voxel data in a voxel world
 * based on world coordinates. It allows for efficient retrieval of VoxelChunk, Voxel, 
 * and BitVoxel data from the world using the provided 3D coordinates.
 */
export class WorldIndex {
    /**
     * The MortonKey representing the local chunk coordinates within the voxel world.
     * This key allows efficient spatial indexing for chunk access.
     */
    private readonly _chunkIndex: MortonKey;

    /**
     * The VoxelIndex representing the local voxel and bit voxel coordinates within a chunk.
     * This index is used to access specific voxel data within a VoxelChunk.
     */
    private readonly _voxelIndex: VoxelIndex;

    constructor() {
        this._chunkIndex = new MortonKey();
        this._voxelIndex = new VoxelIndex();
    }

    /**
     * Calculates a WorldIndex from the given world coordinates (x, y, z), allowing access 
     * to voxel data. It determines both the chunk index and the voxel index within that chunk.
     * 
     * @param worldX - The x-coordinate in world space.
     * @param worldY - The y-coordinate in world space.
     * @param worldZ - The z-coordinate in world space.
     * @param optres - (Optional) A pre-allocated WorldIndex to store the result, minimizing memory allocations.
     * @returns - A WorldIndex object containing the chunk and voxel indices for the given world coordinates.
     */
    public static from(worldX: number, worldY: number, worldZ: number, optres: WorldIndex | null = null): WorldIndex {
        optres = optres ?? new WorldIndex();

        const chunkSize: number = VoxelChunk.DIMS; // Size of a chunk in one dimension
        const worldSize: number = chunkSize * chunkSize; // Represents chunk volume in world space

        // Calculate the chunk coordinates by dividing the world coordinates by the chunk size
        const chunkX: number = Math.floor(worldX / worldSize);
        const chunkY: number = Math.floor(worldY / worldSize);
        const chunkZ: number = Math.floor(worldZ / worldSize);

        // Calculate the voxel index within the chunk by using modulo to get the local position
        const voxelX: number = Math.floor((worldX % worldSize) / chunkSize);
        const voxelY: number = Math.floor((worldY % worldSize) / chunkSize);
        const voxelZ: number = Math.floor((worldZ % worldSize) / chunkSize);

        // BitVoxel coordinates within the voxel
        const bvX: number = worldX % chunkSize;
        const bvY: number = worldY % chunkSize;
        const bvZ: number = worldZ % chunkSize;

        // Set the chunk and voxel indices using MortonKey and VoxelIndex
        MortonKey.from(chunkX, chunkY, chunkZ, optres._chunkIndex);
        VoxelIndex.from(voxelX, voxelY, voxelZ, bvX, bvY, bvZ, optres._voxelIndex);

        return optres;
    }

    /**
     * Provides access to the chunk index, which can be used to retrieve the VoxelChunk
     * corresponding to the current WorldIndex.
     * 
     * @returns - The MortonKey representing the chunk index.
     */
    public get chunkIndex(): MortonKey {
        return this._chunkIndex;
    }

    /**
     * Provides access to the voxel index within a chunk. This is used to locate the
     * specific Voxel and BitVoxel within the chunk.
     * 
     * @returns - The VoxelIndex representing the voxel and bit voxel within the chunk.
     */
    public get voxelIndex(): VoxelIndex {
        return this._voxelIndex;
    }

    /* istanbul ignore next */
    /**
     * Converts the WorldIndex into a human-readable string representation.
     * Useful for debugging purposes to see the chunk and voxel indices.
     * 
     * @returns - A string representation of the WorldIndex.
     */
    toString(): string {
        return "WorldIndex - chunkIndex:" + this.chunkIndex + " voxelIndex:" + this.voxelIndex;
    }
}
