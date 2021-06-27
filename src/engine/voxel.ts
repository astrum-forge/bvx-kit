import { BitArray } from "../containers/bit-array";

/**
 * Provides an easy interface access to a single Voxel reference
 * 
 * This Class is not meant for mass storage however it does provide a clean interface
 * to modify Voxels from application logic. Use sparingly and recycle references for optimum
 * performance.
 */
export class Voxel {

    /**
     * Reference to the BitVoxel array
     */
    private _bvxReference: BitArray | null;

    /**
     * Reference to the Voxel Meta-Data array
     */
    private _vxMetaReference: Uint16Array | null;

    /**
     * This is the Voxel Index used to access the references
     */
    private _vxIndex: number = -1;

    constructor(vxIndex: number = -1, vxMetaReference: Uint16Array | null = null, bvxReference: BitArray | null = null) {
        this._bvxReference = bvxReference;
        this._vxMetaReference = vxMetaReference;
        this._vxIndex = vxIndex;
    }

    public set(vxIndex: number, vxMetaReference: Uint16Array, bvxReference: BitArray): Voxel {
        this._bvxReference = bvxReference;
        this._vxMetaReference = vxMetaReference;
        this._vxIndex = vxIndex >= 0 ? vxIndex : 0;

        return this;
    }

    public clear(): Voxel {
        this._bvxReference = null;
        this._vxMetaReference = null;
        this._vxIndex = -1;

        return this;
    }

    public isValid(): boolean {
        return this._vxIndex >= 0 && this._bvxReference !== null && this._vxMetaReference !== null;
    }

    /**
     * Sets the 16 bit application-specific meta-data for this Voxel
     */
    public set metaData(meta: number) {
        if (this._vxMetaReference === null) {
            throw new Error("set Voxel.metaData(number) - cannot set as internal reference is not available, try Voxel.set() first");
        }

        this._vxMetaReference[this._vxIndex] = meta & 0xFFFF0000;
    }

    /**
     * Returns the 16 bit application-specific meta-data for this Voxel
     */
    public get metaData(): number {
        if (this._vxMetaReference === null) {
            throw new Error("get Voxel.metaData - cannot get as internal reference is not available, try Voxel.set() first");
        }

        return this._vxMetaReference[this._vxIndex];
    }
}