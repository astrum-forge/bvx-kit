import { describe, expect, it } from '@jest/globals';
import { BitArray } from "../src/lib/containers/bit-array.js";
import { BVXLayer } from "../src/lib/engine/layer/bvx-layer.js";
import { VoxelChunk } from "../src/lib/engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelChunk8 } from "../src/lib/engine/chunks/voxel-chunk-8.js";
import { VoxelChunk16 } from "../src/lib/engine/chunks/voxel-chunk-16.js";
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelChunkArena } from "../src/lib/engine/chunks/voxel-chunk-arena.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { MortonKey } from "../src/lib/math/morton-key.js";

/**
 * Provides coverage for voxel-chunk-arena.ts and the injected-buffer paths of
 * bit-array.ts, bvx-layer.ts and the VoxelChunk types.
 */
describe('VoxelChunkArena', () => {

    it('.byteLengthFor() - sizes both regions', () => {
        expect(VoxelChunkArena.byteLengthFor(1, 0)).toEqual(512);
        expect(VoxelChunkArena.byteLengthFor(4, 0)).toEqual(4 * 512);
        expect(VoxelChunkArena.byteLengthFor(4, VoxelChunk16.META_BYTE_LENGTH)).toEqual((4 * 512) + (4 * 128));
    });

    it('.constructor() - rejects an invalid shape or an undersized buffer', () => {
        expect(() => new VoxelChunkArena(0, 0)).toThrow(Error);
        expect(() => new VoxelChunkArena(-1, 0)).toThrow(Error);
        expect(() => new VoxelChunkArena(4, 3)).toThrow(Error);
        expect(() => new VoxelChunkArena(4, -4)).toThrow(Error);
        expect(() => new VoxelChunkArena(4, 0, new ArrayBuffer(16))).toThrow(RangeError);

        // exactly the required size is accepted
        const exact = VoxelChunkArena.byteLengthFor(4, 128);

        expect(() => new VoxelChunkArena(4, 128, new ArrayBuffer(exact))).not.toThrow();
    });

    it('.allocate() - hands out slots, recycles released ones and reports full', () => {
        const arena = new VoxelChunkArena(3, 0);

        expect(arena.capacity).toEqual(3);
        expect(arena.length).toEqual(0);
        expect(arena.available).toEqual(3);

        const a = arena.allocate();
        const b = arena.allocate();
        const c = arena.allocate();

        expect(a).toEqual(0);
        expect(b).toEqual(1);
        expect(c).toEqual(2);
        expect(arena.length).toEqual(3);
        expect(arena.allocate()).toEqual(-1);

        arena.release(b);

        expect(arena.length).toEqual(2);
        expect(arena.allocate()).toEqual(b);

        expect(() => arena.release(-1)).toThrow(RangeError);
        expect(() => arena.release(3)).toThrow(RangeError);
        expect(() => arena.storageAt(3)).toThrow(RangeError);
    });

    it('.storageAt() - slots do not overlap for any chunk type', () => {
        const widths: number[] = [0, VoxelChunk8.META_BYTE_LENGTH, VoxelChunk16.META_BYTE_LENGTH, VoxelChunk32.META_BYTE_LENGTH];

        for (const width of widths) {
            const capacity = 5;
            const arena = new VoxelChunkArena(capacity, width);

            for (let slot = 0; slot < capacity; slot++) {
                const storage = arena.storageAt(slot);

                // occupancy region: aligned, in range, and disjoint from the next slot
                expect(storage.layerByteOffset % 4).toEqual(0);
                expect(storage.layerByteOffset).toEqual(slot * BVXLayer.BYTE_LENGTH);
                expect(storage.layerByteOffset + BVXLayer.BYTE_LENGTH).toBeLessThanOrEqual(arena.buffer.byteLength);

                // meta region: starts after every occupancy slot, aligned for a Uint32 view
                if (width > 0) {
                    expect(storage.metaByteOffset % 4).toEqual(0);
                    expect(storage.metaByteOffset).toBeGreaterThanOrEqual(capacity * BVXLayer.BYTE_LENGTH);
                    expect(storage.metaByteOffset + width).toBeLessThanOrEqual(arena.buffer.byteLength);
                }
            }
        }
    });

    it('.build() - arena chunks behave exactly like self-allocating ones', () => {
        const arena = new VoxelChunkArena(4, VoxelChunk16.META_BYTE_LENGTH);

        const owned = new VoxelChunk16(MortonKey.from(1, 2, 3));
        const viewed = arena.build(arena.allocate(), storage => new VoxelChunk16(MortonKey.from(1, 2, 3), storage));

        const index = VoxelIndex.from(1, 2, 3, 0, 1, 2);

        for (const chunk of [owned, viewed]) {
            chunk.setBitVoxel(index);
            chunk.setMetaData(index, 4242);
        }

        expect(viewed.getBitVoxel(index)).toEqual(owned.getBitVoxel(index));
        expect(viewed.getMetaData(index)).toEqual(owned.getMetaData(index));
        expect(viewed.length).toEqual(owned.length);
        expect(viewed.metaBits).toEqual(16);
        expect(viewed.layer.bitArray.byteLength).toEqual(BVXLayer.BYTE_LENGTH);
    });

    it('.build() - neighbouring slots do not alias each other', () => {
        const arena = new VoxelChunkArena(2, VoxelChunk32.META_BYTE_LENGTH);

        const first = arena.build(arena.allocate(), s => new VoxelChunk32(MortonKey.from(0, 0, 0), s));
        const second = arena.build(arena.allocate(), s => new VoxelChunk32(MortonKey.from(1, 0, 0), s));

        // fill the first slot completely, in both regions
        for (let i = 0; i < first.layer.bitArray.elements.length; i++) {
            first.layer.bitArray.elements[i] = 0xFFFFFFFF;
        }

        for (let v = 0; v < VoxelChunk.SIZE; v++) {
            first.setMetaData(new VoxelIndex(v << 6), 0xDEADBEEF);
        }

        expect(first.isFull).toEqual(true);
        expect(second.isEmpty).toEqual(true);
        expect(second.length).toEqual(0);

        for (let v = 0; v < VoxelChunk.SIZE; v++) {
            expect(second.getMetaData(new VoxelIndex(v << 6))).toEqual(0);
        }
    });

    it('.clear() - zeroes a recycled slot in both regions', () => {
        const arena = new VoxelChunkArena(1, VoxelChunk8.META_BYTE_LENGTH);
        const slot = arena.allocate();

        const before = arena.build(slot, s => new VoxelChunk8(MortonKey.from(0, 0, 0), s));
        const index = VoxelIndex.from(0, 0, 0, 1, 1, 1);

        before.setBitVoxel(index);
        before.setMetaData(index, 200);

        arena.release(slot);
        arena.clear(slot);

        const after = arena.build(arena.allocate(), s => new VoxelChunk8(MortonKey.from(9, 9, 9), s));

        expect(after.getBitVoxel(index)).toEqual(0);
        expect(after.getMetaData(index)).toEqual(0);
        expect(after.isEmpty).toEqual(true);
    });

    it('- a second set of views over the same buffer sees live writes', () => {
        // This is the mechanism a worker relies on: given the arena's buffer and the
        // slot assignment, it rebuilds chunk views that address the same memory rather
        // than decoding a snapshot into fresh objects.
        const arena = new VoxelChunkArena(8, VoxelChunk16.META_BYTE_LENGTH);
        const slots = new Map<number, number>();

        const writerWorld = new VoxelWorld();

        for (let x = 0; x < 3; x++) {
            const key = MortonKey.from(x, 0, 0);
            const slot = arena.allocate();

            slots.set(key.key, slot);
            writerWorld.insert(arena.build(slot, s => new VoxelChunk16(key.clone(), s)));
        }

        // the "worker" side - same buffer, same slot assignment, independent objects
        const readerArena = new VoxelChunkArena(8, VoxelChunk16.META_BYTE_LENGTH, arena.buffer);
        const readerWorld = new VoxelWorld();

        for (const [encoded, slot] of slots) {
            readerWorld.insert(readerArena.build(slot, s => new VoxelChunk16(new MortonKey(encoded), s)));
        }

        const writer = writerWorld.get(MortonKey.from(1, 0, 0)) as VoxelChunk16;
        const reader = readerWorld.get(MortonKey.from(1, 0, 0)) as VoxelChunk16;

        expect(reader).not.toBe(writer);
        expect(reader.length).toEqual(0);

        // a write on one side is visible on the other with no message passing
        const index = VoxelIndex.from(2, 2, 2, 1, 1, 1);

        writer.setBitVoxel(index);
        writer.setMetaData(index, 777);

        expect(reader.getBitVoxel(index)).toEqual(1);
        expect(reader.getMetaData(index)).toEqual(777);

        // and the reader's world meshes from that live state
        const geometry = new VoxelFaceGeometry();
        geometry.computeIndices(reader, readerWorld);

        expect(geometry.popCount()).toEqual(6);
    });

    it('.isShared - reports what actually backs the arena', () => {
        expect(new VoxelChunkArena(2, 0).isShared).toEqual(false);

        // SharedArrayBuffer is gated behind cross-origin isolation in browsers, so the
        // arena must work either way and report which it got
        if (typeof SharedArrayBuffer !== "undefined") {
            const shared = new SharedArrayBuffer(VoxelChunkArena.byteLengthFor(2, 0));
            const arena = new VoxelChunkArena(2, 0, shared);

            expect(arena.isShared).toEqual(true);

            const chunk = arena.build(arena.allocate(), s => new VoxelChunk0(MortonKey.from(0, 0, 0), s));
            const index = VoxelIndex.from(0, 0, 0, 0, 0, 0);

            chunk.setBitVoxel(index);

            expect(chunk.getBitVoxel(index)).toEqual(1);
            expect(chunk.layer.bitArray.buffer).toBe(shared);
        }
    });
});

/**
 * Provides coverage for the injected-buffer constructor of bit-array.ts
 */
describe('BitArray injected storage', () => {

    it('.constructor() - views the provided buffer at the provided offset', () => {
        const buffer = new ArrayBuffer(64);
        const first = new BitArray(4, buffer, 0);
        const second = new BitArray(4, buffer, 16);

        expect(first.buffer).toBe(buffer);
        expect(first.byteOffset).toEqual(0);
        expect(first.byteLength).toEqual(16);
        expect(second.byteOffset).toEqual(16);

        first.setBitAt(0);

        expect(second.bitAt(0)).toEqual(0);

        second.setBitAt(0);

        expect(new Uint32Array(buffer)[0]).toEqual(1);
        expect(new Uint32Array(buffer)[4]).toEqual(1);
    });

    it('.constructor() - rejects misalignment and overruns', () => {
        const buffer = new ArrayBuffer(64);

        expect(() => new BitArray(4, buffer, 2)).toThrow(Error);
        expect(() => new BitArray(4, buffer, 52)).toThrow(RangeError);
        expect(() => new BitArray(4, buffer, -4)).toThrow(RangeError);
        expect(() => new BitArray(17, buffer, 0)).toThrow(RangeError);
    });

    it('.uniformState() - reports empty, full and mixed', () => {
        const empty = new BitArray(4);

        expect(empty.uniformState).toEqual(BitArray.EMPTY);

        const full = new BitArray(4);

        full.elements.fill(0xFFFFFFFF);

        expect(full.uniformState).toEqual(BitArray.FULL);

        // a single set bit anywhere breaks uniformity, including in the last element
        const mixedEarly = new BitArray(4);

        mixedEarly.setBitAt(0);

        expect(mixedEarly.uniformState).toEqual(BitArray.MIXED);

        const mixedLate = new BitArray(4);

        mixedLate.elements.fill(0xFFFFFFFF);
        mixedLate.unsetBitAt(127);

        expect(mixedLate.uniformState).toEqual(BitArray.MIXED);
    });
});
