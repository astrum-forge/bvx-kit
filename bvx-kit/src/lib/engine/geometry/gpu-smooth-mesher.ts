/// <reference types="@webgpu/types" />

import { MortonKey } from "../../math/morton-key.js";
import { BVXLayer } from "../layer/bvx-layer.js";
import { VoxelChunk } from "../chunks/voxel-chunk.js";
import { VoxelWorld } from "../voxel-world.js";
import { SmoothMesher, SmoothMeshRequest, SmoothMeshResidency, SmoothMeshResult } from "./smooth-mesher.js";
import { VoxelSmoothGeometry } from "./voxel-smooth-geometry.js";
import { SMOOTH_MESHER_WGSL } from "./smooth-mesher.wgsl.js";

/**
 * Device-resident geometry for one chunk, handed back as the result's handle.
 *
 * The buffers are the mesher's, not the caller's - they are recycled on the next
 * mesh of the same slot. A renderer binds them; it must not free them.
 */
export interface GpuSmoothMeshHandle {
    /**
     * Vertex positions, three f32 each. Created with VERTEX usage.
     */
    readonly positions: GPUBuffer;

    /**
     * Vertex normals, three f32 each. Created with VERTEX usage.
     */
    readonly normals: GPUBuffer;

    /**
     * Triangle indices, u32. Created with INDEX usage.
     */
    readonly indices: GPUBuffer;

    /**
     * Byte offset of this chunk's slice within each buffer.
     */
    readonly vertexByteOffset: number;
    readonly normalByteOffset: number;
    readonly indexByteOffset: number;
}

/**
 * Options for GpuSmoothMesher.
 */
export interface GpuSmoothMesherOptions {
    /**
     * How many chunks the mesher sizes its scratch for, and therefore the most
     * it will contour in one submission. Scratch is about 0.5 MB per chunk.
     */
    readonly capacity?: number;

    /**
     * How many workgroups each chunk gets for the data-parallel passes. Defaults to 16.
     *
     * The shader grid-strides within a tile, so this only changes how the work is
     * spread, never the result. It matters at small batches, where one workgroup per
     * chunk leaves the device almost idle: measured on an M1 at smoothing 2, 16 tiles
     * is worth 2.2x at a batch of one and 1.3x at eight, and nothing by 32, where the
     * batch alone already saturates. Values above 54 cannot help - that is one thread
     * per field sample.
     */
    readonly tiles?: number;
}

/**
 * A WebGPU compute implementation of VoxelSmoothGeometry.
 *
 * ## What it does and does not accept
 *
 * It contours a chunk against its 26 neighbours with the same field, the same blur and
 * the same surface-nets rules as the CPU, and leaves the result on the device.
 *
 * It does **not** implement occluder meshing - the merged-field ownership modes and the
 * vertex compaction they need are not ported. `supports()` reports false for those, and
 * a caller holding a CpuSmoothMesher should route them there.
 *
 * Two further differences from the CPU reference, both measured rather than assumed:
 *
 * - **Positions are f32 throughout.** The CPU computes a vertex position in f64 and
 *   rounds once on the store. Topology is identical - vertex count, index count and the
 *   set of triangles match exactly at every smoothing level - but about 5% of vertex
 *   components differ, by at most 4.8e-7 units against a 0.25-unit BitVoxel.
 * - **There is no degenerate-normal fallback.** A dual cell whose field gradient is zero
 *   gets a zero normal here; the CPU resolves it from the adjacent triangles. The result
 *   reports how many such vertices a chunk produced, in `degenerateNormals`, so a
 *   renderer can detect the case rather than discover it visually. On terrain-shaped
 *   data it does not arise; two diagonally opposite solid corners with nothing else in
 *   the cell is what triggers it.
 *
 * ## Why it takes a device rather than making one
 *
 * The output is meant to be drawn, not read back - a readback round trip measured
 * 0.32 ms for sixteen bytes on Apple Silicon, regardless of payload size, which is more
 * than the contouring saves below roughly 25 chunks. Drawing it means the renderer's
 * device must own it, so the caller passes the device in. That also keeps the kit free
 * of any WebGPU runtime dependency: nothing here touches navigator.gpu.
 *
 * ## When it is worth using
 *
 * Two costs, and they behave differently. Measured on an M1 at smoothing 2, against the
 * CPU mesher's 241 us per chunk.
 *
 * **The contouring itself**, amortised over many submissions so per-call latency does
 * not dominate the measurement:
 *
 * | chunks per submission | 1 | 2 | 4 | 8 | 16 | 32 | 64 |
 * | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
 * | us per chunk | 140 | 76 | 46 | 29 | 20 | 17 | 17 |
 * | speedup vs CPU | 1.7x | 3.2x | 5.3x | 8.3x | 12x | 14x | 14x |
 *
 * Batching is still worth a lot, but the old advice that a batch of one "loses to the
 * CPU by roughly six times" no longer holds - that was a property of the one-workgroup-
 * per-chunk dispatch this no longer uses.
 *
 * **The call around it** adds a fixed cost that batching amortises and nothing else
 * reduces: staging and uploading the neighbourhoods runs about 10 us per chunk on the
 * calling thread, and submitting the work and awaiting the 16-bytes-per-chunk counts
 * readback costs roughly 0.3 ms per call whatever the batch size. At 64 chunks that is
 * noise; at one chunk it is the whole call.
 *
 * So `meshBatch` is worth using in proportion to how many chunks go into one call, and a
 * caller submitting one chunk at a time is measuring the round trip rather than the
 * mesher. Two further consequences worth knowing:
 *
 * - **A caller who needs the vertices back on the CPU should use CpuSmoothMesher below
 *   roughly 25 chunks.** The readback round trip costs more than the contouring saves.
 * - **One instance cannot overlap itself.** Every call writes the same scratch, so a
 *   second `meshBatch` cannot be submitted until the first resolves. An application that
 *   wants the GPU contouring while the CPU reads the previous counts should hold two
 *   instances and alternate between them.
 */
export class GpuSmoothMesher implements SmoothMesher {
    public readonly id: string = "webgpu";
    public readonly residency: SmoothMeshResidency = "gpu";

    /**
     * Field, cell and output sizes, mirroring VoxelSmoothGeometry's own.
     */
    private static readonly FIELD_SIZE: number = 24 * 24 * 24;
    private static readonly MAX_CELLS: number = 17 * 17 * 17;
    private static readonly MAX_INDICES: number = 3 * 17 * 16 * 16 * 6;
    private static readonly DESC_STRIDE: number = 32;

    /**
     * Words of per-chunk output the shader reports: vertex count, index count,
     * degenerate-normal count, and one spare that keeps the stride 16-byte aligned.
     */
    private static readonly COUNT_WORDS: number = 4;

    /**
     * The shader declares its descriptor array at a fixed length, so a batch
     * cannot exceed it.
     */
    public static readonly MAX_BATCH: number = 64;

    /**
     * The most workgroups per chunk that can do any work - one thread per field sample.
     */
    public static readonly MAX_TILES: number = Math.ceil((24 * 24 * 24) / 256);

    /**
     * One scratch buffer serves the blur ping-pong and the per-cell vertex data;
     * the phases never overlap, and sharing keeps the pipeline inside WebGPU's
     * default eight storage buffers per compute stage.
     */
    private static readonly SCRATCH_STRIDE: number = Math.max(24 * 24 * 24, 17 * 17 * 17 * 6);

    private readonly _device: GPUDevice;
    private readonly _capacity: number;
    private readonly _tiles: number;

    private readonly _module: GPUShaderModule;
    private readonly _pipelineLayout: GPUPipelineLayout;
    private readonly _pipelines: Map<string, GPUComputePipeline>;
    private readonly _layout: GPUBindGroupLayout;
    private readonly _bindGroup: GPUBindGroup;

    private readonly _params: GPUBuffer;
    private readonly _occupancy: GPUBuffer;
    private readonly _desc: GPUBuffer;
    private readonly _field: GPUBuffer;
    private readonly _scratch: GPUBuffer;
    private readonly _cellSlot: GPUBuffer;
    private readonly _vertices: GPUBuffer;
    private readonly _normals: GPUBuffer;
    private readonly _indices: GPUBuffer;
    private readonly _counts: GPUBuffer;
    private readonly _countsRead: GPUBuffer;

    /**
     * Staging arrays reused across submissions, so a steady-state mesh allocates
     * nothing per chunk.
     */
    private readonly _occupancyStage: Uint32Array<ArrayBuffer>;
    private readonly _descStage: Int32Array<ArrayBuffer>;
    private readonly _paramStage: Uint32Array<ArrayBuffer>;
    private readonly _scratchKey: MortonKey;

    constructor(device: GPUDevice, options: GpuSmoothMesherOptions = {}) {
        const capacity: number = Math.min(GpuSmoothMesher.MAX_BATCH, Math.max(1, options.capacity ?? 32));

        this._device = device;
        this._capacity = capacity;
        this._tiles = Math.min(GpuSmoothMesher.MAX_TILES, Math.max(1, options.tiles ?? 16));
        this._scratchKey = new MortonKey();
        this._pipelines = new Map<string, GPUComputePipeline>();

        this._module = device.createShaderModule({ code: SMOOTH_MESHER_WGSL, label: "bvx-smooth-mesher" });

        // Every pass shares one explicit layout so one bind group serves them all.
        const entries: GPUBindGroupLayoutEntry[] = [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
        ];

        for (let binding = 3; binding <= 9; binding++) {
            entries.push({ binding: binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
        }

        this._layout = device.createBindGroupLayout({ entries: entries, label: "bvx-smooth-layout" });
        this._pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this._layout] });

        const storage: number = GPUBufferUsage.STORAGE;
        const copyDst: number = GPUBufferUsage.COPY_DST;

        // The chunk plus its 26 neighbours, per batched chunk. Uploaded rather than
        // shared: queue.writeBuffer does accept a SharedArrayBuffer-backed view, but
        // the arena's chunks are scattered rather than contiguous, so they have to be
        // gathered somewhere regardless.
        const occupancyWords: number = capacity * 27 * (BVXLayer.BYTE_LENGTH / 4);

        this._occupancyStage = new Uint32Array(occupancyWords);
        this._descStage = new Int32Array(GpuSmoothMesher.MAX_BATCH * GpuSmoothMesher.DESC_STRIDE);
        this._paramStage = new Uint32Array(4);

        this._params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | copyDst, label: "bvx-smooth-params" });
        this._occupancy = device.createBuffer({ size: occupancyWords * 4, usage: storage | copyDst, label: "bvx-smooth-occupancy" });
        this._desc = device.createBuffer({ size: this._descStage.byteLength, usage: GPUBufferUsage.UNIFORM | copyDst, label: "bvx-smooth-desc" });

        this._field = device.createBuffer({ size: capacity * GpuSmoothMesher.FIELD_SIZE * 4, usage: storage, label: "bvx-smooth-field" });
        this._scratch = device.createBuffer({ size: capacity * GpuSmoothMesher.SCRATCH_STRIDE * 4, usage: storage, label: "bvx-smooth-scratch" });
        this._cellSlot = device.createBuffer({ size: capacity * GpuSmoothMesher.MAX_CELLS * 4, usage: storage, label: "bvx-smooth-cellslot" });

        // The three output buffers carry VERTEX / INDEX usage so a renderer can
        // draw straight out of them - the whole point of staying on the device.
        this._vertices = device.createBuffer({
            size: capacity * GpuSmoothMesher.MAX_CELLS * 3 * 4,
            usage: storage | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
            label: "bvx-smooth-vertices"
        });
        this._normals = device.createBuffer({
            size: capacity * GpuSmoothMesher.MAX_CELLS * 3 * 4,
            usage: storage | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
            label: "bvx-smooth-normals"
        });
        this._indices = device.createBuffer({
            size: capacity * GpuSmoothMesher.MAX_INDICES * 4,
            usage: storage | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_SRC,
            label: "bvx-smooth-indices"
        });

        const countBytes: number = capacity * GpuSmoothMesher.COUNT_WORDS * 4;

        this._counts = device.createBuffer({
            size: countBytes,
            usage: storage | GPUBufferUsage.COPY_SRC | copyDst,
            label: "bvx-smooth-counts"
        });
        this._countsRead = device.createBuffer({
            size: countBytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: "bvx-smooth-counts-read"
        });

        this._bindGroup = device.createBindGroup({
            layout: this._layout,
            label: "bvx-smooth-bindgroup",
            entries: [
                { binding: 0, resource: { buffer: this._params } },
                { binding: 1, resource: { buffer: this._desc } },
                { binding: 2, resource: { buffer: this._occupancy } },
                { binding: 3, resource: { buffer: this._field } },
                { binding: 4, resource: { buffer: this._scratch } },
                { binding: 5, resource: { buffer: this._cellSlot } },
                { binding: 6, resource: { buffer: this._vertices } },
                { binding: 7, resource: { buffer: this._normals } },
                { binding: 8, resource: { buffer: this._indices } },
                { binding: 9, resource: { buffer: this._counts } }
            ]
        });
    }

    /**
     * The largest batch this instance will contour in one submission.
     */
    public get capacity(): number {
        return this._capacity;
    }

    /**
     * The workgroups per chunk the data-parallel passes are dispatched with.
     */
    public get tiles(): number {
        return this._tiles;
    }

    /**
     * Occluder meshing is not implemented on this path - the merged-field
     * ownership modes and the vertex compaction they require are absent, and a
     * silently different surface is worse than a routed one.
     */
    public supports(request: SmoothMeshRequest): boolean {
        if (request.smoothing < 0 || request.smoothing > VoxelSmoothGeometry.MAX_SMOOTHING) {
            return false;
        }

        if (request.occluders === null) {
            return true;
        }

        // An occluder world with nothing in this neighbourhood behaves exactly
        // like no occluder world at all, which the CPU decides the same way.
        return !this._occludersActive(request.chunk.key, request.occluders);
    }

    /**
     * Contours one chunk. Prefer meshBatch for more than one - a single-chunk
     * submission pays the whole fixed dispatch cost for one chunk's work.
     */
    public async mesh(request: SmoothMeshRequest): Promise<SmoothMeshResult> {
        const results: SmoothMeshResult[] = await this.meshBatch([request]);

        return results[0];
    }

    /**
     * The ordered list of pass entry points for a smoothing level.
     *
     * Three axis passes flip which buffer holds the field, so the direction alternates
     * and `copy_back` appears only when the number of triples is odd. Pairs of smoothing
     * passes collapse into one triple of fused 5-taps.
     *
     * @param smoothing - The clamped smoothing level.
     * @returns - The entry points, in dispatch order.
     */
    public static passList(smoothing: number): string[] {
        const list: string[] = ["sample_field"];

        let inField = true;
        let remaining: number = smoothing;

        while (remaining >= 2) {
            list.push(inField ? "blur2_x" : "blur2_x_r");
            list.push(inField ? "blur2_y" : "blur2_y_r");
            list.push(inField ? "blur2_z" : "blur2_z_r");

            inField = !inField;
            remaining -= 2;
        }

        if (remaining === 1) {
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
     * Contours a batch of chunks in one submission.
     *
     * All chunks in a batch share the smoothing level and winding, because both
     * are per-pass constants in the shader; the caller must not mix them.
     */
    public async meshBatch(requests: SmoothMeshRequest[]): Promise<SmoothMeshResult[]> {
        if (requests.length === 0) {
            return [];
        }

        if (requests.length > this._capacity) {
            throw new Error(`bvx: smooth mesh batch of ${requests.length} exceeds capacity ${this._capacity}`);
        }

        const device: GPUDevice = this._device;
        const count: number = requests.length;
        const smoothing: number = Math.min(Math.max(requests[0].smoothing | 0, 0), VoxelSmoothGeometry.MAX_SMOOTHING);
        const margin: number = 1 + smoothing;
        const countBytes: number = count * GpuSmoothMesher.COUNT_WORDS * 4;

        this._stage(requests, count);

        this._paramStage[0] = count;
        this._paramStage[1] = margin;
        this._paramStage[2] = BVXLayer.DIMS + (2 * margin);
        this._paramStage[3] = requests[0].flipped ? 1 : 0;

        device.queue.writeBuffer(this._occupancy, 0, this._occupancyStage, 0, count * 27 * (BVXLayer.BYTE_LENGTH / 4));
        device.queue.writeBuffer(this._desc, 0, this._descStage);
        device.queue.writeBuffer(this._params, 0, this._paramStage);

        const encoder: GPUCommandEncoder = device.createCommandEncoder({ label: "bvx-smooth" });

        encoder.clearBuffer(this._counts, 0, countBytes);

        const pass: GPUComputePassEncoder = encoder.beginComputePass({ label: "bvx-smooth-pass" });

        pass.setBindGroup(0, this._bindGroup);

        // WebGPU makes each dispatch its own synchronisation scope, so consecutive
        // dispatches in one pass that share a storage buffer are ordered as if they ran
        // serially. No manual barrier is needed between the stages below.
        for (const entryPoint of GpuSmoothMesher.passList(smoothing)) {
            pass.setPipeline(this._pipeline(entryPoint));

            // scan_cells synchronises through workgroup memory, so its chunk must sit in
            // a single workgroup; every other pass grid-strides across the tiles.
            pass.dispatchWorkgroups(entryPoint === "scan_cells" ? 1 : this._tiles, count);
        }

        pass.end();

        // The counts are the one thing that must come back: a draw needs its index
        // count on the CPU. It is 16 bytes per chunk, and it is the only readback
        // in the pipeline - the geometry itself never crosses.
        encoder.copyBufferToBuffer(this._counts, 0, this._countsRead, 0, countBytes);

        device.queue.submit([encoder.finish()]);

        await this._countsRead.mapAsync(GPUMapMode.READ, 0, countBytes);

        const counts: Uint32Array = new Uint32Array(this._countsRead.getMappedRange(0, countBytes).slice(0));

        this._countsRead.unmap();

        const results: SmoothMeshResult[] = [];
        const stride: number = GpuSmoothMesher.COUNT_WORDS;

        for (let i = 0; i < count; i++) {
            const indexCount: number = Math.min(counts[(i * stride) + 1], GpuSmoothMesher.MAX_INDICES);

            results.push({
                residency: "gpu",
                vertexCount: counts[i * stride],
                indexCount: indexCount,
                degenerateNormals: counts[(i * stride) + 2],
                vertices: null,
                normals: null,
                indices: null,
                handle: {
                    positions: this._vertices,
                    normals: this._normals,
                    indices: this._indices,
                    vertexByteOffset: i * GpuSmoothMesher.MAX_CELLS * 3 * 4,
                    normalByteOffset: i * GpuSmoothMesher.MAX_CELLS * 3 * 4,
                    indexByteOffset: i * GpuSmoothMesher.MAX_INDICES * 4
                } satisfies GpuSmoothMeshHandle
            });
        }

        return results;
    }

    public dispose(): void {
        this._params.destroy();
        this._occupancy.destroy();
        this._desc.destroy();
        this._field.destroy();
        this._scratch.destroy();
        this._cellSlot.destroy();
        this._vertices.destroy();
        this._normals.destroy();
        this._indices.destroy();
        this._counts.destroy();
        this._countsRead.destroy();
        this._pipelines.clear();
    }

    /**
     * Returns the pipeline for an entry point, creating it on first use. Smoothing 0
     * never touches a blur pipeline and should not pay to compile six of them.
     */
    private _pipeline(entryPoint: string): GPUComputePipeline {
        const existing: GPUComputePipeline | undefined = this._pipelines.get(entryPoint);

        if (existing !== undefined) {
            return existing;
        }

        const pipeline: GPUComputePipeline = this._device.createComputePipeline({
            layout: this._pipelineLayout,
            compute: { module: this._module, entryPoint: entryPoint },
            label: `bvx-smooth-${entryPoint}`
        });

        this._pipelines.set(entryPoint, pipeline);

        return pipeline;
    }

    /**
     * Whether the occluder world holds any chunk in the neighbourhood, which is
     * the same test VoxelSmoothGeometry._SampleField makes.
     */
    private _occludersActive(key: MortonKey, occluders: VoxelWorld): boolean {
        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    MortonKey.from(key.x + ox, key.y + oy, key.z + oz, this._scratchKey);

                    if (occluders.get(this._scratchKey) !== null) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * Packs each request's 27-chunk neighbourhood into the upload staging arrays
     * and writes its descriptor.
     */
    private _stage(requests: SmoothMeshRequest[], count: number): void {
        const words: number = BVXLayer.BYTE_LENGTH / 4;
        const occupancy: Uint32Array<ArrayBuffer> = this._occupancyStage;
        const desc: Int32Array<ArrayBuffer> = this._descStage;

        desc.fill(-1);

        for (let i = 0; i < count; i++) {
            const request: SmoothMeshRequest = requests[i];
            const key: MortonKey = request.chunk.key;
            const descBase: number = i * GpuSmoothMesher.DESC_STRIDE;

            let negative = 0;

            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    for (let oz = -1; oz <= 1; oz++) {
                        const slot: number = ((ox + 1) * 3 + (oy + 1)) * 3 + (oz + 1);

                        MortonKey.from(key.x + ox, key.y + oy, key.z + oz, this._scratchKey);

                        const chunk: VoxelChunk | null = (ox === 0 && oy === 0 && oz === 0)
                            ? request.chunk
                            : request.world.get(this._scratchKey);

                        if (chunk === null) {
                            desc[descBase + slot] = -1;

                            continue;
                        }

                        // arena slot index is the position in this batch's upload
                        const arena: number = (i * 27) + slot;

                        occupancy.set(chunk.layer.bitArray.elements, arena * words);
                        desc[descBase + slot] = arena;
                    }
                }
            }

            // seam ownership - a negative-side neighbour that exists emits the
            // shared quads itself
            const negativeSlots: number[] = [4, 10, 12];

            for (let axis = 0; axis < 3; axis++) {
                if (desc[descBase + negativeSlots[axis]] >= 0) {
                    negative |= (1 << axis);
                }
            }

            desc[descBase + 27] = negative;
        }
    }
}
