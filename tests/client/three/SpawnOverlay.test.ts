/**
 * Spawn-phase halos (SpawnOverlay.ts): the default renderer's
 * SpawnOverlayPass semantics (who, draw order, radii, breath timing, ring
 * profile) and the draped relief patches.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { SpawnCenter } from "../../../src/client/render/gl/passes/SpawnOverlayPass";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { heightFieldSurface } from "../../../src/client/render/three/OverlayLayer";
import {
  buildSpawnPatch,
  SpawnKind,
  SpawnOverlay,
  spawnBreath,
  spawnInstances,
  spawnRingAlpha,
} from "../../../src/client/render/three/SpawnOverlay";
import type { FrameInfo } from "../../../src/client/render/three/types";

const S = createRenderSettings().spawnOverlay;

function center(
  x: number,
  y: number,
  over: Partial<SpawnCenter> = {},
): SpawnCenter {
  return {
    x,
    y,
    r: 1,
    g: 0.84,
    b: 0,
    isSelf: false,
    isTeammate: false,
    ...over,
  };
}

function frame(dtMs: number): FrameInfo {
  return {
    nowMs: 0,
    dtMs,
    tickAlpha: 1,
    camera: new THREE.PerspectiveCamera(),
    cssPxPerTile: 2,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView: false,
  };
}

/** A map with hills (relief) and a sea on the left. */
function surface(W = 120, H = 90) {
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      terrain[y * W + x] =
        x < 20
          ? 10
          : 0x80 | Math.min(30, Math.floor(15 + 10 * Math.sin(x / 7)));
    }
  }
  const hf = new HeightField(W, H, terrain, {
    heightScale: 6,
    seabedDepth: 3,
    targetVertices: (W * H) / 4, // step 2
  });
  return heightFieldSurface(hf);
}

describe("spawn instances (SpawnOverlayPass.update)", () => {
  it("orders enemies, teammates, self and sizes each patch", () => {
    const list = spawnInstances(
      [
        center(10, 10, { isSelf: true }),
        center(30, 10, { isTeammate: true, r: 0, g: 0, b: 1 }),
        center(50, 10, { r: 1, g: 0, b: 0 }),
        center(70, 10, { r: 0, g: 1, b: 0 }),
      ],
      S,
    );
    expect(list.map((i) => i.kind)).toEqual([
      SpawnKind.Enemy,
      SpawnKind.Enemy,
      SpawnKind.Teammate,
      SpawnKind.Self,
    ]);
    expect(list.map((i) => i.x)).toEqual([50.5, 70.5, 30.5, 10.5]);
    // Default quad radii: highlight + 1, max ring × 1.15 + 1.
    expect(list[0].radius).toBe(S.highlightRadius + 1);
    expect(list[2].radius).toBeCloseTo(S.mateMaxRad * 1.15 + 1, 9);
    expect(list[3].radius).toBeCloseTo(S.selfMaxRad * 1.15 + 1, 9);
    // Colours as linear rgb (gold 0.84 → ~0.674).
    expect(list[3].color[0]).toBe(1);
    expect(list[3].color[1]).toBeCloseTo(0.674, 3);
    expect(spawnInstances([], S)).toEqual([]);
  });

  it("breathes like the default: radius ×0.5…×1.15, opacity 65…100%", () => {
    expect(spawnBreath(0)).toBe(0.5);
    expect(spawnBreath(Math.PI / 2)).toBe(1);
    expect(spawnBreath(-Math.PI / 2)).toBe(0);
    // Full breath: the solid band starts at minR × 1.15.
    const minR = S.selfMinRad * 1.15;
    const maxR = S.selfMaxRad * 1.15;
    expect(
      spawnRingAlpha(0, S.selfMinRad, S.selfMaxRad, 1, S.gradientSolidEnd),
    ).toBe(0);
    expect(
      spawnRingAlpha(
        minR / 2,
        S.selfMinRad,
        S.selfMaxRad,
        1,
        S.gradientSolidEnd,
      ),
    ).toBeCloseTo(0.5, 6);
    expect(
      spawnRingAlpha(
        minR + 0.5,
        S.selfMinRad,
        S.selfMaxRad,
        1,
        S.gradientSolidEnd,
      ),
    ).toBe(1);
    expect(
      spawnRingAlpha(
        maxR + 0.1,
        S.selfMinRad,
        S.selfMaxRad,
        1,
        S.gradientSolidEnd,
      ),
    ).toBe(0);
    // Empty breath: radii halved, opacity × 0.65.
    expect(
      spawnRingAlpha(
        S.selfMinRad * 0.5 + 0.2,
        S.selfMinRad,
        S.selfMaxRad,
        0,
        S.gradientSolidEnd,
      ),
    ).toBeCloseTo(0.65, 6);
  });
});

describe("SpawnOverlay mesh", () => {
  it("drapes each centre's patch on the relief grid, sea plane included", () => {
    const surf = surface();
    const p = buildSpawnPatch(surf, 30.5, 40.5, 12);
    const g = surf.grid;
    // Grid vertices covering the square, triangulated like the terrain.
    expect(p.vertexCount).toBe(
      (Math.ceil(42.5 / g.step) - Math.floor(18.5 / g.step) + 1) *
        (Math.ceil(52.5 / g.step) - Math.floor(28.5 / g.step) + 1),
    );
    expect(p.index.length % 6).toBe(0);
    let sea = 0;
    for (let v = 0; v < p.vertexCount; v++) {
      const x = p.positions[v * 3];
      const y = p.positions[v * 3 + 1];
      const z = p.positions[v * 3 + 2];
      expect(x % g.step === 0 || x === g.mapWidth).toBe(true);
      expect(y).toBeCloseTo(surf.surfaceAt(x, z), 5);
      expect(y).toBeGreaterThanOrEqual(0);
      if (y === 0) sea++;
    }
    expect(sea).toBeGreaterThan(0);
    // Clamped at the map edge.
    const edge = buildSpawnPatch(surf, 0.5, 0.5, 12);
    for (let v = 0; v < edge.vertexCount; v++) {
      expect(edge.positions[v * 3]).toBeGreaterThanOrEqual(0);
      expect(edge.positions[v * 3 + 2]).toBeGreaterThanOrEqual(0);
    }
  });

  it("shows while centres are pushed, rebuilds only on change, breathes", () => {
    const parent = new THREE.Group();
    const surf = surface();
    const o = new SpawnOverlay(parent, surf, S, 120, 90, 5);
    o.update(frame(16));
    expect(o.mesh.visible).toBe(false);

    const centers = [
      center(60, 45, { isSelf: true }),
      center(90, 20, { r: 0.2, g: 0.4, b: 1 }),
    ];
    o.setCenters(centers);
    o.update(frame(16));
    expect(o.mesh.visible).toBe(true);
    const st = o.perfStats();
    expect(st.spawnHalos).toBe(2);
    expect(st.spawnRebuilds).toBe(1);
    expect(o.mesh.geometry.drawRange.count).toBe(st.spawnTriangles * 3);
    // Per-vertex centre / kind: the self patch comes last.
    const aSpawn = o.mesh.geometry.getAttribute("aSpawn");
    expect(aSpawn.getX(0)).toBe(90.5);
    expect(aSpawn.getZ(0)).toBe(SpawnKind.Enemy);
    expect(aSpawn.getX(st.spawnVertices - 1)).toBe(60.5);
    expect(aSpawn.getZ(st.spawnVertices - 1)).toBe(SpawnKind.Self);

    // The same list every tick costs nothing; a moved spawn rebuilds.
    o.setCenters(centers.map((c) => ({ ...c })));
    expect(o.perfStats().spawnRebuilds).toBe(1);
    o.setCenters([{ ...centers[0], x: 61 }, centers[1]]);
    expect(o.perfStats().spawnRebuilds).toBe(2);

    // Breath: animSpeed rad/ms of local time (default ~0.8 s period).
    const quarter = Math.PI / 2 / S.animSpeed;
    o.update(frame(quarter - 16));
    expect(o.breath).toBeCloseTo(1, 6);
    o.update(frame(2 * quarter));
    expect(o.breath).toBeCloseTo(0, 6);

    // Empty list (spawn over, no tutorial ring): hidden, nothing drawn.
    o.setCenters([]);
    o.update(frame(16));
    expect(o.mesh.visible).toBe(false);
    expect(o.perfStats().spawnHalos).toBe(0);
    o.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
