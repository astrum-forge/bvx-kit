import { HashGrid } from "../containers/hash-grid.js";
import { MortonKey } from "../math/morton-key.js";
import { VoxelRaycaster } from "./raycaster/voxel-raycaster.js";
import { VoxelChunk } from "./chunks/voxel-chunk.js";

/**
 * VoxelWorld manages a single world instance of a collection of Voxels.
 * Storage is managed by MortonKeys that represents the world coordinate
 * for each individual VoxelChunk.
 * 
 * Each MortonKey can contain 0-1023 values on each of the x,y,z axis
 * Each VoxelChunk contains 4 x 4 x 4 Voxels
 * Each Voxel contains 4 x 4 x 4 BitVoxels
 * 
 * If we take the assumption that each Voxel is 1m x 1m x 1m in size, then
 * VoxelWorld can contain a maximum map of 4096m x 4096m x 4096m or 4km^3
 * 
 * For game engines or Renderers that want to have bigger maps, they can always
 * spawn additional independent VoxelWorld instances and manage the coordinates
 * accordingly.
 */
export class VoxelWorld {
    /**
     * Construct a HashGrid storage that can be queried using a provided
     * MortonKey and stores instances of VoxelChunk types
     */
    private readonly _voxelChunks: HashGrid<MortonKey, VoxelChunk>;
    private readonly _voxelRaycaster: VoxelRaycaster;

    constructor() {
        // init with 1024 buckets for now, this can be increased to decrease
        // the O(n) search space for more constant lookups at cost of memory
        this._voxelChunks = new HashGrid<MortonKey, VoxelChunk>(1024);

        // provides a Raycaster instance to query the data contained in this world
        this._voxelRaycaster = new VoxelRaycaster(this);
    }

    /**
     * Returns the Raycaster structure that allows picking Voxels using a VoxelRay
     */
    public get raycaster(): VoxelRaycaster {
        return this._voxelRaycaster;
    }

    /**
     * Returns a VoxelChunk from the provided Morton Key
     * @param key - The key used to store the required VoxelChunk
     * @returns - VoxelChunk instance or null
     */
    public get(key: MortonKey): VoxelChunk | null {
        return this._voxelChunks.get(key);
    }

    /**
     * Returns a VoxelChunk from the provided Morton Key
     * @param key - The key used to store the required VoxelChunk
     * @param optret - (optional) item to return if VoxelChunk is null
     * @returns - VoxelChunk instance or null
     */
    public getOpt(key: MortonKey, optret: VoxelChunk): VoxelChunk {
        const retItem: VoxelChunk | null = this.get(key);

        if (retItem === null) {
            return optret;
        }

        return retItem;
    }

    /**
     * Inserts a new VoxelChunk instance at the provided Morton Key Coordinate
     * @param chunk - The Chunk instance to insert
     */
    public insert(chunk: VoxelChunk): void {
        this._voxelChunks.set(chunk.key, chunk);
    }

    /**
     * Removes a previous instance of VoxelChunk from provided Morton Key Coordinate
     * @param key - The Morton Key Coordinate
     * @returns - Returns true if removed or false otherwise. If returns false then there
     * was nothing to return
     */
    public remove(key: MortonKey): boolean {
        return this._voxelChunks.remove(key);
    }
}