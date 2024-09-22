/**
 * VoxelRay represents a finite 3D line segment with a defined start and end point, 
 * unlike traditional rays which extend infinitely. It is used to query, place, remove, 
 * or modify voxel states in a 3D voxel world.
 * 
 * VoxelRay operates in voxel coordinate space, meaning that depending on the rendering 
 * system, some transformation or preprocessing may be required before using the ray.
 */
export class VoxelRay {
    /**
     * The starting 3D coordinates of the ray in voxel space.
     */
    private _startX: number;
    private _startY: number;
    private _startZ: number;

    /**
     * The ending 3D coordinates of the ray in voxel space.
     */
    private _endX: number;
    private _endY: number;
    private _endZ: number;

    constructor() {
        // Initializes the ray with default start and end coordinates set to (0, 0, 0).
        this._startX = 0.0;
        this._startY = 0.0;
        this._startZ = 0.0;

        this._endX = 0.0;
        this._endY = 0.0;
        this._endZ = 0.0;
    }

    /**
     * Sets the start and end coordinates of the VoxelRay.
     * 
     * @param sx - The x-coordinate of the start point.
     * @param sy - The y-coordinate of the start point.
     * @param sz - The z-coordinate of the start point.
     * @param ex - The x-coordinate of the end point.
     * @param ey - The y-coordinate of the end point.
     * @param ez - The z-coordinate of the end point.
     * 
     * @returns - The current instance of VoxelRay with the new start and end points set.
     */
    public set(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): this {
        // Sets the starting coordinates of the ray
        this._startX = sx;
        this._startY = sy;
        this._startZ = sz;

        // Sets the ending coordinates of the ray
        this._endX = ex;
        this._endY = ey;
        this._endZ = ez;

        return this;
    }

    /**
     * Gets the x-coordinate of the start point of the ray.
     */
    public get startX(): number {
        return this._startX;
    }

    /**
     * Gets the y-coordinate of the start point of the ray.
     */
    public get startY(): number {
        return this._startY;
    }

    /**
     * Gets the z-coordinate of the start point of the ray.
     */
    public get startZ(): number {
        return this._startZ;
    }

    /**
     * Gets the x-coordinate of the end point of the ray.
     */
    public get endX(): number {
        return this._endX;
    }

    /**
     * Gets the y-coordinate of the end point of the ray.
     */
    public get endY(): number {
        return this._endY;
    }

    /**
     * Gets the z-coordinate of the end point of the ray.
     */
    public get endZ(): number {
        return this._endZ;
    }
}
