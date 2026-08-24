/**
 * Chunk layouts, probe sequences and the timing helper shared by every child
 * process in the HashGrid experiment.
 *
 * Layouts are deliberately shaped like real resident chunk sets rather than
 * random keys - the whole premise under test is that Morton keys distribute
 * evenly, and random keys would distribute evenly under any hash.
 */

import { MortonKey } from "../../out/index.js";

/**
 * Deterministic LCG, same generator the existing bench.js uses.
 */
export const makeRand = (initialSeed) => {
    let seed = initialSeed;

    return () => {
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;

        return seed / 0x7FFFFFFF;
    };
};

/**
 * Builds the (x, y, z) chunk coordinates for a named layout.
 *
 * cube    - a solid cube of chunks, the friendliest possible case
 * terrain - a wide slab 8 chunks tall, what a 1 m/BitVoxel open world looks like
 * thin    - a slab only 2 chunks tall, a near-2D world
 * sphere  - a ball of chunks around the camera, what streaming actually keeps
 * shell   - a hollow ball, what a world with terrain surface only keeps resident
 */
export const layoutCoords = (layout, target) => {
    const out = [];
    const ox = 64;
    const oy = 8;
    const oz = 64;

    if (layout === "cube") {
        const side = Math.ceil(Math.cbrt(target));

        for (let x = 0; x < side && out.length < target; x++) {
            for (let y = 0; y < side && out.length < target; y++) {
                for (let z = 0; z < side && out.length < target; z++) {
                    out.push([ox + x, oy + y, oz + z]);
                }
            }
        }

        return out;
    }

    if (layout === "terrain" || layout === "thin") {
        const height = layout === "terrain" ? 8 : 2;
        const side = Math.ceil(Math.sqrt(target / height));

        for (let x = 0; x < side && out.length < target; x++) {
            for (let z = 0; z < side && out.length < target; z++) {
                for (let y = 0; y < height && out.length < target; y++) {
                    out.push([ox + x, oy + y, oz + z]);
                }
            }
        }

        return out;
    }

    if (layout === "sphere" || layout === "shell") {
        const hollow = layout === "shell";
        // solid ball volume 4/3 pi r^3, hollow shell keeps ~40% of it
        const r = Math.ceil(Math.cbrt((target * (hollow ? 2.5 : 1.0)) / 4.18879));
        const inner = hollow ? r * 0.78 : -1;
        const r2 = r * r;
        const inner2 = inner * inner;

        for (let x = -r; x <= r; x++) {
            for (let y = -r; y <= r; y++) {
                for (let z = -r; z <= r; z++) {
                    const d2 = x * x + y * y + z * z;

                    if (d2 > r2 || (hollow && d2 < inner2)) {
                        continue;
                    }

                    out.push([ox + r + x, oy + r + y, oz + r + z]);
                }
            }
        }

        // deterministic trim to the requested count
        return out.slice(0, target);
    }

    throw new Error(`unknown layout ${layout}`);
};

/**
 * Encodes a coordinate list into raw Morton keys.
 */
export const toRawKeys = (coords) => {
    const keys = new Int32Array(coords.length);
    const tmp = new MortonKey();

    for (let i = 0; i < coords.length; i++) {
        const c = coords[i];

        MortonKey.from(c[0], c[1], c[2], tmp);
        keys[i] = tmp.key;
    }

    return keys;
};

/**
 * Materialises one MortonKey object per raw key. Allocated once, outside every
 * timed region, so key construction is never part of a lookup measurement.
 */
export const toKeyObjects = (raw) => {
    const keys = new Array(raw.length);

    for (let i = 0; i < raw.length; i++) {
        keys[i] = new MortonKey(raw[i]);
    }

    return keys;
};

/**
 * Fisher-Yates with a fixed seed - the same permutation for every candidate.
 */
export const shuffled = (arr, seed) => {
    const rand = makeRand(seed);
    const out = arr.slice();

    for (let i = out.length - 1; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0;
        const t = out[i];

        out[i] = out[j];
        out[j] = t;
    }

    return out;
};

let sink = 0;

/**
 * Runs `runOnce` (which performs exactly `opsPerRun` operations and returns a
 * number to accumulate) until each sample covers at least `minMs`, and reports
 * the median nanoseconds per operation across `reps` samples.
 */
export const timeit = (runOnce, opsPerRun, { minMs = 150, reps = 5, warmups = 3 } = {}) => {
    for (let i = 0; i < warmups; i++) {
        sink += runOnce();
    }

    const samples = [];

    for (let r = 0; r < reps; r++) {
        const t0 = performance.now();

        let ops = 0;

        // assigned by the first pass of the loop below, which always runs at least once
        let t1;

        do {
            sink += runOnce();
            ops += opsPerRun;
            t1 = performance.now();
        } while (t1 - t0 < minMs);

        samples.push(((t1 - t0) * 1e6) / ops);
    }

    samples.sort((a, b) => a - b);

    return samples[samples.length >> 1];
};

export const getSink = () => sink;
