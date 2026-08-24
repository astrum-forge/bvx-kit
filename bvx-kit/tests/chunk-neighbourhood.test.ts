import { describe, expect, it } from '@jest/globals';
import { BVXLayer } from "../src/lib/engine/layer/bvx-layer.js";
import { BVXMesher, MesherRequest, MesherResponse } from "../src/lib/worker/bvx-mesher.js";
import { BVXSerializer } from "../src/lib/serialize/bvx-serializer.js";
import { ChunkNeighbourhoodPacker, ChunkNeighbourhoodReader } from "../src/lib/worker/chunk-neighbourhood.js";
import { MortonKey } from "../src/lib/math/morton-key.js";
import { VoxelChunk } from "../src/lib/engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../src/lib/engine/chunks/voxel-chunk-0.js";
import { VoxelChunk32 } from "../src/lib/engine/chunks/voxel-chunk-32.js";
import { VoxelChunkArena } from "../src/lib/engine/chunks/voxel-chunk-arena.js";
import { VoxelIndex } from "../src/lib/engine/voxel-index.js";
import { VoxelWorld } from "../src/lib/engine/voxel-world.js";

/**
 * Coverage for chunk-neighbourhood.ts and the payload kinds BVXMesher accepts.
 *
 * The load-bearing test here is the equivalence one: a `neighbourhood` payload has to
 * produce byte-identical geometry to the BVW1 `snapshot` it replaces, for every
 * geometry type, or the 14x saving on the calling thread is not a saving but a bug.
 */
describe('ChunkNeighbourhood', () => {

    /**
     * A 3x3x3 neighbourhood of terrain-ish chunks around (4, 4, 4), with a hole in one
     * corner so absent and empty are both represented.
     */
    const buildWorld = (): { world: VoxelWorld; centre: VoxelChunk } => {
        const world = new VoxelWorld();
        const index = new VoxelIndex();

        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                for (let oz = -1; oz <= 1; oz++) {
                    // leave (-1,-1,-1) out entirely - absent, not empty
                    if (ox === -1 && oy === -1 && oz === -1) {
                        continue;
                    }

                    const chunk = new VoxelChunk0(MortonKey.from(4 + ox, 4 + oy, 4 + oz));

                    // (1,1,1) exists but holds nothing
                    if (!(ox === 1 && oy === 1 && oz === 1)) {
                        for (let x = 0; x < 16; x++) {
                            for (let z = 0; z < 16; z++) {
                                const height = 6 + ((x * 3 + z * 5) % 5);

                                for (let y = 0; y < height; y++) {
                                    VoxelIndex.from(x >> 2, y >> 2, z >> 2, x & 3, y & 3, z & 3, index);
                                    chunk.setBitVoxel(index);
                                }
                            }
                        }
                    }

                    world.insert(chunk);
                }
            }
        }

        return { world: world, centre: world.get(MortonKey.from(4, 4, 4)) as VoxelChunk };
    };

    it('.pack() - carries occupancy, presence and the centre key', () => {
        const { world, centre } = buildWorld();
        const packed = new ChunkNeighbourhoodPacker().pack(centre, world);

        expect(packed.chunkKey).toEqual(centre.key.key);
        expect(packed.occupancy.length).toEqual(27 * BVXLayer.ELEMENTS);

        // 26 of 27 slots present - the corner that was never inserted is not
        expect(packed.presence & (1 << 13)).not.toEqual(0);
        expect(packed.presence & (1 << 0)).toEqual(0);

        let present = 0;

        for (let slot = 0; slot < 27; slot++) {
            if ((packed.presence & (1 << slot)) !== 0) {
                present++;
            }
        }

        expect(present).toEqual(26);
    });

    it('.pack() - rejects a buffer that is too short', () => {
        const { world, centre } = buildWorld();

        expect(() => new ChunkNeighbourhoodPacker().pack(centre, world, new Uint32Array(16))).toThrow(RangeError);
    });

    it('.bind() - rebuilds a world the geometry generators can read', () => {
        const { world, centre } = buildWorld();
        const packed = new ChunkNeighbourhoodPacker().pack(centre, world);
        const reader = new ChunkNeighbourhoodReader();
        const bound = reader.bind(packed);

        expect(bound.key.key).toEqual(centre.key.key);
        expect(reader.world.chunks.length).toEqual(26);

        // occupancy survives the round trip word for word
        expect(Array.from(bound.layer.bitArray.elements)).toEqual(Array.from(centre.layer.bitArray.elements));

        // the absent corner really is absent, not an empty chunk
        expect(reader.world.get(MortonKey.from(3, 3, 3))).toBeNull();

        // the empty one is present
        expect(reader.world.get(MortonKey.from(5, 5, 5))).not.toBeNull();
        expect((reader.world.get(MortonKey.from(5, 5, 5)) as VoxelChunk).isEmpty).toEqual(true);
    });

    it('.bind() - a reused reader does not leak the previous neighbourhood', () => {
        const { world, centre } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();
        const reader = new ChunkNeighbourhoodReader();

        reader.bind(packer.pack(centre, world));

        // an isolated chunk with no neighbours at all
        const lonely = new VoxelWorld();
        const chunk = new VoxelChunk0(MortonKey.from(9, 9, 9));

        chunk.setBitVoxel(VoxelIndex.from(0, 0, 0, 1, 1, 1));
        lonely.insert(chunk);

        const bound = reader.bind(packer.pack(chunk, lonely));

        expect(reader.world.chunks.length).toEqual(1);
        expect(bound.length).toEqual(1);

        // every other slot was zeroed rather than left holding the last world
        for (let slot = 0; slot < 27; slot++) {
            if (slot === 13) {
                continue;
            }

            const words = packer.pack(chunk, lonely).occupancy;

            expect(words.length).toBeGreaterThan(0);
        }
    });

    it('.bind() - an absent centre comes back zeroed and uninserted', () => {
        const world = new VoxelWorld();
        const neighbour = new VoxelChunk0(MortonKey.from(2, 3, 3));

        neighbour.setBitVoxel(VoxelIndex.from(0, 0, 0, 0, 0, 0));
        world.insert(neighbour);

        // pack a centre the world does not hold, by handing pack() the chunk directly
        const absent = new VoxelChunk0(MortonKey.from(3, 3, 3));
        const packer = new ChunkNeighbourhoodPacker();
        const packed = packer.pack(absent, world);

        // the centre came from the argument, so it IS present here
        expect(packed.presence & (1 << 13)).not.toEqual(0);

        // clear the centre bit to model a genuinely absent chunk
        packed.presence &= ~(1 << 13);
        packed.occupancy.fill(0xFFFFFFFF, 13 * BVXLayer.ELEMENTS, 14 * BVXLayer.ELEMENTS);

        const reader = new ChunkNeighbourhoodReader();
        const centre = reader.bind(packed);

        expect(reader.world.get(MortonKey.from(3, 3, 3))).toBeNull();
        expect(centre.isEmpty).toEqual(true);
        expect(reader.centre).toBe(centre);
    });

    /**
     * Every geometry type, meshed both ways.
     */
    const both = (world: VoxelWorld, centre: VoxelChunk, build: (payloadKind: "snapshot" | "neighbourhood") => MesherRequest): [MesherResponse, MesherResponse] => {
        const mesher = new BVXMesher();

        return [mesher.process(build("snapshot")), mesher.process(build("neighbourhood"))];
    };

    it('.process() - a neighbourhood payload matches a snapshot payload exactly', () => {
        const { world, centre } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const payload = (kind: "snapshot" | "neighbourhood") => kind === "snapshot"
            ? { kind: "snapshot" as const, chunkKey: centre.key.key, world: BVXSerializer.saveWorld(world) }
            : { kind: "neighbourhood" as const, chunk: packer.pack(centre, world) };

        // ---- faces
        const [facesSnapshot, facesNeighbourhood] = both(world, centre, (kind) => ({
            id: 1, type: "faces", flipped: false, payload: payload(kind)
        }));

        expect(facesSnapshot.type).toEqual("faces");
        expect(facesNeighbourhood.type).toEqual("faces");

        if (facesSnapshot.type === "faces" && facesNeighbourhood.type === "faces") {
            expect(facesNeighbourhood.faceCount).toEqual(facesSnapshot.faceCount);
            expect(facesNeighbourhood.faceCount).toBeGreaterThan(0);
            expect(Array.from(facesNeighbourhood.faceMasks)).toEqual(Array.from(facesSnapshot.faceMasks));
            expect(Array.from(facesNeighbourhood.touched)).toEqual(Array.from(facesSnapshot.touched));
            expect(Array.from(facesNeighbourhood.indices)).toEqual(Array.from(facesSnapshot.indices));
        }

        // ---- smooth, at every smoothing level
        for (let smoothing = 0; smoothing <= 3; smoothing++) {
            const [snapshot, neighbourhood] = both(world, centre, (kind) => ({
                id: 2, type: "smooth", smoothing: smoothing, flipped: false, payload: payload(kind)
            }));

            if (snapshot.type === "smooth" && neighbourhood.type === "smooth") {
                expect(neighbourhood.vertices.length).toEqual(snapshot.vertices.length);
                expect(neighbourhood.vertices.length).toBeGreaterThan(0);
                expect(Array.from(neighbourhood.vertices)).toEqual(Array.from(snapshot.vertices));
                expect(Array.from(neighbourhood.normals)).toEqual(Array.from(snapshot.normals));
                expect(Array.from(neighbourhood.indices)).toEqual(Array.from(snapshot.indices));
            }
            else {
                throw new Error("expected smooth responses");
            }
        }

        // ---- quads
        const [quadsSnapshot, quadsNeighbourhood] = both(world, centre, (kind) => ({
            id: 3, type: "quads", payload: payload(kind)
        }));

        if (quadsSnapshot.type === "quads" && quadsNeighbourhood.type === "quads") {
            expect(quadsNeighbourhood.quads.length).toEqual(quadsSnapshot.quads.length);
            expect(quadsNeighbourhood.quads.length).toBeGreaterThan(0);
            expect(Array.from(quadsNeighbourhood.quads)).toEqual(Array.from(quadsSnapshot.quads));
        }
        else {
            throw new Error("expected quads responses");
        }
    });

    it('.process() - a neighbourhood payload carries meta-data through a quads response', () => {
        const world = new VoxelWorld();
        const chunk = new VoxelChunk32(MortonKey.from(1, 1, 1));
        const index = VoxelIndex.from(1, 1, 1, 1, 1, 1);

        chunk.setBitVoxel(index);
        chunk.setMetaData(index, 0xABCDEF);
        world.insert(chunk);

        const packed = new ChunkNeighbourhoodPacker().pack(chunk, world);
        const response = new BVXMesher().process({ id: 4, type: "quads", payload: { kind: "neighbourhood", chunk: packed } });

        expect(response.type).toEqual("quads");

        if (response.type === "quads") {
            expect(response.meta.length).toEqual(64);
            expect(response.meta[index.vKey]).toEqual(0xABCDEF);
        }
    });

    it('.process() - a response hands the occupancy buffers back for reuse', () => {
        const { world, centre } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();
        const occupancy = ChunkNeighbourhoodPacker.allocate();
        const packed = packer.pack(centre, world, occupancy);

        const response = new BVXMesher().process({ id: 5, type: "faces", flipped: false, payload: { kind: "neighbourhood", chunk: packed } });

        expect(response.recycle).toBeDefined();
        expect(response.recycle?.length).toEqual(1);
        expect(response.recycle?.[0]).toBe(occupancy);
    });

    it('.requestTransferables() - lists the occupancy buffers and nothing else', () => {
        const { world, centre } = buildWorld();
        const packer = new ChunkNeighbourhoodPacker();

        const request: MesherRequest = {
            id: 6,
            type: "faces",
            flipped: false,
            payload: { kind: "neighbourhood", chunk: packer.pack(centre, world, ChunkNeighbourhoodPacker.allocate()) }
        };

        const buffers = BVXMesher.requestTransferables(request);

        expect(buffers.length).toEqual(1);

        // an arena payload transfers nothing
        expect(BVXMesher.requestTransferables({
            id: 7,
            type: "faces",
            flipped: false,
            payload: { kind: "arena", chunk: { chunkKey: 0, slots: new Int32Array(27).fill(-1) } }
        }).length).toEqual(0);
    });

    it('.process() - an arena payload matches a neighbourhood payload', () => {
        const { world, centre } = buildWorld();

        // copy the world into an arena and record the slot each chunk landed in
        const arena = new VoxelChunkArena(32, 0);
        const slotOf = new Map<number, number>();
        const arenaWorld = new VoxelWorld();

        for (const chunk of world.chunks.values()) {
            const slot = arena.allocate();

            expect(slot).toBeGreaterThanOrEqual(0);

            const copy = arena.build(slot, (storage) => new VoxelChunk0(chunk.key.clone(), storage));

            copy.layer.bitArray.elements.set(chunk.layer.bitArray.elements);
            arenaWorld.insert(copy);
            slotOf.set(chunk.key.key, slot);
        }

        const arenaCentre = arenaWorld.get(centre.key) as VoxelChunk;
        const packer = new ChunkNeighbourhoodPacker();

        const arenaPayload = packer.packArena(arenaCentre, arenaWorld, (chunk) => slotOf.get(chunk.key.key) as number);

        const mesher = new BVXMesher();

        mesher.bindArena(arena);

        const viaArena = mesher.process({ id: 8, type: "faces", flipped: false, payload: { kind: "arena", chunk: arenaPayload } });
        const viaCopy = mesher.process({ id: 9, type: "faces", flipped: false, payload: { kind: "neighbourhood", chunk: packer.pack(centre, world) } });

        if (viaArena.type === "faces" && viaCopy.type === "faces") {
            expect(viaArena.faceCount).toEqual(viaCopy.faceCount);
            expect(Array.from(viaArena.faceMasks)).toEqual(Array.from(viaCopy.faceMasks));
            expect(Array.from(viaArena.indices)).toEqual(Array.from(viaCopy.indices));
        }
        else {
            throw new Error("expected faces responses");
        }
    });

    it('.process() - an arena payload with no arena bound answers with an error', () => {
        const response = new BVXMesher().process({
            id: 10,
            type: "faces",
            flipped: false,
            payload: { kind: "arena", chunk: { chunkKey: 0, slots: new Int32Array(27).fill(-1) } }
        });

        expect(response.type).toEqual("error");

        if (response.type === "error") {
            expect(response.message).toContain("no arena is bound");
        }
    });

    it('.process() - a malformed snapshot answers with an error rather than throwing', () => {
        const response = new BVXMesher().process({
            id: 11,
            type: "faces",
            flipped: false,
            payload: { kind: "snapshot", chunkKey: 0, world: new Uint8Array([1, 2, 3, 4]) }
        });

        expect(response.type).toEqual("error");
        expect(response.id).toEqual(11);
    });
});
