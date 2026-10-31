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
import { TerrainLayer } from "../../../src/client/render/three/TerrainLayer";
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

/** Layer context over a stub renderer that records synchronous uploads. */
function makeCtx() {
  const terrain = new Uint8Array(W * H).fill(DEEP);
  terrain[ISLAND[1] * W + ISLAND[0]] = LAND; // a 1-tile island
  const settings = defaultThreeSettings();
  const heightField = new HeightField(W, H, terrain, {
    heightScale: settings.heightScale,
    seabedDepth: settings.seabedDepth,
    targetVertices: (W * H) / 9, // step 3
  });
  const uploads: THREE.Texture[] = [];
  const renderer = {
    initTexture: (t: THREE.Texture) => uploads.push(t),
  } as unknown as THREE.WebGLRenderer;
  const ctx: ThreeLayerContext = {
    renderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField,
    palette: new PaletteView(),
    settings,
    renderSettings: createRenderSettings(),
    config: {} as Config,
    overlayRoot: document.createElement("div"),
  };
  return { ctx, uploads, heightField };
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
    const { ctx, heightField: hf } = makeCtx();
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
    terrainTex.clearUpdateRanges();

    const rects = [{ x: ISLAND[0], y: ISLAND[1], w: 1, h: 1 }];
    const bytes = new Uint8Array([0]); // nuked: shallow water
    expect(hf.applyRects(rects, bytes)).not.toBeNull();
    terrain.setTerrainBytes(rects, bytes);
    water.setTerrainBytes(rects, bytes);
    for (const k of corners) {
      expect(pos[k * 3 + 1]).toBe(hf.heights[k]);
      expect(pos[k * 3 + 1]).toBeLessThan(0);
    }
    // One single-row upload, not one per layer.
    expect(terrainTex.updateRanges).toEqual([
      { start: (ISLAND[1] * W + ISLAND[0]) * 4, count: 4 },
    ]);
    const position = geo.getAttribute("position") as THREE.BufferAttribute;
    expect(position.updateRanges.length).toBeGreaterThan(0);

    water.dispose();
    terrain.dispose();
  });
});

describe("TerrainLayer tile state uploads", () => {
  it("uploads fully first, then only the touched row spans", () => {
    const { ctx, uploads } = makeCtx();
    const terrain = new TerrainLayer(ctx);
    const tex = uniformsOf(meshNamed(ctx, "terrain")).uTiles
      .value as THREE.DataTexture;
    const state = new Uint16Array(W * H);

    terrain.setTiles(state, null);
    expect((tex.image as { data: unknown }).data).toBe(state);
    expect(uploads).toContain(tex);
    expect(tex.updateRanges).toEqual([]);

    state[2 * W + 5] = 7;
    state[2 * W + 9] = 7;
    state[4 * W + 0] = 7;
    terrain.setTiles(state, [2 * W + 9, 4 * W, 2 * W + 5]);
    expect(tex.updateRanges).toEqual([
      { start: (2 * W + 5) * 4, count: 5 * 4 },
      { start: (4 * W + 0) * 4, count: 4 },
    ]);
    // A different buffer instance forces a full upload of that buffer.
    const other = new Uint16Array(W * H);
    const before = uploads.length;
    terrain.setTiles(other, [0]);
    expect((tex.image as { data: unknown }).data).toBe(other);
    expect(uploads.length).toBe(before + 1);
    expect(tex.updateRanges).toEqual([]);
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
