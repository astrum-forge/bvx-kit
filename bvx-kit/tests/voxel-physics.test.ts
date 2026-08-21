import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { VoxelPhysics } from "../src/lib/engine/physics/voxel-physics.js";
import { VoxelPhysicsLayer } from "../src/lib/engine/physics/voxel-physics-layer.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { BVXSerializer } from "../src/lib/serialize/bvx-serializer.js";

/**
 * Provides coverage for voxel-physics.ts, voxel-physics-layer.ts and
 * physics-voxel-chunk.ts
 */
describe('VoxelPhysics', () => {

    /**
     * Small bounded simulation over an empty base world.
     */
    const makePhysics = (base: VoxelWorld = new VoxelWorld()) => {
        return new VoxelPhysics(base, { maxX: 63, maxY: 63, maxZ: 63 });
    };

    /**
     * Sets a solid BitVoxel in the base world at global BitVoxel coordinates,
     * creating the chunk on demand.
     */
    const setBase = (base: VoxelWorld, x: number, y: number, z: number): void => {
        const key = MortonKey.from(x >> 4, y >> 4, z >> 4);
        let chunk = base.get(key);

        if (chunk === null) {
            chunk = new VoxelChunk0(key);
            base.insert(chunk);
        }

        chunk.setBitVoxel(VoxelIndex.from((x & 15) >> 2, (y & 15) >> 2, (z & 15) >> 2, x & 3, y & 3, z & 3));
    };

    /**
     * Collects all grain coordinates of a layer within a small scan region.
     */
    const collect = (layer: VoxelPhysicsLayer, max = 64): [number, number, number][] => {
        const grains: [number, number, number][] = [];

        for (let x = 0; x < max; x++) {
            for (let y = 0; y < max; y++) {
                for (let z = 0; z < max; z++) {
                    if (layer.get(x, y, z) === 1) {
                        grains.push([x, y, z]);
                    }
                }
            }
        }

        return grains;
    };

    it('.update() - grains fall one cell per tick and rest on the floor', () => {
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        sand.set(8, 5, 8);

        // one cell per tick
        physics.update();
        expect(sand.get(8, 4, 8)).toEqual(1);
        expect(sand.get(8, 5, 8)).toEqual(0);

        // run to the floor (minY = 0) and settle
        physics.update(10);

        expect(sand.get(8, 0, 8)).toEqual(1);
        expect(sand.length).toEqual(1);
        expect(sand.activeCount).toEqual(0);

        // a dormant simulation performs no moves
        expect(physics.update()).toEqual(0);
    });

    it('.update() - a falling column compacts together within a single tick', () => {
        const physics = makePhysics();

        // disable slide so the column stays a column
        const dirt = physics.addLayer({ slide: false });

        for (let y = 2; y <= 6; y++) {
            dirt.set(8, y, 8);
        }

        physics.update();

        // every grain moved down one cell in the same tick
        for (let y = 1; y <= 5; y++) {
            expect(dirt.get(8, y, 8)).toEqual(1);
        }

        expect(dirt.get(8, 6, 8)).toEqual(0);
        expect(dirt.length).toEqual(5);
    });

    it('.update() - grains rest on base world geometry', () => {
        const base = new VoxelWorld();

        setBase(base, 8, 3, 8);

        const physics = makePhysics(base);
        const sand = physics.addLayer({ slide: false });

        sand.set(8, 8, 8);
        physics.update(20);

        // resting directly on top of the base voxel
        expect(sand.get(8, 4, 8)).toEqual(1);
        expect(sand.activeCount).toEqual(0);
    });

    it('.update() - sliding grains form piles', () => {
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        // drop a stack of grains onto the same column
        for (let y = 4; y <= 8; y++) {
            sand.set(8, y, 8);
        }

        physics.update(30);

        const grains = collect(sand);

        // nothing lost and everything settled
        expect(grains.length).toEqual(5);
        expect(sand.activeCount).toEqual(0);

        // a pile is at most 2 tall - a grain 2 above the floor always has a
        // diagonal escape when only 5 grains are present
        for (const [, y] of grains) {
            expect(y).toBeLessThanOrEqual(1);
        }
    });

    it('.update() - water flows toward drop-offs and pools go dormant', () => {
        const base = new VoxelWorld();

        // a raised 4x1x4 platform at y = 2 with open edges
        for (let x = 6; x <= 9; x++) {
            for (let z = 6; z <= 9; z++) {
                setBase(base, x, 2, z);
            }
        }

        const physics = makePhysics(base);
        const water = physics.addLayer(VoxelPhysics.WATER);

        // pour a stack of water onto the platform center
        for (let y = 5; y <= 8; y++) {
            water.set(7, y, 7);
        }

        physics.update(60);

        const grains = collect(water);

        // all water flowed off the platform and rests on the floor
        expect(grains.length).toEqual(4);
        expect(water.activeCount).toEqual(0);

        for (const [, y] of grains) {
            expect(y).toEqual(0);
        }
    });

    it('.update() - water levels out inside a container and goes dormant', () => {
        const base = new VoxelWorld();

        // a closed 6x6 basin with walls at y = 0..3
        for (let x = 4; x <= 11; x++) {
            for (let z = 4; z <= 11; z++) {
                const isWall = x === 4 || x === 11 || z === 4 || z === 11;

                if (isWall) {
                    for (let y = 0; y <= 3; y++) {
                        setBase(base, x, y, z);
                    }
                }
            }
        }

        const physics = makePhysics(base);
        const water = physics.addLayer(VoxelPhysics.WATER);

        // pour a 36-grain column into one corner of the basin - exactly one
        // 6x6 layer of water once levelled
        for (let y = 4; y < 40; y++) {
            water.set(5, y, 5);
        }

        physics.update(200);

        const grains = collect(water);

        expect(grains.length).toEqual(36);
        expect(water.activeCount).toEqual(0);

        // a perfectly levelled pool - every grain on the basin floor
        for (const [x, y, z] of grains) {
            expect(y).toEqual(0);
            expect(x).toBeGreaterThanOrEqual(5);
            expect(x).toBeLessThanOrEqual(10);
            expect(z).toBeGreaterThanOrEqual(5);
            expect(z).toBeLessThanOrEqual(10);
        }
    });

    it('.update() - dense grains sink through lighter liquid layers', () => {
        const base = new VoxelWorld();

        // a sealed 1x1 well so nothing can slide or flow away
        for (let y = 0; y <= 4; y++) {
            setBase(base, 7, y, 8);
            setBase(base, 9, y, 8);
            setBase(base, 8, y, 7);
            setBase(base, 8, y, 9);
        }

        const physics = makePhysics(base);
        const sand = physics.addLayer(VoxelPhysics.SAND);
        const water = physics.addLayer(VoxelPhysics.WATER);

        // two water grains at the bottom of the well, sand dropped above
        water.set(8, 0, 8);
        water.set(8, 1, 8);
        sand.set(8, 5, 8);

        physics.update(20);

        // the sand sank to the bottom, displacing the water upward
        expect(sand.get(8, 0, 8)).toEqual(1);
        expect(water.get(8, 1, 8)).toEqual(1);
        expect(water.get(8, 2, 8)).toEqual(1);

        expect(sand.length).toEqual(1);
        expect(water.length).toEqual(2);

        // water never sinks through sand - everything is dormant and stable
        expect(physics.update(5)).toEqual(0);
        expect(sand.get(8, 0, 8)).toEqual(1);
    });

    it('.wakeRegion() - removing base ground wakes resting grains', () => {
        const base = new VoxelWorld();

        setBase(base, 8, 2, 8);

        const physics = makePhysics(base);
        const sand = physics.addLayer({ slide: false });

        sand.set(8, 6, 8);
        physics.update(10);

        // resting on the base voxel, fully dormant
        expect(sand.get(8, 3, 8)).toEqual(1);
        expect(sand.activeCount).toEqual(0);

        // remove the supporting ground - the base world is application-managed,
        // so the application reports the change through wakeRegion
        const chunk = base.get(MortonKey.from(0, 0, 0));
        (chunk as VoxelChunk0).unsetBitVoxel(VoxelIndex.from(2, 0, 2, 0, 2, 0));

        physics.wakeRegion(8, 2, 8, 8, 2, 8);

        expect(sand.activeCount).toEqual(1);

        physics.update(10);

        expect(sand.get(8, 0, 8)).toEqual(1);
        expect(sand.activeCount).toEqual(0);
    });

    it('.update() - grains never leave the simulation bounds', () => {
        const physics = new VoxelPhysics(new VoxelWorld(), { maxX: 15, maxY: 15, maxZ: 15 });
        const water = physics.addLayer(VoxelPhysics.WATER);

        // fill a column on the boundary corner and let it spread
        for (let y = 0; y < 10; y++) {
            water.set(0, y, 0);
        }

        physics.update(100);

        // grains outside the bounds cannot be placed either
        expect(water.set(16, 0, 0)).toBe(false);
        expect(water.set(-1, 0, 0)).toBe(false);

        const grains = collect(water, 32);

        expect(grains.length).toEqual(10);

        for (const [x, y, z] of grains) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(15);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThanOrEqual(15);
            expect(z).toBeGreaterThanOrEqual(0);
            expect(z).toBeLessThanOrEqual(15);
        }
    });

    it('.drainDirtyChunks() - reports chunks whose contents changed', () => {
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        // a grain about to fall across the chunk boundary at y = 16
        sand.set(8, 16, 8);
        sand.drainDirtyChunks();

        physics.update();

        const dirty = sand.drainDirtyChunks();

        // both the source chunk (0,1,0) and target chunk (0,0,0) are dirty
        expect(dirty.has(MortonKey.from(0, 1, 0).key)).toBe(true);
        expect(dirty.has(MortonKey.from(0, 0, 0).key)).toBe(true);

        // draining clears the set
        expect(sand.drainDirtyChunks().size).toEqual(0);
    });

    it('.unset() - removes grains and wakes the surroundings', () => {
        const physics = makePhysics();
        const sand = physics.addLayer({ slide: false });

        // a settled 2-grain column
        sand.set(8, 0, 8);
        sand.set(8, 1, 8);
        physics.update(5);

        expect(sand.activeCount).toEqual(0);

        // removing the bottom grain wakes the one above, which then falls
        expect(sand.unset(8, 0, 8)).toBe(true);
        expect(sand.unset(8, 0, 8)).toBe(false);

        physics.update(5);

        expect(sand.get(8, 0, 8)).toEqual(1);
        expect(sand.length).toEqual(1);
    });

    it('.update() - simulations are deterministic', () => {
        const build = () => {
            const physics = makePhysics();
            const sand = physics.addLayer(VoxelPhysics.SAND);
            const water = physics.addLayer(VoxelPhysics.WATER);

            for (let i = 0; i < 20; i++) {
                sand.set(6 + (i % 5), 10 + i, 8);
                water.set(8, 12 + i, 6 + (i % 5));
            }

            physics.update(40);

            return { sand: collect(sand), water: collect(water) };
        };

        const first = build();
        const second = build();

        expect(second.sand).toEqual(first.sand);
        expect(second.water).toEqual(first.water);
    });

    it('.world - layer worlds mesh with the existing geometry generators', () => {
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        sand.set(8, 0, 8);
        sand.set(8, 1, 8);
        physics.update(5);

        const geometry = new VoxelFaceGeometry();
        const chunk = sand.world.get(MortonKey.from(0, 0, 0));

        expect(chunk).not.toBeNull();

        geometry.computeIndices(chunk as VoxelChunk0, sand.world);

        // two stacked grains sharing one face - 10 visible faces
        expect(geometry.popCount()).toEqual(10);
    });

    it('.importWorld() .clear() - serialization round-trip through BVXSerializer', () => {
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        for (let i = 0; i < 10; i++) {
            sand.set(4 + i, 6 + i, 8);
        }

        physics.update(3);

        const before = collect(sand);
        const data = BVXSerializer.saveWorld(sand.world);

        // restore into a fresh simulation - grains wake and keep simulating
        const restoredPhysics = makePhysics();
        const restored = restoredPhysics.addLayer(VoxelPhysics.SAND);

        restored.importWorld(BVXSerializer.loadWorld(data));

        expect(collect(restored)).toEqual(before);
        expect(restored.activeCount).toEqual(restored.length);

        restoredPhysics.update(30);

        expect(restored.length).toEqual(10);
        expect(restored.activeCount).toEqual(0);

        // clearing removes all grains and reports the chunks as dirty
        restored.drainDirtyChunks();
        restored.clear();

        expect(restored.length).toEqual(0);
        expect(restored.drainDirtyChunks().size).toBeGreaterThan(0);
        expect(restoredPhysics.update()).toEqual(0);
    });

    it('.update() - empty chunks are removed once dormant', () => {
        const physics = makePhysics();
        const sand = physics.addLayer({ slide: false });

        // a grain high up falls through chunk (0,2,0) and (0,1,0) to the floor
        sand.set(8, 40, 8);
        physics.update(60);

        expect(sand.get(8, 0, 8)).toEqual(1);

        // the transit chunks emptied out and were removed from the world
        expect(sand.world.get(MortonKey.from(0, 2, 0))).toBeNull();
        expect(sand.world.get(MortonKey.from(0, 1, 0))).toBeNull();
        expect(sand.world.get(MortonKey.from(0, 0, 0))).not.toBeNull();
    });
});
