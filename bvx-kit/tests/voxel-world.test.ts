import { describe, expect, it } from '@jest/globals';
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { MortonKey } from "../src/lib/math/morton-key.js";

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('VoxelWorld', () => {

    const def = new VoxelChunk32(MortonKey.from(0, 0, 0));

    it('.insert() .get() .getOpt() .remove() - ensure can insert and get and remove properly', () => {
        const world = new VoxelWorld();

        // try and get empty items, should be nulls
        expect(world.get(MortonKey.from(1, 1, 1))).toBe(null);
        expect(world.get(MortonKey.from(2, 2, 2))).toBe(null);
        expect(world.get(MortonKey.from(3, 3, 3))).toBe(null);
        expect(world.get(MortonKey.from(4, 4, 4))).toBe(null);

        // generate dummy VoxelChunks to insert
        const one = new VoxelChunk32(MortonKey.from(1, 1, 1));
        const two = new VoxelChunk32(MortonKey.from(2, 2, 2));
        const three = new VoxelChunk32(MortonKey.from(3, 3, 3));
        const four = new VoxelChunk32(MortonKey.from(4, 4, 4));

        // insert items
        world.insert(one);
        world.insert(two);
        world.insert(three);
        world.insert(four);

        // try and get the items
        const oneg = world.get(MortonKey.from(1, 1, 1));
        const twog = world.get(MortonKey.from(2, 2, 2));
        const threeg = world.get(MortonKey.from(3, 3, 3));
        const fourg = world.get(MortonKey.from(4, 4, 4));

        // ensure instances returned are not null
        expect(oneg).not.toBe(null);
        expect(twog).not.toBe(null);
        expect(threeg).not.toBe(null);
        expect(fourg).not.toBe(null);

        // ensure correct instances are returned
        expect(one.cmp(oneg)).toBe(true);
        expect(two.cmp(twog)).toBe(true);
        expect(three.cmp(threeg)).toBe(true);
        expect(four.cmp(fourg)).toBe(true);

        // try and get the items using getopt
        const onegdf = world.getOpt(MortonKey.from(1, 1, 1), def);
        const twogdf = world.getOpt(MortonKey.from(2, 2, 2), def);
        const threegdf = world.getOpt(MortonKey.from(3, 3, 3), def);
        const fourgdf = world.getOpt(MortonKey.from(4, 4, 4), def);

        // ensure correct instances are returned
        expect(one.cmp(onegdf)).toBe(true);
        expect(two.cmp(twogdf)).toBe(true);
        expect(three.cmp(threegdf)).toBe(true);
        expect(four.cmp(fourgdf)).toBe(true);

        // make sure returned instances do not match the default
        expect(def.cmp(onegdf)).toBe(false);
        expect(def.cmp(twogdf)).toBe(false);
        expect(def.cmp(threegdf)).toBe(false);
        expect(def.cmp(fourgdf)).toBe(false);

        // expect the removal of these items to be true
        expect(world.remove(MortonKey.from(1, 1, 1))).toBe(true);
        expect(world.remove(MortonKey.from(2, 2, 2))).toBe(true);
        expect(world.remove(MortonKey.from(3, 3, 3))).toBe(true);
        expect(world.remove(MortonKey.from(4, 4, 4))).toBe(true);

        // try and get empty items, should be nulls after removal
        expect(world.get(MortonKey.from(1, 1, 1))).toBe(null);
        expect(world.get(MortonKey.from(2, 2, 2))).toBe(null);
        expect(world.get(MortonKey.from(3, 3, 3))).toBe(null);
        expect(world.get(MortonKey.from(4, 4, 4))).toBe(null);

        // try and get defaults - should match defaults
        const onegd = world.getOpt(MortonKey.from(1, 1, 1), def);
        const twogd = world.getOpt(MortonKey.from(2, 2, 2), def);
        const threegd = world.getOpt(MortonKey.from(3, 3, 3), def);
        const fourgd = world.getOpt(MortonKey.from(4, 4, 4), def);

        // ensure instances returned are not null
        expect(onegd).not.toBe(null);
        expect(twogd).not.toBe(null);
        expect(threegd).not.toBe(null);
        expect(fourgd).not.toBe(null);

        // ensure correct instances are returned
        expect(def.cmp(onegd)).toBe(true);
        expect(def.cmp(twogd)).toBe(true);
        expect(def.cmp(threegd)).toBe(true);
        expect(def.cmp(fourgd)).toBe(true);

        // ensure null is handled properly
        expect(def.cmp(null)).toBe(false);
    });

    it('.constructor() - takes a bucket count for a small world', () => {
        // The 27-chunk neighbourhood a mesh request binds pays for the default 256
        // buckets and uses none of them.
        const small = new VoxelWorld(32);

        expect(small.chunks.size).toEqual(32);

        const big = new VoxelWorld();

        expect(big.chunks.size).toEqual(256);

        // a small world still indexes correctly
        for (let i = 0; i < 27; i++) {
            small.insert(new VoxelChunk32(MortonKey.from(i, i >> 1, i >> 2)));
        }

        expect(small.get(MortonKey.from(5, 2, 1))).not.toBeNull();
    });

    it('.clear() - drops every chunk and keeps the index usable', () => {
        const world = new VoxelWorld(16);

        for (let i = 0; i < 12; i++) {
            world.insert(new VoxelChunk32(MortonKey.from(i, 0, 0)));
        }

        expect(world.chunks.length).toEqual(12);

        world.clear();

        expect(world.chunks.length).toEqual(0);
        expect(world.get(MortonKey.from(3, 0, 0))).toBeNull();

        world.insert(new VoxelChunk32(MortonKey.from(7, 0, 0)));

        expect(world.chunks.length).toEqual(1);
        expect(world.get(MortonKey.from(7, 0, 0))).not.toBeNull();
    });

});