/**
 * SAM range rings: the 3D port of the default renderer's `SAMRadiusPass`
 * (gl/passes/SamRadiusPass.ts), draped on the relief.
 *
 * Same semantics as the default renderer:
 * - Shown while a ghost of a SAM launcher, missile silo, city, atom or
 *   hydrogen bomb is being placed, or while the build bar highlights SAM
 *   launchers or bombs (`setGhostType` / `setHighlightTypes`).
 * - One dashed, rotating circle of `samRange(level)` tiles around every
 *   active SAM launcher, coloured from the local player's point of view:
 *   self green, allies and teammates yellow, others red (the default's
 *   "perspective" mode). Circles of one group (friendly / enemy) are merged
 *   by circle union: only the arcs no other circle of the group covers are
 *   drawn. The default's "owner" colour mode (palette colours, groups from
 *   the alliance clusters, outlined dashes) is ported too, though nothing
 *   switches the default renderer to it.
 * - A SAM being upgraded shows its growing operating radius plus the target
 *   radius (and the rest of its group gets a faint preview ring), refreshed
 *   at 20 Hz from the interpolated tick.
 * - Look from render-settings `samRadius` (stroke 1.5 tiles each side, dashes
 *   12 on / 6 off tiles, 14 tiles/s rotation, alpha 0.8).
 *
 * 3D: every arc is a ribbon 4 tiles wide (the stroke plus its 0.5-tile
 * smoothing) with 5 vertices across, 1 tile apart, in columns every half
 * grid step (at least 1 tile) along the circle; each vertex sits at the
 * drawn surface height (`ReliefSurface.surfaceAt`: the relief triangles, or
 * the sea plane) plus `SAM_RING_LIFT`, with a polygon offset. On the World
 * map that sampling keeps the ribbon above the relief everywhere (measured:
 * never below, under 1 tile above on the sharpest ridges, ~0.4 typical),
 * so rings follow slopes and coasts, never float, never z-fight, and relief
 * in front hides them under tilt. Columns on flat runs (sea, plains) are
 * dropped down to the circle's own polygon resolution (sagitta ≤ 0.05
 * tile). The dash pattern, rotation and anti-aliasing are in the fragment
 * shader, so geometry only changes with the arcs. Heights are cached per
 * circle (centre + radius) until the relief changes.
 *
 * Cost: nothing while hidden (inputs only mark the rings dirty; they are
 * rebuilt when they next show). Visible: one draw call, 8 triangles per
 * ribbon segment (`samRingSegments`).
 */

import * as THREE from "three";
import type { RenderSettings } from "../gl/RenderSettings";
import { samRange } from "../gl/utils/NukeTrajectory";
import { UT_SAM_LAUNCHER, type UnitState } from "../types";
import type { FrameInfo, ReliefSurface } from "./types";

type Rgb = readonly [number, number, number];

/** Ghost types that show the SAM rings (default: SAM_RADIUS_GHOST_TYPES). */
export const SAM_RING_GHOST_TYPES: ReadonlySet<string> = new Set([
  "Missile Silo",
  "SAM Launcher",
  "City",
  "Atom Bomb",
  "Hydrogen Bomb",
]);

/** Build-bar highlight types that show them (SAM_RADIUS_HIGHLIGHT_TYPES). */
export const SAM_RING_HIGHLIGHT_TYPES: ReadonlySet<string> = new Set([
  "SAM Launcher",
  "Atom Bomb",
  "Hydrogen Bomb",
]);

/** Relationship colours of the default renderer (sRGB = linear at 0 / 1). */
export const SAM_COLOR_SELF: Rgb = [0, 1, 0];
export const SAM_COLOR_ALLY: Rgb = [1, 1, 0];
export const SAM_COLOR_ENEMY: Rgb = [1, 0, 0];

/** The default renderer's fixed tick length for the upgrade animation. */
const TICK_INTERVAL_MS = 100;
/** Geometry refresh while a SAM upgrade animates (default: 20 Hz). */
export const SAM_UPGRADE_REFRESH_MS = 50;
/** Ribbon half-width beyond the stroke: the default's 0.5-tile smoothing. */
const RING_AA = 0.5;
/** Lift above the drawn surface (tiles), on top of the polygon offset. */
export const SAM_RING_LIFT = 0.4;
/** Fewest samples around a circle. */
const MIN_RING_SAMPLES = 24;
/** Vertices across a ribbon (inner edge … outer edge). */
export const RING_LINES = 5;
/** Height error tolerated when dropping columns on flat runs (tiles). */
const FLAT_TOLERANCE = 0.02;
/** Largest chord sagitta of the ribbon polygon (tiles). */
const MAX_SAGITTA = 0.05;

const TWO_PI = Math.PI * 2;
const EPS = 1e-9;

export type Interval = [number, number];

export interface SamCircle {
  /** Centre in world tiles (tile centre). */
  x: number;
  y: number;
  radius: number;
  /** Linear rgb. */
  color: Rgb;
  alpha: number;
  /** Union group: circles only merge within a group. */
  group: number;
  /** 1 = dashes rotate, 0 = static. */
  spin: number;
}

/** One visible arc of a circle, angles in [0, 2π]. */
export interface SamArc {
  circle: SamCircle;
  start: number;
  end: number;
}

/** Who sees what: the local player's point of view. */
export interface SamViewInputs {
  localPlayer: number;
  allies: ReadonlySet<number>;
  /** "perspective" (default renderer) or "owner" (palette colours). */
  colorMode: "perspective" | "owner";
  /** Alliance clusters (owner → cluster id), used in "owner" mode. */
  clusters: ReadonlyMap<number, number>;
  /** Palette (row 0 = sRGB territory colours), used in "owner" mode. */
  palette: Float32Array | null;
}

// ---------------------------------------------------------------------------
// Circle union (SamRadiusPass's math)
// ---------------------------------------------------------------------------

function normalizeAngle(a: number): number {
  while (a < 0) a += TWO_PI;
  while (a >= TWO_PI) a -= TWO_PI;
  return a;
}

/** Union of angle intervals (wrapping ones split at 0), sorted. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const flat: Interval[] = [];
  for (const [s, e] of intervals) {
    const ns = normalizeAngle(s);
    const ne = normalizeAngle(e);
    if (ne < ns) {
      flat.push([ns, TWO_PI], [0, ne]);
    } else {
      flat.push([ns, ne]);
    }
  }
  flat.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  let cur: Interval = [flat[0][0], flat[0][1]];
  for (let i = 1; i < flat.length; i++) {
    const it = flat[i];
    if (it[0] <= cur[1] + EPS) {
      cur[1] = Math.max(cur[1], it[1]);
    } else {
      merged.push(cur);
      cur = [it[0], it[1]];
    }
  }
  merged.push(cur);
  return merged;
}

/** Arcs of `a` that no other circle of `circles` covers. */
export function uncoveredArcs(
  a: SamCircle,
  circles: readonly SamCircle[],
): Interval[] {
  const covered: Interval[] = [];
  for (const b of circles) {
    if (a === b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dSq = dx * dx + dy * dy;
    if (dSq <= EPS) continue;
    // `a` inside `b`: nothing of it shows.
    const diff = b.radius - a.radius;
    if (diff >= 0 && dSq <= diff * diff + EPS) return [];
    // Disjoint.
    const maxDist = a.radius + b.radius;
    if (dSq >= maxDist * maxDist - EPS) continue;
    const d = Math.sqrt(dSq);
    const cosPhi =
      (a.radius * a.radius + dSq - b.radius * b.radius) / (2 * a.radius * d);
    const phi = Math.acos(Math.max(-1, Math.min(1, cosPhi)));
    const theta = Math.atan2(dy, dx);
    covered.push([theta - phi, theta + phi]);
  }
  const merged = mergeIntervals(covered);
  if (merged.length === 0) return [[0, TWO_PI]];
  const out: Interval[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor + EPS) out.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < TWO_PI - EPS) out.push([cursor, TWO_PI]);
  return out;
}

/** Visible arcs of all circles, merged per group. */
export function samArcs(circles: readonly SamCircle[]): SamArc[] {
  const groups = new Map<number, SamCircle[]>();
  for (const c of circles) {
    let g = groups.get(c.group);
    if (g === undefined) {
      g = [];
      groups.set(c.group, g);
    }
    g.push(c);
  }
  const arcs: SamArc[] = [];
  for (const g of [...groups.keys()].sort((a, b) => a - b)) {
    const list = groups.get(g)!;
    for (const c of list) {
      for (const [start, end] of uncoveredArcs(c, list)) {
        arcs.push({ circle: c, start, end });
      }
    }
  }
  return arcs;
}

// ---------------------------------------------------------------------------
// Circles from structures (SamRadiusPass.collectSAMCircles)
// ---------------------------------------------------------------------------

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function circleColor(ownerID: number, view: SamViewInputs): Rgb {
  if (view.colorMode === "owner" && view.palette !== null) {
    const off = ownerID * 4;
    if (off + 2 < view.palette.length) {
      return [
        srgbChannelToLinear(view.palette[off]),
        srgbChannelToLinear(view.palette[off + 1]),
        srgbChannelToLinear(view.palette[off + 2]),
      ];
    }
  }
  return ownerID === view.localPlayer
    ? SAM_COLOR_SELF
    : view.allies.has(ownerID)
      ? SAM_COLOR_ALLY
      : SAM_COLOR_ENEMY;
}

function baseGroup(u: UnitState, friendly: boolean, view: SamViewInputs) {
  return view.colorMode === "owner"
    ? (view.clusters.get(u.ownerID) ?? u.ownerID)
    : friendly
      ? 0
      : 1;
}

function isUpgrading(u: UnitState, tick: number): boolean {
  const start = u.samUpgradeStartTick;
  const duration = u.samUpgradeDuration ?? 0;
  return start !== null && tick >= start && tick - start < duration;
}

/**
 * The circles to draw at the continuous (interpolated) tick, and whether a
 * SAM upgrade is animating (the circles then change over time).
 */
export function collectSamCircles(
  sams: Iterable<UnitState>,
  mapW: number,
  tick: number,
  view: SamViewInputs,
): { circles: SamCircle[]; upgrading: boolean } {
  const list: UnitState[] = [];
  for (const u of sams) {
    if (u.unitType === UT_SAM_LAUNCHER && u.isActive) list.push(u);
  }
  const friendlyOf = (u: UnitState) =>
    u.ownerID === view.localPlayer || view.allies.has(u.ownerID);
  // Groups with an upgrade in progress show a static preview network.
  const upgradingGroups = new Set<number>();
  for (const u of list) {
    if (isUpgrading(u, tick)) {
      upgradingGroups.add(baseGroup(u, friendlyOf(u), view));
    }
  }
  const circles: SamCircle[] = [];
  for (const u of list) {
    const friendly = friendlyOf(u);
    const bg = baseGroup(u, friendly, view);
    const color = circleColor(u.ownerID, view);
    const tx = u.pos % mapW;
    const ty = (u.pos - tx) / mapW;
    const x = tx + 0.5;
    const y = ty + 0.5;
    const active = bg * 2;
    const preview = bg * 2 + 1;
    if (isUpgrading(u, tick)) {
      const start = u.samUpgradeStartTick!;
      const duration = u.samUpgradeDuration ?? 0;
      const progress = Math.max(0, Math.min(1, (tick - start) / duration));
      const target = samRange(u.samUpgradeTargetLevel ?? 0);
      const from = u.samUpgradeStartRange ?? 0;
      circles.push({
        x,
        y,
        radius: from + (target - from) * progress,
        color,
        alpha: friendly ? 1 : 0.35,
        group: active,
        spin: friendly ? 1 : 0,
      });
      circles.push({
        x,
        y,
        radius: target,
        color,
        alpha: friendly ? 0.35 : 1,
        group: preview,
        spin: friendly ? 0 : 1,
      });
    } else {
      circles.push({
        x,
        y,
        radius: samRange(u.level),
        color,
        alpha: 1,
        group: active,
        spin: 1,
      });
      if (upgradingGroups.has(bg)) {
        circles.push({
          x,
          y,
          radius: samRange(u.level),
          color,
          alpha: friendly ? 0.35 : 1,
          group: preview,
          spin: friendly ? 0 : 1,
        });
      }
    }
  }
  return { circles, upgrading: upgradingGroups.size > 0 };
}

/** Key of everything about a SAM launcher that changes its rings. */
function samKey(u: UnitState): string {
  return `${u.id}:${u.pos}:${u.level}:${u.ownerID}:${u.isActive ? 1 : 0}:${u.samUpgradeStartTick}:${u.samUpgradeStartRange}:${u.samUpgradeTargetLevel}:${u.samUpgradeDuration}`;
}

// ---------------------------------------------------------------------------
// Draped ribbons
// ---------------------------------------------------------------------------

/** Heights of one circle's ribbon, sampled around the whole circle. */
export interface RingSamples {
  /** Samples around the circle (sample n closes it at 2π). */
  n: number;
  /** Surface heights (no lift), RING_LINES per sample, inner to outer. */
  heights: Float32Array;
  /** Ribbon line radii offsets from the circle (tiles), inner to outer. */
  offsets: readonly number[];
  /** Samples kept as columns (always 0 and n), ascending. */
  keep: Int32Array;
}

/** Samples around a circle of radius r with spacing ≈ ds tiles. */
export function ringSampleCount(radius: number, ds: number): number {
  return Math.max(
    MIN_RING_SAMPLES,
    Math.ceil((TWO_PI * radius) / Math.max(0.25, ds)),
  );
}

/** Column spacing along a ring (tiles): half a grid step, at least 1. */
export function ringSampleSpacing(gridStep: number): number {
  return Math.max(1, gridStep / 2);
}

/**
 * Heights of a ribbon of half-width `half` around `c`, every `ds` tiles,
 * and the columns worth keeping: a sample is dropped when every line is
 * straight through it (within FLAT_TOLERANCE) and the chord stays within
 * MAX_SAGITTA of the circle.
 */
export function sampleRing(
  surface: ReliefSurface,
  c: SamCircle,
  half: number,
  ds: number,
): RingSamples {
  const n = ringSampleCount(c.radius, ds);
  const L = RING_LINES;
  const heights = new Float32Array((n + 1) * L);
  const offsets: number[] = [];
  for (let s = 0; s < L; s++) {
    offsets.push(Math.max(-c.radius, -half + (2 * half * s) / (L - 1)));
  }
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * TWO_PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let s = 0; s < L; s++) {
      const r = c.radius + offsets[s];
      heights[k * L + s] = surface.surfaceAt(c.x + ca * r, c.y + sa * r);
    }
  }
  // Longest chord (in samples) within the sagitta limit.
  const maxChord = Math.sqrt(8 * Math.max(1, c.radius + half) * MAX_SAGITTA);
  const maxSkip = Math.max(1, Math.floor(maxChord / ((TWO_PI * c.radius) / n)));
  const keep: number[] = [0];
  let i = 0;
  while (i < n) {
    let j = i + 1;
    // Extend while every sample strictly between i and j + 1 is on the line.
    while (j < n && j + 1 - i <= maxSkip) {
      const jn = j + 1;
      let flat = true;
      for (let m = i + 1; m < jn && flat; m++) {
        const t = (m - i) / (jn - i);
        for (let s = 0; s < L; s++) {
          const h0 = heights[i * L + s];
          const h1 = heights[jn * L + s];
          if (
            Math.abs(heights[m * L + s] - (h0 + (h1 - h0) * t)) > FLAT_TOLERANCE
          ) {
            flat = false;
            break;
          }
        }
      }
      if (!flat) break;
      j = jn;
    }
    keep.push(j);
    i = j;
  }
  return { n, heights, offsets, keep: Int32Array.from(keep) };
}

const RING_VERT = /* glsl */ `
attribute vec4 aRing;   // (radial offset from the ring line, arc position,
                        //  arc length from the arc start, to the arc end)
attribute vec4 aColor;  // linear rgb + alpha
attribute float aSpin;
varying vec4 vRing;
varying vec4 vColor;
varying float vSpin;
void main() {
  vRing = aRing;
  vColor = aColor;
  vSpin = aSpin;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** SamRadiusPass's sam-radius.frag.glsl, in ribbon coordinates. */
const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uOutline;
uniform float uStrokeWidth;
uniform float uDashLen;
uniform float uGapLen;
uniform float uRotationSpeed;
uniform float uAlpha;
uniform float uOutlineWidth;
uniform float uOutlineSoftness;
varying vec4 vRing;
varying vec4 vColor;
varying float vSpin;
void main() {
  float d = vRing.x;
  float ringAlpha = smoothstep(-uStrokeWidth - 0.5, -uStrokeWidth, d)
                  * (1.0 - smoothstep(uStrokeWidth, uStrokeWidth + 0.5, d));
  if (ringAlpha < 0.01) discard;
  float period = uDashLen + uGapLen;
  float dashPhase = mod(vRing.y + uTime * uRotationSpeed * vSpin, period);
  float dashAlpha = 1.0 - smoothstep(uDashLen - 0.5, uDashLen + 0.5, dashPhase);
  float alpha = ringAlpha * dashAlpha * uAlpha * vColor.a;
  if (alpha < 0.01) discard;
  float edgeFade = 1.0;
  if (uOutline > 0.5) {
    float ow = uOutlineWidth;
    float soft = uOutlineSoftness;
    edgeFade = min(smoothstep(ow - soft, ow + soft, d + uStrokeWidth),
                   smoothstep(ow - soft, ow + soft, uStrokeWidth - d));
    edgeFade = min(edgeFade, smoothstep(ow - soft, ow + soft, dashPhase));
    edgeFade = min(edgeFade, smoothstep(ow - soft, ow + soft, uDashLen - dashPhase));
    edgeFade = min(edgeFade, smoothstep(ow - soft, ow + soft, vRing.z));
    edgeFade = min(edgeFade, smoothstep(ow - soft, ow + soft, vRing.w));
  }
  gl_FragColor = vec4(vColor.rgb * edgeFade, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Cache key of a circle's ribbon heights. */
function ringKey(c: SamCircle): string {
  return `${c.x},${c.y},${c.radius}`;
}

/**
 * JS budget per frame for sampling new circles (the first build of a late
 * game's ~60 launchers takes ~15 ms of sampling: spread over a few frames).
 */
export const SAM_SAMPLE_BUDGET_MS = 2;

/** Arc-end distance used for full circles (no arc ends to outline). */
const NO_ARC_END = 1e4;

export interface SamRingStats {
  /** Circles still waiting for their heights (sampled over frames). */
  pendingCircles: number;
  circles: number;
  arcs: number;
  segments: number;
  vertices: number;
  rebuilds: number;
  buildMs: number;
  buildMsMax: number;
}

/**
 * The SAM range rings of OverlayLayer: inputs from the facade, geometry
 * rebuilt lazily (only while visible), one draped mesh.
 */
export class SamRangeRings {
  readonly mesh: THREE.Mesh;
  /** JS per frame for sampling new circles (tests may lift it). */
  sampleBudgetMs = SAM_SAMPLE_BUDGET_MS;
  private readonly material: THREE.ShaderMaterial;
  private readonly cache = new Map<string, RingSamples>();
  private cacheVersion = -1;
  private cacheHalf = -1;

  // Inputs.
  private sams: UnitState[] = [];
  private samSignature = "";
  private localPlayer = 0;
  private allies: ReadonlySet<number> = new Set();
  private clusters: ReadonlyMap<number, number> = new Map();
  private colorMode: "perspective" | "owner" = "perspective";
  private paletteVersion = -1;
  private ghostVisible = false;
  private highlightVisible = false;
  private tick = 0;
  private tickMs = performance.now();

  // State.
  private dirty = true;
  private upgrading = false;
  private lastBuildMs = -Infinity;
  private builtVersion = -1;

  // Buffers (grown by doubling).
  private vertCap = 0;
  private indexCap = 0;
  private positions = new Float32Array(0);
  private ring = new Float32Array(0);
  private colors = new Float32Array(0);
  private spins = new Float32Array(0);
  private index = new Uint32Array(0);

  private readonly stats: SamRingStats = {
    pendingCircles: 0,
    circles: 0,
    arcs: 0,
    segments: 0,
    vertices: 0,
    rebuilds: 0,
    buildMs: 0,
    buildMsMax: 0,
  };

  constructor(
    parent: THREE.Object3D,
    private readonly surface: ReliefSurface,
    private readonly mapW: number,
    private readonly settings: RenderSettings["samRadius"],
    private readonly palette: { data: Float32Array; version: number } | null,
    renderOrder: number,
  ) {
    this.material = new THREE.ShaderMaterial({
      name: "three-sam-rings",
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOutline: { value: 0 },
        uStrokeWidth: { value: settings.strokeWidth },
        uDashLen: { value: settings.dashLen },
        uGapLen: { value: settings.gapLen },
        uRotationSpeed: { value: settings.rotationSpeed },
        uAlpha: { value: settings.alpha },
        uOutlineWidth: { value: settings.outlineWidth },
        uOutlineSoftness: { value: settings.outlineSoftness },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = "sam-rings";
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Whether the rings are wanted (build mode / highlight), data aside. */
  get wanted(): boolean {
    return this.ghostVisible || this.highlightVisible;
  }

  /** All units (the facade's structure map): SAM launchers are kept. */
  setStructures(units: ReadonlyMap<number, UnitState>): void {
    const sams: UnitState[] = [];
    let sig = "";
    for (const u of units.values()) {
      if (u.unitType !== UT_SAM_LAUNCHER) continue;
      sams.push(u);
      sig += samKey(u) + ";";
    }
    this.sams = sams;
    if (sig !== this.samSignature) {
      this.samSignature = sig;
      this.dirty = true;
    }
  }

  setLocalPlayer(id: number): void {
    if (id === this.localPlayer) return;
    this.localPlayer = id;
    this.dirty = true;
  }

  /** Allies and teammates of the local player (copied when it changed). */
  setAllies(allies: ReadonlySet<number>): void {
    if (sameSet(allies, this.allies)) return;
    this.allies = new Set(allies);
    this.dirty = true;
  }

  setAllianceClusters(clusters: ReadonlyMap<number, number>): void {
    if (this.colorMode !== "owner") {
      this.clusters = clusters;
      return;
    }
    if (sameMap(clusters, this.clusters)) return;
    this.clusters = new Map(clusters);
    this.dirty = true;
  }

  /** "owner" colours by palette and groups by alliance cluster. */
  setColorMode(mode: "perspective" | "owner"): void {
    if (mode === this.colorMode) return;
    this.colorMode = mode;
    this.material.uniforms.uOutline.value = mode === "owner" ? 1 : 0;
    this.dirty = true;
  }

  setTick(tick: number, nowMs = performance.now()): void {
    if (tick === this.tick) return;
    this.tick = tick;
    this.tickMs = nowMs;
  }

  /** The ghost being placed (null = none). */
  setGhostType(type: string | null): void {
    this.ghostVisible = type !== null && SAM_RING_GHOST_TYPES.has(type);
  }

  /** The build bar's highlighted structure types (null = none). */
  setHighlightTypes(types: readonly string[] | null): void {
    this.highlightVisible =
      types !== null && types.some((t) => SAM_RING_HIGHLIGHT_TYPES.has(t));
  }

  update(frame: FrameInfo): void {
    if (!this.wanted) {
      this.mesh.visible = false;
      return;
    }
    const now = frame.nowMs;
    if (
      this.colorMode === "owner" &&
      this.palette !== null &&
      this.palette.version !== this.paletteVersion
    ) {
      this.dirty = true;
    }
    if (this.surface.version !== this.builtVersion) this.dirty = true;
    if (
      this.dirty ||
      (this.upgrading && now - this.lastBuildMs >= SAM_UPGRADE_REFRESH_MS)
    ) {
      this.rebuild(now);
    }
    this.material.uniforms.uTime.value = (now / 1000) % 3600;
    this.mesh.visible = this.stats.segments > 0;
  }

  perfStats(): SamRingStats {
    return { ...this.stats };
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.cache.clear();
  }

  // ---- Internals ----

  private continuousTick(now: number): number {
    const sub = Math.min(
      1,
      Math.max(0, (now - this.tickMs) / TICK_INTERVAL_MS),
    );
    return this.tick + sub;
  }

  private rebuild(now: number): void {
    const t0 = performance.now();
    this.lastBuildMs = now;
    if (this.palette !== null) this.paletteVersion = this.palette.version;
    const { circles, upgrading } = collectSamCircles(
      this.sams,
      this.mapW,
      this.continuousTick(now),
      {
        localPlayer: this.localPlayer,
        allies: this.allies,
        colorMode: this.colorMode,
        clusters: this.clusters,
        palette: this.palette?.data ?? null,
      },
    );
    this.upgrading = upgrading;
    // Heights first, within the per-frame budget: until every circle is
    // sampled, the rings already drawn stay and this continues next frame.
    const pending = this.sampleCircles(circles, t0);
    this.stats.pendingCircles = pending;
    const ms0 = performance.now() - t0;
    this.stats.buildMs = ms0;
    this.stats.buildMsMax = Math.max(this.stats.buildMsMax, ms0);
    if (pending > 0) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const arcs = samArcs(circles);
    this.buildGeometry(circles, arcs);
    const ms = performance.now() - t0;
    this.stats.rebuilds++;
    this.stats.buildMs = ms;
    this.stats.buildMsMax = Math.max(this.stats.buildMsMax, ms);
  }

  /**
   * Samples the circles not cached yet, until `sampleBudgetMs` has passed
   * since `t0` (at least one per call). Returns how many are left.
   */
  private sampleCircles(circles: readonly SamCircle[], t0: number): number {
    const surface = this.surface;
    const half = this.settings.strokeWidth + RING_AA;
    if (surface.version !== this.cacheVersion || half !== this.cacheHalf) {
      this.cache.clear();
      this.cacheVersion = surface.version;
      this.cacheHalf = half;
    }
    const ds = ringSampleSpacing(surface.grid.step);
    let sampled = 0;
    let pending = 0;
    for (const c of circles) {
      const key = ringKey(c);
      if (this.cache.has(key)) continue;
      if (sampled > 0 && performance.now() - t0 > this.sampleBudgetMs) {
        pending++;
        continue;
      }
      this.cache.set(key, sampleRing(surface, c, half, ds));
      sampled++;
    }
    return pending;
  }

  private buildGeometry(circles: SamCircle[], arcs: SamArc[]): void {
    this.builtVersion = this.surface.version;
    // Drop cached circles no longer drawn.
    const live = new Set<string>();
    for (const c of circles) live.add(ringKey(c));
    for (const k of this.cache.keys()) if (!live.has(k)) this.cache.delete(k);

    // Columns per arc: its two ends plus the kept samples strictly inside.
    const L = RING_LINES;
    const plan: { arc: SamArc; s: RingSamples; q0: number; q1: number }[] = [];
    let columns = 0;
    let segments = 0;
    for (const arc of arcs) {
      if (!(arc.end > arc.start)) continue;
      const s = this.cache.get(ringKey(arc.circle))!;
      const step = TWO_PI / s.n;
      // keep[q0 .. q1] lie strictly inside (start, end).
      let q0 = 0;
      while (q0 < s.keep.length && s.keep[q0] * step <= arc.start + EPS) q0++;
      let q1 = s.keep.length - 1;
      while (q1 >= 0 && s.keep[q1] * step >= arc.end - EPS) q1--;
      const inner = Math.max(0, q1 - q0 + 1);
      plan.push({ arc, s, q0, q1 });
      columns += inner + 2;
      segments += inner + 1;
    }
    this.stats.circles = circles.length;
    this.stats.arcs = plan.length;
    this.stats.segments = segments;
    this.stats.vertices = columns * L;
    if (segments === 0) {
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    this.ensure(columns * L, segments * (L - 1) * 6);

    let v = 0;
    let ii = 0;
    const pos = this.positions;
    const ring = this.ring;
    const col = this.colors;
    const spin = this.spins;
    const idx = this.index;
    for (let pi = 0; pi < plan.length; pi++) {
      const { arc, s, q0, q1 } = plan[pi];
      const c = arc.circle;
      const full = arc.start <= EPS && arc.end >= TWO_PI - EPS;
      const step = TWO_PI / s.n;
      const heights = s.heights;
      const offsets = s.offsets;
      const cx = c.x;
      const cy = c.y;
      const radius = c.radius;
      const cr = c.color[0];
      const cg = c.color[1];
      const cb = c.color[2];
      const ca = c.alpha;
      const cs = c.spin;
      const firstColumn = v;
      const last = q1 - q0 + 2;
      // Columns: the arc start, the kept samples inside, the arc end. The
      // ends interpolate between the fine samples around them.
      for (let col_i = 0; col_i <= last; col_i++) {
        let a: number;
        let k0: number;
        let f = 0;
        if (col_i === 0 || col_i === last) {
          a = col_i === 0 ? arc.start : arc.end;
          const kf = a / step;
          k0 = Math.min(s.n - 1, Math.max(0, Math.floor(kf)));
          f = kf - k0;
        } else {
          k0 = s.keep[q0 + col_i - 1];
          a = k0 * step;
        }
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        const arcPos = a * radius;
        const fromStart = full ? NO_ARC_END : (a - arc.start) * radius;
        const toEnd = full ? NO_ARC_END : (arc.end - a) * radius;
        const h0i = k0 * L;
        const h1i = h0i + L;
        for (let side = 0; side < L; side++) {
          const h0 = heights[h0i + side];
          const h = f > 0 ? h0 + (heights[h1i + side] - h0) * f : h0;
          const off = offsets[side];
          const r = radius + off;
          const o = v * 3;
          pos[o] = cx + cosA * r;
          pos[o + 1] = h + SAM_RING_LIFT;
          pos[o + 2] = cy + sinA * r;
          const q = v * 4;
          ring[q] = off;
          ring[q + 1] = arcPos;
          ring[q + 2] = fromStart;
          ring[q + 3] = toEnd;
          col[q] = cr;
          col[q + 1] = cg;
          col[q + 2] = cb;
          col[q + 3] = ca;
          spin[v] = cs;
          v++;
        }
      }
      const nCols = (v - firstColumn) / L;
      for (let q = 0; q + 1 < nCols; q++) {
        const a = firstColumn + q * L;
        const b = a + L;
        for (let side = 0; side < L - 1; side++) {
          idx[ii++] = a + side;
          idx[ii++] = b + side;
          idx[ii++] = a + side + 1;
          idx[ii++] = a + side + 1;
          idx[ii++] = b + side;
          idx[ii++] = b + side + 1;
        }
      }
    }
    const g = this.mesh.geometry;
    for (const name of ["position", "aRing", "aColor", "aSpin"]) {
      const attr = g.getAttribute(name) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, v * attr.itemSize);
      attr.needsUpdate = true;
    }
    const index = g.getIndex()!;
    index.clearUpdateRanges();
    index.addUpdateRange(0, ii);
    index.needsUpdate = true;
    g.setDrawRange(0, ii);
  }

  /** Grows the buffers (doubling) with a fresh geometry. */
  private ensure(verts: number, indices: number): void {
    if (verts <= this.vertCap && indices <= this.indexCap) return;
    let vc = Math.max(256, this.vertCap);
    while (vc < verts) vc *= 2;
    let ic = Math.max(1024, this.indexCap);
    while (ic < indices) ic *= 2;
    this.vertCap = vc;
    this.indexCap = ic;
    this.positions = new Float32Array(vc * 3);
    this.ring = new Float32Array(vc * 4);
    this.colors = new Float32Array(vc * 4);
    this.spins = new Float32Array(vc);
    this.index = new Uint32Array(ic);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute("aRing", new THREE.BufferAttribute(this.ring, 4));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.colors, 4));
    g.setAttribute("aSpin", new THREE.BufferAttribute(this.spins, 1));
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    const old = this.mesh.geometry;
    this.mesh.geometry = g;
    old.dispose();
  }
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function sameMap(
  a: ReadonlyMap<number, number>,
  b: ReadonlyMap<number, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
