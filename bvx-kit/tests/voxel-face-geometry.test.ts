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
    it('.touched - lists every populated BitVoxel index in ascending order', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // three isolated BitVoxels, each fully exposed on all 6 faces
        const a = VoxelIndex.from(0, 0, 0, 1, 1, 1);
        const b = VoxelIndex.from(2, 2, 2, 0, 0, 0);
        const c = VoxelIndex.from(3, 3, 3, 3, 3, 3);

        chunk.setBitVoxel(a);
        chunk.setBitVoxel(b);
        chunk.setBitVoxel(c);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        expect(geometry.touchedCount).toEqual(3);
        expect(Array.from(geometry.touched)).toEqual([a.key, b.key, c.key].sort((x, y) => x - y));
        expect(geometry.popCount()).toEqual(18);

        // the touched list must agree with the index buffer in both directions
        let nonZero = 0;

        for (let i = 0; i < geometry.length; i++) {
            if (geometry.indices[i] !== 0) {
                nonZero++;

                expect(Array.from(geometry.touched)).toContain(i);
            }
        }

        expect(nonZero).toEqual(geometry.touchedCount);
    });

    it('.reset() - clears every populated entry from the previous computation', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        // populate a spread of BitVoxels, then recompute against a single one -
        // reset() only walks the previous touched list, so a stale mask left behind
        // by the first pass would survive into the second
        for (let vx = 0; vx < 4; vx++) {
            for (let vy = 0; vy < 4; vy++) {
                for (let vz = 0; vz < 4; vz++) {
                    chunk.setBitVoxel(VoxelIndex.from(vx, vy, vz, 1, 1, 1));
                }
            }
        }

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        expect(geometry.touchedCount).toEqual(64);
        expect(geometry.popCount()).toEqual(64 * 6);

        // clear all but one BitVoxel and recompute
        for (let vx = 0; vx < 4; vx++) {
            for (let vy = 0; vy < 4; vy++) {
                for (let vz = 0; vz < 4; vz++) {
                    if (vx === 0 && vy === 0 && vz === 0) {
                        continue;
                    }

                    chunk.unsetBitVoxel(VoxelIndex.from(vx, vy, vz, 1, 1, 1));
                }
            }
        }

        geometry.computeIndices(chunk, world);

        expect(geometry.touchedCount).toEqual(1);
        expect(geometry.popCount()).toEqual(6);

        // no stale masks anywhere in the buffer
        let nonZero = 0;

        for (let i = 0; i < geometry.length; i++) {
            if (geometry.indices[i] !== 0) {
                nonZero++;
            }
        }

        expect(nonZero).toEqual(1);
    });

    it('.reset() - explicit call clears the buffer, count and touched list', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        world.insert(chunk);
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(chunk, world);

        expect(geometry.popCount()).toEqual(6);
        expect(geometry.touchedCount).toEqual(1);

        geometry.reset();

        expect(geometry.popCount()).toEqual(0);
        expect(geometry.touchedCount).toEqual(0);
        expect(geometry.touched.length).toEqual(0);

        for (let i = 0; i < geometry.length; i++) {
            expect(geometry.indices[i]).toEqual(0);
        }
    });

    /**
     * Fills every BitVoxel of a chunk. Writes the storage directly, which is also what
     * exercises uniformState()'s on-demand scan rather than any write-tracked flag.
     */
    const fillChunk = (chunk: VoxelChunk0): void => {
        const elements = chunk.layer.bitArray.elements;

        for (let i = 0; i < elements.length; i++) {
            elements[i] = 0xFFFFFFFF;
        }
    };

    /**
     * Reads the BitVoxel at a global BitVoxel coordinate, treating chunks that are
     * absent from the world as empty. The reference the fast paths must agree with.
     */
    const worldBit = (world: VoxelWorld, x: number, y: number, z: number): number => {
        const chunk = world.get(MortonKey.from(x >> 4, y >> 4, z >> 4));

        if (chunk === null) {
            return 0;
        }

        const lx = x & 15;
        const ly = y & 15;
        const lz = z & 15;

        return chunk.getBitVoxel(VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3));
    };

    /**
     * Checks a computed geometry against a direct per-BitVoxel evaluation of the same
     * world, and checks that the touched list and face count agree with the buffer.
     */
    const expectMatchesReference = (geometry: VoxelFaceGeometry, world: VoxelWorld, cx: number, cy: number, cz: number): void => {
        const queryIndex = new VoxelIndex();

        let expectedFaces = 0;
        let expectedTouched = 0;

        for (let i = 0; i < geometry.length; i++) {
            queryIndex.key = i;

            const x = (cx * 16) + (queryIndex.vx * 4) + queryIndex.bx;
            const y = (cy * 16) + (queryIndex.vy * 4) + queryIndex.by;
            const z = (cz * 16) + (queryIndex.vz * 4) + queryIndex.bz;

            // only a set BitVoxel emits, and only where its neighbour is empty
            const expected = worldBit(world, x, y, z) === 0 ? 0 :
                ((worldBit(world, x + 1, y, z) ^ 1) << VoxelFaceGeometry.X_POS_INDEX) |
                ((worldBit(world, x - 1, y, z) ^ 1) << VoxelFaceGeometry.X_NEG_INDEX) |
                ((worldBit(world, x, y + 1, z) ^ 1) << VoxelFaceGeometry.Y_POS_INDEX) |
                ((worldBit(world, x, y - 1, z) ^ 1) << VoxelFaceGeometry.Y_NEG_INDEX) |
                ((worldBit(world, x, y, z + 1) ^ 1) << VoxelFaceGeometry.Z_POS_INDEX) |
                ((worldBit(world, x, y, z - 1) ^ 1) << VoxelFaceGeometry.Z_NEG_INDEX);

            expect(geometry.indices[i]).toEqual(expected);

            if (expected !== 0) {
                expectedTouched++;
                expectedFaces += BitOps.popCount(expected);
            }
        }

        expect(geometry.touchedCount).toEqual(expectedTouched);
        expect(geometry.popCount()).toEqual(expectedFaces);

        // the touched list must be ascending and cover exactly the populated entries
        const touched = geometry.touched;

        for (let t = 1; t < touched.length; t++) {
            expect(touched[t]).toBeGreaterThan(touched[t - 1]);
        }

        for (let t = 0; t < touched.length; t++) {
            expect(geometry.indices[touched[t]]).not.toEqual(0);
        }
    };

    it('.computeIndices() - a solid chunk buried in solid neighbours emits nothing', () => {
        const world = new VoxelWorld();

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const chunk = new VoxelChunk0(MortonKey.from(4 + dx, 4 + dy, 4 + dz));

                    fillChunk(chunk);
                    world.insert(chunk);
                }
            }
        }

        const center = world.get(MortonKey.from(4, 4, 4)) as VoxelChunk0;

        expect(center.isFull).toEqual(true);
        expect(center.isEmpty).toEqual(false);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(center, world);

        expect(geometry.popCount()).toEqual(0);
        expect(geometry.touchedCount).toEqual(0);

        expectMatchesReference(geometry, world, 4, 4, 4);
    });

    it('.computeIndices() - a solid chunk with no neighbours emits all six faces', () => {
        const world = new VoxelWorld();
        const center = new VoxelChunk0(MortonKey.from(4, 4, 4));

        fillChunk(center);
        world.insert(center);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(center, world);

        // six faces of 16x16 BitVoxels
        expect(geometry.popCount()).toEqual(6 * 16 * 16);

        expectMatchesReference(geometry, world, 4, 4, 4);
    });

    it('.computeIndices() - a solid chunk against a mixed neighbour matches the reference', () => {
        const world = new VoxelWorld();
        const center = new VoxelChunk0(MortonKey.from(4, 4, 4));

        fillChunk(center);
        world.insert(center);

        // surround with solid chunks on every side but +y
        const solidSides = [[1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

        for (const [dx, dy, dz] of solidSides) {
            const side = new VoxelChunk0(MortonKey.from(4 + dx, 4 + dy, 4 + dz));

            fillChunk(side);
            world.insert(side);
        }

        // the +y neighbour is a partial slab, so only some of the top face is visible
        const above = new VoxelChunk0(MortonKey.from(4, 5, 4));

        for (let x = 0; x < 8; x++) {
            for (let z = 0; z < 16; z++) {
                above.setBitVoxel(VoxelIndex.from(x >> 2, 0, z >> 2, x & 3, 0, z & 3));
            }
        }

        world.insert(above);

        expect(above.isFull).toEqual(false);
        expect(above.isEmpty).toEqual(false);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(center, world);

        // half of the 16x16 top face is exposed
        expect(geometry.popCount()).toEqual(8 * 16);

        expectMatchesReference(geometry, world, 4, 4, 4);
    });

    it('.computeIndices() - an occluder covering a solid chunk suppresses its faces', () => {
        const world = new VoxelWorld();
        const center = new VoxelChunk0(MortonKey.from(4, 4, 4));

        fillChunk(center);
        world.insert(center);

        // nothing in the own world, so every face would be visible
        const bare = new VoxelFaceGeometry();
        bare.computeIndices(center, world);

        expect(bare.popCount()).toEqual(6 * 16 * 16);

        // an occluder world that is solid all around the center hides all of them
        const occluders = new VoxelWorld();

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const chunk = new VoxelChunk0(MortonKey.from(4 + dx, 4 + dy, 4 + dz));

                    fillChunk(chunk);
                    occluders.insert(chunk);
                }
            }
        }

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(center, world, occluders);

        expect(geometry.popCount()).toEqual(0);
        expect(geometry.touchedCount).toEqual(0);
    });

    it('.computeIndices() - an empty chunk emits nothing regardless of neighbours', () => {
        const world = new VoxelWorld();
        const center = new VoxelChunk0(MortonKey.from(4, 4, 4));

        world.insert(center);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) {
                        continue;
                    }

                    const chunk = new VoxelChunk0(MortonKey.from(4 + dx, 4 + dy, 4 + dz));

                    fillChunk(chunk);
                    world.insert(chunk);
                }
            }
        }

        expect(center.isEmpty).toEqual(true);

        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(center, world);

        expect(geometry.popCount()).toEqual(0);
        expect(geometry.touchedCount).toEqual(0);
    });
});
