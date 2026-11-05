import { describe, expect, it } from "vitest";
import { TERRAIN_FRAG } from "../../../src/client/render/three/shaders/terrain";
import { WATER_COMMON } from "../../../src/client/render/three/shaders/water";
import {
  addTexelSpan,
  ALT_FILL_ALPHA_FAR,
  ALT_FILL_ALPHA_NEAR,
  APRON_RAGGED,
  APRON_REACH_MAX,
  APRON_REACH_MIN,
  APRON_REACH_NOISE,
  APRON_WARP_CAP,
  APRON_WARP_FREQ,
  APRON_WARP_GAIN,
  APRON_ZOOM_NEAR,
  apronFillFade,
  apronReachZoomScale,
  apronWarp,
  apronWaterMagnitude,
  apronWidthTiles,
  BORDER_CSS_PX_FAR,
  BORDER_CSS_PX_NEAR,
  borderContrastNeed,
  borderWidthTiles,
  closeUpAmount,
  computeCellLand,
  edgeCoverage,
  EDGE_FLAT_TILES,
  edgeReachTiles,
  FAR_FILL_ALPHA,
  FAR_HILLSHADE_FLATTEN,
  fogRangeForView,
  hexToSrgb01,
  mirrorIntoMap,
  RowSpans,
  SHORE_FAR_SCALE,
  SHORE_SCALE_TPP,
  sharpenZoneWeights,
  shoreViewScale,
  srgbToLinear,
  territoryFarWeight,
  territoryLook,
  vertexTouchesLand,
  virtualLandReach,
  waterColors,
  zoneSharpness,
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

describe("close-up zone blend (mirrors the terrain shader)", () => {
  it("keeps strategy zoom on the 2D-like look and goes fully close-up from ~7 px per tile", () => {
    expect(closeUpAmount(1 / 1.8)).toBe(0); // default zoom, dpr 1
    expect(closeUpAmount(1 / 8)).toBe(1);
    expect(closeUpAmount(1 / 4)).toBeGreaterThan(0);
    expect(closeUpAmount(1 / 4)).toBeLessThan(1);
    expect(zoneSharpness(1 / 1.8, closeUpAmount(1 / 1.8))).toBe(0);
    expect(zoneSharpness(1 / 8, 1)).toBeCloseTo(6, 12);
  });

  it("is the plain (normalised) bilinear blend at k = 0", () => {
    const w = sharpenZoneWeights([0.1, 0.2, 0.3, 0.2], [0, 1, 1, 2], 0);
    const expected = [0.125, 0.25, 0.375, 0.25];
    for (let i = 0; i < 4; i++) expect(w[i]).toBeCloseTo(expected[i], 12);
  });

  it("turns a two-zone edge into a ~2 px transition", () => {
    // Zone 0 on the west corners, zone 1 on the east ones, x across the edge.
    const k = zoneSharpness(1 / 8, 1); // 8 px per tile
    const west = (x: number) => {
      const w = sharpenZoneWeights(
        [(1 - x) / 2, x / 2, (1 - x) / 2, x / 2],
        [0, 1, 0, 1],
        k,
      );
      return w[0] + w[2];
    };
    expect(west(0.5)).toBeCloseTo(0.5, 12);
    // Bisect the 88% and 12% crossings.
    const cross = (level: number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (west(mid) > level) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const span = cross(0.12) - cross(0.88);
    expect(span).toBeCloseTo(4 / (4 + 2 * k), 1);
    expect(span * 8).toBeGreaterThan(1.5); // pixels: anti-aliased
    expect(span * 8).toBeLessThan(2.6); // and crisp
    // Sharper with a larger k; bilinear (span 0.76) with none.
    expect(west(0.3)).toBeGreaterThan(0.95);
  });

  it("ignores corners without weight (water / void)", () => {
    const w = sharpenZoneWeights([0.5, 0, 0.5, 0], [1, 0, 2, 0], 10);
    expect(w[1]).toBe(0);
    expect(w[3]).toBe(0);
    expect(w[0] + w[2]).toBeCloseTo(1, 12);
    expect(sharpenZoneWeights([0, 0, 0, 0], [0, 1, 2, 0], 4)).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe("border contrast need", () => {
  const lin = (s: number) => srgbToLinear(s);
  it("is high for the local player's light grey band on snow", () => {
    expect(borderContrastNeed(lin(0.9), lin(0.98))).toBeGreaterThan(0.85);
  });
  it("is zero for a light band on a darker territory fill", () => {
    expect(borderContrastNeed(lin(0.9), lin(0.45))).toBe(0);
    expect(borderContrastNeed(lin(0.2), lin(0.9))).toBe(0);
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

describe("territory look by zoom (lot 3, item 3)", () => {
  const BASE = 0.588; // mapOverlay.territoryAlpha

  it("is the settings' look from 5 CSS px per tile on (close up untouched)", () => {
    for (const z of [5, 8, 12, 20]) {
      const l = territoryLook(z, BASE);
      expect(l.far).toBe(0);
      expect(l.fillAlpha).toBeCloseTo(BASE, 12);
      expect(l.flatten).toBe(0);
      expect(l.altFillAlpha).toBeCloseTo(ALT_FILL_ALPHA_NEAR, 12);
    }
    expect(territoryLook(8, BASE).borderCssPx).toBeCloseTo(
      BORDER_CSS_PX_NEAR,
      12,
    );
    expect(territoryLook(20, BASE).borderCssPx).toBeCloseTo(
      BORDER_CSS_PX_NEAR,
      12,
    );
  });

  it("is the full strategy look at full map", () => {
    const l = territoryLook(0.7, BASE);
    expect(l.far).toBe(1);
    expect(l.fillAlpha).toBeCloseTo(FAR_FILL_ALPHA, 12);
    expect(l.borderCssPx).toBeCloseTo(BORDER_CSS_PX_FAR, 12);
    expect(l.flatten).toBeCloseTo(FAR_HILLSHADE_FLATTEN, 12);
    expect(l.altFillAlpha).toBeCloseTo(ALT_FILL_ALPHA_FAR, 12);
  });

  it("strengthens fill and borders monotonically as the camera zooms out", () => {
    let prev = territoryLook(30, BASE);
    for (let z = 29.9; z >= 0.3; z -= 0.1) {
      const l = territoryLook(z, BASE);
      expect(l.fillAlpha).toBeGreaterThanOrEqual(prev.fillAlpha - 1e-12);
      expect(l.borderCssPx).toBeGreaterThanOrEqual(prev.borderCssPx - 1e-12);
      expect(l.flatten).toBeGreaterThanOrEqual(prev.flatten - 1e-12);
      expect(l.altFillAlpha).toBeGreaterThanOrEqual(prev.altFillAlpha - 1e-12);
      prev = l;
    }
    // The default zoom (1.8) is nearly the full strategy look; at 1.8 the
    // border reaches one full tile, like the default renderer's.
    const def = territoryLook(1.8, BASE);
    expect(def.fillAlpha).toBeGreaterThan(0.8);
    expect(borderWidthTiles(def.borderCssPx, 1 / 1.8, 0.2)).toBe(1);
    // ~4 px per tile: in between.
    const mid = territoryLook(4, BASE);
    expect(mid.fillAlpha).toBeGreaterThan(BASE);
    expect(mid.fillAlpha).toBeLessThan(def.fillAlpha);
    expect(territoryFarWeight(4)).toBeGreaterThan(0);
    expect(territoryFarWeight(4)).toBeLessThan(0.5);
  });

  it("never lowers a stronger configured fill", () => {
    expect(territoryLook(0.7, 0.95).fillAlpha).toBeCloseTo(0.95, 12);
    expect(territoryLook(0.7, 1.4).fillAlpha).toBe(1);
  });
});

describe("shore halo and map-edge apron (lot 3, item 6)", () => {
  it("narrows the shallow-water halo only when zoomed out", () => {
    expect(shoreViewScale(0.1)).toBe(1); // a tile over 10 px
    expect(shoreViewScale(SHORE_SCALE_TPP[0])).toBe(1);
    expect(shoreViewScale(1 / 0.7)).toBe(SHORE_FAR_SCALE); // full map, 1x
    // The see-through shelf (d < 0.8: magnitude ~7.7 tiles) is then at
    // most ~2 px wide at full map instead of ~5.4.
    const shelfTiles = 0.8 * 0.8 * 12;
    expect(shelfTiles / shoreViewScale(1 / 0.7) / (1 / 0.7)).toBeLessThan(2);
    let prev = 0;
    for (let tpp = 0.05; tpp < 3; tpp += 0.05) {
      expect(shoreViewScale(tpp)).toBeGreaterThanOrEqual(prev);
      prev = shoreViewScale(tpp);
    }
  });

  it("mirrors the GLSL constants", () => {
    // shaders/water.ts: 1.0 + (FAR - 1) * smoothstep(lo, hi, tpp)
    const m =
      /return 1\.0 \+ ([\d.]+) \* smoothstep\(([\d.]+), ([\d.]+), tpp\);/.exec(
        WATER_COMMON,
      );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(SHORE_FAR_SCALE - 1);
    expect([Number(m![2]), Number(m![3])]).toEqual([...SHORE_SCALE_TPP]);
    // shaders/terrain.ts: reach = uEdgeReach * (MIN + (MAX - MIN)
    // smoothstep(noise range, nz) + RAGGED (n2 - 0.5)), never below 0.
    const r =
      /uEdgeReach \* \(([\d.]+) \+ ([\d.]+) \* smoothstep\(([\d.]+), ([\d.]+), nz\)\s+\+ ([\d.]+) \* \(valueNoise/.exec(
        TERRAIN_FRAG,
      );
    expect(r).not.toBeNull();
    expect(Number(r![1])).toBeCloseTo(APRON_REACH_MIN, 9);
    expect(Number(r![2])).toBeCloseTo(APRON_REACH_MAX - APRON_REACH_MIN, 9);
    expect([Number(r![3]), Number(r![4])]).toEqual([...APRON_REACH_NOISE]);
    expect(Number(r![5])).toBeCloseTo(APRON_RAGGED, 9);
    // apronWaterMagnitude: the coast's distance, then open sea.
    expect(TERRAIN_FRAG).toContain(
      "float magA = min(max(max(magM, 0.0), dOut - reach), 16.0);",
    );
    expect(TERRAIN_FRAG).toContain(
      "smoothstep(reach + 0.5 * uEdgeReach, reach + uEdgeReach + 8.0, dOut)",
    );
    // apronFillFade, the warp (apronWarp) and the mirror.
    expect(TERRAIN_FRAG).toContain(
      "float fillFade = smoothstep(0.0, max(1.5, 6.0 * tpp), dOut);",
    );
    const w =
      /valueNoise\(p \* ([\d.]+) \+ vec2\(1\.3, 7\.1\)\)[\s\S]*?\(wn - 0\.5\) \* \(([\d.]+) \* min\(dOut, ([\d.]+)\)\)/.exec(
        TERRAIN_FRAG,
      );
    expect(w).not.toBeNull();
    expect(Number(w![1])).toBe(APRON_WARP_FREQ);
    expect(Number(w![2])).toBe(APRON_WARP_GAIN);
    expect(Number(w![3])).toBe(APRON_WARP_CAP);
    expect(TERRAIN_FRAG).toContain(
      "vec2(uMapSize) - abs(vec2(uMapSize) - abs(pw))",
    );
    // The relief fades flat over the last EDGE_FLAT_TILES inside the map.
    expect(TERRAIN_FRAG).toContain(
      `smoothstep(0.0, ${EDGE_FLAT_TILES}.0, min(inMap.x, inMap.y))`,
    );
  });

  it("sizes the virtual land and the apron from the map", () => {
    expect(edgeReachTiles(2000, 1000)).toBeCloseTo(18, 9); // World
    expect(edgeReachTiles(100, 80)).toBe(8);
    expect(edgeReachTiles(8000, 4000)).toBe(32);
    for (const [w, h] of [
      [2000, 1000],
      [100, 80],
      [8000, 4000],
    ]) {
      const reach = edgeReachTiles(w, h);
      const apron = apronWidthTiles(w, h);
      // Open sea at the rim whatever the noise, the edge water and the
      // zoom (the reach shrinks close up), so WaterLayer's plane continues
      // it seamlessly.
      for (const k of [1, apronReachZoomScale(20)]) {
        const mean = reach * k;
        for (const [n, rag] of [
          [1, 1],
          [0, 0],
          [0.5, 0.5],
        ]) {
          for (const m of [-1, 0, 3, 15]) {
            expect(
              apronWaterMagnitude(
                m,
                apron,
                virtualLandReach(n, mean, rag),
                mean,
              ),
            ).toBe(16);
          }
        }
      }
    }
  });

  it("mirrors the map at its border off the map, identity on it", () => {
    const W = 2000;
    for (const x of [0, 0.5, 999.25, 1999.5, 2000]) {
      expect(mirrorIntoMap(x, W)).toBe(x);
    }
    expect(mirrorIntoMap(-0.25, W)).toBe(0.25);
    expect(mirrorIntoMap(-30, W)).toBe(30);
    expect(mirrorIntoMap(2000.25, W)).toBe(1999.75);
    expect(mirrorIntoMap(2072, W)).toBe(1928);
    // Continuous across the border (no jump: no seam in the lookups).
    expect(mirrorIntoMap(-1e-6, W)).toBeCloseTo(mirrorIntoMap(1e-6, W), 5);
    expect(mirrorIntoMap(W + 1e-6, W)).toBeCloseTo(
      mirrorIntoMap(W - 1e-6, W),
      5,
    );
  });

  it("continues the land up to a noisy virtual coast, then deepens", () => {
    const reach = 24;
    // Between 0.15 and 2 times the mean reach (some land dies at the edge,
    // some runs far: no band parallel to the edge), ± the ragged term.
    expect(virtualLandReach(0, reach)).toBeCloseTo(0.15 * reach, 9);
    expect(virtualLandReach(APRON_REACH_NOISE[0], reach)).toBeCloseTo(
      0.15 * reach,
      9,
    );
    expect(virtualLandReach(1, reach)).toBeCloseTo(2 * reach, 9);
    expect(virtualLandReach(0.5, reach)).toBeCloseTo(1.075 * reach, 9);
    expect(virtualLandReach(1, reach, 1)).toBeCloseTo(2.15 * reach, 9);
    expect(virtualLandReach(0, reach, 0)).toBe(0);
    // Up to the virtual coast the mirrored water keeps its depth; past it
    // the water is as deep as it is far from the coast (a shelf like a
    // real coast's, not a wide shallow band), then open sea.
    const r = virtualLandReach(0.5, reach);
    expect(apronWaterMagnitude(-1, r, r, reach)).toBe(0);
    expect(apronWaterMagnitude(5, r / 2, r, reach)).toBe(5);
    expect(apronWaterMagnitude(-1, r + 3, r, reach)).toBe(3);
    expect(apronWaterMagnitude(7, r + 3, r, reach)).toBe(7);
    expect(apronWaterMagnitude(-1, r + reach + 8, r, reach)).toBe(16);
    let prev = 0;
    for (let d = r; d < r + reach + 8; d += 0.5) {
      const m = apronWaterMagnitude(-1, d, r, reach);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
    // The fill stops at the edge: gone within max(1.5 tiles, 6 px).
    expect(apronFillFade(0, 1)).toBe(0);
    expect(apronFillFade(1.5, 0.1)).toBe(1);
    expect(apronFillFade(6 / 0.7, 1 / 0.7)).toBe(1);
    expect(apronFillFade(1, 1 / 0.7)).toBeLessThan(0.1);
  });

  it("warps the mirrored lookups more with the distance, and shrinks close up", () => {
    // Continuous with the map at the edge, growing, capped.
    expect(apronWarp(1, 0)).toBe(0);
    expect(apronWarp(0.5, 15)).toBe(0);
    expect(Math.abs(apronWarp(1, 10))).toBeCloseTo(0.5 * APRON_WARP_GAIN * 10);
    expect(apronWarp(1, 100)).toBe(apronWarp(1, APRON_WARP_CAP));
    // No fold: the warp's slope along the normal stays under 1.
    expect(0.5 * APRON_WARP_GAIN).toBeLessThan(1);
    // The made-up land is a short fringe close up.
    expect(apronReachZoomScale(0.7)).toBe(1);
    expect(apronReachZoomScale(1.8)).toBe(1);
    expect(apronReachZoomScale(20)).toBe(APRON_ZOOM_NEAR);
    let prev = 1;
    for (let z = 0.5; z < 20; z += 0.25) {
      expect(apronReachZoomScale(z)).toBeLessThanOrEqual(prev);
      prev = apronReachZoomScale(z);
    }
  });
});
