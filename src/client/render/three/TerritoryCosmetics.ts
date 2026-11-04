/**
 * Territory cosmetics: patterns and skins, painted into the territory fill
 * of the terrain shader. Owned by TerrainLayer.
 *
 * Semantics (the default renderer: `gl/shaders/map-overlay/territory.frag.glsl`
 * lines 69-113, `gl/passes/SkinAtlasArray.ts`, the pattern / skin code of
 * `gl/Renderer.ts`), unchanged:
 * - Both are gated by render-settings `passEnabled.territoryPatterns` (read
 *   live), drawn only in the normal view (the alt view shows relation
 *   colours) and never on fallout tiles.
 * - Pattern: a bitmap repeated in tile space, one bit per
 *   `2^scale × 2^scale` tiles, bit set = the player's secondary colour
 *   (palette row 1, which `resolvePlayerColors` sets to the pattern's
 *   secondary colour), bit clear = the fill colour. Data layout of
 *   `writePatternEntry` (gl/utils/PlayerPalette.ts): `patternMeta` = 4 floats
 *   per smallID (hasPattern, width, height, scale), `patternData` = 1024
 *   bytes per smallID (the bitmap after the 3 header bytes).
 * - Skin: one 1024 × 1024-tile image per unique URL (`initSkinAtlas`, the
 *   player set is locked at game start), centred on the player's spawn tile
 *   (`setPlayerSpawn`; image centre = UV 0.5), a single stamp (outside it the
 *   plain fill), blended by the image alpha into the fill: raw colours in
 *   free-for-all, multiplied by the territory colour in team games. A skin
 *   overrides the pattern. Images load late (zero alpha = plain fill until
 *   then); one that fails (CORS, 404) stays the plain fill.
 * Both are looked up per tile (the tile under the fragment), so they drape
 * on the relief by construction and match the default renderer tile for
 * tile at every zoom (the default does not fade them out when zoomed out).
 *
 * 3D adaptation:
 * - One RGBA32F texel per owner (`uCosmeticMeta`, 4096 × 1) holds what the
 *   shader needs: (0, …) none, (1, width, height, scale) pattern,
 *   (2, layer, anchor x, anchor y) skin. Owners without a cosmetic cost one
 *   `texelFetch`, and none at all while no player has one (uniform switch).
 * - The skin is sampled with `textureGrad` and the world-space derivatives of
 *   the fragment, so the mip level follows the on-screen tile size under
 *   tilt (with 4× anisotropic filtering where available); the UV itself is
 *   the default's tile-quantised one (one texel per tile).
 * - The skin atlas is a `THREE.DataArrayTexture` (RGBA8, mipmapped), whose
 *   CPU copy three re-uploads after a context restore.
 *
 * Costs: the meta texture is 64 KB; the pattern bitmap texture (R8UI
 * 1024 × 4096, 4 MB, as the default) is only allocated once a player has a
 * pattern, and later changes upload only the changed rows; each skin layer is
 * 4 MB of CPU memory and ~5.3 MB of VRAM (mipmaps included).
 */

import * as THREE from "three";
import { PALETTE_WIDTH } from "./PaletteView";
import { createIntegerTexture, TextureRectUploader } from "./TerrainResources";

/** Atlas layer size in tiles (and texels): SkinAtlasArray's SKIN_DIM. */
export const SKIN_DIM = 1024;
/** Bitmap bytes per owner in `patternData` (writePatternEntry). */
export const PATTERN_ROW_BYTES = 1024;
/** Owner slots (the palette size). */
export const COSMETIC_SLOTS = PALETTE_WIDTH;
/** `uCosmeticMeta` kinds (texel .x). */
export const COSMETIC_NONE = 0;
export const COSMETIC_PATTERN = 1;
export const COSMETIC_SKIN = 2;
/** Anisotropic filtering of the skin atlas (tilted view), when available. */
const SKIN_ANISOTROPY = 4;
/** Bytes of one skin layer (RGBA8). */
const SKIN_LAYER_BYTES = SKIN_DIM * SKIN_DIM * 4;
const MIB = 1024 * 1024;

// ---- Pure helpers (TS mirrors of the shader; unit-tested) ----

/**
 * Pattern bit at tile (x, y): true = secondary colour. The integer math of
 * the default's territory.frag.glsl (and of TERRITORY_COSMETICS_GLSL):
 * `bits` holds the bitmap from byte `offset` (one owner's row).
 */
export function patternBitAt(
  width: number,
  height: number,
  scale: number,
  bits: Uint8Array,
  offset: number,
  x: number,
  y: number,
): boolean {
  const px = x >> scale;
  const py = y >> scale;
  const mx = ((px % width) + width) % width;
  const my = ((py % height) + height) % height;
  const bitIndex = my * width + mx;
  const byte = bits[offset + (bitIndex >> 3)] ?? 0;
  return (byte & (1 << (bitIndex & 7))) !== 0;
}

/**
 * Skin UV of tile (x, y) for a skin anchored at (ax, ay): the default's
 * `(tile - anchor) / SKIN_DIM + 0.5` (the anchor tile is the image centre).
 */
export function skinUv(
  x: number,
  y: number,
  ax: number,
  ay: number,
): [number, number] {
  return [(x - ax) / SKIN_DIM + 0.5, (y - ay) / SKIN_DIM + 0.5];
}

/** Whether a skin UV is on the image (outside: the plain fill). */
export function skinUvInBounds(u: number, v: number): boolean {
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/**
 * Where an image of `w × h` px lands in its SKIN_DIM² layer: centred,
 * downscaled to fit, never upscaled (SkinAtlasArray.uploadImage).
 */
export function skinPlacement(
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(1, SKIN_DIM / w, SKIN_DIM / h);
  const dw = (w * scale) | 0;
  const dh = (h * scale) | 0;
  return {
    x: ((SKIN_DIM - dw) / 2) | 0,
    y: ((SKIN_DIM - dh) / 2) | 0,
    w: dw,
    h: dh,
  };
}

/**
 * Write owner `sid`'s `uCosmeticMeta` texel into `out`: a skin (layer + 1
 * > 0) overrides a pattern (`patternMeta[sid * 4] > 0`), as in the default.
 */
export function packCosmeticEntry(
  out: Float32Array,
  sid: number,
  patternMeta: Float32Array,
  skinLayerPlus1: Uint8Array,
  anchors: Uint16Array,
): number {
  const o = sid * 4;
  const layerPlus1 = skinLayerPlus1[sid];
  if (layerPlus1 > 0) {
    out[o] = COSMETIC_SKIN;
    out[o + 1] = layerPlus1 - 1;
    out[o + 2] = anchors[sid * 2];
    out[o + 3] = anchors[sid * 2 + 1];
    return COSMETIC_SKIN;
  }
  if (patternMeta[o] > 0) {
    out[o] = COSMETIC_PATTERN;
    out[o + 1] = patternMeta[o + 1];
    out[o + 2] = patternMeta[o + 2];
    out[o + 3] = patternMeta[o + 3];
    return COSMETIC_PATTERN;
  }
  out.fill(0, o, o + 4);
  return COSMETIC_NONE;
}

/**
 * GLSL of the territory cosmetics. Declares its uniforms and
 * `vec3 territoryCosmetic(int owner, ivec2 tile, vec3 fill, vec2 dx, vec2 dy)`:
 * the fill colour (sRGB 0..1) of an owned tile with its pattern or skin
 * (`dx` / `dy`: derivatives of the world xz along screen x / y, for the
 * skin's mip level). Needs `uPalette` (row 1 = secondary colour).
 */
export const TERRITORY_COSMETICS_GLSL = /* glsl */ `
uniform float uCosmeticsOn;               // territoryPatterns and any player has one
uniform float uCosmeticsTeam;             // 1 = team game: skins tinted by the fill
uniform highp sampler2D uCosmeticMeta;    // RGBA32F 4096 x 1, see TerritoryCosmetics.ts
uniform highp usampler2D uPatternBits;    // R8UI 1024 x 4096, row = owner
uniform highp sampler2DArray uSkinAtlas;  // RGBA8 1024 x 1024 x layers, mipmapped

const float SKIN_DIM = ${SKIN_DIM.toFixed(1)};

vec3 territoryCosmetic(int owner, ivec2 tile, vec3 fill, vec2 dx, vec2 dy) {
  vec4 m = texelFetch(uCosmeticMeta, ivec2(owner, 0), 0);
  if (m.x > 1.5) {
    // Skin: one stamp centred on the spawn tile (UV 0.5), tile-quantised UV
    // as the default; the mip level follows the fragment's footprint.
    vec2 uv = (vec2(tile) - m.zw) / SKIN_DIM + 0.5;
    vec4 s = textureGrad(uSkinAtlas, vec3(uv, m.y), dx / SKIN_DIM, dy / SKIN_DIM);
    bool inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
    float a = inside ? s.a : 0.0;
    vec3 sc = uCosmeticsTeam > 0.5 ? fill * s.rgb : s.rgb;
    return mix(fill, sc, a);
  }
  if (m.x > 0.5) {
    // Pattern: bit set = secondary colour (palette row 1).
    int pw = int(m.y);
    int ph = int(m.z);
    int ps = int(m.w);
    int mx = (((tile.x >> ps) % pw) + pw) % pw;
    int my = (((tile.y >> ps) % ph) + ph) % ph;
    int bitIndex = my * pw + mx;
    uint bits = texelFetch(uPatternBits, ivec2(bitIndex >> 3, owner), 0).r;
    if ((bits & (1u << uint(bitIndex & 7))) != 0u) {
      return texelFetch(uPalette, ivec2(owner, 1), 0).rgb;
    }
  }
  return fill;
}
`;

// ---- Skin image loading ----

/** Decoded pixels of one skin layer (SKIN_DIM² RGBA8), or null on failure. */
export type SkinPixels = Uint8Array | Uint8ClampedArray;

/**
 * Loads a skin image and hands back its SKIN_DIM² layer pixels (or null when
 * it fails) and the JS time it spent decoding them (ms). Returns a cancel
 * function. Injectable for tests.
 */
export type SkinLoader = (
  url: string,
  done: (pixels: SkinPixels | null, decodeMs?: number) => void,
) => () => void;

/**
 * Browser loader: `<img crossOrigin="anonymous">` drawn centred into a
 * SKIN_DIM² canvas (SkinAtlasArray.uploadImage), read back as RGBA8. A
 * failed load (CORS, 404) logs the default renderer's warning.
 */
export const loadSkinPixels: SkinLoader = (url, done) => {
  let cancelled = false;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (cancelled) return;
    const t0 = performance.now();
    let pixels: SkinPixels | null = null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = SKIN_DIM;
      canvas.height = SKIN_DIM;
      const g = canvas.getContext("2d", { willReadFrequently: true });
      if (g !== null) {
        const p = skinPlacement(img.naturalWidth, img.naturalHeight);
        g.drawImage(img, p.x, p.y, p.w, p.h);
        pixels = g.getImageData(0, 0, SKIN_DIM, SKIN_DIM).data;
      }
    } catch (err) {
      console.warn("Skin image failed to load:", url, err);
    }
    done(pixels, performance.now() - t0);
  };
  img.onerror = () => {
    if (cancelled) return;
    console.warn("Skin image failed to load:", url);
    done(null);
  };
  img.src = url;
  return () => {
    cancelled = true;
    img.onload = null;
    img.onerror = null;
  };
};

type Uniform<T> = { value: T };

export interface TerritoryCosmeticsUniforms {
  uCosmeticsOn: Uniform<number>;
  uCosmeticsTeam: Uniform<number>;
  uCosmeticMeta: Uniform<THREE.Texture>;
  uPatternBits: Uniform<THREE.Texture>;
  uSkinAtlas: Uniform<THREE.Texture>;
}

/** The pattern / skin state behind the terrain shader's territory fill. */
export class TerritoryCosmetics {
  readonly uniforms: TerritoryCosmeticsUniforms;

  /** The facade's pattern meta (writePatternEntry layout), copied. */
  private readonly patternMeta = new Float32Array(COSMETIC_SLOTS * 4);
  /** Per owner: 0 = no skin, else atlas layer + 1 (GPURenderer's table). */
  private readonly skinLayerPlus1 = new Uint8Array(COSMETIC_SLOTS);
  /** Per owner: skin anchor tile (x, y), (0, 0) until a spawn is known. */
  private readonly anchors = new Uint16Array(COSMETIC_SLOTS * 2);
  /** `uCosmeticMeta` texels (packCosmeticEntry). */
  private readonly meta = new Float32Array(COSMETIC_SLOTS * 4);
  private readonly kinds = new Uint8Array(COSMETIC_SLOTS);
  private readonly metaTex: THREE.DataTexture;
  private patternPlayers = 0;
  private skinPlayers = 0;

  /** Pattern bitmaps; a 1×1 placeholder until a player has a pattern. */
  private patternTex: THREE.DataTexture;
  private patternUploader: TextureRectUploader | null = null;
  /**
   * The bitmap texture was just allocated: three uploads it whole (from the
   * live CPU copy) in the next render, so row uploads would only force that
   * 4 MB upload early, inside the facade call.
   */
  private patternFresh = false;
  private patternRowUploads = 0;
  private patternRowsUploaded = 0;

  /** Skin atlas: a 1×1×1 placeholder until `initSkinAtlas` has URLs. */
  private skinTex: THREE.DataArrayTexture;
  private skinUrls: readonly string[] = [];
  private readonly skinLayers = new Map<string, number>();
  private skinLoaded = 0;
  private skinFailed = 0;
  private skinDecodeMsMax = 0;
  private skinDecodeMsTotal = 0;
  /** JS time of `setPatterns` / `initSkinAtlas` calls. */
  private setupMsMax = 0;
  private setupMsTotal = 0;
  private cancelLoads: (() => void)[] = [];
  /** A restore happened: the next frame re-uploads the whole atlas. */
  private restorePending = false;
  private disposed = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly loader: SkinLoader = loadSkinPixels,
  ) {
    this.metaTex = new THREE.DataTexture(
      this.meta,
      COSMETIC_SLOTS,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.metaTex.minFilter = THREE.NearestFilter;
    this.metaTex.magFilter = THREE.NearestFilter;
    this.metaTex.generateMipmaps = false;
    this.metaTex.flipY = false;
    this.metaTex.colorSpace = THREE.NoColorSpace;
    this.metaTex.needsUpdate = true;
    this.patternTex = createIntegerTexture(new Uint8Array(1), 1, 1, "R8UI");
    this.skinTex = createSkinTexture(new Uint8Array(4), 1, 1);
    this.uniforms = {
      uCosmeticsOn: { value: 0 },
      uCosmeticsTeam: { value: 0 },
      uCosmeticMeta: { value: this.metaTex },
      uPatternBits: { value: this.patternTex },
      uSkinAtlas: { value: this.skinTex },
    };
  }

  /** The `uCosmeticMeta` texels (read-only view, for tests and tools). */
  get metaData(): Float32Array {
    return this.meta;
  }

  /** Pattern bitmaps as uploaded (null until a player has a pattern). */
  get patternBits(): Uint8Array | null {
    return this.patternUploader === null
      ? null
      : (this.patternTex.image.data as Uint8Array);
  }

  /** The atlas layer of a skin URL, -1 when not registered. */
  skinLayer(url: string): number {
    return this.skinLayers.get(url) ?? -1;
  }

  /**
   * Patterns of every player (`addPlayers` / `updatePlayerCosmetics`):
   * the facade's whole `patternMeta` / `patternData` arrays. Only the
   * bitmap rows that changed are uploaded.
   */
  setPatterns(patternMeta: Float32Array, patternData: Uint8Array): void {
    const t0 = performance.now();
    const n = Math.min(COSMETIC_SLOTS * 4, patternMeta.length);
    this.patternMeta.set(patternMeta.subarray(0, n));
    if (n < this.patternMeta.length) this.patternMeta.fill(0, n);
    let r0 = COSMETIC_SLOTS;
    let r1 = -1;
    for (let sid = 0; sid < COSMETIC_SLOTS; sid++) {
      if (!(this.patternMeta[sid * 4] > 0)) continue;
      const src = sid * PATTERN_ROW_BYTES;
      if (src >= patternData.length) continue;
      const row = patternData.subarray(src, src + PATTERN_ROW_BYTES);
      const bits = this.ensurePatternTexture();
      if (rowEquals(bits, src, row)) continue;
      bits.set(row, src);
      if (sid < r0) r0 = sid;
      if (sid > r1) r1 = sid;
    }
    if (r1 >= r0 && this.patternUploader !== null && !this.patternFresh) {
      this.patternUploader.upload(
        this.renderer,
        0,
        r0,
        PATTERN_ROW_BYTES,
        r1 - r0 + 1,
      );
      this.patternRowUploads++;
      this.patternRowsUploaded += r1 - r0 + 1;
    }
    this.recomposeAll();
    this.noteSetup(performance.now() - t0);
  }

  /**
   * Allocate one atlas layer per unique skin URL and start loading them
   * (GPURenderer.initSkinAtlas: called once at game start). The same list
   * again (after a context restore) keeps the loaded layers.
   */
  initSkinAtlas(urls: readonly string[]): void {
    if (sameList(urls, this.skinUrls)) return;
    const t0 = performance.now();
    this.cancelSkinLoads();
    this.skinTex.dispose();
    this.skinLayers.clear();
    this.skinUrls = [...urls];
    this.skinLoaded = 0;
    this.skinFailed = 0;
    this.skinLayerPlus1.fill(0);
    const n = this.skinUrls.length;
    this.skinTex =
      n === 0
        ? createSkinTexture(new Uint8Array(4), 1, 1)
        : createSkinTexture(new Uint8Array(n * SKIN_LAYER_BYTES), SKIN_DIM, n);
    if (n > 0) this.skinTex.anisotropy = maxAnisotropy(this.renderer);
    this.uniforms.uSkinAtlas.value = this.skinTex;
    this.skinUrls.forEach((url, layer) => {
      this.skinLayers.set(url, layer);
      this.loadLayer(url, layer);
    });
    this.recomposeAll();
    this.noteSetup(performance.now() - t0);
  }

  /**
   * Show a registered skin for a player, or none (null). URLs not given to
   * `initSkinAtlas` are ignored, as in the default renderer.
   */
  setPlayerSkin(smallID: number, url: string | null): void {
    if (!validSlot(smallID)) return;
    let layer = -1;
    if (url !== null) {
      layer = this.skinLayer(url);
      if (layer < 0) return;
    }
    this.skinLayerPlus1[smallID] = layer + 1;
    this.recompose(smallID);
  }

  /** A player's spawn tile: the centre of their skin. */
  setPlayerSpawn(smallID: number, x: number, y: number): void {
    if (!validSlot(smallID)) return;
    this.anchors[smallID * 2] = x;
    this.anchors[smallID * 2 + 1] = y;
    this.recompose(smallID);
  }

  /** Team games tint skins by the territory colour. */
  setTeamMode(on: boolean): void {
    this.uniforms.uCosmeticsTeam.value = on ? 1 : 0;
  }

  /** Per frame: the live `territoryPatterns` switch, restore handling. */
  update(showPatterns: boolean): void {
    // This frame's render uploads a fresh bitmap texture whole.
    this.patternFresh = false;
    const any = this.patternPlayers + this.skinPlayers > 0;
    this.uniforms.uCosmeticsOn.value = showPatterns && any ? 1 : 0;
    if (this.restorePending) {
      this.restorePending = false;
      // A layer that loaded around the restore must not limit three's
      // re-upload to that layer: upload them all from the CPU copy.
      this.skinTex.clearLayerUpdates();
      this.skinTex.needsUpdate = true;
    }
  }

  /** After a WebGL context restore (three re-uploads the CPU copies). */
  contextRestored(): void {
    this.restorePending = true;
  }

  /**
   * Counters for the perf tool: players with a pattern / skin, atlas layers
   * (allocated, loaded, failed), VRAM (MiB, skin mipmaps included), the
   * JS time of a skin decode (draw + read-back + copy into the atlas) and of
   * the setup calls (`setPatterns`, `initSkinAtlas`). The GPU upload of a
   * layer and its mipmaps happens in the next frame's render.
   */
  perfStats(): Record<string, number> {
    const layers = this.skinUrls.length;
    const patternBytes = this.patternUploader === null ? 1 : 1024 * 4096;
    const skinBytes = layers === 0 ? 4 : (layers * SKIN_LAYER_BYTES * 4) / 3;
    return {
      patternPlayers: this.patternPlayers,
      skinPlayers: this.skinPlayers,
      skinLayers: layers,
      skinLayersLoaded: this.skinLoaded,
      skinLayersFailed: this.skinFailed,
      skinMB: round2(skinBytes / MIB),
      patternMB: round2(patternBytes / MIB),
      cosmeticsMB: round2(
        (skinBytes + patternBytes + COSMETIC_SLOTS * 16) / MIB,
      ),
      patternRowUploads: this.patternRowUploads,
      patternRowsUploaded: this.patternRowsUploaded,
      skinDecodeMsMax: round2(this.skinDecodeMsMax),
      skinDecodeMsTotal: round2(this.skinDecodeMsTotal),
      cosmeticsSetupMsMax: round2(this.setupMsMax),
      cosmeticsSetupMsTotal: round2(this.setupMsTotal),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSkinLoads();
    this.metaTex.dispose();
    this.patternTex.dispose();
    this.skinTex.dispose();
  }

  // ---- Internals ----

  /** The full-size bitmap texture's data (allocated on first use). */
  private ensurePatternTexture(): Uint8Array {
    if (this.patternUploader === null) {
      this.patternTex.dispose();
      this.patternTex = createIntegerTexture(
        new Uint8Array(PATTERN_ROW_BYTES * COSMETIC_SLOTS),
        PATTERN_ROW_BYTES,
        COSMETIC_SLOTS,
        "R8UI",
      );
      this.patternUploader = new TextureRectUploader(this.patternTex);
      this.patternFresh = true;
      this.uniforms.uPatternBits.value = this.patternTex;
    }
    return this.patternTex.image.data as Uint8Array;
  }

  private loadLayer(url: string, layer: number): void {
    const tex = this.skinTex;
    const cancel = this.loader(url, (pixels, decodeMs = 0) => {
      // A newer atlas (or dispose) replaced this one.
      if (this.disposed || tex !== this.skinTex) return;
      if (pixels === null || pixels.length < SKIN_LAYER_BYTES) {
        this.skinFailed++;
        return;
      }
      const t0 = performance.now();
      const data = tex.image.data as Uint8Array;
      data.set(pixels.subarray(0, SKIN_LAYER_BYTES), layer * SKIN_LAYER_BYTES);
      tex.addLayerUpdate(layer);
      tex.needsUpdate = true;
      this.skinLoaded++;
      const ms = decodeMs + performance.now() - t0;
      this.skinDecodeMsTotal += ms;
      if (ms > this.skinDecodeMsMax) this.skinDecodeMsMax = ms;
    });
    this.cancelLoads.push(cancel);
  }

  private noteSetup(ms: number): void {
    this.setupMsTotal += ms;
    if (ms > this.setupMsMax) this.setupMsMax = ms;
  }

  private cancelSkinLoads(): void {
    for (const cancel of this.cancelLoads) cancel();
    this.cancelLoads = [];
  }

  private recompose(sid: number): void {
    const before = this.kinds[sid];
    const kind = packCosmeticEntry(
      this.meta,
      sid,
      this.patternMeta,
      this.skinLayerPlus1,
      this.anchors,
    );
    this.kinds[sid] = kind;
    this.countKind(before, -1);
    this.countKind(kind, 1);
    this.metaTex.needsUpdate = true;
  }

  private recomposeAll(): void {
    this.patternPlayers = 0;
    this.skinPlayers = 0;
    for (let sid = 0; sid < COSMETIC_SLOTS; sid++) {
      const kind = packCosmeticEntry(
        this.meta,
        sid,
        this.patternMeta,
        this.skinLayerPlus1,
        this.anchors,
      );
      this.kinds[sid] = kind;
      this.countKind(kind, 1);
    }
    this.metaTex.needsUpdate = true;
  }

  private countKind(kind: number, delta: number): void {
    if (kind === COSMETIC_PATTERN) this.patternPlayers += delta;
    else if (kind === COSMETIC_SKIN) this.skinPlayers += delta;
  }
}

/** RGBA8 array texture of `layers` square layers of `size` texels. */
function createSkinTexture(
  data: Uint8Array,
  size: number,
  layers: number,
): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  const mipmapped = size > 1;
  tex.generateMipmaps = mipmapped;
  tex.minFilter = mipmapped
    ? THREE.LinearMipmapLinearFilter
    : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  // sRGB bytes blended in sRGB like the fill (the shader linearises after).
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function maxAnisotropy(renderer: THREE.WebGLRenderer): number {
  const caps = (renderer as Partial<THREE.WebGLRenderer>).capabilities;
  const max = caps?.getMaxAnisotropy?.() ?? 1;
  return Math.max(1, Math.min(SKIN_ANISOTROPY, max));
}

function validSlot(sid: number): boolean {
  return Number.isInteger(sid) && sid >= 0 && sid < COSMETIC_SLOTS;
}

function rowEquals(bits: Uint8Array, offset: number, row: Uint8Array): boolean {
  for (let i = 0; i < row.length; i++) {
    if (bits[offset + i] !== row[i]) return false;
  }
  return true;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
