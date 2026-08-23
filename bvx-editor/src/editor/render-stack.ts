import {
    BoundingInfo,
    CascadedShadowGenerator,
    Color3,
    Color4,
    ColorCurves,
    DefaultRenderingPipeline,
    DirectionalLight,
    HemisphericLight,
    Mesh,
    MeshBuilder,
    Scene,
    ShadowGenerator,
    SSAO2RenderingPipeline,
    StandardMaterial,
    Vector3,
    type Camera
} from "@babylonjs/core";
import { HORIZON_RGB, GhibliToonPlugin, createSky, installGhibliOcclusionCombine } from "./ghibli";

/**
 * Everything the editor renders that is not voxel geometry - the light rig,
 * shadows, the ground plane, the sky dome, atmospheric haze and the post
 * chain - assembled in one place so the look can be reasoned about as a whole.
 */

/**
 * How much the screen-space occlusion pass darkens at full effect.
 *
 * Above 1, which is not physical and is the point: a stylised scene wants the
 * creases readable, and the raw hemisphere estimate at a voxel corner is only
 * about a fifth occluded.
 */
const OCCLUSION_STRENGTH = 1.6;

/**
 * The handles the editor needs to keep after the scene is dressed.
 */
export interface RenderStack {
    /**
     * Unit vector pointing from the scene toward the sun. Drives the water
     * glints, the sky's sun disc and the cloud shading.
     */
    readonly sunDirection: Vector3;

    /**
     * Shadow map fed by the key light. The editor owns its caster list.
     */
    readonly shadows: CascadedShadowGenerator;

    /**
     * The meadow plane the region sits on.
     */
    readonly ground: Mesh;

    /**
     * Screen-space ambient occlusion, or null if the pipeline reported itself
     * unsupported.
     */
    readonly occlusion: SSAO2RenderingPipeline | null;

    /**
     * Colour grading, bloom and vignette.
     */
    readonly post: DefaultRenderingPipeline;

    /**
     * Fades the screen-space occlusion effect in or out. The pass itself keeps
     * running either way - see the implementation for why.
     */
    setOcclusionEnabled(enabled: boolean): void;
}

/**
 * Dresses the scene: lights, shadows, ground, sky, haze and post-processing.
 *
 * @param scene the scene to dress
 * @param camera the camera the post chain attaches to
 * @param regionUnits the editable region's extent in world units
 */
export const createRenderStack = (scene: Scene, camera: Camera, regionUnits: number, occlusionEnabled: boolean): RenderStack => {
    // the same colour the sky dome starts its gradient from, so the fogged
    // ground and the sky meet without a seam
    const horizon = new Color3(HORIZON_RGB[0], HORIZON_RGB[1], HORIZON_RGB[2]);

    scene.clearColor = Color4.FromColor3(horizon, 1.0);

    // ------------------------------------------------------------------ lights

    // A blue sky dome with warm ground bounce, a warm shadow-casting sun and a
    // faint cool fill from the opposite side. The toon ramps in the Ghibli
    // plugins are tuned to this rig's intensities - LIGHT_NORMALISER in
    // ghibli.ts assumes a fully sun-lit surface lands near 1.0.
    const ambient = new HemisphericLight("ambient", new Vector3(0.2, 1.0, 0.3), scene);

    ambient.intensity = 0.52;
    ambient.diffuse = new Color3(0.66, 0.79, 0.96);
    ambient.groundColor = new Color3(0.52, 0.48, 0.38);
    ambient.specular = Color3.Black();

    const key = new DirectionalLight("key", new Vector3(-0.55, -0.8, -0.35), scene);

    key.intensity = 1.18;
    key.diffuse = new Color3(1.0, 0.94, 0.78);
    key.specular = Color3.Black();
    key.position = new Vector3(regionUnits * 1.2, regionUnits * 1.6, regionUnits * 1.1);

    const fill = new DirectionalLight("fill", new Vector3(0.6, -0.25, 0.5), scene);

    fill.intensity = 0.12;
    fill.diffuse = new Color3(0.55, 0.65, 0.90);
    fill.specular = Color3.Black();

    const sunDirection = key.direction.negate().normalize();

    // ----------------------------------------------------------------- shadows

    // Cascaded rather than a single map. One 2048 map stretched over the whole
    // region gives roughly a fifth of a BitVoxel per texel, which is what turns
    // the floating islands' shadows into soft blobs; four cascades put most of
    // that resolution in front of the camera instead, where a 0.25-unit voxel
    // gets tens of texels.
    const shadows = new CascadedShadowGenerator(2048, key);

    // Two, which is also Babylon's floor - CascadedShadowGenerator clamps
    // below this. Each cascade is another full pass over the caster list and
    // that list is every chunk in the region, so the count is worth keeping at
    // the minimum; a world only 64 units across gets nothing from a third
    // split anyway, and two still leaves the near cascade tight enough to give
    // a 0.25 unit BitVoxel tens of shadow texels.
    shadows.numCascades = 2;
    shadows.lambda = 0.86;
    shadows.stabilizeCascades = true;
    shadows.cascadeBlendPercentage = 0.06;
    shadows.shadowMaxZ = regionUnits * 2.4;
    shadows.depthClamp = true;
    shadows.usePercentageCloserFiltering = true;
    shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    shadows.bias = 0.006;
    shadows.normalBias = 0.018;
    shadows.darkness = 0.06;
    shadows.transparencyShadow = false;

    // The caster bounds are supplied rather than derived. Left alone, the
    // generator adds an onBeforeRender observable that recomputes them from every
    // caster's bounding info on every frame, and the caster list here is every
    // chunk in the region - a walk of several hundred meshes per frame to arrive
    // at a box that cannot change, because a chunk mesh is placed once and never
    // moves.
    //
    // Freezing alone would be wrong: the setter snaps the bounds immediately, and
    // at this point the caster list is still empty, which would freeze them at
    // the empty-set sentinel. So the region's own extent is handed over straight
    // afterwards. It is deliberately the whole editable volume rather than a
    // tight fit around current geometry - the value only has to contain every
    // caster, and this one does so for anything the user can ever build.
    shadows.freezeShadowCastersBoundingInfo = true;
    shadows.shadowCastersBoundingInfo = new BoundingInfo(
        new Vector3(0, 0, 0),
        new Vector3(regionUnits, regionUnits, regionUnits)
    );

    // The shadow map is re-rendered every other frame, and this one line is
    // worth more than every other optimisation in this file combined: the
    // shadow stage is two full passes over every chunk in the region, which
    // measured 10.4 ms of a 14.3 ms frame while a simulation was remeshing -
    // 72% of the budget. Halving how often it runs takes the frame to 8.4 ms,
    // which is parity with the renderer this replaced.
    //
    // It is free rather than a trade because the cascades are stabilised:
    // their matrices snap to shadow-texel boundaries, so a map one frame old
    // is not merely close to the current one, it is identical. Verified by
    // rendering a 30-frame orbit at both rates - zero differing pixels.
    // Removing stabilizeCascades would invalidate that and this with it.
    const shadowMap = shadows.getShadowMap();

    if (shadowMap) {
        shadowMap.refreshRate = 2;
    }

    // ------------------------------------------------------------------ ground

    // Wider than the camera's far plane on purpose: the plane is meant to have
    // no edge the eye can find, and the cheapest way to guarantee that is for
    // its edge to be clipped away rather than merely fogged out.
    const ground = MeshBuilder.CreateGround("ground", { width: regionUnits * 30, height: regionUnits * 30 }, scene);

    ground.position.set(regionUnits / 2, -0.02, regionUnits / 2);
    ground.isPickable = false;
    ground.receiveShadows = true;
    ground.freezeWorldMatrix();

    const groundMaterial = new StandardMaterial("ground-mat", scene);

    groundMaterial.diffuseColor = Color3.FromHexString("#8fb96e");
    groundMaterial.specularColor = Color3.Black();

    ground.material = groundMaterial;

    new GhibliToonPlugin(groundMaterial);

    // --------------------------------------------------------------------- sky

    // Radius comfortably inside the camera's far plane; infiniteDistance keeps
    // it centred on the viewer so the horizon never slides away.
    createSky(scene, sunDirection, regionUnits * 12);

    // Aerial perspective, ranged against the camera rather than the region:
    // haze has to stay off the terrain at the default framing and still have
    // fully closed in by the far plane, or the ground's clipped edge shows.
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = regionUnits * 1.5;
    scene.fogEnd = regionUnits * 4.5;
    scene.fogColor = horizon;

    // ---------------------------------------------------------- post-processing

    // Occlusion first so its composite lands on the raw scene colour, before
    // bloom and grading run over the result.
    installGhibliOcclusionCombine();

    const buildOcclusion = (): SSAO2RenderingPipeline | null => {
        if (!SSAO2RenderingPipeline.IsSupported) {
            return null;
        }

        // The occlusion estimate runs at half resolution and is upsampled by
        // its own depth-aware blur, which is what that blur is for. AO is a
        // low-frequency signal - there is nothing in it that a full-resolution
        // pass would resolve and the half-resolution one would not.
        const occlusion = new SSAO2RenderingPipeline("bvx-occlusion", scene, { ssaoRatio: 0.5, blurRatio: 1.0 }, [camera], false);

        // Radius is in world units: a BitVoxel is 0.25 and a Voxel is 1.0, so
        // this reaches about three BitVoxels - wide enough to darken the inside
        // of a terrace step, tight enough not to halo whole hillsides.
        occlusion.radius = 0.75;

        // Deliberately restrained. The chunk meshes already carry baked contact
        // occlusion, so this pass is here for what baking cannot see - one
        // island shadowing another, a shoreline meeting the water - and pushing
        // it harder just re-darkens creases that are already dark.
        occlusion.totalStrength = OCCLUSION_STRENGTH;
        occlusion.samples = 16;
        occlusion.epsilon = 0.022;
        occlusion.maxZ = regionUnits * 1.8;
        occlusion.minZAspect = 0.3;

        // The bilateral denoiser is what keeps 16 samples from reading as
        // grain; softening it stops the filter smearing shadow edges into
        // the flat sky behind a silhouette.
        // Left at Babylon's default. `textureSamples` here multisamples the
        // depth+normal pre-pass, which SSAO reads point-wise, so raising it
        // buys nothing; it is also not safe to change after construction -
        // assigning it live puts the pre-pass into a state where the whole
        // effect quietly stops contributing, which is an easy way to measure a
        // speed-up that is really a broken feature.
        occlusion.expensiveBlur = true;
        occlusion.bilateralSamples = 14;
        occlusion.bilateralSoften = 0.45;
        occlusion.bilateralTolerance = 0.1;

        return occlusion;
    };

    const buildPost = (): DefaultRenderingPipeline => {
        // HDR, which is not just about precision here. In LDR mode Babylon does
        // not add an image-processing post-process at all - it makes every
        // StandardMaterial grade itself instead. Anything that is not a
        // StandardMaterial then silently escapes the grade, which for this scene
        // means the sky dome: ungraded, it never matches the fogged ground it is
        // supposed to blend into. In HDR mode the grade is one pass over the
        // finished frame, materials write linear, and the bloom is computed on
        // linear values the way it should be.
        const post = new DefaultRenderingPipeline("bvx-post", true, scene, [camera]);

        // 4x MSAA replaces FXAA. FXAA finds edges by luminance and cannot tell a
        // voxel silhouette from a toon band, so it softens the painted terminators
        // it should leave alone; MSAA resolves the geometry properly and the band
        // edges are already derivative-widened in the shader.
        post.fxaaEnabled = false;
        post.samples = 4;

        // Threshold set above the brightest painted albedo (a white voxel in full
        // sun), so bloom is reserved for things that genuinely emit - the sun disc
        // and the sharp glints on water - rather than turning every snow cap into
        // a lamp.
        post.bloomEnabled = true;
        post.bloomThreshold = 1.02;
        post.bloomWeight = 0.22;
        post.bloomKernel = 64;
        post.bloomScale = 0.5;

        post.imageProcessingEnabled = true;
        // gentle: the sky's horizon band already sits near white, and any more
        // contrast clips it to pure white and puts a hard line under the horizon
        // where the fogged ground plane cannot follow it
        post.imageProcessing.contrast = 1.04;
        post.imageProcessing.exposure = 1.0;
        post.imageProcessing.vignetteEnabled = true;
        post.imageProcessing.vignetteWeight = 1.4;
        post.imageProcessing.vignetteColor = new Color4(0.06, 0.09, 0.16, 0);

        const curves = new ColorCurves();

        curves.globalSaturation = 16;
        curves.highlightsSaturation = -8;
        curves.shadowsHue = 220;
        curves.shadowsDensity = 12;

        post.imageProcessing.colorCurvesEnabled = true;
        post.imageProcessing.colorCurves = curves;

        return post;
    };

    const occlusion = buildOcclusion();
    const post = buildPost();

    if (occlusion && !occlusionEnabled) {
        occlusion.totalStrength = 0;
    }

    const stack: RenderStack = {
        sunDirection: sunDirection,
        shadows: shadows,
        ground: ground,
        occlusion: occlusion,
        post: post,

        // Turned off by taking the effect to zero, leaving the pipeline where
        // it is. Every attempt to restructure the chain on a live camera fails,
        // and fails silently into a black frame: detaching the occlusion
        // pipeline leaves the one still attached sampling a texture nothing
        // produces any more, and disposing both and rebuilding them does not
        // recover either. Babylon's post pipelines are fixed at the point the
        // camera is set up; only their parameters are safely live.
        //
        // The cost of that: the pass still runs when the toggle is off, so this
        // is a look control and not a performance one. It is about 1 ms.
        setOcclusionEnabled: (enabled: boolean): void => {
            if (occlusion) {
                occlusion.totalStrength = enabled ? OCCLUSION_STRENGTH : 0;
            }
        }
    };

    return stack;
};
