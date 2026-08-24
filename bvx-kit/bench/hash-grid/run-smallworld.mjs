/**
 * Child process: the cost of a SHORT-LIVED index, for ONE candidate.
 *
 * BVXMesher's snapshot protocol deserialises a fresh 27-chunk VoxelWorld for
 * every mesh request, so the index is constructed, filled with 27 entries,
 * queried a handful of times and thrown away - thousands of times a second.
 * That is the opposite of the resident-world workload and a fixed 1024-bucket
 * array is a very different proposition there.
 *
 * Measures the construct + 27 insert + 6 lookup cycle, and the empty-index
 * allocation footprint. Run with --expose-gc.
 */

import { MortonKey } from "../../out/index.js";
import { IMPLS } from "./impls.mjs";
import { timeit } from "./workloads.mjs";

const args = new Map(process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");

    return [a.slice(2, i), a.slice(i + 1)];
}));

const implName = args.get("impl");
const { ctor: Impl, rawKeys } = IMPLS[implName];
const VALUE = { tag: "chunk" };

// a 3x3x3 neighbourhood, exactly what a mesh request carries
const neighbourhood = [];

for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
        for (let z = 0; z < 3; z++) {
            const k = MortonKey.from(100 + x, 8 + y, 100 + z);

            neighbourhood.push(rawKeys ? k.key : k);
        }
    }
}

// the six face neighbours the blocky mesher queries
const probes = [4, 10, 12, 14, 16, 22].map((i) => neighbourhood[i]);

const cycleNs = timeit(() => {
    const index = new Impl(27);

    for (let i = 0; i < neighbourhood.length; i++) {
        index.set(neighbourhood[i], VALUE);
    }

    let acc = 0;

    for (let i = 0; i < probes.length; i++) {
        if (index.get(probes[i]) !== null) {
            acc++;
        }
    }

    return acc;
}, 1, { minMs: 200, reps: 5, warmups: 3 });

// empty-index footprint - how much memory a world costs before it holds anything
const settle = () => {
    for (let i = 0; i < 6; i++) {
        global.gc();
    }

    const m = process.memoryUsage();

    return m.heapUsed + m.external;
};

const COPIES = 2000;
const held = new Array(COPIES);
const before = settle();

for (let i = 0; i < COPIES; i++) {
    held[i] = new Impl(27);
}

const after = settle();

if (held[COPIES - 1].length !== 0) {
    throw new Error("unexpected");
}

process.stdout.write(JSON.stringify([{
    impl: implName,
    cycleNs,
    emptyBytes: (after - before) / COPIES
}]));
