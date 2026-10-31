import type { Config } from "@openfront/engine-lib/configuration/Config";
import { renderTroops } from "@openfront/engine-lib/Format";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import type { HeightField } from "../../../src/client/render/three/HeightField";
import {
  bonusPopupText,
  conquestPopupText,
  formatPopupGold,
  lerpFactor,
  LINE_PER_EM,
  MAX_POPUPS,
  NAME_CULL_FRACTION,
  nameEmTiles,
  NameLayer,
  nameLineHeightTiles,
  nameShade,
  popupAlpha,
  quantizeLog2,
  shownNameLineHeightPx,
  STATUS_CROWN,
  STATUS_DISCONNECTED,
  STATUS_NUKE,
  STATUS_NUKE_TARGETS_ME,
  STATUS_TARGET,
  STATUS_TRAITOR,
  statusIconIndices,
  statusMask,
  statusSpriteCss,
  troopRefreshBucket,
} from "../../../src/client/render/three/NameLayer";
import { PaletteView } from "../../../src/client/render/three/PaletteView";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type {
  FrameInfo,
  ProjectFn,
  ThreeLayerContext,
} from "../../../src/client/render/three/types";
import {
  PlayerTypeEnum,
  type NameEntry,
  type PlayerState,
  type PlayerStatic,
  type PlayerStatusData,
} from "../../../src/client/render/types";

describe("name sizing (NamePass formula)", () => {
  it("maps NameEntry.size to an em in tiles", () => {
    // size 1: nameSize max(4, 0) = 4, nameScale 0.25 → 1 tile
    expect(nameEmTiles(1)).toBe(1);
    expect(nameEmTiles(0.3)).toBe(1); // baseSize clamps to 1
    // size 12: nameSize 4, nameScale min(3, 3) → 12
    expect(nameEmTiles(12)).toBe(12);
    // size 20: nameSize 8, nameScale capped at 3 → 24
    expect(nameEmTiles(20)).toBe(24);
    // floor(size) is used
    expect(nameEmTiles(20.9)).toBe(24);
  });

  it("line height is 36/48 of the em", () => {
    expect(LINE_PER_EM).toBe(0.75);
    expect(nameLineHeightTiles(20)).toBeCloseTo(18, 12);
  });

  it("culls below 0.004 × canvas width, with target / hover exceptions", () => {
    const cssW = 1500; // threshold = 6 px
    const thr = NAME_CULL_FRACTION * cssW;
    expect(thr).toBe(6);
    expect(shownNameLineHeightPx(10, cssW, false, false)).toBe(10);
    expect(shownNameLineHeightPx(6, cssW, false, false)).toBe(6);
    expect(shownNameLineHeightPx(5.9, cssW, false, false)).toBe(0);
    // Targeted: boosted to exactly the threshold.
    expect(shownNameLineHeightPx(1, cssW, true, false)).toBe(6);
    expect(shownNameLineHeightPx(20, cssW, true, false)).toBe(20);
    // Hovered: keeps its own (small) size.
    expect(shownNameLineHeightPx(2, cssW, false, true)).toBe(2);
    // Degenerate input never shows.
    expect(shownNameLineHeightPx(0, cssW, true, true)).toBe(0);
    expect(shownNameLineHeightPx(NaN, cssW, true, true)).toBe(0);
  });
});

describe("name animation helpers", () => {
  it("lerp factor is frame-rate independent", () => {
    expect(lerpFactor(0)).toBe(0);
    expect(lerpFactor(100, 10)).toBeCloseTo(1 - Math.exp(-1), 12);
    // Two 8 ms steps leave the same remainder as one 16 ms step.
    const a = lerpFactor(8);
    const b = lerpFactor(16);
    expect((1 - a) * (1 - a)).toBeCloseTo(1 - b, 12);
    expect(lerpFactor(-5)).toBe(0);
  });

  it("troop refresh buckets every 500 ms, staggered by 100 ms per slot", () => {
    expect(troopRefreshBucket(0, 0)).toBe(0);
    expect(troopRefreshBucket(499, 0)).toBe(0);
    expect(troopRefreshBucket(500, 0)).toBe(1);
    // index 1 is 100 ms ahead: its bucket changes at 400 ms.
    expect(troopRefreshBucket(399, 1)).toBe(0);
    expect(troopRefreshBucket(400, 1)).toBe(1);
    // the stagger wraps every 5 slots
    expect(troopRefreshBucket(400, 6)).toBe(troopRefreshBucket(400, 1));
  });

  it("log-quantises the outline compensation factor", () => {
    expect(quantizeLog2(1, 12)).toBe(1);
    expect(quantizeLog2(4, 12)).toBe(4);
    expect(quantizeLog2(0.25, 12)).toBe(0.25);
    for (const v of [0.13, 0.7, 1.9, 3.3, 11]) {
      const q = quantizeLog2(v, 12);
      expect(Math.abs(Math.log2(q / v))).toBeLessThanOrEqual(1 / 24 + 1e-12);
    }
    expect(quantizeLog2(0, 12)).toBe(1);
    expect(quantizeLog2(Infinity, 12)).toBe(1);
  });

  it("popups fade linearly over their life", () => {
    expect(popupAlpha(0, 2500)).toBe(1);
    expect(popupAlpha(1250, 2500)).toBe(0.5);
    expect(popupAlpha(2500, 2500)).toBe(0);
    expect(popupAlpha(9999, 2500)).toBe(0);
    expect(popupAlpha(10, 0)).toBe(0);
  });
});

describe("number formatting", () => {
  it("formats popup gold like WorldTextPass", () => {
    expect(formatPopupGold(0)).toBe("0");
    expect(formatPopupGold(999)).toBe("999");
    expect(formatPopupGold(1500)).toBe("1.5K");
    expect(formatPopupGold(45_000)).toBe("45.0K");
    expect(formatPopupGold(1_234_567)).toBe("1.2M");
    expect(conquestPopupText(1500)).toBe("+ 1.5K");
    expect(bonusPopupText(45_000)).toBe("+ 45.0K");
    expect(bonusPopupText(-3000)).toBe("- 3.0K");
  });

  it("reuses renderTroops for the troop line", () => {
    // renderTroops shows troops / 10, floored to 3 significant digits.
    expect(renderTroops(9990)).toBe("999");
    expect(renderTroops(12_345)).toBe("1.23K");
    expect(renderTroops(1_234_567)).toBe("123K");
  });
});

describe("status row", () => {
  const sd = (p: Partial<PlayerStatusData>): PlayerStatusData => ({
    crown: false,
    traitor: false,
    disconnected: false,
    alliance: false,
    allianceReq: false,
    target: false,
    embargo: false,
    nukeActive: false,
    nukeTargetsMe: false,
    inDoomsdayClock: false,
    doomsdayClockDraining: false,
    doomsdayClockDecaying: false,
    doomsdayClockWarnProgress: 0,
    traitorRemainingTicks: 0,
    allianceFraction: 0,
    allianceRemainingTicks: 0,
    ...p,
  });

  it("builds a bit mask from status data", () => {
    expect(statusMask(undefined)).toBe(0);
    expect(statusMask(sd({}))).toBe(0);
    expect(statusMask(sd({ crown: true, target: true }))).toBe(
      STATUS_CROWN | STATUS_TARGET,
    );
  });

  it("orders icons like NamePass and picks the nuke colour", () => {
    // crown 0, traitor 1, disconnected 2, target 5, nukeWhite 8 / nukeRed 7
    expect(
      statusIconIndices(
        STATUS_TARGET | STATUS_CROWN | STATUS_TRAITOR | STATUS_DISCONNECTED,
      ),
    ).toEqual([0, 1, 2, 5]);
    expect(statusIconIndices(STATUS_NUKE)).toEqual([8]);
    expect(statusIconIndices(STATUS_NUKE | STATUS_NUKE_TARGETS_ME)).toEqual([
      7,
    ]);
    // nukeTargetsMe alone shows nothing
    expect(statusIconIndices(STATUS_NUKE_TARGETS_ME)).toEqual([]);
  });

  it("addresses the padded inner square of an atlas cell", () => {
    // 768×1024 atlas, 256-px cells, 16-px padding → 224-px inner squares.
    expect(statusSpriteCss(0, 224)).toEqual({
      size: "768px 1024px",
      position: "-16px -16px",
    });
    // index 5 = column 2, row 1
    expect(statusSpriteCss(5, 224).position).toBe("-528px -272px");
    // half size scales everything
    expect(statusSpriteCss(5, 112)).toEqual({
      size: "384px 512px",
      position: "-264px -136px",
    });
  });

  it("uses grey fills for nations and bots", () => {
    expect(nameShade(PlayerTypeEnum.Human)).toBe(0);
    expect(nameShade(PlayerTypeEnum.Nation)).toBe(0.3);
    expect(nameShade(PlayerTypeEnum.Bot)).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// DOM behaviour (jsdom)
// ---------------------------------------------------------------------------

const MAP_W = 200;

function makeCtx() {
  const palette = new PaletteView();
  const ctx: ThreeLayerContext = {
    renderer: {} as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    mapWidth: MAP_W,
    mapHeight: 100,
    heightField: { surfaceAt: () => 0 } as unknown as HeightField,
    palette,
    settings: defaultThreeSettings(),
    renderSettings: createRenderSettings(),
    config: { msPerTick: () => 100 } as unknown as Config,
    overlayRoot: document.createElement("div"),
  };
  return ctx;
}

/** Top-down projection at `zoom` CSS px per tile, all points visible. */
function projector(zoom: number): ProjectFn {
  return (wx, wy) => ({ x: wx * zoom, y: wy * zoom, visible: true });
}

function frame(nowMs: number, p: Partial<FrameInfo> = {}): FrameInfo {
  return {
    nowMs,
    dtMs: 16,
    tickAlpha: 1,
    camera: new THREE.PerspectiveCamera(),
    cssPxPerTile: 1,
    tilt: 0,
    cssWidth: 1000,
    cssHeight: 800,
    dpr: 1,
    localPlayerID: 0,
    highlightOwner: 0,
    altView: false,
    ...p,
  };
}

function player(
  id: string,
  smallID: number,
  extra: Partial<PlayerStatic> = {},
) {
  return {
    smallID,
    id,
    name: id,
    displayName: id.toUpperCase(),
    clanTag: null,
    clientID: null,
    playerType: PlayerTypeEnum.Human,
    team: null,
    isLobbyCreator: false,
    ...extra,
  } satisfies PlayerStatic;
}

function state(smallID: number, troops: number, isAlive = true): PlayerState {
  return {
    smallID,
    troops,
    isAlive,
    outgoingEmojis: [],
  } as unknown as PlayerState;
}

function labels(ctx: ThreeLayerContext): HTMLElement[] {
  return Array.from(
    ctx.overlayRoot.querySelectorAll<HTMLElement>(".ofn-label"),
  );
}

describe("NameLayer DOM", () => {
  it("creates, positions, sizes and culls name labels", () => {
    const ctx = makeCtx();
    const layer = new NameLayer(ctx);
    layer.addPlayers([player("a", 1), player("b", 2)]);
    const names = new Map<string, NameEntry>([
      ["a", { playerID: "a", x: 10, y: 20, size: 20 }],
      ["b", { playerID: "b", x: 50, y: 50, size: 1 }],
    ]);
    const players = new Map([
      [1, state(1, 12_345)],
      [2, state(2, 100)],
    ]);
    layer.updateNames(names, players, false);
    layer.update(frame(1000), projector(2));

    // "b" is size 1 → line 0.75 tiles × 2 px = 1.5 px < 4 px: culled, and
    // never built.
    const els = labels(ctx);
    expect(els).toHaveLength(1);
    const el = els[0];
    expect(el.style.display).toBe("block");
    expect(el.querySelector(".ofn-name")!.textContent).toBe("A");
    expect(el.querySelector(".ofn-troops")!.textContent).toBe("1.23K");
    // em 24 tiles → line 18 tiles × 2 px = 36 px; design line 24 px → ×1.5
    expect(el.style.transform).toBe("translate3d(20px,40px,0) scale(1.5000)");

    // Zoomed far out the label is culled (36/2/10 = 1.8 px < 4 px).
    layer.update(frame(1016), projector(0.1));
    expect(el.style.display).toBe("none");
    // ... unless it is the hovered owner.
    layer.update(frame(1032, { highlightOwner: 1 }), projector(0.1));
    expect(el.style.display).toBe("block");
    expect(el.classList.contains("ofn-hover")).toBe(true);
    layer.dispose();
    expect(ctx.overlayRoot.children).toHaveLength(0);
  });

  it("boosts targeted names, hides dead players and alt view", () => {
    const ctx = makeCtx();
    const layer = new NameLayer(ctx);
    layer.addPlayers([player("a", 1)]);
    const names = new Map<string, NameEntry>([
      ["a", { playerID: "a", x: 10, y: 10, size: 1 }],
    ]);
    const status = new Map<number, PlayerStatusData>([
      [1, { target: true } as PlayerStatusData],
    ]);
    layer.updateNames(names, new Map([[1, state(1, 10)]]), false, status);
    layer.update(frame(0), projector(2));
    const el = labels(ctx)[0];
    // threshold 4 px → scale 4 / 24
    expect(el.style.transform).toContain(`scale(${(4 / 24).toFixed(4)})`);
    expect(el.querySelectorAll(".ofn-status .ofn-icon")).toHaveLength(1);

    layer.update(frame(16, { altView: true }), projector(2));
    expect((el.parentElement as HTMLElement).style.display).toBe("none");
    layer.update(frame(32), projector(2));
    expect((el.parentElement as HTMLElement).style.display).toBe("");

    layer.updateNames(names, new Map([[1, state(1, 10, false)]]), false);
    layer.update(frame(48), projector(2));
    expect(el.style.display).toBe("none");
  });

  it("lerps towards new placements and snaps on request", () => {
    const ctx = makeCtx();
    const layer = new NameLayer(ctx);
    layer.addPlayers([player("a", 1)]);
    const players = new Map([[1, state(1, 10)]]);
    const at = (x: number) =>
      new Map<string, NameEntry>([["a", { playerID: "a", x, y: 0, size: 20 }]]);
    layer.updateNames(at(0), players, false);
    layer.update(frame(0), projector(1)); // first placement snaps
    layer.updateNames(at(100), players, false);
    layer.update(frame(16, { dtMs: 100 }), projector(1));
    const el = labels(ctx)[0];
    const expected = 100 * lerpFactor(100);
    expect(el.style.transform).toBe(
      `translate3d(${Math.round(expected * 10) / 10}px,0px,0) scale(0.7500)`,
    );
    layer.updateNames(at(150), players, true);
    layer.update(frame(32), projector(1));
    expect(el.style.transform).toBe("translate3d(150px,0px,0) scale(0.7500)");
  });

  it("upserts players by id and refreshes display names", () => {
    const ctx = makeCtx();
    const layer = new NameLayer(ctx);
    layer.addPlayers([player("a", 1)]);
    layer.addPlayers([player("a", 1, { flag: "/flags/fr.svg" })]);
    const names = new Map<string, NameEntry>([
      ["a", { playerID: "a", x: 0, y: 0, size: 20 }],
    ]);
    layer.updateNames(names, new Map([[1, state(1, 10)]]), false);
    layer.update(frame(0), projector(1));
    expect(labels(ctx)).toHaveLength(1);
    const flag = labels(ctx)[0].querySelector<HTMLImageElement>(".ofn-flag");
    expect(flag?.getAttribute("src")).toBe("/flags/fr.svg");

    layer.refreshNames(new Map([["a", "Anonymous"]]));
    layer.update(frame(16), projector(1));
    expect(labels(ctx)[0].querySelector(".ofn-name")!.textContent).toBe(
      "Anonymous",
    );
  });

  it("draws attack labels at a constant size and recycles them", () => {
    const ctx = makeCtx();
    const layer = new NameLayer(ctx);
    layer.setAttackTroopLabels([
      { x: 1, y: 2, text: "5K", colorR: 1, colorG: 0, colorB: 0 },
      { x: 3, y: 4, text: "7K", colorR: 0, colorG: 0, colorB: 1 },
    ]);
    layer.update(frame(0), projector(10));
    const els = Array.from(
      ctx.overlayRoot.querySelectorAll<HTMLElement>(".ofn-attack"),
    );
    expect(els.map((e) => e.textContent)).toEqual(["5K", "7K"]);
    expect(els[0].style.transform).toBe(
      "translate3d(15px,25px,0) translate(-50%,-50%)",
    );
    expect(els[0].style.color).toBe("rgb(255, 0, 0)");
    layer.setAttackTroopLabels([]);
    layer.update(frame(16), projector(10));
    expect(els.every((e) => e.style.display === "none")).toBe(true);
  });

  it("shows conquest / bonus popups, fades and expires them", () => {
    const ctx = makeCtx();
    const layer = new NameLayer(ctx);
    const now = performance.now();
    layer.showConquest([{ x: 10, y: 10, gold: 1500 }]);
    // too old: skipped
    layer.showConquest([{ x: 10, y: 10, gold: 1, tickAge: 30 }]);
    layer.showBonus([
      {
        playerID: "a",
        smallID: 1,
        tile: 5 * MAP_W + 7,
        gold: 45_000,
        troops: 0,
      },
      { playerID: "a", smallID: 1, tile: 0, gold: 0, troops: 0 },
    ]);
    layer.update(frame(now), projector(4));
    const els = Array.from(
      ctx.overlayRoot.querySelectorAll<HTMLElement>(".ofn-popup"),
    );
    expect(els.map((e) => e.textContent)).toEqual(["+ 1.5K", "+ 45.0K"]);
    expect(els.every((e) => e.style.display === "block")).toBe(true);
    // conquest at (x + .5, y + 8 + .5) × 4 px, em = 6 tiles × 4 = 24 px
    expect(els[0].style.transform).toMatch(
      /^translate3d\(42px,74px,0\) scale\(0\.75\d*\) translate\(-50%,-50%\)$/,
    );
    layer.update(frame(now + 1600), projector(4));
    expect(els[1].style.display).toBe("none"); // bonus (1.5 s) is over
    expect(Number(els[0].style.opacity)).toBeLessThan(0.4);
    layer.update(frame(now + 2600), projector(4));
    expect(els[0].style.display).toBe("none");
  });

  it("caps the number of live popups", () => {
    const ctx = makeCtx();
    const layer = new NameLayer(ctx);
    const events = Array.from({ length: MAX_POPUPS + 20 }, (_, i) => ({
      x: i,
      y: 0,
      gold: i,
    }));
    layer.showConquest(events);
    layer.update(frame(performance.now()), projector(4));
    expect(
      ctx.overlayRoot.querySelectorAll(".ofn-popup").length,
    ).toBeLessThanOrEqual(MAX_POPUPS);
  });
});
