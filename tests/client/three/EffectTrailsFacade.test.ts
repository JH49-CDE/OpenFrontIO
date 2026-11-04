/**
 * Facade wiring of the boat / nuke trails and the effect palette
 * (ThreeMapRenderer → TerrainLayer → EffectTrails, shared with WaterLayer
 * and UnitLayer): `uploadTileAndTrailState` (full upload now),
 * `uploadLiveTrailDelta` (rows diffed, rectangles sent by the next frames),
 * `updateEffectPalette` (one texture for the ground and the ribbons),
 * `updateRelations` (alt-view colours), and the perf counters. three's
 * WebGLRenderer and initGL are stubbed; the layers are real.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import type * as THREE_NS from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NUKE_TRAIL_BIT } from "../../../src/client/render/frame/TrailManager";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { getPaletteSize } from "../../../src/client/render/gl/utils/ColorUtils";
import { writePlayerEffects } from "../../../src/client/render/gl/utils/PlayerPalette";
import { EFFECT_ROWS } from "../../../src/client/render/three/EffectTrails";
import { ThreeMapRenderer } from "../../../src/client/render/three/ThreeMapRenderer";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type { RendererConfig } from "../../../src/client/render/types";

const uploads = vi.hoisted(() => ({ full: 0, rects: 0 }));

vi.mock("../../../src/client/render/gl/initGL", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initGL: () => ({
    status: "ok",
    gl: {
      SAMPLES: 0x80a9,
      getParameter: () => 0,
      getExtension: () => null,
    },
  }),
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    info = {
      autoReset: true,
      reset: () => {},
      render: { calls: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
      programs: [],
    };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "";
    private target: unknown = null;
    initTexture() {
      uploads.full++;
    }
    copyTextureToTexture() {
      uploads.rects++;
    }
    setPixelRatio() {}
    setSize() {}
    getRenderTarget() {
      return this.target;
    }
    setRenderTarget(t: unknown) {
      this.target = t;
    }
    render() {}
    dispose() {}
    forceContextLoss() {}
  }
  return { ...actual, WebGLRenderer };
});

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const W = 64;
const H = 48;
const PALETTE = getPaletteSize();

function makeView() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  let pending: FrameRequestCallback | null = null;
  const terrain = new Uint8Array(W * H).fill(0x80 | 4);
  const settings = createRenderSettings();
  const view = new ThreeMapRenderer(
    canvas,
    { mapWidth: W, mapHeight: H, players: [] } as unknown as RendererConfig,
    () => terrain,
    new Float32Array(PALETTE * 2 * 4),
    { msPerTick: () => 100 } as unknown as Config,
    settings,
    (cb) => {
      pending = cb;
      return 1;
    },
    () => {
      pending = null;
    },
    // No bloom: the post chain needs a real renderer.
    { ...defaultThreeSettings(), bloom: false },
  );
  const frame = (): void => {
    const cb = pending;
    pending = null;
    cb?.(performance.now());
  };
  const material = (name: string) =>
    (
      view.scene.getObjectByName(name) as THREE_NS.Mesh<
        THREE_NS.BufferGeometry,
        THREE_NS.ShaderMaterial
      >
    ).material;
  const stats = () =>
    (
      view as unknown as {
        terrain: { perfStats(): Record<string, number> };
      }
    ).terrain.perfStats();
  return { view, frame, material, settings, stats };
}

const views: ThreeMapRenderer[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.dispose();
});

describe("ThreeMapRenderer trails and effect palette", () => {
  it("uploads the full trail state now and live deltas over the next frames", () => {
    const { view, frame, material, stats } = makeView();
    views.push(view);
    const tiles = new Uint16Array(W * H);
    const trail = new Uint16Array(W * H);
    trail[10 * W + 5] = 3;
    const full0 = uploads.full;
    view.uploadTileAndTrailState(tiles, trail);
    // Tiles and trails, both immediate.
    expect(uploads.full - full0).toBe(2);
    frame();
    expect(stats().trailTiles).toBe(1);
    expect(stats().trailsOn).toBe(1);
    expect(stats().trailUploadCallsLastFrame).toBe(1);
    // The terrain and the water paint the same trail texture.
    const terrain = material("terrain");
    const water = material("water");
    expect(terrain.uniforms.uTrailTex).toBe(water.uniforms.uTrailTex);
    expect(terrain.uniforms.uTrailsOn.value).toBe(1);
    expect(water.uniforms.uPalette.value).toBe(view.palette.texture);

    // A tick's rows: marked, then diffed and sent as a rectangle by the
    // next frame.
    trail[20 * W + 30] = 3 | NUKE_TRAIL_BIT;
    trail[21 * W + 31] = 3 | NUKE_TRAIL_BIT;
    const rects0 = uploads.rects;
    view.uploadLiveTrailDelta(trail, 20, 21);
    expect(uploads.rects).toBe(rects0);
    expect(stats().trailPendingRows).toBe(2);
    frame();
    expect(stats().trailScannedTexelsLastFrame).toBe(2 * W);
    expect(uploads.rects - rects0).toBe(1);
    expect(stats().trailPendingCells).toBe(0);
    expect(stats().trailTiles).toBe(3);
    expect(stats().trailUploadCallsLastFrame).toBe(1);
    expect(stats().trailTexelsLastFrame).toBe(16 * 16);
  });

  it("shares one effect palette texture between the ground and the ribbons", () => {
    const { view, frame, material, stats } = makeView();
    views.push(view);
    const pal = new Float32Array(PALETTE * EFFECT_ROWS * 4);
    writePlayerEffects(
      pal,
      3,
      (t) =>
        t === "nukeTrail"
          ? {
              type: "transition",
              colors: ["#ff0000", "#ffffff"],
              frequency: 1,
            }
          : undefined,
      { setNukeTrailSpiral() {}, clearNukeTrailSpiral() {} },
    );
    view.updateEffectPalette(pal);
    frame();
    const terrain = material("terrain");
    const tex = terrain.uniforms.uEffectPalette.value as THREE_NS.DataTexture;
    expect((tex.image as { data: Float32Array }).data[3 * 4]).toBe(0); // boat block
    const nukeRow = EFFECT_ROWS / 6;
    expect(
      (tex.image as { data: Float32Array }).data[
        (nukeRow * PALETTE + 3) * 4 + 3
      ],
    ).toBe(2); // two colours
    expect(material("water").uniforms.uEffectPalette.value).toBe(tex);
    expect(material("unit-trails").uniforms.uEffectPalette.value).toBe(tex);
    expect(terrain.uniforms.uEffectsOn.value).toBe(1);
    expect(stats().effectNukePlayers).toBe(1);
    expect(stats().effectBoatPlayers).toBe(0);
    expect(stats().effectPaletteUploads).toBe(1);
  });

  it("feeds the relations to the alt-view trail colours", () => {
    const { view, frame, settings, stats } = makeView();
    views.push(view);
    view.setLocalPlayerID(1);
    const size = 8;
    const rel = new Uint8Array(size * size);
    rel[1 * size + 2] = 1; // 1 → 2 friendly
    view.updateRelations(rel, size);
    view.setAltView(true);
    frame();
    expect(stats().trailAffiliationRebuilds).toBe(1);
    const trails = (
      view as unknown as {
        terrain: { trails: { affiliationData: Uint8Array } };
      }
    ).terrain.trails;
    const a = settings.affiliation;
    expect(Array.from(trails.affiliationData.subarray(8, 11))).toEqual(
      [a.allyR, a.allyG, a.allyB].map((v) => Math.round(v * 255)),
    );
  });
});
