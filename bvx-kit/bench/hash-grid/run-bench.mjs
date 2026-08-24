/**
 * Child process: measures ONE candidate index across every requested
 * (layout, size) pair and prints a JSON result to stdout.
 *
 * One implementation per process is deliberate. Exercising several candidates
 * from the same call site turns it megamorphic in V8 and quietly penalises
 * whichever ran second, which is exactly the trap that makes in-process
 * container benchmarks unreliable.
 */

import { IMPLS } from "./impls.mjs";
import { layoutCoords, toRawKeys, toKeyObjects, shuffled, timeit } from "./workloads.mjs";

const args = new Map(process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");

    return [a.slice(2, i), a.slice(i + 1)];
}));

const implName = args.get("impl");
const jobs = JSON.parse(args.get("jobs"));
const entry = IMPLS[implName];

if (!entry) {
    throw new Error(`unknown impl ${implName}`);
}

const { ctor: Impl, rawKeys } = entry;

// A single shared value object for every entry. Keeps the measurement about the
// index rather than about the payload.
const VALUE = { tag: "chunk" };

/**
 * Chooses the key representation the candidate expects.
 */
const keysFor = (objs, raws) => (rawKeys ? raws : objs);

/**
 * Builds a populated index and returns it.
 */
const build = (keys, n) => {
    const index = new Impl(n);

    for (let i = 0; i < keys.length; i++) {
        index.set(keys[i], VALUE);
    }

    return index;
};

const results = [];

for (const job of jobs) {
    const { layout, n } = job;

    const coords = layoutCoords(layout, n);
    const actual = coords.length;

    const rawResident = toRawKeys(coords);
    const objResident = toKeyObjects(rawResident);

    // absent keys - same shape, translated clear of the resident region
    const missCoords = coords.map((c) => [c[0] + 400, c[1], c[2]]);
    const rawMiss = toRawKeys(missCoords);
    const objMiss = toKeyObjects(rawMiss);

    // churn keys - a streaming batch, translated on a different axis again
    const churnCount = Math.min(2048, Math.max(64, actual >> 3));
    const farCoords = coords.slice(0, churnCount).map((c) => [c[0], c[1], c[2] + 400]);
    const rawFar = toRawKeys(farCoords);
    const objFar = toKeyObjects(rawFar);

    const resident = keysFor(objResident, rawResident);
    const miss = keysFor(objMiss, rawMiss);
    const far = keysFor(objFar, rawFar);

    // coherent probe order is the resident order itself - an x-major sweep, the
    // access pattern a mesher or a chunk streamer actually produces
    const coherent = resident;
    const random = shuffled(resident, 0xC0FFEE);

    const index = build(resident, actual);
    const stored = index.length;

    const row = { impl: implName, layout, n: actual, stored };

    // ---- lookups -------------------------------------------------------

    row.getHitCoherent = timeit(() => {
        let acc = 0;

        for (let i = 0; i < coherent.length; i++) {
            if (index.get(coherent[i]) !== null) {
                acc++;
            }
        }

        return acc;
    }, coherent.length);

    row.getHitRandom = timeit(() => {
        let acc = 0;

        for (let i = 0; i < random.length; i++) {
            if (index.get(random[i]) !== null) {
                acc++;
            }
        }

        return acc;
    }, random.length);

    row.getMiss = timeit(() => {
        let acc = 0;

        for (let i = 0; i < miss.length; i++) {
            if (index.get(miss[i]) === null) {
                acc++;
            }
        }

        return acc;
    }, miss.length);

    // a job may ask for lookups only, for cheap repeated runs that measure
    // run-to-run variance rather than adding more workloads
    if (job.lookupsOnly) {
        results.push(row);

        continue;
    }

    // ---- full iteration -------------------------------------------------

    row.iterate = timeit(() => {
        let acc = 0;

        for (const v of index.values()) {
            if (v !== null) {
                acc++;
            }
        }

        return acc;
    }, stored);

    // ---- structural diagnostics ----------------------------------------

    if (typeof index.stats === "function") {
        row.stats = index.stats();
    }

    // ---- churn - a streaming batch out and back in ----------------------

    row.churn = timeit(() => {
        for (let i = 0; i < churnCount; i++) {
            index.remove(resident[i]);
        }

        for (let i = 0; i < churnCount; i++) {
            index.set(far[i], VALUE);
        }

        for (let i = 0; i < churnCount; i++) {
            index.remove(far[i]);
        }

        for (let i = 0; i < churnCount; i++) {
            index.set(resident[i], VALUE);
        }

        return index.length;
    }, churnCount * 4, { minMs: 100, reps: 5, warmups: 2 });

    // ---- cold build -----------------------------------------------------

    const buildLimit = job.buildLimit ?? Infinity;

    if (actual <= buildLimit) {
        row.build = timeit(() => build(resident, actual).length, actual, { minMs: 50, reps: 3, warmups: 1 });
    }

    results.push(row);
}

process.stdout.write(JSON.stringify(results));
