/**
 * HeightField — a downsampled elevation grid built from the per-tile terrain
 * bytes, shared by every Three.js layer (relief mesh, water, unit placement,
 * picking).
 *
 * Grid: vertex (i, j) sits at world (vertexX(i), vertexY(j)) =
 * (min(i*step, W), min(j*step, H)), i ∈ [0, cols), j ∈ [0, rows), so the grid
 * spans exactly [0, W]×[0, H] (the last row/column cell may be narrower than
 * `step`). `step = ceil(sqrt(W*H / targetVertices))` bounds the vertex count.
 *
 * Each vertex height is the mean tile height (`heightForTerrainByte`) of the
 * tiles whose centres lie within ±step/2 of the vertex, followed by an
 * optional sign-preserving 3×3 binomial blur (softens the 1-tile magnitude
 * staircase without sinking coasts below the water or raising the seabed above
 * it). World units: 1 = one tile, Y up, sea level 0.
 *
 * The full-map `terrain` byte array is owned here and patched in place by
 * `applyRects`, so layers that keep a reference to it always see current
 * bytes.
 */

import type { TerrainRect } from "../types";
import { buildHeightLut } from "./TerrainCodec";

export interface HeightFieldOptions {
  heightScale: number;
  seabedDepth: number;
  targetVertices: number;
  /** Apply the 3×3 sign-preserving blur (default true). */
  smooth?: boolean;
}

/** Inclusive range of grid vertex indices. */
export interface GridRange {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

/** Grid step (tiles per cell) keeping the vertex count near `targetVertices`. */
export function gridStepFor(
  mapWidth: number,
  mapHeight: number,
  targetVertices: number,
): number {
  const target = Math.max(1, targetVertices);
  return Math.max(1, Math.ceil(Math.sqrt((mapWidth * mapHeight) / target)));
}

export class HeightField {
  readonly mapWidth: number;
  readonly mapHeight: number;
  /** Tiles per grid cell (integer ≥ 1). */
  readonly step: number;
  /** Vertex count along X: ceil(W/step) + 1. */
  readonly cols: number;
  /** Vertex count along Y (world Z): ceil(H/step) + 1. */
  readonly rows: number;
  /** Final vertex heights (world Y), row-major `j * cols + i`. */
  readonly heights: Float32Array;
  /** Full-map terrain bytes (`y * W + x`), kept current by `applyRects`. */
  readonly terrain: Uint8Array;
  readonly heightScale: number;
  readonly seabedDepth: number;
  /** Bumped on every height change (full rebuild or rect patch). */
  version = 0;
  /** Lowest / highest vertex height (conservative after partial updates). */
  minHeight = 0;
  maxHeight = 0;
  /** Vertices changed by the most recent rebuild / applyRects. */
  lastDirty: GridRange | null = null;

  private readonly raw: Float32Array;
  private readonly lut: Float32Array;
  private readonly smooth: boolean;

  constructor(
    mapWidth: number,
    mapHeight: number,
    terrain: Uint8Array,
    opts: HeightFieldOptions,
  ) {
    if (terrain.length !== mapWidth * mapHeight) {
      throw new Error(
        `HeightField: terrain has ${terrain.length} bytes, expected ${mapWidth * mapHeight}`,
      );
    }
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.terrain = terrain;
    this.heightScale = opts.heightScale;
    this.seabedDepth = opts.seabedDepth;
    this.smooth = opts.smooth ?? true;
    this.step = gridStepFor(mapWidth, mapHeight, opts.targetVertices);
    this.cols = Math.ceil(mapWidth / this.step) + 1;
    this.rows = Math.ceil(mapHeight / this.step) + 1;
    this.raw = new Float32Array(this.cols * this.rows);
    this.heights = new Float32Array(this.cols * this.rows);
    this.lut = buildHeightLut(opts.heightScale, opts.seabedDepth);
    this.rebuild();
  }

  get vertexCount(): number {
    return this.cols * this.rows;
  }

  /** World X of grid column i. */
  vertexX(i: number): number {
    return Math.min(i * this.step, this.mapWidth);
  }

  /** World Y (= three Z) of grid row j. */
  vertexY(j: number): number {
    return Math.min(j * this.step, this.mapHeight);
  }

  /** Recompute every vertex from `terrain`. */
  rebuild(): void {
    const all: GridRange = {
      i0: 0,
      j0: 0,
      i1: this.cols - 1,
      j1: this.rows - 1,
    };
    this.computeRaw(all);
    this.computeFinal(all);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < this.heights.length; k++) {
      const h = this.heights[k];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    this.minHeight = lo;
    this.maxHeight = hi;
    this.lastDirty = all;
    this.version++;
  }

  /**
   * Patch terrain bytes (rects concatenated row-major in `bytes`, as
   * `MapRenderer.applyTerrainRects` receives them) and recompute the affected
   * vertices. Returns the changed vertex range (also in `lastDirty`), or null
   * when nothing was applied.
   */
  applyRects(
    rects: readonly TerrainRect[],
    bytes: Uint8Array,
  ): GridRange | null {
    const W = this.mapWidth;
    const H = this.mapHeight;
    let tx0 = Infinity;
    let ty0 = Infinity;
    let tx1 = -Infinity;
    let ty1 = -Infinity;
    let off = 0;
    for (const r of rects) {
      const n = r.w * r.h;
      if (
        r.w > 0 &&
        r.h > 0 &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.x + r.w <= W &&
        r.y + r.h <= H &&
        off + n <= bytes.length
      ) {
        for (let row = 0; row < r.h; row++) {
          const src = off + row * r.w;
          this.terrain.set(
            bytes.subarray(src, src + r.w),
            (r.y + row) * W + r.x,
          );
        }
        tx0 = Math.min(tx0, r.x);
        ty0 = Math.min(ty0, r.y);
        tx1 = Math.max(tx1, r.x + r.w - 1);
        ty1 = Math.max(ty1, r.y + r.h - 1);
      }
      off += Math.max(0, n);
    }
    if (tx0 > tx1) return null;

    // Vertices whose averaging window (tile centres within ±step/2) touches
    // the changed tiles, then one more ring for the 3×3 blur.
    const s = this.step;
    const rawRange: GridRange = {
      i0: Math.max(0, Math.floor((tx0 - s / 2) / s)),
      j0: Math.max(0, Math.floor((ty0 - s / 2) / s)),
      i1: Math.min(this.cols - 1, Math.ceil((tx1 + 1 + s / 2) / s)),
      j1: Math.min(this.rows - 1, Math.ceil((ty1 + 1 + s / 2) / s)),
    };
    const pad = this.smooth ? 1 : 0;
    const dirty: GridRange = {
      i0: Math.max(0, rawRange.i0 - pad),
      j0: Math.max(0, rawRange.j0 - pad),
      i1: Math.min(this.cols - 1, rawRange.i1 + pad),
      j1: Math.min(this.rows - 1, rawRange.j1 + pad),
    };
    this.computeRaw(rawRange);
    this.computeFinal(dirty);
    for (let j = dirty.j0; j <= dirty.j1; j++) {
      for (let i = dirty.i0; i <= dirty.i1; i++) {
        const h = this.heights[j * this.cols + i];
        if (h < this.minHeight) this.minHeight = h;
        if (h > this.maxHeight) this.maxHeight = h;
      }
    }
    this.lastDirty = dirty;
    this.version++;
    return dirty;
  }

  /**
   * Bilinearly interpolated height (world Y) at world (x, y); points outside
   * the map clamp to the edge.
   */
  heightAt(x: number, y: number): number {
    const cols = this.cols;
    const s = this.step;
    const xc = x > 0 ? (x < this.mapWidth ? x : this.mapWidth) : 0;
    const yc = y > 0 ? (y < this.mapHeight ? y : this.mapHeight) : 0;
    let i = Math.floor(xc / s);
    if (i > cols - 2) i = cols - 2;
    let j = Math.floor(yc / s);
    if (j > this.rows - 2) j = this.rows - 2;
    const x0 = i * s;
    const y0 = j * s;
    const fx = Math.min(1, (xc - x0) / (this.vertexX(i + 1) - x0));
    const fy = Math.min(1, (yc - y0) / (this.vertexY(j + 1) - y0));
    const k = j * cols + i;
    const h = this.heights;
    const top = h[k] + (h[k + 1] - h[k]) * fx;
    const bottom = h[k + cols] + (h[k + cols + 1] - h[k + cols]) * fx;
    return top + (bottom - top) * fy;
  }

  /**
   * Height of the visible surface: the terrain on land, the water plane
   * (Y = 0) over the seabed. Use this to place things on the map and to pick.
   */
  surfaceAt(x: number, y: number): number {
    const h = this.heightAt(x, y);
    return h > 0 ? h : 0;
  }

  /** Terrain byte of the tile containing world (x, y), clamped to the map. */
  terrainByteAt(x: number, y: number): number {
    const tx = Math.min(this.mapWidth - 1, Math.max(0, Math.floor(x)));
    const ty = Math.min(this.mapHeight - 1, Math.max(0, Math.floor(y)));
    return this.terrain[ty * this.mapWidth + tx];
  }

  /** Mean tile height around each vertex of `r` into `raw`. */
  private computeRaw(r: GridRange): void {
    const W = this.mapWidth;
    const H = this.mapHeight;
    const s = this.step;
    const half = s / 2;
    const terrain = this.terrain;
    const lut = this.lut;
    for (let j = r.j0; j <= r.j1; j++) {
      const vy = this.vertexY(j);
      // Tiles t whose centre t + 0.5 is within ±step/2 of the vertex.
      const ty0 = Math.max(0, Math.ceil(vy - half - 0.5));
      const ty1 = Math.min(H - 1, Math.floor(vy + half - 0.5));
      for (let i = r.i0; i <= r.i1; i++) {
        const vx = this.vertexX(i);
        const tx0 = Math.max(0, Math.ceil(vx - half - 0.5));
        const tx1 = Math.min(W - 1, Math.floor(vx + half - 0.5));
        let sum = 0;
        let n = 0;
        for (let ty = ty0; ty <= ty1; ty++) {
          const row = ty * W;
          for (let tx = tx0; tx <= tx1; tx++) {
            sum += lut[terrain[row + tx]];
            n++;
          }
        }
        this.raw[j * this.cols + i] = n > 0 ? sum / n : 0;
      }
    }
  }

  /** `heights` over `r` from `raw` (blurred when smoothing is on). */
  private computeFinal(r: GridRange): void {
    const cols = this.cols;
    const rows = this.rows;
    const raw = this.raw;
    const out = this.heights;
    if (!this.smooth) {
      for (let j = r.j0; j <= r.j1; j++) {
        const k = j * cols;
        out.set(raw.subarray(k + r.i0, k + r.i1 + 1), k + r.i0);
      }
      return;
    }
    for (let j = r.j0; j <= r.j1; j++) {
      const jm = (j > 0 ? j - 1 : 0) * cols;
      const jc = j * cols;
      const jp = (j < rows - 1 ? j + 1 : j) * cols;
      for (let i = r.i0; i <= r.i1; i++) {
        const im = i > 0 ? i - 1 : 0;
        const ip = i < cols - 1 ? i + 1 : i;
        // [1 2 1] ⊗ [1 2 1] / 16, edges clamped.
        const blurred =
          (raw[jm + im] +
            2 * raw[jm + i] +
            raw[jm + ip] +
            2 * (raw[jc + im] + 2 * raw[jc + i] + raw[jc + ip]) +
            raw[jp + im] +
            2 * raw[jp + i] +
            raw[jp + ip]) /
          16;
        const c = raw[jc + i];
        // Keep at least half the unblurred height on the same side of sea
        // level, so blurring never floods thin land or lifts shallow water.
        out[jc + i] =
          c > 0
            ? Math.max(blurred, 0.5 * c)
            : c < 0
              ? Math.min(blurred, 0.5 * c)
              : blurred;
      }
    }
  }
}
