<h3 align="center">
  <img src="graphics/icon_2.png?raw=true" alt="Astrum Forge Studios Logo" width="400">
</h3>

[![License](https://img.shields.io/badge/license-MIT-orange.svg?style=flat)](LICENSE)

#### **Generic & Renderer-Agnostic BitVoxel Engine Implementation in TypeScript**

* * *

**_BitVoxel Engine_** is an optimized voxel rendering and data management engine, written in TypeScript and designed to be both generic and renderer-agnostic. This engine introduces a powerful approach to voxel-based environments by detaching voxel meta-data from rendering states and storing them in abstracted layers. This allows for efficient memory use and improved rendering performance, especially in large, destructible worlds.

<h3 align="center">
  <img src="graphics/info.jpg?raw=true" alt="BitVoxel Layer Composition" width="800">
</h3>

### _**What is BitVoxel Engine?**_

The **BitVoxel Engine** uses an innovative architecture that focuses on memory efficiency and real-time rendering. It achieves this through the following core features:

-   **Meta-Data Abstraction**: Voxel meta-data (e.g., material type) is separated from the rendering state, which allows the engine to render smaller voxel grids (called BitVoxels) without needing to fully subdivide the voxel space.
-   **BitVoxel Layer**: The state of each voxel is stored as a single bit in the BitVoxel Layer, dramatically reducing memory requirements while still allowing for high-resolution environments.
-   **Memory Efficiency**: The engine supports a flexible meta-data layer that can store **0**, **8**, **16**, or **32** bits per voxel, while the BitVoxel state layer requires only **1** bit per voxel. This enables the engine to handle large voxel worlds with minimal memory overhead.
-   **Performance and Scalability**: The architecture of the engine is designed with performance in mind, making it ideal for real-time applications such as games with dynamic, destructible environments.

### _**About BitVoxel Engine**_

-   Voxel Meta-Data Layer supports **0**, **8**, **16**, or **32** bits per Voxel, making it highly customizable based on the needs of the project.
-   BitVoxel State Layer uses only **1** bit per voxel, ensuring that voxel states (active/inactive) are stored with minimal memory usage.
-   Written entirely in TypeScript, with no external dependencies, making it lightweight and easy to integrate into a variety of projects.
-   Built for robustness and performance, the code is 100% unit-tested to ensure stability and reliability in production environments.
-   Released under a permissive [MIT License](LICENSE), allowing you to freely use, modify, and distribute the engine in your own projects.

For more in-depth technical details, see the accompanying [White Paper](whitepaper.pdf).

### _**Installation**_

To install the **BitVoxel Engine** in your project, you can use [npm](https://www.npmjs.com/package/@astrumforge/bvx-kit):

```console
npm install @astrumforge/bvx-kit
```

### _**Quick Setup**_

Here’s how you can quickly get started with **BitVoxel Engine** by creating and managing voxel chunks within a voxel world:

```TypeScript
import { MortonKey, VoxelChunk, VoxelWorld } from '@astrumforge/bvx-kit';

// create a new world instance to manage our Voxels
const world: VoxelWorld = new VoxelWorld();

// create a new VoxelChunk at world position (x=1, y=1, z=1)
const chunk: VoxelChunk = new VoxelChunk(MortonKey.from(1,1,1));

// insert the chunk into the world
world.insert(chunk);

// return a previously inserted VoxelChunk instance from position (x=1, y=1, z=1)
const prevChunk: VoxelChunk | null = world.get(MortonKey.from(1,1,1));

if (prevChunk !== null) {
  // do something with the VoxelChunk
}
```

### _**Key Features**_

- **Generic and Renderer-Agnostic**: The engine is designed to work with any renderer, whether you're using WebGL, Three.js, or a custom solution.
- **Optimized Memory Usage**: The separation of meta-data from voxel state reduces memory consumption, allowing for larger voxel maps with finer detail.
- **Flexible Meta-Data Layer**: Depending on the complexity of your project, you can store meta-data with different bit sizes, optimizing for memory or detail as needed.
- **TypeScript-based**: The engine is written in TypeScript, providing type safety and better tooling for developers.