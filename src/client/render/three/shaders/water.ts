/**
 * GLSL (ES 3.00) of the water plane and the sky dome, plus the chunks the
 * terrain shader shares with them (environment lighting, noise, water
 * shading). Materials using these are `ShaderMaterial`s with
 * `glslVersion: GLSL3`, so every fragment shader declares its own output
 * (`FRAG_OUTPUT`) and three's tonemapping / colorspace / fog chunks keep
 * writing `gl_FragColor`.
 *
 * Units: world X/Z = tiles, Y up, sea level 0. Colours are linear unless a
 * uniform says sRGB.
 */

import { EFFECT_TRAILS_GLSL } from "../EffectTrails";

/** Fragment output for GLSL3 ShaderMaterials (three's chunks use gl_FragColor). */
export const FRAG_OUTPUT = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
`;

/**
 * Environment uniforms (owned by SceneEnvironment, shared by reference) and
 * the lighting helpers built on them.
 */
export const ENV_COMMON = /* glsl */ `
uniform vec3 uSunDir;        // unit vector towards the sun
uniform vec3 uSunIrradiance; // sun colour × intensity
uniform vec3 uHemiSky;       // hemisphere sky colour × intensity
uniform vec3 uHemiGround;    // hemisphere ground colour × intensity
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;    // also the fog colour
uniform vec3 uSunTint;       // sun colour without intensity (sky glow)

const float INV_PI = 0.3183098861837907;
const vec3 UP = vec3(0.0, 1.0, 0.0);

// Diffuse light on a surface with normal n, in MeshStandardMaterial's units
// (sun * cos + hemisphere, times the Lambert BRDF 1/pi), so custom-shaded
// terrain matches the lit meshes of the other layers.
vec3 diffuseLight(vec3 n) {
  vec3 hemi = mix(uHemiGround, uHemiSky, 0.5 * n.y + 0.5);
  return (uSunIrradiance * max(dot(n, uSunDir), 0.0) + hemi) * INV_PI;
}

// Sky radiance along a unit direction: horizon haze -> zenith blue, with a
// soft glow and (sunDisc = 1) a small disc around the sun. Callers pass a
// constant, so the branch folds away: with 0 the disc's pow is not
// evaluated at all (SwiftShader would, as 0 * pow(s, 1200)).
vec3 skyRadiance(vec3 dir, float sunDisc) {
  float e = clamp(dir.y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(e, 0.55));
  float s = max(dot(dir, uSunDir), 0.0);
  float glow = 0.25 * pow(s, 24.0);
  if (sunDisc > 0.0) glow += sunDisc * 4.0 * pow(s, 1200.0);
  c += uSunTint * glow;
  return c;
}

vec3 skyColor(vec3 dir) {
  return skyRadiance(dir, 1.0);
}

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c * (1.0 / 12.92);
  vec3 hi = pow((c + 0.055) * (1.0 / 1.055), vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
`;

/** Integer-hash value noise (stable for large world coordinates). */
export const NOISE_COMMON = /* glsl */ `
// Hash of an integer lattice point -> [0, 1). The offset keeps the
// coordinates positive before the unsigned conversion.
float hash12(ivec2 p) {
  uvec2 q = uvec2(p + 1048576);
  uint h = q.x * 0x8da6b343u ^ q.y * 0xd8163841u;
  h ^= h >> 13u;
  h *= 0x5bd1e995u;
  h ^= h >> 15u;
  return float(h & 0x00ffffffu) * (1.0 / 16777216.0);
}

// Smooth value noise in [0, 1), one lattice cell per unit.
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = hash12(c);
  float b = hash12(c + ivec2(1, 0));
  float d = hash12(c + ivec2(0, 1));
  float e = hash12(c + ivec2(1, 1));
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
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
`;

/**
 * Water surface shading shared by the water plane and the terrain shader
 * (which draws the water itself wherever the relief rises above sea level,
 * so both must agree exactly). Needs ENV_COMMON and NOISE_COMMON.
 *
 * `mag` is the bilinearly interpolated water magnitude of the 4 nearest
 * tiles, with land counted as -1: ≈ half the tile distance to the coast,
 * -0.5 on the waterline. `tpp` = tiles per device pixel (fwidth of world xz).
 */
export const WATER_COMMON = /* glsl */ `
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uFoamColor;
uniform vec3 uSeabedShallow;
uniform float uWaveStrength;

float waterDepth01(float mag) {
  return sqrt(clamp(mag / 12.0, 0.0, 1.0));
}

// ---- BEGIN lot 3: shore halo width (TerrainShading.shoreViewScale) ----
// Factor on the water magnitude for the shallow look only (seabed showing
// through, shallow tint, see-through shelf): 1 close up (a tile over ~3 px),
// 3 once a tile is under ~0.7 px, so the coastal halo is a thin band at full
// map instead of ~7 tiles of yellow-green glow. Foam, waves and the seabed
// geometry keep the true magnitude. Callers: shadeWater (body + opacity),
// the seabed colour in terrain.ts (main, the water path) and WATER_FRAG.
float shoreViewScale(float tpp) {
  return 1.0 + 2.0 * smoothstep(0.3, 1.4, tpp);
}
// ---- END lot 3: shore halo width

// Seabed albedo: sand at the coast -> dark floor offshore.
vec3 seabedAlbedo(float mag) {
  return mix(uSeabedShallow, uWaterDeep * 0.35, waterDepth01(mag));
}

// Slope (dh/dx, dh/dz) of one travelling sine wave h = A sin(k (dir.p - c t)),
// A = steep * lambda, so |slope| = 2 pi steep. The octave fades out while its
// wavelength shrinks from ~8 to ~3 pixels: no shimmer when zoomed out.
// zw (lot 3, item 8): the same slope for the glints, kept only while the
// wavelength is under ~16-40 px on screen (glintWaveWeight): the long
// octaves' highlight contours were the big repeating "vermicelli".
// The glint share is only computed while the glints show (glints; zw is
// read under the same condition), not at full map or the default zoom.
vec4 waveSlope1(vec2 p, float t, vec2 dir, float lambda, float steep, float speed, float tpp, bool glints) {
  float fade = 1.0 - smoothstep(0.12, 0.33, tpp / lambda);
  if (fade <= 0.0) return vec4(0.0);
  float k = 6.2831853 / lambda;
  float phase = k * (dot(dir, p) - speed * t);
  vec2 s = dir * (6.2831853 * steep * fade * cos(phase));
  vec4 r = vec4(s, 0.0, 0.0);
  if (glints) r.zw = s * (1.0 - smoothstep(16.0, 40.0, lambda / tpp));
  return r;
}

// xy: slope of the surface (reflection, fresnel); zw: its share for the
// glints (lot 3, item 8; 0 unless glints). The phase is bent by a slow warp
// (cheap trig), so the crests of the 5 octaves do not repeat as a lattice.
vec4 waveSlope(vec2 p, float t, float tpp, bool glints) {
  // Slow large-scale modulation so the wave pattern does not look tiled.
  float swell = 0.65 + 0.7 * valueNoise(p * 0.035 + vec2(t * 0.013, -t * 0.009));
  vec2 pw = p + 2.2 * vec2(
    sin(dot(p, vec2(0.071, 0.046)) + t * 0.05),
    sin(dot(p, vec2(-0.052, 0.083)) - t * 0.04));
  vec4 g = waveSlope1(pw, t, vec2(0.832, 0.555), 13.0, 0.010, 1.10, tpp, glints);
  g += waveSlope1(pw, t, vec2(-0.447, 0.894), 7.3, 0.012, 0.85, tpp, glints);
  g += waveSlope1(pw, t, vec2(0.970, -0.243), 4.1, 0.014, 0.65, tpp, glints);
  g += waveSlope1(pw, t, vec2(-0.781, -0.625), 2.3, 0.013, 0.50, tpp, glints);
  g += waveSlope1(pw, t, vec2(0.196, 0.981), 1.3, 0.011, 0.38, tpp, glints);
  return g * (swell * uWaveStrength);
}

// ---- BEGIN lot 3: glitter scaled to the screen (item 8; TerrainShading
// glitterLevel / GLITTER_*). Slope (dimensionless) of a glitter layer whose
// period follows the pixel footprint: two value-noise octaves around
// GLITTER_PX device px, cross-faded over log2 of the footprint (no popping
// while zooming), each rotated and offset by its absolute level (a level
// looks the same in either slot) and drifting, so the glints are small
// sparkles at any zoom, never a repeating pattern.
vec2 glitterSlope(vec2 p, float t, float tpp) {
  float L = log2(max(tpp, 1e-4) * 5.0);
  float k = floor(L);
  float fr = L - k;
  vec2 s = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    float lvl = k + float(i);
    float a = lvl * 2.39996;
    mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
    vec2 q = R * (p * exp2(-lvl)) + vec2(lvl * 17.31 + t * 0.23, lvl * 7.73 - t * 0.19);
    vec3 n = valueNoiseD(q);
    s += (i == 0 ? 1.0 - fr : fr) * (transpose(R) * n.yz);
  }
  return s;
}
// ---- END lot 3: glitter

// Foam. Zoomed out: a crisp light band over the shoreline water tiles
// (bilinear mag up to ~0.45), like the default renderer's lighter shore
// tiles. Close up (a tile over ~3-8 px): a thin wash line on the waterline
// plus lace bands running towards the coast, broken up by large-scale noise
// so they do not echo the tile staircase of the coastline.
float foamAmount(vec2 p, float mag, float t, float tpp) {
  if (mag > 2.2) return 0.0;
  float detail = 1.0 - smoothstep(0.12, 0.3, tpp);
  // Rim edge in mag units (~tiles near the coast): the wash line is at
  // least ~1.5 px wide; anti-aliased over ~1 px.
  float edge = mix(0.45, -0.5 + min(0.12 + 1.5 * tpp, 0.95), detail);
  float aa = 0.6 * tpp + 0.02;
  float rim = 1.0 - smoothstep(edge - aa, edge + aa, mag);
  float lace = 0.0;
  if (detail > 0.0) {
    float n = valueNoise(p * 0.8 + vec2(t * 0.11, -t * 0.07));
    // Slow large-scale breakup of the bands (cheap trig instead of noise).
    float n2 = 0.5 + 0.5 * sin(dot(p, vec2(0.29, 0.21))
      + 2.0 * sin(dot(p, vec2(-0.17, 0.26)) + t * 0.05));
    float bands = 0.5 + 0.5 * sin((mag * 2.2 + t * 0.55) * 3.1415927 + n * 3.0 + n2 * 8.0);
    lace = smoothstep(0.62, 0.9, bands) * (0.55 + 0.45 * n)
      * (1.0 - smoothstep(-0.3, 1.6, mag)) * smoothstep(0.25, 0.6, n2) * detail;
  }
  return clamp(lace + rim * mix(0.65, 0.85, detail), 0.0, 1.0);
}

// Water surface colour (linear) and opacity at p. V = unit vector from the
// surface to the camera.
vec4 shadeWater(vec2 p, float mag, vec3 V, float tpp, float t) {
  // Shallow look narrowed when zoomed out (lot 3, shoreViewScale).
  float d = waterDepth01(mag * shoreViewScale(tpp));
  // Calmer near the coast and when zoomed out.
  float calm = mix(0.4, 1.0, smoothstep(0.0, 3.0, mag))
    * mix(1.0, 0.45, smoothstep(0.3, 1.5, tpp));
  // Sun glints only at close zoom (faded out from ~30 down to ~4 px per
  // tile; see below).
  float glintOn = 1.0 - smoothstep(0.03, 0.25, tpp);
  vec4 slopes = waveSlope(p, t, tpp, glintOn > 0.0) * calm;
  vec2 slope = slopes.xy;
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 body = mix(uWaterShallow, uWaterDeep, d) * diffuseLight(UP);
  // Lot 3 (item 8): the reflected sky without the sun's disc. Mirrored by
  // the summed sines, the disc drew the big repeating "vermicelli" at mid
  // zoom; the sun's reflection is the glint lobe below, scaled to the
  // screen.
  vec3 col = mix(body, skyRadiance(reflect(-V, n), 0.0), fres);

  // Sun glints (tight lobe) and a soft sheen (wide lobe), Blinn-Phong, only
  // at close zoom (faded out from ~30 down to ~4 px per tile). Lot 3 (item
  // 8): the lobes see the waves' short octaves only (slopes.zw, a third of
  // their slope) plus the glitter layer, so the sun's reflection is a field
  // of sparkles of a few px at any zoom instead of long repeating contours;
  // with them that small, the tight lobe can be brighter (0.22, was 0.05).
  vec3 h = normalize(V + uSunDir);
  float glint = 0.0;
  if (glintOn > 0.0) {
    vec2 gs = 0.35 * slopes.zw + 0.28 * calm * uWaveStrength * glitterSlope(p, t, tpp);
    vec3 ng = normalize(vec3(-gs.x, 1.0, -gs.y));
    vec3 nb = normalize(vec3(-slopes.z, 1.0, -slopes.w));
    glint = (0.22 * pow(max(dot(ng, h), 0.0), 700.0)
      + 0.04 * pow(max(dot(nb, h), 0.0), 60.0)) * glintOn;
  }
  col += uSunIrradiance * (glint * INV_PI);

  float foam = foamAmount(p, mag, t, tpp);
  col = mix(col, uFoamColor * diffuseLight(UP), foam);

  // See-through over the shallow shelf, opaque offshore.
  float alpha = mix(0.5, 1.0, smoothstep(0.05, 0.8, d));
  alpha = clamp(max(alpha, max(foam, fres)) + 0.3 * glint, 0.0, 1.0);
  return vec4(col, alpha);
}
`;

export const WATER_VERT = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const WATER_FRAG = /* glsl */ `
${FRAG_OUTPUT}
${ENV_COMMON}
${NOISE_COMMON}
${WATER_COMMON}

uniform highp usampler2D uTerrain; // R8UI W x H terrain bytes
uniform highp sampler2D uPalette;  // RGBA32F 4096 x 2: row 0 fill (trail colour)
uniform ivec2 uMapSize;
uniform float uTime;
uniform float uAltView;
uniform float uSeabedDepth; // world depth of the deepest seabed (tiles)

// ---- BEGIN effect trails uniforms + effectTrail() (EffectTrails.ts)
${EFFECT_TRAILS_GLSL}
// ---- END effect trails uniforms

varying vec3 vWorld;
#include <fog_pars_fragment>

// Water magnitude of a tile (clamped to the map), land = -1.
float shoreAt(ivec2 t) {
  uint tb = texelFetch(uTerrain, clamp(t, ivec2(0), uMapSize - 1), 0).r;
  return (tb & 0x80u) != 0u ? -1.0 : float(min(tb & 31u, 16u));
}

void main() {
  vec2 p = vWorld.xz;
  vec2 fw = max(fwidth(p), vec2(1e-5));
  float tpp = max(fw.x, fw.y);

  vec2 size = vec2(uMapSize);
  vec2 off = max(max(-p, p - size), vec2(0.0));
  float dOut = max(off.x, off.y); // tiles outside the map (0 inside)
  if (dOut <= 0.0) {
    uint tb = texelFetch(uTerrain, clamp(ivec2(floor(p)), ivec2(0), uMapSize - 1), 0).r;
    // Land, decided per tile (not by relief height): the terrain draws it.
    if ((tb & 0x80u) != 0u) discard;
  }

  // Bilinear magnitude over the 4 nearest tile centres (smooth depth / foam).
  vec2 q = p - 0.5;
  ivec2 b = ivec2(floor(q));
  vec2 w = q - vec2(b);
  float mag = mix(
    mix(shoreAt(b), shoreAt(b + ivec2(1, 0)), w.x),
    mix(shoreAt(b + ivec2(0, 1)), shoreAt(b + ivec2(1, 1)), w.x),
    w.y);
  // Off the map the edge depth fades into open sea within a few tiles
  // (edge land counts as shallow water there: no foam streaks running off
  // the map from coastal edge tiles).
  if (dOut > 0.0) mag = mix(max(mag, 0.0), 16.0, smoothstep(0.0, 6.0, dOut));

  vec3 V = normalize(cameraPosition - vWorld);
  vec4 wtr = shadeWater(p, mag, V, tpp, uTime);
  vec3 col = wtr.rgb;
  float alpha = wtr.a;
  // There is no relief under the plane off the map, and near the edges a
  // tilted view ray through translucent water leaves the map before it
  // reaches the seabed (it would show the sky). Follow the ray down to the
  // seabed depth of this point (TerrainCodec's water depth curve); where it
  // lands outside the map, composite the seabed here, flat-lit exactly as
  // the terrain shades it, so the switch is seamless.
  float depth = uSeabedDepth * (0.08 + 0.92 * waterDepth01(max(mag, 0.0)));
  vec2 hit = p - V.xz * (depth / max(V.y, 0.05));
  vec2 sd = max(-hit, hit - size); // > 0 outside the map
  float composite = dOut > 0.0 ? 1.0 : smoothstep(-2.0, 0.0, max(sd.x, sd.y));
  col = mix(col, mix(seabedAlbedo(mag * shoreViewScale(tpp)) * diffuseLight(UP), wtr.rgb, wtr.a), composite);
  alpha = mix(alpha, 1.0, composite);
  col *= mix(1.0, 0.6, uAltView);

  // ---- BEGIN effect trails composite (boat / nuke trails, EffectTrails.ts):
  // lit flat like the terrain shader's, "over" the water and what shows
  // through it (this plane is translucent over the shallows). A uniform
  // branch: free while no tile holds a trail.
  if (uTrailsOn > 0.5 && dOut <= 0.0) {
    vec4 tr = effectTrail(clamp(ivec2(floor(p)), ivec2(0), uMapSize - 1), p, uAltView > 0.5);
    if (tr.a > 0.0) {
      vec3 tc = srgbToLinear(tr.rgb) * diffuseLight(UP);
      float a2 = tr.a + alpha * (1.0 - tr.a);
      col = (col * alpha * (1.0 - tr.a) + tc * tr.a) / a2;
      alpha = a2;
    }
  }
  // ---- END effect trails composite

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Sky dome: a unit sphere scaled around the camera, drawn first. */
export const SKY_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

export const SKY_FRAG = /* glsl */ `
${FRAG_OUTPUT}
${ENV_COMMON}

varying vec3 vDir;

void main() {
  gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
