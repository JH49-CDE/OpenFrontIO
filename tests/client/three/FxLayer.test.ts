import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import {
  dragDisplacement,
  easeOutCubic,
  effectStartMs,
  FX_LIFETIME_MS,
  fireballColor,
  fireballRadiusFactor,
  FxKind,
  FxLayer,
  fxKindForDeadUnit,
  isEffectExpired,
  lightFlashFactor,
  mulberry32,
  NUKE_VISUAL_SCALE,
  nukeOuterRadius,
  nukeVisualRadius,
  particleEnvelope,
  shockwaveAlpha,
  shockwaveParams,
  smokePuffTexels,
  softCircleTexels,
} from "../../../src/client/render/three/FxLayer";
import type { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import type { DeadUnitFx } from "../../../src/client/render/types";

const dead = (
  unitType: string,
  reachedTarget: boolean,
  pos = 0,
  tickAge = 0,
): DeadUnitFx => ({ unitType, pos, reachedTarget, ownerSmallID: 1, tickAge });

describe("dead unit → effect", () => {
  it("maps unit types like the default FxPass", () => {
    expect(fxKindForDeadUnit(dead("Atom Bomb", true))).toBe(FxKind.Nuke);
    expect(fxKindForDeadUnit(dead("Hydrogen Bomb", true))).toBe(FxKind.Nuke);
    expect(fxKindForDeadUnit(dead("MIRV Warhead", true))).toBe(FxKind.Nuke);
    expect(fxKindForDeadUnit(dead("Atom Bomb", false))).toBe(
      FxKind.NukeIntercepted,
    );
    expect(fxKindForDeadUnit(dead("MIRV Warhead", false))).toBe(
      FxKind.NukeIntercepted,
    );
    expect(fxKindForDeadUnit(dead("Warship", false))).toBe(FxKind.WarshipSunk);
    expect(fxKindForDeadUnit(dead("Shell", true))).toBe(FxKind.ShellHit);
    expect(fxKindForDeadUnit(dead("Shell", false))).toBeNull();
    expect(fxKindForDeadUnit(dead("Train", false))).toBe(FxKind.TrainDestroyed);
    expect(fxKindForDeadUnit(dead("Train", true))).toBeNull(); // arrived
    for (const s of ["City", "Port", "Factory", "Defense Post"]) {
      expect(fxKindForDeadUnit(dead(s, false))).toBe(FxKind.StructureDestroyed);
    }
    for (const n of ["MIRV", "Transport", "Trade Ship", "SAMMissile"]) {
      expect(fxKindForDeadUnit(dead(n, true))).toBeNull();
    }
  });

  it("uses the gameplay outer radii ×1.5 for shockwaves", () => {
    expect(nukeOuterRadius("Atom Bomb")).toBe(30);
    expect(nukeOuterRadius("Hydrogen Bomb")).toBe(100);
    expect(nukeOuterRadius("MIRV Warhead")).toBe(18);
    expect(nukeOuterRadius("MIRV")).toBe(0);
    expect(shockwaveParams(30, undefined).radius).toBe(45);
    expect(shockwaveParams(100, undefined).radius).toBe(150);
    expect(shockwaveParams(18, undefined).durationMs).toBe(1500);
  });

  it("sizes the cloud like the default renderer's per-type radii", () => {
    const fx = createRenderSettings().fx;
    // Atom bomb: visual radius = its gameplay outer radius.
    expect(nukeVisualRadius("Atom Bomb", fx)).toBeCloseTo(30, 9);
    expect(nukeVisualRadius("Hydrogen Bomb", fx)).toBeCloseTo(
      fx.nukeRadiusHydro * NUKE_VISUAL_SCALE,
      9,
    );
    expect(
      nukeVisualRadius("Hydrogen Bomb", fx) / nukeVisualRadius("Atom Bomb", fx),
    ).toBeCloseTo(fx.nukeRadiusHydro / fx.nukeRadiusAtom, 9);
    expect(nukeVisualRadius("MIRV Warhead", fx)).toBeCloseTo(
      fx.nukeRadiusMirv * NUKE_VISUAL_SCALE,
      9,
    );
    expect(nukeVisualRadius("MIRV", fx)).toBe(0);
    expect(nukeVisualRadius("City", fx)).toBe(0);
  });

  it("lets a nuke-explosion cosmetic override the ring", () => {
    const p = shockwaveParams(30, {
      type: "shockwave",
      colors: [[0.6, 0.1, 1]],
      maxRadius: 80,
      speed: 100,
      transitionSpeed: 0,
    });
    expect(p.radius).toBe(80);
    expect(p.durationMs).toBe(1600); // 2 · maxRadius / speed seconds
    expect(p.color[0]).toBeCloseTo(1.5, 12);
    expect(p.color[2]).toBeCloseTo(2.5, 12);
  });
});

describe("effect timing", () => {
  it("starts replayed events tickAge ticks in the past", () => {
    expect(effectStartMs(10_000, undefined, 100)).toBe(10_000);
    expect(effectStartMs(10_000, 3, 100)).toBe(9_700);
    expect(effectStartMs(10_000, -2, 100)).toBe(10_000);
  });

  it("expires effects at their lifetime", () => {
    const life = FX_LIFETIME_MS[FxKind.Nuke];
    expect(isEffectExpired(life - 1, 0, life)).toBe(false);
    expect(isEffectExpired(life, 0, life)).toBe(true);
    for (const v of Object.values(FX_LIFETIME_MS)) expect(v).toBeGreaterThan(0);
  });
});

describe("curves", () => {
  it("easeOutCubic spans 0..1 monotonically", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    let prev = -1;
    for (let u = 0; u <= 1; u += 0.05) {
      const v = easeOutCubic(u);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("drag displacement integrates e^(-kt)", () => {
    expect(dragDisplacement(0, 1)).toBe(0);
    expect(dragDisplacement(2, 0)).toBe(2);
    // small t: ≈ t (velocity barely damped)
    expect(dragDisplacement(1e-4, 0.8)).toBeCloseTo(1e-4, 8);
    // asymptote 1/k
    expect(dragDisplacement(100, 0.8)).toBeCloseTo(1 / 0.8, 9);
    // numeric integral check
    const k = 1.3;
    const t = 0.7;
    let sum = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) sum += Math.exp(-k * ((i + 0.5) / n) * t);
    expect(dragDisplacement(t, k)).toBeCloseTo((sum / n) * t, 6);
  });

  it("particle envelope fades in, peaks at 1 and ends at 0", () => {
    expect(particleEnvelope(0, 0.1)).toBe(0);
    expect(particleEnvelope(0.05, 0.1)).toBeCloseTo(0.5, 12);
    expect(particleEnvelope(0.1, 0.1)).toBe(1);
    expect(particleEnvelope(1, 0.1)).toBe(0);
    for (let u = 0; u <= 1; u += 0.01) {
      const v = particleEnvelope(u, 0.1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("particle envelope holds full opacity for `hold` of the life", () => {
    expect(particleEnvelope(0.02, 0.04, 0.4)).toBeCloseTo(0.5, 12);
    for (const u of [0.04, 0.2, 0.44]) {
      expect(particleEnvelope(u, 0.04, 0.4)).toBe(1);
    }
    expect(particleEnvelope(0.5, 0.04, 0.4)).toBeLessThan(1);
    expect(particleEnvelope(0.5, 0.04, 0.4)).toBeGreaterThan(
      particleEnvelope(0.5, 0.04),
    );
    expect(particleEnvelope(1, 0.04, 0.4)).toBe(0);
    // hold = 0 is the plain envelope.
    expect(particleEnvelope(0.6, 0.1, 0)).toBe(particleEnvelope(0.6, 0.1));
  });

  it("fireball expands fast, swells slowly and cools to black", () => {
    expect(fireballRadiusFactor(0)).toBe(0);
    expect(fireballRadiusFactor(0.2)).toBeCloseTo(0.9, 12);
    expect(fireballRadiusFactor(1)).toBeCloseTo(1.15, 12);
    expect(fireballRadiusFactor(0.1)).toBeGreaterThan(0.6); // fast start
    const hot = fireballColor(0);
    expect(Math.min(...hot)).toBeGreaterThan(5); // white-hot, HDR
    const warm = fireballColor(0.4);
    expect(warm[0]).toBeGreaterThan(warm[1]);
    expect(warm[1]).toBeGreaterThan(warm[2]); // orange
    expect(fireballColor(1)).toEqual([0, 0, 0]);
    // cooling: red/green ratio grows over time
    const ratio = (u: number) => {
      const c = fireballColor(u);
      return c[0] / Math.max(1e-9, c[1]);
    };
    expect(ratio(0.1)).toBeLessThan(ratio(0.4));
    expect(ratio(0.4)).toBeLessThan(ratio(0.7));
  });

  it("shockwave / light curves vanish at both ends", () => {
    expect(shockwaveAlpha(0)).toBe(0);
    expect(shockwaveAlpha(1)).toBe(0);
    expect(shockwaveAlpha(0.1)).toBeGreaterThan(0.5);
    expect(lightFlashFactor(0)).toBe(0);
    expect(lightFlashFactor(1)).toBe(0);
    expect(lightFlashFactor(0.05)).toBeCloseTo(0.9025, 12);
  });

  it("mulberry32 is deterministic and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sprite textures", () => {
  const alphaAt = (t: Uint8Array, size: number, i: number, j: number) =>
    t[(j * size + i) * 4 + 3];

  it("soft circle is opaque-ish in the middle and clear at the edge", () => {
    const t = softCircleTexels(32);
    expect(alphaAt(t, 32, 16, 16)).toBeGreaterThan(240);
    expect(alphaAt(t, 32, 0, 0)).toBe(0);
    expect(alphaAt(t, 32, 0, 16)).toBe(0);
  });

  it("smoke puff is deterministic per seed with a clear border", () => {
    const a = smokePuffTexels(32, 7);
    expect(smokePuffTexels(32, 7)).toEqual(a);
    expect(smokePuffTexels(32, 8)).not.toEqual(a);
    expect(alphaAt(a, 32, 16, 16)).toBeGreaterThan(200);
    expect(alphaAt(a, 32, 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer behaviour (no GL needed: only CPU-side state is inspected)
// ---------------------------------------------------------------------------

const MAP_W = 400;

function makeCtx(quality: "high" | "low" = "high") {
  const settings = defaultThreeSettings();
  settings.quality = quality;
  const ctx: ThreeLayerContext = {
    renderer: {} as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: MAP_W,
    mapHeight: 300,
    heightField: { surfaceAt: () => 1 } as unknown as HeightField,
    palette: new PaletteView(),
    settings,
    renderSettings: createRenderSettings(),
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
  return ctx;
}

function frame(nowMs: number): FrameInfo {
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: new THREE.PerspectiveCamera(),
    cssPxPerTile: 1,
    tilt: 0,
    cssWidth: 1000,
    cssHeight: 800,
    dpr: 1,
    localPlayerID: 0,
    highlightOwner: 0,
    altView: false,
  };
}

describe("FxLayer", () => {
  it("spawns a nuke on the next frame and cleans it up after its life", () => {
    const ctx = makeCtx();
    const fx = new FxLayer(ctx);
    expect(ctx.scene.getObjectByName("fx")).toBeDefined();
    fx.applyDeadUnits([dead("Atom Bomb", true, 120 * MAP_W + 200)]);
    expect(fx.stats().pending).toBe(1);
    fx.update(frame(1000));
    const s = fx.stats();
    expect(s.pending).toBe(0);
    expect(s.fireballs).toBe(1);
    expect(s.decals).toBe(2); // shockwave + ground flash
    expect(s.glow).toBeGreaterThan(8);
    expect(s.smoke).toBeGreaterThan(20);
    expect(s.live).toBe(1);

    // 4 PointLights stay in the scene; the flash lights one of them.
    fx.update(frame(1050));
    const lights: THREE.PointLight[] = [];
    ctx.scene.traverse((o) => {
      if (o instanceof THREE.PointLight) lights.push(o);
    });
    expect(lights).toHaveLength(4);
    const lit = lights.filter((l) => l.intensity > 0);
    expect(lit).toHaveLength(1);
    expect(lit[0].position.x).toBeCloseTo(200.5, 9);
    expect(lit[0].position.z).toBeCloseTo(120.5, 9);

    fx.update(frame(1000 + FX_LIFETIME_MS[FxKind.Nuke] + 10));
    const done = fx.stats();
    expect(done.glow + done.smoke + done.fireballs + done.decals).toBe(0);
    expect(lights.every((l) => l.intensity === 0)).toBe(true);

    fx.dispose();
    expect(ctx.scene.getObjectByName("fx")).toBeUndefined();
  });

  it("keeps a nuke's flash short and its cloud rising", () => {
    const ctx = makeCtx();
    const fx = new FxLayer(ctx);
    fx.applyDeadUnits([dead("Hydrogen Bomb", true, 120 * MAP_W + 200)]);
    fx.update(frame(1000));
    const early = fx.stats();
    // 400 ms in: both flash billboards are over, embers and cloud remain.
    fx.update(frame(1400));
    const later = fx.stats();
    expect(later.glow).toBeLessThan(early.glow);
    expect(later.glow).toBeGreaterThan(0);
    expect(later.smoke).toBe(early.smoke);
    // The cloud outlives the fireball and the shockwave.
    fx.update(frame(1000 + 4500));
    const late = fx.stats();
    expect(late.fireballs).toBe(0);
    expect(late.smoke).toBeGreaterThan(0);
    fx.dispose();
  });

  it("skips events older than their lifetime and ignores silent units", () => {
    const fx = new FxLayer(makeCtx());
    fx.applyDeadUnits([
      dead("Shell", true, 5, 10), // 1 s old, shell flash lasts 0.4 s
      dead("Transport", false, 5),
      dead("MIRV", false, 5),
    ]);
    expect(fx.stats().pending).toBe(1);
    fx.update(frame(5000));
    const s = fx.stats();
    expect(s.pending).toBe(0);
    expect(s.live).toBe(0);
    expect(s.glow).toBe(0);
  });

  it("spreads a MIRV salvo over several frames", () => {
    const fx = new FxLayer(makeCtx());
    const warheads = Array.from({ length: 300 }, (_, i) =>
      dead("MIRV Warhead", true, 100 * MAP_W + i),
    );
    fx.applyDeadUnits(warheads);
    fx.update(frame(1000));
    const first = fx.stats();
    expect(first.live).toBe(12);
    expect(first.pending).toBe(288);
    for (let f = 1; f < 14; f++) fx.update(frame(1000 + f * 16));
    // The live-effect cap holds the rest back ...
    expect(fx.stats().live).toBe(160);
    expect(fx.stats().pending).toBe(140);
    // ... and they are dropped once they waited a second.
    for (let f = 14; f < 80; f++) fx.update(frame(1000 + f * 16));
    const s = fx.stats();
    expect(s.pending).toBe(0);
    expect(s.live).toBe(160);
    // Pools stay bounded.
    expect(s.pending).toBe(0);
    expect(s.glow).toBeLessThanOrEqual(2048);
    expect(s.smoke).toBeLessThanOrEqual(2048);
    expect(s.fireballs).toBeLessThanOrEqual(48);
    expect(s.decals).toBeLessThanOrEqual(32);
    fx.dispose();
  });

  it("sparkles for conquests and bonuses; no lights at low quality", () => {
    const ctx = makeCtx("low");
    const fx = new FxLayer(ctx);
    fx.applyConquestEvents([{ x: 10, y: 10, gold: 100 }]);
    fx.applyBonusEvents([
      { playerID: "p", smallID: 1, tile: 42, gold: 0, troops: 0 },
      { playerID: "p", smallID: 1, tile: 43, gold: 500, troops: 0 },
    ]);
    expect(fx.stats().pending).toBe(2);
    fx.update(frame(100));
    const s = fx.stats();
    expect(s.glow).toBeGreaterThan(0);
    expect(s.decals).toBe(1); // conquest ground glow
    let lights = 0;
    ctx.scene.traverse((o) => {
      if (o instanceof THREE.PointLight) lights++;
    });
    expect(lights).toBe(0);
    fx.dispose();
  });
});
