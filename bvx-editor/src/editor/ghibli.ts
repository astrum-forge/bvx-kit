import {
    Effect,
    Material,
    MaterialPluginBase,
    Mesh,
    MeshBuilder,
    Scene,
    ShaderMaterial,
    UniformBuffer,
    Vector3
} from "@babylonjs/core";

/**
 * Ghibli-inspired shading for the editor, built as StandardMaterial plugins so
 * shadows, fog and vertex colours keep working unchanged.
 *
 * - GhibliToonPlugin: soft-banded painterly light ramp for solid voxels,
 *   sand and the ground plane.
 * - GhibliWaterPlugin: animated stylised water - vertex waves, wavy normals,
 *   fresnel transparency, banded sun glints, drifting sparkles and crest foam.
 * - createSky: a procedural gradient sky dome with drifting clouds and a sun.
 */

/**
 * The luminance the accumulated scene lighting is normalised by inside the
 * toon ramps. Tuned to the editor's key + hemispheric + fill light rig - a
 * fully sun-lit surface lands near 1.0, a fully shadowed one near 0.2.
 */
const LIGHT_NORMALISER = "1.5";

/**
 * Shared GLSL - a cheap value noise used by the water sparkle/foam breakup.
 */
const NOISE_GLSL = /* glsl */ `
float bvxHash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float bvxNoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(
        mix(bvxHash21(i), bvxHash21(i + vec2(1.0, 0.0)), u.x),
        mix(bvxHash21(i + vec2(0.0, 1.0)), bvxHash21(i + vec2(1.0, 1.0)), u.x),
        u.y);
}
`;

/**
 * Shared GLSL - the animated water height field, a sum of three directional
 * waves normalised into [-1, 0] so displacement only ever pulls the surface
 * down into the voxel volume (never opens gaps against neighbours).
 */
const WAVE_GLSL = /* glsl */ `
float bvxWaveField(vec2 p, float t) {
    float w = sin(dot(p, vec2(0.86, 0.50)) * 1.9 + t * 1.15);
    w += sin(dot(p, vec2(-0.35, 0.94)) * 2.7 + t * 1.65) * 0.60;
    w += sin(dot(p, vec2(0.55, -0.83)) * 4.1 + t * 2.30) * 0.35;

    return (w / 1.95) * 0.5 - 0.5;
}
`;

/**
 * Soft-banded painterly light ramp. Collapses the accumulated lighting
 * (all lights, with shadows folded in) into three soft toon bands, grades
 * shadows cool and sunlight warm, adds a sky-blue rim on silhouettes and a
 * subtle per-voxel tint jitter for a hand-painted feel.
 */
export class GhibliToonPlugin extends MaterialPluginBase {
    constructor(material: Material) {
        super(material, "GhibliToon", 200);
        this._enable(true);
    }

    public override getClassName(): string {
        return "GhibliToonPlugin";
    }

    public override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
        if (shaderType !== "fragment") {
            return null;
        }

        return {
            // diffuseBase (accumulated lighting incl. shadows), baseColor
            // (vertex colours incl. baked AO), diffuseColor, normalW and
            // viewDirectionW are all in scope here; fog is applied afterwards
            CUSTOM_FRAGMENT_BEFORE_FOG: /* glsl */ `
            {
                vec3 bvxAlbedo = baseColor.rgb * diffuseColor;

                // per-voxel painterly tint jitter, sampled from the cell the
                // surface belongs to (nudged inward so faces do not flicker
                // between the two cells they sit between)
                vec3 bvxCell = floor(vPositionW - normalW * 0.05);
                float bvxJitter = fract(sin(dot(bvxCell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
                bvxAlbedo *= 1.0 + (bvxJitter - 0.5) * 0.09;

                // three soft toon bands over the accumulated lighting
                float bvxT = clamp(dot(diffuseBase, vec3(0.2126, 0.7152, 0.0722)) / ${LIGHT_NORMALISER}, 0.0, 1.0);
                float bvxRamp = smoothstep(0.18, 0.30, bvxT) * 0.40
                    + smoothstep(0.45, 0.58, bvxT) * 0.38
                    + smoothstep(0.78, 0.90, bvxT) * 0.22;

                // cool luminous shadows, warm sunlight
                vec3 bvxLight = mix(vec3(0.40, 0.46, 0.62), vec3(1.12, 1.07, 0.98), bvxRamp);

                // sky-tinted rim on silhouettes, strongest on the lit side
                float bvxRim = pow(1.0 - clamp(dot(normalW, viewDirectionW), 0.0, 1.0), 3.5);

                color.rgb = bvxAlbedo * bvxLight
                    + bvxAlbedo * vec3(0.55, 0.72, 0.95) * bvxRim * (0.10 + 0.35 * bvxRamp);
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

    public override getUniforms(): { ubo: { name: string, size: number, type: string }[], vertex: string, fragment: string } {
        // the ubo list feeds the Material uniform buffer; the vertex/fragment
        // declarations are used instead when the engine runs without UBOs
        return {
            ubo: [
                { name: "bvxTime", size: 1, type: "float" },
                { name: "bvxSunDir", size: 3, type: "vec3" }
            ],
            vertex: /* glsl */ `
            uniform float bvxTime;
            `,
            fragment: /* glsl */ `
            uniform float bvxTime;
            uniform vec3 bvxSunDir;
            `
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

    public override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
        if (shaderType === "vertex") {
            return {
                CUSTOM_VERTEX_DEFINITIONS: /* glsl */ `
                varying float vWaveCrest;
                ${WAVE_GLSL}
                `,

                // displace in world space so the field is continuous across
                // chunk meshes - the chunk world matrices are pure translations
                CUSTOM_VERTEX_UPDATE_POSITION: /* glsl */ `
                {
                    vec4 bvxWorldPos = world * vec4(positionUpdated, 1.0);
                    float bvxWave = bvxWaveField(bvxWorldPos.xz, bvxTime);

                    positionUpdated.y += bvxWave * 0.07;
                    vWaveCrest = 1.0 + bvxWave;
                }
                `
            };
        }

        return {
            CUSTOM_FRAGMENT_DEFINITIONS: /* glsl */ `
            varying float vWaveCrest;
            ${WAVE_GLSL}
            ${NOISE_GLSL}
            `,

            // tilt up-facing normals along the wave slopes before the lighting
            // loop runs, so diffuse, shadows and the glints all see the waves
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: /* glsl */ `
            {
                float bvxUpW = smoothstep(0.35, 0.7, normalW.y);

                if (bvxUpW > 0.001) {
                    float bvxE = 0.1;
                    float bvxH0 = bvxWaveField(vPositionW.xz, bvxTime);
                    float bvxHx = bvxWaveField(vPositionW.xz + vec2(bvxE, 0.0), bvxTime);
                    float bvxHz = bvxWaveField(vPositionW.xz + vec2(0.0, bvxE), bvxTime);

                    // exaggerated slope so the small displacement reads clearly
                    vec3 bvxWaveN = normalize(vec3((bvxH0 - bvxHx) * 0.18 / bvxE, 1.0, (bvxH0 - bvxHz) * 0.18 / bvxE));

                    normalW = normalize(mix(normalW, bvxWaveN, bvxUpW * 0.85));
                }
            }
            `,

            CUSTOM_FRAGMENT_BEFORE_FOG: /* glsl */ `
            {
                float bvxUp = smoothstep(0.35, 0.7, normalW.y);
                float bvxFresnel = pow(1.0 - clamp(dot(normalW, viewDirectionW), 0.0, 1.0), 2.5);

                // the same banded light ramp as the solids, slightly simplified
                float bvxT = clamp(dot(diffuseBase, vec3(0.2126, 0.7152, 0.0722)) / ${LIGHT_NORMALISER}, 0.0, 1.0);
                float bvxRamp = smoothstep(0.15, 0.30, bvxT) * 0.5 + smoothstep(0.50, 0.68, bvxT) * 0.5;

                // face-on looks into the depths, grazing reflects the sky
                vec3 bvxWater = mix(vec3(0.07, 0.36, 0.55), vec3(0.55, 0.80, 0.92), bvxFresnel * 0.9 + 0.12 * bvxUp);
                bvxWater *= mix(vec3(0.45, 0.55, 0.80), vec3(1.05, 1.02, 0.96), bvxRamp);

                // crisp banded sun glint
                vec3 bvxHalf = normalize(viewDirectionW + bvxSunDir);
                float bvxGlint = smoothstep(0.30, 0.45, pow(max(dot(normalW, bvxHalf), 0.0), 120.0)) * bvxRamp;

                // drifting sparkles where two noise fields align
                float bvxSparkle = bvxNoise2(vPositionW.xz * 9.0 + vec2(bvxTime * 0.8, -bvxTime * 0.5))
                    * bvxNoise2(vPositionW.xz * 13.0 - vec2(bvxTime * 0.6, bvxTime * 0.9));
                float bvxSpark = smoothstep(0.60, 0.80, bvxSparkle) * bvxRamp * bvxUp;

                // foam on wave crests, broken up by slow drifting noise
                float bvxFoamN = bvxNoise2(vPositionW.xz * 2.6 + vec2(-bvxTime * 0.22, bvxTime * 0.17));
                float bvxFoam = smoothstep(0.72, 0.95, vWaveCrest * (0.55 + 0.55 * bvxFoamN)) * bvxUp;

                color.rgb = bvxWater
                    + vec3(1.0, 0.98, 0.90) * bvxGlint * 0.9
                    + vec3(0.95, 1.0, 1.0) * bvxSpark * 0.35
                    + vec3(0.88, 0.96, 1.0) * bvxFoam * (0.25 + 0.4 * bvxRamp);

                color.a = clamp(mix(0.68, 0.92, bvxFresnel) + bvxFoam * 0.25 + bvxGlint * 0.3, 0.0, 0.95);
            }
            `
        };
    }
}

/**
 * Builds the procedural sky dome - a vertical gradient from a warm cream
 * horizon to a cerulean zenith, with a sun disc/halo and two-tone drifting
 * clouds. The dome is a large inward-facing sphere; scene fog never touches
 * it and the shader animates itself from the scene clock.
 */
export const createSky = (scene: Scene, center: Vector3, sunDirection: Vector3): Mesh => {
    Effect.ShadersStore["bvxSkyVertexShader"] = /* glsl */ `
    precision highp float;

    attribute vec3 position;

    uniform mat4 worldViewProjection;

    varying vec3 vDir;

    void main(void) {
        vDir = position;
        gl_Position = worldViewProjection * vec4(position, 1.0);
    }
    `;

    Effect.ShadersStore["bvxSkyFragmentShader"] = /* glsl */ `
    precision highp float;

    uniform float bvxTime;
    uniform vec3 bvxSunDir;

    varying vec3 vDir;

    float bvxHash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float bvxNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);

        return mix(
            mix(bvxHash(i), bvxHash(i + vec2(1.0, 0.0)), u.x),
            mix(bvxHash(i + vec2(0.0, 1.0)), bvxHash(i + vec2(1.0, 1.0)), u.x),
            u.y);
    }

    float bvxFbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;

        for (int i = 0; i < 5; i++) {
            value += bvxNoise(p) * amplitude;
            p = p * 2.03 + vec2(11.7, 5.3);
            amplitude *= 0.5;
        }

        return value;
    }

    void main(void) {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);

        // warm cream horizon -> soft mid blue -> cerulean zenith
        vec3 sky = mix(vec3(0.98, 0.95, 0.86), vec3(0.62, 0.81, 0.94), smoothstep(0.0, 0.22, h));
        sky = mix(sky, vec3(0.28, 0.55, 0.86), smoothstep(0.22, 0.75, h));

        // sun disc and a wide warm halo
        float sd = clamp(dot(d, bvxSunDir), 0.0, 1.0);
        sky += vec3(1.0, 0.92, 0.75) * pow(sd, 600.0) * 1.2;
        sky += vec3(1.0, 0.85, 0.62) * pow(sd, 6.0) * 0.10;

        // puffy two-tone clouds on a planar projection, domain-warped and
        // drifting slowly, fading out toward the horizon
        float fade = smoothstep(0.02, 0.16, d.y);

        if (fade > 0.001) {
            vec2 p = d.xz / (d.y + 0.12);
            vec2 q = p * 0.9 + vec2(bvxTime * 0.006, bvxTime * 0.0025);

            float n = bvxFbm(q + bvxFbm(q * 1.6 + vec2(bvxTime * 0.004, 0.0)) * 0.55);
            float coverage = smoothstep(0.48, 0.60, n);
            float tops = smoothstep(0.55, 0.85, bvxFbm(q * 1.13 - vec2(0.0, 0.22)));

            vec3 cloud = mix(vec3(0.72, 0.78, 0.86), vec3(1.03, 1.01, 0.99), tops);

            sky = mix(sky, cloud, coverage * fade * 0.92);
        }

        // soft haze below the horizon so the dome never shows a hard edge
        sky = mix(vec3(0.80, 0.86, 0.82), sky, smoothstep(-0.25, 0.02, d.y));

        gl_FragColor = vec4(sky, 1.0);
    }
    `;

    const material = new ShaderMaterial("bvx-sky", scene, "bvxSky", {
        attributes: ["position"],
        uniforms: ["worldViewProjection", "bvxTime", "bvxSunDir"]
    });

    material.setVector3("bvxSunDir", sunDirection.normalizeToNew());
    material.setFloat("bvxTime", 0);

    const sky = MeshBuilder.CreateSphere("bvx-sky", { diameter: 900, segments: 12, sideOrientation: Mesh.BACKSIDE }, scene);

    sky.material = material;
    sky.position.copyFrom(center);
    sky.isPickable = false;
    sky.applyFog = false;

    scene.onBeforeRenderObservable.add(() => {
        material.setFloat("bvxTime", performance.now() * 0.001);
    });

    return sky;
};
