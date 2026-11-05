/**
 * GLSL of the night and lights (lot 4 prototype, NightLights.ts), shared by
 * the terrain and water shaders inside `#ifdef NIGHT`. A module of its own
 * that imports nothing: shaders/water.ts needs it at load time, and
 * NightLights.ts (which imports SceneEnvironment, which imports
 * shaders/water.ts) would be an import cycle.
 */

/** Lightmap value range: the light is soft-capped at this (×uNight gain). */
export const LIGHTMAP_MAX = 2;
/** Flash point lights lighting the terrain and the water at once. */
export const NIGHT_FLASH_SLOTS = 4;

/**
 * Uniforms and helpers of the night (terrain and water shaders, inside
 * `#ifdef NIGHT`): the city lightmap (`nightCityLight`, one bilinear fetch),
 * the flashes (`nightFlashLight`, a loop over the live slots), the water's
 * share of both (`nightWater`). Needs ENV_COMMON.
 */
export const NIGHT_GLSL = /* glsl */ `
uniform highp sampler2D uNightMap; // RGBA8, sqrt-encoded city light (NightLightmap)
uniform vec4 uNightMapXf;          // 1 / S, unused, 1 / lmW, 1 / lmH
uniform vec4 uNightLook;           // fill keep, border keep, desaturation, city light gain
uniform vec4 uNightLook2;          // ember gain, wide glow weight, depth (0..1), unused
uniform vec4 uFlash[${NIGHT_FLASH_SLOTS}];    // xyz light position, radius
uniform vec4 uFlashCol[${NIGHT_FLASH_SLOTS}]; // rgb colour x brightness
uniform int uFlashN;               // live slots (packed first)
// Day diffuseLight(UP) (dayFlatLight): the brightness the fill and borders
// keep a share of.
uniform vec3 uNightDayFlat;
#define NIGHT_DAY_FLAT uNightDayFlat
const float NIGHT_LIGHTMAP_MAX = ${LIGHTMAP_MAX.toFixed(1)};
// Moonlit sea floor (linear), added at full depth.
const vec3 NIGHT_SEA_FLOOR = vec3(0.006, 0.011, 0.026);

// City light (linear irradiance-like) at world xz: the lights (rgb) and,
// zoomed out, their wide warm glow (alpha), so a lit region reads around
// the structure icons that cover the cores.
vec3 nightCityLight(vec2 p) {
  vec4 e = texture(uNightMap, (p * uNightMapXf.x + 1.0) * uNightMapXf.zw);
  vec4 l = e * e * NIGHT_LIGHTMAP_MAX;
  return (l.rgb + vec3(1.0, 0.78, 0.5) * (l.a * uNightLook2.y)) * uNightLook.w;
}

float flashFalloff(float x) {
  float w = max(1.0 - x * x, 0.0);
  return w * w / (1.0 + 5.0 * x * x);
}

// Light of the live flashes at world point wp with normal n: falloff with
// the horizontal distance, half wrapped around the relief (Lambert).
vec3 nightFlashLight(vec3 wp, vec3 n) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${NIGHT_FLASH_SLOTS}; i++) {
    if (i >= uFlashN) break;
    vec3 d = uFlash[i].xyz - wp;
    float x = length(d.xz) / uFlash[i].w;
    if (x >= 1.0) continue;
    float lam = max(dot(n, normalize(d)), 0.0);
    acc += uFlashCol[i].rgb * (flashFalloff(x) * (0.4 + 0.6 * lam));
  }
  return acc;
}

// Water at night: greyed like the ground (moonlight) but lifted a little
// over a moonlit navy floor (the shallow-water gradient and the shore foam
// still read, ships keep a sea to stand out on), the city lights on the
// harbours and the flashes on the sea, added as light on a pale surface (a
// flash does not turn the sea into a dark red disc).
vec3 nightWater(vec3 col, vec3 wp) {
  col = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), 0.6 * uNightLook.z);
  col = col * (1.0 + 0.6 * uNightLook2.z) + NIGHT_SEA_FLOOR * uNightLook2.z;
  vec3 l = nightCityLight(wp.xz) * 0.55;
  return col + (col * 0.8 + 0.03) * l + nightFlashLight(wp, vec3(0.0, 1.0, 0.0)) * 0.3;
}
`;
