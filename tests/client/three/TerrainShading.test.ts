import { describe, expect, it } from "vitest";
import {
  addTexelSpan,
  borderWidthTiles,
  computeCellLand,
  edgeCoverage,
  fogRangeForView,
  hexToSrgb01,
  RowSpans,
  srgbToLinear,
  vertexTouchesLand,
  waterColors,
} from "../../../src/client/render/three/TerrainShading";

describe("colour helpers", () => {
  it("converts sRGB to linear with the exact transfer function", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 5);
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
  });

  it("parses #rrggbb and falls back on bad input", () => {
    expect(hexToSrgb01("#ff8000", [0, 0, 0])).toEqual([1, 128 / 255, 0]);
    expect(hexToSrgb01("4785b5", [0, 0, 0])).toEqual([
      71 / 255,
      133 / 255,
      181 / 255,
    ]);
    expect(hexToSrgb01("nope", [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    expect(hexToSrgb01(undefined, [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });

  it("derives a darker, bluer deep sea and a greener shallow sea", () => {
    const ocean: [number, number, number] = [71 / 255, 133 / 255, 181 / 255];
    const lin = ocean.map(srgbToLinear);
    const { shallow, deep, foam } = waterColors(ocean);
    for (const c of [shallow, deep, foam]) {
      for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    for (let i = 0; i < 3; i++) expect(deep[i]).toBeLessThan(lin[i]);
    // Navy: blue keeps the largest share.
    expect(deep[2] / deep[0]).toBeGreaterThan(lin[2] / lin[0]);
    // Teal: the shallow water is greener relative to blue than the ocean.
    expect(shallow[1] / shallow[2]).toBeGreaterThan(lin[1] / lin[2]);
  });
});

describe("border width / coverage (mirrors the terrain shader)", () => {
  const PX = 1.3;
  const MIN = 0.12;

  it("is one full tile when zoomed out", () => {
    // 2 tiles per pixel: a 1.3 px band would be 2.6 tiles.
    expect(borderWidthTiles(PX, 2, MIN)).toBe(1);
    expect(edgeCoverage(0.99, 1, 2)).toBe(1);
  });

  it("keeps ~1.3 px until it reaches the minimum tile fraction", () => {
    for (const tpp of [0.1, 0.25, 0.5]) {
      const w = borderWidthTiles(PX, tpp, MIN);
      expect(w / tpp).toBeCloseTo(PX, 9);
    }
  });

  it("becomes a thin line (MIN tiles) when zoomed in", () => {
    // 50 px per tile.
    expect(borderWidthTiles(PX, 1 / 50, MIN)).toBe(MIN);
  });

  it("ramps over one pixel centred on the band edge", () => {
    const aa = 0.02;
    const w = 0.12;
    expect(edgeCoverage(0, w, aa)).toBe(1);
    expect(edgeCoverage(w, w, aa)).toBeCloseTo(0.5, 12);
    expect(edgeCoverage(w + aa / 2, w, aa)).toBeCloseTo(0, 12);
    expect(edgeCoverage(0.5, w, aa)).toBe(0);
    let prev = 1;
    for (let d = 0; d <= 0.2; d += 0.005) {
      const c = edgeCoverage(d, w, aa);
      expect(c).toBeLessThanOrEqual(prev + 1e-12);
      prev = c;
    }
  });
});

describe("fogRangeForView", () => {
  it("leaves a top-down view unfogged", () => {
    // Top-down every ground point is at view depth = distance; peaks are
    // closer. The fog must start beyond it.
    const { near, far } = fogRangeForView(100, 0);
    expect(near).toBeGreaterThan(100);
    expect(far).toBeGreaterThan(near);
  });

  it("pulls the fog in when tilted, scaling with distance", () => {
    const flat = fogRangeForView(100, 0);
    const tilted = fogRangeForView(100, 1);
    expect(tilted.near).toBeLessThan(flat.near);
    expect(tilted.far).toBeLessThan(flat.far);
    expect(tilted.far).toBeGreaterThan(tilted.near);
    const far = fogRangeForView(1000, 1);
    expect(far.near).toBeCloseTo(tilted.near * 10, 9);
    // Out-of-range tilt fractions clamp.
    expect(fogRangeForView(100, 3)).toEqual(tilted);
  });
});

describe("RowSpans", () => {
  it("groups refs by row with min / max x", () => {
    const W = 10;
    const spans = new RowSpans(W, 5);
    const n = spans.collect([3 * W + 7, 1 * W + 2, 3 * W + 1, 1 * W + 2, 4]);
    expect(n).toBe(3);
    const got = new Map<number, [number, number]>();
    for (let k = 0; k < n; k++) {
      got.set(spans.rows[k], [spans.x0[k], spans.x1[k]]);
    }
    expect(got).toEqual(
      new Map([
        [3, [1, 7]],
        [1, [2, 2]],
        [0, [4, 4]],
      ]),
    );
  });

  it("resets its scratch between calls and ignores bad refs", () => {
    const W = 8;
    const spans = new RowSpans(W, 4);
    spans.collect([0, 7, 2 * W + 3]);
    const n = spans.collect([2 * W + 5, -1, 4 * W, Number.NaN]);
    expect(n).toBe(1);
    expect([spans.rows[0], spans.x0[0], spans.x1[0]]).toEqual([2, 5, 5]);
  });
});

describe("addTexelSpan", () => {
  it("emits single-row ranges in three's RGBA component units", () => {
    const ranges: [number, number][] = [];
    const tex = {
      addUpdateRange: (s: number, c: number) => ranges.push([s, c]),
    };
    addTexelSpan(tex, 100, 10, 3, 5);
    // Clipped to the row: x 95..99 only.
    addTexelSpan(tex, 100, 95, 4, 20);
    addTexelSpan(tex, 100, -5, 0, 10);
    addTexelSpan(tex, 100, 120, 0, 3); // fully outside: nothing
    expect(ranges).toEqual([
      [(3 * 100 + 10) * 4, 5 * 4],
      [(4 * 100 + 95) * 4, 5 * 4],
      [0, 5 * 4],
    ]);
    // three r186 converts back with floor(start / 4), ceil(count / 4) and
    // uploads one row at (x, y) = (pixel % W, pixel / W): stays in the row.
    for (const [s, c] of ranges) {
      const pixel = s / 4;
      expect((pixel % 100) + c / 4).toBeLessThanOrEqual(100);
    }
  });
});

describe("coast lift cells", () => {
  // 7 × 5 map, step 3 → cells 3 × 2 (the last column / row narrower).
  const W = 7;
  const H = 5;
  const STEP = 3;
  const CX = 3;
  const CY = 2;
  const LAND = 0x80;

  function terrainWithLand(tiles: [number, number][]): Uint8Array {
    const t = new Uint8Array(W * H).fill(0x05); // water, magnitude 5
    for (const [x, y] of tiles) t[y * W + x] = LAND | 3;
    return t;
  }

  it("marks every cell holding a land tile, including narrow edge cells", () => {
    const t = terrainWithLand([
      [6, 4], // last (1-wide) column, last (2-high) row
      [1, 1],
    ]);
    const out = new Uint8Array(CX * CY);
    computeCellLand(t, W, H, STEP, CX, CY, out);
    expect([...out]).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it("recomputes only the requested cells", () => {
    const t = terrainWithLand([[4, 1]]);
    const out = new Uint8Array(CX * CY);
    computeCellLand(t, W, H, STEP, CX, CY, out);
    expect([...out]).toEqual([0, 1, 0, 0, 0, 0]);
    // The land turns to water (water nuke) and land appears elsewhere.
    t[1 * W + 4] = 0;
    t[4 * W + 0] = LAND;
    computeCellLand(t, W, H, STEP, CX, CY, out, 1, 0, 1, 0);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0]);
    computeCellLand(t, W, H, STEP, CX, CY, out, -5, -5, 99, 99);
    expect([...out]).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it("lifts the vertices around land cells only", () => {
    const out = new Uint8Array(CX * CY);
    computeCellLand(terrainWithLand([[4, 1]]), W, H, STEP, CX, CY, out);
    // Cell (1, 0) has corners (1..2, 0..1).
    const lifted: string[] = [];
    for (let j = 0; j <= CY; j++) {
      for (let i = 0; i <= CX; i++) {
        if (vertexTouchesLand(out, CX, CY, i, j)) lifted.push(`${i},${j}`);
      }
    }
    expect(lifted).toEqual(["1,0", "2,0", "1,1", "2,1"]);
  });
});
