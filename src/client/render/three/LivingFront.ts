/**
 * Living front (lot 4 prototype, `?three_front=1`): the moving parts drawn
 * from `FrontField` (TerrainLayer's), besides the capture wave which is in
 * the terrain shader.
 *
 * - `FrontParticles` (owned by FxLayer): smoke puffs and sparks at the
 *   field's border events (tiles just taken from another player that are
 *   still on a border), in two capped particle pools of FxLayer's own kind
 *   (its smoke and glow materials: no new program). At most
 *   `FRONT_SPAWN_PER_FRAME` events per frame, picked uniformly among the
 *   events in view, younger than `FRONT_EVENT_MAX_AGE_MS` (no backlog after
 *   a stall) and kept by the zoom's density (`frontParticleLook`): none at
 *   full map, a few faint puffs at the default zoom, sparks from ~2.5 px
 *   per tile, so the whole map never turns into fog.
 * - `FrontArrows` (owned by OverlayLayer): animated chevrons along active
 *   fronts, from the attacker into the defender, one per front cluster
 *   (`FrontField.cluster` at a cell that keeps them ~150 CSS px apart:
 *   `frontArrowCell`), only for pairs with an active attack, the heaviest
 *   `FRONT_ARROW_CAP` in view. Coloured by the attacker, with a dark
 *   outline (the affiliation colour in the alt view); sized in CSS px by
 *   zoom and by the attack's troops (`frontArrowLook`); they glide between
 *   re-clusterings, and a front that stops fades out where it is. When two
 *   players attack each other in one cell only the heavier side gets an
 *   arrow (crossing chevrons would read as a "#"). One
 *   instanced draw call (2 triangles per arrow), drawn under the structure
 *   icons (render order) and under the DOM names.
 *
 * Nothing here is created without the flag.
 */

import * as THREE from "three";
import {
  FRONT_EVENT_CAPACITY,
  FRONT_SEGMENT_CELL,
  type FrontCluster,
  type FrontField,
} from "./FrontField";
import type { ParticleSpec } from "./FxLayer";
import { PALETTE_WIDTH } from "./PaletteView";
import { unitAffiliationRgb } from "./StructureIcons";
import type { FrameInfo, ThreeLayerContext } from "./types";

type Rgb = readonly [number, number, number];

/** What FrontParticles spawns into (FxLayer's ParticlePool). */
export interface ParticleSink {
  spawn(s: ParticleSpec, startMs: number): boolean;
  readonly size: number;
}

/** Ground surface height lookup (TerrainLayer / HeightField). */
export interface SurfaceSampler {
  surfaceAt(x: number, z: number): number;
}

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** NDC points cast by `viewGroundRect`: the corners and the centre. */
const VIEW_POINTS: readonly number[] = [-1, -1, 1, -1, 1, 1, -1, 1, 0, 0];

/**
 * Tile rectangle [x0, z0, x1, z1] seen by the camera: the screen corners and
 * centre cast onto the sea plane (rays above the horizon capped at 3 camera
 * heights), clamped to the map (as FxLayer's fallout smoke).
 */
export function viewGroundRect(
  camera: THREE.Camera,
  W: number,
  H: number,
  out: Float64Array,
  ray: THREE.Vector3 = new THREE.Vector3(),
): Float64Array {
  out[0] = Infinity;
  out[1] = Infinity;
  out[2] = -Infinity;
  out[3] = -Infinity;
  const pos = camera.position;
  const cap = 3 * Math.max(1, pos.y);
  for (let c = 0; c < VIEW_POINTS.length; c += 2) {
    const dir = ray
      .set(VIEW_POINTS[c], VIEW_POINTS[c + 1], 0.5)
      .unproject(camera)
      .sub(pos)
      .normalize();
    const t = dir.y < -1e-3 ? Math.min(-pos.y / dir.y, cap / -dir.y) : cap;
    const x = pos.x + dir.x * t;
    const z = pos.z + dir.z * t;
    out[0] = Math.min(out[0], x);
    out[1] = Math.min(out[1], z);
    out[2] = Math.max(out[2], x);
    out[3] = Math.max(out[3], z);
  }
  out[0] = Math.max(0, out[0]);
  out[1] = Math.max(0, out[1]);
  out[2] = Math.min(W, out[2]);
  out[3] = Math.min(H, out[3]);
  return out;
}

// ---------------------------------------------------------------------------
// Smoke and sparks
// ---------------------------------------------------------------------------

/** Front smoke puffs alive at once (halved at low quality). */
export const FRONT_SMOKE_CAPACITY = 160;
/** Front sparks (and their pop flashes) alive at once (halved at low). */
export const FRONT_SPARK_CAPACITY = 240;
/** Border events turned into particles per frame at most (~48 per tick). */
export const FRONT_SPAWN_PER_FRAME = 8;
/** Border events older than this are skipped (no backlog after a stall). */
export const FRONT_EVENT_MAX_AGE_MS = 400;
/** Events outside the view by more than this (tiles) are skipped. */
const FRONT_VIEW_MARGIN = 4;
/** Drift of the front smoke (tiles/s, world xz; FalloutSmoke's wind). */
const FRONT_WIND: readonly [number, number] = [0.5, -0.35];
// Light warm grey smoke (linear; a dark puff seen from above reads as a
// stain on the ground, a light one as smoke).
const SMOKE_YOUNG: Rgb = [0.3, 0.28, 0.26];
const SMOKE_OLD: Rgb = [0.55, 0.53, 0.5];
const SPARK_HOT: Rgb = [3.2, 1.6, 0.45];
const SPARK_COOL: Rgb = [1.2, 0.3, 0.05];
const POP: Rgb = [2.4, 1.3, 0.5];

/** Particle density and look by zoom (CSS px per tile). */
export interface FrontParticleLook {
  /** Share of the border events that make smoke (0 = none). */
  rate: number;
  /** Peak opacity of a smoke puff. */
  smokeAlpha: number;
  /** Share of the smoking events that also throw sparks. */
  sparks: number;
  /** Puff size at birth, tiles (at least ~7 CSS px). */
  puffTiles: number;
  /** Spark size, tiles (at least ~3.5 CSS px). */
  sparkTiles: number;
}

/**
 * None at full map (0.7) and up to 1.3 px per tile; a few faint puffs at
 * the default zoom (1.8: ~8% of the events, 0.21 opacity); all of them from
 * 4 (0.38). Sparks from 2.5, all from 5.
 */
export function frontParticleLook(
  cssPxPerTile: number,
  out: FrontParticleLook = {
    rate: 0,
    smokeAlpha: 0,
    sparks: 0,
    puffTiles: 0,
    sparkTiles: 0,
  },
): FrontParticleLook {
  const z = Math.max(1e-3, cssPxPerTile);
  const rate = smoothstep(1.3, 4, z);
  out.rate = rate;
  out.smokeAlpha = 0.38 * (0.5 + 0.5 * rate);
  out.sparks = smoothstep(2.5, 5, z);
  out.puffTiles = Math.max(1.6, 7 / z);
  out.sparkTiles = Math.max(0.35, 3.5 / z);
  return out;
}

/**
 * The reverse pair's cluster key (B → A in the same cell as A → B), from a
 * `FrontField.cluster` key (cell · 4096² + attacker · 4096 + defender).
 */
export function reverseClusterKey(
  key: number,
  attacker: number,
  defender: number,
): number {
  const PAIR = 4096;
  return key - (attacker * PAIR + defender) + defender * PAIR + attacker;
}

/** Small seeded PRNG (mulberry32). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blankSpec(): ParticleSpec {
  return {
    delayMs: 0,
    lifeMs: 1000,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    drag: 0,
    grav: 0,
    size0: 1,
    size1: 1,
    color0: [1, 1, 1],
    color1: [1, 1, 1],
    colorTime: 1,
    alpha: 1,
    fadeIn: 0.05,
    hold: 0,
    rot: 0,
    spin: 0,
    twinkle: 0,
  };
}

/**
 * Whether border event `seq` makes smoke at density `rate` (a fixed
 * pseudo-random draw per event, so an event waiting over several frames
 * is not re-rolled).
 */
export function frontEventKept(seq: number, rate: number): boolean {
  return (Math.imul(seq, 0x9e3779b1) >>> 0) / 4294967296 < rate;
}

export class FrontParticles {
  /** Oldest border event that may still spawn (FrontField.eventCount space). */
  private readSeq = 0;
  /** The field the sequence numbers refer to. */
  private field: FrontField | null = null;
  /** Sequence number consumed per ring slot (-1 = none). */
  private readonly consumed = new Float64Array(FRONT_EVENT_CAPACITY).fill(-1);
  /** This frame's picks (reservoir), ring slots and sequence numbers. */
  private readonly pickSlot = new Int32Array(FRONT_SPAWN_PER_FRAME);
  private readonly pickSeq = new Float64Array(FRONT_SPAWN_PER_FRAME);
  private readonly rand = prng(0x5f0e7);
  private readonly spec = blankSpec();
  private readonly look = frontParticleLook(0);
  private readonly rect = new Float64Array(4);
  private readonly ray = new THREE.Vector3();
  /** Events turned into particles: last frame, total; JS ms of the last frame. */
  spawnedLastFrame = 0;
  spawnedTotal = 0;
  lastMs = 0;

  constructor(
    private readonly smoke: ParticleSink,
    private readonly sparks: ParticleSink,
  ) {}

  /** Live particles (both pools). */
  get size(): number {
    return this.smoke.size + this.sparks.size;
  }

  update(
    frame: FrameInfo,
    field: FrontField | null,
    surface: SurfaceSampler,
  ): void {
    const t0 = performance.now();
    this.spawnedLastFrame = 0;
    if (field === null) {
      this.lastMs = performance.now() - t0;
      return;
    }
    if (field !== this.field) {
      this.field = field;
      this.readSeq = 0;
      this.consumed.fill(-1);
    }
    const look = frontParticleLook(frame.cssPxPerTile, this.look);
    const end = field.eventCount;
    if (look.rate <= 0) {
      // Zoomed out: skip the events (no backlog when zooming in).
      this.readSeq = end;
      this.lastMs = performance.now() - t0;
      return;
    }
    const rect = viewGroundRect(
      frame.camera,
      field.width,
      field.height,
      this.rect,
      this.ray,
    );
    const m = FRONT_VIEW_MARGIN;
    const now = frame.nowMs;
    const K = FRONT_SPAWN_PER_FRAME;
    // Events younger than FRONT_EVENT_MAX_AGE_MS, kept by the zoom's
    // density, in view and not used yet: K of them, picked uniformly
    // (reservoir), so every front in view gets its share; the others stay
    // eligible for the next frames until they are too old.
    let i = Math.max(this.readSeq, end - FRONT_EVENT_CAPACITY);
    while (
      i < end &&
      now - field.eventTime[i % FRONT_EVENT_CAPACITY] > FRONT_EVENT_MAX_AGE_MS
    ) {
      i++;
    }
    this.readSeq = i;
    let seen = 0;
    for (; i < end; i++) {
      const e = i % FRONT_EVENT_CAPACITY;
      if (this.consumed[e] === i || !frontEventKept(i, look.rate)) continue;
      const x = field.eventX[e];
      const z = field.eventY[e];
      if (
        x < rect[0] - m ||
        x > rect[2] + m ||
        z < rect[1] - m ||
        z > rect[3] + m ||
        // Only where the front still is (it may have moved on since).
        !field.onBorder(Math.floor(x), Math.floor(z))
      ) {
        continue;
      }
      seen++;
      const j = seen <= K ? seen - 1 : Math.floor(this.rand() * seen);
      if (j < K) {
        this.pickSlot[j] = e;
        this.pickSeq[j] = i;
      }
    }
    const spawned = Math.min(K, seen);
    for (let k = 0; k < spawned; k++) {
      const e = this.pickSlot[k];
      this.consumed[e] = this.pickSeq[k];
      const x = field.eventX[e];
      const z = field.eventY[e];
      this.emit(x, z, surface.surfaceAt(x, z), look, now);
    }
    this.spawnedLastFrame = spawned;
    this.spawnedTotal += spawned;
    this.lastMs = performance.now() - t0;
  }

  /** One smoke puff, and (by zoom) a pop and 2-3 sparks, at (x, y, z). */
  private emit(
    x: number,
    z: number,
    y: number,
    look: FrontParticleLook,
    now: number,
  ): void {
    const r = this.rand;
    const s = this.spec;
    const delay = r() * 90;
    // Smoke: rises, drifts downwind and grows, dissolving as it does.
    s.delayMs = delay;
    s.lifeMs = 1300 + 600 * r();
    s.x = x + (r() - 0.5) * 0.8;
    s.y = y + 0.6;
    s.z = z + (r() - 0.5) * 0.8;
    s.vx = FRONT_WIND[0] * (0.7 + 0.6 * r()) + (r() - 0.5) * 0.3;
    s.vy = 0.8 + 0.6 * r();
    s.vz = FRONT_WIND[1] * (0.7 + 0.6 * r()) + (r() - 0.5) * 0.3;
    s.drag = 0.35;
    s.grav = -0.05;
    s.size0 = look.puffTiles * (0.8 + 0.4 * r());
    s.size1 = s.size0 * (2.8 + 0.8 * r());
    s.color0 = SMOKE_YOUNG;
    s.color1 = SMOKE_OLD;
    s.colorTime = 0.7;
    s.alpha = look.smokeAlpha;
    s.fadeIn = 0.15;
    s.hold = 0;
    s.rot = r() * Math.PI * 2;
    s.spin = (r() - 0.5) * 0.4;
    s.twinkle = 0;
    this.smoke.spawn(s, now);
    if (look.sparks <= 0 || r() >= look.sparks) return;
    // A short pop where the tile fell, then sparks on ballistic arcs.
    s.delayMs = delay;
    s.lifeMs = 160;
    s.x = x;
    s.y = y + 0.4;
    s.z = z;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.drag = 0;
    s.grav = 0;
    s.size0 = look.sparkTiles * 3;
    s.size1 = look.sparkTiles * 4.5;
    s.color0 = POP;
    s.color1 = SPARK_COOL;
    s.colorTime = 1;
    s.alpha = 0.8;
    s.fadeIn = 0.05;
    s.hold = 0;
    s.spin = 0;
    this.sparks.spawn(s, now);
    const n = 2 + (r() < 0.5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2;
      const v = 1.5 + 2 * r();
      s.delayMs = delay + 20 * k;
      s.lifeMs = 350 + 350 * r();
      s.x = x;
      s.y = y + 0.4;
      s.z = z;
      s.vx = Math.cos(a) * v;
      s.vy = 2.5 + 2.5 * r();
      s.vz = Math.sin(a) * v;
      s.drag = 1.5;
      s.grav = 9;
      s.size0 = look.sparkTiles;
      s.size1 = look.sparkTiles * 0.5;
      s.color0 = SPARK_HOT;
      s.color1 = SPARK_COOL;
      s.colorTime = 0.8;
      s.alpha = 1;
      s.fadeIn = 0.02;
      s.hold = 0.2;
      s.twinkle = 0.4;
      this.sparks.spawn(s, now);
    }
  }
}

// ---------------------------------------------------------------------------
// Attack arrows
// ---------------------------------------------------------------------------

/** Arrows drawn at most. */
export const FRONT_ARROW_CAP = 32;
/** Target spacing of the arrows, CSS px (sets the cluster cell). */
export const FRONT_ARROW_SPACING_PX = 150;
/** Clusters below this decayed capture weight get no arrow. */
export const FRONT_ARROW_MIN_WEIGHT = 6;
/**
 * Nor clusters whose front stopped: recent weight (FrontCluster.recent,
 * ≈ 3 × captures per tick) under this, about 2 captures per tick.
 */
export const FRONT_ARROW_MIN_RECENT = 6;
/** Fade in of an arrow, ms. */
export const FRONT_ARROW_FADE_MS = 450;
/** Fade out (frozen in place: no ghost drifting behind the front), ms. */
export const FRONT_ARROW_FADE_OUT_MS = 200;
/** Re-clustering period, ms (the arrows glide in between). */
export const FRONT_ARROW_CLUSTER_MS = 100;
/** Largest cluster cell, tiles. */
const FRONT_ARROW_MAX_CELL = 512;
/** Gliding time constant of position and direction, ms. */
const FRONT_ARROW_GLIDE_MS = 250;
const ARROW_RENDER_ORDER = 12;

/**
 * Cluster cell (tiles) at a zoom: the power-of-two multiple of
 * FRONT_SEGMENT_CELL closest to FRONT_ARROW_SPACING_PX on screen, at most
 * 512 (full map 0.7 → 256, default 1.8 → 64, 5 and up → 32).
 */
export function frontArrowCell(cssPxPerTile: number): number {
  const want = FRONT_ARROW_SPACING_PX / Math.max(1e-3, cssPxPerTile);
  const k = Math.round(Math.log2(Math.max(1, want / FRONT_SEGMENT_CELL)));
  return Math.min(
    FRONT_ARROW_MAX_CELL,
    FRONT_SEGMENT_CELL * 2 ** Math.max(0, k),
  );
}

/** Arrow size in CSS px (length tail to head, width) and opacity. */
export interface FrontArrowLook {
  lengthPx: number;
  widthPx: number;
  alpha: number;
}

/**
 * Subtle at full map (32 px long, 0.75 opacity: the name labels stay
 * readable), richer close up (64 px, 0.92, from 5 px per tile; 84 px from
 * 12); × 0.85-1.15 by the attack's troops (1k → 1M, log scale).
 */
export function frontArrowLook(
  cssPxPerTile: number,
  troops: number,
  out: FrontArrowLook = { lengthPx: 0, widthPx: 0, alpha: 0 },
): FrontArrowLook {
  const near = smoothstep(0.7, 5, cssPxPerTile);
  const close = smoothstep(6, 12, cssPxPerTile);
  const tf = Math.min(
    1,
    Math.max(0, (Math.log10(Math.max(1, troops)) - 3) / 3),
  );
  out.lengthPx = (32 + 32 * near + 20 * close) * (0.85 + 0.3 * tf);
  out.widthPx = 0.5 * out.lengthPx;
  out.alpha = 0.75 + 0.17 * near;
  return out;
}

/**
 * Arrow colour (linear rgb) from the attacker's territory colour (sRGB):
 * the same hue at full brightness, a fifth whitened, so a dark owner still
 * gives a light core against the dark outline.
 */
export function frontArrowColor(
  fill: ArrayLike<number>,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const m = Math.max(fill[0], fill[1], fill[2], 0.05);
  for (let c = 0; c < 3; c++) {
    const v = Math.min(1, fill[c] / m);
    out[c] = toLinear(v + (1 - v) * 0.2);
  }
  return out;
}

const ARROW_VERT = /* glsl */ `
attribute vec3 iCenter;
attribute vec4 iAxis;   // unit direction (x, z), half length, half width (tiles)
attribute vec4 iColor;  // linear rgb, alpha
attribute vec3 iParams; // half length, half width (CSS px), phase
varying vec2 vP;
varying vec4 vColor;
varying vec3 vParams;
void main() {
  vec2 d = iAxis.xy;
  vec2 n = vec2(-d.y, d.x);
  vec2 xz = iCenter.xz + d * (position.x * iAxis.z) + n * (position.y * iAxis.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, iCenter.y, xz.y, 1.0);
  vP = position.xy;
  vColor = iColor;
  vParams = iParams;
}
`;

/**
 * Three chevrons marching from the tail to the head (fading in and out at
 * the ends, growing towards the head), coloured core in a dark outline so
 * they read on any territory. Distances in CSS px.
 */
const ARROW_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vP;
varying vec4 vColor;
varying vec3 vParams;
float segSd(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  float L = vParams.x;
  float Wd = vParams.y;
  vec2 p = vec2(vP.x * L, vP.y * Wd);
  float core = 0.0;
  float halo = 0.0;
  for (int i = 0; i < 3; i++) {
    float t = fract((float(i) + uTime * 0.9 + vParams.z) / 3.0);
    float sc = 0.7 + 0.3 * t;
    float cx = mix(-0.55 * L, 0.55 * L, t);
    vec2 q = vec2(p.x - cx, abs(p.y));
    float d = segSd(q, vec2(-0.5 * Wd * sc, 0.85 * Wd * sc), vec2(0.42 * Wd * sc, 0.0));
    float fade = sin(3.14159265 * t);
    float cw = 0.17 * Wd * sc;
    core = max(core, (1.0 - smoothstep(cw - 0.7, cw + 0.7, d)) * fade);
    halo = max(halo, (1.0 - smoothstep(cw + 1.4, cw + 2.8, d)) * fade);
  }
  float a = halo * vColor.a;
  if (a < 0.01) discard;
  vec3 col = mix(vec3(0.03), vColor.rgb, core / max(halo, 1e-3));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface ArrowState {
  attacker: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  tx: number;
  ty: number;
  tdx: number;
  tdy: number;
  troops: number;
  alpha: number;
  present: boolean;
  phase: number;
}

export class FrontArrows {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly center: THREE.InstancedBufferAttribute;
  private readonly axis: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly arrows = new Map<number, ArrowState>();
  private readonly clusters: FrontCluster[] = [];
  private readonly attrs: readonly THREE.InstancedBufferAttribute[];
  /** Keys accepted by the last re-clustering (mutual-attack test). */
  private readonly accepted = new Set<number>();
  /** Relation matrix for the alt view's affiliation colours. */
  private relations: Uint8Array | null = null;
  private relSize = 0;
  private readonly rect = new Float64Array(4);
  private readonly ray = new THREE.Vector3();
  private readonly rgb: [number, number, number] = [0, 0, 0];
  private readonly fill: [number, number, number] = [0, 0, 0];
  private readonly look: FrontArrowLook = { lengthPx: 0, widthPx: 0, alpha: 0 };
  private lastClusterMs = -Infinity;
  private lastCell = 0;
  /** Arrows drawn by the last update, candidate clusters, JS ms. */
  drawn = 0;
  candidates = 0;
  lastMs = 0;

  constructor(
    parent: THREE.Object3D,
    private readonly ctx: Pick<ThreeLayerContext, "palette" | "renderSettings">,
  ) {
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute("position", quad.getAttribute("position"));
    const inst = (size: number) => {
      const a = new THREE.InstancedBufferAttribute(
        new Float32Array(FRONT_ARROW_CAP * size),
        size,
      );
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.center = inst(3);
    this.axis = inst(4);
    this.color = inst(4);
    this.params = inst(3);
    geo.setAttribute("iCenter", this.center);
    geo.setAttribute("iAxis", this.axis);
    geo.setAttribute("iColor", this.color);
    geo.setAttribute("iParams", this.params);
    this.attrs = [this.center, this.axis, this.color, this.params];
    geo.instanceCount = 0;
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      name: "front-arrows",
      vertexShader: ARROW_VERT,
      fragmentShader: ARROW_FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = "front-arrows";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = ARROW_RENDER_ORDER;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Relation matrix (the facade's `updateRelations`): alt-view colours. */
  setRelations(data: Uint8Array, size: number): void {
    if (!(size > 0) || data.length < size * size) return;
    this.relations = data;
    this.relSize = size;
  }

  update(
    frame: FrameInfo,
    field: FrontField | null,
    surface: SurfaceSampler,
  ): void {
    const t0 = performance.now();
    const now = frame.nowMs;
    const zoom = Math.max(1e-3, frame.cssPxPerTile);
    if (field !== null) {
      const cell = frontArrowCell(zoom);
      if (
        cell !== this.lastCell ||
        now - this.lastClusterMs >= FRONT_ARROW_CLUSTER_MS
      ) {
        this.recluster(frame, field, cell);
      }
    }
    // Glide, fade, write the instances.
    const k = 1 - Math.exp(-Math.max(0, frame.dtMs) / FRONT_ARROW_GLIDE_MS);
    const fadeIn = Math.max(0, frame.dtMs) / FRONT_ARROW_FADE_MS;
    const fadeOut = Math.max(0, frame.dtMs) / FRONT_ARROW_FADE_OUT_MS;
    const pal = this.ctx.palette.data;
    const c = this.center.array as Float32Array;
    const ax = this.axis.array as Float32Array;
    const col = this.color.array as Float32Array;
    const pr = this.params.array as Float32Array;
    let n = 0;
    for (const [key, a] of this.arrows) {
      a.alpha = Math.min(
        1,
        Math.max(0, a.alpha + (a.present ? fadeIn : -fadeOut)),
      );
      if (!a.present && a.alpha <= 0) {
        this.arrows.delete(key);
        continue;
      }
      // A front that stopped fades out where it is (no glide).
      if (a.present) {
        a.x += (a.tx - a.x) * k;
        a.y += (a.ty - a.y) * k;
        a.dx += (a.tdx - a.dx) * k;
        a.dy += (a.tdy - a.dy) * k;
      }
      const len = Math.hypot(a.dx, a.dy);
      if (len < 1e-4 || n >= FRONT_ARROW_CAP) continue;
      const dx = a.dx / len;
      const dy = a.dy / len;
      const look = frontArrowLook(zoom, a.troops, this.look);
      const halfL = look.lengthPx / 2;
      const halfW = look.widthPx / 2;
      c[n * 3] = a.x;
      c[n * 3 + 1] = surface.surfaceAt(a.x, a.y) + 0.6;
      c[n * 3 + 2] = a.y;
      ax[n * 4] = dx;
      ax[n * 4 + 1] = dy;
      ax[n * 4 + 2] = halfL / zoom;
      ax[n * 4 + 3] = halfW / zoom;
      // The attacker's fill (palette row 0), or its affiliation colour in
      // the alt view, copied: no allocation.
      if (frame.altView) {
        unitAffiliationRgb(
          a.attacker,
          frame.localPlayerID,
          this.relations,
          this.relSize,
          this.ctx.renderSettings.affiliation,
          this.fill,
        );
      } else {
        const o = (a.attacker & (PALETTE_WIDTH - 1)) * 4;
        this.fill[0] = pal[o];
        this.fill[1] = pal[o + 1];
        this.fill[2] = pal[o + 2];
      }
      const rgb = frontArrowColor(this.fill, this.rgb);
      col[n * 4] = rgb[0];
      col[n * 4 + 1] = rgb[1];
      col[n * 4 + 2] = rgb[2];
      col[n * 4 + 3] = look.alpha * a.alpha * a.alpha * (3 - 2 * a.alpha);
      pr[n * 3] = halfL;
      pr[n * 3 + 1] = halfW;
      pr[n * 3 + 2] = a.phase;
      n++;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    this.drawn = n;
    if (n > 0) {
      for (const attr of this.attrs) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n * attr.itemSize);
        attr.needsUpdate = true;
      }
      this.material.uniforms.uTime.value = (now / 1000) % 3600;
    }
    this.lastMs = performance.now() - t0;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.arrows.clear();
  }

  /** New clusters: the heaviest in view become (or keep) arrows. */
  private recluster(frame: FrameInfo, field: FrontField, cell: number): void {
    const now = frame.nowMs;
    this.lastClusterMs = now;
    this.lastCell = cell;
    const list = this.clusters;
    const count = field.cluster(
      now,
      cell,
      FRONT_ARROW_MIN_WEIGHT,
      list,
      FRONT_ARROW_MIN_RECENT,
    );
    const rect = viewGroundRect(
      frame.camera,
      field.width,
      field.height,
      this.rect,
      this.ray,
    );
    const m = cell / 2;
    let inView = 0;
    for (let i = 0; i < count; i++) {
      const c = list[i];
      if (
        c.x < rect[0] - m ||
        c.x > rect[2] + m ||
        c.y < rect[1] - m ||
        c.y > rect[3] + m
      ) {
        continue;
      }
      list[i] = list[inView];
      list[inView++] = c;
    }
    this.candidates = inView;
    // Heaviest first (insertion sort of the prefix in place: no allocation;
    // a few dozen clusters at most).
    for (let i = 1; i < inView; i++) {
      const c = list[i];
      let j = i - 1;
      while (j >= 0 && list[j].w < c.w) {
        list[j + 1] = list[j];
        j--;
      }
      list[j + 1] = c;
    }
    for (const a of this.arrows.values()) a.present = false;
    const accepted = this.accepted;
    accepted.clear();
    for (let i = 0; i < inView && accepted.size < FRONT_ARROW_CAP; i++) {
      const c = list[i];
      // Mutual attacks in one cell: the heavier side only.
      if (accepted.has(reverseClusterKey(c.key, c.attacker, c.defender))) {
        continue;
      }
      accepted.add(c.key);
      let a = this.arrows.get(c.key);
      if (a === undefined) {
        a = {
          attacker: c.attacker,
          x: c.x,
          y: c.y,
          dx: c.dx,
          dy: c.dy,
          tx: c.x,
          ty: c.y,
          tdx: c.dx,
          tdy: c.dy,
          troops: c.troops,
          alpha: 0,
          present: true,
          phase: (c.key % 997) / 997,
        };
        this.arrows.set(c.key, a);
      }
      a.present = true;
      a.tx = c.x;
      a.ty = c.y;
      a.tdx = c.dx;
      a.tdy = c.dy;
      a.troops = c.troops;
    }
  }
}
