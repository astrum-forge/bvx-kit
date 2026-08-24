/**
 * How repeatable is a single benchmark run?
 *
 * The median-of-5 inside one process controls for noise within that process. It
 * does not control for whatever V8 decided to do with the code that run - and a
 * first pass showed the slow candidates reproducing to within 1% while the fast
 * ones moved by 30-70% between passes.
 *
 * This runs the lookup measurements REPS times per candidate, each in a fresh
 * process, and reports the median and the full spread. Numbers whose spread
 * overlaps should not be reported as different.
 *
 *   node bench/hash-grid/stability.mjs [--reps=5] [--n=262144]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = new Map(process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");

    return i < 0 ? [a.slice(2), "1"] : [a.slice(2, i), a.slice(i + 1)];
}));

const REPS = Number(argv.get("reps") ?? 5);
const N = Number(argv.get("n") ?? 262144);
const LAYOUTS = (argv.get("layouts") ?? "terrain").split(",");
const TAG = argv.get("tag") ?? String(N);

const ALL = [
    "shipped", "chain-mask", "sorted-buckets", "sorted-flat", "chain-grow",
    "chain-grow-mix", "chain-grow-fold", "chain-presized", "open-addr",
    "open-addr-mix", "open-addr-fold", "map-wrapped", "map-raw"
];

const IMPLS = argv.has("impls") ? argv.get("impls").split(",") : ALL;

const LABELS = {
    "shipped": "HashGrid, as shipped",
    "chain-mask": "Chained 1024, mask + flat",
    "sorted-buckets": "Sorted buckets 1024",
    "sorted-flat": "One sorted array",
    "chain-grow": "Chained, doubling",
    "chain-grow-mix": "Chained, doubling, mixed",
    "chain-grow-fold": "Chained, doubling, fold",
    "chain-presized": "Chained, pre-sized",
    "open-addr": "Open addressing",
    "open-addr-mix": "Open addressing, mixed",
    "open-addr-fold": "Open addressing, fold",
    "map-wrapped": "Map (wrapped)",
    "bucket-map-64": "64 buckets, Map each",
    "bucket-map-256": "256 buckets, Map each",
    "bucket-map-1024": "1024 buckets, Map each",
    "bucket-map-4096": "4096 buckets, Map each",
    "bucket-map-16384": "16384 buckets, Map each",
    "bucket-map-1024-eager": "1024 buckets, eager Maps",
    "old-chained": "HashGrid before the change",
    "map-raw": "Map (raw keys)"
};

const samples = new Map();

for (const impl of IMPLS) {
    for (const layout of LAYOUTS) {
        const jobs = JSON.stringify([{ layout, n: N, lookupsOnly: true }]);
        const runs = [];

        for (let r = 0; r < REPS; r++) {
            process.stderr.write(`  ${impl} ${layout} ${r + 1}/${REPS}\n`);

            const out = execFileSync(process.execPath, [
                "--max-old-space-size=6144", join(HERE, "run-bench.mjs"), `--impl=${impl}`, `--jobs=${jobs}`
            ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });

            runs.push(JSON.parse(out)[0]);
        }

        samples.set(`${impl}|${layout}`, runs);
    }
}

const stat = (vals) => {
    const s = [...vals].sort((a, b) => a - b);

    return { median: s[s.length >> 1], min: s[0], max: s[s.length - 1] };
};

const rows = [];

for (const impl of IMPLS) {
    for (const layout of LAYOUTS) {
        const runs = samples.get(`${impl}|${layout}`);

        rows.push({
            impl,
            layout,
            coherent: stat(runs.map((r) => r.getHitCoherent)),
            random: stat(runs.map((r) => r.getHitRandom)),
            miss: stat(runs.map((r) => r.getMiss))
        });
    }
}

const fmt = (s) => `${s.median.toFixed(1)} [${s.min.toFixed(1)}-${s.max.toFixed(1)}]`;

const multi = LAYOUTS.length > 1;
const headers = multi
    ? ["implementation", "layout", "coherent hit", "random hit", "miss"]
    : ["implementation", "coherent hit", "random hit", "miss"];
const cells = rows.map((r) => (multi
    ? [LABELS[r.impl], r.layout, fmt(r.coherent), fmt(r.random), fmt(r.miss)]
    : [LABELS[r.impl], fmt(r.coherent), fmt(r.random), fmt(r.miss)]));
const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
const line = (c) => c.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join("  ");

console.log(`\nns/op, median [min-max] over ${REPS} independent processes, N = ${N}, layouts: ${LAYOUTS.join(", ")}\n`);
console.log(line(headers));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
cells.forEach((c) => console.log(line(c)));

writeFileSync(join(HERE, `stability-${TAG}.json`), JSON.stringify({ reps: REPS, n: N, layouts: LAYOUTS, rows, raw: [...samples] }, null, 2));
console.log(`\nwritten to stability-${TAG}.json\n`);
