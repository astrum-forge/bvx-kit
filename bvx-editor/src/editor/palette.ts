/**
 * The editor's colour palette. Voxel meta-data stores an index into this list.
 *
 * NOTE: In the BitVoxel architecture meta-data (and therefore colour) applies
 * per Voxel - a 4x4x4 group of BitVoxels shares one palette entry.
 */
export interface PaletteEntry {
    /**
     * Display name of the colour.
     */
    name: string;

    /**
     * CSS hex value, used by the UI swatches.
     */
    hex: string;

    /**
     * Linear-ish RGB triplet in 0-1 range, used for mesh vertex colours.
     */
    rgb: [number, number, number];
}

/**
 * Converts a CSS hex colour into an RGB triplet in 0-1 range.
 */
const rgb = (hex: string): [number, number, number] => {
    const value = parseInt(hex.slice(1), 16);

    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
};

/**
 * Builds a palette entry from a name and CSS hex value.
 */
const entry = (name: string, hex: string): PaletteEntry => {
    return { name: name, hex: hex, rgb: rgb(hex) };
};

/**
 * The 16 editor colours. Index 0 is the default for unpainted voxels.
 */
export const PALETTE: PaletteEntry[] = [
    entry("Slate", "#8b97a8"),
    entry("Cloud", "#e8ecf2"),
    entry("Carbon", "#3a4150"),
    entry("Ember", "#e8593f"),
    entry("Amber", "#f2a83b"),
    entry("Sun", "#f7d154"),
    entry("Moss", "#8fbf4d"),
    entry("Fern", "#4d9e5f"),
    entry("Pine", "#2e6e54"),
    entry("Aqua", "#45c4b8"),
    entry("Sky", "#4aa3e8"),
    entry("Cobalt", "#3b6ce8"),
    entry("Violet", "#8a5fe8"),
    entry("Orchid", "#c45fd6"),
    entry("Rose", "#e85f8a"),
    entry("Clay", "#a8785f")
];
