/**
 * Lot 4 prototype (`?three_wakes=1`): foam wakes behind moving ships.
 *
 * `WakeRenderer` is owned by `UnitLayer` and only built when
 * `settings.prototypes.wakes` is on: without the flag there is no mesh, no
 * material (so no shader program), no texture reference and no per-unit
 * work, only one null check per frame in `UnitLayer.update`.
 *
 * What is drawn: one instanced quad (2 triangles, a trapezoid widening
 * behind the bow) per moving ship in view, lying on the sea at
 * `WAKE_LIFT`, in ONE draw call:
 * - a Kelvin-like V whose apex sits at the bow and whose arms run back at
 *   `WAKE_HALF_ANGLE_DEG` on each side, widening and fading towards the
 *   tail, broken up by the foam noise below (close up: faint oblique
 *   crests along the arms, a real wake's feathers, and churned water
 *   inside the V);
 * - turbulent foam on the centre line behind the stern (the propeller
 *   wash), broken up by value noise anchored to the water (the ship's
 *   odometer minus the distance behind its bow, so the foam stays put as
 *   the ship sails on), slowly churning.
 * Everything is in units of the drawn ship length (the model's length ×
 * its min-size boost), so a wake always fits its ship on screen: a small V
 * of ~20 px behind a 10 px ship at the default zoom, a short faint streak
 * (no arms) at full map (`wakeLook`). Military traffic reads first: zoomed
 * out a trade ship's wake is faint (`wakeKindStrength`), a transport's or
 * a warship's strong; and where many wakes crowd one spot (convoy lanes,
 * port queues) each is dimmed (1 / √n per ~32 CSS px cell), so lanes do not
 * merge into white bands.
 *
 * Kinematics come from UnitLayer's tracks (`WakeSource`): the velocity is an
 * exponential average (`WAKE_VELOCITY_TAU_MS`) of each tick's segment (tiles
 * per tick), which turns the 4-connected staircase of a diagonal course
 * into a steady heading, and fades the wake out smoothly when a ship stops
 * (docked or blocked ships have none). Warships get a longer, wider and
 * stronger wake, transports a stronger one (`WAKE_KINDS`).
 *
 * Water only: each fragment fetches its tile's terrain byte (the shared
 * `TerrainByteTexture`) and is discarded on land, so a ship hugging a coast
 * never paints foam on the shore. Depth-tested (relief in front hides it),
 * never written to depth, drawn after the sea and before the units' contact
 * shadows (`WAKE_RENDER_ORDER`); lit like the water's own foam (same colour
 * and light), fogged, premultiplied "over" blending, dimmed in the alt view.
 *
 * Bounded: at most `WAKE_MAX_INSTANCES` instances (the rest are counted
 * in `capped`; trade ships stop `WAKE_MILITARY_RESERVE` short of it, so the
 * cap never drops a transport or a warship), only ships whose wake's
 * bounding sphere is in the view frustum, one `bufferSubData` of 9 floats
 * per instance per frame. With the night on (`?three_night=1`) the wakes
 * are dimmer (`WAKE_NIGHT_DIM`), so they do not read as searchlights.
 */

import * as THREE from "three";
import { smoothstep } from "./CameraRig";
import { nightModeOf } from "./NightLights";
import { UNIT_MESH_LENGTH, type UnitMeshKind } from "./ProceduralMeshes";
import { environmentUniforms } from "./SceneEnvironment";
import { ENV_COMMON, FRAG_OUTPUT, NOISE_COMMON } from "./shaders/water";
import {
  createWaterUniforms,
  refreshWaterUniforms,
  TerrainByteTexture,
  type WaterUniforms,
  waterColorKey,
} from "./TerrainResources";
import type { FrameInfo, ThreeLayerContext } from "./types";

// ---------------------------------------------------------------------------
// Tuning (shared by the shader and its TypeScript twin)
// ---------------------------------------------------------------------------

/** Most wakes drawn in one frame (the rest are skipped and counted). */
export const WAKE_MAX_INSTANCES = 1024;
/** Slots of the cap that only transports and warships may use. */
export const WAKE_MILITARY_RESERVE = 64;
/** Crowding cell, CSS px: wakes sharing one are dimmed by 1 / √n. */
export const WAKE_CROWD_CELL_PX = 32;
/** Opacity of the wakes at night (the moonlit sea is dark). */
export const WAKE_NIGHT_DIM = 0.5;
/** Floats per instance: apex x/z, dir x/z, ship length, wake length, strength, odometer, wash. */
export const WAKE_STRIDE = 9;
/** Time constant of the velocity average (tick segments), ms. */
export const WAKE_VELOCITY_TAU_MS = 350;
/** Speeds (tiles per tick) over which a wake fades in. */
export const WAKE_SPEED_RANGE: readonly [number, number] = [0.08, 0.5];
/** Below this strength no instance is drawn. */
export const WAKE_MIN_STRENGTH = 0.02;
/** Half-angle of the V (a Kelvin wake's is 19.47°). */
export const WAKE_HALF_ANGLE_DEG = 19.5;
export const WAKE_HALF_TAN = Math.tan((WAKE_HALF_ANGLE_DEG * Math.PI) / 180);
/** The apex sits this far ahead of the ship's centre (ship lengths). */
export const WAKE_BOW = 0.46;
/** Stern, ship lengths behind the apex. */
export const WAKE_STERN = 2 * WAKE_BOW;
/** The quad starts this far ahead of the apex, and is this wide there (ship lengths). */
export const WAKE_FRONT = 0.03;
export const WAKE_MARGIN = 0.32;
/** Arms: half width at the apex and its growth per ship length, ship lengths. */
export const WAKE_ARM_W0 = 0.035;
export const WAKE_ARM_GROW = 0.03;
/** Arms' peak coverage: a little under the stern wash's, which reads first. */
export const WAKE_ARM_PEAK = 0.8;
/** The arms end at this share of the wake's length (the wash goes on). */
export const WAKE_ARM_REACH = 0.6;
/** Highest foam coverage (the coast's own foam is never outshone). */
export const WAKE_MAX_ALPHA = 0.85;
/** Stern wash: half width at the stern and its growth per ship length. */
export const WAKE_FOAM_W0 = 0.11;
export const WAKE_FOAM_GROW = 0.13;
/** Thin features are widened to at least this many device px (half width). */
export const WAKE_MIN_PX = 0.75;
/** Height above sea level (tiles); the units' contact shadows sit at 0.06. */
export const WAKE_LIFT = 0.03;
/** After the sea (-10) and its overlay plane (-9), before shadows (1). */
export const WAKE_RENDER_ORDER = -8;
/** The odometer wraps here (ship lengths): a foam pattern jump every ~1,000 lengths. */
export const WAKE_ODO_WRAP = 1024;
/** Opacity of the wakes in the alt view (the sea is dimmed there). */
export const WAKE_ALT_VIEW_DIM = 0.55;

/**
 * Per-kind wake: strength (opacity) close up (from 6 CSS px per tile) and
 * zoomed out (2.5 and under), length and wash width factors, and whether it
 * is military (it may use the cap's reserve). Zoomed out ~900 trade ships
 * must not out-shout the transports (the invasion threat) and warships.
 */
export interface WakeKind {
  strength: number;
  farStrength: number;
  length: number;
  wash: number;
  military: boolean;
}

export const WAKE_KINDS: Readonly<Partial<Record<UnitMeshKind, WakeKind>>> = {
  transport: {
    strength: 1.35,
    farStrength: 1.35,
    length: 1,
    wash: 1.1,
    military: true,
  },
  tradeShip: {
    strength: 1,
    farStrength: 0.55,
    length: 1,
    wash: 0.75,
    military: false,
  },
  warship: {
    strength: 1.5,
    farStrength: 1.5,
    length: 1.15,
    wash: 1.3,
    military: true,
  },
};

/** A kind's strength at a zoom (far below 2.5 CSS px per tile, near from 6). */
export function wakeKindStrength(kind: WakeKind, cssPxPerTile: number): number {
  const t = smoothstep(2.5, 6, cssPxPerTile);
  return kind.farStrength + (kind.strength - kind.farStrength) * t;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Look of the wakes at a zoom (CSS px per tile at the screen centre). */
export interface WakeLook {
  /** Wake length behind the bow, in drawn ship lengths (full speed). */
  lengthShips: number;
  /** Weight of the V arms (0 = a streak of stern foam only). */
  arms: number;
  /** Overall opacity. */
  opacity: number;
}

/**
 * Full map (≤ 0.9 CSS px per tile): a short faint streak (1.6 ship lengths,
 * no arms, 0.4 opacity: a trade ship's 0.22), so ~900 ships do not turn
 * the sea into a pattern; the V grows in over 0.9-1.6 (default zoom 1.8:
 * 2 ship lengths at 0.65 opacity, a trade ship's 0.36), longer and
 * stronger close up (2.6 ship lengths, 0.85 from 10 px per tile).
 */
export function wakeLook(
  cssPxPerTile: number,
  out: WakeLook = { lengthShips: 0, arms: 0, opacity: 0 },
): WakeLook {
  const near = smoothstep(0.9, 1.6, cssPxPerTile);
  const close = smoothstep(3, 10, cssPxPerTile);
  out.lengthShips = 1.6 + 0.4 * near + 0.6 * close;
  out.arms = near;
  out.opacity = 0.4 + 0.25 * near + 0.2 * close;
  return out;
}

/** 0..1 wake strength of a ship moving `speed` tiles per tick. */
export function wakeSpeedWeight(speed: number): number {
  return smoothstep(WAKE_SPEED_RANGE[0], WAKE_SPEED_RANGE[1], speed);
}

/** Per-ship wake state (kept on UnitLayer's track, created lazily). */
export interface WakeTrack {
  /** Averaged velocity, tiles per tick. */
  vx: number;
  vy: number;
  /** Distance sailed, drawn ship lengths (wraps at WAKE_ODO_WRAP). */
  odo: number;
  /** Drawn position on the last frame. */
  prevX: number;
  prevY: number;
}

/**
 * What the wake needs from a unit track (UnitLayer's `UnitTrack` has these
 * fields): its kind, the tick segment being interpolated (tiles), where it
 * was drawn this frame, and a slot for its wake state.
 */
export interface WakeSource {
  readonly id: number;
  readonly kind: UnitMeshKind;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly dispX: number;
  readonly dispY: number;
  wake: WakeTrack | null;
}

/** Deterministic odometer offset (ship lengths) so wakes differ. */
function odoSeed(id: number): number {
  const h = Math.imul(id ^ 0x2c1b3c6d, 0x297a2d39) >>> 0;
  return (h / 0x100000000) * 64;
}

/**
 * A new wake state. A ship already moving when first seen (its segment is
 * non-zero: the page just loaded, or the replay pushed a state) gets its
 * full velocity at once; a ship leaving port starts from rest.
 */
export function createWakeTrack(src: WakeSource): WakeTrack {
  return {
    vx: src.toX - src.fromX,
    vy: src.toY - src.fromY,
    odo: odoSeed(src.id),
    prevX: src.dispX,
    prevY: src.dispY,
  };
}

/** Jumps longer than this (tiles) between frames do not count as sailing. */
const WAKE_TELEPORT_TILES = 60;

/**
 * Advances a wake state by one frame: the velocity moves towards the
 * current tick segment with time constant WAKE_VELOCITY_TAU_MS (frame-rate
 * independent), and the odometer by the drawn distance in ship lengths
 * (`shipLen` tiles).
 */
export function stepWakeTrack(
  w: WakeTrack,
  src: WakeSource,
  shipLen: number,
  dtMs: number,
): void {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / WAKE_VELOCITY_TAU_MS);
  w.vx += (src.toX - src.fromX - w.vx) * k;
  w.vy += (src.toY - src.fromY - w.vy) * k;
  const ex = src.dispX - w.prevX;
  const ey = src.dispY - w.prevY;
  const d = Math.sqrt(ex * ex + ey * ey);
  if (d < WAKE_TELEPORT_TILES && shipLen > 0) {
    w.odo = (w.odo + d / shipLen) % WAKE_ODO_WRAP;
  }
  w.prevX = src.dispX;
  w.prevY = src.dispY;
}

/**
 * Foam coverage (0..1, before strength and opacity) at `s` ship lengths
 * behind the bow and `l` beside the track, for a wake `lr` ship lengths
 * long; `px` = ship lengths per device pixel, `n` = the turbulence noise
 * (0..1), `arms` = the V's weight, `wash` = the stern foam's width factor.
 * TypeScript twin of the shader's `wakeFoam` (detail terms left out).
 */
export function wakeFoam(
  s: number,
  l: number,
  lr: number,
  px: number,
  n: number,
  arms: number,
  wash: number,
): number {
  const al = Math.abs(l);
  const sp = Math.max(s, 0);
  const w = WAKE_ARM_W0 + WAKE_ARM_GROW * sp;
  const wp = Math.max(w, WAKE_MIN_PX * px);
  const d = (al - sp * WAKE_HALF_TAN) / wp;
  const armTail = 1 - Math.min(1, Math.max(0, s / (WAKE_ARM_REACH * lr)));
  const arm =
    WAKE_ARM_PEAK *
    Math.exp(-d * d) *
    (w / wp) *
    smoothstep(0, 0.08, s) *
    Math.pow(armTail, 1.4) *
    (0.45 + 0.9 * n);
  const st = s - WAKE_STERN;
  const fw = (WAKE_FOAM_W0 + WAKE_FOAM_GROW * Math.max(st, 0)) * wash;
  const fwp = Math.max(fw, WAKE_MIN_PX * px);
  const core = Math.exp(-(al * al) / (fwp * fwp)) * (fw / fwp);
  const tf = 1 - Math.min(1, Math.max(0, st / Math.max(lr - WAKE_STERN, 0.1)));
  const along = smoothstep(-0.08, 0.06, st) * Math.pow(tf, 1.3);
  const foam = core * along * (0.25 + 1.1 * smoothstep(0.2, 0.9, n));
  return Math.min(1, Math.max(0, Math.max(arm * arms, foam)));
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const f = (v: number) => v.toFixed(5);

export const WAKE_VERT = /* glsl */ `
attribute vec4 aWakeA; // apex x, z (tiles), unit direction of travel x, z
attribute vec4 aWakeB; // drawn ship length, wake length (tiles), strength, odometer
attribute float aWash; // stern foam width factor
uniform float uLift;
varying vec2 vLocal;   // (behind the bow, beside the track), ship lengths
varying vec4 vInfo;    // wake length (ship lengths), strength, odometer, wash
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  float len = aWakeB.x;
  float L = aWakeB.y;
  // position.x: 0 at the front edge, 1 at the tail; position.y: -1..1.
  float s = mix(-${f(WAKE_FRONT)} * len, L, position.x);
  float hw = ${f(WAKE_MARGIN)} * len + position.x * L * ${f(WAKE_HALF_TAN)};
  float l = position.y * hw;
  vec2 fwd = aWakeA.zw;
  vec2 xz = aWakeA.xy - fwd * s + vec2(-fwd.y, fwd.x) * l;
  vec4 world = modelMatrix * vec4(xz.x, uLift, xz.y, 1.0);
  vWorld = world.xyz;
  vLocal = vec2(s, l) / len;
  vInfo = vec4(L / len, aWakeB.z, aWakeB.w, aWash);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const WAKE_FRAG = /* glsl */ `
${FRAG_OUTPUT}
${ENV_COMMON}
${NOISE_COMMON}
uniform highp usampler2D uTerrain; // R8UI W x H terrain bytes (bit 7 = land)
uniform ivec2 uMapSize;
uniform vec3 uFoamColor;
uniform float uTime;
uniform vec3 uLook; // V arms weight, opacity, alt-view dim
varying vec2 vLocal;
varying vec4 vInfo;
varying vec3 vWorld;
#include <fog_pars_fragment>

const float HALF_TAN = ${f(WAKE_HALF_TAN)};

// Foam coverage (TS twin: WakeLayer.wakeFoam). s, l: ship lengths behind
// the bow / beside the track; lr: wake length; px: ship lengths per pixel;
// n: foam noise; detail: close-up weight (feathers, churned water inside
// the V; not in the twin).
float wakeFoam(float s, float l, float lr, float px, float n, float arms, float wash, float detail) {
  // The arms end before the wash does, and only start at the bow.
  float armTail = 1.0 - clamp(s / (${f(WAKE_ARM_REACH)} * lr), 0.0, 1.0);
  float sp = max(s, 0.0);
  // The V: Gaussian arms at +-HALF_TAN, at least WAKE_MIN_PX px wide
  // (energy kept: a widened arm is dimmer, so far wakes do not shimmer).
  float w = ${f(WAKE_ARM_W0)} + ${f(WAKE_ARM_GROW)} * sp;
  float wp = max(w, ${f(WAKE_MIN_PX)} * px);
  float d = (l - sp * HALF_TAN) / wp;
  // Broken up by the same water-anchored foam noise as the wash.
  float arm = ${f(WAKE_ARM_PEAK)} * exp(-d * d) * (w / wp) * smoothstep(0.0, 0.08, s)
    * pow(armTail, 1.4) * (0.45 + 0.9 * n);
  if (detail > 0.0) {
    // Faint oblique crests along the arms (a Kelvin wake's feathers,
    // steady in the ship's frame) and churned water inside the V.
    arm *= 1.0 - detail * 0.25 * (0.5 + 0.5 * sin(6.2831853 * (s * 3.4 + l * 2.2)));
    float inside = smoothstep(0.0, 0.15, sp * HALF_TAN - l) * smoothstep(0.8, 1.2, s);
    arm += detail * 0.07 * inside * armTail;
  }
  // Stern wash: turbulent foam on the centre line, widening behind and
  // outlasting the arms.
  float st = s - ${f(WAKE_STERN)};
  float fw = (${f(WAKE_FOAM_W0)} + ${f(WAKE_FOAM_GROW)} * max(st, 0.0)) * wash;
  float fwp = max(fw, ${f(WAKE_MIN_PX)} * px);
  float core = exp(-(l * l) / (fwp * fwp)) * (fw / fwp);
  float tf = 1.0 - clamp(st / max(lr - ${f(WAKE_STERN)}, 0.1), 0.0, 1.0);
  float along = smoothstep(-0.08, 0.06, st) * pow(tf, 1.3);
  // Broken into streaks along the track (the noise is stretched along it).
  float foam = core * along * (0.25 + 1.1 * smoothstep(0.2, 0.9, n));
  return clamp(max(arm * arms, foam), 0.0, 1.0);
}

void main() {
  // Derivatives first (uniform control flow).
  vec2 fl = fwidth(vLocal);
  float px = max(max(fl.x, fl.y), 1e-5);
  // Water only, decided per tile like the sea plane: no foam on the shore.
  ivec2 tile = clamp(ivec2(floor(vWorld.xz)), ivec2(0), uMapSize - 1);
  if ((texelFetch(uTerrain, tile, 0).r & 0x80u) != 0u) discard;

  float s = vLocal.x;
  float l = abs(vLocal.y);
  // Close-up detail once a ship spans ~25 to ~60 device px.
  float detail = 1.0 - smoothstep(0.016, 0.04, px);
  // Foam noise anchored to the water (odometer - distance behind the
  // bow), stretched along the track (streaks), slowly spreading outwards;
  // a second octave close up.
  vec2 q = vec2((vInfo.z - s) * 2.0, l * 9.0 - uTime * 0.25);
  float n = valueNoise(q);
  if (detail > 0.0) n = mix(n, 0.55 * n + 0.45 * valueNoise(q * 2.7 + 13.7), detail);

  float foam = wakeFoam(s, l, vInfo.x, px, n, uLook.x, vInfo.w, detail);
  float a = min(foam * vInfo.y, ${f(WAKE_MAX_ALPHA)}) * uLook.y * uLook.z;
  if (a < 0.004) discard;
  // Lit like the water's foam (shadeWater), a touch brighter on dense foam.
  gl_FragColor = vec4(uFoamColor * diffuseLight(UP) * (0.92 + 0.12 * foam), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** UnitLayer's min-size boost: (min CSS px, zoom, model length) → scale. */
export type ShipScaleFn = (
  minPx: number,
  cssPxPerTile: number,
  sizeTiles: number,
) => number;

/**
 * Counters of the last frame: instances drawn, ships with a wake outside
 * the view, ships over WAKE_MAX_INSTANCES, JS time of the wake pass (last
 * frame and max over 120 frames; measured only with `three_perf`), and
 * the instance data uploaded.
 */
export interface WakeStats {
  wakeInstances: number;
  wakeCulled: number;
  wakeCapped: number;
  wakeJsMs: number;
  wakeJsMsMax: number;
  wakeUploadKB: number;
}

const JS_WINDOW = 120;
/** Crowding hash table size (power of two, > 2 × WAKE_MAX_INSTANCES). */
const CROWD_SLOTS = 4096;

/** Dimming of one wake among `n` sharing its crowding cell (1 / √n). */
export function wakeCrowdDim(n: number): number {
  return n > 1 ? 1 / Math.sqrt(n) : 1;
}

export class WakeRenderer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly data = new Float32Array(WAKE_MAX_INSTANCES * WAKE_STRIDE);
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly terrain: TerrainByteTexture;
  private readonly water: WaterUniforms;
  private readonly look = new THREE.Vector3(1, 1, 1);
  private readonly time = { value: 0 };
  private colorKey = "";
  private readonly sphere = new THREE.Sphere();
  private readonly lookScratch: WakeLook = {
    lengthShips: 0,
    arms: 0,
    opacity: 0,
  };
  /** Opacity factor: WAKE_NIGHT_DIM with the night on, else 1. */
  private readonly nightDim: number;
  // Crowding: cell keys and counts (open addressing), each instance's slot.
  private readonly crowdKeys = new Int32Array(CROWD_SLOTS);
  private readonly crowdCounts = new Uint16Array(CROWD_SLOTS);
  private readonly crowdSlot = new Int16Array(WAKE_MAX_INSTANCES);

  // Counters of the last frame (perfStats).
  private instances = 0;
  private culled = 0;
  private capped = 0;
  private jsMs = 0;
  private readonly jsHistory = new Float32Array(JS_WINDOW);
  private jsIndex = 0;

  constructor(
    parent: THREE.Object3D,
    private readonly ctx: ThreeLayerContext,
    private readonly shipScale: ShipScaleFn,
  ) {
    this.terrain = TerrainByteTexture.acquire(ctx);
    this.water = createWaterUniforms();
    this.nightDim = nightModeOf(ctx.settings) !== null ? WAKE_NIGHT_DIM : 1;
    this.refreshColors();

    const g = new THREE.InstancedBufferGeometry();
    // A quad from the front edge (x = 0) to the tail (x = 1), y = side.
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]),
        3,
      ),
    );
    g.setIndex([0, 2, 1, 1, 2, 3]);
    this.buffer = new THREE.InstancedInterleavedBuffer(
      this.data,
      WAKE_STRIDE,
      1,
    );
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(
      "aWakeA",
      new THREE.InterleavedBufferAttribute(this.buffer, 4, 0),
    );
    g.setAttribute(
      "aWakeB",
      new THREE.InterleavedBufferAttribute(this.buffer, 4, 4),
    );
    g.setAttribute(
      "aWash",
      new THREE.InterleavedBufferAttribute(this.buffer, 1, 8),
    );
    g.instanceCount = 0;
    this.geometry = g;

    this.material = new THREE.ShaderMaterial({
      name: "three-unit-wakes",
      glslVersion: THREE.GLSL3,
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...environmentUniforms(ctx.scene),
        uTerrain: { value: this.terrain.texture },
        uMapSize: { value: new THREE.Vector2(ctx.mapWidth, ctx.mapHeight) },
        uFoamColor: this.water.uFoamColor,
        uTime: this.time,
        uLook: { value: this.look },
        uLift: { value: WAKE_LIFT },
      },
      transparent: true,
      depthWrite: false,
      fog: true,
      // Premultiplied "over" (the fragment writes rgb × a, a).
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      // Like the contact shadows: wins over the sea plane (pushed back) and
      // the coast-lifted relief at sea level.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = "unit-wakes";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = WAKE_RENDER_ORDER;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /**
   * Rebuilds the instances from the tracks (after UnitLayer has set this
   * frame's `dispX` / `dispY`). Non-ships are skipped; ships get a wake
   * state on first sight.
   */
  update(
    frame: FrameInfo,
    sources: Iterable<WakeSource>,
    frustum: THREE.Frustum,
  ): void {
    const perf = this.ctx.settings.perf;
    const t0 = perf ? performance.now() : 0;
    const zoom = frame.cssPxPerTile;
    const minPx = this.ctx.settings.unitMinScreenPx;
    const look = wakeLook(zoom, this.lookScratch);
    this.look.set(
      look.arms,
      look.opacity,
      (frame.altView ? WAKE_ALT_VIEW_DIM : 1) * this.nightDim,
    );
    this.time.value = (frame.nowMs / 1000) % 3600;
    if (waterColorKey(this.ctx.renderSettings.terrain) !== this.colorKey) {
      this.refreshColors();
    }
    const data = this.data;
    const sphere = this.sphere;
    const keys = this.crowdKeys;
    const counts = this.crowdCounts;
    const slots = this.crowdSlot;
    keys.fill(-1);
    const cell = Math.max(1, WAKE_CROWD_CELL_PX / Math.max(zoom, 1e-3));
    const tradeCap = WAKE_MAX_INSTANCES - WAKE_MILITARY_RESERVE;
    let n = 0;
    let culled = 0;
    let capped = 0;
    for (const src of sources) {
      const kind = WAKE_KINDS[src.kind];
      if (kind === undefined) continue;
      const base = UNIT_MESH_LENGTH[src.kind];
      const len = base * this.shipScale(minPx, zoom, base);
      let w = src.wake;
      if (w === null) {
        w = createWakeTrack(src);
        src.wake = w;
      } else {
        stepWakeTrack(w, src, len, frame.dtMs);
      }
      const speed = Math.sqrt(w.vx * w.vx + w.vy * w.vy);
      const weight = wakeSpeedWeight(speed);
      const strength = weight * wakeKindStrength(kind, zoom);
      if (strength < WAKE_MIN_STRENGTH) continue;
      const dx = w.vx / speed;
      const dy = w.vy / speed;
      const L = look.lengthShips * kind.length * len * (0.6 + 0.4 * weight);
      const ax = src.dispX + dx * WAKE_BOW * len;
      const ay = src.dispY + dy * WAKE_BOW * len;
      // Bounding sphere of the trapezoid (front edge to tail).
      const front = WAKE_FRONT * len;
      const half = (L + front) / 2;
      const c = half - front;
      sphere.center.set(ax - dx * c, WAKE_LIFT, ay - dy * c);
      const side = WAKE_MARGIN * len + L * WAKE_HALF_TAN;
      sphere.radius = Math.sqrt(half * half + side * side);
      if (!frustum.intersectsSphere(sphere)) {
        culled++;
        continue;
      }
      if (n >= (kind.military ? WAKE_MAX_INSTANCES : tradeCap)) {
        capped++;
        continue;
      }
      // Crowding cell of the apex (open addressing, CROWD_SLOTS > 2n).
      const ck =
        (Math.floor(ay / cell) & 32767) * 32768 +
        (Math.floor(ax / cell) & 32767);
      let h = (Math.imul(ck, 0x9e3779b1) >>> 20) & (CROWD_SLOTS - 1);
      while (keys[h] !== -1 && keys[h] !== ck) h = (h + 1) & (CROWD_SLOTS - 1);
      if (keys[h] === -1) {
        keys[h] = ck;
        counts[h] = 0;
      }
      counts[h]++;
      slots[n] = h;
      const o = n * WAKE_STRIDE;
      data[o] = ax;
      data[o + 1] = ay;
      data[o + 2] = dx;
      data[o + 3] = dy;
      data[o + 4] = len;
      data[o + 5] = L;
      data[o + 6] = strength;
      data[o + 7] = w.odo;
      data[o + 8] = kind.wash;
      n++;
    }
    // Crowded spots (lanes, port queues): each wake dimmed by 1 / √n.
    for (let i = 0; i < n; i++) {
      const c = counts[slots[i]];
      if (c > 1) data[i * WAKE_STRIDE + 6] *= wakeCrowdDim(c);
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(0, n * WAKE_STRIDE);
      this.buffer.needsUpdate = true;
    }
    this.instances = n;
    this.culled = culled;
    this.capped = capped;
    if (perf) {
      this.jsMs = performance.now() - t0;
      this.jsHistory[this.jsIndex] = this.jsMs;
      this.jsIndex = (this.jsIndex + 1) % JS_WINDOW;
    }
  }

  /** Counters for the perf tool (layer `units`). */
  stats(): WakeStats {
    let max = 0;
    for (const v of this.jsHistory) max = Math.max(max, v);
    return {
      wakeInstances: this.instances,
      wakeCulled: this.culled,
      wakeCapped: this.capped,
      wakeJsMs: this.jsMs,
      wakeJsMsMax: max,
      wakeUploadKB: (this.instances * WAKE_STRIDE * 4) / 1024,
    };
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.terrain.release();
  }

  private refreshColors(): void {
    const t = this.ctx.renderSettings.terrain;
    refreshWaterUniforms(this.water, t);
    this.colorKey = waterColorKey(t);
  }
}
