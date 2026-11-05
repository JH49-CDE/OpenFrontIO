/**
 * Lot 3, item 4: structure bases. Pads smaller than the former plazas, by
 * type and level; models carry `aFooting` for the `conform` part material
 * (pad sheared onto the instance's ground plane, buildings moved rigidly);
 * pads fitted on land (shifted / shrunk) and on the relief (plane, sink),
 * so no foundation skirt floats over slopes and no pad overhangs the sea.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  BlobShadows,
  createPartMaterial,
  createStructureGeometry,
  createStructureLodGeometry,
  createUnitGeometry,
  FOOTING_Y,
  InstancedBatch,
  MAX_VISUAL_LEVEL,
  PAD_TOP,
  STRUCTURE_SCALE,
  structurePad,
  structureVariant,
  UnitMesh,
} from "../../../src/client/render/three/ProceduralMeshes";
import {
  fitGroundPlane,
  fitPadOnLand,
  groundGrid,
  groundGridAt,
  levelPad,
  PAD_FIT_SCALES,
  PAD_FLOAT_QUANTILE,
  PAD_MAX_SHIFT,
  PAD_MAX_SINK,
  PAD_MAX_SLOPE,
  PAD_SINK,
  PAD_TOP_MAX_SLOPE,
  padSamplePoints,
  planarGrid,
  StructureLayer,
} from "../../../src/client/render/three/StructureLayer";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import {
  STRUCTURE_TYPES,
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  type UnitState,
} from "../../../src/client/render/types";

const TYPES = [...STRUCTURE_TYPES];
const variantsOf = (type: string) => [
  ...new Set(
    Array.from({ length: MAX_VISUAL_LEVEL }, (_, i) =>
      structureVariant(type, i + 1),
    ),
  ),
];

/** The former plazas (lot 2), tiles: side or diameter. */
const OLD_PAD: Readonly<Record<string, number>> = {
  [UT_CITY]: 6.2 * 1.35,
  [UT_PORT]: 5.4 * 1.35,
  [UT_FACTORY]: 6.2 * 1.35,
  [UT_DEFENSE_POST]: 5.4 * 1.35,
  [UT_SAM_LAUNCHER]: 5.6 * 1.35,
  [UT_MISSILE_SILO]: 5.6 * 1.35,
};

/** Vertices of `g` (x, y, z, aFooting.z) as an array of tuples. */
function vertices(g: THREE.BufferGeometry): [number, number, number, number][] {
  const p = g.getAttribute("position");
  const f = g.getAttribute("aFooting");
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < p.count; i++) {
    out.push([p.getX(i), p.getY(i), p.getZ(i), f.getZ(i) > 0 ? 1 : 0]);
  }
  return out;
}

describe("structure pads (models)", () => {
  it("are smaller than the former plazas and grow with the level", () => {
    for (const type of TYPES) {
      for (const v of variantsOf(type)) {
        const pad = structurePad(type, v);
        const size = Math.max(pad.x1 - pad.x0, pad.z1 - pad.z0);
        expect(size, `${type}#${v}`).toBeLessThan(OLD_PAD[type] + 1e-6);
      }
    }
    const city = (lv: number) => {
      const p = structurePad(UT_CITY, lv);
      return p.x1 - p.x0;
    };
    // City lv 1: 6.1 tiles (was 8.4), lv 6: 7.3.
    expect(city(1)).toBeLessThan(0.75 * OLD_PAD[UT_CITY]);
    for (let lv = 2; lv <= MAX_VISUAL_LEVEL; lv++) {
      expect(city(lv)).toBeGreaterThan(city(lv - 1));
    }
    const sam = (v: number) => structurePad(UT_SAM_LAUNCHER, v).x1;
    expect(sam(2)).toBeGreaterThan(sam(1));
    expect(sam(3)).toBeGreaterThan(sam(2));
    // Varied by type: round for defense posts and SAM launchers.
    expect(structurePad(UT_DEFENSE_POST).round).toBe(true);
    expect(structurePad(UT_SAM_LAUNCHER).round).toBe(true);
    expect(structurePad(UT_CITY).round).toBe(false);
    // Types whose model does not encode the level stretch their pad.
    const f1 = levelPad(UT_FACTORY, 1, 1);
    const f3 = levelPad(UT_FACTORY, 1, 3);
    expect(f3.x1 - f3.x0).toBeCloseTo((f1.x1 - f1.x0) * 1.1);
    expect(levelPad(UT_CITY, 3, 3)).toEqual(structurePad(UT_CITY, 3));
  });

  it("carry aFooting: the pad follows the plane, the rest stands on it", () => {
    for (const type of TYPES) {
      for (const v of variantsOf(type)) {
        for (const lod of [false, true]) {
          const g = lod
            ? createStructureLodGeometry(type, v)!
            : createStructureGeometry(type, v)!;
          const tag = `${type}#${v}${lod ? "@lod" : ""}`;
          const pad = structurePad(type, v);
          const vs = vertices(g);
          expect(g.getAttribute("aFooting").count, tag).toBe(vs.length);
          // The footing vertices span exactly the pad, top at PAD_TOP.
          const foot = vs.filter((q) => q[3] === 1);
          expect(foot.length, tag).toBeGreaterThan(0);
          const top = Math.max(...foot.map((q) => q[1]));
          if (pad.round) {
            const r = Math.max(...foot.map((q) => Math.hypot(q[0], q[2])));
            expect(r, tag).toBeCloseTo((pad.x1 - pad.x0) / 2, 1);
          } else {
            const maxX = Math.max(...foot.map((q) => q[0]));
            const minZ = Math.min(...foot.map((q) => q[2]));
            expect(maxX, tag).toBeCloseTo(pad.x1, 1);
            expect(minZ, tag).toBeCloseTo(pad.z0, 1);
          }
          expect(top, tag).toBeCloseTo(PAD_TOP * STRUCTURE_SCALE, 3);
          // Nothing but the port's pier and crane leaves the pad.
          const slack = pad.round ? 0.25 : 0.05;
          const r = (pad.x1 - pad.x0) / 2;
          for (const [x, y, z, f] of vs) {
            if (f === 1 || (type === UT_PORT && x > pad.x1 - 0.2)) continue;
            if (type === UT_PORT && z > 1.4 && y > 2.5) continue; // crane jib
            if (pad.round) {
              expect(Math.hypot(x, z), tag).toBeLessThan(r + slack);
            } else {
              expect(x, tag).toBeGreaterThan(pad.x0 - slack);
              expect(x, tag).toBeLessThan(pad.x1 + slack);
              expect(z, tag).toBeGreaterThan(pad.z0 - slack);
              expect(z, tag).toBeLessThan(pad.z1 + slack);
            }
          }
          // Buildings standing on the pad reach down into it (no gap when
          // the pad is sheared under them).
          const rigidLow = Math.min(
            ...vs.filter((q) => q[3] === 0).map((q) => q[1]),
          );
          expect(rigidLow, tag).toBeLessThan(
            FOOTING_Y * STRUCTURE_SCALE + 1e-3,
          );
        }
      }
    }
  });

  it("anchors each city tower where it stands", () => {
    const g = createStructureGeometry(UT_CITY, 6)!;
    const f = g.getAttribute("aFooting");
    const anchors = new Set<string>();
    for (let i = 0; i < f.count; i++) {
      if (f.getZ(i) === 0) {
        // Rigid parts: the (u, v) of their anchor, no pad size.
        expect(f.getW(i)).toBe(0);
        anchors.add(`${f.getX(i).toFixed(2)},${f.getY(i).toFixed(2)}`);
      }
    }
    // 9 towers on a 3×3 grid.
    expect(anchors.size).toBe(9);
  });
});

describe("conform part material", () => {
  /** Runs the material's onBeforeCompile on three's standard shaders. */
  function compiled(conform: boolean) {
    const mat = createPartMaterial({ glow: { value: 1 }, conform });
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    mat.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    );
    return { mat, shader };
  }

  it("drapes pads on the ground grid and moves the rest rigidly, only when asked", () => {
    const on = compiled(true);
    const off = compiled(false);
    for (const decl of [
      "attribute vec3 iGround0;",
      "attribute vec3 iGround1;",
      "attribute vec3 iGround2;",
      "attribute vec4 aFooting;",
    ]) {
      expect(on.shader.vertexShader).toContain(decl);
    }
    // Every vertex moves by the ground at its (u, v) — its own for the
    // pad, its anchor's for the rest — in world units.
    expect(on.shader.vertexShader).toContain(
      "transformed.y += conformGround(aFooting.xy) / conformScaleY();",
    );
    // Pad tops get the ground's normal.
    expect(on.shader.vertexShader).toContain(
      "objectNormal = normalize(vec3(-ls.x, 1.0, -ls.y));",
    );
    // Units keep the lot-2 program (same cache key, no new attributes).
    expect(off.shader.vertexShader).not.toContain("iGround");
    expect(off.mat.customProgramCacheKey()).toBe("openfront-three-parts-v1");
    expect(on.mat.customProgramCacheKey()).not.toBe(
      off.mat.customProgramCacheKey(),
    );
  });

  it("interpolates the grid bilinearly on its 2×2 cells", () => {
    const g = [0, 1, 4, 2, 3, 6, 4, 5, 8];
    // Nodes.
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        expect(groundGridAt(g, i / 2, j / 2)).toBeCloseTo(g[3 * j + i]);
      }
    }
    // Cell centres: the mean of their corners.
    expect(groundGridAt(g, 0.25, 0.25)).toBeCloseTo((0 + 1 + 2 + 3) / 4);
    expect(groundGridAt(g, 0.75, 0.75)).toBeCloseTo((3 + 6 + 5 + 8) / 4);
    // Clamped outside.
    expect(groundGridAt(g, -1, 2)).toBe(4);
  });

  it("samples the ground under a placed pad, relative to its centre", () => {
    const pad = structurePad(UT_FACTORY);
    const plane = (x: number, z: number) => 2 + 0.2 * (x - 40) - 0.1 * (z - 30);
    for (const rot of [0, 0.7, Math.PI]) {
      const grid = new Float32Array(9);
      const r = groundGrid(plane, 40, 30, rot, pad, 0.8, grid);
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const world = (lx: number, lz: number) =>
        [40 + 0.8 * (lx * c + lz * s), 30 + 0.8 * (lz * c - lx * s)] as const;
      // Relative to the ground at the pad's centre (the factory's pad is a
      // little off the model's origin).
      const [mx, mz] = world((pad.x0 + pad.x1) / 2, (pad.z0 + pad.z1) / 2);
      expect(r.centre).toBeCloseTo(plane(mx, mz), 6);
      // A plane is bilinear: nothing floats.
      expect(r.float).toBeCloseTo(0, 6);
      // The grid's corner (u, v) = (0, 0) is the pad's (x0, z0) corner,
      // turned and scaled like the model.
      const [wx, wz] = world(pad.x0, pad.z0);
      expect(grid[0]).toBeCloseTo(plane(wx, wz) - r.centre, 5);
      expect(grid[4]).toBe(0);
    }
    // A small dip under a few samples does not sink the pad (it would
    // vanish under the bumps of rough ground); a step under half of it
    // does, by at most PAD_MAX_SINK.
    const dip = (x: number, z: number) =>
      Math.hypot(x - 41, z - 31) < 1 ? 0.5 : 1;
    expect(groundGrid(dip, 40, 30, 0, pad, 1).float).toBeCloseTo(0, 6);
    const step = (x: number) => (x < 40 ? 0 : 1.5);
    const st = groundGrid(step, 40, 30, 0, pad, 1);
    expect(st.float).toBeGreaterThan(0.05);
    expect(st.float).toBeLessThanOrEqual(PAD_MAX_SINK);
  });
});

describe("InstancedBatch ground grids and sloped shadows", () => {
  it("stores a ground grid per instance and keeps it when growing", () => {
    const parent = new THREE.Group();
    const batch = new InstancedBatch(
      parent,
      createUnitGeometry(UnitMesh.Shell),
      new THREE.MeshBasicMaterial(),
      "grids",
      16,
      0,
      true,
    );
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const grid = (i: number) => Array.from({ length: 9 }, (_, k) => i + k / 8);
    batch.begin();
    for (let i = 0; i < 20; i++) batch.push(m, c, 1, grid(i));
    batch.end();
    expect(batch.capacity).toBe(32);
    expect(batch.groundAt(3)).toEqual(grid(3).map((v) => Math.fround(v)));
    expect(batch.groundAt(19)).toEqual(grid(19).map((v) => Math.fround(v)));
    for (const r of [0, 1, 2]) {
      expect(batch.mesh.geometry.getAttribute(`iGround${r}`).count).toBe(32);
    }
    // Without `ground`: no attributes (units, shadows).
    const plain = new InstancedBatch(
      parent,
      createUnitGeometry(UnitMesh.Shell),
      new THREE.MeshBasicMaterial(),
      "plain",
    );
    expect(plain.mesh.geometry.getAttribute("iGround0")).toBeUndefined();
  });

  it("tilts contact shadows onto the ground plane", () => {
    const parent = new THREE.Group();
    const sh = new BlobShadows(parent, "s");
    sh.begin();
    sh.push(5, 1, 7, 4, 2, 0.4, 0.5, 0.3, -0.2);
    sh.end();
    const mesh = parent.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    // A corner of the quad (local ±1 in x / z) lies on the plane.
    for (const [lx, lz] of [
      [1, 1],
      [-1, 1],
      [1, -1],
    ]) {
      const p = new THREE.Vector3(lx, 0, lz).applyMatrix4(m);
      expect(p.y).toBeCloseTo(1 + 0.3 * (p.x - 5) - 0.2 * (p.z - 7), 6);
    }
    sh.dispose();
  });
});

describe("fitting pads on land and relief", () => {
  /** Land east of x = 32 (a straight north-south coast). */
  const eastLand = (x: number) => x >= 32;

  it("samples the whole pad, inset from its edge", () => {
    const pad = structurePad(UT_CITY, 1);
    const pts = padSamplePoints(pad);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
    }
    expect(minX).toBeCloseTo(pad.x0 + 0.05);
    expect(maxX).toBeCloseTo(pad.x1 - 0.05);
    expect(pts.length / 2).toBeGreaterThan(50);
    const disc = padSamplePoints(structurePad(UT_SAM_LAUNCHER, 1));
    for (let i = 0; i < disc.length; i += 2) {
      expect(Math.hypot(disc[i], disc[i + 1])).toBeLessThan(
        structurePad(UT_SAM_LAUNCHER, 1).x1,
      );
    }
  });

  it("keeps inland pads on their tile at full size", () => {
    const fit = fitPadOnLand(eastLand, 50.5, 20.5, 0, structurePad(UT_CITY, 3));
    expect(fit).toEqual({ dx: 0, dz: 0, scale: 1, water: 0 });
  });

  it("moves coastal pads inland instead of over the sea", () => {
    // A city 1.5 tiles from the coast: its 6.3-tile pad would overhang. It
    // moves at most PAD_MAX_SHIFT (1 tile) inland, so it stays on the
    // clicked tile (and centred in its range rings), and shrinks for the
    // rest.
    expect(PAD_MAX_SHIFT).toBe(1);
    const pad = structurePad(UT_CITY, 2);
    const fit = fitPadOnLand(eastLand, 33.5, 20.5, 0, pad);
    expect(fit.water).toBe(0);
    expect(fit.scale).toBeLessThan(1);
    expect(fit.scale).toBeGreaterThan(0.5);
    expect(fit.dx).toBeGreaterThan(0);
    expect(Math.hypot(fit.dx, fit.dz)).toBeLessThanOrEqual(PAD_MAX_SHIFT);
    // Every pad sample is on land.
    const pts = padSamplePoints(pad);
    for (let i = 0; i < pts.length; i += 2) {
      expect(eastLand(33.5 + fit.dx + fit.scale * pts[i])).toBe(true);
    }
    // A port on the shore tile, facing the water (west): the quay is on
    // land, the pier (beyond the pad) over the water.
    const portPad = structurePad(UT_PORT);
    const port = fitPadOnLand(eastLand, 32.5, 20.5, Math.PI, portPad);
    expect(port.water).toBe(0);
    expect(port.dx).toBeGreaterThanOrEqual(0);
    // Turned by π its +X (the pier) points west: the quay's water edge is
    // on land, the pier's tip (4.4 design units out) over the sea.
    expect(32.5 + port.dx - portPad.x1).toBeGreaterThanOrEqual(32 - 0.05);
    expect(32.5 + port.dx - 4.4 * STRUCTURE_SCALE).toBeLessThan(32);
  });

  it("shrinks pads on narrow land, to the smallest scale at worst", () => {
    // A 4-tile wide north-south strip.
    const strip = (x: number) => x >= 30 && x < 34;
    const fit = fitPadOnLand(strip, 32.5, 20.5, 0, structurePad(UT_CITY, 3));
    expect(fit.water).toBe(0);
    expect(fit.scale).toBeLessThan(1);
    expect(fit.scale).toBeGreaterThanOrEqual(
      PAD_FIT_SCALES[PAD_FIT_SCALES.length - 1],
    );
    // A one-tile spit: the least area over water, at the smallest scale.
    const spit = (x: number) => x >= 32 && x < 33;
    const worst = fitPadOnLand(spit, 32.5, 20.5, 0, structurePad(UT_CITY, 3));
    expect(worst.water).toBeGreaterThan(0);
    expect(worst.scale).toBe(PAD_FIT_SCALES[PAD_FIT_SCALES.length - 1]);
  });

  it("fits the ground plane and sinks the pad so it floats nowhere", () => {
    const pad = structurePad(UT_FACTORY);
    // An inclined plane: exact gradient, no sink.
    const tilted = (x: number, z: number) =>
      2 + 0.2 * (x - 40) - 0.1 * (z - 30);
    const p = fitGroundPlane(tilted, 40, 30, 0.6, pad, 1);
    expect(p.height).toBeCloseTo(2, 6);
    expect(p.gx).toBeCloseTo(0.2, 6);
    expect(p.gz).toBeCloseTo(-0.1, 6);
    expect(p.sink).toBeCloseTo(0, 6);
    // A bump: the plane drops until no sample is below it.
    const bumpy = (x: number, z: number) =>
      1 + 0.5 * Math.cos((x - 40) * 0.6) * Math.cos((z - 30) * 0.6);
    const b = fitGroundPlane(bumpy, 40, 30, 0, pad, 1);
    const pts = padSamplePoints(pad, 0);
    for (let i = 0; i < pts.length; i += 2) {
      const x = 40 + pts[i];
      const z = 30 + pts[i + 1];
      const plane = b.height - b.sink + b.gx * pts[i] + b.gz * pts[i + 1];
      expect(plane).toBeLessThanOrEqual(bumpy(x, z) + 1e-9);
    }
    expect(b.sink).toBeGreaterThan(0);
    expect(b.sink).toBeLessThanOrEqual(PAD_MAX_SINK);
    // Cliffs: the slope is capped.
    const cliff = (x: number) => 5 * x;
    const c = fitGroundPlane(cliff, 40, 30, 0, pad, 1);
    expect(Math.hypot(c.gx, c.gz)).toBeCloseTo(PAD_MAX_SLOPE, 6);
  });
});

// ---------------------------------------------------------------------------
// StructureLayer integration
// ---------------------------------------------------------------------------

const W = 64;
const H = 64;

/**
 * West of x = 32 sea; east of it land rising northwards (magnitude grows
 * with y: a slope of ~0.12 tile per tile on the relief).
 */
function makeContext(): ThreeLayerContext {
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = W / 2; x < W; x++) {
      terrain[y * W + x] = 0x80 | Math.min(30, Math.floor((H - y) / 2));
    }
  }
  const palette = new Float32Array(4096 * 2 * 4);
  palette.set([0.9, 0.2, 0.2, 1], 1 * 4);
  return {
    renderer: null as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: W,
    mapHeight: H,
    heightField: new HeightField(W, H, terrain, {
      heightScale: 6,
      seabedDepth: 3,
      targetVertices: 10_000,
    }),
    palette: new PaletteView(palette),
    settings: defaultThreeSettings(),
    renderSettings: createRenderSettings(),
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
}

function frame(nowMs: number, cssPxPerTile = 8): FrameInfo {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 1, 10_000);
  const focal = 600 / (2 * Math.tan(Math.PI / 6));
  cam.position.set(W / 2, focal / cssPxPerTile, H / 2);
  cam.rotation.set(-Math.PI / 2, 0, 0, "YXZ");
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: cam,
    cssPxPerTile,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView: false,
  };
}

function structure(
  id: number,
  unitType: string,
  x: number,
  y: number,
  level = 1,
): UnitState {
  return {
    id,
    unitType,
    ownerID: 1,
    lastOwnerID: null,
    pos: y * W + x,
    lastPos: y * W + x,
    isActive: true,
    reachedTarget: false,
    retreating: false,
    targetable: true,
    waitTicks: 0,
    markedForDeletion: false,
    health: null,
    underConstruction: false,
    targetUnitId: null,
    targetTile: null,
    troops: 0,
    missileTimerQueue: [],
    level,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
  };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** Updates the layer until its placement queue is empty (budgeted fits). */
function settle(layer: StructureLayer): void {
  for (let i = 0; i < 100 && layer.perfStats().padPlacePending > 0; i++) {
    layer.update(frame(10_000 + 16 * i));
  }
}

function instance(ctx: ThreeLayerContext, name: string) {
  const mesh = ctx.scene.getObjectByName(name) as THREE.InstancedMesh;
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(0, m);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  const grid: number[] = [];
  for (const r of [0, 1, 2]) {
    const a = mesh.geometry.getAttribute(`iGround${r}`);
    grid.push(a.getX(0), a.getY(0), a.getZ(0));
  }
  return { mesh, m, p, s, grid };
}

describe("StructureLayer bases", () => {
  it("keeps coastal models on land and their icons on the tile", () => {
    const ctx = makeContext();
    const layer = new StructureLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.update(frame(0));
    layer.updateStructures(
      new Map([
        [1, structure(1, "City", 33, 20, 2)],
        [2, structure(2, "Factory", 50, 40)],
      ]),
    );
    settle(layer);
    const city = instance(ctx, "structures-City#2");
    // Moved east by at most a tile and shrunk, onto land: its whole pad is
    // over land tiles.
    expect(city.p.x).toBeGreaterThan(33.5);
    expect(city.p.x).toBeLessThanOrEqual(34.5 + 1e-6);
    const pad = structurePad(UT_CITY, 2);
    expect(city.p.x - (city.s.x * (pad.x1 - pad.x0)) / 2).toBeGreaterThan(
      32 - 0.05,
    );
    expect(layer.perfStats().padsShifted).toBe(1);
    expect(layer.perfStats().padsShrunk).toBe(1);
    // The icon stays on the structure's tile (default renderer parity).
    const icons = ctx.scene.getObjectByName("structure-icons") as THREE.Mesh;
    const at = icons.geometry.getAttribute("aAnchor");
    expect(at.getX(0)).toBeCloseTo(33.5);
    expect(at.getZ(0)).toBeCloseTo(20.5);
    // Inland: on its tile.
    const factory = instance(ctx, "structures-Factory#1");
    expect(factory.p.x).toBeCloseTo(50.5);
    expect(factory.p.z).toBeCloseTo(40.5);
  });

  it("follows the slope: the pad never floats more than a thin curb", () => {
    const ctx = makeContext();
    const hf = ctx.heightField;
    const layer = new StructureLayer(ctx);
    disposers.push(() => layer.dispose());
    layer.update(frame(0));
    const units = new Map<number, UnitState>();
    const placed: [string, number, number, number][] = [
      ["City", 48, 30, 3],
      ["Factory", 48, 46, 1],
      ["Missile Silo", 56, 14, 2],
      ["Defense Post", 42, 52, 1],
      ["SAM Launcher", 58, 52, 3],
    ];
    placed.forEach(([t, x, y, lv], i) =>
      units.set(i + 1, structure(i + 1, t, x, y, lv)),
    );
    layer.updateStructures(units);
    settle(layer);
    for (const [type, x, y, lv] of placed) {
      const v = structureVariant(type, lv);
      const inst = instance(ctx, `structures-${type}#${v}`);
      // On the slope the ground grid is not flat.
      const span = Math.max(...inst.grid) - Math.min(...inst.grid);
      expect(span, type).toBeGreaterThan(0.2);
      // Pad top on the conformed ground vs the surface.
      const pad = levelPad(type, v, lv);
      const pts = padSamplePoints(pad, 0);
      const k = inst.s.x;
      const w = pad.x1 - pad.x0;
      const d = pad.z1 - pad.z0;
      const floats: number[] = [];
      let oldFloat = -Infinity;
      // The lot-2 placement: the highest point under the footprint.
      const r = 0.3 * Math.max(pad.x1 - pad.x0, pad.z1 - pad.z0);
      let oldGround = hf.surfaceAt(x + 0.5, y + 0.5);
      for (const [dx, dz] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        oldGround = Math.max(
          oldGround,
          hf.surfaceAt(x + 0.5 + dx, y + 0.5 + dz),
        );
      }
      for (let i = 0; i < pts.length; i += 2) {
        const local = new THREE.Vector3(
          pts[i],
          PAD_TOP * STRUCTURE_SCALE,
          pts[i + 1],
        );
        const world = local.clone().applyMatrix4(inst.m);
        const top =
          world.y +
          groundGridAt(
            inst.grid,
            (pts[i] - pad.x0) / w,
            (pts[i + 1] - pad.z0) / d,
          );
        const ground = hf.surfaceAt(world.x, world.z);
        floats.push(top - ground);
        oldFloat = Math.max(
          oldFloat,
          oldGround + PAD_TOP * STRUCTURE_SCALE * k - ground,
        );
      }
      // The pad's side shows at most its own height above the ground minus
      // the sink (a thin curb) at PAD_FLOAT_QUANTILE of its samples, and
      // a little more over the remaining dips.
      floats.sort((a, b) => a - b);
      const curb = PAD_TOP * STRUCTURE_SCALE * k - PAD_SINK;
      const q = floats[Math.floor(PAD_FLOAT_QUANTILE * (floats.length - 1))];
      const worst = floats[floats.length - 1];
      expect(q, type).toBeLessThan(curb + 1e-6);
      expect(worst, type).toBeLessThan(curb + 0.1);
      // The lot-2 placement floated more.
      expect(oldFloat, type).toBeGreaterThan(worst + 0.3);
    }
  });

  it("fits on land within a per-call budget, the rest over the next frames", () => {
    const ctx = makeContext();
    const layer = new StructureLayer(ctx);
    disposers.push(() => layer.dispose());
    // A slow clock: each reading 1 ms later, so the budget (1.5 ms) lets
    // one fit through per call.
    let t = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (t += 1));
    disposers.push(() => clock.mockRestore());
    layer.update(frame(0));
    // Ten coastal cities: each needs a shift inland.
    const units = new Map<number, UnitState>();
    for (let i = 0; i < 10; i++) {
      units.set(i + 1, structure(i + 1, "City", 33, 4 + 6 * i, 2));
    }
    layer.updateStructures(units);
    const pending = () => layer.perfStats().padPlacePending;
    // At most one fitted within the budget, the others wait on their tile.
    expect(pending()).toBeGreaterThanOrEqual(9);
    expect(layer.perfStats().padsShifted).toBe(10 - pending());
    let frames = 0;
    while (pending() > 0 && frames < 50) layer.update(frame(16 * ++frames));
    // One per frame on this clock.
    expect(frames).toBeGreaterThanOrEqual(9);
    expect(frames).toBeLessThanOrEqual(10);
    expect(layer.perfStats().padsShifted).toBe(10);
    // All on land now: every model east of the coast by its half pad.
    const mesh = ctx.scene.getObjectByName(
      "structures-City#2",
    ) as THREE.InstancedMesh;
    const half =
      (structurePad(UT_CITY, 2).x1 - structurePad(UT_CITY, 2).x0) / 2;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, sc);
      expect(p.x - sc.x * half).toBeGreaterThan(32 - 0.06);
    }
    // A terrain change re-queues every model (icons re-seat at once).
    ctx.heightField.version++;
    layer.update(frame(1000));
    expect(pending()).toBe(10);
    frames = 0;
    while (pending() > 0 && frames < 50)
      layer.update(frame(1000 + 16 * ++frames));
    expect(pending()).toBe(0);
    expect(layer.perfStats().padsShifted).toBe(10);
  });
});

describe("lot 3 fix pass: flat slabs, separate towers, piers on posts", () => {
  it("reduces the ground grid to its plane, tilted at most PAD_TOP_MAX_SLOPE", () => {
    // A plane is kept (relative to its centre).
    const g = new Float32Array(9);
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++)
        g[3 * j + i] = 5 + 0.2 * (i / 2) - 0.1 * (j / 2);
    }
    expect(planarGrid(g, 6, 6)).toBeCloseTo(0, 6);
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        expect(g[3 * j + i]).toBeCloseTo(
          0.2 * (i / 2 - 0.5) - 0.1 * (j / 2 - 0.5),
          6,
        );
      }
    }
    // A bump under the centre: a flat slab at the mean (no crease).
    const b = new Float32Array(9);
    b[4] = 0.9;
    expect(planarGrid(b, 6, 6)).toBeCloseTo(0.1 - 0.9, 6);
    for (let k = 0; k < 9; k++) expect(b[k]).toBeCloseTo(0, 6);
    // A steep slope (0.5 rise per tile): tilted at PAD_TOP_MAX_SLOPE.
    const s = new Float32Array(9);
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) s[3 * j + i] = 3 * (i / 2);
    }
    planarGrid(s, 6, 6);
    expect((s[5] - s[3]) / 6).toBeCloseTo(PAD_TOP_MAX_SLOPE, 6);
    expect(s[4]).toBe(0);
  });

  it("drapes pads on a plane over rough ground (no crumpled top)", () => {
    const rough = (x: number, z: number) =>
      0.4 * Math.sin(x * 1.7) * Math.cos(z * 1.3) + 0.05 * x;
    const out = new Float32Array(9);
    groundGrid(rough, 30.5, 20.5, 0.4, structurePad(UT_FACTORY), 1, out);
    expect(out[4]).toBe(0);
    // Planar: every row and column is linear, opposite nodes balance.
    for (let r = 0; r < 3; r++) {
      expect(out[3 * r] + out[3 * r + 2]).toBeCloseTo(2 * out[3 * r + 1], 5);
      expect(out[r] + out[6 + r]).toBeCloseTo(2 * out[3 + r], 5);
    }
  });

  it("keeps a city's towers apart at every level (a cluster, not a block)", () => {
    for (let lv = 1; lv <= MAX_VISUAL_LEVEL; lv++) {
      const g = createStructureGeometry(UT_CITY, lv)!;
      const p = g.getAttribute("position");
      const f = g.getAttribute("aFooting");
      // Group the tower vertices by their anchor (u, v); pad vertices
      // (aFooting.z > 0) are not towers.
      const boxes = new Map<string, [number, number, number, number]>();
      for (let i = 0; i < p.count; i++) {
        if (f.getZ(i) > 0) continue;
        const key = `${f.getX(i).toFixed(4)},${f.getY(i).toFixed(4)}`;
        const b = boxes.get(key) ?? [Infinity, Infinity, -Infinity, -Infinity];
        b[0] = Math.min(b[0], p.getX(i));
        b[1] = Math.min(b[1], p.getZ(i));
        b[2] = Math.max(b[2], p.getX(i));
        b[3] = Math.max(b[3], p.getZ(i));
        boxes.set(key, b);
      }
      const list = [...boxes.values()];
      expect(list.length, `level ${lv}`).toBeGreaterThanOrEqual(3);
      for (let a = 0; a < list.length; a++) {
        for (let c = a + 1; c < list.length; c++) {
          const A = list[a];
          const B = list[c];
          // Separated along x or z by at least 0.1 tile.
          const gap = Math.max(
            B[0] - A[2],
            A[0] - B[2],
            B[1] - A[3],
            A[1] - B[3],
          );
          expect(gap, `level ${lv} towers ${a}/${c}`).toBeGreaterThanOrEqual(
            0.1,
          );
        }
      }
    }
  });

  it("lays the port's pier on posts, its deck flush with the quay or above", () => {
    const g = createStructureGeometry(UT_PORT, 1)!;
    const pad = structurePad(UT_PORT);
    const p = g.getAttribute("position");
    let deckTop = -Infinity;
    let postBottom = Infinity;
    for (let i = 0; i < p.count; i++) {
      // Beyond the quay, under the crane's jib (y < 1 tile).
      if (p.getX(i) < pad.x1 + 0.3 || p.getY(i) > 1) continue;
      deckTop = Math.max(deckTop, p.getY(i));
      postBottom = Math.min(postBottom, p.getY(i));
    }
    expect(deckTop).toBeGreaterThanOrEqual(PAD_TOP * STRUCTURE_SCALE - 1e-6);
    expect(postBottom).toBeLessThan(-1);
  });
});
