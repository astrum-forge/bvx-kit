import { BitOps } from "../util/bit-ops.js";

/**
 * BitArray provides a Uint32Array-backed array for efficient bit-level manipulation.
 * Each element in the Uint32Array stores 32 bits, and this class allows 
 * reading, writing, and toggling individual bits within that structure.
 */
export class BitArray {
    /**
     * The number of bits per element in the underlying Uint32Array (32 bits per element).
     */
    public static readonly BITS_PER_ELEMENT: number = 32;

    /**
     * The underlying ArrayBuffer that stores the raw data.
     */
    private readonly _buffer: ArrayBuffer;

    /**
     * A typed array view (Uint32Array) of the _buffer, allowing access to 32-bit chunks.
     */
    private readonly _array: Uint32Array;

    /**
     * Initializes a new BitArray with a specified number of 32-bit elements.
     * Each element contains 32 bits, so the total number of bits is `elements * 32`.
     * 
     * @param elements - The number of 32-bit elements to allocate. Defaults to 1.
     */
    constructor(elements: number = 1) {
        // Allocate 4 bytes per element (since each Uint32 element is 4 bytes)
        this._buffer = new ArrayBuffer(elements > 0 ? elements * 4 : 4);
        this._array = new Uint32Array(this._buffer);
    }

    /**
     * Returns the underlying ArrayBuffer that stores the raw data.
     */
    public get buffer(): ArrayBuffer {
        return this._buffer;
    }

    /**
     * Returns the Uint32Array view of the underlying buffer.
     */
    public get elements(): Uint32Array {
        return this._array;
    }

    /**
     * Returns the number of 32-bit elements in the array.
     */
    public get length(): number {
        return this._array.length;
    }

    /**
     * Returns the value of the bit at the specified position (0 or 1).
     * 
     * @param pos - The bit position to read from.
     * @returns - The value of the bit at the specified position (0 or 1).
     * @throws - Error if the bit position is out of bounds.
     */
    public bitAt(pos: number): number {
        if (pos < 0) {
            throw new Error(`BitArray.bitAt(number) - bit position cannot be negative: ${pos}`);
        }

        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index >= this._array.length) {
            throw new Error(`BitArray.bitAt(number) - computed index ${index} exceeds array length ${this._array.length}`);
        }

        const value: number = this._array[index];
        return BitOps.bitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    /**
     * Returns the inverted value of the bit at the specified position (0 becomes 1, 1 becomes 0).
     * 
     * @param pos - The bit position to invert.
     * @returns - The inverted value of the bit at the specified position (0 or 1).
     * @throws - Error if the bit position is out of bounds.
     */
    public bitInvAt(pos: number): number {
        if (pos < 0) {
            throw new Error(`BitArray.bitInvAt(number) - bit position cannot be negative: ${pos}`);
        }

        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index >= this._array.length) {
            throw new Error(`BitArray.bitInvAt(number) - computed index ${index} exceeds array length ${this._array.length}`);
        }

        const value: number = this._array[index];
        return BitOps.bitInvAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    /**
     * Sets the bit at the specified position to 1.
     * 
     * @param pos - The bit position to set.
     * @throws - Error if the bit position is out of bounds.
     */
    public setBitAt(pos: number): void {
        if (pos < 0) {
            throw new Error(`BitArray.setBitAt(number) - bit position cannot be negative: ${pos}`);
        }

        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index >= this._array.length) {
            throw new Error(`BitArray.setBitAt(number) - computed index ${index} exceeds array length ${this._array.length}`);
        }

        const value: number = this._array[index];
        this._array[index] = BitOps.setBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    /**
     * Sets the bit at the specified position to the provided bit value (0 or 1).
     * 
     * @param pos - The bit position to set.
     * @param bitValue - The bit value (0 or 1) to set at the specified position.
     * @throws - Error if the bit position is out of bounds.
     */
    public setBit(pos: number, bitValue: number): void {
        if (pos < 0) {
            throw new Error(`BitArray.setBit(number, number) - bit position cannot be negative: ${pos}`);
        }

        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index >= this._array.length) {
            throw new Error(`BitArray.setBit(number, number) - computed index ${index} exceeds array length ${this._array.length}`);
        }

        const value: number = this._array[index];
        this._array[index] = BitOps.setBit(value, pos % BitArray.BITS_PER_ELEMENT, bitValue);
    }

    /**
     * Unsets the bit at the specified position (sets it to 0).
     * 
     * @param pos - The bit position to unset.
     * @throws - Error if the bit position is out of bounds.
     */
    public unsetBitAt(pos: number): void {
        if (pos < 0) {
            throw new Error(`BitArray.unsetBitAt(number) - bit position cannot be negative: ${pos}`);
        }

        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index >= this._array.length) {
            throw new Error(`BitArray.unsetBitAt(number) - computed index ${index} exceeds array length ${this._array.length}`);
        }

        const value: number = this._array[index];
        this._array[index] = BitOps.unsetBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    /**
     * Toggles the bit at the specified position (0 becomes 1, 1 becomes 0).
     * 
     * @param pos - The bit position to toggle.
     * @throws - Error if the bit position is out of bounds.
     */
    public toggleBitAt(pos: number): void {
        if (pos < 0) {
            throw new Error(`BitArray.toggleBitAt(number) - bit position cannot be negative: ${pos}`);
        }

        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index >= this._array.length) {
            throw new Error(`BitArray.toggleBitAt(number) - computed index ${index} exceeds array length ${this._array.length}`);
        }

        const value: number = this._array[index];
        this._array[index] = BitOps.toggleBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    /**
     * Counts the number of bits that are set to 1 in the entire BitArray.
     * This uses BitOps.popCount() to efficiently count the set bits.
     * 
     * @returns - The total number of bits set to 1 in the BitArray.
     */
    public popCount(): number {
        let counter = 0;
        const arr: Uint32Array = this._array;
        const length: number = arr.length;

        for (let i = 0; i < length; i++) {
            counter += BitOps.popCount(arr[i]);
        }

        return counter;
    }
}
