/**
 * Pure helpers of the terrain / water / environment layers (no three import,
 * so they are unit-testable and cheap to load):
 * - colour conversions and the water palette derived from the game's terrain
 *   colours,
 * - the border-width / edge-coverage math the terrain shader implements,
 * - the view-distance fog range,
 * - per-row texel spans for partial texture uploads,
 * - the "coast lift" of the relief mesh (cells holding land never dip below
 *   the water plane, so crisp per-tile coastlines are drawn by the terrain
 *   shader instead of being hidden under the water).
 */

import { LAND_BIT } from "./TerrainCodec";

export type Rgb = [number, number, number];

/** sRGB-encoded channel (0..1) → linear (exact sRGB transfer function). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** "#rrggbb" → sRGB 0..1 triple, or `fallback` when the string is invalid. */
export function hexToSrgb01(hex: string | undefined, fallback: Rgb): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  if (!m) return [fallback[0], fallback[1], fallback[2]];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export function srgbToLinearRgb(c: Rgb): Rgb {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

/** Water albedos (linear) derived from the theme's ocean colour. */
export interface WaterColors {
  /** Near the coast: the ocean colour pulled towards a clear teal. */
  shallow: Rgb;
  /** Open sea: the ocean colour darkened towards navy. */
  deep: Rgb;
  /** Breaking-wave foam. */
  foam: Rgb;
}

/** Teal the shallow water is pulled towards (linear). */
const SHALLOW_TEAL: Rgb = [0.05, 0.42, 0.42];

/**
 * Shallow teal → deep navy around the theme's ocean colour, so graphics
 * presets that recolour the ocean (e.g. a darker one) keep their character.
 */
export function waterColors(oceanSrgb: Rgb): WaterColors {
  const o = srgbToLinearRgb(oceanSrgb);
  const shallow: Rgb = [0, 0, 0];
  const deep: Rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    shallow[i] = Math.min(1, (o[i] * 0.55 + SHALLOW_TEAL[i] * 0.45) * 1.25);
    // Navy: keep blue, drop red/green a little more.
    deep[i] = o[i] * [0.5, 0.6, 0.72][i];
  }
  return { shallow, deep, foam: [0.92, 0.95, 0.97] };
}

/**
 * Border width in tiles: `borderPx` screen pixels at the current zoom
 * (`tilesPerPx` = fwidth of the world coordinate), never thinner than
 * `minTiles` (a thin crisp line when zoomed in) nor wider than one tile
 * (the default renderer's 1-tile border when zoomed out).
 */
export function borderWidthTiles(
  borderPx: number,
  tilesPerPx: number,
  minTiles: number,
): number {
  return Math.min(1, Math.max(minTiles, borderPx * tilesPerPx));
}

/**
 * Anti-aliased coverage of a border band of width `width` (tiles) at
 * distance `dist` (tiles) from the tile edge, with a one-pixel ramp of
 * `aa` tiles centred on the band's inner edge. A full-tile band covers the
 * whole tile.
 */
export function edgeCoverage(dist: number, width: number, aa: number): number {
  if (width >= 0.999) return 1;
  return Math.min(1, Math.max(0, (width - dist) / Math.max(aa, 1e-6) + 0.5));
}

/**
 * Linear fog range (camera-space depth) for a camera at `distance` from its
 * target. Top-down the whole ground sits at depth ≈ distance, so the fog
 * starts beyond it (no haze); tilting pulls it in so the far side of the
 * view fades towards the horizon colour.
 */
export function fogRangeForView(
  distance: number,
  tiltFraction: number,
): { near: number; far: number } {
  const t = Math.min(1, Math.max(0, tiltFraction));
  const d = Math.max(1e-3, distance);
  return { near: d * (1.25 - 0.35 * t), far: d * (4 - 1.2 * t) };
}

/**
 * Collects, for a list of tile refs, the x-extent touched in each row
 * (reusable scratch; O(refs + touched rows), no per-map work).
 */
export class RowSpans {
  /** Row index of span k (k < count). */
  readonly rows: Int32Array;
  /** First / last x (inclusive) of span k. */
  readonly x0: Int32Array;
  readonly x1: Int32Array;
  count = 0;
  private readonly minX: Int32Array;
  private readonly maxX: Int32Array;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.rows = new Int32Array(height);
    this.x0 = new Int32Array(height);
    this.x1 = new Int32Array(height);
    this.minX = new Int32Array(height).fill(width);
    this.maxX = new Int32Array(height).fill(-1);
  }

  /** Group `refs` (y*W + x) by row; returns the number of spans. */
  collect(refs: readonly number[]): number {
    const W = this.width;
    const H = this.height;
    let n = 0;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (!(ref >= 0)) continue;
      const y = Math.floor(ref / W);
      if (y >= H) continue;
      const x = ref - y * W;
      if (this.maxX[y] < 0) this.rows[n++] = y;
      if (x < this.minX[y]) this.minX[y] = x;
      if (x > this.maxX[y]) this.maxX[y] = x;
    }
    for (let k = 0; k < n; k++) {
      const y = this.rows[k];
      this.x0[k] = this.minX[y];
      this.x1[k] = this.maxX[y];
      this.minX[y] = W;
      this.maxX[y] = -1;
    }
    this.count = n;
    return n;
  }
}

/**
 * Minimal view of `THREE.Texture` for `addTexelSpan` (keeps this module free
 * of a three import).
 */
export interface UpdateRangeTarget {
  addUpdateRange(start: number, count: number): void;
}

/**
 * Queue a partial upload of `count` texels starting at (x, y) of a
 * single-channel DataTexture of width `width`.
 *
 * three r186 `WebGLTextures.updateTexture` assumes 4 components per texel
 * (`componentStride = 4`, "only RGBA supported") and uploads each range as
 * ONE row (`height = 1`): so ranges are given in units of texel*4 and must
 * not cross a row. The span is clipped to its row.
 */
export function addTexelSpan(
  texture: UpdateRangeTarget,
  width: number,
  x: number,
  y: number,
  count: number,
): void {
  const x0 = Math.max(0, x);
  const x1 = Math.min(width, x + count);
  if (x1 <= x0 || y < 0) return;
  texture.addUpdateRange((y * width + x0) * 4, (x1 - x0) * 4);
}

/** World Y the relief is kept at (or above) wherever a cell holds land. */
export const COAST_LIFT = 0.05;

/**
 * Marks grid cells (`step`×`step` tiles; cell (ci, cj) covers tiles
 * [ci*step, (ci+1)*step) × [cj*step, (cj+1)*step), clipped to the map) that
 * contain at least one land tile. Only cells in [ci0, ci1] × [cj0, cj1]
 * (inclusive, clamped) are recomputed; `out` is `cellsX * cellsY` long.
 */
export function computeCellLand(
  terrain: Uint8Array,
  mapWidth: number,
  mapHeight: number,
  step: number,
  cellsX: number,
  cellsY: number,
  out: Uint8Array,
  ci0 = 0,
  cj0 = 0,
  ci1 = cellsX - 1,
  cj1 = cellsY - 1,
): void {
  ci0 = Math.max(0, ci0);
  cj0 = Math.max(0, cj0);
  ci1 = Math.min(cellsX - 1, ci1);
  cj1 = Math.min(cellsY - 1, cj1);
  if (ci1 < ci0 || cj1 < cj0) return;
  for (let cj = cj0; cj <= cj1; cj++) {
    out.fill(0, cj * cellsX + ci0, cj * cellsX + ci1 + 1);
  }
  const tx0 = ci0 * step;
  const tx1 = Math.min(mapWidth, (ci1 + 1) * step);
  const ty0 = cj0 * step;
  const ty1 = Math.min(mapHeight, (cj1 + 1) * step);
  for (let ty = ty0; ty < ty1; ty++) {
    const rowOut = Math.floor(ty / step) * cellsX;
    const row = ty * mapWidth;
    for (let tx = tx0; tx < tx1; tx++) {
      if ((terrain[row + tx] & LAND_BIT) !== 0) {
        out[rowOut + Math.floor(tx / step)] = 1;
        // The rest of this cell's row segment cannot change the answer.
        tx = Math.min(tx1, (Math.floor(tx / step) + 1) * step) - 1;
      }
    }
  }
}

/**
 * Whether grid vertex (i, j) touches a land cell (cells (i-1..i, j-1..j)).
 * `cellLand` comes from `computeCellLand`.
 */
export function vertexTouchesLand(
  cellLand: Uint8Array,
  cellsX: number,
  cellsY: number,
  i: number,
  j: number,
): boolean {
  const ia = i > 0 ? i - 1 : 0;
  const ib = i < cellsX ? i : cellsX - 1;
  const ja = j > 0 ? j - 1 : 0;
  const jb = j < cellsY ? j : cellsY - 1;
  for (let cj = ja; cj <= jb; cj++) {
    for (let ci = ia; ci <= ib; ci++) {
      if (cellLand[cj * cellsX + ci] !== 0) return true;
    }
  }
  return false;
}
