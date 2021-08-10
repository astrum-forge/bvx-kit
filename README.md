<h3 align="center">
  <img src="graphics/icon.png?raw=true" alt="OvisTek Logo" width="150">
</h3>

[![Twitter: @OvisTek](https://img.shields.io/badge/contact-OvisTek-blue.svg?style=flat)](https://twitter.com/OvisTek)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/4b7dbe49f42d465bb3b6f3c669801764)](https://www.codacy.com/gh/OvisTek/bvx.ts/dashboard?utm_source=github.com&utm_medium=referral&utm_content=OvisTek/bvx.ts&utm_campaign=Badge_Grade)
[![Coverage Badge](badges/coverage-global%20coverage.svg)](badges)
[![install size](https://packagephobia.com/badge?p=@ovistek/bvx.ts)](https://packagephobia.com/result?p=@ovistek/bvx.ts)
[![NPM](https://img.shields.io/npm/v/@ovistek/bvx.ts)](https://www.npmjs.com/package/@ovistek/bvx.ts)
[![License](https://img.shields.io/badge/license-MIT-orange.svg?style=flat)](LICENSE)

#### **Generic & Renderer Agnostic BitVoxel Engine Implementation in TypeScript**

* * *

_**BitVoxel Engine**_ detaches Voxel meta-data and Rendering state data into abstracted layers. This allows rendering smaller voxels with inherited meta-data without subdividing the Voxel layer.

<h3 align="center">
  <img src="graphics/info.jpg?raw=true" alt="BitVoxel Layer Composition" width="800">
</h3>

### _**About**_

-   Voxel Meta-Data Layer requires **0**, **8**, **16** or **32** bit per Voxel
-   BitVoxel State Layer requires **1** bit per BitVoxel
-   Written in TypeScript with no external dependencies
-   Designed for Robustness & Performance with 100% unit tested code
-   Permissive [MIT License](LICENSE)

### _**Installation**_

-   Install using [npm](https://www.npmjs.com/package/@ovistek/bvx.ts)

```console
npm install @ovistek/bvx.ts
```

### _**Quick Setup**_

```TypeScript
import { MortonKey, VoxelChunk, VoxelWorld } from '@ovistek/bvx.ts';

// create a new world instance to manage our Voxels
const world:VoxelWorld = new VoxelWorld();

// create a new VoxelChunk at world position (x=1,y=1,z=1)
const chunk:VoxelChunk = new VoxelChunk(MortonKey.from(1,1,1));

// insert the chunk into the world
world.insert(chunk);

// return a previously inserted VoxelChunk instance from position (x=1,y=1,z=1)
const prevChunk:VoxelChunk | null = world.get(MortonKey.from(1,1,1));

if (prevChunk !== null) {
  // do something with VoxelChunk
}
```
