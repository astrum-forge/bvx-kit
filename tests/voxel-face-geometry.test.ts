import { VoxelChunk } from "../src/engine/voxel-chunk";
import { VoxelIndex } from "../src/engine/voxel-index";
import { MortonKey } from "../src/math/morton-key";
import { VoxelFaceGeometry } from "../src/engine/geometry/voxel-face-geometry";
import { VoxelWorld } from "../src/engine/voxel-world";
import { BitOps } from "../src/util/bit-ops";

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('VoxelFaceGeometry', () => {

    it('.constructor() - ensure proper buffer length', () => {
        const geometry = new VoxelFaceGeometry();

        expect(geometry.length).toEqual(4096);
        expect(geometry.buffer.byteLength).toEqual(4096);

        const world = new VoxelWorld();
        const chunk = new VoxelChunk(MortonKey.from(1, 1, 1));

        world.insert(chunk);

        geometry.computeIndices(chunk, world);

        // we expect no bit-voxels to be present
        expect(geometry.popCount()).toEqual(0);
    });

    it('.computeIndices() - non-bounded single BitVoxel', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk(MortonKey.from(1, 1, 1));

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
        const chunk = new VoxelChunk(MortonKey.from(1, 1, 1));

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
        const chunk = new VoxelChunk(MortonKey.from(1, 1, 1));

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
        const chunk = new VoxelChunk(MortonKey.from(1, 1, 1));

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
});