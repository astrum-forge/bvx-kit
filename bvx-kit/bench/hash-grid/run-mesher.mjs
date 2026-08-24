/**
 * Child process: end-to-end validation for ONE candidate index.
 *
 * Builds a real VoxelWorld filled with terrain-shaped chunks, swaps the world's
 * internal index for the candidate, and measures the two operations whose cost
 * is dominated by chunk lookups - the blocky face mesher (6 neighbour lookups
 * per chunk) and the raycaster (1 lookup per chunk boundary crossed).
 *
 * This is the number that decides the recommendation. A microbenchmark that
 * says a lookup got 20x faster is only interesting if the surrounding work
 * leaves room for it to matter.
 */

import { MortonKey, VoxelChunk16, VoxelIndex, VoxelWorld, VoxelFaceGeometry, VoxelRay } from "../../out/index.js";
import { IMPLS } from "./impls.mjs";
import { layoutCoords, timeit } from "./workloads.mjs";

const args = new Map(process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");

    return [a.slice(2, i), a.slice(i + 1)];
}));

const implName = args.get("impl");
const jobs = JSON.parse(args.get("jobs"));

// "native" leaves VoxelWorld's own index in place. Every other candidate is reached
// through a wrapper class, which adds a call frame that production code does not
// have - so native is the only measurement of the real shipping path.
const isNative = implName === "native";
const entry = isNative ? null : IMPLS[implName];

if (!isNative && (!entry || entry.rawKeys)) {
    throw new Error(`impl ${implName} cannot back a VoxelWorld`);
}

const Impl = entry ? entry.ctor : null;

// the layouts place chunks at y 8..15, so the resident band in global BitVoxel
// units is 128..255 - the surface has to sit inside it or every chunk comes out
// empty and the mesher measures nothing
const SURFACE = 186;

/**
 * Deterministic value-noise heightfield, in global BitVoxel units.
 */
const heightAt = (x, z) => {
    const a = Math.sin(x * 0.031) * Math.cos(z * 0.027);
    const b = Math.sin((x + z) * 0.011);

    return SURFACE + a * 11 + b * 7;
};

/**
 * Fills a 16^3 chunk from the heightfield. Chunks fully below the surface come
 * out solid, chunks fully above come out empty, which is what a real world
 * looks like and is what makes the mesher cost realistic.
 */
const fillChunk = (chunk, cx, cy, cz) => {
    const vi = new VoxelIndex();

    const baseX = cx * 16;
    const baseY = cy * 16;
    const baseZ = cz * 16;

    for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
            const h = heightAt(baseX + lx, baseZ + lz);

            for (let ly = 0; ly < 16; ly++) {
                if (baseY + ly >= h) {
                    continue;
                }

                VoxelIndex.from(lx >> 2, ly >> 2, lz >> 2, lx & 3, ly & 3, lz & 3, vi);
                chunk.setBitVoxel(vi);
            }
        }
    }
};

const results = [];

for (const job of jobs) {
    const { layout, n } = job;
    const coords = layoutCoords(layout, n);

    const world = new VoxelWorld();

    // swap the world's index for the candidate before anything is inserted
    if (!isNative) {
        world._voxelChunks = new Impl(coords.length);
    }

    const chunks = [];

    for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        const chunk = new VoxelChunk16(MortonKey.from(c[0], c[1], c[2]));

        fillChunk(chunk, c[0], c[1], c[2]);
        world.insert(chunk);
        chunks.push(chunk);
    }

    const geometry = new VoxelFaceGeometry();

    // sanity: a sweep that produces no faces is measuring nothing
    let totalFaces = 0;

    for (let i = 0; i < chunks.length; i++) {
        geometry.computeIndices(chunks[i], world);
        totalFaces += geometry.popCount();
    }

    if (totalFaces === 0) {
        throw new Error("mesher produced no geometry - the terrain missed the chunk band");
    }

    // one full sweep of the resident set - what a cold streaming fill costs
    const meshNs = timeit(() => {
        let acc = 0;

        for (let i = 0; i < chunks.length; i++) {
            geometry.computeIndices(chunks[i], world);
            acc += geometry.length;
        }

        return acc;
    }, chunks.length, { minMs: 400, reps: 5, warmups: 1 });

    // Raycaster coordinates are global BitVoxel units, so a chunk spans 16.
    // Rays run through the air band above the surface, which is the worst case
    // for the index: one lookup per chunk boundary and no early hit.
    // spread-based Math.min blows the stack at 131k coords - fold instead
    let cxMin = Infinity;
    let cxMax = -Infinity;
    let czMin = Infinity;
    let czMax = -Infinity;

    for (let i = 0; i < coords.length; i++) {
        const c = coords[i];

        if (c[0] < cxMin) { cxMin = c[0]; }
        if (c[0] > cxMax) { cxMax = c[0]; }
        if (c[2] < czMin) { czMin = c[2]; }
        if (c[2] > czMax) { czMax = c[2]; }
    }

    const minX = cxMin * 16 + 1;
    const maxX = cxMax * 16 + 15;
    const minZ = czMin * 16 + 1;
    const maxZ = czMax * 16 + 15;
    const airY = SURFACE + 34;

    const rays = [];

    for (let i = 0; i < 64; i++) {
        const z = minZ + ((maxZ - minZ) * i) / 64;
        const ray = new VoxelRay();

        ray.set(minX + 0.5, airY + 0.5, z + 0.5, maxX + 0.5, airY + 0.5, z + 0.5);
        rays.push(ray);
    }

    const raycaster = world.raycaster;

    const rayNs = timeit(() => {
        let acc = 0;

        for (let i = 0; i < rays.length; i++) {
            if (raycaster.raycast(rays[i]) === null) {
                acc++;
            }
        }

        return acc;
    }, rays.length, { minMs: 200, reps: 5, warmups: 1 });

    results.push({
        impl: implName,
        layout,
        n: chunks.length,
        facesPerChunk: totalFaces / chunks.length,
        chunkCrossingsPerRay: (maxX - minX) / 16,
        meshUsPerChunk: meshNs / 1000,
        rayUsPerRay: rayNs / 1000
    });
}

process.stdout.write(JSON.stringify(results));
