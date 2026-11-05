/**
 * Lot 3, item 7: bombs in flight. Their on-screen length is capped at their
 * own depth (they fly up to 120 tiles high, close to the camera), their
 * exhaust glow is tamed, and every nuke / MIRV warhead leaves a readable
 * trail (a light contrail behind a short glowing head, at least
 * NUKE_TRAIL_MIN_PX wide), with short trails past the first
 * MAX_FULL_WARHEAD_TRAILS warheads.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  createUnitGeometry,
  NUKE_FLAME_GLOW,
  UNIT_MESH_LENGTH,
  UnitMesh,
} from "../../../src/client/render/three/ProceduralMeshes";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import {
  capScreenScale,
  MAX_FULL_WARHEAD_TRAILS,
  NUKE_CAP_ZOOM_GAIN_MAX,
  NUKE_SCREEN_CAP_PX,
  NUKE_TRAIL_MIN_PX,
  nukeScreenCapPx,
  ribbonFragment,
  UNIT_GLOW_FAR,
  UnitLayer,
  unitGlowAtZoom,
  WARHEAD_CONTRAIL_MIN,
  WARHEAD_CONTRAIL_REF,
  WARHEAD_SHORT_TRAIL_POINTS,
  warheadContrailScale,
} from "../../../src/client/render/three/UnitLayer";
import type { UnitState } from "../../../src/client/render/types";

describe("nuke screen cap (pure)", () => {
  it("caps bombs only, a little more generously close up", () => {
    expect(nukeScreenCapPx("atomBomb", 0.7)).toBe(NUKE_SCREEN_CAP_PX.atomBomb);
    expect(nukeScreenCapPx("atomBomb", 2)).toBe(NUKE_SCREEN_CAP_PX.atomBomb);
    expect(nukeScreenCapPx("hydrogenBomb", 8)).toBeCloseTo(
      2 * NUKE_SCREEN_CAP_PX.hydrogenBomb!,
    );
    expect(nukeScreenCapPx("mirv", 20)).toBeCloseTo(
      NUKE_CAP_ZOOM_GAIN_MAX * NUKE_SCREEN_CAP_PX.mirv!,
    );
    expect(nukeScreenCapPx("warship", 4)).toBe(Infinity);
    expect(nukeScreenCapPx("tradeShip", 4)).toBe(Infinity);
    // Ordered by size, warheads smallest.
    const z = 4;
    expect(nukeScreenCapPx("mirvWarhead", z)).toBeLessThan(
      nukeScreenCapPx("atomBomb", z),
    );
    expect(nukeScreenCapPx("atomBomb", z)).toBeLessThan(
      nukeScreenCapPx("hydrogenBomb", z),
    );
    expect(nukeScreenCapPx("hydrogenBomb", z)).toBeLessThan(
      nukeScreenCapPx("mirv", z),
    );
  });

  it("shrinks the scale only when the model would be longer than the cap", () => {
    // 7 tiles at 4 px per tile = 28 px: under a 30 px cap, unchanged.
    expect(capScreenScale(1, 7, 4, 30)).toBe(1);
    // 7 tiles at 20 px per tile (close to the camera) = 140 px → 30 px.
    expect(capScreenScale(1, 7, 20, 30) * 7 * 20).toBeCloseTo(30);
    // The min-size boost is capped the same way.
    expect(capScreenScale(2.5, 7, 4, 30) * 7 * 4).toBeCloseTo(30);
    // No cap, no depth: unchanged.
    expect(capScreenScale(1.5, 7, 20, Infinity)).toBe(1.5);
    expect(capScreenScale(1.5, 7, 0, 30)).toBe(1.5);
  });

  it("tames the bombs' exhaust (bloom no longer balloons them)", () => {
    for (const kind of [
      UnitMesh.AtomBomb,
      UnitMesh.HydrogenBomb,
      UnitMesh.Mirv,
      UnitMesh.MirvWarhead,
    ]) {
      const glow = createUnitGeometry(kind).getAttribute("aGlow").array;
      expect(Math.max(...glow), kind).toBeLessThanOrEqual(NUKE_FLAME_GLOW);
    }
    expect(NUKE_FLAME_GLOW).toBeLessThan(3);
    // SAM missiles and shells keep theirs.
    const sam = createUnitGeometry(UnitMesh.SamMissile).getAttribute("aGlow");
    expect(Math.max(...sam.array)).toBeGreaterThan(3);
  });

  it("mirrors the contrail: composited over, under the additive glow", () => {
    const head: [number, number, number] = [1.7, 1, 0.45];
    const f = ribbonFragment(head, 0, 1, null, false, 0, 0, 0, {
      rgb: [0.6, 0.6, 0.6],
      alpha: 0.5,
    });
    expect(f.alpha).toBe(0.5);
    expect(f.rgb[0]).toBeCloseTo(1.7 + 0.3);
    // Without a contrail: the lot-2 additive ribbon.
    expect(ribbonFragment(head, 0, 1, null, false, 0, 0, 0)).toEqual({
      rgb: head,
      alpha: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// UnitLayer
// ---------------------------------------------------------------------------

const W = 400;
const H = 300;

function makeContext(): ThreeLayerContext {
  const terrain = new Uint8Array(W * H).fill(0x80 | 4);
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField: new HeightField(W, H, terrain, {
      heightScale: 6,
      seabedDepth: 3,
      targetVertices: 20_000,
    }),
    palette: new PaletteView(new Float32Array(4096 * 2 * 4)),
    settings: defaultThreeSettings(),
    renderSettings: createRenderSettings(),
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
}

/**
 * The renderer's camera for a zoom (CameraRig: fov 30°, distance so the
 * ground at the centre is `zoom` CSS px per tile), tilted `tiltDeg`.
 */
function frame(
  nowMs: number,
  zoom: number,
  cx: number,
  cz: number,
  tiltDeg = 0,
): FrameInfo {
  const cssH = 600;
  const cam = new THREE.PerspectiveCamera(30, 800 / cssH, 0.5, 100_000);
  const focal = cssH / (2 * Math.tan((15 * Math.PI) / 180));
  const d = focal / zoom;
  const t = (tiltDeg * Math.PI) / 180;
  cam.position.set(cx, d * Math.cos(t), cz + d * Math.sin(t));
  cam.rotation.set(-Math.PI / 2 + t, 0, 0, "YXZ");
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: cam,
    cssPxPerTile: zoom,
    tilt: t,
    cssWidth: 800,
    cssHeight: cssH,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView: false,
  };
}

const ref = (x: number, y: number) => y * W + x;

function nuke(
  id: number,
  unitType: string,
  x: number,
  y: number,
  lastX: number,
  target: [number, number],
): UnitState {
  return {
    id,
    unitType,
    ownerID: 1,
    lastOwnerID: null,
    pos: ref(x, y),
    lastPos: ref(lastX, y),
    isActive: true,
    reachedTarget: false,
    retreating: false,
    targetable: true,
    waitTicks: 0,
    markedForDeletion: false,
    health: null,
    underConstruction: false,
    targetUnitId: null,
    targetTile: ref(target[0], target[1]),
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

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** On-screen length (CSS px) of instance 0 of a unit batch. */
function screenLength(
  ctx: ThreeLayerContext,
  name: string,
  f: FrameInfo,
  len: number,
): number {
  const mesh = ctx.scene.getObjectByName(name) as THREE.InstancedMesh;
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(0, m);
  const half = len / 2;
  const a = new THREE.Vector3(-half, 0, 0).applyMatrix4(m).project(f.camera);
  const b = new THREE.Vector3(half, 0, 0).applyMatrix4(m).project(f.camera);
  return Math.hypot(
    ((b.x - a.x) / 2) * f.cssWidth,
    ((b.y - a.y) / 2) * f.cssHeight,
  );
}

describe("UnitLayer in-flight bombs", () => {
  /**
   * A hydrogen bomb flying east along y = 150 from `x0` to `x1` (10 tiles a
   * tick), flown for `ticks` ticks.
   */
  function fly(
    layer: UnitLayer,
    f: (t: number) => FrameInfo,
    ticks: number,
    x0 = 20,
    x1 = 380,
  ) {
    for (let k = 0; k <= ticks; k++) {
      const x = x0 + 10 * k;
      layer.updateUnits(
        new Map([
          [
            1,
            nuke(1, "Hydrogen Bomb", x, 150, k === 0 ? x : x - 10, [x1, 150]),
          ],
        ]),
        k + 1,
      );
      for (let i = 0; i < 3; i++) layer.update(f(k * 150 + i * 50));
    }
  }

  it("keeps a bomb near the camera small (zoom 11, tilted)", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    // A 100-tile flight: at its apex (x = 200) 30 tiles up. The camera at
    // zoom 11 tilted 48° (68 tiles up) looks at a point 33 tiles north of
    // the bomb, which passes ~57 tiles from it (the ground: 102).
    const f = (t: number) => frame(t, 11, 200, 116.6, 48);
    fly(layer, f, 5, 150, 250);
    const len = UNIT_MESH_LENGTH.hydrogenBomb;
    const px = screenLength(ctx, "units-hydrogenBomb", f(9999), len);
    expect(px).toBeLessThanOrEqual(nukeScreenCapPx("hydrogenBomb", 11) + 0.5);
    expect(px).toBeGreaterThan(10);
    const stats = layer.perfStats();
    expect(stats.nukesInFlight).toBe(1);
    expect(stats.nukesScreenCapped).toBe(1);
  });

  it("leaves bombs at their size where they are small anyway", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    const f = (t: number) => frame(t, 1.8, 200, 150);
    fly(layer, f, 18);
    expect(layer.perfStats().nukesScreenCapped).toBe(0);
  });

  it("draws a readable trail: wide enough, contrail behind a short glow", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    // Full map: a tile is 0.7 px, the bomb's own ribbon would be ~1 px.
    const f = (t: number) => frame(t, 0.7, 200, 150);
    fly(layer, f, 10);
    const mesh = ctx.scene.getObjectByName("unit-trails") as THREE.Mesh;
    expect(mesh.visible).toBe(true);
    const pos = mesh.geometry.getAttribute("position");
    const smoke = mesh.geometry.getAttribute("aSmoke");
    const glow = mesh.geometry.getAttribute("aColor");
    // Head: the first vertex pair; width on screen ≥ NUKE_TRAIL_MIN_PX.
    const cam = f(0).camera;
    const a = new THREE.Vector3().fromBufferAttribute(pos, 0).project(cam);
    const b = new THREE.Vector3().fromBufferAttribute(pos, 1).project(cam);
    const widthPx = Math.hypot(
      ((b.x - a.x) / 2) * 800,
      ((b.y - a.y) / 2) * 600,
    );
    expect(widthPx).toBeGreaterThanOrEqual(NUKE_TRAIL_MIN_PX - 0.05);
    // The head glows (below the bloom threshold at full map: no glowing
    // ellipse, lot 3 unitGlowAtZoom) and has no smoke yet; further back the
    // contrail is composited over (alpha > 0) and the glow is nearly gone.
    expect(glow.getX(0)).toBeGreaterThan(0.5);
    expect(glow.getX(0)).toBeLessThan(1);
    expect(smoke.getW(0)).toBe(0);
    const n = layer.perfStats().trailSamples;
    expect(n).toBeGreaterThan(6);
    const mid = 2 * Math.floor(n / 2);
    expect(smoke.getW(mid)).toBeGreaterThan(0.2);
    expect(glow.getX(mid)).toBeLessThan(0.5 * glow.getX(0));
  });

  it("gives every MIRV warhead a trail, short ones past the cap", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    const f = (t: number) => frame(t, 2, 200, 150);
    const count = MAX_FULL_WARHEAD_TRAILS + 40;
    for (let k = 0; k < 8; k++) {
      const units = new Map<number, UnitState>();
      for (let i = 0; i < count; i++) {
        const y = 20 + (i % 250);
        const x = 20 + (i >> 3) + 10 * k;
        units.set(
          100 + i,
          nuke(100 + i, "MIRV Warhead", x, y, k === 0 ? x : x - 10, [390, y]),
        );
      }
      layer.updateUnits(units, k + 1);
      layer.update(f(k * 100));
    }
    const s = layer.perfStats();
    expect(s.warheadTrails).toBe(count);
    expect(s.trailRibbons).toBe(count);
    // Samples: the full trails keep up to 12, the short ones
    // WARHEAD_SHORT_TRAIL_POINTS (+ their live heads).
    expect(s.trailSamples).toBeLessThanOrEqual(
      MAX_FULL_WARHEAD_TRAILS * 13 + 40 * (WARHEAD_SHORT_TRAIL_POINTS + 1),
    );
    expect(s.trailSamples).toBeGreaterThan(MAX_FULL_WARHEAD_TRAILS * 8);
    // Gone: the trails retire (and stop counting against the cap).
    layer.updateUnits(new Map(), 20);
    layer.update(f(5000));
    expect(layer.perfStats().warheadTrails).toBe(0);
  });
});

describe("lot 3 fix pass: no bloom blobs far out, no kink, thinned salvos", () => {
  /** A hydrogen bomb flying east along y = 150, 10 tiles a tick. */
  function fly(layer: UnitLayer, f: (t: number) => FrameInfo, ticks: number) {
    for (let k = 0; k <= ticks; k++) {
      const x = 20 + 10 * k;
      layer.updateUnits(
        new Map([
          [
            1,
            nuke(1, "Hydrogen Bomb", x, 150, k === 0 ? x : x - 10, [380, 150]),
          ],
        ]),
        k + 1,
      );
      for (let i = 0; i < 3; i++) layer.update(f(k * 150 + i * 50));
    }
  }

  it("keeps exhausts and ribbon heads under the bloom threshold zoomed out", () => {
    expect(unitGlowAtZoom(0.7)).toBe(UNIT_GLOW_FAR);
    expect(unitGlowAtZoom(1.5)).toBe(UNIT_GLOW_FAR);
    expect(unitGlowAtZoom(4)).toBe(1);
    expect(unitGlowAtZoom(20)).toBe(1);
    let prev = 0;
    for (let z = 0.5; z < 6; z += 0.1) {
      expect(unitGlowAtZoom(z)).toBeGreaterThanOrEqual(prev);
      prev = unitGlowAtZoom(z);
    }
    // Flame luminance ~0.47 × NUKE_FLAME_GLOW × the flicker (≤ 1.17), and
    // the ribbon head (warm 1.7): under the bloom threshold (1) at full
    // map, so a bomb is no glowing ellipse there (img00).
    expect(0.47 * NUKE_FLAME_GLOW * 1.17 * unitGlowAtZoom(0.7)).toBeLessThan(1);
    expect(1.7 * unitGlowAtZoom(0.7)).toBeLessThan(1);
  });

  it("thins MIRV warhead contrails by their number", () => {
    expect(warheadContrailScale(0)).toBe(1);
    expect(warheadContrailScale(WARHEAD_CONTRAIL_REF)).toBe(1);
    expect(warheadContrailScale(4 * WARHEAD_CONTRAIL_REF)).toBeCloseTo(0.5);
    expect(warheadContrailScale(10_000)).toBe(WARHEAD_CONTRAIL_MIN);
    let prev = 1;
    for (let n = 1; n < 500; n++) {
      expect(warheadContrailScale(n)).toBeLessThanOrEqual(prev);
      prev = warheadContrailScale(n);
    }
  });

  it("keeps the trail straight behind the bomb while its on-screen size changes", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    // The zoom (so the min-size boost and the cap, the model's length and
    // lift) changes every frame; before, each sample kept the tail offset
    // of its frame and the ribbon kinked behind the model.
    const zooms = [0.7, 11, 1.8, 6, 0.7, 4, 11, 2];
    let i = 0;
    const f = (t: number) => frame(t, zooms[i++ % zooms.length], 200, 150);
    fly(layer, f, 12);
    const mesh = ctx.scene.getObjectByName("unit-trails") as THREE.Mesh;
    expect(mesh.visible).toBe(true);
    const pos = mesh.geometry.getAttribute("position");
    const n = layer.perfStats().trailSamples;
    expect(n).toBeGreaterThan(6);
    // The ribbon's centre line runs west (the bomb flies east), never back.
    const mid = (k: number) => (pos.getX(2 * k) + pos.getX(2 * k + 1)) / 2;
    for (let k = 0; k + 1 < n; k++) {
      expect(mid(k + 1)).toBeLessThanOrEqual(mid(k) + 1e-6);
    }
    // Its head is behind the bomb (tile 140 after 12 ticks: centre 140.5).
    expect(mid(0)).toBeLessThan(140.5);
    // The exhaust glow stays within NUKE_HEAD_GLOW_PX of the head (a
    // split vertex ends it on a long first segment): the glow at the
    // vertices farther back is 0.
    const glow = mesh.geometry.getAttribute("aColor");
    expect(glow.getX(0)).toBeGreaterThan(0);
    for (let k = 3; k < n; k++) expect(glow.getX(2 * k)).toBe(0);
  });
});
