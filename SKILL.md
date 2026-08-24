---
name: bvx-kit
description: Work with the @astrum-forge/bvx-kit BitVoxel engine - creating voxel worlds and chunks, editing BitVoxel state and per-voxel meta-data, generating blocky, quad or smooth render geometry, raycasting, falling-grain physics layers (sand, water), binary serialization, and worker-pool meshing. Use when writing, reviewing or debugging code that imports @astrum-forge/bvx-kit or manipulates BitVoxels, voxel chunks or voxel meshes.
license: Apache-2.0
---

# bvx-kit core API

bvx-kit is a renderer-agnostic BitVoxel engine (ESM-only TypeScript, Node >= 20).
Everything is imported from the package root: `import { ... } from '@astrum-forge/bvx-kit'`.
This file covers the core API and the rules that keep it fast and correct. `README.md`
(shipped in this package) covers the concepts in prose; `MIGRATION.md` covers the
1.x to 2.0 changes.

## Mental model - read this first

The data hierarchy, smallest to largest:

- **BitVoxel** - 1 bit of occupancy. The unit of geometry. Carries no data of its own.
- **Voxel** - a 4x4x4 block of BitVoxels (64 bits) plus one meta-data value
  (e.g. a material id). Meta-data is per *voxel*, never per BitVoxel.
- **VoxelChunk** - 4x4x4 voxels = 16x16x16 = 4096 BitVoxels. Identified by a `MortonKey`.
- **VoxelWorld** - a hash grid of chunks.

Coordinate spaces (mixing these up is the classic bvx-kit bug):

| Space | Key type | Range per axis | Addresses |
| --- | --- | --- | --- |
| Chunk coordinates | `MortonKey.from(x,y,z)` | 0-1023, wraps | a chunk in the world |
| Voxel-in-chunk | `VoxelIndex.from(x,y,z)` | 0-3 | a voxel inside one chunk |
| BitVoxel-in-voxel | `VoxelIndex.from(x,y,z,u,v,w)` | u,v,w: 0-3 | a BitVoxel inside that voxel |
| Global BitVoxel | `WorldIndex.from(x,y,z)` | 0-16383 | any BitVoxel in the world (global = chunk*16 + voxel*4 + bit) |

Render scale: the shipped geometry paths size one BitVoxel at **0.25 world units**
(`VoxelSmoothGeometry.BIT_VOXEL_SIZE`), so one chunk spans 4 units. Meshes are generated
in chunk-local space - place a chunk's mesh at `(key.x * 4, key.y * 4, key.z * 4)`.

## Installation

The package lives on GitHub Packages, which requires a token even for public reads
(`read:packages` scope is enough):

```ini
# .npmrc, next to package.json
@astrum-forge:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @astrum-forge/bvx-kit
```

## Worlds and chunks

Chunk classes differ only in meta-data width: `VoxelChunk0` (none - `setMetaData` is a
no-op), `VoxelChunk8`, `VoxelChunk16`, `VoxelChunk32`.

```typescript
import { VoxelWorld, VoxelChunk16, MortonKey } from '@astrum-forge/bvx-kit';

const world = new VoxelWorld();

const key = MortonKey.from(1, 2, 3);
const chunk = new VoxelChunk16(key);
world.insert(chunk);                 // replaces any chunk already at that key

world.get(key);                      // VoxelChunk | null
world.remove(key);                   // boolean
for (const c of world.chunks.values()) { /* every chunk */ }
```

Chunks do not auto-create: `world.get()` returns `null` for missing positions. Create
and `insert` explicitly.

## Editing voxels

All single-chunk edits go through a `VoxelIndex`:

```typescript
import { VoxelIndex } from '@astrum-forge/bvx-kit';

const voxel = VoxelIndex.from(1, 2, 3);        // voxel (1,2,3), bit (0,0,0)
chunk.fillVoxel(voxel);                        // set all 64 BitVoxels of that voxel
chunk.emptyVoxel(voxel);                       // clear all 64
chunk.setMetaData(voxel, 7);                   // per-voxel material/meta
chunk.getMetaData(voxel);                      // 7

const bit = VoxelIndex.from(1, 2, 3, 0, 3, 2); // voxel (1,2,3), bit (0,3,2)
chunk.setBitVoxel(bit);
chunk.unsetBitVoxel(bit);
chunk.toggleBitVoxel(bit);
chunk.getBitVoxel(bit);                        // 0 | 1
chunk.getBitVoxelCount(voxel);                 // set bits in that voxel, 0-64

chunk.length;                                  // set BitVoxels in the chunk, 0-4096
chunk.isEmpty; chunk.isFull;
```

To edit by global BitVoxel coordinate, split it with `WorldIndex`:

```typescript
import { WorldIndex } from '@astrum-forge/bvx-kit';

const wi = WorldIndex.from(20, 5, 9);          // global BitVoxel (20,5,9)
const target = world.get(wi.chunkIndex);
if (target !== null) {
    target.setBitVoxel(wi.voxelIndex);
}
```

## Render geometry (CPU)

Three paths, all renderer-agnostic and all sampling neighbour chunks through the world
so seams come out correct - insert chunks before meshing them.

### Blocky faces - `VoxelFaceGeometry` + `BVXGeometry`

The vertex/normal/uv buffers are **static LUTs shared by every chunk** (24 vertices per
BitVoxel, chunk-local coordinates); only the index buffer is per-chunk. Upload the LUTs
once, regenerate indices per dirty chunk:

```typescript
import { VoxelFaceGeometry, BVXGeometry } from '@astrum-forge/bvx-kit';

const faces = new VoxelFaceGeometry();
faces.computeIndices(chunk, world);            // optional third arg: occluder world
const indices = BVXGeometry.getIndices(faces); // second arg flips winding

renderer.upload(BVXGeometry.vertices, BVXGeometry.normals, BVXGeometry.uv, indices);
```

`faces.indices` is a `Uint8Array` of 4096 6-bit visibility masks (bit order
`X_POS_INDEX` .. `Z_NEG_INDEX`), `faces.touched` lists the BitVoxel indices with a
non-zero mask, and `faces.popCount()` is the visible-face total. Never mutate the
static `BVXGeometry` arrays.

### Packed quads - `VoxelQuadGeometry`

One 32-bit word per visible face with per-corner ambient occlusion baked in - built for
handing across worker boundaries and expanding into vertices in the consumer. Decode
with the static helpers (`indexOf`, `faceOf`, `occlusionOf`, `flippedOf`) and the
`CORNERS` / `NORMALS` / `TANGENTS` tables. Material comes from the chunk:
`chunk.getMetaData(new VoxelIndex(VoxelQuadGeometry.indexOf(word)))`.

```typescript
import { VoxelQuadGeometry } from '@astrum-forge/bvx-kit';

const quads = new VoxelQuadGeometry();
quads.computeQuads(chunk, world);   // (center, world, occluders?, occlusion?, source?)
quads.quads;                        // Uint32Array; the first `quads.count` words are valid
```

### Smooth surface - `VoxelSmoothGeometry`

Naive Surface Nets over the BitVoxel field, watertight across chunk seams. `smoothing`
is 0-3 field blur passes (0 = classic surface nets):

```typescript
import { VoxelSmoothGeometry } from '@astrum-forge/bvx-kit';

const smooth = new VoxelSmoothGeometry();
smooth.computeGeometry(chunk, world, 2);
// exact-length views: 3 floats per vertex, 3 indices per triangle
renderer.upload(smooth.vertices, smooth.normals, smooth.indices);
```

The `vertices` / `normals` / `indices` getters return views that alias internal buffers
and are overwritten by the next `computeGeometry()` call on the same instance - copy or
upload before reusing it.

For GPU contouring there is `GpuSmoothMesher` (WebGPU compute, leaves the geometry on
the GPU, not a drop-in for the CPU path) and `CpuSmoothMesher`, both behind the shared
`SmoothMesher` interface - read those classes' docs before routing to them.

### Multi-layer occlusion

Every mesher takes an optional occluder `VoxelWorld`: a face or surface is emitted only
where the neighbouring cell is empty in *both* worlds, and occluder cells never emit
geometry of their own. Use it to mesh co-located layers (terrain plus physics sand)
without duplicate interior faces. Occlusion is deliberately one-directional - a
transparent layer (water) lists the opaque worlds as occluders; the opaque layers omit
the water so their surfaces stay visible through it.

## Raycasting

Rays are finite segments in **global BitVoxel space** (divide render-space coordinates
by 0.25 when using the shipped scale). The result is a `WorldIndex` for the first set
BitVoxel, or `null`:

```typescript
import { VoxelRay } from '@astrum-forge/bvx-kit';

const ray = new VoxelRay().set(sx, sy, sz, ex, ey, ez);
const hit = world.raycaster.raycast(ray);
if (hit !== null) {
    const target = world.get(hit.chunkIndex);
    target?.unsetBitVoxel(hit.voxelIndex);     // e.g. dig out the hit BitVoxel
}
```

Coordinates wrap at the 1024-chunk world edge - a ray that leaves the world keeps
traversing on the wrapped side, so clamp long rays to your own bounds first. Cost is
proportional to segment length in BitVoxels, including through empty space.

## Physics (falling grains and liquids)

`VoxelPhysics` layers granular/liquid simulation on top of a static base world, which
is never modified and acts as collision geometry. Layer coordinates are global BitVoxel
coordinates.

```typescript
import { VoxelPhysics, MortonKey } from '@astrum-forge/bvx-kit';

const physics = new VoxelPhysics(world, { maxX: 127, maxY: 127, maxZ: 127 });
const sand = physics.addLayer(VoxelPhysics.SAND);    // or WATER, or custom params
sand.set(10, 40, 10);                                // drop a grain

// per frame (or fixed timestep):
const result = physics.update();                     // update(ticks = 1, maxWork = 0)
for (const key of sand.drainDirtyChunks()) {
    remesh(sand.world, new MortonKey(key));          // remesh only what moved
}
```

Rules that matter:

- `update()` is the only thing that advances the simulation. `maxWork > 0` budgets cell
  probes; check `result.complete` - `false` means a tick is still open and the next
  `update()` resumes it.
- Grains that cannot move go dormant and cost ~nothing. After editing the **base**
  world, call `physics.wakeRegion(minX, minY, minZ, maxX, maxY, maxZ)` so resting
  grains re-evaluate their support.
- Each layer's `world` is a plain `VoxelWorld` - mesh and serialize it like any other.
  Mesh a layer with the base world as occluders (and vice versa) to avoid duplicated
  faces at their interfaces.
- Custom materials are just `VoxelPhysicsParams` (`{ slide, flow, flowDistance,
  density }`). Denser grains sink through lighter layers - sand falls through water.

## Serialization

Compact, versioned binary. Where the bytes are stored (file, network, IndexedDB) is
application logic:

```typescript
import { BVXSerializer } from '@astrum-forge/bvx-kit';

const bytes = BVXSerializer.saveWorld(world);   // or saveChunk(chunk); Uint8Array
const loaded = BVXSerializer.loadWorld(bytes);  // or loadChunk(bytes)
```

Do not use the serialized format as a worker wire format - pack a neighbourhood instead
(below); it measured 1.2 us against 17.2 us per request.

## Worker meshing

The core is platform-agnostic: the application supplies a tiny worker entry file, and
the pool handles dispatch, coalescing, cancellation and buffer recycling:

```typescript
// mesher.worker.ts - the whole file
import { BVXWorkerHost } from '@astrum-forge/bvx-kit';
new BVXWorkerHost().attach(self as never);
```

```typescript
// application side
import { BVXMesherPool, ChunkNeighbourhoodPacker } from '@astrum-forge/bvx-kit';

const pool = new BVXMesherPool({
    workers: Array.from({ length: 4 }, () =>
        new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })),
});
const packer = new ChunkNeighbourhoodPacker();

const response = await pool.submit({
    id: 0,
    type: 'quads',                              // or 'faces' / 'smooth', see below
    payload: {
        kind: 'neighbourhood',
        chunk: packer.pack(chunk, world, pool.acquireOccupancy()),
    },
});
```

- Request types: `quads` needs nothing beyond the payload; `faces` also requires
  `flipped: boolean`; `smooth` also requires `smoothing: number` and `flipped: boolean`.
  Response buffers mirror the synchronous generators (`quads` + widened `metaData`,
  `faceMasks` + `touched`, or `vertices` / `normals` / `indices`).
- The pool has no timer and no frame budget - pacing is the application's job. Use
  `pool.queued` to decide whether to submit, `pool.cancel(BVXMesherPool.keyOf(req))` to
  drop work, and `await pool.drain()` to flush everything outstanding.
- Resubmitting a chunk that is still queued **supersedes** the queued job - a chunk
  dirtied three times in a frame is meshed once.
- Zero-copy over `SharedArrayBuffer`: allocate chunks from a `VoxelChunkArena` and send
  arena payloads naming slots instead of copying occupancy. Read the concurrency notes
  on `VoxelChunkArena` first - publish-by-message is the cheapest sound protocol.
- `BVXMesher` itself is DOM-free, so the same class runs on the main thread, in a Web
  Worker, or in a Node worker thread. Physics has the same split:
  `BVXPhysicsRunner` (worker side) and `BVXPhysicsHost` (application side).

## Conventions and gotchas

- **`optres` out-params everywhere.** Every key and geometry API accepts an optional
  pre-allocated result (`MortonKey.from(x, y, z, myKey)`). Use them in per-frame code
  to avoid GC pressure; fresh allocations are fine in cold paths.
- **Meta-data is per voxel.** 64 BitVoxels share one meta value, and
  `VoxelChunk0.setMetaData` silently does nothing.
- **Insert before meshing.** Meshers and physics sample neighbours through the world; a
  chunk meshed before its neighbours exist renders differently once they arrive.
- **Keys wrap, nothing throws.** MortonKey axes are 0-1023 (-1 wraps to 1023); global
  BitVoxel space is 0-16383. Out-of-range coordinates silently wrap.
- **Reused buffers.** `VoxelSmoothGeometry` getters and pool-recycled response buffers
  alias memory that later calls overwrite - copy or upload before the next compute or
  submit.
- Lower-level exports: `BitArray`, `HashGrid`, `LinearKey`, `BitOps` (containers and
  bit utilities), `SMOOTH_MESHER_WGSL` (the WebGPU compute source), and `VERSION` (the
  package version string, stamped from the release tag).
