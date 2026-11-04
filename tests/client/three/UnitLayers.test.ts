/**
 * Headless integration of UnitLayer / StructureLayer / OverlayLayer: a fake
 * layer context (no WebGL — nothing is rendered) driven through sim ticks and
 * frames, checking the instance data the layers produce.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import {
  OverlayLayer,
  telegraphColors,
} from "../../../src/client/render/three/OverlayLayer";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  createUnitGeometry,
  triangleCount,
  UnitMesh,
} from "../../../src/client/render/three/ProceduralMeshes";
import {
  levelLabelPx,
  StructureLayer,
  structureLodAt,
  structureProgress,
  type StructureProgressRules,
} from "../../../src/client/render/three/StructureLayer";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import {
  healthBarValue,
  nukeArcHeight,
  railHalfDirections,
  UnitLayer,
} from "../../../src/client/render/three/UnitLayer";
import type { UnitState } from "../../../src/client/render/types";

const W = 64;
const H = 64;

/** The rules the status bars read (Config's warship / structure values). */
const rulesConfig = {
  msPerTick: () => 100,
  unitInfo: (type: string) =>
    type === "Warship"
      ? { maxHealth: 1000, constructionDuration: 50 }
      : { constructionDuration: 50 },
  warshipVeterancyHealthBonus: () => 10,
  deletionMarkDuration: () => 300,
  SAMCooldown: () => 90,
  SiloCooldown: () => 90,
} as unknown as Config;

/** West half sea, east half low land (magnitude 4). */
function makeContext(config?: Config): ThreeLayerContext {
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = W / 2; x < W; x++) terrain[y * W + x] = 0x80 | 4;
  }
  const palette = new Float32Array(4096 * 2 * 4);
  palette.set([0.9, 0.2, 0.2, 1], 1 * 4);
  palette.set([0.2, 0.4, 0.9, 1], 2 * 4);
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
    settings: defaultThreeSettings(),
    renderSettings: createRenderSettings(),
    config: config ?? ({ msPerTick: () => 100 } as unknown as Config),
    overlayRoot: document.createElement("div"),
  };
}

/**
 * A camera looking straight down (north up) at the map centre from the
 * height where the ground is drawn at `cssPxPerTile` CSS px per tile on the
 * 800×600 canvas of `frame` — the whole 64×64 map is in view from 8 px per
 * tile down.
 */
function topDownCamera(
  cssPxPerTile: number,
  cx = W / 2,
  cz = H / 2,
): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 1, 10_000);
  const focal = 600 / (2 * Math.tan(Math.PI / 6));
  cam.position.set(cx, focal / cssPxPerTile, cz);
  cam.rotation.set(-Math.PI / 2, 0, 0, "YXZ");
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

function frame(nowMs: number, tickAlpha: number, cssPxPerTile = 4): FrameInfo {
  return {
    nowMs,
    dtMs: 16,
    tickAlpha,
    camera: topDownCamera(cssPxPerTile),
    cssPxPerTile,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView: false,
  };
}

const ref = (x: number, y: number) => y * W + x;

function unit(over: Partial<UnitState> & { id: number }): UnitState {
  return {
    unitType: "Warship",
    ownerID: 1,
    lastOwnerID: null,
    pos: ref(10, 10),
    lastPos: ref(10, 10),
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

function instanced(ctx: ThreeLayerContext, name: string): THREE.InstancedMesh {
  const obj = ctx.scene.getObjectByName(name);
  if (!(obj instanceof THREE.InstancedMesh)) {
    throw new Error(`no instanced mesh ${name}`);
  }
  return obj;
}

function instancePosition(mesh: THREE.InstancedMesh, i = 0): THREE.Vector3 {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  return new THREE.Vector3().setFromMatrixPosition(m);
}

function instanceScale(mesh: THREE.InstancedMesh, i = 0): THREE.Vector3 {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  return s;
}

/** Instances drawn by a StatusBars mesh (an InstancedBufferGeometry). */
function barInstances(ctx: ThreeLayerContext, name: string): number {
  const mesh = ctx.scene.getObjectByName(name) as THREE.Mesh | undefined;
  if (mesh === undefined || !mesh.visible) return 0;
  return (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
}

/** A camera looking straight down at the whole 64×64 test map. */
function topDownFrame(nowMs: number, cssPxPerTile: number): FrameInfo {
  return frame(nowMs, 1, cssPxPerTile);
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

describe("UnitLayer", () => {
  it("interpolates between ticks without replaying stale lastPos", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());

    // Tick 1: first sighting, moved 9 → 10 (from rest: smoothstep).
    layer.updateUnits(
      unitMap(unit({ id: 1, pos: ref(10, 10), lastPos: ref(9, 10) })),
      1,
    );
    layer.update(frame(0, 0.5));
    const mesh = instanced(ctx, "units-warship");
    expect(mesh.count).toBe(1);
    expect(instancePosition(mesh).x).toBeCloseTo(10.0); // 9.5 → 10.5, half
    expect(instancePosition(mesh).z).toBeCloseTo(10.5);
    layer.update(frame(50, 1));
    expect(instancePosition(mesh).x).toBeCloseTo(10.5);

    // Tick 2: keeps moving → linear interpolation.
    layer.updateUnits(
      unitMap(unit({ id: 1, pos: ref(11, 10), lastPos: ref(10, 10) })),
      2,
    );
    layer.update(frame(100, 0.25));
    expect(instancePosition(mesh).x).toBeCloseTo(10.75);
    layer.update(frame(190, 1));

    // Tick 3: no update for the unit (stale lastPos ≠ pos): stays put.
    layer.updateUnits(
      unitMap(unit({ id: 1, pos: ref(11, 10), lastPos: ref(10, 10) })),
      3,
    );
    layer.update(frame(200, 0));
    expect(instancePosition(mesh).x).toBeCloseTo(11.5);

    // Boats float near sea level.
    expect(Math.abs(instancePosition(mesh).y)).toBeLessThan(0.2);

    // Gone from the map → no instance.
    layer.updateUnits(new Map(), 4);
    layer.update(frame(300, 0));
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
  });

  it("skips inactive, queued and structure units", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.updateUnits(
      unitMap(
        unit({ id: 1, isActive: false }),
        unit({ id: 2, unitType: "Atom Bomb", waitTicks: 3 }),
        unit({ id: 3, unitType: "City" }),
        unit({ id: 4, unitType: "Transport" }),
      ),
      1,
    );
    layer.update(frame(0, 1, 8));
    expect(ctx.scene.getObjectByName("units-warship")).toBeUndefined();
    expect(ctx.scene.getObjectByName("units-atomBomb")).toBeUndefined();
    expect(instanced(ctx, "units-transport").count).toBe(1);
  });

  it("flies nukes on an arc with a trail, and draws selection rings", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    const target = ref(54, 30);
    // Launch at (4, 30).
    layer.updateUnits(
      unitMap(
        unit({
          id: 7,
          unitType: "Atom Bomb",
          pos: ref(4, 30),
          lastPos: ref(4, 30),
          targetTile: target,
        }),
      ),
      1,
    );
    layer.update(frame(0, 1));
    const mesh = instanced(ctx, "units-atomBomb");
    expect(instancePosition(mesh).y).toBeLessThan(3);

    // Halfway (25 tiles from both ends): at the apex.
    layer.updateUnits(
      unitMap(
        unit({
          id: 7,
          unitType: "Atom Bomb",
          pos: ref(29, 30),
          lastPos: ref(28, 30),
          targetTile: target,
        }),
      ),
      2,
    );
    for (let t = 100; t <= 300; t += 50) layer.update(frame(t, 1));
    const apex = instancePosition(mesh);
    expect(apex.x).toBeCloseTo(29.5);
    expect(apex.y).toBeGreaterThan(nukeArcHeight(50) - 1);
    const trail = ctx.scene.getObjectByName("unit-trails") as THREE.Mesh;
    expect(trail.visible).toBe(true);

    // Selection ring under a selected warship.
    layer.updateUnits(
      unitMap(
        unit({
          id: 7,
          unitType: "Atom Bomb",
          pos: ref(30, 30),
          lastPos: ref(29, 30),
          targetTile: target,
        }),
        unit({ id: 8, pos: ref(5, 5) }),
      ),
      3,
    );
    layer.setSelectedUnits([8]);
    layer.update(frame(400, 1));
    expect(instanced(ctx, "unit-selection").count).toBe(1);
    layer.setSelectedUnits([]);
    layer.update(frame(420, 1));
    expect(instanced(ctx, "unit-selection").count).toBe(0);
  });

  it("enforces the minimum on-screen size when zoomed out", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.updateUnits(unitMap(unit({ id: 1, unitType: "Transport" })), 1);
    layer.update(frame(0, 1, 8));
    const mesh = instanced(ctx, "units-transport");
    expect(instanceScale(mesh).y).toBeCloseTo(1);
    layer.update(frame(16, 1, 0.5));
    // 10 px / (0.5 px/tile × 5 tiles) = ×4 — on the low-poly model, since
    // the boat is now only 10 px long.
    expect(mesh.count).toBe(0);
    const lod = instanced(ctx, "units-transport-lod");
    expect(lod.count).toBe(1);
    expect(instanceScale(lod).y).toBeCloseTo(4);
  });

  it("culls units outside the view and keeps their trails going", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.updateUnits(
      unitMap(
        unit({ id: 1, pos: ref(5, 5) }),
        unit({ id: 2, pos: ref(60, 60) }),
        unit({
          id: 3,
          unitType: "Atom Bomb",
          pos: ref(58, 58),
          lastPos: ref(57, 58),
          targetTile: ref(62, 62),
        }),
      ),
      1,
    );
    // Zoomed in on the north-west corner: 16 px per tile, ±25 × 19 tiles.
    const f = { ...frame(0, 1, 16), camera: topDownCamera(16, 10, 10) };
    layer.update(f);
    expect(instanced(ctx, "units-warship").count).toBe(1);
    expect(instancePosition(instanced(ctx, "units-warship")).x).toBeCloseTo(
      5.5,
    );
    expect(ctx.scene.getObjectByName("units-atomBomb")).toBeUndefined();
    expect(instanced(ctx, "unit-shadows").count).toBe(1);
    // The off-screen nuke still lays its trail.
    const trail = ctx.scene.getObjectByName("unit-trails") as THREE.Mesh;
    layer.update({ ...f, nowMs: 100 });
    expect(trail.visible).toBe(true);
    const stats = layer.perfStats();
    expect(stats.unitInstances).toBe(1);
    expect(stats.unitCulled).toBe(2);
    // The whole map in view: all three drawn.
    layer.update(frame(200, 1, 4));
    expect(layer.perfStats().unitCulled).toBe(0);
    expect(layer.perfStats().unitInstances).toBe(3);
  });

  it("switches small boats and trains to low-poly models, earlier in low quality", () => {
    const ships = () =>
      unitMap(
        unit({ id: 1, unitType: "Trade Ship", pos: ref(10, 10) }),
        unit({ id: 2, unitType: "Trade Ship", pos: ref(20, 10) }),
        unit({ id: 3, unitType: "Atom Bomb", pos: ref(30, 30) }),
      );
    const run = (quality: "high" | "low", zoom: number) => {
      const ctx = makeContext();
      if (quality === "low") ctx.settings.quality = "low";
      const layer = new UnitLayer(ctx);
      disposers.push(() => layer.dispose());
      layer.updateUnits(ships(), 1);
      layer.update(frame(0, 1, zoom));
      return layer.perfStats();
    };
    // 5.5-tile ships: 44 px at 8 px per tile → full models (240 triangles).
    const close = run("high", 8);
    expect(close.unitLodInstances).toBe(0);
    // 22 px at 4 px per tile → low-poly; the nuke has no LOD model.
    const far = run("high", 4);
    expect(far.unitLodInstances).toBe(2);
    const bomb = triangleCount(createUnitGeometry(UnitMesh.AtomBomb));
    expect(far.unitTriangles - bomb).toBeLessThan(
      (close.unitTriangles - bomb) / 5,
    );
    // Low quality: still low-poly at 44 px.
    expect(run("low", 8).unitLodInstances).toBe(2);
  });
});

describe("UnitLayer status, shadows and rails", () => {
  it("shows damaged warships' health and veterancy like BarPass", () => {
    const rules = { baseMaxHealth: 1000, veterancyBonusPercent: 10 };
    expect(healthBarValue(null, 0, rules)).toBeNull();
    expect(healthBarValue(1000, 0, rules)).toBeNull(); // full: no bar
    expect(healthBarValue(500, 0, rules)).toBeCloseTo(0.5, 12);
    // Veterancy raises the max (1000 + 20%): 1100 is no longer full.
    expect(healthBarValue(1100, 2, rules)).toBeCloseTo(1100 / 1200, 12);
    expect(healthBarValue(500, 0, { ...rules, baseMaxHealth: 0 })).toBeNull();
  });

  it("draws bars, pips, contact shadows and rails", () => {
    const ctx = makeContext(rulesConfig);
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.updateUnits(
      unitMap(
        unit({ id: 1, pos: ref(10, 10), health: 500, veterancy: 2 }),
        unit({ id: 2, pos: ref(10, 30), health: 1000 }),
        unit({ id: 3, unitType: "Transport", pos: ref(20, 20) }),
        unit({ id: 4, unitType: "Train", trainType: 0, pos: ref(40, 20) }),
        unit({ id: 5, unitType: "Atom Bomb", pos: ref(45, 40) }),
      ),
      1,
    );
    layer.update(frame(0, 1, 4));
    // One health bar + two veterancy pips; the healthy warship has none.
    expect(barInstances(ctx, "unit-status-bars")).toBe(3);
    // Boats and trains stand on shadows; the airborne nuke has none.
    expect(instanced(ctx, "unit-shadows").count).toBe(4);
    // Zoomed far out the bars fade away.
    layer.update(frame(16, 1, 0.5));
    expect(barInstances(ctx, "unit-status-bars")).toBe(0);

    // Rails: a straight N-S tile and a curve, two half-tracks each, as
    // strips (each block's slot keeps some slack: zero matrices).
    const rails = new Uint8Array(W * H);
    rails[ref(40, 20)] = 1;
    rails[ref(41, 20)] = 6;
    layer.setRailroads(rails);
    layer.update(frame(2000, 1, 4));
    expect(layer.perfStats().railPieces).toBe(4);
    const strips = instanced(ctx, "rails");
    expect(strips.count).toBeGreaterThanOrEqual(4);
    expect(instancePosition(strips, 0).x).toBeCloseTo(40.5);
    const slack = new THREE.Matrix4();
    strips.getMatrixAt(4, slack);
    expect(slack.elements.every((v) => v === 0)).toBe(true);
    // Trains ride on top of the rails, above the ground (a 10 px train is
    // drawn with its low-poly model).
    const train = instanced(ctx, "units-trainEngine-lod");
    expect(instancePosition(train).y).toBeGreaterThan(
      ctx.heightField.surfaceAt(40.5, 20.5),
    );
    // Close up the rails get sleepers and steel.
    layer.update(frame(2016, 1, 12));
    expect(instanced(ctx, "rails-detail").count).toBe(4);
    const stats = layer.perfStats();
    expect(stats.railDetailPieces).toBe(4);
    expect(stats.railTriangles).toBe(strips.count * 2 + 4 * 16);
    expect(stats.railJsMsMax).toBeGreaterThanOrEqual(stats.railJsMs);
  });

  it("maps railroad codes to the edges they join", () => {
    const deg = (code: number) =>
      railHalfDirections(code).map((a) => Math.round((a * 180) / Math.PI));
    expect(deg(1)).toEqual([-90, 90]); // vertical: north + south
    expect(deg(2)).toEqual([0, 180]); // horizontal: east + west
    expect(deg(3)).toEqual([-90, 180]); // top-left: north + west
    expect(deg(4)).toEqual([-90, 0]);
    expect(deg(5)).toEqual([90, 180]);
    expect(deg(6)).toEqual([90, 0]);
    expect(railHalfDirections(0)).toEqual([]);
    expect(railHalfDirections(7)).toEqual([]);
  });
});

describe("StructureLayer", () => {
  it("instances structures per model with state-dependent scale", () => {
    const ctx = makeContext();
    const layer = new StructureLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.update(frame(0, 1, 8));
    layer.updateStructures(
      unitMap(
        unit({ id: 1, unitType: "City", pos: ref(45, 20), level: 3 }),
        unit({ id: 2, unitType: "City", pos: ref(50, 40), level: 3 }),
        unit({ id: 3, unitType: "Port", pos: ref(33, 30) }),
        unit({
          id: 4,
          unitType: "Factory",
          pos: ref(45, 50),
          underConstruction: true,
        }),
        unit({ id: 5, unitType: "Transport", pos: ref(10, 10) }),
        unit({ id: 6, unitType: "Defense Post", isActive: false }),
      ),
    );
    expect(instanced(ctx, "structures-City#3").count).toBe(2);
    expect(instanced(ctx, "structures-Port#1").count).toBe(1);
    expect(ctx.scene.getObjectByName("structures-Defense Post#1")).toBe(
      undefined,
    );
    // On land, above sea level.
    const city = instanced(ctx, "structures-City#3");
    expect(instancePosition(city).y).toBeGreaterThan(0);
    // Ports face the water (west): model +X turned towards −X.
    const port = instanced(ctx, "structures-Port#1");
    const m = new THREE.Matrix4();
    port.getMatrixAt(0, m);
    const fwd = new THREE.Vector3(1, 0, 0).transformDirection(m);
    expect(fwd.x).toBeLessThan(-0.9);
    // Under construction: smaller than full size.
    const factory = instanced(ctx, "structures-Factory#1");
    layer.update(frame(16, 1, 8));
    expect(instanceScale(factory).x).toBeLessThan(0.8);

    // Highlight scales matching types up on the next frame.
    const before = instanceScale(city).x;
    layer.setHighlightTypes(["City"]);
    layer.update(frame(32, 1, 8));
    expect(instanceScale(city).x).toBeCloseTo(before * 1.2);
    layer.setHighlightTypes(null);
    layer.update(frame(48, 1, 8));
    expect(instanceScale(city).x).toBeCloseTo(before);

    // Destroyed / removed structures disappear.
    layer.updateStructures(unitMap());
    expect(city.count).toBe(0);
  });

  it("switches to low-poly models when zoomed out (earlier in low quality)", () => {
    expect(structureLodAt(4.9, false, false)).toBe(true);
    expect(structureLodAt(5.2, false, false)).toBe(false);
    // Hysteresis: back to full models only 15% above the threshold.
    expect(structureLodAt(5.2, true, false)).toBe(true);
    expect(structureLodAt(5.8, true, false)).toBe(false);
    expect(structureLodAt(8, false, true)).toBe(true);

    const ctx = makeContext();
    const layer = new StructureLayer(ctx);
    disposers.push(() => layer.dispose());
    const cities = unitMap(
      unit({ id: 1, unitType: "City", pos: ref(45, 20), level: 3 }),
      unit({ id: 2, unitType: "City", pos: ref(50, 40), level: 3 }),
    );
    layer.update(frame(0, 1, 8));
    layer.updateStructures(cities);
    const full = layer.perfStats();
    expect(full.structureLod).toBe(0);
    expect(full.structureInstances).toBe(2);
    const fullCity = instanced(ctx, "structures-City#3");
    const fullScale = instanceScale(fullCity).x;
    // Inside the icon fade band (2.5-5 px per tile): low-poly models,
    // still growing out of the ground under the fading icons.
    layer.update(frame(16, 1, 3));
    const far = layer.perfStats();
    expect(far.structureLod).toBe(1);
    expect(fullCity.count).toBe(0);
    const lodCity = instanced(ctx, "structures-City#3@lod");
    expect(lodCity.count).toBe(2);
    expect(far.structureTriangles * 3).toBeLessThan(full.structureTriangles);
    expect(instanceScale(lodCity).x).toBeLessThan(fullScale);
    // Below the band: icons only, no model at all.
    layer.update(frame(24, 1, 1));
    expect(layer.perfStats().structureInstances).toBe(0);
    expect(lodCity.count).toBe(0);
    layer.update(frame(32, 1, 8));
    expect(layer.perfStats().structureLod).toBe(0);
    expect(fullCity.count).toBe(2);
  });

  it("culls structures outside the view", () => {
    const ctx = makeContext();
    const layer = new StructureLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.update(frame(0, 1, 8));
    layer.updateStructures(
      unitMap(
        unit({ id: 1, unitType: "City", pos: ref(36, 8), level: 3 }),
        unit({ id: 2, unitType: "City", pos: ref(56, 56), level: 3 }),
        unit({ id: 3, unitType: "Factory", pos: ref(40, 10) }),
      ),
    );
    // Zoomed in on the north: the south-east city is out of view.
    const near = { ...frame(16, 1, 30), camera: topDownCamera(30, 38, 9) };
    layer.update(near);
    const stats = layer.perfStats();
    expect(stats.structureCulled).toBe(1);
    expect(stats.structureInstances).toBe(2);
    expect(instanced(ctx, "structures-City#3").count).toBe(1);
    expect(instancePosition(instanced(ctx, "structures-City#3")).x).toBeCloseTo(
      36.5,
    );
    expect(instanced(ctx, "structure-shadows").count).toBe(2);
    // The same view next frame: nothing to rebuild, same draw.
    layer.update({ ...near, nowMs: 32 });
    expect(layer.perfStats().structureInstances).toBe(2);
    // Whole map in view again.
    layer.update(frame(48, 1, 8));
    expect(layer.perfStats().structureCulled).toBe(0);
    expect(instanced(ctx, "structures-City#3").count).toBe(2);
  });
});

describe("StructureLayer status", () => {
  const rules: StructureProgressRules = {
    deletionMarkDuration: 300,
    samCooldown: 90,
    siloCooldown: 90,
    constructionDuration: () => 50,
  };

  it("computes BarPass's progress values", () => {
    const tick = 1000;
    expect(
      structureProgress(unit({ id: 1, unitType: "City" }), tick, rules),
    ).toBeNull();
    // Deletion countdown wins over everything else.
    expect(
      structureProgress(
        unit({ id: 1, unitType: "City", markedForDeletion: 1150 }),
        tick,
        rules,
      ),
    ).toBeCloseTo(0.5, 12);
    expect(
      structureProgress(
        unit({
          id: 1,
          unitType: "City",
          underConstruction: true,
          constructionStartTick: 980,
        }),
        tick,
        rules,
      ),
    ).toBeCloseTo(0.4, 12);
    // Silo with 2 slots, one reloading for 45 of 90 ticks: (1 + 0.5) / 2.
    expect(
      structureProgress(
        unit({
          id: 1,
          unitType: "Missile Silo",
          level: 2,
          missileTimerQueue: [955],
        }),
        tick,
        rules,
      ),
    ).toBeCloseTo(0.75, 12);
    // Fully reloaded → no bar.
    expect(
      structureProgress(
        unit({ id: 1, unitType: "SAM Launcher", missileTimerQueue: [800] }),
        tick,
        rules,
      ),
    ).toBeNull();
  });

  it("draws progress bars, level labels and shadows", () => {
    const ctx = makeContext(rulesConfig);
    const layer = new StructureLayer(ctx);
    disposers.push(() => layer.dispose());
    const units = unitMap(
      unit({ id: 1, unitType: "City", pos: ref(45, 20), level: 3 }),
      unit({
        id: 2,
        unitType: "Factory",
        pos: ref(50, 40),
        markedForDeletion: 1100,
      }),
      unit({
        id: 3,
        unitType: "Missile Silo",
        pos: ref(40, 50),
        level: 2,
        missileTimerQueue: [990],
      }),
      unit({ id: 4, unitType: "Defense Post", pos: ref(55, 10) }),
    );
    layer.updateStructures(units);
    layer.updateStatus(units, 1000);
    layer.update(topDownFrame(0, 8));
    expect(barInstances(ctx, "structure-status-bars")).toBe(2);
    expect(instanced(ctx, "structure-shadows").count).toBe(4);
    const shown = () =>
      [
        ...ctx.overlayRoot.querySelectorAll<HTMLElement>(
          ".three-structure-levels > div",
        ),
      ].filter((e) => e.style.display !== "none");
    expect(
      shown()
        .map((e) => e.textContent)
        .sort(),
    ).toEqual(["2", "3"]);
    expect(shown()[0].style.fontSize).toBe(`${levelLabelPx(8)}px`);

    // A deletion mark set without updateStructures is picked up per tick.
    const marked = new Map(units);
    marked.set(1, { ...units.get(1)!, markedForDeletion: 1200 });
    layer.updateStatus(marked, 1001);
    layer.update(topDownFrame(16, 8));
    expect(barInstances(ctx, "structure-status-bars")).toBe(3);

    // Zoomed out below the icon threshold: no bars, no labels.
    layer.update(topDownFrame(32, 1));
    expect(barInstances(ctx, "structure-status-bars")).toBe(0);
    expect(shown()).toHaveLength(0);

    layer.dispose();
    disposers.length = 0;
    expect(ctx.overlayRoot.querySelector(".three-structure-levels")).toBeNull();
  });

  it("sizes level labels with the zoom", () => {
    expect(levelLabelPx(1)).toBe(12);
    expect(levelLabelPx(8)).toBeGreaterThan(levelLabelPx(3));
    expect(levelLabelPx(40)).toBe(22);
  });
});

describe("OverlayLayer", () => {
  it("colours telegraphs like the default renderer (self / ally / enemy)", () => {
    const [self, ally, enemy] = telegraphColors(
      createRenderSettings().nukeTelegraph,
    );
    expect(self).toEqual([0, 1, 0]);
    expect(ally[0]).toBeCloseTo(1, 6);
    expect(ally[1]).toBeCloseTo(1, 6);
    expect(enemy).toEqual([1, 0, 0]);
  });

  it("builds telegraphs, trajectory, ghost and one-shot markers", () => {
    const ctx = makeContext();
    const layer = new OverlayLayer(ctx);
    disposers.push(() => layer.dispose());

    layer.updateNukeTelegraphs([
      { x: 40, y: 30, innerRadius: 12, outerRadius: 30, relation: 2 },
      { x: 20, y: 20, innerRadius: 0, outerRadius: 0, relation: 0 },
    ]);
    const tele = ctx.scene.getObjectByName("nuke-telegraphs") as THREE.Mesh;
    expect(tele.visible).toBe(true);
    expect(tele.geometry.drawRange.count).toBeGreaterThan(0);
    // Draped above the surface everywhere.
    const pos = tele.geometry.getAttribute("position");
    for (let i = 0; i < 50; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      expect(pos.getY(i)).toBeGreaterThan(
        ctx.heightField.surfaceAt(x, z) + 0.1,
      );
    }
    layer.updateNukeTelegraphs([]);
    expect(tele.visible).toBe(false);

    layer.updateNukeTrajectory({
      p0x: 50,
      p0y: 30,
      p1x: 40,
      p1y: 10,
      p2x: 20,
      p2y: 10,
      p3x: 10,
      p3y: 30,
      tUntargetableStart: 0.3,
      tUntargetableEnd: 0.6,
      tSamIntercept: 0.8,
    });
    const arc = ctx.scene.getObjectByName("trajectory") as LineSegments2;
    const dashed = ctx.scene.getObjectByName(
      "trajectory-untargetable",
    ) as LineSegments2;
    expect(arc.visible).toBe(true);
    expect(dashed.visible).toBe(true);
    layer.updateNukeTrajectory(null);
    expect(arc.visible).toBe(false);

    layer.updateGhostPreview({
      ghostType: "City",
      tileX: 45,
      tileY: 20,
      radiusTileX: 45,
      radiusTileY: 20,
      canBuild: true,
      canUpgrade: false,
      cost: 0,
      showCost: false,
      canAfford: true,
      ghostRailPaths: [],
      overlappingRailroads: [],
      ownerID: 1,
      upgradeTargetTile: null,
      rangeRadius: 25,
      rangeWarning: false,
    });
    const ghost = ctx.scene.getObjectByName("ghost-structure") as THREE.Mesh;
    expect(ghost.visible).toBe(true);
    expect(
      (ctx.scene.getObjectByName("ghost-range") as THREE.Mesh).visible,
    ).toBe(true);

    layer.showMoveIndicator(10, 10, 1);
    layer.triggerBlockedFlash(12, 12);
    layer.updateAttackRings([{ x: 5, y: 5, unitId: 3 }]);
    layer.update(frame(performance.now(), 1));
    const markers = () =>
      ctx.scene.children
        .flatMap((c) => c.children)
        .filter((o) => o.name === "overlay-marker" && o.visible).length;
    // Footprint ring + move chevrons + blocked X + attack ring.
    expect(markers()).toBe(4);
    // While structures show as icons (1 px per tile) the ghost is an icon
    // (StructureLayer); the model grows in with the structures' crossfade.
    layer.update(frame(performance.now(), 1, 1));
    expect(ghost.visible).toBe(false);
    layer.update(frame(performance.now(), 1, 4));
    expect(ghost.visible).toBe(true);
    expect(ghost.scale.x).toBeGreaterThan(ghost.scale.y);
    layer.update(frame(performance.now(), 1, 8));
    expect(ghost.visible).toBe(true);
    expect(ghost.scale.x).toBeCloseTo(ghost.scale.y);
    layer.updateGhostPreview(null);
    expect(ghost.visible).toBe(false);
    layer.update(frame(performance.now() + 5000, 1));
    // Everything one-shot has expired; the attack ring is still wanted.
    expect(markers()).toBe(1);
    layer.updateAttackRings([]);
    layer.update(frame(performance.now() + 10_000, 1));
    expect(markers()).toBe(0);
  });
});
