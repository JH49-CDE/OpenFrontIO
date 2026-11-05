/**
 * ProceduralMeshes — low-poly geometry for every unit and structure of the
 * Three.js renderer, plus the shared building blocks the unit / structure /
 * overlay layers draw them with (the "part" material and `InstancedBatch`).
 *
 * Everything is built from three primitives merged with `mergeGeometries`
 * (no external assets). Units: world tiles, local +X = forward (bow / nose),
 * +Y = up, origin at the waterline / ground / missile centre. Structures:
 * origin at ground level in the middle of the footprint, foundations reach
 * below 0 so slopes never show a gap.
 *
 * Every part carries three vertex attributes read by `createPartMaterial`:
 * - `color` (linear rgb): the part's own colour;
 * - `aTint` (0..1): how much the instance (owner) colour multiplies it —
 *   0 = neutral stone / steel / flame, 1 = owner-coloured roof / hull;
 * - `aGlow` (≥ 0): emissive strength (exhaust flames, shells). The bloom
 *   threshold is luminance 1, so a part glows when aGlow × its colour's
 *   luminance × the layer's glow uniform (≈ 1) exceeds 1: flames (luminance
 *   ~0.47) use ~4.5 for a soft halo, shells ~2, the gold load stays below.
 *   The bombs' exhausts stay at NUKE_FLAME_GLOW (lot 3): from afar bloom
 *   spread a 4.5 one over many times the size of the bomb.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
} from "../types";
import { PALETTE_WIDTH } from "./PaletteView";

// ---------------------------------------------------------------------------
// Instance colours
// ---------------------------------------------------------------------------

/**
 * Owner colour of `sid` from the palette floats (row 0, sRGB 0..1) into `out`
 * as a linear colour, lightened towards white by `lighten` (0..1). Unknown
 * owners (an all-zero entry) fall back to a neutral grey.
 */
export function setOwnerColor(
  out: THREE.Color,
  palette: Float32Array,
  sid: number,
  lighten = 0,
): THREE.Color {
  const o = (sid & (PALETTE_WIDTH - 1)) * 4;
  let r = palette[o] ?? 0;
  let g = palette[o + 1] ?? 0;
  let b = palette[o + 2] ?? 0;
  if (r + g + b <= 0) {
    r = g = b = 0.62;
  }
  r += (1 - r) * lighten;
  g += (1 - g) * lighten;
  b += (1 - b) * lighten;
  return out.setRGB(r, g, b, THREE.SRGBColorSpace);
}

// ---------------------------------------------------------------------------
// Part material
// ---------------------------------------------------------------------------

/**
 * Vertex-shader helpers of the `conform` part material. Each instance
 * carries the height of the ground under its pad on a 3×3 grid (world
 * tiles, relative to the instance origin; rows `iGround0..2` at v = 0,
 * ½, 1, columns at u = 0, ½, 1 of the pad's model-space rectangle), and
 * `conformGround(uv)` interpolates it bilinearly on each of the 2×2 cells.
 */
const CONFORM_GLSL = /* glsl */ `
#ifdef USE_INSTANCING
float conformRow(vec3 r, float u) {
  return u < 1.0 ? mix(r.x, r.y, u) : mix(r.y, r.z, u - 1.0);
}
float conformGround(vec2 uv) {
  vec2 t = clamp(uv, 0.0, 1.0) * 2.0;
  float a = conformRow(iGround0, t.x);
  float b = conformRow(iGround1, t.x);
  float c = conformRow(iGround2, t.x);
  return t.y < 1.0 ? mix(a, b, t.y) : mix(b, c, t.y - 1.0);
}
float conformScaleY() {
  return max(length(instanceMatrix[1].xyz), 1e-4);
}
#endif`;

/**
 * MeshStandardMaterial for merged part geometry drawn by an `InstancedBatch`:
 * per-vertex colour × (instance colour where `aTint` = 1) × per-instance
 * `iShade`, plus emissive `vColor × aGlow × glow.value`.
 *
 * Only for meshes that carry `aTint`/`aGlow` and an `iShade` instanced
 * attribute (a missing attribute reads as 0 and would turn the mesh black).
 *
 * `conform` (structures, lot 3): the models follow the ground under their
 * instance (`iGround0..2`, from an `InstancedBatch` built with `ground`).
 * Every pad vertex (`aFooting.z` > 0: the pad's model-space width, `.w`
 * its depth) is moved to the ground at its own (u, v) = `aFooting.xy`, so
 * the base lies on the relief instead of floating over it, and its top
 * gets the ground's normal; every other part is moved rigidly to the
 * ground at its anchor's (u, v), so buildings stay upright, each standing
 * where it is. Geometry from `createStructureGeometry` /
 * `createStructureLodGeometry` carries `aFooting`.
 */
export function createPartMaterial(opts: {
  roughness?: number;
  metalness?: number;
  /** Shared emissive multiplier (animate `.value` for flicker). */
  glow: { value: number };
  /** Follow each instance's ground plane (structures). */
  conform?: boolean;
}): THREE.MeshStandardMaterial {
  const conform = opts.conform === true;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: opts.roughness ?? 0.65,
    metalness: opts.metalness ?? 0.08,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowStrength = opts.glow;
    let vs = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
attribute float aTint;
attribute float aGlow;
attribute float iShade;
varying float vGlow;${
        conform
          ? `
attribute vec3 iGround0;
attribute vec3 iGround1;
attribute vec3 iGround2;
attribute vec4 aFooting;
${CONFORM_GLSL}`
          : ""
      }`,
    );
    if (conform) {
      vs = vs
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
#ifdef USE_INSTANCING
if (aFooting.z > 0.0 && objectNormal.y > 0.5) {
  // The ground's slope at the vertex, in model units (height / width).
  const float e = 0.05;
  float sy = conformScaleY();
  float dx = conformGround(aFooting.xy + vec2(e, 0.0))
    - conformGround(aFooting.xy - vec2(e, 0.0));
  float dz = conformGround(aFooting.xy + vec2(0.0, e))
    - conformGround(aFooting.xy - vec2(0.0, e));
  vec2 ls = vec2(dx / aFooting.z, dz / aFooting.w) / (2.0 * e * sy);
  objectNormal = normalize(vec3(-ls.x, 1.0, -ls.y));
}
#endif`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
#ifdef USE_INSTANCING
transformed.y += conformGround(aFooting.xy) / conformScaleY();
#endif`,
        );
    }
    shader.vertexShader = vs.replace(
      "#include <color_vertex>",
      `vColor = vec4(1.0);
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aTint);
#endif
vColor.rgb *= iShade;
vGlow = aGlow;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vGlow;
uniform float uGlowStrength;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
#ifdef USE_COLOR
  totalEmissiveRadiance += vColor.rgb * vGlow * uGlowStrength;
#endif`,
      );
  };
  mat.customProgramCacheKey = () =>
    conform ? "openfront-three-parts-v1-conform" : "openfront-three-parts-v1";
  return mat;
}

// ---------------------------------------------------------------------------
// InstancedBatch
// ---------------------------------------------------------------------------

/** Smallest power-of-two-ish capacity ≥ `needed`, doubling from `current`. */
export function nextCapacity(current: number, needed: number): number {
  let cap = Math.max(16, Math.floor(current));
  while (cap < needed) cap *= 2;
  return cap;
}

/** Uploads the first `n` elements of an attribute (nothing when n = 0). */
function markRange(attr: THREE.BufferAttribute, n: number): void {
  if (n <= 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n);
  attr.needsUpdate = true;
}

/**
 * One InstancedMesh (one draw call) whose capacity doubles on demand.
 * Usage per rebuild: `begin()`, `push(...)` per instance, `end()`. Single
 * instances can be rewritten in place with `setMatrix` / `setShade` followed
 * by `markDirty()`. Frustum culling is off (instances move every frame, the
 * cached bounding sphere would go stale). With `ground`, each instance also
 * carries the 3×3 ground height grid read by the `conform` part material
 * (`iGround0..2`, three vec3 rows).
 */
export class InstancedBatch {
  mesh: THREE.InstancedMesh;
  /** Instances written since `begin()`. */
  count = 0;
  private shadeAttr!: THREE.InstancedBufferAttribute;
  private groundAttrs: THREE.InstancedBufferAttribute[] = [];

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly template: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly name: string,
    initialCapacity = 16,
    private readonly renderOrder = 0,
    private readonly ground = false,
  ) {
    this.mesh = this.create(nextCapacity(0, initialCapacity));
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  begin(): void {
    this.count = 0;
  }

  /**
   * Appends an instance and returns its index; `ground` is its 3×3 ground
   * height grid, row-major (only stored with `ground`; zeros if omitted).
   */
  push(
    m: THREE.Matrix4,
    color: THREE.Color,
    shade = 1,
    ground: ArrayLike<number> | null = null,
  ): number {
    const i = this.count;
    if (i >= this.capacity) this.grow(i + 1);
    this.mesh.setMatrixAt(i, m);
    this.mesh.setColorAt(i, color);
    this.shadeAttr.array[i] = shade;
    for (let r = 0; r < this.groundAttrs.length; r++) {
      const a = this.groundAttrs[r].array;
      for (let c = 0; c < 3; c++) a[3 * i + c] = ground?.[3 * r + c] ?? 0;
    }
    this.count = i + 1;
    return i;
  }

  /** The 3×3 ground grid of instance `i` (row-major; zeros without). */
  groundAt(i: number): number[] {
    const out = new Array<number>(9).fill(0);
    this.groundAttrs.forEach((attr, r) => {
      for (let c = 0; c < 3; c++) out[3 * r + c] = attr.array[3 * i + c];
    });
    return out;
  }

  setMatrix(i: number, m: THREE.Matrix4): void {
    this.mesh.setMatrixAt(i, m);
  }

  setColor(i: number, c: THREE.Color): void {
    this.mesh.setColorAt(i, c);
  }

  setShade(i: number, shade: number): void {
    this.shadeAttr.array[i] = shade;
  }

  /** Publishes the instances written since `begin()`. */
  end(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.markDirty();
  }

  /**
   * Re-uploads matrices / colours / shades of the live instances (only the
   * first `count`, not the whole capacity) after in-place edits.
   */
  markDirty(): void {
    const n = this.count;
    markRange(this.mesh.instanceMatrix, n * 16);
    if (this.mesh.instanceColor) markRange(this.mesh.instanceColor, n * 3);
    markRange(this.shadeAttr, n);
    for (const a of this.groundAttrs) markRange(a, n * 3);
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }

  private create(capacity: number): THREE.InstancedMesh {
    // Each batch owns a copy of the (small) template geometry so it can
    // carry its own per-instance `iShade` attribute and be disposed alone.
    const geometry = this.template.clone();
    this.shadeAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity).fill(1),
      1,
    );
    this.shadeAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("iShade", this.shadeAttr);
    if (this.ground) {
      this.groundAttrs = [0, 1, 2].map((r) => {
        const a = new THREE.InstancedBufferAttribute(
          new Float32Array(capacity * 3),
          3,
        );
        a.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(`iGround${r}`, a);
        return a;
      });
    }
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(1),
      3,
    );
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.name = this.name;
    mesh.renderOrder = this.renderOrder;
    this.parent.add(mesh);
    return mesh;
  }

  private grow(needed: number): void {
    const old = this.mesh;
    const oldShade = this.shadeAttr;
    const oldGround = this.groundAttrs;
    const next = this.create(nextCapacity(this.capacity, needed));
    next.instanceMatrix.array.set(old.instanceMatrix.array);
    if (old.instanceColor && next.instanceColor) {
      next.instanceColor.array.set(old.instanceColor.array);
    }
    this.shadeAttr.array.set(oldShade.array);
    oldGround.forEach((a, r) => this.groundAttrs[r].array.set(a.array));
    this.parent.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.mesh = next;
  }
}

// ---------------------------------------------------------------------------
// Blob shadows
// ---------------------------------------------------------------------------

/**
 * Horizontal shift (tiles, +x east / +z south) of the shadow of a point
 * `h` tiles up, for the sun towards (−0.5, 0.8, −0.35): h·(0.5, 0.35)/0.8.
 */
export function shadowOffset(h: number): [number, number] {
  return [h * 0.625, h * 0.4375];
}

/** `iShade` is InstancedBatch's per-instance scalar: here the opacity. */
const SHADOW_VERT = /* glsl */ `
attribute float iShade;
varying vec2 vLocal;
varying float vAlpha;
void main() {
  vLocal = uv * 2.0 - 1.0;
  vAlpha = iShade;
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}
`;

/** Soft elliptical contact shadow: dark core, smooth falloff to the rim. */
const SHADOW_FRAG = /* glsl */ `
varying vec2 vLocal;
varying float vAlpha;
void main() {
  float d = length(vLocal);
  float a = vAlpha * (1.0 - smoothstep(0.25, 1.0, d));
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.015, 0.02, 0.04, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Soft dark ellipses lying flat under units and structures (one instanced
 * draw call), so models read as standing on the ground / floating on the
 * water instead of hovering. Depth-tested against the relief (drawn just
 * above it with a polygon offset); never written to depth.
 * Usage per rebuild: `begin()`, `push(...)`, `end()`.
 */
export class BlobShadows {
  private readonly geometry = new THREE.PlaneGeometry(2, 2).rotateX(
    -Math.PI / 2,
  );
  private readonly material = new THREE.ShaderMaterial({
    name: "blob-shadow",
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  private readonly batch: InstancedBatch;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly white = new THREE.Color(1, 1, 1);
  private readonly shear = new THREE.Matrix4();

  constructor(parent: THREE.Object3D, name: string, renderOrder = 1) {
    this.geometry.deleteAttribute("normal");
    this.batch = new InstancedBatch(
      parent,
      this.geometry,
      this.material,
      name,
      32,
      renderOrder,
    );
  }

  get count(): number {
    return this.batch.count;
  }

  begin(): void {
    this.batch.begin();
  }

  /**
   * An ellipse centred at world (x, y, z), `length` × `width` tiles across,
   * its length along heading `yaw` (three Y rotation), with opacity `alpha`,
   * lying on a plane of world gradient (`slopeX`, `slopeZ`) (default flat).
   */
  push(
    x: number,
    y: number,
    z: number,
    length: number,
    width: number,
    yaw: number,
    alpha: number,
    slopeX = 0,
    slopeZ = 0,
  ): void {
    this.p.set(0, 0, 0);
    this.q.setFromAxisAngle(this.up, yaw);
    this.s.set(length / 2, 1, width / 2);
    this.m.compose(this.p, this.q, this.s);
    if (slopeX !== 0 || slopeZ !== 0) {
      // y += slopeX·x + slopeZ·z (the quad is flat in model space).
      this.shear.set(1, 0, 0, 0, slopeX, 1, slopeZ, 0, 0, 0, 1, 0, 0, 0, 0, 1);
      this.m.premultiply(this.shear);
    }
    this.m.setPosition(x, y, z);
    this.batch.push(this.m, this.white, alpha);
  }

  end(): void {
    this.batch.end();
  }

  dispose(): void {
    this.batch.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Part helpers
// ---------------------------------------------------------------------------

interface PartOptions {
  /** 0 = keep the part colour, 1 = multiply by the owner colour. */
  tint?: number;
  /** Emissive strength (0 = none). */
  glow?: number;
}

/** Tags a primitive with part colour / tint / glow (non-indexed, no uv). */
function part(
  geo: THREE.BufferGeometry,
  color: number,
  opts: PartOptions = {},
): THREE.BufferGeometry {
  const g = geo.index !== null ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (g.getAttribute("uv") !== undefined) g.deleteAttribute("uv");
  g.clearGroups();
  const n = g.getAttribute("position").count;
  const c = new THREE.Color(color);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.setAttribute(
    "aTint",
    new THREE.BufferAttribute(new Float32Array(n).fill(opts.tint ?? 0), 1),
  );
  g.setAttribute(
    "aGlow",
    new THREE.BufferAttribute(new Float32Array(n).fill(opts.glow ?? 0), 1),
  );
  return g;
}

/**
 * Drops the triangles of `geo` whose face normal fails `keep` (faces that
 * are never seen, e.g. the bottom of a box lying on the ground). Returns a
 * non-indexed position-only geometry; `geo` is disposed.
 */
function trimmed(
  geo: THREE.BufferGeometry,
  keep: (nx: number, ny: number, nz: number) => boolean,
): THREE.BufferGeometry {
  const g = geo.index !== null ? geo.toNonIndexed() : geo;
  const src = g.getAttribute("position");
  const out: number[] = [];
  const a = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (let i = 0; i + 2 < src.count; i += 3) {
    // Counter-clockwise front faces: n = (b − a) × (c − a).
    a.fromBufferAttribute(src, i);
    e1.fromBufferAttribute(src, i + 1).sub(a);
    e2.fromBufferAttribute(src, i + 2).sub(a);
    const n = e1.cross(e2).normalize();
    if (!keep(n.x, n.y, n.z)) continue;
    for (let k = 0; k < 3; k++) {
      out.push(src.getX(i + k), src.getY(i + k), src.getZ(i + k));
    }
  }
  if (g !== geo) g.dispose();
  geo.dispose();
  const res = new THREE.BufferGeometry();
  res.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(out), 3),
  );
  return res;
}

/** `keep` predicate: everything except faces pointing down. */
const NO_BOTTOM = (_x: number, y: number): boolean => y > -0.5;

/** Box without its bottom face (10 triangles). */
function openBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y0: number,
  z: number,
): THREE.BufferGeometry {
  return trimmed(box(w, h, d, x, y0, z), NO_BOTTOM);
}

/** Triangle count of a (non-)indexed triangle geometry. */
export function triangleCount(g: THREE.BufferGeometry): number {
  const n = g.index !== null ? g.index.count : g.getAttribute("position").count;
  return Math.floor(n / 3);
}

/** Merges parts, scales them, and gives every face a flat normal. */
function assemble(
  parts: THREE.BufferGeometry[],
  scale = 1,
): THREE.BufferGeometry {
  // Drop the primitives' own normals: computeVertexNormals on a non-indexed
  // geometry yields one normal per face (the low-poly faceted look).
  for (const p of parts) {
    if (p.getAttribute("normal") !== undefined) p.deleteAttribute("normal");
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error("ProceduralMeshes: merge failed");
  if (scale !== 1) merged.scale(scale, scale, scale);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** Axis-aligned box with its bottom at `y0`, centred on (x, z). */
function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y0: number,
  z: number,
): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y0 + h / 2, z);
}

/** Vertical cylinder / frustum with its bottom at `y0`. */
function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  seg: number,
  x: number,
  y0: number,
  z: number,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg).translate(
    x,
    y0 + h / 2,
    z,
  );
}

/**
 * Cylinder along X centred at (cx, cy, cz): radius `rBack` at the −X end,
 * `rFront` at the +X end. (CylinderGeometry's top (+Y) maps to +X under a
 * −90° turn about Z.)
 */
function cylX(
  rBack: number,
  rFront: number,
  len: number,
  seg: number,
  cx: number,
  cy = 0,
  cz = 0,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rFront, rBack, len, seg)
    .rotateZ(-Math.PI / 2)
    .translate(cx, cy, cz);
}

/** Cone along X, tip towards +X (or −X with `backwards`), centred at cx. */
function coneX(
  r: number,
  len: number,
  seg: number,
  cx: number,
  backwards = false,
  cy = 0,
  cz = 0,
): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, len, seg)
    .rotateZ(backwards ? Math.PI / 2 : -Math.PI / 2)
    .translate(cx, cy, cz);
}

/** Upper half-sphere (dome) resting on y0. */
function dome(
  r: number,
  seg: number,
  x: number,
  y0: number,
  z: number,
): THREE.BufferGeometry {
  return new THREE.SphereGeometry(
    r,
    seg,
    Math.max(2, seg >> 1),
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  ).translate(x, y0, z);
}

/**
 * A boat hull: outline in the XZ plane (stern at −L/2, bow tip at +L/2,
 * `bowFrac` of the length tapering to the tip, `bluntBow` keeping some width
 * at the tip), extruded from y0 to y0 + h.
 */
function hull(
  len: number,
  width: number,
  h: number,
  y0: number,
  bowFrac: number,
  bluntBow = 0,
  sternRound = 0.15,
): THREE.BufferGeometry {
  const hw = width / 2;
  const sx = -len / 2;
  const bx = len / 2 - len * bowFrac;
  const tip = len / 2;
  const s = new THREE.Shape();
  s.moveTo(sx + width * sternRound, -hw);
  s.lineTo(bx, -hw);
  s.lineTo(tip, -hw * bluntBow);
  s.lineTo(tip, hw * bluntBow);
  s.lineTo(bx, hw);
  s.lineTo(sx + width * sternRound, hw);
  s.lineTo(sx, hw * 0.7);
  s.lineTo(sx, -hw * 0.7);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, {
    depth: h,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  })
    .rotateX(-Math.PI / 2)
    .translate(0, y0, 0);
}

/** Four fins around the X axis (an "X" seen from behind) at x = cx. */
function fins(
  len: number,
  span: number,
  bodyR: number,
  cx: number,
  color: number,
  opts: PartOptions = {},
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const g = new THREE.BoxGeometry(len, 0.06 + bodyR * 0.08, span)
      .translate(cx, 0, bodyR * 0.6 + span / 2)
      .rotateX(Math.PI / 4 + (k * Math.PI) / 2);
    out.push(part(g, color, opts));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette of neutral materials (sRGB hex)
// ---------------------------------------------------------------------------

const C = {
  white: 0xf2f2ee,
  tintBase: 0xffffff,
  tintShade: 0xc8c8c8,
  steel: 0x8b939c,
  steelDark: 0x4a5058,
  hullDark: 0x33373d,
  rust: 0x7a3326,
  stone: 0x9c968b,
  stoneDark: 0x77726a,
  concrete: 0xa9a9a4,
  wood: 0x8a6440,
  wall: 0xe7dcc6,
  paving: 0xd9d5cc,
  ballast: 0x8f877b,
  brick: 0x8e3d2f,
  glass: 0x6f8fa8,
  flame: 0xffa040,
  flameHot: 0xffe08a,
  hazard: 0xe2b322,
  khaki: 0x6e6a3c,
  gold: 0xf2c14e,
  red: 0xc0392b,
  black: 0x222222,
} as const;

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const UnitMesh = {
  Transport: "transport",
  TradeShip: "tradeShip",
  Warship: "warship",
  TrainEngine: "trainEngine",
  TrainCarriage: "trainCarriage",
  TrainLoaded: "trainLoaded",
  AtomBomb: "atomBomb",
  HydrogenBomb: "hydrogenBomb",
  Mirv: "mirv",
  MirvWarhead: "mirvWarhead",
  Shell: "shell",
  SamMissile: "samMissile",
} as const;
export type UnitMeshKind = (typeof UnitMesh)[keyof typeof UnitMesh];

/**
 * Nominal length (tiles) of each unit model, matching the default renderer's
 * sprite sizes (warship 11, boats 5, nukes 7/9/13, warhead & SAM 3, shell 1).
 * Trains follow the engine's 2-tile car spacing. Used for the minimum
 * on-screen size.
 */
export const UNIT_MESH_LENGTH: Readonly<Record<UnitMeshKind, number>> = {
  transport: 5,
  tradeShip: 5.5,
  warship: 11,
  trainEngine: 2.1,
  trainCarriage: 1.9,
  trainLoaded: 1.9,
  atomBomb: 7,
  hydrogenBomb: 9,
  mirv: 13,
  mirvWarhead: 3,
  shell: 1,
  samMissile: 3,
};

/** Builds the geometry of a unit model (caller owns / disposes it). */
export function createUnitGeometry(kind: UnitMeshKind): THREE.BufferGeometry {
  switch (kind) {
    case "transport":
      return transportGeometry();
    case "tradeShip":
      return tradeShipGeometry();
    case "warship":
      return warshipGeometry();
    case "trainEngine":
      return trainEngineGeometry();
    case "trainCarriage":
      return trainCarriageGeometry(false);
    case "trainLoaded":
      return trainCarriageGeometry(true);
    case "atomBomb":
      return atomBombGeometry();
    case "hydrogenBomb":
      return hydrogenBombGeometry();
    case "mirv":
      return mirvGeometry();
    case "mirvWarhead":
      return warheadGeometry();
    case "shell":
      return shellGeometry();
    case "samMissile":
      return samMissileGeometry();
  }
}

/** Landing craft: blunt bow ramp, open owner-coloured deck, troops, cabin. */
function transportGeometry(): THREE.BufferGeometry {
  const parts = [
    part(hull(4.7, 1.8, 0.4, -0.3, 0.14, 0.75), C.hullDark),
    part(hull(4.7, 1.8, 0.42, 0.1, 0.14, 0.75), C.tintBase, { tint: 1 }),
    // Deck slightly lower than the gunwale, lighter owner tone.
    part(box(3.6, 0.06, 1.4, -0.1, 0.42, 0), C.tintShade, { tint: 1 }),
    // Bow ramp.
    part(box(0.18, 0.5, 1.3, 2.2, 0.12, 0), C.steelDark),
    // Stern cabin.
    part(box(0.9, 0.55, 1.1, -1.75, 0.45, 0), C.white),
    part(box(0.95, 0.08, 1.15, -1.75, 1.0, 0), C.tintBase, { tint: 1 }),
  ];
  // Troops on deck: a 3×2 block of little khaki boxes.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      parts.push(
        part(
          box(0.32, 0.38, 0.32, -0.6 + i * 0.6, 0.48, -0.32 + j * 0.64),
          C.khaki,
        ),
      );
    }
  }
  return assemble(parts);
}

/** Cargo ship: dark hull, stacks of containers (mostly owner colour), bridge. */
function tradeShipGeometry(): THREE.BufferGeometry {
  const parts = [
    part(hull(5.3, 1.55, 0.4, -0.35, 0.22, 0, 0.05), C.rust),
    part(hull(5.3, 1.55, 0.35, 0.05, 0.22, 0, 0.05), C.tintBase, { tint: 1 }),
    // Bridge + funnel at the stern.
    part(box(0.75, 0.8, 1.2, -2.0, 0.4, 0), C.white),
    part(box(0.8, 0.08, 1.3, -2.0, 1.2, 0), C.steelDark),
    part(cyl(0.16, 0.18, 0.5, 6, -2.25, 1.2, 0), C.red),
  ];
  // Containers: 4 bays × 2 rows (two tiers in the middle bays); a checker
  // of owner-coloured and neutral orange / blue boxes.
  const neutrals = [0xd9822b, 0x2f7fb8];
  for (let bay = 0; bay < 4; bay++) {
    const x = -1.2 + bay * 0.78;
    for (let row = 0; row < 2; row++) {
      const z = -0.34 + row * 0.68;
      const tinted = (bay + row) % 2 === 0;
      parts.push(
        part(
          box(0.7, 0.36, 0.6, x, 0.4, z),
          tinted ? C.tintBase : neutrals[bay % 2],
          { tint: tinted ? 1 : 0 },
        ),
      );
      if (bay === 1 || bay === 2) {
        parts.push(
          part(box(0.7, 0.34, 0.6, x, 0.77, z), C.tintShade, { tint: 1 }),
        );
      }
    }
  }
  return assemble(parts);
}

/** Warship: long hull, grey superstructure, fore and aft gun turrets. */
function warshipGeometry(): THREE.BufferGeometry {
  const parts = [
    part(hull(10.6, 2.2, 0.45, -0.4, 0.26, 0, 0.08), C.hullDark),
    part(hull(10.6, 2.2, 0.5, 0.05, 0.26, 0, 0.08), C.tintBase, { tint: 1 }),
    // Superstructure: stepped blocks, bridge windows, mast and funnel.
    part(box(3.4, 0.6, 1.4, -0.6, 0.55, 0), C.steel),
    part(box(1.8, 0.55, 1.1, 0.0, 1.15, 0), C.steel),
    part(box(0.9, 0.18, 1.12, 0.45, 1.45, 0), C.glass),
    part(cyl(0.07, 0.09, 1.8, 5, -0.2, 1.7, 0), C.steelDark),
    part(box(0.9, 0.08, 0.08, -0.2, 2.9, 0), C.steelDark),
    part(cyl(0.32, 0.36, 0.7, 8, -1.6, 1.15, 0), C.steelDark),
  ];
  // Turrets (owner colour) with twin barrels.
  const turret = (x: number, dir: 1 | -1, y0: number) => {
    parts.push(
      part(cyl(0.48, 0.55, 0.32, 8, x, y0, 0), C.tintShade, { tint: 1 }),
    );
    for (const z of [-0.13, 0.13]) {
      parts.push(
        part(
          cylX(0.08, 0.07, 1.5, 5, x + dir * 0.95, y0 + 0.2, z),
          C.steelDark,
        ),
      );
    }
  };
  turret(2.6, 1, 0.55);
  turret(1.4, 1, 0.75);
  turret(-3.2, -1, 0.55);
  return assemble(parts);
}

/** Locomotive: chassis, owner-coloured body + cab, dark boiler, chimney. */
function trainEngineGeometry(): THREE.BufferGeometry {
  return assemble([
    part(box(2.0, 0.22, 0.78, 0, 0.0, 0), C.black),
    part(cylX(0.3, 0.3, 1.0, 8, 0.45, 0.52, 0), C.hullDark),
    part(box(0.8, 0.75, 0.82, -0.55, 0.22, 0), C.tintBase, { tint: 1 }),
    part(box(0.95, 0.08, 0.92, -0.55, 0.97, 0), C.tintShade, { tint: 1 }),
    part(cyl(0.11, 0.13, 0.42, 6, 0.75, 0.75, 0), C.hullDark),
    part(box(0.12, 0.3, 0.7, 1.02, 0.12, 0), C.red),
  ]);
}

/** Carriage: chassis + owner-coloured box car, or an open wagon of gold. */
function trainCarriageGeometry(loaded: boolean): THREE.BufferGeometry {
  const parts = [part(box(1.8, 0.2, 0.74, 0, 0.0, 0), C.black)];
  if (loaded) {
    parts.push(
      part(box(1.7, 0.42, 0.76, 0, 0.2, 0), C.tintBase, { tint: 1 }),
      part(box(1.5, 0.2, 0.6, 0, 0.55, 0), C.gold, { glow: 0.3 }),
      part(cyl(0.18, 0.3, 0.22, 6, -0.35, 0.7, 0), C.gold, { glow: 0.3 }),
      part(cyl(0.16, 0.28, 0.2, 6, 0.4, 0.7, 0.05), C.gold, { glow: 0.3 }),
    );
  } else {
    parts.push(
      part(box(1.7, 0.62, 0.76, 0, 0.2, 0), C.tintBase, { tint: 1 }),
      part(box(1.75, 0.07, 0.8, 0, 0.82, 0), C.tintShade, { tint: 1 }),
    );
  }
  return assemble(parts);
}

/**
 * Railway pieces. A piece is half a tile of track, from the tile centre
 * (x = 0) to its edge (x = 0.5) along +X; a straight rail tile is two halves
 * (east + west or north + south), a curve the two halves towards the edges
 * it connects. Two levels of detail share the same instance transforms:
 * - the strip: a flat 2-triangle ballast bed, drawn for every piece;
 * - the detail: two sleepers and two steel rails on top of the strip at the
 *   gauge the train models straddle, drawn only close up.
 */
/** Height of the ballast strip above the piece origin (the ground). */
export const RAIL_STRIP_Y = 0.02;
/** Top of the rail heads above the ground; trains ride on them. */
export const RAIL_TOP = 0.1;

/** The flat ballast bed of a half-tile piece: 2 triangles, normal +Y. */
export function createRailStripGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.5, 0.5)
    .rotateX(-Math.PI / 2)
    .translate(0.25, RAIL_STRIP_Y, 0);
  g.deleteAttribute("uv");
  return g;
}

/**
 * Sleepers (top faces only: they are 1/30 of a tile thick) and rails (top
 * and sides, no ends or bottom) of a half-tile piece: 16 triangles, with
 * the part attributes of `part()`.
 */
export function createRailDetailGeometry(): THREE.BufferGeometry {
  const up = (_x: number, y: number): boolean => y > 0.5;
  const topAndSides = (x: number, y: number): boolean =>
    Math.abs(x) < 0.5 && y > -0.5;
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [0.12, 0.37]) {
    parts.push(part(trimmed(box(0.09, 0.01, 0.46, x, 0.035, 0), up), C.wood));
  }
  for (const z of [-0.15, 0.15]) {
    parts.push(
      part(
        trimmed(box(0.52, RAIL_TOP - 0.04, 0.05, 0.25, 0.04, z), topAndSides),
        C.steelDark,
      ),
    );
  }
  return assemble(parts);
}

/**
 * Low-poly stand-ins for small on-screen units (boats and trains a few
 * dozen px long, shells): the same length, owner tint and silhouette in
 * 8-42 triangles instead of 36-364. Null for kinds without one.
 */
export function createUnitLodGeometry(
  kind: UnitMeshKind,
): THREE.BufferGeometry | null {
  const lowHull = (
    len: number,
    width: number,
    h: number,
    y0: number,
    bowFrac: number,
    bluntBow = 0,
    sternRound = 0.15,
  ) =>
    trimmed(hull(len, width, h, y0, bowFrac, bluntBow, sternRound), NO_BOTTOM);
  switch (kind) {
    case "transport":
      return assemble([
        part(lowHull(4.7, 1.8, 0.82, -0.3, 0.14, 0.75), C.tintBase, {
          tint: 1,
        }),
        part(openBox(0.9, 0.63, 1.1, -1.75, 0.45, 0), C.white),
      ]);
    case "tradeShip":
      return assemble([
        part(lowHull(5.3, 1.55, 0.75, -0.35, 0.22, 0, 0.05), C.tintBase, {
          tint: 1,
        }),
        part(openBox(3.04, 0.7, 1.28, -0.03, 0.4, 0), C.tintShade, {
          tint: 1,
        }),
        part(openBox(0.8, 0.88, 1.25, -2.0, 0.4, 0), C.white),
      ]);
    case "warship":
      return assemble([
        part(lowHull(10.6, 2.2, 0.95, -0.4, 0.26, 0, 0.08), C.tintBase, {
          tint: 1,
        }),
        part(openBox(3.4, 1.15, 1.4, -0.6, 0.55, 0), C.steel),
        part(openBox(1.3, 0.35, 1.0, 2.0, 0.55, 0), C.tintShade, { tint: 1 }),
      ]);
    case "trainEngine":
      return assemble([
        part(openBox(2.0, 0.55, 0.8, 0.15, 0.0, 0), C.hullDark),
        part(openBox(0.9, 1.05, 0.88, -0.55, 0.0, 0), C.tintBase, { tint: 1 }),
      ]);
    case "trainCarriage":
      return assemble([
        part(openBox(1.75, 0.89, 0.78, 0, 0.0, 0), C.tintBase, { tint: 1 }),
      ]);
    case "trainLoaded":
      return assemble([
        part(openBox(1.75, 0.62, 0.78, 0, 0.0, 0), C.tintBase, { tint: 1 }),
        part(openBox(1.5, 0.2, 0.6, 0, 0.62, 0), C.gold, { glow: 0.3 }),
      ]);
    case "shell":
      return assemble([
        part(new THREE.OctahedronGeometry(0.42, 0), C.flameHot, { glow: 2.1 }),
      ]);
    default:
      return null;
  }
}

/**
 * Emissive strength of the bombs' exhaust flames: just over the bloom
 * threshold (a soft glow); it was 4.5-4.8.
 */
export const NUKE_FLAME_GLOW = 2.5;

/** Atom bomb (≈7 tiles): owner-coloured body, white nose, fins, flame. */
function atomBombGeometry(): THREE.BufferGeometry {
  const r = 0.42;
  return assemble([
    part(cylX(r * 0.9, r, 4.4, 10, -0.2), C.tintBase, { tint: 1 }),
    part(cylX(r * 1.04, r * 1.04, 0.3, 10, 1.6), C.hazard),
    part(coneX(r, 1.6, 10, 2.8), C.white),
    ...fins(1.1, 0.7, r, -2.0, C.tintShade, { tint: 1 }),
    part(coneX(r * 0.8, 1.3, 8, -3.05, true), C.flame, {
      glow: NUKE_FLAME_GLOW,
    }),
  ]);
}

/** Hydrogen bomb (≈9 tiles): fatter, big fins, glowing yellow band. */
function hydrogenBombGeometry(): THREE.BufferGeometry {
  const r = 0.62;
  return assemble([
    part(cylX(r * 0.88, r, 5.6, 12, -0.3), C.tintBase, { tint: 1 }),
    part(cylX(r * 1.06, r * 1.06, 0.35, 12, 1.4), C.flameHot, { glow: 1.0 }),
    part(cylX(r * 1.06, r * 1.06, 0.2, 12, -1.6), C.hazard),
    part(coneX(r, 1.9, 12, 3.4), C.white),
    ...fins(1.6, 1.15, r, -2.5, C.tintShade, { tint: 1 }),
    part(coneX(r * 0.85, 1.5, 8, -3.85, true), C.flame, {
      glow: NUKE_FLAME_GLOW,
    }),
  ]);
}

/** MIRV (≈13 tiles): heavy body with four strapped-on warheads, big fins. */
function mirvGeometry(): THREE.BufferGeometry {
  const r = 0.8;
  const parts = [
    part(cylX(r * 0.9, r, 8.2, 12, -0.6), C.tintBase, { tint: 1 }),
    part(coneX(r, 2.6, 12, 4.8), C.white),
    part(cylX(r * 1.04, r * 1.04, 0.3, 12, 2.6), C.hazard),
    ...fins(2.0, 1.4, r, -3.8, C.tintShade, { tint: 1 }),
    part(coneX(r * 0.85, 1.8, 8, -5.6, true), C.flame, {
      glow: NUKE_FLAME_GLOW,
    }),
  ];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const y = Math.sin(a) * r * 1.05;
    const z = Math.cos(a) * r * 1.05;
    parts.push(
      part(cylX(0.2, 0.2, 0.9, 6, 1.8, y, z), C.white),
      part(coneX(0.2, 0.6, 6, 2.55, false, y, z), C.red),
    );
  }
  return assemble(parts);
}

/** MIRV warhead (≈3 tiles): small re-entry vehicle with a glowing tail. */
function warheadGeometry(): THREE.BufferGeometry {
  const r = 0.24;
  return assemble([
    part(cylX(r * 0.85, r, 1.3, 8, -0.2), C.tintBase, { tint: 1 }),
    part(coneX(r, 0.9, 8, 0.9), C.white),
    ...fins(0.4, 0.25, r, -0.7, C.tintShade, { tint: 1 }),
    part(coneX(r * 0.8, 0.7, 6, -1.2, true), C.flame, {
      glow: NUKE_FLAME_GLOW,
    }),
  ]);
}

/** Shell: a small glowing slug (stretched along its heading by the layer). */
function shellGeometry(): THREE.BufferGeometry {
  return assemble([
    part(new THREE.SphereGeometry(0.42, 8, 6), C.flameHot, { glow: 2.1 }),
  ]);
}

/** SAM missile (≈3 tiles): thin white dart, owner band, glowing motor. */
function samMissileGeometry(): THREE.BufferGeometry {
  const r = 0.14;
  return assemble([
    part(cylX(r, r, 2.0, 6, -0.1), C.white),
    part(cylX(r * 1.1, r * 1.1, 0.35, 6, 0.3), C.tintBase, { tint: 1 }),
    part(coneX(r, 0.6, 6, 1.2), C.red),
    ...fins(0.35, 0.22, r, -0.95, C.white),
    part(coneX(r * 0.9, 0.7, 6, -1.45, true), C.flame, { glow: 3.6 }),
  ]);
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

/** Design-to-world scale: models are drawn on a ~6-unit grid. */
export const STRUCTURE_SCALE = 1.35;

/**
 * Footprint (tiles, the model's widest extent) per structure type — about
 * the size the default renderer's icons reach once they become world-anchored.
 */
export const STRUCTURE_FOOTPRINT: Readonly<Record<string, number>> = {
  [UT_CITY]: 6.4 * STRUCTURE_SCALE,
  [UT_PORT]: 7.6 * STRUCTURE_SCALE,
  [UT_FACTORY]: 6.4 * STRUCTURE_SCALE,
  [UT_DEFENSE_POST]: 5.4 * STRUCTURE_SCALE,
  [UT_SAM_LAUNCHER]: 5.6 * STRUCTURE_SCALE,
  [UT_MISSILE_SILO]: 5.6 * STRUCTURE_SCALE,
};

/** Highest level with its own model; higher levels reuse it. */
export const MAX_VISUAL_LEVEL = 6;

/**
 * Model variant for a structure level. Cities, SAM launchers and missile
 * silos change shape with level (more towers / tubes / silos); the other
 * types have one model and are stretched by the layer instead.
 */
export function structureVariant(type: string, level: number): number {
  const lv = Math.max(1, Math.min(MAX_VISUAL_LEVEL, Math.floor(level) || 1));
  switch (type) {
    case UT_CITY:
      return lv;
    case UT_SAM_LAUNCHER:
      return Math.min(3, lv);
    case UT_MISSILE_SILO:
      return Math.min(4, lv);
    default:
      return 1;
  }
}

/** True when `structureVariant` already encodes the level for this type. */
export function levelChangesModel(type: string): boolean {
  return (
    type === UT_CITY || type === UT_SAM_LAUNCHER || type === UT_MISSILE_SILO
  );
}

// ---- Pads (bases) ----------------------------------------------------------

/** Top of a pad above the model origin (design units); buildings stand on it. */
export const PAD_TOP = 0.3;
/** Bottom of the pads' foundations (design units): they reach into the ground. */
const PAD_BOTTOM = -1.2;
/**
 * Parts standing on a pad (bottom within PAD_STANDING of PAD_TOP) are
 * extended down to here (design units), so on a sloped pad they never leave
 * a gap above it.
 */
export const FOOTING_Y = -0.5;
const PAD_STANDING: readonly [number, number] = [0.05, 0.5];

/**
 * The base of a structure model, in model space (tiles; +X is the port's
 * water side): its x / z extent, and whether it is round (defense posts and
 * SAM launchers: a disc of radius (x1 − x0) / 2 around its centre).
 */
export interface StructurePad {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  round: boolean;
}

/**
 * Spacing (design units) of a city's 3×3 tower grid at `level`: tight while
 * the 3-5 towers sit on the diagonal slots, wider once the edge slots fill
 * (level 4 on).
 */
function citySpacing(level: number): number {
  const lv = Math.max(1, Math.min(MAX_VISUAL_LEVEL, level));
  // Roofs (1.12 × the tower) at least ~0.15 apart, so the towers read as
  // a cluster, not one block.
  return lv <= 3 ? 1.53 + 0.04 * (lv - 1) : 1.78 + 0.08 * (lv - 4);
}

/** Tower width factor: slimmer towers while a city is small (levels 1-3). */
function cityTowerWidth(level: number): number {
  return level <= 3 ? 0.85 : 1;
}

/** Half side (design units) of a city's square pad at `level`. */
function cityPadHalf(level: number): number {
  const lv = Math.max(1, Math.min(MAX_VISUAL_LEVEL, level));
  // Corner towers (1.35 wide × cityTowerWidth, roofs 1.12×) plus a margin.
  return citySpacing(lv) + 0.756 * cityTowerWidth(lv) + 0.12;
}

const SAM_PAD_R = [2.0, 2.25, 2.5] as const;
const DEFENSE_RING_R = 2.0;
const DEFENSE_PAD_R = 2.45;

/** `structurePad` in design units. */
function padDesign(type: string, variant: number): StructurePad {
  const sq = (h: number): StructurePad => ({
    x0: -h,
    x1: h,
    z0: -h,
    z1: h,
    round: false,
  });
  const disc = (r: number): StructurePad => ({ ...sq(r), round: true });
  switch (type) {
    case UT_CITY:
      return sq(cityPadHalf(variant));
    case UT_PORT:
      return { x0: -3.0, x1: 0.4, z0: -2.45, z1: 2.3, round: false };
    case UT_FACTORY:
      return { x0: -3.0, x1: 3.05, z0: -1.95, z1: 1.95, round: false };
    case UT_DEFENSE_POST:
      return disc(DEFENSE_PAD_R);
    case UT_SAM_LAUNCHER:
      return disc(SAM_PAD_R[Math.max(1, Math.min(3, variant)) - 1]);
    case UT_MISSILE_SILO:
      return sq(variant <= 1 ? 2.4 : 2.5);
    default:
      return sq(2.5);
  }
}

/**
 * The pad (base) of a structure model in model space, tiles (lot 3:
 * smaller than the former plazas, sized by type and level). The layer fits
 * it on land (`fitPadOnLand`) and onto the relief; a port's pier reaches
 * out over the water beyond it by design.
 */
export function structurePad(type: string, variant = 1): StructurePad {
  const d = padDesign(type, variant);
  const k = STRUCTURE_SCALE;
  return {
    x0: d.x0 * k,
    x1: d.x1 * k,
    z0: d.z0 * k,
    z1: d.z1 * k,
    round: d.round,
  };
}

/** Marks a part as the pad: each of its vertices follows the ground. */
function footing(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.userData.footing = true;
  return g;
}

/**
 * Anchors rigid parts at (x, z) (design units): they move with the ground's
 * height there (one building, one assembly). Default: the model centre.
 */
function anchored(
  parts: THREE.BufferGeometry[],
  x: number,
  z: number,
): THREE.BufferGeometry[] {
  for (const p of parts) p.userData.anchor = [x, z];
  return parts;
}

/** Keeps a part's bottom where it is (the port's pier over the water). */
function keepBottom(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.userData.keepBottom = true;
  return g;
}

/**
 * `assemble` for structures: gives every vertex `aFooting` for the
 * `conform` part material — (u, v) on the pad rectangle `pad` (design
 * units) of the vertex for pad parts, of the part's anchor otherwise, then
 * the pad's model-space width and depth for pad vertices (0 otherwise) —
 * and extends the parts standing on the pad down to FOOTING_Y.
 */
function assembleStructure(
  parts: THREE.BufferGeometry[],
  pad: StructurePad,
  scale = STRUCTURE_SCALE,
): THREE.BufferGeometry {
  const w = pad.x1 - pad.x0;
  const d = pad.z1 - pad.z0;
  for (const p of parts) {
    const pos = p.getAttribute("position") as THREE.BufferAttribute;
    const n = pos.count;
    const isFooting = p.userData.footing === true;
    let minY = Infinity;
    for (let i = 0; i < n; i++) minY = Math.min(minY, pos.getY(i));
    if (
      !isFooting &&
      p.userData.keepBottom !== true &&
      minY > PAD_STANDING[0] &&
      minY < PAD_STANDING[1]
    ) {
      for (let i = 0; i < n; i++) {
        if (Math.abs(pos.getY(i) - minY) < 1e-4) pos.setY(i, FOOTING_Y);
      }
    }
    const anchor = (p.userData.anchor as [number, number] | undefined) ?? [
      0, 0,
    ];
    const f = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = isFooting ? pos.getX(i) : anchor[0];
      const z = isFooting ? pos.getZ(i) : anchor[1];
      f[i * 4] = (x - pad.x0) / w;
      f[i * 4 + 1] = (z - pad.z0) / d;
      f[i * 4 + 2] = isFooting ? w * scale : 0;
      f[i * 4 + 3] = isFooting ? d * scale : 0;
    }
    p.setAttribute("aFooting", new THREE.BufferAttribute(f, 4));
  }
  return assemble(parts, scale);
}

/**
 * The pad of a structure as one part (design units): a block from
 * PAD_BOTTOM (below the ground) to PAD_TOP, its top in `top` lightly tinted
 * with the owner colour (so the base reads as the owner's from above), its
 * sides in `side`; no bottom face. The top is split 2×2 (rect) or fanned
 * (round: an octagon turned by π/8, flat sides facing the defense post's
 * walls) so that it follows the 3×3 ground grid.
 */
function padPart(
  pad: StructurePad,
  side: number,
  top: number,
  topTint: number,
): THREE.BufferGeometry {
  const w = pad.x1 - pad.x0;
  const d = pad.z1 - pad.z0;
  const h = PAD_TOP - PAD_BOTTOM;
  const g = pad.round
    ? new THREE.CylinderGeometry(w / 2, w / 2, h, 8, 1).rotateY(Math.PI / 8)
    : new THREE.BoxGeometry(w, h, d, 2, 1, 2);
  g.translate((pad.x0 + pad.x1) / 2, PAD_BOTTOM + h / 2, (pad.z0 + pad.z1) / 2);
  const geo = part(trimmed(g, NO_BOTTOM), side);
  // Two tones: the faces looking up take the top colour and owner tint.
  const pos = geo.getAttribute("position");
  const col = geo.getAttribute("color") as THREE.BufferAttribute;
  const tint = geo.getAttribute("aTint") as THREE.BufferAttribute;
  const c = new THREE.Color(top);
  const a = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    e1.fromBufferAttribute(pos, i + 1).sub(a);
    e2.fromBufferAttribute(pos, i + 2).sub(a);
    if (e1.cross(e2).normalize().y < 0.5) continue;
    for (let k = i; k < i + 3; k++) {
      col.setXYZ(k, c.r, c.g, c.b);
      tint.setX(k, topTint);
    }
  }
  return footing(geo);
}

/** Pad colours per type (sRGB): sides, top, top owner tint. */
const PAD_STYLE: Readonly<Record<string, readonly [number, number, number]>> = {
  [UT_CITY]: [C.stone, C.paving, 0.45],
  [UT_PORT]: [C.stoneDark, C.stone, 0.3],
  [UT_FACTORY]: [C.stoneDark, 0x8c877e, 0.3],
  [UT_DEFENSE_POST]: [0x6f6650, 0x968a68, 0.35],
  [UT_SAM_LAUNCHER]: [C.stoneDark, C.concrete, 0.3],
  [UT_MISSILE_SILO]: [C.stoneDark, C.paving, 0.4],
};

/** The pad part of a structure type at a model variant. */
function typePad(type: string, variant: number): THREE.BufferGeometry {
  const [side, top, tint] = PAD_STYLE[type] ?? [C.stone, C.paving, 0.45];
  return padPart(padDesign(type, variant), side, top, tint);
}

/**
 * Builds the geometry of a structure model; `variant` comes from
 * `structureVariant`. Returns null for unknown types.
 */
export function createStructureGeometry(
  type: string,
  variant = 1,
): THREE.BufferGeometry | null {
  switch (type) {
    case UT_CITY:
      return cityGeometry(variant);
    case UT_PORT:
      return portGeometry();
    case UT_FACTORY:
      return factoryGeometry();
    case UT_DEFENSE_POST:
      return defensePostGeometry();
    case UT_SAM_LAUNCHER:
      return samLauncherGeometry(variant);
    case UT_MISSILE_SILO:
      return missileSiloGeometry(variant);
    default:
      return null;
  }
}

/** City tower slots (3×3 grid: centre → corners → edges) and counts. */
const CITY_SLOTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];
const CITY_TOWERS = [3, 4, 5, 6, 7, 9] as const;

/** Silo positions (design units) and radius for 1..4 silos. */
function siloSpots(n: number): { spots: [number, number][]; r: number } {
  const corners: [number, number][] = [
    [-1.15, -1.15],
    [1.15, 1.15],
    [1.15, -1.15],
    [-1.15, 1.15],
  ];
  return n === 1
    ? { spots: [[0.3, 0]], r: 1.5 }
    : { spots: corners.slice(0, n), r: 1.0 };
}

/** Control bunker of a silo site (design units), when a corner is free. */
function siloBunker(n: number): [number, number] | null {
  if (n >= 4) return null;
  return n === 1 ? [-1.75, 1.55] : [-1.3, 1.3];
}

/**
 * Low-poly stand-in for a structure model that is only a few dozen px wide
 * on screen: the same pad, owner-tinted roofs and rough silhouette (main
 * block, chimney / crane / domes) in 40-110 triangles instead of 156-936,
 * with no hidden bottom faces. Null for unknown types.
 */
export function createStructureLodGeometry(
  type: string,
  variant = 1,
): THREE.BufferGeometry | null {
  const lowCyl = (
    rTop: number,
    rBottom: number,
    h: number,
    seg: number,
    x: number,
    y0: number,
    z: number,
  ) => trimmed(cyl(rTop, rBottom, h, seg, x, y0, z), NO_BOTTOM);
  const tint = { tint: 1 };
  let parts: THREE.BufferGeometry[];
  let padVariant = 1;
  switch (type) {
    case UT_CITY: {
      const lv = Math.max(1, Math.min(MAX_VISUAL_LEVEL, variant));
      padVariant = lv;
      const grow = 1 + 0.32 * (lv - 1);
      const block = 0.75 * grow + 0.5;
      const tower = 1.3 * grow + 0.5;
      const side = 2 * (citySpacing(lv) + 0.6);
      parts = [
        typePad(type, lv),
        part(openBox(side, block, side, 0, 0.3, 0), C.wall),
        part(
          openBox(side + 0.2, 0.22, side + 0.2, 0, 0.3 + block, 0),
          C.tintBase,
          tint,
        ),
        part(openBox(1.55, tower, 1.55, 0, 0.3, 0), C.wall),
        part(openBox(1.75, 0.3, 1.75, 0, 0.3 + tower, 0), C.tintShade, tint),
      ];
      break;
    }
    case UT_PORT:
      parts = [
        typePad(type, 1),
        ...anchored(
          [
            part(openBox(2.6, 1.0, 2.4, -1.4, 0.3, -1.1), C.wall),
            part(openBox(2.8, 0.25, 2.6, -1.4, 1.3, -1.1), C.tintBase, tint),
          ],
          -1.4,
          -1.1,
        ),
        ...anchored(
          [keepBottom(part(openBox(4.0, 0.18, 1.3, 2.4, 0.12, 0.4), C.wood))],
          0.4,
          0.4,
        ),
        ...anchored(
          [
            part(openBox(0.35, 2.8, 0.35, -0.1, 0.3, 1.75), C.tintBase, tint),
            part(openBox(3.4, 0.22, 0.26, 1.3, 3.0, 1.75), C.tintBase, tint),
          ],
          -0.1,
          1.75,
        ),
      ];
      break;
    case UT_FACTORY:
      parts = [
        typePad(type, 1),
        part(openBox(4.6, 1.3, 3.4, -0.5, 0.3, 0), C.wall),
        part(openBox(4.6, 0.75, 3.4, -0.5, 1.6, 0), C.tintBase, tint),
        ...anchored(
          [part(openBox(0.75, 3.4, 0.75, 2.3, 0.3, -0.9), C.brick)],
          2.3,
          -0.9,
        ),
      ];
      break;
    case UT_DEFENSE_POST:
      parts = [
        typePad(type, 1),
        part(
          lowCyl(
            DEFENSE_RING_R + 0.2,
            DEFENSE_RING_R + 0.2,
            0.99,
            8,
            0,
            0.3,
            0,
          ),
          C.tintBase,
          tint,
        ),
        part(lowCyl(1.0, 1.1, 0.7, 6, 0, 1.29, 0), C.tintShade, tint),
      ];
      break;
    case UT_SAM_LAUNCHER: {
      const cols = Math.max(1, Math.min(3, variant));
      padVariant = cols;
      parts = [
        typePad(type, cols),
        part(lowCyl(1.6, 1.7, 0.3, 8, 0, 0.4, 0), C.tintBase, tint),
        part(openBox(2.0, 0.9, 0.5 + 0.55 * cols, 0.3, 0.9, 0), C.white),
      ];
      break;
    }
    case UT_MISSILE_SILO: {
      const n = Math.max(1, Math.min(4, variant));
      const { spots, r } = siloSpots(n);
      padVariant = n;
      parts = [typePad(type, n)];
      for (const [x, z] of spots) {
        parts.push(
          ...anchored(
            [part(lowCyl(r, r * 1.2, 0.95, 6, x, 0.3, z), C.tintBase, tint)],
            x,
            z,
          ),
        );
      }
      break;
    }
    default:
      return null;
  }
  return assembleStructure(parts, padDesign(type, padVariant));
}

/**
 * City: a cluster of towers on a paved pad; level n adds towers (filling a
 * 3×3 grid centre → corners → edges), makes them taller and spreads them a
 * little (the pad grows with them). Roofs carry the owner colour, so the
 * top-down view reads like the default renderer's icon. Each tower stands
 * on the slope where it is (its own anchor).
 */
function cityGeometry(level: number): THREE.BufferGeometry {
  const lv = Math.max(1, Math.min(MAX_VISUAL_LEVEL, level));
  const parts = [typePad(UT_CITY, lv)];
  const n = CITY_TOWERS[lv - 1];
  // Fixed per-slot variation so every city of a level looks the same.
  const jitter = [1, 0.62, 0.75, 0.55, 0.7, 0.5, 0.66, 0.58, 0.8];
  const grow = 1 + 0.32 * (lv - 1);
  const sp = citySpacing(lv);
  for (let k = 0; k < n; k++) {
    const [gx, gz] = CITY_SLOTS[k];
    const x = gx * sp;
    const z = gz * sp;
    const w = (k === 0 ? 1.55 : 1.35) * cityTowerWidth(lv);
    const h = 1.3 * grow * jitter[k] + 0.5;
    const tower = [
      part(box(w, h, w, x, 0.3, z), C.wall),
      // Window band.
      part(box(w * 1.02, 0.14, w * 1.02, x, 0.3 + h * 0.6, z), C.glass),
      // Owner-coloured roof with a small overhang.
      part(box(w * 1.12, 0.22, w * 1.12, x, 0.3 + h, z), C.tintBase, {
        tint: 1,
      }),
    ];
    if (k === 0) {
      // The tallest tower gets a stepped crown and an antenna.
      tower.push(
        part(box(w * 0.6, 0.5, w * 0.6, x, 0.52 + h, z), C.tintShade, {
          tint: 1,
        }),
        part(cyl(0.05, 0.07, 0.9, 4, x, 1.02 + h, z), C.steelDark),
      );
    }
    parts.push(...anchored(tower, x, z));
  }
  return assembleStructure(parts, padDesign(UT_CITY, lv));
}

/**
 * Port: a stone quay (the pad, on land) with a warehouse, containers and a
 * crane, and a pier towards +X reaching out over the water on posts.
 */
function portGeometry(): THREE.BufferGeometry {
  const parts = [
    typePad(UT_PORT, 1),
    // Warehouse.
    ...anchored(
      [
        part(box(2.6, 1.0, 2.4, -1.4, 0.3, -1.1), C.wall),
        part(box(2.8, 0.25, 2.6, -1.4, 1.3, -1.1), C.tintBase, { tint: 1 }),
      ],
      -1.4,
      -1.1,
    ),
    // Containers on the quay.
    ...anchored(
      [
        part(box(0.9, 0.45, 0.5, -1.8, 0.3, 1.3), C.tintShade, { tint: 1 }),
        part(box(0.9, 0.45, 0.5, -0.8, 0.3, 1.3), 0xd9822b),
      ],
      -1.3,
      1.3,
    ),
  ];
  // Pier (planks on posts) from the quay's edge out over the water, flush
  // with the quay's top (the model sits low on the shore since lot 3: a
  // lower deck hid its posts under the water).
  const pier = [
    keepBottom(part(box(4.0, 0.18, 1.3, 2.4, PAD_TOP - 0.06, 0.4), C.wood)),
  ];
  for (const x of [1.4, 2.6, 3.8]) {
    for (const z of [-0.15, 0.95]) {
      pier.push(part(cyl(0.09, 0.09, 1.5, 5, x, -1.2, z), C.wood));
    }
  }
  parts.push(...anchored(pier, 0.4, 0.4));
  // Crane on the quay's edge: tower, jib out over the pier, counterweight.
  parts.push(
    ...anchored(
      [
        part(box(0.35, 2.8, 0.35, -0.1, 0.3, 1.75), C.tintBase, { tint: 1 }),
        part(box(3.4, 0.22, 0.26, 1.0, 3.0, 1.75), C.tintBase, { tint: 1 }),
        part(box(0.6, 0.4, 0.5, -1.0, 2.85, 1.75), C.steelDark),
        part(cyl(0.025, 0.025, 1.6, 3, 2.4, 1.4, 1.75), C.steelDark),
      ],
      -0.1,
      1.75,
    ),
  );
  return assembleStructure(parts, padDesign(UT_PORT, 1));
}

/** Factory: hall with an owner-coloured sawtooth roof and a brick chimney. */
function factoryGeometry(): THREE.BufferGeometry {
  const hall = [part(box(4.6, 1.3, 3.4, -0.5, 0.3, 0), C.wall)];
  // Sawtooth roof: right-triangle prisms (vertical glazed face towards +X).
  const teeth = 4;
  const tw = 4.6 / teeth;
  for (let k = 0; k < teeth; k++) {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(tw, 0);
    s.lineTo(tw, 0.75);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, {
      depth: 3.4,
      bevelEnabled: false,
      steps: 1,
    }).translate(-2.8 + k * tw, 1.6, -1.7);
    hall.push(part(g, C.tintBase, { tint: 1 }));
  }
  const parts = [
    typePad(UT_FACTORY, 1),
    ...anchored(hall, -0.5, 0),
    // Chimney with a dark rim.
    ...anchored(
      [
        part(cyl(0.32, 0.42, 3.4, 8, 2.3, 0.3, -0.9), C.brick),
        part(cyl(0.36, 0.36, 0.2, 8, 2.3, 3.7, -0.9), C.hullDark),
      ],
      2.3,
      -0.9,
    ),
    // Small annex.
    ...anchored(
      [
        part(box(1.0, 0.8, 1.2, 2.3, 0.3, 1.0), C.wall),
        part(box(1.1, 0.15, 1.3, 2.3, 1.1, 1.0), C.tintShade, { tint: 1 }),
      ],
      2.3,
      1.0,
    ),
  ];
  return assembleStructure(parts, padDesign(UT_FACTORY, 1));
}

/**
 * Defense post: an earthwork pad with an octagonal stone wall ring (owner
 * caps), each section standing on the slope where it is, and a central
 * bunker.
 */
function defensePostGeometry(): THREE.BufferGeometry {
  const parts = [typePad(UT_DEFENSE_POST, 1)];
  const ringR = DEFENSE_RING_R;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const seg = 2 * ringR * Math.tan(Math.PI / 8);
    const wall = box(seg * 1.02, 0.85, 0.38, 0, 0.3, 0);
    const cap = box(seg * 1.04, 0.14, 0.46, 0, 1.15, 0);
    // Place each wall section tangentially on the ring.
    const section: THREE.BufferGeometry[] = [];
    for (const [g, color, tint] of [
      [wall, C.stone, 0],
      [cap, C.tintBase, 1],
    ] as const) {
      g.translate(0, 0, ringR).rotateY(a);
      section.push(part(g, color, { tint }));
    }
    parts.push(...anchored(section, ringR * Math.sin(a), ringR * Math.cos(a)));
  }
  parts.push(
    part(cyl(1.05, 1.15, 0.7, 8, 0, 0.3, 0), C.concrete),
    part(dome(1.0, 8, 0, 1.0, 0), C.tintBase, { tint: 1 }),
    part(cyl(0.04, 0.04, 1.6, 4, 0.0, 1.8, 0), C.steelDark),
    part(box(0.6, 0.35, 0.04, 0.32, 3.0, 0), C.tintBase, { tint: 1 }),
  );
  return assembleStructure(parts, padDesign(UT_DEFENSE_POST, 1));
}

/**
 * SAM launcher: round concrete pad (wider with level), owner-coloured
 * turntable and a rack of tubes angled up towards +X; variant 1..3 → 2 / 4
 * / 6 tubes.
 */
function samLauncherGeometry(variant: number): THREE.BufferGeometry {
  const cols = Math.max(1, Math.min(3, variant));
  const parts = [
    typePad(UT_SAM_LAUNCHER, cols),
    part(cyl(1.6, 1.7, 0.3, 10, 0, 0.4, 0), C.tintBase, { tint: 1 }),
    part(box(1.4, 0.6, 1.2, -0.6, 0.7, 0), C.tintShade, { tint: 1 }),
  ];
  const tilt = (35 * Math.PI) / 180;
  for (let c = 0; c < cols; c++) {
    for (const row of [0, 1]) {
      const z = (c - (cols - 1) / 2) * 0.55;
      const y = 1.1 + row * 0.5;
      const tube = cylX(0.2, 0.2, 2.4, 6, 0.4, 0, 0)
        .rotateZ(tilt)
        .translate(0, y, z);
      const tip = coneX(0.2, 0.45, 6, 1.83, false, 0, 0)
        .rotateZ(tilt)
        .translate(0, y, z);
      parts.push(part(tube, C.white), part(tip, C.red));
    }
  }
  return assembleStructure(parts, padDesign(UT_SAM_LAUNCHER, cols));
}

/**
 * Missile silo: concrete pad with 1..4 round silos (owner-coloured domes
 * ringed with hazard paint) and a small control building.
 */
function missileSiloGeometry(variant: number): THREE.BufferGeometry {
  const n = Math.max(1, Math.min(4, variant));
  const parts = [typePad(UT_MISSILE_SILO, n)];
  const { spots, r } = siloSpots(n);
  for (const [x, z] of spots) {
    parts.push(
      ...anchored(
        [
          part(cyl(r * 1.15, r * 1.25, 0.4, 12, x, 0.3, z), C.stone),
          part(cyl(r * 1.02, r * 1.02, 0.08, 12, x, 0.7, z), C.hazard),
          part(dome(r * 0.92, 12, x, 0.7, z), C.tintBase, { tint: 1 }),
        ],
        x,
        z,
      ),
    );
  }
  // Control bunker (only when a corner is free).
  const b = siloBunker(n);
  if (b !== null) {
    const [bx, bz] = b;
    parts.push(
      ...anchored(
        [
          part(box(1.1, 0.6, 1.0, bx, 0.3, bz), C.wall),
          part(box(1.2, 0.14, 1.1, bx, 0.9, bz), C.tintShade, { tint: 1 }),
        ],
        bx,
        bz,
      ),
    );
  }
  return assembleStructure(parts, padDesign(UT_MISSILE_SILO, n));
}
