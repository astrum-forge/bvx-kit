import { HashGrid } from "../containers/hash-grid.js";
import { MortonKey } from "../math/morton-key.js";
import { VoxelRaycaster } from "./raycaster/voxel-raycaster.js";
import { VoxelChunk } from "./chunks/voxel-chunk.js";

/**
 * VoxelWorld manages a collection of voxel chunks in a 3D space.
 * Each chunk is indexed and stored using a MortonKey, which encodes the world
 * coordinates for the chunk. The system allows for efficient spatial querying
 * and manipulation of voxel data.
 * 
 * Structure:
 * - Each MortonKey can address up to 1024 values per axis (x, y, z).
 * - Each VoxelChunk contains a 4x4x4 grid of voxels.
 * - Each voxel contains a 4x4x4 grid of BitVoxels.
 * 
 * Assuming each voxel is 1 meter in size, the VoxelWorld can span up to 
 * 4096m x 4096m x 4096m (4km³). For larger maps, multiple VoxelWorld instances
 * can be used, with external systems managing the world coordinates across
 * instances.
 */
export class VoxelWorld {
    /**
     * HashGrid structure that stores and indexes VoxelChunks using MortonKeys.
     * This grid allows fast lookups of voxel chunks based on their spatial location.
     */
    private readonly _voxelChunks: HashGrid<MortonKey, VoxelChunk>;

    /**
     * The VoxelRaycaster provides functionality for raycasting through the voxel world,
     * allowing for efficient querying and voxel picking (e.g., for player interactions).
     */
    private readonly _voxelRaycaster: VoxelRaycaster;

    constructor() {
        // Initialize the HashGrid with 1024 buckets. This can be increased to improve
        // lookup performance at the cost of more memory usage.
        this._voxelChunks = new HashGrid<MortonKey, VoxelChunk>(1024);

        // Initialize the VoxelRaycaster for querying voxel data within this world.
        this._voxelRaycaster = new VoxelRaycaster(this);
    }

    /**
     * Provides access to the VoxelRaycaster, which allows for raycasting operations
     * (e.g., picking voxels based on a ray or line of sight).
     * 
     * @returns - The VoxelRaycaster instance for this VoxelWorld.
     */
    public get raycaster(): VoxelRaycaster {
        return this._voxelRaycaster;
    }

    /**
     * Retrieves a VoxelChunk stored at the provided MortonKey.
     * 
     * @param key - The MortonKey representing the chunk's spatial location.
     * @returns - The VoxelChunk at the specified key, or null if it does not exist.
     */
    public get(key: MortonKey): VoxelChunk | null {
        return this._voxelChunks.get(key);
    }

    /**
     * Retrieves a VoxelChunk from the provided MortonKey, returning a default value if
     * the chunk is not found.
     * 
     * @param key - The MortonKey representing the chunk's spatial location.
     * @param optret - The default VoxelChunk to return if the key is not found.
     * @returns - The VoxelChunk at the specified key or the provided default chunk if not found.
     */
    public getOpt(key: MortonKey, optret: VoxelChunk): VoxelChunk {
        const retItem: VoxelChunk | null = this.get(key);

        if (retItem === null) {
            return optret;
        }

        return retItem;
    }

    /**
     * Inserts a new VoxelChunk into the VoxelWorld at the specified MortonKey.
     * 
     * @param chunk - The VoxelChunk to insert. The chunk's key will be used as the 
     * spatial index for storage.
     */
    public insert(chunk: VoxelChunk): void {
        this._voxelChunks.set(chunk.key, chunk);
    }

    /**
     * Removes a VoxelChunk from the VoxelWorld at the specified MortonKey.
     * 
     * @param key - The MortonKey representing the chunk's spatial location.
     * @returns - True if the chunk was successfully removed, or false if no chunk 
     * was found at the key.
     */
    public remove(key: MortonKey): boolean {
        return this._voxelChunks.remove(key);
    }
}
