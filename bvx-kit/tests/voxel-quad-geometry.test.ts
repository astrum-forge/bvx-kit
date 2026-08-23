import { describe, expect, it } from '@jest/globals';
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelFaceGeometry } from "../src/lib/engine/geometry/voxel-face-geometry.js";
import { VoxelQuadGeometry } from "../src/lib/engine/geometry/voxel-quad-geometry.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";

/**
 * Builds a world holding one chunk at (1,1,1) and returns both.
 */
function makeWorld(): { world: VoxelWorld, chunk: VoxelChunk0 } {
    const world = new VoxelWorld();
    const chunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

    world.insert(chunk);

    return { world: world, chunk: chunk };
}

/**
 * Encodes chunk-local BitVoxel coordinates into a VoxelIndex.
 */
function at(x: number, y: number, z: number): VoxelIndex {
    return new VoxelIndex(((x >> 2) << 10) | ((y >> 2) << 8) | ((z >> 2) << 6) | ((x & 3) << 4) | ((y & 3) << 2) | (z & 3));
}

describe('VoxelQuadGeometry', () => {

    it('.computeQuads() - an empty chunk produces nothing', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        geometry.computeQuads(chunk, world);

        expect(geometry.count).toEqual(0);
        expect(geometry.quads.length).toEqual(0);
    });

    it('.computeQuads() - a lone BitVoxel emits six fully open quads', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        chunk.setBitVoxel(at(5, 5, 5));
        geometry.computeQuads(chunk, world);

        expect(geometry.count).toEqual(6);

        const seen = new Set<number>();

        for (const quad of geometry.quads) {
            const index = VoxelQuadGeometry.indexOf(quad);
            const face = VoxelQuadGeometry.faceOf(quad);

            expect(index).toEqual(at(5, 5, 5).key);
            expect(face).toBeGreaterThanOrEqual(0);
            expect(face).toBeLessThan(6);

            seen.add(face);

            // nothing is adjacent, so every corner is fully open and the two
            // diagonals tie - which resolves to the unflipped split
            for (let corner = 0; corner < 4; corner++) {
                expect(VoxelQuadGeometry.occlusionOf(quad, corner)).toEqual(3);
            }

            expect(VoxelQuadGeometry.flippedOf(quad)).toEqual(false);
        }

        expect(seen.size).toEqual(6);
    });

    it('.computeQuads() - quad count always matches the face mesher', () => {
        const { world, chunk } = makeWorld();
        const quads = new VoxelQuadGeometry();
        const faces = new VoxelFaceGeometry();

        // a slab with a notch cut out of it, so the shape is not trivially uniform
        for (let x = 2; x < 12; x++) {
            for (let z = 2; z < 12; z++) {
                for (let y = 2; y < 6; y++) {
                    chunk.setBitVoxel(at(x, y, z));
                }
            }
        }

        chunk.unsetBitVoxel(at(6, 5, 6));
        chunk.unsetBitVoxel(at(7, 5, 6));

        faces.computeIndices(chunk, world);
        quads.computeQuads(chunk, world);

        expect(quads.count).toEqual(faces.popCount());
    });

    it('.computeQuads() - occlusion darkens a corner against a neighbour', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        // a voxel with a neighbour diagonally above its +y face
        chunk.setBitVoxel(at(5, 5, 5));
        chunk.setBitVoxel(at(6, 6, 5));

        geometry.computeQuads(chunk, world);

        let top = 0;

        for (const quad of geometry.quads) {
            if (VoxelQuadGeometry.indexOf(quad) !== at(5, 5, 5).key) {
                continue;
            }

            if (VoxelQuadGeometry.faceOf(quad) !== VoxelFaceGeometry.Y_POS_INDEX) {
                continue;
            }

            top = quad;
        }

        expect(top).not.toEqual(0);

        const levels: number[] = [0, 1, 2, 3].map((corner) => VoxelQuadGeometry.occlusionOf(top, corner));

        // the +x side neighbour occludes the two corners on that edge and leaves
        // the other two fully open
        expect(levels.filter((level) => level === 3).length).toEqual(2);
        expect(levels.filter((level) => level < 3).length).toEqual(2);

        // an edge neighbour darkens one whole edge, so the two diagonals stay
        // balanced and the split is left unflipped
        expect(levels[0] + levels[2]).toEqual(levels[1] + levels[3]);
        expect(VoxelQuadGeometry.flippedOf(top)).toEqual(false);
    });

    it('.computeQuads() - a single dark corner flips the split diagonal', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        // a neighbour touching only the diagonal of the +y face darkens exactly
        // one of its four corners, which is the case the flip exists for
        chunk.setBitVoxel(at(5, 5, 5));
        chunk.setBitVoxel(at(6, 6, 6));

        geometry.computeQuads(chunk, world);

        let top = 0;

        for (const quad of geometry.quads) {
            if (VoxelQuadGeometry.indexOf(quad) === at(5, 5, 5).key && VoxelQuadGeometry.faceOf(quad) === VoxelFaceGeometry.Y_POS_INDEX) {
                top = quad;
            }
        }

        const levels: number[] = [0, 1, 2, 3].map((corner) => VoxelQuadGeometry.occlusionOf(top, corner));

        expect(levels.filter((level) => level === 3).length).toEqual(3);
        expect(levels.filter((level) => level === 2).length).toEqual(1);

        // the dark corner sits on the 0-2 diagonal, so that diagonal is the
        // cheaper split and the quad is flipped onto 1-3
        expect(levels[0] + levels[2]).toBeLessThan(levels[1] + levels[3]);
        expect(VoxelQuadGeometry.flippedOf(top)).toEqual(true);
    });

    it('.computeQuads() - "none" leaves every corner open and skips the field', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        chunk.setBitVoxel(at(5, 5, 5));
        chunk.setBitVoxel(at(6, 6, 5));

        geometry.computeQuads(chunk, world, null, "none");

        for (const quad of geometry.quads) {
            for (let corner = 0; corner < 4; corner++) {
                expect(VoxelQuadGeometry.occlusionOf(quad, corner)).toEqual(3);
            }

            expect(VoxelQuadGeometry.flippedOf(quad)).toEqual(false);
        }
    });

    it('.computeQuads() - "face" shares one level across all four corners', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        chunk.setBitVoxel(at(5, 5, 5));
        chunk.setBitVoxel(at(6, 6, 5));

        geometry.computeQuads(chunk, world, null, "face");

        for (const quad of geometry.quads) {
            const first = VoxelQuadGeometry.occlusionOf(quad, 0);

            for (let corner = 1; corner < 4; corner++) {
                expect(VoxelQuadGeometry.occlusionOf(quad, corner)).toEqual(first);
            }

            // corners always tie under "face", so the split is never flipped
            expect(VoxelQuadGeometry.flippedOf(quad)).toEqual(false);
        }
    });

    it('.computeQuads() - occluders cull faces exactly as the face mesher does', () => {
        const { world, chunk } = makeWorld();
        const occluderWorld = new VoxelWorld();
        const occluderChunk = new VoxelChunk0(MortonKey.from(1, 1, 1));

        occluderWorld.insert(occluderChunk);

        chunk.setBitVoxel(at(5, 5, 5));

        // an occluder cell directly above hides the +y face
        occluderChunk.setBitVoxel(at(5, 6, 5));

        const quads = new VoxelQuadGeometry();
        const faces = new VoxelFaceGeometry();

        faces.computeIndices(chunk, world, occluderWorld);
        quads.computeQuads(chunk, world, occluderWorld);

        expect(quads.count).toEqual(faces.popCount());
        expect(quads.count).toEqual(5);

        for (const quad of quads.quads) {
            expect(VoxelQuadGeometry.faceOf(quad)).not.toEqual(VoxelFaceGeometry.Y_POS_INDEX);
        }
    });

    it('.computeQuads() - "occluders" source ignores the lane\'s own cells', () => {
        const { world, chunk } = makeWorld();
        const occluderWorld = new VoxelWorld();

        occluderWorld.insert(new VoxelChunk0(MortonKey.from(1, 1, 1)));

        // two own-world cells side by side - under "merged" the neighbour shades
        // the +y face of its partner, under "occluders" nothing does
        chunk.setBitVoxel(at(5, 5, 5));
        chunk.setBitVoxel(at(6, 6, 5));

        const geometry = new VoxelQuadGeometry();

        geometry.computeQuads(chunk, world, occluderWorld, "corner", "merged");

        const merged: number[] = [];

        for (const quad of geometry.quads) {
            merged.push(VoxelQuadGeometry.occlusionOf(quad, 0) + VoxelQuadGeometry.occlusionOf(quad, 1)
                + VoxelQuadGeometry.occlusionOf(quad, 2) + VoxelQuadGeometry.occlusionOf(quad, 3));
        }

        geometry.computeQuads(chunk, world, occluderWorld, "corner", "occluders");

        for (const quad of geometry.quads) {
            for (let corner = 0; corner < 4; corner++) {
                expect(VoxelQuadGeometry.occlusionOf(quad, corner)).toEqual(3);
            }
        }

        // and the merged pass really did shade something, so the comparison means
        // something rather than both being trivially open
        expect(merged.some((total) => total < 12)).toEqual(true);
    });

    it('.computeQuads() - reruns do not leak state between chunks', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        chunk.setBitVoxel(at(5, 5, 5));
        geometry.computeQuads(chunk, world);

        expect(geometry.count).toEqual(6);

        chunk.unsetBitVoxel(at(5, 5, 5));
        geometry.computeQuads(chunk, world);

        expect(geometry.count).toEqual(0);
    });

    it('.computeQuads() - packed fields round-trip through the accessors', () => {
        const { world, chunk } = makeWorld();
        const geometry = new VoxelQuadGeometry();

        for (let x = 4; x < 10; x++) {
            for (let y = 4; y < 10; y++) {
                for (let z = 4; z < 10; z++) {
                    if (((x + y + z) & 1) === 0) {
                        chunk.setBitVoxel(at(x, y, z));
                    }
                }
            }
        }

        geometry.computeQuads(chunk, world);

        expect(geometry.count).toBeGreaterThan(0);

        for (const quad of geometry.quads) {
            // the reserved high byte must stay clear so it can be claimed later
            expect(quad >>> 24).toEqual(0);

            expect(VoxelQuadGeometry.indexOf(quad)).toBeLessThan(4096);
            expect(VoxelQuadGeometry.faceOf(quad)).toBeLessThan(6);

            for (let corner = 0; corner < 4; corner++) {
                expect(VoxelQuadGeometry.occlusionOf(quad, corner)).toBeLessThan(4);
            }
        }
    });
});
