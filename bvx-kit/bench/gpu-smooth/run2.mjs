/**
 * Second pass of the smooth-mesher compute benchmark.
 *
 * Round one established where the time goes. This one answers the questions it
 * raised:
 *
 *   1. exactly how far the GPU kernel is from the CPU reference, and why
 *   2. whether each variant is bit-identical to the shipped kernel
 *   3. whether the shipped GpuSmoothMesher class agrees with this harness
 *   4. what the best surviving combination costs across the batch sizes an
 *      editor actually submits
 *   5. whether the degenerate-gradient normal fallback the CPU runs, and the
 *      GPU does not, is reachable on real terrain
 */
import { VoxelSmoothGeometry, GpuSmoothMesher } from "../../out/index.js";
import { buildWorld } from "./world.mjs";
import { Mesher, autoReps, MAX_INDICES } from "./harness.mjs";

const out = document.getElementById("log");
const lines = [];

function log(s = "") {
    lines.push(s);
    out.textContent = lines.join("\n");
    console.log("[S2] " + s);
}

const f = (n, d = 3) => Number(n).toFixed(d);

/**
 * ULP distance between two f32 values, via their bit patterns.
 */
const ulpBufA = new ArrayBuffer(4);
const ulpF32 = new Float32Array(ulpBufA);
const ulpI32 = new Int32Array(ulpBufA);

function bits(x) {
    ulpF32[0] = x;

    return ulpI32[0];
}

function ulpDistance(a, b) {
    if (a === b) {
        return 0;
    }

    let ia = bits(a);
    let ib = bits(b);

    if ((ia < 0) !== (ib < 0)) {
        return Infinity;
    }

    if (ia < 0) {
        ia = -2147483648 - ia;
    }

    if (ib < 0) {
        ib = -2147483648 - ib;
    }

    return Math.abs(ia - ib);
}

/**
 * Full numeric comparison of one chunk's GPU output against the CPU reference.
 */
function diffChunk(cpu, gpu) {
    const r = {
        vertexCountMatch: cpu.vertexCount === gpu.vertices.length / 3,
        indexCountMatch: cpu.indexCount === gpu.indices.length,
        maxVertexUlp: 0,
        maxVertexAbs: 0,
        maxNormalUlp: 0,
        maxNormalAbs: 0,
        exactVertices: 0,
        totalVertices: cpu.vertices.length,
        triangleSetMatch: true,
        zeroNormalsGpu: 0,
        zeroNormalsCpu: 0
    };

    if (!r.vertexCountMatch || !r.indexCountMatch) {
        return r;
    }

    for (let i = 0; i < cpu.vertices.length; i++) {
        const u = ulpDistance(cpu.vertices[i], gpu.vertices[i]);

        if (u === 0) {
            r.exactVertices++;
        }

        r.maxVertexUlp = Math.max(r.maxVertexUlp, u);
        r.maxVertexAbs = Math.max(r.maxVertexAbs, Math.abs(cpu.vertices[i] - gpu.vertices[i]));
    }

    for (let i = 0; i < cpu.normals.length; i += 3) {
        const cz = cpu.normals[i] === 0 && cpu.normals[i + 1] === 0 && cpu.normals[i + 2] === 0;
        const gz = gpu.normals[i] === 0 && gpu.normals[i + 1] === 0 && gpu.normals[i + 2] === 0;

        if (cz) {
            r.zeroNormalsCpu++;
        }

        if (gz) {
            r.zeroNormalsGpu++;
        }

        for (let k = 0; k < 3; k++) {
            r.maxNormalUlp = Math.max(r.maxNormalUlp, ulpDistance(cpu.normals[i + k], gpu.normals[i + k]));
            r.maxNormalAbs = Math.max(r.maxNormalAbs, Math.abs(cpu.normals[i + k] - gpu.normals[i + k]));
        }
    }

    const set = new Set();

    for (let i = 0; i < cpu.indices.length; i += 3) {
        set.add(`${cpu.indices[i]},${cpu.indices[i + 1]},${cpu.indices[i + 2]}`);
    }

    for (let i = 0; i < gpu.indices.length; i += 3) {
        if (!set.has(`${gpu.indices[i]},${gpu.indices[i + 1]},${gpu.indices[i + 2]}`)) {
            r.triangleSetMatch = false;
            break;
        }
    }

    return r;
}

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

function timeCpu(records, world, smoothing, minMs = 200) {
    const geometry = new VoxelSmoothGeometry();

    const once = () => {
        for (const record of records) {
            geometry.computeGeometry(record.chunk, world, smoothing, false, null, "primary");
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

/**
 * Reads a whole batch's geometry back once.
 */
async function readAll(mesher, counts, count) {
    const list = [];

    for (let i = 0; i < count; i++) {
        list.push(await mesher.readGeometry(i, counts[i * 2], Math.min(counts[i * 2 + 1], MAX_INDICES)));
    }

    return list;
}

const CANDIDATES = [
    { name: "baseline (shipped shape)", opts: {} },
    { name: "pingpong only", opts: { pingpong: true } },
    { name: "tiles=16 only", opts: { tiles: 16 } },
    { name: "tiles=54 only", opts: { tiles: 54 } },
    { name: "tiles=16 + pingpong", opts: { tiles: 16, pingpong: true } },
    { name: "tiles=16 + pingpong + descIndex", opts: { tiles: 16, pingpong: true, descIndex: true } },
    { name: "tiles=54 + pingpong + descIndex", opts: { tiles: 54, pingpong: true, descIndex: true } },
    { name: "tiles=16 + pingpong + branchless", opts: { tiles: 16, pingpong: true, branchless: true } },
    { name: "tiles=16 + pingpong + wgAtomic", opts: { tiles: 16, pingpong: true, wgAtomic: true } }
];

async function main() {
    log("bvx-kit — smooth mesher compute bench, pass 2");
    log("=".repeat(84));

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice();

    device.addEventListener("uncapturederror", (e) => log(`GPU ERROR: ${e.error.message}`));

    log(`adapter: ${adapter.info?.description ?? "?"} / ${adapter.info?.architecture ?? "?"}`);
    log();

    const built = buildWorld(14, 5, 14);
    const CAP = 64;
    const batch = built.surface.slice(0, CAP);

    log(`world 980 chunks, ${built.surface.length} surface; batch = ${batch.length}`);
    log();

    // ---------------------------------------------------------------------
    // 1. numeric agreement with the CPU, per smoothing level
    // ---------------------------------------------------------------------
    log("-".repeat(84));
    log("1. GPU vs CPU numeric agreement (shipped kernel shape)");
    log();
    log("  sm | v-count | i-count | tri-set | exact verts |  max v ULP |    max v abs |  max n ULP | cpu 0-norm | gpu 0-norm");

    for (let smoothing = 0; smoothing <= 3; smoothing++) {
        const cpu = cpuReference(batch, built.world, smoothing, false);
        const mesher = new Mesher(device, CAP, {});

        mesher.stage(batch, built.world, smoothing, false);

        const counts = await mesher.run(batch.length, smoothing);
        const gpu = await readAll(mesher, counts, batch.length);

        let vOk = true;
        let iOk = true;
        let tOk = true;
        let exact = 0;
        let totalV = 0;
        let maxVU = 0;
        let maxVA = 0;
        let maxNU = 0;
        let zc = 0;
        let zg = 0;

        for (let i = 0; i < batch.length; i++) {
            const d = diffChunk(cpu[i], gpu[i]);

            vOk = vOk && d.vertexCountMatch;
            iOk = iOk && d.indexCountMatch;
            tOk = tOk && d.triangleSetMatch;
            exact += d.exactVertices;
            totalV += d.totalVertices;
            maxVU = Math.max(maxVU, d.maxVertexUlp);
            maxVA = Math.max(maxVA, d.maxVertexAbs);
            maxNU = Math.max(maxNU, d.maxNormalUlp);
            zc += d.zeroNormalsCpu;
            zg += d.zeroNormalsGpu;
        }

        log(`  ${smoothing}  |   ${vOk ? "OK " : "BAD"}   |   ${iOk ? "OK " : "BAD"}   |   ${iOk && tOk ? "OK " : "BAD"}   | ` +
            `${String(exact).padStart(6)}/${String(totalV).padStart(6)} | ${String(maxVU).padStart(10)} | ${maxVA.toExponential(3).padStart(12)} | ` +
            `${String(maxNU).padStart(10)} | ${String(zc).padStart(10)} | ${String(zg).padStart(10)}`);

        mesher.destroy();
    }

    log();
    log("  v/i-count and tri-set compare topology; ULP columns compare the numbers.");
    log("  cpu 0-norm / gpu 0-norm count vertices left with a (0,0,0) normal - the CPU");
    log("  resolves those from adjacent triangles, the GPU has no such pass.");

    // ---------------------------------------------------------------------
    // 2. the shipped GpuSmoothMesher class against this harness
    // ---------------------------------------------------------------------
    log();
    log("-".repeat(84));
    log("2. shipped GpuSmoothMesher class vs this harness (same shader, real host code)");

    try {
        const shipped = new GpuSmoothMesher(device, { capacity: CAP });

        const requests = batch.map((r) => ({
            chunk: r.chunk,
            world: built.world,
            occluders: null,
            smoothing: 2,
            flipped: false,
            occlusionMode: "primary"
        }));

        const shippedResults = await shipped.meshBatch(requests);

        const mesher = new Mesher(device, CAP, {});

        mesher.stage(batch, built.world, 2, false);

        const counts = await mesher.run(batch.length, 2);

        let agree = true;

        for (let i = 0; i < batch.length; i++) {
            if (shippedResults[i].vertexCount !== counts[i * 2] || shippedResults[i].indexCount !== Math.min(counts[i * 2 + 1], MAX_INDICES)) {
                agree = false;
                log(`  chunk ${i}: shipped ${shippedResults[i].vertexCount}/${shippedResults[i].indexCount} vs harness ${counts[i * 2]}/${counts[i * 2 + 1]}`);
                break;
            }
        }

        log(`  counts agree on all ${batch.length} chunks: ${agree}`);

        shipped.dispose();
        mesher.destroy();
    }
    catch (e) {
        log(`  shipped class failed: ${e.message}`);
    }

    // ---------------------------------------------------------------------
    // 3. variants must be bit-identical to the shipped kernel
    // ---------------------------------------------------------------------
    log();
    log("-".repeat(84));
    log("3. variant equivalence — every variant against the shipped kernel's own output");

    const reference = new Mesher(device, CAP, {});

    reference.stage(batch, built.world, 2, false);

    const refCounts = await reference.run(batch.length, 2);
    const refGeom = await readAll(reference, refCounts, batch.length);

    reference.destroy();

    const built3 = [];

    for (const candidate of CANDIDATES) {
        const mesher = new Mesher(device, CAP, candidate.opts);

        mesher.stage(batch, built.world, 2, false);

        const counts = await mesher.run(batch.length, 2);
        const geom = await readAll(mesher, counts, batch.length);

        let identical = true;
        let note = "";

        for (let i = 0; i < batch.length && identical; i++) {
            if (counts[i * 2] !== refCounts[i * 2] || counts[i * 2 + 1] !== refCounts[i * 2 + 1]) {
                identical = false;
                note = `chunk ${i} counts ${counts[i * 2]}/${counts[i * 2 + 1]} vs ${refCounts[i * 2]}/${refCounts[i * 2 + 1]}`;
                break;
            }

            for (let k = 0; k < refGeom[i].vertices.length; k++) {
                if (geom[i].vertices[k] !== refGeom[i].vertices[k] || geom[i].normals[k] !== refGeom[i].normals[k]) {
                    identical = false;
                    note = `chunk ${i} vertex/normal ${k}: ${geom[i].vertices[k]} vs ${refGeom[i].vertices[k]}`;
                    break;
                }
            }

            if (identical) {
                const set = new Set();

                for (let k = 0; k < refGeom[i].indices.length; k += 3) {
                    set.add(`${refGeom[i].indices[k]},${refGeom[i].indices[k + 1]},${refGeom[i].indices[k + 2]}`);
                }

                for (let k = 0; k < geom[i].indices.length; k += 3) {
                    if (!set.has(`${geom[i].indices[k]},${geom[i].indices[k + 1]},${geom[i].indices[k + 2]}`)) {
                        identical = false;
                        note = `chunk ${i} triangle set differs`;
                        break;
                    }
                }
            }
        }

        log(`  ${candidate.name.padEnd(34)} ${identical ? "IDENTICAL" : "DIFFERS — " + note}`);

        built3.push({ candidate, mesher });
    }

    // ---------------------------------------------------------------------
    // 4. throughput across the batch sizes an editor submits
    // ---------------------------------------------------------------------
    log();
    log("-".repeat(84));
    log("4. throughput, smoothing=2, us per chunk");

    const SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

    log();
    log("  CPU (VoxelSmoothGeometry, one thread):");

    const cpuRow = [];

    for (const n of SIZES) {
        const ms = timeCpu(batch.slice(0, n), built.world, 2);

        cpuRow.push(ms * 1000 / n);
    }

    log("  " + "cpu".padEnd(34) + cpuRow.map((v) => f(v, 1).padStart(8)).join(""));

    log();
    log("  " + "chunks".padEnd(34) + SIZES.map((v) => String(v).padStart(8)).join(""));

    const rows = [];

    for (const { candidate, mesher } of built3) {
        const row = [];

        for (const n of SIZES) {
            mesher.stage(batch.slice(0, n), built.world, 2, false);

            const { per } = await autoReps((reps) => mesher.time(n, 2, reps));

            row.push(per * 1000 / n);
        }

        log("  " + candidate.name.padEnd(34) + row.map((v) => f(v, 1).padStart(8)).join(""));

        rows.push({ name: candidate.name, row });
    }

    log();
    log("  speedup vs CPU (x):");
    log("  " + "chunks".padEnd(34) + SIZES.map((v) => String(v).padStart(8)).join(""));

    for (const r of rows) {
        log("  " + r.name.padEnd(34) + r.row.map((v, i) => f(cpuRow[i] / v, 2).padStart(8)).join(""));
    }

    // ---------------------------------------------------------------------
    // 5. per-pass at batch 1 and batch 64 for the best candidate
    // ---------------------------------------------------------------------
    log();
    log("-".repeat(84));
    log("5. per-pass cost, shipped shape vs tiles=16+pingpong");

    for (const target of ["baseline (shipped shape)", "tiles=16 + pingpong"]) {
        const entry = built3.find((b) => b.candidate.name === target);

        for (const n of [1, 64]) {
            entry.mesher.stage(batch.slice(0, n), built.world, 2, false);
            await entry.mesher.run(n, 2);

            const seen = new Set();
            const parts = [];

            for (const name of entry.mesher.passList(2)) {
                if (seen.has(name)) {
                    continue;
                }

                seen.add(name);

                const { per } = await autoReps((reps) => entry.mesher.timePass(name, n, reps));
                const occurrences = entry.mesher.passList(2).filter((x) => x === name).length;

                parts.push(`${name}=${f(per * 1000, 1)}us x${occurrences}`);
            }

            log(`  ${target} @ ${n}: ${parts.join("  ")}`);
        }
    }

    for (const { mesher } of built3) {
        mesher.destroy();
    }

    log();
    log("DONE");
}

main().catch((e) => log("FATAL " + e.stack));
