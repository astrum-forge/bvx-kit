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

_**BitVoxels**_ is a Voxel subdivision scheme that trades flexibility for memory efficiency. Under the scheme, Voxels are subdivided into _**BitVoxel**_ states with inherited meta-data. This allows rendering smaller Voxels with predictable memory costs.

This framework is renderer agnostic and is designed to be plugged into any custom code. Additional work is required for various integrations. For the purposes of stability and robustness, full unit testing with 100% code coverage is provided.

Be warned, the framework internals uses _**ALOT**_ of Bitwise operations! 

#### _Installation_

-   Install using [npm](https://www.npmjs.com/package/@ovistek/bvx.ts)

```console
npm install @ovistek/bvx.ts
```

#### _About_

Subdividing Voxels is difficult. Think about games like Minecraft and what it would take to make those voxels smaller. Just by reducing the Voxel size by a factor of 2 (2x smaller Voxels) would require 8x more memory and a reduction of the Voxel size by a factor of 4 (4x smaller Voxels) would require a whopping 64x more memory. This is because subdividing Voxels in a grid-like manner requires O(n^3) times more memory (Cubic growth).

Of course, there are schemes such as Octrees or BSP trees however these schemes often require additional memory, are not easy to implement and have unpredictable memory costs. Think of the checkerboard pattern encoded using an Octree.

BitVoxels is an alternative subdivision scheme that stores individual voxels as a single state that can either be turned ON (visible) or OFF (invisible). this allows us to represent BitVoxels with a single bit of information. Under this scheme, to subdivide a standard Voxel by a factor of 4 (4x smaller) requires just 64 bits of data, 1 bit per BitVoxel.

This framework uses 4x subdivision, hence each standard Voxel stores 64 BitVoxel states and each Voxel stores an additional 16 bits for arbitrary meta-data. Under this scheme, each Voxel requires a total of 80 bits or 10 bytes worth of data. During rendering, the BitVoxels simply inherit the meta-data from the parent Voxel.

It is not an optimal solution, however we believe the scheme has fair tradeoffs compared to alternatives.
