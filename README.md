<h3 align="center">
  <img src="graphics/icon_2.png?raw=true" alt="Astrum Forge Studios Logo" width="400">
</h3>

![License: Prosperity Public License](https://img.shields.io/badge/license-Prosperity%20Public%20License-blue)

# BitVoxel Engine

**A Generic & Renderer-Agnostic BitVoxel Engine Implementation in TypeScript**

**_BitVoxel Engine_** is an optimized voxel rendering and data management engine, designed to be both generic and renderer-agnostic. Written in TypeScript, it introduces a unique approach to voxel-based environments by decoupling voxel meta-data from rendering states, resulting in efficient memory usage and improved rendering performance—especially in large, destructible worlds.

<h3 align="center">
  <img src="graphics/info.jpg?raw=true" alt="BitVoxel Layer Composition" width="800">
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
  <img src="graphics/lut.png?raw=true" alt="BitVoxel LUT Image" width="500">
</h3>

## Installation

Install the **BitVoxel Engine** using npm:

```bash
npm install @astrumforge/bvx-kit
```

## Quick Setup

Here’s how you can quickly set up **BitVoxel Engine** and start managing voxel chunks within a voxel world:

```typescript
import { MortonKey, VoxelChunk, VoxelWorld } from '@astrumforge/bvx-kit';

// Create a new VoxelWorld instance
const world: VoxelWorld = new VoxelWorld();

// Create a new VoxelChunk at world position (x=1, y=1, z=1)
const chunk: VoxelChunk = new VoxelChunk(MortonKey.from(1,1,1));

// Insert the chunk into the world
world.insert(chunk);

// Retrieve a previously inserted VoxelChunk
const prevChunk: VoxelChunk | null = world.get(MortonKey.from(1,1,1));

if (prevChunk !== null) {
  // Do something with the VoxelChunk
}
```

## Additional Resources

For more technical details, check out the [White Paper](whitepaper.pdf).