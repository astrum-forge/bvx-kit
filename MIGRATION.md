# Migrating to bvx-kit 2.0

2.0 changes three things that had grown into the shape of the 1.x API rather than being
designed there: how a mesh request reaches a worker, how a physics budget behaves, and
where the package is published. Everything else is additive.

Every change below is one I measured or tested rather than assumed; the numbers come
from an Apple M1 and are reproducible from `bvx-kit/bench`.

---

## 1. The package moved to GitHub Packages

**Old**

```jsonc
// package.json
"dependencies": { "@astrumforge/bvx-kit": "^1.41.0" }
```

**New**

```jsonc
"dependencies": { "@astrum-forge/bvx-kit": "^2.0.0" }
```

```ini
# .npmrc, next to your package.json
@astrum-forge:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

GitHub Packages requires the scope to match the repository owner. The owner is
`astrum-forge`, so the scope is `@astrum-forge` - the old `@astrumforge` spelling cannot
be published there. Update every import specifier:

```diff
-import { VoxelWorld } from "@astrumforge/bvx-kit";
+import { VoxelWorld } from "@astrum-forge/bvx-kit";
```

Note that GitHub Packages requires authentication even for public packages, so CI needs
a token with `read:packages`.

Releases are now tag driven: pushing a tag named for the version (`2.0.0`, or `v2.0.0`)
builds, tests, lints, publishes and opens a GitHub Release. Nothing publishes on a branch
push, and nothing auto-bumps the version.

---

## 2. Mesh requests carry a neighbourhood, not a BVW1 snapshot

### Why

`BVXSerializer`'s BVW1 format is a storage format - it run-length encodes, writes a
record per chunk, and allocates. Measured over 64 surface chunks:

| | us per request |
| --- | ---: |
| `saveWorld`, **on the calling thread** | 17.2 |
| `loadWorld`, in the worker | 6.6 |
| the blocky face mesh itself | 18.3 |

So packaging was 55% of a blocky mesh round trip, and the expensive 17.2 us of it ran on
the thread the worker exists to keep free. Copying the same bytes into a reused buffer
costs 1.2 us - 14x less - and naming arena slots costs nothing at all.

### What changed

`chunkKey`, `world` and `occluders` moved off the request and into a `payload` that says
how the data arrives.

**Old**

```typescript
const response = mesher.process({
    id: 1,
    type: "faces",
    chunkKey: chunk.key.key,
    flipped: false,
    world: BVXSerializer.saveWorld(world),
    occluders: BVXSerializer.saveWorld(occluders)
});
```

**New - the cheap path**

```typescript
import { ChunkNeighbourhoodPacker } from "@astrum-forge/bvx-kit";

const packer = new ChunkNeighbourhoodPacker();   // reuse one, it is stateful scratch

const response = mesher.process({
    id: 1,
    type: "faces",
    flipped: false,
    payload: {
        kind: "neighbourhood",
        chunk: packer.pack(chunk, world, pool.acquireOccupancy()),
        occluders: packer.pack(chunk, occluders, pool.acquireOccupancy())
    }
});
```

**New - the 1.x path, still supported**

```typescript
const response = mesher.process({
    id: 1,
    type: "faces",
    flipped: false,
    payload: {
        kind: "snapshot",
        chunkKey: chunk.key.key,
        world: BVXSerializer.saveWorld(world),
        occluders: BVXSerializer.saveWorld(occluders)
    }
});
```

A `neighbourhood` payload produces byte-identical geometry to the `snapshot` it replaces
- verified in `tests/chunk-neighbourhood.test.ts` for faces, quads and all four smoothing
levels.

**New - zero copy, over a shared arena**

```typescript
await pool.bindArena({ buffer: arena.buffer, capacity: arena.capacity, metaByteLength: 0 });

const response = await pool.submit({
    id: 0,
    type: "faces",
    flipped: false,
    payload: { kind: "arena", chunk: packer.packArena(chunk, world, (c) => slotOf(c)) }
});
```

Read `VoxelChunkArena`'s concurrency section before using this one. It is sound under
publish-by-message - which is what the pool does - and not sound if the owning thread
keeps editing a chunk while a worker meshes it.

### Responses

Responses gained two things:

- `MesherErrorResponse` - a fourth response type. A malformed request now comes back as
  `{ type: "error", message }` instead of throwing inside the worker's message handler,
  which posted nothing and left the caller's promise unsettled forever.
- `recycle` - the occupancy buffers the request arrived with, handed straight back so
  they can be reused. `BVXMesherPool` collects these automatically.

If you switch on `response.type`, add an `error` case.

### Newly exported

`MesherQuadsRequest` and `MesherQuadsResponse` were reachable through the `MesherRequest`
union but never exported by name, so an external consumer could not declare one. They are
exported now, along with every payload type.

---

## 3. `BVXMesherPool`

New. A pool of mesher workers with explicit controls and no policy of its own - no timer,
no frame budget, no deadline. Work moves when you submit it and when a worker reports
back, and at no other time.

```typescript
const pool = new BVXMesherPool({
    workers: Array.from({ length: 4 }, () =>
        new Worker(new URL("./mesher.worker.ts", import.meta.url), { type: "module" }))
});

// submit returns a promise; resubmitting the same chunk supersedes the queued job
const response = await pool.submit(request);

pool.cancel(BVXMesherPool.keyOf(request));  // drop queued work
pool.queued;                                 // decide whether to submit more
await pool.drain();                          // wait for everything outstanding
```

It replaces the hand-rolled pool most applications were writing. Your frame budget stays
where it is - in your render loop - and now has `queued`, `inFlight` and `idle` to act on.

---

## 4. `VoxelPhysics.update()` returns a result, and its budget is resumable

### Why

The 1.x budget changed the simulation, not just its pacing. When it ran out mid-tick,
"the layers that had not yet stepped are skipped for that tick" - so the same input
produced a different simulation depending on how much time the frame had, which defeats
the reason the budget was denominated in simulation quantities in the first place.

### What changed

**Old**

```typescript
const moves: number = physics.update(steps, maxMoves, maxWork);

if (physics.budgetExceeded) {
    // ...
}
```

**New**

```typescript
const result = physics.update(ticks, maxWork);

result.ticks;     // how many ticks completed
result.moves;     // grain movements
result.work;      // cell probes - the quantity maxWork budgets
result.complete;  // false when a tick is still open
result.tick;      // the counter after the call

if (physics.tickInProgress) {
    // a tick was cut short and the next update() continues it
}
```

- `maxMoves` is gone. Movements never predicted cost - a tick doing 6,000 movements
  measured 10.2 ms while one doing 21,620 measured 32.8 ms - and the docs already said
  so. `maxWork`, in cell probes, is near-perfectly linear in time.
- `budgetExceeded` is gone; read `complete` on the result, or `tickInProgress`.
- The `steps` parameter is now `ticks` and is the first of two, not the first of three.
- **A budget cut now resumes rather than skips.** The sweep records the chunk and y-plane
  it stopped at, and the next call continues the same tick from there. The tick counter
  does not advance until the tick finishes.

The property this buys is tested directly: after 40 completed ticks the world is
identical at budgets of 1, 37, 500 and unlimited. A budget changes how many calls a tick
takes and nothing else.

`notifyFlowSettled()` and `flowWakeNeeded` are gone from `VoxelPhysics` - they were
internal plumbing exposed because the coordinator and the layers were circularly
dependent. The layers now ask each other directly, which is both cheaper and strictly
more precise.

`VoxelPhysicsLayer.step()` now takes `(tick, maxWork)` and returns whether the tick
finished; read `movesPerformed` and `workPerformed` for the counts. It was never intended
to be called directly - use `VoxelPhysics.update()`.

### The physics worker protocol

`PhysicsStepRequest.steps` is now `ticks`, and `maxMoves` is now `maxWork`.
`PhysicsStepResponse.budgetExceeded` is replaced by `complete`, `ticks` and `work`.

---

## 5. `SmoothMeshResult.degenerateNormals`

New required field on `SmoothMeshResult`. If you implement `SmoothMesher` yourself, add
it; a CPU implementation that resolves degenerate gradients reports 0.

It exists because `GpuSmoothMesher` has no degenerate-normal fallback pass and the CPU
does. A dual cell whose field gradient vanishes - two diagonally opposite solid corners
is the simple case - gets a zero normal from the GPU where the CPU resolves it from the
adjacent triangles. That is now counted and reported rather than left to be discovered as
flat shading. The case is reachable: a targeted test produces one.

---

## 6. `GpuSmoothMesher` is faster and its guidance changed

No API change beyond `degenerateNormals` and a new `tiles` option, but the advice in the
1.x docs is no longer right.

The kernel now tiles its dispatch across workgroups instead of running one workgroup per
chunk, ping-pongs the blur instead of copying back after every pass, and fuses pairs of
smoothing passes into a single 5-tap. Smoothing 2 went from 12 dispatches to 8 and
smoothing 3 from 16 to 10. Every change is bit-identical to the previous kernel, verified
over 64 surface chunks at every smoothing level.

The old claim that "a batch of one loses to the CPU by roughly six times" was a property
of the dispatch shape, not the hardware, and no longer holds.

What has **not** changed: if you need the vertices back on the CPU, the ~0.3 ms readback
round trip still costs more than the contouring saves below roughly 25 chunks. Use
`CpuSmoothMesher` there.

`SMOOTH_MESHER_WGSL` gained entry points (`blur_x_r`, `blur2_x` and friends). If you
compile it yourself, use `GpuSmoothMesher.passList(smoothing)` to get the dispatch order
rather than hard-coding it, and dispatch `(tiles, chunkCount)` with `scan_cells` at
`(1, chunkCount)`.

---

## 7. Build toolchain

Only relevant if you build the kit from source; the published package is unaffected.

| | 1.x | 2.0 |
| --- | --- | --- |
| typescript | 5.7 | **7.0 native compiler, 6.0 API bridge** |
| eslint / @eslint/js | 9 | **10** |
| jest / @types/jest | 29 | **30** |
| globals | 15 | **17** |
| ts-jest | 29.2 | 29.4 |
| @typescript-eslint/*, typescript-eslint | 8.24 | 8.67 |
| @types/eslint__js | 8.42 | **removed** |

`@types/eslint__js` is gone because `@eslint/js` 10 ships its own types and nothing
referenced the shim.

**Two TypeScript installs, on purpose.** The kit compiles and type-checks with the
native TypeScript 7 compiler, installed under the `typescript7` alias
(`npm:typescript@^7.0.2`) and invoked by `npm run build-ts` through its explicit path,
so everything the package publishes is built by 7.0. The `typescript` package itself
stays at 6.0.x because 7.0 ships no JS compiler API - its main entry exports only a
version stub - and the tools that consume that API do not accept 7 yet:
`typescript-eslint@8.67.0` declares `typescript >=4.8.4 <6.1.0` and `ts-jest@29.4.12`
declares `>=4.3 <7`, and neither has a newer major. Lint and tests therefore run on
the 6.0 API. Once both tools accept 7, drop the 6.x bridge and the alias and let
`typescript@^7` carry the single install.

Two tsconfig changes came with TypeScript 6, which errors on what 5.x merely deprecated:

- `moduleResolution` moved from the deprecated `Node` (node10) to `bundler`, and
  `rootDir` is now explicit. The emitted JavaScript is unchanged.
- `isolatedModules` is on. It immediately caught a real bug: `Key` is an interface and
  was re-exported from `src/index.ts` as a value, which emits a runtime re-export of
  something that does not exist. Any consumer bundling with esbuild, swc or Vite's
  transpile-only pipeline would have hit it. If you import `Key`, it is
  `import type { Key }` now.

Because `bundler` resolution does not enforce the explicit `.js` extensions Node needs,
`npm run verify:esm` imports the built `out/index.js` as real Node ESM, checks every
expected export is present, checks `Key` is *absent* at runtime, and meshes a chunk. CI
runs it after every build.

Jest 30 loads `jest.config.ts` as an ES module, so `__dirname` no longer exists there;
the config derives it from `import.meta.url`.

## 8. Smaller changes

- **`VoxelChunkArena.release()` now throws** when the slot is not allocated. 1.x pushed a
  duplicate onto the free list and later handed the same memory to two chunks, which
  aliased silently. If you were double-releasing, you had a bug; you will now hear about
  it. `isAllocated(slot)` reports the state.
- **`VoxelChunkArena` gained an optional versioned mode** - `new VoxelChunkArena(capacity,
  metaByteLength, buffer, true)` - with `beginWrite`, `endWrite`, `version` and
  `readStable` for readers that cannot rely on publish-by-message ordering. Off by
  default; costs 4 bytes per slot.
- **`VoxelChunkArena.clear()` fills through a `Uint32Array`** rather than a `Uint8Array`.
  Every other access to that memory is 32-bit, and the memory model's guarantee that a
  racing read sees a whole old or whole new value holds only while both sides use views
  of the same width.
- **`VoxelWorld` takes a bucket count** - `new VoxelWorld(32)`. The 1.x constructor
  documented this and did not accept it, so a 27-chunk neighbourhood always allocated the
  256-bucket default.
- **`VoxelWorld.clear()` and `HashGrid.clear()`** are new.
- **`BVXWorkerHost` answers every message.** It also accepts a `bind-arena` control
  message and replies with a ready message reporting whether the buffer it received is
  genuinely shared.
- **`VERSION`** is exported from the package root.
