import { BitOps } from "../util/bit-ops";
import { BitArray } from "./bit-array";

/**
 * Allows storing numbers and values in a compact way to save on memory.
 * In Compact Arrays, each array element can have an arbitrary number of bits.
 * 
 * The number of arbitrary bits can be between 1 and 32 (inclusive)
 */
export class CompactArray {
    public static readonly BITS_PER_ELEMENT: number = 32;

    /**
     * The total number of elements
     * NOTE: This is NOT the number of numbers in the array
     */
    private readonly _elements: number;

    /**
     * The number of bits that each element occupies
     */
    private readonly _bitsPerElement: number;

    /**
     * Used to mask the incoming or outgoing value since values are arbitrary
     */
    private readonly _valueMask: number;

    /**
     * Read-Only Fixed Length 32 bit unsigned integer array
     */
    private readonly _array: BitArray;

    /**
     * Construct an array with enough storage for the provided number of elements and
     * required bits per element
     *  
     * @param elements - The number of elements to store, minimum of 1
     * @param bitsPerElement - The number of bits per element
     */
    constructor(elements: number, bitsPerElement: number) {
        const bits: number = CompactArray.BITS_PER_ELEMENT;

        this._elements = elements > 0 ? elements : 1;
        this._bitsPerElement = (bitsPerElement > 0) ? ((bitsPerElement < bits) ? bitsPerElement : (bits - 1)) : 1;
        this._valueMask = BitOps.maskForBits(this._bitsPerElement);

        // the actual compact array storage - we leverage BitArray for this
        this._array = new BitArray(Math.ceil((this._elements * this._bitsPerElement) / bits));
    }

    public get array(): BitArray {
        return this._array;
    }

    public get length(): number {
        return this._elements;
    }

    public get bitsPerElement(): number {
        return this._bitsPerElement;
    }

    /**
     * Read the value set at the provided index
     * @param index - The index to read the value from. This will be masked.
     * @returns - the masked read value
     */
    public get(index: number): number {
        if (index > this.length || index < 0) {
            throw new RangeError("CompactArray.get(index:number) - index out of bounds, must be between 0 and " + this.length + " but was " + index);
        }

        const bits: number = CompactArray.BITS_PER_ELEMENT;
        const elements: Uint32Array = this._array.elements;

        // calculate the bucket index to be used
        const target: number = index * this._bitsPerElement;
        const bucketIndex: number = (target / bits) | 0;
        const nextIndex: number = bucketIndex + 1;
        const readIndex: number = (target % bits) | 0;
        const valueMask: number = this._valueMask;

        // grab the values from first index and next index
        // the read value for arbitrary bits can fall on the border of the bucket so some
        // bits need to be grabbed from the lower bucket and others from the upper connecting bucket
        const lowerValue: number = elements[bucketIndex];

        // this means some values may fall into another bucket that we need to extract
        if (nextIndex < elements.length) {
            const upperValue: number = elements[nextIndex];

            // bits to read from the upper value
            const bitsFromUpper: number = bits - readIndex;

            const lowerMask: number = valueMask << readIndex;
            const upperMask: number = ((valueMask >> bitsFromUpper) ^ lowerMask) & valueMask;

            const shiftBack: number = (bits - bitsFromUpper);

            const finalLowerValue: number = ((lowerValue & lowerMask) >> shiftBack) & upperMask;
            const finalUpperValue: number = ((upperValue & upperMask) << bitsFromUpper) & lowerMask;

            return (finalLowerValue | finalUpperValue) & valueMask;
        }
        else {
            // bits to read from the upper value
            const bitsFromUpper: number = bits - readIndex;
            const lowerMask: number = valueMask << readIndex;
            const shiftBack: number = (bits - bitsFromUpper);

            return ((lowerValue & lowerMask) >> shiftBack) & valueMask;
        }
    }

    /**
     * Sets the provided value at the provided index
     * @param index - The index to place the value into
     * @param value - The value to place. This value will be masked
     */
    public set(index: number, value: number): void {
        if (index > this.length || index < 0) {
            throw new RangeError("CompactArray.set(index:number, value:number) - index out of bounds, must be between 0 and " + this.length + " but was " + index);
        }

        const maskedValue: number = value & this._valueMask;

        const bits: number = CompactArray.BITS_PER_ELEMENT;
        const elements: Uint32Array = this._array.elements;

        // calculate the bucket index to be used
        const target: number = index * this._bitsPerElement;
        const bucketIndex: number = (target / bits) | 0;
        const nextIndex: number = bucketIndex + 1;
        const readIndex: number = (target % bits) | 0;
        const valueMask: number = this._valueMask;

        // grab the values from first index and next index
        // the read value for arbitrary bits can fall on the border of the bucket so some
        // bits need to be grabbed from the lower bucket and others from the upper connecting bucket
        const lowerValue: number = elements[bucketIndex];

        // this means some values may fall into another bucket that we need to extract
        if (nextIndex < elements.length) {
            const upperValue: number = elements[nextIndex];

            // bits to read from the upper value
            const bitsFromUpper: number = bits - readIndex;

            const lowerMask: number = valueMask << readIndex;
            const upperMask: number = ((valueMask >> bitsFromUpper) ^ lowerMask) & valueMask;

            const lowerShiftedValue: number = (maskedValue << readIndex) & lowerMask;
            const upperShiftedValue: number = (maskedValue >> bitsFromUpper) & upperMask;

            // compute the new values to replace into the buckets
            const newLowerValue: number = (lowerValue & ~lowerMask) | lowerShiftedValue;
            const newUpperValue: number = (upperValue & ~upperMask) | upperShiftedValue;

            elements[bucketIndex] = newLowerValue;
            elements[nextIndex] = newUpperValue;
        }
        else {
            // otherwise we just read from a single bucket
            const lowerMask: number = valueMask << readIndex;
            const lowerShiftedValue: number = (maskedValue << readIndex) & lowerMask;

            // compute the new values to replace into the buckets
            const newLowerValue: number = (lowerValue & ~lowerMask) | lowerShiftedValue;

            elements[bucketIndex] = newLowerValue;
        }
    }
}