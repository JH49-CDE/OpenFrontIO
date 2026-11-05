import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import {
  captureDirection,
  FRONT_EVENTS_PER_TICK,
  FRONT_PULSE_MS,
  FRONT_PVP_BIT,
  FRONT_STALE_MS,
  FRONT_SWEEP_PERIOD,
  FRONT_TIME_MOD,
  FRONT_TIME_UNIT_MS,
  type FrontCluster,
  FrontField,
  frontAgeMs,
  frontNowUnits,
  FRONT_DECAY_S,
  FRONT_HOT_S,
  frontHeat,
  frontPulse,
  frontStamp,
  frontWaveLook,
} from "../../../src/client/render/three/FrontField";
import { FxLayer } from "../../../src/client/render/three/FxLayer";
import { HeightField } from "../../../src/client/render/three/HeightField";
import {
  FRONT_ARROW_CAP,
  FRONT_SMOKE_CAPACITY,
  FRONT_SPARK_CAPACITY,
  FRONT_SPAWN_PER_FRAME,
  frontArrowCell,
  frontArrowColor,
  frontArrowLook,
  frontEventKept,
  frontParticleLook,
  reverseClusterKey,
} from "../../../src/client/render/three/LivingFront";
import { OverlayLayer } from "../../../src/client/render/three/OverlayLayer";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { TERRAIN_FRAG } from "../../../src/client/render/three/shaders/terrain";
import { FALLOUT_BIT } from "../../../src/client/render/three/TerrainCodec";
import { TerrainLayer } from "../../../src/client/render/three/TerrainLayer";
import {
  defaultThreeSettings,
  type ThreeRenderSettings,
} from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import type { PlayerState } from "../../../src/client/render/types";
import { withoutDefines } from "./shaderDefines";

const W = 128;
const H = 96;
const A = 1; // attacker
const B = 2; // defender

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** Tile state: A owns x < split, B the rest. */
function splitState(split: number): Uint16Array {
  const t = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) t[y * W + x] = x < split ? A : B;
  }
  return t;
}

/** A takes column `x` from B (writes the state, returns the refs). */
function takeColumn(t: Uint16Array, x: number, y0 = 0, y1 = H): number[] {
  const refs: number[] = [];
  for (let y = y0; y < y1; y++) {
    t[y * W + x] = A;
    refs.push(y * W + x);
  }
  return refs;
}

function settingsWith(front: boolean, perf = true): ThreeRenderSettings {
  const s = defaultThreeSettings();
  s.perf = perf;
  s.prototypes = { wakes: false, front, night: false };
  return s;
}

/** Layer context over a stub renderer recording texture uploads. */
function makeCtx(front: boolean) {
  const terrain = new Uint8Array(W * H).fill(0x80 | 4); // all land
  const settings = settingsWith(front);
  const heightField = new HeightField(W, H, terrain, {
    heightScale: settings.heightScale,
    seabedDepth: settings.seabedDepth,
    targetVertices: (W * H) / 4,
  });
  const full: THREE.Texture[] = [];
  const rects: { target: THREE.Texture; w: number; h: number }[] = [];
  const renderer = {
    initTexture: (t: THREE.Texture) => full.push(t),
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
  const palette = new Float32Array(4096 * 2 * 4);
  palette.set([0.2, 0.25, 0.22, 1], A * 4); // a dark attacker
  palette.set([0.9, 0.6, 0.7, 1], B * 4);
  const ctx: ThreeLayerContext = {
    renderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField,
    palette: new PaletteView(palette),
    settings,
    renderSettings: createRenderSettings(),
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
  return { ctx, full, rects };
}

/** Straight-down camera over (cx, cz) at `cssPxPerTile` (800×600 canvas). */
function camera(cssPxPerTile: number, cx = W / 2, cz = H / 2) {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 1, 100_000);
  const focal = 600 / (2 * Math.tan(Math.PI / 6));
  cam.position.set(cx, focal / cssPxPerTile, cz);
  cam.rotation.set(-Math.PI / 2, 0, 0, "YXZ");
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

function frame(nowMs: number, cssPxPerTile: number, dtMs = 16): FrameInfo {
  return {
    nowMs,
    dtMs,
    tickAlpha: 1,
    camera: camera(cssPxPerTile),
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

function attacks(
  list: [number, number, number, boolean?][],
): Map<number, Pick<PlayerState, "outgoingAttacks">> {
  const m = new Map<number, Pick<PlayerState, "outgoingAttacks">>();
  for (const [a, t, troops, retreating] of list) {
    const p = m.get(a) ?? { outgoingAttacks: [] };
    p.outgoingAttacks.push({
      attackerID: a,
      targetID: t,
      troops,
      id: `${a}-${t}`,
      retreating: retreating === true,
    });
    m.set(a, p);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("capture stamps", () => {
  it("are 1..FRONT_TIME_MOD in time units, with a pvp flag; 0 = never", () => {
    expect(frontStamp(0, false)).toBe(1);
    expect(frontStamp(FRONT_TIME_UNIT_MS * 10, false)).toBe(11);
    expect(frontStamp(FRONT_TIME_UNIT_MS * 10, true)).toBe(11 | FRONT_PVP_BIT);
    // Wraps without ever giving 0.
    const wrap = FRONT_TIME_UNIT_MS * FRONT_TIME_MOD;
    expect(frontStamp(wrap, false)).toBe(1);
    expect(frontStamp(wrap - FRONT_TIME_UNIT_MS, false)).toBe(FRONT_TIME_MOD);
    expect(frontAgeMs(0, frontNowUnits(1000))).toBe(Infinity);
  });

  it("give the age of a capture, across the wrap too", () => {
    for (const t of [0, 12_345, FRONT_TIME_UNIT_MS * FRONT_TIME_MOD - 70]) {
      const s = frontStamp(t, true);
      expect(frontAgeMs(s, frontNowUnits(t))).toBeLessThan(FRONT_TIME_UNIT_MS);
      const later = frontAgeMs(s, frontNowUnits(t + 600));
      expect(later).toBeGreaterThan(600 - FRONT_TIME_UNIT_MS);
      expect(later).toBeLessThanOrEqual(600 + FRONT_TIME_UNIT_MS);
    }
  });

  it("pulse: a fast rise, bright on the last ticks only, no ripple", () => {
    expect(frontPulse(-0.1)).toBe(0);
    expect(frontPulse(0)).toBe(0);
    expect(frontPulse(1)).toBe(0);
    expect(frontPulse(0.06)).toBeGreaterThan(0.7);
    let peak = 0;
    let last = Infinity;
    for (let u = 0.06; u < 1; u += 0.01) {
      const p = frontPulse(u);
      peak = Math.max(peak, p);
      // Monotonic after the rise: no ripple (they drew contour lines).
      expect(p).toBeLessThanOrEqual(last + 1e-12);
      last = p;
    }
    expect(peak).toBeLessThanOrEqual(1);
    // The leading edge: ~3 ticks (300 ms) bright, then a faint tail.
    const at = (ms: number) => frontPulse(ms / FRONT_PULSE_MS);
    expect(at(300)).toBeLessThan(0.5 * at(80));
    expect(at(600)).toBeLessThan(0.2 * at(80));
    expect(frontPulse(0.97)).toBeLessThan(0.01);
    // White-hot only at first.
    expect(frontHeat(0)).toBe(1);
    expect(frontHeat(300)).toBeLessThan(0.15);
  });

  it("wave look: a strong white-hot line zoomed out, a soft glow close up", () => {
    const far = frontWaveLook(0.7);
    const near = frontWaveLook(8);
    expect(far.gain).toBeGreaterThan(near.gain);
    expect(far.heat).toBeGreaterThan(near.heat);
    // Strongest on the moving line itself, weaker inside the band.
    expect(near.interior).toBeLessThan(0.5);
    expect(far.interior).toBeLessThan(1);
    expect(frontWaveLook(1.8).gain).toBeGreaterThan(near.gain);
    expect(near.neutral).toBeLessThan(1);
  });

  it("attack direction points from the attacker into the defender", () => {
    const t = splitState(60);
    const d: [number, number] = [0, 0];
    expect(captureDirection(t, W, H, 59, 40, A, B, d)).toBe(true);
    expect(d[0]).toBeGreaterThan(0.9);
    expect(Math.abs(d[1])).toBeLessThan(0.2);
    // Swapped roles: the other way.
    expect(captureDirection(t, W, H, 60, 40, B, A, d)).toBe(true);
    expect(d[0]).toBeLessThan(-0.9);
    // Nobody around: no direction.
    expect(captureDirection(new Uint16Array(W * H), W, H, 5, 5, A, B, d)).toBe(
      false,
    );
  });
});

describe("LivingFront helpers", () => {
  it("arrow cells keep the arrows ~150 px apart, on the segment grid", () => {
    expect(frontArrowCell(0.7)).toBe(256);
    expect(frontArrowCell(1.8)).toBe(64);
    expect(frontArrowCell(5)).toBe(32);
    expect(frontArrowCell(20)).toBe(32);
    expect(frontArrowCell(0.05)).toBe(512);
  });

  it("arrows: subtle zoomed out, larger close up and for big attacks", () => {
    const far = frontArrowLook(0.7, 10_000);
    const near = frontArrowLook(8, 10_000);
    expect(near.lengthPx).toBeGreaterThan(far.lengthPx);
    expect(near.alpha).toBeGreaterThan(far.alpha);
    expect(frontArrowLook(8, 1e6).lengthPx).toBeGreaterThan(
      frontArrowLook(8, 1e3).lengthPx,
    );
    expect(far.widthPx).toBeCloseTo(far.lengthPx / 2, 9);
  });

  it("arrow colour keeps the hue at full brightness (light core)", () => {
    const c = frontArrowColor([0.2, 0.25, 0.22]);
    expect(Math.max(...c)).toBeCloseTo(1, 6);
    expect(c[1]).toBeGreaterThan(c[0]);
    expect(Math.min(...c)).toBeGreaterThan(0.3);
  });

  it("particles: none at full map, few at the default zoom, all close up", () => {
    expect(frontParticleLook(0.7).rate).toBe(0);
    expect(frontParticleLook(1.3).rate).toBe(0);
    const d = frontParticleLook(1.8);
    expect(d.rate).toBeGreaterThan(0);
    expect(d.rate).toBeLessThan(0.15);
    expect(d.sparks).toBe(0);
    expect(frontParticleLook(5).rate).toBe(1);
    expect(frontParticleLook(5).sparks).toBe(1);
    // At least ~7 CSS px at any zoom.
    expect(frontParticleLook(2).puffTiles * 2).toBeGreaterThanOrEqual(7);
  });

  it("an event's density draw is fixed and follows the rate", () => {
    let kept = 0;
    for (let i = 0; i < 10_000; i++) if (frontEventKept(i, 0.3)) kept++;
    expect(kept / 10_000).toBeGreaterThan(0.27);
    expect(kept / 10_000).toBeLessThan(0.33);
    expect(frontEventKept(17, 0.3)).toBe(frontEventKept(17, 0.3));
    expect(frontEventKept(17, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FrontField
// ---------------------------------------------------------------------------

describe("FrontField", () => {
  it("stamps owner changes only, flags captures from players", () => {
    const f = new FrontField(W, H);
    const t = splitState(60);
    t[5] = 0; // unowned tile
    f.reset(t);
    const refs = takeColumn(t, 60, 0, 10);
    t[5] = A; // expansion into unclaimed land
    t[200] |= FALLOUT_BIT; // a bit change, same owner
    const ref0 = 70 * W + 90;
    t[ref0] = 0; // lost to nobody
    const n = f.applyChanges(t, [...refs, 5, 200, ref0], 5000);
    expect(n).toBe(11);
    expect(f.pvpLastTick).toBe(10);
    for (const r of refs) expect(f.stamps[r]).toBe(frontStamp(5000, true));
    expect(f.stamps[5]).toBe(frontStamp(5000, false));
    expect(f.stamps[200]).toBe(0);
    expect(f.stamps[ref0]).toBe(0);
    // The same values again: nothing changed owner.
    expect(f.applyChanges(t, refs, 5100)).toBe(0);
  });

  it("a full state resets everything (no wave for it)", () => {
    const f = new FrontField(W, H);
    const t = splitState(60);
    f.reset(t);
    f.applyChanges(t, takeColumn(t, 60), 1000);
    expect(f.stampedCells).toBeGreaterThan(0);
    f.reset(splitState(30));
    expect(f.stamps.every((s) => s === 0)).toBe(true);
    expect(f.segments.size).toBe(0);
    expect(f.stampedCells).toBe(0);
    // Changes before any full state only seed the shadow.
    const g = new FrontField(W, H);
    expect(g.applyChanges(t, [0, 1, 2], 0)).toBe(0);
  });

  it("samples border events among captures from players, capped per tick", () => {
    const f = new FrontField(W, H);
    const t = splitState(20);
    f.reset(t);
    // A takes a wide band: only its last column touches B.
    const refs: number[] = [];
    for (let x = 20; x < 30; x++) refs.push(...takeColumn(t, x));
    f.applyChanges(t, refs, 1000);
    expect(f.eventCount).toBeGreaterThan(0);
    expect(f.eventCount).toBeLessThanOrEqual(FRONT_EVENTS_PER_TICK);
    for (let i = 0; i < f.eventCount; i++) {
      expect(f.eventX[i]).toBe(29.5); // on the new border
      expect(f.eventAttacker[i]).toBe(A);
      expect(f.eventDefender[i]).toBe(B);
      expect(f.eventTime[i]).toBe(1000);
    }
    // Expansion into unclaimed land makes no event.
    const g = new FrontField(W, H);
    const u = new Uint16Array(W * H);
    g.reset(u);
    u[10] = A;
    g.applyChanges(u, [10], 0);
    expect(g.eventCount).toBe(0);
  });

  it("clusters captures into fronts pointing into the defender", () => {
    const f = new FrontField(W, H);
    const t = splitState(40);
    f.reset(t);
    for (let k = 0; k < 6; k++) {
      f.applyChanges(t, takeColumn(t, 40 + k), 1000 + 100 * k);
    }
    const out: FrontCluster[] = [];
    const n = f.cluster(1500, 32, 1, out);
    expect(n).toBe(3); // 96 rows / 32-tile cells
    for (let i = 0; i < n; i++) {
      const c = out[i];
      expect(c.attacker).toBe(A);
      expect(c.defender).toBe(B);
      expect(c.dx).toBeGreaterThan(0.9);
      // Near the front line (the last columns taken, 44-45), not at the
      // mean of the captures (43).
      expect(c.x).toBeGreaterThan(44);
      expect(c.x).toBeLessThan(46);
    }
    // A bigger cell merges them.
    expect(f.cluster(1500, 128, 1, out)).toBe(1);
    expect(out[0].w).toBeGreaterThan(500);
    // Known attacks filter the pairs; a retreating attack does not count.
    f.setAttacks(attacks([[B, A, 500]]));
    expect(f.cluster(1500, 32, 1, out)).toBe(0);
    f.setAttacks(attacks([[A, B, 2000, true]]));
    expect(f.cluster(1500, 32, 1, out)).toBe(0);
    f.setAttacks(attacks([[A, B, 2000]]));
    expect(f.cluster(1500, 32, 1, out)).toBe(3);
    expect(out[0].troops).toBe(2000);
    // A stopped front loses its recent weight first, then its segments.
    expect(f.cluster(3500, 32, 1, out, 8)).toBe(0);
    expect(f.cluster(3500, 32, 1, out)).toBe(3);
    f.cluster(60_000, 32, 1, out);
    expect(f.segments.size).toBe(0);
  });

  it("sweeps stale stamps long before they wrap, queueing their upload", () => {
    const f = new FrontField(W, H);
    const t = splitState(60);
    f.reset(t);
    const refs = takeColumn(t, 60);
    f.applyChanges(t, refs, 1000);
    const cells = f.stampedCells;
    expect(cells).toBe(6); // 96 rows of 16-tile cells
    // Not stale yet: nothing zeroed in a whole sweep period.
    for (let i = 0; i < FRONT_SWEEP_PERIOD; i++) f.sweep(2000);
    expect(f.sweptCells).toBe(0);
    // Stale: zeroed within one period, uploads queued.
    const late = 1000 + FRONT_STALE_MS + 1;
    for (let i = 0; i < FRONT_SWEEP_PERIOD; i++) f.sweep(late);
    expect(f.sweptCells).toBe(cells);
    for (const r of refs) expect(f.stamps[r]).toBe(0);
    expect(f.sweepQueue.pendingCells).toBe(cells);
    // Well within the wrap of the stamps.
    expect(FRONT_STALE_MS * 2).toBeLessThan(
      FRONT_TIME_MOD * FRONT_TIME_UNIT_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// Terrain shader and layer
// ---------------------------------------------------------------------------

/** The shader as compiled without FRONT_WAVE (comments dropped). */
function withoutFrontWave(src: string): string {
  return withoutDefines(src, ["FRONT_WAVE"]).replace(/\/\/.*$/gm, "");
}

describe("capture wave in the terrain shader", () => {
  it("is compiled out without the define", () => {
    const off = withoutFrontWave(TERRAIN_FRAG);
    expect(TERRAIN_FRAG).toContain("#ifdef FRONT_WAVE");
    for (const id of ["uFront", "frontWave", "frontPulse", "frontAgeS"]) {
      expect(TERRAIN_FRAG).toContain(id);
      expect(off).not.toContain(id);
    }
    // No other preprocessor block of the program depends on it.
    expect(off.match(/FRONT_/g)).toBeNull();
  });

  it("mirrors the TypeScript constants and pulse", () => {
    expect(TERRAIN_FRAG).toContain(
      `const float FRONT_PULSE_S = ${(FRONT_PULSE_MS / 1000).toFixed(3)};`,
    );
    expect(TERRAIN_FRAG).toContain(
      `const float FRONT_UNIT_S = ${(FRONT_TIME_UNIT_MS / 1000).toFixed(3)};`,
    );
    expect(TERRAIN_FRAG).toContain(`const uint FRONT_PVP = ${FRONT_PVP_BIT}u;`);
    expect(TERRAIN_FRAG).toContain(
      `const float FRONT_DECAY_S = ${FRONT_DECAY_S.toFixed(3)};`,
    );
    expect(TERRAIN_FRAG).toContain(
      `const float FRONT_HOT_S = ${FRONT_HOT_S.toFixed(3)};`,
    );
    expect(TERRAIN_FRAG).toContain(
      "(0.75 * exp(-age / FRONT_DECAY_S) + 0.25 * (1.0 - u) * (1.0 - u))",
    );
    // Added as light over the lit ground (the relief reads through), not a
    // flat replacement; strongest on the border tiles.
    expect(TERRAIN_FRAG).toContain("return lit + col * (k * uFrontLook.x);");
    expect(TERRAIN_FRAG).toContain("mix(uFrontLook.w, 1.0, edge)");
  });
});

describe("TerrainLayer, living front", () => {
  it("costs nothing without the flag: no field, texture, define or uniform", () => {
    const { ctx, rects } = makeCtx(false);
    const layer = new TerrainLayer(ctx);
    disposers.push(() => layer.dispose());
    expect(layer.front).toBeNull();
    const mesh = ctx.scene.getObjectByName("terrain") as THREE.Mesh;
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.defines?.FRONT_WAVE).toBeUndefined();
    expect("uFront" in mat.uniforms).toBe(false);
    const t = splitState(60);
    layer.setTiles(t, null);
    layer.setTiles(t, takeColumn(t, 60));
    layer.update(frame(1000, 4));
    // One tile upload per dirty rectangle, nothing else.
    expect(rects.every((r) => r.target === layer.tileTexture)).toBe(true);
    expect(
      Object.keys(layer.perfStats()).filter((k) => k.startsWith("front")),
    ).toEqual([]);
  });

  it("with the flag, sends the stamps with the tile state's rectangles", () => {
    const { ctx, full, rects } = makeCtx(true);
    const layer = new TerrainLayer(ctx);
    disposers.push(() => layer.dispose());
    const front = layer.front;
    expect(front).not.toBeNull();
    const mesh = ctx.scene.getObjectByName("terrain") as THREE.Mesh;
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.defines?.FRONT_WAVE).toBe("");
    const frontTex = mat.uniforms.uFront.value as THREE.Texture;
    expect(frontTex).toBeInstanceOf(THREE.DataTexture);

    const t = splitState(60);
    layer.setTiles(t, null);
    // The full upload also sends the (reset) stamps.
    expect(full).toContain(frontTex);
    layer.update(frame(1000, 4));
    rects.length = 0;
    const refs = takeColumn(t, 60);
    layer.setTiles(t, refs);
    // Stamped with the last frame's time.
    expect(front!.stamps[refs[0]]).toBe(frontStamp(1000, true));
    layer.update(frame(1016, 4));
    const tileRects = rects.filter((r) => r.target === layer.tileTexture);
    const frontRects = rects.filter((r) => r.target === frontTex);
    expect(tileRects.length).toBeGreaterThan(0);
    // Every rectangle here holds a new stamp: the same rectangles.
    expect(frontRects).toEqual(
      tileRects.map((r) => ({ ...r, target: frontTex })),
    );
    const stats = layer.perfStats();
    expect(stats.frontUploadCalls).toBe(frontRects.length);
    expect(stats.frontTexelsLastFrame).toBe(
      frontRects.reduce((s, r) => s + r.w * r.h, 0),
    );
    expect(stats.frontTextureMB).toBeCloseTo((W * H * 2) / (1 << 20), 9);
    expect(stats.frontCaptures).toBe(H);
    // The wave's clock and look follow the frame.
    expect(mat.uniforms.uFrontNow.value).toBeCloseTo(frontNowUnits(1016), 9);
    const look = frontWaveLook(4);
    expect(mat.uniforms.uFrontLook.value.x).toBeCloseTo(look.gain, 9);
    expect(mat.uniforms.uFrontLook.value.w).toBeCloseTo(look.interior, 9);
    // Nothing changed: no front upload.
    layer.update(frame(1032, 4));
    expect(layer.perfStats().frontUploadCalls).toBe(0);
  });

  it("sends no stamps for tiles lost to nobody (a nuke) or other bit changes", () => {
    const { ctx, rects } = makeCtx(true);
    const layer = new TerrainLayer(ctx);
    disposers.push(() => layer.dispose());
    const mat = (ctx.scene.getObjectByName("terrain") as THREE.Mesh)
      .material as THREE.ShaderMaterial;
    const frontTex = mat.uniforms.uFront.value as THREE.Texture;
    const t = splitState(60);
    layer.setTiles(t, null);
    layer.update(frame(1000, 4));
    rects.length = 0;
    // A wide area falls to nobody, with fallout: tile uploads, no stamps.
    const refs: number[] = [];
    for (let y = 10; y < 60; y++) {
      for (let x = 20; x < 100; x++) {
        t[y * W + x] = FALLOUT_BIT;
        refs.push(y * W + x);
      }
    }
    layer.setTiles(t, refs);
    layer.update(frame(1016, 4));
    expect(rects.some((r) => r.target === layer.tileTexture)).toBe(true);
    expect(rects.filter((r) => r.target === frontTex)).toEqual([]);
    expect(layer.perfStats().frontUploadCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FxLayer (smoke, sparks) and OverlayLayer (arrows)
// ---------------------------------------------------------------------------

/** A field with an active front: A pushes into B for `ticks` ticks. */
function activeFront(ticks: number, t0 = 1000): FrontField {
  const f = new FrontField(W, H);
  const t = splitState(40);
  f.reset(t);
  for (let k = 0; k < ticks; k++) {
    f.applyChanges(t, takeColumn(t, 40 + k), t0 + 100 * k);
  }
  return f;
}

describe("FrontField, upload and border helpers", () => {
  it("marks stamp cells dirty only for captures, cleared when taken", () => {
    const f = new FrontField(W, H);
    const t = splitState(60);
    f.reset(t);
    expect(f.takeDirty(0, 0, W, H)).toBe(false);
    // Lost to nobody: no stamp, nothing dirty.
    const lost: number[] = [];
    for (let y = 0; y < 8; y++) {
      t[y * W + 10] = 0;
      lost.push(y * W + 10);
    }
    f.applyChanges(t, lost, 1000);
    expect(f.takeDirty(0, 0, W, H)).toBe(false);
    // A capture: its cell only.
    f.applyChanges(t, takeColumn(t, 60, 0, 4), 1100);
    expect(f.takeDirty(0, 0, 32, 32)).toBe(false);
    expect(f.takeDirty(32, 0, 32, 32)).toBe(true);
    expect(f.takeDirty(32, 0, 32, 32)).toBe(false);
    f.applyChanges(t, takeColumn(t, 61, 0, 4), 1200);
    f.clearDirty();
    expect(f.takeDirty(0, 0, W, H)).toBe(false);
  });

  it("tells whether a tile is still on a border", () => {
    const f = new FrontField(W, H);
    expect(f.onBorder(59, 10)).toBe(false); // no state yet
    f.reset(splitState(60));
    expect(f.onBorder(59, 10)).toBe(true);
    expect(f.onBorder(60, 10)).toBe(true);
    expect(f.onBorder(30, 10)).toBe(false);
    expect(f.onBorder(-1, 10)).toBe(false);
    expect(f.onBorder(W, 10)).toBe(false);
  });

  it("finds the reverse pair's cluster key", () => {
    const P = 4096;
    const key = 7 * P * P + 3 * P + 9;
    expect(reverseClusterKey(key, 3, 9)).toBe(7 * P * P + 9 * P + 3);
    expect(reverseClusterKey(reverseClusterKey(key, 3, 9), 9, 3)).toBe(key);
  });
});

describe("FxLayer, living front", () => {
  it("creates nothing without the flag", () => {
    const { ctx } = makeCtx(false);
    const fx = new FxLayer(ctx);
    disposers.push(() => fx.dispose());
    fx.setFront(activeFront(3));
    fx.update(frame(1250, 6));
    expect(ctx.scene.getObjectByName("fx-front-smoke")).toBeUndefined();
    expect(ctx.scene.getObjectByName("fx-front-sparks")).toBeUndefined();
    expect(
      Object.keys(fx.perfStats()).filter((k) => k.startsWith("front")),
    ).toEqual([]);
  });

  it("spawns capped smoke and sparks in view close up, none zoomed out", () => {
    const { ctx } = makeCtx(true);
    const fx = new FxLayer(ctx);
    disposers.push(() => fx.dispose());
    const f = activeFront(3);
    fx.setFront(f);
    // Full map: nothing, and the events are skipped (no backlog).
    fx.update(frame(1250, 0.7));
    expect(fx.perfStats().frontParticles).toBe(0);
    // Close up: at most FRONT_SPAWN_PER_FRAME events per frame.
    const g = activeFront(3);
    fx.setFront(g);
    fx.update(frame(1250, 6));
    const s = fx.perfStats();
    expect(s.frontSpawnedLastFrame).toBe(FRONT_SPAWN_PER_FRAME);
    expect(s.frontSmoke).toBe(FRONT_SPAWN_PER_FRAME);
    expect(s.frontSparks).toBeGreaterThan(FRONT_SPAWN_PER_FRAME);
    // Events older than FRONT_EVENT_MAX_AGE_MS no longer spawn.
    fx.update(frame(5000, 6));
    expect(fx.perfStats().frontSpawnedLastFrame).toBe(0);
    // Totals stay within the pools.
    for (let k = 0; k < 40; k++) {
      const h = activeFront(30, 6000 + k * 50);
      fx.setFront(h);
      fx.update(frame(6000 + k * 50 + 2900, 6));
    }
    const end = fx.perfStats();
    expect(end.frontSmoke).toBeLessThanOrEqual(FRONT_SMOKE_CAPACITY);
    expect(end.frontSparks).toBeLessThanOrEqual(FRONT_SPARK_CAPACITY);
    expect(ctx.scene.getObjectByName("fx-front-smoke")).toBeDefined();
  });

  it("makes no smoke where the front has moved on (no stains behind it)", () => {
    const { ctx } = makeCtx(true);
    const fx = new FxLayer(ctx);
    disposers.push(() => fx.dispose());
    const f = new FrontField(W, H);
    const t = splitState(40);
    f.reset(t);
    f.applyChanges(t, takeColumn(t, 40), 1000);
    expect(f.eventCount).toBeGreaterThan(0);
    // The attacker then takes everything: column 40 is no longer a border.
    const rest: number[] = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== A) {
        t[i] = A;
        rest.push(i);
      }
    }
    f.applyChanges(t, rest, 1100);
    fx.setFront(f);
    fx.update(frame(1200, 6));
    expect(fx.perfStats().frontSpawnedLastFrame).toBe(0);
    expect(fx.perfStats().frontSmoke).toBe(0);
  });
});

describe("OverlayLayer, living front arrows", () => {
  it("creates nothing without the flag", () => {
    const { ctx } = makeCtx(false);
    const layer = new OverlayLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.setFront(activeFront(6));
    layer.update(frame(1550, 5));
    expect(ctx.scene.getObjectByName("front-arrows")).toBeUndefined();
    expect(layer.perfStats().frontArrows).toBeUndefined();
  });

  it("draws one arrow per active front cluster, into the defender", () => {
    const { ctx } = makeCtx(true);
    const layer = new OverlayLayer(ctx);
    disposers.push(() => layer.dispose());
    const f = activeFront(6);
    f.setAttacks(attacks([[A, B, 50_000]]));
    layer.setFront(f);
    // Fade in over a few frames.
    for (let i = 0; i < 40; i++) layer.update(frame(1550 + i, 5, 16));
    const mesh = ctx.scene.getObjectByName("front-arrows") as THREE.Mesh;
    expect(mesh.visible).toBe(true);
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geo.instanceCount).toBe(3); // three 32-tile cells along the front
    expect(layer.perfStats().frontArrows).toBe(3);
    const axis = geo.getAttribute("iAxis");
    const center = geo.getAttribute("iCenter");
    for (let i = 0; i < 3; i++) {
      expect(axis.getX(i)).toBeGreaterThan(0.9); // +x: into B
      expect(center.getX(i)).toBeGreaterThan(44);
      expect(center.getX(i)).toBeLessThan(47);
    }
    // No active attack between them any more: the arrows fade out.
    f.setAttacks(attacks([]));
    for (let i = 0; i < 60; i++) layer.update(frame(1700 + i * 16, 5, 16));
    expect(mesh.visible).toBe(false);
    expect(layer.perfStats().frontArrows).toBe(0);
  });

  it("draws one arrow where two players attack each other in one cell", () => {
    const { ctx } = makeCtx(true);
    const layer = new OverlayLayer(ctx);
    disposers.push(() => layer.dispose());
    const f = new FrontField(W, H);
    const t = splitState(60);
    f.reset(t);
    // Rows 0-47: A pushes into B; rows 48-95: B pushes into A. The middle
    // 32-tile cell (rows 32-63) holds both directions.
    for (let k = 0; k < 4; k++) {
      const refs = takeColumn(t, 60 + k, 0, 48);
      for (let y = 48; y < H; y++) {
        t[y * W + 59 - k] = B;
        refs.push(y * W + 59 - k);
      }
      f.applyChanges(t, refs, 1000 + 100 * k);
    }
    f.setAttacks(
      attacks([
        [A, B, 50_000],
        [B, A, 50_000],
      ]),
    );
    layer.setFront(f);
    for (let i = 0; i < 40; i++) layer.update(frame(1350 + i, 5, 16));
    // Three cells, four (cell, pair) clusters, three arrows.
    expect(layer.perfStats().frontArrowCandidates).toBe(4);
    expect(layer.perfStats().frontArrows).toBe(3);
  });

  it("fades a stopped front's arrow out where it is (no ghost drifting)", () => {
    const { ctx } = makeCtx(true);
    const layer = new OverlayLayer(ctx);
    disposers.push(() => layer.dispose());
    const f = activeFront(6);
    f.setAttacks(attacks([[A, B, 50_000]]));
    layer.setFront(f);
    for (let i = 0; i < 40; i++) layer.update(frame(1550 + i, 5, 16));
    const mesh = ctx.scene.getObjectByName("front-arrows") as THREE.Mesh;
    const center = (
      mesh.geometry as THREE.InstancedBufferGeometry
    ).getAttribute("iCenter");
    const x0 = center.getX(0);
    const z0 = center.getZ(0);
    // The attack ends: the arrow fades within FRONT_ARROW_FADE_OUT_MS
    // without moving.
    f.setAttacks(attacks([]));
    layer.update(frame(1700, 5, 16));
    layer.update(frame(1716, 5, 16));
    expect(layer.perfStats().frontArrows).toBe(3);
    expect(center.getX(0)).toBeCloseTo(x0, 9);
    expect(center.getZ(0)).toBeCloseTo(z0, 9);
    for (let i = 0; i < 14; i++) layer.update(frame(1732 + i * 16, 5, 16));
    expect(layer.perfStats().frontArrows).toBe(0);
  });

  it("caps the arrows", () => {
    const { ctx } = makeCtx(true);
    const layer = new OverlayLayer(ctx);
    disposers.push(() => layer.dispose());
    const f = new FrontField(W, H);
    const t = new Uint16Array(W * H);
    // Many pairs fighting across the map: owners in 4-tile stripes.
    for (let i = 0; i < t.length; i++) t[i] = 1 + ((i % W) >> 2);
    f.reset(t);
    for (let k = 0; k < 3; k++) {
      const refs: number[] = [];
      for (let y = 0; y < H; y++) {
        for (let s = 0; s < W / 4 - 1; s++) {
          const x = s * 4 + 3 + k; // the next stripe's first columns
          if (x >= W) continue;
          t[y * W + x] = 1 + s;
          refs.push(y * W + x);
        }
      }
      f.applyChanges(t, refs, 1000 + 100 * k);
    }
    layer.setFront(f);
    for (let i = 0; i < 10; i++) layer.update(frame(1250 + i * 16, 5, 16));
    expect(layer.perfStats().frontArrowCandidates).toBeGreaterThan(
      FRONT_ARROW_CAP,
    );
    expect(layer.perfStats().frontArrows).toBe(FRONT_ARROW_CAP);
  });
});
