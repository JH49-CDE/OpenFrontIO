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
// soft glow and a small disc around the sun.
vec3 skyColor(vec3 dir) {
  float e = clamp(dir.y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(e, 0.55));
  float s = max(dot(dir, uSunDir), 0.0);
  c += uSunTint * (0.25 * pow(s, 24.0) + 4.0 * pow(s, 1200.0));
  return c;
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

// Seabed albedo: sand at the coast -> dark floor offshore.
vec3 seabedAlbedo(float mag) {
  return mix(uSeabedShallow, uWaterDeep * 0.35, waterDepth01(mag));
}

// Slope (dh/dx, dh/dz) of one travelling sine wave h = A sin(k (dir.p - c t)),
// A = steep * lambda, so |slope| = 2 pi steep. The octave fades out while its
// wavelength shrinks from ~8 to ~3 pixels: no shimmer when zoomed out.
vec2 waveSlope1(vec2 p, float t, vec2 dir, float lambda, float steep, float speed, float tpp) {
  float fade = 1.0 - smoothstep(0.12, 0.33, tpp / lambda);
  if (fade <= 0.0) return vec2(0.0);
  float k = 6.2831853 / lambda;
  float phase = k * (dot(dir, p) - speed * t);
  return dir * (6.2831853 * steep * fade * cos(phase));
}

vec2 waveSlope(vec2 p, float t, float tpp) {
  // Slow large-scale modulation so the wave pattern does not look tiled.
  float swell = 0.65 + 0.7 * valueNoise(p * 0.035 + vec2(t * 0.013, -t * 0.009));
  vec2 g = waveSlope1(p, t, vec2(0.832, 0.555), 13.0, 0.010, 1.10, tpp);
  g += waveSlope1(p, t, vec2(-0.447, 0.894), 7.3, 0.012, 0.85, tpp);
  g += waveSlope1(p, t, vec2(0.970, -0.243), 4.1, 0.014, 0.65, tpp);
  g += waveSlope1(p, t, vec2(-0.781, -0.625), 2.3, 0.013, 0.50, tpp);
  g += waveSlope1(p, t, vec2(0.196, 0.981), 1.3, 0.011, 0.38, tpp);
  return g * (swell * uWaveStrength);
}

// Foam: lace bands running towards the coast plus a wash line on the
// waterline. Zoomed out the bands average into a light rim (like the default
// renderer's lighter shoreline water) instead of aliasing.
float foamAmount(vec2 p, float mag, float t, float tpp) {
  if (mag > 2.2) return 0.0;
  float detail = 1.0 - smoothstep(0.3, 1.0, tpp);
  float n = valueNoise(p * 0.8 + vec2(t * 0.11, -t * 0.07));
  float bands = 0.5 + 0.5 * sin((mag * 2.2 + t * 0.55) * 3.1415927 + n * 3.0);
  float lace = smoothstep(0.62, 0.9, bands) * (0.55 + 0.45 * n);
  float nearCoast = 1.0 - smoothstep(-0.3, 1.6, mag);
  // Wash line: at least ~1.5 px wide (mag changes ~1 per tile at the coast).
  float rimW = min(0.12 + 1.5 * tpp, 1.2);
  float rim = 1.0 - smoothstep(-0.5 + 0.5 * rimW, -0.5 + rimW, mag);
  float f = nearCoast * mix(0.15, lace, detail) + rim * mix(0.3, 0.85, detail);
  return clamp(f, 0.0, 1.0);
}

// Water surface colour (linear) and opacity at p. V = unit vector from the
// surface to the camera.
vec4 shadeWater(vec2 p, float mag, vec3 V, float tpp, float t) {
  float d = waterDepth01(mag);
  // Calmer near the coast and when zoomed out.
  float calm = mix(0.4, 1.0, smoothstep(0.0, 3.0, mag))
    * mix(1.0, 0.45, smoothstep(0.3, 1.5, tpp));
  vec2 slope = waveSlope(p, t, tpp) * calm;
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 body = mix(uWaterShallow, uWaterDeep, d) * diffuseLight(UP);
  vec3 col = mix(body, skyColor(reflect(-V, n)), fres);

  // Sun glints (tight lobe) and a soft sheen (wide lobe), Blinn-Phong.
  // Kept small and only at close zoom (faded out from ~30 down to ~4 px per
  // tile): further out the sun's reflection turns whole seas into glitter.
  vec3 h = normalize(V + uSunDir);
  float ndh = max(dot(n, h), 0.0);
  float glint = (0.6 * pow(ndh, 700.0) + 0.04 * pow(ndh, 60.0))
    * (1.0 - smoothstep(0.03, 0.25, tpp));
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
uniform ivec2 uMapSize;
uniform float uTime;
uniform float uAltView;
uniform float uSeabedDepth; // world depth of the deepest seabed (tiles)

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
  col = mix(col, mix(seabedAlbedo(mag) * diffuseLight(UP), wtr.rgb, wtr.a), composite);
  alpha = mix(alpha, 1.0, composite);
  col *= mix(1.0, 0.6, uAltView);

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
