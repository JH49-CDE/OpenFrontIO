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
 * - `aGlow` (≥ 0): emissive strength (exhaust flames, shells), which the
 *   bloom pass turns into a glow.
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
 * MeshStandardMaterial for merged part geometry drawn by an `InstancedBatch`:
 * per-vertex colour × (instance colour where `aTint` = 1) × per-instance
 * `iShade`, plus emissive `vColor × aGlow × glow.value`.
 *
 * Only for meshes that carry `aTint`/`aGlow` and an `iShade` instanced
 * attribute (a missing attribute reads as 0 and would turn the mesh black).
 */
export function createPartMaterial(opts: {
  roughness?: number;
  metalness?: number;
  /** Shared emissive multiplier (animate `.value` for flicker). */
  glow: { value: number };
}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: opts.roughness ?? 0.65,
    metalness: opts.metalness ?? 0.08,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowStrength = opts.glow;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float aTint;
attribute float aGlow;
attribute float iShade;
varying float vGlow;`,
      )
      .replace(
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
  mat.customProgramCacheKey = () => "openfront-three-parts-v1";
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
 * cached bounding sphere would go stale).
 */
export class InstancedBatch {
  mesh: THREE.InstancedMesh;
  /** Instances written since `begin()`. */
  count = 0;
  private shadeAttr!: THREE.InstancedBufferAttribute;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly template: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly name: string,
    initialCapacity = 16,
    private readonly renderOrder = 0,
  ) {
    this.mesh = this.create(nextCapacity(0, initialCapacity));
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  begin(): void {
    this.count = 0;
  }

  /** Appends an instance and returns its index. */
  push(m: THREE.Matrix4, color: THREE.Color, shade = 1): number {
    const i = this.count;
    if (i >= this.capacity) this.grow(i + 1);
    this.mesh.setMatrixAt(i, m);
    this.mesh.setColorAt(i, color);
    this.shadeAttr.array[i] = shade;
    this.count = i + 1;
    return i;
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
    const next = this.create(nextCapacity(this.capacity, needed));
    next.instanceMatrix.array.set(old.instanceMatrix.array);
    if (old.instanceColor && next.instanceColor) {
      next.instanceColor.array.set(old.instanceColor.array);
    }
    this.shadeAttr.array.set(oldShade.array);
    this.parent.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.mesh = next;
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
      part(box(1.5, 0.2, 0.6, 0, 0.55, 0), C.gold, { glow: 0.12 }),
      part(cyl(0.18, 0.3, 0.22, 6, -0.35, 0.7, 0), C.gold, { glow: 0.12 }),
      part(cyl(0.16, 0.28, 0.2, 6, 0.4, 0.7, 0.05), C.gold, { glow: 0.12 }),
    );
  } else {
    parts.push(
      part(box(1.7, 0.62, 0.76, 0, 0.2, 0), C.tintBase, { tint: 1 }),
      part(box(1.75, 0.07, 0.8, 0, 0.82, 0), C.tintShade, { tint: 1 }),
    );
  }
  return assemble(parts);
}

/** Atom bomb (≈7 tiles): owner-coloured body, white nose, fins, flame. */
function atomBombGeometry(): THREE.BufferGeometry {
  const r = 0.42;
  return assemble([
    part(cylX(r * 0.9, r, 4.4, 10, -0.2), C.tintBase, { tint: 1 }),
    part(cylX(r * 1.04, r * 1.04, 0.3, 10, 1.6), C.hazard),
    part(coneX(r, 1.6, 10, 2.8), C.white),
    ...fins(1.1, 0.7, r, -2.0, C.tintShade, { tint: 1 }),
    part(coneX(r * 0.8, 1.3, 8, -3.05, true), C.flame, { glow: 1.6 }),
  ]);
}

/** Hydrogen bomb (≈9 tiles): fatter, big fins, glowing yellow band. */
function hydrogenBombGeometry(): THREE.BufferGeometry {
  const r = 0.62;
  return assemble([
    part(cylX(r * 0.88, r, 5.6, 12, -0.3), C.tintBase, { tint: 1 }),
    part(cylX(r * 1.06, r * 1.06, 0.35, 12, 1.4), C.flameHot, { glow: 1.1 }),
    part(cylX(r * 1.06, r * 1.06, 0.2, 12, -1.6), C.hazard),
    part(coneX(r, 1.9, 12, 3.4), C.white),
    ...fins(1.6, 1.15, r, -2.5, C.tintShade, { tint: 1 }),
    part(coneX(r * 0.85, 1.5, 8, -3.85, true), C.flame, { glow: 1.8 }),
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
    part(coneX(r * 0.85, 1.8, 8, -5.6, true), C.flame, { glow: 1.8 }),
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
    part(coneX(r * 0.8, 0.7, 6, -1.2, true), C.flame, { glow: 2.0 }),
  ]);
}

/** Shell: a small glowing slug (stretched along its heading by the layer). */
function shellGeometry(): THREE.BufferGeometry {
  return assemble([
    part(new THREE.SphereGeometry(0.42, 8, 6), C.flameHot, { glow: 2.4 }),
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
    part(coneX(r * 0.9, 0.7, 6, -1.45, true), C.flame, { glow: 2.4 }),
  ]);
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

/** Design-to-world scale: models are drawn on a ~6-unit grid. */
const STRUCTURE_SCALE = 1.35;

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

/** Stone plaza with a foundation that reaches below the ground. */
function plaza(w: number, d: number, color: number = C.stone) {
  return part(box(w, 1.5, d, 0, -1.2, 0), color);
}

/**
 * City: a cluster of towers on a plaza; level n adds towers (filling a 3×3
 * grid centre → corners → edges) and makes them taller. Roofs carry the owner
 * colour, so the top-down view reads like the default renderer's icon.
 */
function cityGeometry(level: number): THREE.BufferGeometry {
  const parts = [plaza(6.2, 6.2)];
  const slots: [number, number][] = [
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
  const counts = [3, 4, 5, 6, 7, 9];
  const n = counts[Math.min(counts.length, Math.max(1, level)) - 1];
  // Fixed per-slot variation so every city of a level looks the same.
  const jitter = [1, 0.62, 0.75, 0.55, 0.7, 0.5, 0.66, 0.58, 0.8];
  const grow = 1 + 0.32 * (level - 1);
  for (let k = 0; k < n; k++) {
    const [gx, gz] = slots[k];
    const x = gx * 1.9;
    const z = gz * 1.9;
    const w = k === 0 ? 1.55 : 1.35;
    const h = 1.3 * grow * jitter[k] + 0.5;
    parts.push(part(box(w, h, w, x, 0.3, z), C.wall));
    // Window band.
    parts.push(
      part(box(w * 1.02, 0.14, w * 1.02, x, 0.3 + h * 0.6, z), C.glass),
    );
    // Owner-coloured roof with a small overhang; the tallest tower gets a
    // stepped crown and an antenna.
    parts.push(
      part(box(w * 1.12, 0.22, w * 1.12, x, 0.3 + h, z), C.tintBase, {
        tint: 1,
      }),
    );
    if (k === 0) {
      parts.push(
        part(box(w * 0.6, 0.5, w * 0.6, x, 0.52 + h, z), C.tintShade, {
          tint: 1,
        }),
        part(cyl(0.05, 0.07, 0.9, 4, x, 1.02 + h, z), C.steelDark),
      );
    }
  }
  return assemble(parts, STRUCTURE_SCALE);
}

/** Port: quay, warehouse with owner roof, a pier towards +X and a crane. */
function portGeometry(): THREE.BufferGeometry {
  const parts = [
    part(box(4.2, 1.5, 5.4, -1.1, -1.2, 0), C.stone),
    // Warehouse.
    part(box(2.6, 1.0, 2.4, -1.4, 0.3, -1.1), C.wall),
    part(box(2.8, 0.25, 2.6, -1.4, 1.3, -1.1), C.tintBase, { tint: 1 }),
    // Containers on the quay.
    part(box(0.9, 0.45, 0.5, -1.8, 0.3, 1.3), C.tintShade, { tint: 1 }),
    part(box(0.9, 0.45, 0.5, -0.8, 0.3, 1.3), 0xd9822b),
    // Pier (planks on posts) reaching out over the water.
    part(box(3.6, 0.18, 1.3, 2.6, 0.12, 0.4), C.wood),
  ];
  for (const x of [1.4, 2.6, 3.8]) {
    for (const z of [-0.15, 0.95]) {
      parts.push(part(cyl(0.09, 0.09, 1.3, 5, x, -1.2, z), C.wood));
    }
  }
  // Crane: tower, jib out over the pier, counterweight.
  parts.push(
    part(box(0.35, 2.8, 0.35, 0.8, 0.3, 1.5), C.tintBase, { tint: 1 }),
    part(box(3.4, 0.22, 0.26, 1.9, 3.0, 1.5), C.tintBase, { tint: 1 }),
    part(box(0.6, 0.4, 0.5, -0.1, 2.85, 1.5), C.steelDark),
    part(cyl(0.025, 0.025, 1.6, 3, 3.3, 1.4, 1.5), C.steelDark),
  );
  return assemble(parts, STRUCTURE_SCALE);
}

/** Factory: hall with an owner-coloured sawtooth roof and a brick chimney. */
function factoryGeometry(): THREE.BufferGeometry {
  const parts = [
    plaza(6.2, 4.8, C.stoneDark),
    part(box(4.6, 1.3, 3.4, -0.5, 0.3, 0), C.wall),
  ];
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
    parts.push(part(g, C.tintBase, { tint: 1 }));
  }
  // Chimney with a dark rim, plus a small annex.
  parts.push(
    part(cyl(0.32, 0.42, 3.4, 8, 2.3, 0.3, -0.9), C.brick),
    part(cyl(0.36, 0.36, 0.2, 8, 2.3, 3.7, -0.9), C.hullDark),
    part(box(1.0, 0.8, 1.2, 2.3, 0.3, 1.0), C.wall),
    part(box(1.1, 0.15, 1.3, 2.3, 1.1, 1.0), C.tintShade, { tint: 1 }),
  );
  return assemble(parts, STRUCTURE_SCALE);
}

/** Defense post: octagonal stone wall ring with owner caps, central bunker. */
function defensePostGeometry(): THREE.BufferGeometry {
  const parts = [part(cyl(2.7, 2.7, 1.5, 8, 0, -1.2, 0), C.stoneDark)];
  const ringR = 2.15;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const seg = 2 * ringR * Math.tan(Math.PI / 8);
    const wall = box(seg * 1.02, 0.85, 0.38, 0, 0.3, 0);
    const cap = box(seg * 1.04, 0.14, 0.46, 0, 1.15, 0);
    // Place each wall section tangentially on the ring.
    for (const [g, color, tint] of [
      [wall, C.stone, 0],
      [cap, C.tintBase, 1],
    ] as const) {
      g.translate(0, 0, ringR).rotateY(a);
      parts.push(part(g, color, { tint }));
    }
  }
  parts.push(
    part(cyl(1.05, 1.15, 0.7, 8, 0, 0.3, 0), C.concrete),
    part(dome(1.0, 8, 0, 1.0, 0), C.tintBase, { tint: 1 }),
    part(cyl(0.04, 0.04, 1.6, 4, 0.0, 1.8, 0), C.steelDark),
    part(box(0.6, 0.35, 0.04, 0.32, 3.0, 0), C.tintBase, { tint: 1 }),
  );
  return assemble(parts, STRUCTURE_SCALE);
}

/**
 * SAM launcher: concrete pad, owner-coloured turntable and a rack of tubes
 * angled up towards +X; variant 1..3 → 2 / 4 / 6 tubes.
 */
function samLauncherGeometry(variant: number): THREE.BufferGeometry {
  const parts = [
    part(cyl(2.6, 2.8, 1.6, 8, 0, -1.2, 0), C.concrete),
    part(cyl(1.6, 1.7, 0.3, 10, 0, 0.4, 0), C.tintBase, { tint: 1 }),
    part(box(1.4, 0.6, 1.2, -0.6, 0.7, 0), C.tintShade, { tint: 1 }),
  ];
  const cols = Math.max(1, Math.min(3, variant));
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
  return assemble(parts, STRUCTURE_SCALE);
}

/**
 * Missile silo: concrete pad with 1..4 round silos (owner-coloured domes
 * ringed with hazard paint) and a small control building.
 */
function missileSiloGeometry(variant: number): THREE.BufferGeometry {
  const parts = [part(box(5.6, 1.5, 5.6, 0, -1.2, 0), C.concrete)];
  const n = Math.max(1, Math.min(4, variant));
  const corners: [number, number][] = [
    [-1.15, -1.15],
    [1.15, 1.15],
    [1.15, -1.15],
    [-1.15, 1.15],
  ];
  const spots: [number, number][] = n === 1 ? [[0.3, 0]] : corners.slice(0, n);
  const r = n === 1 ? 1.5 : 1.0;
  for (const [x, z] of spots) {
    parts.push(
      part(cyl(r * 1.15, r * 1.25, 0.4, 12, x, 0.3, z), C.stone),
      part(cyl(r * 1.02, r * 1.02, 0.08, 12, x, 0.7, z), C.hazard),
      part(dome(r * 0.92, 12, x, 0.7, z), C.tintBase, { tint: 1 }),
    );
  }
  // Control bunker (only when a corner is free).
  if (n < 4) {
    const [bx, bz] = n === 1 ? [-1.9, 1.6] : [-1.3, 1.3];
    parts.push(
      part(box(1.1, 0.6, 1.0, bx, 0.3, bz), C.wall),
      part(box(1.2, 0.14, 1.1, bx, 0.9, bz), C.tintShade, { tint: 1 }),
    );
  }
  return assemble(parts, STRUCTURE_SCALE);
}
