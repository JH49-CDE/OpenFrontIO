/**
 * Lot 4 prototype, night and lights (`?three_night=1`, NightLights.ts): the
 * switch (URL flag or the night graphics preset) and the depth, the look by
 * zoom, the structure lights and their lightmap (kernel, encoding,
 * incremental rebuilds within budget, black margin), the flashes (envelope,
 * colour, falloff, slots), the GLSL mirrors, the window mask, and that
 * nothing of it exists when off: no define, uniform, texture, object or
 * counter in any layer, and the NIGHT code compiled out of the shaders.
 * three's WebGLRenderer and initGL are stubbed for the facade tests; the
 * layers are real.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { getPaletteSize } from "../../../src/client/render/gl/utils/ColorUtils";
import {
  FxLayer,
  nightFlashFor,
} from "../../../src/client/render/three/FxLayer";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { NIGHT_NAME_CSS } from "../../../src/client/render/three/NameLayer";
import {
  dayFlatLight,
  flashFalloff,
  LIGHTMAP_BUDGET,
  LIGHTMAP_MAX,
  lightKernel,
  lightmapCap,
  lightmapDecode,
  lightmapEncode,
  lightmapScale,
  NIGHT_FLASH_SLOTS,
  NIGHT_GLSL,
  NIGHT_LIGHT_MAX_RADIUS,
  NIGHT_PRESET_AMBIENT,
  NightFlashes,
  nightFlashColor,
  nightFlashEnvelope,
  NightLighting,
  NightLightmap,
  nightDepth,
  nightLook,
  nightModeOf,
  structureLight,
  wideKernel,
  windowShare,
} from "../../../src/client/render/three/NightLights";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  addWindowMask,
  createPartMaterial,
  createStructureGeometry,
  createUnitGeometry,
  UnitMesh,
} from "../../../src/client/render/three/ProceduralMeshes";
import {
  RAIL_NIGHT_GLOW,
  RailTracks,
} from "../../../src/client/render/three/RailTracks";
import {
  NIGHT_ENVIRONMENT,
  SceneEnvironment,
  SUN_INTENSITY,
} from "../../../src/client/render/three/SceneEnvironment";
import { TERRAIN_FRAG } from "../../../src/client/render/three/shaders/terrain";
import { WATER_FRAG } from "../../../src/client/render/three/shaders/water";
import { StructureLayer } from "../../../src/client/render/three/StructureLayer";
import { TerrainLayer } from "../../../src/client/render/three/TerrainLayer";
import { ThreeMapRenderer } from "../../../src/client/render/three/ThreeMapRenderer";
import {
  defaultThreeSettings,
  type ThreeRenderSettings,
} from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import { UnitLayer } from "../../../src/client/render/three/UnitLayer";
import { WaterLayer } from "../../../src/client/render/three/WaterLayer";
import type {
  RendererConfig,
  UnitState,
} from "../../../src/client/render/types";
import { withoutDefines } from "./shaderDefines";
import {
  lateGameStructures,
  makeSetContext,
  SET_H,
  SET_W,
} from "./structureSet";

vi.mock("../../../src/client/render/gl/initGL", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initGL: () => ({
    status: "ok",
    gl: {
      SAMPLES: 0x80a9,
      getParameter: () => 0,
      getExtension: () => null,
    },
  }),
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    info = {
      autoReset: true,
      reset: () => {},
      render: { calls: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
      programs: [],
    };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "";
    private target: unknown = null;
    initTexture() {}
    copyTextureToTexture() {}
    setPixelRatio() {}
    setSize() {}
    getRenderTarget() {
      return this.target;
    }
    setRenderTarget(t: unknown) {
      this.target = t;
    }
    render() {}
    dispose() {}
    forceContextLoss() {}
  }
  return { ...actual, WebGLRenderer };
});

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const W = 96;
const H = 64;

function settingsWith(night: boolean): ThreeRenderSettings {
  const s = defaultThreeSettings();
  s.perf = true;
  s.prototypes = { wakes: false, front: false, night };
  return s;
}

/** Layer context over a stub renderer recording rectangle uploads. */
function makeCtx(night: boolean, ambient = 1) {
  const terrain = new Uint8Array(W * H).fill(0x80 | 4); // all land
  const settings = settingsWith(night);
  const heightField = new HeightField(W, H, terrain, {
    heightScale: settings.heightScale,
    seabedDepth: settings.seabedDepth,
    targetVertices: (W * H) / 4,
  });
  const rects: { target: THREE.Texture; w: number; h: number }[] = [];
  const renderer = {
    initTexture: () => {},
    copyTextureToTexture: (
      _src: THREE.Texture,
      dst: THREE.Texture,
      region: THREE.Box2,
    ) =>
      rects.push({
        target: dst,
        w: region.max.x - region.min.x,
        h: region.max.y - region.min.y,
      }),
  } as unknown as THREE.WebGLRenderer;
  const renderSettings = createRenderSettings();
  if (ambient < 1) {
    renderSettings.lighting.ambient = ambient;
    renderSettings.lighting.enabled = true;
  }
  const ctx: ThreeLayerContext = {
    renderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField,
    palette: new PaletteView(new Float32Array(4096 * 2 * 4)),
    settings,
    renderSettings,
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
  return { ctx, rects };
}

function frame(nowMs: number, cssPxPerTile: number): FrameInfo {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 1, 100_000);
  cam.position.set(W / 2, 600 / cssPxPerTile, H / 2);
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
    localPlayerID: 0,
    highlightOwner: 0,
    altView: false,
  };
}

function unit(
  id: number,
  unitType: string,
  x: number,
  y: number,
  level = 1,
  mapW = W,
): UnitState {
  return {
    id,
    unitType,
    ownerID: 1,
    lastOwnerID: null,
    pos: y * mapW + x,
    lastPos: y * mapW + x,
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
    level,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
  } as UnitState;
}

const units = (...list: UnitState[]) => new Map(list.map((u) => [u.id, u]));

/** Rebuild every dirty cell of a lightmap (no budget). */
function drain(lm: NightLightmap): void {
  while (!lm.queue.empty) lm.rebuild(null);
}

/** Brute-force light at texel (i, j): every light's kernel, summed. */
function bruteTexel(
  lm: NightLightmap,
  lights: { x: number; y: number; type: string; level: number }[],
  i: number,
  j: number,
): [number, number, number, number] {
  const S = lm.scale;
  const cx = (i - 0.5) * S;
  const cy = (j - 0.5) * S;
  const acc = [0, 0, 0, 0];
  for (const l of lights) {
    const s = structureLight(l.type, l.level)!;
    const d = Math.hypot(cx - (l.x + 0.5), cy - (l.y + 0.5));
    const k = lightKernel(d, s.radius) * s.intensity;
    acc[0] += k * s.r;
    acc[1] += k * s.g;
    acc[2] += k * s.b;
    acc[3] += wideKernel(d, s.wideRadius) * s.wideIntensity;
  }
  return [
    lightmapDecode(lightmapEncode(acc[0])),
    lightmapDecode(lightmapEncode(acc[1])),
    lightmapDecode(lightmapEncode(acc[2])),
    lightmapDecode(lightmapEncode(acc[3])),
  ];
}

/** The shader as compiled without NIGHT (its #else kept). */
function withoutNight(src: string): string {
  return withoutDefines(src, ["NIGHT"]);
}

describe("night switch and depth", () => {
  it("is on with the URL flag only (never from the graphics preset)", () => {
    expect(nightModeOf(settingsWith(true))).toBe("url");
    expect(nightModeOf(settingsWith(false))).toBeNull();
    // Settings built by hand without the prototypes field: off.
    expect(nightModeOf({})).toBeNull();
  });

  it("is the Night preset's depth at least, deeper with a darker ambient", () => {
    expect(nightDepth("url", 1)).toBe(1);
    expect(nightDepth("url", NIGHT_PRESET_AMBIENT)).toBeCloseTo(1, 9);
    // Evan's pick (0.76) is a dusk for the default renderer: still night.
    expect(nightDepth("url", 0.76)).toBe(1);
    expect(nightDepth("url", 0.2)).toBeCloseTo(1.25, 9);
    expect(nightDepth("url", 0)).toBe(1.25);
    expect(nightDepth("url", Number.NaN)).toBe(1);
  });

  it("keeps more of the territory zoomed out, and nothing at depth 0", () => {
    const far = nightLook(1, 0.7);
    const near = nightLook(1, 11);
    expect(far.fillKeep).toBeGreaterThan(near.fillKeep);
    expect(far.borderKeep).toBeGreaterThan(near.borderKeep);
    expect(far.borderKeep).toBeGreaterThan(far.fillKeep);
    expect(far.wideGlow).toBe(1);
    expect(nightLook(1, 5).wideGlow).toBe(0);
    const day = nightLook(0, 1.8);
    expect(day).toMatchObject({
      fillKeep: 0,
      borderKeep: 0,
      desaturate: 0,
      cityLight: 0,
      emberGain: 1,
      windows: 0,
      units: 0,
      wideGlow: 0,
    });
  });

  it("self-lights the unit models more zoomed out (ships read on the sea)", () => {
    // Self-light = 0.08 × units (the part material's factor).
    expect(0.08 * nightLook(1, 0.7).units).toBeCloseTo(0.35, 9);
    expect(0.08 * nightLook(1, 1.8).units).toBeCloseTo(0.35, 9);
    expect(0.08 * nightLook(1, 11).units).toBeCloseTo(0.13, 9);
    expect(nightLook(1, 5).units).toBeLessThan(nightLook(1, 2).units);
  });
});

describe("structure lights", () => {
  it("grow with a city's level, capped; ports and factories are smaller", () => {
    let last = structureLight("City", 1)!;
    for (const lv of [2, 4, 8, 16, 22]) {
      const l = structureLight("City", lv)!;
      expect(l.radius).toBeGreaterThan(last.radius);
      expect(l.intensity).toBeGreaterThan(last.intensity);
      expect(l.radius).toBeLessThanOrEqual(NIGHT_LIGHT_MAX_RADIUS);
      last = l;
    }
    expect(structureLight("City", 1000)!.radius).toBe(NIGHT_LIGHT_MAX_RADIUS);
    for (const t of ["Port", "Factory", "Defense Post", "Missile Silo"]) {
      const l = structureLight(t, 1)!;
      expect(l.radius).toBeLessThan(structureLight("City", 1)!.radius);
    }
    expect(structureLight("Trade Ship", 1)).toBeNull();
    expect(structureLight("Train", 1)).toBeNull();
    const uc = structureLight("City", 4, true)!;
    expect(uc.intensity).toBeCloseTo(structureLight("City", 4)!.intensity / 4);
    // The wide glow reaches further, fainter.
    expect(last.wideRadius).toBeGreaterThan(last.radius);
    expect(last.wideIntensity).toBeLessThan(last.intensity);
  });

  it("lights more windows in bigger cities", () => {
    expect(windowShare("City", 1)).toBeCloseTo(0.3, 9);
    expect(windowShare("City", 6)).toBeGreaterThan(windowShare("City", 2));
    expect(windowShare("City", 1e6)).toBeLessThanOrEqual(0.8);
    expect(windowShare("Factory", 1)).toBeGreaterThan(windowShare("Port", 1));
  });

  it("has a kernel of 1 at the centre, 0 from the radius, decreasing", () => {
    expect(lightKernel(0, 10)).toBeCloseTo(1, 9);
    expect(lightKernel(10, 10)).toBe(0);
    expect(lightKernel(12, 10)).toBe(0);
    let prev = 2;
    for (let d = 0; d < 10; d += 0.25) {
      const k = lightKernel(d, 10);
      expect(k).toBeLessThan(prev);
      prev = k;
    }
    expect(wideKernel(0, 30)).toBe(1);
    expect(wideKernel(30, 30)).toBe(0);
  });

  it("encodes light in 8 bits with fine steps in the dark, soft-capped", () => {
    expect(lightmapEncode(0)).toBe(0);
    expect(lightmapDecode(0)).toBe(0);
    expect(lightmapDecode(255)).toBeCloseTo(LIGHTMAP_MAX, 9);
    expect(lightmapCap(100)).toBeLessThanOrEqual(LIGHTMAP_MAX);
    let last = -1;
    for (let v = 0; v <= 6; v += 0.05) {
      const e = lightmapEncode(v);
      expect(e).toBeGreaterThanOrEqual(last);
      last = e;
      // Within one 8-bit step of the capped value.
      const c = lightmapCap(v);
      const step = (2 * Math.sqrt(c / LIGHTMAP_MAX) + 1 / 255) / 255;
      expect(Math.abs(lightmapDecode(e) - c)).toBeLessThanOrEqual(
        LIGHTMAP_MAX * step + 1e-9,
      );
    }
    // A faint halo (0.01) is not rounded to black.
    expect(lightmapEncode(0.01)).toBeGreaterThan(0);
  });

  it("sizes the lightmap at ~128k texels at most (4 tiles a texel on World)", () => {
    expect(lightmapScale(2000, 1000)).toBe(4);
    expect(lightmapScale(200, 100)).toBe(2);
    const lm = new NightLightmap(2000, 1000);
    expect(lm.width).toBe(502);
    expect(lm.height).toBe(252);
    expect(lm.data.byteLength).toBe(502 * 252 * 4);
  });
});

describe("NightLightmap", () => {
  it("matches a brute-force sum of every light, with a black margin", () => {
    const lm = new NightLightmap(W, H);
    const lights = [
      { x: 20, y: 20, type: "City", level: 4 },
      { x: 30, y: 24, type: "Factory", level: 1 },
      { x: 70, y: 40, type: "Port", level: 2 },
      { x: 2, y: 60, type: "City", level: 1 },
    ];
    lm.setStructures(
      units(
        ...lights.map((l, k) => unit(k + 1, l.type, l.x, l.y, l.level)),
        unit(9, "Trade Ship", 50, 50),
      ),
    );
    expect(lm.lightCount).toBe(4);
    drain(lm);
    for (let j = 0; j < lm.height; j++) {
      for (let i = 0; i < lm.width; i++) {
        const got = lm.texel(i, j);
        const margin =
          i === 0 || j === 0 || i === lm.width - 1 || j === lm.height - 1;
        const want = margin ? [0, 0, 0, 0] : bruteTexel(lm, lights, i, j);
        for (let c = 0; c < 4; c++) {
          // The core kernel comes from a table: within a step or two.
          expect(Math.abs(got[c] - want[c])).toBeLessThan(0.03);
        }
      }
    }
  });

  it("rebuilds only around what changed, and clears a removed light", () => {
    const lm = new NightLightmap(W, H);
    const a = unit(1, "City", 20, 20, 2);
    const b = unit(2, "City", 75, 45, 1);
    lm.setStructures(units(a, b));
    drain(lm);
    // Same structures: nothing to do.
    lm.setStructures(units(a, b));
    expect(lm.queue.empty).toBe(true);
    // A level change and a removal mark cells; the rest of the map stays.
    const before = lm.rectsBuilt;
    lm.setStructures(units({ ...a, level: 3 }));
    expect(lm.queue.empty).toBe(false);
    drain(lm);
    expect(lm.rectsBuilt).toBeGreaterThan(before);
    expect(lm.lightCount).toBe(1);
    const S = lm.scale;
    const at = (x: number, y: number) =>
      lm.texel(Math.floor(x / S) + 1, Math.floor(y / S) + 1);
    expect(at(75, 45)[0]).toBe(0);
    expect(at(75, 45)[3]).toBe(0);
    expect(at(20, 20)[0]).toBeGreaterThan(0.5);
  });

  it("stays within its per-frame budget, the rest left dirty", () => {
    const lm = new NightLightmap(SET_W, SET_H);
    lm.setStructures(lateGameStructures(400));
    const pending = lm.queue.pendingCells;
    expect(pending).toBeGreaterThan(0);
    const rects = lm.rebuild(LIGHTMAP_BUDGET);
    expect(rects.length).toBeLessThanOrEqual(LIGHTMAP_BUDGET.maxCalls);
    // A time budget of 0: one rectangle, the others marked dirty again.
    const one = lm.rebuild(LIGHTMAP_BUDGET, 0);
    expect(one.length).toBe(1);
    expect(lm.queue.empty).toBe(false);
  });

  it("builds a late-game map (400 structures, World size) in bounded JS", () => {
    const lm = new NightLightmap(SET_W, SET_H);
    const set = lateGameStructures(400);
    const t0 = performance.now();
    lm.setStructures(set);
    const diffMs = performance.now() - t0;
    let worst = 0;
    let total = 0;
    let frames = 0;
    while (!lm.queue.empty && frames < 10_000) {
      const a = performance.now();
      lm.rebuild(LIGHTMAP_BUDGET, 1);
      const ms = performance.now() - a;
      worst = Math.max(worst, ms);
      total += ms;
      frames++;
    }
    expect(lm.queue.empty).toBe(true);
    // Loose bounds (jsdom, shared CI machines); the README has the numbers.
    expect(diffMs).toBeLessThan(20);
    expect(worst).toBeLessThan(25);
    expect(total).toBeLessThan(1500);
    // An unchanged set costs a diff and no rebuild.
    lm.setStructures(set);
    expect(lm.queue.empty).toBe(true);
  });
});

describe("flashes", () => {
  it("rise, flash and fade over about a second", () => {
    const life = 1500;
    expect(nightFlashEnvelope(-1, life)).toBe(0);
    expect(nightFlashEnvelope(0, life)).toBe(0);
    expect(nightFlashEnvelope(life, life)).toBe(0);
    const at = [100, 300, 600, 1000].map((t) => nightFlashEnvelope(t, life));
    expect(at[0]).toBeGreaterThan(0.45);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeLessThan(at[i - 1]);
    expect(at[3]).toBeGreaterThan(0);
    expect(at[3]).toBeLessThan(0.06);
    // White-hot, then the fireball's orange.
    const c0 = nightFlashColor(0);
    const c1 = nightFlashColor(600);
    expect(c0[2]).toBeGreaterThan(0.85);
    expect(c1[2]).toBeLessThan(0.3);
    expect(c1[1]).toBeLessThan(c0[1]);
  });

  it("fall off from 1 at the centre to 0 at the radius", () => {
    expect(flashFalloff(0)).toBe(1);
    expect(flashFalloff(1)).toBe(0);
    expect(flashFalloff(2)).toBe(0);
    expect(flashFalloff(0.5)).toBeCloseTo(0.75 ** 2 / (1 + 5 * 0.25), 9);
  });

  it("keep the brightest in a few slots", () => {
    const f = new NightFlashes();
    const flash = (peak: number, startMs: number) =>
      f.flash(
        { x: 0, y: 1, z: 0, radius: 10, peak, lifeMs: 1000, startMs },
        startMs,
      );
    for (let i = 0; i < NIGHT_FLASH_SLOTS; i++) expect(flash(5, 0)).toBe(true);
    expect(f.activeCount(10)).toBe(NIGHT_FLASH_SLOTS);
    // A burning building does not steal a nuke's slot...
    expect(flash(0.5, 20)).toBe(false);
    expect(f.dropped).toBe(1);
    // ...a brighter flash takes the dimmest.
    expect(flash(8, 900)).toBe(true);
    expect(f.activeCount(1500)).toBe(1);
    expect(f.activeCount(2000)).toBe(0);
  });

  it("are sized by the impact (nukes by their visual radius)", () => {
    const atom = nightFlashFor("nuke", 30);
    const hydrogen = nightFlashFor("nuke", 69);
    expect(atom.radius).toBe(60);
    expect(hydrogen.radius).toBeGreaterThan(atom.radius);
    expect(hydrogen.lifeMs).toBeGreaterThan(atom.lifeMs);
    expect(nightFlashFor("nuke", 30, 0.5).peak).toBe(atom.peak / 2);
    for (const k of ["intercept", "explosion", "sinking"] as const) {
      expect(nightFlashFor(k, 2).peak).toBeLessThan(atom.peak);
    }
  });
});

describe("night GLSL", () => {
  it("mirrors the TypeScript constants and curves", () => {
    expect(NIGHT_GLSL).toContain(
      `const float NIGHT_LIGHTMAP_MAX = ${LIGHTMAP_MAX.toFixed(1)};`,
    );
    expect(NIGHT_GLSL).toContain(`uniform vec4 uFlash[${NIGHT_FLASH_SLOTS}];`);
    expect(NIGHT_GLSL).toContain("w * w / (1.0 + 5.0 * x * x)");
    // e^2 decoding of the sqrt encoding.
    expect(NIGHT_GLSL).toContain("vec4 l = e * e * NIGHT_LIGHTMAP_MAX;");
  });

  it("is compiled out of the terrain and water shaders without the define", () => {
    for (const src of [TERRAIN_FRAG, WATER_FRAG]) {
      expect(src).toContain("#ifdef NIGHT");
      const off = withoutNight(src);
      for (const id of [
        "uNightMap",
        "uNightLook",
        "uFlash",
        "nightCityLight",
        "nightFlashLight",
        "nightWater",
        "NIGHT_DAY_FLAT",
      ]) {
        expect(off).not.toContain(id);
      }
    }
    // Nothing of the night outside its blocks, not even a macro.
    expect(withoutNight(TERRAIN_FRAG).replace(/\/\/.*$/gm, "")).not.toMatch(
      /NIGHT/,
    );
    // The off path is the day's own line (byte for byte, as before lot 4).
    expect(withoutNight(TERRAIN_FRAG)).toContain(
      "vec3 lit = srgbToLinear(albedo) * shading + emissive;",
    );
  });
});

describe("lit windows", () => {
  it("marks whole wall faces of a structure, not roofs, pads or units", () => {
    const g = createStructureGeometry("City", 3)!;
    const plain = g.getAttribute("aGlow");
    for (let i = 0; i < plain.count; i++) {
      expect(plain.getX(i)).toBeGreaterThanOrEqual(0);
    }
    const share = windowShare("City", 3);
    addWindowMask(g, share);
    const glow = g.getAttribute("aGlow");
    const nor = g.getAttribute("normal");
    let marked = 0;
    for (let i = 0; i < glow.count; i += 3) {
      const v = [glow.getX(i), glow.getX(i + 1), glow.getX(i + 2)];
      // One value per face.
      expect(v[1]).toBe(v[0]);
      expect(v[2]).toBe(v[0]);
      if (v[0] < 0) {
        marked++;
        expect(v[0]).toBeCloseTo(-share, 6);
        expect(Math.abs(nor.getY(i))).toBeLessThan(0.3);
      }
    }
    expect(marked).toBeGreaterThan(20);
    g.dispose();
    // No glass or plastered walls on a hull: nothing marked.
    const ship = addWindowMask(createUnitGeometry(UnitMesh.TradeShip), 0.5);
    const sg = ship.getAttribute("aGlow");
    for (let i = 0; i < sg.count; i++) {
      expect(sg.getX(i)).toBeGreaterThanOrEqual(0);
    }
    ship.dispose();
  });

  it("compiles in only with the night option", () => {
    const glow = { value: 1 };
    const off = createPartMaterial({ glow, conform: true });
    const on = createPartMaterial({ glow, conform: true, night: { value: 1 } });
    expect(off.defines?.NIGHT_WINDOWS).toBeUndefined();
    expect(on.defines?.NIGHT_WINDOWS).toBe("");
    expect(on.customProgramCacheKey()).not.toBe(off.customProgramCacheKey());
    off.dispose();
    on.dispose();
  });
});

describe("SceneEnvironment night depth", () => {
  it("swaps the sun for a dim moon and comes back to the day exactly", () => {
    const { ctx } = makeCtx(true);
    const env = new SceneEnvironment(ctx);
    const day = {
      sun: env.sun.intensity,
      irr: env.uniforms.uSunIrradiance.value.clone(),
      zenith: env.uniforms.uSkyZenith.value.clone(),
      fog: env.fog.color.clone(),
    };
    env.setNightDepth(1);
    expect(env.sun.intensity).toBeCloseTo(NIGHT_ENVIRONMENT.moonIntensity, 9);
    expect(env.uniforms.uSunIrradiance.value.r).toBeLessThan(day.irr.r / 3);
    expect(env.fog.color.equals(env.uniforms.uSkyHorizon.value)).toBe(true);
    env.setNightDepth(1.25);
    expect(env.sun.intensity).toBeCloseTo(
      NIGHT_ENVIRONMENT.moonIntensity * 0.5,
      9,
    );
    env.setNightDepth(0);
    expect(env.sun.intensity).toBe(SUN_INTENSITY);
    expect(env.uniforms.uSunIrradiance.value.r).toBeCloseTo(day.irr.r, 6);
    expect(env.uniforms.uSkyZenith.value.b).toBeCloseTo(day.zenith.b, 6);
    expect(env.fog.color.r).toBeCloseTo(day.fog.r, 6);
    env.dispose();
  });

  it("measures the day brightness the territory keeps a share of", () => {
    const f = dayFlatLight();
    for (const c of f) {
      expect(c).toBeGreaterThan(0.7);
      expect(c).toBeLessThan(1.1);
    }
  });
});

describe("night in the layers", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
  });

  it("creates nothing without the flag (terrain, water, structures, units, FX)", () => {
    const { ctx } = makeCtx(false);
    const terrain = new TerrainLayer(ctx);
    const water = new WaterLayer(ctx);
    const fx = new FxLayer(ctx);
    disposers.push(() => {
      fx.dispose();
      water.dispose();
      terrain.dispose();
    });
    expect(terrain.night).toBeNull();
    terrain.update(frame(1000, 2));
    const stats = terrain.perfStats();
    expect(Object.keys(stats).filter((k) => k.startsWith("night"))).toEqual([]);
    const materials: THREE.Material[] = [];
    ctx.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m !== undefined && !materials.includes(m)) materials.push(m);
    });
    expect(materials.length).toBeGreaterThan(3);
    for (const m of materials) {
      const d = (m as THREE.ShaderMaterial).defines ?? {};
      expect(d.NIGHT).toBeUndefined();
      expect(d.NIGHT_WINDOWS).toBeUndefined();
      const u = (m as THREE.ShaderMaterial).uniforms ?? {};
      expect(u.uNightMap).toBeUndefined();
      expect(u.uNightSmoke).toBeUndefined();
    }
    // A nuke flashes FxLayer's point lights only.
    fx.applyDeadUnits([
      {
        unitType: "Atom Bomb",
        pos: 20 * W + 20,
        reachedTarget: true,
        ownerSmallID: 1,
      },
    ]);
    fx.update(frame(1000, 2));

    const set = makeSetContext();
    const structures = new StructureLayer(set);
    const unitsLayer = new UnitLayer(set);
    disposers.push(() => {
      structures.dispose();
      unitsLayer.dispose();
    });
    const sm = (structures as unknown as { material: THREE.Material }).material;
    const um = (unitsLayer as unknown as { material: THREE.Material }).material;
    expect(sm.defines?.NIGHT_WINDOWS).toBeUndefined();
    expect(um.defines?.NIGHT_WINDOWS).toBeUndefined();
  });

  it("with the flag: defines, shared uniforms, counters, lightmap uploads", () => {
    const { ctx, rects } = makeCtx(true);
    const env = new SceneEnvironment(ctx);
    const terrain = new TerrainLayer(ctx);
    const water = new WaterLayer(ctx);
    const fx = new FxLayer(ctx);
    disposers.push(() => {
      fx.dispose();
      water.dispose();
      terrain.dispose();
      env.dispose();
    });
    const night = terrain.night!;
    expect(night).not.toBeNull();
    expect(night.mode).toBe("url");
    const tm = (terrain as unknown as { material: THREE.ShaderMaterial })
      .material;
    const wm = (water as unknown as { material: THREE.ShaderMaterial })
      .material;
    expect(tm.defines.NIGHT).toBe("");
    expect(wm.defines.NIGHT).toBe("");
    // The same uniform objects (one texture, one set of flash slots).
    expect(tm.uniforms.uNightMap).toBe(wm.uniforms.uNightMap);
    expect(tm.uniforms.uFlash).toBe(wm.uniforms.uFlash);

    night.setStructures(units(unit(1, "City", 40, 30, 8)));
    const before = rects.length;
    terrain.update(frame(1000, 2));
    const lmRects = rects
      .slice(before)
      .filter((r) => r.target === night.texture);
    expect(lmRects.length).toBeGreaterThan(0);
    expect(lmRects.length).toBeLessThanOrEqual(LIGHTMAP_BUDGET.maxCalls);
    const s = terrain.perfStats();
    for (const k of [
      "nightLightmapBuilds",
      "nightLightmapMs",
      "nightLights",
      "nightFlashLights",
    ]) {
      expect(s[k]).toBeTypeOf("number");
    }
    expect(s.nightLights).toBe(1);
    expect(s.nightDepth).toBe(1);
    // The moonlit environment.
    expect(env.sun.intensity).toBeCloseTo(NIGHT_ENVIRONMENT.moonIntensity, 9);

    // A nuke impact lights the ground: one flash slot live, then none.
    fx.applyDeadUnits([
      {
        unitType: "Atom Bomb",
        pos: 30 * W + 40,
        reachedTarget: true,
        ownerSmallID: 1,
        tickAge: 0,
      },
    ]);
    fx.update(frame(2000, 2));
    expect(night.flashes.started).toBe(1);
    terrain.update(frame(2100, 2));
    expect(terrain.perfStats().nightFlashLights).toBe(1);
    expect(tm.uniforms.uFlashN.value).toBe(1);
    const col = (tm.uniforms.uFlashCol.value as THREE.Vector4[])[0];
    expect(col.x).toBeGreaterThan(1);
    terrain.update(frame(6000, 2));
    expect(tm.uniforms.uFlashN.value).toBe(0);
    // The smoke material dims its lit colours at night.
    let smoke: THREE.ShaderMaterial | null = null;
    ctx.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial;
      if (m?.name === "fx-smoke") smoke = m;
    });
    expect(smoke!.defines.NIGHT).toBe("");
    expect(smoke!.uniforms.uNightSmoke.value).toBeLessThan(1);
  });

  it("is one shared, refcounted night per scene", () => {
    const { ctx } = makeCtx(true);
    const a = NightLighting.acquire(ctx, "url");
    const b = NightLighting.acquire(ctx, "url");
    expect(b).toBe(a);
    const terrain = new TerrainLayer(ctx);
    expect(terrain.night).toBe(a);
    terrain.dispose();
    a.release();
    b.release();
    // All released: a new acquire builds a new one.
    const c = NightLighting.acquire(ctx, "url");
    expect(c).not.toBe(a);
    c.release();
  });

  it("ignores the night graphics preset without the flag (zero cost)", () => {
    const { ctx } = makeCtx(false, NIGHT_PRESET_AMBIENT);
    expect(ctx.renderSettings.lighting.enabled).toBe(true);
    const terrain = new TerrainLayer(ctx);
    disposers.push(() => terrain.dispose());
    expect(terrain.night).toBeNull();
    const tm = (terrain as unknown as { material: THREE.ShaderMaterial })
      .material;
    expect(tm.defines?.NIGHT).toBeUndefined();
    expect("uNightMap" in tm.uniforms).toBe(false);
  });

  it("deepens live with a darker ambient setting (flag on)", () => {
    const { ctx } = makeCtx(true, NIGHT_PRESET_AMBIENT);
    const terrain = new TerrainLayer(ctx);
    disposers.push(() => terrain.dispose());
    const night = terrain.night!;
    expect(night.mode).toBe("url");
    terrain.update(frame(1000, 2));
    expect(night.currentDepth).toBeCloseTo(1, 9);
    ctx.renderSettings.lighting.ambient = 0.2;
    terrain.update(frame(1016, 2));
    expect(night.currentDepth).toBeCloseTo(1.25, 9);
    ctx.renderSettings.lighting.ambient = 1;
    terrain.update(frame(1032, 2));
    expect(night.currentDepth).toBe(1);
  });

  it("puts lit windows on the structure models and self-light on units", () => {
    const set = makeSetContext({
      prototypes: { wakes: false, front: false, night: true },
    });
    const structures = new StructureLayer(set);
    const unitsLayer = new UnitLayer(set);
    disposers.push(() => {
      structures.dispose();
      unitsLayer.dispose();
    });
    const sm = (structures as unknown as { material: THREE.Material }).material;
    const um = (unitsLayer as unknown as { material: THREE.Material }).material;
    expect(sm.defines?.NIGHT_WINDOWS).toBe("");
    expect(um.defines?.NIGHT_WINDOWS).toBe("");
    structures.updateStructures(lateGameStructures(60));
    const templates = (
      structures as unknown as {
        templateFor(
          key: string,
          type: string,
          variant: number,
          lod: boolean,
        ): THREE.BufferGeometry | null;
      }
    ).templateFor("City#2", "City", 2, false)!;
    const glow = templates.getAttribute("aGlow");
    let negative = 0;
    for (let i = 0; i < glow.count; i++) if (glow.getX(i) < 0) negative++;
    expect(negative).toBeGreaterThan(0);
  });

  it("gives the units their own self-light uniform, by zoom", () => {
    const { ctx } = makeCtx(true);
    const terrain = new TerrainLayer(ctx);
    disposers.push(() => terrain.dispose());
    const night = terrain.night!;
    terrain.update(frame(1000, 0.7));
    expect(night.unitUniform.value).toBeCloseTo(nightLook(1, 0.7).units, 9);
    expect(night.windowUniform.value).toBeCloseTo(nightLook(1, 0.7).windows, 9);
    terrain.update(frame(1016, 11));
    expect(night.unitUniform.value).toBeCloseTo(nightLook(1, 11).units, 9);
  });

  it("lets the rails glow faintly at night (never black lines), not by day", () => {
    const parent = new THREE.Group();
    const hf = new HeightField(W, H, new Uint8Array(W * H).fill(0x80 | 4), {
      heightScale: 1,
      seabedDepth: 1,
      targetVertices: (W * H) / 4,
    });
    const strip = (rails: RailTracks) =>
      (rails as unknown as { stripMaterial: THREE.MeshStandardMaterial })
        .stripMaterial;
    const day = new RailTracks(parent, hf, W, H, { quality: "high" });
    const nightRails = new RailTracks(parent, hf, W, H, {
      quality: "high",
      prototypes: { wakes: false, front: false, night: true },
    });
    disposers.push(() => {
      day.dispose();
      nightRails.dispose();
    });
    for (const r of [day, nightRails]) {
      (
        r as unknown as { updateStripLook(z: number, d: number): void }
      ).updateStripLook(4, 1);
    }
    expect(strip(day).emissive.getHex()).toBe(0);
    const m = strip(nightRails);
    expect(m.emissive.r).toBeCloseTo(m.color.r * RAIL_NIGHT_GLOW, 6);
    expect(m.emissive.g).toBeCloseTo(m.color.g * RAIL_NIGHT_GLOW, 6);
  });
});

describe("ThreeMapRenderer night wiring", () => {
  const PALETTE = getPaletteSize();
  const views: ThreeMapRenderer[] = [];
  afterEach(() => {
    for (const v of views.splice(0)) v.dispose();
  });

  function makeView(night: boolean, ambient = 1) {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    let pending: FrameRequestCallback | null = null;
    const terrain = new Uint8Array(W * H).fill(0x80 | 4);
    const settings = createRenderSettings();
    if (ambient < 1) {
      settings.lighting.ambient = ambient;
      settings.lighting.enabled = true;
    }
    const view = new ThreeMapRenderer(
      canvas,
      { mapWidth: W, mapHeight: H, players: [] } as unknown as RendererConfig,
      () => terrain,
      new Float32Array(PALETTE * 2 * 4),
      { msPerTick: () => 100 } as unknown as Config,
      settings,
      (cb) => {
        pending = cb;
        return 1;
      },
      () => {
        pending = null;
      },
      {
        ...defaultThreeSettings(),
        bloom: false,
        perf: true,
        prototypes: { wakes: false, front: false, night },
      },
    );
    views.push(view);
    const frame = (): void => {
      const cb = pending;
      pending = null;
      cb?.(performance.now());
    };
    const terrainLayer = (
      view as unknown as { terrain: { night: NightLighting | null } }
    ).terrain;
    return { view, frame, night: terrainLayer.night };
  }

  it("feeds the structures to the city lights (updateStructures)", () => {
    const { view, frame, night } = makeView(true);
    expect(night).not.toBeNull();
    view.updateStructures(
      units(unit(1, "City", 30, 30, 5), unit(2, "Port", 60, 20, 1)),
    );
    expect(night!.lightmap.lightCount).toBe(2);
    for (let i = 0; i < 20 && !night!.lightmap.queue.empty; i++) frame();
    expect(night!.lightmap.queue.empty).toBe(true);
  });

  it("turns the names light at night only (a CSS class, no per-frame work)", () => {
    const names = (v: ThreeMapRenderer) =>
      (v as unknown as { names: { container: HTMLDivElement } }).names
        .container;
    const day = names(makeView(false).view);
    expect(day.classList.contains("ofn-night")).toBe(false);
    expect(day.querySelector("style")!.textContent).not.toContain("ofn-night");
    const night = names(makeView(true).view);
    expect(night.classList.contains("ofn-night")).toBe(true);
    expect(night.querySelector("style")!.textContent).toContain(
      NIGHT_NAME_CSS.trim(),
    );
  });

  it("is off by default and with the night preset, on with the flag", () => {
    expect(makeView(false).night).toBeNull();
    expect(makeView(false, NIGHT_PRESET_AMBIENT).night).toBeNull();
    expect(makeView(true).night!.mode).toBe("url");
    // No night material anywhere without it.
    const { view } = makeView(false);
    view.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      expect(m?.defines?.NIGHT).toBeUndefined();
      expect(m?.defines?.NIGHT_WINDOWS).toBeUndefined();
    });
  });
});
