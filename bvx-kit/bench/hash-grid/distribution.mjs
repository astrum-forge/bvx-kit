/**
 * Tests the premise the HashGrid was built on: that Morton (Z-order) keys with
 * a power-of-two bucket count self-distribute, so no hashing step is needed.
 *
 * Pure counting, no timing. For each resident-chunk layout it reports the
 * bucket depth distribution and, more usefully, the expected number of key
 * comparisons a successful lookup performs - which is what the linear scan
 * inside a bucket actually costs.
 *
 * Three bucket-index functions are compared:
 *   morton     key & (buckets - 1)          what ships today
 *   linear     LinearKey low bits           the alternative key encoding
 *   mixed      multiply-shift over the key  what a general hash map does
 */

import { layoutCoords } from "./workloads.mjs";

const LAYOUTS = ["cube", "terrain", "thin", "sphere", "shell"];
const SIZES = [1024, 8192, 32768, 131072, 262144];

const mortonEncode = (n) => {
    const n0 = n & 0x3ff;
    const n1 = (n0 ^ (n0 << 16)) & 0xff0000ff;
    const n2 = (n1 ^ (n1 << 8)) & 0x0300f00f;
    const n3 = (n2 ^ (n2 << 4)) & 0x030c30c3;

    return (n3 ^ (n3 << 2)) & 0x09249249;
};

const KEYFN = {
    morton: (x, y, z) => (mortonEncode(z) << 2) + (mortonEncode(y) << 1) + mortonEncode(x),
    linear: (x, y, z) => ((x & 0x3ff) << 20) | ((y & 0x3ff) << 10) | (z & 0x3ff)
};

const nextPow2 = (n) => {
    let v = 16;

    while (v < n) {
        v *= 2;
    }

    return v;
};

/**
 * Bucket-depth statistics for a key set under a given index function.
 */
const analyse = (keys, buckets, mix) => {
    const depth = new Int32Array(buckets);
    const mask = buckets - 1;
    // multiply-shift takes the HIGH bits of the product - the low bits of an
    // odd multiply are just a permutation of the low bits of the key and would
    // reproduce the identity distribution exactly
    const shift = 32 - Math.log2(buckets);

    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const b = mix ? Math.imul(k, 0x9e3779b1) >>> shift : (k >>> 0) & mask;

        depth[b]++;
    }

    let used = 0;
    let max = 0;
    let compares = 0;

    for (let i = 0; i < buckets; i++) {
        const d = depth[i];

        if (d > 0) {
            used++;

            if (d > max) {
                max = d;
            }
        }

        // a successful lookup into a bucket of depth d costs (d+1)/2 compares
        // on average, so summing d*(d+1)/2 over buckets and dividing by the
        // entry count gives the expected compares per hit
        compares += (d * (d + 1)) / 2;
    }

    return {
        buckets,
        used,
        usedPct: (used / buckets) * 100,
        mean: keys.length / buckets,
        max,
        comparesPerHit: compares / keys.length,
        idealComparesPerHit: (keys.length / buckets + 1) / 2
    };
};

const rows = [];

for (const layout of LAYOUTS) {
    for (const n of SIZES) {
        const coords = layoutCoords(layout, n);

        for (const scheme of ["morton", "linear"]) {
            const fn = KEYFN[scheme];
            const keys = new Int32Array(coords.length);

            for (let i = 0; i < coords.length; i++) {
                keys[i] = fn(coords[i][0], coords[i][1], coords[i][2]);
            }

            rows.push({
                layout,
                n: coords.length,
                scheme,
                fixed1024: analyse(keys, 1024, false),
                mixed1024: analyse(keys, 1024, true),
                grown: analyse(keys, nextPow2(coords.length), false),
                grownMixed: analyse(keys, nextPow2(coords.length), true)
            });
        }
    }
}

process.stdout.write(JSON.stringify(rows, null, 0));
