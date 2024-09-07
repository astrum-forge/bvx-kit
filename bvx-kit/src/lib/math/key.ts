/**
 * Interface representing a generic Key with 3D coordinates (x, y, z) and 
 * a unique identifier (key). This interface provides methods for comparing, 
 * cloning, and accessing the coordinate values.
 */
export interface Key {
    /**
     * Gets the x-coordinate value.
     */
    get x(): number;

    /**
     * Sets the x-coordinate value.
     * @param value - The new value for the x-coordinate.
     */
    set x(value: number);

    /**
     * Gets the y-coordinate value.
     */
    get y(): number;

    /**
     * Sets the y-coordinate value.
     * @param value - The new value for the y-coordinate.
     */
    set y(value: number);

    /**
     * Gets the z-coordinate value.
     */
    get z(): number;

    /**
     * Sets the z-coordinate value.
     * @param value - The new value for the z-coordinate.
     */
    set z(value: number);

    /**
     * Gets the unique key associated with this object.
     * This key can be used for identification or sorting.
     */
    get key(): number;

    /**
     * Compares the current Key object with another Key instance.
     * @param other - The other Key object to compare against.
     * @returns - Returns true if the two keys are equal, otherwise false.
     */
    cmp(other: Key): boolean;

    /**
     * Creates a deep copy of the current Key object.
     * @returns - A new Key instance that is a clone of the current object.
     */
    clone(): Key;
}
