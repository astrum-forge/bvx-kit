/**
 * Child process: resident memory cost of ONE candidate index at ONE size.
 *
 * Every entry stores the same shared value object, so the measured delta is the
 * index structure alone - nodes, arrays, hash tables - and not the payload.
 *
 * Three things this has to get right, all of which a naive heapUsed delta gets
 * wrong (verified against Int32Array, whose true cost is exactly 4 B/entry):
 *
 *   1. typed arrays live outside heapUsed, so `external` must be included
 *   2. one measurement per process - a structure from an earlier job stays
 *      reachable from the stack and gets collected mid-measurement, which can
 *      make a delta come out negative
 *   3. several independent copies, so the allocation dominates the GC noise
 *      floor rather than sitting inside it
 */

import { IMPLS } from "./impls.mjs";
import { layoutCoords, toRawKeys, toKeyObjects } from "./workloads.mjs";

const args = new Map(process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");

    return [a.slice(2, i), a.slice(i + 1)];
}));

const implName = args.get("impl");
const layout = args.get("layout");
const n = Number(args.get("n"));
const copies = Number(args.get("copies") ?? 6);

const { ctor: Impl, rawKeys } = IMPLS[implName];
const VALUE = { tag: "chunk" };

const settle = () => {
    for (let i = 0; i < 6; i++) {
        global.gc();
    }

    const m = process.memoryUsage();

    return m.heapUsed + m.external;
};

const coords = layoutCoords(layout, n);
const raw = toRawKeys(coords);
const objs = toKeyObjects(raw);
const keys = rawKeys ? raw : objs;

const held = [];
const before = settle();

for (let c = 0; c < copies; c++) {
    const index = new Impl(coords.length);

    for (let i = 0; i < keys.length; i++) {
        index.set(keys[i], VALUE);
    }

    held.push(index);
}

const after = settle();

for (const index of held) {
    if (index.length !== coords.length) {
        throw new Error(`${implName} stored ${index.length} of ${coords.length}`);
    }
}

const bytes = (after - before) / copies;

process.stdout.write(JSON.stringify([{
    impl: implName,
    layout,
    n: coords.length,
    copies,
    bytes,
    bytesPerEntry: bytes / coords.length
}]));
