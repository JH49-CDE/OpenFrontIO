/**
 * SAM range rings (SamRings.ts): the default renderer's SAMRadiusPass
 * semantics (who is shown, colours, circle union, upgrade animation, when
 * the rings show) and the draped ribbon geometry, checked against the real
 * World relief.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { samRange } from "../../../src/client/render/gl/utils/NukeTrajectory";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { heightFieldSurface } from "../../../src/client/render/three/OverlayLayer";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import {
  collectSamCircles,
  mergeIntervals,
  RING_LINES,
  SAM_COLOR_ALLY,
  SAM_COLOR_ENEMY,
  SAM_COLOR_SELF,
  SAM_RING_LIFT,
  SAM_UPGRADE_REFRESH_MS,
  SamRangeRings,
  samArcs,
  type SamCircle,
  type SamViewInputs,
  uncoveredArcs,
} from "../../../src/client/render/three/SamRings";
import { TerrainLayer } from "../../../src/client/render/three/TerrainLayer";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ReliefSurface,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import type { UnitState } from "../../../src/client/render/types";
import { rng, WORLD_H, WORLD_W, worldTerrain } from "./railNetwork";

const TWO_PI = Math.PI * 2;

function sam(
  id: number,
  x: number,
  y: number,
  ownerID: number,
  over: Partial<UnitState> = {},
  mapW = 200,
): UnitState {
  return {
    id,
    unitType: "SAM Launcher",
    ownerID,
    pos: y * mapW + x,
    level: 1,
    isActive: true,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
    ...over,
  } as UnitState;
}

const VIEW: SamViewInputs = {
  localPlayer: 1,
  allies: new Set([2]),
  colorMode: "perspective",
  clusters: new Map(),
  palette: null,
};

function circle(x: number, y: number, radius: number, group = 0): SamCircle {
  return { x, y, radius, color: [1, 0, 0], alpha: 1, group, spin: 1 };
}

const arcLength = (arcs: [number, number][]) =>
  arcs.reduce((s, [a, b]) => s + (b - a), 0);

function frame(nowMs: number, dtMs = 16): FrameInfo {
  return {
    nowMs,
    dtMs,
    tickAlpha: 1,
    camera: new THREE.PerspectiveCamera(),
    cssPxPerTile: 4,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID: 1,
    highlightOwner: 0,
    altView: false,
  };
}

/** A small flat-ish map surface (HeightField stand-in). */
function flatSurface(W = 200, H = 160): ReliefSurface {
  const terrain = new Uint8Array(W * H).fill(0x80 | 5); // plains
  const hf = new HeightField(W, H, terrain, {
    heightScale: 6,
    seabedDepth: 3,
    targetVertices: (W * H) / 4,
  });
  return heightFieldSurface(hf);
}

describe("SAM ring circle union (SAMRadiusPass math)", () => {
  it("merges overlapping and wrapping intervals", () => {
    expect(mergeIntervals([])).toEqual([]);
    expect(
      mergeIntervals([
        [0.5, 1],
        [0.8, 1.5],
        [3, 3.2],
      ]),
    ).toEqual([
      [0.5, 1.5],
      [3, 3.2],
    ]);
    // An interval crossing 0 splits into [s, 2π] and [0, e].
    const wrap = mergeIntervals([[-0.5, 0.5]]);
    expect(wrap[0][0]).toBeCloseTo(0, 9);
    expect(wrap[0][1]).toBeCloseTo(0.5, 9);
    expect(wrap[1][0]).toBeCloseTo(TWO_PI - 0.5, 9);
    expect(wrap[1][1]).toBeCloseTo(TWO_PI, 9);
  });

  it("drops the arcs another circle of the group covers", () => {
    const a = circle(0, 0, 10);
    const b = circle(10, 0, 10);
    // Each circle loses the 120° facing the other (cos φ = 0.5).
    for (const [c, others] of [
      [a, [a, b]],
      [b, [a, b]],
    ] as const) {
      expect(arcLength(uncoveredArcs(c, others))).toBeCloseTo(
        TWO_PI - (2 * Math.PI) / 3,
        6,
      );
    }
    // a's covered arc faces +x (angle 0): 0 itself is not drawn.
    const arcsA = uncoveredArcs(a, [a, b]);
    expect(arcsA.some(([s, e]) => s <= 0.01 && e >= 0.01)).toBe(false);
    // A circle inside a bigger one draws nothing; disjoint ones are whole.
    expect(uncoveredArcs(circle(1, 0, 3), [circle(1, 0, 3), a])).toEqual([]);
    expect(uncoveredArcs(a, [a, circle(100, 0, 10)])).toEqual([[0, TWO_PI]]);
  });

  it("only merges circles of the same group", () => {
    const arcs = samArcs([circle(0, 0, 10, 0), circle(10, 0, 10, 2)]);
    expect(arcs).toHaveLength(2);
    for (const arc of arcs) {
      expect(arc.start).toBe(0);
      expect(arc.end).toBe(TWO_PI);
    }
    // b's visible part crosses angle 0, so it is split there.
    expect(samArcs([circle(0, 0, 10), circle(10, 0, 10)])).toHaveLength(3);
    expect(
      arcLength(
        samArcs([circle(0, 0, 10), circle(10, 0, 10)]).map(
          (a) => [a.start, a.end] as [number, number],
        ),
      ),
    ).toBeCloseTo(2 * (TWO_PI - (2 * Math.PI) / 3), 6);
  });
});

describe("SAM ring circles from structures", () => {
  it("colours by relation and sizes by level, active launchers only", () => {
    const units = [
      sam(1, 10, 10, 1, { level: 1 }),
      sam(2, 50, 10, 2, { level: 3 }),
      sam(3, 90, 10, 7, { level: 5 }),
      sam(4, 130, 10, 7, { isActive: false }),
      { ...sam(5, 150, 10, 7), unitType: "City" } as UnitState,
    ];
    const { circles, upgrading } = collectSamCircles(units, 200, 0, VIEW);
    expect(upgrading).toBe(false);
    expect(circles).toHaveLength(3);
    const [self, ally, enemy] = circles;
    expect(self.color).toEqual(SAM_COLOR_SELF);
    expect(ally.color).toEqual(SAM_COLOR_ALLY);
    expect(enemy.color).toEqual(SAM_COLOR_ENEMY);
    expect(self.radius).toBe(samRange(1));
    expect(ally.radius).toBe(samRange(3));
    expect(enemy.radius).toBe(samRange(5));
    // Tile centre; friendly (self + allies) vs enemy groups.
    expect([self.x, self.y]).toEqual([10.5, 10.5]);
    expect(self.group).toBe(0);
    expect(ally.group).toBe(0);
    expect(enemy.group).toBe(2);
    for (const c of circles) {
      expect(c.alpha).toBe(1);
      expect(c.spin).toBe(1);
    }
  });

  it("animates an upgrade: growing radius, target preview, group preview", () => {
    const units = [
      sam(1, 10, 10, 1, {
        level: 1,
        samUpgradeStartTick: 100,
        samUpgradeStartRange: samRange(1),
        samUpgradeTargetLevel: 2,
        samUpgradeDuration: 50,
      }),
      sam(2, 60, 10, 2, { level: 1 }),
      sam(3, 120, 10, 9, { level: 1 }),
    ];
    const at = (tick: number) => collectSamCircles(units, 200, tick, VIEW);
    const mid = at(125);
    expect(mid.upgrading).toBe(true);
    const own = mid.circles.filter((c) => c.x === 10.5);
    expect(own).toHaveLength(2);
    expect(own[0].radius).toBeCloseTo((samRange(1) + samRange(2)) / 2, 9);
    expect(own[0].alpha).toBe(1); // friendly: the operating ring is solid
    expect(own[1].radius).toBe(samRange(2));
    expect(own[1].alpha).toBe(0.35);
    expect(own[1].spin).toBe(0);
    // The ally (same friendly group) gets a faint static preview too; the
    // enemy group does not.
    expect(mid.circles.filter((c) => c.x === 60.5)).toHaveLength(2);
    expect(mid.circles.filter((c) => c.x === 120.5)).toHaveLength(1);
    // Before / after the upgrade window: one plain circle each.
    expect(at(99).circles).toHaveLength(3);
    expect(at(150).circles).toHaveLength(3);
    expect(at(150).upgrading).toBe(false);
  });

  it("owner mode: palette colours (linear) and alliance-cluster groups", () => {
    const palette = new Float32Array(4096 * 4);
    palette.set([1, 0.5, 0, 1], 7 * 4);
    const view: SamViewInputs = {
      ...VIEW,
      colorMode: "owner",
      clusters: new Map([
        [7, 3],
        [8, 3],
      ]),
      palette,
    };
    const { circles } = collectSamCircles(
      [sam(1, 10, 10, 7), sam(2, 40, 10, 8), sam(3, 90, 10, 9)],
      200,
      0,
      view,
    );
    expect(circles[0].color[0]).toBeCloseTo(1, 6);
    expect(circles[0].color[1]).toBeCloseTo(0.214, 3); // sRGB 0.5
    expect(circles[0].group).toBe(circles[1].group);
    expect(circles[2].group).not.toBe(circles[0].group);
  });
});

describe("SamRangeRings mesh", () => {
  function make(surface = flatSurface()) {
    const parent = new THREE.Group();
    const rings = new SamRangeRings(
      parent,
      surface,
      200,
      createRenderSettings().samRadius,
      null,
      19,
    );
    // Sample every circle in the frame it is needed (the budget has its
    // own test).
    rings.sampleBudgetMs = Infinity;
    return { rings, parent, surface };
  }
  const units = (...list: UnitState[]) =>
    new Map(list.map((u) => [u.id, u] as const));

  it("shows only in build mode for SAM-relevant ghosts / highlights", () => {
    const { rings } = make();
    rings.setLocalPlayer(1);
    rings.setStructures(units(sam(1, 60, 60, 1)));
    rings.update(frame(0));
    expect(rings.mesh.visible).toBe(false);
    for (const type of [
      "SAM Launcher",
      "Missile Silo",
      "City",
      "Atom Bomb",
      "Hydrogen Bomb",
    ]) {
      rings.setGhostType(type);
      rings.update(frame(0));
      expect(rings.mesh.visible, type).toBe(true);
    }
    rings.setGhostType("Port");
    rings.update(frame(0));
    expect(rings.mesh.visible).toBe(false);
    rings.setGhostType(null);
    rings.setHighlightTypes(["Hydrogen Bomb"]);
    rings.update(frame(0));
    expect(rings.mesh.visible).toBe(true);
    // City / Silo buttons do not (SAM_RADIUS_HIGHLIGHT_TYPES).
    rings.setHighlightTypes(["City", "Missile Silo"]);
    rings.update(frame(0));
    expect(rings.mesh.visible).toBe(false);
    rings.dispose();
  });

  it("builds lazily: inputs only mark it dirty while hidden", () => {
    const { rings } = make();
    rings.setStructures(units(sam(1, 60, 60, 1)));
    rings.setLocalPlayer(1);
    rings.setAllies(new Set([3]));
    for (let i = 0; i < 5; i++) rings.update(frame(i * 16));
    expect(rings.perfStats().rebuilds).toBe(0);
    rings.setGhostType("SAM Launcher");
    rings.update(frame(100));
    expect(rings.perfStats().rebuilds).toBe(1);
    // Same inputs every tick: no rebuild.
    rings.setStructures(units(sam(1, 60, 60, 1)));
    rings.setAllies(new Set([3]));
    rings.setAllianceClusters(new Map([[1, 1]])); // perspective: ignored
    rings.update(frame(116));
    expect(rings.perfStats().rebuilds).toBe(1);
    // A new ally recolours.
    rings.setAllies(new Set([3, 4]));
    rings.update(frame(132));
    expect(rings.perfStats().rebuilds).toBe(2);
    // A level change resizes.
    rings.setStructures(units(sam(1, 60, 60, 1, { level: 4 })));
    rings.update(frame(148));
    expect(rings.perfStats().rebuilds).toBe(3);
    rings.dispose();
  });

  it("spreads the sampling of new circles over frames", () => {
    const { rings } = make();
    rings.sampleBudgetMs = 0; // one circle per frame
    rings.setLocalPlayer(1);
    rings.setGhostType("SAM Launcher");
    rings.setStructures(units(sam(1, 40, 40, 1), sam(2, 150, 120, 5)));
    rings.update(frame(0));
    expect(rings.perfStats().pendingCircles).toBe(1);
    expect(rings.mesh.visible).toBe(false);
    rings.update(frame(16));
    expect(rings.perfStats().pendingCircles).toBe(0);
    expect(rings.perfStats().circles).toBe(2);
    expect(rings.mesh.visible).toBe(true);
    // Two new launchers: the drawn rings stay until all heights are in.
    rings.setStructures(
      units(
        sam(1, 40, 40, 1),
        sam(2, 150, 120, 5),
        sam(3, 100, 40, 5),
        sam(4, 20, 130, 5),
      ),
    );
    rings.update(frame(32));
    expect(rings.perfStats().pendingCircles).toBe(1);
    expect(rings.perfStats().circles).toBe(2);
    expect(rings.mesh.visible).toBe(true);
    rings.update(frame(48));
    expect(rings.perfStats().circles).toBe(4);
    rings.dispose();
  });

  it("refreshes an upgrading SAM at 20 Hz while shown", () => {
    const { rings } = make();
    rings.setGhostType("SAM Launcher");
    rings.setLocalPlayer(1);
    rings.setTick(100, 0);
    rings.setStructures(
      units(
        sam(1, 60, 60, 1, {
          samUpgradeStartTick: 99,
          samUpgradeStartRange: samRange(1),
          samUpgradeTargetLevel: 3,
          samUpgradeDuration: 100,
        }),
      ),
    );
    rings.update(frame(10));
    expect(rings.perfStats().rebuilds).toBe(1);
    expect(rings.perfStats().circles).toBe(2);
    rings.update(frame(10 + SAM_UPGRADE_REFRESH_MS / 2));
    expect(rings.perfStats().rebuilds).toBe(1);
    rings.update(frame(10 + SAM_UPGRADE_REFRESH_MS));
    expect(rings.perfStats().rebuilds).toBe(2);
    rings.dispose();
  });

  it("builds ribbons on the surface: 5 lines across, colours per circle", () => {
    const { rings, surface } = make();
    rings.setLocalPlayer(1);
    rings.setAllies(new Set([2]));
    rings.setStructures(
      units(sam(1, 50, 80, 1), sam(2, 70, 80, 2), sam(3, 150, 80, 5)),
    );
    rings.setGhostType("City");
    rings.update(frame(0));
    const g = rings.mesh.geometry;
    const st = rings.perfStats();
    // Self + ally merge (the ally's arc crosses angle 0: two arcs), the
    // enemy is a full circle.
    expect(st.circles).toBe(3);
    expect(st.arcs).toBe(4);
    expect(g.drawRange.count).toBe(st.segments * (RING_LINES - 1) * 6);
    const pos = g.getAttribute("position");
    const col = g.getAttribute("aColor");
    const ring = g.getAttribute("aRing");
    const seen = new Set<string>();
    for (let v = 0; v < st.vertices; v++) {
      expect(pos.getY(v)).toBeCloseTo(
        surface.surfaceAt(pos.getX(v), pos.getZ(v)) + SAM_RING_LIFT,
        4,
      );
      // Radial offset in [-2, 2]: the stroke (1.5) plus 0.5 smoothing.
      expect(Math.abs(ring.getX(v))).toBeLessThanOrEqual(2 + 1e-6);
      seen.add(`${col.getX(v)},${col.getY(v)},${col.getZ(v)}`);
    }
    expect(seen).toEqual(new Set(["0,1,0", "1,1,0", "1,0,0"]));
    rings.dispose();
  });
});

describe("SAM ring draping on the World relief", () => {
  it("never dips under the drawn relief and floats little", () => {
    const settings = defaultThreeSettings();
    const hf = new HeightField(WORLD_W, WORLD_H, worldTerrain(), {
      heightScale: settings.heightScale,
      seabedDepth: settings.seabedDepth,
      targetVertices: settings.targetVertices,
    });
    const ctx: ThreeLayerContext = {
      renderer: {
        initTexture: () => {},
        copyTextureToTexture: () => {},
      } as unknown as THREE.WebGLRenderer,
      scene: new THREE.Scene(),
      mapWidth: WORLD_W,
      mapHeight: WORLD_H,
      heightField: hf,
      palette: new PaletteView(),
      settings,
      renderSettings: createRenderSettings(),
      config: {} as Config,
      overlayRoot: document.createElement("div"),
    };
    const terrain = new TerrainLayer(ctx);
    const rings = new SamRangeRings(
      new THREE.Group(),
      terrain,
      WORLD_W,
      ctx.renderSettings.samRadius,
      null,
      19,
    );
    // 40 enemy SAMs scattered over the map (mountains, coasts, sea).
    const r = rng(11);
    const map = new Map<number, UnitState>();
    for (let i = 1; i <= 40; i++) {
      const x = Math.floor(150 + r() * 1700);
      const y = Math.floor(150 + r() * 700);
      map.set(i, sam(i, x, y, 9, { level: 1 + (i % 4) }, WORLD_W));
    }
    rings.setLocalPlayer(1);
    rings.setStructures(map);
    rings.setGhostType("SAM Launcher");
    // The heights are sampled over a few frames (2 ms each).
    let frames = 0;
    do {
      rings.update(frame(frames * 16));
      frames++;
    } while (rings.perfStats().pendingCircles > 0 && frames < 200);
    expect(rings.perfStats().pendingCircles).toBe(0);
    expect(rings.mesh.visible).toBe(true);
    const g = rings.mesh.geometry;
    const pos = g.getAttribute("position");
    const idx = g.getIndex()!;
    const n = g.drawRange.count;
    expect(n).toBeGreaterThan(0);
    let below = 0;
    let minD = 0;
    let maxFloat = 0;
    let floatSum = 0;
    let samples = 0;
    const p = [0, 0, 0].map(() => new THREE.Vector3());
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++)
        p[k].fromBufferAttribute(pos, idx.getX(t + k));
      for (const [u, v] of [
        [1 / 3, 1 / 3],
        [0.5, 0.25],
        [0.25, 0.5],
        [0.1, 0.1],
      ]) {
        const w = 1 - u - v;
        const x = p[0].x * w + p[1].x * u + p[2].x * v;
        const y = p[0].y * w + p[1].y * u + p[2].y * v;
        const z = p[0].z * w + p[1].z * u + p[2].z * v;
        const d = y - terrain.surfaceAt(x, z);
        if (d < 0) {
          below++;
          minD = Math.min(minD, d);
        }
        maxFloat = Math.max(maxFloat, d);
        floatSum += d;
        samples++;
      }
    }
    expect({ below, minD }).toEqual({ below: 0, minD: 0 });
    expect(maxFloat).toBeLessThan(1);
    expect(floatSum / samples).toBeLessThan(SAM_RING_LIFT + 0.1);
    // Flat runs (sea, plains) are decimated: well under one column per tile.
    const st = rings.perfStats();
    let circumference = 0;
    for (const u of map.values()) circumference += TWO_PI * samRange(u.level);
    expect(st.segments).toBeLessThan(circumference * 0.75);
    rings.dispose();
    terrain.dispose();
  }, 60_000);
});
