/**
 * FxLayer — explosions, shockwaves, flashes and smoke from dead units, plus
 * conquest / bonus sparkles.
 *
 * Triggers (same as the default FxPass, units.md §4):
 * | event                                         | effect                                        |
 * |-----------------------------------------------|-----------------------------------------------|
 * | Atom / Hydrogen / MIRV Warhead, reachedTarget | fireball, shockwave ring, ground flash, light |
 * |                                               | flash, sparks, mushroom column, base surge    |
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
 * Particle colours are linear HDR: values above ~1 feed the bloom pass.
 */

import * as THREE from "three";
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
    color: [3.0, 2.3, 1.5],
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
 * then an ease-out fade (1 − v)^1.4 to zero at the end.
 */
export function particleEnvelope(u: number, fadeIn: number): number {
  if (u <= 0 || u >= 1) return 0;
  if (fadeIn > 0 && u < fadeIn) return u / fadeIn;
  const v = (u - fadeIn) / (1 - fadeIn);
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
const P_STRIDE = 25;

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
      let a = d[o + P_ALPHA] * particleEnvelope(u, d[o + P_FADEIN]);
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
  /** Rise speed of the centre, tiles/s. */
  rise: number;
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
      const y = f.y + r * f.lift + (f.rise * age) / 1000;
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

/** Linear HDR colours shared by the recipes. */
const FIRE_LIT: Rgb = [2.2, 1.0, 0.35];
const SMOKE_GREY: Rgb = [0.13, 0.12, 0.115];
const SPARK_HOT: Rgb = [9, 4.5, 1.2];
const SPARK_COOL: Rgb = [2, 0.35, 0.05];
const FLASH_WHITE: Rgb = [6, 5.5, 4.5];
const FLASH_ORANGE: Rgb = [3, 1.2, 0.3];
const GOLD_HOT: Rgb = [5, 3.6, 1.1];
const GOLD_COOL: Rgb = [2.4, 1.3, 0.25];

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
  private readonly baseDensity: number;

  constructor(private readonly ctx: ThreeLayerContext) {
    const low = ctx.settings.quality === "low";
    this.baseDensity = low ? 0.5 : 1;

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
    nuke?: { outer: number; cosmetic: NukeExplosionRenderParams | undefined },
  ): void {
    if (this.pending.length >= MAX_PENDING) return;
    this.pending.push({
      kind,
      x,
      z,
      outer: nuke?.outer ?? 0,
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
    s.fadeIn = 0.02;
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
   * Nuke detonation, scaled by the gameplay outer radius O (atom 30,
   * hydrogen 100, warhead 18): fireball (peak 0.42·O), shockwave ring,
   * ground flash (1.3·O), light flash, white flash billboard, sparks and the
   * mushroom cloud.
   */
  private spawnNuke(e: PendingFx, now: number, lite: boolean): void {
    const O = Math.max(6, e.outer);
    const { x, z } = e;
    const t0 = e.startMs;
    const ground = this.ctx.heightField.surfaceAt(x, z);
    const ring = shockwaveParams(O, e.cosmetic);

    this.fireballs.spawn({
      x,
      y: ground,
      z,
      radius: 0.42 * O,
      lifeMs: 1200 + 8 * O,
      startMs: t0,
      rise: 0.04 * O,
      lift: 0.35,
      intensity: 1,
    });
    this.decals.spawn({
      x,
      z,
      y: NaN,
      mode: DecalMode.Ring,
      radius: ring.radius,
      width: 0.18,
      lifeMs: ring.durationMs,
      startMs: t0,
      color: ring.color,
      alpha: 1,
    });
    this.decals.spawn({
      x,
      z,
      y: NaN,
      mode: DecalMode.Disc,
      radius: 1.3 * O,
      width: 0,
      lifeMs: 700,
      startMs: t0,
      color: [5, 3.6, 2.2],
      alpha: 1,
    });
    const flashY = ground + 0.3 * O;
    // Peak candela so the irradiance ~O/2 away is a few times the sun's.
    this.lights.flash(
      {
        x,
        y: flashY,
        z,
        peak: 1.5 * O * O,
        range: 2.5 * O,
        lifeMs: 900,
        startMs: t0,
      },
      now,
    );
    this.glowFlash({
      x,
      y: flashY,
      z,
      startMs: t0,
      size0: 2.2 * O,
      size1: 3 * O,
      lifeMs: 450,
      color0: FLASH_WHITE,
      color1: FLASH_ORANGE,
    });
    this.sparks({
      n: this.count(clamp(Math.round(0.5 * O), 8, 32)),
      x,
      y: ground + 0.1 * O,
      z,
      startMs: t0,
      speed: O,
      size: Math.max(0.6, 0.05 * O),
      lifeMs: 1500,
    });
    this.mushroom(x, ground, z, O, t0, lite);
  }

  /**
   * Mushroom cloud: a stem of puffs rising to ≤ 0.9·O, a cap of puffs that
   * rise with it and spread outwards (with drag k a puff's final offset is
   * v / k), and a ground-level base surge riding out with the shockwave.
   * Puffs start fire-lit (HDR orange, blooms) and cool to grey.
   */
  private mushroom(
    x: number,
    ground: number,
    z: number,
    O: number,
    t0: number,
    lite: boolean,
  ): void {
    const H = 0.9 * O;
    const k = 0.8;

    const stem = this.count(clamp(Math.round(0.45 * O), 6, 24));
    for (let i = 0; i < stem; i++) {
      const s = this.resetSpec();
      s.delayMs = (i / stem) * 500;
      s.lifeMs = this.rnd(5200, 6400);
      s.x = x + this.rnd(-0.06, 0.06) * O;
      s.y = ground;
      s.z = z + this.rnd(-0.06, 0.06) * O;
      s.vy = H * k * this.rnd(0.15, 1); // settles at 0.15..1 × H
      s.drag = k;
      s.size0 = 0.12 * O;
      s.size1 = 0.28 * O;
      s.color0 = FIRE_LIT;
      s.color1 = SMOKE_GREY;
      s.colorTime = 0.25;
      s.alpha = 0.85;
      s.spin = this.rnd(-0.2, 0.2);
      this.smoke.spawn(s, t0);
    }

    const cap = this.count(clamp(Math.round(0.55 * O), 8, 28));
    const kc = 0.75;
    for (let i = 0; i < cap; i++) {
      const s = this.resetSpec();
      const ang = (i / cap) * Math.PI * 2 + this.rnd(-0.3, 0.3);
      const out = this.rnd(0.25, 0.5) * O * kc; // settles 0.25..0.5·O out
      s.delayMs = this.rnd(150, 450);
      s.lifeMs = this.rnd(5400, 6500);
      s.x = x + Math.cos(ang) * 0.1 * O;
      s.y = ground + 0.15 * O;
      s.z = z + Math.sin(ang) * 0.1 * O;
      s.vx = Math.cos(ang) * out;
      s.vz = Math.sin(ang) * out;
      s.vy = H * kc * this.rnd(0.95, 1.1);
      s.drag = kc;
      s.size0 = 0.2 * O;
      s.size1 = 0.45 * O;
      s.color0 = FIRE_LIT;
      s.color1 = SMOKE_GREY;
      s.colorTime = 0.35;
      s.alpha = 0.85;
      s.spin = this.rnd(-0.2, 0.2);
      this.smoke.spawn(s, t0);
    }

    if (lite) return;
    const surge = this.count(clamp(Math.round(0.45 * O), 8, 22));
    const kd = 1.2;
    for (let i = 0; i < surge; i++) {
      const s = this.resetSpec();
      const ang = (i / surge) * Math.PI * 2 + this.rnd(-0.2, 0.2);
      const out = 1.1 * O * kd * this.rnd(0.8, 1.05); // settles ~1.1·O out
      s.delayMs = this.rnd(0, 120);
      s.lifeMs = this.rnd(3200, 4200);
      s.x = x + Math.cos(ang) * 0.2 * O;
      s.y = ground + 0.03 * O;
      s.z = z + Math.sin(ang) * 0.2 * O;
      s.vx = Math.cos(ang) * out;
      s.vz = Math.sin(ang) * out;
      s.vy = 0.05 * O * kd;
      s.drag = kd;
      s.size0 = 0.15 * O;
      s.size1 = 0.35 * O;
      s.color0 = [1.2, 0.8, 0.5];
      s.color1 = [0.28, 0.25, 0.22];
      s.colorTime = 0.3;
      s.alpha = 0.55;
      s.fadeIn = 0.08;
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
      size0: 10,
      size1: 16,
      lifeMs: 380,
      color0: [6, 5, 4],
      color1: [3, 1, 0.3],
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
      intensity: 1,
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
      color: [2.2, 1.8, 1.3],
      alpha: 0.9,
    });
    this.lights.flash(
      { x, y, z, peak: 300, range: 40, lifeMs: 500, startMs: t0 },
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
      intensity: 1,
    });
    this.glowFlash({
      x,
      y: ground + radius * 0.5,
      z,
      startMs: t0,
      size0: radius * 2,
      size1: radius * 3,
      lifeMs: 280,
      color0: [5, 3.5, 2],
      color1: [2.5, 0.8, 0.2],
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
      color: [3, 2, 1.2],
      alpha: 0.9,
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
      s.color0 = [1.4, 1.5, 1.6];
      s.color1 = [0.9, 0.95, 1];
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
      intensity: 0.8,
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
      size0: 2.2,
      size1: 3.2,
      lifeMs: 220,
      color0: [6, 4, 1.6],
      color1: [2.5, 0.8, 0.2],
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
        color: [2.2, 1.6, 0.5],
        alpha: 0.8,
      });
    }
  }
}
