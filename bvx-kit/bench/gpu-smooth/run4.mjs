/**
 * Verification and timing of the shipped GpuSmoothMesher after the rewrite.
 *
 * Passes 1-3 measured kernel variants through a bench harness. This one drives the
 * class the kit actually exports, so what is verified is what ships:
 *
 *   1. topology against the CPU reference at every smoothing level
 *   2. numeric agreement, reported rather than asserted, since the GPU is f32 throughout
 *   3. the degenerate-normal count the shader now reports
 *   4. throughput against the CPU across the batch sizes an application submits
 *   5. that a deliberately degenerate cell is counted rather than silently flat-shaded
 */
import { GpuSmoothMesher, MortonKey, VoxelChunk0, VoxelIndex, VoxelSmoothGeometry, VoxelWorld } from "../../out/index.js";
import { buildWorld } from "./world.mjs";

const out = document.getElementById("log");
const lines = [];

function log(s = "") {
    lines.push(s);
    out.textContent = lines.join("\n");
    console.log("[S4] " + s);
}

const f = (n, d = 2) => Number(n).toFixed(d);

const ulpBuf = new ArrayBuffer(4);
const ulpF32 = new Float32Array(ulpBuf);
const ulpI32 = new Int32Array(ulpBuf);

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

async function readSlice(device, buffer, byteOffset, byteLength, Ctor) {
    if (byteLength === 0) {
        return new Ctor(0);
    }

    const read = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();

    encoder.copyBufferToBuffer(buffer, byteOffset, read, 0, byteLength);
    device.queue.submit([encoder.finish()]);

    await read.mapAsync(GPUMapMode.READ);

    const copy = new Ctor(read.getMappedRange().slice(0));

    read.unmap();
    read.destroy();

    return copy;
}

function cpuReference(records, world, smoothing) {
    const geometry = new VoxelSmoothGeometry();
    const results = [];

    for (const record of records) {
        geometry.computeGeometry(record.chunk, world, smoothing, false, null, "primary");

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

async function main() {
    log("bvx-kit — shipped GpuSmoothMesher, post-rewrite verification");
    log("=".repeat(92));

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice();

    let errors = 0;

    device.addEventListener("uncapturederror", (e) => {
        errors++;
        log(`GPU ERROR: ${e.error.message}`);
    });

    log(`adapter: ${adapter.info?.description ?? "?"} / ${adapter.info?.architecture ?? "?"}`);
    log();

    const built = buildWorld(14, 5, 14);
    const CAP = 64;
    const batch = built.surface.slice(0, CAP);

    log(`world ${built.all.length} chunks, ${built.surface.length} surface; batch = ${batch.length}`);
    log();

    const mesher = new GpuSmoothMesher(device, { capacity: CAP });

    log(`mesher: capacity=${mesher.capacity} tiles=${mesher.tiles}`);
    log();

    // ---------------------------------------------------------------- 1 + 2 + 3
    log("-".repeat(92));
    log("1. topology and numerics against the CPU reference");
    log();
    log("  sm | dispatches | v-count | i-count | tri-set | exact floats  |    max v abs |  max n ULP | degenerate");

    for (let smoothing = 0; smoothing <= 3; smoothing++) {
        const cpu = cpuReference(batch, built.world, smoothing);

        const requests = batch.map((record) => ({
            chunk: record.chunk,
            world: built.world,
            occluders: null,
            smoothing: smoothing,
            flipped: false,
            occlusionMode: "primary"
        }));

        const results = await mesher.meshBatch(requests);

        let vOk = true;
        let iOk = true;
        let tOk = true;
        let exact = 0;
        let total = 0;
        let maxAbs = 0;
        let maxNormalUlp = 0;
        let degenerate = 0;

        for (let i = 0; i < batch.length; i++) {
            const result = results[i];
            const reference = cpu[i];

            degenerate += result.degenerateNormals;

            if (result.vertexCount !== reference.vertexCount) {
                vOk = false;
                continue;
            }

            if (result.indexCount !== reference.indexCount) {
                iOk = false;
                continue;
            }

            const handle = result.handle;

            const vertices = await readSlice(device, handle.positions, handle.vertexByteOffset, result.vertexCount * 3 * 4, Float32Array);
            const normals = await readSlice(device, handle.normals, handle.normalByteOffset, result.vertexCount * 3 * 4, Float32Array);
            const indices = await readSlice(device, handle.indices, handle.indexByteOffset, result.indexCount * 4, Uint32Array);

            for (let k = 0; k < reference.vertices.length; k++) {
                total++;

                if (vertices[k] === reference.vertices[k]) {
                    exact++;
                }

                maxAbs = Math.max(maxAbs, Math.abs(vertices[k] - reference.vertices[k]));
            }

            for (let k = 0; k < reference.normals.length; k++) {
                maxNormalUlp = Math.max(maxNormalUlp, ulpDistance(normals[k], reference.normals[k]));
            }

            const set = new Set();

            for (let k = 0; k < reference.indices.length; k += 3) {
                set.add(`${reference.indices[k]},${reference.indices[k + 1]},${reference.indices[k + 2]}`);
            }

            for (let k = 0; k < indices.length; k += 3) {
                if (!set.has(`${indices[k]},${indices[k + 1]},${indices[k + 2]}`)) {
                    tOk = false;
                    break;
                }
            }
        }

        const dispatches = GpuSmoothMesher.passList(smoothing).length;

        log(`  ${smoothing}  |     ${String(dispatches).padStart(2)}     |   ${vOk ? "OK " : "BAD"}   |   ${iOk ? "OK " : "BAD"}   |   ${tOk ? "OK " : "BAD"}   | ` +
            `${String(exact).padStart(6)}/${String(total).padStart(6)} | ${maxAbs.toExponential(3).padStart(12)} | ${String(maxNormalUlp).padStart(10)} | ${String(degenerate).padStart(10)}`);
    }

    log();
    log(`  pass lists:`);

    for (let smoothing = 0; smoothing <= 3; smoothing++) {
        log(`    smoothing ${smoothing}: ${GpuSmoothMesher.passList(smoothing).join(" ")}`);
    }

    // ---------------------------------------------------------------- 4
    log();
    log("-".repeat(92));
    log("4. throughput, us per chunk, geometry left on the device");

    const SIZES = [1, 2, 4, 8, 16, 32, 64];

    for (const smoothing of [0, 1, 2, 3]) {
        const row = [];

        for (const n of SIZES) {
            const requests = batch.slice(0, n).map((record) => ({
                chunk: record.chunk,
                world: built.world,
                occluders: null,
                smoothing: smoothing,
                flipped: false,
                occlusionMode: "primary"
            }));

            // warm up, then time enough submissions to be out of the noise
            await mesher.meshBatch(requests);

            let reps = 2;

            for (;;) {
                const start = performance.now();

                for (let r = 0; r < reps; r++) {
                    await mesher.meshBatch(requests);
                }

                const elapsed = performance.now() - start;

                if (elapsed >= 120 || reps >= 512) {
                    row.push(elapsed / reps * 1000 / n);
                    break;
                }

                reps = Math.min(512, Math.max(reps * 2, Math.ceil(reps * (150 / Math.max(elapsed, 0.1)))));
            }
        }

        log(`  smoothing ${smoothing}: ` + row.map((v, i) => `${SIZES[i]}=${f(v, 1)}`).join("  "));
    }

    log();
    log("  note: these include the counts readback and the mapAsync wait, because");
    log("  meshBatch awaits them. The kernel itself is faster than these numbers.");

    // ---------------------------------------------------------------- 5
    log();
    log("-".repeat(92));
    log("5. a degenerate-gradient cell is counted, not silently flat-shaded");

    // two diagonally opposite BitVoxels in an otherwise empty chunk: the eight corner
    // samples of the dual cell between them sum to a zero gradient on every axis
    const world = new VoxelWorld();
    const chunk = new VoxelChunk0(MortonKey.from(2, 2, 2));

    chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 0, 0));
    chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));
    world.insert(chunk);

    const [degenerateResult] = await mesher.meshBatch([{
        chunk: chunk,
        world: world,
        occluders: null,
        smoothing: 0,
        flipped: false,
        occlusionMode: "primary"
    }]);

    const reference = new VoxelSmoothGeometry();

    reference.computeGeometry(chunk, world, 0, false, null, "primary");

    let cpuZero = 0;

    for (let i = 0; i < reference.normals.length; i += 3) {
        if (reference.normals[i] === 0 && reference.normals[i + 1] === 0 && reference.normals[i + 2] === 0) {
            cpuZero++;
        }
    }

    const gpuNormals = await readSlice(device, degenerateResult.handle.normals, degenerateResult.handle.normalByteOffset, degenerateResult.vertexCount * 3 * 4, Float32Array);

    let gpuZero = 0;

    for (let i = 0; i < gpuNormals.length; i += 3) {
        if (gpuNormals[i] === 0 && gpuNormals[i + 1] === 0 && gpuNormals[i + 2] === 0) {
            gpuZero++;
        }
    }

    log(`  vertices: cpu ${reference.vertexCount}  gpu ${degenerateResult.vertexCount}`);
    log(`  zero normals after meshing: cpu ${cpuZero}  gpu ${gpuZero}`);
    log(`  degenerateNormals reported by the mesher: ${degenerateResult.degenerateNormals}`);
    log(`  -> ${degenerateResult.degenerateNormals > 0 ? "the case is reachable and is reported" : "this shape did not produce one"}`);

    mesher.dispose();

    log();
    log(`uncaptured GPU errors: ${errors}`);
    log("DONE");
}

main().catch((e) => log("FATAL " + e.stack));
