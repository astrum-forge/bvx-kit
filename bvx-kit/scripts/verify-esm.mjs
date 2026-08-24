/**
 * Proves the built package resolves and loads as real Node ESM.
 *
 * `moduleResolution: bundler` does not enforce the explicit .js extensions Node
 * requires, so this checks the thing that actually matters at the point it matters:
 * importing out/index.js the way a Node consumer will.
 */
const expected = [
    "BitArray", "HashGrid", "LinearKey", "MortonKey", "BitOps", "VoxelWorld", "BVXLayer",
    "VoxelChunk", "VoxelChunk0", "VoxelChunk8", "VoxelChunk16", "VoxelChunk32",
    "VoxelChunkArena", "VoxelIndex", "WorldIndex", "VoxelGeometry", "VoxelFaceGeometry",
    "VoxelSmoothGeometry", "VoxelQuadGeometry", "CpuSmoothMesher", "GpuSmoothMesher",
    "SMOOTH_MESHER_WGSL", "VoxelRay", "VoxelRaycaster", "VoxelPhysics", "VoxelPhysicsLayer",
    "PhysicsVoxelChunk", "BVXSerializer", "BVXMesher", "ChunkNeighbourhoodPacker",
    "ChunkNeighbourhoodReader", "BVXMesherPool", "BVXWorkerHost", "BVXPhysicsRunner",
    "BVXPhysicsHost", "BVXGeometry", "VERSION"
];

const kit = await import("../out/index.js");

const missing = expected.filter((name) => kit[name] === undefined);

if (missing.length > 0) {
    console.error(`FAIL - the built package does not export: ${missing.join(", ")}`);
    process.exit(1);
}

// a type-only export must not appear at runtime; re-exporting one as a value is the
// bug isolatedModules exists to catch, and it only shows up here
if ("Key" in kit) {
    console.error("FAIL - 'Key' is an interface and must not be a runtime export");
    process.exit(1);
}

// and the package has to actually work, not merely load
const world = new kit.VoxelWorld();
const chunk = new kit.VoxelChunk0(kit.MortonKey.from(1, 1, 1));

chunk.setBitVoxel(kit.VoxelIndex.from(1, 1, 1, 1, 1, 1));
world.insert(chunk);

const geometry = new kit.VoxelFaceGeometry();

geometry.computeIndices(chunk, world);

if (geometry.popCount() !== 6) {
    console.error(`FAIL - expected 6 visible faces from one isolated BitVoxel, got ${geometry.popCount()}`);
    process.exit(1);
}

console.log(`OK - out/index.js loads as Node ESM, exports ${expected.length} names, and meshes`);
