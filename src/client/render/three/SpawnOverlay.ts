/**
 * Spawn-phase overlay: the 3D port of the default renderer's
 * `SpawnOverlayPass` (gl/passes/SpawnOverlayPass.ts), draped on the relief.
 *
 * Same semantics as the default renderer (`WebGLFrameBuilder.syncSpawnOverlay`
 * decides who is listed; an empty list hides everything):
 * - the local player: a big breathing halo (render-settings `spawnOverlay`
 *   radii 10 → 30 tiles, scaled ×0.5 … ×1.15 by the breath), pulsing white →
 *   gold (teamless) or the own territory colour (team games), opacity
 *   65 → 100%. Past the spawn phase the tutorial may keep only this one up;
 * - teammates: a smaller breathing halo (5 → 14 tiles) in their colour;
 * - other human players: their colour on the unowned tiles within 9 tiles
 *   of their spawn.
 * Drawn enemies → teammates → self, so the local halo composites on top.
 * The breath runs from local time (`animSpeed` 0.008 rad/ms, ~0.8 s).
 *
 * 3D: each centre gets a patch of the relief grid around it (the vertices
 * of the terrain mesh itself, clamped to the sea plane), so the halo lies
 * exactly on the drawn surface — slopes, coasts and sea — and relief in
 * front hides it under tilt; a polygon offset keeps it above the terrain
 * without z-fighting. One merged mesh, one draw call; the patches are cached
 * per centre and rebuilt only when the list or the relief changes. The halo
 * is unlit (it reads the same in shadow) and the local one gets a slight HDR
 * gain so it glows a little under bloom.
 */

import * as THREE from "three";
import type { SpawnCenter } from "../gl/passes/SpawnOverlayPass";
import type { RenderSettings } from "../gl/RenderSettings";
import { FRAG_OUTPUT } from "./shaders/water";
import type { FrameInfo, ReliefSurface } from "./types";

/** Instance kinds (as in spawn-overlay.frag.glsl). */
export const SpawnKind = { Enemy: 0, Self: 1, Teammate: 2 } as const;
export type SpawnKind = (typeof SpawnKind)[keyof typeof SpawnKind];

/** Largest breath scale (0.5 + 0.65) and the edge margin, as the default. */
const MAX_BREATH_SCALE = 1.15;
const RADIUS_MARGIN = 1;
/** HDR gain of the local player's halo (a soft glow under bloom). */
const SELF_GAIN = 1.25;

type Rgb = readonly [number, number, number];

export interface SpawnInstance {
  /** World centre (tile centre). */
  x: number;
  y: number;
  /** Radius the patch must cover (tiles). */
  radius: number;
  kind: SpawnKind;
  /** Linear rgb. */
  color: Rgb;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The instances to draw, in draw order (enemies, teammates, self), with
 * the patch radius each needs (the default's quad radii).
 */
export function spawnInstances(
  centers: readonly SpawnCenter[],
  s: RenderSettings["spawnOverlay"],
): SpawnInstance[] {
  const out: SpawnInstance[] = [];
  const push = (c: SpawnCenter, kind: SpawnKind, radius: number) =>
    out.push({
      x: c.x + 0.5,
      y: c.y + 0.5,
      radius,
      kind,
      color: [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)],
    });
  for (const c of centers) {
    if (!c.isSelf && !c.isTeammate) {
      push(c, SpawnKind.Enemy, s.highlightRadius + RADIUS_MARGIN);
    }
  }
  for (const c of centers) {
    if (c.isTeammate) {
      push(
        c,
        SpawnKind.Teammate,
        s.mateMaxRad * MAX_BREATH_SCALE + RADIUS_MARGIN,
      );
    }
  }
  for (const c of centers) {
    if (c.isSelf) {
      push(c, SpawnKind.Self, s.selfMaxRad * MAX_BREATH_SCALE + RADIUS_MARGIN);
    }
  }
  return out;
}

/** Breath (0..1) at an animation time (radians), as SpawnOverlayPass. */
export function spawnBreath(animTime: number): number {
  return 0.5 + 0.5 * Math.sin(animTime);
}

/**
 * Halo alpha at `dist` tiles from the centre, before the opacity pulse:
 * SpawnOverlayPass's ring profile (TS mirror of the shader, for tests).
 */
export function spawnRingAlpha(
  dist: number,
  minR: number,
  maxR: number,
  breath: number,
  gradientSolidEnd: number,
): number {
  const scale = 0.5 + 0.65 * breath;
  const bMin = minR * scale;
  const bMax = maxR * scale;
  const t = (dist - bMin) / (bMax - bMin);
  let alpha = 0;
  if (dist < bMin) alpha = dist / Math.max(bMin, 0.001);
  else if (t < gradientSolidEnd) alpha = 1;
  else if (t < 1) alpha = 1 - (t - gradientSolidEnd) / (1 - gradientSolidEnd);
  return alpha * (0.65 + 0.35 * breath);
}

const SPAWN_VERT = /* glsl */ `
attribute vec3 aSpawn;  // (centre x, centre z, kind)
attribute vec3 aColor;  // linear rgb
varying vec3 vWorld;
varying vec3 vSpawn;
varying vec3 vColor;
void main() {
  vSpawn = aSpawn;
  vColor = aColor;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/** spawn-overlay.frag.glsl in world space, linear colours. */
const SPAWN_FRAG = /* glsl */ `
${FRAG_OUTPUT}
uniform highp usampler2D uTiles;
uniform ivec2 uMapSize;
uniform float uHasTiles;
uniform float uBreath;
uniform float uHighlightRadiusSq;
uniform float uHighlightAlpha;
uniform vec4 uSelfRadii;
uniform vec4 uMateRadii;
uniform vec2 uGradientStops;
uniform float uSelfGain;
varying vec3 vWorld;
varying vec3 vSpawn;
varying vec3 vColor;

void main() {
  vec2 d = vWorld.xz - vSpawn.xy;
  float distSq = dot(d, d);
  float dist = sqrt(distSq);
  float kind = vSpawn.z;

  // Other players: their colour on unowned tiles within the radius.
  if (kind < 0.5) {
    ivec2 tc = ivec2(floor(vWorld.xz));
    if (any(lessThan(tc, ivec2(0))) || any(greaterThanEqual(tc, uMapSize))) discard;
    if (distSq > uHighlightRadiusSq) discard;
    if (uHasTiles > 0.5 && (texelFetch(uTiles, tc, 0).r & 0xfffu) != 0u) discard;
    gl_FragColor = vec4(vColor, uHighlightAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  // Breathing halo (self or teammate).
  float minR;
  float maxR;
  vec3 color;
  float gain = 1.0;
  if (kind > 1.5) {
    minR = uMateRadii.x;
    maxR = uMateRadii.y;
    color = vColor;
  } else {
    minR = uSelfRadii.x;
    maxR = uSelfRadii.y;
    // White -> base colour in phase with the breath.
    color = mix(vec3(1.0), vColor, uBreath);
    gain = uSelfGain;
  }
  float scale = 0.5 + 0.65 * uBreath;
  float bMinR = minR * scale;
  float bMaxR = maxR * scale;
  float t = (dist - bMinR) / (bMaxR - bMinR);
  float solidEnd = uGradientStops.y;
  float alpha = 0.0;
  if (dist < bMinR) {
    alpha = dist / max(bMinR, 0.001);
  } else if (t < solidEnd) {
    alpha = 1.0;
  } else if (t < 1.0) {
    alpha = 1.0 - (t - solidEnd) / (1.0 - solidEnd);
  }
  if (alpha <= 0.0) discard;
  alpha *= 0.65 + 0.35 * uBreath;
  gl_FragColor = vec4(color * gain, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Cached grid patch of one centre (relief vertices around it). */
interface Patch {
  positions: Float32Array;
  index: Uint32Array;
  vertexCount: number;
}

/**
 * The relief-grid vertices covering [x - r, x + r] × [y - r, y + r], at the
 * drawn surface height, triangulated like the terrain mesh.
 */
export function buildSpawnPatch(
  surface: ReliefSurface,
  x: number,
  y: number,
  r: number,
): Patch {
  const g = surface.grid;
  const s = g.step;
  const i0 = Math.max(0, Math.floor((x - r) / s));
  const j0 = Math.max(0, Math.floor((y - r) / s));
  const i1 = Math.min(g.cols - 1, Math.ceil((x + r) / s));
  const j1 = Math.min(g.rows - 1, Math.ceil((y + r) / s));
  const nx = i1 - i0 + 1;
  const nz = j1 - j0 + 1;
  if (nx < 2 || nz < 2) {
    return {
      positions: new Float32Array(0),
      index: new Uint32Array(0),
      vertexCount: 0,
    };
  }
  const positions = new Float32Array(nx * nz * 3);
  let o = 0;
  for (let j = j0; j <= j1; j++) {
    const z = g.vertexY(j);
    for (let i = i0; i <= i1; i++) {
      positions[o++] = g.vertexX(i);
      positions[o++] = surface.vertexSurface(i, j);
      positions[o++] = z;
    }
  }
  const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Same split as TerrainLayer: (a, c, b), (b, c, d).
      index[k++] = a;
      index[k++] = c;
      index[k++] = b;
      index[k++] = b;
      index[k++] = c;
      index[k++] = d;
    }
  }
  return { positions, index, vertexCount: nx * nz };
}

export class SpawnOverlay {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly patches = new Map<string, Patch>();
  private patchVersion = -1;
  private signature = "";
  private instances: SpawnInstance[] = [];
  /** Animation clock (radians), advanced only while something is shown. */
  private animTime = 0;
  private vertCap = 0;
  private indexCap = 0;
  private positions = new Float32Array(0);
  private spawn = new Float32Array(0);
  private colors = new Float32Array(0);
  private index = new Uint32Array(0);
  private vertexCount = 0;
  private triangleCount = 0;
  private rebuilds = 0;

  constructor(
    parent: THREE.Object3D,
    private readonly surface: ReliefSurface,
    private readonly settings: RenderSettings["spawnOverlay"],
    mapW: number,
    mapH: number,
    renderOrder: number,
  ) {
    const tiles = surface.tileTexture;
    this.material = new THREE.ShaderMaterial({
      name: "three-spawn-overlay",
      glslVersion: THREE.GLSL3,
      vertexShader: SPAWN_VERT,
      fragmentShader: SPAWN_FRAG,
      uniforms: {
        uTiles: { value: tiles },
        uMapSize: { value: new THREE.Vector2(mapW, mapH) },
        uHasTiles: { value: tiles !== null ? 1 : 0 },
        uBreath: { value: 0.5 },
        uHighlightRadiusSq: { value: 0 },
        uHighlightAlpha: { value: 1 },
        uSelfRadii: { value: new THREE.Vector4() },
        uMateRadii: { value: new THREE.Vector4() },
        uGradientStops: { value: new THREE.Vector2() },
        uSelfGain: { value: SELF_GAIN },
      },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = "spawn-overlay";
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Spawn centres of the tick (empty = hide). */
  setCenters(centers: readonly SpawnCenter[]): void {
    this.instances = spawnInstances(centers, this.settings);
    this.rebuildIfChanged();
  }

  update(frame: FrameInfo): void {
    if (this.instances.length === 0) {
      this.mesh.visible = false;
      return;
    }
    if (this.surface.version !== this.patchVersion) this.rebuildIfChanged();
    const s = this.settings;
    this.animTime += frame.dtMs * s.animSpeed;
    const u = this.material.uniforms;
    u.uBreath.value = spawnBreath(this.animTime);
    u.uHighlightRadiusSq.value = s.highlightRadius * s.highlightRadius;
    u.uHighlightAlpha.value = s.highlightAlpha;
    (u.uSelfRadii.value as THREE.Vector4).set(s.selfMinRad, s.selfMaxRad, 0, 0);
    (u.uMateRadii.value as THREE.Vector4).set(s.mateMinRad, s.mateMaxRad, 0, 0);
    (u.uGradientStops.value as THREE.Vector2).set(
      s.gradientInnerEdge,
      s.gradientSolidEnd,
    );
    this.mesh.visible = this.triangleCount > 0;
  }

  /** Current breath (0..1), for tests and debugging. */
  get breath(): number {
    return this.material.uniforms.uBreath.value as number;
  }

  perfStats(): Record<string, number> {
    return {
      spawnHalos: this.instances.length,
      spawnVertices: this.vertexCount,
      spawnTriangles: this.triangleCount,
      spawnRebuilds: this.rebuilds,
    };
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.patches.clear();
  }

  // ---- Internals ----

  private rebuildIfChanged(): void {
    let sig = "";
    for (const it of this.instances) {
      sig += `${it.x},${it.y},${it.kind},${it.color.join(",")};`;
    }
    const version = this.surface.version;
    if (sig === this.signature && version === this.patchVersion) return;
    this.signature = sig;
    if (version !== this.patchVersion) {
      this.patches.clear();
      this.patchVersion = version;
    }
    this.rebuilds++;
    const used = new Map<string, Patch>();
    let verts = 0;
    let indices = 0;
    const list: [Patch, SpawnInstance][] = [];
    for (const it of this.instances) {
      const key = `${it.x},${it.y},${it.radius}`;
      let p = used.get(key) ?? this.patches.get(key);
      p ??= buildSpawnPatch(this.surface, it.x, it.y, it.radius);
      used.set(key, p);
      if (p.vertexCount === 0) continue;
      list.push([p, it]);
      verts += p.vertexCount;
      indices += p.index.length;
    }
    this.patches.clear();
    for (const [k, p] of used) this.patches.set(k, p);
    this.vertexCount = verts;
    this.triangleCount = indices / 3;
    if (indices === 0) {
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    this.ensure(verts, indices);
    let v = 0;
    let ii = 0;
    for (const [p, it] of list) {
      this.positions.set(p.positions, v * 3);
      for (let k = 0; k < p.vertexCount; k++) {
        const o = (v + k) * 3;
        this.spawn[o] = it.x;
        this.spawn[o + 1] = it.y;
        this.spawn[o + 2] = it.kind;
        this.colors[o] = it.color[0];
        this.colors[o + 1] = it.color[1];
        this.colors[o + 2] = it.color[2];
      }
      for (let k = 0; k < p.index.length; k++) {
        this.index[ii + k] = p.index[k] + v;
      }
      v += p.vertexCount;
      ii += p.index.length;
    }
    const g = this.mesh.geometry;
    for (const name of ["position", "aSpawn", "aColor"]) {
      const attr = g.getAttribute(name) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, v * 3);
      attr.needsUpdate = true;
    }
    const index = g.getIndex()!;
    index.clearUpdateRanges();
    index.addUpdateRange(0, ii);
    index.needsUpdate = true;
    g.setDrawRange(0, ii);
  }

  private ensure(verts: number, indices: number): void {
    if (verts <= this.vertCap && indices <= this.indexCap) return;
    let vc = Math.max(1024, this.vertCap);
    while (vc < verts) vc *= 2;
    let ic = Math.max(4096, this.indexCap);
    while (ic < indices) ic *= 2;
    this.vertCap = vc;
    this.indexCap = ic;
    this.positions = new Float32Array(vc * 3);
    this.spawn = new Float32Array(vc * 3);
    this.colors = new Float32Array(vc * 3);
    this.index = new Uint32Array(ic);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    g.setAttribute("aSpawn", new THREE.BufferAttribute(this.spawn, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.colors, 3));
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    const old = this.mesh.geometry;
    this.mesh.geometry = g;
    old.dispose();
  }
}
