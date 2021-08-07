import { MortonKey } from "../../math/morton-key";
import { VoxelIndex } from "../voxel-index";
import { VoxelChunk } from "./voxel-chunk";

/**
 * Empty Voxel Chunks cannot store any meta-data
 */
export class VoxelChunk0 extends VoxelChunk {

    constructor(key: MortonKey) {
        super(key);
    }

    /**
     * Empty Voxel Chunks cannot store any meta-data. This function
     * will hence do nothing
     */
    public setMetaData(_key: VoxelIndex, _meta: number): void { }

    /**
     * Empty Voxel Chunks cannot store any meta-data. This function
     * will return a default value of 0
     */
    public getMetaData(_key: VoxelIndex): number {
        return 0;
    }
}