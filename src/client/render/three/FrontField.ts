/**
 * FrontField — the data of the living front (lot 4 prototype, only built
 * with `?three_front=1`). Pure bookkeeping: no three, no GL.
 *
 * Fed by TerrainLayer from the same `changedTiles` as the tile uploads, in
 * O(changed tiles) per tick:
 * - **Capture times** (`stamps`, one u16 per tile, the data of the R16UI
 *   texture the terrain shader's capture wave reads): when a tile changes
 *   owner to a player, its stamp is the time of the capture in
 *   `FRONT_TIME_UNIT_MS` units (1..`FRONT_TIME_MOD`, 0 = never), plus
 *   `FRONT_PVP_BIT` when it was taken from another player (a full-strength
 *   wave; expansion into unclaimed land gets a fainter one). The texture is
 *   sent by TerrainLayer with the tile state's own rectangles (the same
 *   cells are dirty), so the wave and the new owner arrive in the same frame.
 *   Stamps wrap after `FRONT_TIME_MOD` units (27 min): a slow sweep zeroes
 *   the cells whose last capture is older than `FRONT_STALE_MS` long before
 *   that (`sweep`, `sweepQueue`), so an old capture never pulses again.
 * - **Border events** (a ring of `FRONT_EVENT_CAPACITY`): at most
 *   `FRONT_EVENTS_PER_TICK` tiles per tick, sampled among the tiles taken
 *   from another player that are still on a border (a 4-neighbour with
 *   another owner): FxLayer's smoke and sparks rise there.
 * - **Front segments** (`segments`): per `FRONT_SEGMENT_CELL`-tile cell
 *   and (attacker, defender) pair, decaying sums of the captures: weight
 *   and attack direction (time constant `FRONT_SEGMENT_TAU_MS`; the
 *   direction is the local owner gradient `captureDirection`: towards the
 *   defender's tiles, away from the attacker's) and the centroid of the
 *   last few ticks (`FRONT_SEGMENT_POS_TAU_MS`, on the front line). `clusterFront` merges them at a
 *   zoom-dependent cell size for OverlayLayer's arrows, keeping the pairs
 *   with an active attack (`setAttacks`, the players' `outgoingAttacks`).
 *
 * The tile state is not kept for owners: `shadow` is a copy of the last
 * tile state seen, so an owner change is told apart from other bit changes
 * (fallout) and the previous owner is exact.
 */

import type { AttackData, PlayerState } from "../types";
import {
  TILE_UPLOAD_CELL,
  type TileUploadBudget,
  TileUploadQueue,
} from "./TileUploadQueue";

/** Capture time unit, ms (stamps are integers in these units). */
export const FRONT_TIME_UNIT_MS = 50;
/** Stamps are 1..FRONT_TIME_MOD (15 bits; they wrap after ~27 min). */
export const FRONT_TIME_MOD = 0x7fff;
/** Stamp flag: the tile was taken from another player. */
export const FRONT_PVP_BIT = 0x8000;
/** Length of the capture wave, ms. */
export const FRONT_PULSE_MS = 1300;
/** Cells whose last capture is older than this are zeroed (< wrap / 2). */
export const FRONT_STALE_MS = 8 * 60_000;
/** A sweep visits every cell once per this many calls (~1 min at 60 FPS). */
export const FRONT_SWEEP_PERIOD = 3600;
/** Uploads of zeroed cells per frame (a few cells a minute in practice). */
export const FRONT_SWEEP_BUDGET: TileUploadBudget = {
  maxCalls: 1,
  maxTexels: 1 << 14,
};
/** Border events kept (smoke / sparks spawn points). */
export const FRONT_EVENT_CAPACITY = 2048;
/**
 * Border events sampled per tick at most: enough that a close-up view of
 * one front still gets a few per tick (FxLayer spawns at most a few per
 * frame, in view).
 */
export const FRONT_EVENTS_PER_TICK = 256;
/** Cell of the front segments, tiles (arrow clusters are multiples). */
export const FRONT_SEGMENT_CELL = 32;
/** Captures folded into segments per tick at most (stride-sampled). */
export const FRONT_SEGMENT_SAMPLES_PER_TICK = 1024;
/** Decay time constant of the segments' weight and direction, ms. */
export const FRONT_SEGMENT_TAU_MS = 2500;
/**
 * Decay time constant of the segments' position, ms: the last few ticks
 * only, so an arrow sits on the front line instead of lagging behind it
 * (a front moving a tile per tick would leave a 2.5 s centroid ~25 tiles
 * behind).
 */
export const FRONT_SEGMENT_POS_TAU_MS = 250;
/** Segments below this decayed weight are dropped. */
export const FRONT_SEGMENT_MIN_WEIGHT = 0.05;
/** Distance (tiles) of the owner samples of `captureDirection`. */
export const FRONT_GRADIENT_REACH = 3;

const OWNER = 0xfff;
const PAIR = 4096;
const INV_SQRT2 = Math.SQRT1_2;
/** The 8 directions of `captureDirection` (unit vectors). */
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [INV_SQRT2, INV_SQRT2],
  [-INV_SQRT2, INV_SQRT2],
  [INV_SQRT2, -INV_SQRT2],
  [-INV_SQRT2, -INV_SQRT2],
];

/** The stamp of a capture at `nowMs` (1..FRONT_TIME_MOD, + the pvp flag). */
export function frontStamp(nowMs: number, pvp: boolean): number {
  const s = (Math.floor(nowMs / FRONT_TIME_UNIT_MS) % FRONT_TIME_MOD) + 1;
  return pvp ? s | FRONT_PVP_BIT : s;
}

/** `nowMs` in stamp units, fractional (the shader's `uFrontNow`). */
export function frontNowUnits(nowMs: number): number {
  return ((nowMs / FRONT_TIME_UNIT_MS) % FRONT_TIME_MOD) + 1;
}

/** Age (ms) of a stamp at `nowUnits` (modular); Infinity for 0. */
export function frontAgeMs(stamp: number, nowUnits: number): number {
  const s = stamp & FRONT_TIME_MOD;
  if (s === 0) return Infinity;
  const d = nowUnits - s;
  return (
    (d - FRONT_TIME_MOD * Math.floor(d / FRONT_TIME_MOD)) * FRONT_TIME_UNIT_MS
  );
}

/** Decay time of the wave's bright part, s (the last ~3 ticks' captures). */
export const FRONT_DECAY_S = 0.22;
/** Decay time of its white-hot colour, s. */
export const FRONT_HOT_S = 0.15;
/** White-hot colour of the freshest captures (linear rgb). */
export const FRONT_HOT_RGB: readonly [number, number, number] = [1, 0.65, 0.35];

/**
 * The capture wave at life fraction u = age / FRONT_PULSE_MS (0..1): a fast
 * rise (~80 ms), a sharp decay (FRONT_DECAY_S: bright on the last ~3 ticks'
 * captures, the leading edge) and a faint tail ((1 − u)², a quarter); no
 * ripple. The GLSL twin is `frontPulse` in shaders/terrain.ts.
 */
export function frontPulse(u: number): number {
  if (!(u >= 0) || u >= 1) return 0;
  const a = Math.min(1, u / 0.06);
  const attack = a * a * (3 - 2 * a);
  const age = (u * FRONT_PULSE_MS) / 1000;
  return attack * (0.75 * Math.exp(-age / FRONT_DECAY_S) + 0.25 * (1 - u) ** 2);
}

/** Share of the white-hot colour in the wave at `ageMs` (before the look's). */
export function frontHeat(ageMs: number): number {
  return ageMs >= 0 ? Math.exp(-ageMs / 1000 / FRONT_HOT_S) : 0;
}

/** Uniforms of the capture wave at a zoom (`uFrontLook`). */
export interface FrontWaveLook {
  /** Emission of the wave at its peak (× its colour, added to the lit ground). */
  gain: number;
  /** Weight of the white-hot colour on the freshest captures. */
  heat: number;
  /** Strength of a capture of unclaimed land (taken from a player = 1). */
  neutral: number;
  /** Strength inside the captured band (tiles on a border = 1). */
  interior: number;
}

/**
 * The wave by zoom (CSS px per tile). It is light added to the shaded
 * ground, so the relief and the fill read through it. Zoomed out (the
 * strategy weight of `territoryLook`, full from 1.25 down) the moving front
 * line flashes strong and white-hot (a 1-2 px line with a touch of bloom),
 * so an active front reads at a glance; close up (from 5) it is a softer
 * glow of the owner's colour, strongest on the line itself.
 */
export function frontWaveLook(
  cssPxPerTile: number,
  out: FrontWaveLook = { gain: 0, heat: 0, neutral: 0, interior: 0 },
): FrontWaveLook {
  const t = Math.min(1, Math.max(0, (cssPxPerTile - 1.25) / (5 - 1.25)));
  const far = 1 - t * t * (3 - 2 * t);
  out.gain = 0.75 + 0.65 * far;
  out.heat = 0.6 + 0.4 * far;
  out.neutral = 0.35;
  out.interior = 0.3 + 0.3 * far;
  return out;
}

/**
 * Attack direction at a captured tile (x, y): the sum of the 8 unit
 * directions, + towards the defender's tiles and − towards the attacker's,
 * sampled `reach` tiles away (clamped to the map). Writes a unit vector to
 * `out` and returns true, or false when the neighbourhood gives none.
 */
export function captureDirection(
  tiles: Uint16Array,
  W: number,
  H: number,
  x: number,
  y: number,
  attacker: number,
  defender: number,
  out: [number, number],
  reach: number = FRONT_GRADIENT_REACH,
): boolean {
  let gx = 0;
  let gy = 0;
  for (let k = 0; k < DIRS.length; k++) {
    const d = DIRS[k];
    const sx = Math.min(W - 1, Math.max(0, x + Math.round(d[0] * reach)));
    const sy = Math.min(H - 1, Math.max(0, y + Math.round(d[1] * reach)));
    const o = tiles[sy * W + sx] & OWNER;
    if (o === defender) {
      gx += d[0];
      gy += d[1];
    } else if (o === attacker) {
      gx -= d[0];
      gy -= d[1];
    }
  }
  const len = Math.hypot(gx, gy);
  if (len < 1e-6) return false;
  out[0] = gx / len;
  out[1] = gy / len;
  return true;
}

/** Decaying sums of the captures of one (cell, attacker, defender). */
export interface FrontSegment {
  attacker: number;
  defender: number;
  /** Weight and direction sums (FRONT_SEGMENT_TAU_MS), decayed to `t`. */
  w: number;
  dx: number;
  dy: number;
  /** Position weight and sums (FRONT_SEGMENT_POS_TAU_MS), decayed to `t`. */
  pw: number;
  sx: number;
  sy: number;
  /** Time (ms) the sums were last decayed to. */
  t: number;
}

/** A merged front cluster (arrow input). */
export interface FrontCluster {
  key: number;
  attacker: number;
  defender: number;
  /** Centroid (tiles) and unit attack direction. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Decayed capture weight (≈ captures within the last few seconds). */
  w: number;
  /**
   * Recent weight (FRONT_SEGMENT_POS_TAU_MS: ≈ 3 × the captures per tick
   * of the last few ticks): 0 once the front stopped moving here.
   */
  recent: number;
  /** Troops of the attack (0 when attacks are unknown). */
  troops: number;
}

/** Small seeded PRNG (mulberry32), deterministic sampling. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FrontField {
  /** Capture stamps, one per tile (the R16UI texture's data). */
  readonly stamps: Uint16Array;
  /** Zeroed cells waiting for an upload (TerrainLayer takes them). */
  readonly sweepQueue: TileUploadQueue;
  /** Front segments by key (cell · 4096² + attacker · 4096 + defender). */
  readonly segments = new Map<number, FrontSegment>();

  // Border events (ring): position (tile centre), pair, time.
  readonly eventX = new Float32Array(FRONT_EVENT_CAPACITY);
  readonly eventY = new Float32Array(FRONT_EVENT_CAPACITY);
  readonly eventAttacker = new Uint16Array(FRONT_EVENT_CAPACITY);
  readonly eventDefender = new Uint16Array(FRONT_EVENT_CAPACITY);
  readonly eventTime = new Float64Array(FRONT_EVENT_CAPACITY);
  /** Events written so far; event i lives at i % FRONT_EVENT_CAPACITY. */
  eventCount = 0;

  /** Last tile state seen (owner changes and previous owners). */
  private readonly shadow: Uint16Array;
  private shadowValid = false;
  /** Last capture time per upload cell (ms), -1 when it holds no stamp. */
  private readonly cellLast: Float64Array;
  /** Upload cells whose stamps changed since they were last sent. */
  private readonly cellDirty: Uint8Array;
  private readonly cellCols: number;
  private sweepCursor = 0;
  /** Active attacks: attacker · 4096 + target → troops (null = unknown). */
  private attacks: Map<number, number> | null = null;
  private readonly rand = prng(0x0f2017);
  /** Scratch: this tick's captures from players and their old owners. */
  private pvpRefs = new Int32Array(1024);
  private pvpPrev = new Uint16Array(1024);
  private readonly dir: [number, number] = [0, 0];
  private readonly clusterIndex = new Map<number, number>();
  /** Position weight per cluster (scratch of `cluster`). */
  private readonly clusterPos: number[] = [];

  // Counters (perf tool).
  capturesLastTick = 0;
  pvpLastTick = 0;
  capturesTotal = 0;
  sweptCells = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const n = width * height;
    this.stamps = new Uint16Array(n);
    this.shadow = new Uint16Array(n);
    this.sweepQueue = new TileUploadQueue(width, height);
    this.cellCols = this.sweepQueue.cols;
    this.cellLast = new Float64Array(
      this.sweepQueue.cols * this.sweepQueue.rows,
    ).fill(-1);
    this.cellDirty = new Uint8Array(this.cellLast.length);
  }

  /** CPU memory of the field (stamps + shadow), MB. */
  get memoryMB(): number {
    return (this.stamps.byteLength + this.shadow.byteLength) / (1 << 20);
  }

  /** Cells holding stamps. */
  get stampedCells(): number {
    let n = 0;
    for (let i = 0; i < this.cellLast.length; i++) {
      if (this.cellLast[i] >= 0) n++;
    }
    return n;
  }

  /**
   * A full tile state (first tick, a new buffer, a context restore): the
   * shadow follows it, every stamp, segment and queued sweep is dropped
   * (nothing pulses for a state that did not arrive as captures).
   */
  reset(tileState: Uint16Array): void {
    if (tileState.length !== this.shadow.length) return;
    this.shadow.set(tileState);
    this.shadowValid = true;
    this.stamps.fill(0);
    this.cellLast.fill(-1);
    this.cellDirty.fill(0);
    this.sweepQueue.clear();
    this.segments.clear();
    this.capturesLastTick = 0;
    this.pvpLastTick = 0;
  }

  /**
   * A tick's changed tiles (`tileState` already holds the new values).
   * Stamps the owner changes, samples border events and folds captures
   * into the front segments. Returns the number of captures.
   */
  applyChanges(
    tileState: Uint16Array,
    changed: readonly number[],
    nowMs: number,
  ): number {
    if (!this.shadowValid || tileState.length !== this.shadow.length) {
      this.reset(tileState);
      return 0;
    }
    const W = this.width;
    const C = TILE_UPLOAD_CELL;
    const shadow = this.shadow;
    const stamps = this.stamps;
    const free = frontStamp(nowMs, false);
    const pvpStamp = free | FRONT_PVP_BIT;
    if (this.pvpRefs.length < changed.length) {
      this.pvpRefs = new Int32Array(changed.length);
      this.pvpPrev = new Uint16Array(changed.length);
    }
    let captures = 0;
    let pvp = 0;
    for (let i = 0; i < changed.length; i++) {
      const ref = changed[i];
      if (!(ref >= 0 && ref < shadow.length)) continue;
      const s = tileState[ref];
      const prev = shadow[ref];
      shadow[ref] = s;
      const o = s & OWNER;
      const po = prev & OWNER;
      if (o === po || o === 0) continue;
      captures++;
      stamps[ref] = po !== 0 ? pvpStamp : free;
      const y = Math.floor(ref / W);
      const x = ref - y * W;
      const ci = Math.floor(y / C) * this.cellCols + Math.floor(x / C);
      this.cellLast[ci] = nowMs;
      this.cellDirty[ci] = 1;
      if (po !== 0) {
        this.pvpRefs[pvp] = ref;
        this.pvpPrev[pvp] = po;
        pvp++;
      }
    }
    this.capturesLastTick = captures;
    this.pvpLastTick = pvp;
    this.capturesTotal += captures;
    if (pvp > 0) {
      this.sampleEvents(tileState, pvp, nowMs);
      this.foldSegments(tileState, pvp, nowMs);
    }
    return captures;
  }

  /**
   * Visit the next cells (all of them every FRONT_SWEEP_PERIOD calls) and
   * zero those whose last capture is older than FRONT_STALE_MS, queueing
   * their upload. Returns the cells zeroed.
   */
  sweep(nowMs: number): number {
    const cells = this.cellLast.length;
    const per = Math.ceil(cells / FRONT_SWEEP_PERIOD);
    const C = TILE_UPLOAD_CELL;
    const W = this.width;
    const H = this.height;
    let zeroed = 0;
    for (let k = 0; k < per; k++) {
      const c = this.sweepCursor;
      this.sweepCursor = (c + 1) % cells;
      const last = this.cellLast[c];
      if (last < 0 || nowMs - last <= FRONT_STALE_MS) continue;
      this.cellLast[c] = -1;
      const cx = (c % this.cellCols) * C;
      const cy = Math.floor(c / this.cellCols) * C;
      const x1 = Math.min(W, cx + C);
      const y1 = Math.min(H, cy + C);
      for (let y = cy; y < y1; y++) this.stamps.fill(0, y * W + cx, y * W + x1);
      this.sweepQueue.markRect(cx, cy, x1 - cx, y1 - cy);
      zeroed++;
    }
    this.sweptCells += zeroed;
    return zeroed;
  }

  /**
   * Whether a stamp changed in the upload cells of the tile rectangle
   * (x, y, w, h) since they were last sent; clears them. TerrainLayer sends
   * the stamps of a tile rectangle only then: tiles changing hands to
   * nobody (a nuke, fallout) or other bit changes cost no stamp upload.
   */
  takeDirty(x: number, y: number, w: number, h: number): boolean {
    const C = TILE_UPLOAD_CELL;
    const cols = this.cellCols;
    const rows = this.cellDirty.length / cols;
    const cx0 = Math.max(0, Math.floor(x / C));
    const cx1 = Math.min(cols - 1, Math.floor((x + w - 1) / C));
    const cy0 = Math.max(0, Math.floor(y / C));
    const cy1 = Math.min(rows - 1, Math.floor((y + h - 1) / C));
    let any = false;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = cy * cols + cx;
        if (this.cellDirty[i] !== 0) {
          this.cellDirty[i] = 0;
          any = true;
        }
      }
    }
    return any;
  }

  /**
   * Whether tile (x, y) is on a border (a 4-neighbour with another owner)
   * in the last tile state seen: a border event that is no longer on the
   * front (it moved on) makes no smoke.
   */
  onBorder(x: number, y: number): boolean {
    const W = this.width;
    const H = this.height;
    if (!this.shadowValid || x < 0 || y < 0 || x >= W || y >= H) return false;
    const t = this.shadow;
    const ref = y * W + x;
    const o = t[ref] & OWNER;
    return (
      (x > 0 && (t[ref - 1] & OWNER) !== o) ||
      (x < W - 1 && (t[ref + 1] & OWNER) !== o) ||
      (y > 0 && (t[ref - W] & OWNER) !== o) ||
      (y < H - 1 && (t[ref + W] & OWNER) !== o)
    );
  }

  /** Every stamp was just sent in full: nothing is dirty. */
  clearDirty(): void {
    this.cellDirty.fill(0);
  }

  /** The players' active attacks (non-retreating, against a player). */
  setAttacks(
    players: ReadonlyMap<number, Pick<PlayerState, "outgoingAttacks">>,
  ): void {
    const m = this.attacks ?? new Map<number, number>();
    m.clear();
    for (const p of players.values()) {
      const list: readonly AttackData[] | undefined = p.outgoingAttacks;
      if (!list) continue;
      for (const a of list) {
        if (a.retreating || !(a.targetID > 0) || !(a.attackerID > 0)) continue;
        const k = a.attackerID * PAIR + a.targetID;
        m.set(k, (m.get(k) ?? 0) + a.troops);
      }
    }
    this.attacks = m;
  }

  /** Active attacks known (pairs), -1 when none were ever set. */
  get activeAttacks(): number {
    return this.attacks === null ? -1 : this.attacks.size;
  }

  /**
   * Merge the live segments into clusters of `cellTiles` (a multiple of
   * FRONT_SEGMENT_CELL) at `nowMs`, keeping those of at least `minWeight`
   * and `minRecent` (the front still moves there) and, once attacks are
   * known, only the pairs with an active attack. Drops dead segments.
   * Writes into `out` (objects reused) and returns the cluster count.
   */
  cluster(
    nowMs: number,
    cellTiles: number,
    minWeight: number,
    out: FrontCluster[],
    minRecent = 0,
  ): number {
    const cell = Math.max(
      FRONT_SEGMENT_CELL,
      Math.round(cellTiles / FRONT_SEGMENT_CELL) * FRONT_SEGMENT_CELL,
    );
    const ratio = cell / FRONT_SEGMENT_CELL;
    const segCols = Math.ceil(this.width / FRONT_SEGMENT_CELL);
    const cols = Math.ceil(this.width / cell);
    const index = this.clusterIndex;
    index.clear();
    let n = 0;
    const pos = this.clusterPos;
    for (const [key, s] of this.segments) {
      const age = Math.max(0, nowMs - s.t);
      const k = Math.exp(-age / FRONT_SEGMENT_TAU_MS);
      const kp = Math.exp(-age / FRONT_SEGMENT_POS_TAU_MS);
      const w = s.w * k;
      if (w < FRONT_SEGMENT_MIN_WEIGHT) {
        this.segments.delete(key);
        continue;
      }
      const pair = s.attacker * PAIR + s.defender;
      let troops = 0;
      if (this.attacks !== null) {
        const t = this.attacks.get(pair);
        if (t === undefined) continue;
        troops = t;
      }
      const segCell = Math.floor(key / (PAIR * PAIR));
      const scx = segCell % segCols;
      const scy = Math.floor(segCell / segCols);
      const ck =
        (Math.floor(scy / ratio) * cols + Math.floor(scx / ratio)) *
          PAIR *
          PAIR +
        pair;
      let i = index.get(ck);
      if (i === undefined) {
        i = n++;
        index.set(ck, i);
        let c = out[i];
        if (c === undefined) {
          c = {
            key: 0,
            attacker: 0,
            defender: 0,
            x: 0,
            y: 0,
            dx: 0,
            dy: 0,
            w: 0,
            recent: 0,
            troops: 0,
          };
          out[i] = c;
        }
        c.key = ck;
        c.attacker = s.attacker;
        c.defender = s.defender;
        c.x = 0;
        c.y = 0;
        c.dx = 0;
        c.dy = 0;
        c.w = 0;
        c.troops = troops;
        pos[i] = 0;
      }
      const c = out[i];
      c.w += w;
      c.dx += s.dx * k;
      c.dy += s.dy * k;
      c.x += s.sx * kp;
      c.y += s.sy * kp;
      pos[i] += s.pw * kp;
    }
    // Finish (centroids, unit directions), drop the light ones.
    let m = 0;
    for (let i = 0; i < n; i++) {
      const c = out[i];
      const len = Math.hypot(c.dx, c.dy);
      if (c.w < minWeight || len < 1e-6 || !(pos[i] > 1e-9)) continue;
      if (pos[i] < minRecent) continue;
      c.recent = pos[i];
      c.x /= pos[i];
      c.y /= pos[i];
      c.dx /= len;
      c.dy /= len;
      const d = out[m];
      out[m] = c;
      out[i] = d;
      m++;
    }
    return m;
  }

  // ---- Internals ----

  /**
   * Up to FRONT_EVENTS_PER_TICK of this tick's captures from players that
   * are on a border now, picked with a random stride (two passes at most).
   */
  private sampleEvents(
    tileState: Uint16Array,
    pvp: number,
    nowMs: number,
  ): void {
    const W = this.width;
    const H = this.height;
    const want = FRONT_EVENTS_PER_TICK;
    const stride = Math.max(1, Math.floor(pvp / (2 * want)));
    let i = Math.floor(this.rand() * stride);
    let got = 0;
    for (; i < pvp && got < want; i += stride) {
      const ref = this.pvpRefs[i];
      const y = Math.floor(ref / W);
      const x = ref - y * W;
      const o = tileState[ref] & OWNER;
      const border =
        (x > 0 && (tileState[ref - 1] & OWNER) !== o) ||
        (x < W - 1 && (tileState[ref + 1] & OWNER) !== o) ||
        (y > 0 && (tileState[ref - W] & OWNER) !== o) ||
        (y < H - 1 && (tileState[ref + W] & OWNER) !== o);
      if (!border) continue;
      const e = this.eventCount++ % FRONT_EVENT_CAPACITY;
      this.eventX[e] = x + 0.5;
      this.eventY[e] = y + 0.5;
      this.eventAttacker[e] = o;
      this.eventDefender[e] = this.pvpPrev[i];
      this.eventTime[e] = nowMs;
      got++;
    }
  }

  /** Fold (a stride sample of) this tick's captures into the segments. */
  private foldSegments(
    tileState: Uint16Array,
    pvp: number,
    nowMs: number,
  ): void {
    const W = this.width;
    const H = this.height;
    const segCols = Math.ceil(W / FRONT_SEGMENT_CELL);
    const stride = Math.max(1, Math.ceil(pvp / FRONT_SEGMENT_SAMPLES_PER_TICK));
    const weight = stride;
    const dir = this.dir;
    for (let i = Math.floor(this.rand() * stride); i < pvp; i += stride) {
      const ref = this.pvpRefs[i];
      const y = Math.floor(ref / W);
      const x = ref - y * W;
      const attacker = tileState[ref] & OWNER;
      const defender = this.pvpPrev[i];
      const cell =
        Math.floor(y / FRONT_SEGMENT_CELL) * segCols +
        Math.floor(x / FRONT_SEGMENT_CELL);
      const key = cell * PAIR * PAIR + attacker * PAIR + defender;
      let s = this.segments.get(key);
      if (s === undefined) {
        s = {
          attacker,
          defender,
          w: 0,
          dx: 0,
          dy: 0,
          pw: 0,
          sx: 0,
          sy: 0,
          t: nowMs,
        };
        this.segments.set(key, s);
      } else if (nowMs > s.t) {
        const k = Math.exp(-(nowMs - s.t) / FRONT_SEGMENT_TAU_MS);
        const kp = Math.exp(-(nowMs - s.t) / FRONT_SEGMENT_POS_TAU_MS);
        s.w *= k;
        s.dx *= k;
        s.dy *= k;
        s.pw *= kp;
        s.sx *= kp;
        s.sy *= kp;
        s.t = nowMs;
      }
      s.w += weight;
      s.pw += weight;
      s.sx += (x + 0.5) * weight;
      s.sy += (y + 0.5) * weight;
      if (captureDirection(tileState, W, H, x, y, attacker, defender, dir)) {
        s.dx += dir[0] * weight;
        s.dy += dir[1] * weight;
      }
    }
  }
}
