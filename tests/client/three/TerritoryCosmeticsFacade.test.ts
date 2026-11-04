/**
 * Facade wiring of the territory cosmetics (ThreeMapRenderer → TerrainLayer →
 * TerritoryCosmetics): patterns from `addPlayers` / `updatePlayerCosmetics`,
 * skins from `initSkinAtlas` / `setPlayerSkin` / `setPlayerSpawn`, team mode
 * from the players' teams, the live `territoryPatterns` switch, and the
 * terrain layer's perf counters. three's WebGLRenderer and initGL are
 * stubbed; the layers are real.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import { base64url } from "jose";
import type * as THREE_NS from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import {
  PALETTE_SIZE,
  writePatternEntry,
} from "../../../src/client/render/gl/utils/PlayerPalette";
import {
  COSMETIC_PATTERN,
  COSMETIC_SKIN,
} from "../../../src/client/render/three/TerritoryCosmetics";
import { ThreeMapRenderer } from "../../../src/client/render/three/ThreeMapRenderer";
import {
  type PlayerStatic,
  PlayerTypeEnum,
  type RendererConfig,
} from "../../../src/client/render/types";

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
    initTexture() {}
    copyTextureToTexture() {}
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

function player(smallID: number, team: string | null): PlayerStatic {
  return {
    smallID,
    id: `p${smallID}`,
    name: `P${smallID}`,
    displayName: `P${smallID}`,
    clanTag: null,
    clientID: null,
    playerType: PlayerTypeEnum.Human,
    team,
    isLobbyCreator: false,
  };
}

function makeView(players: PlayerStatic[] = []) {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  let pending: FrameRequestCallback | null = null;
  const terrain = new Uint8Array(W * H).fill(0x80 | 4);
  const settings = createRenderSettings();
  const view = new ThreeMapRenderer(
    canvas,
    { mapWidth: W, mapHeight: H, players } as unknown as RendererConfig,
    () => terrain,
    new Float32Array(4096 * 2 * 4),
    { msPerTick: () => 100 } as unknown as Config,
    settings,
    (cb) => {
      pending = cb;
      return 1;
    },
    () => {
      pending = null;
    },
  );
  const frame = (): void => {
    const cb = pending;
    pending = null;
    cb?.(performance.now());
  };
  const uniforms = () =>
    (
      view.scene.getObjectByName("terrain") as THREE_NS.Mesh<
        THREE_NS.BufferGeometry,
        THREE_NS.ShaderMaterial
      >
    ).material.uniforms;
  const metaTexel = (sid: number) => {
    const data = (uniforms().uCosmeticMeta.value as THREE_NS.DataTexture).image
      .data as Float32Array;
    return Array.from(data.subarray(sid * 4, sid * 4 + 4));
  };
  const stats = () =>
    (
      view as unknown as {
        terrain: { perfStats(): Record<string, number> };
      }
    ).terrain.perfStats();
  return { view, frame, uniforms, metaTexel, settings, stats };
}

/** A 4×4 checkerboard, scale 0. */
const CHECKER = (() => {
  const bytes = new Uint8Array([0, (4 - 2) << 3, (4 - 2) << 2, 0, 0]);
  for (let i = 0; i < 16; i++) {
    if (((i % 4) + (i >> 2)) % 2 === 1) bytes[3 + (i >> 3)] |= 1 << (i & 7);
  }
  return base64url.encode(bytes);
})();

describe("ThreeMapRenderer territory cosmetics", () => {
  let search = "";

  beforeEach(() => {
    search = window.location.search;
    window.history.replaceState(null, "", "?three_bloom=0");
  });

  afterEach(() => {
    window.history.replaceState(null, "", search || "?");
    document.body.innerHTML = "";
    sessionStorage.clear();
  });

  it("draws the patterns pushed with the players and on a cosmetics refresh", () => {
    const { view, frame, uniforms, metaTexel, settings, stats } = makeView();
    const meta = new Float32Array(PALETTE_SIZE * 4);
    const data = new Uint8Array(PALETTE_SIZE * 1024);
    writePatternEntry(meta, data, 3, { name: "checker", patternData: CHECKER });
    view.addPlayers(
      [player(3, null)],
      new Float32Array(PALETTE_SIZE * 2 * 4),
      meta,
      data,
    );
    frame();
    expect(metaTexel(3)).toEqual([COSMETIC_PATTERN, 4, 4, 0]);
    expect(uniforms().uCosmeticsOn.value).toBe(1);
    expect(stats().patternPlayers).toBe(1);
    expect(stats().patternMB).toBe(4);

    // The default renderer's debug switch, read live.
    settings.passEnabled.territoryPatterns = false;
    frame();
    expect(uniforms().uCosmeticsOn.value).toBe(0);
    settings.passEnabled.territoryPatterns = true;

    // Cosmetics hidden (visibility settings): cleared.
    writePatternEntry(meta, data, 3, undefined);
    view.updatePlayerCosmetics(
      [player(3, null)],
      new Float32Array(PALETTE_SIZE * 2 * 4),
      meta,
      data,
    );
    frame();
    expect(metaTexel(3)).toEqual([0, 0, 0, 0]);
    expect(uniforms().uCosmeticsOn.value).toBe(0);
    view.dispose();
  });

  it("anchors registered skins on the spawn tile", () => {
    const { view, frame, uniforms, metaTexel, stats } = makeView();
    const url = "https://cdn.test/skins/a.png";
    view.initSkinAtlas([url]);
    view.setPlayerSpawn(5, 20, 30);
    view.setPlayerSkin(5, url);
    view.setPlayerSkin(6, "https://cdn.test/skins/other.png");
    frame();
    expect(metaTexel(5)).toEqual([COSMETIC_SKIN, 0, 20, 30]);
    expect(metaTexel(6)).toEqual([0, 0, 0, 0]);
    const atlas = uniforms().uSkinAtlas.value as THREE_NS.DataArrayTexture;
    expect(atlas.image.depth).toBe(1);
    expect(stats().skinLayers).toBe(1);
    expect(stats().skinPlayers).toBe(1);
    expect(uniforms().uCosmeticsOn.value).toBe(1);
    view.dispose();
  });

  it("tints skins in team games (any player with a team)", () => {
    const ffa = makeView([player(1, null), player(2, null)]);
    expect(ffa.uniforms().uCosmeticsTeam.value).toBe(0);
    ffa.view.addPlayers(
      [player(3, "Red")],
      new Float32Array(PALETTE_SIZE * 2 * 4),
      new Float32Array(PALETTE_SIZE * 4),
      new Uint8Array(PALETTE_SIZE * 1024),
    );
    expect(ffa.uniforms().uCosmeticsTeam.value).toBe(1);
    ffa.view.dispose();
    const teams = makeView([player(1, "Blue")]);
    expect(teams.uniforms().uCosmeticsTeam.value).toBe(1);
    teams.view.dispose();
  });
});
