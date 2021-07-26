import { MortonKey } from "../math/morton-key";
import { VoxelChunk } from "./voxel-chunk";
import { VoxelIndex } from "./voxel-index";

/**
 * Allows VoxelChunk, Voxel and BitVoxel access from a world coordinate
 */
export class WorldIndex {
    /**
     * Local coordinate to access a particular chunk in a VoxelWorld
     */
    private readonly _chunkIndex: MortonKey;

    /**
     * Local coordinate to access a particular Voxel and BitVoxel in a VoxelChunk
     */
    private readonly _voxelIndex: VoxelIndex;

    constructor() {
        this._chunkIndex = new MortonKey();
        this._voxelIndex = new VoxelIndex();
    }

    /**
     * Calculate a WorldIndex from world coordinates that allows accessing Voxel data
     * @param worldX - the x world coordinate
     * @param worldY - the y world coordinate
     * @param worldZ - the z world coordinate
     * @param optres - (optional) result to store in, use this to avoid memory allocation
     * @returns - returns a computed WorldIndex
     */
    public static from(worldX: number, worldY: number, worldZ: number, optres: WorldIndex | null = null): WorldIndex {
        optres = optres || new WorldIndex();

        const chunkSize: number = VoxelChunk.SIZE;
        const bvxSubdiv: number = VoxelChunk.BVX_SUBDIV;

        const worldSize: number = chunkSize * bvxSubdiv;

        const chunkX: number = (worldX / worldSize);
        const chunkY: number = (worldY / worldSize);
        const chunkZ: number = (worldZ / worldSize);

        const voxelX: number = (worldX % worldSize) / bvxSubdiv;
        const voxelY: number = (worldY % worldSize) / bvxSubdiv;
        const voxelZ: number = (worldZ % worldSize) / bvxSubdiv;

        const bvX: number = (worldX % bvxSubdiv);
        const bvY: number = (worldY % bvxSubdiv);
        const bvZ: number = (worldZ % bvxSubdiv);

        // insert the local coordinates and return
        MortonKey.from(chunkX | 0, chunkY | 0, chunkZ | 0, optres._chunkIndex);
        VoxelIndex.from(voxelX | 0, voxelY | 0, voxelZ | 0, bvX | 0, bvY | 0, bvZ | 0, optres._voxelIndex);

        return optres;
    }

    /**
     * Use against a VoxelWorld to access a particular VoxelChunk
     */
    public get chunkIndex(): MortonKey {
        return this._chunkIndex;
    }

    /**
     * Use against a VoxelChunk to access a particular Voxel and BitVoxel
     */
    public get voxelIndex(): VoxelIndex {
        return this._voxelIndex;
    }

    /* istanbul ignore next */
    toString(): string {
        return "WorldIndex - chunkIndex:" + this.chunkIndex + " voxelIndex:" + this.voxelIndex;
    }
}