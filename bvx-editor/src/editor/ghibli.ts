import {
    Material,
    MaterialPluginBase,
    Mesh,
    MeshBuilder,
    Scene,
    ShaderLanguage,
    ShaderMaterial,
    ShaderStore,
    UniformBuffer,
    Vector3,
    type AbstractMesh,
    type MaterialDefines
} from "@babylonjs/core";

/**
 * Ghibli-inspired shading for the editor, written in WGSL and built as
 * StandardMaterial plugins so shadows, fog and vertex colours keep working
 * unchanged.
 *
 * - GhibliToonPlugin: soft-banded painterly light ramp for solid voxels,
 *   sand and the ground plane.
 * - GhibliWaterPlugin: animated stylised water - vertex waves, wavy normals,
 *   fresnel transparency, banded sun glints, drifting sparkles and crest foam.
 * - createSky: a procedural gradient sky dome with drifting clouds and a sun.
 * - installGhibliOcclusionCombine: retints the SSAO composite so screen-space
 *   occlusion reads as cool painted shade rather than grey grime.
 *
 * The editor runs on WebGPU only, so every shader here is WGSL. Babylon's
 * StandardMaterial ships WGSL variants of the same shader with the same
 * injection points, and plugin uniforms declared through `getUniforms().ubo`
 * are emitted into the material UBO automatically - the vertex/fragment
 * declaration strings a WebGL build would need have no WGSL counterpart and
 * are deliberately absent.
 */

/**
 * Vertex attribute carrying baked ambient occlusion, 1 float per vertex,
 * 0 = fully enclosed and 1 = fully open.
 *
 * AO travels in its own stream rather than pre-multiplied into the vertex
 * colour, which is what most voxel renderers do. Folding it into the albedo
 * darkens a surface uniformly - including in full sunlight - and that flat
 * grey wash over otherwise clean colour is exactly what makes voxel terrain
 * read as "dirty". Kept separate, the toon ramp can spend occlusion only
 * where it physically belongs: on the ambient/skylight term.
 */
export const BVX_AO_KIND = "bvxAO";

/**
 * The luminance the accumulated scene lighting is normalised by inside the
 * toon ramps. Tuned to the editor's key + hemispheric + fill light rig - a
 * fully sun-lit surface lands near 1.0, a fully shadowed one near 0.2.
 */
const LIGHT_NORMALISER = "1.5";

/**
 * The painterly light ramp's three tones, from deepest shade to full sun.
 *
 * Shade is a luminous cool blue rather than a darkened copy of the albedo -
 * the single biggest thing separating a painted look from a lit-and-shaded
 * one. Sunlight runs slightly above 1.0 so lit faces bloom a little.
 */
const TONE_SHADE = "vec3f(0.62, 0.69, 0.85)";
const TONE_MID = "vec3f(0.88, 0.90, 0.90)";
const TONE_SUN = "vec3f(1.08, 1.03, 0.92)";

/**
 * The tint a fully occluded surface takes in ambient light. Occlusion cools
 * and deepens rather than desaturating toward grey.
 */
const TONE_OCCLUDED = "vec3f(0.56, 0.63, 0.79)";

/**
 * Sky colour used for the silhouette rim light.
 */
const TONE_RIM = "vec3f(0.60, 0.78, 0.99)";

/**
 * The colour the atmosphere reaches at the horizon.
 *
 * Shared, not merely matched: the ground plane fogs to this and the sky dome
 * starts its gradient from it, so where the two meet there is nothing to see.
 * Two hand-tuned values that were nearly equal is what put a hard cut-out line
 * across the world in the first place.
 */
export const HORIZON_RGB: [number, number, number] = [0.949, 0.925, 0.863];

const HORIZON_WGSL = `vec3f(${HORIZON_RGB[0]}, ${HORIZON_RGB[1]}, ${HORIZON_RGB[2]})`;

/**
 * Shared WGSL - a cheap value noise used by the water sparkle/foam breakup
 * and by the sky's clouds.
 */
const NOISE_WGSL = /* wgsl */ `
fn bvxHash21(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn bvxNoise2(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);

    return mix(
        mix(bvxHash21(i), bvxHash21(i + vec2f(1.0, 0.0)), u.x),
        mix(bvxHash21(i + vec2f(0.0, 1.0)), bvxHash21(i + vec2f(1.0, 1.0)), u.x),
        u.y);
}
`;

/**
 * Shared WGSL - the animated water height field, a sum of three directional
 * waves normalised into [-1, 0] so displacement only ever pulls the surface
 * down into the voxel volume (never opens gaps against neighbours).
 */
const WAVE_WGSL = /* wgsl */ `
fn bvxWaveField(p: vec2f, t: f32) -> f32 {
    var w = sin(dot(p, vec2f(0.86, 0.50)) * 1.9 + t * 1.15);
    w += sin(dot(p, vec2f(-0.35, 0.94)) * 2.7 + t * 1.65) * 0.60;
    w += sin(dot(p, vec2f(0.55, -0.83)) * 4.1 + t * 2.30) * 0.35;

    return (w / 1.95) * 0.5 - 0.5;
}
`;

/**
 * Shared WGSL - the painterly light ramp itself, used by both the solid and
 * the water shading so everything sits in one painted world.
 *
 * `bvxToonRamp` collapses a 0..1 exposure into three soft bands. The band
 * edges are widened by the screen-space derivative of the exposure, which is
 * what keeps the terminator from crawling and stair-stepping across a voxel
 * surface: a band edge is always about a pixel wide no matter how steeply the
 * lighting changes there. Fixed-width smoothsteps cannot do this - they are
 * either hard (and alias) on gentle gradients or mushy on sharp ones.
 */
const RAMP_WGSL = /* wgsl */ `
fn bvxToonRamp(t: f32) -> f32 {
    let aa = clamp(fwidth(t) * 0.6, 0.005, 0.22);

    // Edges chosen against the editor's light rig, whose useful range is
    // narrow: a surface facing away from the sun still collects skylight and
    // lands near 0.10, a sun-facing wall near 0.55, flat sunlit ground near
    // 0.86. Bands placed for a 0-1 spread would put almost the whole scene in
    // the bottom one and flatten the terrain into a silhouette.
    return smoothstep(0.07 - aa, 0.19 + aa, t) * 0.40
        + smoothstep(0.34 - aa, 0.50 + aa, t) * 0.36
        + smoothstep(0.68 - aa, 0.84 + aa, t) * 0.24;
}

fn bvxToneFor(ramp: f32) -> vec3f {
    return mix(
        mix(${TONE_SHADE}, ${TONE_MID}, smoothstep(0.0, 0.55, ramp)),
        ${TONE_SUN},
        smoothstep(0.48, 1.0, ramp));
}
`;

/**
 * Soft-banded painterly light ramp. Collapses the accumulated lighting (all
 * lights, with shadows folded in) into three soft toon bands, grades shadows
 * cool and sunlight warm, spends baked ambient occlusion on the shade side
 * only, and adds a sky-blue rim on silhouettes.
 */
export class GhibliToonPlugin extends MaterialPluginBase {
    constructor(material: Material) {
        super(material, "GhibliToon", 200, { BVXAO: false });
        this._enable(true);
    }

    public override getClassName(): string {
        return "GhibliToonPlugin";
    }

    public override isCompatible(shaderLanguage: ShaderLanguage): boolean {
        return shaderLanguage === ShaderLanguage.WGSL;
    }

    /**
     * The AO stream is optional - chunk meshes carry it, the ground plane and
     * any other decorative geometry do not - so it is gated behind a define
     * rather than assumed present. Declaring an attribute the mesh does not
     * provide is a hard error on WebGPU.
     */
    public override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
        defines["BVXAO"] = mesh.isVerticesDataPresent(BVX_AO_KIND);
    }

    public override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
        if (mesh.isVerticesDataPresent(BVX_AO_KIND)) {
            attributes.push(BVX_AO_KIND);
        }
    }

    public override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [pointName: string]: string } | null {
        if (shaderLanguage !== ShaderLanguage.WGSL) {
            return null;
        }

        if (shaderType === "vertex") {
            return {
                CUSTOM_VERTEX_DEFINITIONS: /* wgsl */ `
                #ifdef BVXAO
                attribute bvxAO: f32;
                varying bvxVertexAO: f32;
                #endif
                `,

                CUSTOM_VERTEX_MAIN_END: /* wgsl */ `
                #ifdef BVXAO
                vertexOutputs.bvxVertexAO = vertexInputs.bvxAO;
                #endif
                `
            };
        }

        return {
            CUSTOM_FRAGMENT_DEFINITIONS: /* wgsl */ `
            #ifdef BVXAO
            varying bvxVertexAO: f32;
            #endif
            ${RAMP_WGSL}
            `,

            // diffuseBase (accumulated lighting incl. shadows), baseColor
            // (vertex colours), diffuseColor, normalW and viewDirectionW are
            // all in scope here; fog is applied afterwards
            CUSTOM_FRAGMENT_BEFORE_FOG: /* wgsl */ `
            {
                var bvxAO: f32 = 1.0;
                #ifdef BVXAO
                bvxAO = clamp(fragmentInputs.bvxVertexAO, 0.0, 1.0);
                #endif

                let bvxAlbedo = baseColor.rgb * diffuseColor;

                // the accumulated lighting, split into how much there is and
                // what colour it is. The ramp bands the amount; the hue is
                // folded back in afterwards so the hemispheric rig keeps
                // tinting up-facing surfaces sky-blue and down-facing ones
                // with warm ground bounce even after banding.
                let bvxAmount = dot(diffuseBase, vec3f(0.2126, 0.7152, 0.0722));
                let bvxHue = diffuseBase / max(bvxAmount, 0.0001);
                let bvxRamp = bvxToonRamp(clamp(bvxAmount / ${LIGHT_NORMALISER}, 0.0, 1.0));

                var bvxLight = bvxToneFor(bvxRamp);
                bvxLight *= mix(vec3f(1.0), clamp(bvxHue, vec3f(0.65), vec3f(1.45)), 0.35);

                // occlusion is an ambient-only term: it reaches full strength
                // in the shade bands and fades out as a surface turns into
                // the sun, so a lit face never picks up baked grime
                let bvxOcclusion = mix(${TONE_OCCLUDED}, vec3f(1.0), bvxAO);
                bvxLight *= mix(bvxOcclusion, vec3f(1.0), bvxRamp * 0.55);

                // sky-tinted rim on silhouettes, strongest on the lit side and
                // suppressed inside creases where a rim makes no sense
                let bvxRim = pow(1.0 - clamp(dot(normalW, viewDirectionW), 0.0, 1.0), 3.5) * bvxAO;

                color = vec4f(
                    bvxAlbedo * bvxLight
                        + bvxAlbedo * ${TONE_RIM} * bvxRim * (0.07 + 0.30 * bvxRamp),
                    color.a);
            }
            `
        };
    }
}

/**
 * Animated stylised water. Vertices bob on a world-space wave field (pulled
 * downward only, so chunk seams and neighbouring solids never show gaps),
 * up-facing normals follow the wave slopes, and the surface is composed from
 * fresnel-blended depth colours, banded sun glints, drifting sparkles and
 * noise-broken crest foam - all over the same soft toon light ramp as the
 * solids so water sits in the same painted world.
 */
export class GhibliWaterPlugin extends MaterialPluginBase {
    /**
     * Direction pointing from the scene toward the sun, for the glints.
     */
    public readonly sunDirection: Vector3;

    /**
     * The animation clock, snapshotted once per frame (see bindForSubMesh).
     */
    private _time = 0;
    private _timeFrameId = -1;

    constructor(material: Material, sunDirection: Vector3) {
        super(material, "GhibliWater", 200);

        this.sunDirection = sunDirection.normalizeToNew();
        this._enable(true);
    }

    public override getClassName(): string {
        return "GhibliWaterPlugin";
    }

    public override isCompatible(shaderLanguage: ShaderLanguage): boolean {
        return shaderLanguage === ShaderLanguage.WGSL;
    }

    public override getUniforms(): { ubo: { name: string, size: number, type: string }[] } {
        // WGSL always has uniform buffers, so the ubo list is the whole story -
        // the manager emits the matching `uniform bvxTime: f32;` declarations
        // into the material UBO for us
        return {
            ubo: [
                { name: "bvxTime", size: 1, type: "float" },
                { name: "bvxSunDir", size: 3, type: "vec3" }
            ]
        };
    }

    public override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene): void {
        // snapshot the clock once per frame. The depth pre-pass and the colour
        // pass each bind this material, and every water chunk binds it again -
        // all of them must displace the waves identically within a frame, or
        // the colour pass fails the depth test against the pre-pass and the
        // surface flickers as if z-fighting.
        const frameId = scene.getFrameId();

        if (frameId !== this._timeFrameId) {
            this._timeFrameId = frameId;
            this._time = performance.now() * 0.001;
        }

        uniformBuffer.updateFloat("bvxTime", this._time);
        uniformBuffer.updateVector3("bvxSunDir", this.sunDirection);
    }

    public override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [pointName: string]: string } | null {
        if (shaderLanguage !== ShaderLanguage.WGSL) {
            return null;
        }

        if (shaderType === "vertex") {
            return {
                CUSTOM_VERTEX_DEFINITIONS: /* wgsl */ `
                varying bvxWaveCrest: f32;
                ${WAVE_WGSL}
                `,

                // displaced after the world transform, so the field is
                // continuous across chunk meshes and vPositionW (which the
                // fragment shader re-samples the waves from) already carries
                // the displacement
                CUSTOM_VERTEX_UPDATE_WORLDPOS: /* wgsl */ `
                {
                    let bvxWave = bvxWaveField(worldPos.xz, uniforms.bvxTime);

                    worldPos.y += bvxWave * 0.07;
                    vertexOutputs.bvxWaveCrest = 1.0 + bvxWave;
                }
                `
            };
        }

        return {
            CUSTOM_FRAGMENT_DEFINITIONS: /* wgsl */ `
            varying bvxWaveCrest: f32;
            ${WAVE_WGSL}
            ${NOISE_WGSL}
            ${RAMP_WGSL}
            `,

            // tilt up-facing normals along the wave slopes before the lighting
            // loop runs, so diffuse, shadows and the glints all see the waves
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: /* wgsl */ `
            {
                let bvxUpW = smoothstep(0.35, 0.7, normalW.y);

                if (bvxUpW > 0.001) {
                    let bvxE = 0.1;
                    let bvxP = fragmentInputs.vPositionW.xz;
                    let bvxH0 = bvxWaveField(bvxP, uniforms.bvxTime);
                    let bvxHx = bvxWaveField(bvxP + vec2f(bvxE, 0.0), uniforms.bvxTime);
                    let bvxHz = bvxWaveField(bvxP + vec2f(0.0, bvxE), uniforms.bvxTime);

                    // exaggerated slope so the small displacement reads clearly
                    let bvxWaveN = normalize(vec3f(
                        (bvxH0 - bvxHx) * 0.18 / bvxE,
                        1.0,
                        (bvxH0 - bvxHz) * 0.18 / bvxE));

                    normalW = normalize(mix(normalW, bvxWaveN, bvxUpW * 0.85));
                }
            }
            `,

            CUSTOM_FRAGMENT_BEFORE_FOG: /* wgsl */ `
            {
                let bvxUp = smoothstep(0.35, 0.7, normalW.y);
                let bvxFresnel = pow(1.0 - clamp(dot(normalW, viewDirectionW), 0.0, 1.0), 2.5);

                let bvxAmount = dot(diffuseBase, vec3f(0.2126, 0.7152, 0.0722));

                // Water gets a smooth light response, not the solids' banded
                // one. Its normals swing through the whole wave field within a
                // few pixels, so hard bands land on the surface as a corduroy
                // of stripes rather than as painted shapes. The glints and the
                // foam below carry the graphic, banded look instead.
                let bvxRamp = smoothstep(0.08, 0.80, clamp(bvxAmount / ${LIGHT_NORMALISER}, 0.0, 1.0));

                // 0 in open water, rising toward 1 as land closes in.
                //
                // The mesher bakes this into the water lane's vertex colour,
                // which is otherwise dead weight - this shader composes its own
                // colour from depth, fresnel and light and never reads the
                // albedo. Carrying it in a dedicated vertex attribute (as the
                // solids carry their occlusion) is the tidier design and does
                // not work here: this material runs a depth pre-pass, and the
                // extra attribute makes the two passes disagree about the
                // vertex layout, which drops the whole frame on WebGPU.
                var bvxShore: f32 = 0.0;
                #if defined(VERTEXCOLOR) || defined(INSTANCESCOLOR) && defined(INSTANCES)
                bvxShore = clamp(fragmentInputs.vColor.r, 0.0, 1.0);
                #endif

                // Face-on looks into the depths, grazing reflects the sky, and
                // the shallows by the shore lighten toward a green-blue. The
                // body colour is a mid teal rather than a deep navy: these
                // lakes are a few voxels deep over sand, and a dark blue
                // blended against a yellow bed reads as grey, not as water.
                var bvxWater = mix(
                    vec3f(0.08, 0.42, 0.56),
                    vec3f(0.62, 0.88, 0.97),
                    bvxFresnel * 1.0 + 0.10 * bvxUp);
                bvxWater = mix(bvxWater, vec3f(0.36, 0.76, 0.76), bvxShore * 0.55);
                bvxWater *= bvxToneFor(bvxRamp);

                // crisp banded sun glint
                let bvxHalf = normalize(viewDirectionW + uniforms.bvxSunDir);
                let bvxGlint = smoothstep(0.30, 0.45, pow(max(dot(normalW, bvxHalf), 0.0), 120.0)) * bvxRamp;

                // drifting sparkles where two noise fields align
                let bvxSparkle = bvxNoise2(fragmentInputs.vPositionW.xz * 9.0 + vec2f(uniforms.bvxTime * 0.8, -uniforms.bvxTime * 0.5))
                    * bvxNoise2(fragmentInputs.vPositionW.xz * 13.0 - vec2f(uniforms.bvxTime * 0.6, uniforms.bvxTime * 0.9));
                let bvxSpark = smoothstep(0.64, 0.84, bvxSparkle) * bvxRamp * bvxUp;

                // foam where the water meets land, and on wave crests - both
                // broken up by the same slow drifting noise so the shoreline
                // never reads as an outline traced around the terrain
                let bvxFoamN = bvxNoise2(fragmentInputs.vPositionW.xz * 2.6 + vec2f(-uniforms.bvxTime * 0.22, uniforms.bvxTime * 0.17));
                let bvxCrest = smoothstep(0.72, 0.95, fragmentInputs.bvxWaveCrest * (0.55 + 0.55 * bvxFoamN));
                let bvxSurf = smoothstep(0.30, 0.85, bvxShore * (0.60 + 0.70 * bvxFoamN));
                let bvxFoam = max(bvxCrest, bvxSurf) * bvxUp;

                color = vec4f(
                    bvxWater
                        + vec3f(1.0, 0.98, 0.90) * bvxGlint * 0.9
                        + vec3f(0.95, 1.0, 1.0) * bvxSpark * 0.30
                        + vec3f(0.88, 0.96, 1.0) * bvxFoam * (0.30 + 0.45 * bvxRamp),
                    clamp(mix(0.84, 0.96, bvxFresnel) + bvxFoam * 0.25 + bvxGlint * 0.3, 0.0, 0.97));
            }
            `
        };
    }
}

/**
 * Replaces Babylon's SSAO composite shader with one that tints the occlusion
 * instead of multiplying the scene by a grey factor.
 *
 * A neutral multiply is the correct thing to do for a physically-lit scene and
 * the wrong thing for a painted one: it drains saturation out of every crease
 * and leaves the smudged grey shading that reads as dirt on voxel geometry.
 * Tinting toward a cool shade keeps creases part of the painting.
 *
 * The mapping is deliberately steeper than the raw signal. Screen-space
 * occlusion at a right-angle corner is physically about a fifth of the
 * hemisphere, so the visibility factor there only reaches ~0.78 - and a gentle
 * tint of a 0.22 signal is a 5% darkening nobody can see. `SHARPEN` below 1
 * lifts the small values where all the interesting geometry lives; the tint is
 * dark enough that what survives actually reads.
 *
 * Must be called before the SSAO pipeline is constructed - Babylon caches the
 * compiled effect under the shader's name.
 */
export const installGhibliOcclusionCombine = (): void => {
    ShaderStore.ShadersStoreWGSL["ssaoCombinePixelShader"] = /* wgsl */ `
    varying vUV: vec2f;

    var textureSamplerSampler: sampler;
    var textureSampler: texture_2d<f32>;
    var originalColorSampler: sampler;
    var originalColor: texture_2d<f32>;

    uniform viewport: vec4f;

    const SHARPEN: f32 = 0.62;
    const OCCLUSION_TINT: vec3f = vec3f(0.30, 0.40, 0.62);

    @fragment
    fn main(input: FragmentInputs) -> FragmentOutputs {
        let uv = uniforms.viewport.xy + input.vUV * uniforms.viewport.zw;
        let scene = textureSample(originalColor, originalColorSampler, uv);

        // Babylon's SSAO writes the visibility factor into every channel
        let visibility = clamp(textureSample(textureSampler, textureSamplerSampler, uv).r, 0.0, 1.0);
        let occlusion = pow(1.0 - visibility, SHARPEN);

        let shade = mix(vec3f(1.0), OCCLUSION_TINT, occlusion);

        fragmentOutputs.color = vec4f(scene.rgb * shade, scene.a);
    }
    `;
};

/**
 * Builds the procedural sky dome - a vertical gradient from a warm cream
 * horizon to a cerulean zenith, with a sun disc/halo and two-tone drifting
 * clouds. The dome is a large inward-facing sphere; scene fog never touches
 * it and the shader animates itself from the scene clock.
 *
 * Returns the dome and a callback that keeps it centred on the camera, so the
 * horizon never slides past the viewer however far the camera pans.
 */
export const createSky = (scene: Scene, sunDirection: Vector3, radius: number): Mesh => {
    ShaderStore.ShadersStoreWGSL["bvxSkyVertexShader"] = /* wgsl */ `
    attribute position: vec3f;

    uniform worldViewProjection: mat4x4f;

    varying vDir: vec3f;

    @vertex
    fn main(input: VertexInputs) -> FragmentInputs {
        vertexOutputs.vDir = vertexInputs.position;
        vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
    }
    `;

    ShaderStore.ShadersStoreWGSL["bvxSkyFragmentShader"] = /* wgsl */ `
    uniform bvxTime: f32;
    uniform bvxSunDir: vec3f;

    varying vDir: vec3f;

    ${NOISE_WGSL}

    fn bvxFbm(p0: vec2f) -> f32 {
        var value = 0.0;
        var amplitude = 0.5;
        var p = p0;

        for (var i = 0; i < 5; i++) {
            value += bvxNoise2(p) * amplitude;
            p = p * 2.03 + vec2f(11.7, 5.3);
            amplitude *= 0.5;
        }

        return value;
    }

    @fragment
    fn main(input: FragmentInputs) -> FragmentOutputs {
        let d = normalize(input.vDir);
        let h = clamp(d.y, 0.0, 1.0);

        // warm cream horizon -> soft mid blue -> cerulean zenith. The first
        // band is deliberately wide: a tight horizon gradient is what makes a
        // sky dome read as a painted backdrop with a seam in it.
        var sky = mix(${HORIZON_WGSL}, vec3f(0.62, 0.81, 0.95), smoothstep(0.0, 0.28, h));
        sky = mix(sky, vec3f(0.26, 0.53, 0.88), smoothstep(0.16, 0.72, h));

        // sun disc and a wide warm halo
        let sd = clamp(dot(d, uniforms.bvxSunDir), 0.0, 1.0);
        sky += vec3f(1.0, 0.92, 0.75) * pow(sd, 700.0) * 1.3;
        sky += vec3f(1.0, 0.86, 0.64) * pow(sd, 5.0) * 0.13;

        // puffy two-tone clouds on a planar projection, domain-warped and
        // drifting slowly, fading out toward the horizon
        let fade = smoothstep(0.015, 0.20, d.y);

        if (fade > 0.001) {
            let p = d.xz / (d.y + 0.12);
            let q = p * 0.9 + vec2f(uniforms.bvxTime * 0.006, uniforms.bvxTime * 0.0025);

            let n = bvxFbm(q + bvxFbm(q * 1.6 + vec2f(uniforms.bvxTime * 0.004, 0.0)) * 0.55);
            let coverage = smoothstep(0.47, 0.62, n);

            // sunlit tops, cool shaded undersides - the offset that samples the
            // "tops" field is biased toward the sun so the whole cloud deck is
            // lit from one direction
            let tops = smoothstep(0.52, 0.86, bvxFbm(q * 1.13 - uniforms.bvxSunDir.xz * 0.30));
            let cloud = mix(vec3f(0.70, 0.76, 0.86), vec3f(1.04, 1.02, 0.99), tops);

            sky = mix(sky, cloud, coverage * fade * 0.92);
        }

        // Below the horizon the dome fades to the same colour the ground plane
        // fogs to. The ground covers this everywhere it reaches, but it is
        // clipped by the far plane, and this is what fills the sliver of dome
        // that shows through beneath the true horizon.
        sky = mix(${HORIZON_WGSL}, sky, smoothstep(-0.30, 0.01, d.y));

        // Written in linear space, because the image-processing post-process
        // owns the conversion back to gamma for the whole frame. StandardMaterial
        // does this for us behind IMAGEPROCESSINGPOSTPROCESS; a hand-written
        // shader has to do it itself, and skipping it is why the dome used to
        // come out a washed, over-bright cream that never quite matched the
        // fogged ground it meets at the horizon.
        fragmentOutputs.color = vec4f(pow(max(sky, vec3f(0.0)), vec3f(2.2)), 1.0);
    }
    `;

    const material = new ShaderMaterial("bvx-sky", scene, "bvxSky", {
        attributes: ["position"],
        uniforms: ["worldViewProjection", "bvxTime", "bvxSunDir"],
        shaderLanguage: ShaderLanguage.WGSL
    });

    material.setVector3("bvxSunDir", sunDirection.normalizeToNew());
    material.setFloat("bvxTime", 0);
    material.backFaceCulling = false;

    const sky = MeshBuilder.CreateSphere("bvx-sky", { diameter: radius * 2, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);

    sky.material = material;
    sky.isPickable = false;
    sky.applyFog = false;
    sky.infiniteDistance = true;

    // the dome is pure background - nothing occludes it and it occludes nothing
    sky.renderingGroupId = 0;
    sky.alwaysSelectAsActiveMesh = true;

    scene.onBeforeRenderObservable.add(() => {
        material.setFloat("bvxTime", performance.now() * 0.001);
    });

    return sky;
};
