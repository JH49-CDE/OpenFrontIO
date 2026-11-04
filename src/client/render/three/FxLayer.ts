/**
 * FxLayer — explosions, shockwaves, flashes and smoke from dead units, plus
 * conquest / bonus sparkles.
 *
 * Triggers (same as the default FxPass, units.md §4):
 * | event                                         | effect                                        |
 * |-----------------------------------------------|-----------------------------------------------|
 * | Atom / Hydrogen / MIRV Warhead, reachedTarget | short flash, ground flash, light flash,       |
 * |                                               | shockwave ring, embers, rising fireball and   |
 * |                                               | a lit mushroom cloud (stem + cap), base surge |
 * | same types without reachedTarget (SAM kill)   | airborne flash ~25 tiles up, ring, sparks     |
 * | any structure                                 | small explosion + smoke                       |
 * | Warship                                       | splash, ripple, small fire + smoke            |
 * | Shell with reachedTarget                      | tiny flash                                    |
 * | Train without reachedTarget                   | small explosion                               |
 * | conquest (local player) / bonus               | golden sparkle burst                          |
 * MIRV carriers, boats and SAM missiles produce nothing.
 *
 * Contract notes: `applyBonusEvents` receives events already filtered to the
 * local player (all of them when there is none, e.g. spectating), exactly as
 * the default renderer filters them.
 *
 * Building blocks — fixed-capacity pools, at most 5 draw calls, nothing is
 * allocated per frame:
 * - glow particles: additive camera-facing quads (sparks, flashes, sparkles);
 * - smoke particles: alpha-blended camera-facing quads (smoke, dust, spray);
 *   both are CPU-simulated (closed-form motion, see `dragDisplacement`) and
 *   streamed into instanced attributes;
 * - fireballs: instanced additive spheres with a soft limb;
 * - decals: polar-grid rings / discs whose vertices are re-draped on the
 *   relief every frame (shockwaves, ground flashes, ripples);
 * - flash lights: ≤ 4 PointLights that stay in the scene at intensity 0 when
 *   idle — the light count is part of three's program key, so adding or
 *   hiding lights would recompile every lit material mid-game. They light
 *   three's lit meshes (units / structures); the custom terrain shader is
 *   lit by the ground-flash decal instead.
 *
 * Timing: events are queued with their `tickAge` and spawned in `update`,
 * starting at `frame.nowMs - tickAge * msPerTick` (replay seeks start effects
 * part-way through and skip those older than their lifetime). At most
 * `SPAWN_BUDGET_PER_FRAME` effects spawn per frame (a MIRV lands hundreds of
 * warheads in one tick) and a long backlog spawns reduced variants.
 *
 * Sizes: a nuke's cloud, flash and fireball scale with its visual radius
 * (`nukeVisualRadius`: the default renderer's per-type radii, so a hydrogen
 * bomb is ~2.3× an atom bomb and a MIRV warhead matches an atom bomb); its
 * shockwave ring keeps the gameplay outer radius × 1.5.
 *
 * Particle colours are linear HDR. The bloom threshold is 1.0 (luminance),
 * so only values above that glow: flashes and fire peak around 3-4, the
 * young cloud and embers sit just above 1, cooled smoke stays below.
 */

import * as THREE from "three";
import { nukeExplosionRadius } from "../gl/passes/fx-pass/FxSettings";
import type { RenderSettings } from "../gl/RenderSettings";
import type {
  BonusEvent,
  ConquestFx,
  DeadUnitFx,
  NukeExplosionRenderParams,
} from "../types";
import {
  NUKE_MAGNITUDES,
  STRUCTURE_TYPES,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV_WARHEAD,
  UT_SHELL,
  UT_TRAIN,
  UT_WARSHIP,
} from "../types/UnitType";
import type { FrameInfo, ThreeLayerContext } from "./types";

// ---------------------------------------------------------------------------
// Effect kinds and lifetimes
// ---------------------------------------------------------------------------

export const FxKind = {
  Nuke: 0,
  NukeIntercepted: 1,
  StructureDestroyed: 2,
  WarshipSunk: 3,
  ShellHit: 4,
  TrainDestroyed: 5,
  Conquest: 6,
  Bonus: 7,
} as const;
export type FxKind = (typeof FxKind)[keyof typeof FxKind];

/**
 * Total visible lifetime of each effect (ms, longest part including spawn
 * delays). Events older than this are skipped.
 */
export const FX_LIFETIME_MS: Readonly<Record<FxKind, number>> = {
  [FxKind.Nuke]: 7200,
  [FxKind.NukeIntercepted]: 2700,
  [FxKind.StructureDestroyed]: 3600,
  [FxKind.WarshipSunk]: 3500,
  [FxKind.ShellHit]: 400,
  [FxKind.TrainDestroyed]: 2300,
  [FxKind.Conquest]: 1500,
  [FxKind.Bonus]: 1000,
};

/** Visual shockwave radius = gameplay outer blast radius × this. */
export const SHOCKWAVE_RADIUS_FACTOR = 1.5;
/** Default shockwave duration (render-settings default), ms. */
const SHOCKWAVE_MS = 1500;
/** Height (tiles above the surface) of SAM interceptions. */
export const INTERCEPT_ALTITUDE = 25;
/** Mushroom-cap height as a multiple of the nuke's visual radius. */
const NUKE_CLOUD_HEIGHT = 1.15;
/** Mushroom-cap radius as a multiple of the nuke's visual radius. */
const NUKE_CAP_RADIUS = 0.5;
/** Drag (1/s) of the rising cloud: 53% of the climb after 1 s, 95% after 4. */
const CLOUD_K = 0.75;

const MAX_PENDING = 1024;
const SPAWN_BUDGET_PER_FRAME = 12;
/** Queue length above which effects spawn in their reduced variant. */
const LITE_BACKLOG = 24;
const MAX_LIVE_EFFECTS = 160;
/** Queued effects that could not spawn within this long are dropped. */
const MAX_QUEUE_WAIT_MS = 1000;

const GLOW_CAPACITY = 2048;
const SMOKE_CAPACITY = 2048;
const FIREBALL_CAPACITY = 48;
const DECAL_CAPACITY = 32;
const LIGHT_POOL = 4;

/** Frames over which the perf counters keep their maxima. */
const FILL_WINDOW = 120;

const RENDER_ORDER_DECALS = 20;
const RENDER_ORDER_SMOKE = 21;
const RENDER_ORDER_FIREBALLS = 22;
const RENDER_ORDER_GLOW = 23;

/** Effect for a dead unit, or null (MIRV carrier, boats, SAM missiles). */
export function fxKindForDeadUnit(d: DeadUnitFx): FxKind | null {
  switch (d.unitType) {
    case UT_ATOM_BOMB:
    case UT_HYDROGEN_BOMB:
    case UT_MIRV_WARHEAD:
      return d.reachedTarget ? FxKind.Nuke : FxKind.NukeIntercepted;
    case UT_WARSHIP:
      return FxKind.WarshipSunk;
    case UT_SHELL:
      return d.reachedTarget ? FxKind.ShellHit : null;
    case UT_TRAIN:
      return d.reachedTarget ? null : FxKind.TrainDestroyed;
    default:
      return STRUCTURE_TYPES.has(d.unitType) ? FxKind.StructureDestroyed : null;
  }
}

/** Gameplay outer blast radius of a nuke type (tiles), 0 if not a nuke. */
export function nukeOuterRadius(unitType: string): number {
  return NUKE_MAGNITUDES[unitType]?.outer ?? 0;
}

/**
 * Converts the default renderer's nuke FX radii (render-settings `fx`,
 * 70 / 160 / 70) to the 3D effect scale: an atom bomb's visual radius then
 * equals its gameplay outer blast radius (30 tiles).
 */
export const NUKE_VISUAL_SCALE = 30 / 70;

/**
 * Visual radius (tiles) of a nuke's flash / fireball / cloud, from the
 * default renderer's per-type radii; 0 if not a nuke.
 */
export function nukeVisualRadius(
  unitType: string,
  fx: RenderSettings["fx"],
): number {
  return (nukeExplosionRadius(fx, unitType) ?? 0) * NUKE_VISUAL_SCALE;
}

/** When an event that happened `tickAge` ticks ago started, in frame time. */
export function effectStartMs(
  nowMs: number,
  tickAge: number | undefined,
  msPerTick: number,
): number {
  return nowMs - Math.max(0, tickAge ?? 0) * msPerTick;
}

/** True when an effect started at `startMs` is fully over at `nowMs`. */
export function isEffectExpired(
  nowMs: number,
  startMs: number,
  lifetimeMs: number,
): boolean {
  return nowMs - startMs >= lifetimeMs;
}

/**
 * Shockwave ring of a nuke: the player's nuke-explosion cosmetic sets an
 * absolute radius, a duration of 2·maxRadius/speed and its first colour
 * (shown as a ring whatever the cosmetic's type); otherwise outer × 1.5 over
 * 1.5 s in warm white.
 */
export function shockwaveParams(
  outerRadius: number,
  cosmetic: NukeExplosionRenderParams | undefined,
): { radius: number; durationMs: number; color: [number, number, number] } {
  if (cosmetic && cosmetic.maxRadius > 0 && cosmetic.speed > 0) {
    const c = cosmetic.colors[0] ?? [1, 1, 1];
    return {
      radius: cosmetic.maxRadius,
      durationMs: clamp(
        (2000 * cosmetic.maxRadius) / cosmetic.speed,
        400,
        6000,
      ),
      color: [c[0] * 2.5, c[1] * 2.5, c[2] * 2.5],
    };
  }
  return {
    radius: outerRadius * SHOCKWAVE_RADIUS_FACTOR,
    durationMs: SHOCKWAVE_MS,
    color: [2.4, 1.9, 1.4],
  };
}

// ---------------------------------------------------------------------------
// Curves (pure, unit-tested). `u` is normalised age 0..1.
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function easeOutCubic(u: number): number {
  const v = 1 - clamp(u, 0, 1);
  return 1 - v * v * v;
}

export function easeOutQuad(u: number): number {
  const v = 1 - clamp(u, 0, 1);
  return 1 - v * v;
}

/**
 * Displacement factor of a velocity under linear drag `k` (1/s) after `t`
 * seconds: ∫₀ᵗ e^(−k s) ds = (1 − e^(−k t)) / k, → t as k → 0 and → 1/k
 * (the asymptote) as t → ∞. Position = p0 + v · this − ½ g t².
 */
export function dragDisplacement(t: number, k: number): number {
  if (t <= 0) return 0;
  if (k < 1e-6) return t;
  return (1 - Math.exp(-k * t)) / k;
}

/**
 * Alpha envelope of a particle: linear fade-in over `fadeIn` of its life,
 * full opacity for a further `hold` of it, then an ease-out fade
 * (1 − v)^1.4 to zero at the end.
 */
export function particleEnvelope(u: number, fadeIn: number, hold = 0): number {
  if (u <= 0 || u >= 1) return 0;
  if (fadeIn > 0 && u < fadeIn) return u / fadeIn;
  const start = Math.min(0.999, fadeIn + Math.max(0, hold));
  if (u <= start) return 1;
  const v = (u - start) / (1 - start);
  return Math.pow(1 - v, 1.4);
}

/**
 * Fireball radius relative to its peak: a violent expansion over the first
 * 20% of its life (ease-out), then a slow 25% swell while it cools.
 */
export function fireballRadiusFactor(u: number): number {
  const c = clamp(u, 0, 1);
  if (c < 0.2) return 0.9 * easeOutCubic(c / 0.2);
  return 0.9 + 0.25 * ((c - 0.2) / 0.8);
}

/** Fireball colour keys (linear HDR): white-hot → yellow → orange → dark red → out. */
const FIREBALL_KEYS: readonly (readonly [number, number, number, number])[] = [
  [0, 8, 7.5, 6.5],
  [0.15, 7, 4.2, 1.4],
  [0.4, 4, 1.4, 0.25],
  [0.7, 1.2, 0.2, 0.04],
  [1, 0, 0, 0],
];

/** Fireball colour at `u` (piecewise linear over FIREBALL_KEYS) into `out`. */
export function fireballColor(u: number, out: number[] = [0, 0, 0]): number[] {
  const c = clamp(u, 0, 1);
  for (let i = 1; i < FIREBALL_KEYS.length; i++) {
    const b = FIREBALL_KEYS[i];
    if (c <= b[0]) {
      const a = FIREBALL_KEYS[i - 1];
      const f = (c - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * f;
      out[1] = a[2] + (b[2] - a[2]) * f;
      out[2] = a[3] + (b[3] - a[3]) * f;
      return out;
    }
  }
  out[0] = out[1] = out[2] = 0;
  return out;
}

/** Shock-front radius relative to its maximum (decelerating). */
export function shockwaveRadiusFactor(u: number): number {
  return easeOutCubic(u);
}

/** Shock-front opacity: quick fade-in, then (1 − u)^1.5. */
export function shockwaveAlpha(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return Math.min(1, u * 12) * Math.pow(1 - u, 1.5);
}

/** Ground-flash disc opacity: (1 − u)². */
export function flashAlpha(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return (1 - u) * (1 - u);
}

/** PointLight flash intensity relative to its peak. */
export function lightFlashFactor(u: number): number {
  if (u < 0 || u >= 1) return 0;
  return Math.min(1, u * 20) * (1 - u) * (1 - u);
}

/** Small seeded PRNG (mulberry32) returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural sprite textures (RGBA8, row 0 = bottom, i.e. v = 0)
// ---------------------------------------------------------------------------

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Soft round glow: gaussian core, zero alpha at the quad edge. */
/**
 * Screen area (device px², clipped to the viewport) of a camera-facing quad
 * of side `size` (world units) centred on world point (x, y, z), seen
 * through `view` (the camera's `matrixWorldInverse` elements, column-major)
 * with a perspective focal length of `focalPx` (device px). 0 behind the
 * camera. Rotation of the quad is ignored. This is the fill estimate of
 * `FxLayer.perfStats`: blended FX fragments cost fill rate, not vertices.
 */
export function quadScreenArea(
  view: ArrayLike<number>,
  focalPx: number,
  widthPx: number,
  heightPx: number,
  x: number,
  y: number,
  z: number,
  size: number,
): number {
  const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
  const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
  const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
  const depth = -vz;
  if (!(depth > 1e-3) || !(size > 0)) return 0;
  const k = focalPx / depth;
  const cx = widthPx / 2 + vx * k;
  const cy = heightPx / 2 - vy * k;
  const half = (size / 2) * k;
  const w = Math.min(widthPx, cx + half) - Math.max(0, cx - half);
  const h = Math.min(heightPx, cy + half) - Math.max(0, cy - half);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Camera data for the fill estimate (perf tool only). */
interface FillView {
  view: ArrayLike<number>;
  focalPx: number;
  widthPx: number;
  heightPx: number;
}

export function softCircleTexels(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = (i + 0.5 - half) / half;
      const dy = (j + 0.5 - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.exp(-d * d * 4.5) * (1 - smoothstep(0.8, 1, d));
      const o = (j * size + i) * 4;
      out[o] = out[o + 1] = out[o + 2] = 255;
      out[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  return out;
}

/**
 * Cauliflower smoke puff: a few overlapping gaussian blobs (seeded), alpha
 * = clamped density with a round falloff; R = shading, brighter towards the
 * top of the sprite (lit from above), darker in dense cores.
 */
export function smokePuffTexels(size: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const blobs: { x: number; y: number; r: number }[] = [];
  for (let b = 0; b < 7; b++) {
    const ang = rand() * Math.PI * 2;
    const dist = b === 0 ? 0 : 0.18 + rand() * 0.22;
    blobs.push({
      x: Math.cos(ang) * dist,
      y: Math.sin(ang) * dist,
      r: b === 0 ? 0.42 : 0.2 + rand() * 0.16,
    });
  }
  const out = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const px = (i + 0.5 - half) / half;
      const py = (j + 0.5 - half) / half;
      let density = 0;
      for (const bl of blobs) {
        const dx = (px - bl.x) / bl.r;
        const dy = (py - bl.y) / bl.r;
        density += Math.exp(-(dx * dx + dy * dy) * 1.6);
      }
      const edge = 1 - smoothstep(0.75, 1, Math.sqrt(px * px + py * py));
      const a = clamp(density * 0.9, 0, 1) * edge;
      const shade = clamp(
        0.62 + 0.3 * py + 0.12 * (1 - clamp(density, 0, 1.5)),
        0,
        1,
      );
      const o = (j * size + i) * 4;
      out[o] = out[o + 1] = out[o + 2] = Math.round(shade * 255);
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

function makeSpriteTexture(
  texels: Uint8Array,
  size: number,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(texels, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shaders (three ShaderMaterial, GLSL ES 1 syntax upgraded by three)
// ---------------------------------------------------------------------------

/** Camera-facing quad per instance: centre, rgba, (size, rotation). */
const BILLBOARD_VERT = /* glsl */ `
attribute vec3 iOffset;
attribute vec4 iColor;
attribute vec2 iSizeRot;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
  float c = cos(iSizeRot.y);
  float s = sin(iSizeRot.y);
  vec2 p = position.xy * iSizeRot.x;
  mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vColor = iColor;
}
`;

const GLOW_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float a = texture2D(uMap, vUv).a * vColor.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SMOKE_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vColor.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb * t.r, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FIREBALL_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vColor;
varying vec3 vObj;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vNormalW = normalize(mat3(m) * normal);
  vViewW = cameraPosition - wp.xyz;
  vColor = instanceColor;
  vObj = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** Bright core, soft limb, a cheap trig "boil" scrolling with time. */
const FIREBALL_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vColor;
varying vec3 vObj;
void main() {
  float f = clamp(dot(normalize(vNormalW), normalize(vViewW)), 0.0, 1.0);
  float boil = sin(vObj.x * 9.0 + uTime * 3.1) * sin(vObj.y * 11.0 - uTime * 2.3)
             * sin(vObj.z * 10.0 + uTime * 2.7);
  float core = pow(f, 1.4) * (0.85 + 0.3 * boil);
  gl_FragColor = vec4(vColor * (0.12 + core), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DECAL_VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec2 aParams;
varying vec4 vColor;
varying vec2 vParams;
void main() {
  vColor = aColor;
  vParams = aParams;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * aParams.x = radial position across the decal (0 inner .. 1 outer edge),
 * aParams.y = mode: 0 ring (bright front at the outer edge, soft trailing
 * side), 1 disc (quadratic falloff from the centre).
 */
const DECAL_FRAG = /* glsl */ `
varying vec4 vColor;
varying vec2 vParams;
void main() {
  float t = vParams.x;
  float profile = vParams.y < 0.5
    ? smoothstep(0.0, 0.8, t) * (1.0 - smoothstep(0.86, 1.0, t))
    : (1.0 - t) * (1.0 - t);
  float a = vColor.a * profile;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Particle pool (CPU-simulated billboards)
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/** Everything describing one particle; times in ms, lengths in tiles. */
export interface ParticleSpec {
  /** Spawn delay after the effect start. */
  delayMs: number;
  lifeMs: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Linear drag, 1/s (velocity · e^(−k t)). */
  drag: number;
  /** Downward acceleration, tiles/s² (negative = buoyant). */
  grav: number;
  /** Full quad size at birth / at death. */
  size0: number;
  size1: number;
  color0: Rgb;
  color1: Rgb;
  /** Fraction of the life over which colour goes color0 → color1. */
  colorTime: number;
  alpha: number;
  fadeIn: number;
  /** Fraction of the life held at full alpha after the fade-in. */
  hold: number;
  rot: number;
  spin: number;
  /** 0..1 flicker depth (sparkles). */
  twinkle: number;
}

function defaultSpec(): ParticleSpec {
  return {
    delayMs: 0,
    lifeMs: 1000,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    drag: 0,
    grav: 0,
    size0: 1,
    size1: 1,
    color0: [1, 1, 1],
    color1: [1, 1, 1],
    colorTime: 1,
    alpha: 1,
    fadeIn: 0.05,
    hold: 0,
    rot: 0,
    spin: 0,
    twinkle: 0,
  };
}

// Float64 particle record layout (times stay exact for long sessions).
const P_T0 = 0;
const P_LIFE = 1;
const P_PX = 2;
const P_VX = 5;
const P_DRAG = 8;
const P_GRAV = 9;
const P_S0 = 10;
const P_S1 = 11;
const P_C0 = 12;
const P_C1 = 15;
const P_CTIME = 18;
const P_ALPHA = 19;
const P_FADEIN = 20;
const P_ROT = 21;
const P_SPIN = 22;
const P_TWINKLE = 23;
const P_PHASE = 24;
const P_HOLD = 25;
const P_STRIDE = 26;

function dynamicInstanced(
  capacity: number,
  itemSize: number,
): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * itemSize),
    itemSize,
  );
  attr.setUsage(THREE.DynamicDrawUsage);
  return attr;
}

function markRange(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

class ParticlePool {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly data: Float64Array;
  private readonly offsets: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly sizeRot: THREE.InstancedBufferAttribute;
  private count = 0;
  private phase = 0;

  constructor(
    private readonly capacity: number,
    material: THREE.ShaderMaterial,
    renderOrder: number,
    name: string,
  ) {
    this.data = new Float64Array(capacity * P_STRIDE);
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    this.offsets = dynamicInstanced(capacity, 3);
    this.colors = dynamicInstanced(capacity, 4);
    this.sizeRot = dynamicInstanced(capacity, 2);
    geo.setAttribute("iOffset", this.offsets);
    geo.setAttribute("iColor", this.colors);
    geo.setAttribute("iSizeRot", this.sizeRot);
    geo.instanceCount = 0;
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  get size(): number {
    return this.count;
  }

  /** Adds a particle born at `startMs + s.delayMs`; false when full. */
  spawn(s: ParticleSpec, startMs: number): boolean {
    if (this.count >= this.capacity) return false;
    const d = this.data;
    const o = this.count++ * P_STRIDE;
    d[o + P_T0] = startMs + s.delayMs;
    d[o + P_LIFE] = Math.max(1, s.lifeMs);
    d[o + P_PX] = s.x;
    d[o + P_PX + 1] = s.y;
    d[o + P_PX + 2] = s.z;
    d[o + P_VX] = s.vx;
    d[o + P_VX + 1] = s.vy;
    d[o + P_VX + 2] = s.vz;
    d[o + P_DRAG] = s.drag;
    d[o + P_GRAV] = s.grav;
    d[o + P_S0] = s.size0;
    d[o + P_S1] = s.size1;
    d[o + P_C0] = s.color0[0];
    d[o + P_C0 + 1] = s.color0[1];
    d[o + P_C0 + 2] = s.color0[2];
    d[o + P_C1] = s.color1[0];
    d[o + P_C1 + 1] = s.color1[1];
    d[o + P_C1 + 2] = s.color1[2];
    d[o + P_CTIME] = Math.max(1e-3, s.colorTime);
    d[o + P_ALPHA] = s.alpha;
    d[o + P_FADEIN] = clamp(s.fadeIn, 0, 0.95);
    d[o + P_ROT] = s.rot;
    d[o + P_SPIN] = s.spin;
    d[o + P_TWINKLE] = s.twinkle;
    d[o + P_PHASE] = this.phase = (this.phase + 2.399) % 6.2832;
    d[o + P_HOLD] = clamp(s.hold, 0, 0.95);
    return true;
  }

  /** Simulate to `nowMs`, drop dead particles, stream the live ones. */
  update(nowMs: number): void {
    const d = this.data;
    const off = this.offsets.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const sr = this.sizeRot.array as Float32Array;
    let n = 0;
    let i = 0;
    while (i < this.count) {
      const o = i * P_STRIDE;
      const age = nowMs - d[o + P_T0];
      const life = d[o + P_LIFE];
      if (age >= life) {
        // Swap-remove: move the last record here and re-test this slot.
        const last = --this.count;
        if (i !== last) d.copyWithin(o, last * P_STRIDE, (last + 1) * P_STRIDE);
        continue;
      }
      i++;
      if (age < 0) continue; // delayed birth
      const u = age / life;
      const t = age / 1000;
      const disp = dragDisplacement(t, d[o + P_DRAG]);
      const fall = 0.5 * d[o + P_GRAV] * t * t;
      let a =
        d[o + P_ALPHA] * particleEnvelope(u, d[o + P_FADEIN], d[o + P_HOLD]);
      const tw = d[o + P_TWINKLE];
      if (tw > 0) {
        a *= 1 - tw * 0.5 * (1 + Math.sin(age * 0.025 + d[o + P_PHASE]));
      }
      if (a <= 0.001) continue;
      const cm = Math.min(1, u / d[o + P_CTIME]);
      const k3 = n * 3;
      off[k3] = d[o + P_PX] + d[o + P_VX] * disp;
      off[k3 + 1] = d[o + P_PX + 1] + d[o + P_VX + 1] * disp - fall;
      off[k3 + 2] = d[o + P_PX + 2] + d[o + P_VX + 2] * disp;
      const k4 = n * 4;
      col[k4] = d[o + P_C0] + (d[o + P_C1] - d[o + P_C0]) * cm;
      col[k4 + 1] = d[o + P_C0 + 1] + (d[o + P_C1 + 1] - d[o + P_C0 + 1]) * cm;
      col[k4 + 2] = d[o + P_C0 + 2] + (d[o + P_C1 + 2] - d[o + P_C0 + 2]) * cm;
      col[k4 + 3] = a;
      const k2 = n * 2;
      sr[k2] = d[o + P_S0] + (d[o + P_S1] - d[o + P_S0]) * easeOutQuad(u);
      sr[k2 + 1] = d[o + P_ROT] + d[o + P_SPIN] * t;
      n++;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      markRange(this.offsets, n);
      markRange(this.colors, n);
      markRange(this.sizeRot, n);
    }
  }

  /** Screen area of the quads streamed by the last `update` (device px²). */
  screenArea(v: FillView): number {
    const off = this.offsets.array as Float32Array;
    const sr = this.sizeRot.array as Float32Array;
    let area = 0;
    for (let i = 0; i < this.geometry.instanceCount; i++) {
      area += quadScreenArea(
        v.view,
        v.focalPx,
        v.widthPx,
        v.heightPx,
        off[i * 3],
        off[i * 3 + 1],
        off[i * 3 + 2],
        sr[i * 2],
      );
    }
    return area;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Fireballs (instanced spheres)
// ---------------------------------------------------------------------------

interface Fireball {
  x: number;
  y: number;
  z: number;
  radius: number;
  lifeMs: number;
  startMs: number;
  /** Rise speed of the centre, tiles/s (when `riseK` is 0). */
  rise: number;
  /**
   * With `riseK` > 0 the centre instead climbs `riseTo` tiles with drag
   * riseK (1/s): riseTo · (1 − e^(−riseK·t)), the same law as the cloud
   * puffs, so a nuke's fireball stays inside its rising cap.
   */
  riseTo?: number;
  riseK?: number;
  /** Centre height above `y` as a fraction of the current radius. */
  lift: number;
  intensity: number;
}

class FireballPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly items: Fireball[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly rgb = [0, 0, 0];

  constructor(
    private readonly capacity: number,
    material: THREE.ShaderMaterial,
  ) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 3),
      material,
      capacity,
    );
    this.mesh.name = "fx-fireballs";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Creates the instanceColor attribute (USE_INSTANCING_COLOR).
    this.mesh.setColorAt(0, this.color.setRGB(0, 0, 0));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER_FIREBALLS;
    this.mesh.visible = false;
  }

  get size(): number {
    return this.items.length;
  }

  spawn(f: Fireball): boolean {
    if (this.items.length >= this.capacity) return false;
    this.items.push(f);
    return true;
  }

  update(nowMs: number): void {
    const items = this.items;
    let n = 0;
    let w = 0;
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      const age = nowMs - f.startMs;
      if (age >= f.lifeMs) continue;
      items[w++] = f;
      if (age < 0) continue;
      const u = age / f.lifeMs;
      const r = Math.max(1e-3, f.radius * fireballRadiusFactor(u));
      const rk = f.riseK ?? 0;
      const climb =
        rk > 0
          ? (f.riseTo ?? 0) * rk * dragDisplacement(age / 1000, rk)
          : (f.rise * age) / 1000;
      const y = f.y + r * f.lift + climb;
      // Slightly squashed: a hot dome rather than a ball.
      this.matrix.makeScale(r, r * 0.85, r).setPosition(f.x, y, f.z);
      this.mesh.setMatrixAt(n, this.matrix);
      fireballColor(u, this.rgb);
      const k = f.intensity;
      this.mesh.setColorAt(
        n,
        this.color.setRGB(this.rgb[0] * k, this.rgb[1] * k, this.rgb[2] * k),
      );
      n++;
    }
    items.length = w;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      markRange(this.mesh.instanceMatrix, n);
      markRange(this.mesh.instanceColor!, n);
    }
  }

  /** Screen area of the spheres drawn by the last `update` (device px²). */
  screenArea(v: FillView): number {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    let area = 0;
    for (let i = 0; i < this.mesh.count; i++) {
      const o = i * 16;
      // Bounding square of the disc (side 2r), times π/4 for the disc.
      area +=
        (Math.PI / 4) *
        quadScreenArea(
          v.view,
          v.focalPx,
          v.widthPx,
          v.heightPx,
          m[o + 12],
          m[o + 13],
          m[o + 14],
          2 * m[o],
        );
    }
    return area;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Decals (rings / discs draped on the relief)
// ---------------------------------------------------------------------------

/** Radial rows (≥ 2) and angular segments of a decal's polar grid. */
const DECAL_RADIAL = 5;
const DECAL_ANGULAR = 64;
const DECAL_VERTS = DECAL_RADIAL * (DECAL_ANGULAR + 1);
const DECAL_INDICES = (DECAL_RADIAL - 1) * DECAL_ANGULAR * 6;
/** Draped decals float this far above the surface (tiles). */
const DECAL_LIFT = 0.3;

const DecalMode = { Ring: 0, Disc: 1 } as const;
type DecalMode = (typeof DecalMode)[keyof typeof DecalMode];

interface Decal {
  x: number;
  z: number;
  /** Fixed world Y, or NaN to drape on the surface. */
  y: number;
  mode: DecalMode;
  /** Final outer radius. */
  radius: number;
  /** Ring band width as a fraction of the radius (min 1.5 tiles). */
  width: number;
  lifeMs: number;
  startMs: number;
  color: Rgb;
  alpha: number;
}

interface SurfaceSampler {
  surfaceAt(x: number, y: number): number;
}

class DecalPool {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly position: THREE.BufferAttribute;
  private readonly color: THREE.BufferAttribute;
  private readonly params: THREE.BufferAttribute;
  private readonly items: Decal[] = [];
  private readonly cos = new Float32Array(DECAL_ANGULAR + 1);
  private readonly sin = new Float32Array(DECAL_ANGULAR + 1);

  constructor(
    private readonly capacity: number,
    material: THREE.ShaderMaterial,
  ) {
    const verts = capacity * DECAL_VERTS;
    this.position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.color = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    this.params = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
    for (const a of [this.position, this.color, this.params]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    const index =
      verts > 65535
        ? new Uint32Array(capacity * DECAL_INDICES)
        : new Uint16Array(capacity * DECAL_INDICES);
    let k = 0;
    const row = DECAL_ANGULAR + 1;
    for (let d = 0; d < capacity; d++) {
      const base = d * DECAL_VERTS;
      for (let r = 0; r < DECAL_RADIAL - 1; r++) {
        for (let a = 0; a < DECAL_ANGULAR; a++) {
          const v00 = base + r * row + a;
          const v01 = v00 + 1;
          const v10 = v00 + row;
          const v11 = v10 + 1;
          index[k++] = v00;
          index[k++] = v10;
          index[k++] = v01;
          index[k++] = v01;
          index[k++] = v10;
          index[k++] = v11;
        }
      }
    }
    for (let a = 0; a <= DECAL_ANGULAR; a++) {
      const ang = (a / DECAL_ANGULAR) * Math.PI * 2;
      this.cos[a] = Math.cos(ang);
      this.sin[a] = Math.sin(ang);
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("aColor", this.color);
    this.geometry.setAttribute("aParams", this.params);
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = "fx-decals";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER_DECALS;
    this.mesh.visible = false;
  }

  get size(): number {
    return this.items.length;
  }

  spawn(d: Decal): boolean {
    if (this.items.length >= this.capacity) return false;
    this.items.push(d);
    return true;
  }

  update(nowMs: number, surface: SurfaceSampler): void {
    const items = this.items;
    const pos = this.position.array as Float32Array;
    const col = this.color.array as Float32Array;
    const par = this.params.array as Float32Array;
    let n = 0;
    let w = 0;
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const age = nowMs - d.startMs;
      if (age >= d.lifeMs) continue;
      items[w++] = d;
      if (age < 0) continue;
      const u = age / d.lifeMs;
      let inner: number;
      let outer: number;
      let alpha: number;
      if (d.mode === DecalMode.Ring) {
        outer = d.radius * shockwaveRadiusFactor(u);
        inner = Math.max(0, outer - Math.max(1.5, d.width * outer));
        alpha = d.alpha * shockwaveAlpha(u);
      } else {
        outer = d.radius * (0.55 + 0.45 * easeOutCubic(u));
        inner = 0;
        alpha = d.alpha * flashAlpha(u);
      }
      if (alpha <= 0.002 || outer <= 0.05) continue;
      const draped = Number.isNaN(d.y);
      let v = n * DECAL_VERTS;
      for (let r = 0; r < DECAL_RADIAL; r++) {
        const t = r / (DECAL_RADIAL - 1);
        const rad = inner + (outer - inner) * t;
        for (let a = 0; a <= DECAL_ANGULAR; a++, v++) {
          const x = d.x + rad * this.cos[a];
          const z = d.z + rad * this.sin[a];
          pos[v * 3] = x;
          pos[v * 3 + 1] = draped ? surface.surfaceAt(x, z) + DECAL_LIFT : d.y;
          pos[v * 3 + 2] = z;
          col[v * 4] = d.color[0];
          col[v * 4 + 1] = d.color[1];
          col[v * 4 + 2] = d.color[2];
          col[v * 4 + 3] = alpha;
          par[v * 2] = t;
          par[v * 2 + 1] = d.mode;
        }
      }
      n++;
    }
    items.length = w;
    this.geometry.setDrawRange(0, n * DECAL_INDICES);
    this.mesh.visible = n > 0;
    if (n > 0) {
      markRange(this.position, n * DECAL_VERTS);
      markRange(this.color, n * DECAL_VERTS);
      markRange(this.params, n * DECAL_VERTS);
    }
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Flash lights
// ---------------------------------------------------------------------------

interface LightSlot {
  light: THREE.PointLight;
  startMs: number;
  lifeMs: number;
  peak: number;
}

/** A point-light flash request (world tiles, ms, candela). */
interface LightFlash {
  x: number;
  y: number;
  z: number;
  peak: number;
  range: number;
  lifeMs: number;
  startMs: number;
}

class FlashLights {
  readonly slots: LightSlot[] = [];

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffc27a, 0, 1, 2);
      light.name = `fx-flash-${i}`;
      this.slots.push({ light, startMs: 0, lifeMs: 0, peak: 0 });
    }
  }

  /**
   * Use a free light, else the dimmest one if it is dimmer than this flash
   * (a nuke is never stolen by a burning building).
   */
  flash(f: LightFlash, nowMs: number): void {
    let best: LightSlot | null = null;
    let bestIntensity = Infinity;
    for (const s of this.slots) {
      const i = this.intensityAt(s, nowMs);
      if (i < bestIntensity) {
        best = s;
        bestIntensity = i;
      }
    }
    if (!best || bestIntensity >= f.peak) return;
    best.startMs = f.startMs;
    best.lifeMs = f.lifeMs;
    best.peak = f.peak;
    best.light.position.set(f.x, f.y, f.z);
    best.light.distance = f.range;
  }

  update(nowMs: number): void {
    for (const s of this.slots) s.light.intensity = this.intensityAt(s, nowMs);
  }

  private intensityAt(s: LightSlot, nowMs: number): number {
    if (s.lifeMs <= 0) return 0;
    return s.peak * lightFlashFactor((nowMs - s.startMs) / s.lifeMs);
  }

  dispose(): void {
    for (const s of this.slots) s.light.dispose();
  }
}

// ---------------------------------------------------------------------------
// Effect recipes' building blocks
// ---------------------------------------------------------------------------

/**
 * Linear HDR colours shared by the recipes. Bloom starts at luminance 1
 * (0.21 R + 0.72 G + 0.07 B): flashes peak around 3-4, sparks / embers ~2,
 * the young fire-lit cloud just above 1, cooled smoke and cloud below.
 */
const SPARK_HOT: Rgb = [3.6, 1.7, 0.5];
const SPARK_COOL: Rgb = [1.3, 0.3, 0.05];
const FLASH_WHITE: Rgb = [4, 3.75, 3.3];
const FLASH_ORANGE: Rgb = [2.6, 1.3, 0.45];
const GOLD_HOT: Rgb = [2.8, 2.0, 0.65];
const GOLD_COOL: Rgb = [1.5, 0.85, 0.2];
/**
 * Mushroom cloud once the fire light has faded: sunlit cap top, shaded cap
 * underside and stem, dusty base surge (the puff texture multiplies these
 * by its own 0.62..1 top-lit shading).
 */
const CLOUD_TOP: Rgb = [0.95, 0.9, 0.82];
const CLOUD_UNDER: Rgb = [0.52, 0.45, 0.4];
const CLOUD_STEM: Rgb = [0.64, 0.56, 0.48];
const CLOUD_FIRE: Rgb = [2.5, 0.85, 0.2];
const DUST_HOT: Rgb = [1.15, 0.85, 0.55];
const DUST: Rgb = [0.5, 0.45, 0.38];

/** One camera-facing glow flash (sizes in tiles). */
interface GlowFlashOptions {
  x: number;
  y: number;
  z: number;
  startMs: number;
  size0: number;
  size1: number;
  lifeMs: number;
  color0: Rgb;
  color1: Rgb;
  /** Peak alpha (default 1) and fade-in fraction (default 0.02). */
  alpha?: number;
  fadeIn?: number;
}

/** Hot sparks thrown out on ballistic arcs from one point. */
interface SparkOptions {
  n: number;
  x: number;
  y: number;
  z: number;
  startMs: number;
  /** Typical launch speed, tiles/s (gravity scales with it). */
  speed: number;
  size: number;
  lifeMs: number;
}

/** Smoke puffs rising from around a point. */
interface PuffOptions {
  n: number;
  x: number;
  y: number;
  z: number;
  startMs: number;
  /** Horizontal scatter of the birth points, tiles. */
  spread: number;
  /** Typical rise speed, tiles/s. */
  rise: number;
  size0: number;
  size1: number;
  lifeMs: number;
  color0: Rgb;
  color1: Rgb;
  alpha: number;
}

// ---------------------------------------------------------------------------
// FxLayer
// ---------------------------------------------------------------------------

interface PendingFx {
  kind: FxKind;
  /** World position of the event (tile centre). */
  x: number;
  z: number;
  /** Gameplay outer blast radius for nukes. */
  outer: number;
  /** Visual radius for nukes (`nukeVisualRadius`). */
  visual: number;
  cosmetic: NukeExplosionRenderParams | undefined;
  tickAge: number;
  /** Assigned on the first `update` after the event arrived. */
  startMs: number;
  /** Frame time of that first `update`. */
  queuedMs: number;
}

export class FxLayer {
  private readonly glow: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly fireballs: FireballPool;
  private readonly decals: DecalPool;
  private readonly lights: FlashLights;
  private readonly root = new THREE.Group();
  private readonly textures: THREE.Texture[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly time = { value: 0 };

  private readonly pending: PendingFx[] = [];
  /** End times of live effects (concurrency cap). */
  private readonly liveEnds: number[] = [];
  private readonly rand = mulberry32(0x0f1e2d3c);
  private readonly spec = defaultSpec();
  /** Particle-count multiplier (quality × backlog). */
  private density = 1;
  /**
   * Flash brightness for the nukes spawning this frame: 1/√n for n
   * simultaneous detonations, so a MIRV salvo's overlapping additive
   * flashes do not saturate into a white-out.
   */
  private flashGain = 1;
  private readonly baseDensity: number;
  /**
   * Perf tool only (`three_perf=1`): FX fill of the last frames, in screens
   * (quad / sphere screen area over the viewport area), and the camera data
   * of the last frame.
   */
  private readonly recentFill: Float32Array | null;
  private recentIndex = 0;
  private readonly fillView: {
    view: Float32Array;
    focalPx: number;
    widthPx: number;
    heightPx: number;
  } | null;

  constructor(private readonly ctx: ThreeLayerContext) {
    const low = ctx.settings.quality === "low";
    this.baseDensity = low ? 0.5 : 1;
    const perf = ctx.settings.perf === true;
    this.recentFill = perf ? new Float32Array(FILL_WINDOW) : null;
    this.fillView = perf
      ? { view: new Float32Array(16), focalPx: 1, widthPx: 1, heightPx: 1 }
      : null;

    const glowTex = makeSpriteTexture(softCircleTexels(64), 64);
    const smokeTex = makeSpriteTexture(smokePuffTexels(64, 7), 64);
    this.textures.push(glowTex, smokeTex);

    const glowMat = new THREE.ShaderMaterial({
      name: "fx-glow",
      vertexShader: BILLBOARD_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: { uMap: { value: glowTex } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const smokeMat = new THREE.ShaderMaterial({
      name: "fx-smoke",
      vertexShader: BILLBOARD_VERT,
      fragmentShader: SMOKE_FRAG,
      uniforms: { uMap: { value: smokeTex } },
      transparent: true,
      depthWrite: false,
    });
    const fireMat = new THREE.ShaderMaterial({
      name: "fx-fireball",
      vertexShader: FIREBALL_VERT,
      fragmentShader: FIREBALL_FRAG,
      uniforms: { uTime: this.time },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const decalMat = new THREE.ShaderMaterial({
      name: "fx-decal",
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.materials.push(glowMat, smokeMat, fireMat, decalMat);

    this.glow = new ParticlePool(
      GLOW_CAPACITY,
      glowMat,
      RENDER_ORDER_GLOW,
      "fx-glow",
    );
    this.smoke = new ParticlePool(
      SMOKE_CAPACITY,
      smokeMat,
      RENDER_ORDER_SMOKE,
      "fx-smoke",
    );
    this.fireballs = new FireballPool(FIREBALL_CAPACITY, fireMat);
    this.decals = new DecalPool(DECAL_CAPACITY, decalMat);
    this.lights = new FlashLights(low ? 0 : LIGHT_POOL);

    this.root.name = "fx";
    this.root.add(
      this.decals.mesh,
      this.smoke.mesh,
      this.fireballs.mesh,
      this.glow.mesh,
    );
    for (const s of this.lights.slots) this.root.add(s.light);
    ctx.scene.add(this.root);
  }

  // ---- Event input ----

  applyDeadUnits(d: DeadUnitFx[]): void {
    const W = this.ctx.mapWidth;
    for (const u of d) {
      const kind = fxKindForDeadUnit(u);
      if (kind === null) continue;
      const x = u.pos % W;
      const y = (u.pos - x) / W;
      this.enqueue(kind, x + 0.5, y + 0.5, u.tickAge ?? 0, {
        outer: nukeOuterRadius(u.unitType),
        visual: nukeVisualRadius(u.unitType, this.ctx.renderSettings.fx),
        cosmetic: u.explosion,
      });
    }
  }

  applyConquestEvents(e: ConquestFx[]): void {
    for (const c of e) {
      this.enqueue(FxKind.Conquest, c.x + 0.5, c.y + 0.5, c.tickAge ?? 0);
    }
  }

  applyBonusEvents(e: BonusEvent[]): void {
    const W = this.ctx.mapWidth;
    for (const b of e) {
      if (b.gold === 0) continue;
      const x = b.tile % W;
      const y = (b.tile - x) / W;
      this.enqueue(FxKind.Bonus, x + 0.5, y + 0.5, 0);
    }
  }

  // ---- Per frame ----

  update(frame: FrameInfo): void {
    const now = frame.nowMs;
    this.time.value = (now / 1000) % 3600;
    if (this.pending.length > 0) this.spawnPending(now);
    this.glow.update(now);
    this.smoke.update(now);
    this.fireballs.update(now);
    this.decals.update(now, this.ctx.heightField);
    this.lights.update(now);
    if (this.recentFill !== null) {
      this.recentFill[this.recentIndex] = this.fillScreens(frame);
      this.recentIndex = (this.recentIndex + 1) % FILL_WINDOW;
    }
  }

  /**
   * Counters for the perf tool (`three_perf=1`): live particles and
   * effects, and the FX fill in screens (screen area of the glow / smoke
   * quads and fireballs over the viewport area: 2 = every pixel blended
   * twice on average) for the last frame and its maximum over the last 120
   * frames. Decals are thin draped rings and left out.
   */
  perfStats(): Record<string, number> {
    const fill = this.recentFill;
    const last =
      fill === null
        ? 0
        : fill[(this.recentIndex + FILL_WINDOW - 1) % FILL_WINDOW];
    let max = 0;
    if (fill !== null) for (const v of fill) max = Math.max(max, v);
    return {
      glowParticles: this.glow.size,
      smokeParticles: this.smoke.size,
      fireballs: this.fireballs.size,
      decals: this.decals.size,
      pendingEffects: this.pending.length,
      liveEffects: this.liveEnds.length,
      fillScreens: Math.round(last * 100) / 100,
      fillScreensMax: Math.round(max * 100) / 100,
    };
  }

  /** FX fill of this frame, in screens (perf tool only). */
  private fillScreens(frame: FrameInfo): number {
    const v = this.fillView;
    const cam = frame.camera;
    if (v === null || !(cam instanceof THREE.PerspectiveCamera)) return 0;
    const dpr = frame.dpr > 0 ? frame.dpr : 1;
    v.widthPx = Math.max(1, frame.cssWidth * dpr);
    v.heightPx = Math.max(1, frame.cssHeight * dpr);
    v.focalPx = v.heightPx / 2 / Math.tan(((cam.fov / 2) * Math.PI) / 180);
    v.view.set(cam.matrixWorldInverse.elements);
    const area =
      this.glow.screenArea(v) +
      this.smoke.screenArea(v) +
      this.fireballs.screenArea(v);
    return area / (v.widthPx * v.heightPx);
  }

  /** Pool / queue occupancy (debugging and tests). */
  stats(): {
    glow: number;
    smoke: number;
    fireballs: number;
    decals: number;
    pending: number;
    live: number;
  } {
    return {
      glow: this.glow.size,
      smoke: this.smoke.size,
      fireballs: this.fireballs.size,
      decals: this.decals.size,
      pending: this.pending.length,
      live: this.liveEnds.length,
    };
  }

  dispose(): void {
    this.ctx.scene.remove(this.root);
    this.glow.dispose();
    this.smoke.dispose();
    this.fireballs.dispose();
    this.decals.dispose();
    this.lights.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.pending.length = 0;
    this.liveEnds.length = 0;
  }

  // ---- Queue ----

  private enqueue(
    kind: FxKind,
    x: number,
    z: number,
    tickAge: number,
    nuke?: {
      outer: number;
      visual: number;
      cosmetic: NukeExplosionRenderParams | undefined;
    },
  ): void {
    if (this.pending.length >= MAX_PENDING) return;
    this.pending.push({
      kind,
      x,
      z,
      outer: nuke?.outer ?? 0,
      visual: nuke?.visual ?? 0,
      cosmetic: nuke?.cosmetic,
      tickAge,
      startMs: NaN,
      queuedMs: NaN,
    });
  }

  /**
   * Spawn queued effects (oldest first) within the per-frame budget and the
   * live-effect cap; drop those already over or queued for too long; keep
   * the rest queued.
   */
  private spawnPending(now: number): void {
    const ends = this.liveEnds;
    for (let i = ends.length - 1; i >= 0; i--) {
      if (ends[i] <= now) {
        ends[i] = ends[ends.length - 1];
        ends.pop();
      }
    }
    const msPerTick = this.ctx.config.msPerTick();
    const pending = this.pending;
    const lite = pending.length > LITE_BACKLOG;
    this.density = this.baseDensity * (lite ? 0.35 : 1);
    let nukes = 0;
    for (const e of pending) if (e.kind === FxKind.Nuke) nukes++;
    this.flashGain = 1 / Math.sqrt(clamp(nukes, 1, SPAWN_BUDGET_PER_FRAME));
    let budget = SPAWN_BUDGET_PER_FRAME;
    let w = 0;
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      if (Number.isNaN(e.startMs)) {
        e.startMs = effectStartMs(now, e.tickAge, msPerTick);
        e.queuedMs = now;
      }
      const life = FX_LIFETIME_MS[e.kind];
      if (isEffectExpired(now, e.startMs, life)) continue;
      // Too late to look like part of the original burst.
      if (now - e.queuedMs > MAX_QUEUE_WAIT_MS) continue;
      if (budget <= 0 || ends.length >= MAX_LIVE_EFFECTS) {
        pending[w++] = e;
        continue;
      }
      budget--;
      ends.push(e.startMs + life);
      this.spawn(e, now, lite);
    }
    pending.length = w;
  }

  private spawn(e: PendingFx, now: number, lite: boolean): void {
    switch (e.kind) {
      case FxKind.Nuke:
        this.spawnNuke(e, now, lite);
        break;
      case FxKind.NukeIntercepted:
        this.spawnIntercept(e, now);
        break;
      case FxKind.StructureDestroyed:
        this.spawnExplosion(e, now, 3, 7);
        break;
      case FxKind.TrainDestroyed:
        this.spawnExplosion(e, now, 1.8, 4);
        break;
      case FxKind.WarshipSunk:
        this.spawnSinking(e, now);
        break;
      case FxKind.ShellHit:
        this.spawnShellHit(e);
        break;
      case FxKind.Conquest:
        this.spawnSparkles(e, 26, 1, 9);
        break;
      case FxKind.Bonus:
        this.spawnSparkles(e, 8, 0.45, 0);
        break;
    }
  }

  // ---- Particle helpers ----

  private count(n: number): number {
    return Math.max(1, Math.round(n * this.density));
  }

  private rnd(lo: number, hi: number): number {
    return lo + (hi - lo) * this.rand();
  }

  /**
   * Reset the motion / look fields of the shared spec (callers always set
   * position, life, sizes and colours) and give it a random rotation.
   */
  private resetSpec(): ParticleSpec {
    const s = this.spec;
    s.delayMs = 0;
    s.vx = s.vy = s.vz = 0;
    s.drag = 0;
    s.grav = 0;
    s.colorTime = 1;
    s.alpha = 1;
    s.fadeIn = 0.05;
    s.hold = 0;
    s.rot = this.rnd(0, Math.PI * 2);
    s.spin = 0;
    s.twinkle = 0;
    return s;
  }

  private glowFlash(o: GlowFlashOptions): void {
    const s = this.resetSpec();
    s.lifeMs = o.lifeMs;
    s.x = o.x;
    s.y = o.y;
    s.z = o.z;
    s.size0 = o.size0;
    s.size1 = o.size1;
    s.color0 = o.color0;
    s.color1 = o.color1;
    s.alpha = o.alpha ?? 1;
    s.fadeIn = o.fadeIn ?? 0.02;
    this.glow.spawn(s, o.startMs);
  }

  private sparks(o: SparkOptions): void {
    for (let i = 0; i < o.n; i++) {
      const s = this.resetSpec();
      const ang = this.rnd(0, Math.PI * 2);
      const elev = this.rnd(0.35, 1.2); // launch elevation, radians
      const v = o.speed * this.rnd(0.5, 1.2);
      s.lifeMs = o.lifeMs * this.rnd(0.6, 1.1);
      s.x = o.x;
      s.y = o.y;
      s.z = o.z;
      s.vx = Math.cos(ang) * Math.cos(elev) * v;
      s.vz = Math.sin(ang) * Math.cos(elev) * v;
      s.vy = Math.sin(elev) * v;
      s.drag = 0.6;
      s.grav = o.speed * 0.9;
      s.size0 = o.size;
      s.size1 = o.size * 0.4;
      s.color0 = SPARK_HOT;
      s.color1 = SPARK_COOL;
      s.twinkle = 0.3;
      this.glow.spawn(s, o.startMs);
    }
  }

  private smokePuffs(o: PuffOptions): void {
    for (let i = 0; i < o.n; i++) {
      const s = this.resetSpec();
      s.delayMs = this.rnd(0, 250);
      s.lifeMs = o.lifeMs * this.rnd(0.8, 1);
      s.x = o.x + this.rnd(-o.spread, o.spread);
      s.y = o.y + this.rnd(0, o.spread * 0.5);
      s.z = o.z + this.rnd(-o.spread, o.spread);
      s.vy = o.rise * this.rnd(0.6, 1.2);
      s.vx = this.rnd(-0.3, 0.3) * o.rise;
      s.vz = this.rnd(-0.3, 0.3) * o.rise;
      s.drag = 0.4;
      s.size0 = o.size0 * this.rnd(0.8, 1.2);
      s.size1 = o.size1 * this.rnd(0.8, 1.2);
      s.color0 = o.color0;
      s.color1 = o.color1;
      s.colorTime = 0.3;
      s.alpha = o.alpha;
      s.fadeIn = 0.08;
      s.spin = this.rnd(-0.3, 0.3);
      this.smoke.spawn(s, o.startMs);
    }
  }

  // ---- Recipes ----

  /**
   * Nuke detonation, sized by its visual radius V (atom bomb / warhead 30,
   * hydrogen bomb ~69 tiles):
   * - a short white-hot core flash (~0.6·V across, < 0.2 s) inside a dimmer
   *   orange halo, a ground-flash disc (0.6·V) and a point-light flash;
   * - the shockwave ring (gameplay outer radius × 1.5, or the cosmetic's);
   * - embers thrown out on ballistic arcs;
   * - a fireball (0.24·V) climbing inside the cap as it cools;
   * - the mushroom cloud (`mushroom`).
   * Durations stretch with √(V / 30): a hydrogen bomb lingers a little.
   */
  private spawnNuke(e: PendingFx, now: number, lite: boolean): void {
    const V = Math.max(8, e.visual > 0 ? e.visual : e.outer);
    const { x, z } = e;
    const t0 = e.startMs;
    const ground = this.ctx.heightField.surfaceAt(x, z);
    const ring = shockwaveParams(Math.max(6, e.outer), e.cosmetic);
    const slow = clamp(Math.sqrt(V / 30), 0.75, 1.6);
    const flashY = ground + 0.12 * V;

    this.glowFlash({
      x,
      y: flashY,
      z,
      startMs: t0,
      size0: 0.55 * V,
      size1: 0.75 * V,
      lifeMs: 180 * slow,
      color0: FLASH_WHITE,
      color1: FLASH_ORANGE,
      alpha: this.flashGain,
      fadeIn: 0.1,
    });
    this.glowFlash({
      x,
      y: flashY,
      z,
      startMs: t0,
      size0: 0.95 * V,
      size1: 1.35 * V,
      lifeMs: 340 * slow,
      color0: [1.6, 1.2, 0.75],
      color1: [0.9, 0.4, 0.12],
      alpha: 0.5 * this.flashGain,
      fadeIn: 0.08,
    });
    this.decals.spawn({
      x,
      z,
      y: NaN,
      mode: DecalMode.Disc,
      radius: 0.6 * V,
      width: 0,
      lifeMs: 450 * slow,
      startMs: t0,
      color: [2.2, 1.6, 1.0],
      alpha: 0.8 * this.flashGain,
    });
    // Peak candela: the irradiance V/3 away is about the sun's.
    this.lights.flash(
      {
        x,
        y: flashY,
        z,
        peak: 0.35 * V * V,
        range: 1.8 * V,
        lifeMs: 650 * slow,
        startMs: t0,
      },
      now,
    );
    // Band ~7 tiles wide (16% of an atom's ring), and dimmer on very
    // large rings (hydrogen: 150 tiles) so they do not wash out the view.
    this.decals.spawn({
      x,
      z,
      y: NaN,
      mode: DecalMode.Ring,
      radius: ring.radius,
      width: clamp(7 / ring.radius, 0.05, 0.16),
      lifeMs: ring.durationMs,
      startMs: t0,
      color: ring.color,
      alpha: 0.85 * clamp(60 / ring.radius, 0.55, 1),
    });
    this.fireballs.spawn({
      x,
      y: ground,
      z,
      radius: 0.24 * V,
      lifeMs: 1700 * slow,
      startMs: t0,
      rise: 0,
      riseTo: 0.85 * NUKE_CLOUD_HEIGHT * V,
      riseK: CLOUD_K,
      lift: 0.5,
      intensity: 0.5,
    });
    this.embers(x, ground + 0.1 * V, z, V, t0, slow);
    this.mushroom(x, ground, z, V, t0, lite);
  }

  /** Glowing embers thrown out and up from a nuke, falling back. */
  private embers(
    x: number,
    y: number,
    z: number,
    V: number,
    t0: number,
    slow: number,
  ): void {
    const n = this.count(clamp(Math.round(0.6 * V), 10, 40));
    const size = Math.max(0.5, 0.04 * V);
    for (let i = 0; i < n; i++) {
      const s = this.resetSpec();
      const ang = this.rnd(0, Math.PI * 2);
      const elev = this.rnd(0.6, 1.35); // launch elevation, radians
      const v = 0.9 * V * this.rnd(0.5, 1.1);
      s.delayMs = this.rnd(0, 120);
      s.lifeMs = this.rnd(1300, 2300) * slow;
      s.x = x;
      s.y = y;
      s.z = z;
      s.vx = Math.cos(ang) * Math.cos(elev) * v;
      s.vz = Math.sin(ang) * Math.cos(elev) * v;
      s.vy = Math.sin(elev) * v;
      s.drag = 0.9;
      s.grav = 0.55 * V;
      s.size0 = size;
      s.size1 = size * 0.4;
      s.color0 = SPARK_HOT;
      s.color1 = SPARK_COOL;
      s.colorTime = 0.6;
      s.twinkle = 0.4;
      this.glow.spawn(s, t0);
    }
  }

  /**
   * Mushroom cloud of visual radius V. Every puff leaves the burst point
   * with velocity (target − start)·k under drag k, so it settles exactly on
   * its target (a velocity v travels v / k) and all puffs share the same
   * time course: the cloud grows as a whole, 53% of the way after 1 s.
   * - stem: puffs settling at evenly spread heights up to under the cap,
   *   flaring out near the ground;
   * - cap: a torus of puffs at height H = 1.15·V, 0.5·V in radius — a
   *   shaded underside ring drawn first, then a sunlit upper ring — plus a
   *   dome on top;
   * - base surge: dusty puffs riding out along the ground.
   * Puffs start fire-lit (above the bloom threshold) and cool to their
   * daylight colour within ~1.3 s, hold full opacity for ~40% of their
   * life, then fade. `lite` (MIRV backlog) drops the dome and the surge.
   */
  private mushroom(
    x: number,
    ground: number,
    z: number,
    V: number,
    t0: number,
    lite: boolean,
  ): void {
    const H = NUKE_CLOUD_HEIGHT * V;
    const k = CLOUD_K;
    const capR = NUKE_CAP_RADIUS * V;
    const TAU = Math.PI * 2;
    const launch = (
      s: ParticleSpec,
      ang: number,
      r0: number,
      y0: number,
      r1: number,
      y1: number,
      drag = k,
    ) => {
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      s.x = x + c * r0;
      s.y = y0;
      s.z = z + sn * r0;
      s.vx = c * (r1 - r0) * drag;
      s.vz = sn * (r1 - r0) * drag;
      s.vy = (y1 - y0) * drag;
      s.drag = drag;
    };

    const stem = this.count(clamp(Math.round(0.5 * V), 8, 26));
    for (let i = 0; i < stem; i++) {
      const s = this.resetSpec();
      const f = (i + 0.5) / stem; // 0 at the ground .. 1 under the cap
      const flare = 1 + 1.6 * Math.pow(1 - f, 3);
      launch(
        s,
        this.rnd(0, TAU),
        0.02 * V,
        ground + 0.02 * V,
        0.07 * V * flare * this.rnd(0.3, 1),
        ground + 0.86 * H * f,
      );
      s.delayMs = this.rnd(0, 120);
      s.lifeMs = this.rnd(5200, 6200);
      s.size0 = 0.11 * V;
      s.size1 = (0.17 + 0.09 * flare) * V;
      s.color0 = CLOUD_FIRE;
      s.color1 = CLOUD_STEM;
      s.colorTime = 0.2;
      s.alpha = 0.92;
      s.fadeIn = 0.04;
      s.hold = 0.4;
      s.spin = this.rnd(-0.15, 0.15);
      this.smoke.spawn(s, t0);
    }

    const cap = this.count(clamp(Math.round(0.9 * V), 12, 44));
    for (const upper of [false, true]) {
      const n = Math.max(4, Math.round(cap / 2));
      for (let i = 0; i < n; i++) {
        const s = this.resetSpec();
        const ang = ((i + (upper ? 0.5 : 0)) / n) * TAU + this.rnd(-0.2, 0.2);
        const y1 = upper
          ? H + 0.06 * V * this.rnd(0.5, 1.4)
          : H - 0.06 * V * this.rnd(0.3, 1.2);
        launch(
          s,
          ang,
          0.05 * V,
          ground + 0.08 * V,
          capR * this.rnd(upper ? 0.45 : 0.6, 1),
          ground + y1,
        );
        s.delayMs = this.rnd(60, 220);
        s.lifeMs = this.rnd(5600, 6600);
        s.size0 = 0.16 * V;
        s.size1 = 0.4 * V * this.rnd(0.85, 1.15);
        s.color0 = CLOUD_FIRE;
        s.color1 = upper ? CLOUD_TOP : CLOUD_UNDER;
        s.colorTime = upper ? 0.16 : 0.24;
        s.alpha = 0.92;
        s.fadeIn = 0.04;
        s.hold = 0.42;
        s.spin = this.rnd(-0.15, 0.15);
        this.smoke.spawn(s, t0);
      }
    }
    if (lite) return;

    const dome = this.count(clamp(Math.round(0.25 * V), 4, 14));
    for (let i = 0; i < dome; i++) {
      const s = this.resetSpec();
      launch(
        s,
        this.rnd(0, TAU),
        0.03 * V,
        ground + 0.1 * V,
        capR * this.rnd(0, 0.45),
        ground + H + 0.12 * V * this.rnd(0.6, 1.2),
      );
      s.delayMs = this.rnd(120, 260);
      s.lifeMs = this.rnd(5600, 6600);
      s.size0 = 0.18 * V;
      s.size1 = 0.42 * V;
      s.color0 = CLOUD_FIRE;
      s.color1 = CLOUD_TOP;
      s.colorTime = 0.16;
      s.alpha = 0.92;
      s.fadeIn = 0.04;
      s.hold = 0.42;
      s.spin = this.rnd(-0.15, 0.15);
      this.smoke.spawn(s, t0);
    }

    const surge = this.count(clamp(Math.round(0.5 * V), 8, 24));
    for (let i = 0; i < surge; i++) {
      const s = this.resetSpec();
      launch(
        s,
        (i / surge) * TAU + this.rnd(-0.2, 0.2),
        0.15 * V,
        ground + 0.03 * V,
        0.95 * V * this.rnd(0.8, 1.05),
        ground + 0.07 * V,
        1.3,
      );
      s.delayMs = this.rnd(0, 120);
      s.lifeMs = this.rnd(3200, 4200);
      s.size0 = 0.14 * V;
      s.size1 = 0.3 * V;
      s.color0 = DUST_HOT;
      s.color1 = DUST;
      s.colorTime = 0.3;
      s.alpha = 0.45;
      s.fadeIn = 0.08;
      s.hold = 0.2;
      s.spin = this.rnd(-0.3, 0.3);
      this.smoke.spawn(s, t0);
    }
  }

  /** SAM interception: an airborne flash, a flat ring and a little smoke. */
  private spawnIntercept(e: PendingFx, now: number): void {
    const { x, z } = e;
    const t0 = e.startMs;
    const y = this.ctx.heightField.surfaceAt(x, z) + INTERCEPT_ALTITUDE;
    this.glowFlash({
      x,
      y,
      z,
      startMs: t0,
      size0: 8,
      size1: 12,
      lifeMs: 300,
      color0: [3.6, 3.2, 2.6],
      color1: [2.2, 0.9, 0.3],
    });
    this.fireballs.spawn({
      x,
      y,
      z,
      radius: 3.2,
      lifeMs: 650,
      startMs: t0,
      rise: 0,
      lift: 0,
      intensity: 0.55,
    });
    this.decals.spawn({
      x,
      z,
      y,
      mode: DecalMode.Ring,
      radius: 14,
      width: 0.25,
      lifeMs: 700,
      startMs: t0,
      color: [1.8, 1.5, 1.15],
      alpha: 0.9,
    });
    this.lights.flash(
      { x, y, z, peak: 160, range: 36, lifeMs: 450, startMs: t0 },
      now,
    );
    this.sparks({
      n: this.count(10),
      x,
      y,
      z,
      startMs: t0,
      speed: 12,
      size: 0.7,
      lifeMs: 1000,
    });
    this.smokePuffs({
      n: this.count(5),
      x,
      y,
      z,
      startMs: t0,
      spread: 2,
      rise: 1,
      size0: 2.5,
      size1: 6,
      lifeMs: 2500,
      color0: [0.5, 0.45, 0.4],
      color1: [0.3, 0.3, 0.3],
      alpha: 0.6,
    });
  }

  /** Building / train explosion: fireball, flash, sparks, smoke. */
  private spawnExplosion(
    e: PendingFx,
    now: number,
    radius: number,
    smoke: number,
  ): void {
    const { x, z } = e;
    const t0 = e.startMs;
    const ground = this.ctx.heightField.surfaceAt(x, z);
    this.fireballs.spawn({
      x,
      y: ground,
      z,
      radius,
      lifeMs: 450 + radius * 100,
      startMs: t0,
      rise: radius * 0.3,
      lift: 0.35,
      intensity: 0.6,
    });
    this.glowFlash({
      x,
      y: ground + radius * 0.5,
      z,
      startMs: t0,
      size0: radius * 1.6,
      size1: radius * 2.4,
      lifeMs: 260,
      color0: [3.2, 2.3, 1.3],
      color1: [2.0, 0.7, 0.2],
    });
    this.decals.spawn({
      x,
      z,
      y: NaN,
      mode: DecalMode.Disc,
      radius: radius * 2,
      width: 0,
      lifeMs: 350,
      startMs: t0,
      color: [2.0, 1.4, 0.8],
      alpha: 0.85,
    });
    this.lights.flash(
      {
        x,
        y: ground + radius,
        z,
        peak: 12 * radius * radius,
        range: radius * 7,
        lifeMs: 400,
        startMs: t0,
      },
      now,
    );
    this.sparks({
      n: this.count(Math.round(radius * 3)),
      x,
      y: ground + 0.5,
      z,
      startMs: t0,
      speed: radius * 3.5,
      size: 0.6,
      lifeMs: 900,
    });
    this.smokePuffs({
      n: this.count(smoke),
      x,
      y: ground + 0.5,
      z,
      startMs: t0,
      spread: radius * 0.5,
      rise: radius,
      size0: radius * 0.7,
      size1: radius * 2,
      lifeMs: 3300,
      color0: [1.3, 0.7, 0.35],
      color1: [0.17, 0.16, 0.15],
      alpha: 0.75,
    });
  }

  /** Sunk warship: water spray, a ripple ring, a small fire and smoke. */
  private spawnSinking(e: PendingFx, now: number): void {
    const { x, z } = e;
    const t0 = e.startMs;
    const ground = this.ctx.heightField.surfaceAt(x, z);
    const spray = this.count(14);
    for (let i = 0; i < spray; i++) {
      const s = this.resetSpec();
      const ang = this.rnd(0, Math.PI * 2);
      const out = this.rnd(1, 4);
      s.lifeMs = this.rnd(900, 1300);
      s.x = x;
      s.y = ground + 0.2;
      s.z = z;
      s.vx = Math.cos(ang) * out;
      s.vz = Math.sin(ang) * out;
      s.vy = this.rnd(6, 13);
      s.drag = 0.2;
      s.grav = 16;
      s.size0 = 1;
      s.size1 = 2.4;
      s.color0 = [1.15, 1.2, 1.25];
      s.color1 = [0.85, 0.9, 0.95];
      s.alpha = 0.85;
      this.smoke.spawn(s, t0);
    }
    this.decals.spawn({
      x,
      z,
      y: NaN,
      mode: DecalMode.Ring,
      radius: 9,
      width: 0.3,
      lifeMs: 1300,
      startMs: t0,
      color: [0.9, 1, 1.1],
      alpha: 0.7,
    });
    this.fireballs.spawn({
      x,
      y: ground,
      z,
      radius: 2,
      lifeMs: 500,
      startMs: t0,
      rise: 0.5,
      lift: 0.3,
      intensity: 0.5,
    });
    this.lights.flash(
      { x, y: ground + 2, z, peak: 40, range: 14, lifeMs: 350, startMs: t0 },
      now,
    );
    this.smokePuffs({
      n: this.count(6),
      x,
      y: ground + 0.5,
      z,
      startMs: t0,
      spread: 1,
      rise: 1.6,
      size0: 1.5,
      size1: 4.5,
      lifeMs: 3300,
      color0: [0.25, 0.23, 0.22],
      color1: [0.2, 0.2, 0.2],
      alpha: 0.65,
    });
  }

  private spawnShellHit(e: PendingFx): void {
    const { x, z } = e;
    const t0 = e.startMs;
    const y = this.ctx.heightField.surfaceAt(x, z) + 0.4;
    this.glowFlash({
      x,
      y,
      z,
      startMs: t0,
      size0: 2.0,
      size1: 3.0,
      lifeMs: 220,
      color0: [3.2, 2.2, 0.9],
      color1: [1.8, 0.6, 0.15],
    });
    this.sparks({
      n: this.count(3),
      x,
      y,
      z,
      startMs: t0,
      speed: 5,
      size: 0.45,
      lifeMs: 400,
    });
  }

  /** Golden sparkle burst (+ a ground glow when `discRadius` > 0). */
  private spawnSparkles(
    e: PendingFx,
    n: number,
    scale: number,
    discRadius: number,
  ): void {
    const { x, z } = e;
    const t0 = e.startMs;
    const y = this.ctx.heightField.surfaceAt(x, z) + 1;
    const count = this.count(n);
    const size = Math.max(0.6, scale);
    for (let i = 0; i < count; i++) {
      const s = this.resetSpec();
      const ang = (i / count) * Math.PI * 2 + this.rnd(-0.25, 0.25);
      const out = this.rnd(4, 10) * scale;
      s.lifeMs = this.rnd(900, 1400) * (0.6 + 0.4 * scale);
      s.x = x;
      s.y = y;
      s.z = z;
      s.vx = Math.cos(ang) * out;
      s.vz = Math.sin(ang) * out;
      s.vy = this.rnd(3, 8) * scale;
      s.drag = 1.4;
      s.grav = 5 * scale;
      s.size0 = 1.6 * size;
      s.size1 = 0.7 * size;
      s.color0 = GOLD_HOT;
      s.color1 = GOLD_COOL;
      s.twinkle = 1;
      this.glow.spawn(s, t0);
    }
    if (discRadius > 0) {
      this.decals.spawn({
        x,
        z,
        y: NaN,
        mode: DecalMode.Disc,
        radius: discRadius,
        width: 0,
        lifeMs: 700,
        startMs: t0,
        color: [1.8, 1.3, 0.45],
        alpha: 0.75,
      });
    }
  }
}
