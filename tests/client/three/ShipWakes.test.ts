/**
 * Lot 4 prototype (`?three_wakes=1`): foam wakes behind moving ships
 * (WakeLayer.ts, owned by UnitLayer). Pure helpers (look by zoom, speed
 * weight, velocity average, odometer, foam profile and its GLSL twin),
 * nothing built without the flag, and the data path with it: one instance
 * per moving ship in view, oriented by its averaged motion, warships
 * stronger, culled, capped, fading out once a ship stops.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { UNIT_MESH_LENGTH } from "../../../src/client/render/three/ProceduralMeshes";
import { TerrainByteTexture } from "../../../src/client/render/three/TerrainResources";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import { UnitLayer } from "../../../src/client/render/three/UnitLayer";
import {
  createWakeTrack,
  stepWakeTrack,
  WAKE_ARM_W0,
  WAKE_BOW,
  WAKE_FOAM_W0,
  WAKE_FRAG,
  WAKE_HALF_TAN,
  WAKE_KINDS,
  WAKE_MARGIN,
  WAKE_ARM_REACH,
  WAKE_MAX_ALPHA,
  WAKE_MAX_INSTANCES,
  WAKE_MILITARY_RESERVE,
  WAKE_MIN_STRENGTH,
  WAKE_NIGHT_DIM,
  WAKE_ODO_WRAP,
  WAKE_STERN,
  WAKE_STRIDE,
  WAKE_VERT,
  type WakeSource,
  wakeCrowdDim,
  wakeFoam,
  wakeKindStrength,
  wakeLook,
  wakeSpeedWeight,
} from "../../../src/client/render/three/WakeLayer";
import type { UnitState } from "../../../src/client/render/types";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function source(over: Partial<WakeSource> = {}): WakeSource {
  return {
    id: 7,
    kind: "tradeShip",
    fromX: 10.5,
    fromY: 20.5,
    toX: 11.5,
    toY: 20.5,
    dispX: 11.5,
    dispY: 20.5,
    wake: null,
    ...over,
  };
}

describe("wake look by zoom", () => {
  it("is a short streak at full map and a V from the default zoom", () => {
    const full = wakeLook(0.7);
    expect(full.arms).toBe(0);
    expect(full.opacity).toBeCloseTo(0.4);
    expect(full.lengthShips).toBeCloseTo(1.6);
    const def = wakeLook(1.8);
    expect(def.arms).toBe(1);
    expect(def.opacity).toBeCloseTo(0.65);
    expect(def.lengthShips).toBeCloseTo(2);
    expect(wakeLook(20).lengthShips).toBeCloseTo(2.6);
    expect(wakeLook(20).opacity).toBeCloseTo(0.85);
  });

  it("changes monotonically with the zoom (no popping)", () => {
    let prev = wakeLook(0.3);
    for (let z = 0.35; z <= 25; z *= 1.05) {
      const l = wakeLook(z);
      expect(l.arms).toBeGreaterThanOrEqual(prev.arms);
      expect(l.opacity).toBeGreaterThanOrEqual(prev.opacity);
      expect(l.lengthShips).toBeGreaterThanOrEqual(prev.lengthShips);
      expect(l.opacity - prev.opacity).toBeLessThan(0.06);
      prev = l;
    }
  });
});

describe("wake strength by kind and zoom", () => {
  it("keeps trade wakes faint zoomed out, military ones strong", () => {
    const trade = WAKE_KINDS.tradeShip!;
    const transport = WAKE_KINDS.transport!;
    const war = WAKE_KINDS.warship!;
    expect(wakeKindStrength(trade, 1.8)).toBeCloseTo(trade.farStrength);
    expect(wakeKindStrength(trade, 1.8)).toBeLessThan(0.6);
    expect(wakeKindStrength(trade, 8)).toBeCloseTo(1);
    for (const z of [0.7, 1.8, 4, 8]) {
      expect(wakeKindStrength(transport, z)).toBeGreaterThan(
        wakeKindStrength(trade, z),
      );
      expect(wakeKindStrength(war, z)).toBeGreaterThan(
        wakeKindStrength(trade, z),
      );
    }
    expect(transport.military && war.military && !trade.military).toBe(true);
  });
});

describe("wake kinematics", () => {
  it("has no wake at rest and a full one at cruising speed", () => {
    expect(wakeSpeedWeight(0)).toBe(0);
    expect(wakeSpeedWeight(0.05)).toBe(0);
    // One tile a tick, straight or on a diagonal staircase (√2/2 net).
    expect(wakeSpeedWeight(1)).toBe(1);
    expect(wakeSpeedWeight(Math.SQRT1_2)).toBe(1);
    expect(wakeSpeedWeight(0.3)).toBeGreaterThan(0);
    expect(wakeSpeedWeight(0.3)).toBeLessThan(1);
  });

  it("starts a moving ship at full speed and a ship leaving port at rest", () => {
    const moving = createWakeTrack(source());
    expect([moving.vx, moving.vy]).toEqual([1, 0]);
    const docked = createWakeTrack(source({ fromX: 11.5 }));
    expect([docked.vx, docked.vy]).toEqual([0, 0]);
    // Different ships, different foam.
    expect(createWakeTrack(source({ id: 8 })).odo).not.toBe(moving.odo);
  });

  it("averages the velocity independently of the frame rate", () => {
    const src = source({ fromX: 10.5, toX: 10.5, toY: 21.5 });
    const a = createWakeTrack(source());
    const b = createWakeTrack(source());
    stepWakeTrack(a, src, 5.5, 100);
    for (let i = 0; i < 10; i++) stepWakeTrack(b, src, 5.5, 10);
    expect(a.vx).toBeCloseTo(b.vx, 10);
    expect(a.vy).toBeCloseTo(b.vy, 10);
  });

  it("holds a steady heading on a diagonal staircase course", () => {
    // Alternating east / south steps, one per 100 ms tick, 60 FPS frames.
    const w = createWakeTrack(source());
    let x = 11.5;
    let y = 20.5;
    const headings: number[] = [];
    for (let tick = 0; tick < 40; tick++) {
      const east = tick % 2 === 0;
      const src = source({
        fromX: x,
        fromY: y,
        toX: east ? x + 1 : x,
        toY: east ? y : y + 1,
      });
      for (let f = 0; f < 6; f++) {
        stepWakeTrack(w, src, 5.5, 100 / 6);
        if (tick >= 20) headings.push(Math.atan2(w.vy, w.vx));
      }
      x = src.toX;
      y = src.toY;
    }
    for (const h of headings) {
      // Within ±10° of the course (45°); the hull's heading swings ±11°.
      expect(Math.abs(h - Math.PI / 4)).toBeLessThan((10 * Math.PI) / 180);
    }
    expect(wakeSpeedWeight(Math.hypot(w.vx, w.vy))).toBe(1);
  });

  it("fades out within ~1.2 s once a ship stops", () => {
    const w = createWakeTrack(source());
    const stopped = source({ fromX: 11.5 });
    let ms = 0;
    while (
      wakeSpeedWeight(Math.hypot(w.vx, w.vy)) * 1.25 >=
      WAKE_MIN_STRENGTH
    ) {
      stepWakeTrack(w, stopped, 5.5, 16);
      ms += 16;
    }
    expect(ms).toBeGreaterThan(300);
    expect(ms).toBeLessThan(1200);
  });

  it("measures the distance sailed in ship lengths, ignoring teleports", () => {
    const w = createWakeTrack(source());
    const odo = w.odo;
    stepWakeTrack(w, source({ dispX: 22.5 }), 5.5, 16);
    expect(w.odo - odo).toBeCloseTo(11 / 5.5);
    stepWakeTrack(w, source({ dispX: 522.5 }), 5.5, 16);
    expect(w.odo - odo).toBeCloseTo(2);
    w.odo = WAKE_ODO_WRAP - 0.5;
    stepWakeTrack(w, source({ dispX: 528 }), 5.5, 16);
    expect(w.odo).toBeCloseTo(0.5);
  });
});

describe("wake foam profile (TS twin of the shader)", () => {
  const lr = 2.6;
  const px = 0.01;
  const at = (s: number, l: number, arms = 1, n = 0.5, p = px) =>
    wakeFoam(s, l, lr, p, n, arms, 1);

  it("draws nothing ahead of the bow or past the tail", () => {
    expect(at(-0.1, 0)).toBe(0);
    expect(at(lr, 0)).toBe(0);
    expect(at(lr, lr * WAKE_HALF_TAN)).toBe(0);
  });

  it("puts the V's arms at the Kelvin angle, symmetric", () => {
    let prev = Infinity;
    for (const s of [0.4, 0.65, 0.9]) {
      const armL = s * WAKE_HALF_TAN;
      // Brightest near the bow, fading towards the tail.
      expect(at(s, armL)).toBeGreaterThan(0.12);
      expect(at(s, armL)).toBeLessThan(prev);
      prev = at(s, armL);
      expect(at(s, -armL)).toBeCloseTo(at(s, armL));
      // Off the arm (beside it, and between the arms ahead of the stern).
      expect(at(s, armL + 0.25)).toBeLessThan(0.05);
      if (s < WAKE_STERN - 0.1) expect(at(s, armL / 2)).toBeLessThan(0.1);
    }
    expect(at(0.4, 0.4 * WAKE_HALF_TAN)).toBeGreaterThan(0.4);
    // Arms off: a streak of stern foam only.
    expect(at(1, WAKE_HALF_TAN, 0)).toBeLessThan(0.05);
  });

  it("starts the arms at the bow (no X) and ends them before the wash", () => {
    // Nothing of the arms ahead of the apex.
    for (const l of [0, 0.02, 0.05, 0.1]) expect(at(-0.02, l)).toBe(0);
    // Past WAKE_ARM_REACH of the length: no arm, the wash goes on.
    const s = WAKE_ARM_REACH * lr + 0.05;
    expect(at(s, s * WAKE_HALF_TAN)).toBeLessThan(0.02);
    expect(at(s, 0, 0)).toBeGreaterThan(0.2);
  });

  it("puts turbulent foam on the centre line behind the stern", () => {
    expect(at(WAKE_STERN - 0.2, 0, 0)).toBe(0);
    expect(at(WAKE_STERN + 0.2, 0, 0)).toBeGreaterThan(0.5);
    expect(at(WAKE_STERN + 0.2, 0, 0, 0)).toBeLessThan(
      at(WAKE_STERN + 0.2, 0, 0, 1),
    );
    // Wider behind, fading out towards the tail, wider for a warship.
    const w1 = WAKE_FOAM_W0;
    expect(at(WAKE_STERN + 1, w1, 0)).toBeGreaterThan(
      at(WAKE_STERN + 0.1, w1, 0) * 0.5,
    );
    expect(at(lr - 0.1, 0, 0)).toBeLessThan(at(WAKE_STERN + 0.2, 0, 0));
    expect(
      wakeFoam(WAKE_STERN + 0.3, 0.15, lr, px, 0.5, 0, 1.35),
    ).toBeGreaterThan(wakeFoam(WAKE_STERN + 0.3, 0.15, lr, px, 0.5, 0, 1));
  });

  it("widens thin arms to the pixel and dims them (no shimmer far out)", () => {
    const s = 0.5;
    const armL = s * WAKE_HALF_TAN;
    // Coarse pixels (0.1 ship lengths): wider, dimmer peak.
    const fine = at(s, armL, 1, 0.5, 0.01);
    const coarse = at(s, armL, 1, 0.5, 0.1);
    expect(coarse).toBeLessThan(fine);
    expect(at(s, armL + 0.06, 1, 0.5, 0.1)).toBeGreaterThan(
      at(s, armL + 0.06, 1, 0.5, 0.01),
    );
  });

  it("mirrors the constants in the GLSL", () => {
    const f = (v: number) => v.toFixed(5);
    for (const c of [
      WAKE_HALF_TAN,
      WAKE_ARM_W0,
      WAKE_FOAM_W0,
      WAKE_STERN,
      WAKE_ARM_REACH,
      WAKE_MAX_ALPHA,
    ]) {
      expect(WAKE_FRAG).toContain(f(c));
    }
    expect(WAKE_VERT).toContain(f(WAKE_MARGIN));
    expect(WAKE_VERT).toContain(f(WAKE_HALF_TAN));
  });

  it("costs one terrain fetch and 1-2 value noises per fragment", () => {
    const main = WAKE_FRAG.slice(WAKE_FRAG.indexOf("void main()"));
    expect(main.match(/texelFetch\(/g)).toHaveLength(1);
    expect(main.match(/valueNoise\(/g)).toHaveLength(2);
    // The second octave only close up.
    expect(main).toMatch(/if \(detail > 0\.0\) n = mix\(n, [^;]*valueNoise/);
    // Land tiles are discarded (water only).
    expect(main).toMatch(/& 0x80u\) != 0u\) discard;/);
  });
});

// ---------------------------------------------------------------------------
// UnitLayer integration
// ---------------------------------------------------------------------------

const W = 400;
const H = 300;

/** Open sea with an island (x ≥ 300). */
function makeContext(
  wakes: boolean,
  perf = true,
  night = false,
): ThreeLayerContext {
  const terrain = new Uint8Array(W * H).fill(10);
  for (let y = 0; y < H; y++) {
    for (let x = 300; x < W; x++) terrain[y * W + x] = 0x80 | 4;
  }
  const settings = defaultThreeSettings();
  settings.perf = perf;
  settings.prototypes = { ...settings.prototypes, wakes, night };
  return {
    // Enough of a renderer for the shared terrain texture.
    renderer: {
      initTexture: () => {},
      copyTextureToTexture: () => {},
    } as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField: new HeightField(W, H, terrain, {
      heightScale: 6,
      seabedDepth: 3,
      targetVertices: 20_000,
    }),
    palette: new PaletteView(new Float32Array(4096 * 2 * 4)),
    settings,
    renderSettings: createRenderSettings(),
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
}

function frame(
  nowMs: number,
  zoom: number,
  cx = W / 2,
  cz = H / 2,
  altView = false,
): FrameInfo {
  const cssH = 600;
  const cam = new THREE.PerspectiveCamera(30, 800 / cssH, 0.5, 100_000);
  const focal = cssH / (2 * Math.tan((15 * Math.PI) / 180));
  cam.position.set(cx, focal / zoom, cz);
  cam.rotation.set(-Math.PI / 2, 0, 0, "YXZ");
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: cam,
    cssPxPerTile: zoom,
    tilt: 0,
    cssWidth: 800,
    cssHeight: cssH,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView,
  };
}

const ref = (x: number, y: number) => y * W + x;

function unit(
  id: number,
  unitType: string,
  x: number,
  y: number,
  lastX: number,
  lastY: number,
): UnitState {
  return {
    id,
    unitType,
    ownerID: 1,
    lastOwnerID: null,
    pos: ref(x, y),
    lastPos: ref(lastX, lastY),
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
  };
}

const unitMap = (...us: UnitState[]) => new Map(us.map((u) => [u.id, u]));

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

function layerFor(wakes: boolean, perf = true, night = false) {
  const ctx = makeContext(wakes, perf, night);
  const layer = new UnitLayer(ctx);
  disposers.push(() => layer.dispose());
  return { ctx, layer };
}

const wakeMesh = (ctx: ThreeLayerContext) =>
  ctx.scene.getObjectByName("unit-wakes") as THREE.Mesh | undefined;

/** Instance `i` of the wake buffer. */
function instance(ctx: ThreeLayerContext, i: number) {
  const g = wakeMesh(ctx)!.geometry as THREE.InstancedBufferGeometry;
  const a = g.getAttribute("aWakeA") as THREE.InterleavedBufferAttribute;
  const d = a.data.array as Float32Array;
  const o = i * WAKE_STRIDE;
  return {
    ax: d[o],
    ay: d[o + 1],
    dx: d[o + 2],
    dy: d[o + 3],
    len: d[o + 4],
    L: d[o + 5],
    strength: d[o + 6],
    wash: d[o + 8],
  };
}

const fleet = () =>
  unitMap(
    unit(1, "Trade Ship", 100, 100, 99, 100), // east
    unit(2, "Warship", 150, 150, 150, 151), // north
    unit(3, "Transport", 200, 120, 201, 120), // west
    unit(4, "Trade Ship", 120, 200, 120, 200), // docked
    unit(5, "Train", 350, 50, 349, 50), // not a ship
  );

describe("UnitLayer without ?three_wakes=1", () => {
  it("builds nothing and reports no wake counters", () => {
    const { ctx, layer } = layerFor(false);
    layer.updateUnits(fleet(), 1);
    layer.update(frame(1000, 4));
    expect(wakeMesh(ctx)).toBeUndefined();
    const materials = new Set<string>();
    ctx.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m !== undefined) materials.add(m.name);
    });
    expect([...materials].some((n) => /wake/.test(n))).toBe(false);
    expect(Object.keys(layer.perfStats()).some((k) => /^wake/.test(k))).toBe(
      false,
    );
    // No wake state on the tracks either.
    const tracks = (
      layer as unknown as { tracks: Map<number, { wake: unknown }> }
    ).tracks;
    for (const tr of tracks.values()) expect(tr.wake).toBeNull();
  });
});

describe("UnitLayer with ?three_wakes=1", () => {
  it("draws one wake per moving ship in view, in one draw call", () => {
    const { ctx, layer } = layerFor(true);
    layer.updateUnits(fleet(), 1);
    layer.update(frame(1000, 4));
    const mesh = wakeMesh(ctx)!;
    expect(mesh.visible).toBe(true);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(
      3,
    );
    expect(mesh.material).toBeInstanceOf(THREE.ShaderMaterial);
    const stats = layer.perfStats();
    expect(stats.wakeInstances).toBe(3);
    expect(stats.wakeCulled).toBe(0);
    expect(stats.wakeCapped).toBe(0);
    expect(stats.wakeUploadKB).toBeCloseTo((3 * WAKE_STRIDE * 4) / 1024);
    expect(stats.wakeJsMs).toBeGreaterThanOrEqual(0);
  });

  it("orients each wake by the ship's motion, apex at the bow", () => {
    const { ctx, layer } = layerFor(true);
    layer.updateUnits(fleet(), 1);
    layer.update(frame(1000, 4));
    const byId = [instance(ctx, 0), instance(ctx, 1), instance(ctx, 2)];
    const [trade, war, transport] = byId;
    // East, north (-y), west; apex WAKE_BOW ship lengths ahead of the centre.
    expect([trade.dx, trade.dy]).toEqual([1, 0]);
    expect(trade.ax).toBeCloseTo(100.5 + WAKE_BOW * trade.len);
    expect(trade.ay).toBeCloseTo(100.5);
    expect(war.dx).toBeCloseTo(0);
    expect(war.dy).toBeCloseTo(-1);
    expect(transport.dx).toBeCloseTo(-1);
    // Drawn ship lengths at zoom 4 (no min-size boost).
    expect(trade.len).toBeCloseTo(UNIT_MESH_LENGTH.tradeShip);
    expect(war.len).toBeCloseTo(UNIT_MESH_LENGTH.warship);
    // Warships: stronger, longer (relative to the ship) and wider wash.
    expect(war.strength).toBeGreaterThan(trade.strength);
    expect(war.L / war.len).toBeGreaterThan(trade.L / trade.len);
    expect(war.wash).toBeCloseTo(WAKE_KINDS.warship!.wash);
    expect(trade.L / trade.len).toBeCloseTo(wakeLook(4).lengthShips);
  });

  it("scales the wake with the ship's min-size boost far out", () => {
    const { ctx, layer } = layerFor(true);
    layer.updateUnits(unitMap(unit(1, "Trade Ship", 100, 100, 99, 100)), 1);
    layer.update(frame(1000, 0.7));
    const w = instance(ctx, 0);
    // 10 CSS px at 0.7 px per tile.
    expect(w.len * 0.7).toBeCloseTo(10);
    expect(w.L / w.len).toBeCloseTo(wakeLook(0.7).lengthShips);
  });

  it("culls wakes outside the view", () => {
    const { layer } = layerFor(true);
    layer.updateUnits(fleet(), 1);
    // Zoom 20 on the corner (10, 10): every ship is off screen.
    layer.update(frame(1000, 20, 10, 10));
    const stats = layer.perfStats();
    expect(stats.wakeInstances).toBe(0);
    expect(stats.wakeCulled).toBe(3);
  });

  it(`caps the instances at ${WAKE_MAX_INSTANCES}, never dropping military ships`, () => {
    const { ctx, layer } = layerFor(true);
    const ships: UnitState[] = [];
    for (let i = 0; i < 1100; i++) {
      const x = 10 + (i % 40) * 7;
      const y = 10 + Math.floor(i / 40) * 10;
      ships.push(unit(i + 1, "Trade Ship", x, y, x - 1, y));
    }
    // Warships seen last (after every trade ship).
    for (let i = 0; i < 40; i++) {
      ships.push(unit(5000 + i, "Warship", 12 + i * 7, 285, 11 + i * 7, 285));
    }
    layer.updateUnits(unitMap(...ships), 1);
    layer.update(frame(1000, 0.7));
    const stats = layer.perfStats();
    const trade = WAKE_MAX_INSTANCES - WAKE_MILITARY_RESERVE;
    expect(stats.wakeInstances).toBe(trade + 40);
    expect(stats.wakeCapped).toBe(1100 - trade);
    expect(
      (wakeMesh(ctx)!.geometry as THREE.InstancedBufferGeometry).instanceCount,
    ).toBe(trade + 40);
  });

  it("dims crowded wakes (lanes, port queues) by 1 / sqrt(n)", () => {
    const { ctx, layer } = layerFor(true);
    // One lone transport, and 9 transports within one crowding cell.
    const ships: UnitState[] = [unit(1, "Transport", 40, 40, 39, 40)];
    for (let i = 0; i < 9; i++) {
      const x = 150 + (i % 3);
      const y = 150 + Math.floor(i / 3);
      ships.push(unit(10 + i, "Transport", x, y, x - 1, y));
    }
    layer.updateUnits(unitMap(...ships), 1);
    // 1.8 px per tile: a 32 px cell is ~18 tiles.
    layer.update(frame(1000, 1.8));
    const lone = instance(ctx, 0).strength;
    const crowded = instance(ctx, 1).strength;
    expect(crowded).toBeCloseTo(lone * wakeCrowdDim(9), 6);
    expect(wakeCrowdDim(9)).toBeCloseTo(1 / 3, 9);
    expect(wakeCrowdDim(1)).toBe(1);
  });

  it("is dimmer at night (?three_night=1)", () => {
    const day = layerFor(true);
    const night = layerFor(true, true, true);
    for (const { layer } of [day, night]) {
      layer.updateUnits(fleet(), 1);
      layer.update(frame(1000, 4));
    }
    const look = (ctx: ThreeLayerContext) =>
      (wakeMesh(ctx)!.material as THREE.ShaderMaterial).uniforms.uLook
        .value as THREE.Vector3;
    expect(look(day.ctx).z).toBe(1);
    expect(look(night.ctx).z).toBeCloseTo(WAKE_NIGHT_DIM, 9);
  });

  it("fades a ship's wake out once it stops, hides the mesh when none is left", () => {
    const { ctx, layer } = layerFor(true);
    layer.updateUnits(unitMap(unit(1, "Trade Ship", 100, 100, 99, 100)), 1);
    let now = 1000;
    layer.update(frame(now, 4));
    const first = instance(ctx, 0).strength;
    // The ship stays on its tile from tick 2 on.
    layer.updateUnits(unitMap(unit(1, "Trade Ship", 100, 100, 100, 100)), 2);
    let frames = 0;
    while (layer.perfStats().wakeInstances > 0 && frames < 200) {
      now += 16;
      layer.update({ ...frame(now, 4), dtMs: 16 });
      if (frames === 30) expect(instance(ctx, 0).strength).toBeLessThan(first);
      frames++;
    }
    expect(frames).toBeGreaterThan(15);
    expect(frames).toBeLessThan(80);
    expect(wakeMesh(ctx)!.visible).toBe(false);
  });

  it("samples the shared terrain bytes (water only) and dims in the alt view", () => {
    const { ctx, layer } = layerFor(true);
    layer.updateUnits(fleet(), 1);
    layer.update(frame(1000, 4, W / 2, H / 2, true));
    const m = wakeMesh(ctx)!.material as THREE.ShaderMaterial;
    const shared = TerrainByteTexture.acquire(ctx);
    expect(m.uniforms.uTerrain.value).toBe(shared.texture);
    shared.release();
    expect((m.uniforms.uLook.value as THREE.Vector3).z).toBeLessThan(1);
    expect(m.depthWrite).toBe(false);
    expect(m.depthTest).toBe(true);
  });

  it("skips the JS timing without three_perf, and disposes cleanly", () => {
    const { ctx, layer } = layerFor(true, false);
    layer.updateUnits(fleet(), 1);
    layer.update(frame(1000, 4));
    expect(layer.perfStats().wakeJsMs).toBe(0);
    expect(layer.perfStats().wakeInstances).toBe(3);
    layer.dispose();
    disposers.length = 0;
    expect(wakeMesh(ctx)).toBeUndefined();
  });
});

describe("wake JS cost", () => {
  // Measured ~0.1-0.15 ms (median) for 900 ships here, where the whole
  // unit layer takes ~0.5-0.6 ms without wakes.
  it("stays well under a millisecond per frame for a late-game fleet", () => {
    const { layer } = layerFor(true);
    // 900 trade ships sailing east, one tile a tick, plus 200 other units.
    const make = (tick: number) => {
      const us: UnitState[] = [];
      for (let i = 0; i < 900; i++) {
        const x = 10 + (i % 30) * 8 + tick;
        const y = 5 + Math.floor(i / 30) * 9;
        us.push(unit(i + 1, "Trade Ship", x, y, x - 1, y));
      }
      for (let i = 0; i < 200; i++) {
        us.push(
          unit(
            2000 + i,
            "Train",
            310 + (i % 80),
            10 + i,
            309 + (i % 80),
            10 + i,
          ),
        );
      }
      return unitMap(...us);
    };
    const times: number[] = [];
    let now = 1000;
    for (let tick = 1; tick <= 40; tick++) {
      layer.updateUnits(make(tick), tick);
      for (let f = 0; f < 6; f++) {
        now += 16;
        const fr = { ...frame(now, 0.7), tickAlpha: f / 6 };
        layer.update(fr);
        if (tick > 10) times.push(layer.perfStats().wakeJsMs);
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    expect(layer.perfStats().wakeInstances).toBe(900);
    // Loose bound (shared CI machines).
    expect(median).toBeLessThan(2);
  });
});
