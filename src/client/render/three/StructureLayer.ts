/**
 * StructureLayer — instanced structures (City, Port, Factory, Defense Post,
 * SAM Launcher, Missile Silo) standing on the relief, with the default
 * renderer's status information.
 *
 * One `InstancedBatch` per model variant (cities, SAM launchers and silos
 * change shape with level — see `structureVariant`). Instance data (position,
 * owner colour, state) is rebuilt only in `updateStructures`, which the
 * facade calls on ticks where a structure changed. Per frame the layer only
 * rewrites matrices when something visual moves: the zoom-dependent minimum
 * size, the build-menu highlight, structures under construction (grey,
 * small, slowly growing / pulsing) and structures marked for deletion (red,
 * blinking). Every structure stands on a soft contact shadow.
 *
 * Status (parity with BarPass / StructureLevelPass):
 * - a progress bar above the model (`StatusBars`): deletion countdown,
 *   construction progress or missile readiness (silo / SAM), from
 *   `structureProgress`, refreshed every tick by `updateStatus`;
 * - the level number (level > 1) as a small DOM badge above the model in
 *   `ctx.overlayRoot` (Overpass bold like the names, white on a dark pill
 *   so it reads on any terrain), shown from the default renderer's icon
 *   zoom (1.2) on.
 *
 * Level of detail: below STRUCTURE_LOD_ZOOM CSS px per tile
 * (STRUCTURE_LOD_ZOOM_LOW with `quality: "low"`), where a model is only a
 * few dozen px wide, every structure switches to its low-poly model
 * (`createStructureLodGeometry`, batches `structures-<type>#<variant>@lod`);
 * the switch has 15% hysteresis and costs one `rebuild`. Labels and bars
 * stay anchored on the full model's height.
 *
 * Culling: structures whose bounding sphere (with a margin) leaves the view
 * frustum get no instance (nor shadow); a change of the visible set costs
 * one `rebuild`, so it only happens while panning close up. `perfStats()`
 * reports the instances and triangles drawn and the structures culled.
 *
 * Contract notes:
 * - `updateStructures` gets the FULL unit map, only on ticks where a
 *   structure changed (new, owner, level, isActive, construction finished).
 * - `updateStatus` gets the full unit map and the tick EVERY tick (the
 *   facade's `updateUnits`): progress bars advance and a change of
 *   `markedForDeletion` (which does not trigger `updateStructures`) is
 *   picked up there.
 * - `setHighlightTypes(null)` clears the build-menu type highlight.
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import {
  STRUCTURE_TYPES,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  type UnitState,
} from "../types";
import type { HeightField } from "./HeightField";
import { ensureOverpassFont, LABEL_FONT_FAMILY } from "./NameLayer";
import {
  BlobShadows,
  createPartMaterial,
  createStructureGeometry,
  createStructureLodGeometry,
  InstancedBatch,
  levelChangesModel,
  MAX_VISUAL_LEVEL,
  setOwnerColor,
  shadowOffset,
  STRUCTURE_FOOTPRINT,
  structureVariant,
  triangleCount,
} from "./ProceduralMeshes";
import { barSize, StatusBars } from "./StatusBars";
import { isLand } from "./TerrainCodec";
import type { FrameInfo, ThreeLayerContext } from "./types";
import { minScreenScale, sphereInFrustum } from "./UnitLayer";

/** Time over which a structure under construction grows to its full ghost size. */
const CONSTRUCTION_GROW_MS = 6000;
/** Relative zoom change that triggers a rewrite of the min-size scale. */
const ZOOM_EPSILON = 0.002;
/** Level labels / bars appear above this zoom (default `dotsZoomThreshold`). */
export const STATUS_MIN_ZOOM = 1.2;
/** Contact shadow: diameter / footprint, opacity, lift above the ground. */
const SHADOW_SIZE = 1.18;
const SHADOW_ALPHA = 0.4;
const SHADOW_LIFT = 0.08;

/** Structures use their low-poly models below this zoom (CSS px per tile)... */
export const STRUCTURE_LOD_ZOOM = 5;
/** ...or below this one with `quality: "low"`. */
export const STRUCTURE_LOD_ZOOM_LOW = 12;
/** The full models come back above the threshold × this factor. */
const LOD_HYSTERESIS = 1.15;

/**
 * Whether structures should use their low-poly models at `zoom`, given
 * whether they do now (hysteresis) and the quality setting.
 */
export function structureLodAt(
  zoom: number,
  current: boolean,
  low: boolean,
): boolean {
  const z = low ? STRUCTURE_LOD_ZOOM_LOW : STRUCTURE_LOD_ZOOM;
  return current ? zoom < z * LOD_HYSTERESIS : zoom < z;
}

/** Level label font size (CSS px): 12 px zoomed out, up to 22 px close up. */
export function levelLabelPx(cssPxPerTile: number): number {
  return Math.round(Math.min(22, Math.max(12, 10 + 0.8 * cssPxPerTile)));
}

/**
 * Stretch of models whose shape does not encode the level: (horizontal,
 * vertical) scale for `level`, capped at MAX_VISUAL_LEVEL.
 */
export function structureLevelScale(
  type: string,
  level: number,
): [number, number] {
  if (levelChangesModel(type)) return [1, 1];
  const lv = Math.max(1, Math.min(MAX_VISUAL_LEVEL, Math.floor(level) || 1));
  return [1 + 0.05 * (lv - 1), 1 + 0.14 * (lv - 1)];
}

/**
 * Scale of a structure under construction `ageMs` after it was first seen:
 * starts at 0.5, grows to 0.75 over CONSTRUCTION_GROW_MS, with a gentle
 * breathing pulse (`tSec` = wall clock).
 */
export function constructionScale(ageMs: number, tSec: number): number {
  const grow = Math.min(1, Math.max(0, ageMs / CONSTRUCTION_GROW_MS));
  return 0.5 + 0.25 * grow + 0.03 * Math.sin(tSec * 4);
}

/**
 * Heading (tile-space radians) from (x, y) towards open water: the sum of
 * the directions of the water tiles on a few rings around the point.
 * Returns 0 when there is no water nearby.
 */
export function waterHeading(hf: HeightField, x: number, y: number): number {
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const r of [2, 4, 6, 9]) {
      if (!isLand(hf.terrainByteAt(x + ca * r, y + sa * r))) {
        sx += ca;
        sy += sa;
      }
    }
  }
  return sx * sx + sy * sy > 1e-6 ? Math.atan2(sy, sx) : 0;
}

/** Rules config values the structure progress bars depend on. */
export interface StructureProgressRules {
  deletionMarkDuration: number;
  samCooldown: number;
  siloCooldown: number;
  constructionDuration(type: string): number;
}

/** Reads `StructureProgressRules` from the game config (BarPass defaults). */
export function structureProgressRules(config: Config): StructureProgressRules {
  const num = (f: () => number, fallback: number): number => {
    try {
      const v = f();
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    deletionMarkDuration: num(() => config.deletionMarkDuration(), 300),
    samCooldown: num(() => config.SAMCooldown(), 90),
    siloCooldown: num(() => config.SiloCooldown(), 90),
    constructionDuration: (type) =>
      num(
        () => config.unitInfo(type as UnitType).constructionDuration ?? 50,
        50,
      ),
  };
}

/**
 * Progress bar value of a structure at `tick`, or null for no bar — the
 * same rules as the default renderer's BarPass, in priority order:
 * deletion countdown (remaining / deletionMarkDuration), construction
 * progress, then missile readiness of silos / SAM launchers (ready missiles
 * plus the reload progress of the others, over `level` slots; no bar when
 * fully ready).
 */
export function structureProgress(
  u: UnitState,
  tick: number,
  rules: StructureProgressRules,
): number | null {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  if (u.markedForDeletion !== false) {
    return clamp01(
      (u.markedForDeletion - tick) / Math.max(1, rules.deletionMarkDuration),
    );
  }
  if (u.underConstruction && u.constructionStartTick !== null) {
    const duration = rules.constructionDuration(u.unitType);
    if (!(duration > 0)) return null;
    return clamp01((tick - u.constructionStartTick) / duration);
  }
  if (u.unitType === UT_MISSILE_SILO || u.unitType === UT_SAM_LAUNCHER) {
    const slots = Math.max(1, u.level);
    const reloading = u.missileTimerQueue.length;
    if (reloading === 0) return null;
    const cooldown =
      u.unitType === UT_SAM_LAUNCHER ? rules.samCooldown : rules.siloCooldown;
    let readiness = (slots - reloading) / slots;
    for (const start of u.missileTimerQueue) {
      readiness += (tick - start) / Math.max(1, cooldown) / slots;
    }
    const r = clamp01(readiness);
    return r < 1 ? r : null;
  }
  return null;
}

interface StructureInst {
  id: number;
  type: string;
  owner: number;
  level: number;
  variant: number;
  underConstruction: boolean;
  marked: boolean;
  /** Progress bar value (null = no bar), refreshed every tick. */
  progress: number | null;
  /** Tile centre. */
  x: number;
  y: number;
  /** World Y of the ground under the footprint. */
  ground: number;
  /** Rotation about +Y (radians). */
  rotY: number;
  /** performance.now() when first seen under construction. */
  ucSinceMs: number;
  stamp: number;
  batch: InstancedBatch | null;
  index: number;
  /** Model height (tiles) at scale 1, for anchoring labels and bars. */
  top: number;
  label: LevelLabel | null;
  /** Inside the view frustum (last visibility pass); culled when false. */
  inView: boolean;
}

/** A pooled DOM level label and what was last written to it. */
interface LevelLabel {
  el: HTMLDivElement;
  text: string;
  fontPx: number;
  x: number;
  y: number;
  shown: boolean;
}

/** Deterministic 32-bit hash of a unit id. */
function hash(id: number): number {
  return Math.imul(id ^ 0x27d4eb2f, 0x165667b1) >>> 0;
}

export class StructureLayer {
  private readonly group = new THREE.Group();
  private readonly glow = { value: 1 };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly templates = new Map<string, THREE.BufferGeometry>();
  private readonly tops = new Map<string, number>();
  private readonly batches = new Map<string, InstancedBatch>();
  /** Triangles of one instance, per batch key. */
  private readonly batchTris = new Map<string, number>();
  /**
   * Batch keys (`type#variant`, `type#variant@lod`), built once: `rebuild`
   * runs whenever the visible set changes (panning close up), so it should
   * not build two strings per structure each time.
   */
  private readonly keys = new Map<string, string[]>();
  private readonly lodKeys = new Map<string, string>();
  /** Low-poly models in use (see the file comment). */
  private lod = false;
  private culled = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly insts = new Map<number, StructureInst>();
  /** Instances that animate every frame (under construction / marked). */
  private animated: StructureInst[] = [];
  private readonly shadows: BlobShadows;
  private readonly bars: StatusBars;
  private readonly rules: StructureProgressRules;
  /** Instances with a progress bar this tick. */
  private barred: StructureInst[] = [];
  private readonly labelRoot: HTMLDivElement;
  private readonly labelPool: LevelLabel[] = [];

  private highlight: ReadonlySet<string> | null = null;
  private highlightDirty = false;
  private stamp = 0;
  private paletteVersion = -1;
  private heightVersion = -1;
  /** Zoom the current matrices were written for. */
  private matrixZoom = 1;
  private lastZoom = 1;
  private lastNowMs = 0;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly v = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly ctx: ThreeLayerContext) {
    this.group.name = "structures";
    ctx.scene.add(this.group);
    this.material = createPartMaterial({
      glow: this.glow,
      roughness: 0.75,
      metalness: 0.04,
    });
    this.shadows = new BlobShadows(this.group, "structure-shadows");
    this.bars = new StatusBars(
      this.group,
      ctx.renderSettings.bar,
      "structure-status-bars",
    );
    this.rules = structureProgressRules(ctx.config);
    ensureOverpassFont();
    this.labelRoot = document.createElement("div");
    this.labelRoot.className = "three-structure-levels";
    const st = this.labelRoot.style;
    st.position = "absolute";
    st.inset = "0";
    st.pointerEvents = "none";
    st.overflow = "hidden";
    ctx.overlayRoot.appendChild(this.labelRoot);
  }

  updateStructures(units: ReadonlyMap<number, UnitState>): void {
    const stamp = ++this.stamp;
    const W = this.ctx.mapWidth;
    const now = performance.now();
    const hf = this.ctx.heightField;
    for (const u of units.values()) {
      if (!u.isActive || !STRUCTURE_TYPES.has(u.unitType)) continue;
      let inst = this.insts.get(u.id);
      if (inst === undefined || inst.type !== u.unitType) {
        const x = (u.pos % W) + 0.5;
        const y = Math.floor(u.pos / W) + 0.5;
        inst = {
          id: u.id,
          type: u.unitType,
          owner: u.ownerID,
          level: u.level,
          variant: 1,
          underConstruction: false,
          marked: false,
          progress: null,
          x,
          y,
          ground: 0,
          rotY: 0,
          ucSinceMs: now,
          stamp,
          batch: null,
          index: -1,
          top: 1,
          label: null,
          inView: true,
        };
        this.place(inst, hf);
        this.insts.set(u.id, inst);
      }
      if (u.underConstruction && !inst.underConstruction) inst.ucSinceMs = now;
      inst.underConstruction = u.underConstruction;
      inst.marked = u.markedForDeletion !== false;
      inst.owner = u.ownerID;
      inst.level = u.level;
      inst.variant = structureVariant(u.unitType, u.level);
      inst.stamp = stamp;
    }
    for (const [id, inst] of this.insts) {
      if (inst.stamp !== stamp) {
        this.releaseLabel(inst);
        this.insts.delete(id);
      }
    }
    this.barred = this.barred.filter((i) => this.insts.get(i.id) === i);
    this.rebuild(now);
  }

  /**
   * Per-tick status: progress bar values, and the deletion mark (which
   * changes without an `updateStructures`).
   */
  updateStatus(units: ReadonlyMap<number, UnitState>, gameTick: number): void {
    const barred: StructureInst[] = [];
    let markChanged = false;
    for (const inst of this.insts.values()) {
      const u = units.get(inst.id);
      if (u === undefined || !u.isActive) {
        inst.progress = null;
        continue;
      }
      const marked = u.markedForDeletion !== false;
      if (marked !== inst.marked) {
        inst.marked = marked;
        markChanged = true;
      }
      inst.progress = structureProgress(u, gameTick, this.rules);
      if (inst.progress !== null) barred.push(inst);
    }
    this.barred = barred;
    if (markChanged) this.rebuild(performance.now());
  }

  setHighlightTypes(types: string[] | null): void {
    this.highlight = types !== null && types.length > 0 ? new Set(types) : null;
    this.highlightDirty = true;
  }

  update(frame: FrameInfo): void {
    const now = frame.nowMs;
    this.lastNowMs = now;
    this.lastZoom = frame.cssPxPerTile;
    this.updateModels(frame);
    this.updateStatusViews(frame);
  }

  /** Counters for the facade's perf tool (picked up by duck typing). */
  perfStats(): Record<string, number> {
    let instances = 0;
    let tris = 0;
    for (const [key, b] of this.batches) {
      instances += b.count;
      tris += b.count * (this.batchTris.get(key) ?? 0);
    }
    return {
      structureInstances: instances,
      structureTriangles: tris,
      structureLod: this.lod ? 1 : 0,
      structureCulled: this.culled,
    };
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    for (const g of this.templates.values()) g.dispose();
    this.templates.clear();
    this.shadows.dispose();
    this.bars.dispose();
    this.material.dispose();
    this.insts.clear();
    this.animated = [];
    this.barred = [];
    this.labelRoot.remove();
    this.labelPool.length = 0;
    this.ctx.scene.remove(this.group);
  }

  // ---- Internals ----

  /** Per-frame model updates (terrain / palette / zoom / animation). */
  private updateModels(frame: FrameInfo): void {
    const now = frame.nowMs;
    const hf = this.ctx.heightField;

    if (hf.version !== this.heightVersion) {
      // Terrain changed (water nuke): re-seat every structure.
      this.heightVersion = hf.version;
      for (const inst of this.insts.values()) this.place(inst, hf);
      this.rebuild(now);
      return;
    }
    const lod = structureLodAt(
      frame.cssPxPerTile,
      this.lod,
      this.ctx.settings.quality === "low",
    );
    const viewChanged = this.updateVisibility(frame);
    if (lod !== this.lod || viewChanged) {
      this.lod = lod;
      this.rebuild(now);
      return;
    }
    if (this.ctx.palette.version !== this.paletteVersion) {
      this.paletteVersion = this.ctx.palette.version;
      for (const inst of this.insts.values()) {
        if (inst.batch !== null) {
          inst.batch.setColor(inst.index, this.colorFor(inst));
        }
      }
      for (const b of this.batches.values()) b.markDirty();
    }

    const zoomChanged =
      Math.abs(frame.cssPxPerTile - this.matrixZoom) >
      ZOOM_EPSILON * this.matrixZoom;
    if (
      this.highlightDirty ||
      (zoomChanged && this.minScaleChanged(frame.cssPxPerTile))
    ) {
      this.highlightDirty = false;
      this.matrixZoom = frame.cssPxPerTile;
      for (const inst of this.insts.values()) this.writeInstance(inst, now);
      for (const b of this.batches.values()) b.markDirty();
      this.writeShadows();
      return;
    }
    if (zoomChanged) this.matrixZoom = frame.cssPxPerTile;

    if (this.animated.length > 0) {
      const touched = new Set<InstancedBatch>();
      for (const inst of this.animated) {
        this.writeInstance(inst, now);
        if (inst.batch !== null) touched.add(inst.batch);
      }
      for (const b of touched) b.markDirty();
    }
  }

  /**
   * Frustum test of every structure (bounding sphere at this frame's
   * min-size scale, plus a 2-tile margin). True when any `inView` changed.
   */
  private updateVisibility(frame: FrameInfo): boolean {
    const cam = frame.camera;
    this.projScreen.multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const minPx = this.ctx.settings.structureMinScreenPx;
    let changed = false;
    let culled = 0;
    for (const inst of this.insts.values()) {
      const fp = STRUCTURE_FOOTPRINT[inst.type] ?? 6;
      const k = minScreenScale(minPx, frame.cssPxPerTile, fp) * 1.2;
      const half = 0.5 * inst.top * k;
      const r = Math.hypot(0.75 * fp * k, half) + 2;
      const inView = sphereInFrustum(
        planes,
        inst.x,
        inst.ground + half,
        inst.y,
        r,
      );
      if (!inView) culled++;
      if (inView !== inst.inView) {
        inst.inView = inView;
        changed = true;
      }
    }
    this.culled = culled;
    return changed;
  }

  /** Progress bars and level labels for this frame's camera. */
  private updateStatusViews(frame: FrameInfo): void {
    const zoom = frame.cssPxPerTile;
    const show = zoom >= STATUS_MIN_ZOOM;
    this.bars.begin(frame, show ? 1 : 0);
    if (show) {
      for (const inst of this.barred) {
        if (inst.progress === null) continue;
        const [k, top] = this.anchor(inst);
        const fpPx = (STRUCTURE_FOOTPRINT[inst.type] ?? 6) * k * zoom;
        const { w, h } = barSize(fpPx, 0.6, 20, 80);
        this.bars.bar(inst.x, top, inst.y, 0, h / 2 + 4, w, h, inst.progress);
      }
    }
    this.bars.end();

    const cam = frame.camera;
    const cw = frame.cssWidth;
    const ch = frame.cssHeight;
    const fontPx = levelLabelPx(zoom);
    for (const inst of this.insts.values()) {
      const label = inst.label;
      if (inst.level <= 1 || !show) {
        if (label !== null) this.setLabelShown(label, false);
        continue;
      }
      const [, top] = this.anchor(inst);
      const ndc = this.v.set(inst.x, top, inst.y).project(cam);
      const visible =
        ndc.z < 1 && Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05;
      if (!visible) {
        if (label !== null) this.setLabelShown(label, false);
        continue;
      }
      const l = label ?? this.acquireLabel(inst);
      const text = String(inst.level);
      if (l.text !== text) {
        l.text = text;
        l.el.textContent = text;
      }
      if (l.fontPx !== fontPx) {
        l.fontPx = fontPx;
        l.el.style.fontSize = `${fontPx}px`;
      }
      // Above the model, above the bar when there is one.
      const lift = inst.progress !== null ? Math.round(fontPx * 0.5) + 8 : 3;
      const x = Math.round(((ndc.x + 1) / 2) * cw);
      const y = Math.round(((1 - ndc.y) / 2) * ch) - lift;
      if (x !== l.x || y !== l.y) {
        l.x = x;
        l.y = y;
        l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      }
      this.setLabelShown(l, true);
    }
  }

  /** Scale and world Y of the top of `inst`'s model this frame. */
  private anchor(inst: StructureInst): [number, number] {
    const base = minScreenScale(
      this.ctx.settings.structureMinScreenPx,
      this.lastZoom,
      STRUCTURE_FOOTPRINT[inst.type] ?? 6,
    );
    let k = base;
    if (inst.underConstruction) {
      k *= constructionScale(
        this.lastNowMs - inst.ucSinceMs,
        this.lastNowMs / 1000,
      );
    }
    const [, ly] = structureLevelScale(inst.type, inst.level);
    return [k, inst.ground + inst.top * k * ly];
  }

  private acquireLabel(inst: StructureInst): LevelLabel {
    let l = this.labelPool.pop();
    if (l === undefined) {
      const el = document.createElement("div");
      const st = el.style;
      st.position = "absolute";
      st.left = "0";
      st.top = "0";
      st.fontFamily = LABEL_FONT_FAMILY;
      st.fontWeight = "700";
      st.lineHeight = "1.1";
      st.color = "#fff";
      st.background = "rgba(14, 16, 22, 0.78)";
      st.borderRadius = "0.4em";
      st.padding = "0.1em 0.35em 0.02em";
      st.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.45)";
      st.whiteSpace = "nowrap";
      st.pointerEvents = "none";
      st.userSelect = "none";
      st.willChange = "transform";
      st.display = "none";
      this.labelRoot.appendChild(el);
      l = { el, text: "", fontPx: 0, x: NaN, y: NaN, shown: false };
    }
    inst.label = l;
    return l;
  }

  private releaseLabel(inst: StructureInst): void {
    if (inst.label === null) return;
    this.setLabelShown(inst.label, false);
    this.labelPool.push(inst.label);
    inst.label = null;
  }

  private setLabelShown(l: LevelLabel, on: boolean): void {
    if (l.shown === on) return;
    l.shown = on;
    l.el.style.display = on ? "block" : "none";
  }

  /** Ground height (highest point under the footprint) and orientation. */
  private place(inst: StructureInst, hf: HeightField): void {
    const r = (STRUCTURE_FOOTPRINT[inst.type] ?? 6) * 0.3;
    let ground = hf.surfaceAt(inst.x, inst.y);
    for (const [dx, dy] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      ground = Math.max(ground, hf.surfaceAt(inst.x + dx, inst.y + dy));
    }
    inst.ground = ground;
    // Model +X maps to tile heading h with rotY = −h (three's Y rotation
    // turns +X towards −Z, i.e. north).
    inst.rotY =
      inst.type === UT_PORT
        ? -waterHeading(hf, inst.x, inst.y)
        : ((hash(inst.id) & 3) * Math.PI) / 2;
  }

  /** Re-assigns every instance to its batch slot and writes all data. */
  private rebuild(now: number): void {
    this.lastNowMs = now;
    this.matrixZoom = this.lastZoom;
    this.paletteVersion = this.ctx.palette.version;
    this.heightVersion = this.ctx.heightField.version;
    this.highlightDirty = false;
    for (const b of this.batches.values()) b.begin();
    this.animated = [];
    for (const inst of this.insts.values()) {
      const key = this.keyOf(inst.type, inst.variant);
      inst.top = this.topOf(key, inst.type, inst.variant);
      const batch = inst.inView
        ? this.batchFor(key, inst.type, inst.variant, this.lod)
        : null;
      inst.batch = batch;
      if (batch === null) {
        inst.index = -1;
        continue;
      }
      this.computeMatrix(inst, now);
      inst.index = batch.push(
        this.m,
        this.colorFor(inst),
        this.shadeFor(inst, now),
      );
      if (inst.underConstruction || inst.marked) this.animated.push(inst);
    }
    for (const b of this.batches.values()) b.end();
    this.writeShadows();
  }

  /** One soft shadow per structure, shifted away from the sun. */
  private writeShadows(): void {
    const sh = this.shadows;
    sh.begin();
    for (const inst of this.insts.values()) {
      if (inst.batch === null) continue;
      const base = minScreenScale(
        this.ctx.settings.structureMinScreenPx,
        this.matrixZoom,
        STRUCTURE_FOOTPRINT[inst.type] ?? 6,
      );
      const size = (STRUCTURE_FOOTPRINT[inst.type] ?? 6) * base * SHADOW_SIZE;
      const [ox, oz] = shadowOffset(0.3 * inst.top * base);
      sh.push(
        inst.x + ox,
        inst.ground + SHADOW_LIFT,
        inst.y + oz,
        size,
        size,
        inst.rotY,
        SHADOW_ALPHA,
      );
    }
    sh.end();
  }

  private writeInstance(inst: StructureInst, now: number): void {
    if (inst.batch === null) return;
    this.computeMatrix(inst, now);
    inst.batch.setMatrix(inst.index, this.m);
    inst.batch.setShade(inst.index, this.shadeFor(inst, now));
  }

  /** True when the min-size boost differs between matrixZoom and `zoom`. */
  private minScaleChanged(zoom: number): boolean {
    const minPx = this.ctx.settings.structureMinScreenPx;
    for (const fp of Object.values(STRUCTURE_FOOTPRINT)) {
      if (
        minScreenScale(minPx, zoom, fp) !==
        minScreenScale(minPx, this.matrixZoom, fp)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Instance matrix of `inst` into `this.m`. */
  private computeMatrix(inst: StructureInst, now: number): void {
    const base = minScreenScale(
      this.ctx.settings.structureMinScreenPx,
      this.matrixZoom,
      STRUCTURE_FOOTPRINT[inst.type] ?? 6,
    );
    const [lx, ly] = structureLevelScale(inst.type, inst.level);
    let k = base;
    if (this.highlight?.has(inst.type)) k *= 1.2;
    if (inst.underConstruction) {
      k *= constructionScale(now - inst.ucSinceMs, now / 1000);
    }
    this.p.set(inst.x, inst.ground, inst.y);
    this.q.setFromAxisAngle(this.up, inst.rotY);
    this.s.set(k * lx, k * ly, k * lx);
    this.m.compose(this.p, this.q, this.s);
  }

  /** Owner colour; grey while under construction, red when marked. */
  private colorFor(inst: StructureInst): THREE.Color {
    if (inst.marked)
      return this.c.setRGB(0.92, 0.16, 0.13, THREE.SRGBColorSpace);
    if (inst.underConstruction) {
      return this.c.setRGB(0.78, 0.78, 0.78, THREE.SRGBColorSpace);
    }
    return setOwnerColor(this.c, this.ctx.palette.data, inst.owner, 0.05);
  }

  /** Brightness: highlight / dimming, marked-for-deletion blink. */
  private shadeFor(inst: StructureInst, now: number): number {
    let shade = 1;
    if (this.highlight !== null) {
      shade = this.highlight.has(inst.type) ? 1.45 : 0.45;
    }
    if (inst.marked) {
      shade *= 0.8 + 0.35 * (0.5 + 0.5 * Math.sin((now / 1000) * 6));
    } else if (inst.underConstruction) {
      shade *= 0.92;
    }
    return shade;
  }

  /** The batch key `type#variant`, cached. */
  private keyOf(type: string, variant: number): string {
    let byVariant = this.keys.get(type);
    if (byVariant === undefined) {
      byVariant = [];
      this.keys.set(type, byVariant);
    }
    return (byVariant[variant] ??= `${type}#${variant}`);
  }

  /** Model geometry of a full (`key`) or low-poly (`key@lod`) batch. */
  private templateFor(
    key: string,
    type: string,
    variant: number,
    lod: boolean,
  ): THREE.BufferGeometry | null {
    const tkey = lod ? `${key}@lod` : key;
    let template = this.templates.get(tkey);
    if (template === undefined) {
      const g = lod
        ? createStructureLodGeometry(type, variant)
        : createStructureGeometry(type, variant);
      if (g === null) return null;
      template = g;
      this.templates.set(tkey, template);
      if (!lod) {
        g.computeBoundingBox();
        this.tops.set(key, Math.max(0.5, g.boundingBox?.max.y ?? 1));
      }
    }
    return template;
  }

  /** Height of the full model (labels and bars anchor on it at any LOD). */
  private topOf(key: string, type: string, variant: number): number {
    if (!this.tops.has(key)) this.templateFor(key, type, variant, false);
    return this.tops.get(key) ?? 1;
  }

  private batchFor(
    key: string,
    type: string,
    variant: number,
    lod: boolean,
  ): InstancedBatch | null {
    let bkey = key;
    if (lod) {
      let k = this.lodKeys.get(key);
      if (k === undefined) {
        k = `${key}@lod`;
        this.lodKeys.set(key, k);
      }
      bkey = k;
    }
    let batch = this.batches.get(bkey);
    if (batch !== undefined) return batch;
    const template = this.templateFor(key, type, variant, lod);
    if (template === null) return null;
    batch = new InstancedBatch(
      this.group,
      template,
      this.material,
      `structures-${bkey}`,
      32,
    );
    this.batches.set(bkey, batch);
    this.batchTris.set(bkey, triangleCount(template));
    return batch;
  }
}
