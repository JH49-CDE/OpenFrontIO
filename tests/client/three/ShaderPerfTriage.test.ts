/**
 * Perf triage of the lot-3 terrain and water shaders (README, "Performance
 * notes"): work whose weight is 0 is skipped by a branch instead of being
 * computed and mixed away, and the big shading functions have one call site
 * each (every call site is inlined; SwiftShader runs every block of the
 * program for every fragment). The pixels are unchanged (checked headless,
 * pixel for pixel); these tests keep the structure from regressing.
 */
import { describe, expect, it } from "vitest";
import { TERRAIN_FRAG as TERRAIN_FRAG_SRC } from "../../../src/client/render/three/shaders/terrain";
import {
  ENV_COMMON,
  WATER_COMMON as WATER_COMMON_SRC,
  WATER_FRAG as WATER_FRAG_SRC,
} from "../../../src/client/render/three/shaders/water";
import {
  apronFillFade,
  closeUpAmount,
  falloutLook,
} from "../../../src/client/render/three/TerrainShading";

/** GLSL without its // comments (they mention names the code avoids). */
const code = (src: string) => src.replace(/\/\/[^\n]*/g, "");
const TERRAIN = code(TERRAIN_FRAG_SRC);
const WATER_COMMON = code(WATER_COMMON_SRC);
const WATER_FRAG = code(WATER_FRAG_SRC);

/** Bodies of every `header` block in src; header ends with "{". */
function blocks(src: string, header: string): string[] {
  expect(header.endsWith("{")).toBe(true);
  const out: string[] = [];
  let at = src.indexOf(header);
  while (at >= 0) {
    const open = at + header.length - 1;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(open + 1, i));
    at = src.indexOf(header, i);
  }
  return out;
}

/** The one block opened by `header` (a function or a branch). */
function only(src: string, header: string): string {
  const b = blocks(src, header);
  expect(b).toHaveLength(1);
  return b[0];
}

const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** The GLSL between a block's BEGIN and END markers. */
function marked(src: string, begin: string, end: string): string {
  const a = src.indexOf(begin);
  const b = src.indexOf(end, a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** [lo, hi] of `float name = 1.0 - smoothstep(lo, hi, tpp);` in src. */
function fadeRange(src: string, name: string): [number, number] {
  const m = new RegExp(
    `float ${name} = 1\\.0 - smoothstep\\(([\\d.]+), ([\\d.]+), tpp\\);`,
  ).exec(src);
  expect(m).not.toBeNull();
  return [Number(m![1]), Number(m![2])];
}

const FULL_MAP_TPP = 1 / 0.7; // full map (0.7 CSS px per tile) on a 1x screen
const DEFAULT_TPP = 1 / 1.8; // default zoom on a 1x screen

describe("shader perf triage: one call site per shading function", () => {
  it("inlines shadeLandTile and shadeWater once in the terrain shader", () => {
    // The definition plus one call each: the map and the apron share them.
    expect(count(TERRAIN, /\bshadeLandTile\(/g)).toBe(2);
    expect(count(TERRAIN, /\bshadeWater\(/g)).toBe(2);
    expect(TERRAIN).not.toContain("shadeWaterTile");
    const main = TERRAIN.slice(TERRAIN.indexOf("void main() {"));
    expect(count(main, /\bshadeLandTile\(/g)).toBe(1);
    expect(count(main, /\bshadeWater\(/g)).toBe(1);
    // The water plane calls it once too.
    expect(count(WATER_FRAG, /\bshadeWater\(/g)).toBe(2);
  });

  it("has no skirt branch (the mesh has no vertical walls since the apron)", () => {
    expect(TERRAIN).not.toContain("nMesh.y < 0.02");
  });
});

describe("shader perf triage: no work behind a zero weight", () => {
  const fallout = code(
    marked(
      TERRAIN_FRAG_SRC,
      "// ---- BEGIN lot 3: fallout",
      "// ---- END lot 3: fallout",
    ),
  );

  it("computes each fallout look only where its weight is not 0", () => {
    const far = only(fallout, "if (near < 1.0) {");
    const near = only(fallout, "if (near > 0.0) {");
    expect(far).toContain("float mot = ");
    for (const s of [
      "float c1 = valueNoise(",
      "float c2 = 0.5 + (valueNoise(",
      "valueNoise(p * 2.3",
      "float ash2 = ",
    ]) {
      expect(near).toContain(s);
    }
    // Every noise of the block is in one of the two.
    expect(count(fallout, /valueNoise\(/g)).toBe(
      count(far, /valueNoise\(/g) + count(near, /valueNoise\(/g),
    );
    expect(count(fallout, /valueNoise\(/g)).toBe(5);
    // Zoomed out (full map, default zoom) the near look and every hotspot
    // and ember weight are 0; close up the far look's is.
    for (const tpp of [FULL_MAP_TPP, DEFAULT_TPP]) {
      expect(falloutLook(tpp)).toEqual({ near: 0, hot: 0, ember: 0 });
    }
    expect(falloutLook(1 / 6).near).toBe(1);
  });

  it("hashes and fetches nothing for hotspots or embers while they are faded out", () => {
    const hot = only(fallout, "if (hotVis > 0.0) {");
    expect(hot).toContain("hh = hash12(hc + ivec2(311, 97));");
    expect(count(hot, /texelFetch\(uTiles, clamp\(ct/g)).toBe(4);
    expect(count(fallout, /texelFetch\(uTiles, clamp\(ct/g)).toBe(4);
    expect(fallout).toContain(
      "float hotVis = (1.0 - smoothstep(0.25, 0.5, tpp)) * smoothstep(0.55, 0.8, nMesh.y);",
    );
    const ember = only(fallout, "if (emberW > 0.0) {");
    expect(ember).toContain("float e0 = hash12(tile + ivec2(9173, 3511));");
    expect(count(fallout, /\be0 = hash12/g)).toBe(1);
  });

  it("skips the micro detail and the detail normal while detail = 0", () => {
    const main = TERRAIN.slice(TERRAIN.indexOf("void main() {"));
    const detail = fadeRange(main, "detail");
    const close = fadeRange(main, "close");
    // detail is 0 at full map on a 1x screen, and the close-up block (which
    // reads the detail noises) only runs where detail > 0.
    expect(FULL_MAP_TPP).toBeGreaterThanOrEqual(detail[1]);
    expect(close[1]).toBeLessThan(detail[1]);
    expect(closeUpAmount(close[1])).toBe(0);
    expect(closeUpAmount(close[0])).toBe(1);
    // shadeLandTile: from its signature to main.
    const land = TERRAIN.slice(
      TERRAIN.indexOf("vec3 shadeLandTile("),
      TERRAIN.indexOf("void main() {"),
    );
    const guarded = blocks(land, "if (detail > 0.0) {");
    const noise = guarded.find((b) =>
      b.includes("o2 = valueNoiseD(mat2(0.6, -0.8, 0.8, 0.6) * p * 4.6);"),
    );
    expect(noise).toBeDefined();
    expect(noise).toContain("o1 = valueNoiseD(");
    expect(noise).toContain("albedo *= 1.0 + (0.6 * o1.x + 0.4 * o2.x - 0.5)");
    expect(count(land, /valueNoiseD\(/g)).toBe(2);
    // The detail normal, and its bilinear slope only while smoothW < 1.
    const normal = guarded.find((b) => b.includes("if (smoothW < 1.0) {"));
    expect(normal).toBeDefined();
    expect(only(normal!, "if (smoothW < 1.0) {")).toContain(
      "vec4 h4 = tileHeights(t4);",
    );
    expect(count(land, /tileHeights\(/g)).toBe(1);
    expect(land).toContain(
      "if (detail > 0.0) v = 0.8 + 0.35 * detail * valueNoise(p * 0.9);",
    );
  });

  it("skips the territory fill where it is thrown away", () => {
    expect(TERRAIN).toContain("if (owner != 0 && !fallout && apron < 1.0) {");
    // The fallout replaces the colour without reading the fill.
    expect(fallout).not.toMatch(/\bfill\b/);
    // Past the apron's fade its weight is exactly 0 (apron = 1).
    expect(apronFillFade(1.5, 0.1)).toBe(1);
    expect(apronFillFade(6 * FULL_MAP_TPP, FULL_MAP_TPP)).toBe(1);
  });
});

describe("shader perf triage: texture reads", () => {
  it("samples the relief at level 0 (no implicit derivatives in a branch)", () => {
    expect(TERRAIN).not.toContain("texture(uRelief");
    expect(count(TERRAIN, /textureLod\(uRelief, [^;]*?, 0\.0\)/g)).toBe(4);
  });

  it("fetches tileBspline's 3 x 3 tiles at constant offsets, no local array", () => {
    const body = only(TERRAIN, "vec4 tileBspline(ivec2 b, vec2 w) {");
    expect(body).not.toMatch(/\[\d\]\s*;/);
    expect(body).toContain("uint tb = terrainAt(c + ivec2(i - 1, j - 1));");
    expect(count(body, /terrainAt\(/g)).toBe(1);
  });
});

describe("shader perf triage: water", () => {
  it("computes the glint share only while the glints show", () => {
    expect(WATER_COMMON).toContain(
      "if (glints) r.zw = s * (1.0 - smoothstep(16.0, 40.0, lambda / tpp));",
    );
    expect(WATER_COMMON).toContain(
      "vec4 slopes = waveSlope(p, t, tpp, glintOn > 0.0) * calm;",
    );
    // zw is read only under the same condition.
    const glints = only(WATER_COMMON, "if (glintOn > 0.0) {");
    const reads = /slopes\.(zw|z|w)\b/g;
    expect(count(glints, reads)).toBeGreaterThan(0);
    expect(count(WATER_COMMON, reads)).toBe(count(glints, reads));
  });

  it("evaluates the sun disc only when asked for", () => {
    const env = code(ENV_COMMON);
    expect(env).not.toContain("sunDisc * 4.0 * pow(s, 1200.0));");
    expect(env).toContain(
      "if (sunDisc > 0.0) glow += sunDisc * 4.0 * pow(s, 1200.0);",
    );
  });
});
