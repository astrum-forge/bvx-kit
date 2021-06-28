import { BitArray } from "../containers/bit-array";
import { BitOps } from "../util/bit-ops";

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

    /**
     * Checks if this Voxel is valid (could be a cleared reference)
     * @returns - true if the internal references are valid, false otherwise
     */
    public isValid(): boolean {
        return this._vxIndex >= 0 && this._bvxReference !== null && this._vxMetaReference !== null;
    }

    /**
     * Sets the 16 bit application-specific meta-data for this Voxel.
     * 16 bits (unsigned) allows storing values between 0 and 65535 inclusive
     */
    public set metaData(meta: number) {
        if (this._vxMetaReference === null) {
            throw new Error("set Voxel.metaData(number) - cannot set as internal reference is not available, try Voxel.set() first");
        }

        this._vxMetaReference[this._vxIndex] = meta & 0xFFFF0000;
    }

    /**
     * Sets the BitVoxel at the provided local coordinates to the 1/ON state
     * @param x - The local x coordinate of the BitVoxel
     * @param y - The local y coordinate of the BitVoxel
     * @param z - The local z coordinate of the BitVoxel
     * @returns - this instance
     */
    public setBitVoxel(x: number, y: number, z: number): Voxel {
        if (this._bvxReference === null) {
            throw new Error("Voxel.setBitVoxel(number, number, number) - cannot set as internal reference is not available, try Voxel.set() first");
        }

        const index: number = BitOps.flattenCoord3(x, y, z, 2);
        const bitIndex: number = (this._vxIndex * 2) + index;
        this._bvxReference.setBitAt(bitIndex);

        return this;
    }

    /**
     * Unset the BitVoxel at the provided local coordinates to the 0/OFF state
     * @param x - The local x coordinate of the BitVoxel
     * @param y - The local y coordinate of the BitVoxel
     * @param z - The local z coordinate of the BitVoxel
     * @returns - this instance
     */
    public unsetBitVoxel(x: number, y: number, z: number): Voxel {
        if (this._bvxReference === null) {
            throw new Error("Voxel.unsetBitVoxel(number, number, number) - cannot set as internal reference is not available, try Voxel.set() first");
        }

        const index: number = BitOps.flattenCoord3(x, y, z, 2);
        const bitIndex: number = (this._vxIndex * 2) + index;
        this._bvxReference.unsetBitAt(bitIndex);

        return this;
    }

    /**
     * Toggles the BitVoxel at the provided local coordinates. state will be 1/ON if
     * previous state was 0/OFF or reversed.
     * @param x - The local x coordinate of the BitVoxel
     * @param y - The local y coordinate of the BitVoxel
     * @param z - The local z coordinate of the BitVoxel
     * @returns - this instance
     */
    public toggleBitVoxel(x: number, y: number, z: number): Voxel {
        if (this._bvxReference === null) {
            throw new Error("Voxel.toggleBitVoxel(number, number, number) - cannot set as internal reference is not available, try Voxel.set() first");
        }

        const index: number = BitOps.flattenCoord3(x, y, z, 2);
        const bitIndex: number = (this._vxIndex * 2) + index;
        this._bvxReference.toggleBitAt(bitIndex);

        return this;
    }

    /**
     * Gets the state of the BitVoxel at provided coordinates.
     * This function will return 0 by default if Voxel.isValid() is false.
     * @param x - The local x coordinate of the BitVoxel
     * @param y - The local y coordinate of the BitVoxel
     * @param z - The local z coordinate of the BitVoxel
     * @returns - 1 or 0 if BitVoxel state is either ON or OFF
     */
    public getBitVoxel(x: number, y: number, z: number): number {
        // default state of BitVoxels is always 0/OFF
        if (this._bvxReference === null) {
            return 0;
        }

        const index: number = BitOps.flattenCoord3(x, y, z, 2);
        const bitIndex: number = (this._vxIndex * 2) + index;
        return this._bvxReference.bitAt(bitIndex);
    }

    /**
     * Returns the 16 bit application-specific meta-data for this Voxel.
     * 16 bits (unsigned) allows storing values between 0 and 65535 inclusive
     */
    public get metaData(): number {
        if (this._vxMetaReference === null) {
            throw new Error("get Voxel.metaData - cannot get as internal reference is not available, try Voxel.set() first");
        }

        return this._vxMetaReference[this._vxIndex];
    }
}