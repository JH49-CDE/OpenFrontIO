import { describe, expect, it } from "vitest";
import {
  gridStepFor,
  HeightField,
} from "../../../src/client/render/three/HeightField";
import {
  FULL_DEPTH_MAGNITUDE,
  heightForTerrainByte,
  IMPASSABLE_HEIGHT_FRACTION,
  LAND_BASE_FRACTION,
  SHORE_DEPTH_FRACTION,
  TerrainKind,
  terrainKind,
} from "../../../src/client/render/three/TerrainCodec";
import type { TerrainRect } from "../../../src/client/render/types";

const HS = 6;
const SD = 3;
const land = (m: number) => 0x80 | m;
const water = (m: number) => m;

function randomTerrain(w: number, h: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(w * h);
  let s = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const r = s >>> 24;
    bytes[i] = r < 100 ? water(r % 32) : land(r % 31);
  }
  return bytes;
}

describe("terrain byte → height", () => {
  it("puts land above sea level, scaled to heightScale at magnitude 30", () => {
    expect(heightForTerrainByte(land(0), HS, SD)).toBeCloseTo(
      HS * LAND_BASE_FRACTION,
      9,
    );
    expect(heightForTerrainByte(land(30), HS, SD)).toBeCloseTo(HS, 9);
    let prev = 0;
    for (let m = 0; m <= 30; m++) {
      const h = heightForTerrainByte(land(m), HS, SD);
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
    // The shoreline bit does not change the height.
    expect(heightForTerrainByte(land(5) | 0x40, HS, SD)).toBe(
      heightForTerrainByte(land(5), HS, SD),
    );
  });

  it("keeps impassable land flat and low", () => {
    expect(heightForTerrainByte(0x9f, HS, SD)).toBeCloseTo(
      HS * IMPASSABLE_HEIGHT_FRACTION,
      9,
    );
    expect(terrainKind(0x9f)).toBe(TerrainKind.Impassable);
  });

  it("deepens water with distance from shore down to seabedDepth", () => {
    expect(heightForTerrainByte(water(0), HS, SD)).toBeCloseTo(
      -SD * SHORE_DEPTH_FRACTION,
      9,
    );
    // Ocean bit and shoreline bit do not matter.
    expect(heightForTerrainByte(water(4) | 0x20 | 0x40, HS, SD)).toBe(
      heightForTerrainByte(water(4), HS, SD),
    );
    let prev = 0;
    for (let m = 0; m <= FULL_DEPTH_MAGNITUDE; m++) {
      const h = heightForTerrainByte(water(m), HS, SD);
      expect(h).toBeLessThan(prev);
      prev = h;
    }
    expect(heightForTerrainByte(water(31), HS, SD)).toBeCloseTo(-SD, 9);
  });

  it("classifies like the engine", () => {
    expect(terrainKind(water(3))).toBe(TerrainKind.Water);
    expect(terrainKind(land(9))).toBe(TerrainKind.Plains);
    expect(terrainKind(land(10))).toBe(TerrainKind.Highland);
    expect(terrainKind(land(20))).toBe(TerrainKind.Mountain);
  });
});

describe("HeightField grid", () => {
  it("bounds the vertex count on the largest maps", () => {
    expect(gridStepFor(4744, 2628, 600_000)).toBe(5);
    expect(gridStepFor(2000, 1000, 600_000)).toBe(2);
    expect(gridStepFor(224, 168, 600_000)).toBe(1);
    const hf = new HeightField(6000, 400, new Uint8Array(6000 * 400), {
      heightScale: HS,
      seabedDepth: SD,
      targetVertices: 600_000,
    });
    expect(hf.vertexCount).toBeLessThanOrEqual(620_000);
    expect(hf.vertexX(hf.cols - 1)).toBe(6000);
    expect(hf.vertexY(hf.rows - 1)).toBe(400);
  });

  it("averages uniform terrain to the tile height", () => {
    const hf = new HeightField(37, 23, new Uint8Array(37 * 23).fill(land(15)), {
      heightScale: HS,
      seabedDepth: SD,
      targetVertices: 200,
    });
    const expected = heightForTerrainByte(land(15), HS, SD);
    for (const h of hf.heights) expect(h).toBeCloseTo(expected, 5);
    expect(hf.heightAt(10.3, 7.9)).toBeCloseTo(expected, 5);
  });
});

describe("HeightField.heightAt", () => {
  function fieldWithHeights(
    w: number,
    h: number,
    targetVertices: number,
    fn: (x: number, y: number) => number,
  ): HeightField {
    const hf = new HeightField(w, h, new Uint8Array(w * h), {
      heightScale: HS,
      seabedDepth: SD,
      targetVertices,
      smooth: false,
    });
    for (let j = 0; j < hf.rows; j++) {
      for (let i = 0; i < hf.cols; i++) {
        hf.heights[j * hf.cols + i] = fn(hf.vertexX(i), hf.vertexY(j));
      }
    }
    return hf;
  }

  it("reproduces a linear field exactly", () => {
    const hf = fieldWithHeights(8, 6, 10_000, (x, y) => 2 * x + 3 * y);
    expect(hf.step).toBe(1);
    for (const [x, y] of [
      [0, 0],
      [0.25, 0.5],
      [3.7, 2.2],
      [8, 6],
      [7.99, 5.5],
    ]) {
      expect(hf.heightAt(x, y)).toBeCloseTo(2 * x + 3 * y, 5);
    }
  });

  it("interpolates bilinearly (not per triangle) inside a cell", () => {
    const hf = fieldWithHeights(4, 4, 10_000, (x, y) =>
      x === 1 && y === 1 ? 1 : 0,
    );
    expect(hf.heightAt(0.5, 0.5)).toBeCloseTo(0.25, 6);
    expect(hf.heightAt(0.75, 0.25)).toBeCloseTo(0.1875, 6);
    expect(hf.heightAt(1, 1)).toBeCloseTo(1, 6);
  });

  it("handles the narrower last cell when step does not divide the size", () => {
    // 5×3 map at step 2: columns at x = 0, 2, 4, 5.
    const hf = fieldWithHeights(5, 3, 6, (x) => x);
    expect(hf.step).toBe(2);
    expect(hf.cols).toBe(4);
    expect(hf.heightAt(4.5, 1)).toBeCloseTo(4.5, 6);
    expect(hf.heightAt(3, 1)).toBeCloseTo(3, 6);
  });

  it("clamps outside the map and keeps the water surface at 0", () => {
    const hf = fieldWithHeights(8, 6, 10_000, (x) => x - 4);
    expect(hf.heightAt(-10, 3)).toBeCloseTo(-4, 6);
    expect(hf.heightAt(20, 3)).toBeCloseTo(4, 6);
    expect(hf.surfaceAt(1, 3)).toBe(0);
    expect(hf.surfaceAt(6, 3)).toBeCloseTo(2, 6);
  });
});

describe("HeightField.applyRects", () => {
  for (const { w, h, target } of [
    { w: 64, h: 48, target: 100_000 }, // step 1
    { w: 67, h: 41, target: 400 }, // step 5, ragged last cell
  ]) {
    it(`matches a full rebuild after patching (${w}×${h}, target ${target})`, () => {
      const before = randomTerrain(w, h, 7);
      const hf = new HeightField(w, h, before.slice(), {
        heightScale: HS,
        seabedDepth: SD,
        targetVertices: target,
      });
      const version = hf.version;

      // A nuke-like change in the middle plus a corner rect.
      const rects: TerrainRect[] = [
        { x: 20, y: 10, w: 9, h: 4 },
        { x: w - 3, y: h - 2, w: 3, h: 2 },
      ];
      const patched = before.slice();
      const parts: number[] = [];
      for (const r of rects) {
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const b = (patched[y * w + x] & 0x80) !== 0 ? water(2) : land(28);
            patched[y * w + x] = b;
            parts.push(b);
          }
        }
      }
      const dirty = hf.applyRects(rects, Uint8Array.from(parts));

      expect(dirty).not.toBeNull();
      expect(hf.version).toBe(version + 1);
      expect(hf.lastDirty).toEqual(dirty);
      expect(Array.from(hf.terrain)).toEqual(Array.from(patched));

      const fresh = new HeightField(w, h, patched.slice(), {
        heightScale: HS,
        seabedDepth: SD,
        targetVertices: target,
      });
      expect(Array.from(hf.heights)).toEqual(Array.from(fresh.heights));
      expect(hf.maxHeight).toBeGreaterThanOrEqual(fresh.maxHeight);
      expect(hf.minHeight).toBeLessThanOrEqual(fresh.minHeight);

      // Vertices outside the reported range are untouched.
      const original = new HeightField(w, h, before.slice(), {
        heightScale: HS,
        seabedDepth: SD,
        targetVertices: target,
      });
      for (let j = 0; j < hf.rows; j++) {
        for (let i = 0; i < hf.cols; i++) {
          const inside =
            i >= dirty!.i0 &&
            i <= dirty!.i1 &&
            j >= dirty!.j0 &&
            j <= dirty!.j1;
          if (!inside) {
            expect(hf.heights[j * hf.cols + i]).toBe(
              original.heights[j * hf.cols + i],
            );
          }
        }
      }
    });
  }

  it("ignores empty or out-of-map rects", () => {
    const hf = new HeightField(10, 10, randomTerrain(10, 10, 3), {
      heightScale: HS,
      seabedDepth: SD,
      targetVertices: 1000,
    });
    const v = hf.version;
    expect(hf.applyRects([], new Uint8Array(0))).toBeNull();
    expect(
      hf.applyRects([{ x: 8, y: 8, w: 4, h: 4 }], new Uint8Array(16)),
    ).toBeNull();
    expect(hf.version).toBe(v);
  });
});
