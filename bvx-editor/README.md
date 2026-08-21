# BitVoxel Editor

A companion editor for the **[BitVoxel Engine](../bvx-kit/)** — paint and view BitVoxels in the browser with both **blocky** and **smooth** rendering modes. Built with **React** and **BabylonJS**, and deliberately kept separate from the engine, which remains renderer-agnostic. The editor doubles as a reference integration of the engine's rendering, serialization and worker APIs.

## Features

- **Paint / Erase / Pick** tools with brush sizes 1–4 and a 16 colour palette (colours are stored as voxel meta-data — one colour per Voxel, i.e. per 4×4×4 group of BitVoxels).
- **Sand / Water physics** via `VoxelPhysics` — pour granular sand that falls, piles and slides down slopes, and water that flows, pools and levels out. Sand sinks through water, displacing it upward. The simulation runs on a fixed 30 Hz timestep with play/pause and a clear button, and dormant grains cost nothing.
- **Blocky rendering** via `VoxelFaceGeometry` face masks and **smooth rendering** via `VoxelSmoothGeometry` (surface nets) with an adjustable smoothing level (0–3). Physics layers render in both modes (water is translucent).
- **Off-main-thread meshing** through a pool of Web Workers running `BVXWorkerHost` / `BVXMesher`, with world snapshots supplied by `BVXSerializer` and geometry returned as transferables. The simulation reports dirty chunks so only moving regions remesh.
- **Save / Load** scenes as compact binary `.bvx` files — a container holding the base world plus the sand and water layers (legacy base-world-only files still load).
- **Undo / Redo** with stroke granularity, implemented as chunk byte-snapshots. Applies to the base world only — sand and water are live simulation state and are not undo-tracked.
- Demo scene generator, live statistics and keyboard shortcuts.

## Controls

Strokes are **plane-locked**: on pointer-down the brush locks onto the plane of the surface you hit, and the whole drag paints along that surface — up walls, across floors, from any camera angle — instead of stacking voxels toward the camera.

| Input | Action |
| --- | --- |
| Left-drag | Paint / erase / pour with the active tool |
| Right-drag or `⌥`+drag | Orbit the camera |
| Middle-drag or `⌥⇧`+drag | Pan the camera |
| Mouse wheel | Zoom |
| Two-finger scroll (trackpad) | Orbit |
| Pinch (trackpad) or `Ctrl`+wheel | Zoom |
| `⇧`+scroll | Pan |
| `F` | Frame the scene contents |
| `B` / `E` / `I` | Paint / Erase / Pick tool |
| `S` / `W` | Sand / Water tool |
| `Space` | Play / pause the physics simulation |
| `1` – `4`, `[` / `]` | Brush size |
| `Tab` | Toggle blocky/smooth rendering |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+S` | Save scene |

## Running

The editor depends on the engine via a local file reference, so build the engine first:

```bash
cd bvx-kit
npm install
npm run build

cd ../bvx-editor
npm install
npm run dev
```

Then open the printed local URL (defaults to `http://localhost:5180`).

## Building

```bash
npm run build
```

Outputs a static site into `dist/`.
