import type { Config } from "@openfront/engine-lib/configuration/Config";
/**
 * Structure icons at distance (`StructureIcons.ts`) and their crossfade
 * with the 3D models in `StructureLayer`: atlas mapping, the default
 * renderer's icon sizes and colours, fade weights with hysteresis, models
 * skipped below the band, level badges anchored on the icons, and the
 * triangle count of a late-game population at full-map zoom.
 */
import fs from "fs";
import path from "path";
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  createStructureLodGeometry,
  structureVariant,
  triangleCount,
} from "../../../src/client/render/three/ProceduralMeshes";
import {
  defaultIconScale,
  ICON_ATLAS_ORDER,
  ICON_FADE_BAND,
  ICON_FADE_BAND_LOW,
  ICON_FADE_FROM,
  iconAlphaAt,
  iconAtlasColumn,
  iconFadeBand,
  iconGlyphsAt,
  modelFadeScale,
  modelWeightAt,
  structureIconColors,
  structureIconCssPx,
  structureModelsAt,
  unitAffiliationRgb,
} from "../../../src/client/render/three/StructureIcons";
import {
  STRUCTURE_LOD_ZOOM,
  StructureLayer,
} from "../../../src/client/render/three/StructureLayer";
import { countTriangles } from "../../../src/client/render/three/ThreePerf";
import {
  defaultThreeSettings,
  type ThreeRenderSettings,
} from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import * as T from "../../../src/client/render/types";
import type { UnitState } from "../../../src/client/render/types";
import { lateGameStructures, makeSetContext, setFrame } from "./structureSet";

const ss = createRenderSettings().structure;
const aff = createRenderSettings().affiliation;

const W = 64;
const H = 64;

/** West half sea, east half low land; owners 1 and 2 with fill and border. */
function makeContext(
  settings: Partial<ThreeRenderSettings> = {},
): ThreeLayerContext {
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = W / 2; x < W; x++) terrain[y * W + x] = 0x80 | 4;
  }
  const palette = new Float32Array(4096 * 2 * 4);
  palette.set([0.9, 0.2, 0.2, 1], 1 * 4);
  palette.set([0.2, 0.4, 0.9, 1], 2 * 4);
  palette.set([0.5, 0.1, 0.1, 1], 4096 * 4 + 1 * 4);
  palette.set([0.1, 0.2, 0.5, 1], 4096 * 4 + 2 * 4);
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField: new HeightField(W, H, terrain, {
      heightScale: 6,
      seabedDepth: 3,
      targetVertices: 10_000,
    }),
    palette: new PaletteView(palette),
    settings: { ...defaultThreeSettings(), ...settings },
    renderSettings: createRenderSettings(),
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
}

/** Top-down camera over the 64×64 map, 800×600 CSS px canvas. */
function frame(
  nowMs: number,
  cssPxPerTile: number,
  over: Partial<FrameInfo> = {},
): FrameInfo {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 1, 10_000);
  const focal = 600 / (2 * Math.tan(Math.PI / 6));
  cam.position.set(W / 2, focal / cssPxPerTile, H / 2);
  cam.rotation.set(-Math.PI / 2, 0, 0, "YXZ");
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: cam,
    cssPxPerTile,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView: false,
    ...over,
  };
}

const ref = (x: number, y: number) => y * W + x;

function unit(over: Partial<UnitState> & { id: number }): UnitState {
  return {
    unitType: "City",
    ownerID: 1,
    lastOwnerID: null,
    pos: ref(40, 32),
    lastPos: ref(40, 32),
    isActive: true,
    reachedTarget: false,
    retreating: false,
    targetable: true,
    waitTicks: 0,
    markedForDeletion: false,
    health: null,
    underConstruction: false,
    targetUnitId: null,
    targetTile: null,
    troops: 0,
    missileTimerQueue: [],
    level: 1,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
    ...over,
  };
}

const unitMap = (...us: UnitState[]) => new Map(us.map((u) => [u.id, u]));

/** City (owner 1, level 3), port (owner 2), factory under construction, silo marked, a warship. */
const mixed = () =>
  unitMap(
    unit({ id: 1, unitType: "City", pos: ref(40, 20), level: 3 }),
    unit({ id: 2, unitType: "Port", ownerID: 2, pos: ref(33, 30) }),
    unit({
      id: 3,
      unitType: "Factory",
      pos: ref(50, 40),
      underConstruction: true,
    }),
    unit({
      id: 4,
      unitType: "Missile Silo",
      ownerID: 2,
      pos: ref(56, 50),
      markedForDeletion: 1200,
    }),
    unit({ id: 5, unitType: "Warship", pos: ref(10, 10) }),
  );

function iconMesh(ctx: ThreeLayerContext): THREE.Mesh {
  const m = ctx.scene.getObjectByName("structure-icons");
  if (!(m instanceof THREE.Mesh)) throw new Error("no icon mesh");
  return m;
}

function iconAttr(ctx: ThreeLayerContext, name: string): Float32Array {
  const g = iconMesh(ctx).geometry as THREE.InstancedBufferGeometry;
  return (g.getAttribute(name) as THREE.InstancedBufferAttribute)
    .array as Float32Array;
}

function iconUniform<V>(ctx: ThreeLayerContext, name: string): V {
  const mat = iconMesh(ctx).material as THREE.ShaderMaterial;
  return mat.uniforms[name].value as V;
}

/** Scale (x) of instance `i` of the named instanced mesh. */
function instanceScaleX(
  ctx: ThreeLayerContext,
  name: string,
  i = 0,
): number | null {
  const mesh = ctx.scene.getObjectByName(name);
  if (!(mesh instanceof THREE.InstancedMesh) || mesh.count <= i) return null;
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const s = new THREE.Vector3();
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  return s.x;
}

/** Visible level labels (DOM badges). */
function shownLabels(ctx: ThreeLayerContext): HTMLElement[] {
  return [
    ...ctx.overlayRoot.querySelectorAll<HTMLElement>(
      ".three-structure-levels > div",
    ),
  ].filter((e) => e.style.display !== "none");
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

function layerFor(ctx: ThreeLayerContext): StructureLayer {
  const layer = new StructureLayer(ctx);
  disposers.push(() => layer.dispose());
  return layer;
}

describe("structure icon atlas", () => {
  it("uses StructurePass's column order", () => {
    // The order the default renderer's atlas was generated in.
    const src = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../src/client/render/gl/passes/StructurePass.ts",
      ),
      "utf8",
    );
    const body = /const STRUCTURE_ORDER = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
    const names = body
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const order = names.map((n) => (T as Record<string, unknown>)[n]);
    expect(order).toEqual([...ICON_ATLAS_ORDER]);
    expect(ICON_ATLAS_ORDER.map(iconAtlasColumn)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(iconAtlasColumn("Missile Silo")).toBe(5);
    expect(iconAtlasColumn("Defense Post")).toBe(3);
    expect(iconAtlasColumn("Warship")).toBe(-1);
  });

  it("matches the atlas image: one square cell per type", () => {
    const png = fs.readFileSync(
      path.resolve(__dirname, "../../../resources/atlases/icon-atlas.png"),
    );
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(height * ICON_ATLAS_ORDER.length);
  });
});

describe("structure icon size (default renderer parity)", () => {
  it("follows StructurePass's dots / icon / grow zooms in device px", () => {
    expect(defaultIconScale(1, ss)).toBe(ss.dotScale);
    expect(defaultIconScale(1.8, ss)).toBeCloseTo(1.8 / 3);
    expect(defaultIconScale(5, ss)).toBe(1);
    expect(defaultIconScale(14, ss)).toBeCloseTo(2);
    expect(iconGlyphsAt(1.2, ss)).toBe(false);
    expect(iconGlyphsAt(1.3, ss)).toBe(true);
  });

  it("converts to CSS px with the device pixel ratio", () => {
    // Full map, default and band zooms on a 1x screen: 18 / 36 / 60 px.
    expect(structureIconCssPx("City", 0.7, 1, ss)).toBeCloseTo(18);
    expect(structureIconCssPx("City", 1.8, 1, ss)).toBeCloseTo(36);
    expect(structureIconCssPx("City", 4, 1, ss)).toBeCloseTo(60);
    // Per-type shape scale (silo 1.55).
    expect(structureIconCssPx("Missile Silo", 4, 1, ss)).toBeCloseTo(
      60 * ss.shapes["Missile Silo"].scale,
    );
    // 2x screen: the default renderer's zoom is in device px, so 0.7 CSS
    // px per tile is 1.4 device px (icons, not dots) and the result halves.
    expect(structureIconCssPx("City", 0.7, 2, ss)).toBeCloseTo(
      (60 * 1.4) / 3 / 2,
    );
  });
});

describe("icon ↔ model fade", () => {
  it("weights the models with a smoothstep across the band", () => {
    const b = ICON_FADE_BAND;
    expect(b).toEqual({ start: 2.5, end: STRUCTURE_LOD_ZOOM });
    expect(modelWeightAt(1, b)).toBe(0);
    expect(modelWeightAt(2.5, b)).toBe(0);
    expect(modelWeightAt(3.75, b)).toBeCloseTo(0.5);
    expect(modelWeightAt(5, b)).toBe(1);
    expect(modelWeightAt(20, b)).toBe(1);
    let prev = -1;
    for (let z = 2; z <= 6; z += 0.05) {
      const w = modelWeightAt(z, b);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
    // Low quality keeps the icons longer.
    expect(iconFadeBand(true)).toBe(ICON_FADE_BAND_LOW);
    expect(ICON_FADE_BAND_LOW.start).toBeGreaterThan(b.start);
    expect(ICON_FADE_BAND_LOW.end).toBeGreaterThan(b.end);
  });

  it("switches the models on at the band start, off 10% below (hysteresis)", () => {
    const b = ICON_FADE_BAND;
    expect(structureModelsAt(2.4, false, b)).toBe(false);
    expect(structureModelsAt(2.5, false, b)).toBe(true);
    expect(structureModelsAt(2.4, true, b)).toBe(true);
    expect(structureModelsAt(2.2, true, b)).toBe(false);
  });

  it("keeps the icons opaque over the first half of the band", () => {
    // The models are still small there: the icons carry type and owner.
    for (const w of [0, 0.25, ICON_FADE_FROM]) expect(iconAlphaAt(w)).toBe(1);
    expect(iconAlphaAt(1)).toBe(0);
    let prev = 1;
    for (let w = 0; w <= 1.0001; w += 0.01) {
      const a = iconAlphaAt(w);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      expect(Math.abs(a - prev)).toBeLessThan(0.04);
      prev = a;
    }
    // At 4 px per tile (w ≈ 0.65 in the default band) the icons are still
    // mostly opaque; at 4.5 (w ≈ 0.9) they are nearly gone.
    const b = ICON_FADE_BAND;
    expect(iconAlphaAt(modelWeightAt(4, b))).toBeGreaterThan(0.75);
    expect(iconAlphaAt(modelWeightAt(4.5, b))).toBeLessThan(0.2);
  });

  it("grows the models out of the ground", () => {
    expect(modelFadeScale(1)).toEqual([1, 1]);
    const [x0, y0] = modelFadeScale(0);
    expect(x0).toBeGreaterThan(0);
    expect(y0).toBeLessThan(x0);
    expect(modelFadeScale(0.5)[0]).toBeGreaterThan(x0);
  });
});

describe("structure icon colours", () => {
  const palette = new Float32Array(4096 * 2 * 4);
  palette.set([0.9, 0.2, 0.2], 3 * 4);
  palette.set([0.4, 0.1, 0.1], 4096 * 4 + 3 * 4);

  it("tints the fill and ring like structure.frag.glsl", () => {
    const c = structureIconColors(
      {
        palette,
        owner: 3,
        localPlayerID: 1,
        underConstruction: false,
        affiliation: null,
      },
      ss,
    );
    expect(c.fill[0]).toBeCloseTo(0.9 * ss.fillDarken);
    expect(c.fill[1]).toBeCloseTo(0.2 * ss.fillDarken);
    expect(c.border[0]).toBeCloseTo(0.4 * ss.borderDarken);
    // The local player's ring uses the territory colour.
    const own = structureIconColors(
      {
        palette,
        owner: 3,
        localPlayerID: 3,
        underConstruction: false,
        affiliation: null,
      },
      ss,
    );
    expect(own.border[0]).toBeCloseTo(0.9 * ss.borderDarken);
    // Under construction: the default's fixed greys, whatever the owner.
    const uc = structureIconColors(
      {
        palette,
        owner: 3,
        localPlayerID: 1,
        underConstruction: true,
        affiliation: [0, 1, 0],
      },
      ss,
    );
    expect(uc.fill).toEqual([198 / 255, 198 / 255, 198 / 255]);
    expect(uc.border).toEqual([127 / 255, 127 / 255, 127 / 255]);
    // Alt view: affiliation colour, darkened the same way.
    const alt = structureIconColors(
      {
        palette,
        owner: 3,
        localPlayerID: 1,
        underConstruction: false,
        affiliation: [0.2, 0.8, 0.4],
      },
      ss,
    );
    expect(alt.fill[1]).toBeCloseTo(0.8 * ss.fillDarken);
    expect(alt.border[1]).toBeCloseTo(0.8 * ss.borderDarken);
  });

  it("picks the default renderer's unit affiliation colours", () => {
    const size = 4;
    const rel = new Uint8Array(size * size);
    rel[1 * size + 2] = 1; // 1 → 2 friendly
    rel[1 * size + 3] = 2; // 1 → 3 embargo
    expect(unitAffiliationRgb(1, 1, rel, size, aff)).toEqual([
      aff.selfR,
      aff.selfG,
      aff.selfB,
    ]);
    expect(unitAffiliationRgb(2, 1, rel, size, aff)).toEqual([
      aff.allyR,
      aff.allyG,
      aff.allyB,
    ]);
    const enemy = [aff.enemyR, aff.enemyG, aff.enemyB];
    expect(unitAffiliationRgb(3, 1, rel, size, aff)).toEqual(enemy);
    // Neutral reads as enemy for units; so does everyone without relations
    // or for a spectator.
    rel[1 * size + 3] = 0;
    expect(unitAffiliationRgb(3, 1, rel, size, aff)).toEqual(enemy);
    expect(unitAffiliationRgb(2, 1, null, 0, aff)).toEqual(enemy);
    expect(unitAffiliationRgb(2, 0, rel, size, aff)).toEqual(enemy);
  });
});

describe("StructureLayer icons", () => {
  it("draws icons only below the band, both inside it, models only above", () => {
    const ctx = makeContext();
    const layer = layerFor(ctx);
    layer.updateStructures(mixed());

    // Default zoom: one icon per structure, no model, no shadow.
    layer.update(frame(0, 1.8));
    let s = layer.perfStats();
    expect(s.structureInstances).toBe(0);
    expect(s.modelInstancesDrawn).toBe(0);
    expect(s.iconInstances).toBe(4);
    expect(s.iconDrawCalls).toBe(1);
    expect(s.fadeBandInstances).toBe(0);
    expect(iconMesh(ctx).visible).toBe(true);
    expect(iconUniform<number>(ctx, "uAlpha")).toBe(ss.iconAlpha);
    const sizes = iconUniform<Float32Array>(ctx, "uSizePx");
    expect(sizes[0]).toBeCloseTo(structureIconCssPx("City", 1.8, 1, ss));
    expect(sizes[5]).toBeCloseTo(
      structureIconCssPx("Missile Silo", 1.8, 1, ss),
    );
    const shadows = ctx.scene.getObjectByName(
      "structure-shadows",
    ) as THREE.InstancedMesh;
    expect(shadows.count).toBe(0);

    // Instance data: type column, deletion mark, anchored on the relief.
    const meta = iconAttr(ctx, "aMeta");
    const anchor = iconAttr(ctx, "aAnchor");
    const cols = [0, 1, 2, 3].map((i) => meta[i * 2]);
    expect(cols).toEqual([0, 1, 2, 5]);
    expect([0, 1, 2, 3].map((i) => meta[i * 2 + 1])).toEqual([0, 0, 0, 1]);
    expect(anchor[0]).toBeCloseTo(40.5);
    expect(anchor[2]).toBeCloseTo(20.5);
    expect(anchor[1]).toBeCloseTo(ctx.heightField.surfaceAt(40.5, 20.5), 0);
    expect(anchor[1]).toBeGreaterThan(0);

    // Middle of the band: both, the icons still opaque (they fade over the
    // second half) and shrinking towards the models, which grow out of the
    // ground.
    layer.update(frame(16, 3.75));
    s = layer.perfStats();
    expect(s.modelWeight).toBeCloseTo(0.5);
    expect(s.structureInstances).toBe(4);
    expect(s.structureLod).toBe(1);
    expect(s.iconInstances).toBe(4);
    expect(s.fadeBandInstances).toBe(4);
    expect(iconUniform<number>(ctx, "uAlpha")).toBeCloseTo(
      iconAlphaAt(0.5) * ss.iconAlpha,
    );
    expect(s.iconAlpha).toBe(1);
    expect(sizes[0]).toBeLessThan(structureIconCssPx("City", 3.75, 1, ss));
    const midScale = instanceScaleX(ctx, "structures-City#3@lod");
    expect(midScale).not.toBeNull();
    expect(midScale!).toBeCloseTo(modelFadeScale(0.5)[0]);
    expect(shadows.count).toBe(4);

    // Close up: models only.
    layer.update(frame(32, 8));
    s = layer.perfStats();
    expect(s.modelWeight).toBe(1);
    expect(s.iconInstances).toBe(0);
    expect(s.iconDrawCalls).toBe(0);
    expect(iconMesh(ctx).visible).toBe(false);
    expect(instanceScaleX(ctx, "structures-City#3")).toBeCloseTo(1);
  });

  it("keeps the models through small zoom wobbles at the band start", () => {
    const ctx = makeContext();
    const layer = layerFor(ctx);
    layer.updateStructures(mixed());
    layer.update(frame(0, 2.4));
    expect(layer.perfStats().structureInstances).toBe(0);
    layer.update(frame(16, 2.6));
    expect(layer.perfStats().structureInstances).toBe(4);
    layer.update(frame(32, 2.4));
    expect(layer.perfStats().structureInstances).toBe(4);
    layer.update(frame(48, 2.1));
    expect(layer.perfStats().structureInstances).toBe(0);
    // Low quality: still icons only at 3 px per tile.
    const lowCtx = makeContext({ quality: "low" });
    const low = layerFor(lowCtx);
    low.updateStructures(mixed());
    low.update(frame(0, 3));
    expect(low.perfStats().structureInstances).toBe(0);
    expect(low.perfStats().iconInstances).toBe(4);
    low.update(frame(16, 6));
    expect(low.perfStats().iconInstances).toBe(4);
    low.update(frame(32, 7.5));
    expect(low.perfStats().iconInstances).toBe(0);
  });

  it("fades without popping while zooming through the band", () => {
    const ctx = makeContext();
    const layer = layerFor(ctx);
    layer.updateStructures(
      unitMap(unit({ id: 1, unitType: "City", pos: ref(40, 32) })),
    );
    let prevAlpha = NaN;
    let prevSize = NaN;
    let prevModel = 0;
    let t = 0;
    for (let z = 1.5; z <= 6.5; z += 0.01) {
      layer.update(frame((t += 16), z));
      const alpha = iconMesh(ctx).visible
        ? iconUniform<number>(ctx, "uAlpha")
        : 0;
      const size = iconUniform<Float32Array>(ctx, "uSizePx")[0];
      // On-screen model size: low-poly or full batch, whichever is drawn.
      const k =
        instanceScaleX(ctx, "structures-City#1@lod") ??
        instanceScaleX(ctx, "structures-City#1") ??
        0;
      const modelPx = k * z;
      if (!Number.isNaN(prevAlpha)) {
        expect(Math.abs(alpha - prevAlpha)).toBeLessThan(0.02);
        expect(Math.abs(size - prevSize)).toBeLessThan(0.5);
        // The model appears at its smallest under an opaque icon.
        if (prevModel === 0 && modelPx > 0) expect(prevAlpha).toBe(1);
        else expect(Math.abs(modelPx - prevModel)).toBeLessThan(0.5);
      }
      prevAlpha = alpha;
      prevSize = size;
      prevModel = modelPx;
    }
    expect(prevAlpha).toBe(0);
    expect(prevModel).toBeGreaterThan(0);
  });

  it("recolours icons and models for the alt view and relations", () => {
    const ctx = makeContext();
    const layer = layerFor(ctx);
    layer.updateStructures(mixed());
    layer.update(frame(0, 1.8));
    const fill = iconAttr(ctx, "aFill");
    const border = iconAttr(ctx, "aBorder");
    // City of owner 1 (the local player): territory fill and ring.
    expect(fill[0]).toBeCloseTo(0.9 * ss.fillDarken);
    expect(border[0]).toBeCloseTo(0.9 * ss.borderDarken);
    // Port of owner 2: its border colour as ring.
    expect(border[3 + 2]).toBeCloseTo(0.5 * ss.borderDarken);
    // Factory under construction: grey.
    expect(fill[6]).toBeCloseTo(198 / 255);

    // Alt view: self / enemy, then ally once relations say so.
    layer.update(frame(16, 1.8, { altView: true }));
    expect(fill[0]).toBeCloseTo(aff.selfR * ss.fillDarken);
    expect(fill[3]).toBeCloseTo(aff.enemyR * ss.fillDarken);
    const rel = new Uint8Array(9);
    rel[1 * 3 + 2] = 1;
    layer.setRelations(rel, 3);
    layer.update(frame(32, 1.8, { altView: true }));
    expect(fill[3]).toBeCloseTo(aff.allyR * ss.fillDarken);
    expect(fill[4]).toBeCloseTo(aff.allyG * ss.fillDarken);
    // Construction stays grey in the alt view.
    expect(fill[6]).toBeCloseTo(198 / 255);

    // The models follow the alt view too.
    layer.update(frame(48, 8, { altView: true }));
    const port = ctx.scene.getObjectByName(
      "structures-Port#1",
    ) as THREE.InstancedMesh;
    const c = new THREE.Color();
    port.getColorAt(0, c);
    const ally = new THREE.Color().setRGB(
      aff.allyR + (1 - aff.allyR) * 0.05,
      aff.allyG + (1 - aff.allyG) * 0.05,
      aff.allyB + (1 - aff.allyB) * 0.05,
      THREE.SRGBColorSpace,
    );
    expect(c.r).toBeCloseTo(ally.r);
    expect(c.g).toBeCloseTo(ally.g);
    layer.update(frame(64, 8));
    port.getColorAt(0, c);
    expect(c.b).toBeGreaterThan(c.r);

    // A palette change reaches the icons.
    const next = new Float32Array(ctx.palette.data);
    next.set([0.1, 0.9, 0.1], 1 * 4);
    ctx.palette.update(next);
    layer.update(frame(80, 1.8));
    expect(fill[1]).toBeCloseTo(0.9 * ss.fillDarken);
  });

  it("highlights the build-menu types", () => {
    const ctx = makeContext();
    const layer = layerFor(ctx);
    layer.updateStructures(mixed());
    layer.setHighlightTypes(["Port", "Missile Silo"]);
    layer.update(frame(0, 1.8));
    expect(iconUniform<number>(ctx, "uHighlightMask")).toBe(
      (1 << 1) | (1 << 5),
    );
    layer.setHighlightTypes(null);
    layer.update(frame(16, 1.8));
    expect(iconUniform<number>(ctx, "uHighlightMask")).toBe(0);
  });

  it("draws the build ghost as a tinted icon while icons show", () => {
    const ctx = makeContext();
    const layer = layerFor(ctx);
    layer.updateStructures(mixed());
    const ghostMesh = () => {
      const m = ctx.scene.getObjectByName("structure-ghost-icon");
      if (!(m instanceof THREE.Mesh)) throw new Error("no ghost mesh");
      return m as THREE.Mesh<
        THREE.InstancedBufferGeometry,
        THREE.ShaderMaterial
      >;
    };
    const ghost = {
      ghostType: "SAM Launcher",
      tileX: 20,
      tileY: 30,
      radiusTileX: 20,
      radiusTileY: 30,
      canBuild: true,
      canUpgrade: false,
      cost: 0,
      showCost: false,
      canAfford: true,
      ghostRailPaths: [],
      overlappingRailroads: [],
      ownerID: 3,
      upgradeTargetTile: null,
      rangeRadius: 0,
      rangeWarning: false,
    };
    // No ghost: nothing drawn.
    layer.update(frame(0, 1.8));
    expect(ghostMesh().visible).toBe(false);
    expect(layer.perfStats().ghostIcons).toBe(0);
    // A SAM ghost at 1.8: one untinted half-transparent SAM icon there.
    layer.setGhostPreview(ghost);
    layer.update(frame(16, 1.8));
    const m = ghostMesh();
    expect(m.visible).toBe(true);
    expect(m.geometry.instanceCount).toBe(1);
    const meta = m.geometry.getAttribute("aMeta").array as Float32Array;
    expect(meta[0]).toBe(iconAtlasColumn("SAM Launcher"));
    const anchor = m.geometry.getAttribute("aAnchor").array as Float32Array;
    expect([anchor[0], anchor[2]]).toEqual([20.5, 30.5]);
    const u = m.material.uniforms;
    expect(u.uGhostAlpha.value).toBe(0.5);
    expect((u.uTint.value as THREE.Vector3).toArray()).toEqual([0, 0, 0]);
    // The regular icons keep their look.
    expect(iconUniform<number>(ctx, "uGhostAlpha")).toBe(1);
    // Cannot build: red tint; upgrading: green, plus the upgraded structure.
    layer.setGhostPreview({ ...ghost, canBuild: false });
    layer.update(frame(32, 1.8));
    expect((u.uTint.value as THREE.Vector3).toArray()).toEqual([0.8, 0.2, 0.2]);
    layer.setGhostPreview({
      ...ghost,
      canUpgrade: true,
      upgradeTargetTile: ref(10, 12),
    });
    layer.update(frame(48, 1.8));
    expect((u.uTint.value as THREE.Vector3).toArray()).toEqual([0, 0.8, 0]);
    expect(m.geometry.instanceCount).toBe(2);
    expect(layer.perfStats().ghostIcons).toBe(2);
    // Crossfades with the icons: gone once only the models show.
    layer.update(frame(64, 8));
    expect(m.visible).toBe(false);
    // Non-structure ghosts (nukes, warships) have no icon.
    layer.setGhostPreview({ ...ghost, ghostType: "Atom Bomb" });
    layer.update(frame(80, 1.8));
    expect(m.visible).toBe(false);
    layer.setGhostPreview(null);
    layer.update(frame(96, 1.8));
    expect(m.visible).toBe(false);
  });

  it("anchors level badges above the icons, once per structure", () => {
    const ctx = makeContext();
    const layer = layerFor(ctx);
    const units = unitMap(
      unit({ id: 1, unitType: "City", pos: ref(40, 32), level: 3 }),
      unit({ id: 2, unitType: "Factory", pos: ref(50, 20), level: 2 }),
      unit({ id: 3, unitType: "Port", pos: ref(33, 40), level: 1 }),
    );
    layer.updateStructures(units);
    const f = frame(0, 1.8);
    layer.update(f);
    const labels = shownLabels(ctx);
    expect(labels.map((e) => e.textContent).sort()).toEqual(["2", "3"]);
    // The city badge sits above the top of its icon.
    const ndc = new THREE.Vector3(
      40.5,
      ctx.heightField.surfaceAt(40.5, 32.5),
      32.5,
    ).project(f.camera);
    const centreY = ((1 - ndc.y) / 2) * f.cssHeight;
    const iconHalf = 0.45 * structureIconCssPx("City", 1.8, 1, ss);
    const city = labels.find((e) => e.textContent === "3")!;
    const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(city.style.transform);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBeLessThanOrEqual(centreY - iconHalf);
    // Dots zoom (no glyphs): no badge, like the default renderer.
    layer.update(frame(16, 1));
    expect(shownLabels(ctx)).toHaveLength(0);
    // Close up: still one badge each, now above the models.
    layer.update(frame(32, 8));
    expect(shownLabels(ctx)).toHaveLength(2);
  });

  it("removes the icon mesh on dispose", () => {
    const ctx = makeContext();
    const layer = new StructureLayer(ctx);
    layer.updateStructures(mixed());
    layer.update(frame(0, 1.8));
    expect(ctx.scene.getObjectByName("structure-icons")).toBeDefined();
    layer.dispose();
    expect(ctx.scene.getObjectByName("structure-icons")).toBeUndefined();
  });
});

describe("StructureLayer cost on a late-game population", () => {
  it("draws ~400 structures as one icon draw at full-map and default zoom", () => {
    const ctx = makeSetContext();
    const layer = layerFor(ctx);
    const units = lateGameStructures(400);
    layer.updateStructures(units);
    const group = ctx.scene.getObjectByName("structures")!;
    // Before: every structure as a low-poly model plus a 2-triangle shadow.
    let before = 0;
    for (const u of units.values()) {
      const g = createStructureLodGeometry(
        u.unitType,
        structureVariant(u.unitType, u.level),
      )!;
      before += triangleCount(g) + 2;
      g.dispose();
    }
    const at = (z: number, t: number) => {
      layer.update(setFrame(t, z));
      layer.update(setFrame(t + 16, z));
      return countTriangles([group]);
    };
    const full = at(0.7, 0);
    expect(full.triangles).toBe(2 * 400);
    expect(full.meshes).toBe(1);
    expect(full.triangles * 20).toBeLessThan(before);
    const def = at(1.8, 100);
    expect(def.triangles).toBe(2 * 400);
    expect(def.meshes).toBe(1);
    // In the band: icons plus the low-poly models in view.
    const band = at(3.5, 200);
    const s = layer.perfStats();
    expect(s.iconInstances).toBe(400);
    expect(s.structureLod).toBe(1);
    expect(s.structureInstances).toBeGreaterThan(0);
    expect(band.triangles).toBe(
      800 + s.structureTriangles + 2 * s.structureInstances,
    );
    // Close up: models only.
    at(8, 300);
    expect(layer.perfStats().iconInstances).toBe(0);
    expect(layer.perfStats().iconDrawCalls).toBe(0);
  });
});
