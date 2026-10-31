/**
 * Headless integration of UnitLayer / StructureLayer / OverlayLayer: a fake
 * layer context (no WebGL — nothing is rendered) driven through sim ticks and
 * frames, checking the instance data the layers produce.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { OverlayLayer } from "../../../src/client/render/three/OverlayLayer";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { StructureLayer } from "../../../src/client/render/three/StructureLayer";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import {
  nukeArcHeight,
  UnitLayer,
} from "../../../src/client/render/three/UnitLayer";
import type { UnitState } from "../../../src/client/render/types";

const W = 64;
const H = 64;

/** West half sea, east half low land (magnitude 4). */
function makeContext(): ThreeLayerContext {
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
    renderSettings: {} as RenderSettings,
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
}

function frame(nowMs: number, tickAlpha: number, cssPxPerTile = 4): FrameInfo {
  return {
    nowMs,
    dtMs: 16,
    tickAlpha,
    camera: new THREE.PerspectiveCamera(),
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
    layer.update(frame(0, 1));
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
    // 10 px / (0.5 px/tile × 5 tiles) = ×4.
    expect(instanceScale(mesh).y).toBeCloseTo(4);
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
});

describe("OverlayLayer", () => {
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
