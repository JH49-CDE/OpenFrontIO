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
 *   `nukeAltitude`) pitched along their 3D velocity and leave a glowing
 *   additive ribbon trail.
 * - Every model is scaled up to at least `settings.unitMinScreenPx` CSS px.
 *
 * Contract notes:
 * - `updateUnits` runs once per sim tick with the FULL unit map (structures
 *   included; skip `!isActive` and `waitTicks > 0`).
 * - `setSelectedUnits([])` clears the selection.
 */

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
  createPartMaterial,
  createUnitGeometry,
  InstancedBatch,
  nextCapacity,
  setOwnerColor,
  UNIT_MESH_LENGTH,
  type UnitMeshKind,
} from "./ProceduralMeshes";
import type { FrameInfo, ThreeLayerContext } from "./types";

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
}

interface KindInfo {
  motion: Motion;
  /** Heading smoothing time constant, ms. */
  tauMs: number;
  flight?: NukeFlight;
  trail?: TrailStyle;
  /** Boat bob amplitude (tiles), roll and pitch amplitudes (radians). */
  bob?: readonly [number, number, number];
}

const WARM_TRAIL = [1.7, 1.0, 0.45] as const;

const KIND_INFO: Readonly<Record<UnitMeshKind, KindInfo>> = {
  transport: { motion: "boat", tauMs: 160, bob: [0.05, 0.06, 0.025] },
  tradeShip: { motion: "boat", tauMs: 200, bob: [0.04, 0.05, 0.02] },
  warship: { motion: "boat", tauMs: 220, bob: [0.03, 0.03, 0.012] },
  trainEngine: { motion: "train", tauMs: 90 },
  trainCarriage: { motion: "train", tauMs: 90 },
  trainLoaded: { motion: "train", tauMs: 90 },
  atomBomb: {
    motion: "nuke",
    tauMs: 110,
    flight: NukeFlight.Arc,
    trail: { points: 40, width: 0.9, color: WARM_TRAIL, ownerMix: 0.3 },
  },
  hydrogenBomb: {
    motion: "nuke",
    tauMs: 110,
    flight: NukeFlight.Arc,
    trail: { points: 40, width: 1.3, color: WARM_TRAIL, ownerMix: 0.3 },
  },
  mirv: {
    motion: "nuke",
    tauMs: 130,
    flight: NukeFlight.Climb,
    trail: { points: 40, width: 1.6, color: WARM_TRAIL, ownerMix: 0.3 },
  },
  mirvWarhead: {
    motion: "nuke",
    tauMs: 80,
    flight: NukeFlight.Dive,
    trail: { points: 12, width: 0.45, color: WARM_TRAIL, ownerMix: 0.3 },
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
  /** Nukes / SAMs: first-seen ground position (launch origin). */
  originX: number;
  originY: number;
  /** Target tile centre, NaN when unknown. */
  targetX: number;
  targetY: number;
  trail: Trail | null;
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
  /** Half width at the head, tiles. */
  halfWidth: number;
  color: THREE.Color;
  diedMs: number;
}

/**
 * All nuke / SAM trails as one additive ribbon mesh, rebuilt every frame.
 * Each trail is a strip of quads from the missile's tail back through its
 * samples, tapering and fading to black (= invisible under additive blending).
 * Ribbons lie flat (their width is horizontal) so they read from above.
 */
class TrailRenderer {
  private readonly material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly mesh: THREE.Mesh;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private index = new Uint32Array(0);
  private posAttr = new THREE.BufferAttribute(this.positions, 3);
  private colAttr = new THREE.BufferAttribute(this.colors, 3);
  private idxAttr = new THREE.BufferAttribute(this.index, 1);
  private vertCap = 0;
  private indexCap = 0;
  private readonly live = new Set<Trail>();
  private dying: Trail[] = [];

  constructor(parent: THREE.Object3D) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = "unit-trails";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.ensure(1024, 3072);
  }

  create(style: TrailStyle, owner: THREE.Color): Trail {
    // style colour × mix(1, owner, ownerMix): a warm glow with a hint of
    // the owner's colour.
    const k = style.ownerMix;
    const color = new THREE.Color(
      style.color[0] * (1 - k + owner.r * k),
      style.color[1] * (1 - k + owner.g * k),
      style.color[2] * (1 - k + owner.b * k),
    );
    const trail: Trail = {
      pts: new Float32Array(style.points * TRAIL_STRIDE),
      max: style.points,
      count: 0,
      head: -1,
      lastSampleMs: -Infinity,
      live: true,
      liveX: 0,
      liveY: 0,
      liveZ: 0,
      liveSX: 0,
      liveSZ: 1,
      halfWidth: style.width / 2,
      color,
      diedMs: 0,
    };
    this.live.add(trail);
    return trail;
  }

  /** The missile is gone: keep the trail fading out for a moment. */
  retire(trail: Trail, nowMs: number): void {
    if (!this.live.delete(trail)) return;
    trail.live = false;
    trail.diedMs = nowMs;
    this.dying.push(trail);
  }

  /**
   * Moves the live head to (x, y, z) (world) and stores a sample every
   * TRAIL_SAMPLE_MS. `heading` (tile-space radians) orients the ribbon width.
   */
  track(
    trail: Trail,
    nowMs: number,
    x: number,
    y: number,
    z: number,
    heading: number,
    halfWidth: number,
  ): void {
    trail.liveX = x;
    trail.liveY = y;
    trail.liveZ = z;
    // Horizontal perpendicular of the heading (cos h, 0, sin h).
    trail.liveSX = -Math.sin(heading);
    trail.liveSZ = Math.cos(heading);
    trail.halfWidth = halfWidth;
    if (nowMs - trail.lastSampleMs < TRAIL_SAMPLE_MS) return;
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

  update(nowMs: number): void {
    this.dying = this.dying.filter((t) => nowMs - t.diedMs < TRAIL_FADE_MS);
    let verts = 0;
    let indices = 0;
    const all: Trail[] = [];
    for (const t of this.live) all.push(t);
    for (const t of this.dying) all.push(t);
    for (const t of all) {
      const n = t.count + (t.live ? 1 : 0);
      if (n < 2) continue;
      verts += 2 * n;
      indices += 6 * (n - 1);
    }
    if (indices === 0) {
      this.mesh.visible = false;
      return;
    }
    this.ensure(verts, indices);
    const pos = this.positions;
    const col = this.colors;
    const idx = this.index;
    let v = 0;
    let ii = 0;
    for (const t of all) {
      const n = t.count + (t.live ? 1 : 0);
      if (n < 2) continue;
      const life = t.live ? 1 : 1 - (nowMs - t.diedMs) / TRAIL_FADE_MS;
      const base = v;
      for (let k = 0; k < n; k++) {
        let x: number, y: number, z: number, sx: number, sz: number;
        if (t.live && k === 0) {
          x = t.liveX;
          y = t.liveY;
          z = t.liveZ;
          sx = t.liveSX;
          sz = t.liveSZ;
        } else {
          const age = t.live ? k - 1 : k;
          const o = ((t.head - age + t.max) % t.max) * TRAIL_STRIDE;
          x = t.pts[o];
          y = t.pts[o + 1];
          z = t.pts[o + 2];
          sx = t.pts[o + 3];
          sz = t.pts[o + 4];
        }
        const fade = 1 - k / (n - 1);
        const hw = t.halfWidth * (0.25 + 0.75 * fade);
        const intensity = fade * Math.sqrt(fade) * life;
        const r = t.color.r * intensity;
        const g = t.color.g * intensity;
        const b = t.color.b * intensity;
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
    publishRange(this.idxAttr, ii);
    this.mesh.geometry.setDrawRange(0, ii);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.live.clear();
    this.dying = [];
  }

  /** Grows the buffers (doubling) by swapping in a fresh geometry. */
  private ensure(verts: number, indices: number): void {
    if (verts <= this.vertCap && indices <= this.indexCap) return;
    this.vertCap = nextCapacity(this.vertCap, verts);
    this.indexCap = nextCapacity(this.indexCap, indices);
    this.positions = new Float32Array(this.vertCap * 3);
    this.colors = new Float32Array(this.vertCap * 3);
    this.index = new Uint32Array(this.indexCap);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3);
    this.idxAttr = new THREE.BufferAttribute(this.index, 1);
    for (const a of [this.posAttr, this.colAttr, this.idxAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    g.setAttribute("position", this.posAttr);
    g.setAttribute("color", this.colAttr);
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
  private readonly glow = { value: 2.2 };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly templates = new Map<UnitMeshKind, THREE.BufferGeometry>();
  private readonly batches = new Map<UnitMeshKind, InstancedBatch>();
  private readonly tracks = new Map<number, UnitTrack>();
  private readonly trails: TrailRenderer;

  private readonly ringTemplate: THREE.BufferGeometry;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly rings: InstancedBatch;
  private selected: ReadonlySet<number> = new Set();

  private lastTick = Number.NaN;
  private stamp = 0;
  private paletteVersion = -1;
  private lastNowMs = 0;

  // Scratch objects (no per-frame allocation).
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, "YZX");
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(private readonly ctx: ThreeLayerContext) {
    this.group.name = "units";
    ctx.scene.add(this.group);
    this.material = createPartMaterial({ glow: this.glow });
    this.trails = new TrailRenderer(this.group);

    // Selection ring: a flat annulus facing up, drawn over everything.
    this.ringTemplate = new THREE.RingGeometry(0.86, 1, 48).rotateX(
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

  update(frame: FrameInfo): void {
    const now = frame.nowMs;
    this.lastNowMs = now;
    const t = now / 1000;
    const zoom = frame.cssPxPerTile;
    const minPx = this.ctx.settings.unitMinScreenPx;
    const hf = this.ctx.heightField;
    this.glow.value = 2.2 + 0.25 * Math.sin(t * 23) + 0.15 * Math.sin(t * 37);

    for (const b of this.batches.values()) b.begin();
    this.rings.begin();

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
      const scale = minScreenScale(minPx, zoom, len);
      let wy = 0;
      let pitch = 0;
      let roll = 0;
      let yaw = -tr.heading;
      let stretch = 1;

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
          wy = hf.surfaceAt(x, y);
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
          wy = hf.surfaceAt(x, y) + alt.altitude + 0.6 * scale;
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

      this.p.set(x, wy, y);
      this.e.set(roll, yaw, pitch, "YZX");
      this.q.setFromEuler(this.e);
      this.s.set(scale * stretch, scale, scale);
      this.m.compose(this.p, this.q, this.s);
      this.batchFor(tr.kind).push(this.m, tr.color, tr.targetable ? 1 : 0.6);

      if (info.trail !== undefined) {
        tr.trail ??= this.trails.create(info.trail, tr.color);
        // Trail starts at the missile's tail: centre − forward·(len/2).
        const cp = Math.cos(pitch);
        const back = (len / 2) * scale * 0.9;
        this.trails.track(
          tr.trail,
          now,
          x - Math.cos(tr.heading) * cp * back,
          wy - Math.sin(pitch) * back,
          y - Math.sin(tr.heading) * cp * back,
          tr.heading,
          info.trail.width * 0.5 * scale,
        );
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
        this.rings.push(this.m, this.c);
      }
    }

    for (const b of this.batches.values()) b.end();
    this.rings.end();
    this.trails.update(now);
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    for (const g of this.templates.values()) g.dispose();
    this.templates.clear();
    this.rings.dispose();
    this.ringTemplate.dispose();
    this.ringMaterial.dispose();
    this.trails.dispose();
    this.material.dispose();
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
      originX: fx,
      originY: fy,
      targetX: Number.NaN,
      targetY: Number.NaN,
      trail: null,
    };
  }

  private batchFor(kind: UnitMeshKind): InstancedBatch {
    let batch = this.batches.get(kind);
    if (batch === undefined) {
      let template = this.templates.get(kind);
      if (template === undefined) {
        template = createUnitGeometry(kind);
        this.templates.set(kind, template);
      }
      batch = new InstancedBatch(
        this.group,
        template,
        this.material,
        `units-${kind}`,
        kind === "mirvWarhead" ? 512 : 32,
      );
      this.batches.set(kind, batch);
    }
    return batch;
  }
}
