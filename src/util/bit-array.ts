import BitOps from "./bit-ops";

/**
 * Uint32Array backed Bit Array, allowing reading and writing of individual
 * bits of data
 */
export default class BitArray {
    public static readonly BITS_PER_ELEMENT = 32;

    /**
     * Read-Only Fixed Length 32 bit unsigned integer array
     */
    private readonly _array: Uint32Array;

    /**
     * Initialise a new backed array with provided element count.
     * @param elements - Each element can store 32 bits number of bits = elements * 32
     */
    constructor(elements: number = 1) {
        this._array = new Uint32Array(elements > 0 ? elements : 1);
    }

    public get elements(): Uint32Array {
        return this._array;
    }

    public bitAt(pos: number): number {
        const arr: Uint32Array = this._array;
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index > arr.length) {
            throw new Error("BitArray.bitAt(number) - computed index " + index + " cannot be greater than length " + arr.length);
        }

        const value: number = arr[index];

        return BitOps.bitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public bitInvAt(pos: number): number {
        const arr: Uint32Array = this._array;
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index > arr.length) {
            throw new Error("BitArray.bitInvAt(number) - computed index " + index + " cannot be greater than length " + arr.length);
        }

        const value: number = arr[index];

        return BitOps.bitInvAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public setBitAt(pos: number): void {
        const arr: Uint32Array = this._array;
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index > arr.length) {
            throw new Error("BitArray.setBitAt(number) - computed index " + index + " cannot be greater than length " + arr.length);
        }

        const value: number = arr[index];

        arr[index] = BitOps.setBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public setBit(pos: number, bitValue: number): void {
        const arr: Uint32Array = this._array;
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index > arr.length) {
            throw new Error("BitArray.setBit(number) - computed index " + index + " cannot be greater than length " + arr.length);
        }

        const value: number = arr[index];

        arr[index] = BitOps.setBit(value, pos % BitArray.BITS_PER_ELEMENT, bitValue);
    }

    public unsetBitAt(pos: number): void {
        const arr: Uint32Array = this._array;
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index > arr.length) {
            throw new Error("BitArray.unsetBitAt(number) - computed index " + index + " cannot be greater than length " + arr.length);
        }

        const value: number = arr[index];

        arr[index] = BitOps.unsetBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public toggleBitAt(pos: number): void {
        const arr: Uint32Array = this._array;
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;

        if (index > arr.length) {
            throw new Error("BitArray.toggleBitAt(number) - computed index " + index + " cannot be greater than length " + arr.length);
        }

        const value: number = arr[index];

        arr[index] = BitOps.toggleBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public popCount(): number {
        let counter: number = 0;

        const arr: Uint32Array = this._array;
        const length: number = arr.length;

        for (let i: number = 0; i < length; i++) {
            counter += BitOps.popCount(arr[i]);
        }

        return counter;
    }
}