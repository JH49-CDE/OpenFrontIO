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
import {
  TerrainLayer,
  TILE_UPLOAD_BUDGET,
} from "../../../src/client/render/three/TerrainLayer";
import { TerrainByteTexture } from "../../../src/client/render/three/TerrainResources";
import { COAST_LIFT } from "../../../src/client/render/three/TerrainShading";
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
  it("is the HeightField grid plus outward-facing edge skirts", () => {
    const { ctx, heightField: hf } = makeCtx();
    const terrain = new TerrainLayer(ctx);
    const geo = meshNamed(ctx, "terrain").geometry;
    const pos = geo.getAttribute("position").array;
    const index = geo.getIndex()!.array;
    const grid = hf.cols * hf.rows;
    expect(pos.length / 3).toBe(grid + 2 * (2 * hf.cols + 2 * hf.rows));
    const gridTris = (hf.cols - 1) * (hf.rows - 1) * 2;
    const skirtTris = 2 * (2 * (hf.cols - 1) + 2 * (hf.rows - 1));
    expect(index.length).toBe((gridTris + skirtTris) * 3);

    for (let t = 0; t < gridTris; t++) {
      const n = triangleNormal(
        pos,
        index[3 * t],
        index[3 * t + 1],
        index[3 * t + 2],
      );
      expect(n.y).toBeGreaterThan(0); // counter-clockwise from above
    }
    for (let t = gridTris; t < gridTris + skirtTris; t++) {
      const [a, b, c] = [index[3 * t], index[3 * t + 1], index[3 * t + 2]];
      const n = triangleNormal(pos, a, b, c);
      const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3 - W / 2;
      const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3 - H / 2;
      expect(Math.abs(n.y)).toBeLessThan(1e-9); // vertical wall
      expect(n.x * cx + n.z * cz).toBeGreaterThan(0); // facing out
    }
    // Skirt bottoms sit below the deepest seabed.
    let minY = Infinity;
    for (let k = grid; k < pos.length / 3; k++)
      minY = Math.min(minY, pos[k * 3 + 1]);
    expect(minY).toBeLessThan(-ctx.settings.seabedDepth);
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
    expect(u.uBorderPx.value).toBeCloseTo(2.6, 9); // 1.3 CSS px at dpr 2
    expect(u.uTime.value).toBeCloseTo(1.234, 9);
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
