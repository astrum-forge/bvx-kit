import { describe, expect, it } from '@jest/globals';
import { CpuSmoothMesher } from "../src/lib/engine/geometry/cpu-smooth-mesher.js";
import { GpuSmoothMesher } from "../src/lib/engine/geometry/gpu-smooth-mesher.js";
import { SMOOTH_MESHER_WGSL } from "../src/lib/engine/geometry/smooth-mesher.wgsl.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { SmoothMeshRequest } from "../src/lib/engine/geometry/smooth-mesher.js";
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelSmoothGeometry } from "../src/lib/engine/geometry/voxel-smooth-geometry.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";

/**
 * Coverage for the SmoothMesher interface and the parts of the GPU path that do not
 * need a device.
 *
 * GpuSmoothMesher itself cannot be exercised here - jest has no WebGPU - so what is
 * tested is everything about it that is decidable without one: the dispatch schedule and
 * the shader source. The device-backed verification lives in `bench/gpu-smooth`, which
 * diffs the kernel against this same CPU reference in a browser.
 */
describe('SmoothMesher', () => {

    const buildWorld = (): { world: VoxelWorld; chunk: VoxelChunk0 } => {
        const world = new VoxelWorld();
        const index = new VoxelIndex();

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const chunk = new VoxelChunk0(MortonKey.from(3 + ox, 3 + oy, 3 + oz));

                    for (let x = 0; x < 16; x++) {
                        for (let z = 0; z < 16; z++) {
                            const height = 5 + ((x * 3 + z * 7) % 6);

                            for (let y = 0; y < height; y++) {
                                VoxelIndex.from(x >> 2, y >> 2, z >> 2, x & 3, y & 3, z & 3, index);
                                chunk.setBitVoxel(index);
                            }
                        }
                    }

                    world.insert(chunk);
                }
            }
        }

        return { world: world, chunk: world.get(MortonKey.from(3, 3, 3)) as VoxelChunk0 };
    };

    const request = (chunk: VoxelChunk0, world: VoxelWorld, smoothing: number): SmoothMeshRequest => ({
        chunk: chunk,
        world: world,
        occluders: null,
        smoothing: smoothing,
        flipped: false,
        occlusionMode: "primary"
    });

    it('CpuSmoothMesher - matches VoxelSmoothGeometry and accepts every request', async () => {
        const { world, chunk } = buildWorld();
        const mesher = new CpuSmoothMesher();

        expect(mesher.id).toEqual("cpu");
        expect(mesher.residency).toEqual("cpu");
        expect(mesher.supports()).toEqual(true);

        const result = await mesher.mesh(request(chunk, world, 2));

        const reference = new VoxelSmoothGeometry();

        reference.computeGeometry(chunk, world, 2, false, null, "primary");

        expect(result.residency).toEqual("cpu");
        expect(result.vertexCount).toEqual(reference.vertexCount);
        expect(result.indexCount).toEqual(reference.indexCount);
        expect(result.vertexCount).toBeGreaterThan(0);
        expect(Array.from(result.vertices as Float32Array)).toEqual(Array.from(reference.vertices));
        expect(Array.from(result.normals as Float32Array)).toEqual(Array.from(reference.normals));
        expect(Array.from(result.indices as Uint32Array)).toEqual(Array.from(reference.indices));

        // the CPU resolves every degenerate gradient before returning
        expect(result.degenerateNormals).toEqual(0);
        expect(result.handle).toBeNull();

        mesher.dispose();
    });

    it('CpuSmoothMesher - owns its result buffers rather than aliasing the generator', async () => {
        const { world, chunk } = buildWorld();
        const mesher = new CpuSmoothMesher();

        const first = await mesher.mesh(request(chunk, world, 1));
        const before = Array.from(first.vertices as Float32Array);

        // a second mesh must not rewrite the first result
        await mesher.mesh(request(chunk, world, 3));

        expect(Array.from(first.vertices as Float32Array)).toEqual(before);
    });

    it('GpuSmoothMesher.passList() - schedules the blur so a copy back is rare', () => {
        // smoothing 0 has nothing to blur
        expect(GpuSmoothMesher.passList(0)).toEqual(["sample_field", "mark_cells", "scan_cells", "emit_quads"]);

        // one pass: a single triple, which lands in scratch, so one copy back
        expect(GpuSmoothMesher.passList(1)).toEqual([
            "sample_field", "blur_x", "blur_y", "blur_z", "copy_back", "mark_cells", "scan_cells", "emit_quads"
        ]);

        // two passes fuse into one triple of 5-taps - still one copy back, but three
        // fewer dispatches than running the 3-tap twice would take
        expect(GpuSmoothMesher.passList(2)).toEqual([
            "sample_field", "blur2_x", "blur2_y", "blur2_z", "copy_back", "mark_cells", "scan_cells", "emit_quads"
        ]);

        // three passes: a fused pair then a single, whose reversed direction lands the
        // field back where it started, so no copy back at all
        expect(GpuSmoothMesher.passList(3)).toEqual([
            "sample_field", "blur2_x", "blur2_y", "blur2_z", "blur_x_r", "blur_y_r", "blur_z_r",
            "mark_cells", "scan_cells", "emit_quads"
        ]);
    });

    it('GpuSmoothMesher.passList() - dispatch counts are what the docs claim', () => {
        expect(GpuSmoothMesher.passList(0).length).toEqual(4);
        expect(GpuSmoothMesher.passList(1).length).toEqual(8);
        expect(GpuSmoothMesher.passList(2).length).toEqual(8);
        expect(GpuSmoothMesher.passList(3).length).toEqual(10);
    });

    it('GpuSmoothMesher.passList() - every entry point it names exists in the shader', () => {
        const declared = new Set<string>();

        for (const match of SMOOTH_MESHER_WGSL.matchAll(/@compute[\s\S]*?fn\s+(\w+)/g)) {
            declared.add(match[1]);
        }

        for (let smoothing = 0; smoothing <= VoxelSmoothGeometry.MAX_SMOOTHING; smoothing++) {
            for (const entryPoint of GpuSmoothMesher.passList(smoothing)) {
                expect(declared.has(entryPoint)).toEqual(true);
            }
        }

        // and the shader declares no entry point the schedule can never reach
        for (const entryPoint of declared) {
            const reachable = [0, 1, 2, 3].some((smoothing) => GpuSmoothMesher.passList(smoothing).includes(entryPoint));

            expect(reachable).toEqual(true);
        }
    });

    it('SMOOTH_MESHER_WGSL - stays inside the portable binding floor', () => {
        const storage = SMOOTH_MESHER_WGSL.match(/var<storage/g) ?? [];
        const uniform = SMOOTH_MESHER_WGSL.match(/var<uniform/g) ?? [];

        // eight storage buffers per compute stage is WebGPU's default limit, and the
        // whole point of packing the field and the cell data into one scratch buffer is
        // to stay under it on a device requested with no raised limits
        expect(storage.length).toBeLessThanOrEqual(8);
        expect(uniform.length).toBeLessThanOrEqual(2);
    });

    it('GpuSmoothMesher.MAX_TILES - is one workgroup per 256 field samples', () => {
        expect(GpuSmoothMesher.MAX_TILES).toEqual(Math.ceil((24 * 24 * 24) / 256));
        expect(GpuSmoothMesher.MAX_BATCH).toEqual(64);
    });
});
