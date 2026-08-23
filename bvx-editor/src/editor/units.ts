/**
 * Editor-wide scale and shading constants, in their own module because both the
 * main thread and the mesher worker need them and the worker must not pull in
 * anything that reaches BabylonJS.
 */

/**
 * The world size of one BitVoxel. A Voxel is four of these and a chunk sixteen,
 * so a chunk spans 4.0 world units.
 */
export const BIT_VOXEL_SIZE = 0.25;

/**
 * Vertex openness for the 4 baked ambient occlusion levels (0 = fully
 * occluded corner, 3 = fully open).
 *
 * Deeper than a renderer that multiplies AO into the albedo could afford. The
 * toon ramp spends this on the ambient term only (see BVX_AO_KIND), so a fully
 * enclosed corner drops to a third of its skylight without touching what the
 * sun does to the same surface.
 */
export const AO_LEVELS: number[] = [0.42, 0.66, 0.86, 1.0];
