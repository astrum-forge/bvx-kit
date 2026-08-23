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
     * Uniform state - the array holds a mix of set and unset bits.
     */
    public static readonly MIXED: number = -1;

    /**
     * Uniform state - every bit in the array is 0.
     */
    public static readonly EMPTY: number = 0;

    /**
     * Uniform state - every bit in the array is 1.
     */
    public static readonly FULL: number = 1;

    /**
     * A 32-bit element with every bit set.
     */
    private static readonly _ALL_BITS: number = 0xFFFFFFFF;

    /**
     * The underlying buffer that stores the raw data. Typed as ArrayBufferLike rather
     * than ArrayBuffer so that a SharedArrayBuffer can back the storage.
     */
    private readonly _buffer: ArrayBufferLike;

    /**
     * A typed array view (Uint32Array) of the _buffer, allowing access to 32-bit chunks.
     */
    private readonly _array: Uint32Array;

    /**
     * Initializes a new BitArray with a specified number of 32-bit elements.
     * Each element contains 32 bits, so the total number of bits is `elements * 32`.
     *
     * By default the BitArray allocates and owns its storage. Passing a buffer makes it
     * a view over memory the caller owns instead, which is what allows many chunks to
     * be packed into one allocation - or into a SharedArrayBuffer, so that a worker can
     * read live world state directly rather than through a serialized snapshot.
     *
     * @param elements - The number of 32-bit elements. Defaults to 1.
     * @param buffer - (Optional) Existing storage to view. When null, storage is allocated.
     * @param byteOffset - (Optional) Byte offset into the provided buffer. Must be a
     * multiple of 4. Defaults to 0.
     * @throws - Error if the provided buffer is misaligned or too small.
     */
    constructor(elements = 1, buffer: ArrayBufferLike | null = null, byteOffset = 0) {
        const count: number = elements > 0 ? elements : 1;

        if (buffer === null) {
            // Allocate 4 bytes per element (since each Uint32 element is 4 bytes)
            this._buffer = new ArrayBuffer(count * 4);
            this._array = new Uint32Array(this._buffer);

            return;
        }

        if ((byteOffset % 4) !== 0) {
            throw new Error(`BitArray.constructor(number, ArrayBufferLike, number) - byteOffset must be a multiple of 4, was ${byteOffset}`);
        }

        if (byteOffset < 0 || (byteOffset + (count * 4)) > buffer.byteLength) {
            throw new RangeError(`BitArray.constructor(number, ArrayBufferLike, number) - ${count} elements at byteOffset ${byteOffset} exceeds the buffer length of ${buffer.byteLength}`);
        }

        this._buffer = buffer;
        this._array = new Uint32Array(buffer, byteOffset, count);
    }

    /**
     * Returns the underlying buffer that stores the raw data. When the BitArray is a
     * view into caller-provided storage this is the whole of that storage - use
     * byteOffset and byteLength to locate this BitArray's slice within it.
     */
    public get buffer(): ArrayBufferLike {
        return this._buffer;
    }

    /**
     * Returns the byte offset of this BitArray's data within its buffer.
     */
    public get byteOffset(): number {
        return this._array.byteOffset;
    }

    /**
     * Returns the number of bytes this BitArray occupies within its buffer.
     */
    public get byteLength(): number {
        return this._array.byteLength;
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
     * Reports whether the provided elements are entirely unset, entirely set, or a
     * mix of the two.
     *
     * The scan exits at the first element that breaks uniformity, so a mixed array -
     * which is what any chunk holding a surface looks like - normally costs one or two
     * comparisons. Only a genuinely uniform array pays the full walk, and that is the
     * case the result lets a caller skip entirely.
     *
     * This is deliberately computed on demand rather than cached against writes. The
     * element storage is exposed directly and is written in place by the serializer,
     * the physics solver and the geometry merge paths, so a cached flag would need an
     * invalidation contract that every one of those has to honour. At roughly a
     * hundred comparisons worst case, the scan is far cheaper than that risk.
     *
     * @param elements - The Uint32Array to inspect.
     * @returns - BitArray.EMPTY, BitArray.FULL or BitArray.MIXED.
     */
    public static uniformState(elements: Uint32Array): number {
        const length: number = elements.length;
        const first: number = elements[0];

        if (first !== 0 && first !== BitArray._ALL_BITS) {
            return BitArray.MIXED;
        }

        for (let i = 1; i < length; i++) {
            if (elements[i] !== first) {
                return BitArray.MIXED;
            }
        }

        return first === 0 ? BitArray.EMPTY : BitArray.FULL;
    }

    /**
     * Reports whether this BitArray is entirely unset, entirely set, or a mix of the
     * two (see BitArray.uniformState).
     *
     * @returns - BitArray.EMPTY, BitArray.FULL or BitArray.MIXED.
     */
    public get uniformState(): number {
        return BitArray.uniformState(this._array);
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
