/**
 * When the 3D view is disposed. `ClientGameRunner.stop()` runs the renderer
 * disposer built by `createRendererDisposer`, which disposes the map view
 * (releasing its WebGL context), removes the canvas and the input overlay,
 * and drops `window.__webglView`. Main calls `stop()` through the lobby
 * handle on `beforeunload` (the in-game Quit and Back buttons navigate, so it
 * runs while the page unloads), when a new lobby is joined in place, on
 * `leave-lobby` and on desktop invites; the runner calls it itself on a
 * worker error.
 *
 * Here: a real ThreeMapRenderer (three's WebGLRenderer and initGL stubbed)
 * behind the real disposer and a real ClientGameRunner around mocked
 * collaborators (same mocks as ClientGameRunnerActions.test.ts).
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../../../src/client/ClientEnv", () => ({
  ClientEnv: { gitCommit: () => "test-commit" },
}));
vi.mock("../../../src/client/Auth", () => ({
  getPlayToken: async () => "8f1d2c3e-4b5a-4c6d-8e7f-90a1b2c3d4e5",
}));
vi.mock("../../../src/client/LocalServer", () => ({
  LocalServer: class {},
}));
vi.mock("../../../src/client/InGameModal", () => ({
  showInGameAlert: vi.fn(async () => {}),
  showInGameConfirm: vi.fn(async () => false),
}));
vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
  reloadForUpdate: vi.fn(),
  createCanvas: () => document.createElement("canvas"),
  homeHref: () => "/",
}));
vi.mock("../../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: {},
  loadCachedTerrainMap: vi.fn(async () => ({}) as never),
}));
vi.mock("../../../src/client/hud/GameRenderer", () => ({
  createRenderer: vi.fn(),
}));
vi.mock("../../../src/client/hud/layers/lib/GoldRateTracker", () => ({
  goldRateTracker: { resetAll: vi.fn() },
}));
vi.mock("../../../src/client/theme/ThemeProvider", () => ({
  themeProvider: { reset: vi.fn() },
}));
vi.mock("../../../src/client/sound/SoundManager", () => ({
  SoundManager: class {},
}));
vi.mock("../../../src/client/render/gl", () => ({
  GLUnavailableError: class extends Error {},
  MapRenderer: class {},
  applyGraphicsOverrides: vi.fn(),
  createRenderSettings: vi.fn(() => ({})),
  deepAssign: vi.fn(),
  preloadAtlasData: vi.fn(async () => {}),
  renderDpr: () => 1,
  showGLGate: vi.fn(),
  trackGLInit: vi.fn(),
}));
vi.mock("../../../src/client/WebGLFrameBuilder", () => ({
  WebGLFrameBuilder: class {},
}));
vi.mock("../../../src/client/controllers/MapLayerController", () => ({
  MapLayerController: class {},
}));
vi.mock("../../../src/client/view", () => ({
  GameView: class {},
  PlayerView: class {},
}));
vi.mock("../../../src/client/WorkerClient", () => ({
  WorkerClient: class {},
}));

vi.mock("../../../src/client/render/gl/initGL", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initGL: () => ({
    status: "ok",
    gl: {
      getExtension: (name: string) =>
        name === "WEBGL_lose_context"
          ? { loseContext: () => stub.calls.push("gl.loseContext") }
          : null,
    },
  }),
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    info = { autoReset: true, reset: () => {} };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "";
    initTexture() {}
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {
      stub.calls.push("renderer.dispose");
    }
    forceContextLoss() {
      stub.calls.push("forceContextLoss");
    }
  }
  return { ...actual, WebGLRenderer };
});

import {
  ClientGameRunner,
  createRendererDisposer,
  type LobbyConfig,
} from "../../../src/client/ClientGameRunner";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { ThreeMapRenderer } from "../../../src/client/render/three/ThreeMapRenderer";
import { readThreeSettingsFromUrl } from "../../../src/client/render/three/ThreeSettings";
import type { RendererConfig } from "../../../src/client/render/types";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

type DebugWindow = { __webglView?: unknown };

/** What createClientGame builds around the view, minus the game. */
function gameParts() {
  const glCanvas = document.createElement("canvas");
  glCanvas.id = "webgl-debug-canvas";
  document.body.appendChild(glCanvas);
  const inputOverlay = document.createElement("div");
  inputOverlay.id = "game-input-overlay";
  document.body.appendChild(inputOverlay);
  const view = new ThreeMapRenderer(
    glCanvas,
    { mapWidth: 8, mapHeight: 6, players: [] } as unknown as RendererConfig,
    () => new Uint8Array(8 * 6),
    new Float32Array(4096 * 2 * 4),
    { msPerTick: () => 100 } as unknown as Config,
    createRenderSettings(),
    () => 0,
    () => {},
    readThreeSettingsFromUrl("?three_bloom=0&three_perf=1"),
  );
  (window as DebugWindow).__webglView = view;
  const gameRenderer = {
    dispose: vi.fn(() => stub.calls.push("gameRenderer.dispose")),
  };
  const stopFrameLoop = vi.fn(() => stub.calls.push("stopFrameLoop"));
  const disposeRenderer = createRendererDisposer({
    gameRenderer,
    stopFrameLoop,
    view,
    glCanvas,
    inputOverlay,
  });
  return { view, disposeRenderer };
}

/** A runner around mocked collaborators, never started (still in lobby). */
function makeRunner(disposeRenderer: () => void) {
  const input = { initialize: vi.fn(), destroy: vi.fn() };
  const runner = new ClientGameRunner(
    { gameID: "game1234" } as LobbyConfig,
    "c0000001",
    new EventBus(),
    { initialize: vi.fn(), tick: vi.fn() } as never,
    input as never,
    { leaveGame: vi.fn() } as never,
    { cleanup: vi.fn() } as never,
    {} as never,
    { dispose: vi.fn() } as never,
    {} as never,
    null,
    null,
    disposeRenderer,
  );
  return { runner, input };
}

describe("3D view disposal on game stop", () => {
  beforeEach(() => {
    stub.calls = [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete (window as DebugWindow).__webglView;
    vi.restoreAllMocks();
  });

  it("ClientGameRunner.stop() disposes the view and releases its context", () => {
    const { disposeRenderer } = gameParts();
    const { runner, input } = makeRunner(disposeRenderer);
    expect((globalThis as { __threePerf?: unknown }).__threePerf).toBeDefined();

    runner.stop();

    expect(input.destroy).toHaveBeenCalled();
    expect(stub.calls).toEqual([
      "gameRenderer.dispose",
      "stopFrameLoop",
      "renderer.dispose",
      "forceContextLoss",
    ]);
    expect(document.getElementById("webgl-debug-canvas")).toBeNull();
    expect(document.getElementById("game-input-overlay")).toBeNull();
    expect(document.getElementById("three-map-overlay")).toBeNull();
    expect((window as DebugWindow).__webglView).toBeUndefined();
    expect(
      (globalThis as { __threePerf?: unknown }).__threePerf,
    ).toBeUndefined();
  });

  it("is idempotent: a second stop() releases nothing twice", () => {
    const { disposeRenderer } = gameParts();
    const { runner } = makeRunner(disposeRenderer);
    runner.stop();
    runner.stop();
    expect(stub.calls.filter((c) => c === "forceContextLoss")).toHaveLength(1);
  });

  it("leaves a newer game's debugging handle alone", () => {
    const { disposeRenderer } = gameParts();
    const newer = {};
    (window as DebugWindow).__webglView = newer;
    disposeRenderer();
    expect((window as DebugWindow).__webglView).toBe(newer);
  });
});
