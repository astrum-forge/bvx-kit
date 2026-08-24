# Geometry benchmarks

Measures the blocky and smooth mesh paths. Findings are in
`.plans/kit-performance-report.md`.

Nothing here is published or part of the test suite. It imports the compiled library
from `out/`, so run `npm run build-ts` first.

## Running

```
node bench/geometry/verify-blur.mjs    correctness gate for the specialised blur, run this first
node bench/geometry/run-blocky.mjs     VoxelFaceGeometry + BVXGeometry, by chunk shape
node bench/geometry/run-smooth.mjs     VoxelSmoothGeometry, by smoothing level
```

## Files

| File | Purpose |
| --- | --- |
| `workloads.mjs` | The five chunk shapes a streaming world meshes, the terrain heightfield, and the timing helper |
| `run-blocky.mjs` | Blocky path, split into `computeIndices` and `getIndices`. `--json` for machine-readable output |
| `run-smooth.mjs` | Smooth path across all smoothing levels; the spread from smoothing 0 is the blur cost |
| `verify-blur.mjs` | Checks the three specialised blur passes against a reimplementation of the original shared-loop blur, bit for bit, and checks the meshed patch for interior cracks |

## Why these five shapes

A resident window with real vertical depth is mostly *not* surface. At 1 m per
BitVoxel a 1 km x 1 km x 256 m window is 65,536 chunks, of which only the ~4,096
surface columns hold a heightfield. The rest are solid ground or open air, so
`solid-buried` and `air-open` carry most of the aggregate cost of a mesh sweep even
though neither emits a single triangle. Benchmarking only `surface` hides that.

`solid-shell` and `air-shell` are the transition band - uniform chunks with a mixed
neighbour. They cannot take the cheapest exit, so they are worth measuring separately.
