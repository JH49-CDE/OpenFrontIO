/**
 * RailTracks: piece transforms, incremental per-block rebuilds under a time
 * budget, strip slots, detail selection (frustum + screen size), the low
 * quality mode, and loose performance bounds on a synthetic late-game
 * network on the real World map.
 */
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { CameraRig } from "../../../src/client/render/three/CameraRig";
import { HeightField } from "../../../src/client/render/three/HeightField";
import {
  DETAIL_OFF_PX,
  DETAIL_ON_PX,
  pxPerTileAtDepth,
  RAIL_BUDGET_MS,
  RAIL_DIR_X,
  RAIL_DIR_Z,
  RAIL_FADE_GAIN,
  RAIL_FADE_RANGE,
  RAIL_MIN_ZOOM,
  railDetailWanted,
  railHalfDirections,
  railSlotCapacity,
  railStripLook,
  RailTracks,
  writeRailPieceMatrix,
} from "../../../src/client/render/three/RailTracks";
import {
  defaultThreeSettings,
  type ThreeQuality,
} from "../../../src/client/render/three/ThreeSettings";
import type { FrameInfo } from "../../../src/client/render/three/types";
import {
  addRailroad,
  railPath,
  railTiles,
  syntheticRailNetwork,
  WORLD_H,
  WORLD_W,
  worldTerrain,
} from "./railNetwork";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** Rolling terrain: land everywhere, magnitude varying with x and y. */
function hillyField(W: number, H: number): HeightField {
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = Math.round(8 + 6 * Math.sin(x / 9) + 5 * Math.cos(y / 7));
      terrain[y * W + x] = 0x80 | Math.max(0, Math.min(30, m));
    }
  }
  return new HeightField(W, H, terrain, {
    heightScale: 6,
    seabedDepth: 3,
    targetVertices: 20_000,
  });
}

/** A frame seen by the facade's camera rig (1920×1032 CSS px, tilted). */
function rigFrame(
  W: number,
  H: number,
  hf: HeightField,
  cx: number,
  cy: number,
  zoom: number,
): FrameInfo {
  const rig = new CameraRig(defaultThreeSettings(), W, H, hf);
  rig.update({
    centerX: cx,
    centerY: cy,
    cssPxPerTile: zoom,
    cssWidth: 1920,
    cssHeight: 1032,
  });
  return {
    nowMs: 0,
    dtMs: 16,
    tickAlpha: 1,
    camera: rig.camera,
    cssPxPerTile: zoom,
    tilt: rig.tilt,
    cssWidth: 1920,
    cssHeight: 1032,
    dpr: 1,
    localPlayerID: 0,
    highlightOwner: 0,
    altView: false,
  };
}

interface Setup {
  scene: THREE.Scene;
  hf: HeightField;
  rails: RailTracks;
  settings: { quality: ThreeQuality };
}

function setup(
  W: number,
  H: number,
  opts: {
    hf?: HeightField;
    budgetMs?: number;
    clock?: () => number;
    blockSize?: number;
  } = {},
): Setup {
  const scene = new THREE.Scene();
  const hf = opts.hf ?? hillyField(W, H);
  const settings = { quality: "high" as ThreeQuality };
  const rails = new RailTracks(scene, hf, W, H, settings, {
    budgetMs: opts.budgetMs ?? Infinity,
    clock: opts.clock,
    blockSize: opts.blockSize,
  });
  disposers.push(() => rails.dispose());
  return { scene, hf, rails, settings };
}

function mesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const m = scene.getObjectByName(name);
  if (!(m instanceof THREE.InstancedMesh)) throw new Error(`no ${name}`);
  return m;
}

/** Sorted "x,z,dir" keys of the non-degenerate instances of a mesh. */
function pieceKeys(m: THREE.InstancedMesh): string[] {
  const out: string[] = [];
  const a = m.instanceMatrix.array;
  for (let i = 0; i < m.count; i++) {
    const o = i * 16;
    if (a[o + 15] === 0) continue; // zero slot
    const dir = Math.round(Math.atan2(a[o + 2], a[o]) * (2 / Math.PI));
    out.push(`${a[o + 12]},${a[o + 14]},${dir}`);
  }
  return out.sort();
}

/**
 * What the GPU holds for each instance buffer, replaying three's attribute
 * uploads (WebGLAttributes.update): a new attribute is uploaded whole, then
 * a version bump uploads its `updateRanges` (all of it when there are none)
 * and clears them. Only meshes three draws (visible, count > 0) upload.
 */
class GpuMirror {
  private readonly copies = new Map<
    THREE.BufferAttribute,
    { data: Float32Array; version: number }
  >();

  /** Upload what three would upload when drawing `m`; returns its copy. */
  draw(m: THREE.InstancedMesh): Float32Array | null {
    const attr = m.instanceMatrix;
    const array = attr.array as Float32Array;
    let copy = this.copies.get(attr);
    if (!m.visible || m.count === 0) return copy?.data ?? null;
    if (copy === undefined) {
      copy = { data: array.slice(), version: attr.version };
      this.copies.set(attr, copy);
    } else if (copy.version < attr.version) {
      if (attr.updateRanges.length === 0) copy.data.set(array);
      for (const r of attr.updateRanges) {
        copy.data.set(array.subarray(r.start, r.start + r.count), r.start);
      }
      attr.clearUpdateRanges();
      copy.version = attr.version;
    }
    return copy.data;
  }
}

/** Sorted "x,z,dir" keys of the non-degenerate instances the GPU draws. */
function gpuPieceKeys(gpu: GpuMirror, m: THREE.InstancedMesh): string[] | null {
  const a = gpu.draw(m);
  if (a === null) return null;
  const out: string[] = [];
  for (let i = 0; i < m.count; i++) {
    const o = i * 16;
    if (a[o + 15] === 0) continue;
    const dir = Math.round(Math.atan2(a[o + 2], a[o]) * (2 / Math.PI));
    out.push(`${a[o + 12]},${a[o + 14]},${dir}`);
  }
  return out.sort();
}

/** The keys every rail tile of `state` should produce. */
function expectedKeys(state: Uint8Array, W: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < state.length; i++) {
    if (state[i] === 0) continue;
    const x = (i % W) + 0.5;
    const z = Math.floor(i / W) + 0.5;
    for (const a of railHalfDirections(state[i])) {
      out.push(`${x},${z},${Math.round(a * (2 / Math.PI))}`);
    }
  }
  return out.sort();
}

describe("rail piece transforms", () => {
  it("match the old Euler(0, −a, atan2(dh, ½), YZX) composition", () => {
    const out = new Float32Array(16);
    const ref = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3(12.5, 3.25, 40.5);
    const one = new THREE.Vector3(1, 1, 1);
    for (let d = 0; d < 4; d++) {
      for (const dh of [0, 0.3, -0.7, 2.5]) {
        const dx = RAIL_DIR_X[d];
        const dz = RAIL_DIR_Z[d];
        writeRailPieceMatrix(out, 0, p.x, p.y, p.z, dx, dz, dh);
        const a = Math.atan2(dz, dx);
        e.set(0, -a, Math.atan2(dh, 0.5), "YZX");
        ref.compose(p, q.setFromEuler(e), one);
        for (let k = 0; k < 16; k++) {
          expect(out[k]).toBeCloseTo(ref.elements[k], 5);
        }
        // The far end climbs along the slope towards the tile edge.
        const end = new THREE.Vector3(0.5, 0, 0).applyMatrix4(
          new THREE.Matrix4().fromArray(out),
        );
        expect(end.y - p.y).toBeCloseTo(
          (dh / 0.5) * Math.hypot(end.x - p.x, end.z - p.z),
          5,
        );
        expect(Math.sign(end.x - p.x)).toBe(Math.sign(dx));
        expect(Math.sign(end.z - p.z)).toBe(Math.sign(dz));
      }
    }
  });

  it("switches a block's detail on and off with hysteresis", () => {
    expect(railDetailWanted(DETAIL_ON_PX, false)).toBe(true);
    expect(railDetailWanted(DETAIL_ON_PX - 0.01, false)).toBe(false);
    expect(railDetailWanted(DETAIL_OFF_PX, true)).toBe(true);
    expect(railDetailWanted(DETAIL_OFF_PX - 0.01, true)).toBe(false);
  });

  it("sizes slots with slack and converts depth to screen size", () => {
    expect(railSlotCapacity(0)).toBe(8);
    expect(railSlotCapacity(100)).toBe(125);
    // 30° fov, 1032 px tall: focal length ≈ 1926 px.
    expect(pxPerTileAtDepth(1926, 30, 1032)).toBeCloseTo(1, 2);
    expect(pxPerTileAtDepth(0, 30, 1032)).toBe(Infinity);
  });
});

describe("RailTracks incremental rebuilds", () => {
  const W = 256;
  const H = 192;

  function network(): Uint8Array {
    const st = new Uint8Array(W * H);
    // Long lines through several 64-tile blocks, a staircase and junctions.
    addRailroad(st, railPath(4, 10, 250, 10, W, false, true), W);
    addRailroad(st, railPath(30, 5, 200, 180, W, false, false), W);
    addRailroad(st, railPath(100, 20, 180, 120, W, true, true), W);
    addRailroad(st, railPath(70, 150, 240, 60, W, false, true), W);
    return st;
  }

  it("builds every piece once and draws them all as strips", () => {
    const { scene, rails, hf } = setup(W, H);
    const st = network();
    rails.set(st);
    rails.update(rigFrame(W, H, hf, W / 2, H / 2, 1.8));
    expect(rails.pieces).toBe(2 * railTiles(st));
    expect(pieceKeys(mesh(scene, "rails"))).toEqual(expectedKeys(st, W));
    const s = rails.stats();
    expect(s.blocksPending).toBe(0);
    expect(s.blocks).toBeGreaterThan(4);
    expect(s.detailPieces).toBe(0);
    // Strip slots carry ≈25% slack (zero matrices, no pixels).
    expect(s.triangles).toBe(mesh(scene, "rails").count * 2);
    expect(mesh(scene, "rails").count).toBeLessThan(
      rails.pieces * 1.25 + 8 * s.blocks + 1,
    );
  });

  it("rebuilds only the blocks whose tiles changed", () => {
    const { scene, rails, hf } = setup(W, H);
    const st = network();
    const f = rigFrame(W, H, hf, W / 2, H / 2, 1.8);
    rails.set(st);
    rails.update(f);
    const strip = mesh(scene, "rails");
    // Same buffer handed over again, nothing changed: nothing rebuilt.
    rails.set(st);
    rails.update(f);
    expect(rails.stats().blocksRebuilt).toBe(0);
    // A new spur inside one block.
    addRailroad(st, railPath(140, 140, 150, 140, W, false, true), W);
    rails.set(st);
    rails.update(f);
    expect(rails.stats().blocksRebuilt).toBe(1);
    // Edits in three blocks; one of them removes a line's tiles.
    addRailroad(st, railPath(10, 70, 20, 70, W, false, true), W);
    addRailroad(st, railPath(200, 160, 210, 160, W, false, true), W);
    for (let x = 4; x < 60; x++) st[10 * W + x] = 0;
    rails.set(st);
    rails.update(f);
    expect(rails.stats().blocksRebuilt).toBe(3);
    expect(pieceKeys(mesh(scene, "rails"))).toEqual(expectedKeys(st, W));
    expect(mesh(scene, "rails")).toBe(strip);
    expect(rails.stats().uploadBytes).toBeLessThan(strip.count * 64 * 0.75);
  });

  it("spreads the work over frames within the time budget", () => {
    // Fake clock: every read advances 1 ms → the small diff pass fits in
    // one chunk, then 2 blocks per 1.5 ms frame.
    let t = 0;
    const { scene, rails, hf } = setup(W, H, {
      budgetMs: 1.5,
      clock: () => t++,
    });
    const st = network();
    const f = rigFrame(W, H, hf, W / 2, H / 2, 1.8);
    rails.set(st);
    rails.update(f);
    const first = rails.stats();
    expect(first.blocksRebuilt).toBe(2);
    expect(first.blocksPending).toBeGreaterThan(0);
    let frames = 1;
    while (rails.stats().blocksPending > 0 && frames < 100) {
      rails.update(f);
      expect(rails.stats().blocksRebuilt).toBeLessThanOrEqual(2);
      frames++;
    }
    expect(frames).toBeGreaterThan(2);
    expect(pieceKeys(mesh(scene, "rails"))).toEqual(expectedKeys(st, W));
  });

  it("re-drapes only the blocks under a terrain patch", () => {
    const { scene, rails, hf } = setup(W, H);
    const st = network();
    const f = rigFrame(W, H, hf, W / 2, H / 2, 1.8);
    rails.set(st);
    rails.update(f);
    // Flatten a 6×6 patch to sea level near (140, 10) (on the first line).
    const bytes = new Uint8Array(36).fill(0x20);
    hf.applyRects([{ x: 137, y: 7, w: 6, h: 6 }], bytes);
    rails.update(f);
    const s = rails.stats();
    expect(s.blocksRebuilt).toBeGreaterThanOrEqual(1);
    expect(s.blocksRebuilt).toBeLessThanOrEqual(2);
    const strip = mesh(scene, "rails");
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let found = false;
    for (let i = 0; i < strip.count; i++) {
      strip.getMatrixAt(i, m);
      if (m.elements[15] === 0) continue;
      p.setFromMatrixPosition(m);
      if (p.x === 140.5 && p.z === 10.5) {
        expect(p.y).toBeCloseTo(hf.surfaceAt(140.5, 10.5), 5);
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("moves outgrown blocks and compacts the strip buffer", () => {
    const { scene, rails, hf } = setup(W, H, { blockSize: 16 });
    const st = new Uint8Array(W * H);
    const f = rigFrame(W, H, hf, W / 2, H / 2, 1.8);
    // Grow 36 blocks one tile per row at a time: each outgrows its slot
    // again and again, leaving holes until the buffer is compacted.
    for (let step = 0; step < 40; step++) {
      for (let y = 2; y < H; y += 4) st[y * W + step] = 2;
      rails.set(st);
      rails.update(f);
    }
    expect(pieceKeys(mesh(scene, "rails"))).toEqual(expectedKeys(st, W));
    // Holes never exceed half the live slots (+2048 pieces).
    expect(mesh(scene, "rails").count).toBeLessThan(
      railSlotCapacity(rails.pieces) * 1.5 + 2048 + 12 * rails.stats().blocks,
    );
    // Removing everything empties the draw.
    st.fill(0);
    rails.set(st);
    rails.update(f);
    expect(rails.pieces).toBe(0);
    expect(mesh(scene, "rails").visible).toBe(false);
  });

  it("keeps the GPU copy of the strips exact through moves and compactions", () => {
    // Regression: a compaction re-packed the slots in the CPU array but only
    // uploaded the pieces, so the GPU kept old matrices in the slack of the
    // new slots and drew pieces twice (or removed ones as ghosts). Few
    // blocks, so the upload ranges are not collapsed into one.
    const { scene, rails, hf } = setup(W, H);
    const st = new Uint8Array(W * H);
    const f = rigFrame(W, H, hf, W / 2, H / 2, 1.8);
    const gpu = new GpuMirror();
    // A dense block built first (low slots), then a single tile in block 0
    // and a block that grows one row per step (moves, holes, compactions).
    for (let y = 130; y < H; y += 2) st.fill(2, y * W + 192, y * W + W);
    let compactions = 0;
    let lastCount = 0;
    for (let step = 0; step < 64; step++) {
      if (step === 1) st[2 * W + 2] = 2;
      st.fill(2, (64 + step) * W + 64, (64 + step) * W + 128);
      // Remove part of the dense block now and then: those must vanish.
      if (step % 9 === 8)
        st.fill(0, (130 + step) * W + 192, (130 + step) * W + W);
      rails.set(st);
      rails.update(f);
      const strip = mesh(scene, "rails");
      if (strip.count < lastCount) compactions++;
      lastCount = strip.count;
      expect(gpuPieceKeys(gpu, strip)).toEqual(expectedKeys(st, W));
    }
    expect(compactions).toBeGreaterThan(0);
  });
});

describe("RailTracks detail level", () => {
  const W = 512;
  const H = 512;

  function grid(): Uint8Array {
    const st = new Uint8Array(W * H);
    for (let k = 16; k < W; k += 64) {
      addRailroad(st, railPath(k, 4, k, H - 4, W, false, true), W);
      addRailroad(st, railPath(4, k, W - 4, k, W, false, true), W);
    }
    return st;
  }

  it("adds sleepers and rails only to near blocks in view", () => {
    const { scene, rails, hf, settings } = setup(W, H);
    rails.set(grid());
    // Zoomed out: strips only.
    rails.update(rigFrame(W, H, hf, 256, 256, 1.5));
    expect(rails.stats().detailBlocks).toBe(0);
    // Close up over one corner, tilted: a few blocks around the centre.
    const close = rigFrame(W, H, hf, 100, 100, 14);
    rails.update(close);
    const s = rails.stats();
    expect(s.detailBlocks).toBeGreaterThan(0);
    expect(s.detailBlocks).toBeLessThan(s.blocks / 3);
    const detail = mesh(scene, "rails-detail");
    expect(detail.count).toBe(s.detailPieces);
    expect(s.triangles).toBe(
      mesh(scene, "rails").count * 2 + s.detailPieces * 16,
    );
    // Every detailed piece is within ~2 blocks of the view centre.
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < detail.count; i++) {
      detail.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(Math.abs(p.x - 100)).toBeLessThan(192);
      expect(Math.abs(p.z - 100)).toBeLessThan(192);
    }
    // Low quality: strips only, whatever the zoom.
    settings.quality = "low";
    rails.update(close);
    expect(rails.stats().detailBlocks).toBe(0);
    expect(mesh(scene, "rails-detail").visible).toBe(false);
  });

  it("refreshes detail instances when a detailed block is rebuilt", () => {
    const { scene, rails, hf } = setup(W, H);
    const st = grid();
    rails.set(st);
    const close = rigFrame(W, H, hf, 100, 100, 14);
    rails.update(close);
    const before = rails.stats().detailPieces;
    addRailroad(st, railPath(90, 90, 110, 90, W, false, true), W);
    rails.set(st);
    rails.update(close);
    expect(rails.stats().detailPieces).toBeGreaterThan(before);
    expect(mesh(scene, "rails-detail").count).toBe(rails.stats().detailPieces);
  });
});

describe("RailTracks on a late-game World network (loose bounds)", () => {
  // ~25k pieces on the real 2000×1000 World map, 40% of the stations in a
  // crowded Europe / Middle East.
  const terrain = worldTerrain();
  const hf = new HeightField(WORLD_W, WORLD_H, terrain, {
    heightScale: 6,
    seabedDepth: 3,
    targetVertices: 600_000,
  });
  const state = syntheticRailNetwork(
    terrain,
    WORLD_W,
    WORLD_H,
    25_000,
    7,
    [900, 120, 1250, 420],
  );
  const view = (cx: number, cy: number, zoom: number) =>
    rigFrame(WORLD_W, WORLD_H, hf, cx, cy, zoom);

  it("stays under the triangle targets at every zoom", () => {
    const { rails } = setup(WORLD_W, WORLD_H, { hf });
    rails.set(state);
    rails.update(view(1000, 500, 0.96));
    expect(rails.pieces).toBeGreaterThan(24_000);
    // Full map and default zoom (1.8): strips only, < 150k (was 60/piece).
    expect(rails.stats().triangles).toBeLessThan(150_000);
    rails.update(view(1075, 270, 1.8));
    expect(rails.stats().triangles).toBeLessThan(150_000);
    // Close up over the crowded area: < 400k.
    for (const zoom of [4, 6, 8, 12, 20]) {
      rails.update(view(1075, 270, zoom));
      expect(rails.stats().triangles, `zoom ${zoom}`).toBeLessThan(400_000);
    }
    expect(rails.stats().detailPieces).toBeGreaterThan(0);
  });

  it("keeps per-frame rail JS bounded during the initial build and edits", () => {
    const { rails } = setup(WORLD_W, WORLD_H, { hf, budgetMs: RAIL_BUDGET_MS });
    const f = view(1075, 270, 1.8);
    /** Frames until idle; blocks rebuilt over them. */
    const settle = () => {
      let rebuilt = 0;
      let frames = 0;
      do {
        rails.update(f);
        rebuilt += rails.stats().blocksRebuilt;
        frames++;
      } while (rails.stats().blocksPending > 0 && frames < 500);
      expect(rails.stats().blocksPending).toBe(0);
      return rebuilt;
    };
    const live = new Uint8Array(state);
    rails.set(live);
    // Every block once (a few twice: rebuilds run while the diff pass is
    // still marking lower rows of the same block).
    const initial = settle();
    expect(initial).toBeGreaterThanOrEqual(rails.stats().blocks);
    expect(initial).toBeLessThan(rails.stats().blocks * 1.25);
    expect(rails.pieces).toBe(2 * railTiles(state));
    // Edit one block, then ten.
    addRailroad(
      live,
      railPath(1030, 300, 1050, 300, WORLD_W, false, true),
      WORLD_W,
    );
    rails.set(live);
    expect(settle()).toBe(1);
    for (let k = 0; k < 10; k++) {
      const x = 40 + k * 190;
      addRailroad(
        live,
        railPath(x, 900, x + 8, 900, WORLD_W, false, true),
        WORLD_W,
      );
    }
    rails.set(live);
    expect(settle()).toBe(10);
    // Loose wall-clock bound (CI machines vary): far below the 21-47 ms
    // stalls of the full rebuild this replaces.
    expect(rails.stats().jsMsMax).toBeLessThan(15);
  });
});

describe("RailTracks strip fade (default renderer semantics, lot 3)", () => {
  it("uses the default renderer's railroad thresholds", () => {
    // RailroadPass: invisible at railMinZoom - railFadeRange device px per
    // tile and below, full from railMinZoom.
    const rs = createRenderSettings().railroad;
    expect(RAIL_MIN_ZOOM).toBe(rs.railMinZoom);
    expect(RAIL_FADE_RANGE).toBe(rs.railFadeRange);
  });

  it("fades the strips out below 3 device px per tile, by device px", () => {
    // Full map (0.7 CSS px per tile) on a 1x screen: hidden.
    expect(railStripLook(0.7, 1)).toMatchObject({ visibility: 0, opacity: 0 });
    expect(railStripLook(1, 1).visibility).toBe(0);
    // Default zoom (1.8): visibility 40% as the default; the strip, half
    // as wide as the default's line, at 1.5 x 40% of the lot-1 light strip
    // (55%): 33%.
    const def = railStripLook(1.8, 1);
    expect(def.visibility).toBeCloseTo(0.4, 9);
    expect(def.opacity).toBeCloseTo(RAIL_FADE_GAIN * 0.4 * 0.55, 9);
    // The lot-1 look (55%) again from ~2.3 device px per tile.
    expect(railStripLook(2.4, 1).opacity).toBeCloseTo(
      0.55 + 0.45 * railStripLook(2.4, 1).colorT,
      9,
    );
    expect(def.colorT).toBe(0);
    // 3 device px and up: the lot-1 ramp unchanged (ballast, opaque at 5).
    expect(railStripLook(3, 1).visibility).toBe(1);
    expect(railStripLook(5, 1)).toMatchObject({
      visibility: 1,
      colorT: 1,
      opacity: 1,
    });
    // A 2x screen reaches the same device px at half the CSS zoom.
    expect(railStripLook(0.9, 2).visibility).toBeCloseTo(
      railStripLook(1.8, 1).visibility,
      9,
    );
    expect(railStripLook(1.5, 2).visibility).toBe(1);
    // Monotonic in the zoom.
    let prev = -1;
    for (let z = 0.5; z <= 8; z += 0.1) {
      const o = railStripLook(z, 1).opacity;
      expect(o).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = o;
    }
  });

  it("does not draw the strips while faded out, and keeps rebuilding", () => {
    const W = 256;
    const H = 256;
    const { scene, rails, hf } = setup(W, H);
    const st = new Uint8Array(W * H);
    addRailroad(st, railPath(10, 20, 240, 20, W, false, true), W);
    rails.set(st);
    // Full map: no strip draw, no triangles, pieces still built.
    rails.update(rigFrame(W, H, hf, W / 2, H / 2, 0.7));
    const strip = mesh(scene, "rails");
    expect(strip.visible).toBe(false);
    expect(rails.stats().triangles).toBe(0);
    expect(rails.pieces).toBe(2 * railTiles(st));
    const material = strip.material as THREE.MeshStandardMaterial;
    expect(material.opacity).toBe(0);
    // An edit while hidden is applied, and shows once zoomed in.
    addRailroad(st, railPath(10, 60, 240, 60, W, false, true), W);
    rails.set(st);
    rails.update(rigFrame(W, H, hf, W / 2, H / 2, 0.7));
    expect(rails.pieces).toBe(2 * railTiles(st));
    rails.update(rigFrame(W, H, hf, W / 2, H / 2, 1.8));
    expect(mesh(scene, "rails").visible).toBe(true);
    expect(material.opacity).toBeCloseTo(railStripLook(1.8, 1).opacity, 9);
    expect(rails.stats().triangles).toBe(mesh(scene, "rails").count * 2);
    expect(pieceKeys(mesh(scene, "rails"))).toEqual(expectedKeys(st, W));
  });
});
