import { MortonKey } from "../math/morton-key.js";
import { VoxelChunk } from "../engine/chunks/voxel-chunk.js";
import { VoxelChunk0 } from "../engine/chunks/voxel-chunk-0.js";
import { VoxelChunk8 } from "../engine/chunks/voxel-chunk-8.js";
import { VoxelChunk16 } from "../engine/chunks/voxel-chunk-16.js";
import { VoxelChunk32 } from "../engine/chunks/voxel-chunk-32.js";
import { VoxelWorld } from "../engine/voxel-world.js";

/**
 * BVXSerializer provides compact binary serialization for VoxelChunks and entire
 * VoxelWorlds. The format is optimized for storage space and encode/decode speed
 * rather than readability.
 *
 * How the resulting bytes are stored or transmitted is application logic - save
 * operations return the binary data and load operations accept the binary data.
 *
 * Chunk Format BVX1 (all multi-byte values little-endian):
 *
 * - u8 x 4 - magic 'BVX1'
 * - u8     - meta-data bits per voxel (0, 8, 16 or 32)
 * - u32    - MortonKey of the chunk
 * - u8     - layer mode (0 = empty, 1 = raw, 2 = RLE)
 * -        - layer payload (mode 1: 128 x u32, mode 2: u16 run count then runs of (u8 count, u32 value))
 * - u8     - meta mode (0 = empty, 1 = raw, 2 = RLE)
 * -        - meta payload (mode 1: 64 elements, mode 2: u16 run count then runs of (u8 count, element))
 *
 * World Format BVW1:
 *
 * - u8 x 4 - magic 'BVW1'
 * - u32    - number of chunk records
 * -        - chunk records (BVX1) back-to-back
 *
 * The encoder measures both the raw and RLE encodings of each section and always
 * writes the smaller of the two, so pathological voxel data never inflates beyond
 * raw size + 2 bytes of section headers.
 */
export class BVXSerializer {
    /**
     * Section encoding mode - the section contains only zero values and has no payload.
     */
    private static readonly MODE_EMPTY: number = 0;

    /**
     * Section encoding mode - the section payload is the raw element data.
     */
    private static readonly MODE_RAW: number = 1;

    /**
     * Section encoding mode - the section payload is run-length encoded.
     */
    private static readonly MODE_RLE: number = 2;

    /**
     * Maximum run length that can be stored in a single RLE run (u8 counter).
     */
    private static readonly MAX_RUN: number = 255;

    /**
     * Computes the run-length encoding of the provided elements as a flat array
     * of (count, value) pairs. Runs longer than MAX_RUN are split.
     *
     * @param elements - The elements to encode.
     * @returns - A flat array of (count, value) pairs.
     */
    private static _ComputeRuns(elements: Uint8Array | Uint16Array | Uint32Array): number[] {
        const runs: number[] = [];
        const length: number = elements.length;

        let runValue: number = elements[0];
        let runCount = 0;

        for (let i = 0; i < length; i++) {
            const value: number = elements[i];

            if (value === runValue && runCount < BVXSerializer.MAX_RUN) {
                runCount++;
            }
            else {
                runs.push(runCount, runValue);

                runValue = value;
                runCount = 1;
            }
        }

        // Push the final active run
        runs.push(runCount, runValue);

        return runs;
    }

    /**
     * Checks if all provided elements are zero, in which case the section can be
     * encoded as MODE_EMPTY with no payload.
     *
     * @param elements - The elements to check.
     * @returns - True if every element is zero, false otherwise.
     */
    private static _IsAllZero(elements: Uint8Array | Uint16Array | Uint32Array): boolean {
        const length: number = elements.length;

        for (let i = 0; i < length; i++) {
            if (elements[i] !== 0) {
                return false;
            }
        }

        return true;
    }

    /**
     * Computes the encoded byte size of a section (mode byte + payload) for the
     * provided elements.
     *
     * @param elements - The section elements, or null when the section stores nothing.
     * @param elementBytes - The byte width of a single element (1, 2 or 4).
     * @param runs - The precomputed RLE runs for the elements, or null when the section stores nothing.
     * @returns - The total byte size of the encoded section.
     */
    private static _SectionSize(elements: Uint8Array | Uint16Array | Uint32Array | null, elementBytes: number, runs: number[] | null): number {
        // mode byte only
        if (elements === null || runs === null || BVXSerializer._IsAllZero(elements)) {
            return 1;
        }

        const rawSize: number = elements.length * elementBytes;
        const rleSize: number = 2 + ((runs.length / 2) * (1 + elementBytes));

        return 1 + Math.min(rawSize, rleSize);
    }

    /**
     * Writes a single element value into the view using the provided byte width.
     *
     * @param view - The DataView to write into.
     * @param offset - The byte offset to write at.
     * @param value - The element value to write.
     * @param elementBytes - The byte width of the element (1, 2 or 4).
     */
    private static _WriteElement(view: DataView, offset: number, value: number, elementBytes: number): void {
        if (elementBytes === 1) {
            view.setUint8(offset, value);
        }
        else if (elementBytes === 2) {
            view.setUint16(offset, value, true);
        }
        else {
            view.setUint32(offset, value, true);
        }
    }

    /**
     * Reads a single element value from the view using the provided byte width.
     *
     * @param view - The DataView to read from.
     * @param offset - The byte offset to read at.
     * @param elementBytes - The byte width of the element (1, 2 or 4).
     * @returns - The element value.
     */
    private static _ReadElement(view: DataView, offset: number, elementBytes: number): number {
        if (elementBytes === 1) {
            return view.getUint8(offset);
        }

        if (elementBytes === 2) {
            return view.getUint16(offset, true);
        }

        return view.getUint32(offset, true);
    }

    /**
     * Writes a section (mode byte + payload) into the view and returns the new offset.
     *
     * @param view - The DataView to write into.
     * @param offset - The byte offset to begin writing at.
     * @param elements - The section elements, or null when the section stores nothing.
     * @param elementBytes - The byte width of a single element (1, 2 or 4).
     * @param runs - The precomputed RLE runs for the elements, or null when the section stores nothing.
     * @returns - The byte offset immediately after the written section.
     */
    private static _WriteSection(view: DataView, offset: number, elements: Uint8Array | Uint16Array | Uint32Array | null, elementBytes: number, runs: number[] | null): number {
        // empty section - mode byte only
        if (elements === null || runs === null || BVXSerializer._IsAllZero(elements)) {
            view.setUint8(offset, BVXSerializer.MODE_EMPTY);

            return offset + 1;
        }

        const rawSize: number = elements.length * elementBytes;
        const runCount: number = runs.length / 2;
        const rleSize: number = 2 + (runCount * (1 + elementBytes));

        // write whichever encoding is smaller
        if (rleSize < rawSize) {
            view.setUint8(offset, BVXSerializer.MODE_RLE);
            offset += 1;

            view.setUint16(offset, runCount, true);
            offset += 2;

            for (let i = 0; i < runs.length; i += 2) {
                view.setUint8(offset, runs[i]);
                offset += 1;

                BVXSerializer._WriteElement(view, offset, runs[i + 1], elementBytes);
                offset += elementBytes;
            }

            return offset;
        }

        view.setUint8(offset, BVXSerializer.MODE_RAW);
        offset += 1;

        const length: number = elements.length;

        for (let i = 0; i < length; i++) {
            BVXSerializer._WriteElement(view, offset, elements[i], elementBytes);
            offset += elementBytes;
        }

        return offset;
    }

    /**
     * Reads a section (mode byte + payload) from the view into the provided elements
     * and returns the new offset.
     *
     * @param view - The DataView to read from.
     * @param offset - The byte offset to begin reading at.
     * @param elements - The section elements to fill, or null when the section stores nothing.
     * @param elementBytes - The byte width of a single element (1, 2 or 4).
     * @returns - The byte offset immediately after the read section.
     */
    private static _ReadSection(view: DataView, offset: number, elements: Uint8Array | Uint16Array | Uint32Array | null, elementBytes: number): number {
        const mode: number = view.getUint8(offset);
        offset += 1;

        // empty section - elements remain zero-filled
        if (mode === BVXSerializer.MODE_EMPTY) {
            return offset;
        }

        if (elements === null) {
            throw new Error("BVXSerializer._ReadSection() - encountered a non-empty section for a chunk type that stores no data");
        }

        if (mode === BVXSerializer.MODE_RAW) {
            const length: number = elements.length;

            for (let i = 0; i < length; i++) {
                elements[i] = BVXSerializer._ReadElement(view, offset, elementBytes);
                offset += elementBytes;
            }

            return offset;
        }

        if (mode === BVXSerializer.MODE_RLE) {
            const runCount: number = view.getUint16(offset, true);
            offset += 2;

            let writeIndex = 0;

            for (let i = 0; i < runCount; i++) {
                const count: number = view.getUint8(offset);
                offset += 1;

                const value: number = BVXSerializer._ReadElement(view, offset, elementBytes);
                offset += elementBytes;

                for (let j = 0; j < count; j++) {
                    elements[writeIndex] = value;
                    writeIndex++;
                }
            }

            if (writeIndex !== elements.length) {
                throw new Error("BVXSerializer._ReadSection() - RLE data decoded " + writeIndex + " elements but expected " + elements.length);
            }

            return offset;
        }

        throw new Error("BVXSerializer._ReadSection() - unknown section mode " + mode);
    }

    /**
     * Computes the total encoded byte size of a single chunk record.
     *
     * @param chunk - The VoxelChunk to measure.
     * @returns - The byte size of the encoded chunk record.
     */
    private static _ChunkSize(chunk: VoxelChunk): number {
        const layerElements: Uint32Array = chunk.layer.bitArray.elements;
        const layerRuns: number[] = BVXSerializer._ComputeRuns(layerElements);

        const metaElements: Uint8Array | Uint16Array | Uint32Array | null = chunk.metaData;
        const metaBytes: number = chunk.metaBits / 8;
        const metaRuns: number[] | null = metaElements !== null ? BVXSerializer._ComputeRuns(metaElements) : null;

        // magic (4) + meta bits (1) + morton key (4) + layer section + meta section
        return 9 + BVXSerializer._SectionSize(layerElements, 4, layerRuns) + BVXSerializer._SectionSize(metaElements, metaBytes, metaRuns);
    }

    /**
     * Writes a single chunk record into the view and returns the new offset.
     *
     * @param view - The DataView to write into.
     * @param offset - The byte offset to begin writing at.
     * @param chunk - The VoxelChunk to encode.
     * @returns - The byte offset immediately after the written chunk record.
     */
    private static _WriteChunk(view: DataView, offset: number, chunk: VoxelChunk): number {
        // magic 'BVX1'
        view.setUint8(offset, 0x42);
        view.setUint8(offset + 1, 0x56);
        view.setUint8(offset + 2, 0x58);
        view.setUint8(offset + 3, 0x31);
        offset += 4;

        // meta-data bits per voxel identifies the concrete chunk type
        view.setUint8(offset, chunk.metaBits);
        offset += 1;

        // chunk location in the voxel map
        view.setUint32(offset, chunk.key.key, true);
        offset += 4;

        // BitVoxel layer section
        const layerElements: Uint32Array = chunk.layer.bitArray.elements;
        const layerRuns: number[] = BVXSerializer._ComputeRuns(layerElements);
        offset = BVXSerializer._WriteSection(view, offset, layerElements, 4, layerRuns);

        // meta-data section
        const metaElements: Uint8Array | Uint16Array | Uint32Array | null = chunk.metaData;
        const metaBytes: number = chunk.metaBits / 8;
        const metaRuns: number[] | null = metaElements !== null ? BVXSerializer._ComputeRuns(metaElements) : null;

        return BVXSerializer._WriteSection(view, offset, metaElements, metaBytes, metaRuns);
    }

    /**
     * Reads a single chunk record from the view. The concrete VoxelChunk type is
     * reconstructed from the encoded meta-data bit width.
     *
     * @param view - The DataView to read from.
     * @param offset - The byte offset to begin reading at.
     * @returns - The decoded VoxelChunk and the byte offset immediately after the record.
     */
    private static _ReadChunk(view: DataView, offset: number): { chunk: VoxelChunk, offset: number } {
        // verify magic 'BVX1'
        if (view.getUint8(offset) !== 0x42 || view.getUint8(offset + 1) !== 0x56 || view.getUint8(offset + 2) !== 0x58 || view.getUint8(offset + 3) !== 0x31) {
            throw new Error("BVXSerializer._ReadChunk() - invalid chunk record, expected magic BVX1");
        }

        offset += 4;

        const metaBits: number = view.getUint8(offset);
        offset += 1;

        const key: MortonKey = new MortonKey(view.getUint32(offset, true));
        offset += 4;

        let chunk: VoxelChunk;

        switch (metaBits) {
            case 0:
                chunk = new VoxelChunk0(key);
                break;
            case 8:
                chunk = new VoxelChunk8(key);
                break;
            case 16:
                chunk = new VoxelChunk16(key);
                break;
            case 32:
                chunk = new VoxelChunk32(key);
                break;
            default:
                throw new Error("BVXSerializer._ReadChunk() - unknown chunk type with " + metaBits + " meta-data bits, expected 0, 8, 16 or 32");
        }

        // BitVoxel layer section
        offset = BVXSerializer._ReadSection(view, offset, chunk.layer.bitArray.elements, 4);

        // meta-data section
        offset = BVXSerializer._ReadSection(view, offset, chunk.metaData, metaBits / 8);

        return { chunk: chunk, offset: offset };
    }

    /**
     * Serializes a single VoxelChunk into a compact binary representation. The
     * BitVoxel layer state, the meta-data and the chunk location are all encoded.
     *
     * @param chunk - The VoxelChunk to serialize.
     * @returns - The encoded binary data.
     */
    public static saveChunk(chunk: VoxelChunk): Uint8Array {
        const buffer: ArrayBuffer = new ArrayBuffer(BVXSerializer._ChunkSize(chunk));
        const view: DataView = new DataView(buffer);

        BVXSerializer._WriteChunk(view, 0, chunk);

        return new Uint8Array(buffer);
    }

    /**
     * Deserializes a single VoxelChunk previously encoded via saveChunk(). The
     * concrete VoxelChunk type (0, 8, 16 or 32 bit meta-data) is reconstructed
     * automatically.
     *
     * @param data - The binary data to decode.
     * @returns - The decoded VoxelChunk.
     */
    public static loadChunk(data: Uint8Array): VoxelChunk {
        const view: DataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

        return BVXSerializer._ReadChunk(view, 0).chunk;
    }

    /**
     * Serializes all VoxelChunks stored in the provided VoxelWorld into a compact
     * binary representation.
     *
     * @param world - The VoxelWorld to serialize.
     * @returns - The encoded binary data.
     */
    public static saveWorld(world: VoxelWorld): Uint8Array {
        // measure all chunk records to allocate the output in a single pass
        let totalSize = 8; // magic (4) + chunk count (4)
        let chunkCount = 0;

        for (const chunk of world.chunks.values()) {
            totalSize += BVXSerializer._ChunkSize(chunk);
            chunkCount++;
        }

        const buffer: ArrayBuffer = new ArrayBuffer(totalSize);
        const view: DataView = new DataView(buffer);

        // magic 'BVW1'
        view.setUint8(0, 0x42);
        view.setUint8(1, 0x56);
        view.setUint8(2, 0x57);
        view.setUint8(3, 0x31);

        view.setUint32(4, chunkCount, true);

        let offset = 8;

        for (const chunk of world.chunks.values()) {
            offset = BVXSerializer._WriteChunk(view, offset, chunk);
        }

        return new Uint8Array(buffer);
    }

    /**
     * Deserializes a VoxelWorld previously encoded via saveWorld(). All decoded
     * chunks are inserted into the provided world, or a new world if none is
     * provided.
     *
     * @param data - The binary data to decode.
     * @param optres - (Optional) The VoxelWorld to insert the decoded chunks into, reducing allocations.
     * @returns - The new or provided VoxelWorld containing all decoded chunks.
     */
    public static loadWorld(data: Uint8Array, optres: VoxelWorld | null = null): VoxelWorld {
        optres = optres ?? new VoxelWorld();

        const view: DataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // verify magic 'BVW1'
        if (view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x56 || view.getUint8(2) !== 0x57 || view.getUint8(3) !== 0x31) {
            throw new Error("BVXSerializer.loadWorld(Uint8Array) - invalid world data, expected magic BVW1");
        }

        const chunkCount: number = view.getUint32(4, true);

        let offset = 8;

        for (let i = 0; i < chunkCount; i++) {
            const result: { chunk: VoxelChunk, offset: number } = BVXSerializer._ReadChunk(view, offset);

            optres.insert(result.chunk);
            offset = result.offset;
        }

        return optres;
    }
}
