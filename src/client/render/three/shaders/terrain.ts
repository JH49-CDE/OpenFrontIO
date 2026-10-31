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
 *
 * Two looks, cross-faded by the on-screen tile size (`close`):
 * - strategy zoom: a soft bilinear blend of the 2D map's per-tile colours
 *   with a gentle per-tile hillshade;
 * - close up (a tile over ~3-7 px): organic terrain zones (sand / plains /
 *   upland, sampled at a domain-warped point and sharpened to crisp wavy
 *   edges), rock and snow lines following the blended elevation, and
 *   procedural micro detail (bump normals + albedo) per material.
 * The close-up code is kept lean although GPUs skip it when zoomed out:
 * SwiftShader (headless runs) executes both sides of every branch.
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
// Land magnitude of the snow line (rock below, snow above).
const float SNOW_LINE = 24.5;

uint terrainAt(ivec2 t) {
  return texelFetch(uTerrain, clamp(t, ivec2(0), uMapSize - 1), 0).r;
}

// 0 = water, 1 = passable land, 2 = impassable ("void").
int tileClass(uint tb) {
  if ((tb & LAND) == 0u) return 0;
  return (tb & MAG) == 31u ? 2 : 1;
}

// Zone of a tile for the close-up blend: 0 sand (shore), 1 plains,
// 2 upland (highland + mountain); -1 = not passable land.
int zoneClass(uint tb) {
  if (tileClass(tb) != 1) return -1;
  if ((tb & SHORE) != 0u) return 0;
  return (tb & MAG) < 10u ? 1 : 2;
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

// Surface heights of 4 tiles (TerrainCodec.heightForTerrainByte for
// passable land; water and void at sea level), for the detail normal.
vec4 tileHeights(uvec4 t4) {
  vec4 m = vec4(t4 & uvec4(MAG));
  vec4 land = vec4(notEqual(t4 & uvec4(LAND), uvec4(0u))) * step(m, vec4(30.5));
  return land * uHeightScale * (0.03 + 0.97 * pow(min(m, 30.0) / 30.0, vec4(1.6)));
}

// Albedo (sRGB) of a passable land tile: encodeTerrainTile's colour
// families (sand / plains / highland); mountains are bare rock here, their
// snow comes from the magnitude (zoomed out) or the blended elevation.
vec3 baseColor(uint tb) {
  float m = float(tb & MAG);
  if ((tb & SHORE) != 0u) return uColSand;
  if (m < 10.0) {
    return vec3(uColPlains.r, max(uColPlains.g - 2.0 * m / 255.0, 0.0), uColPlains.b);
  }
  if (m < 20.0) return min(uColHighland + 2.0 * (m - 10.0) / 255.0, vec3(1.0));
  return uColMountain * vec3(0.72, 0.70, 0.68);
}

// Value noise with its analytic gradient: (n, dn/dx, dn/dy).
vec3 valueNoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  ivec2 c = ivec2(i);
  float a = hash12(c);
  float b = hash12(c + ivec2(1, 0));
  float d = hash12(c + ivec2(0, 1));
  float e = hash12(c + ivec2(1, 1));
  float k = a - b - d + e;
  return vec3(
    a + (b - a) * u.x + (d - a) * u.y + k * u.x * u.y,
    du * (vec2(b - a, d - a) + k * u.yx));
}

// Fade of a noise octave of 'freq' cycles per tile: gone before its period
// shrinks under ~3 pixels (no shimmer).
float octaveFade(float freq, float tpp) {
  return 1.0 - smoothstep(0.17, 0.33, freq * tpp);
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

// Coverage of bands of width wv (tiles, x / z) along the flagged edges
// (W, E, N, S) and concave corners (NW, NE, SW, SE) of a tile.
float bandCoverage(vec2 f, vec2 wv, vec2 fw, bvec4 edges, bvec4 corners) {
  vec4 c = vec4(
    edgeCoverage(f.x, wv.x, fw.x), edgeCoverage(1.0 - f.x, wv.x, fw.x),
    edgeCoverage(f.y, wv.y, fw.y), edgeCoverage(1.0 - f.y, wv.y, fw.y));
  vec4 e = c * vec4(edges);
  vec4 k = min(c.xyxy, c.zzww) * vec4(corners);
  return max(max(max(e.x, e.y), max(e.z, e.w)), max(max(k.x, k.y), max(k.z, k.w)));
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
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

// p: world xz; tile / f: the tile under p and the position in it; t4 / w:
// the 4 tile centres around the (close up: domain-warped) sample point and
// its bilinear weights; nw: the warp noise; close: 0 at strategy zoom .. 1
// once a tile spans ~7+ pixels.
vec3 shadeLandTile(
  vec2 p, ivec2 tile, vec2 f, uint tb, uvec4 t4, vec2 w, vec3 nw,
  vec3 nMesh, vec2 fw, float tpp, float detail, float close
) {
  vec3 albedo;
  vec3 n = nMesh;
  float shade = 1.0;
  if (tileClass(tb) == 2) {
    albedo = uColVoid * (0.8 + 0.35 * detail * valueNoise(p * 0.9));
  } else {
    vec3 rockCol = uColMountain * vec3(0.72, 0.70, 0.68);
    vec3 snowCol = min(uColMountain * 1.04 + 0.02, vec3(1.0));
    vec4 mags = vec4(t4 & uvec4(MAG));
    ivec4 zc = ivec4(zoneClass(t4.x), zoneClass(t4.y), zoneClass(t4.z), zoneClass(t4.w));
    vec4 isUp = vec4(equal(zc, ivec4(2)));
    vec4 bw = vec4((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y);
    vec4 bwLand = bw * vec4(greaterThanEqual(zc, ivec4(0)));
    mat4x3 c4 = mat4x3(baseColor(t4.x), baseColor(t4.y), baseColor(t4.z), baseColor(t4.w));
    float bt = dot(bwLand, vec4(1.0));
    vec3 own = baseColor(tb);

    // --- Strategy zoom: bilinear blend of the land tile colours (the 2D
    // map's per-tile colours, softened; mountains whiten towards the snow
    // line), crisp against water and void.
    vec4 snowF = isUp * step(20.0, mags) * smoothstep(SNOW_LINE - 2.0, SNOW_LINE + 2.0, mags);
    vec3 farCol = bt > 1e-4
      ? (c4 * (bwLand * (1.0 - snowF)) + snowCol * dot(bwLand, snowF)) / bt
      : own;

    // --- Close up: organic zones. The blend is sharpened towards the
    // dominant zone class: corner weight x exp(k (classWeight - 1)); k = 0
    // is the plain bilinear blend, and between two classes the 12-88%
    // transition spans ~4 / (4 + 2k) tiles, set to ~2 px (or 0.12 tile).
    // Inside the upland zone, highland -> rock (magnitude ~19.5) -> snow
    // follow the blended elevation plus large-scale noise, so they form
    // whole slopes and caps instead of tile speckle.
    albedo = farCol;
    float sand = 0.0;
    float grass = 0.0;
    float high = 0.0;
    float rock = 0.0;
    float snow = 0.0;
    float up = 0.0;
    float lo = 0.5;
    if (close > 0.0) {
      vec4 cw = vec4(
        dot(bwLand, vec4(equal(zc, ivec4(zc.x)))),
        dot(bwLand, vec4(equal(zc, ivec4(zc.y)))),
        dot(bwLand, vec4(equal(zc, ivec4(zc.z)))),
        dot(bwLand, vec4(equal(zc, ivec4(zc.w)))));
      float k = close * max(2.0 / max(2.0 * tpp, 0.12) - 2.0, 0.0);
      vec4 sw = bwLand * exp(k * (cw - 1.0));
      float tot = dot(sw, vec4(1.0));
      int z0 = zoneClass(tb);
      sw = tot > 1e-5 ? sw / tot : vec4(0.0);
      sand = tot > 1e-5 ? dot(sw, vec4(equal(zc, ivec4(0)))) : float(z0 == 0);
      grass = tot > 1e-5 ? dot(sw, vec4(equal(zc, ivec4(1)))) : float(z0 == 1);
      up = tot > 1e-5 ? dot(sw, isUp) : float(z0 == 2);
      vec3 lowCol = tot > 1e-5 ? c4 * (sw * (1.0 - isUp)) : own * (1.0 - up);
      float elev = up > 1e-5 && tot > 1e-5 ? dot(sw * isUp, mags) / up : float(tb & MAG);
      lo = valueNoise(mat2(0.94, 0.34, -0.34, 0.94) * p * 0.23 + vec2(-31.0, 17.0));
      float e = elev + (lo - 0.5) * 5.0 + (nw.x - 0.5);
      float rockAmt = smoothstep(18.0, 21.0, e);
      float snowAmt = smoothstep(SNOW_LINE - 0.8, SNOW_LINE + 0.8, e);
      vec3 hiCol = min(uColHighland + 2.0 * (clamp(elev, 10.0, 19.0) - 10.0) / 255.0, vec3(1.0));
      vec3 nearCol = lowCol + up * mix(mix(hiCol, rockCol, rockAmt), snowCol, snowAmt);
      albedo = mix(farCol, nearCol, close);
      snow = up * snowAmt;
      rock = up * rockAmt - snow;
      high = up - rock - snow;
    }

    // Per-tile detail normal: gradient of the bilinear tile heights (the
    // mesh is a low-pass grid), faded out when tiles get small on screen.
    // Magnitude steps between neighbouring tiles are terraces of up to ~1.5
    // tiles of height per tile, so the gradient is flattened (x DETAIL_RELIEF)
    // to a gentle texture instead of dark bands along every zone boundary.
    vec4 h4 = tileHeights(t4);
    float gx = mix(h4.y - h4.x, h4.w - h4.z, w.y) * DETAIL_RELIEF;
    float gz = mix(h4.z - h4.x, h4.w - h4.y, w.x) * DETAIL_RELIEF;
    n = normalize(mix(nMesh, normalize(vec3(-gx, 1.0, -gz)), 0.6 * detail));

    // Bare rock on steep highland / mountain flanks (zoomed out: on
    // highland / mountain tiles; close up: on the upland zone, sparing snow).
    float steep = 0.7 * (1.0 - smoothstep(0.72, 0.92, n.y));
    float onUpland = mix((tb & MAG) >= 10u ? 1.0 : 0.0, up - 0.6 * snow, close);
    albedo = mix(albedo, uColMountain * vec3(0.62, 0.60, 0.58), steep * onUpland);
    rock = max(rock, steep * onUpland);

    // --- Micro detail from two noise octaves. o1 (1.7 / tile) is stretched
    // across a slowly turning direction close up (rock strata, wind-combed
    // grass); o2 (4.6 / tile) is fine grain. Zoomed out they only speckle
    // the albedo a little; close up they become per-material bump normals
    // and albedo variation, each faded once its period is under ~3 px.
    float ang = 0.6 + lo * 4.0 * close;
    vec2 u = vec2(cos(ang), sin(ang));
    vec2 v = vec2(-u.y, u.x);
    vec2 s1 = vec2(1.7, 1.7 + 2.0 * close);
    vec3 o1 = valueNoiseD(vec2(dot(p, u), dot(p, v)) * s1 + vec2(3.1, 7.7));
    vec2 g1 = u * (s1.x * o1.y) + v * (s1.y * o1.z); // d o1 / dp
    vec3 o2 = valueNoiseD(mat2(0.6, -0.8, 0.8, 0.6) * p * 4.6);
    vec2 g2 = mat2(0.6, 0.8, -0.8, 0.6) * o2.yz * 4.6;
    albedo *= 1.0 + (0.6 * o1.x + 0.4 * o2.x - 0.5) * 0.1 * detail * (1.0 - close);
    if (close > 0.0) {
      float f1 = octaveFade(s1.y, tpp) * close;
      float f2 = octaveFade(4.6, tpp) * close;
      // Ridged fold for rock: sharp crests where |2 o1 - 1| = 0.
      float ridge = 1.0 - abs(2.0 * o1.x - 1.0);
      vec2 dRidge = (o1.x > 0.5 ? -2.0 : 2.0) * g1;
      float veg = grass + high;
      // Slopes (dh/dx, dh/dz) of the bump height field.
      vec2 g = g1 * (f1 * (0.035 * veg + 0.02 * snow + 0.015 * sand))
        + dRidge * (f1 * 0.04 * rock)
        + g2 * (f2 * (0.014 * veg + 0.02 * rock + 0.004 * snow + 0.008 * sand));
      n = normalize(n - vec3(g.x, 0.0, g.y));
      // Albedo: meadows / dry grass patches, speckle, rock creases, snow.
      float meadow = smoothstep(0.25, 0.75, lo + (nw.x - 0.5) * 0.5) * close;
      albedo = mix(albedo, albedo * vec3(0.87, 0.94, 0.82), grass * meadow);
      albedo = mix(albedo, albedo * vec3(1.03, 1.0, 0.93), high * (close - meadow));
      albedo *= 1.0 + (o2.x - 0.5) * 0.12 * f2 * (veg + sand);
      albedo *= 1.0 - rock * f1 * 0.16 * (1.0 - ridge);
      albedo = mix(albedo, albedo * vec3(0.94, 0.97, 1.03), snow * (1.0 - o1.x) * f1);
      // Concavity of the tiles vs the low-pass mesh: valleys darker, crests
      // a touch lighter (cheap ambient occlusion).
      shade = mix(1.0, clamp(1.0 + 0.22 * (dot(bw, h4) - vWorld.y), 0.78, 1.08), close);
    }
  }
  // Slope darkening (cheap ambient occlusion of steep ground).
  float ao = mix(0.75, 1.0, smoothstep(0.55, 0.95, n.y)) * shade;

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
  vec3 ground = albedo;
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
    // Scorched, darkened ground tinted toward the fallout colour, so the
    // relief still reads through it instead of a flat neon sheet.
    albedo = mix(albedo * vec3(0.55, 0.6, 0.5), clamp(tox, 0.0, 1.0), 0.45);
    // Only the noise peaks push the luminance past the bloom threshold:
    // scattered glowing patches rather than a glowing area.
    emissive = srgbToLinear(uFalloutColor) * (0.06 + 1.3 * nz * nz) * pulse;
  }

  vec3 dl = diffuseLight(n);
  vec3 lit = srgbToLinear(albedo) * dl * ao + emissive;

  // --- Borders: a band along every edge whose 4-neighbour has another
  // owner (plus concave corners), width = uBorderPx pixels clamped to
  // [uMinBorder, 1] tile, anti-aliased over one pixel. Where the band has
  // little contrast with the ground on either side (e.g. a light grey band
  // on snow), it gets thin dark edge lines close up (its outermost pixel
  // and one pixel inside the territory) and, zoomed out, a darker shade.
  if (owner != 0) {
    vec2 wb = clamp(uBorderPx * fw, vec2(uMinBorder), vec2(1.0));
    if (hl) wb = min(vec2(1.0), wb * 1.7);
    // Band plus the inner edge line.
    vec2 wl = min(wb + fw, vec2(1.0));
    int oW = ownerAt(tile + ivec2(-1, 0));
    int oE = ownerAt(tile + ivec2(1, 0));
    int oN = ownerAt(tile + ivec2(0, -1));
    int oS = ownerAt(tile + ivec2(0, 1));
    bvec4 edges = bvec4(oW != owner, oE != owner, oN != owner, oS != owner);
    // Concave corners: both edge neighbours match, the diagonal does not.
    bool nearW = f.x < wl.x + fw.x;
    bool nearE = 1.0 - f.x < wl.x + fw.x;
    bool nearN = f.y < wl.y + fw.y;
    bool nearS = 1.0 - f.y < wl.y + fw.y;
    ivec4 diag = ivec4(owner);
    if (nearW && nearN && !edges.x && !edges.z) diag.x = ownerAt(tile + ivec2(-1, -1));
    if (nearE && nearN && !edges.y && !edges.z) diag.y = ownerAt(tile + ivec2(1, -1));
    if (nearW && nearS && !edges.x && !edges.w) diag.z = ownerAt(tile + ivec2(-1, 1));
    if (nearE && nearS && !edges.y && !edges.w) diag.w = ownerAt(tile + ivec2(1, 1));
    bvec4 corners = notEqual(diag, ivec4(owner));

    // Band coverage, and the neighbour across the strongest edge.
    vec4 cE4 = vec4(
      edgeCoverage(f.x, wb.x, fw.x), edgeCoverage(1.0 - f.x, wb.x, fw.x),
      edgeCoverage(f.y, wb.y, fw.y), edgeCoverage(1.0 - f.y, wb.y, fw.y));
    float cov = 0.0;
    int nb = 0;
    if (edges.x && cE4.x > cov) { cov = cE4.x; nb = oW; }
    if (edges.y && cE4.y > cov) { cov = cE4.y; nb = oE; }
    if (edges.z && cE4.z > cov) { cov = cE4.z; nb = oN; }
    if (edges.w && cE4.w > cov) { cov = cE4.w; nb = oS; }
    if (corners.x && min(cE4.x, cE4.z) > cov) { cov = min(cE4.x, cE4.z); nb = diag.x; }
    if (corners.y && min(cE4.y, cE4.z) > cov) { cov = min(cE4.y, cE4.z); nb = diag.y; }
    if (corners.z && min(cE4.x, cE4.w) > cov) { cov = min(cE4.x, cE4.w); nb = diag.z; }
    if (corners.w && min(cE4.y, cE4.w) > cov) { cov = min(cE4.y, cE4.w); nb = diag.w; }
    float covIn = close > 0.0 ? bandCoverage(f, wl, fw, edges, corners) : cov;

    if (covIn > 0.0) {
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
      vec3 light = 0.5 * dl + 0.5 * diffuseLight(UP);
      vec3 borderLit = bl * light + bl * (hl ? 3.0 * uBorderGlow : uBorderGlow);
      // Contrast need (0..1) against the territory inside and the ground
      // (or the neighbour's band) outside, in perceptual brightness.
      float lb = sqrt(luma(borderLit));
      vec3 outside = nb != 0 && !alt
        ? srgbToLinear(texelFetch(uPalette, ivec2(nb, 1), 0).rgb) * light
        : srgbToLinear(ground) * dl * ao;
      float needIn = 1.0 - smoothstep(0.06, 0.22, abs(lb - sqrt(luma(lit))));
      float needOut = 1.0 - smoothstep(0.06, 0.22, abs(lb - sqrt(luma(outside))));
      // Zoomed out the band is too thin for lines: shade it instead.
      borderLit *= 1.0 - 0.35 * max(needIn, needOut) * (1.0 - close);
      float covOut = bandCoverage(f, fw, fw, edges, corners);
      lit *= 1.0 - (covIn - cov) * close * mix(0.15, 0.6, needIn);
      lit = mix(lit, borderLit * (1.0 - covOut * close * 0.7 * needOut), cov);
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
    bool land = (tb & LAND) != 0u;
    // Per-tile detail fades out once a tile is under ~1-3 pixels; the
    // close-up look (organic zones, micro detail) needs ~3-7+ pixels.
    float detail = 1.0 - smoothstep(0.35, 1.2, tpp);
    float close = 1.0 - smoothstep(0.15, 0.4, tpp);
    // The 4 tile centres around the sample point, for bilinear colour /
    // depth / normals. Close up, land samples them at a domain-warped point
    // (gradients of two noise octaves as the warp field: typically ~0.2, at
    // most ~0.6 tile), which turns zone edges organic. The tile's own land /
    // water class and owner are never warped.
    vec3 nw = vec3(0.5, 0.0, 0.0);
    vec2 q = p - 0.5;
    if (land && close > 0.0) {
      nw = valueNoiseD(p * 0.9 + vec2(13.7, 41.3));
      vec3 nw2 = valueNoiseD(mat2(0.8, 0.6, -0.6, 0.8) * p * 2.6);
      q += (nw.yz * 0.34 + nw2.yz * 0.12) * close;
    }
    ivec2 b = ivec2(floor(q));
    vec2 w = q - vec2(b);
    uvec4 t4 = uvec4(
      terrainAt(b),
      terrainAt(b + ivec2(1, 0)),
      terrainAt(b + ivec2(0, 1)),
      terrainAt(b + ivec2(1, 1)));
    if (!land) {
      col = shadeWaterTile(p, t4, w, V, tpp);
    } else {
      col = shadeLandTile(p, tile, f, tb, t4, w, nw, nMesh, fw, tpp, detail, close);
    }
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
