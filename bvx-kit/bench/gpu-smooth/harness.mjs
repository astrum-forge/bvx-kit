/**
 * Host side of the smooth-mesher compute benchmark.
 *
 * One `Mesher` owns every buffer; a variant only swaps the shader module and the
 * dispatch shape, so measurements differ by the kernel and nothing else.
 */
import { BVXLayer, MortonKey } from "../../out/index.js";
import { makeWgsl } from "./variants.mjs";

export const FIELD_SIZE = 24 * 24 * 24;
export const MAX_CELLS = 17 * 17 * 17;
export const MAX_INDICES = 3 * 17 * 16 * 16 * 6;
export const SCRATCH_STRIDE = Math.max(FIELD_SIZE, MAX_CELLS * 6);
export const DESC_STRIDE = 32;
export const WORDS = BVXLayer.BYTE_LENGTH / 4;

const DATA_PASSES = ["sample_field", "blur_x", "blur_y", "blur_z", "copy_back", "mark_cells", "emit_quads"];
const PINGPONG_PASSES = ["blur_x_r", "blur_y_r", "blur_z_r"];
const FUSED_PASSES = ["blur2_x", "blur2_y", "blur2_z"];
const FUSED_PINGPONG = ["blur2_x_r", "blur2_y_r", "blur2_z_r"];

export class Mesher {
    constructor(device, capacity, opts = {}) {
        this.device = device;
        this.capacity = capacity;
        this.tiles = opts.tiles ?? 1;
        this.pingpong = opts.pingpong ?? false;
        this.fuseBlur = opts.fuseBlur ?? false;
        this.activeBox = opts.activeBox ?? false;

        const code = makeWgsl(opts);

        this.module = device.createShaderModule({ code, label: "bench-smooth" });

        const entries = [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
        ];

        for (let b = 3; b <= 9; b++) {
            entries.push({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
        }

        this.layout = device.createBindGroupLayout({ entries });

        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });

        this.pipelines = new Map();

        let names = DATA_PASSES.concat(["scan_cells"], this.pingpong ? PINGPONG_PASSES : []);

        if (this.fuseBlur) {
            names = names.concat(FUSED_PASSES, this.pingpong ? FUSED_PINGPONG : []);
        }

        if (this.activeBox) {
            names = names.concat(["sample_field_active"]);
        }

        for (const entryPoint of names) {
            this.pipelines.set(entryPoint, device.createComputePipeline({
                layout: pipelineLayout,
                compute: { module: this.module, entryPoint },
                label: `bench-${entryPoint}`
            }));
        }

        const storage = GPUBufferUsage.STORAGE;
        const copyDst = GPUBufferUsage.COPY_DST;
        const copySrc = GPUBufferUsage.COPY_SRC;

        const occupancyWords = capacity * 27 * WORDS;

        this.occupancyStage = new Uint32Array(occupancyWords);
        this.descStage = new Int32Array(64 * DESC_STRIDE);
        this.paramStage = new Uint32Array(4);

        this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | copyDst });
        this.occupancy = device.createBuffer({ size: occupancyWords * 4, usage: storage | copyDst });
        this.desc = device.createBuffer({ size: this.descStage.byteLength, usage: GPUBufferUsage.UNIFORM | copyDst });
        this.field = device.createBuffer({ size: capacity * FIELD_SIZE * 4, usage: storage });
        this.scratch = device.createBuffer({ size: capacity * SCRATCH_STRIDE * 4, usage: storage });
        this.cellSlot = device.createBuffer({ size: capacity * MAX_CELLS * 4, usage: storage });
        this.vertices = device.createBuffer({ size: capacity * MAX_CELLS * 3 * 4, usage: storage | copySrc });
        this.normals = device.createBuffer({ size: capacity * MAX_CELLS * 3 * 4, usage: storage | copySrc });
        this.indices = device.createBuffer({ size: capacity * MAX_INDICES * 4, usage: storage | copySrc });
        this.counts = device.createBuffer({ size: capacity * 2 * 4, usage: storage | copySrc | copyDst });
        this.readback = device.createBuffer({ size: capacity * 2 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        this.bindGroup = device.createBindGroup({
            layout: this.layout,
            entries: [
                { binding: 0, resource: { buffer: this.params } },
                { binding: 1, resource: { buffer: this.desc } },
                { binding: 2, resource: { buffer: this.occupancy } },
                { binding: 3, resource: { buffer: this.field } },
                { binding: 4, resource: { buffer: this.scratch } },
                { binding: 5, resource: { buffer: this.cellSlot } },
                { binding: 6, resource: { buffer: this.vertices } },
                { binding: 7, resource: { buffer: this.normals } },
                { binding: 8, resource: { buffer: this.indices } },
                { binding: 9, resource: { buffer: this.counts } }
            ]
        });

        this.scratchKey = new MortonKey();
    }

    destroy() {
        for (const b of [this.params, this.occupancy, this.desc, this.field, this.scratch, this.cellSlot,
            this.vertices, this.normals, this.indices, this.counts, this.readback]) {
            b.destroy();
        }
    }

    /**
     * Packs each request's 27-chunk neighbourhood and descriptor, mirroring
     * GpuSmoothMesher._stage.
     */
    stage(records, world, smoothing, flipped) {
        const count = records.length;
        const desc = this.descStage;

        desc.fill(-1);

        for (let i = 0; i < count; i++) {
            const key = records[i].key;
            const descBase = i * DESC_STRIDE;

            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    for (let oz = -1; oz <= 1; oz++) {
                        const slot = ((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1);

                        MortonKey.from(key.x + ox, key.y + oy, key.z + oz, this.scratchKey);

                        const chunk = world.get(this.scratchKey);

                        if (chunk === null) {
                            continue;
                        }

                        const arena = (i * 27) + slot;

                        this.occupancyStage.set(chunk.layer.bitArray.elements, arena * WORDS);
                        desc[descBase + slot] = arena;
                    }
                }
            }

            let negative = 0;
            const negativeSlots = [4, 10, 12];

            for (let axis = 0; axis < 3; axis++) {
                if (desc[descBase + negativeSlots[axis]] >= 0) {
                    negative |= (1 << axis);
                }
            }

            desc[descBase + 27] = negative;
        }

        const margin = 1 + smoothing;

        this.paramStage[0] = count;
        this.paramStage[1] = margin;
        this.paramStage[2] = BVXLayer.DIMS + (2 * margin);
        this.paramStage[3] = flipped ? 1 : 0;

        this.device.queue.writeBuffer(this.occupancy, 0, this.occupancyStage, 0, count * 27 * WORDS);
        this.device.queue.writeBuffer(this.desc, 0, this.descStage);
        this.device.queue.writeBuffer(this.params, 0, this.paramStage);
    }

    /**
     * The ordered pass list for a given smoothing level, honouring pingpong.
     */
    passList(smoothing) {
        const list = [this.activeBox ? "sample_field_active" : "sample_field"];

        if (!this.pingpong) {
            for (let i = 0; i < smoothing; i++) {
                list.push("blur_x", "blur_y", "blur_z", "copy_back");
            }

            list.push("mark_cells", "scan_cells", "emit_quads");

            return list;
        }

        // Ping-pong: a triple of axis passes flips which buffer holds the field,
        // so only an odd number of triples needs a copy back at the end. With
        // fuseBlur two smoothing passes collapse into one triple of 5-tap passes.
        let inField = true;
        let remaining = smoothing;

        while (remaining >= 2 && this.fuseBlur) {
            list.push(inField ? "blur2_x" : "blur2_x_r");
            list.push(inField ? "blur2_y" : "blur2_y_r");
            list.push(inField ? "blur2_z" : "blur2_z_r");
            inField = !inField;
            remaining -= 2;
        }

        for (let i = 0; i < remaining; i++) {
            list.push(inField ? "blur_x" : "blur_x_r");
            list.push(inField ? "blur_y" : "blur_y_r");
            list.push(inField ? "blur_z" : "blur_z_r");
            inField = !inField;
        }

        if (!inField) {
            list.push("copy_back");
        }

        list.push("mark_cells", "scan_cells", "emit_quads");

        return list;
    }

    /**
     * Records one full pipeline into an existing encoder.
     */
    record(encoder, count, smoothing) {
        encoder.clearBuffer(this.counts, 0, count * 2 * 4);

        const pass = encoder.beginComputePass();

        pass.setBindGroup(0, this.bindGroup);

        for (const name of this.passList(smoothing)) {
            pass.setPipeline(this.pipelines.get(name));
            pass.dispatchWorkgroups(name === "scan_cells" ? 1 : this.tiles, count);
        }

        pass.end();
    }

    /**
     * Records `reps` full pipelines and returns wall-clock ms per pipeline.
     */
    async time(count, smoothing, reps) {
        const encoder = this.device.createCommandEncoder();

        for (let r = 0; r < reps; r++) {
            this.record(encoder, count, smoothing);
        }

        this.device.queue.submit([encoder.finish()]);

        const start = performance.now();

        await this.device.queue.onSubmittedWorkDone();

        return (performance.now() - start) / reps;
    }

    /**
     * Records `reps` dispatches of a single pass and returns ms per dispatch.
     * Counts are cleared between reps so atomic-driven passes do identical work.
     */
    async timePass(name, count, reps) {
        const encoder = this.device.createCommandEncoder();

        for (let r = 0; r < reps; r++) {
            encoder.clearBuffer(this.counts, 0, count * 2 * 4);

            const pass = encoder.beginComputePass();

            pass.setBindGroup(0, this.bindGroup);
            pass.setPipeline(this.pipelines.get(name));
            pass.dispatchWorkgroups(name === "scan_cells" ? 1 : this.tiles, count);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);

        const start = performance.now();

        await this.device.queue.onSubmittedWorkDone();

        return (performance.now() - start) / reps;
    }

    /**
     * Runs once and reads back the per-chunk vertex and index counts.
     */
    async run(count, smoothing) {
        const encoder = this.device.createCommandEncoder();

        this.record(encoder, count, smoothing);

        encoder.copyBufferToBuffer(this.counts, 0, this.readback, 0, count * 2 * 4);

        this.device.queue.submit([encoder.finish()]);

        await this.readback.mapAsync(GPUMapMode.READ, 0, count * 2 * 4);

        const counts = new Uint32Array(this.readback.getMappedRange(0, count * 2 * 4).slice(0));

        this.readback.unmap();

        return counts;
    }

    /**
     * Reads one chunk's geometry back for verification.
     */
    async readGeometry(index, vertexCount, indexCount) {
        const device = this.device;

        const vBytes = Math.max(4, vertexCount * 3 * 4);
        const iBytes = Math.max(4, indexCount * 4);

        const vRead = device.createBuffer({ size: vBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const nRead = device.createBuffer({ size: vBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const iRead = device.createBuffer({ size: iBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        const encoder = device.createCommandEncoder();

        if (vertexCount > 0) {
            encoder.copyBufferToBuffer(this.vertices, index * MAX_CELLS * 3 * 4, vRead, 0, vertexCount * 3 * 4);
            encoder.copyBufferToBuffer(this.normals, index * MAX_CELLS * 3 * 4, nRead, 0, vertexCount * 3 * 4);
        }

        if (indexCount > 0) {
            encoder.copyBufferToBuffer(this.indices, index * MAX_INDICES * 4, iRead, 0, indexCount * 4);
        }

        device.queue.submit([encoder.finish()]);

        await Promise.all([vRead.mapAsync(GPUMapMode.READ), nRead.mapAsync(GPUMapMode.READ), iRead.mapAsync(GPUMapMode.READ)]);

        const result = {
            vertices: new Float32Array(vRead.getMappedRange().slice(0, Math.max(4, vertexCount * 3 * 4))).subarray(0, vertexCount * 3),
            normals: new Float32Array(nRead.getMappedRange().slice(0, Math.max(4, vertexCount * 3 * 4))).subarray(0, vertexCount * 3),
            indices: new Uint32Array(iRead.getMappedRange().slice(0, Math.max(4, indexCount * 4))).subarray(0, indexCount)
        };

        vRead.unmap(); nRead.unmap(); iRead.unmap();
        vRead.destroy(); nRead.destroy(); iRead.destroy();

        return result;
    }
}

/**
 * Picks a repetition count that puts a measurement in the 60-150 ms range.
 */
export async function autoReps(fn) {
    let reps = 2;

    for (;;) {
        const per = await fn(reps);
        const total = per * reps;

        if (total >= 60 || reps >= 4096) {
            return { per, reps };
        }

        reps = Math.min(4096, Math.max(reps * 2, Math.ceil(reps * (80 / Math.max(total, 0.05)))));
    }
}
