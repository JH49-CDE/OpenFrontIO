import { describe, expect, it } from "vitest";
import {
  DENSE_FRACTION,
  FALLOUT_CELL,
  FALLOUT_SMOKE_ALPHA,
  FALLOUT_SMOKE_ZOOM,
  FalloutField,
  falloutPuff,
  falloutSmokeZoomFade,
} from "../../../src/client/render/three/FalloutField";
import { FALLOUT_BIT } from "../../../src/client/render/three/TerrainCodec";

/** Seeded [0, 1) generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reference count of fallout tiles per cell, by brute force. */
function bruteCounts(state: Uint16Array, W: number, H: number): number[] {
  const cx = Math.ceil(W / FALLOUT_CELL);
  const out = new Array(cx * Math.ceil(H / FALLOUT_CELL)).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (state[y * W + x] & FALLOUT_BIT) {
        out[Math.floor(y / FALLOUT_CELL) * cx + Math.floor(x / FALLOUT_CELL)]++;
      }
    }
  }
  return out;
}

describe("FalloutField (lot 3, item 5)", () => {
  it("counts fallout tiles per cell from each tick's changed tiles", () => {
    const W = 37;
    const H = 21; // edge cells narrower than FALLOUT_CELL
    const state = new Uint16Array(W * H);
    const field = new FalloutField(W, H);
    expect(field.cellsX).toBe(5);
    expect(field.cellsY).toBe(3);
    const rand = rng(7);
    for (let tick = 0; tick < 40; tick++) {
      const changed: number[] = [];
      for (let k = 0; k < 30; k++) {
        const ref = Math.floor(rand() * W * H);
        // Owner bits change too: only the fallout bit counts.
        state[ref] = (rand() < 0.6 ? FALLOUT_BIT : 0) | (tick & 0xfff);
        changed.push(ref);
      }
      field.applyChanges(state, changed);
      expect(Array.from(field.counts)).toEqual(bruteCounts(state, W, H));
      expect(field.total).toBe(
        bruteCounts(state, W, H).reduce((a, b) => a + b, 0),
      );
    }
    // Repeated and out-of-range refs are harmless.
    const before = Array.from(field.counts);
    expect(field.applyChanges(state, [0, 0, -1, W * H])).toBe(0);
    expect(Array.from(field.counts)).toEqual(before);
  });

  it("marks a cell dense from DENSE_FRACTION of its tiles, edge cells too", () => {
    const W = 12; // cells 8 and 4 tiles wide
    const H = 8;
    const state = new Uint16Array(W * H);
    const field = new FalloutField(W, H);
    const full = Math.ceil(DENSE_FRACTION * FALLOUT_CELL * FALLOUT_CELL);
    const refs: number[] = [];
    for (let i = 0; i < full - 1; i++) {
      const ref = Math.floor(i / 8) * W + (i % 8);
      state[ref] = FALLOUT_BIT;
      refs.push(ref);
    }
    field.applyChanges(state, refs);
    expect(field.isDense(0)).toBe(false);
    const v = field.version;
    const last = Math.floor((full - 1) / 8) * W + ((full - 1) % 8);
    state[last] = FALLOUT_BIT;
    field.applyChanges(state, [last]);
    expect(field.isDense(0)).toBe(true);
    expect(field.denseCells).toBe(1);
    expect(field.version).toBe(v + 1);
    // The 4 x 8 edge cell: 60% of 32 tiles.
    expect(field.cellTiles(1)).toBe(32);
    const edge: number[] = [];
    for (let i = 0; i < Math.ceil(DENSE_FRACTION * 32); i++) {
      const ref = Math.floor(i / 4) * W + 8 + (i % 4);
      state[ref] = FALLOUT_BIT;
      edge.push(ref);
    }
    field.applyChanges(state, edge);
    expect(field.isDense(1)).toBe(true);
    // Cleaning one tile drops it again (swap-remove keeps the list exact).
    state[edge[0]] = 0;
    field.applyChanges(state, [edge[0]]);
    expect(field.isDense(1)).toBe(false);
    expect(field.isDense(0)).toBe(true);
    expect(field.denseCells).toBe(1);
  });

  it("re-reads a full upload over several bounded steps", () => {
    const W = 64;
    const H = 40;
    const state = new Uint16Array(W * H);
    const rand = rng(3);
    for (let i = 0; i < state.length; i++) {
      if (rand() < 0.4) state[i] = FALLOUT_BIT;
    }
    const field = new FalloutField(W, H);
    field.reset(state);
    expect(field.rebuilding).toBe(true);
    let steps = 0;
    while (field.rebuilding) {
      // At most 7 rows per step here (the budget also caps it by time).
      const rows = field.step(Infinity, 7);
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(7);
      steps++;
      if (steps === 2) {
        // A tick lands mid-rebuild: rows already read update at once, rows
        // not read yet are left to the rebuild (no double count).
        const read = 3 * W + 5;
        const unread = 30 * W + 9;
        state[read] ^= FALLOUT_BIT;
        state[unread] ^= FALLOUT_BIT;
        field.applyChanges(state, [read, unread]);
      }
    }
    expect(steps).toBe(Math.ceil(H / 7));
    expect(Array.from(field.counts)).toEqual(bruteCounts(state, W, H));
    expect(field.step()).toBe(0); // idle
    // The time budget: a step always reads at least one row.
    field.reset(state);
    expect(field.step(0)).toBe(1);
  });

  it("picks smoke emitters only on fallout tiles of dense cells in the view", () => {
    const W = 64;
    const H = 64;
    const state = new Uint16Array(W * H);
    const refs: number[] = [];
    // A dense block (cells (1..2, 1..2)) and a sparse cell (6, 6).
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        if ((x + y) % 5 !== 0) {
          state[y * W + x] = FALLOUT_BIT;
          refs.push(y * W + x);
        }
      }
    }
    state[50 * W + 50] = FALLOUT_BIT;
    refs.push(50 * W + 50);
    const field = new FalloutField(W, H);
    field.applyChanges(state, refs);
    expect(field.denseCells).toBe(4);
    const rand = rng(11);
    let found = 0;
    for (let i = 0; i < 300; i++) {
      const e = field.pickEmitter(0, 0, W, H, rand);
      if (e === null) continue;
      found++;
      expect(field.hasFallout(e.x, e.y)).toBe(true);
      expect(e.x >= 8 && e.x < 24 && e.y >= 8 && e.y < 24).toBe(true);
    }
    expect(found).toBeGreaterThan(250);
    // A view holding no dense cell finds nothing.
    expect(field.pickEmitter(32, 32, 64, 64, rand)).toBeNull();
    // A view holding part of the block only picks in it.
    for (let i = 0; i < 100; i++) {
      const e = field.pickEmitter(16, 0, 64, 16, rand);
      if (e === null) continue;
      expect(e.x >= 16 && e.x < 24 && e.y >= 8 && e.y < 16).toBe(true);
    }
  });
});

describe("fallout smoke puffs (lot 3, item 5)", () => {
  it("loops without a pop: invisible at birth and at the end of its life", () => {
    expect(falloutPuff(0).alpha).toBe(0);
    expect(falloutPuff(1).alpha).toBeCloseTo(0, 6);
    let peak = 0;
    let prev = falloutPuff(0);
    for (let i = 1; i <= 100; i++) {
      const p = falloutPuff(i / 100);
      peak = Math.max(peak, p.alpha);
      // Rises, drifts and grows all its life.
      expect(p.rise).toBeGreaterThan(prev.rise);
      expect(p.drift).toBeGreaterThan(prev.drift);
      expect(p.size).toBeGreaterThan(prev.size);
      prev = p;
    }
    expect(peak).toBeCloseTo(FALLOUT_SMOKE_ALPHA, 2);
    // Thin smoke: never an opaque ball.
    expect(FALLOUT_SMOKE_ALPHA).toBeLessThanOrEqual(0.4);
  });

  it("only shows from FALLOUT_SMOKE_ZOOM on", () => {
    expect(falloutSmokeZoomFade(0.7)).toBe(0);
    expect(falloutSmokeZoomFade(FALLOUT_SMOKE_ZOOM[0])).toBe(0);
    expect(falloutSmokeZoomFade(FALLOUT_SMOKE_ZOOM[1])).toBe(1);
    expect(falloutSmokeZoomFade(11)).toBe(1);
    const mid = falloutSmokeZoomFade(
      (FALLOUT_SMOKE_ZOOM[0] + FALLOUT_SMOKE_ZOOM[1]) / 2,
    );
    expect(mid).toBeCloseTo(0.5, 6);
  });
});
