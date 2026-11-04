/**
 * GPU resources shared by TerrainLayer and WaterLayer:
 * - integer DataTextures (R8UI / R16UI) with immediate full uploads and
 *   rectangle uploads (`TextureRectUploader`: one `texSubImage2D` per
 *   rectangle, where three's `updateRanges` cost one call per row),
 * - `TerrainByteTexture`: the full-map terrain bytes as ONE R8UI texture
 *   for both layers (refcounted per HeightField; the facade forwards each
 *   terrain change to both layers, uploads are deduplicated by the
 *   HeightField version),
 * - the water colour uniforms both water shaders must agree on.
 */

import * as THREE from "three";
import type { RenderSettings } from "../gl/RenderSettings";
import type { TerrainRect } from "../types";
import type { HeightField } from "./HeightField";
import {
  hexToSrgb01,
  type Rgb,
  srgbToLinearRgb,
  waterColors,
} from "./TerrainShading";
import { TileUploadQueue } from "./TileUploadQueue";
import type { ThreeLayerContext } from "./types";

type IntegerTextureData = Uint8Array | Uint16Array;

/**
 * A NEAREST, single-channel unsigned-integer texture over `data`
 * (`usampler2D` + `texelFetch` in GLSL). Row y of the texture is map row y.
 */
export function createIntegerTexture(
  data: IntegerTextureData,
  width: number,
  height: number,
  internalFormat: "R8UI" | "R16UI",
): THREE.DataTexture {
  const type =
    internalFormat === "R8UI"
      ? THREE.UnsignedByteType
      : THREE.UnsignedShortType;
  const tex = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedIntegerFormat,
    type,
  );
  tex.internalFormat = internalFormat;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  // Rows are tightly packed (odd widths, 1-2 bytes per texel).
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Point a DataTexture at `data` (same dimensions). */
export function setTextureData(
  tex: THREE.DataTexture,
  data: IntegerTextureData,
): void {
  (tex.image as { data: IntegerTextureData }).data = data;
}

export function textureData(tex: THREE.DataTexture): unknown {
  return (tex.image as { data: unknown }).data;
}

/**
 * Upload the whole texture right now (synchronously, through three so its
 * state cache stays valid). Drops pending partial ranges: the full upload
 * covers them, and a first upload with ranges would leave the rest of the
 * texture uninitialised.
 */
export function uploadNow(
  renderer: THREE.WebGLRenderer,
  tex: THREE.DataTexture,
): void {
  tex.clearUpdateRanges();
  tex.needsUpdate = true;
  renderer.initTexture(tex);
}

/**
 * Uploads rectangles of a DataTexture from its CPU data (`image.data`, read
 * at upload time, so a swapped buffer is followed) with ONE `texSubImage2D`
 * each, through three's public `copyTextureToTexture`: three binds the
 * texture and saves / restores the unpack state, so its caches stay valid.
 * The copy source is an alias DataTexture over the same data that is never
 * uploaded itself: three copies from CPU memory only for a source it has
 * never seen (otherwise it copies GPU to GPU). If the target was never
 * uploaded (or the context was restored), three uploads it in full first.
 */
export class TextureRectUploader {
  private readonly source: THREE.DataTexture;
  private readonly region = new THREE.Box2();
  private readonly position = new THREE.Vector2();

  constructor(private readonly target: THREE.DataTexture) {
    const image = target.image as { width: number; height: number };
    this.source = new THREE.DataTexture(
      textureData(target) as IntegerTextureData,
      image.width,
      image.height,
      target.format as THREE.PixelFormat,
      target.type,
    );
  }

  /** Upload tiles [x, x+w) × [y, y+h) now. */
  upload(
    renderer: THREE.WebGLRenderer,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    if (w <= 0 || h <= 0) return;
    setTextureData(this.source, textureData(this.target) as IntegerTextureData);
    this.region.min.set(x, y);
    this.region.max.set(x + w, y + h);
    this.position.set(x, y);
    renderer.copyTextureToTexture(
      this.source,
      this.target,
      this.region,
      this.position,
    );
  }
}

const sharedTerrainTextures = new WeakMap<HeightField, TerrainByteTexture>();

/** The live terrain bytes (`heightField.terrain`) as one shared R8UI texture. */
export class TerrainByteTexture {
  readonly texture: THREE.DataTexture;
  private refs = 0;
  private syncedVersion: number;
  /** Merges a change's per-row rects into few rectangle uploads. */
  private readonly changes: TileUploadQueue;
  private readonly uploader: TextureRectUploader;

  /** Get (creating on first use) the texture of `ctx.heightField`. */
  static acquire(ctx: ThreeLayerContext): TerrainByteTexture {
    let t = sharedTerrainTextures.get(ctx.heightField);
    if (!t) {
      t = new TerrainByteTexture(ctx);
      sharedTerrainTextures.set(ctx.heightField, t);
    }
    t.refs++;
    return t;
  }

  private constructor(private readonly ctx: ThreeLayerContext) {
    const hf = ctx.heightField;
    this.texture = createIntegerTexture(
      hf.terrain,
      ctx.mapWidth,
      ctx.mapHeight,
      "R8UI",
    );
    uploadNow(ctx.renderer, this.texture);
    this.syncedVersion = hf.version;
    this.changes = new TileUploadQueue(ctx.mapWidth, ctx.mapHeight);
    this.uploader = new TextureRectUploader(this.texture);
  }

  /**
   * Upload a terrain change (`setTerrainBytes` arguments) right away. The
   * texture references `heightField.terrain`, which the facade has already
   * patched, so rects only select what to re-upload. They are merged into
   * rectangles of 16×16-tile cells, one call each, where three's ranges
   * cost one call per row of every rect. `rects === null` = full map
   * (`bytes` is the full array).
   */
  sync(rects: readonly TerrainRect[] | null, bytes: Uint8Array): void {
    const W = this.ctx.mapWidth;
    const H = this.ctx.mapHeight;
    const version = this.ctx.heightField.version;
    const tex = this.texture;
    if (rects === null) {
      const swap = bytes.length === W * H && bytes !== textureData(tex);
      if (!swap && version === this.syncedVersion) return;
      if (swap) setTextureData(tex, bytes);
      this.syncedVersion = version;
      uploadNow(this.ctx.renderer, tex);
      return;
    }
    if (version === this.syncedVersion) return;
    this.syncedVersion = version;
    const q = this.changes;
    for (const r of rects) q.markRect(r.x, r.y, r.w, r.h);
    if (q.pendingTexels > (W * H) / 2) {
      q.clear();
      uploadNow(this.ctx.renderer, tex);
      return;
    }
    for (const r of q.take(null)) {
      this.uploader.upload(this.ctx.renderer, r.x, r.y, r.w, r.h);
    }
  }

  release(): void {
    if (--this.refs > 0) return;
    this.texture.dispose();
    if (sharedTerrainTextures.get(this.ctx.heightField) === this) {
      sharedTerrainTextures.delete(this.ctx.heightField);
    }
  }
}

/** Water colour uniforms (linear), shared by the terrain and water shaders. */
export interface WaterUniforms {
  uWaterShallow: { value: THREE.Vector3 };
  uWaterDeep: { value: THREE.Vector3 };
  uFoamColor: { value: THREE.Vector3 };
  uSeabedShallow: { value: THREE.Vector3 };
  uWaveStrength: { value: number };
}

const DEFAULT_OCEAN: Rgb = [71 / 255, 133 / 255, 181 / 255];
const DEFAULT_SAND: Rgb = [204 / 255, 203 / 255, 158 / 255];

export function createWaterUniforms(): WaterUniforms {
  return {
    uWaterShallow: { value: new THREE.Vector3() },
    uWaterDeep: { value: new THREE.Vector3() },
    uFoamColor: { value: new THREE.Vector3() },
    uSeabedShallow: { value: new THREE.Vector3() },
    // Calm sea: steeper waves read as noise at strategy zoom.
    uWaveStrength: { value: 0.6 },
  };
}

/** Key of the terrain colours the water depends on (cheap change check). */
export function waterColorKey(terrain: RenderSettings["terrain"]): string {
  return `${terrain.oceanColor}|${terrain.sandColor}`;
}

/** Derive the water colours from the game's terrain colours. */
export function refreshWaterUniforms(
  u: WaterUniforms,
  terrain: RenderSettings["terrain"],
): void {
  const c = waterColors(hexToSrgb01(terrain.oceanColor, DEFAULT_OCEAN));
  const sand = srgbToLinearRgb(hexToSrgb01(terrain.sandColor, DEFAULT_SAND));
  u.uWaterShallow.value.fromArray(c.shallow);
  u.uWaterDeep.value.fromArray(c.deep);
  u.uFoamColor.value.fromArray(c.foam);
  u.uSeabedShallow.value.set(sand[0] * 0.85, sand[1] * 0.85, sand[2] * 0.85);
}
