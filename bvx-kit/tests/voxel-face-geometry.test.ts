import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { BitOps } from "../src/lib/util/bit-ops.js";

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('VoxelFaceGeometry', () => {

    it('.constructor() - ensure proper buffer length', () => {
        const geometry = new VoxelFaceGeometry();

        expect(geometry.length).toEqual(4096);
        expect(geometry.buffer.byteLength).toEqual(4096);

        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        geometry.computeIndices(chunk, world);

        // we expect no bit-voxels to be present
        expect(geometry.popCount()).toEqual(0);
    });

    it('.computeIndices() - non-bounded single BitVoxel', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // set the bit-voxel we want for the chunk
        const voxelIndex = VoxelIndex.from(1, 1, 1, 1, 1, 1);

        // enable our specified bit-voxel
        chunk.setBitVoxel(voxelIndex);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        // we expect a full box - 6 bits
        const geometryIndex = geometry.indices[voxelIndex.key];
        expect(BitOps.popCount(geometryIndex)).toEqual(6);

        // we expect only a single bit-voxel to be visible in our geometry
        expect(geometry.popCount()).toEqual(6);
    });

    it('.computeIndices() - surrounded BitVoxel', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // set the bit-voxel we want for the chunk
        const center = VoxelIndex.from(1, 1, 1, 1, 1, 1);
        // neighbours
        const px = VoxelIndex.from(1, 1, 1, 2, 1, 1);
        const nx = VoxelIndex.from(1, 1, 1, 0, 1, 1);
        const py = VoxelIndex.from(1, 1, 1, 1, 2, 1);
        const ny = VoxelIndex.from(1, 1, 1, 1, 0, 1);
        const pz = VoxelIndex.from(1, 1, 1, 1, 1, 2);
        const nz = VoxelIndex.from(1, 1, 1, 1, 1, 0);

        // enable our specified bit-voxel
        chunk.setBitVoxel(center);
        chunk.setBitVoxel(px);
        chunk.setBitVoxel(nx);
        chunk.setBitVoxel(py);
        chunk.setBitVoxel(ny);
        chunk.setBitVoxel(pz);
        chunk.setBitVoxel(nz);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        // we expect center not to be rendered as its surrounded
        expect(BitOps.popCount(geometry.indices[center.key])).toEqual(0);
        // we expect all neighbours to have 5 sides as they share one with center
        expect(BitOps.popCount(geometry.indices[px.key])).toEqual(5);
        expect(BitOps.popCount(geometry.indices[nx.key])).toEqual(5);
        expect(BitOps.popCount(geometry.indices[py.key])).toEqual(5);
        expect(BitOps.popCount(geometry.indices[ny.key])).toEqual(5);
        expect(BitOps.popCount(geometry.indices[pz.key])).toEqual(5);
        expect(BitOps.popCount(geometry.indices[nz.key])).toEqual(5);

        // we expect a total of 30 sides to be rendered
        expect(geometry.popCount()).toEqual(30);
    });

    it('.computeIndices() - neighbour tolerance bitvoxels', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // place bit-voxels in all edges for edge-edge access
        const e1 = VoxelIndex.from(1, 1, 1, 0, 0, 0);
        const e2 = VoxelIndex.from(1, 1, 1, 3, 0, 0);
        const e3 = VoxelIndex.from(1, 1, 1, 0, 3, 0);
        const e4 = VoxelIndex.from(1, 1, 1, 3, 3, 0);
        const e5 = VoxelIndex.from(1, 1, 1, 0, 3, 3);
        const e6 = VoxelIndex.from(1, 1, 1, 3, 3, 3);
        const e7 = VoxelIndex.from(1, 1, 1, 3, 0, 3);
        const e8 = VoxelIndex.from(1, 1, 1, 0, 0, 3);

        chunk.setBitVoxel(e1);
        chunk.setBitVoxel(e2);
        chunk.setBitVoxel(e3);
        chunk.setBitVoxel(e4);
        chunk.setBitVoxel(e5);
        chunk.setBitVoxel(e6);
        chunk.setBitVoxel(e7);
        chunk.setBitVoxel(e8);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        // expect all bit-voxels to render with all sides
        expect(BitOps.popCount(geometry.indices[e1.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e2.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e3.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e4.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e5.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e6.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e7.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e8.key])).toEqual(6);

        // we expect a total of 48 sides to be rendered
        expect(geometry.popCount()).toEqual(48);
    });

    it('.computeIndices() - edge-chunk neighbour tolerance bitvoxels', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // place bit-voxels in all edges for edge-edge access
        const e1 = VoxelIndex.from(0, 0, 0, 0, 0, 0);
        const e2 = VoxelIndex.from(3, 0, 0, 3, 0, 0);
        const e3 = VoxelIndex.from(0, 3, 0, 0, 3, 0);
        const e4 = VoxelIndex.from(3, 3, 0, 3, 3, 0);
        const e5 = VoxelIndex.from(0, 3, 3, 0, 3, 3);
        const e6 = VoxelIndex.from(3, 3, 3, 3, 3, 3);
        const e7 = VoxelIndex.from(3, 0, 3, 3, 0, 3);
        const e8 = VoxelIndex.from(0, 0, 3, 0, 0, 3);

        chunk.setBitVoxel(e1);
        chunk.setBitVoxel(e2);
        chunk.setBitVoxel(e3);
        chunk.setBitVoxel(e4);
        chunk.setBitVoxel(e5);
        chunk.setBitVoxel(e6);
        chunk.setBitVoxel(e7);
        chunk.setBitVoxel(e8);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        // expect all bit-voxels to render with all sides
        expect(BitOps.popCount(geometry.indices[e1.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e2.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e3.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e4.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e5.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e6.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e7.key])).toEqual(6);
        expect(BitOps.popCount(geometry.indices[e8.key])).toEqual(6);

        // we expect a total of 48 sides to be rendered
        expect(geometry.popCount()).toEqual(48);
    })

    it('.computeIndices() - randomized worlds match a reference implementation', () => {
        // reference implementation of the +axis/-axis neighbour walk, used to
        // verify that the optimised LUT-based computeIndices() produces
        // identical output for arbitrary voxel configurations
        const refIndex = new VoxelIndex();

        const sample = (world: VoxelWorld, chunk: VoxelChunk32, index: VoxelIndex, axis: number, dir: number): number => {
            const v: number[] = [index.vx, index.vy, index.vz];
            const b: number[] = [index.bx, index.by, index.bz];

            b[axis] += dir;

            let target: VoxelChunk32 | null = chunk;

            if (b[axis] > 3) {
                b[axis] = 0;
                v[axis] += 1;

                if (v[axis] > 3) {
                    v[axis] = 0;
                    const nKey = axis === 0 ? chunk.key.clone().incX() : (axis === 1 ? chunk.key.clone().incY() : chunk.key.clone().incZ());
                    target = world.get(nKey) as VoxelChunk32 | null;
                }
            }
            else if (b[axis] < 0) {
                b[axis] = 3;
                v[axis] -= 1;

                if (v[axis] < 0) {
                    v[axis] = 3;
                    const nKey = axis === 0 ? chunk.key.clone().decX() : (axis === 1 ? chunk.key.clone().decY() : chunk.key.clone().decZ());
                    target = world.get(nKey) as VoxelChunk32 | null;
                }
            }

            if (target === null) {
                return 0;
            }

            return target.getBitVoxel(VoxelIndex.from(v[0], v[1], v[2], b[0], b[1], b[2], refIndex));
        };

        // deterministic pseudo-random generator so failures are reproducible
        let seed = 12345;
        const rand = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
            return seed / 0x7FFFFFFF;
        };

        const world = new VoxelWorld();
        const chunks: VoxelChunk32[] = [];

        // build a 2x2x2 block of chunks with random ~30% BitVoxel occupancy
        for (let cx = 1; cx <= 2; cx++) {
            for (let cy = 1; cy <= 2; cy++) {
                for (let cz = 1; cz <= 2; cz++) {
                    const chunk = new VoxelChunk32(MortonKey.from(cx, cy, cz));

                    for (let i = 0; i < 4096; i++) {
                        if (rand() < 0.3) {
                            chunk.setBitVoxel(new VoxelIndex(i));
                        }
                    }

                    world.insert(chunk);
                    chunks.push(chunk);
                }
            }
        }

        const geometry = new VoxelFaceGeometry();
        const queryIndex = new VoxelIndex();

        for (const chunk of chunks) {
            geometry.computeIndices(chunk, world);

            for (let i = 0; i < 4096; i++) {
                queryIndex.key = i;

                if (chunk.getBitVoxel(queryIndex) === 0) {
                    expect(geometry.indices[i]).toEqual(0);

                    continue;
                }

                const expected =
                    ((sample(world, chunk, queryIndex, 0, 1) ^ 1) << VoxelFaceGeometry.X_POS_INDEX) |
                    ((sample(world, chunk, queryIndex, 0, -1) ^ 1) << VoxelFaceGeometry.X_NEG_INDEX) |
                    ((sample(world, chunk, queryIndex, 1, 1) ^ 1) << VoxelFaceGeometry.Y_POS_INDEX) |
                    ((sample(world, chunk, queryIndex, 1, -1) ^ 1) << VoxelFaceGeometry.Y_NEG_INDEX) |
                    ((sample(world, chunk, queryIndex, 2, 1) ^ 1) << VoxelFaceGeometry.Z_POS_INDEX) |
                    ((sample(world, chunk, queryIndex, 2, -1) ^ 1) << VoxelFaceGeometry.Z_NEG_INDEX);

                expect(geometry.indices[i]).toEqual(expected);
            }
        }
    });

    it('.computeIndices() - occluder voxel culls the shared face', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        const center = VoxelIndex.from(1, 1, 1, 1, 1, 1);
        chunk.setBitVoxel(center);

        // occluder world with a voxel directly below the own voxel
        const occluders = new VoxelWorld();
        const occluderChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        occluders.insert(occluderChunk);
        occluderChunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 1));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world, occluders);

        // the -y face is culled by the occluder, 5 faces remain
        const mask = geometry.indices[center.key];

        expect((mask >> VoxelFaceGeometry.Y_NEG_INDEX) & 1).toEqual(0);
        expect(BitOps.popCount(mask)).toEqual(5);
        expect(geometry.popCount()).toEqual(5);
    });

    it('.computeIndices() - occluder voxels never emit geometry of their own', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // the occluder chunk is completely full, the own chunk is empty
        const occluders = new VoxelWorld();
        const occluderChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        occluders.insert(occluderChunk);

        for (let i = 0; i < 4096; i++) {
            occluderChunk.setBitVoxel(new VoxelIndex(i));
        }

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world, occluders);

        expect(geometry.popCount()).toEqual(0);
    });

    it('.computeIndices() - occluder in the adjacent chunk culls the boundary face', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // own voxel on the +x boundary of the chunk
        const center = VoxelIndex.from(3, 1, 1, 3, 1, 1);
        chunk.setBitVoxel(center);

        // occluder voxel just across the boundary in the +x neighbouring chunk -
        // the own world holds no chunk at that position at all
        const occluders = new VoxelWorld();
        const occluderChunk = new VoxelChunk0(MortonKey.from(2, 1, 1));

        occluders.insert(occluderChunk);
        occluderChunk.setBitVoxel(VoxelIndex.from(0, 1, 1, 0, 1, 1));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world, occluders);

        const mask = geometry.indices[center.key];

        expect((mask >> VoxelFaceGeometry.X_POS_INDEX) & 1).toEqual(0);
        expect(BitOps.popCount(mask)).toEqual(5);
    });

    it('.computeIndices() - voxel fully surrounded by occluders is culled entirely', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        const center = VoxelIndex.from(1, 1, 1, 1, 1, 1);
        chunk.setBitVoxel(center);

        const occluders = new VoxelWorld();
        const occluderChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        occluders.insert(occluderChunk);
        occluderChunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 2, 1, 1));
        occluderChunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 1, 1));
        occluderChunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 2, 1));
        occluderChunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 1));
        occluderChunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 2));
        occluderChunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 0));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world, occluders);

        expect(geometry.popCount()).toEqual(0);
    });

    it('.computeIndices() - randomized occluded worlds match a merged-world reference', () => {
        // deterministic pseudo-random generator so failures are reproducible
        let seed = 67890;
        const rand = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
            return seed / 0x7FFFFFFF;
        };

        const world = new VoxelWorld();
        const occluders = new VoxelWorld();
        const merged = new VoxelWorld();
        const chunks: VoxelChunk32[] = [];

        // 2x2x2 chunks - random own occupancy, random disjoint occluder occupancy
        // and a merged reference world holding the union of both
        for (let cx = 1; cx <= 2; cx++) {
            for (let cy = 1; cy <= 2; cy++) {
                for (let cz = 1; cz <= 2; cz++) {
                    const chunk = new VoxelChunk32(MortonKey.from(cx, cy, cz));
                    const occluderChunk = new VoxelChunk0(MortonKey.from(cx, cy, cz));
                    const mergedChunk = new VoxelChunk0(MortonKey.from(cx, cy, cz));

                    for (let i = 0; i < 4096; i++) {
                        const roll = rand();

                        if (roll < 0.2) {
                            chunk.setBitVoxel(new VoxelIndex(i));
                            mergedChunk.setBitVoxel(new VoxelIndex(i));
                        }
                        else if (roll < 0.4) {
                            occluderChunk.setBitVoxel(new VoxelIndex(i));
                            mergedChunk.setBitVoxel(new VoxelIndex(i));
                        }
                    }

                    world.insert(chunk);
                    occluders.insert(occluderChunk);
                    merged.insert(mergedChunk);
                    chunks.push(chunk);
                }
            }
        }

        // samples the merged reference world at global BitVoxel coordinates
        const refKey = new MortonKey();
        const refIndex = new VoxelIndex();

        const mergedBit = (x: number, y: number, z: number): number => {
            const target = merged.get(MortonKey.from(x >> 4, y >> 4, z >> 4, refKey));

            if (target === null) {
                return 0;
            }

            const lx = x & 15;
            const ly = y & 15;
            const lz = z & 15;

            return target.getBitVoxel(VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, refIndex));
        };

        const geometry = new VoxelFaceGeometry();
        const queryIndex = new VoxelIndex();

        for (const chunk of chunks) {
            geometry.computeIndices(chunk, world, occluders);

            const gx = chunk.key.x * 16;
            const gy = chunk.key.y * 16;
            const gz = chunk.key.z * 16;

            for (let i = 0; i < 4096; i++) {
                queryIndex.key = i;

                // occluder-only and empty cells emit nothing
                if (chunk.getBitVoxel(queryIndex) === 0) {
                    expect(geometry.indices[i]).toEqual(0);

                    continue;
                }

                const x = gx + (queryIndex.vx * 4) + queryIndex.bx;
                const y = gy + (queryIndex.vy * 4) + queryIndex.by;
                const z = gz + (queryIndex.vz * 4) + queryIndex.bz;

                // a face renders only when the merged neighbour cell is empty
                const expected =
                    ((mergedBit(x + 1, y, z) ^ 1) << VoxelFaceGeometry.X_POS_INDEX) |
                    ((mergedBit(x - 1, y, z) ^ 1) << VoxelFaceGeometry.X_NEG_INDEX) |
                    ((mergedBit(x, y + 1, z) ^ 1) << VoxelFaceGeometry.Y_POS_INDEX) |
                    ((mergedBit(x, y - 1, z) ^ 1) << VoxelFaceGeometry.Y_NEG_INDEX) |
                    ((mergedBit(x, y, z + 1) ^ 1) << VoxelFaceGeometry.Z_POS_INDEX) |
                    ((mergedBit(x, y, z - 1) ^ 1) << VoxelFaceGeometry.Z_NEG_INDEX);

                expect(geometry.indices[i]).toEqual(expected);
            }
        }
    });
});