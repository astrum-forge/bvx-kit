# Measured results — WebGPU compute face mesher vs CPU face mesher

Machine: Apple M1 (4P+4E, 8 logical), Metal 3, macOS 25.5.0.
Chrome WebGPU, cross-origin isolated (5 µs timer resolution). Node v25.2.1.
World: value-noise terrain heightfield, 24×6×24 = 3456 chunks of 16³ BitVoxels.
  empty 2103 (60.9%) · full 607 (17.6%) · mixed/surface 746 (21.6%)

**Correctness: the GPU kernel reproduces the CPU mesher's output exactly.**
394,534 faces / 338,495 touched on the mixed world and 387,298 / 327,932 on the
surface-only world, from all three of: Node CPU, browser CPU, browser GPU.
Zero uncaptured GPU errors.

## Throughput

| Workload | CPU 1 thread | CPU 8 workers | GPU compute |
| --- | ---: | ---: | ---: |
| surface chunks only (746) | 18.11 µs/ch | 4.21 µs/ch | **1.61 µs/ch** |
| realistic mixed world (3456) | 6.00 µs/ch | — | **0.64 µs/ch** |
| sustained surface chunks/s | 55 k | 237 k | **620 k** |

GPU vs 1 thread: **11.2×**.  GPU vs an 8-worker pool: **2.6×**.
CPU worker-pool scaling on M1: 1.89× / 3.49× / 4.31× at 2 / 4 / 8 workers.

Note the GPU wins the mixed world (9.4×) *despite* not having the CPU's
solid-buried fast path — it pays full price for the 17.6% of chunks that are
solid. It does get the empty-chunk skip free, because a zero occupancy word
exits the bit-scan loop immediately.

## The crossover — cost vs chunks per dispatch

Identical input at every size; only the dispatch count varies.

| Chunks | GPU µs/ch | CPU µs/ch | Winner |
| ---: | ---: | ---: | --- |
| 1 | 96.30 | 15.82 | CPU 6.1× |
| 2 | 52.07 | 19.61 | CPU 2.7× |
| 4 | 26.74 | 25.01 | CPU 1.07× |
| 8 | 13.11 | 28.72 | GPU 2.2× |
| 16 | 7.21 | 27.79 | GPU 3.9× |
| 32 | 4.07 | 18.84 | GPU 4.6× |
| 64 | 2.51 | 19.97 | GPU 8.0× |
| 128 | 2.34 | 19.75 | GPU 8.5× |
| 256 | 1.90 | 19.29 | GPU 10.2× |
| 512 | 1.72 | 21.25 | GPU 12.4× |
| 746 | 1.64 | 19.93 | GPU 12.1× |

**Crossover is at ~5 chunks per dispatch.** The GPU carries a fixed ~95–105 µs
floor per submitted batch that does not shrink below it.

## Overheads

| | |
| --- | ---: |
| 1 dispatch per submit | 29.3 µs |
| 10 dispatches per submit | 3.26 µs each |
| 100 dispatches per submit | 1.08 µs each |
| 1000 dispatches per submit | 0.88 µs each |
| submit + await completion, serialised | **279–344 µs** |

## Upload (`queue.writeBuffer`)

| Size | Time | Rate |
| ---: | ---: | ---: |
| 512 B (one chunk) | 0.0007 ms | 0.69 GB/s |
| 13.8 KB (27-chunk neighbourhood) | 0.0035 ms | 3.92 GB/s |
| 64 KB | 0.0145 ms | 4.52 GB/s |
| 1 MB | 0.247 ms | 4.25 GB/s |
| 16 MB | 10.99 ms | 1.53 GB/s |

Scattered 512 B writes (the streaming-dirty-chunks case):
0.90 µs each at 25 writes, 0.46 µs at 200, 0.44 µs at 1000.

## Readback latency — the number that decides physics and editor latency

| Payload | Round trip |
| ---: | ---: |
| 16 B | 0.318 ms |
| 4 KB | 0.446 ms |
| 256 KB | 0.403 ms |
| 4 MB | 0.715 ms |

Latency-dominated, not bandwidth-dominated: 16 bytes costs 0.32 ms.

Editor case — remesh then read the result back before drawing:

| Chunks remeshed | GPU + readback | CPU, no round trip | |
| ---: | ---: | ---: | --- |
| 1 | 0.631 ms | 0.016 ms | CPU 39.6× lower latency |
| 4 | 0.635 ms | 0.101 ms | CPU 6.3× |
| 25 | 0.666 ms | 0.567 ms | CPU 1.2× |

## Device limits (Apple M1 / Metal 3, Chrome)

maxStorageBufferBindingSize 4,294,967,292 · maxBufferSize 4,294,967,292 ·
maxComputeInvocationsPerWorkgroup 1024 · maxComputeWorkgroupStorageSize 32,768 ·
maxComputeWorkgroupsPerDimension 65,535 · maxStorageBuffersPerShaderStage 10 ·
`subgroups` **available** · `timestamp-query` advertised.

## Method and its limits

- Kernel: one workgroup per chunk, `workgroup_size(128)`, one u32 occupancy word
  (32 BitVoxels) per invocation, centre chunk staged into 512 B of workgroup
  memory. Per thread: count, one `atomicAdd` to reserve a contiguous output
  range, then emit. Output is a compacted `(chunk, bitvoxel, mask)` record list.
- The CPU side is a faithful port of `VoxelFaceGeometry.computeIndices` as it
  stands after the 23 Aug perf pass — empty fast path, solid-buried fast path,
  solid-shell boundary walk, word-skip bit scan, six hand-unrolled direction
  samples. It is not a strawman.
- Timing used `queue.onSubmittedWorkDone()` wall clock, not timestamp queries
  (Chrome zeroes those here). GPU figures therefore include submission and
  completion cost, which is the honest thing to charge them.
- **Chrome demotes a hidden tab's renderer to background QoS**, parking it on the
  efficiency cores: the same CPU mesher measured 19.5 µs/chunk visible and
  237.6 µs/chunk hidden, a 12× swing, while the GPU figure moved 1.5%. All CPU
  figures above come from Node, which is not subject to this; the visible browser
  run agreed with Node within 9%.
- Terrain here averages 519 visible faces per surface chunk against the 312 of the
  repo's own harness, so absolute µs/chunk is not directly comparable to the
  21.9 µs in `kit-performance-report.md`. Every comparison above is CPU and GPU
  against the *same* data on the *same* machine, which is the ratio that matters.
- Not measured: the smooth mesher, physics, and any renderer integration. This
  benches the blocky face mesher only.
