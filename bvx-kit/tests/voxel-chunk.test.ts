import { describe, expect, it } from '@jest/globals';
import { VoxelChunk } from "../src/lib/engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelChunk8 } from "../src/lib/engine/chunks/voxel-chunk-8.js";
import { VoxelChunk16 } from "../src/lib/engine/chunks/voxel-chunk-16.js";
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { MortonKey } from "../src/lib/math/morton-key.js";

/**
 * Provides 100% Coverage for bit-ops.ts
 */
describe('VoxelChunk', () => {

    it('.setMetaData() .getMetaData() - ensure 32 bit meta-data can be set and returned correctly', () => {
        const chunk = new VoxelChunk32(MortonKey.from(0, 0, 0));

        let metacount: number = 1111;

        // loop for every voxel and se meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    chunk.setMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0), metacount);

                    metacount++;
                }
            }
        }

        metacount = 1111;

        // get and compare the meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    const meta = chunk.getMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    expect(meta).toEqual(metacount);

                    metacount++;
                }
            }
        }
    });

    it('.setMetaData() .getMetaData() - ensure 16 bit meta-data can be set and returned correctly', () => {
        const chunk = new VoxelChunk16(MortonKey.from(0, 0, 0));

        let metacount: number = 1111;

        // loop for every voxel and se meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    chunk.setMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0), metacount);

                    metacount++;
                }
            }
        }

        metacount = 1111;

        // get and compare the meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    const meta = chunk.getMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    expect(meta).toEqual(metacount);

                    metacount++;
                }
            }
        }
    });

    it('.setMetaData() .getMetaData() - ensure 8 bit meta-data can be set and returned correctly', () => {
        const chunk = new VoxelChunk8(MortonKey.from(0, 0, 0));

        let metacount: number = 0;

        // loop for every voxel and se meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    chunk.setMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0), metacount);

                    metacount++;
                }
            }
        }

        metacount = 0;

        // get and compare the meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    const meta = chunk.getMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    if (meta > 255) {
                        expect(meta).toEqual(255);
                    }
                    else {
                        expect(meta).toEqual(metacount);
                    }

                    metacount++;
                }
            }
        }
    });

    it('.setMetaData() .getMetaData() - ensure 0 bit meta-data can be set and returned correctly', () => {
        const chunk = new VoxelChunk0(MortonKey.from(0, 0, 0));

        let metacount: number = 0;

        // loop for every voxel and se meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    chunk.setMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0), metacount);

                    metacount++;
                }
            }
        }

        metacount = 0;

        // get and compare the meta-data for every voxel
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    // set meta-data
                    const meta = chunk.getMetaData(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    expect(meta).toEqual(0);

                    metacount++;
                }
            }
        }
    });

    it('.setBitVoxel() .unsetBitVoxel() .toggleBitVoxel() .getBitVoxel() - ensure BitVoxels can be set correctly', () => {
        const chunk = new VoxelChunk32(MortonKey.from(0, 0, 0));

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
        const chunk = new VoxelChunk32(MortonKey.from(0, 0, 0));

        let iterations = 0;

        // do the fill operations
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    chunk.fillVoxel(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    iterations++;

                    expect(chunk.length).toEqual(iterations * 64);

                    for (let x: number = 0; x < VoxelChunk.DIMS; x++) {
                        for (let y: number = 0; y < VoxelChunk.DIMS; y++) {
                            for (let z: number = 0; z < VoxelChunk.DIMS; z++) {
                                expect(chunk.getBitVoxel(VoxelIndex.from(vx, vy, vz, x, y, z))).toEqual(1);
                            }
                        }
                    }
                }
            }
        }

        // do the empty operations
        for (let vx: number = 0; vx < VoxelChunk.DIMS; vx++) {
            for (let vy: number = 0; vy < VoxelChunk.DIMS; vy++) {
                for (let vz: number = 0; vz < VoxelChunk.DIMS; vz++) {
                    chunk.emptyVoxel(VoxelIndex.from(vx, vy, vz, 0, 0, 0));

                    iterations--;

                    expect(chunk.length).toEqual(iterations * 64);

                    for (let x: number = 0; x < VoxelChunk.DIMS; x++) {
                        for (let y: number = 0; y < VoxelChunk.DIMS; y++) {
                            for (let z: number = 0; z < VoxelChunk.DIMS; z++) {
                                expect(chunk.getBitVoxel(VoxelIndex.from(vx, vy, vz, x, y, z))).toEqual(0);
                            }
                        }
                    }
                }
            }
        }
    });

    it('.getBitVoxelCount() - ensure BitVoxels can be counted correctly', () => {
        const chunk = new VoxelChunk32(MortonKey.from(0, 0, 0));

        chunk.fillVoxel(VoxelIndex.from(1, 1, 1));

        expect(chunk.getBitVoxelCount(VoxelIndex.from(1, 1, 1))).toEqual(64);

        chunk.emptyVoxel(VoxelIndex.from(1, 1, 1));

        expect(chunk.getBitVoxelCount(VoxelIndex.from(1, 1, 1))).toEqual(0);

        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 0, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 1, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 0, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 0));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 0, 1, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 0, 1));
        chunk.setBitVoxel(VoxelIndex.from(1, 1, 1, 1, 1, 1));

        expect(chunk.getBitVoxelCount(VoxelIndex.from(1, 1, 1))).toEqual(8);
    });
});