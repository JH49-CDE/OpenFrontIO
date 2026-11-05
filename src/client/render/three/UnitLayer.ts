/**
 * UnitLayer — instanced mobile units (transports, trade ships, warships,
 * trains, nukes, shells, SAM missiles) with interpolation and heading.
 *
 * One `InstancedBatch` (one draw call) per model; instances are rebuilt every
 * frame from a small per-unit `UnitTrack` kept in a Map (removed when the
 * unit disappears from the sim's map).
 *
 * Motion:
 * - Positions are tile centres. Each sim tick re-bases a track from where it
 *   is drawn now to its new tile; frames interpolate with the facade's
 *   `tickAlpha`. Units that also moved on the previous tick are interpolated
 *   linearly (constant speed while cruising); a unit starting from rest eases
 *   in with smoothstep. Rebasing from the drawn position (not `lastPos`)
 *   keeps units whose `lastPos` is stale — engine-updated units that did not
 *   move this tick — from replaying their last step.
 * - Heading = atan2 of the motion, exponentially smoothed per unit.
 * - Boats float at sea level with a gentle bob / roll; trains sit on the
 *   terrain, pitched along the slope; nukes fly an altitude profile (see
 *   `nukeAltitude`) pitched along their 3D velocity and leave a ribbon
 *   trail: a short glowing exhaust at the head and a light contrail behind
 *   it (lot 3); a nuke whose owner has a nuke-trail cosmetic effect gets a
 *   ribbon in the effect's colours instead (the effect palette of
 *   EffectTrails.ts, same colours as its ground track).
 * - In-flight bombs (lot 3): a bomb flies up to 120 tiles high, much closer
 *   to the camera than the ground, so its on-screen length is capped at its
 *   own depth (`nukeScreenCapPx`, `capScreenScale`), and its ribbon is at
 *   least NUKE_TRAIL_MIN_PX wide (warheads WARHEAD_TRAIL_MIN_PX) so the
 *   trail reads at every zoom. MIRV
 *   warheads beyond the first MAX_FULL_WARHEAD_TRAILS get a short trail
 *   (WARHEAD_SHORT_TRAIL_POINTS samples) to bound the per-frame work.
 * - Every model is scaled up to at least `settings.unitMinScreenPx` CSS px.
 * - Boats and trains get a soft contact shadow (`BlobShadows`), shifted
 *   away from the sun.
 * - Warships show the default renderer's health bar (when damaged) and
 *   veterancy pips (`StatusBars`), selected ones a glowing owner ring.
 * - Railways (`RailTracks.ts`) are drawn from the railroad tile state so
 *   trains run on visible tracks; trains ride on top of the rails.
 * - Culling and level of detail: units whose bounding sphere is outside the
 *   view frustum are not drawn (their trails keep sampling). Boats, trains
 *   and shells shorter on screen than UNIT_LOD_PX (UNIT_LOD_PX_LOW with
 *   `quality: "low"`) use a low-poly model (`createUnitLodGeometry`, batch
 *   `units-<kind>-lod`).
 * - Lot 4 prototype (`?three_wakes=1`, `WakeLayer.ts`): foam wakes behind
 *   moving ships, one instanced draw. Without the flag nothing is built
 *   (no mesh, no shader program) and a frame only checks a null field.
 * - `perfStats()` reports unit and railway counters for the perf tool.
 *
 * Contract notes:
 * - `updateUnits` runs once per sim tick with the FULL unit map (structures
 *   included; skip `!isActive` and `waitTicks > 0`).
 * - `setRailroads` receives the long-lived per-tile railroad state (0 = no
 *   rail, else rail type + 1, see RailroadCache) whenever it changed.
 * - `setSelectedUnits([])` clears the selection.
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import { maxHealthWithVeterancy } from "@openfront/engine-lib/game/Veterancy";
import * as THREE from "three";
import {
  TrainType,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
  type UnitState,
} from "../types";
import { smoothstep } from "./CameraRig";
import {
  EFFECT_COLOR_GLSL,
  EffectTrails,
  effectColorAt,
  hasEffect,
  NUKE_TRAIL_BLOCK,
} from "./EffectTrails";
import { NightLighting, nightModeOf } from "./NightLights";
import {
  BlobShadows,
  createPartMaterial,
  createUnitGeometry,
  createUnitLodGeometry,
  InstancedBatch,
  nextCapacity,
  RAIL_TOP,
  setOwnerColor,
  shadowOffset,
  triangleCount,
  UNIT_MESH_LENGTH,
  UnitMesh,
  type UnitMeshKind,
} from "./ProceduralMeshes";
import { pxPerTileAtDepth, RailTracks } from "./RailTracks";
import { FRAG_OUTPUT } from "./shaders/water";
import { barSize, StatusBars } from "./StatusBars";
import { type Rgb, srgbToLinearRgb } from "./TerrainShading";
import type { FrameInfo, ThreeLayerContext } from "./types";
import { WakeRenderer, type WakeTrack } from "./WakeLayer";

export { railHalfDirections } from "./RailTracks";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** Wraps an angle to [-π, π). */
export function wrapAngle(a: number): number {
  const r = (((a + Math.PI) % TAU) + TAU) % TAU;
  return r - Math.PI;
}

/**
 * Moves `current` towards `target` along the shorter arc with an exponential
 * time constant: after `dtMs` the remaining difference is scaled by
 * exp(-dtMs / tauMs), so the result is frame-rate independent. `tauMs ≤ 0`
 * snaps to the target.
 */
export function smoothAngle(
  current: number,
  target: number,
  dtMs: number,
  tauMs: number,
): number {
  if (!(tauMs > 0)) return wrapAngle(target);
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return wrapAngle(current + wrapAngle(target - current) * k);
}

/** Upper bound of the min-size boost (extreme zoom-out). */
export const MAX_MIN_SIZE_SCALE = 30;

/**
 * Scale that keeps a model of `sizeTiles` at least `minPx` CSS px on screen
 * at a zoom of `cssPxPerTile`: max(1, minPx / (cssPxPerTile·sizeTiles)),
 * capped at `maxScale`.
 */
export function minScreenScale(
  minPx: number,
  cssPxPerTile: number,
  sizeTiles: number,
  maxScale = MAX_MIN_SIZE_SCALE,
): number {
  const px = cssPxPerTile * sizeTiles;
  if (!(px > 0)) return maxScale;
  return Math.min(maxScale, Math.max(1, minPx / px));
}

/**
 * In-flight bombs: largest on-screen length (CSS px) of each nuke model at
 * up to 2 px per tile, measured at the model's own depth. Above that zoom
 * the cap grows as √(zoom / 2), up to ×NUKE_CAP_ZOOM_GAIN_MAX.
 */
export const NUKE_SCREEN_CAP_PX: Readonly<
  Partial<Record<UnitMeshKind, number>>
> = {
  atomBomb: 24,
  hydrogenBomb: 30,
  mirv: 36,
  mirvWarhead: 12,
};
export const NUKE_CAP_ZOOM_GAIN_MAX = 2;
/** Bomb ribbons are at least this wide on screen (CSS px) at their head... */
export const NUKE_TRAIL_MIN_PX = 3.5;
/** ...MIRV warheads' this wide. */
export const WARHEAD_TRAIL_MIN_PX = 2;
/**
 * A bomb's exhaust glow on its ribbon runs this far (CSS px, at the bomb's
 * depth) behind its tail, whatever the sample spacing.
 */
export const NUKE_HEAD_GLOW_PX = 16;
/** MIRV warheads with a full trail; later ones get a short one. */
export const MAX_FULL_WARHEAD_TRAILS = 64;
/** Samples of a short warhead trail (a streak of ~0.15 s). */
export const WARHEAD_SHORT_TRAIL_POINTS = 4;

/** On-screen length cap (CSS px) of a nuke model at a zoom; ∞ for others. */
export function nukeScreenCapPx(
  kind: UnitMeshKind,
  cssPxPerTile: number,
): number {
  const base = NUKE_SCREEN_CAP_PX[kind];
  if (base === undefined) return Infinity;
  const gain = Math.sqrt(Math.max(0, cssPxPerTile) / 2);
  return base * Math.min(NUKE_CAP_ZOOM_GAIN_MAX, Math.max(1, gain));
}

/**
 * Zoomed out, the units' emission (bombs' and SAM missiles' exhausts,
 * shells) and the trails' additive glow are scaled by this, so nothing
 * crosses the bloom threshold (luminance 1) where a model is a few px: a
 * bloomed exhaust read as a big glowing ellipse at full map (img00). Full
 * from UNIT_GLOW_ZOOM[1] CSS px per tile on.
 */
export const UNIT_GLOW_FAR = 0.45;
export const UNIT_GLOW_ZOOM: readonly [number, number] = [1.5, 4];
export function unitGlowAtZoom(cssPxPerTile: number): number {
  const t = Math.min(
    1,
    Math.max(
      0,
      (cssPxPerTile - UNIT_GLOW_ZOOM[0]) /
        (UNIT_GLOW_ZOOM[1] - UNIT_GLOW_ZOOM[0]),
    ),
  );
  return UNIT_GLOW_FAR + (1 - UNIT_GLOW_FAR) * t * t * (3 - 2 * t);
}

/**
 * MIRV warheads converge by the dozen: their contrails' opacity is scaled
 * by √(WARHEAD_CONTRAIL_REF / live warheads) (at most 1, at least
 * WARHEAD_CONTRAIL_MIN), so a salvo's fan adds up to lines, not a pale
 * wedge.
 */
export const WARHEAD_CONTRAIL_REF = 6;
export const WARHEAD_CONTRAIL_MIN = 0.3;
export function warheadContrailScale(liveWarheads: number): number {
  if (liveWarheads <= WARHEAD_CONTRAIL_REF) return 1;
  return Math.max(
    WARHEAD_CONTRAIL_MIN,
    Math.sqrt(WARHEAD_CONTRAIL_REF / liveWarheads),
  );
}

/**
 * `scale`, reduced so that a model `lengthTiles` long is at most `capPx`
 * CSS px on screen where one tile spans `pxPerTile` (its depth).
 */
export function capScreenScale(
  scale: number,
  lengthTiles: number,
  pxPerTile: number,
  capPx: number,
): number {
  if (!(pxPerTile > 0) || !(lengthTiles > 0) || !Number.isFinite(capPx)) {
    return scale;
  }
  return Math.min(scale, capPx / (lengthTiles * pxPerTile));
}

/** Apex height (tiles) of a nuke arc spanning `span` tiles. */
export function nukeArcHeight(span: number): number {
  return Math.min(120, Math.max(15, 0.3 * span));
}

/**
 * Flight progress 0..1 from the distances to the launch point (`dO`) and to
 * the target (`dT`): dO / (dO + dT). On a straight path this is exactly
 * dist(origin, pos) / dist(origin, target); unlike that ratio it stays in
 * [0, 1] and reaches ½ at the apex of the engine's bowed Bézier path (whose
 * mid-point can be farther from the origin than the target is).
 */
export function nukeProgress(dO: number, dT: number): number {
  const sum = dO + dT;
  if (!(sum > 0)) return 1;
  return Math.min(1, Math.max(0, dO / sum));
}

/** Altitude profiles of the nuke types. */
export const NukeFlight = {
  /** Atom / hydrogen: arcH·sin(π·progress). */
  Arc: 0,
  /** MIRV: climbs over the first MIRV_CLIMB_TILES, then cruises. */
  Climb: 1,
  /** MIRV warhead: released at cruise altitude, dives onto its target. */
  Dive: 2,
} as const;
export type NukeFlight = (typeof NukeFlight)[keyof typeof NukeFlight];

/** Cruise altitude of a MIRV, where its warheads are released (tiles). */
export const MIRV_CRUISE_ALTITUDE = 100;
/** Ground distance over which a MIRV climbs to cruise altitude. */
export const MIRV_CLIMB_TILES = 180;

export interface NukeAltitude {
  /** Height above the ground track, tiles. */
  altitude: number;
  /** d(altitude)/d(ground distance): tan of the flight-path pitch. */
  slope: number;
  progress: number;
}

/**
 * Altitude and climb slope of a nuke `dO` tiles from its launch point and
 * `dT` from its target, for a launch→target ground distance `span`.
 *
 * Along the path dO grows and dT shrinks at the ground speed, so
 * d(progress)/d(ground distance) = 1 / (dO + dT); the slope follows by the
 * chain rule (e.g. Arc: arcH·π·cos(π·p) / (dO + dT)).
 */
export function nukeAltitude(
  flight: NukeFlight,
  dO: number,
  dT: number,
  span: number,
): NukeAltitude {
  const p = nukeProgress(dO, dT);
  const sum = Math.max(1e-6, dO + dT);
  switch (flight) {
    case NukeFlight.Arc: {
      const h = nukeArcHeight(span);
      return {
        altitude: h * Math.sin(Math.PI * p),
        slope: (h * Math.PI * Math.cos(Math.PI * p)) / sum,
        progress: p,
      };
    }
    case NukeFlight.Climb: {
      const t = Math.min(1, Math.max(0, dO / MIRV_CLIMB_TILES));
      return {
        altitude: MIRV_CRUISE_ALTITUDE * smoothstep(0, 1, t),
        // d/dx of smoothstep(x / L) = 6t(1−t) / L.
        slope: (MIRV_CRUISE_ALTITUDE * 6 * t * (1 - t)) / MIRV_CLIMB_TILES,
        progress: p,
      };
    }
    case NukeFlight.Dive: {
      const a = (Math.PI / 2) * p;
      return {
        altitude: MIRV_CRUISE_ALTITUDE * Math.cos(a),
        slope: (-MIRV_CRUISE_ALTITUDE * (Math.PI / 2) * Math.sin(a)) / sum,
        progress: p,
      };
    }
  }
}

/** Warship max health and veterancy bonus (%) from the rules config. */
export interface WarshipHealthRules {
  baseMaxHealth: number;
  veterancyBonusPercent: number;
}

/** Reads `WarshipHealthRules`; zeros (no health bars) if the config lacks them. */
export function warshipHealthRules(config: Config): WarshipHealthRules {
  try {
    return {
      baseMaxHealth: config.unitInfo(UnitType.Warship).maxHealth ?? 0,
      veterancyBonusPercent: config.warshipVeterancyHealthBonus(),
    };
  } catch {
    return { baseMaxHealth: 0, veterancyBonusPercent: 0 };
  }
}

/**
 * Health bar fill of a unit, or null when no bar is shown: like BarPass,
 * only damaged units (health below the veterancy-adjusted max) get one.
 */
export function healthBarValue(
  health: number | null,
  veterancy: number,
  rules: WarshipHealthRules,
): number | null {
  if (health === null || health <= 0 || rules.baseMaxHealth <= 0) return null;
  const max = maxHealthWithVeterancy(
    rules.baseMaxHealth,
    veterancy,
    rules.veterancyBonusPercent,
  );
  return health < max ? health / max : null;
}

/**
 * Whether a sphere at (x, y, z) of radius `r` is at least partly inside the
 * frustum `planes` (normals pointing inwards, as `THREE.Frustum` builds them).
 */
export function sphereInFrustum(
  planes: readonly THREE.Plane[],
  x: number,
  y: number,
  z: number,
  r: number,
): boolean {
  for (const pl of planes) {
    const n = pl.normal;
    if (n.x * x + n.y * y + n.z * z + pl.constant < -r) return false;
  }
  return true;
}

/** Interpolation weight for a tick segment (see the file comment). */
export function tickEase(alpha: number, continuous: boolean): number {
  const a = Math.min(1, Math.max(0, alpha));
  return continuous ? a : smoothstep(0, 1, a);
}

// ---------------------------------------------------------------------------
// Per-model behaviour
// ---------------------------------------------------------------------------

type Motion = "boat" | "train" | "nuke" | "shell" | "sam";

interface TrailStyle {
  /** Samples kept (≈ trail length / TRAIL_SAMPLE_MS). */
  points: number;
  /** Ribbon width at the head, tiles (× the unit's min-size scale). */
  width: number;
  /** Head colour (linear, may exceed 1 so bloom picks it up). */
  color: readonly [number, number, number];
  /** Fraction of the owner colour mixed into the trail colour. */
  ownerMix: number;
  /**
   * Contrail behind the head (nukes): linear colour, opacity and owner mix,
   * composited "over" the scene; the additive glow then stays at the head.
   */
  smoke?: {
    color: readonly [number, number, number];
    alpha: number;
    ownerMix: number;
  };
  /** Minimum on-screen width of the ribbon's head (CSS px), nukes. */
  minPx?: number;
}

interface KindInfo {
  motion: Motion;
  /** Heading smoothing time constant, ms. */
  tauMs: number;
  flight?: NukeFlight;
  trail?: TrailStyle;
  /** Boat bob amplitude (tiles), roll and pitch amplitudes (radians). */
  bob?: readonly [number, number, number];
  /**
   * Contact shadow: (length, width) as fractions of the model length, the
   * casting height (fraction of the length) and the opacity.
   */
  shadow?: readonly [number, number, number, number];
}

const WARM_TRAIL = [1.7, 1.0, 0.45] as const;
/**
 * Nuke contrail: a light grey (linear) tinted with the owner's colour (the
 * default renderer's nuke trail on the ground is the owner's colour), so
 * a bomb's trail also says whose it is; light enough to stand out on
 * land of the owner's own colour.
 */
const CONTRAIL = {
  color: [0.92, 0.9, 0.86],
  alpha: 0.85,
  ownerMix: 0.45,
} as const;
/**
 * MIRV warheads come by the dozen to hundreds and converge: fainter
 * contrails and a dimmer head, so together they read as lines, not as a
 * glowing sheet.
 */
const WARHEAD_CONTRAIL = { ...CONTRAIL, alpha: 0.7 } as const;
const WARHEAD_HEAD = [0.95, 0.56, 0.26] as const;

const KIND_INFO: Readonly<Record<UnitMeshKind, KindInfo>> = {
  transport: {
    motion: "boat",
    tauMs: 160,
    bob: [0.05, 0.06, 0.025],
    shadow: [1.08, 0.52, 0.12, 0.42],
  },
  tradeShip: {
    motion: "boat",
    tauMs: 200,
    bob: [0.04, 0.05, 0.02],
    shadow: [1.06, 0.44, 0.12, 0.42],
  },
  warship: {
    motion: "boat",
    tauMs: 220,
    bob: [0.03, 0.03, 0.012],
    shadow: [1.04, 0.32, 0.1, 0.45],
  },
  trainEngine: { motion: "train", tauMs: 90, shadow: [1.2, 0.6, 0.3, 0.5] },
  trainCarriage: { motion: "train", tauMs: 90, shadow: [1.2, 0.6, 0.3, 0.5] },
  trainLoaded: { motion: "train", tauMs: 90, shadow: [1.2, 0.6, 0.3, 0.5] },
  atomBomb: {
    motion: "nuke",
    tauMs: 110,
    flight: NukeFlight.Arc,
    trail: {
      points: 40,
      width: 0.9,
      color: WARM_TRAIL,
      ownerMix: 0.3,
      smoke: CONTRAIL,
      minPx: NUKE_TRAIL_MIN_PX,
    },
  },
  hydrogenBomb: {
    motion: "nuke",
    tauMs: 110,
    flight: NukeFlight.Arc,
    trail: {
      points: 40,
      width: 1.3,
      color: WARM_TRAIL,
      ownerMix: 0.3,
      smoke: CONTRAIL,
      minPx: NUKE_TRAIL_MIN_PX,
    },
  },
  mirv: {
    motion: "nuke",
    tauMs: 130,
    flight: NukeFlight.Climb,
    trail: {
      points: 40,
      width: 1.6,
      color: WARM_TRAIL,
      ownerMix: 0.3,
      smoke: CONTRAIL,
      minPx: NUKE_TRAIL_MIN_PX,
    },
  },
  mirvWarhead: {
    motion: "nuke",
    tauMs: 80,
    flight: NukeFlight.Dive,
    trail: {
      points: 12,
      width: 0.45,
      color: WARHEAD_HEAD,
      ownerMix: 0.3,
      smoke: WARHEAD_CONTRAIL,
      minPx: WARHEAD_TRAIL_MIN_PX,
    },
  },
  shell: { motion: "shell", tauMs: 0 },
  samMissile: {
    motion: "sam",
    tauMs: 60,
    trail: { points: 14, width: 0.35, color: [1.1, 1.1, 1.2], ownerMix: 0 },
  },
};

/** Which model draws a unit (null = not a mobile unit). */
export function unitMeshKindFor(u: UnitState): UnitMeshKind | null {
  switch (u.unitType) {
    case UT_TRANSPORT:
      return "transport";
    case UT_TRADE_SHIP:
      return "tradeShip";
    case UT_WARSHIP:
      return "warship";
    case UT_TRAIN:
      if (u.trainType === TrainType.Carriage) {
        return u.loaded === true ? "trainLoaded" : "trainCarriage";
      }
      return "trainEngine";
    case UT_ATOM_BOMB:
      return "atomBomb";
    case UT_HYDROGEN_BOMB:
      return "hydrogenBomb";
    case UT_MIRV:
      return "mirv";
    case UT_MIRV_WARHEAD:
      return "mirvWarhead";
    case UT_SHELL:
      return "shell";
    case UT_SAM_MISSILE:
      return "samMissile";
    default:
      return null;
  }
}

/** A jump longer than this (tiles) between ticks is drawn as a teleport. */
const TELEPORT_TILES = 60;
/** Lighten owner colours a little so units pop against the territory. */
const UNIT_LIGHTEN = 0.12;
/** Lighten selection rings like the default renderer's selection boxes. */
const SELECTION_LIGHTEN = 0.3;
/**
 * HDR gain of selection rings: lifts their luminance just over the bloom
 * threshold (1) so they glow softly; pulses ±15%.
 */
const SELECTION_GLOW = 1.7;
/** Shadows sit this far above the water / ground (tiles). */
const SHADOW_LIFT = 0.06;
/**
 * Boats, trains and shells shorter than this on screen (CSS px) use their
 * low-poly model; `quality: "low"` switches earlier.
 */
export const UNIT_LOD_PX = 24;
export const UNIT_LOD_PX_LOW = 72;
/** Batch key of each kind's low-poly model (no string building per frame). */
const LOD_KEY = Object.fromEntries(
  Object.values(UnitMesh).map((k) => [k, `${k}-lod`]),
) as Readonly<Record<UnitMeshKind, string>>;
/** Health bars / pips fade in between these zooms (CSS px per tile). */
const BAR_FADE_ZOOM: readonly [number, number] = [0.8, 1.2];
/** Height of shells above the surface, tiles. */
const SHELL_ALTITUDE = 0.9;

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

interface UnitTrack {
  id: number;
  kind: UnitMeshKind;
  owner: number;
  /** Instance colour (linear). */
  color: THREE.Color;
  /** Tick segment being interpolated, tile coords (tile centres). */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Ground position drawn on the last frame. */
  dispX: number;
  dispY: number;
  /** World position drawn on the last frame (three Y-up). */
  worldY: number;
  movedLastTick: boolean;
  continuous: boolean;
  heading: number;
  targetHeading: number;
  hasHeading: boolean;
  /** Per-unit animation phase (bob), 0..2π. */
  phase: number;
  /** Tail engines run backwards (model turned by π). */
  reversed: boolean;
  stamp: number;
  targetable: boolean;
  targetUnitId: number | null;
  health: number | null;
  veterancy: number;
  /** Nukes / SAMs: first-seen ground position (launch origin). */
  originX: number;
  originY: number;
  /** Target tile centre, NaN when unknown. */
  targetX: number;
  targetY: number;
  trail: Trail | null;
  /** Lot 4 wake state (ships, `?three_wakes=1` only; created lazily). */
  wake: WakeTrack | null;
}

/** Deterministic 0..2π phase from a unit id. */
function phaseFor(id: number): number {
  const h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return (h / 0x100000000) * TAU;
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

/** Uploads only the first `n` elements of a dynamic attribute. */
function publishRange(attr: THREE.BufferAttribute, n: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n);
  attr.needsUpdate = true;
}

/** Minimum time between two trail samples. */
const TRAIL_SAMPLE_MS = 40;
/** How long a trail lingers after its missile is gone. */
const TRAIL_FADE_MS = 700;
/** Floats per trail sample: x, y, z, side.x, side.z. */
const TRAIL_STRIDE = 5;
/** Contrail trails: the additive exhaust glow falls off as fade^this. */
const SMOKE_GLOW_EXPONENT = 5;
/** Opacity of a nuke ribbon in its owner's effect colours, at its head. */
export const RIBBON_EFFECT_OPACITY = 0.85;
/** Extra emission of an effect-coloured ribbon (bloom), × its colour. */
export const RIBBON_EFFECT_GLOW = 0.5;

/**
 * What a ribbon fragment writes before tone mapping and fog (TS mirror of
 * RIBBON_FRAG): the default trail colour added (`alpha` 0: additive) plus,
 * for a nuke's contrail (`smoke`, lot 3), its colour composited over the
 * scene at its opacity; or, for a nuke whose owner (`effectOwner`, 0 for
 * other missiles) has a nuke-trail effect, the effect's colour at world
 * (x, z) and time `t` (s), linear, composited over the scene at
 * `RIBBON_EFFECT_OPACITY × intensity`, instead of both. All premultiplied
 * (rgb already × alpha for what is composited over).
 */
export function ribbonFragment(
  base: Rgb,
  effectOwner: number,
  intensity: number,
  effect: Float32Array | null,
  effectsOn: boolean,
  x: number,
  z: number,
  t: number,
  smoke: { rgb: Rgb; alpha: number } | null = null,
): { rgb: Rgb; alpha: number } {
  const e =
    effectsOn && effectOwner > 0 && effect !== null
      ? effectColorAt(effect, effectOwner, NUKE_TRAIL_BLOCK, x, z, t)
      : null;
  if (e === null) {
    const a = smoke === null ? 0 : Math.min(1, Math.max(0, smoke.alpha));
    const s = smoke?.rgb ?? [0, 0, 0];
    return {
      rgb: [base[0] + s[0] * a, base[1] + s[1] * a, base[2] + s[2] * a],
      alpha: a,
    };
  }
  const a = Math.min(1, Math.max(0, intensity)) * RIBBON_EFFECT_OPACITY;
  const k = (1 + RIBBON_EFFECT_GLOW) * a;
  const lin = srgbToLinearRgb(e);
  return { rgb: [lin[0] * k, lin[1] * k, lin[2] * k], alpha: a };
}

const RIBBON_VERT = /* glsl */ `
attribute vec3 aColor;  // additive glow: default trail colour x intensity (linear)
attribute vec4 aSmoke;  // contrail colour (linear) and opacity, composited over
attribute vec2 aEffect; // (effect owner smallID, 0 = none; intensity)
varying vec3 vColor;
varying vec4 vSmoke;
varying vec2 vEffect;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vSmoke = aSmoke;
  vEffect = aEffect;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const RIBBON_FRAG = /* glsl */ `
${FRAG_OUTPUT}
${EFFECT_COLOR_GLSL}
varying vec3 vColor;
varying vec4 vSmoke;
varying vec2 vEffect;
varying vec3 vWorld;
#include <fog_pars_fragment>

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c * (1.0 / 12.92);
  vec3 hi = pow((c + 0.055) * (1.0 / 1.055), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

void main() {
  // Default: the glow added (alpha 0 with ONE / ONE_MINUS_SRC_ALPHA
  // blending), as the former additive MeshBasicMaterial, plus a nuke's
  // contrail composited over (premultiplied). A nuke-trail effect: its
  // colour (block 1, same bands as the ground track below), composited
  // over, instead of both.
  vec3 glow = vColor;
  vec3 over = vSmoke.rgb;
  float a = clamp(vSmoke.a, 0.0, 1.0);
  int owner = int(vEffect.x + 0.5);
  vec3 e;
  if (owner > 0 && effectColor(owner, EFFECT_BLOCK_ROWS, vWorld.xz, e)) {
    glow = vec3(0.0);
    a = clamp(vEffect.y, 0.0, 1.0) * ${RIBBON_EFFECT_OPACITY.toFixed(3)};
    over = srgbToLinear(e) * ${(1 + RIBBON_EFFECT_GLOW).toFixed(3)};
  }
  vec3 overOut = vec3(0.0);
  if (a > 0.0) {
    gl_FragColor = vec4(over, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    {
    #include <fog_fragment>
    }
    overOut = gl_FragColor.rgb * a;
  }
  vec3 glowOut = vec3(0.0);
  if (glow.r + glow.g + glow.b > 0.0) {
    gl_FragColor = vec4(glow, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    glowOut = gl_FragColor.rgb;
    // Added light fades out in the fog (mixing it towards the fog colour
    // would add haze over the whole ribbon).
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        glowOut *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        glowOut *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #endif
  }
  gl_FragColor = vec4(glowOut + overOut, a);
}
`;

interface Trail {
  /** Ring buffer of samples, `TRAIL_STRIDE` floats each. */
  pts: Float32Array;
  max: number;
  count: number;
  /** Index of the newest sample. */
  head: number;
  lastSampleMs: number;
  /** Live head: the missile's tail right now (not yet sampled). */
  live: boolean;
  liveX: number;
  liveY: number;
  liveZ: number;
  liveSX: number;
  liveSZ: number;
  /**
   * Samples are points of the missile's path (its centre without the
   * model's lift); drawn raised by `lift` (the current model's), skipping
   * the `skip` newest ones that lie ahead of the live tail (lot 3: a
   * model whose on-screen cap changes no longer kinks its trail).
   */
  lift: number;
  skip: number;
  /**
   * Length (tiles) of a nuke's head glow behind its tail: a fixed length
   * on screen (NUKE_HEAD_GLOW_PX); 0 = over the first samples (SAMs).
   * `split` = 1 adds a vertex at that distance on a longer first segment
   * (its fraction `splitAt`), so the glow does not stretch over it.
   */
  glowLen: number;
  split: number;
  splitAt: number;
  /** Half width at the head, tiles. */
  halfWidth: number;
  color: THREE.Color;
  /** Contrail colour (linear) and opacity at the head; null = none. */
  smoke: THREE.Color | null;
  smokeAlpha: number;
  /** A MIRV warhead's trail (counted against MAX_FULL_WARHEAD_TRAILS). */
  warhead: boolean;
  /** Owner whose nuke-trail effect colours the ribbon (0 = none). */
  effectOwner: number;
  diedMs: number;
}

/** Vertices of a trail's ribbon: live tail (+ split vertex) + samples. */
function drawnVertices(t: Trail): number {
  return t.count - t.skip + (t.live ? 1 + t.split : 0);
}

/**
 * All nuke / SAM trails as one ribbon mesh, rebuilt every frame. Each trail
 * is a strip of quads from the missile's tail back through its samples,
 * tapering and fading to black (= invisible under additive blending).
 * A nuke's trail also carries a light contrail composited over the scene
 * (premultiplied alpha), building up just behind the exhaust and thinning
 * out with age, while its glow stays at the head (lot 3: a readable trail
 * rather than a long glowing streak that bloom widens).
 * Ribbons lie flat (their width is horizontal) so they read from above.
 * A nuke's ribbon takes its owner's nuke-trail effect colours when they have
 * one (outside the alt view), composited over the scene and fading the same
 * way (see `ribbonFragment`).
 */
class TrailRenderer {
  private readonly material: THREE.ShaderMaterial;
  /** Any player has a nuke-trail effect and the alt view is off. */
  private readonly effectsOn = { value: 0 };
  private readonly mesh: THREE.Mesh;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private effect = new Float32Array(0);
  private smoke = new Float32Array(0);
  private index = new Uint32Array(0);
  private posAttr = new THREE.BufferAttribute(this.positions, 3);
  private colAttr = new THREE.BufferAttribute(this.colors, 3);
  private smokeAttr = new THREE.BufferAttribute(this.smoke, 4);
  private effAttr = new THREE.BufferAttribute(this.effect, 2);
  private idxAttr = new THREE.BufferAttribute(this.index, 1);
  private vertCap = 0;
  private indexCap = 0;
  private readonly live = new Set<Trail>();
  private dying: Trail[] = [];
  /** Live then dying trails of the current update (reused). */
  private readonly all: Trail[] = [];
  /** Live / dying nuke ribbons drawn in effect colours (last update). */
  effectRibbons = 0;
  /** Live MIRV warhead trails (full or short). */
  liveWarheads = 0;
  /** Ribbons and samples drawn on the last update (perf counters). */
  ribbons = 0;
  samples = 0;

  constructor(
    parent: THREE.Object3D,
    private readonly effects: EffectTrails,
  ) {
    this.material = new THREE.ShaderMaterial({
      name: "three-unit-trails",
      glslVersion: THREE.GLSL3,
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        // Shared by reference with the ground trails.
        uEffectPalette: effects.uniforms.uEffectPalette,
        uTrailTime: effects.uniforms.uTrailTime,
        uEffectsOn: this.effectsOn,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      // Premultiplied: alpha 0 adds (the default look), alpha > 0 is "over".
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = "unit-trails";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.ensure(1024, 3072);
  }

  /**
   * A trail; `effectOwner` > 0 colours it by that owner's nuke effect;
   * `points` overrides the style's sample count (short warhead trails).
   */
  create(
    style: TrailStyle,
    owner: THREE.Color,
    effectOwner = 0,
    warhead = false,
    points = style.points,
  ): Trail {
    // style colour × mix(1, owner, ownerMix): a warm glow with a hint of
    // the owner's colour.
    const k = style.ownerMix;
    const color = new THREE.Color(
      style.color[0] * (1 - k + owner.r * k),
      style.color[1] * (1 - k + owner.g * k),
      style.color[2] * (1 - k + owner.b * k),
    );
    let smoke: THREE.Color | null = null;
    if (style.smoke !== undefined) {
      const m = style.smoke.ownerMix;
      const c = style.smoke.color;
      smoke = new THREE.Color(
        c[0] * (1 - m) + owner.r * m,
        c[1] * (1 - m) + owner.g * m,
        c[2] * (1 - m) + owner.b * m,
      );
    }
    const max = Math.max(2, Math.floor(points));
    if (warhead) this.liveWarheads++;
    const trail: Trail = {
      pts: new Float32Array(max * TRAIL_STRIDE),
      max,
      count: 0,
      head: -1,
      lastSampleMs: -Infinity,
      live: true,
      liveX: 0,
      liveY: 0,
      liveZ: 0,
      liveSX: 0,
      liveSZ: 1,
      lift: 0,
      skip: 0,
      glowLen: 0,
      split: 0,
      splitAt: 0,
      halfWidth: style.width / 2,
      color,
      smoke,
      smokeAlpha: style.smoke?.alpha ?? 0,
      warhead,
      effectOwner,
      diedMs: 0,
    };
    this.live.add(trail);
    return trail;
  }

  /** The missile is gone: keep the trail fading out for a moment. */
  retire(trail: Trail, nowMs: number): void {
    if (!this.live.delete(trail)) return;
    if (trail.warhead) this.liveWarheads--;
    trail.live = false;
    trail.split = 0;
    trail.diedMs = nowMs;
    this.dying.push(trail);
  }

  /**
   * Moves the missile to path point (x, y, z) (world: its centre without
   * the model's `lift`), its tail `back` tiles behind along the unit
   * forward vector (fx, fy, fz) and `lift` above, and stores a path sample
   * every TRAIL_SAMPLE_MS. `heading` (tile-space radians) orients the
   * ribbon width. The ribbon runs from the live tail back through the
   * samples farther than `back` from the missile's centre.
   */
  track(
    trail: Trail,
    nowMs: number,
    x: number,
    y: number,
    z: number,
    fx: number,
    fy: number,
    fz: number,
    back: number,
    lift: number,
    heading: number,
    halfWidth: number,
    glowLen = 0,
  ): void {
    const tx = x - fx * back;
    const ty = y - fy * back;
    const tz = z - fz * back;
    trail.liveX = tx;
    trail.liveY = ty + lift;
    trail.liveZ = tz;
    trail.lift = lift;
    // Horizontal perpendicular of the heading (cos h, 0, sin h).
    trail.liveSX = -Math.sin(heading);
    trail.liveSZ = Math.cos(heading);
    trail.halfWidth = halfWidth;
    if (nowMs - trail.lastSampleMs >= TRAIL_SAMPLE_MS) {
      trail.lastSampleMs = nowMs;
      trail.head = (trail.head + 1) % trail.max;
      trail.count = Math.min(trail.max, trail.count + 1);
      const o = trail.head * TRAIL_STRIDE;
      trail.pts[o] = x;
      trail.pts[o + 1] = y;
      trail.pts[o + 2] = z;
      trail.pts[o + 3] = trail.liveSX;
      trail.pts[o + 4] = trail.liveSZ;
    }
    // The newest samples still within the model (closer to its centre than
    // its tail) are not drawn.
    let skip = 0;
    const b2 = back * back;
    while (skip < trail.count) {
      const o = ((trail.head - skip + trail.max) % trail.max) * TRAIL_STRIDE;
      const dx = trail.pts[o] - x;
      const dy = trail.pts[o + 1] - y;
      const dz = trail.pts[o + 2] - z;
      if (dx * dx + dy * dy + dz * dz >= b2) break;
      skip++;
    }
    trail.skip = skip;
    trail.glowLen = glowLen;
    trail.split = 0;
    if (glowLen > 0 && skip < trail.count) {
      const o = ((trail.head - skip + trail.max) % trail.max) * TRAIL_STRIDE;
      const seg = Math.hypot(
        trail.pts[o] - tx,
        trail.pts[o + 1] - ty,
        trail.pts[o + 2] - tz,
      );
      if (seg > 1.05 * glowLen) {
        trail.split = 1;
        trail.splitAt = glowLen / seg;
      }
    }
  }

  /**
   * Rebuilds the ribbons. `glowScale` scales the additive glow
   * (`unitGlowAtZoom`); warhead contrails are thinned out by their number
   * (`warheadContrailScale`).
   */
  update(nowMs: number, altView: boolean, glowScale = 1): void {
    // Effects stay off in the alt view (strategic overlay), as the ground
    // trails and the default renderer's spiral ribbons.
    const palette = this.effects.effects;
    const effectsOn = palette.nukePlayers > 0 && !altView;
    this.effectsOn.value = effectsOn ? 1 : 0;
    const effectData = effectsOn ? palette.data : null;
    let effectRibbons = 0;
    // Drop the trails done fading (in place: no allocation per frame).
    let kept = 0;
    for (const t of this.dying) {
      if (nowMs - t.diedMs < TRAIL_FADE_MS) this.dying[kept++] = t;
    }
    this.dying.length = kept;
    let verts = 0;
    let indices = 0;
    const all = this.all;
    all.length = 0;
    for (const t of this.live) all.push(t);
    for (const t of this.dying) all.push(t);
    for (const t of all) {
      const n = drawnVertices(t);
      if (n < 2) continue;
      verts += 2 * n;
      indices += 6 * (n - 1);
    }
    const warheadSmoke = warheadContrailScale(this.liveWarheads);
    if (indices === 0) {
      this.mesh.visible = false;
      this.effectRibbons = 0;
      this.ribbons = 0;
      this.samples = 0;
      return;
    }
    this.ensure(verts, indices);
    const pos = this.positions;
    const col = this.colors;
    const smk = this.smoke;
    const eff = this.effect;
    let ribbons = 0;
    const idx = this.index;
    let v = 0;
    let ii = 0;
    for (const t of all) {
      const n = drawnVertices(t);
      if (n < 2) continue;
      const life = t.live ? 1 : 1 - (nowMs - t.diedMs) / TRAIL_FADE_MS;
      const smokeAlpha = t.smokeAlpha * (t.warhead ? warheadSmoke : 1);
      const base = v;
      const owner = t.effectOwner;
      const smoke = t.smoke;
      ribbons++;
      if (
        effectData !== null &&
        owner > 0 &&
        hasEffect(effectData, owner, NUKE_TRAIL_BLOCK)
      ) {
        effectRibbons++;
      }
      // Samples drawn, and the index span the taper / fade run over (the
      // live tail counts as index 0, as before).
      const drawn = t.count - t.skip;
      const span = Math.max(1, t.live ? drawn : drawn - 1);
      const split = t.live ? t.split : 0;
      // Head glow by distance along the ribbon (tiles), when set.
      let dist = 0;
      let px = 0;
      let py = 0;
      let pz = 0;
      for (let j = 0; j < n; j++) {
        let x: number, y: number, z: number, sx: number, sz: number;
        /** Index along the ribbon (fractional for the split vertex). */
        let kf: number;
        if (t.live && j === 0) {
          x = t.liveX;
          y = t.liveY;
          z = t.liveZ;
          sx = t.liveSX;
          sz = t.liveSZ;
          kf = 0;
        } else if (split === 1 && j === 1) {
          // Where the head glow ends on a long first segment.
          const o = ((t.head - t.skip + t.max) % t.max) * TRAIL_STRIDE;
          const f = t.splitAt;
          x = t.liveX + (t.pts[o] - t.liveX) * f;
          y = t.liveY + (t.pts[o + 1] + t.lift - t.liveY) * f;
          z = t.liveZ + (t.pts[o + 2] - t.liveZ) * f;
          sx = t.liveSX + (t.pts[o + 3] - t.liveSX) * f;
          sz = t.liveSZ + (t.pts[o + 4] - t.liveSZ) * f;
          kf = f;
        } else {
          const i = j - (t.live ? 1 + split : 0);
          const age = i + t.skip;
          const o = ((t.head - age + t.max) % t.max) * TRAIL_STRIDE;
          x = t.pts[o];
          y = t.pts[o + 1] + t.lift;
          z = t.pts[o + 2];
          sx = t.pts[o + 3];
          sz = t.pts[o + 4];
          kf = t.live ? i + 1 : i;
        }
        if (j > 0) dist += Math.hypot(x - px, y - py, z - pz);
        px = x;
        py = y;
        pz = z;
        const fade = Math.max(0, 1 - kf / span);
        const hw = t.halfWidth * (0.25 + 0.75 * fade);
        const intensity = fade * Math.sqrt(fade) * life;
        // With a contrail the exhaust glow stays at the head: over
        // `glowLen` tiles (a fixed length on screen), else over the first
        // samples.
        let glow = intensity;
        if (smoke !== null) {
          if (t.glowLen > 0) {
            const g = Math.max(0, 1 - dist / t.glowLen);
            glow = g * g * life;
          } else {
            glow = Math.pow(fade, SMOKE_GLOW_EXPONENT) * life;
          }
        }
        const r = t.color.r * glow * glowScale;
        const g = t.color.g * glow * glowScale;
        const b = t.color.b * glow * glowScale;
        const p = v * 3;
        pos[p] = x - sx * hw;
        pos[p + 1] = y;
        pos[p + 2] = z - sz * hw;
        pos[p + 3] = x + sx * hw;
        pos[p + 4] = y;
        pos[p + 5] = z + sz * hw;
        col[p] = col[p + 3] = r;
        col[p + 1] = col[p + 4] = g;
        col[p + 2] = col[p + 5] = b;
        const q = v * 2;
        eff[q] = eff[q + 2] = owner;
        eff[q + 1] = eff[q + 3] = intensity;
        const o4 = v * 4;
        if (smoke !== null) {
          // Builds up behind the exhaust (over the head glow's length, or
          // the first samples), then thins.
          const build =
            t.glowLen > 0
              ? Math.min(1, dist / t.glowLen)
              : Math.min(1, kf / 1.5);
          const a = smokeAlpha * Math.pow(fade, 0.7) * build * life;
          smk[o4] = smk[o4 + 4] = smoke.r;
          smk[o4 + 1] = smk[o4 + 5] = smoke.g;
          smk[o4 + 2] = smk[o4 + 6] = smoke.b;
          smk[o4 + 3] = smk[o4 + 7] = a;
        } else {
          for (let c = 0; c < 8; c++) smk[o4 + c] = 0;
        }
        v += 2;
      }
      for (let k = 0; k < n - 1; k++) {
        const a = base + 2 * k;
        idx[ii++] = a;
        idx[ii++] = a + 1;
        idx[ii++] = a + 2;
        idx[ii++] = a + 1;
        idx[ii++] = a + 3;
        idx[ii++] = a + 2;
      }
    }
    publishRange(this.posAttr, v * 3);
    publishRange(this.colAttr, v * 3);
    publishRange(this.smokeAttr, v * 4);
    publishRange(this.effAttr, v * 2);
    publishRange(this.idxAttr, ii);
    this.mesh.geometry.setDrawRange(0, ii);
    this.mesh.visible = true;
    this.effectRibbons = effectRibbons;
    this.ribbons = ribbons;
    this.samples = v / 2;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.live.clear();
    this.dying = [];
    this.all.length = 0;
    this.liveWarheads = 0;
  }

  /** Grows the buffers (doubling) by swapping in a fresh geometry. */
  private ensure(verts: number, indices: number): void {
    if (verts <= this.vertCap && indices <= this.indexCap) return;
    this.vertCap = nextCapacity(this.vertCap, verts);
    this.indexCap = nextCapacity(this.indexCap, indices);
    this.positions = new Float32Array(this.vertCap * 3);
    this.colors = new Float32Array(this.vertCap * 3);
    this.effect = new Float32Array(this.vertCap * 2);
    this.smoke = new Float32Array(this.vertCap * 4);
    this.index = new Uint32Array(this.indexCap);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3);
    this.smokeAttr = new THREE.BufferAttribute(this.smoke, 4);
    this.effAttr = new THREE.BufferAttribute(this.effect, 2);
    this.idxAttr = new THREE.BufferAttribute(this.index, 1);
    for (const a of [
      this.posAttr,
      this.colAttr,
      this.smokeAttr,
      this.effAttr,
      this.idxAttr,
    ]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    g.setAttribute("position", this.posAttr);
    g.setAttribute("aColor", this.colAttr);
    g.setAttribute("aSmoke", this.smokeAttr);
    g.setAttribute("aEffect", this.effAttr);
    g.setIndex(this.idxAttr);
    const old = this.mesh.geometry;
    this.mesh.geometry = g;
    old.dispose();
  }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export class UnitLayer {
  private readonly group = new THREE.Group();
  /** Shared emissive strength of all unit parts (flickers a little). */
  private readonly glow = { value: 1 };
  private readonly material: THREE.MeshStandardMaterial;
  /** Lot 4: night and lights (null unless the night is on). */
  private readonly night: NightLighting | null;
  /** Model geometry per batch key (`kind` or `kind-lod`); null = no LOD. */
  private readonly templates = new Map<string, THREE.BufferGeometry | null>();
  private readonly batches = new Map<string, InstancedBatch>();
  /** Triangles of one instance, per batch. */
  private readonly batchTris = new Map<InstancedBatch, number>();
  private readonly tracks = new Map<number, UnitTrack>();
  private readonly trails: TrailRenderer;
  /** Effect palette (shared with the ground trails). */
  private readonly effectTrails: EffectTrails;

  private readonly ringTemplate: THREE.BufferGeometry;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly rings: InstancedBatch;
  private selected: ReadonlySet<number> = new Set();
  private readonly shadows: BlobShadows;
  private readonly bars: StatusBars;
  private readonly healthRules: WarshipHealthRules;
  private readonly rails: RailTracks;
  /** Lot 4 ship wakes; null (nothing built) without `?three_wakes=1`. */
  private readonly wakes: WakeRenderer | null;

  private lastTick = Number.NaN;
  private stamp = 0;
  private paletteVersion = -1;
  private lastNowMs = 0;

  // Counters of the last frame (perfStats).
  private drawnUnits = 0;
  private lodUnits = 0;
  private culledUnits = 0;
  private unitTriangles = 0;
  private unitJsMs = 0;
  private nukes = 0;
  private nukesCapped = 0;

  // Scratch objects (no per-frame allocation).
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly fwd = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, "YZX");
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(private readonly ctx: ThreeLayerContext) {
    this.group.name = "units";
    ctx.scene.add(this.group);
    const nightMode = nightModeOf(ctx.settings);
    this.night =
      nightMode !== null ? NightLighting.acquire(ctx, nightMode) : null;
    this.material = createPartMaterial({
      glow: this.glow,
      // Lot 4: night self-light (deck lights, stronger zoomed out), only
      // when the night is on.
      ...(this.night !== null ? { night: this.night.unitUniform } : {}),
    });
    this.effectTrails = EffectTrails.acquire(ctx);
    this.trails = new TrailRenderer(this.group, this.effectTrails);
    this.shadows = new BlobShadows(this.group, "unit-shadows");
    this.bars = new StatusBars(
      this.group,
      ctx.renderSettings.bar,
      "unit-status-bars",
    );
    this.healthRules = warshipHealthRules(ctx.config);
    this.rails = new RailTracks(
      this.group,
      ctx.heightField,
      ctx.mapWidth,
      ctx.mapHeight,
      ctx.settings,
    );
    this.wakes =
      ctx.settings.prototypes?.wakes === true
        ? new WakeRenderer(this.group, ctx, minScreenScale)
        : null;

    // Selection ring: a flat annulus facing up, drawn over everything.
    this.ringTemplate = new THREE.RingGeometry(0.82, 1, 48).rotateX(
      -Math.PI / 2,
    );
    this.ringMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.rings = new InstancedBatch(
      this.group,
      this.ringTemplate,
      this.ringMaterial,
      "unit-selection",
      8,
      30,
    );
  }

  updateUnits(units: ReadonlyMap<number, UnitState>, gameTick: number): void {
    const newTick = gameTick !== this.lastTick;
    this.lastTick = gameTick;
    const stamp = ++this.stamp;
    const W = this.ctx.mapWidth;
    const palette = this.ctx.palette;
    const recolor = palette.version !== this.paletteVersion;
    this.paletteVersion = palette.version;

    for (const u of units.values()) {
      if (!u.isActive || u.waitTicks > 0) continue;
      const kind = unitMeshKindFor(u);
      if (kind === null) continue;
      const px = (u.pos % W) + 0.5;
      const py = Math.floor(u.pos / W) + 0.5;
      let tr = this.tracks.get(u.id);
      if (tr === undefined) {
        tr = this.createTrack(u, kind, px, py);
        this.tracks.set(u.id, tr);
      } else {
        if (newTick) {
          const moved = px !== tr.toX || py !== tr.toY;
          let fx = tr.dispX;
          let fy = tr.dispY;
          if (Math.hypot(px - fx, py - fy) > TELEPORT_TILES) {
            fx = px;
            fy = py;
          }
          tr.fromX = fx;
          tr.fromY = fy;
          tr.continuous = moved && tr.movedLastTick;
          tr.movedLastTick = moved;
        }
        tr.toX = px;
        tr.toY = py;
        if (tr.kind !== kind) tr.kind = kind;
        if (recolor || tr.owner !== u.ownerID) {
          tr.owner = u.ownerID;
          setOwnerColor(tr.color, palette.data, tr.owner, UNIT_LIGHTEN);
        }
      }
      tr.stamp = stamp;
      tr.targetable = u.targetable;
      tr.targetUnitId = u.targetUnitId;
      tr.health = u.health;
      tr.veterancy = u.veterancy;
      if (u.targetTile !== null) {
        tr.targetX = (u.targetTile % W) + 0.5;
        tr.targetY = Math.floor(u.targetTile / W) + 0.5;
      }
    }

    for (const [id, tr] of this.tracks) {
      if (tr.stamp === stamp) continue;
      if (tr.trail !== null) this.trails.retire(tr.trail, this.lastNowMs);
      this.tracks.delete(id);
    }
  }

  setSelectedUnits(ids: readonly number[]): void {
    this.selected = new Set(ids);
  }

  /** Railroad tile state changed (see the file comment). */
  setRailroads(state: Uint8Array): void {
    this.rails.set(state);
  }

  update(frame: FrameInfo): void {
    const t0 = performance.now();
    const now = frame.nowMs;
    this.lastNowMs = now;
    const t = now / 1000;
    const zoom = frame.cssPxPerTile;
    const minPx = this.ctx.settings.unitMinScreenPx;
    const hf = this.ctx.heightField;
    const glowScale = unitGlowAtZoom(zoom);
    this.glow.value =
      (1 + 0.1 * Math.sin(t * 23) + 0.07 * Math.sin(t * 37)) * glowScale;
    const barFade = smoothstep(BAR_FADE_ZOOM[0], BAR_FADE_ZOOM[1], zoom);
    const pulse = 1 + 0.15 * Math.sin(t * 4);

    // View frustum, and depth along the view direction for the LOD.
    const cam = frame.camera;
    this.projScreen.multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const ce = cam.matrixWorld.elements;
    const fwd = this.fwd.set(-ce[8], -ce[9], -ce[10]).normalize();
    const camDepth = ce[12] * fwd.x + ce[13] * fwd.y + ce[14] * fwd.z;
    const focalPx = pxPerTileAtDepth(1, cam.fov, frame.cssHeight);
    const lodPx =
      this.ctx.settings.quality === "low" ? UNIT_LOD_PX_LOW : UNIT_LOD_PX;
    let drawn = 0;
    let lods = 0;
    let culled = 0;
    let nukes = 0;
    let nukesCapped = 0;

    for (const b of this.batches.values()) b.begin();
    this.rings.begin();
    this.shadows.begin();
    this.bars.begin(frame, barFade);

    for (const tr of this.tracks.values()) {
      const info = KIND_INFO[tr.kind];
      const e = tickEase(frame.tickAlpha, tr.continuous);
      const x = tr.fromX + (tr.toX - tr.fromX) * e;
      const y = tr.fromY + (tr.toY - tr.fromY) * e;
      tr.dispX = x;
      tr.dispY = y;

      const mx = tr.toX - tr.fromX;
      const my = tr.toY - tr.fromY;
      if (mx * mx + my * my > 1e-6) {
        tr.targetHeading = Math.atan2(my, mx);
        if (!tr.hasHeading) {
          tr.heading = tr.targetHeading;
          tr.hasHeading = true;
        }
      }
      tr.heading = smoothAngle(
        tr.heading,
        tr.targetHeading,
        frame.dtMs,
        info.tauMs,
      );

      const len = UNIT_MESH_LENGTH[tr.kind];
      let scale = minScreenScale(minPx, zoom, len);
      /** CSS px per tile at the unit (nukes only: its own depth). */
      let pxPerTileHere = 0;
      let wy = 0;
      let pitch = 0;
      let roll = 0;
      let yaw = -tr.heading;
      let stretch = 1;
      /** Height of the model above its path (nukes), tiles. */
      let lift = 0;

      switch (info.motion) {
        case "boat": {
          const [amp, rollAmp, pitchAmp] = info.bob ?? [0, 0, 0];
          const ph = tr.phase;
          wy = amp * scale * Math.sin(t * 1.6 + ph);
          roll = rollAmp * Math.sin(t * 1.1 + ph * 1.3);
          pitch = pitchAmp * Math.sin(t * 1.4 + ph * 0.7);
          break;
        }
        case "train": {
          const ch = Math.cos(tr.heading) * 0.8;
          const sh = Math.sin(tr.heading) * 0.8;
          wy = hf.surfaceAt(x, y) + RAIL_TOP;
          pitch = Math.atan2(
            hf.surfaceAt(x + ch, y + sh) - hf.surfaceAt(x - ch, y - sh),
            1.6,
          );
          if (tr.reversed) yaw += Math.PI;
          break;
        }
        case "nuke": {
          const dO = Math.hypot(x - tr.originX, y - tr.originY);
          let alt: NukeAltitude;
          if (Number.isFinite(tr.targetX)) {
            const dT = Math.hypot(tr.targetX - x, tr.targetY - y);
            const span = Math.hypot(
              tr.targetX - tr.originX,
              tr.targetY - tr.originY,
            );
            alt = nukeAltitude(info.flight ?? NukeFlight.Arc, dO, dT, span);
          } else {
            alt = nukeAltitude(NukeFlight.Climb, dO, 0, 0);
          }
          const air = hf.surfaceAt(x, y) + alt.altitude;
          // Cap the on-screen length at the bomb's own depth: high up it is
          // much closer to the camera than the ground the zoom refers to.
          const depth = x * fwd.x + air * fwd.y + y * fwd.z - camDepth;
          pxPerTileHere = depth > 1e-3 ? focalPx / depth : Infinity;
          scale = capScreenScale(
            scale,
            len,
            pxPerTileHere,
            nukeScreenCapPx(tr.kind, zoom),
          );
          nukes++;
          if (scale < minScreenScale(minPx, zoom, len)) nukesCapped++;
          lift = 0.6 * scale;
          wy = air + lift;
          pitch = Math.atan(alt.slope);
          break;
        }
        case "sam": {
          const ground = hf.surfaceAt(x, y);
          const target =
            tr.targetUnitId !== null
              ? this.tracks.get(tr.targetUnitId)
              : undefined;
          const dO = Math.hypot(x - tr.originX, y - tr.originY);
          if (
            target !== undefined &&
            KIND_INFO[target.kind].motion === "nuke"
          ) {
            // Climb towards the target nuke's current altitude and aim at it.
            const dT = Math.hypot(target.dispX - x, target.dispY - y);
            const p = nukeProgress(dO, dT);
            wy = ground + (target.worldY - ground) * Math.sqrt(p);
            pitch = Math.atan2(target.worldY - wy, Math.max(1, dT));
          } else {
            wy = ground + Math.min(40, 0.6 * dO) + 0.5;
            pitch = 0.5;
          }
          break;
        }
        case "shell":
          wy = hf.surfaceAt(x, y) + SHELL_ALTITUDE;
          stretch = 1.8;
          break;
      }
      tr.worldY = wy;

      if (info.trail !== undefined) {
        if (tr.trail === null) {
          // Nukes (TrailManager's nuke trails) take their owner's effect.
          // MIRV warheads past the first MAX_FULL_WARHEAD_TRAILS still get
          // a trail, a short one.
          const warhead = tr.kind === "mirvWarhead";
          const short =
            warhead && this.trails.liveWarheads >= MAX_FULL_WARHEAD_TRAILS;
          tr.trail = this.trails.create(
            info.trail,
            tr.color,
            info.motion === "nuke" ? tr.owner : 0,
            warhead,
            short ? WARHEAD_SHORT_TRAIL_POINTS : info.trail.points,
          );
        }
        // Trail starts at the missile's tail: centre − forward·(len/2).
        const cp = Math.cos(pitch);
        const back = (len / 2) * scale * 0.9;
        let halfWidth = info.trail.width * 0.5 * scale;
        if (info.motion === "nuke" && pxPerTileHere > 0) {
          // Readable at every zoom: at least `minPx` wide.
          halfWidth = Math.max(
            halfWidth,
            (0.5 * (info.trail.minPx ?? 0)) / pxPerTileHere,
          );
        }
        this.trails.track(
          tr.trail,
          now,
          x,
          wy - lift,
          y,
          Math.cos(tr.heading) * cp,
          Math.sin(pitch),
          Math.sin(tr.heading) * cp,
          back,
          lift,
          tr.heading,
          halfWidth,
          info.motion === "nuke" && pxPerTileHere > 0
            ? NUKE_HEAD_GLOW_PX / pxPerTileHere
            : 0,
        );
      }

      // Off-screen: no model, shadow, bars or ring (the trail keeps going).
      const radius = 0.6 * len * scale * stretch + 0.5;
      if (!sphereInFrustum(planes, x, wy, y, radius)) {
        culled++;
        continue;
      }
      const depth = x * fwd.x + wy * fwd.y + y * fwd.z - camDepth;
      const lengthPx = depth > 1e-6 ? (len * scale * focalPx) / depth : 1e9;
      const lod = lengthPx < lodPx && this.lodTemplate(tr.kind) !== null;

      this.p.set(x, wy, y);
      this.e.set(roll, yaw, pitch, "YZX");
      this.q.setFromEuler(this.e);
      this.s.set(scale * stretch, scale, scale);
      this.m.compose(this.p, this.q, this.s);
      this.batchFor(tr.kind, lod).push(
        this.m,
        tr.color,
        tr.targetable ? 1 : 0.6,
      );
      drawn++;
      if (lod) lods++;

      if (info.shadow !== undefined) {
        const [sl, sw, sh, sa] = info.shadow;
        const [ox, oz] = shadowOffset(sh * len * scale);
        const base = info.motion === "boat" ? 0 : wy;
        this.shadows.push(
          x + ox,
          base + SHADOW_LIFT,
          y + oz,
          sl * len * scale,
          sw * len * scale,
          yaw,
          sa,
        );
      }

      if (barFade > 0 && tr.kind === "warship") {
        this.pushWarshipBars(tr, x, wy, y, len * scale * zoom);
      }

      if (this.selected.has(tr.id)) {
        const r = 0.62 * len * scale * (1 + 0.04 * Math.sin(t * 4));
        this.p.set(x, Math.max(0, wy) + 0.15, y);
        this.q.identity();
        this.s.set(r, 1, r);
        this.m.compose(this.p, this.q, this.s);
        setOwnerColor(
          this.c,
          this.ctx.palette.data,
          tr.owner,
          SELECTION_LIGHTEN,
        );
        this.c.multiplyScalar(SELECTION_GLOW * pulse);
        this.rings.push(this.m, this.c);
      }
    }

    let tris = 0;
    for (const b of this.batches.values()) {
      b.end();
      tris += b.count * (this.batchTris.get(b) ?? 0);
    }
    this.rings.end();
    this.shadows.end();
    this.bars.end();
    if (this.wakes !== null) {
      this.wakes.update(frame, this.tracks.values(), this.frustum);
    }
    this.trails.update(now, frame.altView, glowScale);
    this.drawnUnits = drawn;
    this.lodUnits = lods;
    this.culledUnits = culled;
    this.unitTriangles = tris;
    this.nukes = nukes;
    this.nukesCapped = nukesCapped;
    this.unitJsMs = performance.now() - t0;
    this.rails.update(frame);
  }

  /**
   * Counters for the facade's perf tool (picked up by duck typing): railway
   * pieces / triangles / blocks / JS time (see `RailStats`), the units
   * drawn this frame and the nuke ribbons drawn in effect colours.
   */
  perfStats(): Record<string, number> {
    const r = this.rails.stats();
    return {
      railPieces: r.pieces,
      railDetailPieces: r.detailPieces,
      railTriangles: r.triangles,
      railBlocks: r.blocks,
      railDetailBlocks: r.detailBlocks,
      railBlocksRebuiltLastFrame: r.blocksRebuilt,
      railBlocksPending: r.blocksPending,
      railJsMs: r.jsMs,
      railJsMsMax: r.jsMsMax,
      railUploadKB: r.uploadBytes / 1024,
      unitInstances: this.drawnUnits,
      unitLodInstances: this.lodUnits,
      unitCulled: this.culledUnits,
      unitTriangles: this.unitTriangles,
      unitJsMs: this.unitJsMs,
      nukeEffectRibbons: this.trails.effectRibbons,
      nukesInFlight: this.nukes,
      nukesScreenCapped: this.nukesCapped,
      trailRibbons: this.trails.ribbons,
      trailSamples: this.trails.samples,
      warheadTrails: this.trails.liveWarheads,
      // Lot 4 wakes (`?three_wakes=1` only).
      ...this.wakes?.stats(),
    };
  }

  /**
   * Health bar (when damaged) and veterancy pips above a warship whose
   * model is `lengthPx` CSS px long: the bar is half that (20..70 px), the
   * gold pips stack upwards at its right end.
   */
  private pushWarshipBars(
    tr: UnitTrack,
    x: number,
    wy: number,
    y: number,
    lengthPx: number,
  ): void {
    const value = healthBarValue(tr.health, tr.veterancy, this.healthRules);
    if (value === null && tr.veterancy <= 0) return;
    const { w, h } = barSize(lengthPx, 0.5, 20, 70);
    const dy = Math.min(36, Math.max(10, 0.2 * lengthPx));
    const top = wy + 0.6;
    if (value !== null) this.bars.bar(x, top, y, 0, dy, w, h, value);
    const pipH = Math.max(2, Math.round(h * 0.45));
    for (let k = 0; k < Math.min(tr.veterancy, 5); k++) {
      const py = dy - h / 2 + pipH / 2 + k * (pipH + 1);
      this.bars.pip(x, top, y, w / 2 + 2 + h / 2, py, h + 1, pipH);
    }
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    this.batchTris.clear();
    for (const g of this.templates.values()) g?.dispose();
    this.templates.clear();
    this.rings.dispose();
    this.ringTemplate.dispose();
    this.ringMaterial.dispose();
    this.shadows.dispose();
    this.bars.dispose();
    this.rails.dispose();
    this.wakes?.dispose();
    this.trails.dispose();
    this.effectTrails.release();
    this.material.dispose();
    this.night?.release();
    this.tracks.clear();
    this.ctx.scene.remove(this.group);
  }

  private createTrack(
    u: UnitState,
    kind: UnitMeshKind,
    px: number,
    py: number,
  ): UnitTrack {
    const W = this.ctx.mapWidth;
    let fx = px;
    let fy = py;
    if (u.lastPos !== u.pos && u.lastPos >= 0) {
      const lx = (u.lastPos % W) + 0.5;
      const ly = Math.floor(u.lastPos / W) + 0.5;
      if (Math.hypot(px - lx, py - ly) <= TELEPORT_TILES) {
        fx = lx;
        fy = ly;
      }
    }
    const moved = fx !== px || fy !== py;
    const heading = moved ? Math.atan2(py - fy, px - fx) : 0;
    const color = setOwnerColor(
      new THREE.Color(),
      this.ctx.palette.data,
      u.ownerID,
      UNIT_LIGHTEN,
    );
    return {
      id: u.id,
      kind,
      owner: u.ownerID,
      color,
      fromX: fx,
      fromY: fy,
      toX: px,
      toY: py,
      dispX: fx,
      dispY: fy,
      worldY: 0,
      movedLastTick: moved,
      continuous: false,
      heading,
      targetHeading: heading,
      hasHeading: moved,
      phase: phaseFor(u.id),
      reversed: u.trainType === TrainType.TailEngine,
      stamp: 0,
      targetable: u.targetable,
      targetUnitId: u.targetUnitId,
      health: u.health,
      veterancy: u.veterancy,
      originX: fx,
      originY: fy,
      targetX: Number.NaN,
      targetY: Number.NaN,
      trail: null,
      wake: null,
    };
  }

  /** The low-poly model of `kind` (built once), or null if it has none. */
  private lodTemplate(kind: UnitMeshKind): THREE.BufferGeometry | null {
    const key = LOD_KEY[kind];
    let template = this.templates.get(key);
    if (template === undefined) {
      template = createUnitLodGeometry(kind);
      this.templates.set(key, template);
    }
    return template;
  }

  private batchFor(kind: UnitMeshKind, lod = false): InstancedBatch {
    const key = lod ? LOD_KEY[kind] : kind;
    let batch = this.batches.get(key);
    if (batch === undefined) {
      let template = lod ? this.lodTemplate(kind) : this.templates.get(key);
      if (template === undefined || template === null) {
        template = createUnitGeometry(kind);
        this.templates.set(key, template);
      }
      batch = new InstancedBatch(
        this.group,
        template,
        this.material,
        `units-${key}`,
        kind === "mirvWarhead" ? 512 : 32,
      );
      this.batches.set(key, batch);
      this.batchTris.set(batch, triangleCount(template));
    }
    return batch;
  }
}
