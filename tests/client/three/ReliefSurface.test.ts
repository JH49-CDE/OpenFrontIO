/**
 * The surface overlays drape on (TerrainLayer as `ReliefSurface`): it must
 * match the relief mesh as drawn (its own triangles, coast lift included,
 * sea plane over the seabed). Also the ghost range ring / telegraph disc
 * grids built on it stay above the World relief along their rim.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import {
  discGrid,
  OverlayLayer,
  RANGE_FILL_ALPHA,
} from "../../../src/client/render/three/OverlayLayer";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { TerrainLayer } from "../../../src/client/render/three/TerrainLayer";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import type { GhostPreviewData } from "../../../src/client/render/types";
import { rng, WORLD_H, WORLD_W, worldTerrain } from "./railNetwork";

function ctxFor(
  W: number,
  H: number,
  terrain: Uint8Array,
  targetVertices: number,
): ThreeLayerContext {
  const settings = defaultThreeSettings();
  return {
    renderer: {
      initTexture: () => {},
      copyTextureToTexture: () => {},
    } as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField: new HeightField(W, H, terrain, {
      heightScale: settings.heightScale,
      seabedDepth: settings.seabedDepth,
      targetVertices,
    }),
    palette: new PaletteView(),
    settings,
    renderSettings: createRenderSettings(),
    config: {} as Config,
    overlayRoot: document.createElement("div"),
  };
}

function ghost(x: number, y: number, radius: number): GhostPreviewData {
  return {
    ghostType: "SAM Launcher",
    tileX: x,
    tileY: y,
    radiusTileX: x,
    radiusTileY: y,
    canBuild: true,
    canUpgrade: false,
    cost: 0,
    showCost: false,
    canAfford: true,
    ghostRailPaths: [],
    overlappingRailroads: [],
    ownerID: 1,
    upgradeTargetTile: null,
    rangeRadius: radius,
    rangeWarning: false,
  };
}

describe("TerrainLayer as the drawn surface", () => {
  it("interpolates the relief mesh's own triangles, at least sea level", () => {
    // Odd size (narrow last cells), hills, sea and a 1-tile island.
    const W = 47;
    const H = 33;
    const terrain = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        terrain[y * W + x] = x < 12 ? 6 : 0x80 | ((x * 7 + y * 13) % 31);
      }
    }
    terrain[10 * W + 4] = 0x80;
    const ctx = ctxFor(W, H, terrain, (W * H) / 9); // step 3
    const t = new TerrainLayer(ctx);
    const mesh = ctx.scene.getObjectByName("terrain") as THREE.Mesh;
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex()!;
    const grid = t.grid;
    expect(grid.step).toBe(3);
    expect(t.tileTexture).toBeInstanceOf(THREE.DataTexture);
    // Vertices: the drawn height, clamped to the sea plane.
    for (let j = 0; j < grid.rows; j++) {
      for (let i = 0; i < grid.cols; i++) {
        const y = pos.getY(j * grid.cols + i);
        expect(t.vertexSurface(i, j)).toBe(Math.max(0, y));
        expect(t.surfaceAt(grid.vertexX(i), grid.vertexY(j))).toBeCloseTo(
          Math.max(0, y),
          5,
        );
      }
    }
    // Points inside grid triangles: barycentric on the mesh triangles.
    const cells = (grid.cols - 1) * (grid.rows - 1);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const r = rng(3);
    for (let n = 0; n < 400; n++) {
      const tri = Math.floor(r() * cells * 2);
      a.fromBufferAttribute(pos, index.getX(tri * 3));
      b.fromBufferAttribute(pos, index.getX(tri * 3 + 1));
      c.fromBufferAttribute(pos, index.getX(tri * 3 + 2));
      let u = r();
      let v = r();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const w = 1 - u - v;
      const x = a.x * w + b.x * u + c.x * v;
      const z = a.z * w + b.z * u + c.z * v;
      const y = a.y * w + b.y * u + c.y * v;
      expect(t.surfaceAt(x, z)).toBeCloseTo(Math.max(0, y), 4);
    }
    // Outside the map: clamped to the edge.
    expect(t.surfaceAt(-5, -5)).toBe(t.surfaceAt(0, 0));
    expect(t.surfaceAt(W + 5, H + 5)).toBe(t.surfaceAt(W, H));
    // The version follows terrain patches.
    const v0 = t.version;
    const bytes = new Uint8Array(9).fill(0x80 | 30);
    ctx.heightField.applyRects([{ x: 20, y: 10, w: 3, h: 3 }], bytes);
    t.setTerrainBytes([{ x: 20, y: 10, w: 3, h: 3 }], bytes);
    expect(t.version).toBeGreaterThan(v0);
    t.dispose();
  });
});

describe("ghost range ring / telegraph discs on the World relief", () => {
  it("keeps 2-tile rim segments and a 1-tile rim band", () => {
    const g = discGrid(100);
    expect(g.segs).toBe(Math.ceil((2 * Math.PI * 100) / 2));
    expect(g.radii.slice(-3)).toEqual([98, 99, 100]);
    for (let k = 1; k < g.radii.length; k++) {
      expect(g.radii[k] - g.radii[k - 1]).toBeLessThanOrEqual(4 + 1e-9);
    }
    expect(discGrid(2).radii).toEqual([1, 2]);
    expect(discGrid(500).segs).toBe(384);
  });

  it("drapes the ghost range rim above the drawn relief", () => {
    const ctx = ctxFor(WORLD_W, WORLD_H, worldTerrain(), 600_000);
    const terrain = new TerrainLayer(ctx);
    const overlay = new OverlayLayer(ctx, terrain);
    const mesh = ctx.scene.getObjectByName("ghost-range") as THREE.Mesh;
    const r = rng(5);
    let checked = 0;
    let below = 0;
    for (let n = 0; n < 60; n++) {
      const x = Math.floor(150 + r() * 1700);
      const y = Math.floor(150 + r() * 700);
      const radius = 20 + r() * 100;
      overlay.updateGhostPreview(ghost(x, y, radius));
      expect(mesh.visible).toBe(true);
      const g = mesh.geometry;
      const pos = g.getAttribute("position");
      const polar = g.getAttribute("aDisc");
      const idx = g.getIndex()!;
      const p = [0, 1, 2].map(() => new THREE.Vector3());
      for (let t = 0; t < g.drawRange.count; t += 3) {
        // Triangles of the rim band (the stroke).
        if (polar.getX(idx.getX(t)) < radius - 3.5) continue;
        for (let k = 0; k < 3; k++) {
          p[k].fromBufferAttribute(pos, idx.getX(t + k));
        }
        const cx = (p[0].x + p[1].x + p[2].x) / 3;
        const cy = (p[0].y + p[1].y + p[2].y) / 3;
        const cz = (p[0].z + p[1].z + p[2].z) / 3;
        if (cy < terrain.surfaceAt(cx, cz)) below++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(below).toBe(0);
    // The range fill reads like the default (20% white): a third of
    // RANGE_FILL_ALPHA over the whole disc.
    expect(RANGE_FILL_ALPHA / 3).toBeGreaterThan(0.1);
    overlay.update({
      nowMs: 0,
      dtMs: 16,
      tickAlpha: 1,
      camera: new THREE.PerspectiveCamera(),
      cssPxPerTile: 4,
      tilt: 0,
      cssWidth: 800,
      cssHeight: 600,
      dpr: 1,
      localPlayerID: 1,
      highlightOwner: 0,
      altView: false,
    } satisfies FrameInfo);
    overlay.dispose();
    terrain.dispose();
  }, 60_000);
});
