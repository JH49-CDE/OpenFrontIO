/**
 * Quality / look knobs of the Three.js renderer prototype. Separate from the
 * game's `RenderSettings` (which belongs to the default WebGL2 renderer):
 * these only exist for the 3D view.
 */

export type ThreeQuality = "high" | "low";

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
  /** MSAA samples of the post-processing target (0 = off). */
  msaaSamples: number;
  /** Cap on the backing-store pixel ratio (on top of `renderDpr()`). */
  pixelRatioCap: number;
  /** Minimum on-screen size of a mobile unit, CSS px. */
  unitMinScreenPx: number;
  /** Minimum on-screen size of a structure, CSS px. */
  structureMinScreenPx: number;
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
    msaaSamples: 4,
    pixelRatioCap: 2,
    unitMinScreenPx: 10,
    structureMinScreenPx: 14,
  };
}

function finiteParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Defaults plus overrides from the query string, for testing on devices:
 * - `three_quality=low` → no bloom/MSAA, ~150k-vertex relief, pixel ratio ≤ 1.5
 * - `three_tilt=<deg>` → max camera tilt (0 = always top-down)
 * - `three_bloom=0|1`  → force bloom off/on
 */
export function readThreeSettingsFromUrl(
  search: string = globalThis.location?.search ?? "",
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
    s.msaaSamples = 0;
    s.targetVertices = 150_000;
    s.pixelRatioCap = 1.5;
  }
  const tilt = finiteParam(params, "three_tilt");
  if (tilt !== null) s.maxTiltDeg = Math.max(0, Math.min(75, tilt));
  const bloom = params.get("three_bloom");
  if (bloom === "0" || bloom === "1") s.bloom = bloom === "1";
  return s;
}
