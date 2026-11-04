/**
 * A synthetic late-game structure population for the StructureLayer
 * measurements: ~400 structures of every type and level on a 2000×1000
 * World-sized map (land with a few seas), plus a 1920×1032 top-down camera
 * at a given zoom, like the real-GPU test's screen.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  defaultThreeSettings,
  type ThreeRenderSettings,
} from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import type { UnitState } from "../../../src/client/render/types";

export const SET_W = 2000;
export const SET_H = 1000;
export const SCREEN_W = 1920;
export const SCREEN_H = 1032;

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

/** Land (magnitude 2-12) except a few round seas and the outer rim. */
function isSea(x: number, y: number): boolean {
  if (x < 20 || y < 20 || x >= SET_W - 20 || y >= SET_H - 20) return true;
  const seas: [number, number, number][] = [
    [500, 500, 160],
    [1300, 300, 120],
    [1500, 750, 180],
  ];
  for (const [cx, cy, r] of seas) {
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
  }
  return false;
}

export function makeSetContext(
  settings: Partial<ThreeRenderSettings> = {},
  config?: Config,
): ThreeLayerContext {
  const terrain = new Uint8Array(SET_W * SET_H);
  for (let y = 0; y < SET_H; y++) {
    for (let x = 0; x < SET_W; x++) {
      if (isSea(x, y)) continue;
      terrain[y * SET_W + x] = 0x80 | (2 + ((x * 7 + y * 3) % 11));
    }
  }
  const palette = new Float32Array(4096 * 2 * 4);
  for (let sid = 1; sid <= 24; sid++) {
    const h = (sid * 0.137) % 1;
    const c = new THREE.Color().setHSL(h, 0.6, 0.55);
    palette.set([c.r, c.g, c.b, 1], sid * 4);
    palette.set([c.r * 0.7, c.g * 0.7, c.b * 0.7, 1], 4096 * 4 + sid * 4);
  }
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: SET_W,
    mapHeight: SET_H,
    heightField: new HeightField(SET_W, SET_H, terrain, {
      heightScale: 6,
      seabedDepth: 3,
      targetVertices: 20_000,
    }),
    palette: new PaletteView(palette),
    settings: { ...defaultThreeSettings(), ...settings },
    renderSettings: createRenderSettings(),
    config:
      config ??
      ({
        msPerTick: () => 100,
        unitInfo: () => ({ constructionDuration: 50 }),
        deletionMarkDuration: () => 300,
        SAMCooldown: () => 90,
        SiloCooldown: () => 90,
      } as unknown as Config),
    overlayRoot: document.createElement("div"),
  };
}

const TYPES: [string, number][] = [
  ["City", 0.34],
  ["Port", 0.14],
  ["Factory", 0.16],
  ["Defense Post", 0.16],
  ["SAM Launcher", 0.1],
  ["Missile Silo", 0.1],
];

/** ~`n` structures on land (not on the same tile), owners 1-20, levels 1-5. */
export function lateGameStructures(n = 400, seed = 7): Map<number, UnitState> {
  const r = rng(seed);
  const out = new Map<number, UnitState>();
  const used = new Set<number>();
  let id = 1;
  while (out.size < n) {
    const x = 30 + Math.floor(r() * (SET_W - 60));
    const y = 30 + Math.floor(r() * (SET_H - 60));
    const pos = y * SET_W + x;
    if (isSea(x, y) || used.has(pos)) continue;
    used.add(pos);
    let pick = r();
    let type = TYPES[0][0];
    for (const [t, p] of TYPES) {
      if (pick < p) {
        type = t;
        break;
      }
      pick -= p;
    }
    const level = 1 + Math.floor(r() * r() * 5);
    out.set(id, {
      id,
      unitType: type,
      ownerID: 1 + Math.floor(r() * 20),
      lastOwnerID: null,
      pos,
      lastPos: pos,
      isActive: true,
      reachedTarget: false,
      retreating: false,
      targetable: true,
      waitTicks: 0,
      markedForDeletion: false,
      health: null,
      underConstruction: r() < 0.05,
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
    } as UnitState);
    id++;
  }
  return out;
}

/**
 * A top-down frame over the map centre at `cssPxPerTile` on a 1920×1032
 * screen (the same field of view as `topDownCamera` in the other tests).
 */
export function setFrame(
  nowMs: number,
  cssPxPerTile: number,
  cx = SET_W / 2,
  cz = SET_H / 2,
): FrameInfo {
  const cam = new THREE.PerspectiveCamera(60, SCREEN_W / SCREEN_H, 1, 100_000);
  const focal = SCREEN_H / (2 * Math.tan(Math.PI / 6));
  cam.position.set(cx, focal / cssPxPerTile, cz);
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
    cssWidth: SCREEN_W,
    cssHeight: SCREEN_H,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView: false,
  };
}
