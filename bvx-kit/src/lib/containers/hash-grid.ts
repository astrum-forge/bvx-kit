import { Key } from "../math/key.js";

/**
 * Internal class representing a key-value pair stored in the HashGrid.
 * Each Node contains a read-only key and a value. 
 */
class Node<V> {
    // Encoded key stored as a number
    public readonly key: number;
    public value: V;

    /**
     * Constructs a new Node with a key-value pair.
     * 
     * @param key - The key (encoded as a number) to be stored in the Node.
     * @param value - The associated value to be stored.
     */
    constructor(key: number, value: V) {
        // Key is cloned to ensure that external changes don't affect the internal state
        this.key = key;
        this.value = value;
    }
}

/**
 * HashGrid is a hash-based data structure that stores key-value pairs across a fixed 
 * number of buckets. It is optimized for working with 3D data keys, such as MortonKeys, 
 * which are used for fast spatial lookups.
 * 
 * The HashGrid distributes the keys into buckets and allows efficient retrieval, insertion, 
 * and deletion of key-value pairs. MortonKey or any Key implementation can be used as a key.
 */
export class HashGrid<K extends Key, V> {
    /**
     * Default size for the number of buckets in the hash grid.
     */
    public static readonly DEFAULT_SIZE: number = 1024;

    /**
     * The internal dictionary (an array of arrays) storing buckets of Node objects.
     */
    private readonly _dict: Node<V>[][];

    /**
     * The number of hash buckets in the grid.
     */
    private readonly _size: number;

    /**
     * Constructs a new HashGrid with a specified number of buckets.
     * 
     * @param buckets - Number of buckets to allocate for the hash grid. Defaults to DEFAULT_SIZE (1024).
     */
    constructor(buckets: number = HashGrid.DEFAULT_SIZE) {
        // Ensure the size is greater than 0, or use the default size
        this._size = buckets > 0 ? buckets : HashGrid.DEFAULT_SIZE;
        this._dict = new Array<Node<V>[]>(this._size);
    }

    /**
     * Returns the number of hash buckets in the grid.
     */
    public get size(): number {
        return this._size;
    }

    /**
     * Calculates the bucket index for the provided key. The key is treated as
     * an unsigned 32-bit integer to ensure the index is always in-range, even
     * for Key implementations that produce negative encoded keys.
     *
     * @param key - The key used to determine the bucket index.
     * @returns - The bucket index between 0 and size - 1 (inclusive).
     */
    private _GetBucketIndex(key: K): number {
        return (key.key >>> 0) % this._size;
    }

    /**
     * Calculates and returns the appropriate bucket for the provided key.
     *
     * @param key - The key used to determine the bucket.
     * @returns - The array of Node objects in the bucket, or null if the bucket is empty.
     */
    private _GetKeyBucket(key: K): Node<V>[] | null {
        const value: Node<V>[] | null | undefined = this._dict[this._GetBucketIndex(key)];
        return value ? value : null;
    }

    /**
     * Searches for and returns the Node reference associated with the given key.
     * This is an internal method and is not exposed to external classes.
     * 
     * @param key - The key to search for.
     * @returns - The Node reference if found, or null if not found.
     */
    private _Get(key: K): Node<V> | null {
        const bucket: Node<V>[] | null = this._GetKeyBucket(key);

        if (bucket !== null) {
            // NOTE: This is a linear O(n) search. Optimization to O(log(n)) can be done by sorting.
            const length: number = bucket.length;

            for (let i = 0; i < length; i++) {
                const node: Node<V> | undefined | null = bucket[i];

                // Return the node if the keys match
                if (node && node.key === key.key) {
                    return node;
                }
            }
        }

        // Return null if no matching key was found
        return null;
    }

    /**
     * Searches for and returns the value associated with the given key.
     * 
     * @param key - The key to search for.
     * @returns - The associated value if found, or null if not found.
     */
    public get(key: K): V | null {
        const node: Node<V> | null = this._Get(key);

        if (node !== null) {
            return node.value;
        }

        return null;
    }

    /**
     * Inserts or updates a key-value pair in the hash grid. If the key already exists,
     * the value is updated.
     * 
     * @param key - The key to insert or update.
     * @param value - The value to associate with the key.
     */
    public set(key: K, value: V): void {
        const bucketKey: number = this._GetBucketIndex(key);
        const bucket: Node<V>[] | undefined | null = this._dict[bucketKey];

        // Create a new bucket and insert the node if the bucket doesn't exist
        if (!bucket) {
            this._dict[bucketKey] = new Array<Node<V>>(new Node<V>(key.key, value));

            return;
        }

        // Update the value if the key already exists in the bucket
        const length: number = bucket.length;

        for (let i = 0; i < length; i++) {
            const node: Node<V> | undefined | null = bucket[i];

            if (node && node.key === key.key) {
                node.value = value;

                return;
            }
        }

        // Otherwise append a new key-value pair to the existing bucket
        bucket.push(new Node<V>(key.key, value));
    }

    /**
     * Returns the total number of key-value pairs stored in the hash grid.
     * NOTE: This is an O(buckets) operation and should not be used in hot paths.
     */
    public get length(): number {
        const dict: Node<V>[][] = this._dict;
        const size: number = this._size;

        let counter = 0;

        for (let i = 0; i < size; i++) {
            const bucket: Node<V>[] | undefined | null = dict[i];

            if (bucket) {
                counter += bucket.length;
            }
        }

        return counter;
    }

    /**
     * Iterates over all values stored in the hash grid. Iteration order is
     * undefined and should not be relied upon.
     *
     * @returns - A generator that yields each stored value.
     */
    public *values(): Generator<V> {
        const dict: Node<V>[][] = this._dict;
        const size: number = this._size;

        for (let i = 0; i < size; i++) {
            const bucket: Node<V>[] | undefined | null = dict[i];

            if (bucket) {
                const length: number = bucket.length;

                for (let j = 0; j < length; j++) {
                    yield bucket[j].value;
                }
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
        const dict: Node<V>[][] = this._dict;
        const size: number = this._size;

        for (let i = 0; i < size; i++) {
            const bucket: Node<V>[] | undefined | null = dict[i];

            if (bucket) {
                const length: number = bucket.length;

                for (let j = 0; j < length; j++) {
                    yield bucket[j].key;
                }
            }
        }
    }

    /**
     * Removes the key-value pair associated with the given key, if it exists.
     *
     * @param key - The key to remove.
     * @returns - True if the key was found and removed, false otherwise.
     */
    public remove(key: K): boolean {
        const node: Node<V> | null = this._Get(key);

        if (node !== null) {
            const bucket: Node<V>[] = this._GetKeyBucket(key) as Node<V>[];
            const index: number = bucket.indexOf(node);

            // Remove the node from the bucket
            bucket.splice(index, 1);

            return true;
        }

        return false;
    }
}
