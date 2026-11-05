/**
 * OverlayLayer — interaction overlays drawn on the map: ghost build preview
 * (with its range ring), SAM range rings, the spawn-phase halos, nuke
 * trajectory arc, in-flight nuke telegraph rings, transport attack rings,
 * warship move indicator and the blocked-action flash.
 *
 * Everything on the ground drapes on the drawn surface (`ReliefSurface`:
 * the relief mesh's own triangles, or the sea plane), handed in by the
 * facade (TerrainLayer); without one (tests) the HeightField stands in.
 * - SAM range rings (`SamRings.ts`): draped ribbons, shown in build mode.
 * - Spawn halos (`SpawnOverlay.ts`): relief-grid patches around each
 *   spawn centre during the spawn phase.
 *
 * Three more kinds of drawables, all readable top-down and under tilt:
 * - Draped discs (`DrapedDiscs`): polar grids whose vertices follow the
 *   visible surface (+ a small lift), shaded by one shader — filled inner
 *   disc, outer ring (optionally dashed and rotating), pulse. Strokes are a
 *   coloured core framed by a dark outline so they read on any terrain or
 *   territory colour. Used for the nuke telegraphs (the default renderer's
 *   self / ally / enemy colours from render-settings `nukeTelegraph`) and
 *   the ghost's range ring. Stroke widths are in screen pixels
 *   (`uTilesPerPx`), so they stay crisp at every zoom.
 * - Screen-size markers (`MarkerPool`): flat quads lying on the surface,
 *   sized in CSS px and drawn on top of everything (depth test off), with an
 *   SDF shader per marker kind (attack ring, chevrons, blocked X, reticle,
 *   trajectory markers, footprint ring).
 * - The trajectory preview: a 3D arc with the same altitude model as flying
 *   nukes (`nukeAltitude`, NukeFlight.Arc) drawn with fat lines (white, dashed
 *   in the untargetable stretch, red after the first SAM intercept) over a
 *   dark halo, plus a faint dashed ground track.
 *
 * Lot 4 prototype, living front (`?three_front=1` only; nothing of it is
 * created otherwise): animated attack arrows from attacker into defender
 * along active fronts (`FrontArrows`, LivingFront.ts), fed by TerrainLayer's
 * `FrontField` (`setFront`), one instanced draw call.
 */

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { SpawnCenter } from "../gl/passes/SpawnOverlayPass";
import type { RenderSettings } from "../gl/RenderSettings";
import {
  STRUCTURE_TYPES,
  UT_MIRV,
  UT_WARSHIP,
  type AttackRingInput,
  type GhostPreviewData,
  type NukeTelegraphData,
  type NukeTrajectoryData,
  type UnitState,
} from "../types";
import type { FrontField } from "./FrontField";
import type { HeightField } from "./HeightField";
import { FrontArrows } from "./LivingFront";
import {
  createStructureGeometry,
  nextCapacity,
  setOwnerColor,
  STRUCTURE_FOOTPRINT,
} from "./ProceduralMeshes";
import { SamRangeRings } from "./SamRings";
import { SpawnOverlay } from "./SpawnOverlay";
import {
  iconFadeBand,
  modelFadeScaleX,
  modelFadeScaleY,
  modelWeightAt,
} from "./StructureIcons";
import { createIntegerTexture } from "./TerrainResources";
import type { FrameInfo, ReliefSurface, ThreeLayerContext } from "./types";
import { minScreenScale, nukeAltitude, NukeFlight } from "./UnitLayer";

type Rgb = readonly [number, number, number];

/**
 * Telegraph colours by launcher relation (0 self, 1 ally, 2 enemy): the
 * default renderer's sRGB settings, as linear rgb for the shaders.
 */
export function telegraphColors(
  t: RenderSettings["nukeTelegraph"],
): readonly Rgb[] {
  const lin = (r: number, g: number, b: number): Rgb => {
    const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
  };
  return [
    lin(t.selfColorR, t.selfColorG, t.selfColorB),
    lin(t.allyColorR, t.allyColorG, t.allyColorB),
    lin(t.colorR, t.colorG, t.colorB),
  ];
}
/** HDR gain of the move-indicator chevrons: a soft bloom glow. */
const MOVE_GLOW = 2;
const OK_COLOR: Rgb = [0.25, 0.95, 0.35];
const BAD_COLOR: Rgb = [1.0, 0.2, 0.18];
const WHITE: Rgb = [0.95, 0.95, 0.95];

/** Lift of draped overlays above the surface (tiles). */
const DRAPE_LIFT = 0.7;
/**
 * Ghost range ring fill: the default renderer fills the range at 20% white;
 * a little less here, over lit relief (the band alpha is fillAlpha / 3).
 */
export const RANGE_FILL_ALPHA = 0.45;
/** Ring spacing inside the ghost range disc's rim band (tiles). */
const RANGE_INTERIOR_SPACING = 10;
/** Render orders of the draped overlays (water is -10, sea overlay -9). */
const SPAWN_RENDER_ORDER = 5;
const SAM_RENDER_ORDER = 19;

/**
 * The HeightField as a `ReliefSurface` (bilinear heights, at least sea
 * level), for layers built without the terrain (tests).
 */
export function heightFieldSurface(hf: HeightField): ReliefSurface {
  return {
    get version() {
      return hf.version;
    },
    grid: hf,
    surfaceAt: (x, z) => hf.surfaceAt(x, z),
    vertexSurface: (i, j) => Math.max(0, hf.heights[j * hf.cols + i]),
    // Every tile unowned.
    tileTexture: createIntegerTexture(new Uint16Array(1), 1, 1, "R16UI"),
  };
}
const ATTACK_RING_FADE_IN_MS = 200;
const ATTACK_RING_FADE_OUT_MS = 300;
const MOVE_INDICATOR_MS = 800;
const BLOCKED_FLASH_MS = 600;

// ---------------------------------------------------------------------------
// Draped discs
// ---------------------------------------------------------------------------

export interface DiscSpec {
  /** Centre tile (the disc is centred on the tile centre, +0.5). */
  x: number;
  y: number;
  /** Radius of the filled inner disc (0 = none), tiles. */
  inner: number;
  /** Radius of the outer ring, tiles. */
  outer: number;
  color: Rgb;
  /** Alpha of the inner fill (the band between inner and outer gets ⅓). */
  fillAlpha: number;
  dashed: boolean;
}

const DISC_VERT = /* glsl */ `
attribute vec2 aDisc;
attribute vec4 aStyle;
attribute vec3 aColor;
varying vec2 vDisc;
varying vec4 vStyle;
varying vec3 vColor;
void main() {
  vDisc = aDisc;
  vStyle = aStyle;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DISC_FRAG = /* glsl */ `
uniform float uTime;
uniform float uTilesPerPx;
varying vec2 vDisc;   // (radius from the centre in tiles, angle 0..2pi)
varying vec4 vStyle;  // (inner, outer, fill alpha, dashed)
varying vec3 vColor;
void main() {
  float r = vDisc.x;
  float inner = vStyle.x;
  float outer = vStyle.y;
  float px = uTilesPerPx;
  float pulse = 0.85 + 0.15 * sin(uTime * 3.0);
  float dash = 1.0;
  if (vStyle.w > 0.5) {
    // An integer number of ~18 px dashes around the circle, rotating.
    float n = max(8.0, floor(6.2831853 * outer / (18.0 * px) + 0.5));
    float f = fract(vDisc.y / 6.2831853 * n - uTime * 0.35);
    dash = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.6, 0.66, f));
  }
  // Strokes (widths in px): a coloured core inside a dark outline.
  // Outer ring: 5.5 px band at the edge, core 1..4 px in from it.
  float e = outer - r;
  float ringHalo = (1.0 - smoothstep(5.0 * px, 6.0 * px, e)) * dash;
  float ringCore = smoothstep(0.8 * px, 1.6 * px, e)
                 * (1.0 - smoothstep(3.6 * px, 4.4 * px, e)) * dash;
  // Inner circle line: core ±1 px, outline ±2.6 px.
  float di = abs(r - inner);
  float innerHalo = inner > 0.0 ? 1.0 - smoothstep(2.2 * px, 3.0 * px, di) : 0.0;
  float innerCore = inner > 0.0 ? 1.0 - smoothstep(0.8 * px, 1.4 * px, di) : 0.0;
  float halo = max(ringHalo, innerHalo);
  float core = max(ringCore, innerCore);
  float strokeA = halo * 0.92 * pulse;
  vec3 strokeCol = mix(vec3(0.03), vColor, core / max(halo, 1e-3));
  float fill = r < inner ? vStyle.z * pulse : vStyle.z * 0.33;
  // Stroke over fill ("over" compositing).
  float a = strokeA + fill * (1.0 - strokeA);
  if (a < 0.003) discard;
  vec3 col = (strokeCol * strokeA + vColor * fill * (1.0 - strokeA)) / a;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Cached surface-draped polar grid of one disc (positions only). */
interface DiscChunk {
  positions: Float32Array;
  /** (r, angle) per vertex. */
  polar: Float32Array;
  index: Uint32Array;
  vertexCount: number;
}

/** Rim spacing of the disc grids (tiles). */
const DISC_RIM_SPACING = 2;
/** Most segments around a disc (rims of up to ~120 tiles keep 2 tiles). */
const DISC_MAX_SEGS = 384;

/**
 * Polar grid of a disc of `outer` tiles: segments ~2 tiles apart on the rim,
 * and ring radii every ≤ `interior` tiles inside plus a 1-tile band at the
 * rim (3 rings), where the stroke is. On the World map this keeps the rim
 * stroke above the relief everywhere with DRAPE_LIFT (the old 3-tile rings
 * and ≤ 96 segments let it dip up to ~1.3 tiles under ridges).
 */
export function discGrid(
  outer: number,
  interior = 4,
): { segs: number; radii: number[] } {
  const segs = Math.min(
    DISC_MAX_SEGS,
    Math.max(32, Math.ceil((2 * Math.PI * outer) / DISC_RIM_SPACING)),
  );
  const radii: number[] = [];
  const band = Math.max(0, outer - 3);
  const inner = Math.max(1, Math.ceil(band / interior));
  if (band > 0) for (let k = 1; k <= inner; k++) radii.push((band * k) / inner);
  for (const d of [2, 1, 0]) {
    const r = outer - d;
    if (r > (radii[radii.length - 1] ?? 0) + 1e-6) radii.push(r);
  }
  return { segs, radii };
}

/**
 * Builds the draped grid: a centre vertex plus one ring of `segs + 1`
 * vertices per radius (the seam vertex is duplicated with angle 2π so the
 * angle attribute never wraps inside a triangle).
 */
function buildDiscChunk(
  hf: ReliefSurface,
  cx: number,
  cy: number,
  outer: number,
  interior: number,
): DiscChunk {
  const { segs, radii } = discGrid(outer, interior);
  const rings = radii.length;
  const cols = segs + 1;
  const vertexCount = 1 + rings * cols;
  const positions = new Float32Array(vertexCount * 3);
  const polar = new Float32Array(vertexCount * 2);
  positions[0] = cx;
  positions[1] = hf.surfaceAt(cx, cy) + DRAPE_LIFT;
  positions[2] = cy;
  for (let k = 1; k <= rings; k++) {
    const r = radii[k - 1];
    for (let s = 0; s < cols; s++) {
      const a = (s / segs) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const v = 1 + (k - 1) * cols + s;
      positions[v * 3] = x;
      positions[v * 3 + 1] = hf.surfaceAt(x, y) + DRAPE_LIFT;
      positions[v * 3 + 2] = y;
      polar[v * 2] = r;
      polar[v * 2 + 1] = a;
    }
  }
  const index = new Uint32Array(segs * 3 + (rings - 1) * segs * 6);
  let o = 0;
  for (let s = 0; s < segs; s++) {
    index[o++] = 0;
    index[o++] = 1 + s + 1;
    index[o++] = 1 + s;
  }
  for (let k = 1; k < rings; k++) {
    const a0 = 1 + (k - 1) * cols;
    const b0 = 1 + k * cols;
    for (let s = 0; s < segs; s++) {
      const a = a0 + s;
      const b = b0 + s;
      index[o++] = a;
      index[o++] = a + 1;
      index[o++] = b;
      index[o++] = a + 1;
      index[o++] = b + 1;
      index[o++] = b;
    }
  }
  return { positions, polar, index, vertexCount };
}

/**
 * A set of draped discs merged into one mesh. `setDiscs` rebuilds the merged
 * buffers only when the list (or the terrain) changed; the draped grids are
 * cached per (centre, radius) so per-tick telegraph refreshes are cheap.
 */
class DrapedDiscs {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly chunks = new Map<string, DiscChunk>();
  private signature = "";
  private heightVersion = -1;
  private vertCap = 0;
  private indexCap = 0;
  private positions = new Float32Array(0);
  private polar = new Float32Array(0);
  private style = new Float32Array(0);
  private colors = new Float32Array(0);
  private index = new Uint32Array(0);

  constructor(
    parent: THREE.Object3D,
    name: string,
    renderOrder: number,
    private readonly hf: ReliefSurface,
    /** Ring spacing inside the rim band (tiles). */
    private readonly interior = 4,
  ) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: DISC_VERT,
      fragmentShader: DISC_FRAG,
      uniforms: { uTime: { value: 0 }, uTilesPerPx: { value: 1 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  setDiscs(discs: readonly DiscSpec[]): void {
    let sig = "";
    for (const d of discs) {
      sig += `${d.x},${d.y},${d.inner},${d.outer},${d.color.join(",")},${d.fillAlpha},${d.dashed ? 1 : 0};`;
    }
    if (sig === this.signature && this.hf.version === this.heightVersion) {
      return;
    }
    this.signature = sig;
    if (this.hf.version !== this.heightVersion) {
      this.heightVersion = this.hf.version;
      this.chunks.clear();
    }
    const used = new Map<string, DiscChunk>();
    let verts = 0;
    let indices = 0;
    const list: [DiscChunk, DiscSpec][] = [];
    for (const d of discs) {
      if (!(d.outer > 0)) continue;
      const key = `${d.x},${d.y},${d.outer}`;
      let chunk = used.get(key) ?? this.chunks.get(key);
      chunk ??= buildDiscChunk(
        this.hf,
        d.x + 0.5,
        d.y + 0.5,
        d.outer,
        this.interior,
      );
      used.set(key, chunk);
      list.push([chunk, d]);
      verts += chunk.vertexCount;
      indices += chunk.index.length;
    }
    // Keep only the grids still in use.
    this.chunks.clear();
    for (const [k, c] of used) this.chunks.set(k, c);

    if (indices === 0) {
      this.mesh.visible = false;
      return;
    }
    this.ensure(verts, indices);
    let v = 0;
    let ii = 0;
    for (const [chunk, d] of list) {
      this.positions.set(chunk.positions, v * 3);
      this.polar.set(chunk.polar, v * 2);
      for (let k = 0; k < chunk.vertexCount; k++) {
        const s = (v + k) * 4;
        this.style[s] = d.inner;
        this.style[s + 1] = d.outer;
        this.style[s + 2] = d.fillAlpha;
        this.style[s + 3] = d.dashed ? 1 : 0;
        const c = (v + k) * 3;
        this.colors[c] = d.color[0];
        this.colors[c + 1] = d.color[1];
        this.colors[c + 2] = d.color[2];
      }
      for (let k = 0; k < chunk.index.length; k++) {
        this.index[ii + k] = chunk.index[k] + v;
      }
      v += chunk.vertexCount;
      ii += chunk.index.length;
    }
    const g = this.mesh.geometry;
    for (const name of ["position", "aDisc", "aStyle", "aColor"]) {
      g.getAttribute(name).needsUpdate = true;
    }
    const idx = g.getIndex();
    if (idx !== null) idx.needsUpdate = true;
    g.setDrawRange(0, ii);
    this.mesh.visible = true;
  }

  update(frame: FrameInfo): void {
    this.material.uniforms.uTime.value = frame.nowMs / 1000;
    this.material.uniforms.uTilesPerPx.value =
      1 / Math.max(1e-3, frame.cssPxPerTile);
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.chunks.clear();
  }

  /** Grows the merged buffers (doubling) with a fresh geometry. */
  private ensure(verts: number, indices: number): void {
    if (verts <= this.vertCap && indices <= this.indexCap) return;
    this.vertCap = nextCapacity(this.vertCap, verts);
    this.indexCap = nextCapacity(this.indexCap, indices);
    this.positions = new Float32Array(this.vertCap * 3);
    this.polar = new Float32Array(this.vertCap * 2);
    this.style = new Float32Array(this.vertCap * 4);
    this.colors = new Float32Array(this.vertCap * 3);
    this.index = new Uint32Array(this.indexCap);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute("aDisc", new THREE.BufferAttribute(this.polar, 2));
    g.setAttribute("aStyle", new THREE.BufferAttribute(this.style, 4));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.colors, 3));
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    const old = this.mesh.geometry;
    this.mesh.geometry = g;
    old.dispose();
  }
}

// ---------------------------------------------------------------------------
// Screen-size markers
// ---------------------------------------------------------------------------

/** Marker shapes understood by MARKER_FRAG. */
export const MarkerKind = {
  AttackRing: 0,
  MoveChevrons: 1,
  BlockedX: 2,
  Reticle: 3,
  Circle: 4,
  Cross: 5,
  Footprint: 6,
} as const;
export type MarkerKind = (typeof MarkerKind)[keyof typeof MarkerKind];

const MARKER_VERT = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/*
 * Every distance below is in CSS px from the marker centre: p = vLocal ·
 * uHalfPx. `stroke(d, w)` is an anti-aliased band of half-width w px.
 */
const MARKER_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGain;
uniform float uAlpha;
uniform float uKind;
uniform float uTime;
uniform float uProgress;
uniform float uHalfPx;
uniform float uParam;
varying vec2 vLocal;

const float PI2 = 6.2831853;

float segSd(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float stroke(float d, float w) {
  return 1.0 - smoothstep(w - 0.6, w + 0.6, d);
}
float dashes(float ang, float n, float duty) {
  float f = fract(ang / PI2 * n);
  return smoothstep(0.0, 0.05, f) * (1.0 - smoothstep(duty, duty + 0.05, f));
}
// V chevron pointing along +y: wings at (+-w, -wing), tip at (0, tip).
float chevron(vec2 p, float w, float tip, float wing) {
  p.x = abs(p.x);
  return segSd(p, vec2(w, -wing), vec2(0.0, tip));
}
float crossSd(vec2 p, float arm) {
  return min(segSd(p, vec2(-arm), vec2(arm)), segSd(p, vec2(-arm, arm), vec2(arm, -arm)));
}

void main() {
  vec2 p = vLocal * uHalfPx;
  float d = length(p);
  float ang = atan(p.y, p.x);
  int kind = int(uKind + 0.5);
  vec3 col = uColor;
  float a = 0.0;

  if (kind == 0) {
    // Attack ring: dashed inner ring + two counter-rotating outer arcs.
    float innerR = stroke(abs(d - 7.5), 1.0) * dashes(ang + uTime * 1.2, 8.0, 0.55);
    float outerR = stroke(abs(d - 12.5), 1.6) * dashes(ang - uTime * 0.6, 2.0, 0.6);
    a = max(innerR, outerR);
  } else if (kind == 1) {
    // Move indicator: four chevrons converging on the target.
    float t = uProgress;
    float sc = uParam;
    float radius = 16.0 * sc * (1.0 - 0.7 * t);
    float cs = 5.0 * sc;
    float tip = cs * 0.4;
    float wing = cs * 0.6;
    float dd = chevron(vec2(p.x, -(p.y - radius)), cs, tip, wing);
    dd = min(dd, chevron(vec2(p.x, p.y + radius), cs, tip, wing));
    dd = min(dd, chevron(vec2(p.y, -(p.x - radius)), cs, tip, wing));
    dd = min(dd, chevron(vec2(p.y, p.x + radius), cs, tip, wing));
    a = stroke(dd, 1.1 * sc) * (1.0 - t);
  } else if (kind == 2) {
    // Blocked: bold red X with a dark outline and an expanding ring.
    float t = uProgress;
    float dx = crossSd(p, 11.0);
    float line = stroke(dx, 2.6);
    float outline = stroke(dx, 4.2);
    col = mix(vec3(0.08), uColor, line / max(outline, 1e-3));
    float ring = stroke(abs(d - mix(10.0, 30.0, t)), 1.6) * (1.0 - t);
    a = max(outline, ring) * (1.0 - t * t);
  } else if (kind == 3) {
    // Reticle: circle, four ticks with a gap at the centre, centre dot.
    float circle = stroke(abs(d - 12.0), 1.2);
    vec2 q = abs(p);
    float ticks = min(segSd(q, vec2(5.0, 0.0), vec2(18.0, 0.0)),
                      segSd(q, vec2(0.0, 5.0), vec2(0.0, 18.0)));
    a = max(max(circle, stroke(ticks, 1.1)), stroke(d, 1.6));
  } else if (kind == 4) {
    // Trajectory zone boundary: white ring with a grey outline.
    float line = stroke(abs(d - 4.0), 1.0);
    float outline = stroke(abs(d - 4.0), 2.0);
    col = mix(vec3(0.55), uColor, line / max(outline, 1e-3));
    a = outline;
  } else if (kind == 5) {
    // SAM intercept: red X with a black outline.
    float dx = crossSd(p, 6.0);
    float line = stroke(dx, 1.4);
    float outline = stroke(dx, 2.6);
    col = mix(vec3(0.0), uColor, line / max(outline, 1e-3));
    a = outline;
  } else {
    // Footprint ring of radius uParam px with a faint fill, pulsing.
    float pulse = 0.8 + 0.2 * sin(uTime * 5.0);
    a = max(stroke(abs(d - uParam), 1.3) * pulse, (d < uParam ? 0.12 : 0.0));
  }
  a *= uAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface MarkerDraw {
  kind: MarkerKind;
  /** World position of the marker centre (three coords). */
  x: number;
  y: number;
  z: number;
  /** Half size of the quad in CSS px. */
  halfPx: number;
  color: Rgb;
  alpha: number;
  progress?: number;
  param?: number;
  /** HDR colour gain (> 1 glows under bloom); default 1. */
  gain?: number;
}

/**
 * A pool of flat, surface-aligned quads, each with its own material clone
 * (same program) so uniforms are per marker. `begin`, `draw`…, `end` per
 * frame; unused quads are hidden.
 */
class MarkerPool {
  private readonly geometry = new THREE.PlaneGeometry(2, 2).rotateX(
    -Math.PI / 2,
  );
  private readonly base = new THREE.ShaderMaterial({
    vertexShader: MARKER_VERT,
    fragmentShader: MARKER_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uGain: { value: 1 },
      uAlpha: { value: 1 },
      uKind: { value: 0 },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uHalfPx: { value: 16 },
      uParam: { value: 0 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly meshes: THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.ShaderMaterial
  >[] = [];
  private used = 0;
  private timeSec = 0;
  private cssPxPerTile = 1;

  constructor(private readonly parent: THREE.Object3D) {}

  begin(frame: FrameInfo): void {
    this.used = 0;
    this.timeSec = frame.nowMs / 1000;
    this.cssPxPerTile = Math.max(1e-3, frame.cssPxPerTile);
  }

  draw(m: MarkerDraw): void {
    let mesh = this.meshes[this.used];
    if (mesh === undefined) {
      mesh = new THREE.Mesh(this.geometry, this.base.clone());
      mesh.name = "overlay-marker";
      mesh.renderOrder = 40;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.parent.add(mesh);
    }
    this.used++;
    const u = mesh.material.uniforms;
    (u.uColor.value as THREE.Color).setRGB(m.color[0], m.color[1], m.color[2]);
    u.uGain.value = m.gain ?? 1;
    u.uAlpha.value = m.alpha;
    u.uKind.value = m.kind;
    u.uTime.value = this.timeSec;
    u.uProgress.value = m.progress ?? 0;
    u.uHalfPx.value = m.halfPx;
    u.uParam.value = m.param ?? 0;
    const half = m.halfPx / this.cssPxPerTile;
    mesh.position.set(m.x, m.y, m.z);
    mesh.scale.set(half, 1, half);
    mesh.visible = true;
  }

  end(): void {
    for (let i = this.used; i < this.meshes.length; i++) {
      this.meshes[i].visible = false;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.parent.remove(mesh);
      mesh.material.dispose();
    }
    this.meshes.length = 0;
    this.geometry.dispose();
    this.base.dispose();
  }
}

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

/** Bézier samples of the trajectory preview (plus the zone boundaries). */
const TRAJECTORY_SAMPLES = 96;

/** Point of the cubic Bézier of `d` at t (tile coords, before +0.5). */
function bezier(d: NukeTrajectoryData, t: number): [number, number] {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return [
    b0 * d.p0x + b1 * d.p1x + b2 * d.p2x + b3 * d.p3x,
    b0 * d.p0y + b1 * d.p1y + b2 * d.p2y + b3 * d.p3y,
  ];
}

/**
 * World points of the trajectory preview at the given t values: ground track
 * = Bézier + tile centre offset; altitude from the in-flight nuke model so
 * the preview matches the missile that will fly it.
 */
export function trajectoryPoints(
  d: NukeTrajectoryData,
  ts: readonly number[],
  surfaceAt: (x: number, y: number) => number,
): { x: number; y: number; ground: number; alt: number }[] {
  const ox = d.p0x + 0.5;
  const oy = d.p0y + 0.5;
  const tx = d.p3x + 0.5;
  const ty = d.p3y + 0.5;
  const span = Math.hypot(tx - ox, ty - oy);
  return ts.map((t) => {
    const [bx, by] = bezier(d, t);
    const x = bx + 0.5;
    const y = by + 0.5;
    const dO = Math.hypot(x - ox, y - oy);
    const dT = Math.hypot(tx - x, ty - y);
    const alt = nukeAltitude(NukeFlight.Arc, dO, dT, span).altitude;
    return { x, y, ground: surfaceAt(x, y), alt };
  });
}

function sameTrajectory(a: NukeTrajectoryData, b: NukeTrajectoryData): boolean {
  return (
    a.p0x === b.p0x &&
    a.p0y === b.p0y &&
    a.p1x === b.p1x &&
    a.p1y === b.p1y &&
    a.p2x === b.p2x &&
    a.p2y === b.p2y &&
    a.p3x === b.p3x &&
    a.p3y === b.p3y &&
    a.tUntargetableStart === b.tUntargetableStart &&
    a.tUntargetableEnd === b.tUntargetableEnd &&
    a.tSamIntercept === b.tSamIntercept
  );
}

interface FatLine {
  line: LineSegments2;
  material: LineMaterial;
}

function fatLine(
  parent: THREE.Object3D,
  name: string,
  renderOrder: number,
  params: ConstructorParameters<typeof LineMaterial>[0],
): FatLine {
  const material = new LineMaterial({
    transparent: true,
    depthWrite: false,
    ...params,
  });
  const line = new LineSegments2(new LineSegmentsGeometry(), material);
  line.name = name;
  line.renderOrder = renderOrder;
  line.frustumCulled = false;
  line.visible = false;
  parent.add(line);
  return { line, material };
}

/** Replaces a fat line's segments (pairs of xyz points, rgb per point). */
function setSegments(
  fl: FatLine,
  positions: number[],
  colors: number[] | null,
): void {
  const old = fl.line.geometry;
  if (positions.length === 0) {
    fl.line.visible = false;
    return;
  }
  const g = new LineSegmentsGeometry();
  g.setPositions(positions);
  if (colors !== null) g.setColors(colors);
  fl.line.geometry = g;
  old.dispose();
  if (fl.material.dashed) fl.line.computeLineDistances();
  fl.line.visible = true;
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

interface AttackRingState {
  x: number;
  y: number;
  bornMs: number;
  goneMs: number | null;
}

interface TimedMarker {
  x: number;
  y: number;
  startMs: number;
  color: Rgb;
}

export class OverlayLayer {
  private readonly group = new THREE.Group();
  private readonly hf: ReliefSurface;
  /** True when `hf` is our own HeightField stand-in (disposed with us). */
  private readonly ownsSurface: boolean;
  private readonly telegraphs: DrapedDiscs;
  private readonly rangeRing: DrapedDiscs;
  private readonly markers: MarkerPool;
  private readonly samRings: SamRangeRings;
  private readonly spawn: SpawnOverlay;

  // Trajectory preview.
  private trajectory: NukeTrajectoryData | null = null;
  private trajectoryVersion = -1;
  private readonly arcHalo: FatLine;
  private readonly arcSolid: FatLine;
  private readonly arcDashed: FatLine;
  private readonly groundTrack: FatLine;
  private trajectoryMarkers: MarkerDraw[] = [];

  // Ghost preview.
  private ghost: GhostPreviewData | null = null;
  private readonly ghostGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly ghostMaterial: THREE.MeshStandardMaterial;
  private readonly ghostMesh: THREE.Mesh;
  /** The ghost is a structure with a 3D model (shown per the crossfade). */
  private ghostModel = false;

  private readonly relationColors: readonly Rgb[];
  private readonly attackRings = new Map<number, AttackRingState>();
  private moveIndicators: TimedMarker[] = [];
  private blockedFlashes: TimedMarker[] = [];
  private readonly scratch = new THREE.Color();
  // Lot 4: living front arrows (`?three_front=1`; null when off).
  private frontArrows: FrontArrows | null = null;
  private frontField: FrontField | null = null;

  constructor(
    private readonly ctx: ThreeLayerContext,
    surface?: ReliefSurface,
  ) {
    this.hf = surface ?? heightFieldSurface(ctx.heightField);
    this.ownsSurface = surface === undefined;
    this.relationColors = telegraphColors(ctx.renderSettings.nukeTelegraph);
    this.group.name = "overlays";
    ctx.scene.add(this.group);
    this.spawn = new SpawnOverlay(
      this.group,
      this.hf,
      ctx.renderSettings.spawnOverlay,
      ctx.mapWidth,
      ctx.mapHeight,
      SPAWN_RENDER_ORDER,
    );
    this.samRings = new SamRangeRings(
      this.group,
      this.hf,
      ctx.mapWidth,
      ctx.renderSettings.samRadius,
      ctx.palette,
      SAM_RENDER_ORDER,
    );
    this.telegraphs = new DrapedDiscs(
      this.group,
      "nuke-telegraphs",
      20,
      this.hf,
    );
    // Rebuilt as the cursor moves: a coarse interior (only the faint fill).
    this.rangeRing = new DrapedDiscs(
      this.group,
      "ghost-range",
      21,
      this.hf,
      RANGE_INTERIOR_SPACING,
    );
    this.markers = new MarkerPool(this.group);

    this.arcHalo = fatLine(this.group, "trajectory-halo", 33, {
      color: 0x000000,
      linewidth: 6,
      opacity: 0.35,
    });
    this.arcSolid = fatLine(this.group, "trajectory", 34, {
      vertexColors: true,
      linewidth: 3,
    });
    this.arcDashed = fatLine(this.group, "trajectory-untargetable", 34, {
      vertexColors: true,
      linewidth: 2.5,
      opacity: 0.8,
      dashed: true,
      dashSize: 3,
      gapSize: 6,
    });
    this.groundTrack = fatLine(this.group, "trajectory-ground", 32, {
      color: 0xffffff,
      linewidth: 1.5,
      opacity: 0.4,
      dashed: true,
      dashSize: 6,
      gapSize: 6,
      depthTest: false,
    });

    this.ghostMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.25,
      roughness: 0.6,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.ghostMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      this.ghostMaterial,
    );
    this.ghostMesh.name = "ghost-structure";
    this.ghostMesh.renderOrder = 22;
    this.ghostMesh.frustumCulled = false;
    this.ghostMesh.visible = false;
    this.group.add(this.ghostMesh);
  }

  /** null = clear. */
  updateGhostPreview(d: GhostPreviewData | null): void {
    this.ghost = d;
    this.samRings.setGhostType(d?.ghostType ?? null);
    if (d !== null && d.rangeRadius > 0) {
      this.rangeRing.setDiscs([
        {
          x: d.radiusTileX,
          y: d.radiusTileY,
          inner: 0,
          outer: d.rangeRadius,
          color: d.rangeWarning ? BAD_COLOR : WHITE,
          fillAlpha: RANGE_FILL_ALPHA,
          dashed: false,
        },
      ]);
    } else {
      this.rangeRing.setDiscs([]);
    }
    const geo =
      d !== null && STRUCTURE_TYPES.has(d.ghostType)
        ? this.ghostGeometry(d.ghostType)
        : null;
    if (geo !== null) this.ghostMesh.geometry = geo;
    this.ghostModel = geo !== null;
    this.ghostMesh.visible = geo !== null;
  }

  /** null = hide. */
  updateNukeTrajectory(d: NukeTrajectoryData | null): void {
    if (
      d !== null &&
      this.trajectory !== null &&
      sameTrajectory(d, this.trajectory) &&
      this.trajectoryVersion === this.hf.version
    ) {
      return;
    }
    this.trajectory = d === null ? null : { ...d };
    this.trajectoryVersion = this.hf.version;
    if (d === null) {
      for (const fl of [
        this.arcHalo,
        this.arcSolid,
        this.arcDashed,
        this.groundTrack,
      ]) {
        fl.line.visible = false;
      }
      this.trajectoryMarkers = [];
      return;
    }
    this.buildTrajectory(d);
  }

  updateNukeTelegraphs(d: NukeTelegraphData[]): void {
    this.telegraphs.setDiscs(
      d.map((t) => ({
        x: t.x,
        y: t.y,
        inner: t.innerRadius,
        outer: t.outerRadius,
        color: this.relationColors[t.relation] ?? this.relationColors[2],
        fillAlpha: 0.25,
        dashed: true,
      })),
    );
  }

  updateAttackRings(r: AttackRingInput[]): void {
    const now = performance.now();
    const seen = new Set<number>();
    for (const ring of r) {
      seen.add(ring.unitId);
      const s = this.attackRings.get(ring.unitId);
      if (s === undefined) {
        this.attackRings.set(ring.unitId, {
          x: ring.x,
          y: ring.y,
          bornMs: now,
          goneMs: null,
        });
      } else {
        s.x = ring.x;
        s.y = ring.y;
        if (s.goneMs !== null) {
          s.goneMs = null;
          s.bornMs = now;
        }
      }
    }
    for (const [id, s] of this.attackRings) {
      if (!seen.has(id)) s.goneMs ??= now;
    }
  }

  /** One-shot chevrons at a warship move target (tile coords). */
  showMoveIndicator(x: number, y: number, ownerID: number): void {
    setOwnerColor(this.scratch, this.ctx.palette.data, ownerID, 0.3);
    // The marker shader writes its colour as linear, like the scratch.
    this.moveIndicators.push({
      x,
      y,
      startMs: performance.now(),
      color: [this.scratch.r, this.scratch.g, this.scratch.b],
    });
    if (this.moveIndicators.length > 8) this.moveIndicators.shift();
  }

  /** One-shot "can't do that" flash at a tile. */
  triggerBlockedFlash(x: number, y: number): void {
    this.blockedFlashes.push({
      x,
      y,
      startMs: performance.now(),
      color: [1, 0.06, 0.05],
    });
    if (this.blockedFlashes.length > 4) this.blockedFlashes.shift();
  }

  // ---- Spawn phase ----

  /** Spawn centres of the tick (the facade's updateSpawnOverlay). */
  updateSpawnOverlay(centers: readonly SpawnCenter[]): void {
    this.spawn.setCenters(centers);
  }

  // ---- SAM range rings (inputs; drawn only in build mode) ----

  /** All units; SAM launchers are kept. */
  setSamStructures(units: ReadonlyMap<number, UnitState>): void {
    this.samRings.setStructures(units);
  }

  setSamTick(tick: number): void {
    this.samRings.setTick(tick);
  }

  setLocalPlayer(id: number): void {
    this.samRings.setLocalPlayer(id);
  }

  /** Allies and teammates of the local player. */
  setSamAllies(allies: ReadonlySet<number>): void {
    this.samRings.setAllies(allies);
  }

  setSamAllianceClusters(clusters: ReadonlyMap<number, number>): void {
    this.samRings.setAllianceClusters(clusters);
  }

  /**
   * Lot 4: the living front's segments (TerrainLayer's field); the arrows
   * exist only with `?three_front=1` and a field.
   */
  setFront(field: FrontField | null): void {
    this.frontField = field;
    if (
      field !== null &&
      this.frontArrows === null &&
      this.ctx.settings.prototypes?.front === true
    ) {
      this.frontArrows = new FrontArrows(this.group, this.ctx);
    }
  }

  /** Lot 4: relations for the front arrows' alt-view colours (flag only). */
  setFrontRelations(data: Uint8Array, size: number): void {
    this.frontArrows?.setRelations(data, size);
  }

  /** Build-bar highlight (null = none): SAM / bomb buttons show the rings. */
  setHighlightStructureTypes(types: readonly string[] | null): void {
    this.samRings.setHighlightTypes(types);
  }

  /**
   * Counters for the perf tool: spawn halos (`spawnHalos`, patch vertices
   * and triangles, rebuilds) and SAM rings (`samCircles`, `samArcs`,
   * `samRingSegments` (8 triangles each), `samPendingCircles` (heights
   * still being sampled, 2 ms per frame), `samRebuilds`, `samBuildMs` /
   * `samBuildMsMax`).
   */
  perfStats(): Record<string, number> {
    const sam = this.samRings.perfStats();
    return {
      ...this.spawn.perfStats(),
      samVisible: this.samRings.mesh.visible ? 1 : 0,
      samCircles: sam.circles,
      samArcs: sam.arcs,
      samRingSegments: sam.segments,
      samPendingCircles: sam.pendingCircles,
      samRebuilds: sam.rebuilds,
      samBuildMs: sam.buildMs,
      samBuildMsMax: sam.buildMsMax,
      // Lot 4: living front arrows (only with ?three_front=1).
      ...(this.frontArrows !== null
        ? {
            frontArrows: this.frontArrows.drawn,
            frontArrowCandidates: this.frontArrows.candidates,
            frontJsMs: Math.round(this.frontArrows.lastMs * 1000) / 1000,
          }
        : {}),
    };
  }

  update(frame: FrameInfo): void {
    const now = frame.nowMs;
    const zoom = Math.max(1e-3, frame.cssPxPerTile);
    this.spawn.update(frame);
    this.samRings.update(frame);
    this.telegraphs.update(frame);
    this.rangeRing.update(frame);
    // Lot 4: living front arrows (only with ?three_front=1).
    this.frontArrows?.update(frame, this.frontField, this.hf);
    // Dash lengths in CSS px: line distances are in tiles.
    this.arcDashed.material.dashScale = zoom;
    this.groundTrack.material.dashScale = zoom;

    const m = this.markers;
    m.begin(frame);
    this.drawGhost(frame);
    for (const tm of this.trajectoryMarkers) m.draw(tm);

    for (const [id, s] of this.attackRings) {
      const alpha =
        s.goneMs !== null
          ? 1 - (now - s.goneMs) / ATTACK_RING_FADE_OUT_MS
          : Math.min(1, (now - s.bornMs) / ATTACK_RING_FADE_IN_MS);
      if (s.goneMs !== null && alpha <= 0) {
        this.attackRings.delete(id);
        continue;
      }
      m.draw({
        kind: MarkerKind.AttackRing,
        ...this.surfacePoint(s.x, s.y),
        halfPx: 16,
        color: [1, 0.05, 0.05],
        alpha: Math.max(0, alpha),
      });
    }

    this.moveIndicators = this.moveIndicators.filter(
      (mi) => now - mi.startMs < MOVE_INDICATOR_MS,
    );
    // Same growth as the default renderer: bigger above zoom 10.
    const sc = zoom > 10 ? 1 + (zoom - 10) / 10 : 1;
    for (const mi of this.moveIndicators) {
      m.draw({
        kind: MarkerKind.MoveChevrons,
        ...this.surfacePoint(mi.x, mi.y),
        halfPx: 24 * sc,
        color: mi.color,
        alpha: 1,
        progress: (now - mi.startMs) / MOVE_INDICATOR_MS,
        param: sc,
        gain: MOVE_GLOW,
      });
    }

    this.blockedFlashes = this.blockedFlashes.filter(
      (bf) => now - bf.startMs < BLOCKED_FLASH_MS,
    );
    for (const bf of this.blockedFlashes) {
      const t = (now - bf.startMs) / BLOCKED_FLASH_MS;
      // Ease-out drift towards the top of the screen (north, −Z).
      const rise = (1 - (1 - t) * (1 - t)) * (14 / zoom);
      const pt = this.surfacePoint(bf.x, bf.y);
      m.draw({
        kind: MarkerKind.BlockedX,
        x: pt.x,
        y: pt.y,
        z: pt.z - rise,
        halfPx: 34,
        color: bf.color,
        alpha: 1,
        progress: t,
      });
    }
    m.end();
  }

  dispose(): void {
    this.spawn.dispose();
    this.samRings.dispose();
    if (this.ownsSurface) this.hf.tileTexture?.dispose();
    this.telegraphs.dispose();
    this.rangeRing.dispose();
    this.markers.dispose();
    this.frontArrows?.dispose();
    for (const fl of [
      this.arcHalo,
      this.arcSolid,
      this.arcDashed,
      this.groundTrack,
    ]) {
      fl.line.geometry.dispose();
      fl.material.dispose();
    }
    this.ghostMesh.geometry = new THREE.BufferGeometry();
    for (const g of this.ghostGeometries.values()) g.dispose();
    this.ghostGeometries.clear();
    this.ghostMesh.geometry.dispose();
    this.ghostMaterial.dispose();
    this.attackRings.clear();
    this.ctx.scene.remove(this.group);
  }

  // ---- Internals ----

  /** Tile → world point on the visible surface (tile centre), lifted. */
  private surfacePoint(
    tx: number,
    ty: number,
  ): { x: number; y: number; z: number } {
    const x = tx + 0.5;
    const z = ty + 0.5;
    return { x, y: this.hf.surfaceAt(x, z) + 0.3, z };
  }

  private ghostGeometry(type: string): THREE.BufferGeometry | null {
    let g = this.ghostGeometries.get(type);
    if (g === undefined) {
      const built = createStructureGeometry(type, 1);
      if (built === null) return null;
      g = built;
      this.ghostGeometries.set(type, g);
    }
    return g;
  }

  /** Ghost structure / reticle / upgrade highlight for the current frame. */
  private drawGhost(frame: FrameInfo): void {
    const d = this.ghost;
    if (d === null) return;
    const zoom = Math.max(1e-3, frame.cssPxPerTile);
    const ok = d.canBuild || d.canUpgrade;
    const color = ok ? OK_COLOR : BAD_COLOR;
    const t = frame.nowMs / 1000;

    if (this.ghostModel) {
      const fp = STRUCTURE_FOOTPRINT[d.ghostType] ?? 6;
      const k = minScreenScale(
        this.ctx.settings.structureMinScreenPx,
        zoom,
        fp,
      );
      const x = d.tileX + 0.5;
      const z = d.tileY + 0.5;
      // Same crossfade as the structures: while they show as icons the
      // ghost is an icon too (StructureLayer), the model grows in with them.
      const w = modelWeightAt(
        zoom,
        iconFadeBand(this.ctx.settings.quality === "low"),
      );
      this.ghostMesh.visible = w > 0;
      this.ghostMesh.position.set(x, this.hf.surfaceAt(x, z), z);
      this.ghostMesh.scale.set(
        k * modelFadeScaleX(w),
        k * modelFadeScaleY(w),
        k * modelFadeScaleX(w),
      );
      // Tint every frame: the controller may update `d` in place.
      this.ghostMaterial.color.setRGB(color[0], color[1], color[2]);
      this.ghostMaterial.emissive.setRGB(color[0], color[1], color[2]);
      this.ghostMaterial.opacity = 0.48 + 0.1 * Math.sin(t * 4);
      this.markers.draw({
        kind: MarkerKind.Footprint,
        ...this.surfacePoint(d.tileX, d.tileY),
        halfPx: (fp * k * zoom) / 2 + 6,
        color,
        alpha: 0.9,
        param: (fp * k * zoom) / 2 + 2,
      });
      if (d.canUpgrade && d.upgradeTargetTile !== null) {
        const W = this.ctx.mapWidth;
        const ux = d.upgradeTargetTile % W;
        const uy = Math.floor(d.upgradeTargetTile / W);
        this.markers.draw({
          kind: MarkerKind.Footprint,
          ...this.surfacePoint(ux, uy),
          halfPx: (fp * k * zoom) / 2 + 8,
          color: OK_COLOR,
          alpha: 1,
          param: (fp * k * zoom) / 2 + 4,
        });
      }
    } else if (d.ghostType === UT_WARSHIP || d.ghostType === UT_MIRV) {
      this.markers.draw({
        kind: MarkerKind.Reticle,
        ...this.surfacePoint(d.tileX, d.tileY),
        halfPx: 20,
        color: ok ? [0.95, 0.18, 0.15] : [0.45, 0.12, 0.12],
        alpha: 1,
      });
    }
  }

  /** Arc + halo + ground track + zone markers for a trajectory preview. */
  private buildTrajectory(d: NukeTrajectoryData): void {
    const hasZone = d.tUntargetableStart >= 0 && d.tUntargetableEnd >= 0;
    const tSam = d.tSamIntercept < 1 ? Math.max(0, d.tSamIntercept) : 2;
    // Uniform samples plus the exact zone boundaries.
    const tset = new Set<number>();
    for (let i = 0; i <= TRAJECTORY_SAMPLES; i++)
      tset.add(i / TRAJECTORY_SAMPLES);
    if (hasZone) {
      tset.add(Math.min(1, Math.max(0, d.tUntargetableStart)));
      tset.add(Math.min(1, Math.max(0, d.tUntargetableEnd)));
    }
    if (tSam <= 1) tset.add(tSam);
    const ts = [...tset].sort((a, b) => a - b);
    const pts = trajectoryPoints(d, ts, (x, y) => this.hf.surfaceAt(x, y));

    const solid: number[] = [];
    const solidColors: number[] = [];
    const dashed: number[] = [];
    const dashedColors: number[] = [];
    const halo: number[] = [];
    const ground: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const tm = (ts[i] + ts[i + 1]) / 2;
      const seg = [
        a.x,
        a.ground + a.alt + 0.6,
        a.y,
        b.x,
        b.ground + b.alt + 0.6,
        b.y,
      ];
      const intercepted = tm >= tSam;
      const untargetable =
        hasZone && tm >= d.tUntargetableStart && tm <= d.tUntargetableEnd;
      const c: Rgb = intercepted ? [1, 0.3, 0.3] : [1, 1, 1];
      const target = untargetable ? dashed : solid;
      const targetColors = untargetable ? dashedColors : solidColors;
      target.push(...seg);
      targetColors.push(...c, ...c);
      halo.push(...seg);
      ground.push(
        a.x,
        a.ground + DRAPE_LIFT,
        a.y,
        b.x,
        b.ground + DRAPE_LIFT,
        b.y,
      );
    }
    setSegments(this.arcSolid, solid, solidColors);
    setSegments(this.arcDashed, dashed, dashedColors);
    setSegments(this.arcHalo, halo, null);
    setSegments(this.groundTrack, ground, null);

    // Zone boundary circles and the SAM intercept cross, on the arc.
    const markers: MarkerDraw[] = [];
    const at = (t: number, kind: MarkerKind, color: Rgb, halfPx: number) => {
      const [p] = trajectoryPoints(d, [t], (x, y) => this.hf.surfaceAt(x, y));
      markers.push({
        kind,
        x: p.x,
        y: p.ground + p.alt + 0.6,
        z: p.y,
        halfPx,
        color,
        alpha: 1,
      });
    };
    if (hasZone) {
      at(d.tUntargetableStart, MarkerKind.Circle, WHITE, 8);
      at(d.tUntargetableEnd, MarkerKind.Circle, WHITE, 8);
    }
    if (tSam <= 1) at(tSam, MarkerKind.Cross, [1, 0.1, 0.1], 10);
    this.trajectoryMarkers = markers;
  }
}
