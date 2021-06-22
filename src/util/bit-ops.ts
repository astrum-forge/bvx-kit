/**
 * Provides static utility functions for dealing with useful BitWise Arithmetics
 */
export class BitOps {
    private static readonly FLOAT_NORMAL: number = (1 << 23) * Number.EPSILON;

    /**
     * Reads and returns the bit at provided position.
     * @param data - The data to read for bit from
     * @param pos - The bit position between 0 and 31
     * @returns - The state of the bit as 0 or 1
     */
    public static bitAt(data: number, pos: number): number {
        return ((data >> pos) & 1);
    }

    /**
     * Reads and returns the bit at provided position in an inverted state.
     * This will return 0 if bit is 1 and returns 1 if bit is 0
     * @param data - The data to read for bit from
     * @param pos - The bit position between 0 and 31
     * @returns - The inverted bit, 0 if was set and 1 if not set
     */
    public static bitInvAt(data: number, pos: number): number {
        return 1 - ((data >> pos) & 1);
    }

    /**
     * Sets the bit at provided position to 1
     * @param data - The data to set the bit for
     * @param pos - The bit position between 0 and 31
     * @returns - The modified data where the bit was reset to 1
     */
    public static setBitAt(data: number, pos: number): number {
        return (data | 1 << pos);
    }

    /**
     * Unsets/Resets the bit at provided position to 0
     * @param data - The data to unset the bit for
     * @param pos - The bit position between 0 and 31
     * @returns - The modified data where the bit was reset to 0
     */
    public static unsetBitAt(data: number, pos: number): number {
        return (data & ~(1 << pos));
    }

    /**
     * Toggles the bit at the provided position. If the bit was 1, its set to
     * 0 and vice versa.
     * @param data - The data to toggle the bit for
     * @param pos - The bit position between 0 and 31
     * @returns - The modified data where the bit was toggled
     */
    public static toggleBitAt(data: number, pos: number): number {
        return (data ^ (1 << pos));
    }

    /**
     * Sets the bit (0 or 1) at the provided bit position for the data
     * @param data - The data to set the bit for
     * @param pos - The bit position between 0 and 31
     * @param bit - The bit to set, can be either 0 or 1
     * @returns - The modified number with the bit set at position
     */
    public static setBit(data: number, pos: number, bit: number): number {
        const mask: number = 1 << pos;

        return (data & ~mask) | ((bit << pos) & mask);
    }

    /**
     * Checks if the provided number is a power of 2
     * @param value - the number to check
     * @returns - Returns true/false if the number is power of 2
     */
    public static isPowerOfTwo(value: number): boolean {
        return value !== 0 && (value & value - 1) === 0;
    }

    /**
     * Standard PopCount that counts the number of set bits for the provided
     * 32 bit number
     * @param data - The data to cound the bits
     * @returns - The number of set bits
     */
    public static popCount(data: number): number {
        const data0: number = data - ((data >> 1) & 0x55555555);
        const data1: number = (data0 & 0x33333333) + ((data0 >> 2) & 0x33333333);

        return (((data1 + (data1 >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
    }

    /**
     * Provided a 32 bit number, encode the bits into a string and return.
     * This is mostly used for debugging purposes.
     * @param value - The 32 bit number to encode into a string
     * @returns - Returns a 32 character string that represents the bit sequence
     */
    public static toBitString(value: number): string {
        let str = "";

        for (let i: number = 31; i >= 0; i--) {
            str += BitOps.bitAt(value, i);
        }

        return str;
    }

    /**
     * Provided an encoded string with bit data (0 & 1), decode the number and return.
     * This is mostly used for debugging purposes.
     * @param data - The string that contains the bit data
     * @param readIndex - The index to start reading the string
     * @returns - The decoded number
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
     * Perform a robust approximate equality test between two 32 bit
     * floating point numbers. This is useful since floating point numbers
     * cannot be directly compared due to precision loss.
     * @param a - The first number to perform comparison against
     * @param b - The second number to perform comparison against
     * @returns - True/False if numbers are approximetly equal
     */
    public static isEqual(a: number, b: number): boolean {
        // Shortcut, handles infinities
        if (a === b) {
            return true;
        }

        const diff: number = Math.abs(a - b);
        const normal: number = BitOps.FLOAT_NORMAL;

        // a or b is zero, or both are extremely close to it.
        // relative error is less meaningful here
        if (a === 0.0 || b === 0.0 || diff < normal) {
            return diff < (normal * 0.00001);
        }

        const absA: number = Math.abs(a);
        const absB: number = Math.abs(b);

        // use relative error
        return diff < Math.min((absA + absB), Number.MAX_VALUE) * 0.00001;
    }
}