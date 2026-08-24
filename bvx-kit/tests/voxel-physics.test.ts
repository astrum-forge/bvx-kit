import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { VoxelChunkArena } from "../src/lib/engine/chunks/voxel-chunk-arena.js";
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
        expect(physics.update().moves).toEqual(0);
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
        expect(physics.update(5).moves).toEqual(0);
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
        expect(restoredPhysics.update().moves).toEqual(0);
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
    /**
     * Fills a layer with a wide slab of grains that all want to move, spanning
     * enough chunks that a budget can cut the sweep part way through.
     */
    const fillSlab = (layer: VoxelPhysicsLayer): void => {
        for (let x = 0; x < 32; x++) {
            for (let z = 0; z < 32; z++) {
                for (let y = 40; y < 48; y++) {
                    layer.set(x, y, z);
                }
            }
        }
    };

    /**
     * Every set BitVoxel of a layer, as a sorted list of encoded coordinates. Two
     * simulations agree exactly when these agree.
     */
    const snapshot = (layer: VoxelPhysicsLayer): string => {
        const cells: number[] = [];

        for (let x = 0; x < 48; x++) {
            for (let y = 0; y < 56; y++) {
                for (let z = 0; z < 48; z++) {
                    if (layer.get(x, y, z) !== 0) {
                        cells.push((x * 100000) + (y * 100) + z);
                    }
                }
            }
        }

        return cells.sort((a, b) => a - b).join(",");
    };

    it('.update() - a work budget bounds the probes and defers the rest', () => {
        const reference = makePhysics();
        const referenceSand = reference.addLayer(VoxelPhysics.SAND);

        fillSlab(referenceSand);

        const unbudgeted = reference.update();

        expect(unbudgeted.complete).toEqual(true);
        expect(unbudgeted.work).toBeGreaterThan(1000);
        expect(unbudgeted.moves).toBeGreaterThan(1000);

        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        fillSlab(sand);

        const total = sand.length;
        const limit = 500;

        const budgeted = physics.update(1, limit);

        expect(budgeted.complete).toEqual(false);
        expect(physics.tickInProgress).toEqual(true);
        expect(budgeted.ticks).toEqual(0);
        expect(budgeted.work).toBeLessThan(unbudgeted.work);

        // The cap is honoured to within one y-plane of a chunk, which is where the
        // sweep checks it - not to the exact probe. A plane's work includes the wake
        // visits its moves trigger (they are cells examined like any other), so the
        // overshoot is bounded by a plane's full cost rather than its probe count.
        expect(budgeted.work).toBeGreaterThanOrEqual(limit);
        expect(budgeted.work).toBeLessThan(limit * 8);

        // no grain is lost or duplicated by stopping mid-chunk
        expect(sand.length).toEqual(total);

        // the tick counter has not moved, because the tick has not finished
        expect(physics.tick).toEqual(0);
    });

    it('.update() - a budget changes the pacing and nothing else', () => {
        // This is the property the resumable sweep exists to provide: a tick either
        // completes or is continued, never partially applied and abandoned. So the
        // world after N completed ticks must be identical no matter how many calls it
        // took to get there.
        const run = (maxWork: number, targetTicks: number): string => {
            const physics = makePhysics();
            const sand = physics.addLayer(VoxelPhysics.SAND);
            const water = physics.addLayer(VoxelPhysics.WATER);

            for (let x = 0; x < 12; x++) {
                for (let z = 0; z < 12; z++) {
                    for (let y = 30; y < 34; y++) {
                        sand.set(x, y, z);
                    }

                    for (let y = 34; y < 38; y++) {
                        water.set(x, y, z);
                    }
                }
            }

            let guard = 0;

            while (physics.tick < targetTicks && guard < 100000) {
                physics.update(1, maxWork);
                guard++;
            }

            expect(physics.tick).toEqual(targetTicks);
            expect(physics.tickInProgress).toEqual(false);

            return `${snapshot(sand)}|${snapshot(water)}`;
        };

        const free = run(0, 40);

        expect(run(1, 40)).toEqual(free);
        expect(run(37, 40)).toEqual(free);
        expect(run(500, 40)).toEqual(free);
        expect(run(100000, 40)).toEqual(free);
    });

    it('.update() - a budget of zero or less is unlimited', () => {
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        for (let x = 0; x < 8; x++) {
            for (let z = 0; z < 8; z++) {
                sand.set(x, 30, z);
            }
        }

        const result = physics.update(1, 0);

        expect(result.moves).toEqual(64);
        expect(result.ticks).toEqual(1);
        expect(result.complete).toEqual(true);
        expect(physics.tickInProgress).toEqual(false);
    });

    it('.update() - a budgeted simulation still settles, over more calls', () => {
        const settle = (maxWork: number): { grains: number, calls: number, ticks: number, aloft: number } => {
            const physics = makePhysics();
            const sand = physics.addLayer(VoxelPhysics.SAND);

            for (let x = 0; x < 8; x++) {
                for (let z = 0; z < 8; z++) {
                    for (let y = 20; y < 26; y++) {
                        sand.set(x, y, z);
                    }
                }
            }

            let calls = 0;

            while ((sand.activeCount > 0 || physics.tickInProgress) && calls < 20000) {
                physics.update(1, maxWork);
                calls++;
            }

            let aloft = 0;

            for (let x = 0; x < 32; x++) {
                for (let z = 0; z < 32; z++) {
                    for (let y = 8; y < 40; y++) {
                        aloft += sand.get(x, y, z);
                    }
                }
            }

            return { grains: sand.grainCount, calls: calls, ticks: physics.tick, aloft: aloft };
        };

        const budgeted = settle(200);
        const free = settle(0);

        // Same pile, same grain count, same number of simulation ticks - the budget
        // only changed how many calls it took to run them.
        expect(budgeted.grains).toEqual(free.grains);
        expect(budgeted.ticks).toEqual(free.ticks);
        expect(budgeted.aloft).toEqual(0);
        expect(free.aloft).toEqual(0);

        // and it genuinely took more calls, which is the trade being made
        expect(budgeted.calls).toBeGreaterThan(free.calls);
        expect(budgeted.calls).toBeLessThan(20000);
    });

    it('.update() - a tight budget cannot starve the lighter layer of its tick', () => {
        // The old budget could skip layers that had not yet stepped when it ran out,
        // so a dense layer could spend the whole allowance and leave water - typically
        // the one actually moving - with no tick at all. A resumable tick removes that
        // failure by construction: the tick is not finished until every layer has
        // stepped, so every completed tick is a tick for every layer.
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);
        const water = physics.addLayer(VoxelPhysics.WATER);

        for (let x = 0; x < 24; x++) {
            for (let z = 0; z < 24; z++) {
                for (let y = 30; y < 36; y++) {
                    sand.set(x, y, z);
                }

                for (let y = 36; y < 42; y++) {
                    water.set(x, y, z);
                }
            }
        }

        let completed = 0;
        let waterStepped = 0;
        let calls = 0;

        while (completed < 8 && calls < 20000) {
            const before: number = physics.tick;

            physics.update(1, 400);
            calls++;

            if (water.workPerformed > 0) {
                waterStepped++;
            }

            if (physics.tick !== before) {
                completed++;

                // a completed tick always stepped the water, however tight the budget
                expect(waterStepped).toBeGreaterThanOrEqual(completed);
            }
        }

        expect(completed).toEqual(8);
        expect(calls).toBeGreaterThan(8);
    });

    it('.update() - advances several ticks in one call', () => {
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND);

        for (let x = 0; x < 4; x++) {
            for (let z = 0; z < 4; z++) {
                sand.set(x, 30, z);
            }
        }

        const result = physics.update(5);

        expect(result.ticks).toEqual(5);
        expect(result.complete).toEqual(true);
        expect(physics.tick).toEqual(5);
        expect(sand.get(0, 25, 0)).toEqual(1);
    });

    it('.addLayer() - an arena-backed layer simulates identically and reports its slots', () => {
        const run = (arena: VoxelChunkArena | null): { snapshot: string; slots: number[] } => {
            const physics = makePhysics();
            const sand = physics.addLayer(VoxelPhysics.SAND, arena);

            for (let x = 0; x < 10; x++) {
                for (let z = 0; z < 10; z++) {
                    for (let y = 24; y < 28; y++) {
                        sand.set(x, y, z);
                    }
                }
            }

            for (let i = 0; i < 40; i++) {
                physics.update();
            }

            const cells: number[] = [];

            for (let x = 0; x < 32; x++) {
                for (let y = 0; y < 32; y++) {
                    for (let z = 0; z < 32; z++) {
                        if (sand.get(x, y, z) !== 0) {
                            cells.push((x * 100000) + (y * 100) + z);
                        }
                    }
                }
            }

            const slots: number[] = [];

            for (const chunk of sand.world.chunks.values()) {
                slots.push(sand.slotOf(chunk.key.key));
            }

            return { snapshot: cells.sort((a, b) => a - b).join(","), slots: slots.sort((a, b) => a - b) };
        };

        const arena = new VoxelChunkArena(64, 0);
        const backed = run(arena);
        const owned = run(null);

        // the same simulation, whoever owns the memory
        expect(backed.snapshot).toEqual(owned.snapshot);
        expect(backed.snapshot.length).toBeGreaterThan(0);

        // every live chunk names a distinct arena slot
        expect(backed.slots.length).toBeGreaterThan(0);
        expect(new Set(backed.slots).size).toEqual(backed.slots.length);

        for (const slot of backed.slots) {
            expect(slot).toBeGreaterThanOrEqual(0);
            expect(arena.isAllocated(slot)).toEqual(true);
        }

        // a layer with no arena reports no slots
        expect(owned.slots.every((slot) => slot === -1)).toEqual(true);
    });

    it('.addLayer() - an arena-backed layer releases slots as chunks empty', () => {
        const arena = new VoxelChunkArena(64, 0);
        const physics = makePhysics();
        const sand = physics.addLayer(VoxelPhysics.SAND, arena);

        // a column high in the air: it falls through several chunks and abandons them
        for (let y = 40; y < 48; y++) {
            sand.set(4, y, 4);
        }

        const peak = arena.length;

        expect(peak).toBeGreaterThan(0);

        for (let i = 0; i < 200; i++) {
            physics.update();
        }

        // everything landed in one chunk near the floor, and the chunks it left behind
        // gave their slots back rather than leaking them
        expect(arena.length).toBeLessThan(peak + 1);
        expect(sand.grainCount).toEqual(8);

        sand.clear();

        expect(arena.length).toEqual(0);
    });

});
