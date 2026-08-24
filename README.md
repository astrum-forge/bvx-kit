<h3 align="center">
  <img src="https://raw.githubusercontent.com/astrum-forge/bvx-kit/main/graphics/icon_2.png?raw=true" alt="Astrum Forge Studios Logo" width="400">
</h3>

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# BitVoxel Engine

**A Generic & Renderer-Agnostic BitVoxel Engine Implementation in TypeScript**

**_BitVoxel Engine_** is an optimized voxel rendering and data management engine, designed to be both generic and renderer-agnostic. Written in TypeScript, it introduces a unique approach to voxel-based environments by decoupling voxel meta-data from rendering states, resulting in efficient memory usage and improved rendering performance—especially in large, destructible worlds.

<h3 align="center">
  <img src="https://raw.githubusercontent.com/astrum-forge/bvx-kit/main/graphics/info.jpg?raw=true" alt="BitVoxel Layer Composition" width="800">
</h3>

## What is BitVoxel Engine?

The **BitVoxel Engine** features a highly optimized architecture focused on memory efficiency and real-time rendering. Here are some of its core features:

- **Meta-Data Abstraction**: Voxel meta-data (e.g., material type) is separated from rendering states, enabling rendering of smaller voxel grids (BitVoxels) without fully subdividing the voxel space.
- **BitVoxel Layer**: Voxel states are stored as a single bit per voxel, significantly reducing memory usage while allowing for high-resolution environments.
- **Memory Efficiency**: A flexible meta-data layer allows for **0**, **8**, **16**, or **32** bits per voxel, while the BitVoxel state layer uses only **1** bit per voxel. This enables handling large voxel worlds with minimal memory overhead.
- **Performance and Scalability**: Designed with performance in mind, making it ideal for real-time applications such as games with dynamic, destructible environments.

## Key Features

- **Generic and Renderer-Agnostic**: Compatible with any renderer (WebGL, Three.js, custom solutions).
- **Optimized Memory Usage**: Separation of meta-data from voxel states reduces memory consumption, allowing for larger and more detailed voxel maps.
- **Flexible Meta-Data Layer**: Choose different bit sizes for meta-data storage based on project needs, optimizing either for memory or detail.
- **TypeScript-Based**: Written in TypeScript, providing type safety and better developer tooling.
- **Unit-Tested**: The code is 100% unit-tested to ensure stability and reliability.

## Geometry Lookup Table

The **Geometry Lookup Table (LUT)** pre-computes **vertices**, **normals**, and **indices** for 3D BitVoxel rendering. It uses a 6-bit BitVoxel Geometry Index to generate variations for Voxel Face Rendering. Surfaces that are invisible or fully occluded will not be rendered, optimizing the rendering pipeline.

<h3 align="center">
  <img src="https://raw.githubusercontent.com/astrum-forge/bvx-kit/main/graphics/lut.png?raw=true" alt="BitVoxel LUT Image" width="500">
</h3>

## Installation

The engine is published to **GitHub Packages**. Point the scope at that registry and
authenticate - GitHub Packages requires a token even for public packages:

```ini
# .npmrc, next to your package.json
@astrum-forge:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @astrum-forge/bvx-kit
```

A `GITHUB_TOKEN` with `read:packages` is enough. In GitHub Actions the built-in
`secrets.GITHUB_TOKEN` works as-is.

> Upgrading from 1.x? The scope changed from `@astrumforge` to `@astrum-forge`, and 2.0
> makes three breaking changes. See **[MIGRATION.md](MIGRATION.md)**.

## Quick Setup

Here’s how you can quickly set up **BitVoxel Engine** and start managing voxel chunks within a voxel world:

```typescript
import { MortonKey, VoxelChunk, VoxelChunk32, VoxelWorld } from '@astrum-forge/bvx-kit';

// Create a new VoxelWorld instance
const world: VoxelWorld = new VoxelWorld();

// Create a new VoxelChunk with 32 bits of meta-data per voxel
// at world position (x=1, y=1, z=1)
const chunk: VoxelChunk = new VoxelChunk32(MortonKey.from(1,1,1));

// Insert the chunk into the world
world.insert(chunk);

// Retrieve a previously inserted VoxelChunk
const prevChunk: VoxelChunk | null = world.get(MortonKey.from(1,1,1));

if (prevChunk !== null) {
  // Do something with the VoxelChunk
}
```

## Smooth Rendering

In addition to the blocky face geometry path (`VoxelFaceGeometry` + `BVXGeometry`), the engine provides **`VoxelSmoothGeometry`**, a Naive Surface Nets mesher that generates smooth, renderer-agnostic triangle meshes (positions, normals and indices) directly from BitVoxel data. Meshes are watertight across chunk seams and an optional smoothing parameter (0-3 field blur passes) produces progressively softer surfaces:

```typescript
import { VoxelSmoothGeometry } from '@astrum-forge/bvx-kit';

const geometry = new VoxelSmoothGeometry();

// smoothing = 2 blur passes, default winding
geometry.computeGeometry(chunk, world, 2);

// upload to any renderer
renderer.upload(geometry.vertices, geometry.normals, geometry.indices);
```

## Physics Layers

**`VoxelPhysics`** adds falling-grain simulation layers (sand, dirt, liquids) on top of the static base world, which acts as immovable collision geometry. Granular materials and liquids share one solver and differ only by parameters — diagonal sliding, lateral flow toward drop-offs, and relative density (denser grains sink through lighter ones, so sand falls through water while the water bubbles up). The simulation is entirely additive: the base engine carries zero cost when physics is not used, and a dormant simulation costs nanoseconds per update.

The application drives the simulation through an explicit update hook and remeshes only what moved:

```typescript
import { VoxelPhysics } from '@astrum-forge/bvx-kit';

const physics = new VoxelPhysics(world, { maxX: 127, maxY: 127, maxZ: 127 });
const sand = physics.addLayer(VoxelPhysics.SAND);
const water = physics.addLayer(VoxelPhysics.WATER);

sand.set(10, 40, 10); // drop a grain of sand (global BitVoxel coordinates)

// inside the application's update loop:
physics.update();

// each layer's world renders and serializes like any other VoxelWorld
for (const chunkKey of sand.drainDirtyChunks()) {
  remesh(sand.world, chunkKey);
}
```

Grains that cannot move go dormant and cost nothing until a nearby cell changes — pools of water settle completely and re-level automatically when disturbed. After editing the base world, call `physics.wakeRegion(...)` so resting grains re-evaluate their support.

## Serialization

**`BVXSerializer`** provides compact, versioned binary serialization for single chunks or entire worlds. Saving returns the binary data and loading accepts the binary data — where the bytes are stored (file, network, IndexedDB) is application logic. BitVoxel layers and meta-data are run-length encoded when that is smaller than the raw payload:

```typescript
import { BVXSerializer } from '@astrum-forge/bvx-kit';

const chunkBytes: Uint8Array = BVXSerializer.saveChunk(chunk);
const worldBytes: Uint8Array = BVXSerializer.saveWorld(world);

const loadedChunk = BVXSerializer.loadChunk(chunkBytes);
const loadedWorld = BVXSerializer.loadWorld(worldBytes);
```

## Web Workers

Geometry generation moves off the main thread with **`BVXMesher`**, **`BVXWorkerHost`** and **`BVXMesherPool`**. The core stays platform-agnostic: your application provides a tiny worker entry file, and the pool handles dispatch, coalescing, cancellation and buffer recycling.

```typescript
// mesher.worker.ts - your application's worker entry
import { BVXWorkerHost } from '@astrum-forge/bvx-kit';

new BVXWorkerHost().attach(self as never);
```

```typescript
// your application
import { BVXMesherPool, ChunkNeighbourhoodPacker } from '@astrum-forge/bvx-kit';

const pool = new BVXMesherPool({
  workers: Array.from({ length: 4 }, () =>
    new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' }))
});

const packer = new ChunkNeighbourhoodPacker();

const response = await pool.submit({
  id: 0,
  type: 'quads',
  payload: {
    kind: 'neighbourhood',
    chunk: packer.pack(chunk, world, pool.acquireOccupancy())
  }
});
```

A request carries the chunk and its 26 neighbours as packed occupancy words rather than a serialized snapshot: measured on an M1, packing one costs **1.2 us against BVW1's 17.2**, and the expensive part of the old path ran on the very thread the worker exists to keep free. Over a `SharedArrayBuffer` arena you can go further and send only slot indices, copying nothing - see `VoxelChunkArena`'s concurrency notes for what makes that safe.

### The pool owns no schedule

`BVXMesherPool` has no timer, no frame budget and no deadline. Work moves when you submit it and when a worker reports back, and at no other time - pacing belongs to the application, which is the only party that knows what else is competing for the frame. What the pool gives that pacing is something to act on:

```typescript
pool.queued;                                   // decide whether to submit more
pool.cancel(BVXMesherPool.keyOf(request));     // drop work you no longer want
await pool.drain();                            // wait for everything outstanding
```

Resubmitting a chunk that is still queued supersedes the queued job rather than adding a second one, so a chunk dirtied three times in a frame is meshed once.

## Compute Shaders

**`GpuSmoothMesher`** contours smooth surfaces with a WebGPU compute pipeline against a device your renderer owns, leaving the geometry on the GPU to be drawn directly. Measured on an M1 at smoothing 2, against the CPU mesher's 241 us per chunk: **8.3x at a batch of eight, 14x at sixty-four**.

It is not a drop-in replacement for the CPU path - it does not implement occluder meshing, its positions are f32 where the CPU's are f64-rounded-once, and it has no degenerate-normal fallback. `supports()` reports the first; the result reports the third. Read the class docs before routing to it.

If you need the vertices back on the CPU rather than drawn, use `CpuSmoothMesher` below roughly 25 chunks: the readback round trip costs more than the contouring saves.

## BitVoxel Editor

The repository contains a companion **[BitVoxel Editor](bvx-editor/)** — a browser-based editor built with React and BabylonJS for painting and viewing BitVoxels with both blocky and smooth rendering modes. The editor is fully separate from the engine (the engine remains renderer-agnostic) and doubles as a reference integration, including worker-pool meshing and `.bvx` save/load. See [bvx-editor/README.md](bvx-editor/README.md).

## Additional Resources

For more technical details, check out the [White Paper](whitepaper.pdf).
