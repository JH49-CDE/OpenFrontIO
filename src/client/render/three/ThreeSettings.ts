/**
 * Quality / look knobs of the Three.js renderer prototype. Separate from the
 * game's `RenderSettings` (which belongs to the default WebGL2 renderer):
 * these only exist for the 3D view.
 */

import { threeSettingsSearch } from "./RendererSelection";

export type ThreeQuality = "high" | "low";

/**
 * Anti-aliasing technique, independent of bloom:
 * - `msaa`: multisampling. On the post-processing target when bloom is on,
 *   else on the canvas itself (WebGL context `antialias`), which costs no
 *   extra pass or render target. Only below `MSAA_MAX_PIXEL_RATIO`.
 * - `fxaa`: one FXAA pass after tone mapping, at any pixel ratio. Needs the
 *   post-processing chain even without bloom.
 * - `off`: none.
 */
export type ThreeAntialias = "msaa" | "fxaa" | "off";

/**
 * MSAA only below this backing-store pixel ratio: at 1.5× and above the
 * extra pixels already smooth edges and multisampled targets get expensive.
 */
export const MSAA_MAX_PIXEL_RATIO = 1.5;

export interface ThreeRenderSettings {
  quality: ThreeQuality;
  /** Vertical field of view of the perspective camera, degrees. */
  fovDeg: number;
  /** Camera tilt reached at `tiltEndZoom` (0 = always top-down), degrees. */
  maxTiltDeg: number;
  /** Zoom (CSS px per tile) below which the view is exactly top-down. */
  tiltStartZoom: number;
  /** Zoom (CSS px per tile) at and above which the tilt is `maxTiltDeg`. */
  tiltEndZoom: number;
  /** World Y (tiles) of the highest land (magnitude 30). */
  heightScale: number;
  /** World depth (tiles, positive) of the deepest seabed below sea level. */
  seabedDepth: number;
  /** Upper bound for the relief mesh vertex count (sets the grid step). */
  targetVertices: number;
  /** Post-processing bloom; false renders straight to the canvas. */
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  /**
   * Linear-HDR luminance above which pixels bloom. Lit albedo stays below 1,
   * so only emissive things glow (highlighted borders, fallout, glints, FX).
   */
  bloomThreshold: number;
  /** Tone-mapping exposure (Khronos PBR Neutral). */
  exposure: number;
  /** Anti-aliasing technique (see `ThreeAntialias`). */
  antialias: ThreeAntialias;
  /** MSAA samples of the post-processing target, when MSAA is on there. */
  msaaSamples: number;
  /** Cap on the backing-store pixel ratio (on top of `renderDpr()`). */
  pixelRatioCap: number;
  /** Minimum on-screen size of a mobile unit, CSS px. */
  unitMinScreenPx: number;
  /** Minimum on-screen size of a structure, CSS px. */
  structureMinScreenPx: number;
  /**
   * Performance panel and `window.__threePerf()` (`?three_perf=1`). Layers
   * may read it to skip their own instrumentation when off.
   */
  perf: boolean;
  /**
   * Lot-4 visual prototypes, off by default and compiled out of the shaders
   * when off (each is fixed for the page's lifetime):
   * - `wakes`: foam wakes behind moving ships (`?three_wakes=1`)
   * - `front`: living front - capture wave, border smoke/sparks, attack
   *   arrows (`?three_front=1`)
   * - `night`: night and lights - lit cities by level, nuke flash lighting
   *   the ground (`?three_night=1`, see `nightModeOf` in NightLights.ts)
   */
  prototypes: ThreePrototypes;
}

export interface ThreePrototypes {
  wakes: boolean;
  front: boolean;
  night: boolean;
}

export function defaultThreeSettings(): ThreeRenderSettings {
  return {
    quality: "high",
    fovDeg: 30,
    maxTiltDeg: 50,
    tiltStartZoom: 2.5,
    tiltEndZoom: 12,
    heightScale: 6,
    seabedDepth: 3,
    targetVertices: 600_000,
    bloom: true,
    bloomStrength: 0.45,
    bloomRadius: 0.5,
    bloomThreshold: 1,
    exposure: 1,
    antialias: "msaa",
    msaaSamples: 4,
    pixelRatioCap: 2,
    unitMinScreenPx: 10,
    structureMinScreenPx: 14,
    perf: false,
    prototypes: { wakes: false, front: false, night: false },
  };
}

function flagParam(params: URLSearchParams, key: string): boolean {
  const v = params.get(key)?.trim().toLowerCase();
  return v === "1" || v === "true";
}

function finiteParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function antialiasParam(value: string | null): ThreeAntialias | null {
  switch (value?.trim().toLowerCase()) {
    case "msaa":
    case "1":
      return "msaa";
    case "fxaa":
      return "fxaa";
    case "off":
    case "0":
      return "off";
    default:
      return null;
  }
}

/**
 * Defaults plus overrides from the `three_*` query parameters, for testing on
 * devices. By default reads `threeSettingsSearch()`: the parameters of the
 * page-load URL, which survive the address-bar rewrite of a game start.
 * - `three_quality=low` → no bloom, ~150k-vertex relief, pixel ratio ≤ 1.5
 *   (anti-aliasing stays on: canvas MSAA)
 * - `three_tilt=<deg>` → max camera tilt (0 = always top-down)
 * - `three_bloom=0|1`  → force bloom off/on
 * - `three_aa=msaa|fxaa|off` (`1` = msaa, `0` = off) → anti-aliasing
 * - `three_perf=1`     → performance panel and `window.__threePerf()`
 * - `three_wakes=1`, `three_front=1`, `three_night=1` → lot-4 prototypes
 */
export function readThreeSettingsFromUrl(
  search: string = threeSettingsSearch(),
): ThreeRenderSettings {
  const s = defaultThreeSettings();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return s;
  }
  if (params.get("three_quality")?.toLowerCase() === "low") {
    s.quality = "low";
    s.bloom = false;
    s.targetVertices = 150_000;
    s.pixelRatioCap = 1.5;
  }
  const tilt = finiteParam(params, "three_tilt");
  if (tilt !== null) s.maxTiltDeg = Math.max(0, Math.min(75, tilt));
  const bloom = params.get("three_bloom");
  if (bloom === "0" || bloom === "1") s.bloom = bloom === "1";
  const aa = antialiasParam(params.get("three_aa"));
  if (aa !== null) s.antialias = aa;
  s.perf = flagParam(params, "three_perf");
  s.prototypes = {
    wakes: flagParam(params, "three_wakes"),
    front: flagParam(params, "three_front"),
    night: flagParam(params, "three_night"),
  };
  return s;
}

/** How a frame is anti-aliased and composed, from settings + pixel ratio. */
export interface AntialiasPlan {
  /** WebGL context `antialias` attribute (multisampled canvas). */
  contextMsaa: boolean;
  /** MSAA samples of the post-processing target (0 = none). */
  targetSamples: number;
  /** FXAA pass at the end of the post-processing chain. */
  fxaa: boolean;
  /** Whether the post-processing chain (EffectComposer) runs at all. */
  composer: boolean;
}

/**
 * Resolve anti-aliasing for a renderer created at backing-store pixel ratio
 * `pixelRatio` (`min(renderDpr(), pixelRatioCap)`). Bloom and FXAA need the
 * composer; MSAA rides on the composer's target when the composer runs, and
 * on the canvas otherwise, so turning bloom off never turns AA off.
 */
export function planAntialias(
  s: Pick<ThreeRenderSettings, "bloom" | "antialias" | "msaaSamples">,
  pixelRatio: number,
): AntialiasPlan {
  const fxaa = s.antialias === "fxaa";
  const composer = s.bloom || fxaa;
  const msaa =
    s.antialias === "msaa" &&
    pixelRatio < MSAA_MAX_PIXEL_RATIO &&
    s.msaaSamples > 0;
  return {
    contextMsaa: msaa && !composer,
    targetSamples: msaa && composer ? s.msaaSamples : 0,
    fxaa,
    composer,
  };
}
