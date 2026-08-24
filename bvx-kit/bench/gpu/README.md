# WebGPU compute benchmarks

Prices a real WGSL compute face mesher against the CPU face mesher, on the same
data and the same machine. Findings are in `.plans/compute-shader-feasibility.md`;
the full run this document was written from is in `RESULTS.md`.

Nothing here is published or part of the test suite. Unlike the other bench
directories this one does **not** import from `out/` — the CPU reference is
reimplemented in `mesher.js` so that the identical source can run in Node, in a
browser worker and beside the GPU kernel. It is a faithful port of
`VoxelFaceGeometry.computeIndices` as it stands after the 23 Aug perf pass
(empty fast path, solid-buried fast path, solid-shell boundary walk, word-skip
bit scan, six hand-unrolled direction samples), not a strawman. If the mesher
changes, this port has to change with it.

## Running

The GPU half needs a browser; Node has no WebGPU implementation here.

```
python3 bench/gpu/serve.py 8732      # serves this directory with COOP/COEP
open http://localhost:8732/index.html
```

**Keep the tab in the foreground.** The page refuses to start while hidden and
reports `wentHidden` if it loses focus mid-run — see the QoS note below.

The CPU half runs standalone and is the one to trust for CPU numbers:

```
node bench/gpu/cpu-node.mjs
```

Both build the identical deterministic world, so the face counts they print must
match each other and must match the GPU's. That equality is the correctness gate:
the GPU kernel is only interesting if it reproduces the CPU mesher exactly, and on
this machine it does — 394,534 faces / 338,495 touched on the mixed world.

## Files

| File | Purpose |
| --- | --- |
| `mesher.js` | World generator plus the CPU reference mesher. Shared by Node, the browser and the workers so all three run byte-identical code |
| `cpu-node.mjs` | CPU baseline under Node: 1 thread, then `worker_threads` pools of 2 / 4 / 8 over a `SharedArrayBuffer` |
| `index.html` | The WGSL kernel and the whole GPU bench — throughput, batch sweep, dispatch overhead, upload, readback latency |
| `worker.js` | Browser worker for the in-page multicore baseline |
| `serve.py` | Static server that sets COOP/COEP |
| `RESULTS.md` | The recorded run, with the device limits it was taken on |

## What it is actually measuring

Not raw ALU throughput. The kernel is memory- and overhead-bound, and the numbers
that decide the design are the fixed costs rather than the per-chunk one:

- **A ~95–105 µs floor per submitted batch**, which is why the batch sweep exists.
  Below about five dirty chunks the CPU wins outright; the crossover, not the
  asymptote, is the number a scheduler needs.
- **A 0.32 ms readback round trip for sixteen bytes.** Latency-bound, not
  bandwidth-bound — 4 MB costs 0.72 ms. This is what rules out GPU physics driving
  gameplay, and what makes GPU meshing a streaming tool rather than an editing one.
- **An honest multicore CPU baseline.** Comparing a GPU against one thread of an
  eight-core machine overstates the win by roughly 4×, and the kit already ships a
  worker pool.

## Two measurement traps this harness exists to avoid

**Chrome demotes a hidden tab's renderer to background QoS**, parking it on the
efficiency cores. The same CPU mesher measured 19.5 µs/chunk visible and
237.6 µs/chunk hidden — a 12× swing — while the GPU figure moved 1.5%. That is
why the page gates on `document.visibilityState` and why the authoritative CPU
numbers come from Node.

**Without cross-origin isolation Chrome clamps `performance.now()` to 100 µs**,
quantising every sub-millisecond measurement into a staircase of 0.1 / 0.2 / 1.2 ms
that looks like data. `serve.py` sets COOP/COEP to get 5 µs resolution, which also
enables the `SharedArrayBuffer` the worker baseline needs.

## Scope

Blocky face visibility only. No occluders, no meta-data, no ambient occlusion, no
greedy merging, no smooth mesher, no physics, and no renderer integration. The
kernel computes the same 6-bit face masks `computeIndices` does and compacts them;
everything downstream of that is unbuilt.
