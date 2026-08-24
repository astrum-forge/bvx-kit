# HashGrid experiment

Benchmark harness comparing thirteen chunk-index implementations for `VoxelWorld`.
Findings and the recommendation are in `.plans/hashgrid-experiment-report.md`.

Nothing here is published or part of the test suite. It imports the compiled library
from `out/`, so run `npm run build-ts` first.

## Running

```
node bench/hash-grid/verify.mjs                          correctness gate, run this first
node bench/hash-grid/stability.mjs --reps=7 --n=262144   lookup timings
node bench/hash-grid/index.mjs                           all phases
node bench/hash-grid/index.mjs --phase=dist              bucket distribution only
node bench/hash-grid/index.mjs --impls=shipped,map-wrapped
```

`stability.mjs` also takes `--layouts=terrain,cube,thin,sphere,shell` and `--tag=`.

`index.mjs` phases: `dist` (bucket distribution, no timing), `micro` (all operations),
`mem` (bytes per entry), `small` (short-lived 27-chunk worlds), `e2e` (real
`VoxelWorld` mesher and raycaster). It checkpoints `results.json` after each phase.

The full `index.mjs` run takes over ten minutes and may exceed a shell timeout part
way through `e2e`; the checkpoints mean nothing is lost, and `--impls=` resumes a
subset.

## Files

| File | Purpose |
| --- | --- |
| `impls.mjs` | The candidates, behind one common surface. `shipped` wraps whatever `HashGrid` currently is; `old-chained` replicates the pre-Map version for before/after comparison |
| `workloads.mjs` | Chunk layouts, probe sequences, timing helper |
| `verify.mjs` | Cross-checks every candidate against a reference `Map` |
| `distribution.mjs` | Bucket occupancy and compares-per-hit, no timing |
| `run-bench.mjs` | Child: one candidate, per-operation timings |
| `run-memory.mjs` | Child: one candidate at one size, bytes per entry |
| `run-smallworld.mjs` | Child: one candidate, short-lived 27-chunk worlds |
| `run-mesher.mjs` | Child: one candidate, real `VoxelWorld` mesher and raycaster. `--impl=native` leaves `VoxelWorld`'s own index in place, which is the only measurement without a wrapper call frame |
| `stability.mjs` | Lookup timings, one job per process, median across runs |
| `index.mjs` | Orchestrator, spawns children and formats tables |

## Three traps this harness exists to avoid

**One candidate per process.** Exercising several implementations from the same call
site turns it megamorphic in V8 and silently penalises whichever ran second.

**One job per process, for timings that need precision.** Running several sizes
sequentially in one process let earlier jobs perturb V8 state for later ones, and
produced numbers that moved 30-70% between passes while the slow candidates
reproduced to within 1%. `stability.mjs` runs a single (impl, layout, size) per
process and reports the median and range; use it, not `index.mjs --phase=micro`, when
a difference under 2x matters.

**The end-to-end raycaster is noisy.** Repeated runs of the same candidate at 131k
chunks span 84-137 us/ray - the 260 MB of resident chunk data makes it sensitive to
heap layout and GC timing. The mesh sweep is stable to about 2%. Run the raycast
comparison at least five times per side and report the range; differences under about
30% are not resolvable from a single run.

Memory measurement has its own trap: typed arrays live outside `heapUsed`, and a
structure from a previous job stays stack-reachable and gets collected mid-measurement,
which can make a delta come out negative. `run-memory.mjs` measures `heapUsed +
external` over several copies, one size per process. It reports exactly 4.00 B/entry
for an `Int32Array`, which is the calibration.
