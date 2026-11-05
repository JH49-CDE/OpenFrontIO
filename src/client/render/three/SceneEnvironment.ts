/**
 * SceneEnvironment — sky, fog and lights of the 3D map.
 *
 * - Lights: a warm sun (DirectionalLight from the north-west) and a cool
 *   HemisphereLight fill. Other layers' MeshStandardMaterials are lit by
 *   them; the custom terrain / water shaders read the same values through
 *   `uniforms` (`diffuseLight()` in shaders/water.ts reproduces three's
 *   direct + hemisphere Lambert terms, so both match).
 * - Sky: a camera-centred dome (horizon haze → zenith blue, sun glow), drawn
 *   first without depth. It only shows when the view reaches the horizon.
 * - Fog: `scene.fog` (linear, horizon colour), re-ranged every frame from
 *   the camera distance: none top-down, a distance haze when tilted. Every
 *   material with `fog: true` (built-in or custom) uses it.
 *
 * Layers are only handed the shared context, so the instance registers
 * itself per scene: `SceneEnvironment.forScene(ctx.scene)`, or
 * `environmentUniforms(ctx.scene)` for the shader uniforms (defaults when no
 * environment exists, e.g. in tests).
 */

import * as THREE from "three";
import { SKY_FRAG, SKY_VERT } from "./shaders/water";
import { fogRangeForView } from "./TerrainShading";
import type { FrameInfo, ThreeLayerContext } from "./types";

/** Direction *towards* the sun (from the north-west, high). */
export const SUN_DIRECTION = new THREE.Vector3(-0.5, 0.8, -0.35).normalize();

export const SUN_COLOR = 0xfff1dc;
export const SUN_INTENSITY = 2.4;
export const HEMI_SKY = 0xcfe3ff;
const HEMI_GROUND = 0x4d4a3c;
export const HEMI_INTENSITY = 1.1;
const SKY_ZENITH = 0x4f86c6;
/** Horizon haze; also the fog colour, so distant ground melts into the sky. */
const SKY_HORIZON = 0xbcd3e3;

/**
 * Lot 4 prototype, night (`?three_night=1`, NightLights.ts): the moonlit
 * environment `setNightDepth(1)` reaches. A cool, dim moon in the sun's
 * place (its disc and glow in the sky), a dark blue sky fill, a near-black
 * sky and horizon (the fog colour too).
 */
export const NIGHT_ENVIRONMENT = {
  moonColor: 0xb8c8f0,
  moonIntensity: 0.4,
  hemiSky: 0x3a4a66,
  hemiGround: 0x101318,
  hemiIntensity: 0.22,
  zenith: 0x040a18,
  horizon: 0x18233a,
  moonTint: 0x6f7fa0,
} as const;
/** Depth past which the night only dims (up to 1.25: ambient 0.2). */
const NIGHT_DIM_PER_DEPTH = 2;

/**
 * Uniform objects of the environment, shared BY REFERENCE: spread them into
 * a ShaderMaterial's `uniforms` and the values follow the environment.
 * Colours are linear (three's working colour space).
 */
export interface EnvironmentUniforms {
  uSunDir: { value: THREE.Vector3 };
  /** Sun colour × intensity. */
  uSunIrradiance: { value: THREE.Color };
  /** Hemisphere sky / ground colour × intensity. */
  uHemiSky: { value: THREE.Color };
  uHemiGround: { value: THREE.Color };
  uSkyZenith: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  /** Sun colour without intensity (sky glow). */
  uSunTint: { value: THREE.Color };
}

function createEnvironmentUniforms(): EnvironmentUniforms {
  return {
    uSunDir: { value: SUN_DIRECTION.clone() },
    uSunIrradiance: {
      value: new THREE.Color(SUN_COLOR).multiplyScalar(SUN_INTENSITY),
    },
    uHemiSky: {
      value: new THREE.Color(HEMI_SKY).multiplyScalar(HEMI_INTENSITY),
    },
    uHemiGround: {
      value: new THREE.Color(HEMI_GROUND).multiplyScalar(HEMI_INTENSITY),
    },
    uSkyZenith: { value: new THREE.Color(SKY_ZENITH) },
    uSkyHorizon: { value: new THREE.Color(SKY_HORIZON) },
    uSunTint: { value: new THREE.Color(SUN_COLOR) },
  };
}

const environments = new WeakMap<THREE.Scene, SceneEnvironment>();

/**
 * The environment uniforms of `scene` (shared objects), or a standalone
 * default set when the scene has no SceneEnvironment.
 */
export function environmentUniforms(scene: THREE.Scene): EnvironmentUniforms {
  return environments.get(scene)?.uniforms ?? createEnvironmentUniforms();
}

export class SceneEnvironment {
  readonly sun: THREE.DirectionalLight;
  readonly hemisphere: THREE.HemisphereLight;
  /** Unit vector towards the sun (same object as `uniforms.uSunDir.value`). */
  readonly sunDirection: THREE.Vector3;
  /** Linear fog, re-ranged every frame (also `scene.fog`). */
  readonly fog: THREE.Fog;
  /** Shared shader uniforms, see `EnvironmentUniforms`. */
  readonly uniforms: EnvironmentUniforms;

  private readonly sky: THREE.Mesh;
  private readonly skyMaterial: THREE.ShaderMaterial;
  /** Night depth last applied (`setNightDepth`; 0 = the day look). */
  private nightDepth = 0;
  private readonly previousBackground: THREE.Scene["background"];
  private readonly maxTiltRad: number;

  /** The environment registered for `scene`, if any. */
  static forScene(scene: THREE.Scene): SceneEnvironment | undefined {
    return environments.get(scene);
  }

  constructor(private readonly ctx: ThreeLayerContext) {
    this.uniforms = createEnvironmentUniforms();
    this.sunDirection = this.uniforms.uSunDir.value;
    this.maxTiltRad = (ctx.settings.maxTiltDeg * Math.PI) / 180;

    this.sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    // A directional light shines from `position` towards `target`; only the
    // direction matters, so keep both near the origin.
    this.sun.position.copy(this.sunDirection).multiplyScalar(100);
    this.sun.target.position.set(0, 0, 0);
    this.hemisphere = new THREE.HemisphereLight(
      HEMI_SKY,
      HEMI_GROUND,
      HEMI_INTENSITY,
    );

    this.fog = new THREE.Fog(SKY_HORIZON, 1e6, 2e6);

    this.skyMaterial = new THREE.ShaderMaterial({
      name: "three-sky",
      glslVersion: THREE.GLSL3,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { ...this.uniforms },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      this.skyMaterial,
    );
    this.sky.name = "sky";
    this.sky.frustumCulled = false;
    // First of the opaque queue; everything else draws over it.
    this.sky.renderOrder = -1e6;

    this.previousBackground = ctx.scene.background;
    // Clear colour behind the dome (only matters if the dome is skipped).
    ctx.scene.background = new THREE.Color(SKY_HORIZON);
    ctx.scene.fog = this.fog;
    ctx.scene.add(this.sun, this.sun.target, this.hemisphere, this.sky);
    environments.set(ctx.scene, this);
  }

  update(frame: FrameInfo): void {
    const cam = frame.camera;
    // Camera → target distance: the target is on the ground (Y = 0) along
    // the view axis, which is `tilt` away from straight down.
    const cos = Math.cos(frame.tilt);
    const distance = cos > 0.05 ? cam.position.y / cos : cam.position.y;
    const tiltFraction = this.maxTiltRad > 0 ? frame.tilt / this.maxTiltRad : 0;
    const range = fogRangeForView(distance, tiltFraction);
    this.fog.near = range.near;
    this.fog.far = range.far;

    // Keep the dome around the camera and inside the far plane.
    this.sky.position.copy(cam.position);
    this.sky.scale.setScalar(cam.far * 0.9);
  }

  /**
   * Lot 4 prototype, night (only called with `?three_night=1`, by
   * NightLighting when the depth changes): blends the
   * lights, sky and fog from the day look (0) to the moonlit one (1,
   * `NIGHT_ENVIRONMENT`); past 1 it only dims (×0.5 at 1.25). Colours are
   * blended in linear space; the shader uniforms are shared by reference,
   * so every material follows.
   */
  setNightDepth(depth: number): void {
    const d = Math.max(0, Math.min(1.25, Number.isFinite(depth) ? depth : 0));
    if (d === this.nightDepth) return;
    this.nightDepth = d;
    const t = Math.min(1, d);
    const dim = 1 - NIGHT_DIM_PER_DEPTH * Math.max(0, d - 1);
    const N = NIGHT_ENVIRONMENT;
    const mixHex = (out: THREE.Color, day: number, night: number) =>
      out.lerpColors(new THREE.Color(day), new THREE.Color(night), t);
    const u = this.uniforms;
    mixHex(this.sun.color, SUN_COLOR, N.moonColor);
    this.sun.intensity =
      (SUN_INTENSITY + (N.moonIntensity - SUN_INTENSITY) * t) * dim;
    u.uSunIrradiance.value
      .copy(this.sun.color)
      .multiplyScalar(this.sun.intensity);
    const hemiI =
      (HEMI_INTENSITY + (N.hemiIntensity - HEMI_INTENSITY) * t) * dim;
    mixHex(this.hemisphere.color, HEMI_SKY, N.hemiSky);
    mixHex(this.hemisphere.groundColor, HEMI_GROUND, N.hemiGround);
    this.hemisphere.intensity = hemiI;
    u.uHemiSky.value.copy(this.hemisphere.color).multiplyScalar(hemiI);
    u.uHemiGround.value.copy(this.hemisphere.groundColor).multiplyScalar(hemiI);
    mixHex(u.uSkyZenith.value, SKY_ZENITH, N.zenith);
    mixHex(u.uSkyHorizon.value, SKY_HORIZON, N.horizon);
    mixHex(u.uSunTint.value, SUN_COLOR, N.moonTint);
    this.fog.color.copy(u.uSkyHorizon.value);
    const bg = this.ctx.scene.background;
    if (bg instanceof THREE.Color) bg.copy(u.uSkyHorizon.value);
  }

  dispose(): void {
    const scene = this.ctx.scene;
    scene.remove(this.sun, this.sun.target, this.hemisphere, this.sky);
    this.sun.dispose();
    this.hemisphere.dispose();
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    if (scene.fog === this.fog) scene.fog = null;
    scene.background = this.previousBackground;
    if (environments.get(scene) === this) environments.delete(scene);
  }
}
