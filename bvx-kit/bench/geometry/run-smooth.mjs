/**
 * Times the smooth mesh path across smoothing levels. Smoothing 0 does no blur at
 * all, so the spread between it and the higher levels is what the blur costs.
 *
 * Run `npm run build-ts` first.
 */
import { VoxelSmoothGeometry } from "../../out/index.js";
import { CASES, time } from "./workloads.mjs";

const surface = CASES.find(c => c.name === "surface");
const { world, center } = surface.build();
const geometry = new VoxelSmoothGeometry();

console.log("smooth mesh path, us per chunk\n");
console.log("  smoothing   us/chunk   chunks/s   blur cost");

let base = 0;

for (let smoothing = 0; smoothing <= VoxelSmoothGeometry.MAX_SMOOTHING; smoothing++) {
    const us = time(() => geometry.computeGeometry(center, world, smoothing, false), 3000, 300);

    if (smoothing === 0) {
        base = us;
    }

    console.log(
        `  ${String(smoothing).padStart(9)}   ${us.toFixed(2).padStart(8)}   ` +
        `${Math.round(1e6 / us).toLocaleString("en-US").padStart(8)}   ${(us - base).toFixed(2).padStart(9)}`
    );
}
