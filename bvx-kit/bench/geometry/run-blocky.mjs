/**
 * Times the blocky mesh path - VoxelFaceGeometry.computeIndices plus
 * BVXGeometry.getIndices - across the chunk shapes a streaming world meshes.
 *
 * Emits JSON on --json so index.mjs can diff two builds.
 */
import { VoxelFaceGeometry, BVXGeometry } from "../../out/index.js";
import { CASES, time } from "./workloads.mjs";

const json = process.argv.includes("--json");
const results = [];

for (const testCase of CASES) {
    const { world, center } = testCase.build();
    const geometry = new VoxelFaceGeometry();

    geometry.computeIndices(center, world);

    const faces = geometry.popCount();
    const indexBuffer = new Uint32Array(faces * 6);

    const compute = time(() => geometry.computeIndices(center, world));
    const expand = time(() => BVXGeometry.getIndices(geometry, false, indexBuffer));

    results.push({
        name: testCase.name,
        note: testCase.note,
        faces,
        compute,
        expand,
        total: compute + expand
    });
}

if (json) {
    console.log(JSON.stringify(results));
}
else {
    console.log("blocky mesh path, us per chunk\n");
    console.log("  case          faces   compute    expand     total");

    for (const r of results) {
        console.log(
            `  ${r.name.padEnd(12)} ${String(r.faces).padStart(6)}  ` +
            `${r.compute.toFixed(3).padStart(8)}  ${r.expand.toFixed(3).padStart(8)}  ${r.total.toFixed(3).padStart(8)}`
        );
    }

    console.log("");

    for (const r of results) {
        console.log(`  ${r.name.padEnd(12)} ${r.note}`);
    }
}
