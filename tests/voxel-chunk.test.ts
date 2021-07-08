import { VoxelChunk } from "../src/engine/voxel-chunk";
import { VoxelIndex } from "../src/engine/voxel-index";
import { MortonKey } from "../src/math/morton-key";

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('VoxelChunk', () => {

    it('.setMetaData() .getMetaData() - ensure meta-data can be set and returned correctly', () => {
        const chunk = new VoxelChunk(MortonKey.from(0, 0, 0));

        let metacount: number = 1111;

        // loop for every voxel and se meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.SIZE; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.SIZE; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.SIZE; vz++) {
                    // set meta-data
                    chunk.setMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0), metacount);

                    metacount++;
                }
            }
        }

        metacount = 1111;

        // get and compare the meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.SIZE; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.SIZE; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.SIZE; vz++) {
                    // set meta-data
                    const meta = chunk.getMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    expect(meta).toEqual(metacount);

                    metacount++;
                }
            }
        }
    });

    it('.setBitVoxel() .unsetBitVoxel() .toggleBitVoxel() .getBitVoxel() - ensure BitVoxels can be set correctly', () => {
        const chunk = new VoxelChunk(MortonKey.from(0, 0, 0));

        // ensure default chunk BitVoxel is zero
        for (let i: number = 0; i < 4096; i++) {
            expect(chunk.getBitVoxel(new VoxelIndex(i))).toEqual(0);
        }

        // length should be zero (no bitvoxels set)
        expect(chunk.length).toEqual(0);

        // set bit-voxels to the 1 or ON state
        for (let i: number = 0; i < 4096; i++) {
            chunk.setBitVoxel(new VoxelIndex(i))
        }

        // length should be 4096 bitvoxels set
        expect(chunk.length).toEqual(4096);

        // ensure bitvoxels match to 1 (all set previously)
        for (let i: number = 0; i < 4096; i++) {
            expect(chunk.getBitVoxel(new VoxelIndex(i))).toEqual(1);
        }

        // set bit-voxels to the 0 or OFF state
        for (let i: number = 0; i < 4096; i++) {
            chunk.unsetBitVoxel(new VoxelIndex(i))
        }

        // length should be zero (no bitvoxels set)
        expect(chunk.length).toEqual(0);

        // ensure bitvoxels match to 0 (all unsetset previously)
        for (let i: number = 0; i < 4096; i++) {
            expect(chunk.getBitVoxel(new VoxelIndex(i))).toEqual(0);
        }

        // toggle bit-voxels to the 1 or ON state
        for (let i: number = 0; i < 4096; i++) {
            chunk.toggleBitVoxel(new VoxelIndex(i))
        }

        // length should be 4096 bitvoxels set
        expect(chunk.length).toEqual(4096);

        // ensure bitvoxels match to 0 (all toggled previously)
        for (let i: number = 0; i < 4096; i++) {
            expect(chunk.getBitVoxel(new VoxelIndex(i))).toEqual(1);
        }

        // toggle bit-voxels to the 0 or OFF state
        for (let i: number = 0; i < 4096; i++) {
            chunk.toggleBitVoxel(new VoxelIndex(i))
        }

        // length should be 4096 bitvoxels set
        expect(chunk.length).toEqual(0);

        // ensure bitvoxels match to 0 (all toggled previously)
        for (let i: number = 0; i < 4096; i++) {
            expect(chunk.getBitVoxel(new VoxelIndex(i))).toEqual(0);
        }
    });

    it('.fillVoxel() .emptyVoxel() - ensure correct voxels get filled & emptied', () => {
        const chunk = new VoxelChunk(MortonKey.from(0, 0, 0));

        let iterations = 0;

        // do the fill operations
        for (let vx: number = 0; vx < VoxelChunk.BVX_SUBDIV; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.BVX_SUBDIV; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.BVX_SUBDIV; vz++) {
                    chunk.fillVoxel(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    iterations++;

                    expect(chunk.length).toEqual(iterations * 64);

                    for (let x: number = 0; x < VoxelChunk.BVX_SUBDIV; x++) {
                        for (let y: number = 0; y < VoxelChunk.BVX_SUBDIV; y++) {
                            for (let z: number = 0; z < VoxelChunk.BVX_SUBDIV; z++) {
                                expect(chunk.getBitVoxel(VoxelIndex.from(vx, vy, vz, x, y, z))).toEqual(1);
                            }
                        }
                    }
                }
            }
        }

        // do the empty operations
        for (let vx: number = 0; vx < VoxelChunk.BVX_SUBDIV; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.BVX_SUBDIV; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.BVX_SUBDIV; vz++) {
                    chunk.emptyVoxel(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    iterations--;

                    expect(chunk.length).toEqual(iterations * 64);

                    for (let x: number = 0; x < VoxelChunk.BVX_SUBDIV; x++) {
                        for (let y: number = 0; y < VoxelChunk.BVX_SUBDIV; y++) {
                            for (let z: number = 0; z < VoxelChunk.BVX_SUBDIV; z++) {
                                expect(chunk.getBitVoxel(VoxelIndex.from(vx, vy, vz, x, y, z))).toEqual(0);
                            }
                        }
                    }
                }
            }
        }
    });
});