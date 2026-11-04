/**
 * The nukes' aerial ribbon in their owner's nuke-trail effect colours
 * (UnitLayer's TrailRenderer + EffectTrails' palette): which colour a ribbon
 * fragment takes (`ribbonFragment`, the TS twin of the ribbon shader), and
 * what the layer feeds the shader per vertex (owner, intensity) and per
 * frame (the effect switch), sharing the ground trails' palette texture and
 * clock. Other missiles and owners without an effect keep the default
 * additive warm ribbon.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { getPaletteSize } from "../../../src/client/render/gl/utils/ColorUtils";
import type { PaletteEffectAttributes } from "../../../src/client/render/gl/utils/EffectPalette";
import {
  type PaletteEffectType,
  writePlayerEffects,
} from "../../../src/client/render/gl/utils/PlayerPalette";
import {
  EFFECT_ROWS,
  EffectTrails,
  effectColorAt,
  NUKE_TRAIL_BLOCK,
} from "../../../src/client/render/three/EffectTrails";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { srgbToLinearRgb } from "../../../src/client/render/three/TerrainShading";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import {
  RIBBON_EFFECT_GLOW,
  RIBBON_EFFECT_OPACITY,
  ribbonFragment,
  UnitLayer,
} from "../../../src/client/render/three/UnitLayer";
import type { UnitState } from "../../../src/client/render/types";

const W = 64;
const H = 64;
const PALETTE = getPaletteSize();
const ME = 1;
const OTHER = 2;
const WARM: [number, number, number] = [1.7, 1.0, 0.45];

function effectPalette(
  effects: Record<
    number,
    Partial<Record<PaletteEffectType, PaletteEffectAttributes>>
  >,
): Float32Array {
  const pal = new Float32Array(PALETTE * EFFECT_ROWS * 4);
  const sink = { setNukeTrailSpiral() {}, clearNukeTrailSpiral() {} };
  for (const [sid, fx] of Object.entries(effects)) {
    writePlayerEffects(pal, Number(sid), (t) => fx[t], sink);
  }
  return pal;
}

const NUKE_GRADIENT = {
  [ME]: {
    nukeTrail: {
      type: "gradient",
      colors: ["#ff0000", "#0000ff"],
      colorSize: 5,
      movementSpeed: 2,
    },
    // A boat trail effect must not colour the nuke ribbon.
    transportShipTrail: {
      type: "gradient",
      colors: ["#00ff00"],
      colorSize: 5,
      movementSpeed: 0,
    },
  },
  [OTHER]: {
    transportShipTrail: {
      type: "gradient",
      colors: ["#00ff00"],
      colorSize: 5,
      movementSpeed: 0,
    },
  },
} as Record<
  number,
  Partial<Record<PaletteEffectType, PaletteEffectAttributes>>
>;

describe("ribbonFragment", () => {
  const effect = effectPalette(NUKE_GRADIENT);

  it("keeps the default additive ribbon without a nuke-trail effect", () => {
    for (const [owner, data, on] of [
      [0, effect, true], // a SAM missile (no effect owner)
      [OTHER, effect, true], // a boat-trail effect only
      [ME, null, true], // nobody has an effect yet
      [ME, effect, false], // alt view: effects off
    ] as const) {
      const f = ribbonFragment(WARM, owner, 0.5, data, on, 10, 20, 3);
      expect(f.alpha).toBe(0);
      expect(f.rgb).toEqual(WARM);
    }
  });

  it("takes the owner's nuke-trail colours at the ribbon's position", () => {
    const at = (x: number, z: number, t: number, intensity = 1) =>
      ribbonFragment(WARM, ME, intensity, effect, true, x, z, t);
    // Same colour as the ground track under it (block 1, world x + z).
    const ground = effectColorAt(effect, ME, NUKE_TRAIL_BLOCK, 3, 4, 1.5)!;
    const f = at(3, 4, 1.5);
    const k = (1 + RIBBON_EFFECT_GLOW) * RIBBON_EFFECT_OPACITY;
    const lin = srgbToLinearRgb(ground);
    for (let c = 0; c < 3; c++) expect(f.rgb[c]).toBeCloseTo(lin[c] * k, 6);
    expect(f.alpha).toBeCloseTo(RIBBON_EFFECT_OPACITY);
    // Red at the start of the cycle, blue half a cycle (5 tiles) on.
    const red = at(0, 0, 0);
    expect(red.rgb[0]).toBeGreaterThan(1);
    expect(red.rgb[2]).toBe(0);
    const blue = at(2.5, 2.5, 0);
    expect(blue.rgb[0]).toBe(0);
    expect(blue.rgb[2]).toBeGreaterThan(1);
    // It fades with the ribbon (premultiplied: rgb and alpha together).
    const tail = at(0, 0, 0, 0.25);
    expect(tail.alpha).toBeCloseTo(0.25 * RIBBON_EFFECT_OPACITY);
    expect(tail.rgb[0]).toBeCloseTo(red.rgb[0] * 0.25);
  });
});

// ---------------------------------------------------------------------------
// UnitLayer wiring
// ---------------------------------------------------------------------------

function makeContext(): ThreeLayerContext {
  const terrain = new Uint8Array(W * H);
  const palette = new Float32Array(PALETTE * 2 * 4);
  palette.set([0.9, 0.2, 0.2, 1], ME * 4);
  palette.set([0.2, 0.4, 0.9, 1], OTHER * 4);
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
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
}

function frame(nowMs: number, altView = false): FrameInfo {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 1, 10_000);
  cam.position.set(W / 2, 200, H / 2);
  cam.rotation.set(-Math.PI / 2, 0, 0, "YXZ");
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: cam,
    cssPxPerTile: 4,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID: ME,
    highlightOwner: 0,
    altView,
  };
}

const ref = (x: number, y: number) => y * W + x;

function unit(over: Partial<UnitState> & { id: number }): UnitState {
  return {
    unitType: "Atom Bomb",
    ownerID: ME,
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

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

describe("UnitLayer nuke ribbons", () => {
  /** A nuke of ME, one of OTHER and a SAM missile of ME, two ticks in. */
  function flying(ctx: ThreeLayerContext) {
    const layer = new UnitLayer(ctx);
    disposers.push(() => layer.dispose());
    const units = (k: number) =>
      new Map(
        [
          unit({
            id: 1,
            pos: ref(10 + k, 20),
            lastPos: ref(9 + k, 20),
            targetTile: ref(50, 20),
          }),
          unit({
            id: 2,
            ownerID: OTHER,
            unitType: "Hydrogen Bomb",
            pos: ref(10 + k, 40),
            lastPos: ref(9 + k, 40),
            targetTile: ref(50, 40),
          }),
          unit({
            id: 3,
            unitType: "SAMMissile",
            pos: ref(30, 30 - k),
            lastPos: ref(30, 31 - k),
          }),
        ].map((u) => [u.id, u]),
      );
    return { layer, units };
  }

  it("feeds the owner of nukes (not other missiles) to the ribbon shader", () => {
    const ctx = makeContext();
    const { layer, units } = flying(ctx);
    const trails = EffectTrails.acquire(ctx);
    disposers.push(() => trails.release());
    for (let k = 0; k < 4; k++) {
      layer.updateUnits(units(k), k + 1);
      layer.update(frame(100 * k));
    }
    const mesh = ctx.scene.getObjectByName("unit-trails") as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >;
    expect(mesh.visible).toBe(true);
    const mat = mesh.material;
    // The ground trails' palette texture and clock, shared by reference.
    expect(mat.uniforms.uEffectPalette).toBe(trails.uniforms.uEffectPalette);
    expect(mat.uniforms.uTrailTime).toBe(trails.uniforms.uTrailTime);
    expect(mat.uniforms.uEffectsOn).not.toBe(trails.uniforms.uEffectsOn);
    // Owners per vertex: ME and OTHER (nukes), 0 for the SAM missile.
    const eff = mesh.geometry.getAttribute("aEffect");
    const col = mesh.geometry.getAttribute("aColor");
    const index = mesh.geometry.getIndex()!;
    let verts = 0;
    for (let i = 0; i < mesh.geometry.drawRange.count; i++) {
      verts = Math.max(verts, index.getX(i) + 1);
    }
    const owners = new Map<number, number>();
    for (let v = 0; v < verts; v++) {
      owners.set(eff.getX(v), (owners.get(eff.getX(v)) ?? 0) + 1);
      expect(eff.getY(v)).toBeGreaterThanOrEqual(0);
      expect(eff.getY(v)).toBeLessThanOrEqual(1);
    }
    expect([...owners.keys()].sort()).toEqual([0, ME, OTHER]);
    // Head intensity 1 on the first trail's live head.
    expect(eff.getY(0)).toBeCloseTo(1);
    // The default colour is still there for the additive look.
    expect(col.getX(0)).toBeGreaterThan(0);
    // Nobody has an effect yet: the shader's switch is off.
    expect(mat.uniforms.uEffectsOn.value).toBe(0);
    expect(layer.perfStats().nukeEffectRibbons).toBe(0);
  });

  it("switches the effect colours on for nuke-trail effects, off in the alt view", () => {
    const ctx = makeContext();
    const { layer, units } = flying(ctx);
    const trails = EffectTrails.acquire(ctx);
    disposers.push(() => trails.release());
    const mat = () =>
      (ctx.scene.getObjectByName("unit-trails") as THREE.Mesh)
        .material as THREE.ShaderMaterial;
    // A boat-trail effect alone does not colour any ribbon.
    trails.setEffectPalette(effectPalette({ [OTHER]: NUKE_GRADIENT[OTHER] }));
    layer.updateUnits(units(0), 1);
    layer.update(frame(0));
    layer.updateUnits(units(1), 2);
    layer.update(frame(100));
    expect(mat().uniforms.uEffectsOn.value).toBe(0);
    // ME's nuke-trail effect: on, and ME's nuke ribbon is counted.
    trails.setEffectPalette(effectPalette(NUKE_GRADIENT));
    layer.updateUnits(units(2), 3);
    layer.update(frame(200));
    expect(mat().uniforms.uEffectsOn.value).toBe(1);
    expect(mat().uniforms.uEffectPalette.value).toBe(trails.effects.texture);
    expect(layer.perfStats().nukeEffectRibbons).toBe(1);
    // The alt view keeps the default ribbon (strategic overlay).
    layer.update(frame(216, true));
    expect(mat().uniforms.uEffectsOn.value).toBe(0);
    expect(layer.perfStats().nukeEffectRibbons).toBe(0);
    // Premultiplied blending: alpha 0 adds, alpha > 0 composites over.
    expect(mat().blending).toBe(THREE.CustomBlending);
    expect(mat().blendSrc).toBe(THREE.OneFactor);
    expect(mat().blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(mat().depthWrite).toBe(false);
  });

  it("releases the shared effect palette with the layer", () => {
    const ctx = makeContext();
    const layer = new UnitLayer(ctx);
    const trails = EffectTrails.acquire(ctx);
    let disposed = 0;
    trails.trailTexture.addEventListener("dispose", () => disposed++);
    layer.dispose();
    expect(disposed).toBe(0);
    trails.release();
    expect(disposed).toBe(1);
  });
});
