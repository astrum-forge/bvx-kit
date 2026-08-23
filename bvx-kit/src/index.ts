// export containers
export { BitArray } from "./lib/containers/bit-array.js";
export { HashGrid } from "./lib/containers/hash-grid.js";

// export mapping/hashing keys
export { Key } from "./lib/math/key.js";
export { LinearKey } from "./lib/math/linear-key.js";
export { MortonKey } from "./lib/math/morton-key.js";

// export util
export { BitOps } from "./lib/util/bit-ops.js";

// export engine
export { VoxelWorld } from "./lib/engine/voxel-world.js";
export { BVXLayer } from "./lib/engine/layer/bvx-layer.js";
export { VoxelChunk } from "./lib/engine/chunks/voxel-chunk.js";
export { VoxelChunk0 } from "./lib/engine/chunks/voxel-chunk-0.js";
export { VoxelChunk8 } from "./lib/engine/chunks/voxel-chunk-8.js";
export { VoxelChunk16 } from "./lib/engine/chunks/voxel-chunk-16.js";
export { VoxelChunk32 } from "./lib/engine/chunks/voxel-chunk-32.js";
export { VoxelChunkArena } from "./lib/engine/chunks/voxel-chunk-arena.js";
export type { ChunkStorage } from "./lib/engine/chunks/chunk-storage.js";
export { VoxelIndex } from "./lib/engine/voxel-index.js";
export { WorldIndex } from "./lib/engine/world-index.js";
export { VoxelGeometry } from "./lib/engine/geometry/voxel-geometry.js";
export { VoxelFaceGeometry } from "./lib/engine/geometry/voxel-face-geometry.js";
export { VoxelSmoothGeometry } from "./lib/engine/geometry/voxel-smooth-geometry.js";
export type { SmoothOcclusionMode } from "./lib/engine/geometry/voxel-smooth-geometry.js";
export { VoxelQuadGeometry } from "./lib/engine/geometry/voxel-quad-geometry.js";
export { CpuSmoothMesher } from "./lib/engine/geometry/cpu-smooth-mesher.js";
export { GpuSmoothMesher } from "./lib/engine/geometry/gpu-smooth-mesher.js";
export type { GpuSmoothMeshHandle, GpuSmoothMesherOptions } from "./lib/engine/geometry/gpu-smooth-mesher.js";
export { SMOOTH_MESHER_WGSL } from "./lib/engine/geometry/smooth-mesher.wgsl.js";
export type { SmoothMesher, SmoothMeshRequest, SmoothMeshResult, SmoothMeshResidency } from "./lib/engine/geometry/smooth-mesher.js";
export type { QuadOcclusion, QuadOcclusionSource } from "./lib/engine/geometry/voxel-quad-geometry.js";
export { VoxelRay } from "./lib/engine/raycaster/voxel-ray.js";
export { VoxelRaycaster } from "./lib/engine/raycaster/voxel-raycaster.js";

// export physics
export { VoxelPhysics } from "./lib/engine/physics/voxel-physics.js";
export type { VoxelPhysicsOptions } from "./lib/engine/physics/voxel-physics.js";
export { VoxelPhysicsLayer } from "./lib/engine/physics/voxel-physics-layer.js";
export type { VoxelPhysicsParams } from "./lib/engine/physics/voxel-physics-layer.js";
export { PhysicsVoxelChunk } from "./lib/engine/physics/physics-voxel-chunk.js";

// export serialization
export { BVXSerializer } from "./lib/serialize/bvx-serializer.js";

// export worker support
export { BVXMesher } from "./lib/worker/bvx-mesher.js";
export type { MesherRequest, MesherFacesRequest, MesherSmoothRequest, MesherResponse, MesherFacesResponse, MesherSmoothResponse } from "./lib/worker/bvx-mesher.js";
export { BVXWorkerHost } from "./lib/worker/bvx-worker-host.js";
export type { MesherScope } from "./lib/worker/bvx-worker-host.js";
export { BVXPhysicsRunner } from "./lib/worker/bvx-physics-runner.js";
export type { PhysicsRequest, PhysicsAttachRequest, PhysicsEditRequest, PhysicsInjectRequest, PhysicsStepRequest, PhysicsResponse, PhysicsStepResponse, PhysicsAckResponse, PhysicsLayerDelta } from "./lib/worker/bvx-physics-runner.js";
export { BVXPhysicsHost } from "./lib/worker/bvx-physics-host.js";
export type { PhysicsScope } from "./lib/worker/bvx-physics-host.js";

// export generators
export { BVXGeometry } from "./lib/geometry/bvx-geometry.js";