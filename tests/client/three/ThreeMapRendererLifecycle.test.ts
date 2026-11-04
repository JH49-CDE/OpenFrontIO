/**
 * ThreeMapRenderer teardown: the facade must drop its WebGL context when it
 * is disposed (or fails to construct), like the default renderer does, so
 * repeated games in one tab don't pile up live contexts. three's
 * WebGLRenderer and initGL are stubbed; the layers are real.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { THREE_PARAMS_SESSION_KEY } from "../../../src/client/render/three/RendererSelection";
import { ThreeMapRenderer } from "../../../src/client/render/three/ThreeMapRenderer";
import type { ThreePerfSnapshot } from "../../../src/client/render/three/ThreePerf";
import {
  readThreeSettingsFromUrl,
  type ThreeRenderSettings,
} from "../../../src/client/render/three/ThreeSettings";
import type { RendererConfig } from "../../../src/client/render/types";

const stub = vi.hoisted(() => ({
  calls: [] as string[],
  failRendererConstruct: false,
  contextAttributes: [] as WebGLContextAttributes[],
  extensions: [] as string[],
  renders: 0,
}));

vi.mock("../../../src/client/render/gl/initGL", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initGL: (_canvas: HTMLCanvasElement, attrs: WebGLContextAttributes) => {
    stub.contextAttributes.push(attrs);
    return {
      status: "ok",
      gl: {
        SAMPLES: 0x80a9,
        getParameter: (p: number) => (p === 0x80a9 ? 4 : null),
        getExtension: (name: string) => {
          stub.extensions.push(name);
          return name === "WEBGL_lose_context"
            ? { loseContext: () => stub.calls.push("gl.loseContext") }
            : null;
        },
      },
    };
  },
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    info = {
      autoReset: true,
      reset: () => {},
      render: { calls: 3, triangles: 99 },
      memory: { geometries: 1, textures: 2 },
      programs: [],
    };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "";
    constructor() {
      if (stub.failRendererConstruct) throw new Error("no renderer");
    }
    initTexture() {}
    setPixelRatio() {}
    setSize() {}
    render() {
      stub.renders++;
    }
    dispose() {
      stub.calls.push("dispose");
    }
    forceContextLoss() {
      stub.calls.push("forceContextLoss");
    }
  }
  return { ...actual, WebGLRenderer };
});

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const W = 16;
const H = 12;

function makeRenderer(
  terrainSource: () => Uint8Array = () => new Uint8Array(W * H),
  threeSettings?: ThreeRenderSettings,
): {
  view: ThreeMapRenderer;
  canvas: HTMLCanvasElement;
  frame: () => void;
} {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  let pending: FrameRequestCallback | null = null;
  const view = new ThreeMapRenderer(
    canvas,
    { mapWidth: W, mapHeight: H, players: [] } as unknown as RendererConfig,
    terrainSource,
    new Float32Array(4096 * 2 * 4),
    { msPerTick: () => 100 } as unknown as Config,
    createRenderSettings(),
    (cb) => {
      pending = cb;
      return 1;
    },
    () => {
      pending = null;
    },
    threeSettings,
  );
  const frame = (): void => {
    const cb = pending;
    pending = null;
    cb?.(performance.now());
  };
  return { view, canvas, frame };
}

describe("ThreeMapRenderer lifecycle", () => {
  let search = "";

  beforeEach(() => {
    stub.calls = [];
    stub.failRendererConstruct = false;
    stub.contextAttributes = [];
    stub.extensions = [];
    stub.renders = 0;
    // No bloom: the post chain needs a real renderer.
    search = window.location.search;
    window.history.replaceState(null, "", "?three_bloom=0");
  });

  afterEach(() => {
    window.history.replaceState(null, "", search || "?");
    document.body.innerHTML = "";
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("releases the WebGL context on dispose", () => {
    const { view } = makeRenderer();
    expect(document.getElementById("three-map-overlay")).not.toBeNull();

    view.dispose();
    view.dispose(); // idempotent

    expect(stub.calls).toEqual(["dispose", "forceContextLoss"]);
    expect(document.getElementById("three-map-overlay")).toBeNull();
  });

  it("leaves an already-lost context to the browser", () => {
    const { view, canvas } = makeRenderer();
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);

    view.dispose();

    expect(stub.calls).toEqual(["dispose"]);
  });

  it("releases the context when construction fails after acquiring it", () => {
    expect(() =>
      makeRenderer(() => {
        throw new Error("terrain unavailable");
      }),
    ).toThrow("terrain unavailable");

    expect(stub.calls).toEqual(["dispose", "forceContextLoss"]);
    expect(document.getElementById("three-map-overlay")).toBeNull();
  });

  it("releases the raw context when three cannot adopt it", () => {
    stub.failRendererConstruct = true;

    expect(() => makeRenderer()).toThrow("no renderer");

    expect(stub.calls).toEqual(["gl.loseContext"]);
  });
});

describe("ThreeMapRenderer settings, anti-aliasing and perf tool", () => {
  beforeEach(() => {
    stub.calls = [];
    stub.failRendererConstruct = false;
    stub.contextAttributes = [];
    stub.extensions = [];
    stub.renders = 0;
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  /** No bloom (the post chain needs a real renderer), plus `search`. */
  const settings = (search = ""): ThreeRenderSettings =>
    readThreeSettingsFromUrl(`?three_bloom=0${search}`);

  it("reads the page-load three_* parameters, not the rewritten address bar", () => {
    // What RendererSelection remembered at page load; the address bar has
    // since been rewritten to "/" by the game start.
    sessionStorage.setItem(
      THREE_PARAMS_SESSION_KEY,
      "three_quality=low&three_tilt=20",
    );
    const { view } = makeRenderer();
    expect(view.threeSettings.quality).toBe("low");
    expect(view.threeSettings.maxTiltDeg).toBe(20);
    expect(view.threeSettings.bloom).toBe(false);
    view.dispose();
  });

  it("keeps MSAA on the canvas when bloom is off", () => {
    const { view } = makeRenderer(undefined, settings());
    expect(stub.contextAttributes).toEqual([
      expect.objectContaining({ antialias: true }),
    ]);
    expect(view.antialias).toEqual({
      contextMsaa: true,
      targetSamples: 0,
      fxaa: false,
      composer: false,
    });
    expect(view.canvasMsaaSamples).toBe(4);
    view.dispose();

    const { view: off } = makeRenderer(undefined, settings("&three_aa=off"));
    expect(stub.contextAttributes[1]).toMatchObject({ antialias: false });
    expect(off.canvasMsaaSamples).toBe(0);
    off.dispose();
  });

  it("costs nothing with the perf tool off", () => {
    const { view, frame } = makeRenderer(undefined, settings());
    frame();
    frame();
    expect(stub.renders).toBe(2);
    expect(stub.extensions).not.toContain("EXT_disjoint_timer_query_webgl2");
    expect(document.getElementById("three-perf-panel")).toBeNull();
    expect(
      (globalThis as { __threePerf?: unknown }).__threePerf,
    ).toBeUndefined();
    view.dispose();
  });

  it("measures frames and exposes window.__threePerf with ?three_perf=1", () => {
    const errors = vi.spyOn(console, "error");
    const { view, frame } = makeRenderer(undefined, settings("&three_perf=1"));
    for (let i = 0; i < 3; i++) frame();
    expect(errors).not.toHaveBeenCalled();
    expect(stub.renders).toBe(3);
    expect(stub.extensions).toContain("EXT_disjoint_timer_query_webgl2");

    // Facade calls between frames are timed by method.
    view.updateUnits(new Map(), 1);
    frame();

    const perf = (globalThis as { __threePerf?: () => ThreePerfSnapshot })
      .__threePerf;
    expect(typeof perf).toBe("function");
    const s = perf!();
    expect(s.frames).toBe(4);
    expect(s.drawCalls.last).toBe(3);
    expect(s.gpuMs).toBeNull(); // no timer extension in the stub: "n/a"
    expect(s.gpu.supported).toBe(false);
    expect(Object.keys(s.layers)).toEqual(
      expect.arrayContaining([
        "environment",
        "terrain",
        "water",
        "structures",
        "units",
        "overlay",
        "fx",
        "names",
      ]),
    );
    expect(s.layers.terrain.triangles).toBeGreaterThan(0);
    expect(s.calls.updateUnits).toBeDefined();
    expect(s.config).toMatchObject({
      quality: "high",
      bloom: false,
      antialias: "msaa",
      canvasMsaaSamples: 4,
      composer: false,
    });
    const panel = document.getElementById("three-perf-panel");
    expect(panel?.parentElement?.id).toBe("three-map-overlay");

    view.dispose();
    expect(
      (globalThis as { __threePerf?: unknown }).__threePerf,
    ).toBeUndefined();
    expect(document.getElementById("three-perf-panel")).toBeNull();
  });

  it("keeps counting draw calls after a context restore", () => {
    // Regression: three replaces renderer.info when a lost context comes
    // back; the perf tool held the old object and reported its last values
    // forever (seen in a headless late-game loss / restore).
    const { view, canvas, frame } = makeRenderer(
      undefined,
      settings("&three_perf=1"),
    );
    frame();
    const restored = vi.fn();
    view.onContextRestored = restored;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    frame(); // skipped while lost
    expect(stub.renders).toBe(1);
    (view.renderer as unknown as { info: unknown }).info = {
      autoReset: false,
      reset: () => {},
      render: { calls: 7, triangles: 500 },
      memory: { geometries: 4, textures: 5 },
      programs: [1],
    };
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(restored).toHaveBeenCalledTimes(1);
    frame();
    expect(stub.renders).toBe(2);
    const s = (globalThis as { __threePerf?: () => ThreePerfSnapshot })
      .__threePerf!();
    expect(s.drawCalls.last).toBe(7);
    expect(s.triangles.last).toBe(500);
    expect(s.memory).toEqual({ geometries: 4, textures: 5, programs: 1 });
    view.dispose();
  });
});
