import { describe, expect, it } from '@jest/globals';
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelRay } from "../src/lib/engine/raycaster/voxel-ray.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { WorldIndex } from "../src/lib/engine/world-index.js";

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('VoxelRaycaster', () => {
    const index = VoxelIndex.from(1, 1, 1, 1, 1, 1);

    const chunk = new VoxelChunk32(MortonKey.from(0, 0, 0));
    const world = new VoxelWorld();
    world.insert(chunk);

    // we will test raycast against this bitvoxel
    chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));

    it('.raycast() - nx -> px traversal success', () => {
        const ray = new VoxelRay().set(-16, 5, 5, 16, 5, 5);

        const result = world.raycaster.raycast(ray, new WorldIndex());

        expect(result).not.toBe(null);

        if (result) {
            expect(index.cmp(result.voxelIndex)).toBe(true);
        }
    });

    it('.raycast() - px -> nx traversal success', () => {
        const ray = new VoxelRay().set(16, 5, 5, -16, 5, 5);

        const result = world.raycaster.raycast(ray, new WorldIndex());

        expect(result).not.toBe(null);

        if (result) {
            expect(index.cmp(result.voxelIndex)).toBe(true);
        }
    });

    it('.raycast() - ny -> py traversal success', () => {
        const ray = new VoxelRay().set(5, -16, 5, 5, 16, 5);

        const result = world.raycaster.raycast(ray, new WorldIndex());

        expect(result).not.toBe(null);

        if (result) {
            expect(index.cmp(result.voxelIndex)).toBe(true);
        }
    });

    it('.raycast() - py -> ny traversal success', () => {
        const ray = new VoxelRay().set(5, 16, 5, 5, -16, 5);

        const result = world.raycaster.raycast(ray, new WorldIndex());

        expect(result).not.toBe(null);

        if (result) {
            expect(index.cmp(result.voxelIndex)).toBe(true);
        }
    });

    it('.raycast() - nz -> pz traversal success', () => {
        const ray = new VoxelRay().set(5, 5, -16, 5, 5, 16);

        const result = world.raycaster.raycast(ray, new WorldIndex());

        expect(result).not.toBe(null);

        if (result) {
            expect(index.cmp(result.voxelIndex)).toBe(true);
        }
    });

    it('.raycast() - pz -> nz traversal success', () => {
        const ray = new VoxelRay().set(5, 5, 16, 5, 5, -16);

        const result = world.raycaster.raycast(ray, new WorldIndex());

        expect(result).not.toBe(null);

        if (result) {
            expect(index.cmp(result.voxelIndex)).toBe(true);
        }
    });

    it('.raycast() - nx -> px traversal miss', () => {
        const ray = new VoxelRay().set(-16, 4, 4, 16, 4, 4);

        const result = world.raycaster.raycast(ray);

        expect(result).toBe(null);
    });

    it('.raycast() - ny -> py traversal miss', () => {
        const ray = new VoxelRay().set(4, -16, 4, 4, 16, 4);

        const result = world.raycaster.raycast(ray);

        expect(result).toBe(null);
    });

    it('.raycast() - nz -> pz traversal miss', () => {
        const ray = new VoxelRay().set(4, 4, -16, 4, 4, 16);

        const result = world.raycaster.raycast(ray, new WorldIndex());

        expect(result).toBe(null);
    });
});