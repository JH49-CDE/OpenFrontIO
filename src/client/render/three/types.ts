/**
 * Shared types of the Three.js renderer prototype: the context every layer is
 * constructed with and the per-frame info every layer's `update` receives.
 */

import type { Config } from "@openfront/engine-lib/configuration/Config";
import type * as THREE from "three";
import type { RenderSettings } from "../gl/RenderSettings";
import type { HeightField } from "./HeightField";
import type { PaletteView } from "./PaletteView";
import type { ThreeRenderSettings } from "./ThreeSettings";

/** What every layer gets at construction. All fields are long-lived. */
export interface ThreeLayerContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly mapWidth: number;
  readonly mapHeight: number;
  /**
   * Elevation grid. `heightAt(x, y)` / `surfaceAt(x, y)` give world Y,
   * `terrain` is the live full-map terrain byte array, `version` bumps on
   * every terrain change.
   */
  readonly heightField: HeightField;
  /** Player colours (territory fill = row 0, border = row 1). */
  readonly palette: PaletteView;
  /** Quality knobs of the 3D view. */
  readonly settings: ThreeRenderSettings;
  /** The game's render settings (terrain colours in `.terrain`, etc.). */
  readonly renderSettings: RenderSettings;
  /** Game rules config (`msPerTick()` etc.). */
  readonly config: Config;
  /**
   * DOM container above the canvas and below `#game-input-overlay`
   * (position fixed, inset 0, pointer-events none, overflow hidden).
   */
  readonly overlayRoot: HTMLElement;
}

/** Per-frame state handed to every layer's `update`. */
export interface FrameInfo {
  /** performance.now() at the start of the frame. */
  nowMs: number;
  /** Time since the previous frame, clamped to [0, 100] ms. */
  dtMs: number;
  /** 0..1 progress from the latest sim tick towards the next one. */
  tickAlpha: number;
  camera: THREE.PerspectiveCamera;
  /** Zoom: CSS px per tile at the screen centre (TransformHandler.scale). */
  cssPxPerTile: number;
  /** Camera tilt from straight down, radians (0 = top-down). */
  tilt: number;
  cssWidth: number;
  cssHeight: number;
  /** Backing-store pixels per CSS px actually in use. */
  dpr: number;
  /** Local player's smallID, 0 if none (spectator / replay). */
  localPlayerID: number;
  /** Hovered owner smallID, 0 if none. */
  highlightOwner: number;
  /** Alt view (space held): affiliation colours, names hidden. */
  altView: boolean;
}

/**
 * The visible ground as drawn: the relief mesh (TerrainLayer), and the sea
 * plane (Y = 0) wherever the relief dips below it. Overlays drape on it so
 * they never float above or sink under what is on screen.
 */
export interface ReliefSurface {
  /** Bumped whenever the drawn heights change (terrain patches). */
  readonly version: number;
  /** The grid the relief mesh is built on (step, cols, rows, vertexX/Y). */
  readonly grid: HeightField;
  /**
   * World Y of the visible surface at world (x, z): the relief mesh's own
   * triangles (coast lift included), at least sea level. Clamped to the map.
   */
  surfaceAt(x: number, z: number): number;
  /** The same at grid vertex (i, j): max(relief vertex Y, 0). */
  vertexSurface(i: number, j: number): number;
  /** Tile state texture (R16UI, owner in the low 12 bits), if any. */
  readonly tileTexture: THREE.Texture | null;
}

/** Camera inputs in the TransformHandler's terms (all CSS px / tiles). */
export interface CameraInputs {
  /** World point (tiles) at the canvas centre. */
  centerX: number;
  centerY: number;
  /** TransformHandler.scale. */
  cssPxPerTile: number;
  /** Canvas CSS size. */
  cssWidth: number;
  cssHeight: number;
}

/** Result of projecting a world point to the canvas. */
export interface ProjectedPoint {
  /** Canvas-relative CSS px. */
  x: number;
  y: number;
  /** In front of the camera and within the view (with a small margin). */
  visible: boolean;
}

/**
 * Projects world (wx, wy) — tile coords, wy is the map row — at world height
 * `wh` (default: the visible surface there) to the canvas.
 */
export type ProjectFn = (wx: number, wy: number, wh?: number) => ProjectedPoint;
