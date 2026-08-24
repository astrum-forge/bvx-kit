import { Key } from "../math/key.js";

/**
 * HashGrid stores key-value pairs indexed by the encoded numeric value of a Key,
 * such as a MortonKey. It is used to index VoxelChunks by their spatial location.
 *
 * Entries are split across a fixed, power-of-two number of buckets by the low bits of
 * the key, and each bucket holds its own Map. The split is what makes this faster than
 * a single flat Map once the index stops fitting in cache: the low bits of a MortonKey
 * describe a chunk's position inside a small tile, so chunks that are spatially adjacent
 * share a bucket. A mesher sweep or a ray walking through the world touches megabytes of
 * chunk data between lookups, which evicts a large flat hash table but leaves the small
 * bucket for the region being traversed resident.
 *
 * Measured on a 131k-chunk world, this is worth 1.23x on the raycaster against a single
 * Map, and nothing at all on an 8k-chunk world where the whole index stays cached. The
 * bucket count wants to stay modest - the empty bucket array and the per-bucket Map
 * overhead are paid whether or not the world is large, and a VoxelWorld holding only the
 * 27 chunks of a mesh request pays it for no benefit.
 */
export class HashGrid<K extends Key, V> {
    /**
     * Default number of buckets. Chosen as the smallest count that captures the full
     * end-to-end gain while keeping an empty index cheap.
     */
    public static readonly DEFAULT_SIZE: number = 256;

    /**
     * Buckets of stored key-value pairs, indexed by the low bits of the encoded key.
     * Buckets are created on first use, so an empty grid allocates no Maps.
     */
    private readonly _dict: (Map<number, V> | undefined)[];

    /**
     * The number of buckets. Always a power of two.
     */
    private readonly _size: number;

    /**
     * Bit mask used to select a bucket, always _size - 1.
     */
    private readonly _mask: number;

    /**
     * Running count of stored pairs, so length does not have to walk the buckets.
     */
    private _count: number;

    /**
     * Constructs a new HashGrid with the given number of buckets.
     *
     * @param buckets - Number of buckets, rounded up to a power of two. Values of zero
     * or less fall back to DEFAULT_SIZE. More buckets improve lookup locality on a large
     * world and cost memory on a small one.
     */
    constructor(buckets: number = HashGrid.DEFAULT_SIZE) {
        this._size = HashGrid._BucketCount(buckets);
        this._mask = this._size - 1;
        this._dict = new Array<Map<number, V> | undefined>(this._size);
        this._count = 0;
    }

    /**
     * Rounds the requested bucket count up to a power of two, so that a bucket can be
     * selected with a mask rather than a modulo.
     *
     * @param buckets - The requested bucket count.
     * @returns - A power of two greater than or equal to the request.
     */
    private static _BucketCount(buckets: number): number {
        const requested: number = buckets > 0 ? buckets : HashGrid.DEFAULT_SIZE;

        let size = 1;

        while (size < requested) {
            size *= 2;
        }

        return size;
    }

    /**
     * Returns the number of hash buckets in the grid.
     */
    public get size(): number {
        return this._size;
    }

    /**
     * Searches for and returns the value associated with the given key.
     *
     * @param key - The key to search for.
     * @returns - The associated value if found, or null if not found.
     */
    public get(key: K): V | null {
        const encoded: number = key.key;

        // masking rather than a modulo also keeps negative encoded keys in range
        const bucket: Map<number, V> | undefined = this._dict[encoded & this._mask];

        if (bucket === undefined) {
            return null;
        }

        const value: V | undefined = bucket.get(encoded);

        return value !== undefined ? value : null;
    }

    /**
     * Inserts or updates a key-value pair in the hash grid. If the key already exists,
     * the value is updated.
     *
     * @param key - The key to insert or update.
     * @param value - The value to associate with the key.
     */
    public set(key: K, value: V): void {
        const encoded: number = key.key;
        const index: number = encoded & this._mask;

        let bucket: Map<number, V> | undefined = this._dict[index];

        if (bucket === undefined) {
            bucket = new Map<number, V>();
            this._dict[index] = bucket;
        }

        const before: number = bucket.size;

        bucket.set(encoded, value);

        // the bucket only grows when the key was not already present
        if (bucket.size !== before) {
            this._count++;
        }
    }

    /**
     * Returns the total number of key-value pairs stored in the hash grid.
     */
    public get length(): number {
        return this._count;
    }

    /**
     * Iterates over all values stored in the hash grid. Iteration order is
     * undefined and should not be relied upon.
     *
     * @returns - A generator that yields each stored value.
     */
    public *values(): Generator<V> {
        const dict: (Map<number, V> | undefined)[] = this._dict;
        const size: number = this._size;

        for (let i = 0; i < size; i++) {
            const bucket: Map<number, V> | undefined = dict[i];

            if (bucket !== undefined) {
                yield* bucket.values();
            }
        }
    }

    /**
     * Iterates over all encoded keys stored in the hash grid. Iteration order
     * is undefined and should not be relied upon.
     *
     * @returns - A generator that yields each stored key (encoded as a number).
     */
    public *keys(): Generator<number> {
        const dict: (Map<number, V> | undefined)[] = this._dict;
        const size: number = this._size;

        for (let i = 0; i < size; i++) {
            const bucket: Map<number, V> | undefined = dict[i];

            if (bucket !== undefined) {
                yield* bucket.keys();
            }
        }
    }

    /**
     * Removes every key-value pair, keeping the bucket array so a grid that is
     * refilled every frame - the 27-chunk neighbourhood a mesh request binds, for
     * instance - allocates nothing per refill. Buckets that were created stay
     * created and are simply emptied.
     */
    public clear(): void {
        const dict: (Map<number, V> | undefined)[] = this._dict;
        const size: number = this._size;

        for (let i = 0; i < size; i++) {
            const bucket: Map<number, V> | undefined = dict[i];

            if (bucket !== undefined && bucket.size !== 0) {
                bucket.clear();
            }
        }

        this._count = 0;
    }

    /**
     * Removes the key-value pair associated with the given key, if it exists.
     *
     * @param key - The key to remove.
     * @returns - True if the key was found and removed, false otherwise.
     */
    public remove(key: K): boolean {
        const encoded: number = key.key;
        const bucket: Map<number, V> | undefined = this._dict[encoded & this._mask];

        if (bucket !== undefined && bucket.delete(encoded)) {
            this._count--;

            return true;
        }

        return false;
    }
}
