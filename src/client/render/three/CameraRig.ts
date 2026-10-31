/**
 * CameraRig — camera math of the Three.js renderer: the pose for a given
 * TransformHandler view, the zoom→tilt curve, picking (canvas ray ∩ surface)
 * and world→canvas projection. All math is done in doubles here (not through
 * three's matrices) so that at tilt 0 over flat ground it reproduces
 * TransformHandler's 2D formula exactly.
 *
 * World: X = tile x, Z = tile y (map row, "south"), Y = up, 1 unit = 1 tile.
 *
 * Pose for inputs (cx, cy, s = CSS px per tile, cssW × cssH):
 *   target T = (cx, 0, cy)
 *   distance d = (cssH / s) / (2 tan(fov/2))   → the ground at T is drawn at
 *     exactly s px per tile, so at tilt 0 the footprint equals the 2D view
 *   tilt θ = maxTilt · smoothstep(tiltStart, tiltEnd, s)
 *   position P = T + d·(0, cos θ, sin θ)        (south of T, looking north-down)
 *   rotation.x = -π/2 + θ (order YXZ)            → north stays screen-up
 * Camera basis (rows of the view rotation): right = (1, 0, 0),
 *   up = (0, sin θ, -cos θ), forward = (0, -cos θ, -sin θ).
 */

import * as THREE from "three";
import type { ThreeRenderSettings } from "./ThreeSettings";
import type { CameraInputs, ProjectedPoint } from "./types";

type TiltSettings = Pick<
  ThreeRenderSettings,
  "fovDeg" | "maxTiltDeg" | "tiltStartZoom" | "tiltEndZoom"
>;

/** Hermite smoothstep: 0 at/below e0, 1 at/above e1. */
export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Camera tilt (radians from straight down) at a zoom in CSS px per tile. */
export function tiltForZoom(cssPxPerTile: number, s: TiltSettings): number {
  return (
    ((s.maxTiltDeg * Math.PI) / 180) *
    smoothstep(s.tiltStartZoom, s.tiltEndZoom, cssPxPerTile)
  );
}

/** A resolved camera pose; plain numbers so it is cheap to recompute. */
export interface CameraPose {
  tilt: number;
  distance: number;
  fovRad: number;
  /** Focal length in CSS px: cssH / (2 tan(fov/2)). */
  focalPx: number;
  cssWidth: number;
  cssHeight: number;
  targetX: number;
  targetZ: number;
  posX: number;
  posY: number;
  posZ: number;
  /** up = (0, upY, upZ); forward = (0, fwdY, fwdZ); right = (1, 0, 0). */
  upY: number;
  upZ: number;
  fwdY: number;
  fwdZ: number;
  near: number;
  far: number;
}

export function computeCameraPose(
  inputs: CameraInputs,
  settings: TiltSettings,
  mapWidth: number,
  mapHeight: number,
): CameraPose {
  const cssW = inputs.cssWidth > 0 ? inputs.cssWidth : 1;
  const cssH = inputs.cssHeight > 0 ? inputs.cssHeight : 1;
  const scale = inputs.cssPxPerTile > 0 ? inputs.cssPxPerTile : 1;
  const fovRad = (settings.fovDeg * Math.PI) / 180;
  const focalPx = cssH / (2 * Math.tan(fovRad / 2));
  const distance = focalPx / scale;
  const tilt = tiltForZoom(scale, settings);
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return {
    tilt,
    distance,
    fovRad,
    focalPx,
    cssWidth: cssW,
    cssHeight: cssH,
    targetX: inputs.centerX,
    targetZ: inputs.centerY,
    posX: inputs.centerX,
    posY: distance * c,
    posZ: inputs.centerY + distance * s,
    upY: s,
    upZ: -c,
    fwdY: -c,
    fwdZ: -s,
    near: Math.max(0.5, distance * 0.02),
    far: distance * 8 + Math.max(mapWidth, mapHeight),
  };
}

/** Copy a pose onto a three PerspectiveCamera (matrices updated). */
export function applyPoseToCamera(
  pose: CameraPose,
  camera: THREE.PerspectiveCamera,
): void {
  camera.fov = (pose.fovRad * 180) / Math.PI;
  camera.aspect = pose.cssWidth / pose.cssHeight;
  camera.near = pose.near;
  camera.far = pose.far;
  camera.position.set(pose.posX, pose.posY, pose.posZ);
  camera.rotation.set(-Math.PI / 2 + pose.tilt, 0, 0, "YXZ");
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** Camera-space depth (along forward) of a world point; ≤ 0 = behind. */
function viewDepth(pose: CameraPose, wy: number, wz: number): number {
  return (wy - pose.posY) * pose.fwdY + (wz - pose.posZ) * pose.fwdZ;
}

/**
 * Canvas CSS px of world point (wx, wh, wz) (three coords: wh = height,
 * wz = map row). `depth` ≤ 0 means behind the camera (x/y are then NaN).
 */
export function projectToCanvas(
  pose: CameraPose,
  wx: number,
  wh: number,
  wz: number,
): { x: number; y: number; depth: number } {
  const depth = viewDepth(pose, wh, wz);
  if (!(depth > 1e-9)) return { x: NaN, y: NaN, depth };
  const xc = wx - pose.posX;
  const yc = (wh - pose.posY) * pose.upY + (wz - pose.posZ) * pose.upZ;
  const k = pose.focalPx / depth;
  return {
    x: pose.cssWidth / 2 + xc * k,
    y: pose.cssHeight / 2 - yc * k,
    depth,
  };
}

/** Un-normalised world direction of the ray through canvas pixel (px, py). */
export function canvasRayDir(
  pose: CameraPose,
  px: number,
  py: number,
): { x: number; y: number; z: number } {
  const a = (px - pose.cssWidth / 2) / pose.focalPx;
  const b = -(py - pose.cssHeight / 2) / pose.focalPx;
  // forward + a·right + b·up
  return {
    x: a,
    y: pose.fwdY + b * pose.upY,
    z: pose.fwdZ + b * pose.upZ,
  };
}

/**
 * Surface sampler: world (x, y = map row) → visible surface height (≥ 0).
 * `HeightField` implements it.
 */
export interface SurfaceSampler {
  surfaceAt(x: number, y: number): number;
  readonly maxHeight: number;
  readonly step: number;
}

const MAX_MARCH_STEPS = 512;
const BISECT_STEPS = 24;

/**
 * First intersection of the canvas ray with the visible surface (terrain on
 * land, the Y = 0 water plane elsewhere), or the Y = 0 plane when there is no
 * surface. Returns world (x, y = map row, h = height), or null when the ray
 * does not point down.
 *
 * Since the surface lies in [0, maxHeight], the hit is between the ray's
 * entry into that slab and its crossing of Y = 0 (where f ≤ 0 is guaranteed).
 * March with half-grid-cell steps to bracket the first crossing of
 * f(t) = rayY(t) - surface(t), then bisect.
 */
export function pickSurface(
  pose: CameraPose,
  px: number,
  py: number,
  surface: SurfaceSampler | null,
): { x: number; y: number; h: number } | null {
  const d = canvasRayDir(pose, px, py);
  if (!(d.y < -1e-12)) return null;
  const ox = pose.posX;
  const oy = pose.posY;
  const oz = pose.posZ;
  const tExit = oy / -d.y;
  const top = surface ? Math.max(0, surface.maxHeight) : 0;
  if (surface === null || top <= 0) {
    return { x: ox + tExit * d.x, y: oz + tExit * d.z, h: 0 };
  }
  const f = (t: number): number =>
    oy + t * d.y - surface.surfaceAt(ox + t * d.x, oz + t * d.z);

  let t0 = Math.max(0, (oy - top) / -d.y);
  if (f(t0) <= 0) {
    // Camera inside the slab and already below the surface: degenerate.
    return { x: ox + t0 * d.x, y: oz + t0 * d.z, h: oy + t0 * d.y };
  }
  const horiz = Math.hypot(d.x, d.z);
  let dt =
    horiz > 1e-12 ? (0.5 * Math.max(1, surface.step)) / horiz : tExit - t0;
  dt = Math.max(dt, (tExit - t0) / MAX_MARCH_STEPS);
  let t1 = t0;
  for (;;) {
    t1 = Math.min(tExit, t0 + dt);
    if (f(t1) <= 0 || t1 >= tExit) break;
    t0 = t1;
  }
  for (let k = 0; k < BISECT_STEPS; k++) {
    const tm = 0.5 * (t0 + t1);
    if (f(tm) <= 0) t1 = tm;
    else t0 = tm;
  }
  return { x: ox + t1 * d.x, y: oz + t1 * d.z, h: oy + t1 * d.y };
}

/**
 * Owns a PerspectiveCamera driven by TransformHandler-style inputs, plus the
 * picking / projection helpers for its current pose. Construct a second rig
 * (sharing the HeightField) for an independent projector.
 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.5, 1000);
  private _pose: CameraPose;

  constructor(
    private readonly settings: TiltSettings,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
    /** Usually the shared HeightField; null = flat ground at Y = 0. */
    private readonly surface: SurfaceSampler | null,
  ) {
    this._pose = computeCameraPose(
      {
        centerX: mapWidth / 2,
        centerY: mapHeight / 2,
        cssPxPerTile: 1,
        cssWidth: 1,
        cssHeight: 1,
      },
      settings,
      mapWidth,
      mapHeight,
    );
  }

  get pose(): CameraPose {
    return this._pose;
  }

  get tilt(): number {
    return this._pose.tilt;
  }

  /** Recompute the pose from fresh inputs and apply it to `camera`. */
  update(inputs: CameraInputs): CameraPose {
    this.updatePose(inputs);
    applyPoseToCamera(this._pose, this.camera);
    return this._pose;
  }

  /**
   * Recompute the pose only (picking / projection), leaving `camera` as is.
   * Cheaper than `update` — what the input projector uses on every call.
   */
  updatePose(inputs: CameraInputs): CameraPose {
    this._pose = computeCameraPose(
      inputs,
      this.settings,
      this.mapWidth,
      this.mapHeight,
    );
    return this._pose;
  }

  /**
   * World point (tiles, float) under canvas pixel (cssX, cssY), or null when
   * the ray misses the map rect [0, W]×[0, H].
   */
  canvasToWorld(cssX: number, cssY: number): { x: number; y: number } | null {
    const hit = pickSurface(this._pose, cssX, cssY, this.surface);
    if (
      hit === null ||
      !(hit.x >= 0 && hit.x <= this.mapWidth) ||
      !(hit.y >= 0 && hit.y <= this.mapHeight)
    ) {
      return null;
    }
    return { x: hit.x, y: hit.y };
  }

  /**
   * Canvas CSS px of world (x, y) at height `h` (default: the visible surface
   * there). NaN when the point is behind the camera.
   */
  worldToCanvas(x: number, y: number, h?: number): { x: number; y: number } {
    const wh = h ?? this.surface?.surfaceAt(x, y) ?? 0;
    const p = projectToCanvas(this._pose, x, wh, y);
    return { x: p.x, y: p.y };
  }

  /** `worldToCanvas` plus an on-screen test (10% margin around the view). */
  project(x: number, y: number, h?: number): ProjectedPoint {
    const wh = h ?? this.surface?.surfaceAt(x, y) ?? 0;
    const p = projectToCanvas(this._pose, x, wh, y);
    const mx = this._pose.cssWidth * 0.1;
    const my = this._pose.cssHeight * 0.1;
    const visible =
      p.depth > this._pose.near &&
      p.x >= -mx &&
      p.x <= this._pose.cssWidth + mx &&
      p.y >= -my &&
      p.y <= this._pose.cssHeight + my;
    return { x: p.x, y: p.y, visible };
  }
}
