/**
 * Orchestrator for the HashGrid experiment.
 *
 * Spawns one child process per candidate implementation so that every measured
 * call site stays monomorphic, collects the JSON each child prints, and writes
 * both a raw results file and formatted tables.
 *
 *   node bench/hash-grid/index.mjs                 all phases
 *   node bench/hash-grid/index.mjs --phase=micro   one phase
 *   node bench/hash-grid/index.mjs --out=path.json
 *
 * Phases: dist (bucket distribution), micro (operation microbenchmarks),
 *         mem (resident bytes per entry), e2e (mesher and raycaster).
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

const phases = (argv.get("phase") ?? "dist,micro,mem,e2e").split(",");
const outPath = argv.get("out") ?? join(HERE, "results.json");
const only = argv.has("impls") ? new Set(argv.get("impls").split(",")) : null;

const ALL_IMPLS = [
    "shipped",
    "chain-mask",
    "sorted-buckets",
    "sorted-flat",
    "chain-grow",
    "chain-grow-mix",
    "chain-grow-fold",
    "chain-presized",
    "open-addr",
    "open-addr-mix",
    "open-addr-fold",
    "map-wrapped",
    "map-raw"
];

const IMPL_ORDER = only ? ALL_IMPLS.filter((i) => only.has(i)) : ALL_IMPLS;

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
    "map-raw": "Map (raw keys)"
};

const run = (script, args, extraNodeArgs = []) => {
    const out = execFileSync(process.execPath, [...extraNodeArgs, join(HERE, script), ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"]
    });

    return JSON.parse(out);
};

const results = {
    meta: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`
    }
};

/**
 * Checkpoint after every phase - a long run that gets killed part way through
 * should still leave the phases that finished on disk.
 */
const checkpoint = () => writeFileSync(outPath, JSON.stringify(results, null, 2));

// ---------------------------------------------------------------------------

const fmt = (v, d = 1) => (v === undefined || v === null ? "-" : v.toFixed(d));

const table = (headers, rows) => {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join("  ");

    console.log(line(headers));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    rows.forEach((r) => console.log(line(r)));
};

// ---------------------------------------------------------------------------
// Phase: bucket distribution
// ---------------------------------------------------------------------------

if (phases.includes("dist")) {
    console.log("\n=== bucket distribution (no timing) ===\n");

    const dist = run("distribution.mjs", []);

    results.distribution = dist;
    checkpoint();

    console.log("Morton keys, 1024 fixed buckets - expected key compares per successful lookup\n");

    table(
        ["layout", "N", "used/1024", "mean depth", "max depth", "compares/hit", "ideal"],
        dist.filter((r) => r.scheme === "morton").map((r) => [
            r.layout,
            r.n,
            `${r.fixed1024.used} (${fmt(r.fixed1024.usedPct, 0)}%)`,
            fmt(r.fixed1024.mean, 1),
            r.fixed1024.max,
            fmt(r.fixed1024.comparesPerHit, 2),
            fmt(r.fixed1024.idealComparesPerHit, 2)
        ])
    );

    console.log("\nMorton vs Linear vs multiply-shift, 1024 buckets, compares per hit\n");

    const byKey = new Map();

    dist.forEach((r) => {
        const k = `${r.layout}|${r.n}`;

        if (!byKey.has(k)) {
            byKey.set(k, {});
        }

        byKey.get(k)[r.scheme] = r;
    });

    table(
        ["layout", "N", "morton", "linear", "morton+mix", "linear+mix"],
        [...byKey.entries()].map(([k, v]) => {
            const [layout, n] = k.split("|");

            return [
                layout,
                n,
                fmt(v.morton.fixed1024.comparesPerHit, 2),
                fmt(v.linear.fixed1024.comparesPerHit, 2),
                fmt(v.morton.mixed1024.comparesPerHit, 2),
                fmt(v.linear.mixed1024.comparesPerHit, 2)
            ];
        })
    );

    console.log("\nMorton keys, buckets grown to the next power of two >= N\n");

    table(
        ["layout", "N", "buckets", "used", "max depth", "compares/hit", "+mix used", "+mix compares"],
        dist.filter((r) => r.scheme === "morton").map((r) => [
            r.layout,
            r.n,
            r.grown.buckets,
            `${fmt(r.grown.usedPct, 0)}%`,
            r.grown.max,
            fmt(r.grown.comparesPerHit, 2),
            `${fmt(r.grownMixed.usedPct, 0)}%`,
            fmt(r.grownMixed.comparesPerHit, 2)
        ])
    );
}

// ---------------------------------------------------------------------------
// Phase: operation microbenchmarks
// ---------------------------------------------------------------------------

if (phases.includes("micro")) {
    console.log("\n=== operation microbenchmarks (ns / op, median of 5) ===\n");

    const sizes = [1024, 8192, 32768, 131072, 262144];
    const micro = [];

    for (const impl of IMPL_ORDER) {
        // a global sorted array costs O(N) per insert, so a cold build of 262k
        // entries takes minutes - cap it and report the gap rather than wait
        const buildLimit = impl === "sorted-flat" ? 40000 : 1e9;
        const jobs = [
            ...sizes.map((n) => ({ layout: "terrain", n, buildLimit })),
            ...["cube", "thin", "sphere", "shell"].map((layout) => ({ layout, n: 131072, buildLimit }))
        ];

        process.stderr.write(`  micro: ${impl}\n`);
        micro.push(...run("run-bench.mjs", [`--impl=${impl}`, `--jobs=${JSON.stringify(jobs)}`], ["--max-old-space-size=6144"]));
    }

    results.micro = micro;
    checkpoint();

    const at = (impl, layout, n) => micro.find((r) => r.impl === impl && r.layout === layout && r.n >= n * 0.98 && r.n <= n * 1.02);

    for (const op of ["getHitCoherent", "getHitRandom", "getMiss"]) {
        console.log(`\n${op} - terrain layout, ns/op\n`);

        table(
            ["implementation", ...sizes.map((n) => String(n))],
            IMPL_ORDER.map((impl) => [LABELS[impl], ...sizes.map((n) => fmt(at(impl, "terrain", n)?.[op], 1))])
        );
    }

    console.log("\ngetHitCoherent - layout sensitivity at N = 131072, ns/op\n");

    table(
        ["implementation", "terrain", "cube", "thin", "sphere", "shell"],
        IMPL_ORDER.map((impl) => [
            LABELS[impl],
            ...["terrain", "cube", "thin", "sphere", "shell"].map((l) => fmt(at(impl, l, 131072)?.getHitCoherent, 1))
        ])
    );

    console.log("\nmutation and iteration - terrain layout, ns/op\n");

    table(
        ["implementation", "churn 32k", "churn 262k", "build 32k", "build 262k", "iterate 262k"],
        IMPL_ORDER.map((impl) => [
            LABELS[impl],
            fmt(at(impl, "terrain", 32768)?.churn, 1),
            fmt(at(impl, "terrain", 262144)?.churn, 1),
            fmt(at(impl, "terrain", 32768)?.build, 1),
            fmt(at(impl, "terrain", 262144)?.build, 1),
            fmt(at(impl, "terrain", 262144)?.iterate, 1)
        ])
    );

    const withStats = micro.filter((r) => r.stats && r.layout === "terrain" && r.n >= 262000);

    if (withStats.length > 0) {
        console.log("\nstructure state at N = 262144, terrain\n");

        table(
            ["implementation", "buckets/cap", "used", "max depth / mean probe"],
            withStats.map((r) => [
                LABELS[r.impl],
                r.stats.buckets ?? r.stats.capacity,
                r.stats.used ?? `load ${fmt(r.stats.load, 2)}`,
                r.stats.maxDepth ?? fmt(r.stats.meanProbe, 2)
            ])
        );
    }
}

// ---------------------------------------------------------------------------
// Phase: memory
// ---------------------------------------------------------------------------

if (phases.includes("mem")) {
    console.log("\n=== index memory, shared value object, terrain layout ===\n");

    const mem = [];

    // one measurement per process - see the note in run-memory.mjs
    for (const impl of IMPL_ORDER) {
        for (const n of [32768, 262144]) {
            process.stderr.write(`  mem: ${impl} @${n}\n`);
            mem.push(...run("run-memory.mjs", [`--impl=${impl}`, "--layout=terrain", `--n=${n}`], ["--expose-gc", "--max-old-space-size=8192"]));
        }
    }

    results.memory = mem;
    checkpoint();

    table(
        ["implementation", "B/entry @32k", "B/entry @262k", "MB @262k"],
        IMPL_ORDER.map((impl) => {
            const small = mem.find((r) => r.impl === impl && r.n < 40000);
            const big = mem.find((r) => r.impl === impl && r.n > 200000);

            return [LABELS[impl], fmt(small?.bytesPerEntry, 1), fmt(big?.bytesPerEntry, 1), fmt(big ? big.bytes / 1048576 : undefined, 2)];
        })
    );
}

// ---------------------------------------------------------------------------
// Phase: short-lived worlds (the snapshot worker protocol)
// ---------------------------------------------------------------------------

if (phases.includes("small")) {
    console.log("\n=== short-lived 27-chunk world: construct + 27 inserts + 6 lookups ===\n");

    const small = [];

    for (const impl of IMPL_ORDER) {
        process.stderr.write(`  small: ${impl}\n`);
        small.push(...run("run-smallworld.mjs", [`--impl=${impl}`], ["--expose-gc"]));
    }

    results.smallWorld = small;
    checkpoint();

    table(
        ["implementation", "ns / mesh request", "bytes / empty index"],
        IMPL_ORDER.map((impl) => {
            const r = small.find((x) => x.impl === impl);

            return [LABELS[impl], fmt(r?.cycleNs, 0), fmt(r?.emptyBytes, 0)];
        })
    );
}

// ---------------------------------------------------------------------------
// Phase: end to end
// ---------------------------------------------------------------------------

if (phases.includes("e2e")) {
    console.log("\n=== end to end: real VoxelWorld, blocky mesher and raycaster ===\n");

    const e2e = [];

    for (const impl of IMPL_ORDER.filter((i) => i !== "map-raw")) {
        // a global sorted array costs O(N) per insert - populating a 131k chunk
        // world with it takes minutes, so it only runs at the small size
        const sizes = impl === "sorted-flat" ? [8192] : [8192, 131072];
        const jobs = sizes.map((n) => ({ layout: "terrain", n }));

        process.stderr.write(`  e2e: ${impl}\n`);
        e2e.push(...run("run-mesher.mjs", [`--impl=${impl}`, `--jobs=${JSON.stringify(jobs)}`], ["--max-old-space-size=10240"]));
        results.e2e = e2e;
        checkpoint();
    }

    results.e2e = e2e;
    checkpoint();

    table(
        ["implementation", "mesh us/chunk @8k", "@131k", "raycast us/ray @8k", "@131k"],
        IMPL_ORDER.filter((i) => i !== "map-raw").map((impl) => {
            const small = e2e.find((r) => r.impl === impl && r.n < 20000);
            const big = e2e.find((r) => r.impl === impl && r.n > 20000);

            return [LABELS[impl], fmt(small?.meshUsPerChunk, 2), fmt(big?.meshUsPerChunk, 2), fmt(small?.rayUsPerRay, 2), fmt(big?.rayUsPerRay, 2)];
        })
    );
}

writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nraw results written to ${outPath}\n`);
