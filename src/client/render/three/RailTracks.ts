/**
 * RailTracks — the railway network, drawn from the long-lived per-tile
 * railroad state (`RailroadCache.railroadState`: 0 = no rail, else rail
 * type + 1) so trains run on visible tracks.
 *
 * Every rail tile is two half-tile pieces (see `railHalfDirections`), each
 * draped on the relief and pitched along its slope. Pieces are kept per
 * block of `blockSize`² tiles (64 by default), so a change only rebuilds the
 * blocks it touches:
 *
 * - Change detection. The facade only hands over the whole buffer
 *   (`set(state)`, the same array every time), so a shadow copy is diffed
 *   against it, four tiles per compare, and every differing tile marks its
 *   block dirty. Terrain changes (`HeightField.version`) mark the blocks
 *   under `HeightField.lastDirty` (all non-empty blocks when several
 *   patches were missed).
 * - Time budget. Diffing stops for the frame once half of `budgetMs`
 *   (1.25 ms) is spent, block rebuilds once all of it is (at least one
 *   chunk / block always runs), and both resume on the next frame. Rebuilds
 *   run while a diff pass is still going, so even the largest maps (12.5M
 *   tiles, a pass of several frames) keep rebuilding during long railway
 *   animations; a block marked again further down the same pass is simply
 *   rebuilt again.
 * - Rebuild. A block scan writes each piece's instance matrix directly
 *   (no atan2 / Euler / quaternion: the four directions have exact cos/sin,
 *   the pitch comes from one inverse square root, see `writeRailPieceMatrix`).
 *
 * Levels of detail (both instanced, one draw call each, same transforms):
 *
 * - Strip (`rails`): a flat 2-triangle ballast bed for every piece, never
 *   culled. Each block owns a slot range with ~25% slack in one instance
 *   buffer, so a rebuild rewrites and uploads only that block's range (a
 *   block outgrowing its slot moves to the end; the buffer is compacted
 *   when holes pile up). Unused slots hold zero matrices (degenerate, no
 *   pixels). Its colour and opacity follow the zoom: a light, half
 *   transparent line below ~2 px per tile (so railways do not read as
 *   borders), the ballast colour from ~5 px per tile. Lot 3: on top of
 *   that, the default renderer's RailroadPass fade (`railroad.railMinZoom`
 *   3, `railFadeRange` 2, in device px per tile; × RAIL_FADE_GAIN for the
 *   thinner strip): fainter below ~2.3 device px per tile, not drawn at all
 *   from 1 down (`railStripLook`).
 * - Detail (`rails-detail`): sleepers and rails (16 triangles) for the
 *   blocks that intersect the view frustum and are close enough: a tile at
 *   the block's nearest corner covers ≥ DETAIL_ON_PX CSS px (off again
 *   below DETAIL_OFF_PX). Never in `quality: "low"`, where only strips are
 *   drawn.
 *
 * `stats()` reports the counts and timings the facade's perf tool shows
 * (through `UnitLayer.perfStats()`).
 */

import * as THREE from "three";
import { smoothstep } from "./CameraRig";
import type { HeightField } from "./HeightField";
import { nightModeOf } from "./NightLights";
import {
  createRailDetailGeometry,
  createRailStripGeometry,
  nextCapacity,
  triangleCount,
} from "./ProceduralMeshes";
import type { ThreeRenderSettings } from "./ThreeSettings";
import type { FrameInfo } from "./types";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Unit vectors of the four piece directions: E, S, W, N (tile space). */
export const RAIL_DIR_X: readonly number[] = [1, 0, -1, 0];
export const RAIL_DIR_Z: readonly number[] = [0, 1, 0, -1];
const DIR_ANGLE = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/**
 * Direction indices (into RAIL_DIR_X / RAIL_DIR_Z) of the two half-tracks of
 * a railroad tile code (RailroadCache: rail type + 1): 1 vertical, 2
 * horizontal, 3 top-left, 4 top-right, 5 bottom-left, 6 bottom-right (a
 * curve joins the two named edges). -1 for unknown codes.
 */
const CODE_DIR0 = new Int8Array(256).fill(-1);
const CODE_DIR1 = new Int8Array(256).fill(-1);
for (const [code, d0, d1] of [
  [1, 3, 1],
  [2, 0, 2],
  [3, 3, 2],
  [4, 3, 0],
  [5, 1, 2],
  [6, 1, 0],
] as const) {
  CODE_DIR0[code] = d0;
  CODE_DIR1[code] = d1;
}

/**
 * Tile-space directions (radians: 0 east, π/2 south) of the half-tracks of
 * a railroad tile code; unknown codes have none.
 */
export function railHalfDirections(code: number): readonly number[] {
  const d0 = CODE_DIR0[code & 255];
  if (code !== (code & 255) || d0 < 0) return [];
  return [DIR_ANGLE[d0], DIR_ANGLE[CODE_DIR1[code]]];
}

/**
 * Column-major instance matrix of a piece at world (x, h, z) heading along
 * the unit tile direction (dx, dz), rising `dh` over its half-tile length,
 * written into `out[o .. o + 16)`. Equals compose((x, h, z), Euler(0, −a,
 * atan2(dh, 0.5), "YZX"), 1) with a = atan2(dz, dx): local +X runs along
 * the track up the slope, +Z across it, +Y along the pitched normal.
 */
export function writeRailPieceMatrix(
  out: Float32Array,
  o: number,
  x: number,
  h: number,
  z: number,
  dx: number,
  dz: number,
  dh: number,
): void {
  const inv = 1 / Math.sqrt(dh * dh + 0.25);
  const c = 0.5 * inv;
  const s = dh * inv;
  out[o] = dx * c;
  out[o + 1] = s;
  out[o + 2] = dz * c;
  out[o + 3] = 0;
  out[o + 4] = -dx * s;
  out[o + 5] = c;
  out[o + 6] = -dz * s;
  out[o + 7] = 0;
  out[o + 8] = -dz;
  out[o + 9] = 0;
  out[o + 10] = dx;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = h;
  out[o + 14] = z;
  out[o + 15] = 1;
}

/** Slot size (pieces) for a block of `n` pieces: n plus ~25% slack. */
export function railSlotCapacity(n: number): number {
  return n + Math.max(8, n >> 2);
}

/**
 * CSS px covered by one tile at camera-space depth `depth` for a camera of
 * vertical field of view `fovDeg` drawn `cssHeight` px tall.
 */
export function pxPerTileAtDepth(
  depth: number,
  fovDeg: number,
  cssHeight: number,
): number {
  const focal = cssHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  return depth > 1e-6 ? focal / depth : Infinity;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Default block size, tiles. */
export const RAIL_BLOCK_SIZE = 64;
/** Default per-frame time budget of diffing + rebuilding, ms. */
export const RAIL_BUDGET_MS = 1.25;
/** Share of the budget the diff may take before rebuilds get the rest. */
const DIFF_BUDGET_SHARE = 0.5;
/** A block gets sleepers and rails from this many CSS px per tile... */
export const DETAIL_ON_PX = 6;
/** ...and loses them again below this (hysteresis). */
export const DETAIL_OFF_PX = 5;
/**
 * Below this centre zoom no block can reach DETAIL_ON_PX (the nearest
 * visible ground at 50° tilt is < 3× closer than the centre), so the
 * per-block pass is skipped.
 */
const DETAIL_MIN_CENTRE_ZOOM = DETAIL_ON_PX / 3;
/** Words (4 tiles) compared between two clock reads while diffing. */
const DIFF_CHUNK_WORDS = 32_768;
/** Frames over which `jsMsMax` is taken. */
const JS_HISTORY = 120;
/** Strip look: far (light, see-through) → near (ballast, opaque). */
const STRIP_FAR = new THREE.Color(0xd2c9b6);
const STRIP_NEAR = new THREE.Color(0x8f877b);
const STRIP_FAR_OPACITY = 0.55;
/** Lot 4 (night): strip emission, × its colour (the kept fill's level). */
export const RAIL_NIGHT_GLOW = 0.45;
const STRIP_FADE_ZOOM: readonly [number, number] = [2, 5];
/**
 * Visibility of the strips, as the default renderer's RailroadPass with the
 * `railroad` render settings' defaults (`railMinZoom` 3, `railFadeRange`
 * 2): full from RAIL_MIN_ZOOM device px per tile, fading linearly to none
 * at RAIL_MIN_ZOOM - RAIL_FADE_RANGE (1 device px per tile) and below.
 */
export const RAIL_MIN_ZOOM = 3;
export const RAIL_FADE_RANGE = 2;
/**
 * Opacity gain on that visibility: the 3D strip is half a tile wide where
 * the default's line is a full tile, so its opacity follows 1.5 × the
 * default's fade (capped at 1): the lot-1 look from ~2.3 device px per
 * tile, 60% of it at the default zoom (1.8), none from 1 down.
 */
export const RAIL_FADE_GAIN = 1.5;

/** The strip material's look at a zoom (see `railStripLook`). */
export interface RailStripLook {
  /** Default-renderer visibility (0..1); 0 = the strips are not drawn. */
  visibility: number;
  /** Far (0, light) → near (1, ballast) colour weight. */
  colorT: number;
  /**
   * Material opacity: min(1, RAIL_FADE_GAIN × visibility) × the lot-1 far →
   * near opacity.
   */
  opacity: number;
}

/**
 * Look of the railway strips at `cssPxPerTile` on a `dpr` screen. The
 * colour / opacity ramp of lot 1 (light, 55% → ballast, opaque between 2
 * and 5 CSS px per tile) times the default renderer's fade by device px
 * per tile (`RAIL_MIN_ZOOM`, `RAIL_FADE_RANGE`, with `RAIL_FADE_GAIN`): at
 * the default zoom (1.8 CSS px per tile on a 1× screen) the network shows
 * at 60% of the lot-1 strip (33% opacity), at full map (0.7) not at all,
 * as in the default renderer, so long straight railways no longer read as
 * borders while the network still shows.
 */
export function railStripLook(
  cssPxPerTile: number,
  dpr: number,
): RailStripLook {
  const devicePx = cssPxPerTile * (dpr > 0 ? dpr : 1);
  const visibility = Math.min(
    1,
    Math.max(
      0,
      (devicePx - (RAIL_MIN_ZOOM - RAIL_FADE_RANGE)) / RAIL_FADE_RANGE,
    ),
  );
  const colorT = smoothstep(
    STRIP_FADE_ZOOM[0],
    STRIP_FADE_ZOOM[1],
    cssPxPerTile,
  );
  return {
    visibility,
    colorT,
    opacity:
      Math.min(1, RAIL_FADE_GAIN * visibility) *
      (STRIP_FAR_OPACITY + (1 - STRIP_FAR_OPACITY) * colorT),
  };
}
/** Floats per instance matrix. */
const M = 16;

/**
 * Whether a block whose nearest tile covers `tilePx` CSS px gets sleepers
 * and rails, given whether it has them now (hysteresis).
 */
export function railDetailWanted(tilePx: number, wasOn: boolean): boolean {
  return tilePx >= (wasOn ? DETAIL_OFF_PX : DETAIL_ON_PX);
}

// ---------------------------------------------------------------------------
// Instance buffer
// ---------------------------------------------------------------------------

/**
 * One InstancedMesh over a shared geometry whose instance buffer grows by
 * re-creating the mesh (resizing a GL buffer in place is not supported).
 * Uploads are limited to the ranges marked since the last render.
 */
class RailMesh {
  mesh: THREE.InstancedMesh;
  /** Floats marked for upload since the last `takeUploadedFloats`. */
  private marked = 0;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly name: string,
    capacity: number,
  ) {
    this.mesh = this.create(nextCapacity(0, capacity));
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  get array(): Float32Array {
    return this.mesh.instanceMatrix.array as Float32Array;
  }

  /** Grows to hold `n` instances, keeping the current contents. */
  ensure(n: number): void {
    if (n <= this.capacity) return;
    const old = this.mesh;
    const next = this.create(nextCapacity(this.capacity, n));
    next.instanceMatrix.array.set(old.instanceMatrix.array);
    next.count = old.count;
    next.visible = old.visible;
    this.parent.remove(old);
    old.dispose();
    this.mesh = next;
    // A new buffer is uploaded whole on first use.
    this.marked += next.instanceMatrix.array.length;
  }

  /** False hides the mesh whatever its count (the strips when faded out). */
  shown = true;

  setCount(n: number): void {
    this.mesh.count = n;
    this.mesh.visible = n > 0 && this.shown;
  }

  /** Schedules instances [start, start + count) for upload. */
  markRange(start: number, count: number): void {
    if (count <= 0) return;
    const attr = this.mesh.instanceMatrix;
    const ranges = attr.updateRanges;
    if (ranges.length >= 32) {
      // Collapse to one covering range (three merges ranges itself, but
      // keep the list bounded while the mesh is not drawn).
      let lo = start * M;
      let hi = (start + count) * M;
      for (const r of ranges) {
        lo = Math.min(lo, r.start);
        hi = Math.max(hi, r.start + r.count);
      }
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo, hi - lo);
    } else {
      attr.addUpdateRange(start * M, count * M);
    }
    attr.needsUpdate = true;
    this.marked += count * M;
  }

  /** Floats marked for upload since the previous call. */
  takeMarkedFloats(): number {
    const n = this.marked;
    this.marked = 0;
    return n;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }

  private create(capacity: number): THREE.InstancedMesh {
    // InstancedMesh(…, n) writes n identity matrices one by one (~24 ms for
    // 64k); build it with one and swap in a zeroed buffer before it is
    // ever uploaded. Unused slots must be degenerate (zero), not identity.
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, 1);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * M),
      M,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.name = this.name;
    this.parent.add(mesh);
    return mesh;
  }
}

// ---------------------------------------------------------------------------
// RailTracks
// ---------------------------------------------------------------------------

export interface RailTracksOptions {
  /** Block size, tiles (default RAIL_BLOCK_SIZE). */
  blockSize?: number;
  /** Per-frame time budget, ms (default RAIL_BUDGET_MS). */
  budgetMs?: number;
  /** Clock for the budget and the stats (default performance.now). */
  clock?: () => number;
}

/** Counters of the last frame (see the file comment). */
export interface RailStats {
  /** Pieces (half tiles) in the network. */
  pieces: number;
  /** Pieces drawn with sleepers and rails. */
  detailPieces: number;
  /** Triangles submitted: strip instances (incl. slack) + detail. */
  triangles: number;
  /** Blocks holding at least one piece. */
  blocks: number;
  /** Blocks in the detail level. */
  detailBlocks: number;
  /** Blocks rebuilt in the last frame. */
  blocksRebuilt: number;
  /** Blocks waiting for a rebuild (plus 1 while a diff pass runs or waits). */
  blocksPending: number;
  /** JS time of the last `update`, ms. */
  jsMs: number;
  /** Max of `jsMs` over the last JS_HISTORY frames. */
  jsMsMax: number;
  /** Instance bytes marked for upload in the last frame. */
  uploadBytes: number;
}

export class RailTracks {
  readonly blockSize: number;
  private readonly budgetMs: number;
  private readonly clock: () => number;
  private readonly blocksX: number;
  private readonly blocksY: number;
  private readonly nBlocks: number;

  // Per block: instance matrices, piece count, height range.
  private readonly blockData: (Float32Array | null)[];
  private readonly blockCount: Int32Array;
  private readonly blockMinY: Float32Array;
  private readonly blockMaxY: Float32Array;
  private totalPieces = 0;
  private nonEmptyBlocks = 0;

  // Strip slots: [start, start + cap) in the strip buffer, `used` written.
  private readonly slotStart: Int32Array;
  private readonly slotCap: Int32Array;
  private readonly slotUsed: Int32Array;
  private highWater = 0;

  // Change tracking.
  private state: Uint8Array | null = null;
  private prev = new Uint8Array(0);
  private diffPending = false;
  /** Byte offset of the running diff pass, -1 when none runs. */
  private diffCursor = -1;
  private readonly dirty: Uint8Array;
  private readonly queue: number[] = [];
  private queueHead = 0;
  private heightVersion: number;

  // Detail level.
  private readonly detailOn: Uint8Array;
  private detailBlocks: number[] = [];
  private nextDetail: number[] = [];
  private detailStale = false;
  private detailPieces = 0;

  // Rendering.
  private readonly stripGeometry = createRailStripGeometry();
  private readonly detailGeometry = createRailDetailGeometry();
  private readonly stripTris = triangleCount(this.stripGeometry);
  private readonly detailTris = triangleCount(this.detailGeometry);
  private readonly stripMaterial = new THREE.MeshStandardMaterial({
    color: STRIP_FAR.clone(),
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: STRIP_FAR_OPACITY,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  private readonly detailMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.6,
    metalness: 0.15,
  });
  private readonly strip: RailMesh;
  private readonly detail: RailMesh;
  private stripZoom = Number.NaN;
  /** Lot 4: strip self-light at night (0 by day). */
  private nightGlow = 0;
  private stripDpr = Number.NaN;

  // Stats.
  private readonly jsHistory = new Float32Array(JS_HISTORY);
  private jsIndex = 0;
  private lastJsMs = 0;
  private lastRebuilt = 0;
  private lastUploadBytes = 0;

  // Scratch.
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private readonly fwd = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private readonly hf: HeightField,
    private readonly mapW: number,
    private readonly mapH: number,
    private readonly settings: Pick<ThreeRenderSettings, "quality"> &
      Partial<Pick<ThreeRenderSettings, "prototypes">>,
    opts: RailTracksOptions = {},
  ) {
    // Lot 4, night (`?three_night=1` only): the strips glow faintly in their
    // own colour (as bright as the kept territory fill), so rails never turn
    // into black lines that read as borders; the close-up rails a little.
    if (nightModeOf(settings) !== null) {
      this.nightGlow = RAIL_NIGHT_GLOW;
      this.detailMaterial.emissive.setRGB(0.05, 0.045, 0.04);
    }
    this.blockSize = Math.max(8, Math.floor(opts.blockSize ?? RAIL_BLOCK_SIZE));
    this.budgetMs = opts.budgetMs ?? RAIL_BUDGET_MS;
    this.clock = opts.clock ?? (() => performance.now());
    this.blocksX = Math.max(1, Math.ceil(mapW / this.blockSize));
    this.blocksY = Math.max(1, Math.ceil(mapH / this.blockSize));
    this.nBlocks = this.blocksX * this.blocksY;
    const nb = this.nBlocks;
    this.blockData = new Array<Float32Array | null>(nb).fill(null);
    this.blockCount = new Int32Array(nb);
    this.blockMinY = new Float32Array(nb);
    this.blockMaxY = new Float32Array(nb);
    this.slotStart = new Int32Array(nb).fill(-1);
    this.slotCap = new Int32Array(nb);
    this.slotUsed = new Int32Array(nb);
    this.dirty = new Uint8Array(nb);
    this.detailOn = new Uint8Array(nb);
    this.heightVersion = hf.version;
    this.strip = new RailMesh(
      parent,
      this.stripGeometry,
      this.stripMaterial,
      "rails",
      1024,
    );
    this.detail = new RailMesh(
      parent,
      this.detailGeometry,
      this.detailMaterial,
      "rails-detail",
      256,
    );
  }

  /** Pieces (half tiles) currently in the network. */
  get pieces(): number {
    return this.totalPieces;
  }

  /**
   * The railroad state changed. `state` is the long-lived W×H buffer; it is
   * read lazily (diffed against a shadow copy over the next frames).
   */
  set(state: Uint8Array): void {
    if (state.length !== this.mapW * this.mapH) return;
    if (state.length !== this.prev.length)
      this.prev = new Uint8Array(state.length);
    this.state = state;
    this.diffPending = true;
  }

  /** Budgeted change processing, LOD selection and the strip look. */
  update(frame: FrameInfo): void {
    const t0 = this.clock();
    const deadline = t0 + this.budgetMs;
    this.lastRebuilt = 0;
    this.checkHeights();
    this.diffStep(t0 + this.budgetMs * DIFF_BUDGET_SHARE);
    this.rebuildStep(deadline);
    this.compactIfNeeded();
    this.updateStripLook(frame.cssPxPerTile, frame.dpr);
    this.strip.setCount(this.totalPieces > 0 ? this.highWater : 0);
    this.updateDetail(frame);
    this.lastUploadBytes =
      (this.strip.takeMarkedFloats() + this.detail.takeMarkedFloats()) * 4;
    const ms = this.clock() - t0;
    this.lastJsMs = ms;
    this.jsHistory[this.jsIndex] = ms;
    this.jsIndex = (this.jsIndex + 1) % JS_HISTORY;
  }

  stats(): RailStats {
    let max = 0;
    for (const v of this.jsHistory) max = Math.max(max, v);
    return {
      pieces: this.totalPieces,
      detailPieces: this.detailPieces,
      triangles:
        (this.strip.mesh.visible ? this.highWater * this.stripTris : 0) +
        this.detailPieces * this.detailTris,
      blocks: this.nonEmptyBlocks,
      detailBlocks: this.detailBlocks.length,
      blocksRebuilt: this.lastRebuilt,
      blocksPending:
        this.queue.length -
        this.queueHead +
        (this.diffCursor >= 0 || this.diffPending ? 1 : 0),
      jsMs: this.lastJsMs,
      jsMsMax: max,
      uploadBytes: this.lastUploadBytes,
    };
  }

  dispose(): void {
    this.strip.dispose();
    this.detail.dispose();
    this.stripGeometry.dispose();
    this.detailGeometry.dispose();
    this.stripMaterial.dispose();
    this.detailMaterial.dispose();
    this.blockData.fill(null);
    this.state = null;
  }

  // ---- Change tracking ----

  private markBlock(b: number): void {
    if (this.dirty[b] !== 0) return;
    this.dirty[b] = 1;
    this.queue.push(b);
  }

  /** Terrain patches move the pieces of the blocks under them. */
  private checkHeights(): void {
    const hf = this.hf;
    if (hf.version === this.heightVersion) return;
    const missed = hf.version !== this.heightVersion + 1;
    this.heightVersion = hf.version;
    const r = hf.lastDirty;
    if (missed || r === null) {
      for (let b = 0; b < this.nBlocks; b++) {
        if (this.blockCount[b] > 0) this.markBlock(b);
      }
      return;
    }
    // Pieces sample the surface up to half a tile around their tile; the
    // bilinear surface between two vertices depends on both.
    const B = this.blockSize;
    const x0 = hf.vertexX(Math.max(0, r.i0 - 1)) - 1;
    const x1 = hf.vertexX(Math.min(hf.cols - 1, r.i1 + 1)) + 1;
    const y0 = hf.vertexY(Math.max(0, r.j0 - 1)) - 1;
    const y1 = hf.vertexY(Math.min(hf.rows - 1, r.j1 + 1)) + 1;
    const bx0 = Math.max(0, Math.floor(x0 / B));
    const bx1 = Math.min(this.blocksX - 1, Math.floor(x1 / B));
    const by0 = Math.max(0, Math.floor(y0 / B));
    const by1 = Math.min(this.blocksY - 1, Math.floor(y1 / B));
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = by * this.blocksX + bx;
        if (this.blockCount[b] > 0) this.markBlock(b);
      }
    }
  }

  /**
   * Compares the state with the shadow copy from the cursor on, a chunk at
   * a time until the deadline, marking the blocks of differing tiles.
   */
  private diffStep(deadline: number): void {
    if (this.diffCursor < 0) {
      if (!this.diffPending || this.state === null) return;
      this.diffPending = false;
      this.diffCursor = 0;
    }
    const st = this.state;
    if (st === null) {
      this.diffCursor = -1;
      return;
    }
    const prev = this.prev;
    const n = st.length;
    let i = this.diffCursor;
    if ((st.byteOffset & 3) === 0) {
      const nw = n >> 2;
      const a = new Uint32Array(st.buffer, st.byteOffset, nw);
      const p = new Uint32Array(prev.buffer, prev.byteOffset, nw);
      let k = i >> 2;
      while (k < nw) {
        const end = Math.min(nw, k + DIFF_CHUNK_WORDS);
        for (; k < end; k++) {
          if (a[k] !== p[k]) this.diffTiles(k << 2, (k << 2) + 4);
        }
        if (k < nw && this.clock() >= deadline) {
          this.diffCursor = k << 2;
          return;
        }
      }
      i = nw << 2;
    }
    const chunk = DIFF_CHUNK_WORDS * 4;
    while (i < n) {
      const end = Math.min(n, i + chunk);
      this.diffTiles(i, end);
      i = end;
      if (i < n && this.clock() >= deadline) {
        this.diffCursor = i;
        return;
      }
    }
    this.diffCursor = -1;
  }

  private diffTiles(i0: number, i1: number): void {
    const st = this.state;
    if (st === null) return;
    const prev = this.prev;
    const W = this.mapW;
    const B = this.blockSize;
    for (let i = i0; i < i1; i++) {
      const v = st[i];
      if (v === prev[i]) continue;
      prev[i] = v;
      const x = i % W;
      const y = (i - x) / W;
      this.markBlock(Math.floor(y / B) * this.blocksX + Math.floor(x / B));
    }
  }

  /** Rebuilds queued blocks until the deadline (at least one). */
  private rebuildStep(deadline: number): void {
    while (this.queueHead < this.queue.length) {
      const b = this.queue[this.queueHead++];
      this.dirty[b] = 0;
      this.rebuildBlock(b);
      this.writeStrip(b);
      if (this.detailOn[b] !== 0) this.detailStale = true;
      this.lastRebuilt++;
      if (this.clock() >= deadline) break;
    }
    if (this.queueHead > 0 && this.queueHead >= this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    }
  }

  /** Re-scans block `b` of the live state into its instance matrices. */
  private rebuildBlock(b: number): void {
    const st = this.state;
    const B = this.blockSize;
    const W = this.mapW;
    const hf = this.hf;
    const bx = b % this.blocksX;
    const by = (b - bx) / this.blocksX;
    const x0 = bx * B;
    const x1 = Math.min(W, x0 + B);
    const y0 = by * B;
    const y1 = Math.min(this.mapH, y0 + B);
    let data = this.blockData[b];
    let n = 0;
    let lo = Infinity;
    let hi = -Infinity;
    if (st !== null) {
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let x = x0; x < x1; x++) {
          const code = st[row + x];
          if (code === 0) continue;
          const d0 = CODE_DIR0[code];
          if (d0 < 0) continue;
          const d1 = CODE_DIR1[code];
          if (data === null || (n + 2) * M > data.length) {
            const grown = new Float32Array(nextCapacity(n, n + 2) * M);
            if (data !== null) grown.set(data.subarray(0, n * M));
            data = grown;
          }
          const cx = x + 0.5;
          const cz = y + 0.5;
          const h = hf.surfaceAt(cx, cz);
          let dx = RAIL_DIR_X[d0];
          let dz = RAIL_DIR_Z[d0];
          const h0 = hf.surfaceAt(cx + 0.5 * dx, cz + 0.5 * dz);
          writeRailPieceMatrix(data, n * M, cx, h, cz, dx, dz, h0 - h);
          dx = RAIL_DIR_X[d1];
          dz = RAIL_DIR_Z[d1];
          const h1 = hf.surfaceAt(cx + 0.5 * dx, cz + 0.5 * dz);
          writeRailPieceMatrix(data, (n + 1) * M, cx, h, cz, dx, dz, h1 - h);
          n += 2;
          lo = Math.min(lo, h, h0, h1);
          hi = Math.max(hi, h, h0, h1);
        }
      }
    }
    const old = this.blockCount[b];
    this.totalPieces += n - old;
    if (old === 0 && n > 0) this.nonEmptyBlocks++;
    if (old > 0 && n === 0) this.nonEmptyBlocks--;
    this.blockCount[b] = n;
    this.blockData[b] = n > 0 ? data : null;
    this.blockMinY[b] = n > 0 ? lo - 0.1 : 0;
    this.blockMaxY[b] = n > 0 ? hi + 0.2 : 0;
  }

  /** Writes block `b`'s pieces into its strip slot (moving it if full). */
  private writeStrip(b: number): void {
    const n = this.blockCount[b];
    let start = this.slotStart[b];
    if (n > this.slotCap[b]) {
      if (start >= 0) this.clearStrip(start, this.slotUsed[b]);
      const cap = railSlotCapacity(n);
      start = this.highWater;
      this.highWater += cap;
      this.strip.ensure(this.highWater);
      this.slotStart[b] = start;
      this.slotCap[b] = cap;
      this.slotUsed[b] = 0;
    }
    if (start < 0) return;
    const arr = this.strip.array;
    const data = this.blockData[b];
    if (n > 0 && data !== null) arr.set(data.subarray(0, n * M), start * M);
    const used = this.slotUsed[b];
    if (used > n) arr.fill(0, (start + n) * M, (start + used) * M);
    this.strip.markRange(start, Math.max(n, used));
    this.slotUsed[b] = n;
  }

  private clearStrip(start: number, count: number): void {
    if (count <= 0) return;
    this.strip.array.fill(0, start * M, (start + count) * M);
    this.strip.markRange(start, count);
  }

  /**
   * Re-packs every slot back to back (with fresh slack) once the space not
   * held by the slots of non-empty blocks (left behind by moved or emptied
   * blocks) exceeds half of theirs plus 2048 pieces.
   */
  private compactIfNeeded(): void {
    if (this.lastRebuilt === 0) return;
    let held = 0;
    for (let b = 0; b < this.nBlocks; b++) {
      if (this.blockCount[b] > 0) held += this.slotCap[b];
    }
    if (this.highWater - held <= held / 2 + 2048) return;
    const oldHigh = this.highWater;
    let at = 0;
    for (let b = 0; b < this.nBlocks; b++) {
      const n = this.blockCount[b];
      if (n === 0) {
        this.slotStart[b] = -1;
        this.slotCap[b] = 0;
        this.slotUsed[b] = 0;
        continue;
      }
      this.slotStart[b] = at;
      this.slotCap[b] = railSlotCapacity(n);
      this.slotUsed[b] = 0;
      at += this.slotCap[b];
    }
    this.highWater = at;
    this.strip.ensure(at);
    this.strip.array.fill(0, 0, oldHigh * M);
    for (let b = 0; b < this.nBlocks; b++) {
      if (this.blockCount[b] > 0) this.writeStrip(b);
    }
    // writeStrip only uploads each block's pieces: the zeroed slack of the
    // new slots (and the old tail) must reach the GPU too, or it keeps old
    // matrices there and draws pieces twice, or removed ones as ghosts. One
    // upload of the buffer, as rare as compactions.
    this.strip.markRange(0, Math.max(oldHigh, at));
  }

  // ---- Detail level ----

  /** Picks the near, visible blocks and re-packs their detail instances. */
  private updateDetail(frame: FrameInfo): void {
    const next = this.nextDetail;
    next.length = 0;
    if (
      this.settings.quality !== "low" &&
      frame.cssPxPerTile >= DETAIL_MIN_CENTRE_ZOOM &&
      this.nonEmptyBlocks > 0
    ) {
      this.selectDetailBlocks(frame, next);
    } else {
      this.detailOn.fill(0);
    }
    const cur = this.detailBlocks;
    let same = !this.detailStale && cur.length === next.length;
    for (let k = 0; same && k < cur.length; k++) same = cur[k] === next[k];
    if (same) return;
    this.detailBlocks = next;
    this.nextDetail = cur;
    this.detailStale = false;
    let total = 0;
    for (const b of next) total += this.blockCount[b];
    this.detail.ensure(total);
    const arr = this.detail.array;
    let at = 0;
    for (const b of next) {
      const n = this.blockCount[b];
      const data = this.blockData[b];
      if (n > 0 && data !== null) arr.set(data.subarray(0, n * M), at * M);
      at += n;
    }
    this.detail.setCount(total);
    this.detail.markRange(0, total);
    this.detailPieces = total;
  }

  private selectDetailBlocks(frame: FrameInfo, out: number[]): void {
    const cam = frame.camera;
    this.projScreen.multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const e = cam.matrixWorld.elements;
    const f = this.fwd.set(-e[8], -e[9], -e[10]).normalize();
    const camDepth = e[12] * f.x + e[13] * f.y + e[14] * f.z;
    const B = this.blockSize;
    for (let b = 0; b < this.nBlocks; b++) {
      if (this.blockCount[b] === 0) {
        this.detailOn[b] = 0;
        continue;
      }
      const bx = b % this.blocksX;
      const by = (b - bx) / this.blocksX;
      const x0 = bx * B;
      const z0 = by * B;
      const x1 = Math.min(this.mapW, x0 + B);
      const z1 = Math.min(this.mapH, z0 + B);
      const y0 = this.blockMinY[b];
      const y1 = this.blockMaxY[b];
      this.box.min.set(x0, y0, z0);
      this.box.max.set(x1, y1, z1);
      if (!this.frustum.intersectsBox(this.box)) {
        this.detailOn[b] = 0;
        continue;
      }
      // Nearest corner along the view direction.
      const depth =
        (f.x > 0 ? x0 : x1) * f.x +
        (f.y > 0 ? y0 : y1) * f.y +
        (f.z > 0 ? z0 : z1) * f.z -
        camDepth;
      const tilePx = pxPerTileAtDepth(depth, cam.fov, frame.cssHeight);
      const on = railDetailWanted(tilePx, this.detailOn[b] !== 0);
      this.detailOn[b] = on ? 1 : 0;
      if (on) out.push(b);
    }
  }

  /**
   * Light, see-through strips when far, ballast-coloured close up, fainter
   * below ~2.3 device px per tile and hidden from 1 down (`railStripLook`;
   * hidden strips cost no draw call). Rebuilds keep running while hidden.
   */
  private updateStripLook(zoom: number, dpr: number): void {
    if (zoom === this.stripZoom && dpr === this.stripDpr) return;
    this.stripZoom = zoom;
    this.stripDpr = dpr;
    const look = railStripLook(zoom, dpr);
    this.stripMaterial.color.lerpColors(STRIP_FAR, STRIP_NEAR, look.colorT);
    this.stripMaterial.opacity = look.opacity;
    if (this.nightGlow > 0) {
      this.stripMaterial.emissive
        .copy(this.stripMaterial.color)
        .multiplyScalar(this.nightGlow);
    }
    this.strip.shown = look.visibility > 0;
  }
}
