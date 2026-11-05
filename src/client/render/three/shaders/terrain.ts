/**
 * GLSL (ES 3.00) of the relief mesh: terrain colours, lighting, territory
 * fill (with patterns and skins, TerritoryCosmetics.ts), crisp sub-tile
 * borders, fallout, boat / nuke trails (EffectTrails.ts) and the water
 * surface wherever the (low-pass) relief rises above sea level. Used by TerrainLayer through a
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
 *
 * Lot 3 (each in a delimited block below): the territory fill, borders and
 * alt-view look strengthen as the camera zooms out (uniforms set from the
 * zoom by TerrainLayer, curves in TerrainShading.territoryLook); on the
 * flat apron TerrainLayer lays around the map, the land continues past the
 * border as its mirror image and breaks up into the sea along a noisy
 * virtual coast (no straight cut at the map edge).
 *
 * Lot 4 prototypes are compiled in only when their define is set on the
 * material (`defines`, chosen once at creation from the URL flags), so a
 * flag that is off costs nothing, not even program size:
 * - `FRONT_WAVE` (`?three_front=1`, TerrainLayer / FrontField.ts): the
 *   capture wave, a short pulse of the new owner's colour over freshly
 *   captured tiles.
 * - `NIGHT` (`?three_night=1`, NightLights.ts):
 *   moonlit ground desaturated towards blue-grey, the territory fill and
 *   borders keeping part of their day brightness, the city lightmap and
 *   the impact flashes lighting the ground and the water, fallout glowing
 *   brighter.
 */

import { EFFECT_TRAILS_GLSL } from "../EffectTrails";
import {
  FRONT_DECAY_S,
  FRONT_HOT_RGB,
  FRONT_HOT_S,
  FRONT_PULSE_MS,
  FRONT_PVP_BIT,
  FRONT_TIME_MOD,
  FRONT_TIME_UNIT_MS,
} from "../FrontField";
import { SURFACE_OVERLAY_GLSL } from "../SurfaceOverlay";
import { TERRITORY_COSMETICS_GLSL } from "../TerritoryCosmetics";
import { NIGHT_GLSL } from "./night";
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

// ---- BEGIN lot 3: territory readability at distance (TerrainLayer sets
// them from the zoom each frame, with uFillAlpha / uBorderPx / uAltFillAlpha;
// TerrainShading.territoryLook holds the curves).
uniform float uFarFlatten;     // share of the hillshade replaced by flat light on owned land
uniform float uAltGroundOwned; // alt view: brightness of the ground under owned land
uniform float uAltGroundFree;  // alt view: brightness of unowned land
// ---- END lot 3: territory readability uniforms

// ---- BEGIN lot 3: map-edge apron uniforms (TerrainLayer, TerrainShading
// edgeReachTiles / mirrorIntoMap / virtualLandReach / apronWaterMagnitude).
uniform float uEdgeReach;      // mean reach of the land past the map edge, tiles
// ---- END lot 3: map-edge apron uniforms

// ---- BEGIN lot 3: smooth relief close up (item 9; TerrainLayer's relief
// texture, TerrainShading reliefGridCoord / cubicBsplineTaps).
uniform highp sampler2D uRelief; // RGBA16F cols x rows: (dh/dx, dh/dz, height, 0) per grid vertex
uniform vec3 uReliefGrid;        // (step, cols, rows)
// ---- END lot 3: smooth relief uniforms

// ---- BEGIN surface overlay uniforms + surfaceOverlay() (SurfaceOverlay.ts:
// coordinate grid, small-player glow). Lot 2; keep this block self-contained.
${SURFACE_OVERLAY_GLSL}
// ---- END surface overlay uniforms

// ---- BEGIN territory cosmetics uniforms + territoryCosmetic()
// (TerritoryCosmetics.ts: patterns and skins). Keep this block self-contained.
${TERRITORY_COSMETICS_GLSL}
// ---- END territory cosmetics uniforms

// ---- BEGIN effect trails uniforms + effectTrail() (EffectTrails.ts: boat
// and nuke trails, effect palette). Keep this block self-contained.
${EFFECT_TRAILS_GLSL}
// ---- END effect trails uniforms

// ---- BEGIN lot 4: night and lights uniforms + helpers (NIGHT; NightLights.ts).
// Compiled in only with the define (?three_night=1).
#ifdef NIGHT
${NIGHT_GLSL}
#endif
// ---- END lot 4: night uniforms

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

// Owner smallID of a tile. Off the map: the nearest edge tile's owner, so
// no border runs along the map edge (lot 3: the land continues past it on
// the apron; the default renderer draws one there).
int ownerAt(ivec2 t) {
  return int(texelFetch(uTiles, clamp(t, ivec2(0), uMapSize - 1), 0).r & 0xfffu);
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

// ---- BEGIN lot 3: smooth relief close up (item 9). The mesh is a 2-tile
// grid (World) with per-vertex normals, and the per-tile detail was a
// bilinear blend whose slope jumps at every (domain-warped) tile edge:
// close up, snow and rock showed angular cells. Both are replaced, close up
// only (weight 'close'; the default-zoom look is unchanged), by C1 / C2
// smooth versions; the geometry (silhouettes, picking) is untouched.
//
// Cubic B-spline of the relief texture at world xz, 4 bilinear taps (two
// per axis, each pair of B-spline weights folded into one linear fetch):
// slope and height of the mesh grid, C2-smooth.
vec4 reliefSmooth(vec2 p) {
  vec2 dims = uReliefGrid.yz;
  vec2 cells = dims - 1.0;
  // Grid coordinate; the last cell is narrower when the map size is not a
  // multiple of the step (TerrainShading.reliefGridCoord).
  vec2 lastStart = (cells - 1.0) * uReliefGrid.x;
  vec2 g = mix(
    p / uReliefGrid.x,
    cells - 1.0 + (p - lastStart) / max(vec2(uMapSize) - lastStart, vec2(1e-3)),
    step(lastStart, p));
  g = clamp(g, vec2(0.0), cells);
  vec2 i = floor(g);
  vec2 f = g - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) * (1.0 / 6.0);
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) * (1.0 / 6.0);
  vec2 w3 = f3 * (1.0 / 6.0);
  vec2 g0 = w0 + w1;
  vec2 g1 = 1.0 - g0;
  vec2 t0 = (i - 0.5 + w1 / g0) / dims;
  vec2 t1 = (i + 1.5 + w3 / max(g1, vec2(1e-6))) / dims;
  // Explicit level 0 (the texture has no mips; min = mag = linear, so the
  // result is the same): no implicit derivatives inside the caller's
  // non-uniform branch, which compilers may otherwise hoist out of it.
  return g0.y * (g0.x * textureLod(uRelief, t0, 0.0) + g1.x * textureLod(uRelief, vec2(t1.x, t0.y), 0.0))
    + g1.y * (g0.x * textureLod(uRelief, vec2(t0.x, t1.y), 0.0) + g1.x * textureLod(uRelief, t1, 0.0));
}

// Quadratic B-spline over the 3 x 3 tiles around the sample point (9 fetches
// at constant offsets; 4 of them are t4's texels, in cache): tile heights
// with a continuous slope. No local array: one indexed by the sample point
// would be spilled to scratch memory on most GPUs.
// Returns (dh/dx, dh/dz, height, mean upland magnitude), the last one
// weighted over upland tiles only (-1 when there is none), for rock / snow
// lines that follow smooth contours instead of the tile staircase.
vec4 tileBspline(ivec2 b, vec2 w) {
  ivec2 hi = ivec2(step(vec2(0.5), w));
  ivec2 c = b + hi;      // centre tile: round(sample point)
  vec2 f = w + 0.5 - vec2(hi);
  vec3 wx = vec3(0.5 * (1.0 - f.x) * (1.0 - f.x), 0.75 - (f.x - 0.5) * (f.x - 0.5), 0.5 * f.x * f.x);
  vec3 wy = vec3(0.5 * (1.0 - f.y) * (1.0 - f.y), 0.75 - (f.y - 0.5) * (f.y - 0.5), 0.5 * f.y * f.y);
  vec3 dx = vec3(f.x - 1.0, 1.0 - 2.0 * f.x, f.x);
  vec3 dy = vec3(f.y - 1.0, 1.0 - 2.0 * f.y, f.y);
  vec4 r = vec4(0.0);
  float upW = 0.0;
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      uint tb = terrainAt(c + ivec2(i - 1, j - 1));
      float m = float(tb & MAG);
      bool landT = (tb & LAND) != 0u && m < 30.5;
      float th = landT ? uHeightScale * (0.03 + 0.97 * pow(m / 30.0, 1.6)) : 0.0;
      r.xyz += vec3(dx[i] * wy[j], wx[i] * dy[j], wx[i] * wy[j]) * th;
      if (landT && (tb & SHORE) == 0u && m >= 10.0) {
        r.w += wx[i] * wy[j] * m;
        upW += wx[i] * wy[j];
      }
    }
  }
  r.w = upW > 1e-4 ? r.w / upW : -1.0;
  return r;
}
// ---- END lot 3: smooth relief functions

// ---- BEGIN lot 4: living front, capture wave (FRONT_WAVE; FrontField.ts
// holds the stamps and the TypeScript twins frontAgeMs / frontPulse /
// frontHeat). Compiled in only with the define (?three_front=1).
#ifdef FRONT_WAVE
uniform highp usampler2D uFront; // R16UI W x H capture stamps (0 = never)
uniform float uFrontNow;         // now, in stamp units (fractional)
uniform vec4 uFrontLook;         // gain, heat, neutral-capture share, interior share (FrontField.frontWaveLook)
const float FRONT_PULSE_S = ${(FRONT_PULSE_MS / 1000).toFixed(3)};
const float FRONT_UNIT_S = ${(FRONT_TIME_UNIT_MS / 1000).toFixed(3)};
const float FRONT_MOD = ${FRONT_TIME_MOD.toFixed(1)};
const uint FRONT_TIME_MASK = ${FRONT_TIME_MOD}u;
const uint FRONT_PVP = ${FRONT_PVP_BIT}u;
const float FRONT_DECAY_S = ${FRONT_DECAY_S.toFixed(3)};
const float FRONT_HOT_S = ${FRONT_HOT_S.toFixed(3)};
// White-hot colour of the freshest captures (linear).
const vec3 FRONT_HOT = vec3(${FRONT_HOT_RGB.map((v) => v.toFixed(2)).join(", ")});

// Age (s) of a capture stamp, capped at the pulse length (also for a tile
// never captured, or captured long ago: the stamps wrap, FrontField sweeps).
float frontAgeS(uint s) {
  uint t = s & FRONT_TIME_MASK;
  if (t == 0u) return FRONT_PULSE_S;
  return min(mod(uFrontNow - float(t), FRONT_MOD) * FRONT_UNIT_S, FRONT_PULSE_S);
}

// The wave at life fraction u: a fast rise, a sharp decay (bright on the
// last ~3 ticks' captures: the leading edge) and a faint tail; no ripple.
float frontPulse(float u) {
  if (u < 0.0 || u >= 1.0) return 0.0;
  float a = min(1.0, u / 0.06);
  float age = u * FRONT_PULSE_S;
  return a * a * (3.0 - 2.0 * a) * (0.75 * exp(-age / FRONT_DECAY_S) + 0.25 * (1.0 - u) * (1.0 - u));
}

// The capture wave over this tile while its capture is younger than the
// pulse: light ADDED to the lit, relief-shaded ground (an emission, so the
// relief and the fill still read through it), white-hot for the freshest
// captures, then the new owner's colour with its chroma boosted (a grey or
// blue owner stays tinted, never washes out to white). Strongest on the
// tiles still on a border (edge = 1: the moving front line), weaker inside
// (uFrontLook.w). The age is blended over the 4 tile centres around the
// sample point, so successive ticks' bands blend smoothly; the pulse never
// leaves the captured tile.
vec3 frontWave(vec3 lit, int owner, ivec2 tile, ivec2 b, vec2 w, bool alt, float edge) {
  uint s = texelFetch(uFront, tile, 0).r;
  if (frontAgeS(s) >= FRONT_PULSE_S) return lit;
  ivec2 hiT = uMapSize - 1;
  vec4 a4 = vec4(
    frontAgeS(texelFetch(uFront, clamp(b, ivec2(0), hiT), 0).r),
    frontAgeS(texelFetch(uFront, clamp(b + ivec2(1, 0), ivec2(0), hiT), 0).r),
    frontAgeS(texelFetch(uFront, clamp(b + ivec2(0, 1), ivec2(0), hiT), 0).r),
    frontAgeS(texelFetch(uFront, clamp(b + ivec2(1, 1), ivec2(0), hiT), 0).r));
  float age = mix(mix(a4.x, a4.y, w.x), mix(a4.z, a4.w, w.x), w.y);
  float k = frontPulse(age / FRONT_PULSE_S) * ((s & FRONT_PVP) != 0u ? 1.0 : uFrontLook.z)
    * mix(uFrontLook.w, 1.0, edge);
  if (k <= 0.0) return lit;
  vec3 fill = alt ? affiliation(owner) : texelFetch(uPalette, ivec2(owner, 0), 0).rgb;
  vec3 c = fill / max(max(fill.r, fill.g), max(fill.b, 0.05));
  c = clamp(mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.6), 0.0, 1.0);
  vec3 col = mix(srgbToLinear(c), FRONT_HOT, exp(-age / FRONT_HOT_S) * uFrontLook.y);
#ifdef NIGHT
  // On the moonlit map an emission stands out more: dimmer.
  k *= 0.6;
#endif
  return lit + col * (k * uFrontLook.x);
}
#endif
// ---- END lot 4: living front functions

// p: world xz; tile / f: the tile under p and the position in it; t4 / b /
// w: the 4 tile centres around the (close up: domain-warped) sample point,
// the first one and its bilinear weights; nw: the warp noise; hRef: the
// surface height the concavity shade compares the tiles with (the smooth
// relief close up, lot 3); dp: (dFdx(p), dFdy(p)); close:
// 0 at strategy zoom .. 1 once a tile spans ~7+ pixels; apron: 0 on the map,
// > 0 on the map-edge apron (lot 3): the fill fades by it, no borders.
vec3 shadeLandTile(
  vec2 p, ivec2 tile, vec2 f, uint tb, uvec4 t4, ivec2 b, vec2 w, vec3 nw,
  vec3 nMesh, float hRef, vec2 fw, vec4 dp, float tpp, float detail,
  float close, float apron
) {
  vec3 albedo;
  vec3 n = nMesh;
  float shade = 1.0;
  if (tileClass(tb) == 2) {
    // The noise only where its weight is not 0 (detail: not at full map).
    float v = 0.8;
    if (detail > 0.0) v = 0.8 + 0.35 * detail * valueNoise(p * 0.9);
    albedo = uColVoid * v;
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
    // Lot 3 (item 9): smooth tile heights / slope / upland elevation close up.
    vec4 bs = close > 0.0 ? tileBspline(b, w) : vec4(0.0, 0.0, 0.0, -1.0);
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
      // Lot 3 (item 9): the rock / snow lines follow the smooth upland
      // elevation (no angular tile-edge contours).
      if (bs.w >= 0.0) elev = bs.w;
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
    // Lot 3 (item 9): close up, the B-spline's continuous slope instead
    // (fully from ~5 px per tile: a residue of the bilinear slope draws a
    // tile checker on flat, uniform ground such as fallout ash).
    // Perf triage (same pixels): each part only where its weight is not 0,
    // the whole normal from detail > 0 (not at full map on a 1x screen),
    // the bilinear slope while smoothW < 1. hTile is read close up only.
    float smoothW = min(1.0, 1.25 * close);
    float hTile = 0.0;
    if (detail > 0.0) {
      float gx = 0.0;
      float gz = 0.0;
      if (smoothW < 1.0) {
        vec4 h4 = tileHeights(t4);
        gx = mix(h4.y - h4.x, h4.w - h4.z, w.y);
        gz = mix(h4.z - h4.x, h4.w - h4.y, w.x);
        hTile = dot(bw, h4);
      }
      gx = mix(gx, bs.x, smoothW) * DETAIL_RELIEF;
      gz = mix(gz, bs.y, smoothW) * DETAIL_RELIEF;
      hTile = mix(hTile, bs.z, smoothW);
      n = normalize(mix(nMesh, normalize(vec3(-gx, 1.0, -gz)), 0.6 * detail));
    } else {
      n = normalize(nMesh);
    }

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
    // Only where their weight is not 0 (detail > 0; close > 0 implies it).
    vec2 s1 = vec2(1.7, 1.7 + 2.0 * close);
    vec3 o1 = vec3(0.5, 0.0, 0.0);
    vec3 o2 = o1;
    vec2 g1 = vec2(0.0);
    vec2 g2 = vec2(0.0);
    if (detail > 0.0) {
      float ang = 0.6 + lo * 4.0 * close;
      vec2 u = vec2(cos(ang), sin(ang));
      vec2 v = vec2(-u.y, u.x);
      o1 = valueNoiseD(vec2(dot(p, u), dot(p, v)) * s1 + vec2(3.1, 7.7));
      g1 = u * (s1.x * o1.y) + v * (s1.y * o1.z); // d o1 / dp
      o2 = valueNoiseD(mat2(0.6, -0.8, 0.8, 0.6) * p * 4.6);
      g2 = mat2(0.6, 0.8, -0.8, 0.6) * o2.yz * 4.6;
      albedo *= 1.0 + (0.6 * o1.x + 0.4 * o2.x - 0.5) * 0.1 * detail * (1.0 - close);
    }
    if (close > 0.0) {
      float f1 = octaveFade(s1.y, tpp) * close;
      float f2 = octaveFade(4.6, tpp) * close;
      // Ridged fold for rock: sharp crests where |2 o1 - 1| = 0.
      float ridge = 1.0 - abs(2.0 * o1.x - 1.0);
      vec2 dRidge = (o1.x > 0.5 ? -2.0 : 2.0) * g1;
      float veg = grass + high;
      // Slopes (dh/dx, dh/dz) of the bump height field.
      // Lot 3 (item 9): snow gets wind-combed ripples (o1 stretched across
      // the slowly turning direction) and grain, so the smooth relief
      // close up does not read as plastic.
      vec2 g = g1 * (f1 * (0.035 * veg + 0.05 * snow + 0.015 * sand))
        + dRidge * (f1 * 0.04 * rock)
        + g2 * (f2 * (0.014 * veg + 0.02 * rock + 0.012 * snow + 0.008 * sand));
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
      shade = mix(1.0, clamp(1.0 + 0.22 * (hTile - hRef), 0.78, 1.08), close);
    }
  }
  // Slope darkening (cheap ambient occlusion of steep ground).
  float ao = mix(0.75, 1.0, smoothstep(0.55, 0.95, n.y)) * shade;
  // The ground's own colour (lot 3: the fallout burns it).
  vec3 groundCol = albedo;

  // --- Territory fill (mixed in sRGB like the default renderer's blend).
  uint st = texelFetch(uTiles, tile, 0).r;
  int owner = int(st & 0xfffu);
  bool fallout = (st & 0x2000u) != 0u;
  bool alt = uAltView > 0.5;
  bool hl = owner != 0 && owner == uHighlightOwner;
  if (alt) {
    // ---- BEGIN lot 3: alt-view ground. Desaturated and dimmed, owned land
    // less than unowned land, so neutral (grey) territory still reads.
    float l = dot(albedo, vec3(0.299, 0.587, 0.114));
    albedo = mix(vec3(l), albedo, 0.35)
      * (owner != 0 ? uAltGroundOwned : uAltGroundFree);
    // ---- END lot 3: alt-view ground
  }
#ifdef NIGHT
  // Lot 4, night: moonlight washes the ground's colours out (blue-grey).
  albedo = mix(albedo, vec3(luma(albedo)), uNightLook.z);
  // The territory fill's share kept at day brightness (set below).
  vec3 nightFill = vec3(0.0);
#endif
  vec3 ground = albedo;
  // Not where it would be thrown away: the fallout below replaces the
  // colour, and past the apron's fade its weight is 0 (perf triage).
  if (owner != 0 && !fallout && apron < 1.0) {
    vec3 fill;
    float a;
    if (alt) {
      fill = affiliation(owner);
      a = uAltFillAlpha;
    } else {
      fill = texelFetch(uPalette, ivec2(owner, 0), 0).rgb;
      // ---- BEGIN territory cosmetics (pattern / skin, TerritoryCosmetics.ts):
      // replaces the fill colour before saturation / highlight, as the
      // default renderer; never on fallout. A uniform switch: free while off.
      if (uCosmeticsOn > 0.5 && !fallout) {
        fill = territoryCosmetic(owner, tile, fill, dp.xy, dp.zw);
      }
      // ---- END territory cosmetics
      float l = dot(fill, vec3(0.299, 0.587, 0.114));
      fill = mix(vec3(l), fill, uFillSaturation);
      if (hl) fill = clamp((fill - 0.5) * (1.0 + uHighlightFill) + 0.5, 0.0, 1.0);
      a = uFillAlpha;
    }
    // Lot 3: the fill fades out across the map-edge apron's virtual land.
    albedo = mix(albedo, fill, a * (1.0 - apron));
#ifdef NIGHT
    // A little desaturated: the night is the lamps' colour, not the fill's.
    nightFill = srgbToLinear(mix(vec3(luma(fill)), fill, 0.75))
      * (a * (1.0 - apron) * uNightLook.x) * NIGHT_DAY_FLAT;
#endif
  }

  // ---- BEGIN lot 3: fallout (item 5; TerrainShading.falloutLook /
  // falloutHotspot / emberRadiusTiles mirror the curves). Burnt ground that
  // keeps the relief and the lighting: the fallout replaces the colour (as
  // in the default renderer, over any territory fill) but not the normals,
  // the slope darkening or the hillshade. One hue family at every zoom:
  // warm ash grey following the ground's own brightness (snow, rock,
  // plains), darker than any territory.
  // - Zoomed out: the ash, darker, with a touch of sickly tint, mottled at
  //   a ~10-tile scale, and a sickly yellow-green rim (FALLOUT_RIM_PX wide,
  //   on the zone's own tiles), so the zone reads at a glance as a hazard,
  //   not as one more player or a forest.
  // - Close up: soft charred patches, fine ash dust and wind-blown ash
  //   streaks (rotated world-space noise: no tile checker), a faint
  //   sickly stain, the rim faint; a few hotspots (at most one per
  //   FALLOUT_HOT_CELL-tile cell of a rotated lattice, in FALLOUT_HOT_SHARE
  //   of the cells, only well inside the zone: FALLOUT_HOT_CLEAR tiles from
  //   its edge), a dim amber core in a sickly halo, breathing; a few
  //   flickering embers (a disc inside its tile).
  // Everything hangs on this tile's fallout bit: the zone stays exact to
  // the tile (no glow or colour outside it).
  vec3 emissive = vec3(0.0);
  if (fallout) {
    float near = 1.0 - smoothstep(0.18, 0.5, tpp);
    float gL = luma(groundCol);
    vec3 sick = mix(uFalloutColor, vec3(0.75, 0.72, 0.2), 0.6);
    vec3 ash = vec3(0.4, 0.375, 0.345) * (0.55 + 0.7 * gL);
    // Each look is computed only where its weight is not 0 (perf triage,
    // same pixels): the far one while near < 1, the near one while near > 0
    // (it was mixed away at full map and at the default zoom).
    // Far: the ash, darker, a touch of the sickly tint, mottled.
    vec3 farA = vec3(0.0);
    if (near < 1.0) {
      float mot = 0.5 + (valueNoise(mat2(0.8, -0.6, 0.6, 0.8) * p * 0.11 + vec2(9.0, 4.0)) - 0.5)
        * octaveFade(0.11, tpp);
      farA = mix(ash * 0.78, sick * 0.6, 0.1 + 0.12 * mot) * (0.85 + 0.3 * mot);
    }
    // Near: soft charred patches and fine ash dust over the ash.
    vec3 burnt = vec3(0.0);
    if (near > 0.0) {
      burnt = ash;
      float fc = octaveFade(0.83, tpp);
      float c1 = valueNoise(mat2(0.8, 0.6, -0.6, 0.8) * p * 0.31 + vec2(17.0, 3.0));
      float c2 = 0.5 + (valueNoise(mat2(0.6, -0.8, 0.8, 0.6) * p * 0.83 + vec2(5.0, 11.0)) - 0.5) * fc;
      float charred = smoothstep(0.45, 0.8, 0.65 * c1 + 0.35 * c2);
      burnt *= (1.0 - 0.16 * charred)
        * (1.0 + 0.12 * (valueNoise(p * 2.3 + vec2(1.7, 6.1)) - 0.5) * octaveFade(2.3, tpp));
      // Ash streaks, stretched across the wind (FALLOUT_WIND, FxLayer's smoke).
      vec2 aq = vec2(dot(p, vec2(0.8, -0.6)), dot(p, vec2(0.6, 0.8)));
      float ash2 = smoothstep(0.55, 0.85, valueNoise(aq * vec2(0.4, 0.62) + vec2(3.0, 8.0)) * (0.7 + 0.3 * c2));
      burnt = mix(burnt, vec3(0.6, 0.58, 0.55) * (0.8 + 0.25 * gL),
        0.3 * ash2 * (1.0 - charred) * octaveFade(1.2, tpp));
      burnt = mix(burnt, burnt * vec3(1.0, 1.04, 0.85), 0.2);
    }
    // Hotspots: one per 16-tile cell at most (10% of the cells), radius
    // 1.6-3.2 tiles, only well inside the zone (4 taps 6 tiles around the
    // centre, fetched only inside the disc); faded zoomed out (they would
    // shimmer) and on steep flanks (stretched there under tilt). Nothing is
    // hashed or fetched while that fade is 0 (from 0.5 tile per px).
    float hotVis = (1.0 - smoothstep(0.25, 0.5, tpp)) * smoothstep(0.55, 0.8, nMesh.y);
    float hh = 0.0;
    float hot = 0.0;
    float halo = 0.0;
    if (hotVis > 0.0) {
      vec2 hq = mat2(0.8, 0.6, -0.6, 0.8) * p * (1.0 / 16.0);
      ivec2 hc = ivec2(floor(hq));
      hh = hash12(hc + ivec2(311, 97));
      if (hh < 0.1) {
        float r = 0.1 + 0.1 * fract(hh * 37.0);
        vec2 c = r + (1.0 - 2.0 * r) * vec2(hash12(hc + ivec2(5, 71)), fract(hh * 113.0));
        float d2 = dot(hq - vec2(hc) - c, hq - vec2(hc) - c) / (r * r);
        float k = max(0.0, 1.0 - d2);
        if (k > 0.0) {
          ivec2 ct = ivec2(floor(mat2(0.8, -0.6, 0.6, 0.8) * ((vec2(hc) + c) * 16.0)));
          ivec2 hiT = uMapSize - 1;
          uint m = texelFetch(uTiles, clamp(ct + ivec2(6, 0), ivec2(0), hiT), 0).r
            & texelFetch(uTiles, clamp(ct - ivec2(6, 0), ivec2(0), hiT), 0).r
            & texelFetch(uTiles, clamp(ct + ivec2(0, 6), ivec2(0), hiT), 0).r
            & texelFetch(uTiles, clamp(ct - ivec2(0, 6), ivec2(0), hiT), 0).r;
          float vis = (m & 0x2000u) != 0u ? hotVis : 0.0;
          hot = k * k * k * vis;
          halo = k * vis;
        }
      }
    }
    burnt = mix(burnt, sick * 0.5, 0.3 * halo) * (1.0 - 0.25 * hot);
    albedo = near >= 1.0 ? burnt : mix(farA, burnt, near);
    // Zone rim: the fallout tiles within R tiles (~1.6 px, 1-4 tiles) of a
    // clean tile (4 taps), sickly yellow-green, strong zoomed out, faint
    // close up.
    int R = int(clamp(floor(1.6 * tpp + 0.5), 1.0, 4.0));
    ivec2 hiR = uMapSize - 1;
    uint rm = texelFetch(uTiles, clamp(tile + ivec2(R, 0), ivec2(0), hiR), 0).r
      & texelFetch(uTiles, clamp(tile - ivec2(R, 0), ivec2(0), hiR), 0).r
      & texelFetch(uTiles, clamp(tile + ivec2(0, R), ivec2(0), hiR), 0).r
      & texelFetch(uTiles, clamp(tile - ivec2(0, R), ivec2(0), hiR), 0).r;
    float rim = (rm & 0x2000u) == 0u ? mix(0.85, 0.3, near) : 0.0;
    albedo = mix(albedo, sick, rim);
    float breath = 0.7 + 0.3 * sin(uTime * 0.8 + hh * 40.0);
    emissive = srgbToLinear(sick) * (mix(0.025, 0.0, near) + 0.1 * rim + 0.12 * halo * halo * breath)
      + vec3(1.0, 0.42, 0.1) * (0.9 * hot * hot * breath);
    // Embers: on 2% of the tiles (more in hotspots), close up only, a disc
    // of at least ~1.3 px whose centre lies EMBER_MARGIN inside the tile,
    // flickering.
    float emberW = 1.0 - smoothstep(0.12, 0.25, tpp);
    if (emberW > 0.0) {
      float e0 = hash12(tile + ivec2(9173, 3511));
      if (e0 < 0.02 + 0.2 * hot) {
        vec2 c = 0.25 + 0.5 * vec2(hash12(tile + ivec2(71, 4093)), hash12(tile + ivec2(2287, 113)));
        float r = clamp(1.3 * tpp, 0.06, 0.25);
        float disc = 1.0 - smoothstep(0.3 * r, r, length(f - c));
        float flick = sin(uTime * (1.1 + 1.8 * fract(e0 * 57.0)) + e0 * 211.0);
        emissive += vec3(1.0, 0.32, 0.06) * (3.6 * disc * (0.25 + 0.75 * flick * flick) * emberW);
      }
    }
  }
  // ---- END lot 3: fallout
#ifdef NIGHT
  // Lot 4, night: the zone keeps a faint glow of its own colour (the
  // default renderer's fallout light, much dimmer), so it reads at night.
  if (fallout) {
    emissive += srgbToLinear(uFalloutColor) * (0.005 * uNightLook2.z);
  }
#endif

  vec3 dl = diffuseLight(n);
  vec3 shading = dl * ao;
  // ---- BEGIN lot 3: zoomed out, owned land is lit partly flat, so a
  // territory reads as one colour while the relief still shows (0 close up).
  if (owner != 0 && uFarFlatten > 0.0) {
    shading = mix(shading, diffuseLight(UP), uFarFlatten);
  }
  // ---- END lot 3: far flatten
  vec3 lit = srgbToLinear(albedo) * shading + emissive;
#ifdef NIGHT
  // Lot 4, night: the city lights and the impact flashes on the ground (at
  // the real world point: on the apron p is mirrored), the kept share of
  // the fill, the fallout glowing a little brighter and keeping its relief.
  vec3 albedoLin = srgbToLinear(albedo);
  vec3 nightL = nightCityLight(vWorld.xz);
  // Street-light grain in the bright cores (one value noise, 3 cells per
  // tile), from ~2.5 to ~5 px per tile (finer it would shimmer, closer it
  // would read as blotches).
  float grain = smoothstep(0.2, 0.8, luma(nightL)) * (1.0 - smoothstep(0.3, 0.45, tpp))
    * smoothstep(0.15, 0.2, tpp);
  if (grain > 0.0) {
    nightL *= 1.0 + grain * (valueNoise(vWorld.xz * 3.3 + vec2(41.0, 7.0)) - 0.5) * 1.1;
  }
  // Lamp light keeps its own warm colour (sodium), modulated by how light
  // the ground is, not tinted by the territory.
  // A soft knee keeps the biggest cities' cores from clipping to white.
  vec3 lamp = nightL * (0.24 + 0.56 * luma(albedoLin));
  lamp /= 1.0 + 0.6 * luma(lamp);
  lit += lamp + nightFill + emissive * (uNightLook2.x - 1.0);
  // Flashes: white-hot / orange light, the ground's colour mostly whitened
  // under it (a nuke lights the land white, not in the owner's colour).
  lit += nightFlashLight(vWorld, n) * mix(albedoLin, vec3(0.45), 0.6);
  // Fallout: the burnt ash keeps its relief under the moon (the moonlit
  // shading lifted, so its hillshade still reads), not a flat black zone.
  if (fallout) lit += albedoLin * shading * (2.4 * uNightLook2.z);
#endif

  // --- Borders: a band along every edge whose 4-neighbour has another
  // owner (plus concave corners), width = uBorderPx pixels clamped to
  // [uMinBorder, 1] tile, anti-aliased over one pixel. Where the band has
  // little contrast with the ground on either side (e.g. a light grey band
  // on snow), it gets thin dark edge lines close up (its outermost pixel
  // and one pixel inside the territory) and, zoomed out, a darker shade.
#ifdef FRONT_WAVE
  // Lot 4: whether this tile is on a border (the capture wave's front line).
  float frontEdge = 0.0;
#endif
  if (owner != 0 && apron <= 0.0) {
    vec2 wb = clamp(uBorderPx * fw, vec2(uMinBorder), vec2(1.0));
    if (hl) wb = min(vec2(1.0), wb * 1.7);
    // Band plus the inner edge line.
    vec2 wl = min(wb + fw, vec2(1.0));
    int oW = ownerAt(tile + ivec2(-1, 0));
    int oE = ownerAt(tile + ivec2(1, 0));
    int oN = ownerAt(tile + ivec2(0, -1));
    int oS = ownerAt(tile + ivec2(0, 1));
    bvec4 edges = bvec4(oW != owner, oE != owner, oN != owner, oS != owner);
#ifdef FRONT_WAVE
    frontEdge = any(edges) ? 1.0 : 0.0;
#endif
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
        // Lot 3: lifted towards white so the band reads on the dimmed
        // ground (the neutral grey above all).
        bc = min(affiliation(owner) * 1.15 + 0.12, vec3(1.0));
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
#ifdef NIGHT
      // Lot 4, night: borders keep their share of the day brightness, lit
      // by the city lights and flashes too.
      borderLit += bl * (uNightLook.y * NIGHT_DAY_FLAT) + nightL * (0.3 + 0.7 * luma(bl));
#endif
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
  // ---- BEGIN lot 4: living front, capture wave (over fill and border).
#ifdef FRONT_WAVE
  if (owner != 0 && !fallout && apron <= 0.0) {
    lit = frontWave(lit, owner, tile, b, w, alt, frontEdge);
  }
#endif
  // ---- END lot 4: capture wave
  return lit;
}

void main() {
  vec2 p = vWorld.xz;
  // Derivatives in uniform control flow: tiles per device pixel along x / z
  // (fw = fwidth(p)); dp also sets the skin's mip level.
  vec4 dp = vec4(dFdx(p), dFdy(p));
  vec2 fw = max(abs(dp.xy) + abs(dp.zw), vec2(1e-5));
  float tpp = max(fw.x, fw.y);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 nMesh = normalize(vNormal);
  vec3 col;

  // ---- BEGIN lot 3: map-edge apron lookups. Off the map (TerrainLayer's
  // flat ring), tiles are looked up at pt, p mirrored at the map border,
  // so the land and coasts continue past the edge (no stretched edge
  // row); the point is warped first, more with the distance past the
  // edge (TerrainShading.apronWarp), so farther out the land is not a
  // recognisable mirror image. On the map pt = p.
  vec2 offMap = max(max(-p, p - vec2(uMapSize)), vec2(0.0));
  float dOut = max(offMap.x, offMap.y);
  vec2 pt = p;
  if (dOut > 0.0) {
    vec2 wn = vec2(
      valueNoise(p * 0.025 + vec2(1.3, 7.1)),
      valueNoise(p * 0.025 + vec2(8.2, 2.6)));
    vec2 pw = p + (wn - 0.5) * (0.9 * min(dOut, 20.0));
    pt = vec2(uMapSize) - abs(vec2(uMapSize) - abs(pw));
  }
  // ---- END lot 3: map-edge apron lookups
  ivec2 tile = clamp(ivec2(floor(pt)), ivec2(0), uMapSize - 1);
  vec2 f = clamp(pt - vec2(tile), 0.0, 1.0);
  uint tb = terrainAt(tile);
  bool land = (tb & LAND) != 0u;
  // Per-tile detail fades out once a tile is under ~1-3 pixels; the
  // close-up look (organic zones, micro detail) needs ~3-7+ pixels.
  float detail = 1.0 - smoothstep(0.35, 1.2, tpp);
  float close = 1.0 - smoothstep(0.15, 0.4, tpp);
  // ---- BEGIN lot 3: smooth relief close up (item 9): shading normal and
  // reference height from the relief's B-spline instead of the mesh's
  // per-vertex normals (creased along its triangles).
  float hRef = vWorld.y;
  if (land && close > 0.0 && dOut <= 0.0) {
    vec4 rs = reliefSmooth(p);
    float smoothW = min(1.0, 1.25 * close);
    nMesh = normalize(mix(nMesh, normalize(vec3(-rs.x, 1.0, -rs.y)), smoothW));
    hRef = mix(hRef, rs.z, smoothW);
  }
  // ---- END lot 3: smooth relief
  // Lot 3 (item 6): the relief's shading fades to flat over the last
  // EDGE_FLAT_TILES inside the map edge, so it meets the flat-lit apron
  // without a seam under tilt.
  if (dOut <= 0.0) {
    vec2 inMap = min(p, vec2(uMapSize) - p);
    float edgeFlat = 1.0 - smoothstep(0.0, 3.0, min(inMap.x, inMap.y));
    if (edgeFlat > 0.0) nMesh = normalize(mix(nMesh, UP, edgeFlat));
  }
  // The 4 tile centres around the sample point, for bilinear colour /
  // depth / normals. Close up, land samples them at a domain-warped point
  // (gradients of two noise octaves as the warp field: typically ~0.2, at
  // most ~0.6 tile), which turns zone edges organic. The tile's own land /
  // water class and owner are never warped.
  vec3 nw = vec3(0.5, 0.0, 0.0);
  vec2 q = pt - 0.5;
  if (land && close > 0.0) {
    nw = valueNoiseD(pt * 0.9 + vec2(13.7, 41.3));
    vec3 nw2 = valueNoiseD(mat2(0.8, 0.6, -0.6, 0.8) * pt * 2.6);
    q += (nw.yz * 0.34 + nw2.yz * 0.12) * close;
  }
  ivec2 b = ivec2(floor(q));
  vec2 w = q - vec2(b);
  uvec4 t4 = uvec4(
    terrainAt(b),
    terrainAt(b + ivec2(1, 0)),
    terrainAt(b + ivec2(0, 1)),
    terrainAt(b + ivec2(1, 1)));
  // ---- BEGIN lot 3: map-edge apron. On TerrainLayer's flat ring around
  // the map (at COAST_LIFT), the mirrored land continues past the border
  // up to a noisy virtual coastline (reach = uEdgeReach x 0.15..2 by two
  // low-frequency octaves, plus a ragged one; TerrainShading
  // virtualLandReach): along the edge some land dies at once, some runs
  // far. The territory fill stops at the edge (gone within 1.5 tiles /
  // 6 px, apronFillFade: the playfield's limit stays readable, owners do
  // not look bigger), and the land fades like a page margin, desaturated,
  // dimmed and blended into the sea with the distance. The water is the mirrored water, or
  // past the virtual coast its distance from it (a shelf like a real
  // coast's, never a wide pale band), deepening to open sea
  // (apronWaterMagnitude), shaded as WaterLayer's off-map plane, which
  // takes over as open sea at the ring's rim (seamless).
  // The map and the apron share ONE call site of shadeLandTile and one of
  // shadeWater, with their inputs selected per path (perf triage, same
  // pixels): a second inlined copy of each doubled the program, which
  // SwiftShader pays on every fragment and which weighs on the GPU's
  // register allocation for all of them (README, "Performance notes").
  bool onApron = dOut > 0.0;
  float reach = 0.0;
  if (onApron) {
    float nz = 0.6 * valueNoise(p * 0.03 + vec2(3.1, 9.7))
      + 0.4 * valueNoise(p * 0.09 + vec2(7.3, 1.9));
    reach = max(0.0, uEdgeReach * (0.15 + 1.85 * smoothstep(0.25, 0.75, nz)
      + 0.3 * (valueNoise(p * 0.37 + vec2(5.2, 4.4)) - 0.5)));
  }
  // Land cover: 1 on the map's land tiles; on the apron the virtual land,
  // anti-aliased over a pixel around the virtual coast.
  float cover = !land ? 0.0
    : (onApron ? clamp((reach - dOut) / max(tpp, 1e-3) + 0.5, 0.0, 1.0) : 1.0);
  vec3 landCol = vec3(0.0);
  if (cover > 0.0) {
    // On the apron: lit flat, the fill faded out (apronFillFade); there
    // pt is the mirrored point and hRef = vWorld.y. On the map pt = p.
    float fillFade = smoothstep(0.0, max(1.5, 6.0 * tpp), dOut);
    landCol = shadeLandTile(pt, tile, f, tb, t4, b, w, nw, onApron ? UP : nMesh, hRef, fw, dp, tpp,
      detail, close, onApron ? max(fillFade, 1e-3) : 0.0);
  }
  // Water: the map's water tiles (the seabed under the water plane, or
  // the surface itself where the relief rises above sea level), and the
  // whole apron (under its virtual land too: the land blends into it).
  vec3 waterCol = vec3(0.0);
  if (onApron || !land) {
    float magM = mix(
      mix(shoreValue(t4.x), shoreValue(t4.y), w.x),
      mix(shoreValue(t4.z), shoreValue(t4.w), w.x),
      w.y);
    float mag = magM;
    if (onApron) {
      float magA = min(max(max(magM, 0.0), dOut - reach), 16.0);
      mag = mix(magA, 16.0, smoothstep(reach + 0.5 * uEdgeReach, reach + uEdgeReach + 8.0, dOut));
    }
    // Flat-lit so it matches WaterLayer's own seabed composite exactly;
    // the shallow look narrows when zoomed out (lot 3, shoreViewScale).
    vec3 seabed = seabedAlbedo(mag * shoreViewScale(tpp)) * diffuseLight(UP);
    waterCol = seabed;
    if (onApron || vWorld.y > 0.0) {
      vec4 wtr = shadeWater(p, mag, V, tpp, uTime);
      waterCol = mix(seabed, wtr.rgb, wtr.a);
    }
#ifdef NIGHT
    // Lot 4, night: city lights on the harbours, flashes on the sea.
    waterCol = nightWater(waterCol, vWorld);
#endif
    waterCol *= mix(1.0, 0.6, uAltView);
  }
  if (onApron) {
    col = waterCol;
    if (cover > 0.0) {
      float margin = smoothstep(0.0, max(reach, 1.0), dOut);
      vec3 lc = mix(landCol, vec3(luma(landCol)), 0.5 * margin) * ((1.0 - 0.2 * margin) * mix(1.0, 0.7, uAltView));
      col = mix(col, mix(lc, col, 0.45 * margin + 0.3 * smoothstep(0.5 * reach, reach, dOut)), cover);
    }
  } else {
    col = land ? landCol : waterCol;
  }
  // ---- END lot 3: map-edge apron
  // ---- BEGIN effect trails composite (boat / nuke trails, EffectTrails.ts):
  // the trail colour lit flat, over the shaded ground at trailAlpha, where
  // this mesh is the visible surface (land, and water tiles where the
  // relief rises above sea level; WaterLayer paints the same elsewhere).
  // Under the surface overlays (the sea plane draws those over the water).
  // A uniform branch: free while no tile holds a trail.
  if (uTrailsOn > 0.5 && dOut <= 0.0 && (land || vWorld.y > 0.0)) {
    vec4 tr = effectTrail(tile, p, uAltView > 0.5);
    // Lot 3 (item 5): over fallout a trail is faint and greyed, so the
    // bombs' ground tracks do not read as green streaks on the ash.
    if (tr.a > 0.0 && (texelFetch(uTiles, tile, 0).r & 0x2000u) != 0u) {
      tr.rgb = mix(tr.rgb, vec3(dot(tr.rgb, vec3(0.299, 0.587, 0.114))), 0.75);
      tr.a *= 0.35;
    }
    col = mix(col, srgbToLinear(tr.rgb) * diffuseLight(UP), tr.a);
  }
  // ---- END effect trails composite
  // ---- BEGIN surface overlay composite (grid / small-player glow, see
  // SurfaceOverlay.ts). Unlit, over the shaded ground, before fog. Only
  // where this mesh is the visible surface: land, and water tiles where the
  // relief rises above sea level (elsewhere the sea-level overlay plane
  // draws it above the water). A uniform branch: free while off.
  if (uOverlayOn > 0.5 && dOut <= 0.0 && (land || vWorld.y > 0.0)) {
    vec4 ov = surfaceOverlay(p, fw);
    col = col * (1.0 - ov.a) + ov.rgb;
  }
  // ---- END surface overlay composite

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
