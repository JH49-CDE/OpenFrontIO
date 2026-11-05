import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  environmentUniforms,
  SceneEnvironment,
} from "../../../src/client/render/three/SceneEnvironment";
import { FALLOUT_BIT } from "../../../src/client/render/three/TerrainCodec";
import {
  APRON_SLOPE_TILES,
  TerrainLayer,
  TILE_UPLOAD_BUDGET,
} from "../../../src/client/render/three/TerrainLayer";
import { TerrainByteTexture } from "../../../src/client/render/three/TerrainResources";
import {
  ALT_GROUND_FREE,
  ALT_GROUND_OWNED,
  apronWidthTiles,
  COAST_LIFT,
  edgeReachTiles,
  territoryLook,
} from "../../../src/client/render/three/TerrainShading";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import { WaterLayer } from "../../../src/client/render/three/WaterLayer";

const W = 30;
const H = 21;
const DEEP = 20; // water, magnitude 20
const LAND = 0x80;
const ISLAND: [number, number] = [16, 10];

/** A rectangle upload (`copyTextureToTexture`) seen by the stub renderer. */
interface RectUpload {
  target: THREE.Texture;
  /** Data the copy source pointed at. */
  data: unknown;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The region's values at upload time (row-major). */
  values: number[];
}

/**
 * Layer context over a stub renderer that records synchronous full uploads
 * (`initTexture`) and rectangle uploads (`copyTextureToTexture`).
 */
/** Index of the first element where `a` and `b` differ, else -1. */
function firstMismatch(a: Uint16Array, b: Uint16Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function makeCtx({ perf = false, width = W, height = H } = {}) {
  const terrain = new Uint8Array(width * height).fill(DEEP);
  terrain[ISLAND[1] * width + ISLAND[0]] = LAND; // a 1-tile island
  const settings = defaultThreeSettings();
  settings.perf = perf;
  const heightField = new HeightField(width, height, terrain, {
    heightScale: settings.heightScale,
    seabedDepth: settings.seabedDepth,
    targetVertices: (width * height) / 9, // step 3
  });
  const uploads: THREE.Texture[] = [];
  const rects: RectUpload[] = [];
  const renderer = {
    initTexture: (t: THREE.Texture) => uploads.push(t),
    copyTextureToTexture: (
      src: THREE.DataTexture,
      dst: THREE.Texture,
      region: THREE.Box2,
      pos: THREE.Vector2,
    ) => {
      // Never the target itself: three would copy GPU to GPU.
      expect(src).not.toBe(dst);
      expect(pos.x).toBe(region.min.x);
      expect(pos.y).toBe(region.min.y);
      const image = src.image as { data: ArrayLike<number>; width: number };
      const r = {
        target: dst,
        data: image.data,
        x: region.min.x,
        y: region.min.y,
        w: region.max.x - region.min.x,
        h: region.max.y - region.min.y,
        values: [] as number[],
      };
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          r.values.push(image.data[y * image.width + x]);
        }
      }
      rects.push(r);
    },
  } as unknown as THREE.WebGLRenderer;
  const ctx: ThreeLayerContext = {
    renderer,
    scene: new THREE.Scene(),
    mapWidth: width,
    mapHeight: height,
    heightField,
    palette: new PaletteView(),
    settings,
    renderSettings: createRenderSettings(),
    config: {} as Config,
    overlayRoot: document.createElement("div"),
  };
  return { ctx, uploads, rects, heightField };
}

function frameFor(camera: THREE.PerspectiveCamera, tilt = 0): FrameInfo {
  return {
    nowMs: 1234,
    dtMs: 16,
    tickAlpha: 1,
    camera,
    cssPxPerTile: 4,
    tilt,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 2,
    localPlayerID: 3,
    highlightOwner: 5,
    altView: true,
  };
}

function meshNamed(ctx: ThreeLayerContext, name: string): THREE.Mesh {
  const m = ctx.scene.getObjectByName(name);
  expect(m).toBeInstanceOf(THREE.Mesh);
  return m as THREE.Mesh;
}

function uniformsOf(mesh: THREE.Mesh): Record<string, THREE.IUniform> {
  return (mesh.material as THREE.ShaderMaterial).uniforms;
}

function triangleNormal(
  pos: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
) {
  const v = (k: number) =>
    new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  const A = v(a);
  return new THREE.Vector3()
    .subVectors(v(b), A)
    .cross(new THREE.Vector3().subVectors(v(c), A));
}

describe("TerrainLayer geometry", () => {
  it("is the HeightField grid plus the apron, every triangle facing up", () => {
    const { ctx, heightField: hf } = makeCtx();
    // The steepest relief there is: a mountain block next to deep sea.
    for (let y = 4; y < 14; y++) {
      for (let x = 4; x < 14; x++) hf.terrain[y * W + x] = LAND | 30;
    }
    hf.applyRects([{ x: 0, y: 0, w: W, h: H }], hf.terrain.slice());
    const terrain = new TerrainLayer(ctx);
    const geo = meshNamed(ctx, "terrain").geometry;
    const pos = geo.getAttribute("position").array;
    const nrm = geo.getAttribute("normal").array;
    const index = geo.getIndex()!.array;
    const grid = hf.cols * hf.rows;
    const apronColumns = 2 * (2 * hf.cols + 2 * hf.rows);
    // Grid, the apron's slope columns ([inner, foot] per edge vertex), 4
    // slope-foot and 4 rim corners. No skirts: since lot 3 the apron hides
    // the relief's underside, and the vertical walls drawn under it (always
    // hidden) were removed in the perf triage.
    expect(pos.length / 3).toBe(grid + apronColumns + 8);
    const gridTris = (hf.cols - 1) * (hf.rows - 1) * 2;
    const slopeTris = 2 * (2 * (hf.cols - 1) + 2 * (hf.rows - 1));
    expect(index.length).toBe((gridTris + slopeTris + 16) * 3);
    for (let t = 0; t < index.length / 3; t++) {
      const n = triangleNormal(
        pos,
        index[3 * t],
        index[3 * t + 1],
        index[3 * t + 2],
      );
      expect(n.y).toBeGreaterThan(0); // counter-clockwise from above
    }
    // No vertex normal comes near horizontal (the terrain shader has no
    // wall branch any more).
    let minNy = Infinity;
    for (let k = 0; k < pos.length / 3; k++) {
      minNy = Math.min(minNy, nrm[k * 3 + 1]);
    }
    expect(minNy).toBeGreaterThan(0.1);
    terrain.dispose();
  });

  it("lays an apron around the map, sloping from the edge, facing up", () => {
    const { ctx, heightField: hf } = makeCtx();
    // Land along the north edge: the apron's inner row follows it.
    for (let x = 0; x < W; x++) hf.terrain[x] = LAND | 20;
    hf.applyRects([{ x: 0, y: 0, w: W, h: 1 }], hf.terrain.slice(0, W));
    const terrain = new TerrainLayer(ctx);
    const geo = meshNamed(ctx, "terrain").geometry;
    const pos = geo.getAttribute("position").array;
    const nrm = geo.getAttribute("normal").array;
    const index = geo.getIndex()!.array;
    const A = apronWidthTiles(W, H);
    expect(terrain.apronWidth).toBe(A);
    const first = hf.cols * hf.rows; // the apron follows the grid
    let maxY = 0;
    for (let k = first; k < pos.length / 3; k++) {
      // Never under the water plane; flat-lit (normal up).
      expect(pos[k * 3 + 1]).toBeGreaterThanOrEqual(COAST_LIFT - 1e-6);
      expect([nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]]).toEqual([0, 1, 0]);
      maxY = Math.max(maxY, pos[k * 3 + 1]);
    }
    // The north edge's inner row sits on the (raised) edge vertices.
    for (let i = 0; i < hf.cols; i++) {
      const edgeY = pos[i * 3 + 1];
      expect(edgeY).toBeGreaterThan(COAST_LIFT);
      expect(pos[(first + 2 * i) * 3 + 1]).toBeCloseTo(edgeY, 6);
      expect(pos[(first + 2 * i) * 3 + 2]).toBe(0);
      // Its foot, APRON_SLOPE_TILES out, at COAST_LIFT.
      expect(pos[(first + 2 * i + 1) * 3 + 2]).toBe(-APRON_SLOPE_TILES);
      expect(pos[(first + 2 * i + 1) * 3 + 1]).toBeCloseTo(COAST_LIFT, 6);
    }
    expect(maxY).toBeGreaterThan(COAST_LIFT);
    // Every apron triangle faces up; their footprint is the ring between
    // the map and the map grown by A on every side, covered once.
    const gridTris = (hf.cols - 1) * (hf.rows - 1) * 2;
    let area = 0;
    for (let t = gridTris; t < index.length / 3; t++) {
      const [a, b, c] = [index[3 * t], index[3 * t + 1], index[3 * t + 2]];
      for (const v of [a, b, c]) expect(v).toBeGreaterThanOrEqual(first);
      const n = triangleNormal(pos, a, b, c);
      expect(n.y).toBeGreaterThan(0); // counter-clockwise from above
      area += n.y / 2;
    }
    expect(area).toBeCloseTo((W + 2 * A) * (H + 2 * A) - W * H, 4);
    // The shader gets the virtual land's reach.
    const u = uniformsOf(meshNamed(ctx, "terrain"));
    expect(u.uEdgeReach.value).toBe(edgeReachTiles(W, H));
    terrain.dispose();
  });

  it("keeps cells holding land above the water, and drops them after a water nuke", () => {
    const { ctx, heightField: hf, rects: uploaded } = makeCtx();
    const uploadsOf = (t: THREE.Texture) =>
      uploaded.filter((u) => u.target === t);
    const terrain = new TerrainLayer(ctx);
    const water = new WaterLayer(ctx);
    const geo = meshNamed(ctx, "terrain").geometry;
    const pos = geo.getAttribute("position").array;
    // The island's cell corners.
    const ci = Math.floor(ISLAND[0] / hf.step);
    const cj = Math.floor(ISLAND[1] / hf.step);
    const corners = [
      cj * hf.cols + ci,
      cj * hf.cols + ci + 1,
      (cj + 1) * hf.cols + ci,
      (cj + 1) * hf.cols + ci + 1,
    ];
    for (const k of corners) {
      expect(hf.heights[k]).toBeLessThan(0); // the low-pass grid sinks it
      expect(pos[k * 3 + 1]).toBeGreaterThanOrEqual(COAST_LIFT);
    }
    // Far from the island the seabed stays deep.
    expect(pos[1]).toBeLessThan(0);

    const terrainTex = uniformsOf(meshNamed(ctx, "terrain")).uTerrain
      .value as THREE.DataTexture;
    // Terrain and water share one terrain-byte texture.
    expect(uniformsOf(meshNamed(ctx, "water")).uTerrain.value).toBe(terrainTex);

    const rects = [{ x: ISLAND[0], y: ISLAND[1], w: 1, h: 1 }];
    const bytes = new Uint8Array([0]); // nuked: shallow water
    expect(hf.applyRects(rects, bytes)).not.toBeNull();
    terrain.setTerrainBytes(rects, bytes);
    water.setTerrainBytes(rects, bytes);
    for (const k of corners) {
      expect(pos[k * 3 + 1]).toBe(hf.heights[k]);
      expect(pos[k * 3 + 1]).toBeLessThan(0);
    }
    // One rectangle upload (the island's 16×16 cell, clipped to the map)
    // from the live terrain bytes, not one per layer.
    const terrainUploads = uploadsOf(terrainTex);
    expect(terrainUploads).toHaveLength(1);
    expect(terrainUploads[0]).toMatchObject({
      data: hf.terrain,
      x: 16,
      y: 0,
      w: 14,
      h: 16,
    });
    expect(terrainTex.updateRanges).toEqual([]);
    const position = geo.getAttribute("position") as THREE.BufferAttribute;
    expect(position.updateRanges.length).toBeGreaterThan(0);

    water.dispose();
    terrain.dispose();
  });
});

describe("TerrainLayer tile state uploads", () => {
  const tilesOf = (ctx: ThreeLayerContext) =>
    uniformsOf(meshNamed(ctx, "terrain")).uTiles.value as THREE.DataTexture;
  const frame = () => frameFor(new THREE.PerspectiveCamera());

  it("uploads fully first, then queued cells as rectangles on the next frame", () => {
    // 4×3 cells of 16×16 tiles; the last column of cells is 14 wide.
    const MW = 62;
    const MH = 48;
    const { ctx, uploads, rects } = makeCtx({ width: MW, height: MH });
    const terrain = new TerrainLayer(ctx);
    const tex = tilesOf(ctx);
    const state = new Uint16Array(MW * MH);

    terrain.setTiles(state, null);
    expect((tex.image as { data: unknown }).data).toBe(state);
    expect(uploads).toContain(tex);
    expect(rects).toEqual([]);

    // Tiles in the cells (0,0) and (3,2).
    state[2 * MW + 5] = 7;
    state[40 * MW + 60] = 8;
    terrain.setTiles(state, [2 * MW + 5, 40 * MW + 60]);
    expect(rects).toEqual([]); // nothing until the frame
    // A later tick changes a queued tile again before the frame.
    state[2 * MW + 5] = 9;
    terrain.setTiles(state, [2 * MW + 5]);
    terrain.update(frame());
    expect(rects.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [0, 0, 16, 16],
      [48, 32, 14, 16],
    ]);
    // From the live buffer, with the latest values.
    expect(rects[0].data).toBe(state);
    expect(rects[0].values[2 * 16 + 5]).toBe(9);
    expect(rects[1].values[8 * 14 + 12]).toBe(8);
    expect(tex.updateRanges).toEqual([]);
    // The frame's counters include the full upload pushed between frames.
    expect(terrain.perfStats()).toMatchObject({
      uploadCallsLastFrame: 3,
      texelsLastFrame: MW * MH + 16 * 16 + 14 * 16,
      pendingTexels: 0,
    });
    terrain.update(frame());
    expect(rects).toHaveLength(2);
    expect(terrain.perfStats().uploadCallsLastFrame).toBe(0);

    // A different buffer instance forces a full upload of that buffer and
    // drops what was queued (the full upload covers it).
    terrain.setTiles(state, [0]);
    const other = new Uint16Array(MW * MH);
    const before = uploads.length;
    terrain.setTiles(other, [0]);
    expect((tex.image as { data: unknown }).data).toBe(other);
    expect(uploads.length).toBe(before + 1);
    terrain.update(frame());
    expect(rects).toHaveLength(2);
    expect(terrain.perfStats()).toMatchObject({
      uploadCallsLastFrame: 1,
      texelsLastFrame: MW * MH,
      pendingTexels: 0,
      fullUploads: 2,
    });
    terrain.dispose();
  });

  it("spreads a big change over frames within the budget and drops nothing", () => {
    const MW = 1600;
    const MH = 800;
    const { ctx, rects } = makeCtx({ perf: true, width: MW, height: MH });
    const terrain = new TerrainLayer(ctx);
    const state = new Uint16Array(MW * MH);
    terrain.setTiles(state, null);
    terrain.update(frame());
    // A mirror of what the GPU holds, fed by the rectangle uploads.
    const gpu = state.slice();
    const apply = () => {
      for (const r of rects.splice(0)) {
        let i = 0;
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) gpu[y * MW + x] = r.values[i++];
        }
      }
    };
    // Scattered changes all over the map (one tick), then a nuke-sized
    // disc while the first ones are still queued.
    const scattered: number[] = [];
    for (let i = 0; i < 150; i++) {
      const ref = ((i * 7919) % MH) * MW + ((i * 104729) % MW);
      state[ref] = 1 + (i % 5);
      scattered.push(ref);
    }
    terrain.setTiles(state, scattered);
    terrain.update(frame());
    apply();
    let stats = terrain.perfStats();
    expect(stats.uploadCallsLastFrame).toBe(TILE_UPLOAD_BUDGET.maxCalls);
    expect(stats.pendingTexels).toBeGreaterThan(0);
    const disc: number[] = [];
    for (let y = 300; y <= 500; y++) {
      for (let x = 700; x <= 900; x++) {
        if ((x - 800) ** 2 + (y - 400) ** 2 > 100 * 100) continue;
        state[y * MW + x] = 0x1000 | 3;
        disc.push(y * MW + x);
      }
    }
    terrain.setTiles(state, disc);
    let frames = 1;
    while (terrain.perfStats().pendingTexels > 0) {
      terrain.update(frame());
      apply();
      stats = terrain.perfStats();
      expect(stats.uploadCallsLastFrame).toBeGreaterThan(0);
      expect(stats.uploadCallsLastFrame).toBeLessThanOrEqual(
        TILE_UPLOAD_BUDGET.maxCalls,
      );
      if (stats.uploadCallsLastFrame > 1) {
        expect(stats.texelsLastFrame).toBeLessThanOrEqual(
          TILE_UPLOAD_BUDGET.maxTexels,
        );
      }
      expect(++frames).toBeLessThan(100);
    }
    // A plain loop: a deep toEqual over 1.28M elements takes seconds and
    // made this test flaky under a loaded CI runner.
    expect(firstMismatch(gpu, state)).toBe(-1);
    expect(stats.uploadCallsMax).toBe(TILE_UPLOAD_BUDGET.maxCalls);
    expect(stats.fullUploads).toBe(1);
    terrain.dispose();
  });

  it("sends everything at once during the spawn phase, and past half the map in full", () => {
    const MW = 1600;
    const MH = 800;
    const { ctx, uploads, rects } = makeCtx({ width: MW, height: MH });
    const terrain = new TerrainLayer(ctx);
    const tex = tilesOf(ctx);
    const state = new Uint16Array(MW * MH);
    terrain.setTiles(state, null);
    const scattered: number[] = [];
    for (let i = 0; i < 150; i++) {
      scattered.push(((i * 7919) % MH) * MW + ((i * 104729) % MW));
    }
    terrain.setSpawnPhase(true);
    terrain.setTiles(state, scattered);
    terrain.update(frame());
    expect(rects.length).toBeGreaterThan(TILE_UPLOAD_BUDGET.maxCalls);
    expect(terrain.perfStats().pendingTexels).toBe(0);
    terrain.setSpawnPhase(false);

    // More than half the map changed: one full upload on the next frame.
    rects.length = 0;
    const half: number[] = [];
    for (let ref = 0; ref < (MW * MH * 3) / 4; ref++) half.push(ref);
    const before = uploads.length;
    terrain.setTiles(state, half);
    expect(uploads.length).toBe(before);
    terrain.update(frame());
    expect(uploads.length).toBe(before + 1);
    expect(uploads[uploads.length - 1]).toBe(tex);
    expect(rects).toEqual([]);
    expect(terrain.perfStats()).toMatchObject({
      uploadCallsLastFrame: 1,
      texelsLastFrame: MW * MH,
      pendingTexels: 0,
    });
    terrain.dispose();
  });

  it("swaps in a relation matrix of another size", () => {
    const { ctx } = makeCtx();
    const terrain = new TerrainLayer(ctx);
    const u = uniformsOf(meshNamed(ctx, "terrain"));
    terrain.setRelations(new Uint8Array(16), 4);
    expect(u.uRelSize.value).toBe(4);
    expect((u.uRelations.value as THREE.DataTexture).image.width).toBe(4);
    // Too short for its size: ignored.
    terrain.setRelations(new Uint8Array(3), 4);
    expect(u.uRelSize.value).toBe(4);
    terrain.dispose();
  });

  it("pushes frame state into its uniforms", () => {
    const { ctx } = makeCtx();
    const terrain = new TerrainLayer(ctx);
    const u = uniformsOf(meshNamed(ctx, "terrain"));
    terrain.update(frameFor(new THREE.PerspectiveCamera()));
    expect(u.uHighlightOwner.value).toBe(5);
    expect(u.uLocalPlayer.value).toBe(3);
    expect(u.uAltView.value).toBe(1);
    // The zoom's territory look (4 CSS px per tile) at dpr 2.
    const look = territoryLook(4, ctx.renderSettings.mapOverlay.territoryAlpha);
    expect(u.uBorderPx.value).toBeCloseTo(look.borderCssPx * 2, 9);
    expect(u.uFillAlpha.value).toBeCloseTo(look.fillAlpha, 9);
    expect(u.uTime.value).toBeCloseTo(1.234, 9);
    terrain.dispose();
  });

  it("strengthens the territory look as the camera zooms out (lot 3)", () => {
    const { ctx } = makeCtx();
    const terrain = new TerrainLayer(ctx);
    const u = uniformsOf(meshNamed(ctx, "terrain"));
    const base = ctx.renderSettings.mapOverlay.territoryAlpha;
    const at = (zoom: number, dpr = 1) => {
      terrain.update({
        ...frameFor(new THREE.PerspectiveCamera()),
        cssPxPerTile: zoom,
        dpr,
      });
      return {
        fill: u.uFillAlpha.value as number,
        border: u.uBorderPx.value as number,
        flatten: u.uFarFlatten.value as number,
        alt: u.uAltFillAlpha.value as number,
      };
    };
    // Close up: the settings' fill, the 1.3 px border, no flattening.
    expect(at(12)).toEqual({ fill: base, border: 1.3, flatten: 0, alt: 0.4 });
    // Full map: stronger fill, wider border (in device px), flattened
    // hillshade on owned land, stronger alt-view fill.
    const full = at(0.7);
    expect(full.fill).toBeGreaterThan(0.8);
    expect(full.border).toBeCloseTo(2.4, 9);
    expect(full.flatten).toBeGreaterThan(0.3);
    expect(full.alt).toBeGreaterThan(0.5);
    expect(at(0.7, 2).border).toBeCloseTo(4.8, 9);
    // The alt view's ground: owned land lighter than unowned land.
    expect(u.uAltGroundOwned.value).toBe(ALT_GROUND_OWNED);
    expect(u.uAltGroundFree.value).toBe(ALT_GROUND_FREE);
    expect(ALT_GROUND_OWNED).toBeGreaterThan(ALT_GROUND_FREE);
    // A configured alt fill stronger than ours wins (twice the setting).
    ctx.renderSettings.altView.fillAlpha = 0.45;
    expect(at(12).alt).toBeCloseTo(0.9, 9);
    terrain.dispose();
  });
});

describe("SceneEnvironment", () => {
  it("shares its uniforms with the layers and only fogs tilted views", () => {
    const { ctx } = makeCtx();
    const env = new SceneEnvironment(ctx);
    const terrain = new TerrainLayer(ctx);
    expect(environmentUniforms(ctx.scene)).toBe(env.uniforms);
    expect(uniformsOf(meshNamed(ctx, "terrain")).uSunDir).toBe(
      env.uniforms.uSunDir,
    );
    expect(ctx.scene.fog).toBe(env.fog);
    expect(SceneEnvironment.forScene(ctx.scene)).toBe(env);

    const cam = new THREE.PerspectiveCamera(30, 1, 1, 5000);
    cam.position.set(15, 200, 10); // straight down, 200 above the target
    env.update(frameFor(cam, 0));
    expect(env.fog.near).toBeGreaterThan(200);
    const topDownNear = env.fog.near;

    const tilt = (ctx.settings.maxTiltDeg * Math.PI) / 180;
    cam.position.set(15, 200 * Math.cos(tilt), 10 + 200 * Math.sin(tilt));
    env.update(frameFor(cam, tilt));
    expect(env.fog.near).toBeLessThan(topDownNear);
    expect(env.fog.far).toBeGreaterThan(env.fog.near);

    terrain.dispose();
    env.dispose();
    expect(ctx.scene.fog).toBeNull();
    expect(SceneEnvironment.forScene(ctx.scene)).toBeUndefined();
    expect(ctx.scene.children).toHaveLength(0);
  });
});

describe("TerrainByteTexture", () => {
  it("is shared per HeightField and disposed with its last user", () => {
    const { ctx, uploads } = makeCtx();
    const a = TerrainByteTexture.acquire(ctx);
    const b = TerrainByteTexture.acquire(ctx);
    expect(b).toBe(a);
    // Uploaded once, synchronously, at creation.
    expect(uploads.filter((t) => t === a.texture)).toHaveLength(1);
    // A full sync of the same bytes at the same version is a no-op.
    a.sync(null, ctx.heightField.terrain);
    expect(uploads.filter((t) => t === a.texture)).toHaveLength(1);

    let disposed = 0;
    a.texture.addEventListener("dispose", () => disposed++);
    a.release();
    expect(disposed).toBe(0);
    b.release();
    expect(disposed).toBe(1);
    expect(TerrainByteTexture.acquire(ctx)).not.toBe(a);
  });
});

describe("TerrainLayer lot 3 surfaces", () => {
  it("keeps a relief texture of the grid's slope and height (item 9)", () => {
    const { ctx, heightField: hf } = makeCtx();
    const terrain = new TerrainLayer(ctx);
    const mesh = meshNamed(ctx, "terrain");
    const u = uniformsOf(mesh);
    const tex = u.uRelief.value as THREE.DataTexture;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex.type).toBe(THREE.HalfFloatType);
    expect(tex.format).toBe(THREE.RGBAFormat);
    expect(tex.magFilter).toBe(THREE.LinearFilter);
    expect([tex.image.width, tex.image.height]).toEqual([hf.cols, hf.rows]);
    expect((u.uReliefGrid.value as THREE.Vector3).toArray()).toEqual([
      hf.step,
      hf.cols,
      hf.rows,
    ]);
    // Per vertex: the mesh normal's slope and the vertex height.
    const data = tex.image.data as Uint16Array;
    const pos = mesh.geometry.getAttribute("position").array;
    const nrm = mesh.geometry.getAttribute("normal").array;
    const half = THREE.DataUtils.fromHalfFloat;
    let sloped = 0;
    for (let k = 0; k < hf.cols * hf.rows; k++) {
      const gx = half(data[k * 4]);
      const gz = half(data[k * 4 + 1]);
      expect(half(data[k * 4 + 2])).toBeCloseTo(pos[k * 3 + 1], 2);
      expect(gx).toBeCloseTo(-nrm[k * 3] / nrm[k * 3 + 1], 2);
      expect(gz).toBeCloseTo(-nrm[k * 3 + 2] / nrm[k * 3 + 1], 2);
      if (Math.abs(gx) + Math.abs(gz) > 1e-3) sloped++;
    }
    expect(sloped).toBeGreaterThan(0); // around the island
    expect(terrain.perfStats().reliefTextureMB).toBeCloseTo(
      (hf.cols * hf.rows * 8) / (1 << 20),
      9,
    );
    terrain.dispose();
  });

  it("feeds the fallout field from the tile path, bounded (item 5)", () => {
    const MW = 64;
    const MH = 48;
    const { ctx } = makeCtx({ perf: true, width: MW, height: MH });
    const terrain = new TerrainLayer(ctx);
    const frame = () => frameFor(new THREE.PerspectiveCamera());
    const state = new Uint16Array(MW * MH);
    // A first full upload re-reads the buffer over the next frames.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) state[y * MW + x] = FALLOUT_BIT;
    }
    terrain.setTiles(state, null);
    expect(terrain.fallout.rebuilding).toBe(true);
    let frames = 0;
    while (terrain.fallout.rebuilding && frames < 100) {
      terrain.update(frame());
      frames++;
    }
    expect(terrain.fallout.total).toBe(64);
    expect(terrain.fallout.denseCells).toBe(1);
    // Then each tick's changed tiles, exactly (no rescan).
    const changed: number[] = [];
    for (let x = 20; x < 30; x++) {
      state[30 * MW + x] = FALLOUT_BIT | 5;
      changed.push(30 * MW + x);
    }
    state[0] = 3; // cleaned and conquered
    changed.push(0);
    terrain.setTiles(state, changed);
    expect(terrain.fallout.total).toBe(64 + 10 - 1);
    terrain.update(frame());
    expect(terrain.perfStats()).toMatchObject({
      falloutTiles: 73,
      falloutDenseCells: 1,
      falloutRebuilding: 0,
    });
    expect(terrain.perfStats().falloutMsMax).toBeGreaterThanOrEqual(0);
    terrain.dispose();
  });
});
