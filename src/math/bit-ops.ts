/**
 * Provides static utility functions for dealing with BitWise Arithmetics
 */
export default class BitOps {
    public static bitAt(data: number, pos: number): number {
        return ((data >> pos) & 1);
    }

    public static bitInvAt(data: number, pos: number): number {
        return 1 - ((data >> pos) & 1);
    }

    public static setBitAt(data: number, pos: number): number {
        return (data | 1 << pos);
    }

    public static unsetBitAt(data: number, pos: number): number {
        return (data & ~(1 << pos));
    }

    public static toggleBitAt(data: number, pos: number): number {
        return (data ^ (1 << pos));
    }

    public static setBit(data: number, pos: number, bit: number): number {
        const mask: number = 1 << pos;

        return (data & ~mask) | ((bit << pos) & mask);
    }

    public static isPowerOfTwo(value: number): boolean {
        return value != 0 && (value & value - 1) == 0;
    }

    public static popCount(data: number): number {
        const data0: number = data - ((data >> 1) & 0x55555555);
        const data1: number = (data0 & 0x33333333) + ((data0 >> 2) & 0x33333333);

        return (((data1 + (data1 >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
    }

    public static byteAt(data: number, pos: number): number {
        return data >> (24 - (pos * 8));
    }

    public static setByteAt(data: number, newData: number, pos: number): number {
        const shift: number = 24 - (pos * 8);
        const mask: number = 0xFF << shift;

        return (data & ~mask) | ((newData << shift) & mask);
    }

    /**
     * Provided a 32 bit number, encode the bits into a string and return.
     * This is mostly used for debugging purposes.
     * 
     * @param value - The 32 bit number to encode into a string
     * @returns - Returns a 32 character string that represents the bit sequence
     */
    public static toBitString(value: number): string {
        let str = '';

        for (let i: number = 31; i >= 0; i--) {
            str += BitOps.bitAt(value, i);
        }

        return str;
    }

    /**
     * Provided an encoded string with bit data (0 & 1), decode the number and return.
     * This is mostly used for debugging purposes.
     * 
     * @param data - The string that contains the bit data
     * @param readIndex - The index to start reading the string
     * @returns - The decoded number
     */
    public static fromBitString(data: string, readIndex: number = 0): number {
        let value: number = 0;

        for (let i: number = readIndex, j: number = 31; i < 32; i++, j--) {
            value = data[i] === '1' ? BitOps.setBitAt(value, j) : BitOps.unsetBitAt(value, j);
        }

        return value;
    }
}