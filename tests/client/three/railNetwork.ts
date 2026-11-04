/**
 * Test helpers for the railway renderer: the real World map terrain and a
 * synthetic late-game railway network on it (shared by RailTracks.test.ts
 * and the benchmark script).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeRailTiles } from "../../../src/client/render/frame/RailroadCache";
import { isLand } from "../../../src/client/render/three/TerrainCodec";

export const WORLD_W = 2000;
export const WORLD_H = 1000;

/** Terrain bytes of the World map (2000×1000, `resources/maps/world`). */
export function worldTerrain(): Uint8Array {
  // vitest and the benchmark both run from the repository root.
  const path = join(process.cwd(), "resources", "maps", "world", "map.bin");
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.length !== WORLD_W * WORLD_H) {
    throw new Error(`world map.bin: ${bytes.length} bytes`);
  }
  return bytes;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Writes a railroad's tile path into `state` like RailroadCache does. */
export function addRailroad(
  state: Uint8Array,
  path: number[],
  W: number,
): void {
  for (const t of computeRailTiles(path, W)) state[t.ref] = t.type + 1;
}

/**
 * Tile path from a to b: an "L" (all of one axis, then the other) or a
 * staircase (alternating unit steps, Bresenham-like) — the two shapes the
 * game's railroads take on open land.
 */
export function railPath(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  W: number,
  staircase: boolean,
  xFirst: boolean,
): number[] {
  const path = [ay * W + ax];
  let x = ax;
  let y = ay;
  const sx = Math.sign(bx - ax);
  const sy = Math.sign(by - ay);
  if (staircase) {
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    while (x !== bx || y !== by) {
      // Step along the axis that is further behind its share.
      const ex = dx === 0 ? 1 : Math.abs(x - ax) / dx;
      const ey = dy === 0 ? 1 : Math.abs(y - ay) / dy;
      if ((ex <= ey && x !== bx) || y === by) x += sx;
      else y += sy;
      path.push(y * W + x);
    }
    return path;
  }
  const stepX = () => {
    while (x !== bx) {
      x += sx;
      path.push(y * W + x);
    }
  };
  const stepY = () => {
    while (y !== by) {
      y += sy;
      path.push(y * W + x);
    }
  };
  if (xFirst) {
    stepX();
    stepY();
  } else {
    stepY();
    stepX();
  }
  return path;
}

/**
 * A late-game railway network of about `targetPieces` half-tile pieces on
 * the land of `terrain`: stations scattered over land, each linked to its
 * nearest neighbours 20-160 tiles away by L-shaped (70%) or staircase (30%)
 * lines over land, with junctions where lines cross. Deterministic.
 */
export function syntheticRailNetwork(
  terrain: Uint8Array,
  W: number,
  H: number,
  targetPieces: number,
  seed = 7,
  /**
   * Optional crowded area [x0, y0, x1, y1] holding 40% of the stations
   * (a large nation's core): the worst case for close-up views.
   */
  dense: readonly [number, number, number, number] | null = null,
): Uint8Array {
  const rand = rng(seed);
  const state = new Uint8Array(W * H);
  const stations: [number, number][] = [];
  const want = Math.max(16, Math.round(targetPieces / 28));
  for (let tries = 0; stations.length < want && tries < want * 200; tries++) {
    let x = 2 + Math.floor(rand() * (W - 4));
    let y = 2 + Math.floor(rand() * (H - 4));
    if (dense !== null && rand() < 0.4) {
      x = dense[0] + Math.floor(rand() * (dense[2] - dense[0]));
      y = dense[1] + Math.floor(rand() * (dense[3] - dense[1]));
    }
    if (isLand(terrain[y * W + x])) stations.push([x, y]);
  }
  let pieces = 0;
  const landShare = (path: number[]) => {
    let land = 0;
    for (const t of path) if (isLand(terrain[t])) land++;
    return land / path.length;
  };
  for (let k = 0; k < 3 && pieces < targetPieces; k++) {
    for (let i = 0; i < stations.length && pieces < targetPieces; i++) {
      const [ax, ay] = stations[i];
      // k-th nearest station within range.
      const near: [number, number][] = [];
      for (let j = 0; j < stations.length; j++) {
        if (j === i) continue;
        const d = Math.abs(stations[j][0] - ax) + Math.abs(stations[j][1] - ay);
        if (d >= 20 && d <= 160) near.push([d, j]);
      }
      near.sort((a, b) => a[0] - b[0]);
      if (near.length <= k) continue;
      const [bx, by] = stations[near[k][1]];
      const path = railPath(ax, ay, bx, by, W, rand() < 0.3, rand() < 0.5);
      if (landShare(path) < 0.9) continue;
      let fresh = 0;
      for (const t of path) if (state[t] === 0) fresh++;
      addRailroad(state, path, W);
      pieces += 2 * fresh;
    }
  }
  return state;
}

/** Number of rail tiles (×2 = pieces) in a state buffer. */
export function railTiles(state: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < state.length; i++) if (state[i] !== 0) n++;
  return n;
}
