/**
 * EffectTrails — the default renderer's boat and nuke trails
 * (`gl/passes/TrailPass.ts`, `trail.frag.glsl`) and the cosmetic effect
 * palette, for the 3D view. One instance per map, shared (refcounted, like
 * `TerrainByteTexture`) by:
 * - TerrainLayer: paints the trails on the relief (land, and the coastal
 *   water the relief draws itself) and flushes the uploads every frame;
 * - WaterLayer: paints them on the sea plane;
 * - UnitLayer: colours the nukes' aerial ribbons by their nuke-trail effect.
 *
 * Semantics (unchanged from the default renderer):
 * - The facade receives the per-tile trail buffer of `frame/TrailManager.ts`
 *   (R16UI: owner smallID in bits 0-11, bit 12 = nuke trail, 0 = none): a
 *   full push (`uploadTileAndTrailState`: first tick, context restore) or
 *   the rows a tick stamped (`uploadLiveTrailDelta`). TrailManager decides
 *   the lifetime: a tile keeps its trail while a trail claiming it lives
 *   (whole path, no fade), and is cleared when its last claimant dies.
 * - Colour: the alt view shows the owner's "unit" affiliation colour (self /
 *   ally / enemy, `AffiliationPalette` row 1) and no effect; otherwise the
 *   owner's effect for the trail's kind (block 0 = transportShipTrail,
 *   block 1 = nukeTrail of the effect palette): none = the territory colour
 *   (palette row 0), one colour = flat, gradient = cyclic bands along the
 *   world diagonal scrolling at `movementSpeed` tiles/s, transition = the
 *   whole trail cross-fading through the list `frequency` times a second,
 *   spiral = its first colour (the ground centreline; the vortex itself,
 *   SpiralRibbonPass, is not drawn in 3D). Drawn at
 *   `mapOverlay.trailAlpha` while `passEnabled.trail` is on (both read live).
 * - Effect palette (`updateEffectPalette`): RGBA32F 4096 × 48, 6 blocks of
 *   8 rows (PlayerPalette.ts / EffectPalette.ts), mirrored as is.
 *
 * 3D adaptation:
 * - The trail is painted per tile by the ground shaders (EFFECT_TRAILS_GLSL),
 *   so it drapes on the relief and lies on the waves; both shaders composite
 *   it the same way (the trail colour lit flat, `diffuseLight(UP)`, over the
 *   shaded ground or water at `trailAlpha`), so it is seamless across the
 *   shoreline. It sits under the 3D units (boats float on it).
 * - Uploads: the facade only gives a row range per tick (often most of the
 *   map's height), so those rows are only marked; each frame diffs up to
 *   `TRAIL_DIFF_BUDGET` texels of marked rows against the CPU mirror the
 *   texture is uploaded from (4 tiles per compare, `TRAIL_WORD_COMPARE`),
 *   resuming where the last frame stopped. Changed tiles mark 16×16-tile
 *   cells dirty in a `TileUploadQueue`, and the frame then sends a few
 *   merged rectangles within `TRAIL_UPLOAD_BUDGET` (one `texSubImage2D`
 *   each, `TextureRectUploader`). A row is unmarked only once diffed, and a
 *   cell marked clean only once a rectangle covering it was sent, from the
 *   mirror's latest values, so nothing is dropped; the default renderer
 *   sends the whole row band every tick instead.
 * - Switches: the ground shaders skip the trail fetch while no tile holds a
 *   trail (or `passEnabled.trail` is off), and the effect lookups while no
 *   player has a trail effect; the effect palette texture is only allocated
 *   once a player has an effect.
 */

import * as THREE from "three";
import { NUKE_TRAIL_BIT } from "../frame/TrailManager";
import type { RenderSettings } from "../gl/RenderSettings";
import {
  EFFECT_PALETTE_BLOCKS,
  MAX_TRAIL_COLORS,
} from "../gl/utils/ColorUtils";
import type { HeightField } from "./HeightField";
import { PALETTE_WIDTH } from "./PaletteView";
import { type Rgb, unitAffiliationRgb } from "./StructureIcons";
import {
  createIntegerTexture,
  TextureRectUploader,
  uploadNow,
} from "./TerrainResources";
import { type TileUploadBudget, TileUploadQueue } from "./TileUploadQueue";
import type { FrameInfo, ThreeLayerContext } from "./types";

/** Rows of the effect palette: MAX_TRAIL_COLORS per block, 6 blocks. */
export const EFFECT_ROWS = MAX_TRAIL_COLORS * EFFECT_PALETTE_BLOCKS;
/** Effect palette blocks read by the trails (PlayerPalette.ts order). */
export const BOAT_TRAIL_BLOCK = 0;
export const NUKE_TRAIL_BLOCK = 1;
/** Owner smallID bits of a trail texel. */
export const TRAIL_OWNER_MASK = 0xfff;
/** Effect styles (EffectPalette.packEffectEntry's styleId). */
export const EFFECT_GRADIENT = 0;
export const EFFECT_TRANSITION = 1;
export const EFFECT_SPIRAL = 2;

/**
 * Trail rectangles per frame: at most 8 `texSubImage2D` calls and 128k
 * texels (256 KB), but always at least one rectangle. Trails change a few
 * tiles per unit and tick, so the rectangles are small (one 16×16 cell
 * each, merged when close); a MIRV's warheads dirty a few hundred cells,
 * sent over the next frames.
 */
export const TRAIL_UPLOAD_BUDGET: TileUploadBudget = {
  maxCalls: 8,
  maxTexels: 1 << 17,
};
/**
 * Trail texels diffed per frame, in whole rows (always at least one row):
 * 512k, a quarter of the World map, ~0.3-0.5 ms of JS on the dev machine.
 * A tick marks ~0.6-1.6M texels of rows on World (TrailManager's min..max
 * row over every unit), so a tick's rows are diffed within its frames.
 */
export const TRAIL_DIFF_BUDGET = 1 << 19;
/** Frames over which the perf counters keep their maxima. */
const PERF_WINDOW = 120;
const MIB = 1024 * 1024;

/**
 * The per-tick diff compares 4 trail texels at a time as one float64, ~2-3×
 * faster than 2 at a time as uint32 (World: ~0.4-0.7 ms instead of 1-1.5 ms
 * for a 1.6M-tile band on the dev machine). It is exact because a trail
 * texel never sets bit 15 (owner bits 0-11, nuke bit 12): no word is then a
 * NaN or a negative zero, so `!==` on the floats is `!==` on the bits. If
 * TrailManager ever set bit 15, the uint16 path is used.
 */
export const TRAIL_WORD_COMPARE =
  (TRAIL_OWNER_MASK | NUKE_TRAIL_BIT) < 0x8000 ? 4 : 1;

// ---------------------------------------------------------------------------
// TS mirrors of the shader (unit-tested against the default's GLSL)
// ---------------------------------------------------------------------------

/**
 * The colour (sRGB 0..1) of `owner`'s effect in `block` of an effect
 * palette at world tile position (x, y) and time `t` (s), or null when the
 * owner has no effect there (count 0). trail.frag.glsl's effect branch.
 */
export function effectColorAt(
  effect: Float32Array,
  owner: number,
  block: number,
  x: number,
  y: number,
  t: number,
): Rgb | null {
  const rowBase = block * MAX_TRAIL_COLORS;
  const at = (row: number, c: number) =>
    effect[((rowBase + row) * PALETTE_WIDTH + owner) * 4 + c] ?? 0;
  const rgb = (row: number): Rgb => [at(row, 0), at(row, 1), at(row, 2)];
  const count = Math.trunc(at(0, 3) + 0.5);
  if (count <= 0) return null;
  if (count === 1) return rgb(0);
  const style = Math.trunc(at(1, 3) + 0.5);
  if (style === EFFECT_SPIRAL) return rgb(0);
  let i: number;
  let f: number;
  if (style === EFFECT_TRANSITION) {
    const tt = t * at(2, 3);
    i = Math.trunc(tt) % count;
    f = tt - Math.floor(tt);
  } else {
    const colorSize = Math.max(at(2, 3), 0.001);
    const speed = at(3, 3);
    const cycle = colorSize * count;
    const q = (x + y - t * speed) / cycle;
    const ph = (q - Math.floor(q)) * count;
    i = Math.trunc(ph) % count;
    f = ph - Math.floor(ph);
  }
  const j = (i + 1) % count;
  const a = rgb(i);
  const b = rgb(j);
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

/** Inputs of `trailColorAt` besides the trail texel and position. */
export interface TrailColorInput {
  /** Effect palette (null = nobody has an effect). */
  effect: Float32Array | null;
  /** Player palette (PaletteView data: row 0 = territory colour). */
  palette: Float32Array;
  /** Alt-view colours, RGBA8 per owner (EffectTrails.affiliationData). */
  affiliation: Uint8Array;
  altView: boolean;
  /** Effect clock, s. */
  time: number;
}

/**
 * The trail colour (sRGB 0..1) of a trail texel at world tile position
 * (x, y), or null for no trail. trail.frag.glsl, mirrored by
 * EFFECT_TRAILS_GLSL's `effectTrail`.
 */
export function trailColorAt(
  value: number,
  x: number,
  y: number,
  input: TrailColorInput,
): Rgb | null {
  const owner = value & TRAIL_OWNER_MASK;
  if (owner === 0) return null;
  if (input.altView) {
    const a = input.affiliation;
    return [a[owner * 4] / 255, a[owner * 4 + 1] / 255, a[owner * 4 + 2] / 255];
  }
  const block = (value & NUKE_TRAIL_BIT) !== 0 ? NUKE_TRAIL_BLOCK : 0;
  const e =
    input.effect === null
      ? null
      : effectColorAt(input.effect, owner, block, x, y, input.time);
  if (e !== null) return e;
  const p = input.palette;
  return [p[owner * 4], p[owner * 4 + 1], p[owner * 4 + 2]];
}

/** Whether `owner` has an effect in `block` (colour count > 0). */
export function hasEffect(
  effect: Float32Array,
  owner: number,
  block: number,
): boolean {
  const o = (block * MAX_TRAIL_COLORS * PALETTE_WIDTH + owner) * 4 + 3;
  return Math.trunc((effect[o] ?? 0) + 0.5) > 0;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

/**
 * Effect palette lookup, shared by the ground trails and the nukes' aerial
 * ribbons. Declares `uEffectPalette`, `uEffectsOn` and `uTrailTime`, and
 * `bool effectColor(int owner, int rowBase, vec2 p, out vec3 color)`: the
 * owner's effect colour (sRGB) for the block starting at `rowBase`, at world
 * tile position p; false when there is none (or `uEffectsOn` is off: the
 * palette texture is a 1×1 placeholder until a player has an effect).
 */
export const EFFECT_COLOR_GLSL = /* glsl */ `
uniform highp sampler2D uEffectPalette; // RGBA32F 4096 x ${EFFECT_ROWS}, EffectTrails.ts
uniform float uEffectsOn;               // any player has a trail effect
uniform float uTrailTime;               // effect animation clock, s

const int EFFECT_BLOCK_ROWS = ${MAX_TRAIL_COLORS};

bool effectColor(int o, int rowBase, vec2 p, out vec3 color) {
  color = vec3(0.0);
  if (uEffectsOn < 0.5) return false;
  vec4 e0 = texelFetch(uEffectPalette, ivec2(o, rowBase), 0);
  int count = int(e0.a + 0.5);
  if (count <= 0) return false;
  color = e0.rgb;
  if (count == 1) return true;
  int style = int(texelFetch(uEffectPalette, ivec2(o, rowBase + 1), 0).a + 0.5);
  // Spiral: the stamped centreline is its first colour (the vortex is not
  // drawn in 3D).
  if (style == ${EFFECT_SPIRAL}) return true;
  float f;
  if (style == ${EFFECT_TRANSITION}) {
    // The whole trail is one colour at a time, cross-fading through the
    // list; frequency = colour changes per second.
    f = uTrailTime * texelFetch(uEffectPalette, ivec2(o, rowBase + 2), 0).a;
  } else {
    // Gradient: cyclic bands across the map's diagonal, colorSize tiles
    // wide, scrolling at movementSpeed tiles/s.
    float colorSize = max(texelFetch(uEffectPalette, ivec2(o, rowBase + 2), 0).a, 0.001);
    float speed = texelFetch(uEffectPalette, ivec2(o, rowBase + 3), 0).a;
    float cycle = colorSize * float(count);
    f = fract((p.x + p.y - uTrailTime * speed) / cycle) * float(count);
  }
  int i = int(f) % count;
  int j = (i + 1) % count;
  vec3 a = texelFetch(uEffectPalette, ivec2(o, rowBase + i), 0).rgb;
  vec3 b = texelFetch(uEffectPalette, ivec2(o, rowBase + j), 0).rgb;
  color = mix(a, b, fract(f));
  return true;
}
`;

/**
 * The ground trails (terrain and water shaders). Declares the trail uniforms
 * (plus EFFECT_COLOR_GLSL) and `vec4 effectTrail(ivec2 tile, vec2 p, bool
 * alt)`: rgb = the trail colour (sRGB) on that tile, a = its opacity (0 = no
 * trail). Needs `uPalette` (RGBA32F 4096 × 2, row 0 = territory colour),
 * declared by the host shader.
 */
export const EFFECT_TRAILS_GLSL = /* glsl */ `
${EFFECT_COLOR_GLSL}
uniform float uTrailsOn;                     // a tile holds a trail, passEnabled.trail
uniform float uTrailAlpha;                   // mapOverlay.trailAlpha
uniform highp usampler2D uTrailTex;          // R16UI W x H: owner | nuke bit 12
uniform highp sampler2D uTrailAffiliation;   // RGBA8 4096 x 1: alt-view unit colours

vec4 effectTrail(ivec2 tile, vec2 p, bool alt) {
  uint v = texelFetch(uTrailTex, tile, 0).r;
  int o = int(v & ${TRAIL_OWNER_MASK}u);
  if (o == 0) return vec4(0.0);
  vec3 c;
  if (alt) {
    // Alt view: affiliation colours, no effects (strategic overlay).
    c = texelFetch(uTrailAffiliation, ivec2(o, 0), 0).rgb;
  } else {
    // Boat trails read block 0, nuke trails (bit 12) block 1.
    int rowBase = (v & ${NUKE_TRAIL_BIT}u) != 0u ? EFFECT_BLOCK_ROWS : 0;
    if (!effectColor(o, rowBase, p, c)) {
      c = texelFetch(uPalette, ivec2(o, 0), 0).rgb;
    }
  }
  return vec4(c, uTrailAlpha);
}
`;

// ---------------------------------------------------------------------------
// Effect palette mirror
// ---------------------------------------------------------------------------

/**
 * The effect palette as a texture (RGBA32F 4096 × 48, NEAREST): a copy of
 * what `updateEffectPalette` receives, re-uploaded whole on each push like
 * the default renderer (pushes are rare: a player's effects resolve once,
 * or the effect editor changes one). A 1×1 placeholder until the first
 * push holding an effect.
 */
export class EffectPaletteTexture {
  texture: THREE.DataTexture;
  /** The mirror (null until a player has an effect). */
  private mirror: Float32Array | null = null;
  /** Players with a boat-trail / nuke-trail / any effect. */
  boatPlayers = 0;
  nukePlayers = 0;
  anyPlayers = 0;
  /** Pushes that changed the texture (each a whole upload). */
  uploads = 0;
  /** Bumped on every accepted push. */
  version = 0;

  constructor() {
    this.texture = createFloatTexture(new Float32Array(4), 1, 1);
  }

  /** The mirrored palette, null before the first effect. */
  get data(): Float32Array | null {
    return this.mirror;
  }

  /**
   * Mirror `effectData` (the whole palette, or a prefix of it). Returns
   * whether the texture changed (it is uploaded in the next render).
   */
  set(effectData: Float32Array): boolean {
    const size = PALETTE_WIDTH * EFFECT_ROWS * 4;
    if (this.mirror === null) {
      if (!anyNonZero(effectData, size)) return false;
      this.mirror = new Float32Array(size);
      this.texture.dispose();
      this.texture = createFloatTexture(
        this.mirror,
        PALETTE_WIDTH,
        EFFECT_ROWS,
      );
    }
    const m = this.mirror;
    const n = Math.min(size, effectData.length);
    m.set(effectData.subarray(0, n));
    if (n < size) m.fill(0, n);
    this.texture.needsUpdate = true;
    this.uploads++;
    this.version++;
    this.boatPlayers = 0;
    this.nukePlayers = 0;
    this.anyPlayers = 0;
    for (let sid = 1; sid < PALETTE_WIDTH; sid++) {
      let any = false;
      for (let b = 0; b < EFFECT_PALETTE_BLOCKS; b++) {
        if (!hasEffect(m, sid, b)) continue;
        any = true;
        if (b === BOAT_TRAIL_BLOCK) this.boatPlayers++;
        else if (b === NUKE_TRAIL_BLOCK) this.nukePlayers++;
      }
      if (any) this.anyPlayers++;
    }
    return true;
  }

  /** VRAM of the texture, bytes. */
  get bytes(): number {
    return this.mirror === null ? 16 : this.mirror.byteLength;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shared resource
// ---------------------------------------------------------------------------

type Uniform<T> = { value: T };

/** Uniforms of EFFECT_TRAILS_GLSL (shared by reference by the materials). */
export interface EffectTrailUniforms {
  uEffectPalette: Uniform<THREE.Texture>;
  uEffectsOn: Uniform<number>;
  uTrailTime: Uniform<number>;
  uTrailsOn: Uniform<number>;
  uTrailAlpha: Uniform<number>;
  uTrailTex: Uniform<THREE.Texture>;
  uTrailAffiliation: Uniform<THREE.Texture>;
}

const sharedTrails = new WeakMap<HeightField, EffectTrails>();

export class EffectTrails {
  readonly uniforms: EffectTrailUniforms;
  readonly effects = new EffectPaletteTexture();
  private refs = 0;
  private readonly W: number;
  private readonly H: number;
  private readonly startMs = performance.now();

  /** The trail texture's CPU data: what the GPU converges to. */
  private readonly mirror: Uint16Array;
  /** Four tiles per element (`TRAIL_WORD_COMPARE`), null if not used. */
  private readonly mirror64: Float64Array | null;
  private readonly trailTex: THREE.DataTexture;
  private readonly queue: TileUploadQueue;
  private readonly uploader: TextureRectUploader;
  /** The live TrailManager buffer of the last full push. */
  private source: Uint16Array | null = null;
  private source64: Float64Array | null = null;
  /** Tiles holding a trail (non-zero texels of the mirror). */
  private trailTiles = 0;
  /** Rows a tick reported and not diffed yet (1 = pending). */
  private readonly rowPending: Uint8Array;
  private pendingRows = 0;
  /** Row the next frame's diff starts at. */
  private rowCursor = 0;

  /** Alt-view colours (AffiliationPalette row 1), RGBA8 per owner. */
  private readonly affData = new Uint8Array(PALETTE_WIDTH * 4);
  private readonly affTex: THREE.DataTexture;
  private relations: Uint8Array | null = null;
  private relSize = 0;
  private affDirty = true;
  private affLocal = -1;
  /** Affiliation colours the texture was built from (NaN: never). */
  private readonly affKey = new Float64Array(9).fill(NaN);
  private readonly affRgb: Rgb = [0, 0, 0];

  // Perf counters.
  private readonly perf: boolean;
  private callsPending = 0;
  private texelsPending = 0;
  private callsLastFrame = 0;
  private texelsLastFrame = 0;
  private callsTotal = 0;
  private texelsTotal = 0;
  private fullUploads = 0;
  private deltas = 0;
  private scannedTotal = 0;
  private scannedLastFrame = 0;
  private diffMsLastFrame = 0;
  private diffMsMax = 0;
  private diffMsTotal = 0;
  private affRebuilds = 0;
  private readonly recentCalls: Int32Array | null;
  private readonly recentTexels: Int32Array | null;
  private recentIndex = 0;

  /** Get (creating on first use) the trails of `ctx.heightField`'s map. */
  static acquire(ctx: ThreeLayerContext): EffectTrails {
    let t = sharedTrails.get(ctx.heightField);
    if (!t) {
      t = new EffectTrails(ctx);
      sharedTrails.set(ctx.heightField, t);
    }
    t.refs++;
    return t;
  }

  private constructor(private readonly ctx: ThreeLayerContext) {
    this.W = ctx.mapWidth;
    this.H = ctx.mapHeight;
    const n = this.W * this.H;
    this.mirror = new Uint16Array(n);
    this.mirror64 =
      TRAIL_WORD_COMPARE === 4
        ? new Float64Array(this.mirror.buffer, 0, n >> 2)
        : null;
    this.trailTex = createIntegerTexture(this.mirror, this.W, this.H, "R16UI");
    this.rowPending = new Uint8Array(this.H);
    this.queue = new TileUploadQueue(this.W, this.H);
    this.uploader = new TextureRectUploader(this.trailTex);
    this.affTex = new THREE.DataTexture(
      this.affData,
      PALETTE_WIDTH,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.affTex.minFilter = THREE.NearestFilter;
    this.affTex.magFilter = THREE.NearestFilter;
    this.affTex.generateMipmaps = false;
    this.affTex.flipY = false;
    this.affTex.colorSpace = THREE.NoColorSpace;
    this.affTex.needsUpdate = true;
    this.perf = ctx.settings.perf === true;
    this.recentCalls = this.perf ? new Int32Array(PERF_WINDOW) : null;
    this.recentTexels = this.perf ? new Int32Array(PERF_WINDOW) : null;
    this.uniforms = {
      uEffectPalette: { value: this.effects.texture },
      uEffectsOn: { value: 0 },
      uTrailTime: { value: 0 },
      uTrailsOn: { value: 0 },
      uTrailAlpha: { value: trailAlphaOf(ctx.renderSettings) },
      uTrailTex: { value: this.trailTex },
      uTrailAffiliation: { value: this.affTex },
    };
  }

  // ---- Data in ----

  /**
   * The whole trail buffer (`uploadTileAndTrailState`: first tick, context
   * restore): copied into the mirror and uploaded right away.
   */
  setTrailState(state: Uint16Array): void {
    if (state.length !== this.W * this.H) return;
    this.source = state;
    this.source64 =
      state.byteOffset % 8 === 0 && this.mirror64 !== null
        ? new Float64Array(state.buffer, state.byteOffset, state.length >> 2)
        : null;
    this.mirror.set(state);
    this.trailTiles = countNonZero(state, this.source64);
    this.rowPending.fill(0);
    this.pendingRows = 0;
    this.queue.clear();
    uploadNow(this.ctx.renderer, this.trailTex);
    this.fullUploads++;
    this.countUpload(1, state.length);
  }

  /**
   * Rows `rowMin..rowMax` of the trail buffer changed
   * (`uploadLiveTrailDelta`, once per tick): marked for the next frames'
   * diff (`update`). A buffer other than the last full push's is taken as a
   * full push.
   */
  applyTrailDelta(state: Uint16Array, rowMin: number, rowMax: number): void {
    if (state.length !== this.W * this.H) return;
    if (state !== this.source) {
      this.setTrailState(state);
      return;
    }
    const r0 = Math.max(0, Math.floor(rowMin));
    const r1 = Math.min(this.H - 1, Math.floor(rowMax));
    if (!(r1 >= r0)) return;
    this.deltas++;
    const pending = this.rowPending;
    for (let y = r0; y <= r1; y++) {
      if (pending[y] === 0) {
        pending[y] = 1;
        this.pendingRows++;
      }
    }
  }

  /** The facade's effect palette (`updateEffectPalette`). */
  setEffectPalette(effectData: Float32Array): void {
    if (this.effects.set(effectData)) {
      this.uniforms.uEffectPalette.value = this.effects.texture;
    }
  }

  /** The relation matrix (alt-view ally colours). */
  setRelations(data: Uint8Array, size: number): void {
    if (!(size > 0) || data.length < size * size) return;
    this.relations = data;
    this.relSize = size;
    this.affDirty = true;
  }

  // ---- Per frame ----

  /**
   * Diff the reported rows within `TRAIL_DIFF_BUDGET`, send queued trail
   * cells within `TRAIL_UPLOAD_BUDGET` (all of them past half the map: one
   * full upload), and refresh the uniforms. Called once per frame
   * (TerrainLayer.update), before the draw.
   */
  update(frame: FrameInfo): void {
    if (this.pendingRows > 0 && this.source !== null) {
      const t0 = this.perf ? performance.now() : 0;
      this.scannedLastFrame = this.diffRows(this.source, TRAIL_DIFF_BUDGET);
      if (this.perf) {
        const ms = performance.now() - t0;
        this.diffMsLastFrame = ms;
        this.diffMsTotal += ms;
        if (ms > this.diffMsMax) this.diffMsMax = ms;
      }
    } else {
      this.scannedLastFrame = 0;
      this.diffMsLastFrame = 0;
    }
    const q = this.queue;
    if (!q.empty) {
      if (q.pendingTexels > (this.W * this.H) / 2) {
        q.clear();
        uploadNow(this.ctx.renderer, this.trailTex);
        this.fullUploads++;
        this.countUpload(1, this.W * this.H);
      } else {
        const rects = q.take(TRAIL_UPLOAD_BUDGET);
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          this.uploader.upload(this.ctx.renderer, r.x, r.y, r.w, r.h);
          this.countUpload(1, r.w * r.h);
        }
      }
    }
    this.callsLastFrame = this.callsPending;
    this.texelsLastFrame = this.texelsPending;
    this.callsPending = 0;
    this.texelsPending = 0;
    if (this.recentCalls !== null && this.recentTexels !== null) {
      this.recentCalls[this.recentIndex] = this.callsLastFrame;
      this.recentTexels[this.recentIndex] = this.texelsLastFrame;
      this.recentIndex = (this.recentIndex + 1) % PERF_WINDOW;
    }

    const rs = this.ctx.renderSettings;
    const u = this.uniforms;
    u.uTrailsOn.value =
      rs.passEnabled.trail !== false && this.trailTiles > 0 ? 1 : 0;
    u.uTrailAlpha.value = trailAlphaOf(rs);
    u.uTrailTime.value = Math.max(0, (frame.nowMs - this.startMs) / 1000);
    const fx = this.effects;
    u.uEffectsOn.value = fx.boatPlayers + fx.nukePlayers > 0 ? 1 : 0;
    if (frame.altView) this.refreshAffiliation(frame.localPlayerID);
  }

  // ---- Introspection ----

  /** Tiles holding a trail. */
  get tiles(): number {
    return this.trailTiles;
  }

  /** The trail texture's data (the mirror). */
  get trailData(): Uint16Array {
    return this.mirror;
  }

  get trailTexture(): THREE.DataTexture {
    return this.trailTex;
  }

  /** Alt-view colours (RGBA8 per owner), as last rebuilt. */
  get affiliationData(): Uint8Array {
    return this.affData;
  }

  /** Trail cells still waiting for an upload. */
  get pendingCells(): number {
    return this.queue.pendingCells;
  }

  /** Reported rows still waiting for the diff. */
  get pendingRowCount(): number {
    return this.pendingRows;
  }

  /**
   * Counters for the perf tool (merged into the terrain layer's): trail
   * uploads (calls and texels of the last frame, a full push between frames
   * included; maxima over 120 frames with `three_perf`; totals; what is
   * queued), the per-frame diff (texels scanned, rows still to diff, JS
   * time with `three_perf`), tiles holding a trail, VRAM, and the effect
   * palette.
   */
  perfStats(): Record<string, number> {
    const max = (a: Int32Array | null) => (a === null ? 0 : Math.max(...a));
    const fx = this.effects;
    return {
      trailsOn: this.uniforms.uTrailsOn.value,
      trailTiles: this.trailTiles,
      trailUploadCallsLastFrame: this.callsLastFrame,
      trailTexelsLastFrame: this.texelsLastFrame,
      trailUploadCallsMax: max(this.recentCalls),
      trailTexelsMax: max(this.recentTexels),
      trailPendingCells: this.queue.pendingCells,
      trailPendingTexels: this.queue.pendingTexels,
      trailUploadCallsTotal: this.callsTotal,
      trailTexelsTotal: this.texelsTotal,
      trailFullUploads: this.fullUploads,
      trailDeltas: this.deltas,
      trailPendingRows: this.pendingRows,
      trailScannedTexelsLastFrame: this.scannedLastFrame,
      trailScannedTexelsTotal: this.scannedTotal,
      trailDiffMsLastFrame: round2(this.diffMsLastFrame),
      trailDiffMsMax: round2(this.diffMsMax),
      trailDiffMsTotal: round2(this.diffMsTotal),
      trailMB: round2((this.W * this.H * 2 + this.affData.byteLength) / MIB),
      effectBoatPlayers: fx.boatPlayers,
      effectNukePlayers: fx.nukePlayers,
      effectPlayers: fx.anyPlayers,
      effectPaletteUploads: fx.uploads,
      effectPaletteMB: round2(fx.bytes / MIB),
      trailAffiliationRebuilds: this.affRebuilds,
    };
  }

  release(): void {
    if (--this.refs > 0) return;
    this.queue.clear();
    this.trailTex.dispose();
    this.affTex.dispose();
    this.effects.dispose();
    if (sharedTrails.get(this.ctx.heightField) === this) {
      sharedTrails.delete(this.ctx.heightField);
    }
  }

  // ---- Internals ----

  /**
   * Diff pending rows against the mirror, from the cursor (wrapping), up to
   * `budget` texels in whole rows (at least one). Returns the texels read.
   */
  private diffRows(state: Uint16Array, budget: number): number {
    const W = this.W;
    const H = this.H;
    const pending = this.rowPending;
    let scanned = 0;
    let y = this.rowCursor;
    for (let k = 0; k < H && this.pendingRows > 0; k++) {
      if (pending[y] !== 0) {
        if (scanned > 0 && scanned + W > budget) break;
        pending[y] = 0;
        this.pendingRows--;
        this.diffRange(state, y * W, (y + 1) * W);
        scanned += W;
      }
      y = y + 1 === H ? 0 : y + 1;
    }
    this.rowCursor = y;
    this.scannedTotal += scanned;
    return scanned;
  }

  /** Diff tiles [start, end) against the mirror (4 at a time when aligned). */
  private diffRange(state: Uint16Array, start: number, end: number): void {
    const live64 = this.source64;
    const mirror64 = this.mirror64;
    let t = start;
    if (live64 !== null && mirror64 !== null) {
      while ((t & 3) !== 0 && t < end) this.diffTile(state, t++);
      // Word w holds tiles 4w .. 4w + 3.
      const wEnd = end >> 2;
      for (let w = t >> 2; w < wEnd; w++) {
        if (live64[w] !== mirror64[w]) {
          const b = w << 2;
          this.diffTile(state, b);
          this.diffTile(state, b + 1);
          this.diffTile(state, b + 2);
          this.diffTile(state, b + 3);
        }
      }
      t = Math.max(t, wEnd << 2);
    }
    for (; t < end; t++) this.diffTile(state, t);
  }

  private diffTile(state: Uint16Array, t: number): void {
    const v = state[t];
    const old = this.mirror[t];
    if (v === old) return;
    this.mirror[t] = v;
    if (old === 0) this.trailTiles++;
    else if (v === 0) this.trailTiles--;
    const y = (t / this.W) | 0;
    this.queue.markRect(t - y * this.W, y, 1, 1);
  }

  private countUpload(calls: number, texels: number): void {
    this.callsPending += calls;
    this.texelsPending += texels;
    this.callsTotal += calls;
    this.texelsTotal += texels;
  }

  /**
   * Rebuild the alt-view colours when the local player, the relations or
   * the affiliation colours changed (only while the alt view shows them).
   */
  private refreshAffiliation(local: number): void {
    const aff = this.ctx.renderSettings.affiliation;
    // Compared number by number: no per-frame string while the alt view is
    // held.
    const k = this.affKey;
    const same =
      k[0] === aff.selfR &&
      k[1] === aff.selfG &&
      k[2] === aff.selfB &&
      k[3] === aff.allyR &&
      k[4] === aff.allyG &&
      k[5] === aff.allyB &&
      k[6] === aff.enemyR &&
      k[7] === aff.enemyG &&
      k[8] === aff.enemyB;
    if (!this.affDirty && local === this.affLocal && same) return;
    this.affDirty = false;
    this.affLocal = local;
    k[0] = aff.selfR;
    k[1] = aff.selfG;
    k[2] = aff.selfB;
    k[3] = aff.allyR;
    k[4] = aff.allyG;
    k[5] = aff.allyB;
    k[6] = aff.enemyR;
    k[7] = aff.enemyG;
    k[8] = aff.enemyB;
    const d = this.affData;
    const c = this.affRgb;
    d.fill(0, 0, 4);
    for (let owner = 1; owner < PALETTE_WIDTH; owner++) {
      unitAffiliationRgb(owner, local, this.relations, this.relSize, aff, c);
      const o = owner * 4;
      d[o] = Math.round(c[0] * 255);
      d[o + 1] = Math.round(c[1] * 255);
      d[o + 2] = Math.round(c[2] * 255);
      d[o + 3] = 255;
    }
    this.affTex.needsUpdate = true;
    this.affRebuilds++;
  }
}

function trailAlphaOf(rs: RenderSettings): number {
  const a = rs.mapOverlay.trailAlpha;
  return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 0.588;
}

/** A NEAREST RGBA32F DataTexture over `data`. */
function createFloatTexture(
  data: Float32Array,
  width: number,
  height: number,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Non-zero texels of a trail buffer (`words`: its float64 view, if any). */
function countNonZero(state: Uint16Array, words: Float64Array | null): number {
  let n = 0;
  let t = 0;
  if (words !== null) {
    for (let w = 0; w < words.length; w++) {
      if (words[w] === 0) continue;
      const b = w << 2;
      for (let k = 0; k < 4; k++) if (state[b + k] !== 0) n++;
    }
    t = words.length << 2;
  }
  for (; t < state.length; t++) if (state[t] !== 0) n++;
  return n;
}

function anyNonZero(data: Float32Array, n: number): boolean {
  const end = Math.min(n, data.length);
  for (let i = 0; i < end; i++) if (data[i] !== 0) return true;
  return false;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
