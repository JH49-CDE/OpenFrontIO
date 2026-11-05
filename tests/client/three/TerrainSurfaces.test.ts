import { describe, expect, it } from "vitest";
import { TERRAIN_FRAG } from "../../../src/client/render/three/shaders/terrain";
import { WATER_COMMON } from "../../../src/client/render/three/shaders/water";
import {
  bilinearAt,
  cubicBsplineTaps,
  cubicBsplineWeights,
  EMBER_DENSITY,
  EMBER_DENSITY_HOT,
  EMBER_MARGIN,
  EMBER_MAX_TILES,
  EMBER_MIN_PX,
  EMBER_MIN_TILES,
  emberRadiusTiles,
  FALLOUT_EMBER_TPP,
  FALLOUT_HOT_CELL,
  FALLOUT_HOT_CLEAR,
  FALLOUT_HOT_RADIUS,
  FALLOUT_HOT_SHARE,
  FALLOUT_HOT_TPP,
  FALLOUT_NEAR_TPP,
  FALLOUT_RIM_FAR,
  FALLOUT_RIM_MAX,
  FALLOUT_RIM_NEAR,
  FALLOUT_RIM_PX,
  falloutRimTiles,
  falloutHotspot,
  falloutLook,
  GLINT_WAVE_PX,
  glintWaveWeight,
  GLITTER_PX,
  glitterLevels,
  hotspotGlow,
  quadBsplineAt,
  reliefGridCoord,
} from "../../../src/client/render/three/TerrainShading";

/** Seeded [0, 1) generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The GLSL between a block's BEGIN and END markers. */
function block(src: string, begin: string, end: string): string {
  const a = src.indexOf(begin);
  const b = src.indexOf(end, a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const glsl = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

// ---------------------------------------------------------------------------
// Fallout (item 5)
// ---------------------------------------------------------------------------

describe("fallout look (lot 3, item 5)", () => {
  // Tiles per device px at the reference views (dpr 1).
  const FULL_MAP = 1 / 0.7;
  const DEFAULT = 1 / 1.8;
  const MID = 1 / 5;
  const CLOSE = 1 / 11;

  it("is a muted tint zoomed out and burnt ground close up", () => {
    for (const tpp of [FULL_MAP, DEFAULT]) {
      expect(falloutLook(tpp)).toEqual({ near: 0, hot: 0, ember: 0 });
    }
    const mid = falloutLook(MID);
    expect(mid.near).toBeGreaterThan(0.95);
    expect(mid.hot).toBe(1); // hotspots from ~4 px per tile
    expect(mid.ember).toBeGreaterThan(0); // embers fading in
    expect(mid.ember).toBeLessThan(0.5);
    expect(falloutLook(CLOSE)).toEqual({ near: 1, hot: 1, ember: 1 });
    // Monotonic in the zoom.
    let prev = falloutLook(2);
    for (let tpp = 2; tpp > 0.01; tpp *= 0.9) {
      const l = falloutLook(tpp);
      expect(l.near).toBeGreaterThanOrEqual(prev.near);
      expect(l.hot).toBeGreaterThanOrEqual(prev.hot);
      expect(l.ember).toBeGreaterThanOrEqual(prev.ember);
      prev = l;
    }
  });

  it("draws a sickly rim ~1.6 px wide on the zone's own tiles", () => {
    expect(falloutRimTiles(FULL_MAP)).toBe(2); // ~1.4 px at full map
    expect(falloutRimTiles(DEFAULT)).toBe(1);
    expect(falloutRimTiles(CLOSE)).toBe(1); // close up: one tile, faint
    expect(falloutRimTiles(10)).toBe(FALLOUT_RIM_MAX);
    for (let tpp = 0.05; tpp < 3; tpp += 0.05) {
      const r = falloutRimTiles(tpp);
      expect(Number.isInteger(r)).toBe(true);
      expect(r / tpp).toBeGreaterThanOrEqual(Math.min(1, 0.7 / tpp) - 1e-9);
    }
    expect(FALLOUT_RIM_FAR).toBeGreaterThan(FALLOUT_RIM_NEAR);
  });

  it("keeps every ember inside its tile and at least ~1 px wide", () => {
    for (let tpp = 0.01; tpp < FALLOUT_EMBER_TPP[1]; tpp += 0.005) {
      const r = emberRadiusTiles(tpp);
      // The centre lies EMBER_MARGIN inside the tile: the disc stays in.
      expect(r).toBeLessThanOrEqual(EMBER_MARGIN);
      expect(r).toBeGreaterThanOrEqual(EMBER_MIN_TILES);
      expect(r / tpp).toBeGreaterThanOrEqual(Math.min(EMBER_MIN_PX, 1));
    }
    expect(EMBER_MAX_TILES).toBeLessThanOrEqual(EMBER_MARGIN);
  });

  it("keeps every hotspot compact inside its lattice cell (no seam)", () => {
    const rand = rng(5);
    let shown = 0;
    for (let i = 0; i < 2000; i++) {
      const h0 = rand();
      const s = falloutHotspot(h0, rand());
      if (h0 >= FALLOUT_HOT_SHARE) {
        expect(s).toBeNull();
        continue;
      }
      expect(s).not.toBeNull();
      shown++;
      const { radius, cx, cy } = s!;
      const rTiles = radius * FALLOUT_HOT_CELL;
      // Local glows of 1.6-3.2 tiles, not pepper.
      expect(rTiles).toBeGreaterThanOrEqual(1.6 - 1e-9);
      expect(rTiles).toBeLessThanOrEqual(3.2 + 1e-9);
      for (const c of [cx, cy]) {
        expect(c - radius).toBeGreaterThanOrEqual(-1e-9);
        expect(c + radius).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    // Sparse: about FALLOUT_HOT_SHARE of the cells, at most one per
    // FALLOUT_HOT_CELL² tiles (a few dozen on a screen-filling zone at 5 px
    // per tile, not hundreds), and only well inside the zone.
    expect(shown / 2000).toBeCloseTo(FALLOUT_HOT_SHARE, 1);
    const view = (1920 / 5) * (1032 / 5);
    expect(
      (view / (FALLOUT_HOT_CELL * FALLOUT_HOT_CELL)) * FALLOUT_HOT_SHARE,
    ).toBeLessThan(40);
    expect(FALLOUT_HOT_CLEAR).toBeGreaterThan(
      FALLOUT_HOT_CELL * FALLOUT_HOT_RADIUS[1],
    );
    // The glow is compact and smooth: 1 at the centre, 0 from the rim on.
    expect(hotspotGlow(0)).toBe(1);
    expect(hotspotGlow(1)).toBe(0);
    expect(hotspotGlow(1.5)).toBe(0);
    let prev = 1;
    for (let d2 = 0.05; d2 <= 1; d2 += 0.05) {
      expect(hotspotGlow(d2)).toBeLessThan(prev);
      prev = hotspotGlow(d2);
    }
  });

  it("mirrors the shader's fallout block, which keeps the relief", () => {
    const src = block(
      TERRAIN_FRAG,
      "// ---- BEGIN lot 3: fallout",
      "// ---- END lot 3: fallout",
    );
    const fade = (r: readonly [number, number]) =>
      `smoothstep(${glsl(r[0])}, ${glsl(r[1])}, tpp)`;
    expect(src).toContain(`float near = 1.0 - ${fade(FALLOUT_NEAR_TPP)};`);
    expect(src).toContain(`(1.0 - ${fade(FALLOUT_HOT_TPP)})`);
    expect(src).toContain(`float emberW = 1.0 - ${fade(FALLOUT_EMBER_TPP)};`);
    expect(src).toContain(`e0 < ${EMBER_DENSITY} + ${EMBER_DENSITY_HOT} * hot`);
    expect(src).toContain(
      `clamp(${EMBER_MIN_PX} * tpp, ${EMBER_MIN_TILES}, ${EMBER_MAX_TILES})`,
    );
    expect(src).toContain(
      `vec2 c = ${EMBER_MARGIN} + ${1 - 2 * EMBER_MARGIN} * vec2(`,
    );
    expect(src).toContain(`p * (1.0 / ${glsl(FALLOUT_HOT_CELL)})`);
    expect(src).toContain(`if (hh < ${FALLOUT_HOT_SHARE})`);
    const [r0, r1] = FALLOUT_HOT_RADIUS;
    expect(src).toContain(`float r = ${r0} + ${r1 - r0} * fract(hh * 37.0);`);
    expect(src).toContain(`* ${glsl(FALLOUT_HOT_CELL)})));`);
    for (const t of ["+", "-"]) {
      expect(src).toContain(`ct ${t} ivec2(${FALLOUT_HOT_CLEAR}, 0)`);
      expect(src).toContain(`ct ${t} ivec2(0, ${FALLOUT_HOT_CLEAR})`);
    }
    // The rim: R tiles (falloutRimTiles), strength far / near.
    expect(src).toContain(
      `int R = int(clamp(floor(${FALLOUT_RIM_PX} * tpp + 0.5), 1.0, ${glsl(FALLOUT_RIM_MAX)}));`,
    );
    expect(src).toContain(`mix(${FALLOUT_RIM_FAR}, ${FALLOUT_RIM_NEAR}, near)`);
    // Everything hangs on this tile's fallout bit.
    expect(src).toContain("vec3 emissive = vec3(0.0);\n  if (fallout) {");
    expect(TERRAIN_FRAG).toContain("uint st = texelFetch(uTiles, tile, 0).r;");
    expect(TERRAIN_FRAG).toContain("bool fallout = (st & 0x2000u) != 0u;");
    // It recolours the ground but never touches the normals, the slope
    // darkening or the hillshade (the relief and lighting stay).
    expect(src).not.toMatch(/\bn = /);
    expect(src).not.toMatch(/\bao\b/);
    expect(src).not.toMatch(/\bshading\b/);
    expect(src).toContain(
      "albedo = near >= 1.0 ? burnt : mix(farA, burnt, near);",
    );
    // No neon sheet: the even glow is faint zoomed out and gone close up.
    expect(src).toContain("mix(0.025, 0.0, near)");
    // One hue family: the far look is the ash, darker, lightly tinted.
    expect(src).toContain("farA = mix(ash * 0.78, sick * 0.6,");
    expect(src).toContain("burnt = ash;");
    // Over fallout the bombs' ground tracks are faint and greyed.
    expect(TERRAIN_FRAG).toMatch(
      /if \(tr\.a > 0\.0 && \(texelFetch\(uTiles, tile, 0\)\.r & 0x2000u\) != 0u\) \{\s+tr\.rgb = mix\(tr\.rgb, vec3\(dot\(tr\.rgb, vec3\(0\.299, 0\.587, 0\.114\)\)\), 0\.75\);\s+tr\.a \*= 0\.35;/,
    );
  });
});

// ---------------------------------------------------------------------------
// Smooth relief close up (item 9)
// ---------------------------------------------------------------------------

describe("smooth relief close up (lot 3, item 9)", () => {
  it("maps world coordinates to the grid's vertex space", () => {
    // HeightField: 9 tiles at step 2 -> 6 vertices at 0, 2, 4, 6, 8, 9.
    const at = (x: number) => reliefGridCoord(x, 2, 6, 9);
    expect(at(0)).toBe(0);
    expect(at(4)).toBe(2);
    expect(at(8)).toBe(4);
    expect(at(8.5)).toBeCloseTo(4.5, 9); // the narrower last cell
    expect(at(9)).toBe(5);
    expect(at(-3)).toBe(0); // clamped
    expect(at(12)).toBe(5);
    // Continuous and increasing across the map.
    let prev = at(0);
    for (let x = 0; x <= 9; x += 0.01) {
      const g = at(x);
      expect(g).toBeGreaterThanOrEqual(prev);
      expect(g - prev).toBeLessThan(0.02);
      prev = g;
    }
  });

  it("B-spline weights: positive, sum to 1, C2 across a knot", () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const w = cubicBsplineWeights(t);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(-1e-12);
    }
    // The weight of one vertex is continuous where the cell changes: at
    // t = 1 it is w1, at t = 0 of the next cell it is w0 (same vertex).
    const end = cubicBsplineWeights(1);
    const start = cubicBsplineWeights(0);
    expect(end[1]).toBeCloseTo(start[0], 12);
    expect(end[2]).toBeCloseTo(start[1], 12);
    expect(end[3]).toBeCloseTo(start[2], 12);
  });

  it("2 linear fetches reproduce the 4-tap cubic B-spline", () => {
    const rand = rng(9);
    const v = Array.from({ length: 12 }, () => rand() * 10);
    // A linear-filtered texture: value at vertex-space coordinate x.
    const lin = (x: number) => {
      const i = Math.floor(x);
      const f = x - i;
      return v[i] * (1 - f) + v[i + 1] * f;
    };
    for (let i = 1; i < 9; i++) {
      for (let t = 0; t < 1; t += 0.125) {
        const w = cubicBsplineWeights(t);
        const ref =
          w[0] * v[i - 1] + w[1] * v[i] + w[2] * v[i + 1] + w[3] * v[i + 2];
        const { g0, g1, p0, p1 } = cubicBsplineTaps(t);
        expect(g0 * lin(i + p0) + g1 * lin(i + p1)).toBeCloseTo(ref, 9);
      }
    }
  });

  it("tile heights: a continuous slope where the bilinear blend jumps", () => {
    const rand = rng(21);
    const h = Array.from({ length: 16 }, () => rand() * 4);
    const eps = 1e-7;
    let bilinearJumps = 0;
    for (let k = 2; k < 13; k++) {
      // Quadratic B-spline knots sit on the tile edges (k + 0.5).
      const a = quadBsplineAt(h, k + 0.5 - eps);
      const b = quadBsplineAt(h, k + 0.5 + eps);
      expect(b.h).toBeCloseTo(a.h, 5);
      expect(b.slope).toBeCloseTo(a.slope, 5);
      // The bilinear blend's slope jumps at the tile centres.
      const c = bilinearAt(h, k - eps);
      const d = bilinearAt(h, k + eps);
      if (Math.abs(c.slope - d.slope) > 1e-3) bilinearJumps++;
    }
    expect(bilinearJumps).toBeGreaterThan(8);
    // A plane stays a plane (no ripples on even slopes).
    const ramp = Array.from({ length: 16 }, (_, k) => 0.3 * k + 1);
    for (let q = 2; q < 13; q += 0.1) {
      const r = quadBsplineAt(ramp, q);
      expect(r.h).toBeCloseTo(0.3 * q + 1, 9);
      expect(r.slope).toBeCloseTo(0.3, 9);
    }
  });

  it("is wired in the shader close up only, the geometry untouched", () => {
    expect(TERRAIN_FRAG).toContain("uniform highp sampler2D uRelief;");
    expect(TERRAIN_FRAG).toContain("uniform vec3 uReliefGrid;");
    expect(TERRAIN_FRAG).toContain(
      "vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) * (1.0 / 6.0);",
    );
    // Close up, on the map, on land: the smooth shading normal.
    expect(TERRAIN_FRAG).toContain(
      "if (land && close > 0.0 && dOut <= 0.0) {\n    vec4 rs = reliefSmooth(p);",
    );
    expect(TERRAIN_FRAG).toContain(
      "vec4 bs = close > 0.0 ? tileBspline(b, w) : vec4(0.0, 0.0, 0.0, -1.0);",
    );
    // The rock / snow lines follow the smooth upland elevation.
    expect(TERRAIN_FRAG).toContain("if (bs.w >= 0.0) elev = bs.w;");
  });
});

// ---------------------------------------------------------------------------
// Water glints (item 8)
// ---------------------------------------------------------------------------

describe("water glints scaled to the screen (lot 3, item 8)", () => {
  it("keeps the glitter period around GLITTER_PX device px at any zoom", () => {
    for (let tpp = 0.004; tpp < 0.3; tpp *= 1.07) {
      const { fr, periods } = glitterLevels(tpp);
      expect(fr).toBeGreaterThanOrEqual(0);
      expect(fr).toBeLessThan(1);
      const px0 = periods[0] / tpp;
      const px1 = periods[1] / tpp;
      expect(px0).toBeGreaterThan(GLITTER_PX / 2 - 1e-9);
      expect(px0).toBeLessThanOrEqual(GLITTER_PX + 1e-9);
      expect(px1).toBeCloseTo(2 * px0, 9);
    }
  });

  it("cross-fades without popping when the levels shift", () => {
    // Just under and just over a level boundary, the octave carrying the
    // weight is the same level.
    const boundary = 4 / GLITTER_PX; // log2(tpp * GLITTER_PX) = 2
    const below = glitterLevels(boundary * (1 - 1e-9));
    const above = glitterLevels(boundary * (1 + 1e-9));
    expect(below.k + 1).toBe(above.k);
    expect(below.fr).toBeCloseTo(1, 6); // level k + 1 = above.k at weight ~1
    expect(above.fr).toBeCloseTo(0, 6); // level above.k at weight ~1
  });

  it("keeps only the short wave octaves in the glints", () => {
    const tpp = 1 / 6; // the "vermicelli" zoom, 6 px per tile
    expect(glintWaveWeight(13, tpp)).toBe(0); // 78 px crests: out
    expect(glintWaveWeight(7.3, tpp)).toBe(0); // 44 px: out
    expect(glintWaveWeight(1.3, tpp)).toBe(1); // 7.8 px: in
    const w = glintWaveWeight(4.1, tpp); // 24.6 px: partly
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
    // Zoomed out the same octave is short on screen: in.
    expect(glintWaveWeight(4.1, 1 / 2)).toBe(1);
  });

  it("mirrors the water shader", () => {
    expect(WATER_COMMON).toContain(
      `float L = log2(max(tpp, 1e-4) * ${glsl(GLITTER_PX)});`,
    );
    expect(WATER_COMMON).toContain(
      `smoothstep(${glsl(GLINT_WAVE_PX[0])}, ${glsl(GLINT_WAVE_PX[1])}, lambda / tpp)`,
    );
    // The reflected sky has no sun disc (it drew the long repeating
    // highlights); the sun's reflection is the screen-scaled glint lobe.
    expect(WATER_COMMON).toContain("skyRadiance(reflect(-V, n), 0.0)");
    expect(WATER_COMMON).toContain("glitterSlope(p, t, tpp)");
  });
});
