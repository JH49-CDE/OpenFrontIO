/**
 * FalloutField — where the map holds nuclear fallout, kept current from the
 * tile path, for the fallout smoke (lot 3, item 5). Pure data, no three.
 *
 * The map is cut into `FALLOUT_CELL` × `FALLOUT_CELL`-tile cells, each with
 * its count of fallout tiles. A copy of every tile's fallout bit (one byte
 * per tile) lets each tick's changed tiles update the counts exactly, in
 * O(changed tiles), with no rescan: `applyChanges` is fed by
 * `TerrainLayer.setTiles` with the same `changedTiles` the uploads get. A
 * full upload (first tick, new buffer, context restore) re-reads the whole
 * buffer row by row, `FALLOUT_STEP_BUDGET_MS` of JS per `step` (one call
 * per frame), so no frame pays the whole map (World: ~2M tiles, done in a
 * few frames); changes arriving meanwhile on rows not read yet are picked
 * up by the rebuild itself.
 *
 * A cell is "dense" (a smoke emitter) once `DENSE_FRACTION` of its tiles
 * hold fallout. `pickEmitter` draws a random dense cell inside a tile
 * rectangle (the view) and a random fallout tile in it, so smoke only ever
 * rises from fallout tiles.
 */

import { FALLOUT_BIT } from "./TerrainCodec";

/** Cell side, tiles. */
export const FALLOUT_CELL = 8;
/** A cell emits smoke from this share of fallout tiles on. */
export const DENSE_FRACTION = 0.6;
/** JS budget of one `step` of a full rebuild, ms (at least one row). */
export const FALLOUT_STEP_BUDGET_MS = 0.4;

export class FalloutField {
  readonly cellsX: number;
  readonly cellsY: number;
  /** Fallout tiles per cell, row-major. */
  readonly counts: Uint16Array;
  /** Fallout tiles on the map. */
  total = 0;
  /** Dense cells (`counts ≥ denseMin`), unordered; `denseIndex` locates them. */
  private readonly dense: Int32Array;
  private denseCount = 0;
  private readonly denseIndex: Int32Array;
  private readonly denseMin: number;
  /** One byte per tile: 1 = fallout as last seen. */
  private readonly bits: Uint8Array;
  /** Next row of a running full rebuild, or -1. */
  private rebuildRow = -1;
  private rebuildSource: Uint16Array | null = null;
  /** Bumped whenever the dense set changes. */
  version = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cellsX = Math.ceil(width / FALLOUT_CELL);
    this.cellsY = Math.ceil(height / FALLOUT_CELL);
    const n = this.cellsX * this.cellsY;
    this.counts = new Uint16Array(n);
    this.dense = new Int32Array(n);
    this.denseIndex = new Int32Array(n).fill(-1);
    this.bits = new Uint8Array(width * height);
    this.denseMin = Math.ceil(DENSE_FRACTION * FALLOUT_CELL * FALLOUT_CELL);
  }

  /** Dense cells right now. */
  get denseCells(): number {
    return this.denseCount;
  }

  /** True while a full rebuild is still reading rows. */
  get rebuilding(): boolean {
    return this.rebuildRow >= 0;
  }

  /** Tiles of the cell `c` (edge cells are smaller). */
  cellTiles(c: number): number {
    const cx = c % this.cellsX;
    const cy = (c - cx) / this.cellsX;
    const w = Math.min(FALLOUT_CELL, this.width - cx * FALLOUT_CELL);
    const h = Math.min(FALLOUT_CELL, this.height - cy * FALLOUT_CELL);
    return w * h;
  }

  /**
   * The whole buffer changed (first upload, a new buffer, context restore):
   * re-read it over the next `step` calls.
   */
  reset(tileState: Uint16Array): void {
    if (tileState.length !== this.width * this.height) return;
    this.rebuildSource = tileState;
    this.rebuildRow = 0;
  }

  /**
   * Tiles a tick changed (`tileState` already holds their new state).
   * Returns the number of tiles whose fallout bit flipped.
   */
  applyChanges(tileState: Uint16Array, changed: readonly number[]): number {
    if (tileState.length !== this.width * this.height) return 0;
    const W = this.width;
    const bits = this.bits;
    // Rows a running rebuild has not read yet are left to it.
    const pendingFrom = this.rebuildRow >= 0 ? this.rebuildRow * W : Infinity;
    let flips = 0;
    for (let i = 0; i < changed.length; i++) {
      const ref = changed[i];
      if (!(ref >= 0 && ref < bits.length) || ref >= pendingFrom) continue;
      const now = (tileState[ref] & FALLOUT_BIT) !== 0 ? 1 : 0;
      if (now === bits[ref]) continue;
      bits[ref] = now;
      const x = ref % W;
      const y = (ref - x) / W;
      this.bump(
        ((y / FALLOUT_CELL) | 0) * this.cellsX + ((x / FALLOUT_CELL) | 0),
        now === 1 ? 1 : -1,
      );
      flips++;
    }
    return flips;
  }

  /**
   * One frame's share of a running full rebuild: rows until `budgetMs` of
   * JS is spent (at least one row, at most `maxRows`); nothing otherwise.
   * Returns the rows read.
   */
  step(budgetMs = FALLOUT_STEP_BUDGET_MS, maxRows = Infinity): number {
    const src = this.rebuildSource;
    if (this.rebuildRow < 0 || src === null) return 0;
    const W = this.width;
    const y0 = this.rebuildRow;
    const yMax = Math.min(this.height, y0 + Math.max(1, maxRows));
    const bits = this.bits;
    const t0 = performance.now();
    let y = y0;
    for (; y < yMax; y++) {
      if (y > y0 && performance.now() - t0 >= budgetMs) break;
      const rowCell = ((y / FALLOUT_CELL) | 0) * this.cellsX;
      const base = y * W;
      for (let x = 0; x < W; x++) {
        const now = (src[base + x] & FALLOUT_BIT) !== 0 ? 1 : 0;
        if (now === bits[base + x]) continue;
        bits[base + x] = now;
        this.bump(rowCell + ((x / FALLOUT_CELL) | 0), now === 1 ? 1 : -1);
      }
    }
    this.rebuildRow = y >= this.height ? -1 : y;
    if (this.rebuildRow < 0) this.rebuildSource = null;
    return y - y0;
  }

  /** Fallout bit of a tile as last seen. */
  hasFallout(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.bits[y * this.width + x] === 1;
  }

  /** Whether cell `c` is a smoke emitter. */
  isDense(c: number): boolean {
    return this.denseIndex[c] >= 0;
  }

  /**
   * A random fallout tile of a random dense cell whose cell lies in the
   * tile rectangle [x0, x1) × [y0, y1), or null. `rand` returns [0, 1).
   * Draws at most `tries` cells and `tries` tiles per cell.
   */
  pickEmitter(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rand: () => number,
    tries = 8,
  ): { x: number; y: number } | null {
    if (this.denseCount === 0) return null;
    const cx0 = Math.max(0, Math.floor(x0 / FALLOUT_CELL));
    const cy0 = Math.max(0, Math.floor(y0 / FALLOUT_CELL));
    const cx1 = Math.min(this.cellsX - 1, Math.floor((x1 - 1) / FALLOUT_CELL));
    const cy1 = Math.min(this.cellsY - 1, Math.floor((y1 - 1) / FALLOUT_CELL));
    if (cx1 < cx0 || cy1 < cy0) return null;
    const spanX = cx1 - cx0 + 1;
    const spanY = cy1 - cy0 + 1;
    // Few dense cells: sample the list; else sample the rectangle.
    const fromList = this.denseCount < spanX * spanY;
    for (let t = 0; t < tries; t++) {
      let c: number;
      if (fromList) {
        c = this.dense[Math.floor(rand() * this.denseCount)];
        const cx = c % this.cellsX;
        const cy = (c - cx) / this.cellsX;
        if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
      } else {
        c =
          (cy0 + Math.floor(rand() * spanY)) * this.cellsX +
          cx0 +
          Math.floor(rand() * spanX);
        if (this.denseIndex[c] < 0) continue;
      }
      const cx = c % this.cellsX;
      const cy = (c - cx) / this.cellsX;
      const w = Math.min(FALLOUT_CELL, this.width - cx * FALLOUT_CELL);
      const h = Math.min(FALLOUT_CELL, this.height - cy * FALLOUT_CELL);
      for (let k = 0; k < tries; k++) {
        const x = cx * FALLOUT_CELL + Math.floor(rand() * w);
        const y = cy * FALLOUT_CELL + Math.floor(rand() * h);
        if (this.bits[y * this.width + x] === 1) return { x, y };
      }
    }
    return null;
  }

  private bump(c: number, d: number): void {
    const before = this.counts[c];
    const after = before + d;
    this.counts[c] = after;
    this.total += d;
    const wasDense = this.denseIndex[c] >= 0;
    const isDense =
      after >=
      (this.cellTiles(c) === FALLOUT_CELL * FALLOUT_CELL
        ? this.denseMin
        : Math.ceil(DENSE_FRACTION * this.cellTiles(c)));
    if (isDense === wasDense) return;
    this.version++;
    if (isDense) {
      this.denseIndex[c] = this.denseCount;
      this.dense[this.denseCount++] = c;
    } else {
      // Swap-remove.
      const i = this.denseIndex[c];
      const last = this.dense[--this.denseCount];
      this.dense[i] = last;
      this.denseIndex[last] = i;
      this.denseIndex[c] = -1;
    }
  }
}

// ---------------------------------------------------------------------------
// Fallout smoke (FxLayer): a fixed pool of puffs looping over dense cells
// ---------------------------------------------------------------------------

/** Puff slots (one draw call while any shows); `three_quality=low` halves. */
export const FALLOUT_SMOKE_SLOTS = 36;
/** Life of one puff, ms (each slot loops with its own phase). */
export const FALLOUT_SMOKE_LIFE_MS = 7000;
/** Fade-in of a slot (re)assigned mid-life, ms (camera jumps, new zones). */
export const FALLOUT_SMOKE_BIRTH_MS = 600;
/** The smoke fades in between these zooms (CSS px per tile). */
export const FALLOUT_SMOKE_ZOOM: readonly [number, number] = [1.2, 2.4];
/** Peak opacity of a puff. */
export const FALLOUT_SMOKE_ALPHA = 0.3;

/** One puff at life fraction u ∈ [0, 1). */
export interface FalloutPuff {
  /** Height above the ground, tiles. */
  rise: number;
  /** Downwind drift, tiles. */
  drift: number;
  /** Quad size, tiles. */
  size: number;
  /** Opacity, 0 at u = 0 and at u → 1 (a slot loops without a pop). */
  alpha: number;
}

function smooth01(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Closed-form puff at life fraction `u` (rises, drifts, grows, fades),
 * written into `out` when given (no allocation per puff and frame).
 */
export function falloutPuff(
  u: number,
  out: FalloutPuff = { rise: 0, drift: 0, size: 0, alpha: 0 },
): FalloutPuff {
  const v = Math.min(1, Math.max(0, u));
  out.rise = 0.6 + 9 * v * (1 - 0.3 * v);
  out.drift = 3 * v;
  out.size = 2.5 + 7 * Math.sqrt(v);
  out.alpha =
    FALLOUT_SMOKE_ALPHA * smooth01(0, 0.15, v) * (1 - smooth01(0.5, 1, v));
  return out;
}

/** Smoke opacity factor at a zoom (CSS px per tile). */
export function falloutSmokeZoomFade(cssPxPerTile: number): number {
  return smooth01(FALLOUT_SMOKE_ZOOM[0], FALLOUT_SMOKE_ZOOM[1], cssPxPerTile);
}
