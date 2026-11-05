/**
 * Surface overlays (SurfaceOverlay.ts, owned by TerrainLayer): the
 * coordinate grid (cell size, labels, on/off with the grid view and the alt
 * view) and the small-player glow (set → GPU mask passes, strength, pulse),
 * plus the zero-cost-when-off contract.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { TERRAIN_FRAG } from "../../../src/client/render/three/shaders/terrain";
import {
  GLOW_TILE_SCALE,
  glowIntensity,
  gridCellSize,
  gridFontPx,
  gridLabel,
  SEA_OVERLAY_RENDER_ORDER,
} from "../../../src/client/render/three/SurfaceOverlay";
import { TerrainLayer } from "../../../src/client/render/three/TerrainLayer";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import { WATER_RENDER_ORDER } from "../../../src/client/render/three/WaterLayer";

const W = 64;
const H = 40;

interface StubLog {
  renders: { scene: THREE.Scene; target: unknown }[];
  uploads: THREE.Texture[];
}

function makeTerrain() {
  const terrain = new Uint8Array(W * H).fill(0x80 | 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < 10; x++) terrain[y * W + x] = 8;
  const settings = defaultThreeSettings();
  const heightField = new HeightField(W, H, terrain, {
    heightScale: settings.heightScale,
    seabedDepth: settings.seabedDepth,
    targetVertices: (W * H) / 4,
  });
  const log: StubLog = { renders: [], uploads: [] };
  let target: unknown = null;
  const renderer = {
    initTexture: (t: THREE.Texture) => log.uploads.push(t),
    copyTextureToTexture: () => {},
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => {
      target = t;
    },
    render: (scene: THREE.Scene) => log.renders.push({ scene, target }),
  } as unknown as THREE.WebGLRenderer;
  const renderSettings = createRenderSettings();
  const ctx: ThreeLayerContext = {
    renderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField,
    palette: new PaletteView(),
    settings,
    renderSettings,
    config: {} as Config,
    overlayRoot: document.createElement("div"),
  };
  const layer = new TerrainLayer(ctx);
  const material = (
    ctx.scene.getObjectByName("terrain") as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >
  ).material;
  const plane = ctx.scene.getObjectByName("sea-overlay") as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.ShaderMaterial
  >;
  return {
    layer,
    ctx,
    log,
    u: material.uniforms,
    plane,
    target: () => target,
    renderSettings,
  };
}

function frame(over: Partial<FrameInfo> = {}): FrameInfo {
  return {
    nowMs: 1000,
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
    ...over,
  };
}

describe("coordinate grid", () => {
  it("uses the default renderer's cell size", () => {
    // ~10 cells across the short side, at most 50 columns.
    expect(gridCellSize(2000, 1000)).toBe(100);
    expect(gridCellSize(1000, 1000)).toBe(100);
    expect(gridCellSize(1500, 800)).toBeCloseTo(1500 / 19, 9);
    // 3000×500: 60 columns capped to 50, rows limited to 8.
    expect(gridCellSize(3000, 500)).toBe(60);
  });

  it("labels rows by letter and columns from 1", () => {
    expect(gridLabel(0, 0)).toBe("A1");
    expect(gridLabel(25, 9)).toBe("Z10");
    expect(gridLabel(26, 0)).toBe("AA1");
    expect(gridLabel(27, 49)).toBe("AB50");
    // Font: 24 px at zoom 1, +1.2 px per zoom step, clamped to 0.9..1.6x.
    expect(gridFontPx(24, 1)).toBe(24);
    expect(gridFontPx(24, 0.1)).toBeCloseTo(22.92, 9);
    expect(gridFontPx(24, 100)).toBeCloseTo(38.4, 9);
  });

  it("turns on with the grid view or the alt view, off otherwise", () => {
    const t = makeTerrain();
    t.layer.update(frame());
    expect(t.u.uOverlayOn.value).toBe(0);
    expect(t.u.uGridOn.value).toBe(0);
    expect(t.plane.visible).toBe(false);

    t.layer.setGridView(true);
    t.layer.update(frame({ cssPxPerTile: 8, dpr: 2, tilt: Math.PI / 3 }));
    expect(t.u.uOverlayOn.value).toBe(1);
    expect(t.u.uGridOn.value).toBe(1);
    expect(t.plane.visible).toBe(true);
    // Device px per tile, and labels stretched upright under tilt.
    expect(t.u.uGridZoom.value).toBe(16);
    expect(t.u.uGridStretch.value).toBeCloseTo(2, 6);
    expect(t.u.uGridOpacity.value).toBe(
      t.renderSettings.mapOverlay.coordinateGridOpacity,
    );
    expect(t.u.uGridCell.value).toBe(gridCellSize(W, H));
    // Cells of 6.4 tiles × 16 px ≥ 60 px: labels (canvas atlas) on.
    expect(t.u.uGridLabels.value).toBe(1);
    expect(t.u.uGridGlyphs.value).toBeInstanceOf(THREE.CanvasTexture);
    // Zoomed out under 60 px per cell: lines only.
    t.layer.update(frame({ cssPxPerTile: 2 }));
    expect(t.u.uGridLabels.value).toBe(0);

    t.layer.setGridView(false);
    t.layer.update(frame());
    expect(t.u.uOverlayOn.value).toBe(0);
    expect(t.plane.visible).toBe(false);
    t.layer.update(frame({ altView: true }));
    expect(t.u.uGridOn.value).toBe(1);
    expect(t.plane.visible).toBe(true);
    t.layer.update(frame({ altView: false }));
    expect(t.plane.visible).toBe(false);
    t.layer.dispose();
  });

  it("draws the sea part right after the water, the rest in the terrain shader", () => {
    const t = makeTerrain();
    expect(t.plane.renderOrder).toBe(SEA_OVERLAY_RENDER_ORDER);
    expect(SEA_OVERLAY_RENDER_ORDER).toBeGreaterThan(WATER_RENDER_ORDER);
    expect(t.plane.material.depthWrite).toBe(false);
    expect(t.plane.material.transparent).toBe(true);
    // Overlay uniforms are shared by reference with the sea plane.
    expect(t.plane.material.uniforms.uGridOn).toBe(t.u.uGridOn);
    // The terrain shader composites the overlay in its delimited block.
    expect(TERRAIN_FRAG).toContain("BEGIN surface overlay composite");
    // Only on the map: not on the map-edge apron (lot 3).
    expect(TERRAIN_FRAG).toContain(
      "if (uOverlayOn > 0.5 && dOut <= 0.0 && (land || vWorld.y > 0.0))",
    );
    t.layer.dispose();
  });
});

describe("small-player glow", () => {
  it("builds the mask on the GPU once per pushed set", () => {
    const t = makeTerrain();
    const set = new Uint8Array(4096);
    set[3] = 1;
    t.layer.setSmallPlayerGlow(set);
    // The set texture is uploaded when it changes.
    const uploadsAfterSet = t.log.uploads.length;
    expect(uploadsAfterSet).toBeGreaterThan(0);
    expect(t.log.renders).toHaveLength(0);
    t.layer.update(frame());
    // Extract, blur H, blur V; render target restored.
    expect(t.log.renders).toHaveLength(3);
    expect(t.target()).toBe(null);
    const [extract, blurH, blurV] = t.log.renders;
    expect(extract.target).not.toBe(blurH.target);
    expect(blurV.target).toBe(extract.target);
    expect(t.u.uGlowOn.value).toBe(1);
    expect(t.u.uOverlayOn.value).toBe(1);
    expect(t.plane.visible).toBe(true);
    // Mask texels cover 4×4 tiles (rounded up).
    expect(t.u.uGlowMaskTiles.value.x).toBe(
      Math.ceil(W / GLOW_TILE_SCALE) * GLOW_TILE_SCALE,
    );
    // Later frames only animate the pulse.
    t.layer.update(frame());
    t.layer.update(frame());
    expect(t.log.renders).toHaveLength(3);
    // The next push (1/s) rebuilds; an identical set is not re-uploaded.
    t.layer.setSmallPlayerGlow(set);
    expect(t.log.uploads.length).toBe(uploadsAfterSet);
    t.layer.update(frame());
    expect(t.log.renders).toHaveLength(6);
    const stats = t.layer.perfStats();
    expect(stats.glowMaskBuilds).toBe(2);
    expect(stats.glowSetUploads).toBe(1);
    // null: off at once, no passes.
    t.layer.setSmallPlayerGlow(null);
    t.layer.update(frame());
    expect(t.u.uGlowOn.value).toBe(0);
    expect(t.u.uOverlayOn.value).toBe(0);
    expect(t.plane.visible).toBe(false);
    expect(t.log.renders).toHaveLength(6);
    t.layer.dispose();
  });

  it("follows the strength setting live (0 = off, mask deferred)", () => {
    const t = makeTerrain();
    const glow = t.renderSettings.smallPlayerGlow;
    glow.strength = 0;
    const set = new Uint8Array(4096);
    set[5] = 1;
    t.layer.setSmallPlayerGlow(set);
    t.layer.update(frame());
    expect(t.u.uGlowOn.value).toBe(0);
    expect(t.log.renders).toHaveLength(0);
    glow.strength = 5; // clamped to 1
    t.layer.update(frame());
    expect(t.u.uGlowOn.value).toBe(1);
    expect(t.log.renders).toHaveLength(3);
    expect(t.u.uGlowIntensity.value).toBeLessThanOrEqual(glow.alpha);
    // Colour from render settings, as linear rgb.
    expect(t.u.uGlowColor.value.x).toBeCloseTo(1, 6);
    expect(t.u.uGlowColor.value.y).toBeCloseTo(0.0137, 3);
    t.layer.dispose();
  });

  it("pulses like SmallPlayerGlowPass", () => {
    expect(glowIntensity(0.9, 0, 0.35)).toBeCloseTo(0.9 * 0.5 * 0.35, 9);
    expect(glowIntensity(0.9, Math.PI / 2, 1)).toBeCloseTo(0.9, 9);
    expect(glowIntensity(0.9, -Math.PI / 2, 1)).toBeCloseTo(0, 9);
    expect(glowIntensity(0.9, Math.PI / 2, 3)).toBeCloseTo(0.9, 9);
  });

  it("rebuilds the mask after a context restore", () => {
    const t = makeTerrain();
    const set = new Uint8Array(4096);
    set[2] = 1;
    t.layer.setSmallPlayerGlow(set);
    t.layer.update(frame());
    expect(t.log.renders).toHaveLength(3);
    t.layer.contextRestored();
    t.layer.update(frame());
    expect(t.log.renders).toHaveLength(6);
    t.layer.dispose();
  });
});
