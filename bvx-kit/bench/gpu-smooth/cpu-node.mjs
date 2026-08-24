/**
 * Node-side CPU baseline for the smooth mesher.
 *
 * Chrome parks a hidden tab's renderer on the efficiency cores, which moves the
 * in-browser CPU number by up to an order of magnitude. Node is not subject to
 * that, so the honest CPU figure to compare the GPU against comes from here.
 */
import { VoxelSmoothGeometry } from "../../out/index.js";
import { buildWorld } from "./world.mjs";

const built = buildWorld(14, 5, 14);
const batch = built.surface.slice(0, 64);

console.log(`world ${built.all.length} chunks, ${built.surface.length} surface, batch ${batch.length}`);

for (const smoothing of [0, 1, 2, 3]) {
    const geometry = new VoxelSmoothGeometry();

    let vertices = 0;
    let indices = 0;

    for (const record of batch) {
        geometry.computeGeometry(record.chunk, built.world, smoothing, false, null, "primary");
        vertices += geometry.vertexCount;
        indices += geometry.indexCount;
    }

    const once = () => {
        for (const record of batch) {
            geometry.computeGeometry(record.chunk, built.world, smoothing, false, null, "primary");
        }
    };

    for (let i = 0; i < 20; i++) {
        once();
    }

    const reps = 60;
    const start = process.hrtime.bigint();

    for (let i = 0; i < reps; i++) {
        once();
    }

    const us = Number(process.hrtime.bigint() - start) / 1000 / reps / batch.length;

    console.log(`smoothing ${smoothing}: ${us.toFixed(1)} us/chunk   (${vertices} verts, ${indices} indices)`);
}
