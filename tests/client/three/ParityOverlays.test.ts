/**
 * Facade wiring of the lot-2 parity overlays (ThreeMapRenderer): the spawn
 * halos, the small-player glow, the coordinate grid (grid view + alt view,
 * remembered under the default renderer's localStorage key) and the SAM
 * range rings (structures, allies + teammates, build mode). three's
 * WebGLRenderer and initGL are stubbed; the layers are real.
 */
import type { Config } from "@openfront/engine-lib/configuration/Config";
import type * as THREE_NS from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnCenter } from "../../../src/client/render/gl/passes/SpawnOverlayPass";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { GRID_VIEW_KEY } from "../../../src/client/render/three/SurfaceOverlay";
import { ThreeMapRenderer } from "../../../src/client/render/three/ThreeMapRenderer";
import {
  type PlayerState,
  type PlayerStatic,
  PlayerTypeEnum,
  type RendererConfig,
  type UnitState,
} from "../../../src/client/render/types";

const stub = vi.hoisted(() => ({
  renders: [] as { scene: unknown; target: unknown }[],
}));

vi.mock("../../../src/client/render/gl/initGL", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initGL: () => ({
    status: "ok",
    gl: {
      SAMPLES: 0x80a9,
      getParameter: () => 0,
      getExtension: () => null,
    },
  }),
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    info = {
      autoReset: true,
      reset: () => {},
      render: { calls: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
      programs: [],
    };
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "";
    private target: unknown = null;
    initTexture() {}
    copyTextureToTexture() {}
    setPixelRatio() {}
    setSize() {}
    getRenderTarget() {
      return this.target;
    }
    setRenderTarget(t: unknown) {
      this.target = t;
    }
    render(scene: unknown) {
      stub.renders.push({ scene, target: this.target });
    }
    dispose() {}
    forceContextLoss() {}
  }
  return { ...actual, WebGLRenderer };
});

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const W = 120;
const H = 80;

function makeView() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  let pending: FrameRequestCallback | null = null;
  const terrain = new Uint8Array(W * H).fill(0x80 | 4);
  const view = new ThreeMapRenderer(
    canvas,
    { mapWidth: W, mapHeight: H, players: [] } as unknown as RendererConfig,
    () => terrain,
    new Float32Array(4096 * 2 * 4),
    { msPerTick: () => 100 } as unknown as Config,
    createRenderSettings(),
    (cb) => {
      pending = cb;
      return 1;
    },
    () => {
      pending = null;
    },
  );
  const frame = (): void => {
    const cb = pending;
    pending = null;
    cb?.(performance.now());
  };
  const obj = (name: string) =>
    view.scene.getObjectByName(name) as THREE_NS.Mesh<
      THREE_NS.BufferGeometry,
      THREE_NS.ShaderMaterial
    >;
  /** Off-screen renders (glow mask passes), not the frame's scene render. */
  const offscreen = () =>
    stub.renders.filter((r) => r.scene !== view.scene).length;
  return { view, frame, obj, offscreen };
}

function player(smallID: number, team: string | null): PlayerStatic {
  return {
    smallID,
    id: `p${smallID}`,
    name: `P${smallID}`,
    displayName: `P${smallID}`,
    clanTag: null,
    clientID: null,
    playerType: PlayerTypeEnum.Human,
    team,
    isLobbyCreator: false,
  };
}

function sam(id: number, x: number, y: number, ownerID: number): UnitState {
  return {
    id,
    unitType: "SAM Launcher",
    ownerID,
    pos: y * W + x,
    level: 1,
    isActive: true,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
  } as UnitState;
}

describe("ThreeMapRenderer parity overlays", () => {
  let search = "";

  beforeEach(() => {
    stub.renders = [];
    search = window.location.search;
    // No bloom: the post chain needs a real renderer.
    window.history.replaceState(null, "", "?three_bloom=0");
    localStorage.removeItem(GRID_VIEW_KEY);
  });

  afterEach(() => {
    window.history.replaceState(null, "", search || "?");
    document.body.innerHTML = "";
    sessionStorage.clear();
    localStorage.removeItem(GRID_VIEW_KEY);
  });

  it("draws the spawn halos while centres are pushed", () => {
    const { view, frame, obj } = makeView();
    const me: SpawnCenter = {
      x: 40,
      y: 30,
      r: 1,
      g: 0.84,
      b: 0,
      isSelf: true,
      isTeammate: false,
    };
    view.updateSpawnOverlay(true, [me]);
    frame();
    expect(obj("spawn-overlay").visible).toBe(true);
    // Tutorial: past the spawn phase, only the local halo stays.
    view.updateSpawnOverlay(false, [me]);
    frame();
    expect(obj("spawn-overlay").visible).toBe(true);
    view.updateSpawnOverlay(false, []);
    frame();
    expect(obj("spawn-overlay").visible).toBe(false);
    view.dispose();
  });

  it("draws the small-player glow from the pushed set", () => {
    const { view, frame, obj, offscreen } = makeView();
    frame();
    expect(obj("sea-overlay").visible).toBe(false);
    expect(offscreen()).toBe(0);
    const set = new Uint8Array(4096);
    set[7] = 1;
    view.updateSmallPlayerGlow(set);
    frame();
    expect(offscreen()).toBe(3);
    expect(obj("sea-overlay").visible).toBe(true);
    frame();
    expect(offscreen()).toBe(3);
    view.updateSmallPlayerGlow(null);
    frame();
    expect(obj("sea-overlay").visible).toBe(false);
    view.dispose();
  });

  it("shows the grid with the grid view or the alt view, remembered", () => {
    localStorage.setItem(GRID_VIEW_KEY, "true");
    const a = makeView();
    a.frame();
    expect(a.obj("sea-overlay").visible).toBe(true);
    a.view.setGridView(false);
    expect(localStorage.getItem(GRID_VIEW_KEY)).toBe("false");
    a.frame();
    expect(a.obj("sea-overlay").visible).toBe(false);
    a.view.setAltView(true);
    a.frame();
    expect(a.obj("sea-overlay").visible).toBe(true);
    a.view.setAltView(false);
    a.view.setGridView(true);
    expect(localStorage.getItem(GRID_VIEW_KEY)).toBe("true");
    a.frame();
    expect(a.obj("sea-overlay").visible).toBe(true);
    a.view.dispose();
    // The next game starts with the grid on.
    const b = makeView();
    b.frame();
    expect(b.obj("sea-overlay").visible).toBe(true);
    b.view.dispose();
  });

  it("draws SAM rings in build mode, coloured for the local player", () => {
    const { view, frame, obj } = makeView();
    view.addPlayers(
      [player(1, "red"), player(4, "red"), player(5, null), player(6, null)],
      new Float32Array(4096 * 2 * 4),
      new Float32Array(0),
      new Uint8Array(0),
    );
    view.setLocalPlayerID(1);
    view.updateStructures(
      new Map([
        [1, sam(1, 20, 20, 1)],
        [2, sam(2, 90, 20, 4)], // teammate
        [3, sam(3, 20, 70, 5)], // ally
        [4, sam(4, 100, 70, 6)], // enemy
      ]),
    );
    view.updateNames(
      new Map(),
      new Map([[1, { smallID: 1, isAlive: true, allies: [5] } as PlayerState]]),
      false,
    );
    view.setSAMAllianceClusters(new Map([[1, 1]]));
    frame();
    const rings = obj("sam-rings");
    expect(rings.visible).toBe(false);

    view.updateGhostPreview({
      ghostType: "SAM Launcher",
      tileX: 60,
      tileY: 40,
      radiusTileX: 60,
      radiusTileY: 40,
      canBuild: true,
      canUpgrade: false,
      cost: 0,
      showCost: false,
      canAfford: true,
      ghostRailPaths: [],
      overlappingRailroads: [],
      ownerID: 1,
      upgradeTargetTile: null,
      rangeRadius: 60,
      rangeWarning: false,
    });
    // Heights are sampled over a few frames (2 ms of JS each).
    for (let i = 0; i < 20 && !rings.visible; i++) frame();
    expect(rings.visible).toBe(true);
    // The ghost also shows as an icon (StructureLayer) while icons show.
    expect(obj("structure-ghost-icon").visible).toBe(true);
    const col = rings.geometry.getAttribute("aColor");
    const colours = new Set<string>();
    for (let v = 0; v < col.count; v++) {
      if (col.getW(v) > 0) {
        colours.add(`${col.getX(v)},${col.getY(v)},${col.getZ(v)}`);
      }
    }
    // Self green, teammate + ally yellow, enemy red.
    expect(colours).toEqual(new Set(["0,1,0", "1,1,0", "1,0,0"]));

    view.updateGhostPreview(null);
    frame();
    expect(rings.visible).toBe(false);
    expect(obj("structure-ghost-icon").visible).toBe(false);
    view.setHighlightStructureTypes(["SAM Launcher"]);
    frame();
    expect(rings.visible).toBe(true);
    view.setHighlightStructureTypes(null);
    frame();
    expect(rings.visible).toBe(false);
    view.dispose();
  });

  it("feeds the relations to the structure icons (alt-view allies)", () => {
    const { view, frame, obj } = makeView();
    const aff = createRenderSettings().affiliation;
    const darken = createRenderSettings().structure.fillDarken;
    view.setLocalPlayerID(1);
    view.updateStructures(
      new Map([
        [
          9,
          {
            id: 9,
            unitType: "City",
            ownerID: 5,
            pos: 30 * W + 30,
            level: 1,
            isActive: true,
            underConstruction: false,
            markedForDeletion: false,
          } as UnitState,
        ],
      ]),
    );
    view.setAltView(true);
    frame();
    const fill = () => obj("structure-icons").geometry.getAttribute("aFill");
    // No relations yet: every other player reads as an enemy.
    expect(fill().getX(0)).toBeCloseTo(aff.enemyR * darken);
    expect(fill().getY(0)).toBeCloseTo(aff.enemyG * darken);
    const size = 8;
    const rel = new Uint8Array(size * size);
    rel[1 * size + 5] = 1; // player 5 is friendly to the local player 1
    view.updateRelations(rel, size);
    frame();
    expect(fill().getX(0)).toBeCloseTo(aff.allyR * darken);
    expect(fill().getY(0)).toBeCloseTo(aff.allyG * darken);
    expect(fill().getZ(0)).toBeCloseTo(aff.allyB * darken);
    view.dispose();
  });
});
