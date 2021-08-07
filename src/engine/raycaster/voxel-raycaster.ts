import { VoxelChunk } from "../chunks/voxel-chunk";
import { VoxelWorld } from "../voxel-world";
import { WorldIndex } from "../world-index";
import { VoxelRay } from "./voxel-ray";

/**
 * VoxelRaycaster allows picking Voxels for placement, removal or modification
 * from a VoxelWorld structure
 */
export class VoxelRaycaster {
    private static readonly _TMP_KEY: WorldIndex = new WorldIndex();

    private readonly _world: VoxelWorld;

    constructor(world: VoxelWorld) {
        this._world = world;
    }

    /**
     * Perform a Raycast operation against the internal VoxelWorld structure
     * @param ray - VoxelRay ray to use
     * @param optres - (optional) WorldIndex results to fill
     * @returns - returns WorldIndex if a Voxel was picked otherwise null
     */
    public raycast(ray: VoxelRay, optres: WorldIndex | null = null): WorldIndex | null {
        const cellSize: number = 1;

        const x1: number = ray.startX;
        const y1: number = ray.startY;
        const z1: number = ray.startZ;

        const x2: number = ray.endX;
        const y2: number = ray.endY;
        const z2: number = ray.endZ;

        let i: number = Math.floor(x1 / cellSize) | 0;
        let j: number = Math.floor(y1 / cellSize) | 0;
        let k: number = Math.floor(z1 / cellSize) | 0;

        const iend: number = Math.floor(x2 / cellSize) | 0;
        const jend: number = Math.floor(y2 / cellSize) | 0;
        const kend: number = Math.floor(z2 / cellSize) | 0;

        const di: number = ((x1 < x2) ? 1 : ((x1 > x2) ? -1 : 0));
        const dj: number = ((y1 < y2) ? 1 : ((y1 > y2) ? -1 : 0));
        const dk: number = ((z1 < z2) ? 1 : ((z1 > z2) ? -1 : 0));

        const deltatx: number = cellSize / Math.abs(x2 - x1);
        const deltaty: number = cellSize / Math.abs(y2 - y1);
        const deltatz: number = cellSize / Math.abs(z2 - z1);

        const minx: number = cellSize * Math.floor(x1 / cellSize);
        const maxx: number = minx + cellSize;
        let tx: number = ((x1 > x2) ? (x1 - minx) : (maxx - x1)) / Math.abs(x2 - x1);

        const miny: number = cellSize * Math.floor(y1 / cellSize);
        const maxy: number = miny + cellSize;
        let ty: number = ((y1 > y2) ? (y1 - miny) : (maxy - y1)) / Math.abs(y2 - y1);

        const minz: number = cellSize * Math.floor(z1 / cellSize);
        const maxz: number = minz + cellSize;
        let tz: number = ((z1 > z2) ? (z1 - minz) : (maxz - z1)) / Math.abs(z2 - z1);

        // re-use this key to avoid allocation stuff
        const worldKey: WorldIndex = VoxelRaycaster._TMP_KEY;
        const world: VoxelWorld = this._world;

        // this may look scary but it will terminate (eventually)
        while (true) {
            const worldCoord: WorldIndex = WorldIndex.from(i, j, k, worldKey);

            const chunk: VoxelChunk | null = world.get(worldCoord.chunkIndex);

            // check if the current coordinate has hit a BitVoxel, if so then return
            if (chunk !== null && chunk.getBitVoxel(worldCoord.voxelIndex) === 1) {
                return WorldIndex.from(i, j, k, optres);
            }

            if (tx <= ty && tx <= tz) {
                if (i === iend) {
                    return null;
                }

                tx += deltatx;
                i += di;
            }
            else if (ty <= tx && ty <= tz) {
                if (j === jend) {
                    return null;
                }

                ty += deltaty;
                j += dj;
            }
            else {
                if (k === kend) {
                    return null;
                }

                tz += deltatz;
                k += dk;
            }
        }
    }
}