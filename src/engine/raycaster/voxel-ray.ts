/**
 * VoxelRay is constructed a little differently from normal Rays, it can be thought
 * of more like a line-segment with a start and an end rather than a Ray with pseudo-infinite
 * length.
 * 
 * VoxelRay allows querying for Voxels in 3D space. This can be useful for placing, removing
 * or modifying Voxel states from a 3D world.
 * 
 * NOTE: The VoxelRay must use the Voxel coordinate space, so some pre-processing might
 * be required depending on how the Voxels are rendered.
 */
export class VoxelRay {
    /**
     * the start 3D coordinates of the ray
     */
    private _startX: number;
    private _startY: number;
    private _startZ: number;

    /**
     * the end 3D coordinates of the ray
     */
    private _endX: number;
    private _endY: number;
    private _endZ: number;

    constructor() {
        this._startX = 0.0;
        this._startY = 0.0;
        this._startZ = 0.0;

        this._endX = 0.0;
        this._endY = 0.0;
        this._endZ = 0.0;
    }

    public set(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): VoxelRay {
        // start of the ray is whatever the user provided
        this._startX = sx;
        this._startY = sy;
        this._startZ = sz;

        // end of the ray is the length the user provided
        this._endX = ex;
        this._endY = ey;
        this._endZ = ez;

        return this;
    }

    public get startX(): number {
        return this._startX;
    }

    public get startY(): number {
        return this._startY;
    }

    public get startZ(): number {
        return this._startZ;
    }

    public get endX(): number {
        return this._endX;
    }

    public get endY(): number {
        return this._endY;
    }

    public get endZ(): number {
        return this._endZ;
    }
}