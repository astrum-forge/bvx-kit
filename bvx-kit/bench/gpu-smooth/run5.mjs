/**
 * Where meshBatch's wall clock actually goes.
 *
 * run4 timed the shipped class end to end and got numbers far above the kernel cost
 * pass 3 measured. This splits the call into its three parts so the class docs can say
 * something true rather than quoting a kernel number for an API that also stages,
 * submits and waits for a readback.
 */
import { GpuSmoothMesher, VoxelSmoothGeometry } from "../../out/index.js";
import { buildWorld } from "./world.mjs";

const out = document.getElementById("log");
const lines = [];

function log(s = "") {
    lines.push(s);
    out.textContent = lines.join("\n");
    console.log("[S5] " + s);
}

const f = (n, d = 2) => Number(n).toFixed(d);

async function timeAsync(fn, minMs = 150) {
    await fn();
    await fn();

    let reps = 2;

    for (;;) {
        const start = performance.now();

        for (let r = 0; r < reps; r++) {
            await fn();
        }

        const elapsed = performance.now() - start;

        if (elapsed >= minMs || reps >= 512) {
            return elapsed / reps;
        }

        reps = Math.min(512, Math.max(reps * 2, Math.ceil(reps * (minMs * 1.3 / Math.max(elapsed, 0.1)))));
    }
}

function timeSync(fn, minMs = 150) {
    fn();
    fn();

    let reps = 1;

    for (;;) {
        const start = performance.now();

        for (let r = 0; r < reps; r++) {
            fn();
        }

        const elapsed = performance.now() - start;

        if (elapsed >= minMs) {
            return elapsed / reps;
        }

        reps = Math.max(reps * 2, Math.ceil(reps * (minMs * 1.3 / Math.max(elapsed, 0.05))));
    }
}

async function main() {
    log("bvx-kit — where meshBatch's time goes");
    log("=".repeat(88));

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice();

    device.addEventListener("uncapturederror", (e) => log(`GPU ERROR: ${e.error.message}`));

    const built = buildWorld(14, 5, 14);
    const CAP = 64;
    const batch = built.surface.slice(0, CAP);
    const SMOOTHING = 2;

    log(`document.hidden=${document.hidden}  visibilityState=${document.visibilityState}`);
    log(`world ${built.all.length} chunks, ${built.surface.length} surface`);
    log();

    // CPU reference in this same tab, so the comparison shares whatever QoS the tab has
    const geometry = new VoxelSmoothGeometry();

    const cpuPerChunk = timeSync(() => {
        for (const record of batch) {
            geometry.computeGeometry(record.chunk, built.world, SMOOTHING, false, null, "primary");
        }
    }) * 1000 / batch.length;

    log(`CPU reference in this tab: ${f(cpuPerChunk, 1)} us/chunk`);
    log("  (Node measured 240.7; a backgrounded tab runs on the efficiency cores)");
    log();

    const mesher = new GpuSmoothMesher(device, { capacity: CAP });

    log("us per chunk, smoothing 2:");
    log("  chunks |  meshBatch |  stage+upload |  submit only |  readback |  gpu (implied)");

    for (const n of [1, 2, 4, 8, 16, 32, 64]) {
        const requests = batch.slice(0, n).map((record) => ({
            chunk: record.chunk,
            world: built.world,
            occluders: null,
            smoothing: SMOOTHING,
            flipped: false,
            occlusionMode: "primary"
        }));

        // 1. the whole call
        const whole = await timeAsync(() => mesher.meshBatch(requests));

        // 2. staging and upload alone - reach into the private members, this is a bench
        const stage = timeSync(() => {
            mesher._stage(requests, n);

            mesher._paramStage[0] = n;
            mesher._paramStage[1] = 1 + SMOOTHING;
            mesher._paramStage[2] = 16 + (2 * (1 + SMOOTHING));
            mesher._paramStage[3] = 0;

            device.queue.writeBuffer(mesher._occupancy, 0, mesher._occupancyStage, 0, n * 27 * 128);
            device.queue.writeBuffer(mesher._desc, 0, mesher._descStage);
            device.queue.writeBuffer(mesher._params, 0, mesher._paramStage);
        });

        // 3. submit the compute work and wait for it, with no readback
        const submit = await timeAsync(async () => {
            const encoder = device.createCommandEncoder();

            encoder.clearBuffer(mesher._counts, 0, n * 4 * 4);

            const pass = encoder.beginComputePass();

            pass.setBindGroup(0, mesher._bindGroup);

            for (const entryPoint of GpuSmoothMesher.passList(SMOOTHING)) {
                pass.setPipeline(mesher._pipeline(entryPoint));
                pass.dispatchWorkgroups(entryPoint === "scan_cells" ? 1 : mesher.tiles, n);
            }

            pass.end();

            device.queue.submit([encoder.finish()]);

            await device.queue.onSubmittedWorkDone();
        });

        // 4. the counts readback alone
        const readback = await timeAsync(async () => {
            const encoder = device.createCommandEncoder();

            encoder.copyBufferToBuffer(mesher._counts, 0, mesher._countsRead, 0, n * 4 * 4);
            device.queue.submit([encoder.finish()]);

            await mesher._countsRead.mapAsync(GPUMapMode.READ, 0, n * 4 * 4);
            mesher._countsRead.unmap();
        });

        const per = (ms) => f(ms * 1000 / n, 1).padStart(10);

        log(`  ${String(n).padStart(6)} | ${per(whole)} | ${per(stage).padStart(13)} | ${per(submit).padStart(12)} | ${per(readback).padStart(9)} | ` +
            `${f(Math.max(0, whole - stage - readback) * 1000 / n, 1).padStart(14)}`);
    }

    log();
    log("totals per call, ms (not per chunk), at 64 chunks:");

    const requests64 = batch.map((record) => ({
        chunk: record.chunk, world: built.world, occluders: null,
        smoothing: SMOOTHING, flipped: false, occlusionMode: "primary"
    }));

    const whole64 = await timeAsync(() => mesher.meshBatch(requests64));

    log(`  meshBatch: ${f(whole64)} ms for 64 chunks`);

    mesher.dispose();

    log();
    log("DONE");
}

main().catch((e) => log("FATAL " + e.stack));
