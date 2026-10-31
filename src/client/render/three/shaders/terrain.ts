/**
 * GLSL (ES 3.00) of the relief mesh: terrain colours, lighting, territory
 * fill, crisp sub-tile borders, fallout and the water surface wherever the
 * (low-pass) relief rises above sea level. Used by TerrainLayer through a
 * `ShaderMaterial` with `glslVersion: GLSL3`, `fog: true`.
 *
 * Everything per tile is decided with `texelFetch` on full-resolution
 * integer textures (terrain bytes, tile state, relation matrix) at the tile
 * containing the fragment, so coastlines, territory and borders stay crisp
 * at tile resolution no matter how coarse the mesh grid is.
 */

import { ENV_COMMON, FRAG_OUTPUT, NOISE_COMMON, WATER_COMMON } from "./water";

export const TERRAIN_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
#include <fog_pars_vertex>

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const TERRAIN_FRAG = /* glsl */ `
${FRAG_OUTPUT}
${ENV_COMMON}
${NOISE_COMMON}
${WATER_COMMON}

uniform highp usampler2D uTerrain;   // R8UI W x H terrain bytes
uniform highp usampler2D uTiles;     // R16UI W x H tile state
uniform highp usampler2D uRelations; // R8UI N x N, m[a][b] at texel (b, a)
uniform highp sampler2D uPalette;    // RGBA32F 4096 x 2: row 0 fill, row 1 border (sRGB)
uniform ivec2 uMapSize;
uniform int uRelSize;
uniform float uTime;
uniform float uHeightScale;

// Terrain colours, sRGB 0..1 (RenderSettings.terrain).
uniform vec3 uColSand;
uniform vec3 uColPlains;
uniform vec3 uColHighland;
uniform vec3 uColMountain;
uniform vec3 uColVoid;

// Territory look (RenderSettings.mapOverlay / affiliation).
uniform float uFillAlpha;
uniform float uFillSaturation;
uniform float uHighlightFill;
uniform float uHighlightBorder;
uniform vec3 uEmbargoTint;
uniform float uEmbargoRatio;
uniform vec3 uFriendlyTint;
uniform float uFriendlyRatio;
uniform vec3 uFalloutColor;
uniform int uHighlightOwner;
uniform int uLocalPlayer;
uniform float uAltView;
uniform float uAltFillAlpha;
uniform vec3 uAffSelf;
uniform vec3 uAffAlly;
uniform vec3 uAffNeutral;
uniform vec3 uAffEnemy;
uniform float uBorderPx;   // target border width, device px
uniform float uMinBorder;  // narrowest border, tiles
uniform float uBorderGlow; // border emission (bloom), fraction of its colour

varying vec3 vWorld;
varying vec3 vNormal;
#include <fog_pars_fragment>

const float DETAIL_RELIEF = 0.35;
const uint LAND = 0x80u;
const uint SHORE = 0x40u;
const uint MAG = 0x1fu;

uint terrainAt(ivec2 t) {
  return texelFetch(uTerrain, clamp(t, ivec2(0), uMapSize - 1), 0).r;
}

// 0 = water, 1 = passable land, 2 = impassable ("void").
int tileClass(uint tb) {
  if ((tb & LAND) == 0u) return 0;
  return (tb & MAG) == 31u ? 2 : 1;
}

// Owner smallID of a tile, 0 off the map.
int ownerAt(ivec2 t) {
  if (any(lessThan(t, ivec2(0))) || any(greaterThanEqual(t, uMapSize))) return 0;
  return int(texelFetch(uTiles, t, 0).r & 0xfffu);
}

// Pairwise relation: 0 neutral, 1 friendly, 2 embargo.
uint relationOf(int a, int b) {
  if (a <= 0 || b <= 0 || a >= uRelSize || b >= uRelSize) return 0u;
  return texelFetch(uRelations, ivec2(b, a), 0).r;
}

// Alt-view colour of an owner, from the local player's point of view.
vec3 affiliation(int owner) {
  if (owner == uLocalPlayer) return uAffSelf;
  uint r = uLocalPlayer > 0 ? relationOf(uLocalPlayer, owner) : 0u;
  return r == 1u ? uAffAlly : (r == 2u ? uAffEnemy : uAffNeutral);
}

// Surface height of a tile (TerrainCodec.heightForTerrainByte for land;
// water and void at sea level), for the per-tile detail normal.
float tileHeight(uint tb) {
  uint m = tb & MAG;
  if ((tb & LAND) == 0u || m == 31u) return 0.0;
  float t = min(float(m), 30.0) / 30.0;
  return uHeightScale * (0.03 + 0.97 * pow(t, 1.6));
}

// Albedo (sRGB) of a passable land tile: encodeTerrainTile's colour
// families (sand / plains / highland), mountains going rock -> snow cap.
vec3 landColor(uint tb) {
  float m = float(tb & MAG);
  if ((tb & SHORE) != 0u) return uColSand;
  if (m < 10.0) {
    return vec3(uColPlains.r, max(uColPlains.g - 2.0 * m / 255.0, 0.0), uColPlains.b);
  }
  if (m < 20.0) return min(uColHighland + 2.0 * (m - 10.0) / 255.0, vec3(1.0));
  vec3 rock = uColMountain * vec3(0.72, 0.70, 0.68);
  vec3 snow = min(uColMountain * 1.04 + 0.02, vec3(1.0));
  return mix(rock, snow, smoothstep(22.5, 26.5, m));
}

// Bilinear contribution of one neighbour tile, land only.
vec4 landSample(uint tb, float wt) {
  return tileClass(tb) == 1 ? vec4(landColor(tb) * wt, wt) : vec4(0.0);
}

float shoreValue(uint tb) {
  return (tb & LAND) != 0u ? -1.0 : float(min(tb & MAG, 16u));
}

// Coverage of a border band of width w (tiles) at distance d from the tile
// edge, with a one-pixel (aa tiles) ramp. A full-tile band covers the tile.
float edgeCoverage(float d, float w, float aa) {
  if (w >= 0.999) return 1.0;
  return clamp((w - d) / aa + 0.5, 0.0, 1.0);
}

// Water tile: the seabed (under the water plane), or the water surface
// itself where the relief is above sea level.
vec3 shadeWaterTile(vec2 p, uvec4 t4, vec2 w, vec3 V, float tpp) {
  float mag = mix(
    mix(shoreValue(t4.x), shoreValue(t4.y), w.x),
    mix(shoreValue(t4.z), shoreValue(t4.w), w.x),
    w.y);
  // Flat-lit so it matches WaterLayer's own seabed composite exactly.
  vec3 seabed = seabedAlbedo(mag) * diffuseLight(UP);
  vec3 c = seabed;
  if (vWorld.y > 0.0) {
    vec4 wtr = shadeWater(p, mag, V, tpp, uTime);
    c = mix(seabed, wtr.rgb, wtr.a);
  }
  return c * mix(1.0, 0.6, uAltView);
}

vec3 shadeLandTile(
  vec2 p, ivec2 tile, vec2 f, uint tb, uvec4 t4, vec2 w,
  vec3 nMesh, vec2 fw, float detail
) {
  int cls = tileClass(tb);
  vec4 bw = vec4((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y);

  // --- Albedo (sRGB): smooth between neighbouring land tiles, crisp
  // against water and void.
  vec3 albedo;
  vec3 n = nMesh;
  if (cls == 2) {
    albedo = uColVoid * (0.8 + 0.35 * detail * valueNoise(p * 0.9));
  } else {
    vec4 acc = landSample(t4.x, bw.x) + landSample(t4.y, bw.y)
      + landSample(t4.z, bw.z) + landSample(t4.w, bw.w);
    albedo = acc.a > 1e-4 ? acc.rgb / acc.a : landColor(tb);

    // Per-tile detail normal: gradient of the bilinear tile heights (the
    // mesh is a low-pass grid), faded out when tiles get small on screen.
    // Magnitude steps between neighbouring tiles are terraces of up to ~1.5
    // tiles of height per tile, so the gradient is flattened (x DETAIL_RELIEF)
    // to a gentle texture instead of dark bands along every zone boundary.
    float h00 = tileHeight(t4.x);
    float h10 = tileHeight(t4.y);
    float h01 = tileHeight(t4.z);
    float h11 = tileHeight(t4.w);
    float gx = mix(h10 - h00, h11 - h01, w.y) * DETAIL_RELIEF;
    float gz = mix(h01 - h00, h11 - h10, w.x) * DETAIL_RELIEF;
    vec3 nDetail = normalize(vec3(-gx, 1.0, -gz));
    n = normalize(mix(nMesh, nDetail, 0.6 * detail));

    // Bare rock on steep highland / mountain flanks.
    if ((tb & MAG) >= 10u) {
      vec3 rock = uColMountain * vec3(0.62, 0.60, 0.58);
      albedo = mix(albedo, rock, 0.7 * (1.0 - smoothstep(0.72, 0.92, n.y)));
    }
    if (detail > 0.0) {
      float nz = 0.6 * valueNoise(p * 1.9) + 0.4 * valueNoise(p * 5.3);
      albedo *= 1.0 + (nz - 0.5) * 0.1 * detail;
    }
  }
  // Slope darkening (cheap ambient occlusion of steep ground).
  float ao = mix(0.75, 1.0, smoothstep(0.55, 0.95, n.y));

  // --- Territory fill (mixed in sRGB like the default renderer's blend).
  uint st = texelFetch(uTiles, tile, 0).r;
  int owner = int(st & 0xfffu);
  bool fallout = (st & 0x2000u) != 0u;
  bool alt = uAltView > 0.5;
  bool hl = owner != 0 && owner == uHighlightOwner;
  if (alt) {
    float l = dot(albedo, vec3(0.299, 0.587, 0.114));
    albedo = mix(vec3(l), albedo, 0.35) * 0.6;
  }
  if (owner != 0) {
    vec3 fill;
    float a;
    if (alt) {
      fill = affiliation(owner);
      a = uAltFillAlpha;
    } else {
      fill = texelFetch(uPalette, ivec2(owner, 0), 0).rgb;
      float l = dot(fill, vec3(0.299, 0.587, 0.114));
      fill = mix(vec3(l), fill, uFillSaturation);
      if (hl) fill = clamp((fill - 0.5) * (1.0 + uHighlightFill) + 0.5, 0.0, 1.0);
      a = uFillAlpha;
    }
    albedo = mix(albedo, fill, a);
  }

  // --- Fallout: toxic ground with a slow glowing pulse.
  vec3 emissive = vec3(0.0);
  if (fallout) {
    float nz = valueNoise(p * 0.45 + vec2(uTime * 0.05, uTime * 0.03));
    float pulse = 0.75 + 0.25 * sin(uTime * 1.3 + nz * 6.2831853);
    vec3 tox = uFalloutColor + (hash12(tile) - 0.5) * 0.08;
    albedo = mix(albedo, clamp(tox, 0.0, 1.0), 0.8);
    // Noise peaks push the luminance past the bloom threshold: glowing patches.
    emissive = srgbToLinear(uFalloutColor) * (0.6 + 3.2 * nz * nz) * pulse;
  }

  vec3 lit = srgbToLinear(albedo) * diffuseLight(n) * ao + emissive;

  // --- Borders: a band along every edge whose 4-neighbour has another
  // owner (plus concave corners), width = uBorderPx pixels clamped to
  // [uMinBorder, 1] tile, anti-aliased over one pixel.
  if (owner != 0) {
    float wx = clamp(uBorderPx * fw.x, uMinBorder, 1.0);
    float wz = clamp(uBorderPx * fw.y, uMinBorder, 1.0);
    if (hl) {
      wx = min(1.0, wx * 1.7);
      wz = min(1.0, wz * 1.7);
    }
    int oW = ownerAt(tile + ivec2(-1, 0));
    int oE = ownerAt(tile + ivec2(1, 0));
    int oN = ownerAt(tile + ivec2(0, -1));
    int oS = ownerAt(tile + ivec2(0, 1));
    float cov = 0.0;
    int nb = 0;
    float c;
    if (oW != owner) { c = edgeCoverage(f.x, wx, fw.x); if (c > cov) { cov = c; nb = oW; } }
    if (oE != owner) { c = edgeCoverage(1.0 - f.x, wx, fw.x); if (c > cov) { cov = c; nb = oE; } }
    if (oN != owner) { c = edgeCoverage(f.y, wz, fw.y); if (c > cov) { cov = c; nb = oN; } }
    if (oS != owner) { c = edgeCoverage(1.0 - f.y, wz, fw.y); if (c > cov) { cov = c; nb = oS; } }
    // Concave corners: both edge neighbours match, the diagonal does not.
    bool nearW = f.x < wx + fw.x;
    bool nearE = 1.0 - f.x < wx + fw.x;
    bool nearN = f.y < wz + fw.y;
    bool nearS = 1.0 - f.y < wz + fw.y;
    if (nearW && nearN && oW == owner && oN == owner) {
      int o = ownerAt(tile + ivec2(-1, -1));
      if (o != owner) {
        c = min(edgeCoverage(f.x, wx, fw.x), edgeCoverage(f.y, wz, fw.y));
        if (c > cov) { cov = c; nb = o; }
      }
    }
    if (nearE && nearN && oE == owner && oN == owner) {
      int o = ownerAt(tile + ivec2(1, -1));
      if (o != owner) {
        c = min(edgeCoverage(1.0 - f.x, wx, fw.x), edgeCoverage(f.y, wz, fw.y));
        if (c > cov) { cov = c; nb = o; }
      }
    }
    if (nearW && nearS && oW == owner && oS == owner) {
      int o = ownerAt(tile + ivec2(-1, 1));
      if (o != owner) {
        c = min(edgeCoverage(f.x, wx, fw.x), edgeCoverage(1.0 - f.y, wz, fw.y));
        if (c > cov) { cov = c; nb = o; }
      }
    }
    if (nearE && nearS && oE == owner && oS == owner) {
      int o = ownerAt(tile + ivec2(1, 1));
      if (o != owner) {
        c = min(edgeCoverage(1.0 - f.x, wx, fw.x), edgeCoverage(1.0 - f.y, wz, fw.y));
        if (c > cov) { cov = c; nb = o; }
      }
    }

    if (cov > 0.0) {
      vec3 bc;
      if (alt) {
        bc = affiliation(owner);
      } else {
        bc = texelFetch(uPalette, ivec2(owner, 1), 0).rgb;
        if (hl) bc = mix(bc, vec3(1.0), uHighlightBorder);
        // Pairwise tint with the owner across this edge (not relative to
        // the local player), as BorderStampPass does.
        uint rel = relationOf(owner, nb);
        if (rel == 2u) bc = mix(bc, uEmbargoTint, uEmbargoRatio);
        else if (rel == 1u) bc = mix(bc, uFriendlyTint, uFriendlyRatio);
      }
      vec3 bl = srgbToLinear(bc);
      // Half draped (hillshaded), half flat-lit so borders stay readable on
      // shaded slopes; a little emission feeds the bloom glow.
      vec3 light = 0.5 * diffuseLight(n) + 0.5 * diffuseLight(UP);
      vec3 borderLit = bl * light + bl * (hl ? 3.0 * uBorderGlow : uBorderGlow);
      lit = mix(lit, borderLit, cov);
    }
  }
  return lit;
}

void main() {
  vec2 p = vWorld.xz;
  // Derivatives in uniform control flow: tiles per device pixel along x / z.
  vec2 fw = max(fwidth(p), vec2(1e-5));
  float tpp = max(fw.x, fw.y);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 nMesh = normalize(vNormal);
  vec3 col;

  if (nMesh.y < 0.02) {
    // Map-edge skirt (vertical wall): an earthy cross-section.
    float y = vWorld.y;
    vec3 soil = vec3(0.23, 0.16, 0.10);
    vec3 rock = vec3(0.11, 0.10, 0.10);
    vec3 c = mix(rock, soil, smoothstep(-2.0, 0.5, y));
    c *= 0.9 + 0.1 * sin(y * 9.0 + 2.0 * valueNoise(p * 0.5));
    col = c * diffuseLight(nMesh);
  } else {
    ivec2 tile = clamp(ivec2(floor(p)), ivec2(0), uMapSize - 1);
    vec2 f = clamp(p - vec2(tile), 0.0, 1.0);
    uint tb = terrainAt(tile);
    // The 4 tile centres around p, for bilinear colour / depth / normals.
    vec2 q = p - 0.5;
    ivec2 b = ivec2(floor(q));
    vec2 w = q - vec2(b);
    uvec4 t4 = uvec4(
      terrainAt(b),
      terrainAt(b + ivec2(1, 0)),
      terrainAt(b + ivec2(0, 1)),
      terrainAt(b + ivec2(1, 1)));
    // Per-tile detail fades out once a tile is under ~1-3 pixels.
    float detail = 1.0 - smoothstep(0.35, 1.2, tpp);
    if ((tb & LAND) == 0u) {
      col = shadeWaterTile(p, t4, w, V, tpp);
    } else {
      col = shadeLandTile(p, tile, f, tb, t4, w, nMesh, fw, detail);
    }
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
