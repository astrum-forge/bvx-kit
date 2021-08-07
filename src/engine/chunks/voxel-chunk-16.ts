import { MortonKey } from "../../math/morton-key";
import { VoxelIndex } from "../voxel-index";
import { VoxelChunk } from "./voxel-chunk";

/**
 * VoxelChunk8 can stores 16 bits of meta-data per Voxel
 */
export class VoxelChunk16 extends VoxelChunk {

    private readonly _metaDataBuffer: ArrayBuffer;
    private readonly _metaData: Uint16Array;

    constructor(key: MortonKey) {
        super(key);

        this._metaDataBuffer = new ArrayBuffer((VoxelChunk.SIZE * 16) / 8);
        this._metaData = new Uint16Array(this._metaDataBuffer);
    }

    /**
     * Sets the meta-data for the provided Voxel Index
     * @param key - The Voxel Index to set the meta-data
     * @param meta - The 16 bit meta-data to set
     */
    public setMetaData(key: VoxelIndex, meta: number): void {
        this._metaData[key.vKey] = meta;
    }

    /**
     * Returns the encoded meta-data for the provided Voxel Index
     * @param key - The Voxel Index
     * @returns - The encoded 16 bit meta-data
     */
    public getMetaData(key: VoxelIndex): number {
        return this._metaData[key.vKey];
    }
}