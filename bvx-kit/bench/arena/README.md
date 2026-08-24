# Arena benchmarks

Prices `VoxelChunkArena` against the snapshot protocol, and proves that a worker
sharing an arena sees live world state. Findings are in
`.plans/kit-performance-report.md`.

Nothing here is published or part of the test suite. It imports the compiled library
from `out/`, so run `npm run build-ts` first.

## Running

```
node bench/arena/index.mjs
```

The script asserts as it goes - it throws if the arena world does not mesh identically
to a self-allocating world, or if the worker fails to observe a write the main thread
made without telling it. So it doubles as a correctness gate.

## Files

| File | Purpose |
| --- | --- |
| `index.mjs` | Builds the same terrain twice, compares the meshes, prices each stage of both transports, then runs the cross-thread check |
| `mesh.worker.mjs` | Worker that attaches to the shared arena once and afterwards meshes from live memory |

## What it is actually measuring

Not copying. Both directions of the existing mesher protocol already transfer their
buffers rather than cloning them, and a memcpy of a 27-chunk neighbourhood costs about
a quarter of a microsecond. The cost is the *format* - `saveWorld` and `loadWorld`
translating in and out of BVW1 either side of a boundary that a shared buffer removes
the need to cross at all.

The script also compares meshing out of `SharedArrayBuffer`-backed storage against
plain `ArrayBuffer` storage. If shared reads were slower the arena would not be worth
having, so that ratio is measured rather than assumed.
