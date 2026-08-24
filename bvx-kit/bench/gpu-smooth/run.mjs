/**
 * Driver for the smooth-mesher compute benchmark. Prints a plain-text report
 * into the page so it can be scraped, and mirrors every line to the console.
 */
import { VoxelSmoothGeometry } from "../../out/index.js";
import { buildWorld } from "./world.mjs";
import { Mesher, autoReps } from "./harness.mjs";
import { VARIANTS } from "./variants.mjs";

const out = document.getElementById("log");
const lines = [];

function log(s = "") {
    lines.push(s);
    out.textContent = lines.join("\n");
    console.log("[SMOOTH] " + s);
}

function fixed(n, d = 3) {
    return Number(n).toFixed(d);
}

/**
 * Compares a GPU result against the CPU reference for one chunk. Vertices and
 * normals must match in order and bit pattern; triangles must match as a set,
 * because the GPU appends them atomically and its order is not the CPU's.
 */
function compare(cpu, gpu) {
    if (cpu.vertexCount !== gpu.vertices.length / 3) {
        return `vertexCount ${cpu.vertexCount} vs ${gpu.vertices.length / 3}`;
    }

    if (cpu.indexCount !== gpu.indices.length) {
        return `indexCount ${cpu.indexCount} vs ${gpu.indices.length}`;
    }

    for (let i = 0; i < cpu.vertices.length; i++) {
        if (cpu.vertices[i] !== gpu.vertices[i]) {
            return `vertex[${i}] ${cpu.vertices[i]} vs ${gpu.vertices[i]}`;
        }
    }

    for (let i = 0; i < cpu.normals.length; i++) {
        if (Math.abs(cpu.normals[i] - gpu.normals[i]) > 1e-6) {
            return `normal[${i}] ${cpu.normals[i]} vs ${gpu.normals[i]}`;
        }
    }

    const set = new Set();

    for (let i = 0; i < cpu.indices.length; i += 3) {
        set.add(`${cpu.indices[i]},${cpu.indices[i + 1]},${cpu.indices[i + 2]}`);
    }

    for (let i = 0; i < gpu.indices.length; i += 3) {
        const t = `${gpu.indices[i]},${gpu.indices[i + 1]},${gpu.indices[i + 2]}`;

        if (!set.has(t)) {
            return `triangle ${t} not in CPU output`;
        }
    }

    return null;
}

/**
 * CPU reference for a set of chunks, timed.
 */
function cpuReference(records, world, smoothing, flipped) {
    const geometry = new VoxelSmoothGeometry();
    const results = [];

    for (const record of records) {
        geometry.computeGeometry(record.chunk, world, smoothing, flipped, null, "primary");

        results.push({
            vertexCount: geometry.vertexCount,
            indexCount: geometry.indexCount,
            vertices: geometry.vertices.slice(),
            normals: geometry.normals.slice(),
            indices: geometry.indices.slice()
        });
    }

    return results;
}

function timeCpu(records, world, smoothing, flipped, minMs = 250) {
    const geometry = new VoxelSmoothGeometry();

    const once = () => {
        for (const record of records) {
            geometry.computeGeometry(record.chunk, world, smoothing, flipped, null, "primary");
        }
    };

    once();
    once();

    let reps = 1;

    for (;;) {
        const start = performance.now();

        for (let i = 0; i < reps; i++) {
            once();
        }

        const elapsed = performance.now() - start;

        if (elapsed >= minMs) {
            return elapsed / reps;
        }

        reps = Math.max(reps * 2, Math.ceil(reps * (minMs / Math.max(elapsed, 0.05))));
    }
}

async function main() {
    log("bvx-kit — smooth mesher compute benchmark");
    log("=".repeat(78));
    log(`crossOriginIsolated=${self.crossOriginIsolated}  hardwareConcurrency=${navigator.hardwareConcurrency}`);

    if (!navigator.gpu) {
        log("FATAL: no navigator.gpu");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });

    if (!adapter) {
        log("FATAL: no adapter");
        return;
    }

    const info = adapter.info ?? {};

    log(`adapter: vendor=${info.vendor} architecture=${info.architecture} device=${info.device} description=${info.description}`);
    log(`features: ${[...adapter.features].sort().join(", ")}`);

    const l = adapter.limits;

    log(`limits: maxComputeInvocationsPerWorkgroup=${l.maxComputeInvocationsPerWorkgroup} ` +
        `maxComputeWorkgroupStorageSize=${l.maxComputeWorkgroupStorageSize} ` +
        `maxStorageBuffersPerShaderStage=${l.maxStorageBuffersPerShaderStage} ` +
        `maxComputeWorkgroupsPerDimension=${l.maxComputeWorkgroupsPerDimension} ` +
        `maxBufferSize=${l.maxBufferSize}`);

    const device = await adapter.requestDevice({ label: "bench" });

    device.addEventListener("uncapturederror", (e) => log(`GPU ERROR: ${e.error.message}`));

    log();
    log("building world 14x5x14 = 980 chunks …");

    const built = buildWorld(14, 5, 14);

    log(`chunks=${built.all.length} surface=${built.surface.length}`);

    const CAP = 64;
    const SMOOTHING = 2;
    const FLIPPED = false;

    const batch = built.surface.slice(0, CAP);

    log(`benchmark batch: ${batch.length} surface chunks, smoothing=${SMOOTHING}`);
    log();

    // ---------------------------------------------------------------- CPU
    log("-".repeat(78));
    log("CPU reference (VoxelSmoothGeometry, main thread, visible tab)");

    const cpu = cpuReference(batch, built.world, SMOOTHING, FLIPPED);

    let totalV = 0;
    let totalI = 0;

    for (const r of cpu) {
        totalV += r.vertexCount;
        totalI += r.indexCount;
    }

    log(`  ${totalV} vertices, ${totalI} indices across ${batch.length} chunks ` +
        `(${(totalV / batch.length).toFixed(0)} v/chunk)`);

    for (const n of [1, 8, 64]) {
        const ms = timeCpu(batch.slice(0, n), built.world, SMOOTHING, FLIPPED);

        log(`  batch ${String(n).padStart(3)}: ${fixed(ms)} ms  =  ${fixed(ms * 1000 / n, 1)} us/chunk`);
    }

    // ---------------------------------------------------------------- GPU
    const results = {};

    for (const variant of VARIANTS) {
        log();
        log("-".repeat(78));
        log(`VARIANT: ${variant.name}   ${JSON.stringify(variant.opts)}`);

        let mesher;

        try {
            mesher = new Mesher(device, CAP, variant.opts);
        }
        catch (e) {
            log(`  build failed: ${e.message}`);
            continue;
        }

        mesher.stage(batch, built.world, SMOOTHING, FLIPPED);

        // correctness first - a fast wrong kernel is not a result
        const counts = await mesher.run(batch.length, SMOOTHING);

        let mismatch = null;

        for (let i = 0; i < batch.length && mismatch === null; i++) {
            const vc = counts[i * 2];
            const ic = Math.min(counts[i * 2 + 1], 78336);

            const geometry = await mesher.readGeometry(i, vc, ic);
            const diff = compare(cpu[i], geometry);

            if (diff !== null) {
                mismatch = `chunk ${i}: ${diff}`;
            }
        }

        log(`  correctness: ${mismatch === null ? "EXACT MATCH vs CPU on all " + batch.length + " chunks" : "MISMATCH " + mismatch}`);

        // batch scaling
        const scaling = [];

        for (const n of [1, 2, 4, 8, 16, 32, 64]) {
            mesher.stage(batch.slice(0, n), built.world, SMOOTHING, FLIPPED);

            const { per } = await autoReps((reps) => mesher.time(n, SMOOTHING, reps));

            scaling.push({ n, ms: per, us: per * 1000 / n });
        }

        log("  batch scaling (full pipeline):");
        log("    chunks |     ms |  us/chunk");

        for (const s of scaling) {
            log(`    ${String(s.n).padStart(6)} | ${fixed(s.ms).padStart(6)} | ${fixed(s.us, 2).padStart(9)}`);
        }

        // per-pass breakdown at full batch
        mesher.stage(batch, built.world, SMOOTHING, FLIPPED);
        await mesher.run(batch.length, SMOOTHING);

        const perPass = [];
        const seen = new Set();

        for (const name of mesher.passList(SMOOTHING)) {
            if (seen.has(name)) {
                continue;
            }

            seen.add(name);

            const { per } = await autoReps((reps) => mesher.timePass(name, batch.length, reps));

            perPass.push({ name, ms: per });
        }

        const passTotal = perPass.reduce((a, p) => a + p.ms, 0);

        log(`  per-pass at ${batch.length} chunks (isolated dispatches, ms per dispatch):`);

        for (const p of perPass) {
            const occurrences = mesher.passList(SMOOTHING).filter((x) => x === p.name).length;

            log(`    ${p.name.padEnd(14)} ${fixed(p.ms).padStart(7)}  x${occurrences}  = ${fixed(p.ms * occurrences).padStart(7)}`);
        }

        log(`    ${"sum of unique".padEnd(14)} ${fixed(passTotal).padStart(7)}`);

        results[variant.name] = { scaling, perPass, mismatch };

        mesher.destroy();

        await new Promise((r) => setTimeout(r, 30));
    }

    log();
    log("=".repeat(78));
    log("SUMMARY — us/chunk by batch size");
    log("variant".padEnd(26) + ["1", "2", "4", "8", "16", "32", "64"].map((h) => h.padStart(9)).join(""));

    for (const [name, r] of Object.entries(results)) {
        log(name.padEnd(26) + r.scaling.map((s) => fixed(s.us, 2).padStart(9)).join(""));
    }

    log();
    log("DONE");
}

main().catch((e) => log("FATAL " + e.stack));
