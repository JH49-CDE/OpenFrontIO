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
