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
     * it will contour in one submission.
     *
     * The measured cost model says batching is the whole game: a dispatch carries
     * a fixed submission cost of roughly a tenth of a millisecond on Apple
     * Silicon, so a batch of one loses to the CPU outright while a batch of
     * sixty-four wins comfortably. Scratch is about 0.5 MB per chunk.
     */
    readonly capacity?: number;
}

/**
 * A WebGPU compute implementation of VoxelSmoothGeometry.
 *
 * ## What it does and does not accept
 *
 * It contours a chunk against its 26 neighbours with the same field, the same
 * blur and the same surface-nets rules as the CPU, and leaves the result on the
 * device. It does NOT implement occluder meshing - the merged-field ownership
 * modes and the vertex compaction they need are not ported. `supports()` reports
 * false for those, and a caller holding a CpuSmoothMesher should route them
 * there. This is a real limitation, not a temporary one to be assumed away: the
 * reference editor uses occluders on every lane, so today this path serves
 * standalone chunks only.
 *
 * ## Why it takes a device rather than making one
 *
 * The output is meant to be drawn, not read back - a readback round trip
 * measured 0.32 ms for sixteen bytes on this hardware, which is more than the
 * contouring saves. Drawing it means the renderer's device must own it, so the
 * caller passes the device in. That also keeps the kit free of any WebGPU
 * runtime dependency: nothing here touches navigator.gpu.
 */
export class GpuSmoothMesher implements SmoothMesher {
    public readonly id: string = "webgpu";
    public readonly residency: SmoothMeshResidency = "gpu";

    /**
     * Field, cell and output sizes, mirroring VoxelSmoothGeometry's own.
     */
    private static readonly FIELD_DIMS: number = 24;
    private static readonly FIELD_SIZE: number = 24 * 24 * 24;
    private static readonly MAX_CELLS: number = 17 * 17 * 17;
    private static readonly MAX_INDICES: number = 3 * 17 * 16 * 16 * 6;
    private static readonly DESC_STRIDE: number = 32;

    /**
     * The shader declares its descriptor array at a fixed length, so a batch
     * cannot exceed it.
     */
    public static readonly MAX_BATCH: number = 64;

    /**
     * One scratch buffer serves the blur ping-pong and the per-cell vertex data;
     * the phases never overlap, and sharing keeps the pipeline inside WebGPU's
     * default eight storage buffers per compute stage.
     */
    private static readonly SCRATCH_STRIDE: number = Math.max(24 * 24 * 24, 17 * 17 * 17 * 6);

    private readonly _device: GPUDevice;
    private readonly _capacity: number;

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
    private readonly _scratchKey: MortonKey;

    constructor(device: GPUDevice, options: GpuSmoothMesherOptions = {}) {
        const capacity: number = Math.min(GpuSmoothMesher.MAX_BATCH, Math.max(1, options.capacity ?? 32));

        this._device = device;
        this._capacity = capacity;
        this._scratchKey = new MortonKey();
        this._pipelines = new Map<string, GPUComputePipeline>();

        const module: GPUShaderModule = device.createShaderModule({ code: SMOOTH_MESHER_WGSL, label: "bvx-smooth-mesher" });

        // Every pass shares one explicit layout so one bind group serves them all.
        // Ten storage bindings is exactly the portable floor for a compute stage,
        // which is why the field and the cell data are packed rather than split.
        const entries: GPUBindGroupLayoutEntry[] = [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
        ];

        for (let binding = 3; binding <= 9; binding++) {
            entries.push({ binding: binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
        }

        this._layout = device.createBindGroupLayout({ entries: entries, label: "bvx-smooth-layout" });

        const pipelineLayout: GPUPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this._layout] });

        for (const entryPoint of ["sample_field", "blur_x", "blur_y", "blur_z", "copy_back", "mark_cells", "scan_cells", "emit_quads"]) {
            this._pipelines.set(entryPoint, device.createComputePipeline({
                layout: pipelineLayout,
                compute: { module: module, entryPoint: entryPoint },
                label: `bvx-smooth-${entryPoint}`
            }));
        }

        const storage: number = GPUBufferUsage.STORAGE;
        const copyDst: number = GPUBufferUsage.COPY_DST;

        // The chunk plus its 26 neighbours, per batched chunk. Uploaded rather
        // than shared, because WebGPU never maps a SharedArrayBuffer directly.
        const occupancyWords: number = capacity * 27 * (BVXLayer.BYTE_LENGTH / 4);

        this._occupancyStage = new Uint32Array(occupancyWords);
        this._descStage = new Int32Array(GpuSmoothMesher.MAX_BATCH * GpuSmoothMesher.DESC_STRIDE);

        this._params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | copyDst, label: "bvx-smooth-params" });
        this._occupancy = device.createBuffer({ size: occupancyWords * 4, usage: storage | copyDst, label: "bvx-smooth-occupancy" });
        this._desc = device.createBuffer({ size: this._descStage.byteLength, usage: GPUBufferUsage.UNIFORM | copyDst, label: "bvx-smooth-desc" });

        const fieldBytes: number = capacity * GpuSmoothMesher.FIELD_SIZE * 4;

        this._field = device.createBuffer({ size: fieldBytes, usage: storage, label: "bvx-smooth-field" });
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

        this._counts = device.createBuffer({
            size: capacity * 2 * 4,
            usage: storage | GPUBufferUsage.COPY_SRC | copyDst,
            label: "bvx-smooth-counts"
        });
        this._countsRead = device.createBuffer({
            size: capacity * 2 * 4,
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
     * submission pays the whole fixed dispatch cost for one chunk's work and
     * loses to the CPU by roughly six times.
     */
    public async mesh(request: SmoothMeshRequest): Promise<SmoothMeshResult> {
        const results: SmoothMeshResult[] = await this.meshBatch([request]);

        return results[0];
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

        this._stage(requests, count);

        device.queue.writeBuffer(this._occupancy, 0, this._occupancyStage, 0, count * 27 * (BVXLayer.BYTE_LENGTH / 4));
        device.queue.writeBuffer(this._desc, 0, this._descStage);
        device.queue.writeBuffer(this._params, 0, new Uint32Array([
            count,
            margin,
            BVXLayer.DIMS + (2 * margin),
            requests[0].flipped ? 1 : 0
        ]));

        const encoder: GPUCommandEncoder = device.createCommandEncoder({ label: "bvx-smooth" });

        encoder.clearBuffer(this._counts, 0, count * 2 * 4);

        const pass: GPUComputePassEncoder = encoder.beginComputePass({ label: "bvx-smooth-pass" });

        pass.setBindGroup(0, this._bindGroup);

        this._dispatch(pass, "sample_field", count);

        // Three axis passes then a copy back, exactly as the CPU ping-pongs, so
        // the arithmetic and therefore the result are identical.
        for (let i = 0; i < smoothing; i++) {
            this._dispatch(pass, "blur_x", count);
            this._dispatch(pass, "blur_y", count);
            this._dispatch(pass, "blur_z", count);
            this._dispatch(pass, "copy_back", count);
        }

        this._dispatch(pass, "mark_cells", count);
        this._dispatch(pass, "scan_cells", count);
        this._dispatch(pass, "emit_quads", count);

        pass.end();

        // The counts are the one thing that must come back: a draw needs its index
        // count on the CPU. It is 8 bytes per chunk, and it is the only readback
        // in the pipeline - the geometry itself never crosses.
        encoder.copyBufferToBuffer(this._counts, 0, this._countsRead, 0, count * 2 * 4);

        device.queue.submit([encoder.finish()]);

        await this._countsRead.mapAsync(GPUMapMode.READ, 0, count * 2 * 4);

        const counts: Uint32Array = new Uint32Array(this._countsRead.getMappedRange(0, count * 2 * 4).slice(0));

        this._countsRead.unmap();

        const results: SmoothMeshResult[] = [];

        for (let i = 0; i < count; i++) {
            const indexCount: number = Math.min(counts[(i * 2) + 1], GpuSmoothMesher.MAX_INDICES);

            results.push({
                residency: "gpu",
                vertexCount: counts[i * 2],
                indexCount: indexCount,
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
     * Records one pass, one workgroup per chunk.
     */
    private _dispatch(pass: GPUComputePassEncoder, entryPoint: string, count: number): void {
        pass.setPipeline(this._pipelines.get(entryPoint)!);
        pass.dispatchWorkgroups(count);
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
