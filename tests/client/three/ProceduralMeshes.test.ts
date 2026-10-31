import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  BlobShadows,
  createRailPieceGeometry,
  createStructureGeometry,
  createUnitGeometry,
  InstancedBatch,
  nextCapacity,
  setOwnerColor,
  shadowOffset,
  STRUCTURE_FOOTPRINT,
  structureVariant,
  UNIT_MESH_LENGTH,
  UnitMesh,
} from "../../../src/client/render/three/ProceduralMeshes";
import {
  STRUCTURE_TYPES,
  UT_CITY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
} from "../../../src/client/render/types";

function expectPartAttributes(g: THREE.BufferGeometry): void {
  const n = g.getAttribute("position").count;
  expect(n).toBeGreaterThan(0);
  for (const name of ["normal", "color", "aTint", "aGlow"]) {
    expect(g.getAttribute(name)?.count).toBe(n);
  }
  const tint = g.getAttribute("aTint").array;
  // Every model has some owner-coloured surface except the shell.
  expect(tint.some((v) => v === 1) || tint.every((v) => v === 0)).toBe(true);
}

describe("nextCapacity", () => {
  it("doubles from at least 16 until the need is met", () => {
    expect(nextCapacity(0, 1)).toBe(16);
    expect(nextCapacity(16, 16)).toBe(16);
    expect(nextCapacity(16, 17)).toBe(32);
    expect(nextCapacity(32, 200)).toBe(256);
    expect(nextCapacity(100, 101)).toBe(200);
  });
});

describe("InstancedBatch", () => {
  it("grows by doubling and keeps the instances already written", () => {
    const parent = new THREE.Group();
    const template = createUnitGeometry(UnitMesh.Shell);
    const material = new THREE.MeshBasicMaterial();
    const batch = new InstancedBatch(parent, template, material, "test", 16);
    expect(batch.capacity).toBe(16);

    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    batch.begin();
    for (let i = 0; i < 40; i++) {
      m.makeTranslation(i, 2 * i, 3 * i);
      c.setRGB(i / 40, 0, 1);
      expect(batch.push(m, c, 0.5 + i / 100)).toBe(i);
    }
    batch.end();

    expect(batch.capacity).toBe(64);
    expect(batch.mesh.count).toBe(40);
    expect(batch.mesh.visible).toBe(true);
    // Only one mesh is attached at a time.
    expect(parent.children).toEqual([batch.mesh]);
    const out = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (const i of [0, 15, 16, 39]) {
      batch.mesh.getMatrixAt(i, out);
      p.setFromMatrixPosition(out);
      expect(p.toArray()).toEqual([i, 2 * i, 3 * i]);
      batch.mesh.getColorAt(i, c);
      expect(c.r).toBeCloseTo(i / 40);
      const shade = batch.mesh.geometry.getAttribute("iShade").getX(i);
      expect(shade).toBeCloseTo(0.5 + i / 100);
    }

    batch.begin();
    batch.end();
    expect(batch.mesh.count).toBe(0);
    expect(batch.mesh.visible).toBe(false);
    batch.dispose();
    expect(parent.children).toHaveLength(0);
  });
});

describe("unit models", () => {
  for (const kind of Object.values(UnitMesh)) {
    it(`${kind}: part attributes and a length close to the sprite size`, () => {
      const g = createUnitGeometry(kind);
      expectPartAttributes(g);
      g.computeBoundingBox();
      const box = g.boundingBox!;
      const len = box.max.x - box.min.x;
      expect(len).toBeGreaterThan(UNIT_MESH_LENGTH[kind] * 0.75);
      expect(len).toBeLessThan(UNIT_MESH_LENGTH[kind] * 1.25);
      // Forward is +X: longer than wide.
      if (kind !== UnitMesh.Shell) {
        expect(len).toBeGreaterThan(box.max.z - box.min.z);
      }
      g.dispose();
    });
  }
});

describe("structure models", () => {
  it("builds every type and level variant within its footprint", () => {
    for (const type of STRUCTURE_TYPES) {
      const variants = new Set<number>();
      for (let level = 1; level <= 8; level++) {
        variants.add(structureVariant(type, level));
      }
      for (const v of variants) {
        const g = createStructureGeometry(type, v);
        expect(g, `${type} v${v}`).not.toBeNull();
        expectPartAttributes(g!);
        g!.computeBoundingBox();
        const box = g!.boundingBox!;
        const extent = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        expect(extent).toBeLessThanOrEqual(STRUCTURE_FOOTPRINT[type] * 1.02);
        expect(box.max.y).toBeGreaterThan(0.5);
        // Foundations reach below the ground.
        expect(box.min.y).toBeLessThan(-1);
        g!.dispose();
      }
    }
    expect(createStructureGeometry("Warship")).toBeNull();
  });

  it("maps levels to model variants", () => {
    expect(structureVariant(UT_CITY, 1)).toBe(1);
    expect(structureVariant(UT_CITY, 4)).toBe(4);
    expect(structureVariant(UT_CITY, 99)).toBe(6);
    expect(structureVariant(UT_SAM_LAUNCHER, 5)).toBe(3);
    expect(structureVariant(UT_MISSILE_SILO, 5)).toBe(4);
    expect(structureVariant(UT_PORT, 5)).toBe(1);
    expect(structureVariant(UT_CITY, 0)).toBe(1);
  });

  it("taller cities have more geometry", () => {
    const small = createStructureGeometry(UT_CITY, 1)!;
    const big = createStructureGeometry(UT_CITY, 6)!;
    expect(big.getAttribute("position").count).toBeGreaterThan(
      small.getAttribute("position").count,
    );
    small.computeBoundingBox();
    big.computeBoundingBox();
    expect(big.boundingBox!.max.y).toBeGreaterThan(small.boundingBox!.max.y);
  });
});

describe("setOwnerColor", () => {
  it("decodes sRGB palette entries to linear, with lighten and fallback", () => {
    const palette = new Float32Array(4096 * 2 * 4);
    palette.set([1, 0.5, 0, 1], 7 * 4);
    const c = setOwnerColor(new THREE.Color(), palette, 7);
    expect(c.r).toBeCloseTo(1);
    expect(c.g).toBeCloseTo(0.214, 2); // sRGB 0.5 → linear
    expect(c.b).toBeCloseTo(0);
    const light = setOwnerColor(new THREE.Color(), palette, 7, 0.5);
    expect(light.b).toBeCloseTo(0.214, 2);
    // Unknown owner: neutral grey, not black.
    const unknown = setOwnerColor(new THREE.Color(), palette, 99);
    expect(unknown.r).toBeGreaterThan(0.2);
    expect(unknown.r).toBeCloseTo(unknown.b);
  });
});

describe("rail pieces and shadows", () => {
  it("builds a half-track from the tile centre to its edge", () => {
    const g = createRailPieceGeometry();
    expectPartAttributes(g);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.min.x).toBeCloseTo(0, 1);
    expect(box.max.x).toBeCloseTo(0.5, 1);
    // Flat on the ground, narrower than a tile.
    expect(box.max.y).toBeLessThanOrEqual(0.1 + 1e-6);
    expect(box.max.z - box.min.z).toBeLessThan(0.6);
    g.dispose();
  });

  it("shifts shadows away from the north-west sun", () => {
    const [x, z] = shadowOffset(2);
    expect(x).toBeGreaterThan(0); // east
    expect(z).toBeGreaterThan(0); // south
    expect(x / 2).toBeCloseTo(0.5 / 0.8, 12);
    expect(z / 2).toBeCloseTo(0.35 / 0.8, 12);
  });

  it("instances blob shadows with per-instance opacity", () => {
    const parent = new THREE.Group();
    const shadows = new BlobShadows(parent, "shadows");
    shadows.begin();
    shadows.push(1, 0, 2, 4, 2, 0, 0.4);
    shadows.push(5, 1, 6, 3, 3, Math.PI / 2, 0.3);
    shadows.end();
    expect(shadows.count).toBe(2);
    const mesh = parent.getObjectByName("shadows") as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    expect(mesh.geometry.getAttribute("iShade").getX(1)).toBeCloseTo(0.3, 6);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    m.decompose(p, q, sc);
    // The template is 2×2: scale = half the requested size.
    expect([p.x, p.y, p.z]).toEqual([1, 0, 2]);
    expect(sc.x).toBeCloseTo(2, 6);
    expect(sc.z).toBeCloseTo(1, 6);
    shadows.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
