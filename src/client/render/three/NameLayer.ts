/**
 * NameLayer — DOM overlay (under `ctx.overlayRoot`) with player names, troop
 * counts and flags, attack troop labels and world-text popups (conquest /
 * bonus gold). Same data and rules as the default renderer's NamePass and
 * WorldTextPass (names.md §1-§3), drawn as HTML positioned by projecting
 * world points through the 3D camera.
 *
 * Contract notes:
 * - `addPlayers` is an upsert keyed by `PlayerStatic.id`: the facade also
 *   routes `updatePlayerCosmetics` (new flag / crown) through it.
 * - `showBonus` receives events already filtered to the local player (it
 *   filters again with the last frame's local player, harmlessly).
 * - `update` runs AFTER the 3D frame is drawn; `project(wx, wy, wh?)` maps a
 *   world point (tile coords; `wh` = world height, default the visible
 *   surface) to canvas CSS px for the camera of this frame.
 * - Names hide while `frame.altView` is on; world text stays (as in 2D).
 *
 * DOM / performance rules:
 * - One pooled element tree per player (created the first time the label is
 *   shown), one per attack label and per popup. Text is written only when it
 *   changes, troop counts at most every 500 ms per label.
 * - The loop never reads layout. Labels are laid out once at a fixed design
 *   size (`BASE_EM_PX`) and placed with `transform: translate3d() scale()`;
 *   centring uses static `translate(-50%, …)` on children, so the browser
 *   resolves widths itself.
 * - Outline / glow widths must stay constant on screen although the label is
 *   scaled: they are `calc(var(--k) * Npx)` with `--k` = 1/scale, written
 *   only when its log-quantised value changes.
 *
 * Sizing (NamePass shaders, render-settings `name`): a NameEntry `size`
 * becomes an em of `nameSize * nameScale` tiles and a line height of 36/48 of
 * that (MSDF atlas base / size). The on-screen tiles→px factor at the label
 * is measured by projecting a point one tile east: the camera never yaws, so
 * world X stays parallel to the screen and the difference is exactly
 * focalPx / depth — tilted / distant labels shrink naturally.
 *
 * Close-up cap (lot 3): from NAME_CLOSE_ZOOM[0] (4 CSS px per tile) to
 * NAME_CLOSE_ZOOM[1] (6) the labels blend towards a capped line height
 * (`nameCapPx`: 4.5% of the canvas height, 26-52 px) and an opacity of
 * NAME_CLOSE_ALPHA, so close up they no longer hide the models and the
 * mushroom clouds; gold popups get the same treatment (POPUP_CAP_EM_PX).
 * At or below 4 px per tile the sizes, opacity and DOM writes are exactly
 * as before. The whole label (name, troops, flag, status row, crown) is
 * one scaled element, so its parts keep their proportions.
 */

import { renderTroops } from "@openfront/engine-lib/Format";
import { assetUrl } from "@openfront/shared/AssetUrls";
import statusAtlasMeta from "resources/atlases/status-atlas-meta.json";
import type { AttackTroopLabel } from "../gl/passes/WorldTextPass";
import {
  PlayerTypeEnum,
  type BonusEvent,
  type ConquestFx,
  type NameEntry,
  type PlayerState,
  type PlayerStatic,
  type PlayerStatusData,
} from "../types";
import { nightModeOf } from "./NightLights";
import type { FrameInfo, ProjectFn, ThreeLayerContext } from "./types";

// ---------------------------------------------------------------------------
// Constants (mirroring render-settings.json `name` / `bonusPopup` and the
// NamePass / WorldTextPass shaders)
// ---------------------------------------------------------------------------

/** Exponential lerp speed of name position / size (1/s). */
export const NAME_LERP_SPEED = 10;
const NAME_SCALE_FACTOR = 0.4;
const NAME_SCALE_CAP = 3;
const TROOP_SIZE_MULTIPLIER = 0.6;
/** MSDF atlas: em = 48 atlas px, line (base) = 36 atlas px. */
export const LINE_PER_EM = 36 / 48;
/**
 * Name cull: hidden when its line height in device px is below this
 * fraction of the canvas width in device px (NDC threshold 0.008 / 2).
 * Both sides scale with the DPR, so it is compared in CSS px.
 */
export const NAME_CULL_FRACTION = 0.004;
export const TROOP_REFRESH_MS = 500;
/** Troop refresh stagger: (index % 5) × 100 ms. */
const TROOP_STAGGER_SLOTS = 5;
const TROOP_STAGGER_MS = 100;
const NAME_SHADE_NATION = 0.3;
/** Opacity of disconnected players' labels (`.ofn-dim`). */
const DIM_ALPHA = 0.55;
const NAME_SHADE_BOT = 0.4;
/** Visible outline of names, screen px (a centred stroke is twice that). */
const NAME_OUTLINE_PX = 1.4;
const HOVER_GLOW_PX = 5;
/** Labels float this far (tiles) above the surface. */
const LABEL_LIFT = 0.5;

/** Design em of names / popups, CSS px, before the per-frame scale. */
const BASE_EM_PX = 32;
const BASE_LINE_PX = BASE_EM_PX * LINE_PER_EM;
const TROOP_OFFSET_PX = BASE_LINE_PX * 1.1;
const FLAG_H_PX = BASE_LINE_PX * 1.2;
const FLAG_W_PX = (FLAG_H_PX * 128) / 85;
const ICON_PX = BASE_LINE_PX * 1.1;
const STATUS_TOP_PX = -BASE_LINE_PX * 1.4;
const VERIFIED_PX = BASE_LINE_PX * 0.55;

/** Attack troop labels: constant 17 CSS px em, 1.2 px dark outline. */
const ATTACK_LABEL_EM_PX = 17;

const CONQUEST_LIFETIME_MS = 2500;
const CONQUEST_Y_OFFSET = 8;
const POPUP_EM_TILES = 6;
const BONUS_LIFETIME_MS = 1500;
const BONUS_RISE_TILES_PER_S = 3;
const BONUS_Y_OFFSET = -3;
const POPUP_OUTLINE_PX = 2;
/** World text is skipped below this zoom (device px per tile). */
const POPUP_CULL_ZOOM = 0.3;
/** Popups never get smaller than this em (CSS px) — readability floor. */
const POPUP_MIN_EM_PX = 10;
export const MAX_POPUPS = 48;

/** Steps per octave of the `--k` quantisation (~6% steps). */
const K_STEPS_PER_OCTAVE = 12;

/**
 * Close-up cap (lot 3). Names are world-sized like the default renderer's,
 * so close up (tilted view) a big nation's label grew to hundreds of px
 * and hid the models and the mushroom clouds. Across this zoom range (CSS px
 * per tile at the screen centre) the labels blend towards a capped
 * on-screen size and a lower opacity; at or below its start nothing changes
 * (the strategic read is identical).
 */
export const NAME_CLOSE_ZOOM: readonly [number, number] = [4, 6];
/** Capped line height = this fraction of the canvas height (CSS px)... */
export const NAME_CAP_FRACTION = 0.045;
/** ...within these bounds (CSS px). */
export const NAME_CAP_MIN_PX = 26;
export const NAME_CAP_MAX_PX = 52;
/** Opacity of names once fully in the close-up range (not when hovered). */
export const NAME_CLOSE_ALPHA = 0.72;
/** Close up, gold popups keep at most this em (CSS px). */
export const POPUP_CAP_EM_PX = 34;
/** Opacity steps written to the DOM (1/100). */
const ALPHA_STEPS = 100;

// Status flags (bit mask) in NamePass's icon order.
export const STATUS_CROWN = 1 << 0;
export const STATUS_TRAITOR = 1 << 1;
export const STATUS_DISCONNECTED = 1 << 2;
export const STATUS_ALLIANCE = 1 << 3;
export const STATUS_ALLIANCE_REQ = 1 << 4;
export const STATUS_TARGET = 1 << 5;
export const STATUS_EMBARGO = 1 << 6;
export const STATUS_NUKE = 1 << 7;
export const STATUS_NUKE_TARGETS_ME = 1 << 8;
export const STATUS_DOOMSDAY = 1 << 9;

/** Status-atlas cell indices (resources/atlases/status-atlas-meta.json). */
const ICON = statusAtlasMeta.icons;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Em of a name in world tiles for a NameEntry `size` (NamePass sizing:
 * `nameSize * nameScale`, see name.vert.glsl).
 */
export function nameEmTiles(size: number): number {
  const baseSize = Math.max(1, Math.floor(size));
  const nameSize = Math.max(4, Math.floor(baseSize * NAME_SCALE_FACTOR));
  const nameScale = Math.min(baseSize * 0.25, NAME_SCALE_CAP);
  return nameSize * nameScale;
}

/** Line height of a name in world tiles (`36 * nameWorldScale`). */
export function nameLineHeightTiles(size: number): number {
  return nameEmTiles(size) * LINE_PER_EM;
}

/**
 * The line height (CSS px) a name is drawn at, or 0 when culled. Below the
 * cull threshold a targeted name is boosted to exactly the threshold and the
 * hovered owner keeps its size; everything else hides.
 */
export function shownNameLineHeightPx(
  lineHeightPx: number,
  cssWidth: number,
  targeted: boolean,
  hovered: boolean,
): number {
  if (!(lineHeightPx > 0)) return 0;
  const threshold = NAME_CULL_FRACTION * cssWidth;
  if (lineHeightPx >= threshold) return lineHeightPx;
  if (targeted) return threshold;
  if (hovered) return lineHeightPx;
  return 0;
}

/**
 * Weight of the close-up treatment at a zoom (CSS px per tile at the screen
 * centre): 0 up to NAME_CLOSE_ZOOM[0], smoothstep to 1 at NAME_CLOSE_ZOOM[1].
 */
export function nameCloseUpWeight(cssPxPerTile: number): number {
  const [z0, z1] = NAME_CLOSE_ZOOM;
  if (!(cssPxPerTile > z0)) return 0;
  const t = Math.min(1, (cssPxPerTile - z0) / (z1 - z0));
  return t * t * (3 - 2 * t);
}

/** Largest line height (CSS px) of a fully capped name on this canvas. */
export function nameCapPx(cssHeight: number): number {
  const v = NAME_CAP_FRACTION * (cssHeight > 0 ? cssHeight : 0);
  return Math.min(NAME_CAP_MAX_PX, Math.max(NAME_CAP_MIN_PX, v));
}

/**
 * Line height (CSS px) a name is drawn at once the close-up cap applies:
 * `lineHeightPx` unchanged at weight 0 or when it is already under the
 * cap, else blended towards the cap by the weight. Never larger than the
 * world-sized line, so a label only shrinks.
 */
export function closeUpLineHeightPx(
  lineHeightPx: number,
  cssPxPerTile: number,
  cssHeight: number,
): number {
  const k = nameCloseUpWeight(cssPxPerTile);
  if (k <= 0) return lineHeightPx;
  const cap = nameCapPx(cssHeight);
  if (!(lineHeightPx > cap)) return lineHeightPx;
  return lineHeightPx + (cap - lineHeightPx) * k;
}

/** Opacity of names at a zoom (1 for the hovered owner). */
export function closeUpNameAlpha(
  cssPxPerTile: number,
  hovered: boolean,
): number {
  if (hovered) return 1;
  return 1 - (1 - NAME_CLOSE_ALPHA) * nameCloseUpWeight(cssPxPerTile);
}

/** Popup em (CSS px) after the close-up cap, same weight as the names. */
export function closeUpPopupEmPx(emPx: number, cssPxPerTile: number): number {
  const k = nameCloseUpWeight(cssPxPerTile);
  if (k <= 0 || !(emPx > POPUP_CAP_EM_PX)) return emPx;
  return emPx + (POPUP_CAP_EM_PX - emPx) * k;
}

/** Frame-rate independent exponential approach factor, t = 1 - e^(-k·dt). */
export function lerpFactor(dtMs: number, speed: number = NAME_LERP_SPEED) {
  return 1 - Math.exp((-speed * Math.max(0, dtMs)) / 1000);
}

/**
 * Troop-text refresh bucket: the text is re-rendered when this changes, every
 * 500 ms per label, staggered by (index % 5) × 100 ms across labels.
 */
export function troopRefreshBucket(nowMs: number, index: number): number {
  return Math.floor(
    (nowMs + (index % TROOP_STAGGER_SLOTS) * TROOP_STAGGER_MS) /
      TROOP_REFRESH_MS,
  );
}

/** Gold popup text, same as WorldTextPass's `formatGold`. */
export function formatPopupGold(gold: number): string {
  if (gold >= 1_000_000) return (gold / 1_000_000).toFixed(1) + "M";
  if (gold >= 1_000) return (gold / 1_000).toFixed(1) + "K";
  return gold.toString();
}

/** Conquest popup text: "+ 1.2K". */
export function conquestPopupText(gold: number): string {
  return "+ " + formatPopupGold(gold);
}

/** Bonus popup text: "+ 45.0K" / "- 3" (WorldTextPass.applyBonusEvents). */
export function bonusPopupText(gold: number): string {
  return (gold >= 0 ? "+" : "-") + " " + formatPopupGold(Math.abs(gold));
}

/** Linear fade 1 → 0 over the popup's life. */
export function popupAlpha(elapsedMs: number, lifetimeMs: number): number {
  if (!(lifetimeMs > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - elapsedMs / lifetimeMs));
}

/** Log-quantise a positive value to `stepsPerOctave` steps per doubling. */
export function quantizeLog2(v: number, stepsPerOctave: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  return Math.pow(
    2,
    Math.round(Math.log2(v) * stepsPerOctave) / stepsPerOctave,
  );
}

/** Status bit mask of a player (0 when there is no status data). */
export function statusMask(sd: PlayerStatusData | undefined): number {
  if (!sd) return 0;
  let m = 0;
  if (sd.crown) m |= STATUS_CROWN;
  if (sd.traitor) m |= STATUS_TRAITOR;
  if (sd.disconnected) m |= STATUS_DISCONNECTED;
  if (sd.alliance) m |= STATUS_ALLIANCE;
  if (sd.allianceReq) m |= STATUS_ALLIANCE_REQ;
  if (sd.target) m |= STATUS_TARGET;
  if (sd.embargo) m |= STATUS_EMBARGO;
  if (sd.nukeActive) m |= STATUS_NUKE;
  if (sd.nukeTargetsMe) m |= STATUS_NUKE_TARGETS_ME;
  if (sd.inDoomsdayClock) m |= STATUS_DOOMSDAY;
  return m;
}

/**
 * Status-atlas icon indices to show for a mask, in NamePass's row order
 * (crown, traitor, disconnected, alliance, alliance request, target,
 * embargo, nuke — red when it targets the local player — doomsday skull).
 */
export function statusIconIndices(mask: number): number[] {
  const out: number[] = [];
  if (mask & STATUS_CROWN) out.push(ICON.crown);
  if (mask & STATUS_TRAITOR) out.push(ICON.traitor);
  if (mask & STATUS_DISCONNECTED) out.push(ICON.disconnected);
  if (mask & STATUS_ALLIANCE) out.push(ICON.alliance);
  if (mask & STATUS_ALLIANCE_REQ) out.push(ICON.allianceRequest);
  if (mask & STATUS_TARGET) out.push(ICON.target);
  if (mask & STATUS_EMBARGO) out.push(ICON.embargo);
  if (mask & STATUS_NUKE) {
    out.push(mask & STATUS_NUKE_TARGETS_ME ? ICON.nukeRed : ICON.nukeWhite);
  }
  if (mask & STATUS_DOOMSDAY) out.push(ICON.doomsdayClock);
  return out;
}

/**
 * CSS background size / position showing status-atlas cell `index` (its
 * padded inner square) in a `px`-sized box.
 */
export function statusSpriteCss(
  index: number,
  px: number,
): { size: string; position: string } {
  const m = statusAtlasMeta;
  const inner = m.cellSize - 2 * m.pad;
  const k = px / inner;
  const col = index % m.cols;
  const row = Math.floor(index / m.cols);
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    size: `${r(m.width * k)}px ${r(m.height * k)}px`,
    position: `${r(-(col * m.cellSize + m.pad) * k)}px ${r(-(row * m.cellSize + m.pad) * k)}px`,
  };
}

/** Grey level of the name fill: humans black, nations / bots grey. */
export function nameShade(playerType: PlayerTypeEnum): number {
  if (playerType === PlayerTypeEnum.Nation) return NAME_SHADE_NATION;
  if (playerType === PlayerTypeEnum.Bot) return NAME_SHADE_BOT;
  return 0;
}

/** CSS rgb() of a 0..1 colour. */
export function cssRgb(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.round(Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 255);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

/** First broadcast emoji of a player (what NamePass shows), or "". */
export function broadcastEmoji(ps: PlayerState | undefined): string {
  const emojis = ps?.outgoingEmojis;
  if (!emojis) return "";
  for (const e of emojis) {
    if (e.recipientID === "AllPlayers") return e.message;
  }
  return "";
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Styles and font
// ---------------------------------------------------------------------------

/** Label font stack (Overpass bold, as the default renderer's MSDF font). */
export const LABEL_FONT_FAMILY = `Overpass, "Helvetica Neue", Arial, sans-serif`;
const FONT_FAMILY = LABEL_FONT_FAMILY;
let fontRequested = false;

/** Register and start loading the Overpass bold face once per page. */
export function ensureOverpassFont(): void {
  if (fontRequested) return;
  fontRequested = true;
  try {
    if (typeof FontFace === "undefined" || !document.fonts) return;
    const face = new FontFace(
      "Overpass",
      `url(${assetUrl("fonts/overpass-bold.woff")})`,
      { weight: "700" },
    );
    document.fonts.add(face);
    face.load().catch(() => {});
  } catch {
    // Fallback fonts are fine.
  }
}

/**
 * Lot 4, night (`?three_night=1` only; the class is never set otherwise):
 * the names' dark grey text loses its contrast on the moonlit map, so it
 * turns light with a dark outline (the inline per-label colours are
 * overridden; traitors stay red, lighter).
 */
export const NIGHT_NAME_CSS = `
.ofn-night .ofn-label{color:#e8e8e8 !important;
  -webkit-text-stroke-color:rgba(10,12,18,.9) !important;}
.ofn-night .ofn-traitor .ofn-name,.ofn-night .ofn-traitor .ofn-troops{color:#ff8a80 !important;}
`;

function layerCss(): string {
  const icon = ICON_PX.toFixed(2);
  return `
.ofn-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.ofn-label,.ofn-world-text{position:absolute;left:0;top:0;transform-origin:0 0;
  font-family:${FONT_FAMILY};font-weight:700;white-space:pre;pointer-events:none;
  paint-order:stroke fill;user-select:none;}
.ofn-label{width:0;height:0;font-size:${BASE_EM_PX}px;color:#000;
  -webkit-text-stroke-width:calc(var(--k,1) * ${2 * NAME_OUTLINE_PX}px);
  -webkit-text-stroke-color:#000;}
.ofn-name{position:absolute;left:0;top:0;transform:translate(-50%,-50%);
  line-height:${BASE_LINE_PX}px;}
.ofn-troops{position:absolute;left:0;top:${TROOP_OFFSET_PX.toFixed(2)}px;
  transform:translate(-50%,-50%);font-size:${(BASE_EM_PX * TROOP_SIZE_MULTIPLIER).toFixed(2)}px;
  line-height:${(BASE_LINE_PX * TROOP_SIZE_MULTIPLIER).toFixed(2)}px;}
.ofn-flag{position:absolute;right:100%;top:50%;margin-right:${(BASE_EM_PX * 0.08).toFixed(2)}px;
  width:${FLAG_W_PX.toFixed(2)}px;height:${FLAG_H_PX.toFixed(2)}px;
  transform:translateY(-50%);object-fit:contain;}
.ofn-verified{position:absolute;left:calc(100% - ${(BASE_LINE_PX * 0.04).toFixed(2)}px);
  top:${(-VERIFIED_PX * 0.5).toFixed(2)}px;width:${VERIFIED_PX.toFixed(2)}px;
  height:${VERIFIED_PX.toFixed(2)}px;background-repeat:no-repeat;}
.ofn-status{position:absolute;left:0;top:${STATUS_TOP_PX.toFixed(2)}px;
  transform:translateX(-50%);display:flex;align-items:center;
  gap:${(ICON_PX * 0.15).toFixed(2)}px;height:${icon}px;}
.ofn-icon{flex:none;width:${icon}px;height:${icon}px;background-repeat:no-repeat;
  filter:drop-shadow(0 0 1.5px rgba(0,0,0,.8));}
.ofn-crown{flex:none;width:${icon}px;height:${icon}px;object-fit:contain;}
.ofn-emoji{flex:none;font-size:${(ICON_PX * 0.9).toFixed(2)}px;line-height:${icon}px;
  -webkit-text-stroke-width:0;}
.ofn-traitor .ofn-name,.ofn-traitor .ofn-troops{color:#8a1010;}
.ofn-dim{opacity:${DIM_ALPHA};}
.ofn-hover{text-shadow:0 0 calc(var(--k,1) * ${HOVER_GLOW_PX}px) rgba(255,255,255,.75),
  0 0 calc(var(--k,1) * 2px) rgba(255,255,255,.9);}
.ofn-world-text{color:#fff;-webkit-text-stroke-color:rgba(0,0,0,.9);
  text-shadow:0 0 calc(var(--k,1) * 3px) rgba(0,0,0,.6);display:none;}
.ofn-attack{font-size:${ATTACK_LABEL_EM_PX}px;line-height:1;
  -webkit-text-stroke-width:${(2 * 1.2).toFixed(1)}px;}
.ofn-popup{font-size:${BASE_EM_PX}px;line-height:1;
  -webkit-text-stroke-width:calc(var(--k,1) * ${2 * POPUP_OUTLINE_PX}px);}
`;
}

// ---------------------------------------------------------------------------
// Pooled element records
// ---------------------------------------------------------------------------

interface LabelDom {
  root: HTMLDivElement;
  name: HTMLDivElement;
  nameText: Text;
  flag: HTMLImageElement | null;
  verified: HTMLSpanElement | null;
  troops: HTMLDivElement;
  status: HTMLDivElement;
}

interface NameLabel {
  id: string;
  static: PlayerStatic;
  /** Insertion order (troop refresh stagger). */
  index: number;
  dom: LabelDom | null;
  /** Present in the latest `names` map with size > 0. */
  present: boolean;
  alive: boolean;
  tgtX: number;
  tgtY: number;
  tgtSize: number;
  curX: number;
  curY: number;
  curSize: number;
  snapPending: boolean;
  status: number;
  emoji: string;
  // DOM state already written (dirty tracking).
  shown: boolean;
  staticDirty: boolean;
  statusDirty: boolean;
  colorKey: string;
  troopBucket: number;
  troopText: string | null;
  lastTransform: string;
  lastK: number;
  /** Inline opacity written (close-up fade; "" = none, the CSS decides). */
  lastOpacity: string;
  classKey: string;
}

interface WorldTextEl {
  el: HTMLDivElement;
  text: string;
  color: string;
  transform: string;
  opacity: string;
  k: number;
  shown: boolean;
}

interface Popup {
  view: WorldTextEl;
  x: number;
  y: number;
  text: string;
  startMs: number;
  lifetimeMs: number;
  /** Screen rise speed in tiles/s (converted with the local px/tile). */
  rise: number;
}

function createWorldText(parent: HTMLElement, cls: string): WorldTextEl {
  const el = document.createElement("div");
  el.className = `ofn-world-text ${cls}`;
  parent.appendChild(el);
  return {
    el,
    text: "",
    color: "",
    transform: "",
    opacity: "",
    k: 0,
    shown: false,
  };
}

function setShown(view: { el: HTMLElement; shown: boolean }, on: boolean) {
  if (view.shown === on) return;
  view.shown = on;
  view.el.style.display = on ? "block" : "none";
}

// ---------------------------------------------------------------------------
// NameLayer
// ---------------------------------------------------------------------------

export class NameLayer {
  private readonly container: HTMLDivElement;
  private readonly namesRoot: HTMLDivElement;
  private readonly worldRoot: HTMLDivElement;

  private readonly labels = new Map<string, NameLabel>();
  private players: ReadonlyMap<number, PlayerState> = new Map();
  private namesHidden = false;
  private paletteVersion = -1;
  private localPlayerID = 0;

  private attackLabels: AttackTroopLabel[] = [];
  private readonly attackViews: WorldTextEl[] = [];

  private readonly popups: Popup[] = [];
  private readonly freePopupViews: WorldTextEl[] = [];

  constructor(private readonly ctx: ThreeLayerContext) {
    ensureOverpassFont();
    this.container = document.createElement("div");
    this.container.className = "ofn-layer";
    this.container.dataset.layer = "names";
    const style = document.createElement("style");
    style.textContent = layerCss();
    // Lot 4, night (`?three_night=1` only): light names on the dark map.
    if (nightModeOf(ctx.settings) !== null) {
      style.textContent += NIGHT_NAME_CSS;
      this.container.classList.add("ofn-night");
    }
    this.container.appendChild(style);
    this.namesRoot = document.createElement("div");
    this.namesRoot.className = "ofn-layer";
    this.worldRoot = document.createElement("div");
    this.worldRoot.className = "ofn-layer";
    // World text draws over the names, as in the 2D renderer.
    this.container.append(this.namesRoot, this.worldRoot);
    ctx.overlayRoot.appendChild(this.container);
  }

  // ---- Data input ----

  /** Upsert player statics by id (new players and cosmetics changes). */
  addPlayers(players: PlayerStatic[]): void {
    for (const p of players) {
      const label = this.labels.get(p.id);
      if (label) {
        label.static = p;
        label.staticDirty = true;
        label.statusDirty = true;
        label.colorKey = "";
        continue;
      }
      this.labels.set(p.id, {
        id: p.id,
        static: p,
        index: this.labels.size,
        dom: null,
        present: false,
        alive: false,
        tgtX: 0,
        tgtY: 0,
        tgtSize: 0,
        curX: 0,
        curY: 0,
        curSize: 0,
        snapPending: true,
        status: 0,
        emoji: "",
        shown: false,
        staticDirty: true,
        statusDirty: true,
        colorKey: "",
        troopBucket: -1,
        troopText: null,
        lastTransform: "",
        lastK: 0,
        lastOpacity: "",
        classKey: "",
      });
    }
  }

  /** Anonymous-names toggle: replace display names by player id. */
  refreshNames(displayNames: Map<string, string>): void {
    for (const [id, displayName] of displayNames) {
      const label = this.labels.get(id);
      if (!label || label.static.displayName === displayName) continue;
      label.static = { ...label.static, displayName };
      label.staticDirty = true;
    }
  }

  updateNames(
    names: ReadonlyMap<string, NameEntry>,
    players: ReadonlyMap<number, PlayerState>,
    snap: boolean,
    status?: ReadonlyMap<number, PlayerStatusData>,
  ): void {
    this.players = players;
    for (const label of this.labels.values()) {
      const entry = names.get(label.id);
      const sid = label.static.smallID;
      const ps = players.get(sid);
      label.alive = ps?.isAlive ?? false;
      if (!entry || !(entry.size > 0)) {
        label.present = false;
        continue;
      }
      label.present = true;
      if (snap || label.curSize === 0) label.snapPending = true;
      label.tgtX = entry.x;
      label.tgtY = entry.y;
      label.tgtSize = entry.size;

      const mask = statusMask(status?.get(sid));
      const emoji = broadcastEmoji(ps);
      if (mask !== label.status || emoji !== label.emoji) {
        label.status = mask;
        label.emoji = emoji;
        label.statusDirty = true;
      }
    }
  }

  /** Full list each frame (positions already interpolated by the controller). */
  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.attackLabels = labels;
  }

  showConquest(events: ConquestFx[]): void {
    const now = performance.now();
    const msPerTick = this.ctx.config.msPerTick();
    for (const e of events) {
      const startMs = now - (e.tickAge ?? 0) * msPerTick;
      if (now - startMs >= CONQUEST_LIFETIME_MS) continue;
      this.addPopup(
        e.x + 0.5,
        e.y + CONQUEST_Y_OFFSET + 0.5,
        conquestPopupText(e.gold),
        startMs,
        CONQUEST_LIFETIME_MS,
        0,
      );
    }
  }

  showBonus(events: BonusEvent[]): void {
    const now = performance.now();
    const W = this.ctx.mapWidth;
    for (const e of events) {
      if (e.gold === 0) continue;
      if (this.localPlayerID > 0 && e.smallID !== this.localPlayerID) continue;
      const x = e.tile % W;
      const y = (e.tile - x) / W;
      this.addPopup(
        x + 0.5,
        y + BONUS_Y_OFFSET + 0.5,
        bonusPopupText(e.gold),
        now,
        BONUS_LIFETIME_MS,
        BONUS_RISE_TILES_PER_S,
      );
    }
  }

  // ---- Per frame ----

  update(frame: FrameInfo, project: ProjectFn): void {
    this.localPlayerID = frame.localPlayerID;
    if (frame.altView !== this.namesHidden) {
      this.namesHidden = frame.altView;
      this.namesRoot.style.display = frame.altView ? "none" : "";
    }
    if (!frame.altView) this.updateLabels(frame, project);
    this.updateAttackLabels(frame, project);
    this.updatePopups(frame, project);
  }

  dispose(): void {
    this.container.remove();
    this.labels.clear();
    this.attackViews.length = 0;
    this.popups.length = 0;
    this.freePopupViews.length = 0;
    this.attackLabels = [];
  }

  // ---- Names ----

  private updateLabels(frame: FrameInfo, project: ProjectFn): void {
    const hf = this.ctx.heightField;
    const t = lerpFactor(frame.dtMs);
    const paletteVersion = this.ctx.palette.version;
    const paletteChanged = paletteVersion !== this.paletteVersion;
    this.paletteVersion = paletteVersion;

    for (const label of this.labels.values()) {
      if (paletteChanged) label.colorKey = "";
      if (!label.present || !label.alive || !(label.tgtSize > 0)) {
        this.hideLabel(label);
        continue;
      }
      if (label.snapPending) {
        label.snapPending = false;
        label.curX = label.tgtX;
        label.curY = label.tgtY;
        label.curSize = label.tgtSize;
      } else {
        label.curX += (label.tgtX - label.curX) * t;
        label.curY += (label.tgtY - label.curY) * t;
        label.curSize += (label.tgtSize - label.curSize) * t;
      }

      const wx = label.curX;
      const wy = label.curY;
      const wh = hf.surfaceAt(wx, wy) + LABEL_LIFT;
      const p = project(wx, wy, wh);
      if (!p.visible) {
        this.hideLabel(label);
        continue;
      }
      const pxPerTile = project(wx + 1, wy, wh).x - p.x;
      const hovered =
        frame.highlightOwner > 0 &&
        frame.highlightOwner === label.static.smallID;
      const shownH = shownNameLineHeightPx(
        nameLineHeightTiles(label.curSize) * pxPerTile,
        frame.cssWidth,
        (label.status & STATUS_TARGET) !== 0,
        hovered,
      );
      if (shownH <= 0) {
        this.hideLabel(label);
        continue;
      }
      // Close up: capped on screen and faded a little (whole label: name,
      // troops, flag, status row and crown scale together).
      const lineH = closeUpLineHeightPx(
        shownH,
        frame.cssPxPerTile,
        frame.cssHeight,
      );

      const dom = label.dom ?? this.createLabelDom(label);
      if (label.staticDirty) this.applyStatic(label, dom);
      if (label.statusDirty) this.applyStatus(label, dom);
      if (label.colorKey === "") this.applyOutlineColor(label, dom);
      this.applyClasses(label, dom, hovered);
      this.refreshTroops(label, dom, frame.nowMs);

      const scale = lineH / BASE_LINE_PX;
      const transform = `translate3d(${round1(p.x)}px,${round1(p.y)}px,0) scale(${scale.toFixed(4)})`;
      if (transform !== label.lastTransform) {
        label.lastTransform = transform;
        dom.root.style.transform = transform;
      }
      const k = quantizeLog2(1 / scale, K_STEPS_PER_OCTAVE);
      if (k !== label.lastK) {
        label.lastK = k;
        dom.root.style.setProperty("--k", k.toFixed(4));
      }
      this.applyOpacity(label, dom, frame.cssPxPerTile, hovered);
      if (!label.shown) {
        label.shown = true;
        dom.root.style.display = "block";
      }
    }
  }

  /**
   * Close-up fade: an inline opacity only while it is below 1, so the
   * strategic zooms keep the CSS as before (`.ofn-dim` for disconnected
   * players, which the fade multiplies).
   */
  private applyOpacity(
    label: NameLabel,
    dom: LabelDom,
    cssPxPerTile: number,
    hovered: boolean,
  ): void {
    const a = closeUpNameAlpha(cssPxPerTile, hovered);
    let opacity = "";
    if (a < 1) {
      const dim = (label.status & STATUS_DISCONNECTED) !== 0 ? DIM_ALPHA : 1;
      opacity = (Math.round(a * dim * ALPHA_STEPS) / ALPHA_STEPS).toString();
    }
    if (opacity === label.lastOpacity) return;
    label.lastOpacity = opacity;
    dom.root.style.opacity = opacity;
  }

  private hideLabel(label: NameLabel): void {
    if (!label.shown || !label.dom) return;
    label.shown = false;
    label.dom.root.style.display = "none";
  }

  private createLabelDom(label: NameLabel): LabelDom {
    const root = document.createElement("div");
    root.className = "ofn-label";
    root.style.display = "none";
    const name = document.createElement("div");
    name.className = "ofn-name";
    const nameText = document.createTextNode("");
    name.appendChild(nameText);
    const troops = document.createElement("div");
    troops.className = "ofn-troops";
    const status = document.createElement("div");
    status.className = "ofn-status";
    root.append(status, name, troops);
    this.namesRoot.appendChild(root);
    const dom: LabelDom = {
      root,
      name,
      nameText,
      flag: null,
      verified: null,
      troops,
      status,
    };
    label.dom = dom;
    label.shown = false;
    label.staticDirty = true;
    label.statusDirty = true;
    label.colorKey = "";
    return dom;
  }

  /** Name text, fill shade, flag and verified badge from PlayerStatic. */
  private applyStatic(label: NameLabel, dom: LabelDom): void {
    label.staticDirty = false;
    const p = label.static;
    if (dom.nameText.data !== p.displayName) dom.nameText.data = p.displayName;
    const shade = nameShade(p.playerType);
    dom.root.style.color = cssRgb(shade, shade, shade);

    if (p.flag) {
      if (!dom.flag) {
        const img = document.createElement("img");
        img.className = "ofn-flag";
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        dom.name.appendChild(img);
        dom.flag = img;
      }
      if (dom.flag.getAttribute("src") !== p.flag) dom.flag.src = p.flag;
    } else if (dom.flag) {
      dom.flag.remove();
      dom.flag = null;
    }

    if (p.verified === true) {
      if (!dom.verified) {
        const badge = document.createElement("span");
        badge.className = "ofn-verified";
        const css = statusSpriteCss(ICON.verified, VERIFIED_PX);
        badge.style.backgroundImage = `url(${statusAtlasUrl()})`;
        badge.style.backgroundSize = css.size;
        badge.style.backgroundPosition = css.position;
        dom.name.appendChild(badge);
        dom.verified = badge;
      }
    } else if (dom.verified) {
      dom.verified.remove();
      dom.verified = null;
    }
  }

  /** Rebuild the status row (rare: only when the mask / emoji changes). */
  private applyStatus(label: NameLabel, dom: LabelDom): void {
    label.statusDirty = false;
    const children: HTMLElement[] = [];
    const crownUrl = label.static.crown;
    for (const index of statusIconIndices(label.status)) {
      if (index === ICON.crown && crownUrl) {
        // A crown cosmetic skins the first-place crown.
        const img = document.createElement("img");
        img.className = "ofn-crown";
        img.alt = "";
        img.decoding = "async";
        img.src = crownUrl;
        children.push(img);
        continue;
      }
      const icon = document.createElement("span");
      icon.className = "ofn-icon";
      const css = statusSpriteCss(index, ICON_PX);
      icon.style.backgroundImage = `url(${statusAtlasUrl()})`;
      icon.style.backgroundSize = css.size;
      icon.style.backgroundPosition = css.position;
      children.push(icon);
    }
    if (label.emoji) {
      const emoji = document.createElement("span");
      emoji.className = "ofn-emoji";
      emoji.textContent = label.emoji;
      children.push(emoji);
    }
    dom.status.replaceChildren(...children);
  }

  /** Outline = the owner's territory colour (palette row 0). */
  private applyOutlineColor(label: NameLabel, dom: LabelDom): void {
    const [r, g, b] = this.ctx.palette.fill(label.static.smallID);
    const color =
      r + g + b > 0 ? cssRgb(r, g, b) : (label.static.color ?? "#000");
    label.colorKey = color;
    dom.root.style.setProperty("-webkit-text-stroke-color", color);
  }

  private applyClasses(label: NameLabel, dom: LabelDom, hovered: boolean) {
    const traitor = (label.status & STATUS_TRAITOR) !== 0;
    const dim = (label.status & STATUS_DISCONNECTED) !== 0;
    const key = `${hovered ? 1 : 0}${traitor ? 1 : 0}${dim ? 1 : 0}`;
    if (key === label.classKey) return;
    label.classKey = key;
    const cl = dom.root.classList;
    cl.toggle("ofn-hover", hovered);
    cl.toggle("ofn-traitor", traitor);
    cl.toggle("ofn-dim", dim);
  }

  private refreshTroops(label: NameLabel, dom: LabelDom, nowMs: number) {
    const bucket = troopRefreshBucket(nowMs, label.index);
    if (bucket === label.troopBucket && label.troopText !== null) return;
    label.troopBucket = bucket;
    const troops = this.players.get(label.static.smallID)?.troops ?? 0;
    const text = renderTroops(troops);
    if (text !== label.troopText) {
      label.troopText = text;
      dom.troops.textContent = text;
    }
  }

  // ---- World text ----

  private updateAttackLabels(frame: FrameInfo, project: ProjectFn): void {
    const hf = this.ctx.heightField;
    const labels = this.attackLabels;
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      let view = this.attackViews[i];
      if (!view) {
        view = createWorldText(this.worldRoot, "ofn-attack");
        this.attackViews.push(view);
      }
      const wx = l.x + 0.5;
      const wy = l.y + 0.5;
      const p = project(wx, wy, hf.surfaceAt(wx, wy) + LABEL_LIFT);
      if (!p.visible) {
        setShown(view, false);
        continue;
      }
      if (view.text !== l.text) {
        view.text = l.text;
        view.el.textContent = l.text;
      }
      const color = cssRgb(l.colorR, l.colorG, l.colorB);
      if (view.color !== color) {
        view.color = color;
        view.el.style.color = color;
      }
      const transform = `translate3d(${round1(p.x)}px,${round1(p.y)}px,0) translate(-50%,-50%)`;
      if (view.transform !== transform) {
        view.transform = transform;
        view.el.style.transform = transform;
      }
      setShown(view, true);
    }
    for (let i = labels.length; i < this.attackViews.length; i++) {
      setShown(this.attackViews[i], false);
    }
  }

  private addPopup(
    x: number,
    y: number,
    text: string,
    startMs: number,
    lifetimeMs: number,
    rise: number,
  ): void {
    if (this.popups.length >= MAX_POPUPS) {
      // Recycle the oldest popup.
      const oldest = this.popups.shift()!;
      setShown(oldest.view, false);
      this.freePopupViews.push(oldest.view);
    }
    const view =
      this.freePopupViews.pop() ?? createWorldText(this.worldRoot, "ofn-popup");
    this.popups.push({ view, x, y, text, startMs, lifetimeMs, rise });
  }

  private updatePopups(frame: FrameInfo, project: ProjectFn): void {
    if (this.popups.length === 0) return;
    const hf = this.ctx.heightField;
    const now = frame.nowMs;
    const dpr = frame.dpr > 0 ? frame.dpr : 1;
    let w = 0;
    for (let i = 0; i < this.popups.length; i++) {
      const popup = this.popups[i];
      const view = popup.view;
      // Events can be stamped a hair after this frame's start: clamp to 0.
      const elapsed = Math.max(0, now - popup.startMs);
      if (elapsed >= popup.lifetimeMs) {
        setShown(view, false);
        this.freePopupViews.push(view);
        continue;
      }
      this.popups[w++] = popup;

      const wh = hf.surfaceAt(popup.x, popup.y) + LABEL_LIFT;
      const p = project(popup.x, popup.y, wh);
      const pxPerTile = p.visible
        ? project(popup.x + 1, popup.y, wh).x - p.x
        : 0;
      const alpha = popupAlpha(elapsed, popup.lifetimeMs);
      if (!p.visible || !(pxPerTile * dpr >= POPUP_CULL_ZOOM) || alpha <= 0) {
        setShown(view, false);
        continue;
      }
      if (view.text !== popup.text) {
        view.text = popup.text;
        view.el.textContent = popup.text;
      }
      const emPx = closeUpPopupEmPx(
        Math.max(POPUP_EM_TILES * pxPerTile, POPUP_MIN_EM_PX),
        frame.cssPxPerTile,
      );
      const scale = emPx / BASE_EM_PX;
      // Rise in screen space so it reads as "up" at any camera tilt.
      const riseY = (elapsed / 1000) * popup.rise * pxPerTile;
      const transform = `translate3d(${round1(p.x)}px,${round1(p.y - riseY)}px,0) scale(${scale.toFixed(4)}) translate(-50%,-50%)`;
      if (view.transform !== transform) {
        view.transform = transform;
        view.el.style.transform = transform;
      }
      const opacity = alpha.toFixed(3);
      if (view.opacity !== opacity) {
        view.opacity = opacity;
        view.el.style.opacity = opacity;
      }
      const k = quantizeLog2(1 / scale, K_STEPS_PER_OCTAVE);
      if (k !== view.k) {
        view.k = k;
        view.el.style.setProperty("--k", k.toFixed(4));
      }
      setShown(view, true);
    }
    this.popups.length = w;
  }
}

function statusAtlasUrl(): string {
  return assetUrl("atlases/status-atlas.png");
}
