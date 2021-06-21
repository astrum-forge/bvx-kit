import { Key } from "../math/key";

/**
 * Internal node for managing the HashGrid structure. contains
 * read-only key-value pairs.
 */
class Node<K extends Key, V> {
    public readonly key: K;
    public value: V;

    constructor(key: K, value: V) {
        // key is cloned so reference is not changed externally
        this.key = <K>key.clone();
        this.value = value;
    }
}

/**
 * HashGrid contains a set of key-value pairs with a constant length of buckets
 * designed to work with the Key structure. Specifically, MortonKey provides an excellent
 * distribution of 3D data for fast access.
 */
export default class HashGrid<K extends Key, V> {
    public static readonly DEFAULT_SIZE: number = 1024;

    private readonly _dict: Array<Array<Node<K, V>>>;
    private readonly _size: number;

    constructor(buckets: number = HashGrid.DEFAULT_SIZE) {
        this._size = buckets > 0 ? buckets : HashGrid.DEFAULT_SIZE;
        this._dict = new Array<Array<Node<K, V>>>(this._size);
    }

    /**
     * Returns the number of Hash Buckets
     */
    public get size(): number {
        return this._size;
    }

    /**
     * Internal function that calculates and return an appropriate bucket for the provided key
     */
    private _GetKeyBucket(key: K): Array<Node<K, V>> | null {
        const value: Array<Node<K, V>> | null | undefined = this._dict[key.key % this._size];

        return value !== null && value !== undefined ? value : null;
    }

    /**
     * Given a key, search and return the Node Reference attached to the key
     * This is meant to be used internally only as Node should not be exposed
     * externally.
     * @param key - Key to use for search
     * @returns - Node Reference if found or null
     */
    private _Get(key: K): Node<K, V> | null {
        const bucket: Array<Node<K, V>> | null = this._GetKeyBucket(key);

        if (bucket !== null) {
            // NOTE - This should be optimised from O(n) to O(log(n))
            // This can be done by ensuring that data is sorted (can do that during insert)
            // see set() method
            const length: number = bucket.length;

            for (let i: number = 0; i < length; i++) {
                const node: Node<K, V> | undefined | null = bucket[i];

                // we found our object, return and terminate
                if (node !== null && node !== undefined && node.key.cmp(key)) {
                    return node;
                }
            }
        }

        // nothing found, return nothing
        return null;
    }

    /**
     * Given a key, search and return the value attached to the key
     * @param key - Key to use for search
     * @returns - Value if found or null
     */
    public get(key: K): V | null {
        const node: Node<K, V> | null = this._Get(key);

        if (node !== null) {
            return node.value;
        }

        return null;
    }

    /**
     * Sets a provided Value for the provided Key. This will replace a previous
     * value if it exists
     * @param key - The key to use
     * @param value - The value to set
     */
    public set(key: K, value: V): void {
        const node: Node<K, V> | null = this._Get(key);

        // first time inserting this object
        if (node === null) {
            const bucketKey: number = key.key % this._size;
            const bucket: Array<Node<K, V>> | undefined | null = this._dict[bucketKey];

            // bucket exists, just append
            if (bucket !== null && bucket !== undefined) {
                bucket.push(new Node<K, V>(key, value));
            }
            else {
                // otherwise, initialise a new bucket with our requested node
                this._dict[bucketKey] = new Array<Node<K, V>>(new Node<K, V>(key, value));
            }
        }
        else {
            node.value = value;
        }
    }

    /**
     * Deletes the entry for the provided key if it exists
     * @param key - The key to use for removal
     * @returns - Returns true if a value was removed, false otherwise
     */
    public remove(key: K): boolean {
        const node: Node<K, V> | null = this._Get(key);

        if (node !== null) {
            // if statements here will never execute, so we never need them
            // @ts-ignore
            const bucket: Array<Node<K, V>> = this._GetKeyBucket(key);
            const index: number = bucket.indexOf(node);

            // remove the item
            bucket.splice(index, 1);

            return true;
        }

        return false;
    }
}