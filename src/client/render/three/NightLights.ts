/**
 * NightLights — the night and its lights (lot 4 prototype, only built with
 * `?three_night=1`, see `nightModeOf`).
 *
 * The idea of the default renderer's `NightCompositePass` (scene ×
 * (ambient + blurred lightmap), lights from `PointLightPass` /
 * `FalloutLightPass`), redone for a lit 3D scene:
 * - **Moonlight**: `SceneEnvironment.setNightDepth` swaps the sun for a
 *   dim, cool moon and darkens the sky fill, sky and fog. The terrain, water
 *   and every lit model follow (shared uniforms, three's lights). The
 *   terrain shader (`#ifdef NIGHT`) also desaturates the ground towards
 *   blue-grey and keeps part of the territory fill and borders at their day
 *   brightness (`nightLook`), so who owns what still reads at a glance.
 * - **City lights**: a low-resolution lightmap of the map (`NightLightmap`,
 *   1 texel per `lightmapScale` tiles, RGBA8 with a square-root encoding),
 *   one smooth light per structure (`structureLight`: cities by level,
 *   ports, factories, dim military sites), splatted with a soft kernel (the
 *   blur), rebuilt only where a structure changed, a few 16 × 16-texel
 *   cells per frame (`TileUploadQueue`), each sent as one rectangle
 *   (`TextureRectUploader`). The terrain and water shaders read it with one
 *   bilinear fetch; at full map it reads like a night satellite photo.
 *   StructureLayer adds lit windows on the models (`windowShare`).
 * - **Flashes**: `NIGHT_FLASH_SLOTS` short-lived point lights (FxLayer's
 *   nuke, intercept and explosion impacts) lighting the terrain and the
 *   water for ~1-2 s (`nightFlashEnvelope`, `flashFalloff`), as uniforms.
 *
 * Everything here is created only when the night is on; off, no object,
 * texture, uniform or define exists and the shaders compile without it.
 */

import * as THREE from "three";
import {
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  type UnitState,
} from "../types";
import {
  HEMI_INTENSITY,
  HEMI_SKY,
  SceneEnvironment,
  SUN_COLOR,
  SUN_DIRECTION,
  SUN_INTENSITY,
} from "./SceneEnvironment";
import { LIGHTMAP_MAX, NIGHT_FLASH_SLOTS } from "./shaders/night";
import { TextureRectUploader } from "./TerrainResources";
import type { ThreeRenderSettings } from "./ThreeSettings";
import { type TileUploadBudget, TileUploadQueue } from "./TileUploadQueue";
import type { FrameInfo, ThreeLayerContext } from "./types";

export { LIGHTMAP_MAX, NIGHT_FLASH_SLOTS, NIGHT_GLSL } from "./shaders/night";

// ---------------------------------------------------------------------------
// Switch and depth
// ---------------------------------------------------------------------------

/**
 * Ambient of the default renderer's "Night" graphics preset
 * (graphics-presets.json; the graphics modal's ambient level 8).
 */
export const NIGHT_PRESET_AMBIENT = 0.36;
/** Deepest night: the ambient slider's minimum (0.2). */
export const NIGHT_DEPTH_MAX = 1.25;

/**
 * Why the night is on: the URL flag (`three_night=1`), the only switch while
 * it is a prototype. The default renderer's night graphics preset
 * (`lighting.enabled`, ambient < 1) does not turn it on: a player with a
 * darkened preset keeps the plain day programs (zero cost) until the night
 * is validated on real GPUs; with the flag on, a darker ambient setting
 * still deepens it (`nightDepth`).
 */
export type NightMode = "url";

/**
 * Whether this game draws the night, decided once when the renderer is
 * built (every layer asks at construction: shader defines cannot change
 * without recompiling): only with `?three_night=1`.
 */
export function nightModeOf(
  settings: Partial<Pick<ThreeRenderSettings, "prototypes">>,
): NightMode | null {
  return settings.prototypes?.night === true ? "url" : null;
}

/**
 * Night depth from the default renderer's ambient setting: at least 1 (the
 * Night preset's look, ambient 0.36) with the URL flag; a darker ambient
 * deepens it, up to `NIGHT_DEPTH_MAX` (the slider's 0.2).
 */
export function nightDepth(_mode: NightMode, ambient: number): number {
  const a = Number.isFinite(ambient) ? ambient : 1;
  const d = Math.max(
    0,
    Math.min(NIGHT_DEPTH_MAX, (1 - a) / (1 - NIGHT_PRESET_AMBIENT)),
  );
  return Math.max(1, d);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Night look of the terrain shader at a depth and zoom (`uNightLook*`). */
export interface NightLook {
  /** Share of the day brightness the territory fill keeps (emitted). */
  fillKeep: number;
  /** Same for the borders. */
  borderKeep: number;
  /** Ground desaturation towards its luminance (moonlight). */
  desaturate: number;
  /** Gain on the city lightmap. */
  cityLight: number;
  /** Fallout embers / hotspots / rim emission × this. */
  emberGain: number;
  /** Lit windows' emission (StructureLayer). */
  windows: number;
  /**
   * Self-light of the unit models (UnitLayer: deck lights), stronger zoomed
   * out where a ship is a few pixels and must still read on the dark sea.
   */
  units: number;
  /** Weight of the lights' wide glow (zoomed out, around the icons). */
  wideGlow: number;
}

/**
 * Zoomed out the territory keeps more of its day colour (a strategic view
 * must read at a glance: 30% of the fill, 45% of the borders at full map),
 * close up less (16% / 35%), so the night and the warm light pools read;
 * the city lights are a little stronger zoomed out, where they are small.
 * The unit models' self-light is 0.35 of their albedo zoomed out (a ship of
 * a few pixels still reads on the night sea), 0.13 close up. Everything
 * scales with the depth (dusk).
 */
export function nightLook(
  depth: number,
  cssPxPerTile: number,
  out: NightLook = {
    fillKeep: 0,
    borderKeep: 0,
    desaturate: 0,
    cityLight: 0,
    emberGain: 0,
    windows: 0,
    units: 0,
    wideGlow: 0,
  },
): NightLook {
  const k = Math.max(0, Math.min(1, depth));
  const near = smoothstep(1.2, 5, cssPxPerTile);
  out.fillKeep = (0.3 - 0.14 * near) * k;
  out.borderKeep = (0.45 - 0.1 * near) * k;
  out.desaturate = 0.65 * k;
  out.cityLight = (1 - 0.15 * near) * k;
  out.emberGain = 1 + 0.5 * k;
  out.windows = 1.6 * k;
  out.units = ((0.35 - 0.22 * smoothstep(3, 8, cssPxPerTile)) / 0.08) * k;
  out.wideGlow = (1 - smoothstep(1.5, 5, cssPxPerTile)) * k;
  return out;
}

// ---------------------------------------------------------------------------
// Structure lights
// ---------------------------------------------------------------------------

/**
 * One light of the lightmap: radius in tiles, intensity, linear colour; and
 * its wide glow (the lightmap's alpha, luminance only, shown zoomed out
 * where the structure icons cover the cores): radius and intensity.
 */
export interface StructureLight {
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
  wideRadius: number;
  wideIntensity: number;
}

/** Wide glow: radius × this (capped), intensity × this. */
export const NIGHT_WIDE_RADIUS = 2.5;
export const NIGHT_WIDE_MAX_RADIUS = 90;
export const NIGHT_WIDE_INTENSITY = 0.18;

const log2l = (level: number) =>
  Math.log2(Math.max(1, Math.min(64, Math.floor(level) || 1)));

/** Structure types that cast a light (`structureLight` is not null). */
export const NIGHT_LIT_TYPES: ReadonlySet<string> = new Set([
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
]);

/** Largest light radius, tiles (a level-22 city reaches ~40). */
export const NIGHT_LIGHT_MAX_RADIUS = 40;

/**
 * The light a structure casts on the ground at night, or null. The default
 * renderer lights every structure alike (radius 18 tiles, intensity 1.2,
 * the owner's colour, `PointLightPass`); here cities are the main source and
 * grow with their level (radius 10 → 36 tiles, intensity 1.1 → 2.9, log2
 * of the level), ports and factories light their surroundings a little
 * (factories orange), military sites are small cool points (silos red).
 * Warm light colours (sodium / incandescent): the owner reads from the
 * territory fill, the lights from their colour. Under construction: a
 * quarter.
 */
export function structureLight(
  type: string,
  level: number,
  underConstruction = false,
): StructureLight | null {
  const l2 = log2l(level);
  let radius: number;
  let intensity: number;
  let c: readonly [number, number, number];
  switch (type) {
    case UT_CITY:
      radius = 10 + 6 * l2;
      intensity = 1.1 + 0.4 * l2;
      c = [1, 0.8, 0.52];
      break;
    case UT_PORT:
      radius = 8 + 2 * l2;
      intensity = 0.8 + 0.15 * l2;
      c = [1, 0.86, 0.66];
      break;
    case UT_FACTORY:
      radius = 8 + 2 * l2;
      intensity = 0.85 + 0.15 * l2;
      c = [1, 0.62, 0.32];
      break;
    case UT_DEFENSE_POST:
    case UT_SAM_LAUNCHER:
      radius = 4.5;
      intensity = 0.4;
      c = [0.78, 0.86, 1];
      break;
    case UT_MISSILE_SILO:
      radius = 4.5;
      intensity = 0.45;
      c = [1, 0.45, 0.3];
      break;
    default:
      return null;
  }
  if (underConstruction) intensity *= 0.25;
  const r = Math.min(NIGHT_LIGHT_MAX_RADIUS, radius);
  return {
    radius: r,
    intensity,
    r: c[0],
    g: c[1],
    b: c[2],
    wideRadius: Math.min(NIGHT_WIDE_MAX_RADIUS, r * NIGHT_WIDE_RADIUS),
    wideIntensity: intensity * NIGHT_WIDE_INTENSITY,
  };
}

/**
 * Share of the windows lit at night on a structure's model: cities 30% at
 * level 1, more with the level (61% at the largest model, level 6), ports
 * 35%, factories 55% (night shift), the others' small buildings 20%.
 */
export function windowShare(type: string, level: number): number {
  switch (type) {
    case UT_CITY:
      return Math.min(0.8, 0.3 + 0.12 * log2l(level));
    case UT_PORT:
      return 0.35;
    case UT_FACTORY:
      return 0.55;
    default:
      return 0.2;
  }
}

/** Wide-glow kernel at `d` tiles from a light of wide radius `R`. */
export function wideKernel(d: number, R: number): number {
  if (!(R > 0) || d >= R) return 0;
  const h = 1 - (d * d) / (R * R);
  return h * h;
}

/**
 * Light kernel (relative to the light's intensity) at `d` tiles from a light
 * of radius `R`: a bright core (Gaussian, σ = 0.16 R: the lit city) and a
 * faint halo out to R (its glow), 1 at the centre, 0 from R on. Splatting
 * it is the lightmap's blur.
 */
export function lightKernel(d: number, R: number): number {
  if (!(R > 0) || d >= R) return 0;
  return kernelOfX2((d * d) / (R * R));
}

/** `lightKernel` as a function of x² = (d / R)², x² in [0, 1). */
function kernelOfX2(x2: number): number {
  const h = 1 - x2;
  return 0.88 * Math.exp(-x2 / (2 * 0.16 * 0.16)) + 0.12 * h * h * h;
}

/** `kernelOfX2` sampled on x² (the splat's lookup, no sqrt / exp per texel). */
const KERNEL_LUT_SIZE = 1024;
const KERNEL_LUT = (() => {
  const t = new Float32Array(KERNEL_LUT_SIZE + 1);
  for (let i = 0; i <= KERNEL_LUT_SIZE; i++) {
    t[i] = i === KERNEL_LUT_SIZE ? 0 : kernelOfX2(i / KERNEL_LUT_SIZE);
  }
  return t;
})();

/** Soft cap of summed light: linear below ~0.5, never above LIGHTMAP_MAX. */
export function lightmapCap(v: number): number {
  return v > 0 ? LIGHTMAP_MAX * (1 - Math.exp(-v / LIGHTMAP_MAX)) : 0;
}

/** Light value → 8-bit texel (square root: fine steps in the dark). */
export function lightmapEncode(v: number): number {
  const c = lightmapCap(v) / LIGHTMAP_MAX;
  return Math.round(255 * Math.sqrt(Math.max(0, Math.min(1, c))));
}

/** 8-bit texel → light value (what the shader computes). */
export function lightmapDecode(byte: number): number {
  const e = byte / 255;
  return e * e * LIGHTMAP_MAX;
}

/**
 * Tiles per lightmap texel: 4 on World (2000 × 1000 → 502 × 252 texels,
 * 0.5 MB), 2 on small maps; at most ~128k texels.
 */
export function lightmapScale(W: number, H: number): number {
  return Math.max(2, Math.ceil(Math.sqrt((W * H) / 131072)));
}

/** Most structure lights kept (a late World game has ~400-500). */
export const NIGHT_MAX_LIGHTS = 8192;
/** Lightmap rectangles rebuilt and uploaded per frame at most. */
export const LIGHTMAP_BUDGET: TileUploadBudget = {
  maxCalls: 4,
  maxTexels: 1 << 13,
};
/** JS ms per frame past which no further rectangle is rebuilt. */
export const LIGHTMAP_BUDGET_MS = 1;
/** Lightmap dirty-cell size, texels. */
const LIGHTMAP_CELL = 16;

interface LightEntry extends StructureLight {
  x: number;
  y: number;
  /** Key of what the light depends on (type, level, construction). */
  key: string;
  stamp: number;
}

/**
 * The city lightmap's data (no three, no GL). Texel (i, j) covers tiles
 * [(i − 1)·S, i·S) × [(j − 1)·S, j·S): a one-texel margin all round stays
 * black, so the texture's clamp-to-edge reads no light off the map. The
 * shader samples it at uv = (p / S + 1) / (lmW, lmH). RGB: the lights
 * (`lightKernel`); A: their wide glow (`wideKernel`).
 */
export class NightLightmap {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** RGBA8 texels (rgb: the lights, a: their wide glow), the texture's data. */
  readonly data: Uint8Array;
  /** Dirty texel cells waiting for a rebuild + upload. */
  readonly queue: TileUploadQueue;
  private readonly lights = new Map<number, LightEntry>();
  private stamp = 0;
  private readonly done: { x: number; y: number; w: number; h: number }[] = [];
  /** Scratch light sums of one rectangle (rgb + wide glow). */
  private acc = new Float32Array(LIGHTMAP_CELL * LIGHTMAP_CELL * 4 * 16);
  /** Rectangles rebuilt, texels rebuilt (totals). */
  rectsBuilt = 0;
  texelsBuilt = 0;
  /** Light splats done (totals): a light counts once per rectangle. */
  splats = 0;

  constructor(
    readonly mapWidth: number,
    readonly mapHeight: number,
  ) {
    this.scale = lightmapScale(mapWidth, mapHeight);
    this.width = Math.ceil(mapWidth / this.scale) + 2;
    this.height = Math.ceil(mapHeight / this.scale) + 2;
    this.data = new Uint8Array(this.width * this.height * 4);
    // Small merges: a rectangle's rebuild costs its texels × the lights
    // over it, so rectangles stay a few cells.
    this.queue = new TileUploadQueue(
      this.width,
      this.height,
      LIGHTMAP_CELL,
      LIGHTMAP_CELL * LIGHTMAP_CELL * 2,
    );
  }

  /** Structure lights in the map (capped at NIGHT_MAX_LIGHTS). */
  get lightCount(): number {
    return this.lights.size;
  }

  /**
   * Diff the structures (the facade's full unit map, on ticks where a
   * structure changed) against the lights: a light added, removed, moved
   * or changed (level, construction) marks the texel cells under its old
   * and new disc dirty. O(units).
   */
  setStructures(units: ReadonlyMap<number, UnitState>): void {
    const stamp = ++this.stamp;
    const W = this.mapWidth;
    for (const u of units.values()) {
      if (!u.isActive || !NIGHT_LIT_TYPES.has(u.unitType)) continue;
      const level = u.level ?? 1;
      const uc = u.underConstruction === true;
      const key = `${u.unitType}|${level}|${uc ? 1 : 0}|${u.pos}`;
      const old = this.lights.get(u.id);
      if (old !== undefined && old.key === key) {
        old.stamp = stamp;
        continue;
      }
      const light = structureLight(u.unitType, level, uc);
      if (light === null) continue;
      if (old !== undefined) this.markLight(old);
      else if (this.lights.size >= NIGHT_MAX_LIGHTS) continue;
      const x = (u.pos % W) + 0.5;
      const y = Math.floor(u.pos / W) + 0.5;
      const e: LightEntry = { ...light, x, y, key, stamp };
      this.lights.set(u.id, e);
      this.markLight(e);
    }
    for (const [id, e] of this.lights) {
      if (e.stamp !== stamp) {
        this.lights.delete(id);
        this.markLight(e);
      }
    }
  }

  /**
   * Rebuild up to `budget` dirty rectangles (in scan order, see
   * TileUploadQueue) into `data`, stopping once `maxMs` of JS is spent (the
   * first one always goes; the rest are marked dirty again); returns the
   * rebuilt ones for upload (an array reused by the next call).
   */
  rebuild(
    budget: TileUploadBudget | null,
    maxMs = Infinity,
  ): readonly { x: number; y: number; w: number; h: number }[] {
    const t0 = maxMs < Infinity ? performance.now() : 0;
    const rects = this.queue.take(budget);
    const done = this.done;
    done.length = 0;
    for (const r of rects) {
      if (
        done.length > 0 &&
        maxMs < Infinity &&
        performance.now() - t0 > maxMs
      ) {
        this.queue.markRect(r.x, r.y, r.w, r.h);
        continue;
      }
      this.rebuildRect(r.x, r.y, r.w, r.h);
      done.push(r);
    }
    return done;
  }

  /** Light (rgb) and wide glow the data holds at texel (i, j), decoded. */
  texel(i: number, j: number): [number, number, number, number] {
    const o = (j * this.width + i) * 4;
    const d = this.data;
    return [
      lightmapDecode(d[o]),
      lightmapDecode(d[o + 1]),
      lightmapDecode(d[o + 2]),
      lightmapDecode(d[o + 3]),
    ];
  }

  private markLight(e: LightEntry): void {
    const S = this.scale;
    // Texels whose centre ((i − 0.5)·S) lies within the reach, ±1.
    const R = Math.max(e.radius, e.wideRadius);
    const i0 = Math.floor((e.x - R) / S);
    const i1 = Math.ceil((e.x + R) / S) + 2;
    const j0 = Math.floor((e.y - R) / S);
    const j1 = Math.ceil((e.y + R) / S) + 2;
    this.queue.markRect(i0, j0, i1 - i0, j1 - j0);
  }

  private rebuildRect(x0: number, y0: number, w: number, h: number): void {
    const S = this.scale;
    const n = w * h * 4;
    if (this.acc.length < n) this.acc = new Float32Array(n);
    const acc = this.acc;
    acc.fill(0, 0, n);
    // The margin texels stay black.
    const ix0 = Math.max(1, x0);
    const ix1 = Math.min(this.width - 1, x0 + w);
    const iy0 = Math.max(1, y0);
    const iy1 = Math.min(this.height - 1, y0 + h);
    for (const e of this.lights.values()) {
      const R = e.radius;
      const RW = e.wideRadius;
      const reach = Math.max(R, RW);
      // Texel range of the disc, clipped to the rectangle.
      const a0 = Math.max(ix0, Math.ceil((e.x - reach) / S + 0.5));
      const a1 = Math.min(ix1 - 1, Math.floor((e.x + reach) / S + 0.5));
      if (a0 > a1) continue;
      const b0 = Math.max(iy0, Math.ceil((e.y - reach) / S + 0.5));
      const b1 = Math.min(iy1 - 1, Math.floor((e.y + reach) / S + 0.5));
      if (b0 > b1) continue;
      this.splats++;
      // In squared distances (no sqrt), the core kernel from a table.
      const invR2 = 1 / (R * R);
      const invW2 = RW > 0 ? 1 / (RW * RW) : 0;
      const lut = KERNEL_LUT;
      const kI = e.intensity;
      const wI = e.wideIntensity;
      for (let j = b0; j <= b1; j++) {
        const dy = (j - 0.5) * S - e.y;
        const dy2 = dy * dy;
        let o = ((j - y0) * w + (a0 - x0)) * 4;
        for (let i = a0; i <= a1; i++, o += 4) {
          const dx = (i - 0.5) * S - e.x;
          const d2 = dx * dx + dy2;
          const u = 1 - d2 * invW2;
          if (u > 0) acc[o + 3] += u * u * wI;
          const x2 = d2 * invR2;
          if (x2 >= 1) continue;
          const k = lut[(x2 * KERNEL_LUT_SIZE) | 0] * kI;
          acc[o] += k * e.r;
          acc[o + 1] += k * e.g;
          acc[o + 2] += k * e.b;
        }
      }
    }
    const d = this.data;
    for (let j = y0; j < y0 + h; j++) {
      for (let i = x0; i < x0 + w; i++) {
        const o = ((j - y0) * w + (i - x0)) * 4;
        const t = (j * this.width + i) * 4;
        d[t] = lightmapEncode(acc[o]);
        d[t + 1] = lightmapEncode(acc[o + 1]);
        d[t + 2] = lightmapEncode(acc[o + 2]);
        d[t + 3] = lightmapEncode(acc[o + 3]);
      }
    }
    this.rectsBuilt++;
    this.texelsBuilt += w * h;
  }
}

// ---------------------------------------------------------------------------
// Flashes
// ---------------------------------------------------------------------------

/** A flash request (FxLayer, at an impact). Tiles, frame ms. */
export interface NightFlashInput {
  x: number;
  /** Height of the light above the ground point, tiles. */
  y: number;
  z: number;
  /** Reach, tiles (no light from there on). */
  radius: number;
  /** Peak irradiance on the ground right under it (sun ≈ 2.4). */
  peak: number;
  lifeMs: number;
  startMs: number;
}

/**
 * Brightness of a flash at `ageMs` (relative to its peak): a 30 ms rise,
 * the white-hot flash decaying fast (τ = 120 ms) and the fireball's
 * afterglow fading over its life: ~0.55 at 0.1 s, ~0.23 at 0.3 s, ~0.1 at
 * 0.6 s and a faint glow left at 1 s for an atom bomb (life 1.5 s).
 */
export function nightFlashEnvelope(ageMs: number, lifeMs: number): number {
  if (!(ageMs >= 0) || !(lifeMs > 0) || ageMs >= lifeMs) return 0;
  return Math.min(1, ageMs / 30) * flashDecay(ageMs, lifeMs);
}

/** The envelope without its rise (what is left of a flash: slot choice). */
function flashDecay(ageMs: number, lifeMs: number): number {
  if (!(ageMs >= 0) || !(lifeMs > 0) || ageMs >= lifeMs) return 0;
  const u = 1 - ageMs / lifeMs;
  return 0.7 * Math.exp(-ageMs / 120) + 0.3 * u * u;
}

/** Colour of a flash at `ageMs`: white-hot, then the fireball's orange. */
export function nightFlashColor(
  ageMs: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const t = smoothstep(40, 450, ageMs);
  out[0] = 1;
  out[1] = 0.96 + (0.52 - 0.96) * t;
  out[2] = 0.9 + (0.2 - 0.9) * t;
  return out;
}

/**
 * Falloff of a flash at x = horizontal distance / radius (TS twin of the
 * shader's `flashFalloff`): inverse-square-like around the centre, a smooth
 * window down to 0 at the radius.
 */
export function flashFalloff(x: number): number {
  if (!(x < 1)) return 0;
  const w = 1 - x * x;
  return (w * w) / (1 + 5 * x * x);
}

interface FlashSlot extends NightFlashInput {
  active: boolean;
}

/** The flash slots (no three): FxLayer adds, the uniforms read them. */
export class NightFlashes {
  readonly slots: FlashSlot[] = [];
  /** Flashes started, flashes dropped (all slots brighter), totals. */
  started = 0;
  dropped = 0;

  constructor(count = NIGHT_FLASH_SLOTS) {
    for (let i = 0; i < count; i++) {
      this.slots.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        radius: 1,
        peak: 0,
        lifeMs: 0,
        startMs: 0,
      });
    }
  }

  /** Brightness of a slot at `nowMs` (its peak × the envelope). */
  brightness(s: FlashSlot, nowMs: number): number {
    if (!s.active) return 0;
    return s.peak * nightFlashEnvelope(nowMs - s.startMs, s.lifeMs);
  }

  /**
   * Take a free slot, else the dimmest one (what is left of it, its rise
   * aside: a flash starting this frame counts at its peak) if it is dimmer
   * than this flash (as FxLayer's own point lights: a nuke is never stolen
   * by a burning building).
   */
  flash(f: NightFlashInput, nowMs: number): boolean {
    let best: FlashSlot | null = null;
    let bestB = Infinity;
    for (const s of this.slots) {
      const b = s.active ? s.peak * flashDecay(nowMs - s.startMs, s.lifeMs) : 0;
      if (b < bestB) {
        best = s;
        bestB = b;
      }
    }
    if (best === null || bestB >= f.peak) {
      this.dropped++;
      return false;
    }
    Object.assign(best, f);
    best.active = true;
    this.started++;
    return true;
  }

  /** Slots still lit at `nowMs` (frees the others). */
  activeCount(nowMs: number): number {
    let n = 0;
    for (const s of this.slots) {
      if (s.active && nowMs - s.startMs >= s.lifeMs) s.active = false;
      if (s.active) n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

/** Day `diffuseLight(UP)` (linear): what "day brightness" means above. */
export function dayFlatLight(): [number, number, number] {
  const sun = new THREE.Color(SUN_COLOR).multiplyScalar(SUN_INTENSITY);
  const sky = new THREE.Color(HEMI_SKY).multiplyScalar(HEMI_INTENSITY);
  const cos = Math.max(0, SUN_DIRECTION.y);
  return [
    (sun.r * cos + sky.r) / Math.PI,
    (sun.g * cos + sky.g) / Math.PI,
    (sun.b * cos + sky.b) / Math.PI,
  ];
}

// ---------------------------------------------------------------------------
// Three side: the shared night state of a scene
// ---------------------------------------------------------------------------

/** Uniforms of the terrain / water materials (shared by reference). */
export interface NightUniforms {
  uNightMap: { value: THREE.Texture };
  uNightMapXf: { value: THREE.Vector4 };
  uNightLook: { value: THREE.Vector4 };
  uNightLook2: { value: THREE.Vector4 };
  uFlash: { value: THREE.Vector4[] };
  uFlashCol: { value: THREE.Vector4[] };
  uFlashN: { value: number };
  uNightDayFlat: { value: THREE.Vector3 };
}

const sharedNight = new WeakMap<THREE.Scene, NightLighting>();
/** Frames over which `nightLightmapMsMax` keeps its maximum. */
const PERF_WINDOW = 120;

/**
 * The night of one scene (refcounted: TerrainLayer, WaterLayer,
 * StructureLayer, UnitLayer and FxLayer acquire it when the night is on;
 * TerrainLayer drives `update`). Owns the lightmap texture, the flash slots
 * and the uniforms the terrain and water shaders share, and sets the
 * environment's depth.
 */
export class NightLighting {
  readonly mode: NightMode;
  readonly lightmap: NightLightmap;
  readonly flashes = new NightFlashes();
  readonly uniforms: NightUniforms;
  /**
   * Night emission of the part materials (`NIGHT_WINDOWS`): StructureLayer's
   * lit windows and self-light, UnitLayer's self-light.
   */
  readonly windowUniform = { value: 0 };
  /** Night self-light of the unit models (UnitLayer's part material). */
  readonly unitUniform = { value: 0 };
  /** Fallout embers' / FX smoke's night factors (FxLayer). */
  readonly smokeUniform = { value: 1 };
  readonly texture: THREE.DataTexture;
  private readonly uploader: TextureRectUploader;
  private refs = 0;
  private depth = -1;
  private readonly flashColor: [number, number, number] = [0, 0, 0];
  private readonly look: NightLook = nightLook(0, 1);
  /** Perf counters: last frame and totals. */
  private rectsLastFrame = 0;
  private texelsLastFrame = 0;
  private msLastFrame = 0;
  private readonly recentMs: Float32Array;
  private recentIndex = 0;
  private structureMs = 0;

  /** The scene's night, created on first use (only call when it is on). */
  static acquire(ctx: ThreeLayerContext, mode: NightMode): NightLighting {
    let n = sharedNight.get(ctx.scene);
    if (n === undefined) {
      n = new NightLighting(ctx, mode);
      sharedNight.set(ctx.scene, n);
    }
    n.refs++;
    return n;
  }

  private constructor(
    private readonly ctx: ThreeLayerContext,
    mode: NightMode,
  ) {
    this.mode = mode;
    this.lightmap = new NightLightmap(ctx.mapWidth, ctx.mapHeight);
    const lm = this.lightmap;
    this.texture = new THREE.DataTexture(
      lm.data,
      lm.width,
      lm.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
    this.uploader = new TextureRectUploader(this.texture);
    this.recentMs = new Float32Array(PERF_WINDOW);
    const v4 = () => new THREE.Vector4();
    this.uniforms = {
      uNightMap: { value: this.texture },
      uNightMapXf: {
        value: new THREE.Vector4(1 / lm.scale, 0, 1 / lm.width, 1 / lm.height),
      },
      uNightLook: { value: v4() },
      uNightLook2: { value: new THREE.Vector4(1, 0, 0, 0) },
      uFlash: {
        value: Array.from(
          { length: NIGHT_FLASH_SLOTS },
          () => new THREE.Vector4(0, 0, 0, 1),
        ),
      },
      uFlashCol: {
        value: Array.from({ length: NIGHT_FLASH_SLOTS }, v4),
      },
      uFlashN: { value: 0 },
      uNightDayFlat: { value: new THREE.Vector3(...dayFlatLight()) },
    };
  }

  /** The structures (facade's `updateStructures`): lights diffed. */
  setStructures(units: ReadonlyMap<number, UnitState>): void {
    const t0 = performance.now();
    this.lightmap.setStructures(units);
    this.structureMs += performance.now() - t0;
  }

  /** A flash at an impact (FxLayer), live from this frame on. */
  flash(f: NightFlashInput, nowMs: number): void {
    if (this.flashes.flash(f, nowMs)) this.writeFlashes(nowMs);
  }

  /**
   * Once per frame (TerrainLayer, before the draw): the depth (live from
   * the ambient setting), the look by zoom, the flashes, and the lightmap's
   * dirty cells within `LIGHTMAP_BUDGET` (rebuilt, then one rectangle upload
   * each).
   */
  update(frame: FrameInfo): void {
    const depth = nightDepth(
      this.mode,
      this.ctx.renderSettings.lighting?.ambient ?? 1,
    );
    if (depth !== this.depth) {
      this.depth = depth;
      SceneEnvironment.forScene(this.ctx.scene)?.setNightDepth(depth);
    }
    const look = nightLook(depth, frame.cssPxPerTile, this.look);
    const u = this.uniforms;
    u.uNightLook.value.set(
      look.fillKeep,
      look.borderKeep,
      look.desaturate,
      look.cityLight,
    );
    u.uNightLook2.value.set(
      look.emberGain,
      look.wideGlow,
      Math.min(1, depth),
      0,
    );
    this.windowUniform.value = look.windows;
    this.unitUniform.value = look.units;
    this.smokeUniform.value = 1 - 0.45 * Math.min(1, depth);
    this.writeFlashes(frame.nowMs);

    const t0 = performance.now();
    let rects = 0;
    let texels = 0;
    if (!this.lightmap.queue.empty) {
      const lm = this.lightmap;
      for (const r of lm.rebuild(LIGHTMAP_BUDGET, LIGHTMAP_BUDGET_MS)) {
        this.uploader.upload(this.ctx.renderer, r.x, r.y, r.w, r.h);
        rects++;
        texels += r.w * r.h;
      }
    }
    this.rectsLastFrame = rects;
    this.texelsLastFrame = texels;
    this.msLastFrame = performance.now() - t0 + this.structureMs;
    this.structureMs = 0;
    this.recentMs[this.recentIndex] = this.msLastFrame;
    this.recentIndex = (this.recentIndex + 1) % PERF_WINDOW;
  }

  /** Night depth in use (0 = day look, 1 = the Night preset's). */
  get currentDepth(): number {
    return Math.max(0, this.depth);
  }

  /**
   * Counters (`terrain` layer, night on only): lightmap rectangles rebuilt
   * (cumulative `nightLightmapBuilds`, last frame), texels uploaded last
   * frame, its JS ms (rebuild + uploads + the structure diff, last frame
   * and max over 120 frames), lights, live flashes, size.
   */
  perfStats(): Record<string, number> {
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const lm = this.lightmap;
    return {
      nightDepth: r3(this.currentDepth),
      nightLights: lm.lightCount,
      nightLightmapBuilds: lm.rectsBuilt,
      nightLightmapRectsLastFrame: this.rectsLastFrame,
      nightLightmapTexelsLastFrame: this.texelsLastFrame,
      nightLightmapPendingCells: lm.queue.pendingCells,
      nightLightmapMs: r3(this.msLastFrame),
      nightLightmapMsMax: r3(Math.max(...this.recentMs)),
      nightLightmapMB: r3(lm.data.byteLength / (1 << 20)),
      nightFlashLights: this.uniforms.uFlashN.value,
      nightFlashesStarted: this.flashes.started,
    };
  }

  /** Flash slots → uniforms (live ones packed first). */
  private writeFlashes(nowMs: number): void {
    const u = this.uniforms;
    this.flashes.activeCount(nowMs);
    let n = 0;
    for (const s of this.flashes.slots) {
      if (!s.active) continue;
      const b = this.flashes.brightness(s, nowMs);
      if (b <= 0) continue;
      nightFlashColor(nowMs - s.startMs, this.flashColor);
      const c = this.flashColor;
      u.uFlash.value[n].set(s.x, s.y, s.z, s.radius);
      u.uFlashCol.value[n].set(c[0] * b, c[1] * b, c[2] * b, 0);
      n++;
    }
    u.uFlashN.value = n;
  }

  release(): void {
    if (--this.refs > 0) return;
    this.texture.dispose();
    if (sharedNight.get(this.ctx.scene) === this) {
      sharedNight.delete(this.ctx.scene);
    }
  }
}
