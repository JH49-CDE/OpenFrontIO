/**
 * StructureLayer — structures (City, Port, Factory, Defense Post, SAM
 * Launcher, Missile Silo) as the default renderer's icons when zoomed out
 * and as instanced 3D models standing on the relief when zoomed in, with
 * the default renderer's status information.
 *
 * Icons ↔ models (`StructureIcons.ts`): below the fade band
 * (`iconFadeBand`: 2.5-5 CSS px per tile, 3.5-7 with `quality: "low"`)
 * only the icons are drawn (one instanced draw, no model, no shadow);
 * inside it the icons shrink towards the model's footprint and fade out
 * over its second half (`iconAlphaAt`) while the models grow out of the
 * ground (`modelFadeScale`, no transparent model material); above it only
 * the models are drawn. The
 * weight is a smoothstep of the zoom, so nothing pops; the models switch
 * on at the band start and off again only 10% below it
 * (`structureModelsAt`), each switch costing one `rebuild`.
 *
 * Models: one `InstancedBatch` per model variant (cities, SAM launchers and
 * silos change shape with level — see `structureVariant`). Instance data
 * (position, owner colour, state) is rebuilt only in `updateStructures`,
 * which the facade calls on ticks where a structure changed. Per frame the
 * layer only rewrites matrices when something visual moves: the fade
 * weight, the zoom-dependent minimum size, the build-menu highlight,
 * structures under construction (grey, small, slowly growing / pulsing)
 * and structures marked for deletion (red, blinking). Every model stands on
 * a soft contact shadow.
 *
 * Bases (lot 3): every model stands on a pad (`structurePad`, by type and
 * level) that is
 * - on land: `fitPadOnLand` shifts the model up to PAD_MAX_SHIFT tiles off
 *   its tile towards the land around it, or shrinks it (down to 42%), until
 *   the pad covers land tiles only (a port's pier still reaches out over
 *   the water, its quay is the pad);
 * - on the relief: `groundGrid` samples the drawn surface under the pad on
 *   a 3×3 grid reduced to its least-squares plane, tilted at most
 *   PAD_TOP_MAX_SLOPE (`planarGrid`); the `conform` part material lays every
 *   pad vertex on it (`iGround0..2`: a flat slab, no crease) and moves each
 *   building rigidly onto it where it stands, the whole model sunk by the
 *   plane's float over the surface (at PAD_FLOAT_QUANTILE of the pad's
 *   samples) plus PAD_SINK, so on a slope no tall foundation skirt shows.
 *   The contact shadow lies on the pad's least-squares plane
 *   (`fitGroundPlane`).
 * - within a JS budget: past PAD_PLACE_BUDGET_MS per `updateStructures`,
 *   new structures stand provisionally on their tile and are fitted from a
 *   queue, within the same budget per frame (all of them after a terrain
 *   change).
 * Icons stay on their tile at the lot-2 anchor (the highest point under the
 * footprint); level badges and bars glide from there to the model's top.
 *
 * Status (parity with BarPass / StructureLevelPass):
 * - a progress bar (`StatusBars`): deletion countdown, construction
 *   progress or missile readiness (silo / SAM), from `structureProgress`,
 *   refreshed every tick by `updateStatus`;
 * - the level number (level > 1) as a small DOM badge in
 *   `ctx.overlayRoot` (Overpass bold like the names, white on a dark pill
 *   so it reads on any terrain);
 * both shown from the default renderer's glyph zoom (`dotsZoomThreshold`
 * device px per tile) on, above the icon when zoomed out and above the
 * model when zoomed in (the anchor follows the fade weight). The icons draw
 * no number, so a level is never shown twice.
 *
 * Level of detail: below STRUCTURE_LOD_ZOOM CSS px per tile
 * (STRUCTURE_LOD_ZOOM_LOW with `quality: "low"`), where a model is only a
 * few dozen px wide, every structure switches to its low-poly model
 * (`createStructureLodGeometry`, batches `structures-<type>#<variant>@lod`);
 * the switch has 15% hysteresis and costs one `rebuild`. Since no model is
 * drawn below the fade band, low-poly models only appear inside it (and,
 * with `quality: "low"`, up to 12 px per tile). Labels and bars stay
 * anchored on the full model's height.
 *
 * Culling: structures whose bounding sphere (with a margin) leaves the view
 * frustum get no model instance (nor shadow); a change of the visible set
 * costs one `rebuild`, so it only happens while panning close up. Icons are
 * never culled (two triangles each). `perfStats()` reports the instances,
 * triangles and draw calls of models and icons and the structures culled.
 *
 * Contract notes:
 * - `updateStructures` gets the FULL unit map, only on ticks where a
 *   structure changed (new, owner, level, isActive, construction finished).
 * - `updateStatus` gets the full unit map and the tick EVERY tick (the
 *   facade's `updateUnits`): progress bars advance and a change of
 *   `markedForDeletion` (which does not trigger `updateStructures`) is
 *   picked up there.
 * - `setHighlightTypes(null)` clears the build-menu type highlight.
 * - `setRelations` (the facade's `updateRelations`) feeds the alt-view
 *   affiliation colours (ally vs enemy); without it, every other player
 *   reads as an enemy, like the default renderer before relations arrive.
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { renderDpr } from "../gl/utils/Dpr";
import {
  type GhostPreviewData,
  STRUCTURE_TYPES,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  type UnitState,
} from "../types";
import type { HeightField } from "./HeightField";
import { ensureOverpassFont, LABEL_FONT_FAMILY } from "./NameLayer";
import {
  BlobShadows,
  createPartMaterial,
  createStructureGeometry,
  createStructureLodGeometry,
  InstancedBatch,
  levelChangesModel,
  MAX_VISUAL_LEVEL,
  setOwnerColor,
  shadowOffset,
  STRUCTURE_FOOTPRINT,
  structurePad,
  type StructurePad,
  structureVariant,
  triangleCount,
} from "./ProceduralMeshes";
import { barSize, StatusBars } from "./StatusBars";
import {
  ICON_ATLAS_COLS,
  ICON_ATLAS_ORDER,
  iconAlphaAt,
  iconAtlasColumn,
  type IconColors,
  iconFadeBand,
  type IconFrameState,
  iconGlyphsAt,
  modelFadeScaleX,
  modelFadeScaleY,
  modelWeightAt,
  type Rgb,
  StructureIcons,
  structureIconColors,
  structureIconCssPx,
  structureModelsAt,
  unitAffiliationRgb,
} from "./StructureIcons";
import { isLand } from "./TerrainCodec";
import type { FrameInfo, ThreeLayerContext } from "./types";
import { minScreenScale, sphereInFrustum } from "./UnitLayer";

/** Time over which a structure under construction grows to its full ghost size. */
const CONSTRUCTION_GROW_MS = 6000;
/** Relative zoom change that triggers a rewrite of the min-size scale. */
const ZOOM_EPSILON = 0.002;
/** Fade-weight change that triggers a rewrite of the model matrices. */
const FADE_EPSILON = 0.004;
/** Build ghost icon: opacity and tints (StructurePass's ghost draw). */
const GHOST_ICON_ALPHA = 0.5;
const GHOST_TINT_NONE: Rgb = [0, 0, 0];
const GHOST_TINT_UPGRADE: Rgb = [0, 0.8, 0];
const GHOST_TINT_BLOCKED: Rgb = [0.8, 0.2, 0.2];
/** After the icons (15), before the other overlays (20+). */
const GHOST_ICON_RENDER_ORDER = 16;
/** Status anchors sit this fraction of the icon size above its centre. */
const ICON_TOP = 0.45;
/** Contact shadow: diameter / footprint, opacity, lift above the ground. */
const SHADOW_SIZE = 1.18;
const SHADOW_ALPHA = 0.4;
const SHADOW_LIFT = 0.08;

/** Structures use their low-poly models below this zoom (CSS px per tile)... */
export const STRUCTURE_LOD_ZOOM = 5;
/** ...or below this one with `quality: "low"`. */
export const STRUCTURE_LOD_ZOOM_LOW = 12;
/** The full models come back above the threshold × this factor. */
const LOD_HYSTERESIS = 1.15;

/**
 * Whether structures should use their low-poly models at `zoom`, given
 * whether they do now (hysteresis) and the quality setting.
 */
export function structureLodAt(
  zoom: number,
  current: boolean,
  low: boolean,
): boolean {
  const z = low ? STRUCTURE_LOD_ZOOM_LOW : STRUCTURE_LOD_ZOOM;
  return current ? zoom < z * LOD_HYSTERESIS : zoom < z;
}

/** Level label font size (CSS px): 12 px zoomed out, up to 22 px close up. */
export function levelLabelPx(cssPxPerTile: number): number {
  return Math.round(Math.min(22, Math.max(12, 10 + 0.8 * cssPxPerTile)));
}

/**
 * Stretch of models whose shape does not encode the level: (horizontal,
 * vertical) scale for `level`, capped at MAX_VISUAL_LEVEL.
 */
export function structureLevelScale(
  type: string,
  level: number,
): [number, number] {
  if (levelChangesModel(type)) return [1, 1];
  const lv = Math.max(1, Math.min(MAX_VISUAL_LEVEL, Math.floor(level) || 1));
  return [1 + 0.05 * (lv - 1), 1 + 0.14 * (lv - 1)];
}

/**
 * Scale of a structure under construction `ageMs` after it was first seen:
 * starts at 0.5, grows to 0.75 over CONSTRUCTION_GROW_MS, with a gentle
 * breathing pulse (`tSec` = wall clock).
 */
export function constructionScale(ageMs: number, tSec: number): number {
  const grow = Math.min(1, Math.max(0, ageMs / CONSTRUCTION_GROW_MS));
  return 0.5 + 0.25 * grow + 0.03 * Math.sin(tSec * 4);
}

/**
 * Heading (tile-space radians) from (x, y) towards open water: the sum of
 * the directions of the water tiles on a few rings around the point.
 * Returns 0 when there is no water nearby.
 */
export function waterHeading(hf: HeightField, x: number, y: number): number {
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const r of [2, 4, 6, 9]) {
      if (!isLand(hf.terrainByteAt(x + ca * r, y + sa * r))) {
        sx += ca;
        sy += sa;
      }
    }
  }
  return sx * sx + sy * sy > 1e-6 ? Math.atan2(sy, sx) : 0;
}

/** Rules config values the structure progress bars depend on. */
export interface StructureProgressRules {
  deletionMarkDuration: number;
  samCooldown: number;
  siloCooldown: number;
  constructionDuration(type: string): number;
}

/** Reads `StructureProgressRules` from the game config (BarPass defaults). */
export function structureProgressRules(config: Config): StructureProgressRules {
  const num = (f: () => number, fallback: number): number => {
    try {
      const v = f();
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    deletionMarkDuration: num(() => config.deletionMarkDuration(), 300),
    samCooldown: num(() => config.SAMCooldown(), 90),
    siloCooldown: num(() => config.SiloCooldown(), 90),
    constructionDuration: (type) =>
      num(
        () => config.unitInfo(type as UnitType).constructionDuration ?? 50,
        50,
      ),
  };
}

/**
 * Progress bar value of a structure at `tick`, or null for no bar — the
 * same rules as the default renderer's BarPass, in priority order:
 * deletion countdown (remaining / deletionMarkDuration), construction
 * progress, then missile readiness of silos / SAM launchers (ready missiles
 * plus the reload progress of the others, over `level` slots; no bar when
 * fully ready).
 */
export function structureProgress(
  u: UnitState,
  tick: number,
  rules: StructureProgressRules,
): number | null {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  if (u.markedForDeletion !== false) {
    return clamp01(
      (u.markedForDeletion - tick) / Math.max(1, rules.deletionMarkDuration),
    );
  }
  if (u.underConstruction && u.constructionStartTick !== null) {
    const duration = rules.constructionDuration(u.unitType);
    if (!(duration > 0)) return null;
    return clamp01((tick - u.constructionStartTick) / duration);
  }
  if (u.unitType === UT_MISSILE_SILO || u.unitType === UT_SAM_LAUNCHER) {
    const slots = Math.max(1, u.level);
    const reloading = u.missileTimerQueue.length;
    if (reloading === 0) return null;
    const cooldown =
      u.unitType === UT_SAM_LAUNCHER ? rules.samCooldown : rules.siloCooldown;
    let readiness = (slots - reloading) / slots;
    for (const start of u.missileTimerQueue) {
      readiness += (tick - start) / Math.max(1, cooldown) / slots;
    }
    const r = clamp01(readiness);
    return r < 1 ? r : null;
  }
  return null;
}

/** Pad samples lie this far inside its edge (tiles), at most this far apart. */
const PAD_INSET = 0.05;
const PAD_SAMPLE_STEP = 0.8;
/** Scales tried, largest first, to fit a pad on land. */
export const PAD_FIT_SCALES: readonly number[] = [
  1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42,
];
/**
 * Shifts (tiles) tried towards the land around a structure, so a model
 * sits at most PAD_MAX_SHIFT off its tile: it stays on the tile the player
 * clicked (and centred in its SAM / defense range rings); past that the
 * pad shrinks instead.
 */
const PAD_SHIFTS: readonly number[] = [0.5, 1];
export const PAD_MAX_SHIFT = 1;
/** Directions tried around the land direction (radians). */
const PAD_SHIFT_ANGLES: readonly number[] = [0, 0.5, -0.5, 1, -1];
/**
 * JS budget (ms) of the land fits per call: `updateStructures` places new
 * structures fully within it and provisionally (on their tile) past it;
 * the provisional ones, and every structure after a terrain change, are
 * fitted from a queue within the same budget per frame.
 */
export const PAD_PLACE_BUDGET_MS = 1.5;
/** Steepest plane a contact shadow is tilted to (rise per tile). */
export const PAD_MAX_SLOPE = 0.45;
/**
 * A model is lowered until its pad floats over the drawn surface (the 3×3
 * grid's bilinear surface vs the relief) at no more than 1 −
 * PAD_FLOAT_QUANTILE of its samples, by at most this...
 */
export const PAD_MAX_SINK = 0.5;
export const PAD_FLOAT_QUANTILE = 0.85;
/** ...plus this (tiles): the pad's side shows as a thin curb. */
export const PAD_SINK = 0.12;
/**
 * Steepest pad top (rise per tile): the 3×3 ground grid a pad is draped on
 * is reduced to its least-squares plane, tilted at most this much
 * (`planarGrid`), so a pad is a flat slab following the slope (no crease
 * across it); its sides reach into the ground.
 */
export const PAD_TOP_MAX_SLOPE = 0.45;

/**
 * Sample points (model space, tiles) covering a pad: a grid (rect) or rings
 * (round) at most `step` apart, `inset` inside its edge; the centre first.
 */
export function padSamplePoints(
  pad: StructurePad,
  inset = PAD_INSET,
  step = PAD_SAMPLE_STEP,
): Float32Array {
  const key = `${pad.x0},${pad.x1},${pad.z0},${pad.z1},${pad.round},${inset},${step}`;
  let pts = SAMPLE_CACHE.get(key);
  if (pts === undefined) {
    pts = buildPadSamples(pad, inset, step);
    // Pads come in a few dozen shapes (type × level).
    if (SAMPLE_CACHE.size > 256) SAMPLE_CACHE.clear();
    SAMPLE_CACHE.set(key, pts);
  }
  return pts;
}

const SAMPLE_CACHE = new Map<string, Float32Array>();

function buildPadSamples(
  pad: StructurePad,
  inset: number,
  step: number,
): Float32Array {
  const cx = (pad.x0 + pad.x1) / 2;
  const cz = (pad.z0 + pad.z1) / 2;
  const pts: number[] = [cx, cz];
  if (pad.round) {
    const r = Math.max(0, (pad.x1 - pad.x0) / 2 - inset);
    const rings = Math.max(1, Math.ceil(r / step));
    for (let k = 1; k <= rings; k++) {
      const rr = (r * k) / rings;
      const n = Math.max(6, Math.ceil((2 * Math.PI * rr) / step));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        pts.push(cx + rr * Math.cos(a), cz + rr * Math.sin(a));
      }
    }
    return new Float32Array(pts);
  }
  const x0 = Math.min(cx, pad.x0 + inset);
  const x1 = Math.max(cx, pad.x1 - inset);
  const z0 = Math.min(cz, pad.z0 + inset);
  const z1 = Math.max(cz, pad.z1 - inset);
  const nx = Math.max(1, Math.ceil((x1 - x0) / step));
  const nz = Math.max(1, Math.ceil((z1 - z0) / step));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      pts.push(x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz);
    }
  }
  return new Float32Array(pts);
}

/** Where a pad fits: model offset off the tile (tiles), scale, water hits. */
export interface PadFit {
  dx: number;
  dz: number;
  scale: number;
  /** Pad samples still over water (0 = all on land). */
  water: number;
}

/**
 * Fits a structure's pad (model space, turned by `rotY` like the model) on
 * land around tile centre (x, y): the largest of PAD_FIT_SCALES for which
 * the pad covers land tiles only, centred on the tile or shifted (0.5 to
 * PAD_MAX_SHIFT tiles, the tile staying under the pad) towards the land
 * around it. When nothing fits (a 1-tile spit), the
 * candidate with the least pad area over water (samples over water ×
 * scale²).
 */
export function fitPadOnLand(
  isLandAt: (x: number, y: number) => boolean,
  x: number,
  y: number,
  rotY: number,
  pad: StructurePad,
): PadFit {
  const pts = padSamplePoints(pad);
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  const water = (ox: number, oz: number, sc: number, limit: number) => {
    let w = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const px = pts[i];
      const pz = pts[i + 1];
      if (
        !isLandAt(
          x + ox + sc * (px * c + pz * s),
          y + oz + sc * (pz * c - px * s),
        )
      ) {
        if (++w >= limit) return w;
      }
    }
    return w;
  };
  // Direction towards the land around the tile.
  let lx = 0;
  let lz = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const r of [1.5, 3, 4.5, 6]) {
      if (isLandAt(x + ca * r, y + sa * r)) {
        lx += ca;
        lz += sa;
      }
    }
  }
  const len = Math.hypot(lx, lz);
  const half = Math.min(pad.x1 - pad.x0, pad.z1 - pad.z0) / 2;
  let best: PadFit = {
    dx: 0,
    dz: 0,
    scale: PAD_FIT_SCALES[PAD_FIT_SCALES.length - 1],
    water: Infinity,
  };
  let bestArea = Infinity;
  const consider = (dx: number, dz: number, sc: number, w: number) => {
    if (w * sc * sc < bestArea) {
      bestArea = w * sc * sc;
      best = { dx, dz, scale: sc, water: w };
    }
  };
  for (const sc of PAD_FIT_SCALES) {
    // Counting stops once a candidate cannot beat the best one.
    const limit = Math.ceil(bestArea / (sc * sc));
    const w0 = water(0, 0, sc, limit);
    if (w0 === 0) return { dx: 0, dz: 0, scale: sc, water: 0 };
    consider(0, 0, sc, w0);
    if (len < 1e-6) continue;
    const maxShift = Math.min(PAD_MAX_SHIFT, half * sc);
    for (const d of PAD_SHIFTS) {
      if (d > maxShift + 1e-9) break;
      for (const ang of PAD_SHIFT_ANGLES) {
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const ux = (lx * ca - lz * sa) / len;
        const uz = (lx * sa + lz * ca) / len;
        const w = water(ux * d, uz * d, sc, limit);
        if (w === 0) return { dx: ux * d, dz: uz * d, scale: sc, water: 0 };
        consider(ux * d, uz * d, sc, w);
      }
    }
  }
  return best;
}

/** A pad's ground plane: height at its centre, world gradient, sink. */
export interface GroundPlane {
  height: number;
  gx: number;
  gz: number;
  /** How far the plane must drop for the pad to float nowhere (tiles). */
  sink: number;
}

/**
 * Least-squares plane through the surface under a pad centred at world
 * (cx, cz), turned by `rotY`, scaled by `scale`: its height at the centre
 * and gradient (capped at PAD_MAX_SLOPE), and how far it must drop for the
 * pad to lie on or under the surface at every sample (capped at
 * PAD_MAX_SINK).
 */
export function fitGroundPlane(
  surfaceAt: (x: number, z: number) => number,
  cx: number,
  cz: number,
  rotY: number,
  pad: StructurePad,
  scale: number,
): GroundPlane {
  const pts = padSamplePoints(pad, 0);
  const n = pts.length / 2;
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  const dx = new Float64Array(n);
  const dz = new Float64Array(n);
  const h = new Float64Array(n);
  let mx = 0;
  let mz = 0;
  let mh = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[2 * i];
    const pz = pts[2 * i + 1];
    dx[i] = scale * (px * c + pz * s);
    dz[i] = scale * (pz * c - px * s);
    h[i] = surfaceAt(cx + dx[i], cz + dz[i]);
    mx += dx[i];
    mz += dz[i];
    mh += h[i];
  }
  mx /= n;
  mz /= n;
  mh /= n;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let sxh = 0;
  let szh = 0;
  for (let i = 0; i < n; i++) {
    const ex = dx[i] - mx;
    const ez = dz[i] - mz;
    const eh = h[i] - mh;
    sxx += ex * ex;
    sxz += ex * ez;
    szz += ez * ez;
    sxh += ex * eh;
    szh += ez * eh;
  }
  const det = sxx * szz - sxz * sxz;
  let gx = 0;
  let gz = 0;
  if (det > 1e-9) {
    gx = (sxh * szz - szh * sxz) / det;
    gz = (szh * sxx - sxh * sxz) / det;
  }
  const g = Math.hypot(gx, gz);
  if (g > PAD_MAX_SLOPE) {
    gx *= PAD_MAX_SLOPE / g;
    gz *= PAD_MAX_SLOPE / g;
  }
  const a = mh - gx * mx - gz * mz;
  let lowest = 0;
  for (let i = 0; i < n; i++) {
    lowest = Math.min(lowest, h[i] - (a + gx * dx[i] + gz * dz[i]));
  }
  return { height: a, gx, gz, sink: Math.min(PAD_MAX_SINK, -lowest) };
}

/**
 * Bilinear interpolation of a 3×3 grid (row-major, rows by v) at (u, v) in
 * [0, 1]², on each of its 2×2 cells (TS twin of the conform shader's
 * `conformGround`).
 */
export function groundGridAt(g: ArrayLike<number>, u: number, v: number) {
  const tu = Math.min(1, Math.max(0, u)) * 2;
  const tv = Math.min(1, Math.max(0, v)) * 2;
  const row = (r: number) =>
    tu < 1
      ? g[3 * r] + (g[3 * r + 1] - g[3 * r]) * tu
      : g[3 * r + 1] + (g[3 * r + 2] - g[3 * r + 1]) * (tu - 1);
  return tv < 1
    ? row(0) + (row(1) - row(0)) * tv
    : row(1) + (row(2) - row(1)) * (tv - 1);
}

/**
 * The ground under a pad placed at world (cx, cz), turned by `rotY`,
 * scaled by `scale`: its height at the pad's centre, and in `out` the
 * heights relative to it on a 3×3 grid (u, v ∈ {0, ½, 1} of the pad's
 * model-space rectangle, rows by v) — what the conform material drapes
 * the pad on. Each node is the mean of the drawn surface at the node and
 * a quarter of a cell around it; the grid is then reduced to its
 * least-squares plane, tilted at most PAD_TOP_MAX_SLOPE (`planarGrid`), so
 * the pad is a flat slab (no crease) and buildings stand level on it. Also
 * how far the plane floats above the drawn
 * surface at the pad's samples, at the PAD_FLOAT_QUANTILE (capped at
 * PAD_MAX_SINK): the layer sinks the pad by that much, so it floats
 * nowhere on smooth ground and only over the deepest dips of rough
 * ground, rather than vanishing under the bumps.
 */
export function groundGrid(
  surfaceAt: (x: number, z: number) => number,
  cx: number,
  cz: number,
  rotY: number,
  pad: StructurePad,
  scale: number,
  out: Float32Array = new Float32Array(9),
): { centre: number; float: number } {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  const w = pad.x1 - pad.x0;
  const d = pad.z1 - pad.z0;
  const at = (lx: number, lz: number) =>
    surfaceAt(cx + scale * (lx * c + lz * s), cz + scale * (lz * c - lx * s));
  const ox = w / 8;
  const oz = d / 8;
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const x = pad.x0 + (w * i) / 2;
      const z = pad.z0 + (d * j) / 2;
      out[3 * j + i] =
        (at(x, z) +
          at(x - ox, z) +
          at(x + ox, z) +
          at(x, z - oz) +
          at(x, z + oz)) /
        5;
    }
  }
  const centre = out[4] + planarGrid(out, w * scale, d * scale);
  const pts = padSamplePoints(pad, 0);
  const n = pts.length / 2;
  if (FLOAT_SCRATCH.length < n) FLOAT_SCRATCH = new Float64Array(2 * n);
  const above = FLOAT_SCRATCH.subarray(0, n);
  for (let i = 0; i < n; i++) {
    const px = pts[2 * i];
    const pz = pts[2 * i + 1];
    const u = (px - pad.x0) / w;
    const v = (pz - pad.z0) / d;
    above[i] = centre + groundGridAt(out, u, v) - at(px, pz);
  }
  above.sort();
  const q = above[Math.floor(PAD_FLOAT_QUANTILE * (n - 1))];
  return { centre, float: Math.min(PAD_MAX_SINK, Math.max(0, q)) };
}

let FLOAT_SCRATCH = new Float64Array(256);

/**
 * Replaces a 3×3 ground grid (row-major, rows by v; u, v ∈ {0, ½, 1} of a
 * pad `worldW` × `worldD` tiles) by its least-squares plane, its slope
 * capped at PAD_TOP_MAX_SLOPE, relative to the plane's height at the
 * centre (so out[4] = 0); returns that height relative to the old out[4].
 * On a regular 3×3 grid the fit is closed-form: the mean, and per axis
 * (Σ last column − Σ first column) / 3 per unit of u (rows for v).
 */
export function planarGrid(
  out: Float32Array,
  worldW: number,
  worldD: number,
): number {
  let mean = 0;
  for (let k = 0; k < 9; k++) mean += out[k];
  mean /= 9;
  let su = (out[2] + out[5] + out[8] - out[0] - out[3] - out[6]) / 3;
  let sv = (out[6] + out[7] + out[8] - out[0] - out[1] - out[2]) / 3;
  const g = Math.hypot(
    su / Math.max(worldW, 1e-6),
    sv / Math.max(worldD, 1e-6),
  );
  if (g > PAD_TOP_MAX_SLOPE) {
    su *= PAD_TOP_MAX_SLOPE / g;
    sv *= PAD_TOP_MAX_SLOPE / g;
  }
  const rel = mean - out[4];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      out[3 * j + i] = su * (i / 2 - 0.5) + sv * (j / 2 - 0.5);
    }
  }
  return rel;
}

/**
 * The pad of a structure at a level: `structurePad` of its model variant,
 * stretched like the model (`structureLevelScale`) for the types whose
 * model does not change with the level.
 */
export function levelPad(
  type: string,
  variant: number,
  level: number,
): StructurePad {
  const pad = structurePad(type, variant);
  const [lx] = structureLevelScale(type, level);
  if (lx === 1) return pad;
  return {
    x0: pad.x0 * lx,
    x1: pad.x1 * lx,
    z0: pad.z0 * lx,
    z1: pad.z1 * lx,
    round: pad.round,
  };
}

interface StructureInst {
  id: number;
  type: string;
  owner: number;
  level: number;
  variant: number;
  underConstruction: boolean;
  marked: boolean;
  /** Progress bar value (null = no bar), refreshed every tick. */
  progress: number | null;
  /** Tile centre. */
  x: number;
  y: number;
  /** Icon anchor: the highest point under the footprint (lot 2). */
  iconY: number;
  /** Model centre (world x / z): the tile centre, or shifted onto land. */
  cx: number;
  cz: number;
  /** Model scale that keeps the pad on land (1 = full size). */
  fit: number;
  /** World Y of the model origin: the pad's ground plane, sunk. */
  ground: number;
  /** The plane's height at the centre before sinking (contact shadow). */
  base: number;
  /** The plane's world gradient (dY/dX, dY/dZ): contact shadow. */
  gx: number;
  gz: number;
  /** Ground under the pad, 3×3, relative to the centre (conform). */
  grid: Float32Array;
  /** Pad extent and centre in model space (tiles, at fit 1). */
  padW: number;
  padD: number;
  padCx: number;
  padCz: number;
  /** Rotation about +Y (radians). */
  rotY: number;
  /** performance.now() when first seen under construction. */
  ucSinceMs: number;
  stamp: number;
  batch: InstancedBatch | null;
  index: number;
  /** Model height (tiles) at scale 1, for anchoring labels and bars. */
  top: number;
  label: LevelLabel | null;
  /** Waiting in the placement queue (fitted on land later). */
  queued: boolean;
  /** Inside the view frustum (last visibility pass); culled when false. */
  inView: boolean;
  /** Atlas column of the icon (-1: none) and its index in `icons`. */
  iconCol: number;
  icon: number;
}

/** A pooled DOM level label and what was last written to it. */
interface LevelLabel {
  el: HTMLDivElement;
  text: string;
  fontPx: number;
  x: number;
  y: number;
  shown: boolean;
}

/** Deterministic 32-bit hash of a unit id. */
function hash(id: number): number {
  return Math.imul(id ^ 0x27d4eb2f, 0x165667b1) >>> 0;
}

export class StructureLayer {
  private readonly group = new THREE.Group();
  private readonly glow = { value: 1 };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly templates = new Map<string, THREE.BufferGeometry>();
  private readonly tops = new Map<string, number>();
  private readonly batches = new Map<string, InstancedBatch>();
  /** Triangles of one instance, per batch key. */
  private readonly batchTris = new Map<string, number>();
  /**
   * Batch keys (`type#variant`, `type#variant@lod`), built once: `rebuild`
   * runs whenever the visible set changes (panning close up), so it should
   * not build two strings per structure each time.
   */
  private readonly keys = new Map<string, string[]>();
  private readonly lodKeys = new Map<string, string>();
  /** Low-poly models in use (see the file comment). */
  private lod = false;
  /** 3D models drawn at all (zoom at or above the fade band, hysteresis). */
  private models = false;
  /** Model weight of this frame (0 = icons only, 1 = models only). */
  private weight = 0;
  /** Icon crossfade opacity of this frame (`iconAlphaAt(weight)`). */
  private iconAlpha = 1;
  /** Model weight the current matrices were written for. */
  private matrixWeight = 0;
  private culled = 0;
  /** Pad placement cost (JS ms, max over the layer's life) and outcomes. */
  private placeMsMax = 0;
  /** Structures still to fit on land (see PAD_PLACE_BUDGET_MS). */
  private placeQueue: StructureInst[] = [];
  private placeHead = 0;
  /** A queued placement changed a model: rebuild next frame. */
  private placementDirty = false;
  private padsShifted = 0;
  private padsShrunk = 0;
  private readonly icons: StructureIcons;
  /**
   * The build ghost as an icon (StructurePass's ghost: alpha 0.5, tinted),
   * crossfading with the icons; OverlayLayer draws the 3D ghost model.
   */
  private readonly ghostIcons: StructureIcons;
  private ghost: GhostPreviewData | null = null;
  private ghostShown = false;
  private readonly ghostState: IconFrameState;
  /** Icon quad side per atlas column this frame (CSS px). */
  private readonly iconPx = new Float32Array(ICON_ATLAS_COLS);
  /** Device pixel ratio the default renderer would use (icon sizes). */
  private dpr = 1;
  /** Colour inputs: alt view, local player, relations (alt-view allies). */
  private altView = false;
  private localPlayer = 0;
  private relations: Uint8Array | null = null;
  private relSize = 0;
  private relVersion = 0;
  /** Alt view / local player / relations the colours were written for. */
  private colorAlt = false;
  private colorLocal = 0;
  private colorRel = 0;
  private readonly iconColors: IconColors = {
    fill: [0, 0, 0],
    border: [0, 0, 0],
  };
  private readonly affRgb: Rgb = [0, 0, 0];
  private readonly iconState: IconFrameState = {
    alpha: 1,
    sizesPx: this.iconPx,
    glyphs: true,
  };
  /** `statusAnchor` results (scratch). */
  private anchorX = 0;
  private anchorZ = 0;
  private anchorY = 0;
  private anchorLift = 0;
  private anchorPx = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly insts = new Map<number, StructureInst>();
  /** Instances that animate every frame (under construction / marked). */
  private animated: StructureInst[] = [];
  private readonly shadows: BlobShadows;
  private readonly bars: StatusBars;
  private readonly rules: StructureProgressRules;
  /** Instances with a progress bar this tick. */
  private barred: StructureInst[] = [];
  private readonly labelRoot: HTMLDivElement;
  private readonly labelPool: LevelLabel[] = [];

  private highlight: ReadonlySet<string> | null = null;
  private highlightDirty = false;
  private stamp = 0;
  private paletteVersion = -1;
  private heightVersion = -1;
  /** Zoom the current matrices were written for. */
  private matrixZoom = 1;
  private lastZoom = 1;
  private lastNowMs = 0;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly v = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly ctx: ThreeLayerContext) {
    this.group.name = "structures";
    ctx.scene.add(this.group);
    this.material = createPartMaterial({
      glow: this.glow,
      roughness: 0.75,
      metalness: 0.04,
      conform: true,
    });
    this.shadows = new BlobShadows(this.group, "structure-shadows");
    this.icons = new StructureIcons(this.group, ctx.renderSettings);
    this.ghostIcons = new StructureIcons(
      this.group,
      ctx.renderSettings,
      "structure-ghost-icon",
      GHOST_ICON_RENDER_ORDER,
      false,
      this.icons,
    );
    this.ghostState = { alpha: 0, sizesPx: this.iconPx, glyphs: true };
    this.bars = new StatusBars(
      this.group,
      ctx.renderSettings.bar,
      "structure-status-bars",
    );
    this.rules = structureProgressRules(ctx.config);
    ensureOverpassFont();
    this.labelRoot = document.createElement("div");
    this.labelRoot.className = "three-structure-levels";
    const st = this.labelRoot.style;
    st.position = "absolute";
    st.inset = "0";
    st.pointerEvents = "none";
    st.overflow = "hidden";
    ctx.overlayRoot.appendChild(this.labelRoot);
  }

  updateStructures(units: ReadonlyMap<number, UnitState>): void {
    const stamp = ++this.stamp;
    const deadline = performance.now() + PAD_PLACE_BUDGET_MS;
    const W = this.ctx.mapWidth;
    const now = performance.now();
    const hf = this.ctx.heightField;
    for (const u of units.values()) {
      if (!u.isActive || !STRUCTURE_TYPES.has(u.unitType)) continue;
      let inst = this.insts.get(u.id);
      if (inst === undefined || inst.type !== u.unitType) {
        const x = (u.pos % W) + 0.5;
        const y = Math.floor(u.pos / W) + 0.5;
        inst = {
          id: u.id,
          type: u.unitType,
          owner: u.ownerID,
          level: u.level,
          variant: structureVariant(u.unitType, u.level),
          underConstruction: false,
          marked: false,
          progress: null,
          x,
          y,
          iconY: 0,
          cx: x,
          cz: y,
          fit: 1,
          ground: 0,
          base: 0,
          gx: 0,
          gz: 0,
          grid: new Float32Array(9),
          padW: 0,
          padD: 0,
          padCx: 0,
          padCz: 0,
          rotY: 0,
          ucSinceMs: now,
          stamp,
          batch: null,
          index: -1,
          top: 1,
          label: null,
          queued: false,
          inView: true,
          iconCol: iconAtlasColumn(u.unitType),
          icon: -1,
        };
        this.placeWithin(inst, hf, deadline);
        this.insts.set(u.id, inst);
      }
      if (u.underConstruction && !inst.underConstruction) inst.ucSinceMs = now;
      inst.underConstruction = u.underConstruction;
      inst.marked = u.markedForDeletion !== false;
      inst.owner = u.ownerID;
      if (inst.level !== u.level) {
        // A new level changes the pad (size, model): fit it again.
        inst.level = u.level;
        inst.variant = structureVariant(u.unitType, u.level);
        this.placeWithin(inst, hf, deadline);
      }
      inst.stamp = stamp;
    }
    for (const [id, inst] of this.insts) {
      if (inst.stamp !== stamp) {
        this.releaseLabel(inst);
        if (inst.cx !== inst.x || inst.cz !== inst.y) this.padsShifted--;
        if (inst.fit < 1) this.padsShrunk--;
        this.insts.delete(id);
      }
    }
    this.barred = this.barred.filter((i) => this.insts.get(i.id) === i);
    this.rebuild(now);
    this.rebuildIcons();
  }

  /**
   * Per-tick status: progress bar values, and the deletion mark (which
   * changes without an `updateStructures`).
   */
  updateStatus(units: ReadonlyMap<number, UnitState>, gameTick: number): void {
    const barred: StructureInst[] = [];
    let markChanged = false;
    for (const inst of this.insts.values()) {
      const u = units.get(inst.id);
      if (u === undefined || !u.isActive) {
        inst.progress = null;
        continue;
      }
      const marked = u.markedForDeletion !== false;
      if (marked !== inst.marked) {
        inst.marked = marked;
        markChanged = true;
      }
      inst.progress = structureProgress(u, gameTick, this.rules);
      if (inst.progress !== null) barred.push(inst);
    }
    this.barred = barred;
    if (markChanged) {
      this.rebuild(performance.now());
      this.rebuildIcons();
    }
  }

  setHighlightTypes(types: string[] | null): void {
    this.highlight = types !== null && types.length > 0 ? new Set(types) : null;
    this.highlightDirty = true;
    let mask = 0;
    for (const t of types ?? []) {
      const col = iconAtlasColumn(t);
      if (col >= 0) mask |= 1 << col;
    }
    this.icons.setHighlightMask(mask);
  }

  /**
   * The build ghost (the facade's `updateGhostPreview`; null = none): drawn
   * as an icon while the icons show, like StructurePass's ghost, plus a
   * green copy on the structure being upgraded. Read every frame (the
   * controller updates the object in place).
   */
  setGhostPreview(d: GhostPreviewData | null): void {
    this.ghost = d !== null && iconAtlasColumn(d.ghostType) >= 0 ? d : null;
  }

  /**
   * Relation matrix (`size`×`size`, row = player, 1 = friendly), for the
   * alt-view ally / enemy colours. The facade's `updateRelations` hands the
   * same data to the terrain.
   */
  setRelations(data: Uint8Array, size: number): void {
    if (!(size > 0) || data.length < size * size) return;
    this.relations = data;
    this.relSize = size;
    this.relVersion++;
  }

  update(frame: FrameInfo): void {
    const now = frame.nowMs;
    this.lastNowMs = now;
    this.lastZoom = frame.cssPxPerTile;
    this.dpr = renderDpr();
    this.altView =
      frame.altView && this.ctx.renderSettings.altView.recolorStructures;
    this.localPlayer = frame.localPlayerID;
    this.drainPlaceQueue();
    this.updateModels(frame);
    this.updateIcons(frame);
    this.updateGhostIcon(frame);
    this.updateStatusViews(frame);
  }

  /** Counters for the facade's perf tool (picked up by duck typing). */
  perfStats(): Record<string, number> {
    let instances = 0;
    let tris = 0;
    let modelDraws = 0;
    for (const [key, b] of this.batches) {
      instances += b.count;
      tris += b.count * (this.batchTris.get(key) ?? 0);
      if (b.count > 0) modelDraws++;
    }
    const icons = this.icons.drawn ? this.icons.count : 0;
    return {
      structureInstances: instances,
      structureTriangles: tris,
      structureLod: this.lod ? 1 : 0,
      structureCulled: this.culled,
      modelInstancesDrawn: instances,
      modelDrawCalls: modelDraws,
      iconInstances: icons,
      iconDrawCalls: icons > 0 ? 1 : 0,
      iconTriangles: icons * 2,
      // Structures drawn both ways (models fading in under their icons).
      fadeBandInstances: icons > 0 ? instances : 0,
      modelWeight: Math.round(this.weight * 1000) / 1000,
      // Crossfade opacity of the icons (before `structure.iconAlpha`).
      iconAlpha: Math.round(this.iconAlpha * 1000) / 1000,
      // Build ghost icons drawn (0, 1, or 2 with an upgrade target).
      ghostIcons: this.ghostIcons.drawn ? this.ghostIcons.count : 0,
      // Pads (lot 3): models moved off their tile / shrunk to stay on land,
      // and the slowest placement (fit on land + ground plane), JS ms.
      padsShifted: this.padsShifted,
      padsShrunk: this.padsShrunk,
      padPlaceMsMax: Math.round(this.placeMsMax * 1000) / 1000,
      padPlacePending: this.placeQueue.length - this.placeHead,
    };
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    for (const g of this.templates.values()) g.dispose();
    this.templates.clear();
    this.shadows.dispose();
    this.icons.dispose();
    this.ghostIcons.dispose();
    this.bars.dispose();
    this.material.dispose();
    this.insts.clear();
    this.animated = [];
    this.barred = [];
    this.labelRoot.remove();
    this.labelPool.length = 0;
    this.ctx.scene.remove(this.group);
  }

  // ---- Internals ----

  /**
   * Per-frame model updates (terrain / models on-off / LOD / culling /
   * colours / zoom / fade / animation).
   */
  private updateModels(frame: FrameInfo): void {
    const now = frame.nowMs;
    const hf = this.ctx.heightField;
    const zoom = frame.cssPxPerTile;
    const low = this.ctx.settings.quality === "low";
    const band = iconFadeBand(low);
    const models = structureModelsAt(zoom, this.models, band);
    this.weight = models ? modelWeightAt(zoom, band) : 0;

    if (hf.version !== this.heightVersion) {
      // Terrain changed (water nuke): re-seat every icon now, and queue
      // every model for a new fit on land and relief (a few per frame).
      this.heightVersion = hf.version;
      for (const inst of this.insts.values()) {
        this.placeIcon(inst, hf);
        this.queuePlace(inst);
      }
      this.rebuildIcons();
    }
    const lod = structureLodAt(zoom, this.lod, low);
    // No models, nothing to cull: skip the frustum test of every structure.
    const viewChanged = models && this.updateVisibility(frame);
    if (!models) this.culled = 0;
    if (
      models !== this.models ||
      lod !== this.lod ||
      viewChanged ||
      this.placementDirty
    ) {
      this.placementDirty = false;
      const stale = this.colorsStale();
      this.models = models;
      this.lod = lod;
      this.rebuild(now);
      if (stale) this.recolorIcons();
      return;
    }
    if (this.colorsStale()) {
      this.markColorsCurrent();
      for (const inst of this.insts.values()) {
        if (inst.batch !== null) {
          inst.batch.setColor(inst.index, this.colorFor(inst));
        }
      }
      for (const b of this.batches.values()) b.markDirty();
      this.recolorIcons();
    }
    if (!models) {
      this.highlightDirty = false;
      this.matrixZoom = zoom;
      return;
    }

    const zoomChanged =
      Math.abs(zoom - this.matrixZoom) > ZOOM_EPSILON * this.matrixZoom;
    const fadeChanged =
      this.weight !== this.matrixWeight &&
      (Math.abs(this.weight - this.matrixWeight) > FADE_EPSILON ||
        this.weight === 0 ||
        this.weight === 1);
    if (
      this.highlightDirty ||
      fadeChanged ||
      (zoomChanged && this.minScaleChanged(zoom))
    ) {
      this.highlightDirty = false;
      this.matrixZoom = zoom;
      this.matrixWeight = this.weight;
      for (const inst of this.insts.values()) this.writeInstance(inst, now);
      for (const b of this.batches.values()) b.markDirty();
      this.writeShadows();
      return;
    }
    if (zoomChanged) this.matrixZoom = zoom;

    if (this.animated.length > 0) {
      const touched = new Set<InstancedBatch>();
      for (const inst of this.animated) {
        this.writeInstance(inst, now);
        if (inst.batch !== null) touched.add(inst.batch);
      }
      for (const b of touched) b.markDirty();
    }
  }

  /**
   * Frustum test of every structure (bounding sphere at this frame's
   * min-size scale, plus a 2-tile margin). True when any `inView` changed.
   */
  private updateVisibility(frame: FrameInfo): boolean {
    const cam = frame.camera;
    this.projScreen.multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const minPx = this.ctx.settings.structureMinScreenPx;
    let changed = false;
    let culled = 0;
    for (const inst of this.insts.values()) {
      const fp = STRUCTURE_FOOTPRINT[inst.type] ?? 6;
      const k = minScreenScale(minPx, frame.cssPxPerTile, fp) * 1.2 * inst.fit;
      const half = 0.5 * inst.top * k;
      const r = Math.hypot(0.75 * fp * k, half) + 2;
      const inView = sphereInFrustum(
        planes,
        inst.cx,
        inst.ground + half,
        inst.cz,
        r,
      );
      if (!inView) culled++;
      if (inView !== inst.inView) {
        inst.inView = inView;
        changed = true;
      }
    }
    this.culled = culled;
    return changed;
  }

  /**
   * Icon sizes and crossfade for this frame: the default renderer's size,
   * shrinking towards the model's footprint as the models fade in.
   */
  private updateIcons(frame: FrameInfo): void {
    const zoom = frame.cssPxPerTile;
    const ss = this.ctx.renderSettings.structure;
    const minPx = this.ctx.settings.structureMinScreenPx;
    const w = this.weight;
    for (let c = 0; c < ICON_ATLAS_COLS; c++) {
      const type = ICON_ATLAS_ORDER[c];
      let px = structureIconCssPx(type, zoom, this.dpr, ss);
      if (w > 0) {
        const fp = STRUCTURE_FOOTPRINT[type] ?? 6;
        const modelPx = fp * zoom * minScreenScale(minPx, zoom, fp);
        px += (modelPx - px) * w;
      }
      this.iconPx[c] = px;
    }
    const st = this.iconState;
    st.alpha = iconAlphaAt(w);
    this.iconAlpha = st.alpha;
    st.glyphs = iconGlyphsAt(zoom * this.dpr, ss);
    this.icons.frame(frame, st);
  }

  /**
   * The build ghost icon for this frame: StructurePass's ghost (alpha 0.5,
   * the icon mixed half-way to green when upgrading, red when it cannot be
   * built, untinted otherwise), at the icons' size and crossfade; plus the
   * same icon on the structure being upgraded. Nothing runs without a
   * ghost.
   */
  private updateGhostIcon(frame: FrameInfo): void {
    const d = this.ghost;
    if (d === null && !this.ghostShown) return;
    const g = this.ghostIcons;
    g.begin();
    if (d !== null && this.iconAlpha > 0) {
      const col = iconAtlasColumn(d.ghostType);
      const hf = this.ctx.heightField;
      const c = structureIconColors(
        {
          palette: this.ctx.palette.data,
          owner: d.ownerID,
          localPlayerID: this.localPlayer,
          underConstruction: false,
          affiliation: this.altView ? this.affiliationOf(d.ownerID) : null,
        },
        this.ctx.renderSettings.structure,
        this.iconColors,
      );
      if (d.canUpgrade && d.upgradeTargetTile !== null) {
        const W = this.ctx.mapWidth;
        const ux = (d.upgradeTargetTile % W) + 0.5;
        const uz = Math.floor(d.upgradeTargetTile / W) + 0.5;
        g.push(ux, hf.surfaceAt(ux, uz), uz, col, c.fill, c.border, false);
      }
      const x = d.tileX + 0.5;
      const z = d.tileY + 0.5;
      g.push(x, hf.surfaceAt(x, z), z, col, c.fill, c.border, false);
      g.setGhost(
        d.canUpgrade
          ? GHOST_TINT_UPGRADE
          : d.canBuild
            ? GHOST_TINT_NONE
            : GHOST_TINT_BLOCKED,
        GHOST_ICON_ALPHA,
      );
    }
    g.end();
    const st = this.ghostState;
    st.alpha = this.iconAlpha;
    st.glyphs = this.iconState.glyphs;
    g.frame(frame, st);
    this.ghostShown = g.count > 0;
  }

  /** Rewrites every icon (anchor, type, colours, deletion mark). */
  private rebuildIcons(): void {
    const icons = this.icons;
    icons.begin();
    for (const inst of this.insts.values()) {
      if (inst.iconCol < 0) {
        inst.icon = -1;
        continue;
      }
      const c = this.iconColorsFor(inst);
      inst.icon = icons.push(
        inst.x,
        inst.iconY,
        inst.y,
        inst.iconCol,
        c.fill,
        c.border,
        inst.marked,
      );
    }
    icons.end();
  }

  /** Rewrites the icon colours only (palette / alt view / relations). */
  private recolorIcons(): void {
    for (const inst of this.insts.values()) {
      if (inst.icon < 0) continue;
      const c = this.iconColorsFor(inst);
      this.icons.setColors(inst.icon, c.fill, c.border);
    }
    this.icons.markColorsDirty();
  }

  private iconColorsFor(inst: StructureInst): IconColors {
    return structureIconColors(
      {
        palette: this.ctx.palette.data,
        owner: inst.owner,
        localPlayerID: this.localPlayer,
        underConstruction: inst.underConstruction,
        affiliation: this.altView ? this.affiliationOf(inst.owner) : null,
      },
      this.ctx.renderSettings.structure,
      this.iconColors,
    );
  }

  /** Alt-view colour of `owner` (sRGB, shared scratch array). */
  private affiliationOf(owner: number): Rgb {
    return unitAffiliationRgb(
      owner,
      this.localPlayer,
      this.relations,
      this.relSize,
      this.ctx.renderSettings.affiliation,
      this.affRgb,
    );
  }

  /** Whether model / icon colours were written for older inputs. */
  private colorsStale(): boolean {
    return (
      this.ctx.palette.version !== this.paletteVersion ||
      this.altView !== this.colorAlt ||
      this.localPlayer !== this.colorLocal ||
      this.relVersion !== this.colorRel
    );
  }

  private markColorsCurrent(): void {
    this.paletteVersion = this.ctx.palette.version;
    this.colorAlt = this.altView;
    this.colorLocal = this.localPlayer;
    this.colorRel = this.relVersion;
  }

  /**
   * Status anchor of `inst` this frame into `anchorX` / `anchorY` /
   * `anchorZ` (world), `anchorLift` (CSS px above its projection) and
   * `anchorPx` (on-screen width, CSS px): the top of the icon (on its tile)
   * when zoomed out, the top of the model (which may sit off the tile, on
   * land) when zoomed in, blended by the model weight so labels and bars
   * glide between them.
   */
  private statusAnchor(inst: StructureInst): void {
    const w = this.weight;
    const iconPx = inst.iconCol >= 0 ? this.iconPx[inst.iconCol] : 0;
    let top = inst.iconY;
    let modelPx = 0;
    if (w > 0) {
      const [k, t] = this.anchor(inst);
      top = t;
      modelPx = (STRUCTURE_FOOTPRINT[inst.type] ?? 6) * k * this.lastZoom;
    }
    this.anchorX = inst.x + (inst.cx - inst.x) * w;
    this.anchorZ = inst.y + (inst.cz - inst.y) * w;
    this.anchorY = inst.iconY + (top - inst.iconY) * w;
    this.anchorLift = ICON_TOP * iconPx * (1 - w);
    this.anchorPx = iconPx * 2 * ICON_TOP * (1 - w) + modelPx * w;
  }

  /** Progress bars and level labels for this frame's camera. */
  private updateStatusViews(frame: FrameInfo): void {
    const zoom = frame.cssPxPerTile;
    // Shown with the default renderer's glyphs (above its "dots" zoom).
    const show = iconGlyphsAt(
      zoom * this.dpr,
      this.ctx.renderSettings.structure,
    );
    this.bars.begin(frame, show ? 1 : 0);
    if (show) {
      for (const inst of this.barred) {
        if (inst.progress === null) continue;
        this.statusAnchor(inst);
        const { w, h } = barSize(this.anchorPx, 0.6, 20, 80);
        this.bars.bar(
          this.anchorX,
          this.anchorY,
          this.anchorZ,
          0,
          this.anchorLift + h / 2 + 4,
          w,
          h,
          inst.progress,
        );
      }
    }
    this.bars.end();

    const cam = frame.camera;
    const cw = frame.cssWidth;
    const ch = frame.cssHeight;
    const fontPx = levelLabelPx(zoom);
    for (const inst of this.insts.values()) {
      const label = inst.label;
      if (inst.level <= 1 || !show) {
        if (label !== null) this.setLabelShown(label, false);
        continue;
      }
      this.statusAnchor(inst);
      const ndc = this.v
        .set(this.anchorX, this.anchorY, this.anchorZ)
        .project(cam);
      const visible =
        ndc.z < 1 && Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05;
      if (!visible) {
        if (label !== null) this.setLabelShown(label, false);
        continue;
      }
      const l = label ?? this.acquireLabel(inst);
      const text = String(inst.level);
      if (l.text !== text) {
        l.text = text;
        l.el.textContent = text;
      }
      if (l.fontPx !== fontPx) {
        l.fontPx = fontPx;
        l.el.style.fontSize = `${fontPx}px`;
      }
      // Above the icon or model, above the bar when there is one.
      const lift =
        Math.round(this.anchorLift) +
        (inst.progress !== null ? Math.round(fontPx * 0.5) + 8 : 3);
      const x = Math.round(((ndc.x + 1) / 2) * cw);
      const y = Math.round(((1 - ndc.y) / 2) * ch) - lift;
      if (x !== l.x || y !== l.y) {
        l.x = x;
        l.y = y;
        l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      }
      this.setLabelShown(l, true);
    }
  }

  /**
   * Horizontal scale and world Y of the top of `inst`'s model this frame
   * (fade-in included).
   */
  private anchor(inst: StructureInst): [number, number] {
    const base = minScreenScale(
      this.ctx.settings.structureMinScreenPx,
      this.lastZoom,
      STRUCTURE_FOOTPRINT[inst.type] ?? 6,
    );
    let k = base;
    if (inst.underConstruction) {
      k *= constructionScale(
        this.lastNowMs - inst.ucSinceMs,
        this.lastNowMs / 1000,
      );
    }
    k *= inst.fit;
    const fx = modelFadeScaleX(this.weight);
    const fy = modelFadeScaleY(this.weight);
    const [, ly] = structureLevelScale(inst.type, inst.level);
    return [k * fx, inst.ground + inst.top * k * fy * ly];
  }

  private acquireLabel(inst: StructureInst): LevelLabel {
    let l = this.labelPool.pop();
    if (l === undefined) {
      const el = document.createElement("div");
      const st = el.style;
      st.position = "absolute";
      st.left = "0";
      st.top = "0";
      st.fontFamily = LABEL_FONT_FAMILY;
      st.fontWeight = "700";
      st.lineHeight = "1.1";
      st.color = "#fff";
      st.background = "rgba(14, 16, 22, 0.78)";
      st.borderRadius = "0.4em";
      st.padding = "0.1em 0.35em 0.02em";
      st.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.45)";
      st.whiteSpace = "nowrap";
      st.pointerEvents = "none";
      st.userSelect = "none";
      st.willChange = "transform";
      st.display = "none";
      this.labelRoot.appendChild(el);
      l = { el, text: "", fontPx: 0, x: NaN, y: NaN, shown: false };
    }
    inst.label = l;
    return l;
  }

  private releaseLabel(inst: StructureInst): void {
    if (inst.label === null) return;
    this.setLabelShown(inst.label, false);
    this.labelPool.push(inst.label);
    inst.label = null;
  }

  private setLabelShown(l: LevelLabel, on: boolean): void {
    if (l.shown === on) return;
    l.shown = on;
    l.el.style.display = on ? "block" : "none";
  }

  /**
   * Places `inst` fully while `deadline` (performance.now()) is not past;
   * after it, provisionally on its tile (no fit on land), queued for the
   * fit.
   */
  private placeWithin(
    inst: StructureInst,
    hf: HeightField,
    deadline: number,
  ): void {
    if (performance.now() < deadline) {
      this.place(inst, hf);
      return;
    }
    this.placeProvisional(inst, hf);
    this.queuePlace(inst);
  }

  /**
   * Cheap placement until the queue fits `inst`: its icon anchor, a model
   * on its tile at full size, flat, at the ground there.
   */
  private placeProvisional(inst: StructureInst, hf: HeightField): void {
    this.placeIcon(inst, hf);
    this.orient(inst, hf);
    if (inst.cx !== inst.x || inst.cz !== inst.y) this.padsShifted--;
    if (inst.fit < 1) this.padsShrunk--;
    inst.cx = inst.x;
    inst.cz = inst.y;
    inst.fit = 1;
    inst.grid.fill(0);
    inst.base = hf.surfaceAt(inst.x, inst.y);
    inst.gx = 0;
    inst.gz = 0;
    inst.ground = inst.base - PAD_SINK;
  }

  /** Orientation and pad extent of `inst` (model space). */
  private orient(inst: StructureInst, hf: HeightField): StructurePad {
    // Model +X maps to tile heading h with rotY = −h (three's Y rotation
    // turns +X towards −Z, i.e. north).
    inst.rotY =
      inst.type === UT_PORT
        ? -waterHeading(hf, inst.x, inst.y)
        : ((hash(inst.id) & 3) * Math.PI) / 2;
    const pad = levelPad(inst.type, inst.variant, inst.level);
    inst.padW = pad.x1 - pad.x0;
    inst.padD = pad.z1 - pad.z0;
    inst.padCx = (pad.x0 + pad.x1) / 2;
    inst.padCz = (pad.z0 + pad.z1) / 2;
    return pad;
  }

  private queuePlace(inst: StructureInst): void {
    if (inst.queued) return;
    inst.queued = true;
    this.placeQueue.push(inst);
  }

  /**
   * Fits queued structures on land and relief within PAD_PLACE_BUDGET_MS
   * (at least one); a change makes the next `updateModels` rebuild.
   */
  private drainPlaceQueue(): void {
    const q = this.placeQueue;
    if (this.placeHead >= q.length) return;
    const hf = this.ctx.heightField;
    const deadline = performance.now() + PAD_PLACE_BUDGET_MS;
    do {
      const inst = q[this.placeHead++];
      inst.queued = false;
      if (this.insts.get(inst.id) !== inst) continue;
      this.place(inst, hf);
      this.placementDirty = true;
    } while (this.placeHead < q.length && performance.now() < deadline);
    if (this.placeHead >= q.length) {
      q.length = 0;
      this.placeHead = 0;
    }
  }

  /** Icon anchor: the highest point under the footprint (lot 2). */
  private placeIcon(inst: StructureInst, hf: HeightField): void {
    const r = (STRUCTURE_FOOTPRINT[inst.type] ?? 6) * 0.3;
    let ground = hf.surfaceAt(inst.x, inst.y);
    for (const [dx, dy] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      ground = Math.max(ground, hf.surfaceAt(inst.x + dx, inst.y + dy));
    }
    inst.iconY = ground;
  }

  /**
   * Icon anchor, orientation, and the model's place: its pad fitted on land,
   * then on the relief (see the file comment).
   */
  private place(inst: StructureInst, hf: HeightField): void {
    const t0 = performance.now();
    this.placeIcon(inst, hf);
    const pad = this.orient(inst, hf);
    const fit = fitPadOnLand(
      (x, y) => isLand(hf.terrainByteAt(x, y)),
      inst.x,
      inst.y,
      inst.rotY,
      pad,
    );
    const wasShifted = inst.cx !== inst.x || inst.cz !== inst.y;
    const wasShrunk = inst.fit < 1;
    inst.cx = inst.x + fit.dx;
    inst.cz = inst.y + fit.dz;
    inst.fit = fit.scale;
    const plane = fitGroundPlane(
      (x, z) => hf.surfaceAt(x, z),
      inst.cx,
      inst.cz,
      inst.rotY,
      pad,
      fit.scale,
    );
    inst.base = plane.height;
    inst.gx = plane.gx;
    inst.gz = plane.gz;
    const g = groundGrid(
      (x, z) => hf.surfaceAt(x, z),
      inst.cx,
      inst.cz,
      inst.rotY,
      pad,
      fit.scale,
      inst.grid,
    );
    inst.ground = g.centre - g.float - PAD_SINK;
    const shifted = fit.dx !== 0 || fit.dz !== 0;
    this.padsShifted += (shifted ? 1 : 0) - (wasShifted ? 1 : 0);
    this.padsShrunk += (fit.scale < 1 ? 1 : 0) - (wasShrunk ? 1 : 0);
    this.placeMsMax = Math.max(this.placeMsMax, performance.now() - t0);
  }

  /**
   * Re-assigns every instance to its batch slot and writes all data (no
   * model instance at all while the models are off: icons only).
   */
  private rebuild(now: number): void {
    this.lastNowMs = now;
    this.matrixZoom = this.lastZoom;
    this.matrixWeight = this.weight;
    this.markColorsCurrent();
    this.heightVersion = this.ctx.heightField.version;
    this.highlightDirty = false;
    for (const b of this.batches.values()) b.begin();
    this.animated = [];
    for (const inst of this.insts.values()) {
      const key = this.keyOf(inst.type, inst.variant);
      inst.top = this.topOf(key, inst.type, inst.variant);
      const batch =
        this.models && inst.inView
          ? this.batchFor(key, inst.type, inst.variant, this.lod)
          : null;
      inst.batch = batch;
      if (batch === null) {
        inst.index = -1;
        continue;
      }
      this.computeMatrix(inst, now);
      inst.index = batch.push(
        this.m,
        this.colorFor(inst),
        this.shadeFor(inst, now),
        inst.grid,
      );
      if (inst.underConstruction || inst.marked) this.animated.push(inst);
    }
    for (const b of this.batches.values()) b.end();
    this.writeShadows();
  }

  /**
   * One soft shadow per drawn model, the size of its pad, shifted away from
   * the sun and lying on the pad's ground plane.
   */
  private writeShadows(): void {
    const sh = this.shadows;
    sh.begin();
    const fx = modelFadeScaleX(this.matrixWeight);
    const fy = modelFadeScaleY(this.matrixWeight);
    for (const inst of this.insts.values()) {
      if (inst.batch === null) continue;
      const base =
        minScreenScale(
          this.ctx.settings.structureMinScreenPx,
          this.matrixZoom,
          STRUCTURE_FOOTPRINT[inst.type] ?? 6,
        ) * inst.fit;
      const k = base * fx;
      const c = Math.cos(inst.rotY);
      const s = Math.sin(inst.rotY);
      const [ox, oz] = shadowOffset(0.3 * inst.top * base * fy);
      const dx = k * (inst.padCx * c + inst.padCz * s) + ox;
      const dz = k * (inst.padCz * c - inst.padCx * s) + oz;
      sh.push(
        inst.cx + dx,
        inst.base + inst.gx * dx + inst.gz * dz + SHADOW_LIFT,
        inst.cz + dz,
        inst.padW * k * SHADOW_SIZE,
        inst.padD * k * SHADOW_SIZE,
        inst.rotY,
        SHADOW_ALPHA,
        inst.gx,
        inst.gz,
      );
    }
    sh.end();
  }

  private writeInstance(inst: StructureInst, now: number): void {
    if (inst.batch === null) return;
    this.computeMatrix(inst, now);
    inst.batch.setMatrix(inst.index, this.m);
    inst.batch.setShade(inst.index, this.shadeFor(inst, now));
  }

  /** True when the min-size boost differs between matrixZoom and `zoom`. */
  private minScaleChanged(zoom: number): boolean {
    const minPx = this.ctx.settings.structureMinScreenPx;
    for (const fp of Object.values(STRUCTURE_FOOTPRINT)) {
      if (
        minScreenScale(minPx, zoom, fp) !==
        minScreenScale(minPx, this.matrixZoom, fp)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Instance matrix of `inst` into `this.m`. */
  private computeMatrix(inst: StructureInst, now: number): void {
    const base = minScreenScale(
      this.ctx.settings.structureMinScreenPx,
      this.matrixZoom,
      STRUCTURE_FOOTPRINT[inst.type] ?? 6,
    );
    const [lx, ly] = structureLevelScale(inst.type, inst.level);
    let k = base * inst.fit;
    if (this.highlight?.has(inst.type)) k *= 1.2;
    if (inst.underConstruction) {
      k *= constructionScale(now - inst.ucSinceMs, now / 1000);
    }
    // Growing out of the ground while the icons fade (fade band).
    const fx = modelFadeScaleX(this.matrixWeight);
    const fy = modelFadeScaleY(this.matrixWeight);
    this.p.set(inst.cx, inst.ground, inst.cz);
    this.q.setFromAxisAngle(this.up, inst.rotY);
    this.s.set(k * lx * fx, k * ly * fy, k * lx * fx);
    this.m.compose(this.p, this.q, this.s);
  }

  /**
   * Owner colour (affiliation colour in the alt view, like the icons); grey
   * while under construction, red when marked.
   */
  private colorFor(inst: StructureInst): THREE.Color {
    if (inst.marked)
      return this.c.setRGB(0.92, 0.16, 0.13, THREE.SRGBColorSpace);
    if (inst.underConstruction) {
      return this.c.setRGB(0.78, 0.78, 0.78, THREE.SRGBColorSpace);
    }
    if (this.altView) {
      const [r, g, b] = this.affiliationOf(inst.owner);
      return this.c.setRGB(
        r + (1 - r) * 0.05,
        g + (1 - g) * 0.05,
        b + (1 - b) * 0.05,
        THREE.SRGBColorSpace,
      );
    }
    return setOwnerColor(this.c, this.ctx.palette.data, inst.owner, 0.05);
  }

  /** Brightness: highlight / dimming, marked-for-deletion blink. */
  private shadeFor(inst: StructureInst, now: number): number {
    let shade = 1;
    if (this.highlight !== null) {
      shade = this.highlight.has(inst.type) ? 1.45 : 0.45;
    }
    if (inst.marked) {
      shade *= 0.8 + 0.35 * (0.5 + 0.5 * Math.sin((now / 1000) * 6));
    } else if (inst.underConstruction) {
      shade *= 0.92;
    }
    return shade;
  }

  /** The batch key `type#variant`, cached. */
  private keyOf(type: string, variant: number): string {
    let byVariant = this.keys.get(type);
    if (byVariant === undefined) {
      byVariant = [];
      this.keys.set(type, byVariant);
    }
    return (byVariant[variant] ??= `${type}#${variant}`);
  }

  /** Model geometry of a full (`key`) or low-poly (`key@lod`) batch. */
  private templateFor(
    key: string,
    type: string,
    variant: number,
    lod: boolean,
  ): THREE.BufferGeometry | null {
    const tkey = lod ? `${key}@lod` : key;
    let template = this.templates.get(tkey);
    if (template === undefined) {
      const g = lod
        ? createStructureLodGeometry(type, variant)
        : createStructureGeometry(type, variant);
      if (g === null) return null;
      template = g;
      this.templates.set(tkey, template);
      if (!lod) {
        g.computeBoundingBox();
        this.tops.set(key, Math.max(0.5, g.boundingBox?.max.y ?? 1));
      }
    }
    return template;
  }

  /** Height of the full model (labels and bars anchor on it at any LOD). */
  private topOf(key: string, type: string, variant: number): number {
    if (!this.tops.has(key)) this.templateFor(key, type, variant, false);
    return this.tops.get(key) ?? 1;
  }

  private batchFor(
    key: string,
    type: string,
    variant: number,
    lod: boolean,
  ): InstancedBatch | null {
    let bkey = key;
    if (lod) {
      let k = this.lodKeys.get(key);
      if (k === undefined) {
        k = `${key}@lod`;
        this.lodKeys.set(key, k);
      }
      bkey = k;
    }
    let batch = this.batches.get(bkey);
    if (batch !== undefined) return batch;
    const template = this.templateFor(key, type, variant, lod);
    if (template === null) return null;
    batch = new InstancedBatch(
      this.group,
      template,
      this.material,
      `structures-${bkey}`,
      32,
      0,
      true,
    );
    this.batches.set(bkey, batch);
    this.batchTris.set(bkey, triangleCount(template));
    return batch;
  }
}
