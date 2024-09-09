/**
 * Utility class providing static methods for performing bitwise operations
 * and related mathematical manipulations.
 */
export class BitOps {
    private static readonly FLOAT_NORMAL: number = (1 << 23) * Number.EPSILON;

    /**
     * Retrieves the bit value at a specific position within a 32-bit integer.
     * @param data - The integer from which the bit is extracted.
     * @param pos - The bit position to read (between 0 and 31).
     * @returns - The bit value at the specified position (0 or 1).
     */
    public static bitAt(data: number, pos: number): number {
        return ((data >> pos) & 1);
    }

    /**
     * Retrieves the inverted value of the bit at a specific position within a 32-bit integer.
     * @param data - The integer from which the bit is read.
     * @param pos - The bit position to read (between 0 and 31).
     * @returns - The inverted bit value (1 if the bit is 0, 0 if the bit is 1).
     */
    public static bitInvAt(data: number, pos: number): number {
        return 1 - ((data >> pos) & 1);
    }

    /**
     * Sets the bit at a specified position to 1 in a 32-bit integer.
     * @param data - The integer to modify.
     * @param pos - The bit position to set (between 0 and 31).
     * @returns - The modified integer with the bit set to 1.
     */
    public static setBitAt(data: number, pos: number): number {
        return (data | 1 << pos);
    }

    /**
     * Resets (clears) the bit at a specified position to 0 in a 32-bit integer.
     * @param data - The integer to modify.
     * @param pos - The bit position to clear (between 0 and 31).
     * @returns - The modified integer with the bit set to 0.
     */
    public static unsetBitAt(data: number, pos: number): number {
        return (data & ~(1 << pos));
    }

    /**
     * Toggles the bit at a specific position in a 32-bit integer.
     * @param data - The integer to modify.
     * @param pos - The bit position to toggle (between 0 and 31).
     * @returns - The modified integer with the bit toggled.
     */
    public static toggleBitAt(data: number, pos: number): number {
        return (data ^ (1 << pos));
    }

    /**
     * Sets the bit at a specific position to either 0 or 1 in a 32-bit integer.
     * @param data - The integer to modify.
     * @param pos - The bit position to set (between 0 and 31).
     * @param bit - The bit value to set (0 or 1).
     * @returns - The modified integer with the bit set at the specified position.
     */
    public static setBit(data: number, pos: number, bit: number): number {
        const mask: number = 1 << pos;
        return (data & ~mask) | ((bit << pos) & mask);
    }

    /**
     * Determines whether a given integer is a power of 2.
     * @param value - The integer to check.
     * @returns - True if the integer is a power of 2, false otherwise.
     */
    public static isPowerOfTwo(value: number): boolean {
        return value !== 0 && (value & (value - 1)) === 0;
    }

    /**
     * Calculates the maximum value that can be represented with a given number of bits.
     * This is useful for defining bitmasks for bitwise operations.
     * @param bits - The number of bits to use.
     * @returns - The maximum value that can be represented with the specified number of bits.
     */
    public static maskForBits(bits: number): number {
        return ~(0xFFFFFFFF << bits);
    }

    /**
     * Counts the number of bits set to 1 in a 32-bit integer (also known as population count).
     * @param data - The integer to count the bits in.
     * @returns - The number of set bits (0 to 32).
     */
    public static popCount(data: number): number {
        const data0: number = data - ((data >> 1) & 0x55555555);
        const data1: number = (data0 & 0x33333333) + ((data0 >> 2) & 0x33333333);
        return (((data1 + (data1 >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
    }

    /**
     * Converts a 32-bit integer into a binary string representation.
     * Useful for debugging and visualizing bitwise data.
     * @param value - The integer to convert.
     * @returns - A string of 32 characters representing the binary format of the integer.
     */
    public static toBitString(value: number): string {
        let str = "";
        for (let i: number = 31; i >= 0; i--) {
            str += BitOps.bitAt(value, i);
        }
        return str;
    }

    /**
     * Decodes a binary string back into a 32-bit integer.
     * Useful for debugging and converting string-represented bit data.
     * @param data - The string containing the bit sequence.
     * @param readIndex - Optional starting index to begin reading from (defaults to 0).
     * @returns - The decoded 32-bit integer.
     */
    public static fromBitString(data: string, readIndex: number = 0): number {
        let value: number = 0;
        for (let i: number = readIndex, j: number = 31; i < 32; i++, j--) {
            const dval: string = data[i];
            value = dval === "1" ? BitOps.setBitAt(value, j) : BitOps.unsetBitAt(value, j);
        }
        return value;
    }

    /**
     * Flattens 3D coordinates into a 1D index, useful for storing or indexing data in arrays.
     * @param x - The x-coordinate (within the bounds determined by the number of bits).
     * @param y - The y-coordinate (within the bounds determined by the number of bits).
     * @param z - The z-coordinate (within the bounds determined by the number of bits).
     * @param bits - The number of bits used to represent each coordinate (between 1 and 10).
     * @returns - The flattened 1D index.
     */
    public static flattenCoord3(x: number, y: number, z: number, bits: number): number {
        return (((x | 0) << (bits * 2)) | ((y | 0) << bits) | (z | 0)) & ~(0xFFFFFFFF << (bits * 3));
    }

    /**
     * Flattens 2D coordinates into a 1D index, useful for storing or indexing data in arrays.
     * @param x - The x-coordinate (within the bounds determined by the number of bits).
     * @param y - The y-coordinate (within the bounds determined by the number of bits).
     * @param bits - The number of bits used to represent each coordinate (between 1 and 16).
     * @returns - The flattened 1D index.
     */
    public static flattenCoord2(x: number, y: number, bits: number): number {
        return (((x | 0) << bits) | (y | 0)) & ~(0xFFFFFFFF << (bits * 3));
    }

    /**
     * Compares two floating-point numbers for approximate equality, considering
     * floating-point precision limitations.
     * @param a - The first number to compare.
     * @param b - The second number to compare.
     * @returns - True if the numbers are approximately equal, false otherwise.
     */
    public static isEqual(a: number, b: number): boolean {
        // Shortcut for exact equality, including handling of infinities
        if (a === b) {
            return true;
        }

        const diff: number = Math.abs(a - b);
        const normal: number = BitOps.FLOAT_NORMAL;

        // Handle cases where a or b is near zero or very small
        if (a === 0.0 || b === 0.0 || diff < normal) {
            return diff < (normal * 0.00001);
        }

        const absA: number = Math.abs(a);
        const absB: number = Math.abs(b);

        // Use relative error for comparison
        return diff < Math.min((absA + absB), Number.MAX_VALUE) * 0.00001;
    }
}
