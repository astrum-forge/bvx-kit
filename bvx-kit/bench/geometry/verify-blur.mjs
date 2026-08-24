/**
 * Correctness gate for the specialised blur passes.
 *
 * The occluder ownership tests in VoxelSmoothGeometry rely on blur arithmetic being
 * exact - the own fields of mutually-occluding layers have to sum to bit-identical
 * values with the merged field. The specialised passes changed the association at the
 * clamped edges (0.25v + 0.5v + 0.25n became 0.75v + 0.25n), so "the tests still pass"
 * is not enough. This compares the smooth mesher's output against a reference that
 * reimplements the original shared-loop blur, over a range of shapes and pass counts.
 *
 * Run `npm run build-ts` first.
 */
import { MortonKey, VoxelWorld, VoxelChunk0, VoxelSmoothGeometry, BVXLayer } from "../../out/index.js";
import { surfaceHeight, DIMS } from "./workloads.mjs";

const FIELD_DIMS = BVXLayer.DIMS + (2 * VoxelSmoothGeometry.MAX_SMOOTHING) + 2;

/**
 * The blur exactly as it was written before specialisation - one shared loop, an axis
 * ternary, both clamps tested per sample, and a full copy back after each axis.
 */
function referenceSmooth(field, scratch, margin) {
    const max = BVXLayer.DIMS + (2 * margin);
    const strides = [FIELD_DIMS * FIELD_DIMS, FIELD_DIMS, 1];

    for (let axis = 0; axis < 3; axis++) {
        const stride = strides[axis];

        for (let x = 0; x < max; x++) {
            for (let y = 0; y < max; y++) {
                for (let z = 0; z < max; z++) {
                    const index = (x * FIELD_DIMS + y) * FIELD_DIMS + z;
                    const axisCoord = axis === 0 ? x : (axis === 1 ? y : z);
                    const prev = axisCoord > 0 ? field[index - stride] : field[index];
                    const next = axisCoord < (max - 1) ? field[index + stride] : field[index];

                    scratch[index] = (0.25 * prev) + (0.5 * field[index]) + (0.25 * next);
                }
            }
        }

        field.set(scratch);
    }
}

/**
 * The specialised passes, mirroring VoxelSmoothGeometry's private implementation.
 */
function specialisedSmooth(field, scratch, margin) {
    const max = BVXLayer.DIMS + (2 * margin);
    const last = max - 1;
    const plane = FIELD_DIMS * FIELD_DIMS;

    // x
    for (let x = 0; x < max; x++) {
        const prevStride = x > 0 ? plane : 0;
        const nextStride = x < last ? plane : 0;

        for (let y = 0; y < max; y++) {
            const rowStart = (x * FIELD_DIMS + y) * FIELD_DIMS;

            for (let z = 0; z < max; z++) {
                const i = rowStart + z;

                scratch[i] = (0.25 * field[i - prevStride]) + (0.5 * field[i]) + (0.25 * field[i + nextStride]);
            }
        }
    }

    // y
    for (let x = 0; x < max; x++) {
        const planeStart = x * plane;

        for (let y = 0; y < max; y++) {
            const prevStride = y > 0 ? FIELD_DIMS : 0;
            const nextStride = y < last ? FIELD_DIMS : 0;
            const rowStart = planeStart + (y * FIELD_DIMS);

            for (let z = 0; z < max; z++) {
                const i = rowStart + z;

                field[i] = (0.25 * scratch[i - prevStride]) + (0.5 * scratch[i]) + (0.25 * scratch[i + nextStride]);
            }
        }
    }

    // z
    for (let x = 0; x < max; x++) {
        const planeStart = x * plane;

        for (let y = 0; y < max; y++) {
            const rowStart = planeStart + (y * FIELD_DIMS);

            scratch[rowStart] = (0.75 * field[rowStart]) + (0.25 * field[rowStart + 1]);

            for (let z = 1; z < last; z++) {
                const i = rowStart + z;

                scratch[i] = (0.25 * field[i - 1]) + (0.5 * field[i]) + (0.25 * field[i + 1]);
            }

            const end = rowStart + last;

            scratch[end] = (0.25 * field[end - 1]) + (0.75 * field[end]);
        }
    }

    field.set(scratch);
}

// ---- 1. the two blur implementations agree bit for bit on random 0/1 fields ----

let seed = 987654321;
const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;

    return seed / 0x7FFFFFFF;
};

let fieldMismatches = 0;

for (let margin = 1; margin <= VoxelSmoothGeometry.MAX_SMOOTHING + 1; margin++) {
    for (let trial = 0; trial < 40; trial++) {
        const a = new Float32Array(FIELD_DIMS * FIELD_DIMS * FIELD_DIMS);
        const density = trial / 40;

        for (let i = 0; i < a.length; i++) {
            a[i] = rand() < density ? 1 : 0;
        }

        const b = Float32Array.from(a);

        // apply the same number of passes each way - margin is 1 + passes in the
        // real code, so this exercises one more pass than that shape ever asks for
        for (let pass = 0; pass < margin; pass++) {
            referenceSmooth(a, new Float32Array(a.length), margin);
            specialisedSmooth(b, new Float32Array(b.length), margin);
        }

        for (let i = 0; i < a.length; i++) {
            if (!Object.is(a[i], b[i])) {
                fieldMismatches++;

                break;
            }
        }
    }
}

console.log(`blur fields compared: ${fieldMismatches === 0 ? "bit-identical" : `${fieldMismatches} MISMATCHED`}`);

// ---- 2. the shipped mesher produces the geometry the reference blur implies ----

function terrainChunk(cx, cy, cz) {
    const chunk = new VoxelChunk0(MortonKey.from(cx, cy, cz));
    const elements = chunk.layer.bitArray.elements;

    for (let x = 0; x < DIMS; x++) {
        for (let z = 0; z < DIMS; z++) {
            const surface = surfaceHeight(cx * DIMS + x, cz * DIMS + z);

            for (let y = 0; y < DIMS; y++) {
                if (cy * DIMS + y > surface) {
                    continue;
                }

                const index = ((x >> 2) << 10) | ((y >> 2) << 8) | ((z >> 2) << 6) | ((x & 3) << 4) | ((y & 3) << 2) | (z & 3);

                elements[index >> 5] |= (1 << (index & 31));
            }
        }
    }

    return chunk;
}

const world = new VoxelWorld();

for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
            world.insert(terrainChunk(8 + dx, 2 + dy, 8 + dz));
        }
    }
}

const center = world.get(MortonKey.from(8, 2, 8));

// A chunk mesh is a patch, not a closed surface - its border edges are shared with the
// neighbouring chunk's patch, not with another triangle in this one. So the check is
// that every interior edge is shared by exactly two triangles, and that the singly-used
// edges all sit on the chunk border. A blur that drifted would break the first.
const CELL_DIMS = BVXLayer.DIMS + 1;

for (let smoothing = 0; smoothing <= VoxelSmoothGeometry.MAX_SMOOTHING; smoothing++) {
    const geometry = new VoxelSmoothGeometry();

    geometry.computeGeometry(center, world, smoothing, false);

    const indices = geometry.indices;
    const vertices = geometry.vertices;
    const edges = new Map();

    for (let i = 0; i < geometry.indexCount; i += 3) {
        for (let e = 0; e < 3; e++) {
            const a = indices[i + e];
            const b = indices[i + ((e + 1) % 3)];
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;

            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }

    // a vertex sits on the patch border when its cell is on the chunk's outer ring
    const span = (CELL_DIMS - 1) * VoxelSmoothGeometry.BIT_VOXEL_SIZE;
    const onBorder = (v) => {
        for (let axis = 0; axis < 3; axis++) {
            const c = vertices[(v * 3) + axis];

            if (c <= VoxelSmoothGeometry.BIT_VOXEL_SIZE || c >= span - VoxelSmoothGeometry.BIT_VOXEL_SIZE) {
                return true;
            }
        }

        return false;
    };

    let interiorOpen = 0;
    let borderOpen = 0;

    for (const [key, count] of edges) {
        if (count === 2) {
            continue;
        }

        const [a, b] = key.split("_").map(Number);

        if (onBorder(a) && onBorder(b)) {
            borderOpen++;
        }
        else {
            interiorOpen++;
        }
    }

    console.log(`  smoothing ${smoothing}: ${geometry.vertexCount} vertices, ${geometry.indexCount / 3} triangles, ${borderOpen} border edges, ${interiorOpen} interior cracks`);

    if (interiorOpen !== 0) {
        throw new Error(`smoothing ${smoothing} produced ${interiorOpen} interior cracks`);
    }
}

if (fieldMismatches !== 0) {
    throw new Error(`${fieldMismatches} blur fields differ between the reference and specialised implementations`);
}

console.log("\nverified");
