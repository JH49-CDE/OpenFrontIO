/**
 * Boat / nuke trails and the effect palette in the 3D renderer
 * (EffectTrails.ts), checked against the default renderer's own data path
 * and logic:
 * - colours: effect palettes written by the game's `writePlayerEffects`
 *   (the effect editor and the catalog path), looked up by the 3D mirror
 *   (`trailColorAt`, the TS twin of EFFECT_TRAILS_GLSL) and compared with a
 *   literal port of the default's trail.frag.glsl: no effect = territory
 *   colour, flat, gradient (bands along the world diagonal, scrolling),
 *   transition (time), spiral (first colour), nuke bit = block 1, alt view
 *   = "unit" affiliation colours;
 * - the effect palette mirror (allocation, copy, counts, switches);
 * - the trail texture upload path: a real TrailManager driven tick by tick,
 *   its dirty rows diffed within TRAIL_DIFF_BUDGET per frame into 16×16-tile
 *   cells, sent within TRAIL_UPLOAD_BUDGET per frame; a GPU copy rebuilt
 *   from the recorded uploads always converges to the live buffer (nothing
 *   dropped).
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  NUKE_TRAIL_BIT,
  TrailManager,
} from "../../../src/client/render/frame/TrailManager";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import {
  EFFECT_PALETTE_BLOCKS,
  getPaletteSize,
  MAX_TRAIL_COLORS,
} from "../../../src/client/render/gl/utils/ColorUtils";
import type { PaletteEffectAttributes } from "../../../src/client/render/gl/utils/EffectPalette";
import {
  type PaletteEffectType,
  writePlayerEffects,
} from "../../../src/client/render/gl/utils/PlayerPalette";
import {
  EFFECT_COLOR_GLSL,
  EFFECT_ROWS,
  EFFECT_TRAILS_GLSL,
  EffectPaletteTexture,
  EffectTrails,
  effectColorAt,
  NUKE_TRAIL_BLOCK,
  TRAIL_DIFF_BUDGET,
  TRAIL_UPLOAD_BUDGET,
  trailColorAt,
} from "../../../src/client/render/three/EffectTrails";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { TERRAIN_FRAG } from "../../../src/client/render/three/shaders/terrain";
import { WATER_FRAG } from "../../../src/client/render/three/shaders/water";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import type { UnitState } from "../../../src/client/render/types";
import {
  UT_ATOM_BOMB,
  UT_TRANSPORT,
} from "../../../src/client/render/types/UnitType";

const PALETTE = getPaletteSize();
type Rgb = [number, number, number];

// ---------------------------------------------------------------------------
// The default renderer's trail.frag.glsl, ported line by line (reference)
// ---------------------------------------------------------------------------

function defaultTrailFrag(
  trailVal: number,
  vWorldPos: [number, number],
  effect: Float32Array,
  palette: Float32Array,
  affiliation: Uint8Array,
  uTime: number,
  uAltView: boolean,
): Rgb | null {
  const texel = (x: number, y: number) =>
    Array.from(
      effect.subarray((y * PALETTE + x) * 4, (y * PALETTE + x) * 4 + 4),
    );
  const int = (v: number) => Math.trunc(v);
  const fract = (v: number) => v - Math.floor(v);
  const mix = (a: number[], b: number[], t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const owner = trailVal & 0xfff;
  if (owner === 0) return null;
  const isNuke = (trailVal >> 12) & 1;
  if (uAltView) {
    const o = owner * 4;
    return [
      affiliation[o] / 255,
      affiliation[o + 1] / 255,
      affiliation[o + 2] / 255,
    ];
  }
  const o = owner;
  const rowBase = isNuke === 1 ? MAX_TRAIL_COLORS : 0;
  const count = int(texel(o, rowBase)[3] + 0.5);
  if (count <= 0) {
    return [palette[owner * 4], palette[owner * 4 + 1], palette[owner * 4 + 2]];
  } else if (count === 1) {
    return texel(o, rowBase).slice(0, 3) as Rgb;
  } else if (int(texel(o, rowBase + 1)[3] + 0.5) === 2) {
    return texel(o, rowBase).slice(0, 3) as Rgb;
  } else if (int(texel(o, rowBase + 1)[3] + 0.5) === 1) {
    const frequency = texel(o, rowBase + 2)[3];
    const t = uTime * frequency;
    const i = int(t) % count;
    const j = (i + 1) % count;
    return mix(texel(o, rowBase + i), texel(o, rowBase + j), fract(t));
  }
  const colorSize = Math.max(texel(o, rowBase + 2)[3], 0.001);
  const movementSpeed = texel(o, rowBase + 3)[3];
  const cycle = colorSize * count;
  const phase = fract(
    (vWorldPos[0] + vWorldPos[1] - uTime * movementSpeed) / cycle,
  );
  const f = phase * count;
  const i = int(f) % count;
  const j = (i + 1) % count;
  return mix(texel(o, rowBase + i), texel(o, rowBase + j), fract(f));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An effect palette written by the game's own code. */
function paletteWith(
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

const RAINBOW = ["#ff0000", "#ffee00", "#00dd44", "#0088ff", "#aa00ff"];
const EFFECTS = {
  // Gradient boat trail, transition nuke trail.
  3: {
    transportShipTrail: {
      type: "gradient",
      colors: RAINBOW,
      colorSize: 4,
      movementSpeed: 3,
    },
    nukeTrail: {
      type: "transition",
      colors: ["#ff2020", "#ffffff", "#2020ff"],
      frequency: 0.7,
    },
  },
  // Flat boat trail, spiral nuke trail.
  5: {
    transportShipTrail: {
      type: "gradient",
      colors: ["#ff00ff"],
      colorSize: 4,
      movementSpeed: 0,
    },
    nukeTrail: {
      type: "spiral",
      colors: ["#00ffff", "#ff00ff"],
      radius: 3,
      strands: 2,
      rotationSpeed: 2,
    },
  },
  // Only a structures effect: no trail effect.
  9: {
    structures: {
      type: "gradient",
      colors: ["#123456", "#654321"],
      colorSize: 2,
      movementSpeed: 1,
    },
  },
} as Record<
  number,
  Partial<Record<PaletteEffectType, PaletteEffectAttributes>>
>;

function playerPalette(): Float32Array {
  const p = new Float32Array(PALETTE * 2 * 4);
  for (const [sid, rgb] of [
    [3, [0.2, 0.4, 0.9]],
    [4, [0.8, 0.3, 0.1]],
    [5, [0.1, 0.7, 0.3]],
    [9, [0.6, 0.6, 0.2]],
  ] as const) {
    p.set([...rgb, 0.588], sid * 4);
  }
  return p;
}

const W = 96;
const H = 80;

/** A layer context whose stub renderer records uploads into a GPU copy. */
function makeCtx({ perf = false, width = W, height = H } = {}) {
  const settings = defaultThreeSettings();
  settings.perf = perf;
  const heightField = new HeightField(
    width,
    height,
    new Uint8Array(width * height),
    {
      heightScale: settings.heightScale,
      seabedDepth: settings.seabedDepth,
      targetVertices: (width * height) / 16,
    },
  );
  /** What the GPU holds per texture (rebuilt from the uploads). */
  const gpu = new Map<THREE.Texture, Uint16Array>();
  const calls = { full: 0, rects: 0, texels: 0 };
  const dataOf = (t: THREE.Texture) => (t.image as { data: Uint16Array }).data;
  const renderer = {
    initTexture: (t: THREE.Texture) => {
      calls.full++;
      if (dataOf(t) instanceof Uint16Array) gpu.set(t, dataOf(t).slice());
    },
    copyTextureToTexture: (
      src: THREE.DataTexture,
      dst: THREE.Texture,
      region: THREE.Box2,
      pos: THREE.Vector2,
    ) => {
      expect(src).not.toBe(dst);
      const data = (src.image as { data: Uint16Array }).data;
      const w = (src.image as { width: number }).width;
      let copy = gpu.get(dst);
      if (copy === undefined) {
        // three uploads a never-seen target in full first.
        copy = dataOf(dst).slice();
        gpu.set(dst, copy);
      }
      const rw = region.max.x - region.min.x;
      const rh = region.max.y - region.min.y;
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const sx = region.min.x + x;
          const sy = region.min.y + y;
          copy[(pos.y + y) * w + pos.x + x] = data[sy * w + sx];
        }
      }
      calls.rects++;
      calls.texels += rw * rh;
    },
  } as unknown as THREE.WebGLRenderer;
  const ctx: ThreeLayerContext = {
    renderer,
    scene: new THREE.Scene(),
    mapWidth: width,
    mapHeight: height,
    heightField,
    palette: new PaletteView(playerPalette()),
    settings,
    renderSettings: createRenderSettings(),
    config: {} as Config,
    overlayRoot: document.createElement("div"),
  };
  return { ctx, gpu, calls };
}

function frame(nowMs = 0, altView = false, localPlayerID = 3): FrameInfo {
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: new THREE.PerspectiveCamera(),
    cssPxPerTile: 4,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID,
    highlightOwner: 0,
    altView,
  };
}

function unit(
  id: number,
  ownerID: number,
  unitType: string,
  pos: number,
  lastPos: number,
): UnitState {
  return {
    id,
    unitType,
    ownerID,
    lastOwnerID: null,
    pos,
    lastPos,
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

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Index of the first element where `a` and `b` differ, else -1. */
function firstMismatch(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function expectRgbClose(a: Rgb | null, b: Rgb | null): void {
  expect(a === null).toBe(b === null);
  if (a === null || b === null) return;
  for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], 5);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

describe("trail colours (trail.frag.glsl parity)", () => {
  const effect = paletteWith(EFFECTS);
  const palette = playerPalette();
  const affiliation = new Uint8Array(PALETTE * 4);
  affiliation.set([0, 255, 0, 255], 3 * 4);
  affiliation.set([255, 0, 0, 255], 4 * 4);

  it("matches a literal port of the default's shader for every style", () => {
    const values = [
      3, // gradient boat
      3 | NUKE_TRAIL_BIT, // transition nuke
      4, // no effect: territory colour
      4 | NUKE_TRAIL_BIT,
      5, // flat
      5 | NUKE_TRAIL_BIT, // spiral: first colour
      9, // structures effect only: territory colour
      9 | NUKE_TRAIL_BIT,
      0, // no trail
    ];
    const random = rng(7);
    for (let n = 0; n < 400; n++) {
      const v = values[n % values.length];
      const x = random() * 500;
      const y = random() * 500;
      const t = random() * 120;
      for (const alt of [false, true]) {
        const ours = trailColorAt(v, x, y, {
          effect,
          palette,
          affiliation,
          altView: alt,
          time: t,
        });
        const ref = defaultTrailFrag(
          v,
          [x, y],
          effect,
          palette,
          affiliation,
          t,
          alt,
        );
        expectRgbClose(ours, ref);
      }
    }
  });

  it("gives each style the default's colours", () => {
    const at = (v: number, x: number, y: number, t: number) =>
      trailColorAt(v, x, y, {
        effect,
        palette,
        affiliation,
        altView: false,
        time: t,
      });
    // No effect: the territory colour, for boats and nukes.
    expectRgbClose(at(4, 10, 10, 0), [0.8, 0.3, 0.1]);
    expectRgbClose(at(4 | NUKE_TRAIL_BIT, 10, 10, 0), [0.8, 0.3, 0.1]);
    // Flat boat trail.
    expectRgbClose(at(5, 10, 10, 3), [1, 0, 1]);
    // Spiral nuke trail: its first colour, not the second.
    expectRgbClose(at(5 | NUKE_TRAIL_BIT, 10, 10, 3), [0, 1, 1]);
    // Gradient: 5 colours, 4 tiles each, along x + y; at t = 0 the band
    // start at x + y = 8 is the third colour exactly.
    expectRgbClose(at(3, 4, 4, 0), [0, 0xdd / 255, 0x44 / 255]);
    // ... and it scrolls at 3 tiles/s: 1 s later the same colour is 3
    // tiles further along the diagonal.
    expectRgbClose(at(3, 5.5, 5.5, 1), [0, 0xdd / 255, 0x44 / 255]);
    // Transition at 0.7 colour changes/s: t = 1/0.7 s is the 2nd colour.
    expectRgbClose(at(3 | NUKE_TRAIL_BIT, 0, 0, 1 / 0.7), [1, 1, 1]);
    // Halfway between the 2nd and 3rd colours, anywhere on the map.
    const mid = at(3 | NUKE_TRAIL_BIT, 123, 45, 1.5 / 0.7);
    expectRgbClose(mid, [(1 + 0x20 / 255) / 2, (1 + 0x20 / 255) / 2, 1]);
    // The nuke bit selects block 1: a boat trail of the same owner is the
    // gradient, never the transition.
    expect(at(3, 0, 0, 1 / 0.7)).not.toEqual(
      at(3 | NUKE_TRAIL_BIT, 0, 0, 1 / 0.7),
    );
    expect(effectColorAt(effect, 3, NUKE_TRAIL_BLOCK, 0, 0, 0)).not.toBeNull();
    expect(effectColorAt(effect, 4, NUKE_TRAIL_BLOCK, 0, 0, 0)).toBeNull();
  });

  it("uses the alt view's unit affiliation colours, never effects", () => {
    const alt = (v: number) =>
      trailColorAt(v, 10, 10, {
        effect,
        palette,
        affiliation,
        altView: true,
        time: 0,
      });
    expectRgbClose(alt(3), [0, 1, 0]);
    expectRgbClose(alt(3 | NUKE_TRAIL_BIT), [0, 1, 0]);
    expectRgbClose(alt(4), [1, 0, 0]);
  });

  it("ports the shader's styles into the shared GLSL", () => {
    // Block selection by the nuke bit, the spiral / transition / gradient
    // branches and the territory-colour fallback.
    expect(EFFECT_TRAILS_GLSL).toContain(EFFECT_COLOR_GLSL);
    expect(EFFECT_TRAILS_GLSL).toContain(`(v & ${NUKE_TRAIL_BIT}u) != 0u`);
    expect(EFFECT_TRAILS_GLSL).toContain(
      "texelFetch(uPalette, ivec2(o, 0), 0)",
    );
    expect(EFFECT_COLOR_GLSL).toContain(
      "fract((p.x + p.y - uTrailTime * speed) / cycle)",
    );
    expect(EFFECT_COLOR_GLSL).toContain("if (uEffectsOn < 0.5) return false;");
    // Both ground shaders composite it, behind a uniform switch.
    for (const src of [TERRAIN_FRAG, WATER_FRAG]) {
      expect(src).toContain("vec4 effectTrail(ivec2 tile, vec2 p, bool alt)");
      expect(src).toContain("if (uTrailsOn > 0.5");
      expect(src).toContain("srgbToLinear(tr.rgb) * diffuseLight(UP)");
    }
  });
});

// ---------------------------------------------------------------------------
// Effect palette mirror
// ---------------------------------------------------------------------------

describe("EffectPaletteTexture", () => {
  it("allocates on the first effect and mirrors the palette as is", () => {
    const fx = new EffectPaletteTexture();
    const placeholder = fx.texture;
    expect(fx.data).toBeNull();
    // A push without any effect (e.g. the editor cleared one) allocates
    // nothing: the shaders' switch stays off.
    expect(fx.set(new Float32Array(PALETTE * EFFECT_ROWS * 4))).toBe(false);
    expect(fx.texture).toBe(placeholder);
    expect(fx.bytes).toBe(16);

    const pal = paletteWith(EFFECTS);
    expect(fx.set(pal)).toBe(true);
    expect(fx.texture).not.toBe(placeholder);
    const img = fx.texture.image as {
      data: Float32Array;
      width: number;
      height: number;
    };
    expect([img.width, img.height]).toEqual([
      PALETTE,
      MAX_TRAIL_COLORS * EFFECT_PALETTE_BLOCKS,
    ]);
    expect(firstMismatch(img.data, pal)).toBe(-1);
    expect(img.data).not.toBe(pal); // a copy, not the caller's array
    expect(fx.texture.type).toBe(THREE.FloatType);
    expect(fx.texture.minFilter).toBe(THREE.NearestFilter);
    expect(fx.boatPlayers).toBe(2);
    expect(fx.nukePlayers).toBe(2);
    expect(fx.anyPlayers).toBe(3); // owner 9: structures only
    expect(fx.bytes).toBe(PALETTE * 48 * 16); // 3 MiB, as the default
    const version = fx.texture.version;

    // A later push (an owner's effect removed) re-mirrors it whole.
    const fewer = paletteWith({ 3: EFFECTS[3] });
    expect(fx.set(fewer)).toBe(true);
    expect(firstMismatch(img.data, fewer)).toBe(-1);
    expect(fx.texture.version).toBeGreaterThan(version);
    expect([fx.boatPlayers, fx.nukePlayers, fx.anyPlayers]).toEqual([1, 1, 1]);
    // A prefix is mirrored and the rest cleared.
    fx.set(pal.subarray(0, 8 * PALETTE * 4));
    expect(fx.boatPlayers).toBe(2);
    expect(fx.nukePlayers).toBe(0);
    fx.dispose();
  });

  it("switches the effect lookups on only for trail effects", () => {
    const { ctx } = makeCtx();
    const trails = EffectTrails.acquire(ctx);
    const placeholder = trails.uniforms.uEffectPalette.value;
    trails.update(frame());
    expect(trails.uniforms.uEffectsOn.value).toBe(0);
    trails.setEffectPalette(paletteWith({ 9: EFFECTS[9] }));
    trails.update(frame());
    // Allocated (structures effect), but no trail effect: lookups off.
    expect(trails.uniforms.uEffectPalette.value).not.toBe(placeholder);
    expect(trails.uniforms.uEffectsOn.value).toBe(0);
    trails.setEffectPalette(paletteWith(EFFECTS));
    trails.update(frame());
    expect(trails.uniforms.uEffectsOn.value).toBe(1);
    expect(trails.uniforms.uEffectPalette.value).toBe(trails.effects.texture);
    const stats = trails.perfStats();
    expect(stats.effectBoatPlayers).toBe(2);
    expect(stats.effectNukePlayers).toBe(2);
    expect(stats.effectPaletteUploads).toBe(2);
    expect(stats.effectPaletteMB).toBe(3);
    trails.release();
  });
});

// ---------------------------------------------------------------------------
// Trail texture uploads
// ---------------------------------------------------------------------------

describe("EffectTrails trail texture", () => {
  it("is one texture per map, shared and disposed with its last user", () => {
    const { ctx } = makeCtx();
    const a = EffectTrails.acquire(ctx);
    const b = EffectTrails.acquire(ctx);
    expect(b).toBe(a);
    const tex = a.trailTexture;
    let disposed = 0;
    tex.addEventListener("dispose", () => disposed++);
    a.release();
    expect(disposed).toBe(0);
    b.release();
    expect(disposed).toBe(1);
    const c = EffectTrails.acquire(ctx);
    expect(c).not.toBe(a);
    c.release();
  });

  it("uploads a full push now and counts the trail tiles", () => {
    const { ctx, gpu, calls } = makeCtx();
    const trails = EffectTrails.acquire(ctx);
    const tm = new TrailManager(W, H);
    const live = tm.getTrailState();
    live[5 * W + 7] = 3;
    live[6 * W + 7] = 3 | NUKE_TRAIL_BIT;
    trails.setTrailState(live);
    expect(calls.full).toBe(1);
    expect(firstMismatch(gpu.get(trails.trailTexture)!, live)).toBe(-1);
    expect(trails.trailData).not.toBe(live); // the mirror is a copy
    expect(trails.tiles).toBe(2);
    trails.update(frame());
    expect(trails.uniforms.uTrailsOn.value).toBe(1);
    const stats = trails.perfStats();
    expect(stats.trailFullUploads).toBe(1);
    expect(stats.trailUploadCallsLastFrame).toBe(1);
    expect(stats.trailTexelsLastFrame).toBe(W * H);
    // passEnabled.trail (debug GUI) turns them off live.
    ctx.renderSettings.passEnabled.trail = false;
    trails.update(frame());
    expect(trails.uniforms.uTrailsOn.value).toBe(0);
    ctx.renderSettings.passEnabled.trail = true;
    // No trail left: the shaders skip the fetch (rows diffed in the frame).
    live.fill(0);
    trails.applyTrailDelta(live, 5, 6);
    expect(trails.pendingRowCount).toBe(2);
    expect(trails.tiles).toBe(2);
    trails.update(frame());
    expect(trails.pendingRowCount).toBe(0);
    expect(trails.tiles).toBe(0);
    expect(trails.uniforms.uTrailsOn.value).toBe(0);
    // Another buffer (a new game view) is a full push.
    trails.applyTrailDelta(new Uint16Array(W * H), 0, 0);
    expect(calls.full).toBe(2);
    trails.release();
  });

  it("diffs the dirty rows, sends cells within the budget and drops nothing", () => {
    // A long game: boats and nukes launched, moving and dying, on a map
    // with an odd width (rows straddle the 4-tile compare words).
    const MW = 1001;
    const MH = 701;
    const { ctx, gpu, calls } = makeCtx({ width: MW, height: MH, perf: true });
    const trails = EffectTrails.acquire(ctx);
    const tm = new TrailManager(MW, MH);
    const live = tm.getTrailState();
    trails.setTrailState(live);
    const units = new Map<number, UnitState>();
    const random = rng(42);
    let nextId = 1;
    const ref = (x: number, y: number) => y * MW + x;
    const clampX = (x: number) => Math.max(0, Math.min(MW - 1, Math.round(x)));
    const clampY = (y: number) => Math.max(0, Math.min(MH - 1, Math.round(y)));
    let maxCalls = 0;
    let maxTexels = 0;
    let maxScanned = 0;
    let sawBacklog = false;
    let sawRowBacklog = false;
    for (let tick = 0; tick < 400; tick++) {
      // Spawn, move and kill units like a busy game (MIRV-like bursts).
      const spawnCount = tick % 97 === 50 ? 60 : random() < 0.3 ? 1 : 0;
      for (let k = 0; k < spawnCount; k++) {
        const nuke = random() < 0.4;
        const p = ref(clampX(random() * MW), clampY(random() * MH));
        units.set(
          nextId,
          unit(
            nextId++,
            1 + Math.floor(random() * 40),
            nuke ? UT_ATOM_BOMB : UT_TRANSPORT,
            p,
            p,
          ),
        );
      }
      for (const [id, u] of units) {
        if (random() < 0.02) {
          units.delete(id);
          continue;
        }
        const x = u.pos % MW;
        const y = Math.floor(u.pos / MW);
        const step = u.unitType === UT_ATOM_BOMB ? 6 : 1;
        const nx = clampX(x + (random() - 0.3) * 2 * step);
        const ny = clampY(y + (random() - 0.5) * 2 * step);
        u.lastPos = u.pos;
        u.pos = ref(nx, ny);
      }
      tm.clearDirtyRows();
      tm.update(units, [...units.keys()]);
      if (tm.dirtyRowMax >= 0) {
        trails.applyTrailDelta(live, tm.dirtyRowMin, tm.dirtyRowMax);
      }
      // 1-6 frames per tick (60 Hz with 10 ticks/s, or a slow frame rate).
      const frames = 1 + Math.floor(random() * 6);
      for (let f = 0; f < frames; f++) {
        const before = { rects: calls.rects, texels: calls.texels };
        trails.update(frame(tick * 100 + f));
        const n = calls.rects - before.rects;
        const texels = calls.texels - before.texels;
        maxCalls = Math.max(maxCalls, n);
        if (n > 1) maxTexels = Math.max(maxTexels, texels);
        maxScanned = Math.max(
          maxScanned,
          trails.perfStats().trailScannedTexelsLastFrame,
        );
        if (trails.pendingCells > 0) sawBacklog = true;
        if (trails.pendingRowCount > 0) sawRowBacklog = true;
      }
    }
    // Within the per-frame budget (more than one rectangle only within the
    // texel budget), and the queue did hold work back at some point.
    expect(maxCalls).toBeLessThanOrEqual(TRAIL_UPLOAD_BUDGET.maxCalls);
    expect(maxTexels).toBeLessThanOrEqual(TRAIL_UPLOAD_BUDGET.maxTexels);
    expect(sawBacklog).toBe(true);
    // The diff also stays within its budget (whole rows) and lags behind
    // at times (the map is bigger than one frame's budget).
    expect(maxScanned).toBeLessThanOrEqual(TRAIL_DIFF_BUDGET);
    expect(maxScanned).toBeGreaterThan(TRAIL_DIFF_BUDGET - MW);
    expect(sawRowBacklog).toBe(true);
    // Drain: the mirror and the GPU copy converge to the live buffer.
    for (
      let f = 0;
      f < 1000 && (trails.pendingCells > 0 || trails.pendingRowCount > 0);
      f++
    ) {
      trails.update(frame(1e6 + f));
    }
    expect(trails.pendingRowCount).toBe(0);
    expect(trails.pendingCells).toBe(0);
    expect(firstMismatch(trails.trailData, live)).toBe(-1);
    expect(firstMismatch(gpu.get(trails.trailTexture)!, live)).toBe(-1);
    expect(trails.tiles).toBe(live.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0));
    const stats = trails.perfStats();
    expect(stats.trailFullUploads).toBe(1); // only the first push
    expect(stats.trailDeltas).toBeGreaterThan(300);
    // Rectangles, not rows: a fraction of what the default's per-tick row
    // bands upload (the whole map width of every band, each tick).
    expect(stats.trailTexelsTotal - MW * MH).toBeLessThan(
      stats.trailScannedTexelsTotal / 4,
    );
    trails.release();
  });

  it("goes past half the map in one full upload", () => {
    const { ctx, calls, gpu } = makeCtx();
    const trails = EffectTrails.acquire(ctx);
    const live = new Uint16Array(W * H);
    trails.setTrailState(live);
    for (let i = 0; i < live.length; i += 2) live[i] = 7;
    trails.applyTrailDelta(live, 0, H - 1);
    expect(trails.pendingRowCount).toBe(H);
    // One frame diffs the whole (small) map, then uploads it in full.
    trails.update(frame());
    expect(calls.full).toBe(2);
    expect(trails.pendingCells).toBe(0);
    expect(firstMismatch(gpu.get(trails.trailTexture)!, live)).toBe(-1);
    trails.release();
  });

  it("ignores rows outside the reported range (the default's contract)", () => {
    const { ctx } = makeCtx();
    const trails = EffectTrails.acquire(ctx);
    const live = new Uint16Array(W * H);
    trails.setTrailState(live);
    live[10 * W + 3] = 4;
    live[40 * W + 3] = 4;
    trails.applyTrailDelta(live, 10, 10);
    trails.update(frame());
    expect(trails.trailData[10 * W + 3]).toBe(4);
    expect(trails.trailData[40 * W + 3]).toBe(0);
    // Out-of-range rows are clamped.
    trails.applyTrailDelta(live, -5, 1e9);
    expect(trails.pendingRowCount).toBe(H);
    trails.update(frame());
    expect(trails.trailData[40 * W + 3]).toBe(4);
    trails.release();
  });
});

// ---------------------------------------------------------------------------
// Alt view colours
// ---------------------------------------------------------------------------

describe("EffectTrails alt view", () => {
  it("builds the unit affiliation colours lazily, from the relations", () => {
    const { ctx } = makeCtx();
    const trails = EffectTrails.acquire(ctx);
    const aff = ctx.renderSettings.affiliation;
    const byte = (v: number) => Math.round(v * 255);
    const rel = new Uint8Array(16 * 16);
    rel[3 * 16 + 4] = 1; // 3 → 4 friendly
    rel[3 * 16 + 5] = 2; // 3 → 5 embargo
    trails.setRelations(rel, 16);
    trails.update(frame(0, false));
    expect(trails.perfStats().trailAffiliationRebuilds).toBe(0);
    trails.update(frame(0, true, 3));
    const d = trails.affiliationData;
    const rgb = (o: number) => Array.from(d.subarray(o * 4, o * 4 + 3));
    expect(rgb(3)).toEqual([aff.selfR, aff.selfG, aff.selfB].map(byte));
    expect(rgb(4)).toEqual([aff.allyR, aff.allyG, aff.allyB].map(byte));
    // Neutral and embargo are both "enemy" for units (3-state row).
    expect(rgb(5)).toEqual([aff.enemyR, aff.enemyG, aff.enemyB].map(byte));
    expect(rgb(6)).toEqual([aff.enemyR, aff.enemyG, aff.enemyB].map(byte));
    // Unchanged inputs: no rebuild; a new local player: one.
    trails.update(frame(16, true, 3));
    expect(trails.perfStats().trailAffiliationRebuilds).toBe(1);
    trails.update(frame(32, true, 4));
    expect(trails.perfStats().trailAffiliationRebuilds).toBe(2);
    expect(rgb(4)).toEqual([aff.selfR, aff.selfG, aff.selfB].map(byte));
    trails.release();
  });
});
