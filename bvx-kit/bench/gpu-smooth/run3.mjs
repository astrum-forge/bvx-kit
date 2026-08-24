/**
 * Third pass: the two structural changes that pass two pointed at.
 *
 *   fuseBlur   - two clamped 3-tap smoothing passes composed into one clamped
 *                5-tap, halving the number of blur dispatches and the field
 *                traffic they cause. The blur is 63% of the pipeline, so this is
 *                the only remaining large lever.
 *   activeBox  - sample_field writes only the active box instead of all 24^3,
 *                since nothing downstream reads outside it.
 *
 * Everything is checked bit-for-bit against the shipped kernel's own output
 * before it is timed.
 */
import { buildWorld } from "./world.mjs";
import { Mesher, autoReps, MAX_INDICES } from "./harness.mjs";

const out = document.getElementById("log");
const lines = [];

function log(s = "") {
    lines.push(s);
    out.textContent = lines.join("\n");
    console.log("[S3] " + s);
}

const f = (n, d = 2) => Number(n).toFixed(d);

async function readAll(mesher, counts, count) {
    const list = [];

    for (let i = 0; i < count; i++) {
        list.push(await mesher.readGeometry(i, counts[i * 2], Math.min(counts[i * 2 + 1], MAX_INDICES)));
    }

    return list;
}

function identical(a, b, refCounts, counts, count) {
    for (let i = 0; i < count; i++) {
        if (counts[i * 2] !== refCounts[i * 2] || counts[i * 2 + 1] !== refCounts[i * 2 + 1]) {
            return `chunk ${i} counts ${counts[i * 2]}/${counts[i * 2 + 1]} vs ${refCounts[i * 2]}/${refCounts[i * 2 + 1]}`;
        }

        for (let k = 0; k < b[i].vertices.length; k++) {
            if (a[i].vertices[k] !== b[i].vertices[k]) {
                return `chunk ${i} vertex ${k}: ${b[i].vertices[k]} vs ${a[i].vertices[k]}`;
            }

            if (a[i].normals[k] !== b[i].normals[k]) {
                return `chunk ${i} normal ${k}: ${b[i].normals[k]} vs ${a[i].normals[k]}`;
            }
        }

        const set = new Set();

        for (let k = 0; k < a[i].indices.length; k += 3) {
            set.add(`${a[i].indices[k]},${a[i].indices[k + 1]},${a[i].indices[k + 2]}`);
        }

        for (let k = 0; k < b[i].indices.length; k += 3) {
            if (!set.has(`${b[i].indices[k]},${b[i].indices[k + 1]},${b[i].indices[k + 2]}`)) {
                return `chunk ${i} triangle set differs`;
            }
        }
    }

    return null;
}

const CANDIDATES = [
    { name: "shipped", opts: {} },
    { name: "tiles16+pp", opts: { tiles: 16, pingpong: true } },
    { name: "tiles16+pp+fuse", opts: { tiles: 16, pingpong: true, fuseBlur: true } },
    { name: "tiles16+pp+fuse+box", opts: { tiles: 16, pingpong: true, fuseBlur: true, activeBox: true } },
    { name: "tiles32+pp+fuse+box", opts: { tiles: 32, pingpong: true, fuseBlur: true, activeBox: true } },
    { name: "tiles8+pp+fuse+box", opts: { tiles: 8, pingpong: true, fuseBlur: true, activeBox: true } }
];

const SIZES = [1, 2, 4, 8, 16, 32, 64];

async function main() {
    log("bvx-kit — smooth mesher compute bench, pass 3 (fused blur)");
    log("=".repeat(96));

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice();

    device.addEventListener("uncapturederror", (e) => log(`GPU ERROR: ${e.error.message}`));

    const built = buildWorld(14, 5, 14);
    const CAP = 64;
    const batch = built.surface.slice(0, CAP);

    log(`world 980 chunks, ${built.surface.length} surface; batch = ${batch.length}`);

    for (const smoothing of [1, 2, 3]) {
        log();
        log("-".repeat(96));
        log(`smoothing = ${smoothing}`);

        const reference = new Mesher(device, CAP, {});

        reference.stage(batch, built.world, smoothing, false);

        const refCounts = await reference.run(batch.length, smoothing);
        const refGeom = await readAll(reference, refCounts, batch.length);

        reference.destroy();

        const meshers = [];

        log();
        log("  equivalence vs the shipped kernel, and pass list:");

        for (const c of CANDIDATES) {
            const mesher = new Mesher(device, CAP, c.opts);

            mesher.stage(batch, built.world, smoothing, false);

            const counts = await mesher.run(batch.length, smoothing);
            const geom = await readAll(mesher, counts, batch.length);
            const diff = identical(refGeom, geom, refCounts, counts, batch.length);

            const list = mesher.passList(smoothing);

            log(`    ${c.name.padEnd(22)} ${diff === null ? "IDENTICAL" : "DIFFERS — " + diff}`);
            log(`    ${"".padEnd(22)} ${list.length} dispatches: ${list.join(" ")}`);

            meshers.push({ c, mesher });
        }

        log();
        log("  us per chunk:");
        log("    " + "variant".padEnd(22) + SIZES.map((n) => String(n).padStart(9)).join(""));

        const rows = [];

        for (const { c, mesher } of meshers) {
            const row = [];

            for (const n of SIZES) {
                mesher.stage(batch.slice(0, n), built.world, smoothing, false);

                const { per } = await autoReps((reps) => mesher.time(n, smoothing, reps));

                row.push(per * 1000 / n);
            }

            log("    " + c.name.padEnd(22) + row.map((v) => f(v).padStart(9)).join(""));

            rows.push({ name: c.name, row });
        }

        const base = rows[0].row;

        log();
        log("  speedup vs the shipped kernel:");
        log("    " + "variant".padEnd(22) + SIZES.map((n) => String(n).padStart(9)).join(""));

        for (const r of rows.slice(1)) {
            log("    " + r.name.padEnd(22) + r.row.map((v, i) => f(base[i] / v).padStart(9)).join(""));
        }

        // per-pass for the best candidate
        const best = meshers.find((m) => m.c.name === "tiles16+pp+fuse+box");

        best.mesher.stage(batch, built.world, smoothing, false);
        await best.mesher.run(batch.length, smoothing);

        const seen = new Set();
        const parts = [];

        for (const name of best.mesher.passList(smoothing)) {
            if (seen.has(name)) {
                continue;
            }

            seen.add(name);

            const { per } = await autoReps((reps) => best.mesher.timePass(name, batch.length, reps));

            parts.push(`${name}=${f(per * 1000, 1)}us`);
        }

        log();
        log(`  per-pass @64, tiles16+pp+fuse+box: ${parts.join("  ")}`);

        for (const { mesher } of meshers) {
            mesher.destroy();
        }
    }

    log();
    log("DONE");
}

main().catch((e) => log("FATAL " + e.stack));
