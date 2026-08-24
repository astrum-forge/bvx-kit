/**
 * Correctness gate for the experiment. Every candidate must behave identically
 * to the shipped HashGrid before any of its timings are worth reading.
 *
 * Cross-checks set / get / remove / length / values against a reference Map
 * over a mix of layouts, with interleaved updates, removals and re-inserts.
 */

import { MortonKey } from "../../out/index.js";
import { IMPLS } from "./impls.mjs";
import { layoutCoords, toRawKeys, toKeyObjects, shuffled, makeRand } from "./workloads.mjs";

let failures = 0;

const check = (name, cond, detail) => {
    if (!cond) {
        failures++;
        console.log(`  FAIL ${name}: ${detail}`);
    }
};

for (const [implName, entry] of Object.entries(IMPLS)) {
    const { ctor: Impl, rawKeys } = entry;

    for (const layout of ["cube", "terrain", "thin", "sphere", "shell"]) {
        const coords = layoutCoords(layout, 5000);
        const raw = toRawKeys(coords);
        const objs = toKeyObjects(raw);
        const keys = rawKeys ? raw : objs;

        const index = new Impl(coords.length);
        const ref = new Map();

        // insert everything
        for (let i = 0; i < keys.length; i++) {
            index.set(keys[i], i);
            ref.set(raw[i], i);
        }

        check(implName, index.length === ref.size, `${layout} length ${index.length} != ${ref.size}`);

        // every key must read back
        for (let i = 0; i < keys.length; i++) {
            if (index.get(keys[i]) !== i) {
                check(implName, false, `${layout} get(${raw[i]}) = ${index.get(keys[i])}, want ${i}`);

                break;
            }
        }

        // absent keys must return null
        const missCoords = coords.slice(0, 500).map((c) => [c[0] + 400, c[1], c[2]]);
        const missRaw = toRawKeys(missCoords);
        const missKeys = rawKeys ? missRaw : toKeyObjects(missRaw);

        for (let i = 0; i < missKeys.length; i++) {
            if (index.get(missKeys[i]) !== null) {
                check(implName, false, `${layout} miss returned a value`);

                break;
            }
        }

        // update in place must not change length
        index.set(keys[0], -1);
        check(implName, index.get(keys[0]) === -1, `${layout} update did not take`);
        check(implName, index.length === ref.size, `${layout} update changed length`);
        index.set(keys[0], 0);

        // interleaved churn against the reference
        const rand = makeRand(4242);
        const order = shuffled([...keys.keys()], 99);

        for (let step = 0; step < 4000; step++) {
            const i = order[step % order.length];

            if (rand() < 0.5) {
                const had = ref.delete(raw[i]);

                check(implName, index.remove(keys[i]) === had, `${layout} remove disagreed at ${raw[i]}`);
            }
            else {
                index.set(keys[i], i + 7);
                ref.set(raw[i], i + 7);
            }
        }

        check(implName, index.length === ref.size, `${layout} post-churn length ${index.length} != ${ref.size}`);

        for (const [k, v] of ref) {
            const kk = rawKeys ? k : new MortonKey(k);

            if (index.get(kk) !== v) {
                check(implName, false, `${layout} post-churn get(${k}) = ${index.get(kk)}, want ${v}`);

                break;
            }
        }

        // values() must yield every entry exactly once
        const seen = [];

        for (const v of index.values()) {
            seen.push(v);
        }

        check(implName, seen.length === ref.size, `${layout} values() yielded ${seen.length}, want ${ref.size}`);

        const expected = [...ref.values()].sort((a, b) => a - b).join(",");

        check(implName, seen.sort((a, b) => a - b).join(",") === expected, `${layout} values() contents differ`);
    }

    console.log(`${failures === 0 ? "ok  " : "??  "} ${implName}`);
}

console.log(failures === 0 ? "\nall candidates agree with the reference\n" : `\n${failures} failures\n`);
process.exit(failures === 0 ? 0 : 1);
