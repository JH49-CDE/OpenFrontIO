/**
 * StructureLayer — instanced structures (City, Port, Factory, Defense Post,
 * SAM Launcher, Missile Silo) standing on the relief.
 *
 * One `InstancedBatch` per model variant (cities, SAM launchers and silos
 * change shape with level — see `structureVariant`). Instance data (position,
 * owner colour, state) is rebuilt only in `updateStructures`, which the
 * facade calls on ticks where a structure changed. Per frame the layer only
 * rewrites matrices when something visual moves: the zoom-dependent minimum
 * size, the build-menu highlight, structures under construction (grey,
 * small, slowly growing / pulsing) and structures marked for deletion (red,
 * blinking).
 *
 * Contract notes:
 * - `updateStructures` gets the FULL unit map, only on ticks where a
 *   structure changed (new, owner, level, isActive, construction finished).
 *   A change of `markedForDeletion` alone does not trigger it upstream, so
 *   the red tint can lag until the next structure change (same as the
 *   default renderer).
 * - `setHighlightTypes(null)` clears the build-menu type highlight.
 */

import * as THREE from "three";
import { STRUCTURE_TYPES, UT_PORT, type UnitState } from "../types";
import type { HeightField } from "./HeightField";
import {
  createPartMaterial,
  createStructureGeometry,
  InstancedBatch,
  levelChangesModel,
  MAX_VISUAL_LEVEL,
  setOwnerColor,
  STRUCTURE_FOOTPRINT,
  structureVariant,
} from "./ProceduralMeshes";
import { isLand } from "./TerrainCodec";
import type { FrameInfo, ThreeLayerContext } from "./types";
import { minScreenScale } from "./UnitLayer";

/** Time over which a structure under construction grows to its full ghost size. */
const CONSTRUCTION_GROW_MS = 6000;
/** Relative zoom change that triggers a rewrite of the min-size scale. */
const ZOOM_EPSILON = 0.002;

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

interface StructureInst {
  id: number;
  type: string;
  owner: number;
  level: number;
  variant: number;
  underConstruction: boolean;
  marked: boolean;
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
}

/** Deterministic 32-bit hash of a unit id. */
function hash(id: number): number {
  return Math.imul(id ^ 0x27d4eb2f, 0x165667b1) >>> 0;
}

export class StructureLayer {
  private readonly group = new THREE.Group();
  private readonly glow = { value: 1.5 };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly templates = new Map<string, THREE.BufferGeometry>();
  private readonly batches = new Map<string, InstancedBatch>();
  private readonly insts = new Map<number, StructureInst>();
  /** Instances that animate every frame (under construction / marked). */
  private animated: StructureInst[] = [];

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
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly ctx: ThreeLayerContext) {
    this.group.name = "structures";
    ctx.scene.add(this.group);
    this.material = createPartMaterial({
      glow: this.glow,
      roughness: 0.75,
      metalness: 0.04,
    });
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
          x,
          y,
          ground: 0,
          rotY: 0,
          ucSinceMs: now,
          stamp,
          batch: null,
          index: -1,
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
      if (inst.stamp !== stamp) this.insts.delete(id);
    }
    this.rebuild(now);
  }

  setHighlightTypes(types: string[] | null): void {
    this.highlight = types !== null && types.length > 0 ? new Set(types) : null;
    this.highlightDirty = true;
  }

  update(frame: FrameInfo): void {
    const now = frame.nowMs;
    this.lastNowMs = now;
    this.lastZoom = frame.cssPxPerTile;
    const hf = this.ctx.heightField;

    if (hf.version !== this.heightVersion) {
      // Terrain changed (water nuke): re-seat every structure.
      this.heightVersion = hf.version;
      for (const inst of this.insts.values()) this.place(inst, hf);
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

  dispose(): void {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    for (const g of this.templates.values()) g.dispose();
    this.templates.clear();
    this.material.dispose();
    this.insts.clear();
    this.animated = [];
    this.ctx.scene.remove(this.group);
  }

  // ---- Internals ----

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
      const batch = this.batchFor(inst.type, inst.variant);
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

  private batchFor(type: string, variant: number): InstancedBatch | null {
    const key = `${type}#${variant}`;
    let batch = this.batches.get(key);
    if (batch !== undefined) return batch;
    let template = this.templates.get(key);
    if (template === undefined) {
      const g = createStructureGeometry(type, variant);
      if (g === null) return null;
      template = g;
      this.templates.set(key, template);
    }
    batch = new InstancedBatch(
      this.group,
      template,
      this.material,
      `structures-${key}`,
      32,
    );
    this.batches.set(key, batch);
    return batch;
  }
}
