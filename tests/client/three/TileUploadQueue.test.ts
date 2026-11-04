import { describe, expect, it } from "vitest";
import {
  TILE_UPLOAD_CELL,
  TILE_UPLOAD_MERGE_WASTE_TEXELS,
  type TileRect,
  TileUploadQueue,
} from "../../../src/client/render/three/TileUploadQueue";

/** Tile refs of a disc (a nuke's blast) of radius r around (cx, cy). */
function disc(W: number, H: number, cx: number, cy: number, r: number) {
  const refs: number[] = [];
  for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) refs.push(y * W + x);
    }
  }
  return refs;
}

function covers(rects: readonly TileRect[], x: number, y: number): boolean {
  return rects.some(
    (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h,
  );
}

const texelsOf = (rects: readonly TileRect[]) =>
  rects.reduce((s, r) => s + r.w * r.h, 0);

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

describe("TileUploadQueue", () => {
  it("sends a hydrogen bomb's disc as one rectangle instead of ~200 rows", () => {
    const W = 2000;
    const H = 1000;
    const q = new TileUploadQueue(W, H);
    const refs = disc(W, H, 700, 400, 100);
    expect(refs.length).toBeGreaterThan(31000);
    q.markTiles(refs);
    const rects = q.take(null);
    expect(rects.length).toBe(1);
    for (const ref of refs) {
      expect(covers(rects, ref % W, Math.floor(ref / W))).toBe(true);
    }
    // At most one cell of slack around the disc's 201×201 bounding box.
    expect(texelsOf(rects)).toBeLessThanOrEqual(
      (201 + 2 * TILE_UPLOAD_CELL) ** 2,
    );
    expect(q.empty).toBe(true);
    expect(q.pendingTexels).toBe(0);
  });

  it("uses 16×16 cells and merges while adding at most 4096 clean texels", () => {
    expect(TILE_UPLOAD_CELL).toBe(16);
    expect(TILE_UPLOAD_MERGE_WASTE_TEXELS).toBe(4096);
    const q = new TileUploadQueue(400, 400);
    // Gap of 16 clean cells (4096 texels): bridged; 17: not.
    q.markTiles([0, 17 * 16]);
    expect(q.take(null).length).toBe(1);
    q.markTiles([0, 18 * 16]);
    expect(q.take(null).length).toBe(2);
  });

  it("keeps scattered changes apart and clips rectangles to the map", () => {
    const W = 1000;
    const H = 500;
    const q = new TileUploadQueue(W, H, 32, 8192);
    // Two lone tiles far apart on the same row, and the bottom-right tile
    // (its cell is clipped by the map edge: 1000 = 31·32 + 8).
    q.markTiles([3 * W + 5, 3 * W + 900, (H - 1) * W + (W - 1)]);
    expect(q.pendingCells).toBe(3);
    expect(q.pendingTexels).toBe(32 * 32 * 2 + 8 * 20);
    const rects = q.take(null).map((r) => ({ ...r }));
    expect(rects).toEqual([
      { x: 0, y: 0, w: 32, h: 32 },
      { x: 896, y: 0, w: 32, h: 32 },
      { x: 992, y: 480, w: 8, h: 20 },
    ]);
  });

  it("bridges small gaps and merges rows while little clean area is added", () => {
    const W = 640;
    const H = 640;
    // 32×32 cells, merges may add 8 clean cells.
    const q = new TileUploadQueue(W, H, 32, 8 * 32 * 32);
    // Cells (0,0) and (3,0): a gap of 2 clean cells is bridged.
    q.markTiles([0, 3 * 32]);
    // A thin diagonal staircase: cells (5,5), (6,6), (7,7) merge into one
    // 3×3-cell rectangle (6 clean cells ≤ the merge waste).
    q.markTiles([
      5 * 32 * W + 5 * 32,
      6 * 32 * W + 6 * 32,
      7 * 32 * W + 7 * 32,
    ]);
    const rects = q.take(null).map((r) => ({ ...r }));
    expect(rects).toEqual([
      { x: 0, y: 0, w: 4 * 32, h: 32 },
      { x: 5 * 32, y: 5 * 32, w: 3 * 32, h: 3 * 32 },
    ]);
  });

  it("marks tile rectangles", () => {
    const q = new TileUploadQueue(100, 100, 32);
    q.markRect(30, 30, 5, 40); // cells x 0..1, y 0..2
    expect(q.pendingCells).toBe(6);
    expect(q.isTileDirty(33, 69)).toBe(true);
    expect(q.isTileDirty(70, 10)).toBe(false);
    q.markRect(-10, 99, 15, 5); // clipped to [0, 5) × [99, 100): cell (0, 3)
    expect(q.pendingCells).toBe(7);
    q.markRect(10, 10, 0, 5); // empty
    expect(q.pendingCells).toBe(7);
    q.clear();
    expect(q.empty).toBe(true);
    expect(q.take({ maxCalls: 4, maxTexels: 1e6 })).toEqual([]);
  });

  it("respects the per-take budget but always makes progress", () => {
    const W = 4096;
    const H = 2048;
    const q = new TileUploadQueue(W, H);
    const r = rng(7);
    const refs: number[] = [];
    for (let i = 0; i < 3000; i++) {
      refs.push(Math.floor(r() * H) * W + Math.floor(r() * W));
    }
    q.markTiles(refs);
    const budget = { maxCalls: 6, maxTexels: 40_000 };
    let takes = 0;
    while (!q.empty) {
      const before = q.pendingCells;
      const rects = q.take(budget);
      takes++;
      expect(rects.length).toBeGreaterThan(0);
      expect(rects.length).toBeLessThanOrEqual(budget.maxCalls);
      if (rects.length > 1) {
        expect(texelsOf(rects)).toBeLessThanOrEqual(budget.maxTexels);
      }
      expect(q.pendingCells).toBeLessThan(before);
      expect(takes).toBeLessThan(10_000);
    }
    // A budget smaller than one rectangle still sends one per take.
    q.markTiles(disc(W, H, 500, 500, 100));
    const one = q.take({ maxCalls: 8, maxTexels: 10 });
    expect(one.length).toBe(1);
  });

  it("never drops a change: a mirrored GPU copy converges to the live buffer", () => {
    const W = 777;
    const H = 333;
    const live = new Uint16Array(W * H);
    const gpu = new Uint16Array(W * H);
    const q = new TileUploadQueue(W, H);
    const r = rng(42);
    const budget = { maxCalls: 3, maxTexels: 20_000 };
    const upload = (rects: readonly TileRect[]) => {
      for (const rc of rects) {
        for (let y = rc.y; y < rc.y + rc.h; y++) {
          for (let x = rc.x; x < rc.x + rc.w; x++) {
            gpu[y * W + x] = live[y * W + x];
          }
        }
      }
    };
    for (let tick = 0; tick < 200; tick++) {
      // A tick: a burst (sometimes a nuke-sized disc) of changes, written to
      // the live buffer and reported, then a few budgeted frames.
      const changed =
        tick % 50 === 7
          ? disc(W, H, Math.floor(r() * W), Math.floor(r() * H), 100)
          : Array.from(
              { length: Math.floor(r() * 300) },
              () => Math.floor(r() * H) * W + Math.floor(r() * W),
            );
      for (const ref of changed) live[ref] = (live[ref] + 1 + tick) & 0xffff;
      q.markTiles(changed);
      for (let f = 0; f < 6; f++) upload(q.take(budget));
      // Every tile that differs is still queued.
      for (let i = 0; i < W * H; i += 97) {
        if (gpu[i] !== live[i]) {
          expect(q.isTileDirty(i % W, Math.floor(i / W))).toBe(true);
        }
      }
    }
    while (!q.empty) upload(q.take(budget));
    expect(gpu).toEqual(live);
  });

  it("serves old cells round robin while new changes keep arriving", () => {
    const W = 1024;
    const H = 1024;
    const q = new TileUploadQueue(W, H);
    // An old change at the bottom of the map.
    q.markTiles([(H - 1) * W + 512]);
    let served = -1;
    for (let frame = 0; frame < 40 && served < 0; frame++) {
      // Every frame, fresh changes far apart near the top, more than the
      // budget can send in one take.
      q.markTiles([
        (frame % 32) * W + 10,
        (frame % 32) * W + 400,
        (frame % 32) * W + 800,
      ]);
      const rects = q.take({ maxCalls: 2, maxTexels: 1e6 });
      if (covers(rects, 512, H - 1)) served = frame;
    }
    expect(served).toBeGreaterThanOrEqual(0);
    expect(served).toBeLessThan(10);
  });
});
