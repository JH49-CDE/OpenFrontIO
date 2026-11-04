/**
 * Territory patterns and skins in the 3D renderer (TerritoryCosmetics.ts),
 * checked against the default renderer's own data path and logic:
 * - patterns are written with the default's `writePatternEntry`, and the
 *   3D lookup (packed meta texel + bitmap texture, `patternBitAt`, the
 *   shader's integer math) matches `PatternDecoder.isPrimary` and a literal
 *   port of territory.frag.glsl, tile for tile;
 * - skins: layer per URL in `initSkinAtlas` order, unknown URLs ignored,
 *   skin over pattern, anchor = spawn tile at UV 0.5, the stamp bounds,
 *   SkinAtlasArray's image placement, late / failed loads, dispose and
 *   context restore.
 */
import {
  decodePatternData,
  PatternDecoder,
} from "@openfront/shared/PatternDecoder";
import { base64url } from "jose";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { getPaletteSize } from "../../../src/client/render/gl/utils/ColorUtils";
import { writePatternEntry } from "../../../src/client/render/gl/utils/PlayerPalette";
import { TERRAIN_FRAG } from "../../../src/client/render/three/shaders/terrain";
import {
  COSMETIC_NONE,
  COSMETIC_PATTERN,
  COSMETIC_SKIN,
  COSMETIC_SLOTS,
  PATTERN_ROW_BYTES,
  patternBitAt,
  SKIN_DIM,
  type SkinLoader,
  type SkinPixels,
  skinPlacement,
  skinUv,
  skinUvInBounds,
  TERRITORY_COSMETICS_GLSL,
  TerritoryCosmetics,
} from "../../../src/client/render/three/TerritoryCosmetics";

/** Encode a pattern bitmap the way the catalog does (version 0). */
function encodePattern(
  width: number,
  height: number,
  scale: number,
  isSecondary: (x: number, y: number) => boolean,
): string {
  const bytes = new Uint8Array(3 + Math.ceil((width * height) / 8));
  bytes[0] = 0;
  bytes[1] = (scale & 0x07) | (((width - 2) & 0x1f) << 3);
  bytes[2] = (((width - 2) >> 5) & 0x03) | (((height - 2) & 0x3f) << 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isSecondary(x, y)) continue;
      const i = y * width + x;
      bytes[3 + (i >> 3)] |= 1 << (i & 7);
    }
  }
  return base64url.encode(bytes);
}

/** An asymmetric "F" glyph, so any flip or transposition shows. */
const F_GLYPH = (x: number, y: number) =>
  (x === 1 && y >= 1 && y <= 6) ||
  (y === 1 && x >= 1 && x <= 5) ||
  (y === 3 && x >= 1 && x <= 4);

const PATTERNS = [
  { name: "f_glyph", data: encodePattern(8, 8, 1, F_GLYPH) },
  {
    name: "odd_dims",
    data: encodePattern(13, 5, 0, (x, y) => (x * 7 + y * 3) % 5 < 2),
  },
  { name: "wide", data: encodePattern(129, 2, 3, (x, y) => (x + y) % 3 === 0) },
  { name: "tall", data: encodePattern(3, 65, 2, (x, y) => y % 4 === x) },
];

/**
 * Literal TS port of the default renderer's pattern branch
 * (territory.frag.glsl), on its own data layout: true = secondary colour.
 */
function defaultShaderSecondary(
  meta: Float32Array,
  data: Uint8Array,
  owner: number,
  tx: number,
  ty: number,
): boolean {
  const o = owner * 4;
  if (!(meta[o] > 0)) return false;
  const pWidth = Math.trunc(meta[o + 1]);
  const pHeight = Math.trunc(meta[o + 2]);
  const pScale = Math.trunc(meta[o + 3]);
  const px = tx >> pScale;
  const py = ty >> pScale;
  const mx = ((px % pWidth) + pWidth) % pWidth;
  const my = ((py % pHeight) + pHeight) % pHeight;
  const bitIndex = my * pWidth + mx;
  const byteIndex = bitIndex >> 3;
  const patternByte = data[owner * 1024 + byteIndex];
  return (patternByte & (1 << (bitIndex & 7))) !== 0;
}

interface Copy {
  y: number;
  h: number;
  w: number;
}

function stubRenderer() {
  const copies: Copy[] = [];
  const renderer = {
    initTexture: () => {},
    copyTextureToTexture: (
      _src: THREE.Texture,
      _dst: THREE.Texture,
      region: THREE.Box2,
    ) => {
      copies.push({
        y: region.min.y,
        h: region.max.y - region.min.y,
        w: region.max.x - region.min.x,
      });
    },
    capabilities: { getMaxAnisotropy: () => 16 },
  } as unknown as THREE.WebGLRenderer;
  return { renderer, copies };
}

/** A loader whose loads complete when the test says so. */
function manualLoader() {
  const pending = new Map<
    string,
    (p: SkinPixels | null, decodeMs?: number) => void
  >();
  const requested: string[] = [];
  let cancelled = 0;
  const loader: SkinLoader = (url, done) => {
    requested.push(url);
    pending.set(url, done);
    return () => {
      cancelled++;
    };
  };
  return {
    loader,
    requested,
    cancelled: () => cancelled,
    finish: (url: string, pixels: SkinPixels | null, decodeMs?: number) =>
      pending.get(url)?.(pixels, decodeMs),
  };
}

function layerPixels(fill: number): Uint8Array {
  return new Uint8Array(SKIN_DIM * SKIN_DIM * 4).fill(fill);
}

const texel = (c: TerritoryCosmetics, sid: number) =>
  Array.from(c.metaData.subarray(sid * 4, sid * 4 + 4));

describe("territory patterns", () => {
  it("uses the palette size for its owner slots", () => {
    expect(COSMETIC_SLOTS).toBe(getPaletteSize());
  });

  it("matches the default renderer's bit lookup, tile for tile", () => {
    const size = getPaletteSize();
    const meta = new Float32Array(size * 4);
    const data = new Uint8Array(size * 1024);
    const owners = [1, 7, 300, size - 1];
    PATTERNS.forEach((p, i) =>
      writePatternEntry(meta, data, owners[i], {
        name: p.name,
        patternData: p.data,
      }),
    );
    const { renderer } = stubRenderer();
    const c = new TerritoryCosmetics(renderer);
    c.setPatterns(meta, data);
    const bits = c.patternBits!;
    expect(bits).not.toBeNull();

    PATTERNS.forEach((p, i) => {
      const owner = owners[i];
      const decoder = new PatternDecoder(
        { name: p.name, patternData: p.data },
        base64url.decode,
      );
      const [kind, w, h, scale] = texel(c, owner);
      expect(kind).toBe(COSMETIC_PATTERN);
      const decoded = decodePatternData(p.data, base64url.decode);
      expect([w, h, scale]).toEqual([
        decoded.width,
        decoded.height,
        decoded.scale,
      ]);
      let secondary = 0;
      let mismatches = 0;
      // Map-sized coordinates, including far tiles (wrap-around).
      for (let y = 0; y < 200; y += 1) {
        for (let x = 0; x < 200; x += 1) {
          const tx = x * 7 + (y % 3);
          const ty = y * 5;
          const mine = patternBitAt(
            w,
            h,
            scale,
            bits,
            owner * PATTERN_ROW_BYTES,
            tx,
            ty,
          );
          if (mine !== defaultShaderSecondary(meta, data, owner, tx, ty)) {
            mismatches++;
          }
          if (mine === decoder.isPrimary(tx, ty)) mismatches++;
          if (mine) secondary++;
        }
      }
      expect(mismatches).toBe(0);
      expect(secondary).toBeGreaterThan(0);
    });
  });

  it("keeps the orientation: bit (x, y) of the bitmap at tile (x, y) << scale", () => {
    const size = getPaletteSize();
    const meta = new Float32Array(size * 4);
    const data = new Uint8Array(size * 1024);
    writePatternEntry(meta, data, 3, {
      name: "f_glyph",
      patternData: PATTERNS[0].data,
    });
    const c = new TerritoryCosmetics(stubRenderer().renderer);
    c.setPatterns(meta, data);
    const at = (x: number, y: number) =>
      patternBitAt(8, 8, 1, c.patternBits!, 3 * PATTERN_ROW_BYTES, x, y);
    // Scale 1: each bit covers 2×2 tiles; the F's bar runs along +x at
    // row 1, its stem along +y at column 1.
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        expect(at(x, y)).toBe(F_GLYPH(x >> 1, y >> 1));
      }
    }
    expect(at(10, 2)).toBe(true); // bar
    expect(at(2, 10)).toBe(true); // stem
    expect(at(2 + 16 * 40, 10 + 16 * 25)).toBe(true); // repeats
  });

  it("uploads the bitmap texture only when a pattern exists, then only changed rows", () => {
    const size = getPaletteSize();
    const meta = new Float32Array(size * 4);
    const data = new Uint8Array(size * 1024);
    const { renderer, copies } = stubRenderer();
    const c = new TerritoryCosmetics(renderer);
    c.setPatterns(meta, data);
    expect(c.patternBits).toBeNull();
    expect(c.perfStats().patternMB).toBe(0);
    expect(
      (c.uniforms.uPatternBits.value as THREE.DataTexture).image.width,
    ).toBe(1);

    writePatternEntry(meta, data, 5, {
      name: "a",
      patternData: PATTERNS[1].data,
    });
    c.setPatterns(meta, data);
    const tex = c.uniforms.uPatternBits.value as THREE.DataTexture;
    expect(tex.image.width).toBe(PATTERN_ROW_BYTES);
    expect(tex.image.height).toBe(size);
    expect(c.perfStats().patternMB).toBe(4);
    // Fresh texture: three uploads it whole in the next render (needsUpdate),
    // not row by row inside the facade call.
    expect(copies).toEqual([]);
    expect(tex.version).toBeGreaterThan(0);
    c.update(true); // the frame that uploads it

    // Same data again (every addPlayers sends the whole arrays): no upload.
    c.setPatterns(meta, data);
    expect(copies).toHaveLength(0);

    writePatternEntry(meta, data, 40, {
      name: "b",
      patternData: PATTERNS[2].data,
    });
    c.setPatterns(meta, data);
    expect(copies).toEqual([{ y: 40, h: 1, w: 1024 }]);
    expect(c.perfStats().patternPlayers).toBe(2);

    // Cleared (cosmetics hidden): the meta texel goes, the bitmap stays.
    writePatternEntry(meta, data, 5, undefined);
    c.setPatterns(meta, data);
    expect(texel(c, 5)).toEqual([COSMETIC_NONE, 0, 0, 0]);
    expect(c.perfStats().patternPlayers).toBe(1);
    expect(copies).toHaveLength(1);
  });

  it("switches the shader branch with territoryPatterns and only when a player has one", () => {
    const size = getPaletteSize();
    const meta = new Float32Array(size * 4);
    const data = new Uint8Array(size * 1024);
    const c = new TerritoryCosmetics(stubRenderer().renderer);
    c.update(true);
    expect(c.uniforms.uCosmeticsOn.value).toBe(0);
    writePatternEntry(meta, data, 2, {
      name: "a",
      patternData: PATTERNS[0].data,
    });
    c.setPatterns(meta, data);
    c.update(true);
    expect(c.uniforms.uCosmeticsOn.value).toBe(1);
    c.update(false);
    expect(c.uniforms.uCosmeticsOn.value).toBe(0);
  });

  it("is wired into the terrain shader's fill, with the same integer math", () => {
    expect(TERRAIN_FRAG).toContain(TERRITORY_COSMETICS_GLSL);
    expect(TERRAIN_FRAG).toMatch(
      /uCosmeticsOn > 0\.5 && !fallout\) \{\s*fill = territoryCosmetic\(owner, tile, fill, dp\.xy, dp\.zw\);/,
    );
    // The default's lookup, on the packed meta texel.
    for (const line of [
      "int mx = (((tile.x >> ps) % pw) + pw) % pw;",
      "int my = (((tile.y >> ps) % ph) + ph) % ph;",
      "int bitIndex = my * pw + mx;",
      "texelFetch(uPatternBits, ivec2(bitIndex >> 3, owner), 0).r",
      "(bits & (1u << uint(bitIndex & 7))) != 0u",
      "return texelFetch(uPalette, ivec2(owner, 1), 0).rgb;",
      "vec2 uv = (vec2(tile) - m.zw) / SKIN_DIM + 0.5;",
      "vec3 sc = uCosmeticsTeam > 0.5 ? fill * s.rgb : s.rgb;",
      "return mix(fill, sc, a);",
    ]) {
      expect(TERRITORY_COSMETICS_GLSL).toContain(line);
    }
  });
});

describe("territory skins", () => {
  const A = "https://cdn.test/skins/a.png";
  const B = "https://cdn.test/skins/b.png";

  it("maps the anchor (spawn) tile to the image centre and stamps it once", () => {
    expect(skinUv(400, 300, 400, 300)).toEqual([0.5, 0.5]);
    expect(skinUv(400 - 512, 300 + 512, 400, 300)).toEqual([0, 1]);
    const [u0, v0] = skinUv(400 - 513, 300, 400, 300);
    expect(skinUvInBounds(u0, v0)).toBe(false);
    const [u1, v1] = skinUv(400 + 511, 300 - 511, 400, 300);
    expect(skinUvInBounds(u1, v1)).toBe(true);
    // Anchor (0, 0) (no spawn yet) = world origin, as the default.
    expect(skinUv(0, 0, 0, 0)).toEqual([0.5, 0.5]);
  });

  it("places images like SkinAtlasArray (centred, downscaled, never upscaled)", () => {
    expect(skinPlacement(1024, 1024)).toEqual({ x: 0, y: 0, w: 1024, h: 1024 });
    expect(skinPlacement(2048, 1024)).toEqual({
      x: 0,
      y: 256,
      w: 1024,
      h: 512,
    });
    expect(skinPlacement(300, 200)).toEqual({ x: 362, y: 412, w: 300, h: 200 });
    expect(skinPlacement(1000, 3000)).toEqual({
      x: 341,
      y: 0,
      w: 341,
      h: 1024,
    });
  });

  it("assigns layers in URL order and ignores unknown URLs", () => {
    const l = manualLoader();
    const c = new TerritoryCosmetics(stubRenderer().renderer, l.loader);
    c.initSkinAtlas([A, B]);
    expect(l.requested).toEqual([A, B]);
    expect(c.skinLayer(A)).toBe(0);
    expect(c.skinLayer(B)).toBe(1);
    const tex = c.uniforms.uSkinAtlas.value as THREE.DataArrayTexture;
    expect(tex.isDataArrayTexture).toBe(true);
    expect([tex.image.width, tex.image.height, tex.image.depth]).toEqual([
      SKIN_DIM,
      SKIN_DIM,
      2,
    ]);
    expect(tex.generateMipmaps).toBe(true);
    expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.anisotropy).toBe(4);

    c.setPlayerSpawn(9, 120, 340);
    c.setPlayerSkin(9, B);
    expect(texel(c, 9)).toEqual([COSMETIC_SKIN, 1, 120, 340]);
    c.setPlayerSpawn(9, 121, 341); // re-picked spawn
    expect(texel(c, 9)).toEqual([COSMETIC_SKIN, 1, 121, 341]);

    c.setPlayerSkin(10, "https://cdn.test/skins/unknown.png");
    expect(texel(c, 10)).toEqual([COSMETIC_NONE, 0, 0, 0]);
    c.setPlayerSkin(9, null);
    expect(texel(c, 9)).toEqual([COSMETIC_NONE, 0, 0, 0]);
    c.setPlayerSkin(-1, A);
    c.setPlayerSkin(COSMETIC_SLOTS, A);
    expect(c.perfStats().skinPlayers).toBe(0);
  });

  it("overrides a pattern, which comes back when the skin is cleared", () => {
    const size = getPaletteSize();
    const meta = new Float32Array(size * 4);
    const data = new Uint8Array(size * 1024);
    writePatternEntry(meta, data, 4, {
      name: "a",
      patternData: PATTERNS[0].data,
    });
    const c = new TerritoryCosmetics(
      stubRenderer().renderer,
      manualLoader().loader,
    );
    c.initSkinAtlas([A]);
    c.setPatterns(meta, data);
    expect(texel(c, 4)[0]).toBe(COSMETIC_PATTERN);
    c.setPlayerSkin(4, A);
    expect(texel(c, 4)[0]).toBe(COSMETIC_SKIN);
    // A later pattern push keeps the skin on top.
    c.setPatterns(meta, data);
    expect(texel(c, 4)[0]).toBe(COSMETIC_SKIN);
    c.setPlayerSkin(4, null);
    expect(texel(c, 4)).toEqual([COSMETIC_PATTERN, 8, 8, 1]);
  });

  it("fills a layer when its image arrives; a failed image stays the plain fill", () => {
    const l = manualLoader();
    const c = new TerritoryCosmetics(stubRenderer().renderer, l.loader);
    c.initSkinAtlas([A, B]);
    const tex = c.uniforms.uSkinAtlas.value as THREE.DataArrayTexture;
    const data = tex.image.data as Uint8Array;
    const layer = SKIN_DIM * SKIN_DIM * 4;
    expect(data.length).toBe(2 * layer);
    const v0 = tex.version;

    l.finish(B, layerPixels(200), 12.5);
    expect(c.perfStats().skinDecodeMsMax).toBeGreaterThanOrEqual(12.5);
    expect(data[layer]).toBe(200);
    expect(data[2 * layer - 1]).toBe(200);
    expect(data[layer - 1]).toBe(0); // layer 0 untouched
    expect([...tex.layerUpdates]).toEqual([1]);
    expect(tex.version).toBeGreaterThan(v0);

    l.finish(A, null); // CORS / 404
    expect(data[0]).toBe(0);
    const s = c.perfStats();
    expect(s.skinLayers).toBe(2);
    expect(s.skinLayersLoaded).toBe(1);
    expect(s.skinLayersFailed).toBe(1);
    // 2 layers × 4 MiB × 4/3 (mipmaps).
    expect(s.skinMB).toBeCloseTo(10.67, 2);
  });

  it("keeps the loaded atlas when the same URLs come again (context restore)", () => {
    const l = manualLoader();
    const c = new TerritoryCosmetics(stubRenderer().renderer, l.loader);
    c.initSkinAtlas([A, B]);
    l.finish(A, layerPixels(9));
    const tex = c.uniforms.uSkinAtlas.value;
    c.initSkinAtlas([A, B]);
    expect(l.requested).toEqual([A, B]);
    expect(c.uniforms.uSkinAtlas.value).toBe(tex);

    // After a restore the next frame re-uploads every layer, not only the
    // ones that loaded since the last upload.
    l.finish(B, layerPixels(7));
    c.contextRestored();
    const v = tex.version;
    c.update(true);
    expect((tex as THREE.DataArrayTexture).layerUpdates.size).toBe(0);
    expect(tex.version).toBeGreaterThan(v);

    // A different list rebuilds the atlas and its layer table.
    c.setPlayerSkin(3, A);
    c.initSkinAtlas([B]);
    expect(c.uniforms.uSkinAtlas.value).not.toBe(tex);
    expect(c.skinLayer(A)).toBe(-1);
    expect(texel(c, 3)[0]).toBe(COSMETIC_NONE);
    expect(l.cancelled()).toBe(2);
  });

  it("ignores images that arrive after dispose", () => {
    const l = manualLoader();
    const c = new TerritoryCosmetics(stubRenderer().renderer, l.loader);
    c.initSkinAtlas([A]);
    const tex = c.uniforms.uSkinAtlas.value as THREE.DataArrayTexture;
    let disposed = 0;
    tex.addEventListener("dispose", () => disposed++);
    c.dispose();
    expect(disposed).toBe(1);
    expect(l.cancelled()).toBe(1);
    l.finish(A, layerPixels(5));
    expect((tex.image.data as Uint8Array)[0]).toBe(0);
    expect(c.perfStats().skinLayersLoaded).toBe(0);
  });

  it("tints skins in team games only", () => {
    const c = new TerritoryCosmetics(stubRenderer().renderer);
    expect(c.uniforms.uCosmeticsTeam.value).toBe(0);
    c.setTeamMode(true);
    expect(c.uniforms.uCosmeticsTeam.value).toBe(1);
  });

  it("has a 1×1 placeholder atlas without skins", () => {
    const l = manualLoader();
    const c = new TerritoryCosmetics(stubRenderer().renderer, l.loader);
    c.initSkinAtlas([]);
    expect(l.requested).toEqual([]);
    const tex = c.uniforms.uSkinAtlas.value as THREE.DataArrayTexture;
    expect([tex.image.width, tex.image.depth]).toEqual([1, 1]);
    expect(tex.generateMipmaps).toBe(false);
    expect(c.perfStats().skinMB).toBe(0);
  });
});
