/**
 * Candidate chunk-index implementations for the HashGrid experiment.
 *
 * Every candidate exposes the same surface as the shipped HashGrid so the same
 * driver can exercise all of them:
 *
 *   new Impl(sizeHint)      sizeHint is the expected entry count, candidates
 *                           are free to ignore it
 *   .set(key, value)        key is a Key (MortonKey) unless noted
 *   .get(key)               returns the value or null
 *   .remove(key)            returns true when something was removed
 *   .length                 entry count
 *   .values()               generator over values
 *   .stats()                optional, structure specific diagnostics
 *
 * The one deliberate exception is `map-raw`, which takes raw numeric keys. It
 * exists to isolate the cost of the Key object indirection that every other
 * candidate pays.
 */

import { HashGrid } from "../../out/index.js";

/**
 * Rounds up to the next power of two, minimum 16.
 */
const nextPow2 = (n) => {
    let v = 16;

    while (v < n) {
        v *= 2;
    }

    return v;
};

// ---------------------------------------------------------------------------
// A. shipped - the HashGrid exactly as it ships, 1024 fixed buckets
// ---------------------------------------------------------------------------

class Shipped {
    constructor() {
        this._grid = new HashGrid(1024);
    }

    set(key, value) { this._grid.set(key, value); }
    get(key) { return this._grid.get(key); }
    remove(key) { return this._grid.remove(key); }
    get length() { return this._grid.length; }
    *values() { yield* this._grid.values(); }
}

// ---------------------------------------------------------------------------
// A2. old-chained - a faithful replica of HashGrid BEFORE the Map change:
//     1024 fixed buckets, Node objects, modulo, linear scan. Kept so the change
//     can be measured before/after through an identical wrapper depth.
// ---------------------------------------------------------------------------

class OldNode {
    constructor(key, value) {
        this.key = key;
        this.value = value;
    }
}

class OldChained {
    constructor() {
        this._size = 1024;
        this._dict = new Array(this._size);
    }

    _GetBucketIndex(key) {
        return (key.key >>> 0) % this._size;
    }

    _GetKeyBucket(key) {
        const value = this._dict[this._GetBucketIndex(key)];

        return value ? value : null;
    }

    _Get(key) {
        const bucket = this._GetKeyBucket(key);

        if (bucket !== null) {
            const length = bucket.length;

            for (let i = 0; i < length; i++) {
                const node = bucket[i];

                if (node && node.key === key.key) {
                    return node;
                }
            }
        }

        return null;
    }

    get(key) {
        const node = this._Get(key);

        if (node !== null) {
            return node.value;
        }

        return null;
    }

    set(key, value) {
        const bucketKey = this._GetBucketIndex(key);
        const bucket = this._dict[bucketKey];

        if (!bucket) {
            this._dict[bucketKey] = new Array(new OldNode(key.key, value));

            return;
        }

        const length = bucket.length;

        for (let i = 0; i < length; i++) {
            const node = bucket[i];

            if (node && node.key === key.key) {
                node.value = value;

                return;
            }
        }

        bucket.push(new OldNode(key.key, value));
    }

    get length() {
        let counter = 0;

        for (let i = 0; i < this._size; i++) {
            const bucket = this._dict[i];

            if (bucket) {
                counter += bucket.length;
            }
        }

        return counter;
    }

    *values() {
        for (let i = 0; i < this._size; i++) {
            const bucket = this._dict[i];

            if (bucket) {
                for (let j = 0; j < bucket.length; j++) {
                    yield bucket[j].value;
                }
            }
        }
    }

    remove(key) {
        const node = this._Get(key);

        if (node !== null) {
            const bucket = this._GetKeyBucket(key);

            bucket.splice(bucket.indexOf(node), 1);

            return true;
        }

        return false;
    }
}

// ---------------------------------------------------------------------------
// Shared chained-bucket core. Parallel key/value arrays per bucket rather than
// Node objects - this removes one allocation and one pointer chase per entry
// against the shipped version, so the growth candidates are measured against
// the best chained implementation rather than a straw man.
// ---------------------------------------------------------------------------

class ChainedBase {
    // mix: 0 identity (Morton low bits), 1 multiply-shift, 2 xor-fold.
    // The xor-fold shifts are deliberately not multiples of three - a Morton
    // key interleaves one axis every three bits, so a shift of 3n folds an axis
    // onto itself and cannot rescue an axis whose bits are constant.
    constructor(buckets, growLoadFactor, mix = 0) {
        this._mask = buckets - 1;
        this._shift = 32 - Math.log2(buckets);
        this._mix = mix;
        this._buckets = buckets;
        this._grow = growLoadFactor;
        this._keys = new Array(buckets);
        this._vals = new Array(buckets);
        this._count = 0;
    }

    get length() { return this._count; }

    /**
     * Bucket index. Only one subclass is ever instantiated per process, so this
     * call site stays monomorphic and V8 inlines it.
     */
    _slot(k) {
        if (this._mix === 1) {
            return Math.imul(k, 0x9e3779b1) >>> this._shift;
        }

        if (this._mix === 2) {
            return (k ^ (k >>> 7) ^ (k >>> 11)) & this._mask;
        }

        return k & this._mask;
    }

    get(key) {
        const k = key.key;
        const b = this._slot(k);
        const bk = this._keys[b];

        if (bk !== undefined) {
            for (let i = 0, l = bk.length; i < l; i++) {
                if (bk[i] === k) {
                    return this._vals[b][i];
                }
            }
        }

        return null;
    }

    set(key, value) {
        const k = key.key;
        const b = this._slot(k);
        const bk = this._keys[b];

        if (bk === undefined) {
            this._keys[b] = [k];
            this._vals[b] = [value];
            this._count++;
            this._maybeGrow();

            return;
        }

        for (let i = 0, l = bk.length; i < l; i++) {
            if (bk[i] === k) {
                this._vals[b][i] = value;

                return;
            }
        }

        bk.push(k);
        this._vals[b].push(value);
        this._count++;
        this._maybeGrow();
    }

    remove(key) {
        const k = key.key;
        const b = this._slot(k);
        const bk = this._keys[b];

        if (bk === undefined) {
            return false;
        }

        for (let i = 0, l = bk.length; i < l; i++) {
            if (bk[i] === k) {
                // swap-remove - bucket order is already undefined
                const last = bk.length - 1;
                const bv = this._vals[b];

                bk[i] = bk[last];
                bv[i] = bv[last];
                bk.pop();
                bv.pop();
                this._count--;

                return true;
            }
        }

        return false;
    }

    *values() {
        const vals = this._vals;

        for (let i = 0, l = vals.length; i < l; i++) {
            const bv = vals[i];

            if (bv !== undefined) {
                for (let j = 0, m = bv.length; j < m; j++) {
                    yield bv[j];
                }
            }
        }
    }

    _maybeGrow() {
        if (this._grow <= 0 || this._count <= this._buckets * this._grow) {
            return;
        }

        const oldKeys = this._keys;
        const oldVals = this._vals;
        const buckets = this._buckets * 2;

        this._buckets = buckets;
        this._mask = buckets - 1;
        this._shift = 32 - Math.log2(buckets);
        this._keys = new Array(buckets);
        this._vals = new Array(buckets);

        for (let i = 0, l = oldKeys.length; i < l; i++) {
            const bk = oldKeys[i];

            if (bk === undefined) {
                continue;
            }

            const bv = oldVals[i];

            for (let j = 0, m = bk.length; j < m; j++) {
                const k = bk[j];
                const b = this._slot(k);

                if (this._keys[b] === undefined) {
                    this._keys[b] = [k];
                    this._vals[b] = [bv[j]];
                }
                else {
                    this._keys[b].push(k);
                    this._vals[b].push(bv[j]);
                }
            }
        }
    }

    stats() {
        let used = 0;
        let max = 0;

        for (let i = 0; i < this._buckets; i++) {
            const bk = this._keys[i];

            if (bk !== undefined && bk.length > 0) {
                used++;

                if (bk.length > max) {
                    max = bk.length;
                }
            }
        }

        return { buckets: this._buckets, used, maxDepth: max, meanDepth: this._count / this._buckets };
    }
}

// B. chained, 1024 fixed buckets, bitmask instead of modulo
class ChainMask1024 extends ChainedBase {
    constructor() { super(1024, 0); }
}

// C. chained, starts at 1024, doubles when the mean bucket depth passes 1
class ChainGrow extends ChainedBase {
    constructor() { super(1024, 1.0); }
}

// C2. same, but the bucket index is a multiply-shift over the key rather than
//     its low bits - tests whether Morton self-distribution is enough
class ChainGrowMix extends ChainedBase {
    constructor() { super(1024, 1.0, 1); }
}

// C3. same, but an xor-fold that keeps the low key bits dominant, so spatially
//     adjacent chunks still land in nearby buckets
class ChainGrowFold extends ChainedBase {
    constructor() { super(1024, 1.0, 2); }
}

// D. chained, pre-sized to the final entry count, never grows
class ChainPresized extends ChainedBase {
    constructor(hint) { super(nextPow2(hint), 0); }
}

// ---------------------------------------------------------------------------
// E. sorted buckets - 1024 fixed buckets, each bucket sorted by key with a
//    binary search on lookup. This is the "make the bucket scan logarithmic"
//    option, kept honest with parallel arrays.
// ---------------------------------------------------------------------------

class SortedBuckets1024 {
    constructor() {
        this._mask = 1023;
        this._keys = new Array(1024);
        this._vals = new Array(1024);
        this._count = 0;
    }

    get length() { return this._count; }

    get(key) {
        const k = key.key;
        const b = k & this._mask;
        const bk = this._keys[b];

        if (bk === undefined) {
            return null;
        }

        let lo = 0;
        let hi = bk.length - 1;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const mk = bk[mid];

            if (mk === k) {
                return this._vals[b][mid];
            }

            if (mk < k) {
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }

        return null;
    }

    set(key, value) {
        const k = key.key;
        const b = k & this._mask;
        let bk = this._keys[b];

        if (bk === undefined) {
            this._keys[b] = [k];
            this._vals[b] = [value];
            this._count++;

            return;
        }

        let lo = 0;
        let hi = bk.length - 1;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const mk = bk[mid];

            if (mk === k) {
                this._vals[b][mid] = value;

                return;
            }

            if (mk < k) {
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }

        bk.splice(lo, 0, k);
        this._vals[b].splice(lo, 0, value);
        this._count++;
    }

    remove(key) {
        const k = key.key;
        const b = k & this._mask;
        const bk = this._keys[b];

        if (bk === undefined) {
            return false;
        }

        let lo = 0;
        let hi = bk.length - 1;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const mk = bk[mid];

            if (mk === k) {
                bk.splice(mid, 1);
                this._vals[b].splice(mid, 1);
                this._count--;

                return true;
            }

            if (mk < k) {
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }

        return false;
    }

    *values() {
        for (let i = 0; i < 1024; i++) {
            const bv = this._vals[i];

            if (bv !== undefined) {
                for (let j = 0, m = bv.length; j < m; j++) {
                    yield bv[j];
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// F. sorted flat - no buckets at all, one globally sorted key array with a
//    binary search. The literal reading of "sort the inserted objects and
//    search logarithmically".
// ---------------------------------------------------------------------------

class SortedFlat {
    constructor() {
        this._keys = [];
        this._vals = [];
    }

    get length() { return this._keys.length; }

    _find(k) {
        const keys = this._keys;

        let lo = 0;
        let hi = keys.length - 1;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const mk = keys[mid];

            if (mk === k) {
                return mid;
            }

            if (mk < k) {
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }

        return ~lo;
    }

    get(key) {
        const i = this._find(key.key);

        return i >= 0 ? this._vals[i] : null;
    }

    set(key, value) {
        const k = key.key;
        const i = this._find(k);

        if (i >= 0) {
            this._vals[i] = value;

            return;
        }

        const at = ~i;

        this._keys.splice(at, 0, k);
        this._vals.splice(at, 0, value);
    }

    remove(key) {
        const i = this._find(key.key);

        if (i < 0) {
            return false;
        }

        this._keys.splice(i, 1);
        this._vals.splice(i, 1);

        return true;
    }

    *values() {
        const vals = this._vals;

        for (let i = 0, l = vals.length; i < l; i++) {
            yield vals[i];
        }
    }
}

// ---------------------------------------------------------------------------
// K. bucketed Map - keep the original bucket split, but make each bucket a Map
//    instead of an array with a linear scan.
//
//    The appeal: the bucket index is still the low bits of the Morton key, so
//    spatially adjacent chunks stay in the same small Map and the cache locality
//    that the plain Map gives up is preserved - while the within-bucket search
//    stops being O(depth). At 1024 buckets the Morton distribution is also at its
//    best; the aspect-ratio problem in section 2 of the report only appears once
//    the bucket count grows past the world's thinnest axis.
//
//    Buckets are created lazily. Pre-allocating all of them removes an undefined
//    check from the hot path but costs ~1024 Map objects per index, which matters
//    for the 27-chunk snapshot worlds - both are measured.
// ---------------------------------------------------------------------------

class BucketedMap {
    constructor(buckets, eager) {
        // the shipped grid used `% 1024`; for a power-of-two count a mask is the
        // same bucket for every key and one instruction cheaper
        this._buckets = buckets;
        this._mask = buckets - 1;
        this._dict = new Array(buckets);
        this._count = 0;

        if (eager) {
            for (let i = 0; i < buckets; i++) {
                this._dict[i] = new Map();
            }
        }

        this._eager = eager === true;
    }

    get length() { return this._count; }

    get(key) {
        const k = key.key;
        const bucket = this._dict[k & this._mask];

        if (bucket === undefined) {
            return null;
        }

        const value = bucket.get(k);

        return value !== undefined ? value : null;
    }

    set(key, value) {
        const k = key.key;
        const b = k & this._mask;

        let bucket = this._dict[b];

        if (bucket === undefined) {
            bucket = new Map();
            this._dict[b] = bucket;
        }

        const before = bucket.size;

        bucket.set(k, value);

        if (bucket.size !== before) {
            this._count++;
        }
    }

    remove(key) {
        const k = key.key;
        const bucket = this._dict[k & this._mask];

        if (bucket === undefined) {
            return false;
        }

        if (bucket.delete(k)) {
            this._count--;

            return true;
        }

        return false;
    }

    *values() {
        const dict = this._dict;

        for (let i = 0, l = dict.length; i < l; i++) {
            const bucket = dict[i];

            if (bucket !== undefined) {
                yield* bucket.values();
            }
        }
    }

    stats() {
        let used = 0;
        let max = 0;

        for (let i = 0; i < this._buckets; i++) {
            const bucket = this._dict[i];

            if (bucket !== undefined && bucket.size > 0) {
                used++;

                if (bucket.size > max) {
                    max = bucket.size;
                }
            }
        }

        return { buckets: this._buckets, used, maxDepth: max, meanDepth: this._count / this._buckets };
    }
}

// ---------------------------------------------------------------------------
// G. Map behind the existing HashGrid surface - the drop-in the report proposes
// ---------------------------------------------------------------------------

class MapWrapped {
    constructor() {
        this._map = new Map();
    }

    get length() { return this._map.size; }

    get(key) {
        const v = this._map.get(key.key);

        return v !== undefined ? v : null;
    }

    set(key, value) { this._map.set(key.key, value); }
    remove(key) { return this._map.delete(key.key); }
    *values() { yield* this._map.values(); }
}

// ---------------------------------------------------------------------------
// H. raw Map driven with numeric keys - isolates the Key object indirection
// ---------------------------------------------------------------------------

class MapRaw {
    constructor() {
        this._map = new Map();
    }

    get length() { return this._map.size; }

    get(k) {
        const v = this._map.get(k);

        return v !== undefined ? v : null;
    }

    set(k, value) { this._map.set(k, value); }
    remove(k) { return this._map.delete(k); }
    *values() { yield* this._map.values(); }
}

MapRaw.rawKeys = true;

// ---------------------------------------------------------------------------
// I/J. open addressing with linear probing over a flat Int32Array of keys.
//      Identity hashing keeps the Morton locality; the mixed variant exists to
//      test whether that locality is a help or a hazard.
// ---------------------------------------------------------------------------

const EMPTY = 0;
const FULL = 1;
const DEAD = 2;

class OpenAddressed {
    constructor(hint, mix) {
        const cap = nextPow2(Math.max(64, Math.ceil(hint / 0.7)));

        this._mix = mix;
        this._cap = cap;
        this._mask = cap - 1;
        // high bits of the product - see distribution.mjs
        this._shift = 32 - Math.log2(cap);
        this._keys = new Int32Array(cap);
        this._state = new Uint8Array(cap);
        this._vals = new Array(cap);
        this._count = 0;
        this._used = 0;
    }

    get length() { return this._count; }

    _hash(k) {
        if (this._mix === 1) {
            return Math.imul(k, 0x9e3779b1) >>> this._shift;
        }

        if (this._mix === 2) {
            return (k ^ (k >>> 7) ^ (k >>> 11)) & this._mask;
        }

        return (k >>> 0) & this._mask;
    }

    get(key) {
        const k = key.key;
        const keys = this._keys;
        const state = this._state;
        const mask = this._mask;

        let i = this._hash(k);

        for (;;) {
            const s = state[i];

            if (s === EMPTY) {
                return null;
            }

            if (s === FULL && keys[i] === k) {
                return this._vals[i];
            }

            i = (i + 1) & mask;
        }
    }

    set(key, value) {
        const k = key.key;
        const keys = this._keys;
        const state = this._state;
        const mask = this._mask;

        let i = this._hash(k);
        let firstDead = -1;

        for (;;) {
            const s = state[i];

            if (s === EMPTY) {
                break;
            }

            if (s === DEAD) {
                if (firstDead < 0) {
                    firstDead = i;
                }
            }
            else if (keys[i] === k) {
                this._vals[i] = value;

                return;
            }

            i = (i + 1) & mask;
        }

        if (firstDead >= 0) {
            keys[firstDead] = k;
            state[firstDead] = FULL;
            this._vals[firstDead] = value;
            this._count++;

            return;
        }

        keys[i] = k;
        state[i] = FULL;
        this._vals[i] = value;
        this._count++;
        this._used++;

        if (this._used > this._cap * 0.7) {
            this._rehash(this._count > this._cap * 0.35 ? this._cap * 2 : this._cap);
        }
    }

    remove(key) {
        const k = key.key;
        const keys = this._keys;
        const state = this._state;
        const mask = this._mask;

        let i = this._hash(k);

        for (;;) {
            const s = state[i];

            if (s === EMPTY) {
                return false;
            }

            if (s === FULL && keys[i] === k) {
                state[i] = DEAD;
                this._vals[i] = undefined;
                this._count--;

                return true;
            }

            i = (i + 1) & mask;
        }
    }

    _rehash(newCap) {
        const oldKeys = this._keys;
        const oldState = this._state;
        const oldVals = this._vals;
        const oldCap = this._cap;

        this._cap = newCap;
        this._mask = newCap - 1;
        this._shift = 32 - Math.log2(newCap);
        this._keys = new Int32Array(newCap);
        this._state = new Uint8Array(newCap);
        this._vals = new Array(newCap);
        this._used = this._count;

        for (let j = 0; j < oldCap; j++) {
            if (oldState[j] !== FULL) {
                continue;
            }

            const k = oldKeys[j];

            let i = this._hash(k);

            while (this._state[i] === FULL) {
                i = (i + 1) & this._mask;
            }

            this._keys[i] = k;
            this._state[i] = FULL;
            this._vals[i] = oldVals[j];
        }
    }

    *values() {
        const state = this._state;

        for (let i = 0, l = state.length; i < l; i++) {
            if (state[i] === FULL) {
                yield this._vals[i];
            }
        }
    }

    stats() {
        // mean probe distance from the ideal slot
        let total = 0;

        for (let i = 0; i < this._cap; i++) {
            if (this._state[i] !== FULL) {
                continue;
            }

            const ideal = this._hash(this._keys[i]);

            total += (i - ideal) & this._mask;
        }

        return { capacity: this._cap, load: this._count / this._cap, meanProbe: 1 + total / Math.max(1, this._count) };
    }
}

class OpenAddr extends OpenAddressed {
    constructor(hint) { super(hint, 0); }
}

class OpenAddrMix extends OpenAddressed {
    constructor(hint) { super(hint, 1); }
}

class OpenAddrFold extends OpenAddressed {
    constructor(hint) { super(hint, 2); }
}

// ---------------------------------------------------------------------------

export const IMPLS = {
    "shipped": { ctor: Shipped, label: "HashGrid (as it currently ships)" },
    "old-chained": { ctor: OldChained, label: "HashGrid before the Map change" },
    "chain-mask": { ctor: ChainMask1024, label: "Chained 1024, mask + flat buckets" },
    "chain-grow": { ctor: ChainGrow, label: "Chained, doubling on load 1.0" },
    "chain-grow-mix": { ctor: ChainGrowMix, label: "Chained, doubling, mixed hash" },
    "chain-grow-fold": { ctor: ChainGrowFold, label: "Chained, doubling, xor-fold hash" },
    "chain-presized": { ctor: ChainPresized, label: "Chained, pre-sized to N" },
    "sorted-buckets": { ctor: SortedBuckets1024, label: "Sorted buckets 1024 + binary search" },
    "sorted-flat": { ctor: SortedFlat, label: "One sorted array + binary search" },
    "map-wrapped": { ctor: MapWrapped, label: "Map behind the HashGrid surface" },
    "bucket-map-64": { ctor: class extends BucketedMap { constructor() { super(64, false); } }, label: "64 buckets, Map in each" },
    "bucket-map-256": { ctor: class extends BucketedMap { constructor() { super(256, false); } }, label: "256 buckets, Map in each" },
    "bucket-map-1024": { ctor: class extends BucketedMap { constructor() { super(1024, false); } }, label: "1024 buckets, Map in each" },
    "bucket-map-4096": { ctor: class extends BucketedMap { constructor() { super(4096, false); } }, label: "4096 buckets, Map in each" },
    "bucket-map-16384": { ctor: class extends BucketedMap { constructor() { super(16384, false); } }, label: "16384 buckets, Map in each" },
    "bucket-map-1024-eager": { ctor: class extends BucketedMap { constructor() { super(1024, true); } }, label: "1024 buckets, pre-allocated Maps" },
    "map-raw": { ctor: MapRaw, label: "Map, raw numeric keys", rawKeys: true },
    "open-addr": { ctor: OpenAddr, label: "Open addressing, identity hash" },
    "open-addr-mix": { ctor: OpenAddrMix, label: "Open addressing, multiply-shift hash" },
    "open-addr-fold": { ctor: OpenAddrFold, label: "Open addressing, xor-fold hash" }
};

export const IMPL_NAMES = Object.keys(IMPLS);
