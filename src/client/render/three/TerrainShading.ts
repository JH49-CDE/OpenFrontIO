/**
 * Pure helpers of the terrain / water / environment layers (no three import,
 * so they are unit-testable and cheap to load):
 * - colour conversions and the water palette derived from the game's terrain
 *   colours,
 * - the border-width / edge-coverage / contrast math and the close-up zone
 *   blend the terrain shader implements,
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

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Weight (0..1) of the terrain shader's close-up look for `tilesPerPx`
 * (fwidth of the world coordinate): 0 at strategy zoom (a tile under
 * ~2.5 px), 1 once a tile spans ~7 px or more.
 */
export function closeUpAmount(tilesPerPx: number): number {
  return 1 - smoothstep(0.15, 0.4, tilesPerPx);
}

/**
 * Sharpness `k` of the close-up zone blend. Between two zones the 12-88%
 * transition of `sharpenZoneWeights` spans ~4 / (4 + 2k) tiles; k is chosen
 * so that this is ~2 px (never under 0.12 tile), scaled by `close`.
 */
export function zoneSharpness(tilesPerPx: number, close: number): number {
  return close * Math.max(0, 2 / Math.max(2 * tilesPerPx, 0.12) - 2);
}

/**
 * The terrain shader's close-up zone blend: bilinear corner weights `bw`
 * (corners that are not passable land already at 0) sharpened towards the
 * dominant zone, w_i · exp(k (W_i − 1)) normalised, where W_i is the total
 * bilinear weight of corner i's zone. k = 0 is the plain bilinear blend.
 * Returns all zeros when no corner has weight.
 */
export function sharpenZoneWeights(
  bw: readonly [number, number, number, number],
  zones: readonly [number, number, number, number],
  k: number,
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < 4; i++) {
    let classWeight = 0;
    for (let j = 0; j < 4; j++) if (zones[j] === zones[i]) classWeight += bw[j];
    out[i] = bw[i] * Math.exp(k * (classWeight - 1));
    total += out[i];
  }
  if (!(total > 1e-5)) return [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) out[i] /= total;
  return out;
}

/**
 * How much a border band needs extra contrast (0..1) against a surface:
 * 1 when their perceptual brightness (sqrt of linear luminance) is within
 * ~0.06, 0 beyond ~0.22. The terrain shader darkens the band's edge lines
 * (close up) or the band itself (zoomed out) by this amount.
 */
export function borderContrastNeed(
  bandLuma: number,
  groundLuma: number,
): number {
  const d = Math.abs(
    Math.sqrt(Math.max(0, bandLuma)) - Math.sqrt(Math.max(0, groundLuma)),
  );
  return 1 - smoothstep(0.06, 0.22, d);
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

// ---------------------------------------------------------------------------
// Territory readability at distance (lot 3, item 3). TerrainLayer turns the
// zoom into the terrain shader's territory uniforms every frame; the curves
// live here so they are unit-tested.
// ---------------------------------------------------------------------------

/** At and below this zoom (CSS px per tile) the strategy look is full. */
export const TERRITORY_FAR_ZOOM = 1.25;
/** From this zoom on the fill is the settings' (close-up look unchanged). */
export const TERRITORY_NEAR_ZOOM = 5;
/** From this zoom on the borders are back to `BORDER_CSS_PX_NEAR`. */
export const BORDER_NEAR_ZOOM = 8;
/** Fill opacity zoomed out (close up: `mapOverlay.territoryAlpha`, 0.588). */
export const FAR_FILL_ALPHA = 0.82;
/** Border width, CSS px, close up and zoomed out (clamped to ≤ 1 tile). */
export const BORDER_CSS_PX_NEAR = 1.3;
export const BORDER_CSS_PX_FAR = 2.4;
/**
 * Share of the hillshade replaced by flat light on owned land, zoomed out:
 * a territory reads as one colour while the relief still shows.
 */
export const FAR_HILLSHADE_FLATTEN = 0.35;
/** Alt view: affiliation fill opacity, close up and zoomed out. */
export const ALT_FILL_ALPHA_NEAR = 0.4;
export const ALT_FILL_ALPHA_FAR = 0.55;
/**
 * Alt view: brightness of the (desaturated) ground under owned and unowned
 * land. Owned ground stays lighter, so neutral (grey) territory reads
 * against the darker unowned land.
 */
export const ALT_GROUND_OWNED = 0.82;
export const ALT_GROUND_FREE = 0.5;

/**
 * Weight (0..1) of the strategy-zoom territory look: 1 at and below
 * `TERRITORY_FAR_ZOOM` CSS px per tile, 0 from `TERRITORY_NEAR_ZOOM` on.
 */
export function territoryFarWeight(cssPxPerTile: number): number {
  return 1 - smoothstep(TERRITORY_FAR_ZOOM, TERRITORY_NEAR_ZOOM, cssPxPerTile);
}

/** The terrain shader's territory uniforms at a zoom. */
export interface TerritoryLook {
  /** Strategy weight (`territoryFarWeight`). */
  far: number;
  /** Territory fill opacity (sRGB mix over the ground). */
  fillAlpha: number;
  /** Target border width, CSS px (the layer multiplies by the pixel ratio). */
  borderCssPx: number;
  /** Share of the hillshade replaced by flat light on owned land. */
  flatten: number;
  /** Alt view: affiliation fill opacity. */
  altFillAlpha: number;
}

/**
 * Territory look at `cssPxPerTile`: the fill and borders strengthen as the
 * camera zooms out (like the default renderer's flat map, who owns what
 * reads at a glance), and are the settings' look from ~5 px per tile on, so
 * the relief close up is untouched. `baseFillAlpha` is
 * `mapOverlay.territoryAlpha` (never lowered).
 */
export function territoryLook(
  cssPxPerTile: number,
  baseFillAlpha: number,
): TerritoryLook {
  const far = territoryFarWeight(cssPxPerTile);
  const farBorder =
    1 - smoothstep(TERRITORY_FAR_ZOOM, BORDER_NEAR_ZOOM, cssPxPerTile);
  const base = Math.min(1, Math.max(0, baseFillAlpha));
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  return {
    far,
    fillAlpha: mix(base, Math.max(base, FAR_FILL_ALPHA), far),
    borderCssPx: mix(BORDER_CSS_PX_NEAR, BORDER_CSS_PX_FAR, farBorder),
    flatten: FAR_HILLSHADE_FLATTEN * far,
    altFillAlpha: mix(ALT_FILL_ALPHA_NEAR, ALT_FILL_ALPHA_FAR, far),
  };
}

// ---------------------------------------------------------------------------
// Coastline and map edge at distance (lot 3, item 6)
// ---------------------------------------------------------------------------

/** Tiles per device px where the shore halo starts / stops narrowing. */
export const SHORE_SCALE_TPP: readonly [number, number] = [0.3, 1.4];
/** Shore halo compression when zoomed out (water magnitude × this). */
export const SHORE_FAR_SCALE = 3;

/**
 * Factor on the water magnitude for the shallow-water look (seabed showing
 * through, shallow tint), mirrored by `shoreViewScale` in shaders/water.ts:
 * 1 close up (a tile over ~3 device px), `SHORE_FAR_SCALE` once a tile is
 * under ~0.7 device px. The halo keeps its look close up and stays a thin
 * band at full map instead of ~7 tiles of yellow-green glow.
 */
export function shoreViewScale(tilesPerPx: number): number {
  return (
    1 +
    (SHORE_FAR_SCALE - 1) *
      smoothstep(SHORE_SCALE_TPP[0], SHORE_SCALE_TPP[1], tilesPerPx)
  );
}

/**
 * Width (tiles) of the flat apron TerrainLayer lays around the map at
 * `COAST_LIFT`: the longest virtual land, the water deepening past it
 * (`apronWaterMagnitude`: open sea within the mean reach + 8 tiles of the
 * virtual coast) and a margin, so its rim is open sea whatever the noise.
 */
export function apronWidthTiles(mapWidth: number, mapHeight: number): number {
  const reach = edgeReachTiles(mapWidth, mapHeight);
  return Math.ceil((APRON_REACH_MAX + 0.5 * APRON_RAGGED + 1) * reach + 8);
}

/**
 * Mean reach (tiles) of the land continuing past the map edge before it
 * breaks up into the sea: ~0.9% of the longest side, 8-32 tiles (World,
 * 2000 × 1000: 18, ~13 px at full map).
 */
export function edgeReachTiles(mapWidth: number, mapHeight: number): number {
  return Math.min(32, Math.max(8, 0.009 * Math.max(mapWidth, mapHeight)));
}

/**
 * Reach multiplier at noise 0 / 1 (see `virtualLandReach`): wide, so along
 * the edge some land dies right away and some runs far (no band running
 * parallel to the edge at a constant distance).
 */
export const APRON_REACH_MIN = 0.15;
export const APRON_REACH_MAX = 2;
/** Noise range stretched over [MIN, MAX] (the noise rarely leaves it). */
export const APRON_REACH_NOISE: readonly [number, number] = [0.25, 0.75];
/** Ragged coast: ± half this × the mean reach, from a finer octave. */
export const APRON_RAGGED = 0.3;

/**
 * Factor on the virtual land's mean reach by zoom (CSS px per tile): 1 up
 * to `APRON_ZOOM[0]`, `APRON_ZOOM_NEAR` from `APRON_ZOOM[1]` on, so close
 * up the made-up land past the edge stays a short fringe (tens of px)
 * instead of whole islands.
 */
export const APRON_ZOOM: readonly [number, number] = [2, 8];
export const APRON_ZOOM_NEAR = 0.4;
export function apronReachZoomScale(cssPxPerTile: number): number {
  return (
    1 -
    (1 - APRON_ZOOM_NEAR) *
      smoothstep(APRON_ZOOM[0], APRON_ZOOM[1], cssPxPerTile)
  );
}

/**
 * Where the terrain shader looks tiles up for a point of the apron: the
 * point mirrored at the map border (per axis, `size − |size − |p||`), so
 * the land and coasts past the edge continue those inside it. The shader
 * first warps the point (`apronWarp`), more with the distance past the
 * edge, so farther out the land is not a recognisable mirror image.
 * Identity on the map.
 */
export function mirrorIntoMap(p: number, size: number): number {
  return size - Math.abs(size - Math.abs(p));
}

/** Warp of the apron lookups: frequency (1/tiles), gain, distance cap. */
export const APRON_WARP_FREQ = 0.025;
export const APRON_WARP_GAIN = 0.9;
export const APRON_WARP_CAP = 20;

/**
 * Displacement (tiles, one axis) of an apron lookup at `dOut` tiles past
 * the edge for a warp noise `n` in [0, 1]: 0 at the edge (continuous with
 * the map), growing with the distance up to `APRON_WARP_CAP`.
 */
export function apronWarp(n: number, dOut: number): number {
  return (
    (n - 0.5) * APRON_WARP_GAIN * Math.min(Math.max(dOut, 0), APRON_WARP_CAP)
  );
}

/**
 * Reach (tiles past the edge) of the virtual land at a point of the apron,
 * as the terrain shader computes it: the mean reach × a factor between
 * `APRON_REACH_MIN` and `APRON_REACH_MAX`, from two low-frequency
 * value-noise octaves (`noise` in 0..1) stretched over
 * `APRON_REACH_NOISE`, plus a ragged term from a finer octave (`ragged` in
 * 0..1, ± `APRON_RAGGED` / 2), never below 0. The apron shows the mirrored
 * land where it is closer to the edge than this.
 */
export function virtualLandReach(
  noise: number,
  meanReach: number,
  ragged = 0.5,
): number {
  const k = smoothstep(APRON_REACH_NOISE[0], APRON_REACH_NOISE[1], noise);
  return Math.max(
    0,
    meanReach *
      (APRON_REACH_MIN +
        (APRON_REACH_MAX - APRON_REACH_MIN) * k +
        APRON_RAGGED * (ragged - 0.5)),
  );
}

/**
 * Water magnitude the apron shades at `dOut` tiles past the edge: the
 * mirrored water's (`mirroredMag`, land counted as 0), or past the virtual
 * coast its distance from it, whichever is deeper — a shelf like a real
 * coast's (the same shallows and foam, narrowed zoomed out by
 * `shoreViewScale`), never a wide pale band — then open sea (16) from
 * `meanReach` + 8 tiles past the coast, so shallow seas at the edge fade
 * out instead of ending on the map's rectangle. Open sea from
 * `apronWidthTiles` on, where WaterLayer's plane takes over.
 */
export function apronWaterMagnitude(
  mirroredMag: number,
  dOut: number,
  reach: number,
  meanReach: number,
): number {
  const m = Math.min(16, Math.max(0, mirroredMag, dOut - reach));
  return (
    m +
    (16 - m) * smoothstep(reach + 0.5 * meanReach, reach + meanReach + 8, dOut)
  );
}

/** Territory fill past the map edge: gone within max(1.5 tiles, 6 px). */
export function apronFillFade(dOut: number, tilesPerPx: number): number {
  return smoothstep(0, Math.max(1.5, 6 * tilesPerPx), dOut);
}

/** Relief shading fades to flat over this many tiles inside the map edge. */
export const EDGE_FLAT_TILES = 3;

// ---------------------------------------------------------------------------
// Fallout (lot 3, item 5): burnt ground close up, a sickly tint zoomed out.
// The terrain shader's fallout block mirrors these (tested against it).
// ---------------------------------------------------------------------------

/** Tiles per device px over which the ash look replaces the far tint. */
export const FALLOUT_NEAR_TPP: readonly [number, number] = [0.18, 0.5];
/** Hotspots fade out over this footprint range (they would shimmer). */
export const FALLOUT_HOT_TPP: readonly [number, number] = [0.25, 0.5];
/** Embers fade in below this footprint range (a tile over ~4-8 px). */
export const FALLOUT_EMBER_TPP: readonly [number, number] = [0.12, 0.25];
/** Share of fallout tiles holding an ember, plus this × hotspot strength. */
export const EMBER_DENSITY = 0.02;
export const EMBER_DENSITY_HOT = 0.2;
/** Ember radius: `EMBER_MIN_PX` device px, clamped to these tile sizes. */
export const EMBER_MIN_PX = 1.3;
export const EMBER_MIN_TILES = 0.06;
export const EMBER_MAX_TILES = 0.25;
/** Ember centres lie this far (tiles) inside their tile's edges. */
export const EMBER_MARGIN = 0.25;

/** Hotspot lattice cell side, tiles (the lattice is rotated). */
export const FALLOUT_HOT_CELL = 16;
/** Share of the lattice cells holding a hotspot. */
export const FALLOUT_HOT_SHARE = 0.1;
/** Hotspot radius range, cell units (1.6-3.2 tiles). */
export const FALLOUT_HOT_RADIUS: readonly [number, number] = [0.1, 0.2];
/**
 * A hotspot shows only where the 4 tiles this far (tiles) from its centre
 * along the axes are fallout too: well inside the zone, not on its edge.
 */
export const FALLOUT_HOT_CLEAR = 6;

/**
 * The hotspot of a lattice cell from its two hashes (`h0`, `h1` in [0, 1)),
 * as the terrain shader draws it: none from `FALLOUT_HOT_SHARE` on, else a
 * disc of `radius` (cell units, `FALLOUT_HOT_RADIUS`) centred at (cx, cy)
 * in the cell, kept inside it, so the compact glow never crosses a cell
 * edge (no seam, a single hash lookup per pixel).
 */
export function falloutHotspot(
  h0: number,
  h1: number,
): { radius: number; cx: number; cy: number } | null {
  if (h0 >= FALLOUT_HOT_SHARE) return null;
  const fract = (x: number) => x - Math.floor(x);
  const [r0, r1] = FALLOUT_HOT_RADIUS;
  const radius = r0 + (r1 - r0) * fract(h0 * 37);
  return {
    radius,
    cx: radius + (1 - 2 * radius) * h1,
    cy: radius + (1 - 2 * radius) * fract(h0 * 113),
  };
}

/** Zone rim width: `FALLOUT_RIM_PX` device px, 1 to `FALLOUT_RIM_MAX` tiles. */
export const FALLOUT_RIM_PX = 1.6;
export const FALLOUT_RIM_MAX = 4;
/** Rim strength (mix towards the sickly colour) zoomed out / close up. */
export const FALLOUT_RIM_FAR = 0.85;
export const FALLOUT_RIM_NEAR = 0.3;

/**
 * Width (whole tiles) of the sickly rim the terrain shader draws on the
 * fallout tiles next to clean ground (4 taps this far), so the zone reads
 * as a hazard zoomed out while staying exact to the tile.
 */
export function falloutRimTiles(tilesPerPx: number): number {
  return Math.min(
    FALLOUT_RIM_MAX,
    Math.max(1, Math.floor(FALLOUT_RIM_PX * tilesPerPx + 0.5)),
  );
}

/** A hotspot's glow at squared distance `d2` (radius units): compact, C1. */
export function hotspotGlow(d2: number): number {
  const k = Math.max(0, 1 - d2);
  return k * k * k;
}

/** Weights of the terrain shader's fallout look at a footprint. */
export interface FalloutLook {
  /** 0: the far sickly tint, 1: burnt ground and ash. */
  near: number;
  /** Visibility of the glowing hotspots. */
  hot: number;
  /** Visibility of the embers. */
  ember: number;
}

/** Fallout look at `tilesPerPx` (fwidth of the world coordinate). */
export function falloutLook(tilesPerPx: number): FalloutLook {
  return {
    near: 1 - smoothstep(FALLOUT_NEAR_TPP[0], FALLOUT_NEAR_TPP[1], tilesPerPx),
    hot: 1 - smoothstep(FALLOUT_HOT_TPP[0], FALLOUT_HOT_TPP[1], tilesPerPx),
    ember:
      1 - smoothstep(FALLOUT_EMBER_TPP[0], FALLOUT_EMBER_TPP[1], tilesPerPx),
  };
}

/**
 * Ember radius in tiles: at least ~1 device px so it reads, never more than
 * `EMBER_MAX_TILES`, so with its centre `EMBER_MARGIN` inside the tile the
 * disc never leaves its (fallout) tile.
 */
export function emberRadiusTiles(tilesPerPx: number): number {
  return Math.min(
    EMBER_MAX_TILES,
    Math.max(EMBER_MIN_TILES, EMBER_MIN_PX * tilesPerPx),
  );
}

// ---------------------------------------------------------------------------
// Smooth relief close up (lot 3, item 9). The terrain shader samples
// TerrainLayer's relief texture (slope + height per grid vertex) with a
// cubic B-spline in 4 bilinear taps, and the tile heights with a quadratic
// B-spline over 3 × 3 tiles; these mirror its math.
// ---------------------------------------------------------------------------

/**
 * Grid coordinate (vertex index space) of world `x` on a HeightField axis of
 * `size` tiles with `step` tiles per cell and `vertices` vertices; the last
 * cell is narrower when `size` is not a multiple of `step`.
 */
export function reliefGridCoord(
  x: number,
  step: number,
  vertices: number,
  size: number,
): number {
  const cells = vertices - 1;
  const lastStart = (cells - 1) * step;
  const g =
    x >= lastStart
      ? cells - 1 + (x - lastStart) / Math.max(size - lastStart, 1e-3)
      : x / step;
  return Math.min(cells, Math.max(0, g));
}

/** Uniform cubic B-spline weights of the 4 vertices around fraction `t`. */
export function cubicBsplineWeights(
  t: number,
): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  const w0 = (1 - 3 * t + 3 * t2 - t3) / 6;
  const w1 = (4 - 6 * t2 + 3 * t3) / 6;
  const w3 = t3 / 6;
  return [w0, w1, 1 - w0 - w1 - w3, w3];
}

/**
 * The 2 linear taps replacing the 4 B-spline weights at fraction `t` of the
 * cell starting at vertex i: weights g0 / g1 and positions (vertex index
 * space, relative to i) p0 = −1 + w1 / g0 and p1 = 1 + w3 / g1. A linear
 * fetch at p0 blends vertices −1 and 0 as w0 : w1 (both weights ≥ 0).
 */
export function cubicBsplineTaps(t: number): {
  g0: number;
  g1: number;
  p0: number;
  p1: number;
} {
  const [w0, w1, w2, w3] = cubicBsplineWeights(t);
  const g0 = w0 + w1;
  const g1 = w2 + w3;
  return { g0, g1, p0: -1 + w1 / g0, p1: 1 + w3 / Math.max(g1, 1e-6) };
}

/**
 * Quadratic B-spline weights (and their derivatives) of the 3 tiles around a
 * sample at fraction `f` ∈ [0, 1) of the centre tile's span (tile centres at
 * −1, 0, 1 relative to the centre, the sample at f − 0.5).
 */
export function quadBspline(f: number): {
  w: [number, number, number];
  d: [number, number, number];
} {
  return {
    w: [0.5 * (1 - f) * (1 - f), 0.75 - (f - 0.5) * (f - 0.5), 0.5 * f * f],
    d: [f - 1, 1 - 2 * f, f],
  };
}

/**
 * Value and slope at `q` (tile-centre space: tile k's centre at q = k) of
 * the quadratic B-spline over `heights` (one per tile), as the terrain
 * shader evaluates it close up. Tiles outside the array clamp.
 */
export function quadBsplineAt(
  heights: readonly number[],
  q: number,
): { h: number; slope: number } {
  const c = Math.floor(q + 0.5);
  const f = q - c + 0.5;
  const { w, d } = quadBspline(f);
  const at = (k: number) =>
    heights[Math.min(heights.length - 1, Math.max(0, k))];
  let h = 0;
  let slope = 0;
  for (let i = 0; i < 3; i++) {
    h += w[i] * at(c - 1 + i);
    slope += d[i] * at(c - 1 + i);
  }
  return { h, slope };
}

/** The bilinear blend the far look keeps (its slope jumps at tile centres). */
export function bilinearAt(
  heights: readonly number[],
  q: number,
): { h: number; slope: number } {
  const b = Math.floor(q);
  const w = q - b;
  const at = (k: number) =>
    heights[Math.min(heights.length - 1, Math.max(0, k))];
  return { h: at(b) + (at(b + 1) - at(b)) * w, slope: at(b + 1) - at(b) };
}

// ---------------------------------------------------------------------------
// Water glints scaled to the screen (lot 3, item 8; shaders/water.ts)
// ---------------------------------------------------------------------------

/** Glitter period target, device px (the two octaves sit around it). */
export const GLITTER_PX = 5;
/** A wave octave leaves the glints as its wavelength grows over this (px). */
export const GLINT_WAVE_PX: readonly [number, number] = [16, 40];

/**
 * The glitter layer's two octaves at a footprint: level k (period 2^k tiles,
 * weight 1 − fr) and k + 1 (weight fr), with 2^(k + fr) = GLITTER_PX device
 * px. Continuous in the zoom: when fr wraps to 0 the octave of weight 1 is
 * the same level as the one that had weight 1 just before.
 */
export function glitterLevels(tilesPerPx: number): {
  k: number;
  fr: number;
  periods: [number, number];
} {
  const L = Math.log2(Math.max(tilesPerPx, 1e-4) * GLITTER_PX);
  const k = Math.floor(L);
  return { k, fr: L - k, periods: [2 ** k, 2 ** (k + 1)] };
}

/** Weight of a wave octave of `lambda` tiles in the glints at a footprint. */
export function glintWaveWeight(lambda: number, tilesPerPx: number): number {
  return (
    1 - smoothstep(GLINT_WAVE_PX[0], GLINT_WAVE_PX[1], lambda / tilesPerPx)
  );
}
