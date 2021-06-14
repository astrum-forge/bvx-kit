import BitOps from "./bit-ops";

/**
 * Uint32Array backed Bit Array, allowing reading and writing of individual
 * bits of data
 */
export default class BitArray {
    public static readonly BITS_PER_ELEMENT = 32;

    private readonly _array: Uint32Array;

    /**
     * Initialise a new backed array with provided element count.
     * @param elements - Each element can store 32 bits number of bits = elements * 32
     */
    constructor(elements: number = 0) {
        this._array = new Uint32Array(elements);
    }

    public get elements(): Uint32Array {
        return this._array;
    }

    public bitAt(pos: number): number {
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;
        const value: number = this._array[index];

        return BitOps.bitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public bitInvAt(pos: number): number {
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;
        const value: number = this._array[index];

        return BitOps.bitInvAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public setBitAt(pos: number): void {
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;
        const value: number = this._array[index];

        this._array[index] = BitOps.setBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public setBit(pos: number, bitValue: number): void {
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;
        const value: number = this._array[index];

        this._array[index] = BitOps.setBit(value, pos % BitArray.BITS_PER_ELEMENT, bitValue);
    }

    public unsetBitAt(pos: number): void {
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;
        const value: number = this._array[index];

        this._array[index] = BitOps.unsetBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public toggleBitAt(pos: number): void {
        const index: number = (pos / BitArray.BITS_PER_ELEMENT) | 0;
        const value: number = this._array[index];

        this._array[index] = BitOps.toggleBitAt(value, pos % BitArray.BITS_PER_ELEMENT);
    }

    public popCount(): number {
        let counter: number = 0;
        const length: number = this._array.length;

        for (let i: number = 0; i < length; i++) {
            counter += BitOps.popCount(this._array[i]);
        }

        return counter;
    }
}