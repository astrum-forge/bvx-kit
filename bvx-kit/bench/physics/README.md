# Physics benchmarks

Prices the delta protocol `BVXPhysicsRunner` speaks, the move budget added to
`VoxelPhysics.update`, and `wakeRegion`. Findings are in
`.plans/kit-performance-report.md`.

Nothing here is published or part of the test suite. It imports the compiled library
from `out/`, so run `npm run build-ts` first. The peak-tick section simulates 163,840
grains to settlement four times over, so the whole run takes a couple of minutes.

## Running

```
node bench/physics/index.mjs
```

It throws if the grain count the main thread reconstructs from the delta stream does
not match what was seeded, so it doubles as a correctness gate on the protocol.

## Files

| File | Purpose |
| --- | --- |
| `index.mjs` | Delta vs snapshot bytes, peak tick against a move budget, `wakeRegion` scaling, and a real off-thread run |
| `solver.worker.mjs` | Worker entry - adapts node's `parentPort` to the `PhysicsScope` shape `BVXPhysicsHost` expects |

## Reading the delta numbers

There are two delta-vs-snapshot tables and they say opposite things on purpose.

With every chunk in the layer active, a delta *is* the whole layer and the ratio is
1.0x - the protocol compresses nothing. Its advantage is dormancy, not encoding. The
second table disturbs one corner of a settled pool, which is what a real scene looks
like almost all of the time, and there the ratio is around 59x. A fully settled scene
sends nothing at all.
