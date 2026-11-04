import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isThreeRendererRequested,
  RENDERER_STORAGE_KEY,
  syncRendererPreferenceFromUrl,
} from "../../../src/client/render/three/RendererSelection";

describe("RendererSelection", () => {
  beforeEach(() => {
    localStorage.removeItem(RENDERER_STORAGE_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(RENDERER_STORAGE_KEY);
  });

  it("defaults to the WebGL renderer", () => {
    expect(isThreeRendererRequested("")).toBe(false);
    expect(isThreeRendererRequested("?foo=bar")).toBe(false);
  });

  it("uses three when the URL asks, and remembers it", () => {
    expect(isThreeRendererRequested("?renderer=three")).toBe(true);
    syncRendererPreferenceFromUrl("?renderer=three");
    expect(localStorage.getItem(RENDERER_STORAGE_KEY)).toBe("three");
    expect(isThreeRendererRequested("")).toBe(true);
  });

  it("lets the URL win over storage", () => {
    localStorage.setItem(RENDERER_STORAGE_KEY, "three");
    expect(isThreeRendererRequested("?renderer=webgl")).toBe(false);
    expect(isThreeRendererRequested("?renderer=gl")).toBe(false);
    localStorage.removeItem(RENDERER_STORAGE_KEY);
    expect(isThreeRendererRequested("?renderer=THREE")).toBe(true);
  });

  it("forgets the choice on ?renderer=webgl or gl", () => {
    for (const value of ["webgl", "gl"]) {
      localStorage.setItem(RENDERER_STORAGE_KEY, "three");
      syncRendererPreferenceFromUrl(`?renderer=${value}`);
      expect(localStorage.getItem(RENDERER_STORAGE_KEY)).toBeNull();
    }
  });

  it("leaves storage alone without (or with an unknown) renderer param", () => {
    localStorage.setItem(RENDERER_STORAGE_KEY, "three");
    syncRendererPreferenceFromUrl("?lobby=abc");
    syncRendererPreferenceFromUrl("?renderer=vulkan");
    expect(localStorage.getItem(RENDERER_STORAGE_KEY)).toBe("three");
    expect(isThreeRendererRequested("?renderer=vulkan")).toBe(true);
  });

  it("only treats the stored value 'three' as an opt-in", () => {
    localStorage.setItem(RENDERER_STORAGE_KEY, "yes");
    expect(isThreeRendererRequested("")).toBe(false);
  });

  it("reads the page URL by default", () => {
    window.history.replaceState(null, "", "/?renderer=three");
    try {
      expect(isThreeRendererRequested()).toBe(true);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() =>
      syncRendererPreferenceFromUrl("?renderer=three"),
    ).not.toThrow();
    expect(isThreeRendererRequested("")).toBe(false);
    expect(isThreeRendererRequested("?renderer=three")).toBe(true);
  });
});

/**
 * The homepage rewrites the address bar when a game starts (Main.ts:
 * `history.pushState(null, "", pathname)` for solo, `#refresh` + the game
 * path for multiplayer), after which `location.search` is empty. The
 * `three_*` parameters must survive that: Main hands the page-load query to
 * `syncRendererPreferenceFromUrl` at bootstrap, and the 3D renderer reads
 * them back through `threeSettingsSearch()`.
 */
describe("three_* parameters across a game start", () => {
  type Selection =
    typeof import("../../../src/client/render/three/RendererSelection");
  type Settings =
    typeof import("../../../src/client/render/three/ThreeSettings");

  /** A fresh page: modules re-evaluated, storage kept (same tab). */
  async function loadPage(
    url: string,
  ): Promise<{ selection: Selection; settings: Settings }> {
    window.history.replaceState(null, "", url);
    vi.resetModules();
    const selection =
      await import("../../../src/client/render/three/RendererSelection");
    const settings =
      await import("../../../src/client/render/three/ThreeSettings");
    // What Main's bootstrap does when the URL names a renderer or three_*.
    if (selection.namesRendererParams(window.location.search)) {
      selection.syncRendererPreferenceFromUrl(window.location.search);
    }
    return { selection, settings };
  }

  /** Main.ts's history writes when a solo game starts. */
  function soloLaunch(): void {
    window.history.pushState(null, "", window.location.pathname);
  }

  /** Main.ts's history writes when a multiplayer game starts. */
  function multiplayerLaunch(): void {
    if (window.location.hash === "" || window.location.hash === "#") {
      window.history.replaceState(
        null,
        "",
        window.location.origin + "#refresh",
      );
    }
    window.history.pushState(null, "", "/w0/game/AbCdEfGh?live");
  }

  beforeEach(() => {
    localStorage.removeItem(RENDERER_STORAGE_KEY);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    localStorage.removeItem(RENDERER_STORAGE_KEY);
    sessionStorage.clear();
  });

  it("knows which query strings the homepage must hand over", async () => {
    const { selection } = await loadPage("/");
    expect(selection.namesRendererParams("?renderer=three")).toBe(true);
    expect(selection.namesRendererParams("?three_quality=low")).toBe(true);
    expect(selection.namesRendererParams("?three_perf=1&x=1")).toBe(true);
    expect(selection.namesRendererParams("")).toBe(false);
    expect(selection.namesRendererParams("?lobby=abc&threeX=1")).toBe(false);
    expect(
      selection.threeParamsOf(
        "?a=1&three_tilt=30&renderer=three&three_aa=fxaa",
      ),
    ).toBe("three_tilt=30&three_aa=fxaa");
    expect(selection.threeParamsOf("?renderer=three")).toBe("");
  });

  it("keeps three_quality, three_bloom and three_tilt through a solo launch", async () => {
    const { selection, settings } = await loadPage(
      "/?renderer=three&three_quality=low&three_bloom=1&three_tilt=30",
    );
    soloLaunch();
    expect(window.location.search).toBe("");

    expect(selection.isThreeRendererRequested()).toBe(true);
    const s = settings.readThreeSettingsFromUrl();
    expect(s.quality).toBe("low");
    expect(s.targetVertices).toBe(150_000);
    expect(s.bloom).toBe(true); // three_bloom=1 wins over low's default
    expect(s.maxTiltDeg).toBe(30);
  });

  it("keeps them through a multiplayer launch, with the renderer from storage", async () => {
    localStorage.setItem(RENDERER_STORAGE_KEY, "three");
    const { selection, settings } = await loadPage(
      "/?three_quality=low&three_bloom=0&three_tilt=20",
    );
    multiplayerLaunch();
    expect(window.location.search).toBe("?live");

    expect(selection.isThreeRendererRequested()).toBe(true);
    const s = settings.readThreeSettingsFromUrl();
    expect(s.quality).toBe("low");
    expect(s.bloom).toBe(false);
    expect(s.maxTiltDeg).toBe(20);
  });

  it("keeps them for the next game of the tab (Quit reloads the homepage)", async () => {
    await loadPage("/?renderer=three&three_quality=low&three_tilt=10");
    soloLaunch();

    const { settings } = await loadPage("/");
    soloLaunch();
    const s = settings.readThreeSettingsFromUrl();
    expect(s.quality).toBe("low");
    expect(s.maxTiltDeg).toBe(10);
  });

  it("replaces them when a later page load names the renderer", async () => {
    await loadPage("/?renderer=three&three_quality=low");
    const { settings } = await loadPage("/?renderer=three");
    soloLaunch();
    expect(settings.readThreeSettingsFromUrl().quality).toBe("high");
  });

  it("still covers the page load when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { selection, settings } = await loadPage(
      "/?renderer=three&three_quality=low",
    );
    multiplayerLaunch();

    expect(selection.isThreeRendererRequested()).toBe(true);
    expect(selection.isThreeRendererRequested("")).toBe(false);
    expect(settings.readThreeSettingsFromUrl().quality).toBe("low");
  });

  it("reads the address bar when the page-load sync never ran", async () => {
    window.history.replaceState(null, "", "/?three_bloom=0");
    vi.resetModules();
    const settings =
      await import("../../../src/client/render/three/ThreeSettings");
    expect(settings.readThreeSettingsFromUrl().bloom).toBe(false);
  });
});
