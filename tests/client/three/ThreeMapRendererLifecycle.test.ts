/**
 * ThreeMapRenderer teardown: the facade must drop its WebGL context when it
 * is disposed (or fails to construct), like the default renderer does, so
 * repeated games in one tab don't pile up live contexts. three's
 * WebGLRenderer and initGL are stubbed; the layers are real.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { ThreeMapRenderer } from "../../../src/client/render/three/ThreeMapRenderer";
import type { RendererConfig } from "../../../src/client/render/types";

const stub = vi.hoisted(() => ({
  calls: [] as string[],
  failRendererConstruct: false,
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
    constructor() {
      if (stub.failRendererConstruct) throw new Error("no renderer");
    }
    initTexture() {}
    setPixelRatio() {}
    setSize() {}
    render() {}
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
): { view: ThreeMapRenderer; canvas: HTMLCanvasElement } {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const view = new ThreeMapRenderer(
    canvas,
    { mapWidth: W, mapHeight: H, players: [] } as unknown as RendererConfig,
    terrainSource,
    new Float32Array(4096 * 2 * 4),
    { msPerTick: () => 100 } as unknown as Config,
    createRenderSettings(),
    () => 0,
    () => {},
  );
  return { view, canvas };
}

describe("ThreeMapRenderer lifecycle", () => {
  let search = "";

  beforeEach(() => {
    stub.calls = [];
    stub.failRendererConstruct = false;
    // No bloom: the post chain needs a real renderer.
    search = window.location.search;
    window.history.replaceState(null, "", "?three_bloom=0");
  });

  afterEach(() => {
    window.history.replaceState(null, "", search || "?");
    document.body.innerHTML = "";
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
