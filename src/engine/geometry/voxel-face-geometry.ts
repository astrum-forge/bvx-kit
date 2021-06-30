import { VoxelChunk } from "../voxel-chunk";
import { VoxelGeometry } from "./voxel-geometry";

export class VoxelFaceGeometry extends VoxelGeometry {
    public computeIndices(center: VoxelChunk): void {
        // reset the internal buffer
        this.reset();

        // This VoxelChunk has no BitVoxels set (basically empty space)
        // there is nothing to do or render, just return
        // quick exit
        if (center.length <= 0) {
            return;
        }


    }
}