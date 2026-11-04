/**
 * TerrainLayer — the relief mesh, with terrain colours, lighting, territory
 * fill, borders, fallout and coastal water, in ONE draw call.
 *
 * Geometry: the HeightField grid (bounded vertex count) plus vertical
 * "skirts" down the four map edges, so a tilted view never looks under the
 * relief. Cells that hold any land tile are kept at or above
 * `COAST_LIFT` (the grid is a low-pass of the tiles, so thin land would
 * otherwise sink under the water plane): coastlines are then decided per
 * tile by the shader, and where the relief rises above sea level over water
 * tiles the shader draws the water surface itself (the same GLSL as
 * WaterLayer, so the two are seamless).
 *
 * Shading (shaders/terrain.ts) works at TILE resolution with texelFetch on:
 * terrain bytes (R8UI, shared with WaterLayer), tile state (R16UI, the live
 * engine buffer referenced directly), the relation matrix (R8UI) and the
 * palette (RGBA32F). Nothing loops over tiles per frame. Close up (a tile
 * over ~3-7 px) the shader switches to a procedural diorama look: organic
 * terrain zones, rock / snow lines and micro detail (`closeUpAmount` and
 * friends in TerrainShading.ts mirror its math); land / water and
 * ownership stay exact per tile.
 *
 * Tile uploads: a tick's changed tiles only mark 16×16-tile cells dirty
 * (`TileUploadQueue`); each frame `update` sends the dirty cells as a few
 * merged rectangles, one `texSubImage2D` each, within a per-frame budget
 * (`TILE_UPLOAD_BUDGET`; the rest waits for the next frames, like the
 * default renderer's drip buckets). A hydrogen bomb's ~31k tiles become one
 * rectangle instead of one call per row. During the spawn phase everything
 * is sent at once, and full uploads (first tick, a new buffer, context
 * restore, more than half the map pending) stay immediate.
 *
 * Contract notes:
 * - `setTiles(tileState, changed)`: `tileState` is the live engine-mirror
 *   buffer, mutated again on the next tick. The texture references it, so a
 *   deferred rectangle always sends current data, and a cell is only marked
 *   clean once a rectangle covering it was sent. `changed === null` = full
 *   upload.
 * - `setSpawnPhase(on)` (from the facade's `updateSpawnOverlay`): while on,
 *   queued tiles are all sent on the next frame, without a budget.
 * - `setTerrainBytes(null, bytes)`: `bytes` is the full-map array (the same
 *   instance as `ctx.heightField.terrain`). With rects, the facade has
 *   ALREADY patched `heightField.terrain` and recomputed the heights
 *   (`heightField.lastDirty` holds the changed vertex range).
 * - `setDefenseCoverage` is a documented no-op (the engine never sets the
 *   tile defense bit, and posts are drawn by StructureLayer).
 *
 * Territory cosmetics (TerritoryCosmetics.ts): patterns (`setPatterns`)
 * and skins (`initSkinAtlas`, `setPlayerSkin`, `setPlayerSpawn`,
 * `setTeamMode`) replace the fill colour per tile in this shader, as the
 * default renderer's territory pass does.
 *
 * Effect trails (EffectTrails.ts, shared with WaterLayer and UnitLayer):
 * boat and nuke trails (`setTrailState`, `applyTrailDelta`) coloured by the
 * effect palette (`setEffectPalette`), painted per tile by this shader on
 * land and by WaterLayer on the sea; this layer sends their uploads each
 * frame (`TRAIL_UPLOAD_BUDGET`) and reports their counters.
 *
 * Surface overlays (SurfaceOverlay.ts): the coordinate grid
 * (`setGridView`, plus the alt view) and the small-player glow
 * (`setSmallPlayerGlow`) are painted by this shader on land and by a
 * sea-level plane on open water; both are off (no draw, a skipped uniform
 * branch) unless shown.
 *
 * The layer is also the `ReliefSurface` overlays drape on: `surfaceAt`
 * interpolates the relief mesh's own triangles (coast lift included),
 * clamped to sea level, so draped geometry matches what is drawn.
 */

import * as THREE from "three";
import type { TerrainRect, UnitState } from "../types";
import { EffectTrails } from "./EffectTrails";
import type { GridRange, HeightField } from "./HeightField";
import { environmentUniforms } from "./SceneEnvironment";
import { TERRAIN_FRAG, TERRAIN_VERT } from "./shaders/terrain";
import { SurfaceOverlay } from "./SurfaceOverlay";
import {
  createIntegerTexture,
  createWaterUniforms,
  refreshWaterUniforms,
  setTextureData,
  TerrainByteTexture,
  TextureRectUploader,
  textureData,
  uploadNow,
  type WaterUniforms,
  waterColorKey,
} from "./TerrainResources";
import {
  COAST_LIFT,
  computeCellLand,
  hexToSrgb01,
  type Rgb,
  vertexTouchesLand,
} from "./TerrainShading";
import { TerritoryCosmetics } from "./TerritoryCosmetics";
import { type TileUploadBudget, TileUploadQueue } from "./TileUploadQueue";
import type { FrameInfo, ReliefSurface, ThreeLayerContext } from "./types";

/** Size of the relation matrix (frame/derive/RelationMatrix.ts). */
const RELATION_SIZE = 1024;
/** Target border width in CSS px (clamped to [MIN_BORDER_TILES, 1] tile). */
const BORDER_CSS_PX = 1.3;
/**
 * Thinnest border, in tiles: zoomed in, borders grow with the zoom (the 2D
 * renderer's are a full tile) so they stay readable on busy relief.
 */
const MIN_BORDER_TILES = 0.2;
/**
 * Border emission (fraction of its colour): borders stay crisp under any
 * shading, and highlighted ones (3x) pass the bloom threshold and glow.
 */
const BORDER_GLOW = 0.25;
/** Skirt bottom, below the deepest seabed. */
const SKIRT_EXTRA_DEPTH = 1;

/**
 * Tile-state uploads per frame outside the spawn phase: at most 8
 * `texSubImage2D` calls and 256k texels (512 KB), but always at least one
 * rectangle. Replaying recorded ticks of a 30-bot World game at 60 FPS,
 * an ordinary tick needs ~27 rectangles (sent within 3-4 frames) and a
 * hydrogen bomb's disc one; the per-row spans used to send ~144 and ~263
 * calls in one frame.
 */
export const TILE_UPLOAD_BUDGET: TileUploadBudget = {
  maxCalls: 8,
  maxTexels: 1 << 18,
};
/** Frames over which the perf counters keep their maxima. */
const PERF_WINDOW = 120;

/** Fallbacks = render-settings.json defaults (sRGB 0..1). */
const DEFAULT_TERRAIN = {
  sand: [204, 203, 158],
  plains: [190, 220, 138],
  highland: [220, 203, 158],
  mountain: [230, 230, 230],
  void: [60, 60, 60],
} as const;

const v3 = (): { value: THREE.Vector3 } => ({ value: new THREE.Vector3() });
const f1 = (value: number): { value: number } => ({ value });

function srgb255(c: readonly [number, number, number]): Rgb {
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

/** Uniforms of the terrain material (besides environment / water / fog). */
function createTerrainUniforms() {
  return {
    uTerrain: { value: null as THREE.Texture | null },
    uTiles: { value: null as THREE.Texture | null },
    uRelations: { value: null as THREE.Texture | null },
    uPalette: { value: null as THREE.Texture | null },
    uMapSize: { value: new THREE.Vector2(1, 1) },
    uRelSize: f1(RELATION_SIZE),
    uTime: f1(0),
    uHeightScale: f1(1),
    uColSand: v3(),
    uColPlains: v3(),
    uColHighland: v3(),
    uColMountain: v3(),
    uColVoid: v3(),
    uFillAlpha: f1(0.588),
    uFillSaturation: f1(0.85),
    uHighlightFill: f1(0.15),
    uHighlightBorder: f1(0.25),
    uEmbargoTint: v3(),
    uEmbargoRatio: f1(0.35),
    uFriendlyTint: v3(),
    uFriendlyRatio: f1(0.35),
    uFalloutColor: v3(),
    uHighlightOwner: f1(0),
    uLocalPlayer: f1(0),
    uAltView: f1(0),
    uAltFillAlpha: f1(0.3),
    uAffSelf: v3(),
    uAffAlly: v3(),
    uAffNeutral: v3(),
    uAffEnemy: v3(),
    uBorderPx: f1(BORDER_CSS_PX),
    uMinBorder: f1(MIN_BORDER_TILES),
    uBorderGlow: f1(BORDER_GLOW),
  };
}
type TerrainUniforms = ReturnType<typeof createTerrainUniforms> & WaterUniforms;

/** One map edge's skirt: which grid vertices it hangs from, and its facing. */
interface SkirtEdge {
  /** Grid vertex index of each skirt column, in edge order. */
  grid: Int32Array;
  /** First skirt vertex (columns are [top, bottom] pairs). */
  base: number;
  nx: number;
  nz: number;
}

export class TerrainLayer implements ReliefSurface {
  private readonly hf: HeightField;
  private readonly W: number;
  private readonly H: number;
  private readonly terrainBytes: TerrainByteTexture;
  private readonly tileTex: THREE.DataTexture;
  /** False until the tile texture got a full upload from us. */
  private tilesUploaded = false;
  /** Dirty tile cells waiting for an upload. */
  private readonly tileQueue: TileUploadQueue;
  private readonly tileUploader: TextureRectUploader;
  /** Spawn phase: queued tiles go out all at once. */
  private spawnPhase = false;
  /** Upload calls / texels since the last frame's flush (perf counters). */
  private callsPending = 0;
  private texelsPending = 0;
  private callsLastFrame = 0;
  private texelsLastFrame = 0;
  private callsTotal = 0;
  private texelsTotal = 0;
  private fullUploads = 0;
  /** Per-frame calls / texels of the last PERF_WINDOW frames (perf only). */
  private readonly recentCalls: Int32Array | null;
  private readonly recentTexels: Int32Array | null;
  private recentIndex = 0;
  private relTex: THREE.DataTexture;
  private relSize = RELATION_SIZE;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly u: TerrainUniforms;
  private waterKey = "";
  /** Coordinate grid + small-player glow (terrain shader + sea plane). */
  private readonly overlay: SurfaceOverlay;
  /** Territory patterns and skins (terrain shader). */
  private readonly cosmetics: TerritoryCosmetics;
  /** Boat / nuke trails and the effect palette (shared, see the header). */
  readonly trails: EffectTrails;

  // Relief geometry (grid vertices first, then skirt [top, bottom] pairs).
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly gridCount: number;
  private readonly skirts: SkirtEdge[] = [];
  private readonly skirtVertexCount: number;
  private readonly skirtBottomY: number;
  private readonly cellsX: number;
  private readonly cellsY: number;
  private readonly cellLand: Uint8Array;
  /** HeightField version the relief geometry was last built from. */
  private reliefVersion = -1;

  constructor(private readonly ctx: ThreeLayerContext) {
    const hf = ctx.heightField;
    this.hf = hf;
    this.W = ctx.mapWidth;
    this.H = ctx.mapHeight;
    this.tileQueue = new TileUploadQueue(this.W, this.H);
    const perf = ctx.settings.perf === true;
    this.recentCalls = perf ? new Int32Array(PERF_WINDOW) : null;
    this.recentTexels = perf ? new Int32Array(PERF_WINDOW) : null;

    // ---- Textures ----
    this.terrainBytes = TerrainByteTexture.acquire(ctx);
    // Placeholder until the first setTiles (lazily zero-filled memory).
    this.tileTex = createIntegerTexture(
      new Uint16Array(this.W * this.H),
      this.W,
      this.H,
      "R16UI",
    );
    this.tileUploader = new TextureRectUploader(this.tileTex);
    this.relTex = createIntegerTexture(
      new Uint8Array(RELATION_SIZE * RELATION_SIZE),
      RELATION_SIZE,
      RELATION_SIZE,
      "R8UI",
    );

    // ---- Geometry ----
    this.cellsX = hf.cols - 1;
    this.cellsY = hf.rows - 1;
    this.cellLand = new Uint8Array(this.cellsX * this.cellsY);
    this.gridCount = hf.cols * hf.rows;
    this.skirtVertexCount = 2 * (2 * hf.cols + 2 * hf.rows);
    this.skirtBottomY = -(hf.seabedDepth + SKIRT_EXTRA_DEPTH);
    const vertexCount = this.gridCount + this.skirtVertexCount;
    this.positions = new Float32Array(vertexCount * 3);
    this.normals = new Float32Array(vertexCount * 3);
    this.buildStaticGeometry();
    this.refreshRelief(null);
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(this.normals, 3),
    );

    // ---- Material ----
    this.u = {
      ...createTerrainUniforms(),
      ...createWaterUniforms(),
    };
    this.u.uTerrain.value = this.terrainBytes.texture;
    this.u.uTiles.value = this.tileTex;
    this.u.uRelations.value = this.relTex;
    this.u.uPalette.value = ctx.palette.texture;
    this.u.uMapSize.value.set(this.W, this.H);
    this.u.uHeightScale.value = hf.heightScale;
    this.refreshColors();
    this.refreshOverlaySettings();
    this.overlay = new SurfaceOverlay(
      ctx.renderSettings,
      this.W,
      this.H,
      this.tileTex,
      this.terrainBytes.texture,
      THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    );
    this.cosmetics = new TerritoryCosmetics(ctx.renderer);
    this.trails = EffectTrails.acquire(ctx);
    this.material = new THREE.ShaderMaterial({
      name: "three-terrain",
      glslVersion: THREE.GLSL3,
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        // Shared by reference: values follow SceneEnvironment.
        ...environmentUniforms(ctx.scene),
        ...this.u,
        // Shared by reference with the sea-level overlay plane.
        ...this.overlay.uniforms,
        ...this.cosmetics.uniforms,
        // Shared by reference with WaterLayer (and the nukes' ribbons).
        ...this.trails.uniforms,
      },
      fog: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = "terrain";
    ctx.scene.add(this.mesh);
    ctx.scene.add(this.overlay.plane);
  }

  // ---- ReliefSurface (what overlays drape on) ----

  /** HeightField version the drawn relief was last built from. */
  get version(): number {
    return this.reliefVersion;
  }

  get grid(): HeightField {
    return this.hf;
  }

  get tileTexture(): THREE.Texture {
    return this.tileTex;
  }

  /** Drawn surface Y at grid vertex (i, j): relief vertex, at least 0. */
  vertexSurface(i: number, j: number): number {
    const y = this.positions[(j * this.hf.cols + i) * 3 + 1];
    return y > 0 ? y : 0;
  }

  /**
   * Drawn surface Y at world (x, z): the relief triangle under the point
   * (cells split (a, c, b) + (b, c, d) like the index buffer), at least sea
   * level. Clamped to the map.
   */
  surfaceAt(x: number, z: number): number {
    const hf = this.hf;
    const s = hf.step;
    const cols = hf.cols;
    const xc = x > 0 ? (x < this.W ? x : this.W) : 0;
    const zc = z > 0 ? (z < this.H ? z : this.H) : 0;
    let i = Math.floor(xc / s);
    if (i > cols - 2) i = cols - 2;
    let j = Math.floor(zc / s);
    if (j > hf.rows - 2) j = hf.rows - 2;
    const x0 = i * s;
    const z0 = j * s;
    const fx = Math.min(1, (xc - x0) / (hf.vertexX(i + 1) - x0));
    const fz = Math.min(1, (zc - z0) / (hf.vertexY(j + 1) - z0));
    const pos = this.positions;
    const a = (j * cols + i) * 3 + 1;
    const ha = pos[a];
    const hb = pos[a + 3];
    const hc = pos[a + cols * 3];
    const hd = pos[a + cols * 3 + 3];
    const h =
      fx + fz <= 1
        ? ha + (hb - ha) * fx + (hc - ha) * fz
        : hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
    return h > 0 ? h : 0;
  }

  // ---- Surface overlays ----

  /** The persistent coordinate grid (M key); the alt view also shows it. */
  setGridView(active: boolean): void {
    this.overlay.setGridView(active);
  }

  /** Small-player glow set (1 byte per owner smallID), null = none. */
  setSmallPlayerGlow(set: Uint8Array | null): void {
    this.overlay.setSmallPlayers(set, this.ctx.renderer);
  }

  /** After a WebGL context restore: rebuild what lived only on the GPU. */
  contextRestored(): void {
    this.overlay.contextRestored();
    this.cosmetics.contextRestored();
  }

  // ---- Territory cosmetics (patterns, skins) ----

  /** Every player's pattern (`addPlayers` / `updatePlayerCosmetics` data). */
  setPatterns(patternMeta: Float32Array, patternData: Uint8Array): void {
    this.cosmetics.setPatterns(patternMeta, patternData);
  }

  /** One atlas layer per unique skin URL of the game (loaded async). */
  initSkinAtlas(urls: readonly string[]): void {
    this.cosmetics.initSkinAtlas(urls);
  }

  /** A player's skin (a URL given to `initSkinAtlas`), or none. */
  setPlayerSkin(smallID: number, url: string | null): void {
    this.cosmetics.setPlayerSkin(smallID, url);
  }

  /** A player's spawn tile, the centre of their skin. */
  setPlayerSpawn(smallID: number, x: number, y: number): void {
    this.cosmetics.setPlayerSpawn(smallID, x, y);
  }

  /** Team games tint skins by the territory colour. */
  setTeamMode(on: boolean): void {
    this.cosmetics.setTeamMode(on);
  }

  // ---- Effect trails (boat / nuke trails, effect palette) ----

  /** The whole trail buffer (first tick, context restore): uploaded now. */
  setTrailState(trailState: Uint16Array): void {
    this.trails.setTrailState(trailState);
  }

  /** Rows a tick stamped: diffed, sent by the next frames within budget. */
  applyTrailDelta(
    trailState: Uint16Array,
    dirtyRowMin: number,
    dirtyRowMax: number,
  ): void {
    this.trails.applyTrailDelta(trailState, dirtyRowMin, dirtyRowMax);
  }

  /** The effect palette (RGBA32F 4096 × 48), mirrored. */
  setEffectPalette(effectData: Float32Array): void {
    this.trails.setEffectPalette(effectData);
  }

  setTiles(
    tileState: Uint16Array,
    changedTiles: readonly number[] | null,
  ): void {
    if (tileState.length !== this.W * this.H) return;
    const tex = this.tileTex;
    if (
      changedTiles === null ||
      !this.tilesUploaded ||
      textureData(tex) !== tileState
    ) {
      setTextureData(tex, tileState);
      this.uploadAllTiles();
      return;
    }
    // Sent by the next frames' `update` (flushTiles).
    this.tileQueue.markTiles(changedTiles);
  }

  /** Spawn phase on: queued tiles are all sent on the next frame. */
  setSpawnPhase(inSpawnPhase: boolean): void {
    this.spawnPhase = inSpawnPhase;
  }

  /**
   * Upload counters for the perf tool (`three_perf=1`): calls and texels of
   * the last frame (including a full upload pushed between frames), their
   * maxima over the last 120 frames (perf builds only), totals, and what is
   * still queued; plus the surface overlay, territory cosmetics and effect
   * trail counters.
   */
  perfStats(): Record<string, number> {
    const max = (a: Int32Array | null) => (a === null ? 0 : Math.max(...a));
    return {
      ...this.overlay.perfStats(),
      ...this.cosmetics.perfStats(),
      ...this.trails.perfStats(),
      uploadCallsLastFrame: this.callsLastFrame,
      texelsLastFrame: this.texelsLastFrame,
      uploadCallsMax: max(this.recentCalls),
      texelsMax: max(this.recentTexels),
      pendingTexels: this.tileQueue.pendingTexels,
      pendingCells: this.tileQueue.pendingCells,
      uploadCallsTotal: this.callsTotal,
      texelsTotal: this.texelsTotal,
      fullUploads: this.fullUploads,
    };
  }

  setTerrainBytes(
    rects: readonly TerrainRect[] | null,
    bytes: Uint8Array,
  ): void {
    this.terrainBytes.sync(rects, bytes);
    // The HeightField version tells whether heights changed since we last
    // read them (the constructor already did, before the facade's first
    // full call).
    if (this.hf.version === this.reliefVersion) return;
    this.refreshRelief(rects === null ? null : this.hf.lastDirty);
  }

  /** Terrain colours / render settings changed. */
  rebuild(): void {
    this.refreshColors();
    this.refreshOverlaySettings();
  }

  setRelations(data: Uint8Array, size: number): void {
    if (!(size > 0) || data.length < size * size) return;
    if (size !== this.relSize) {
      this.relTex.dispose();
      this.relTex = createIntegerTexture(data, size, size, "R8UI");
      this.relSize = size;
      this.u.uRelations.value = this.relTex;
      this.u.uRelSize.value = size;
    } else {
      setTextureData(this.relTex, data);
    }
    uploadNow(this.ctx.renderer, this.relTex);
    // Alt-view trail colours (allies).
    this.trails.setRelations(data, size);
  }

  /** Not drawn: no defended-territory tint in the prototype. */
  setDefenseCoverage(units: ReadonlyMap<number, UnitState>): void {}

  update(frame: FrameInfo): void {
    this.flushTiles();
    // After the tile uploads: the glow mask reads the tile texture.
    this.overlay.update(frame, this.ctx.renderer);
    // Same switch as the default renderer (debug GUI; on by default).
    this.cosmetics.update(
      this.ctx.renderSettings.passEnabled.territoryPatterns === true,
    );
    // Trail uploads within budget, trail / effect uniforms (shared).
    this.trails.update(frame);
    const u = this.u;
    u.uTime.value = (frame.nowMs / 1000) % 3600;
    u.uHighlightOwner.value = frame.highlightOwner;
    u.uLocalPlayer.value = frame.localPlayerID;
    u.uAltView.value = frame.altView ? 1 : 0;
    u.uBorderPx.value = BORDER_CSS_PX * (frame.dpr > 0 ? frame.dpr : 1);
    this.refreshOverlaySettings();
    const key = waterColorKey(this.ctx.renderSettings.terrain);
    if (key !== this.waterKey) this.refreshColors();
  }

  dispose(): void {
    this.tileQueue.clear();
    this.overlay.dispose();
    this.cosmetics.dispose();
    this.trails.release();
    this.ctx.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.tileTex.dispose();
    this.relTex.dispose();
    this.terrainBytes.release();
  }

  // ---- Tile uploads ----

  /** Full upload of the tile state, right now; nothing stays queued. */
  private uploadAllTiles(): void {
    this.tileQueue.clear();
    uploadNow(this.ctx.renderer, this.tileTex);
    this.tilesUploaded = true;
    this.fullUploads++;
    this.countUpload(1, this.W * this.H);
  }

  /**
   * Send queued tile cells: all of them during the spawn phase, else the
   * next rectangles within `TILE_UPLOAD_BUDGET`. Past half the map pending,
   * one full upload is cheaper than rectangles.
   */
  private flushTiles(): void {
    const q = this.tileQueue;
    if (!q.empty) {
      if (q.pendingTexels > (this.W * this.H) / 2) {
        this.uploadAllTiles();
      } else {
        const rects = q.take(this.spawnPhase ? null : TILE_UPLOAD_BUDGET);
        const renderer = this.ctx.renderer;
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          this.tileUploader.upload(renderer, r.x, r.y, r.w, r.h);
          this.countUpload(1, r.w * r.h);
        }
      }
    }
    // Close this frame's counters (between-frame full uploads included).
    this.callsLastFrame = this.callsPending;
    this.texelsLastFrame = this.texelsPending;
    this.callsPending = 0;
    this.texelsPending = 0;
    if (this.recentCalls !== null && this.recentTexels !== null) {
      this.recentCalls[this.recentIndex] = this.callsLastFrame;
      this.recentTexels[this.recentIndex] = this.texelsLastFrame;
      this.recentIndex = (this.recentIndex + 1) % PERF_WINDOW;
    }
  }

  private countUpload(calls: number, texels: number): void {
    this.callsPending += calls;
    this.texelsPending += texels;
    this.callsTotal += calls;
    this.texelsTotal += texels;
  }

  // ---- Uniform refresh ----

  /** Terrain + water colours from `renderSettings.terrain`. */
  private refreshColors(): void {
    const t = this.ctx.renderSettings.terrain;
    const u = this.u;
    const set = (
      target: { value: THREE.Vector3 },
      hex: string,
      fallback: readonly [number, number, number],
    ) => target.value.fromArray(hexToSrgb01(hex, srgb255(fallback)));
    set(u.uColSand, t.sandColor, DEFAULT_TERRAIN.sand);
    set(u.uColPlains, t.plainsColor, DEFAULT_TERRAIN.plains);
    set(u.uColHighland, t.highlandColor, DEFAULT_TERRAIN.highland);
    set(u.uColMountain, t.mountainColor, DEFAULT_TERRAIN.mountain);
    set(u.uColVoid, t.backgroundColor, DEFAULT_TERRAIN.void);
    refreshWaterUniforms(u, t);
    this.waterKey = waterColorKey(t);
  }

  /** Territory look from `renderSettings.mapOverlay` / affiliation (cheap). */
  private refreshOverlaySettings(): void {
    const s = this.ctx.renderSettings;
    const o = s.mapOverlay;
    const a = s.affiliation;
    const u = this.u;
    // Same opacity as the default renderer: with neutral tone mapping the
    // fills read as in 2D, and the hillshade still shows through.
    u.uFillAlpha.value = Math.min(1, Math.max(0, o.territoryAlpha));
    u.uFillSaturation.value = o.territorySaturation;
    u.uHighlightFill.value = o.highlightFillBrighten;
    u.uHighlightBorder.value = o.highlightBrighten;
    u.uEmbargoTint.value.set(o.embargoTintR, o.embargoTintG, o.embargoTintB);
    u.uEmbargoRatio.value = o.embargoTintRatio;
    u.uFriendlyTint.value.set(
      o.friendlyTintR,
      o.friendlyTintG,
      o.friendlyTintB,
    );
    u.uFriendlyRatio.value = o.friendlyTintRatio;
    u.uFalloutColor.value.set(o.staleNukeR, o.staleNukeG, o.staleNukeB);
    u.uAffSelf.value.set(a.selfR, a.selfG, a.selfB);
    u.uAffAlly.value.set(a.allyR, a.allyG, a.allyB);
    u.uAffNeutral.value.set(a.neutralR, a.neutralG, a.neutralB);
    u.uAffEnemy.value.set(a.enemyR, a.enemyG, a.enemyB);
    // The alt view dims the terrain, so its fill can be stronger.
    u.uAltFillAlpha.value = Math.min(1, Math.max(0.3, 2 * s.altView.fillAlpha));
  }

  // ---- Geometry ----

  /** X/Z of all vertices, skirt normals and the index buffer (once). */
  private buildStaticGeometry(): void {
    const hf = this.hf;
    const cols = hf.cols;
    const rows = hf.rows;
    const pos = this.positions;
    for (let j = 0; j < rows; j++) {
      const z = hf.vertexY(j);
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 3;
        pos[k] = hf.vertexX(i);
        pos[k + 2] = z;
      }
    }

    // Skirts: north (z = 0), south (z = H), west (x = 0), east (x = W),
    // each running along +X or +Z.
    const edgeDefs: {
      n: number;
      at: (s: number) => number;
      nx: number;
      nz: number;
    }[] = [
      { n: cols, at: (s) => s, nx: 0, nz: -1 },
      { n: cols, at: (s) => (rows - 1) * cols + s, nx: 0, nz: 1 },
      { n: rows, at: (s) => s * cols, nx: -1, nz: 0 },
      { n: rows, at: (s) => s * cols + cols - 1, nx: 1, nz: 0 },
    ];
    let base = this.gridCount;
    for (const e of edgeDefs) {
      const grid = new Int32Array(e.n);
      for (let s = 0; s < e.n; s++) {
        grid[s] = e.at(s);
        for (const v of [base + 2 * s, base + 2 * s + 1]) {
          pos[v * 3] = pos[grid[s] * 3];
          pos[v * 3 + 2] = pos[grid[s] * 3 + 2];
          this.normals[v * 3] = e.nx;
          this.normals[v * 3 + 1] = 0;
          this.normals[v * 3 + 2] = e.nz;
        }
        pos[(base + 2 * s + 1) * 3 + 1] = this.skirtBottomY;
      }
      this.skirts.push({ grid, base, nx: e.nx, nz: e.nz });
      base += 2 * e.n;
    }

    // Index: grid cells, counter-clockwise seen from above (+Y), then skirt
    // quads facing outwards.
    const cells = (cols - 1) * (rows - 1);
    let skirtQuads = 0;
    for (const s of this.skirts) skirtQuads += s.grid.length - 1;
    const index = new Uint32Array((cells + skirtQuads) * 6);
    let o = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        index[o++] = a;
        index[o++] = c;
        index[o++] = b;
        index[o++] = b;
        index[o++] = c;
        index[o++] = d;
      }
    }
    for (const s of this.skirts) {
      // The edge runs along e = +X or +Z; triangle (top_a, top_b, bot_a)
      // has normal e × (0, -1, 0) = (e.z, 0, -e.x). Flip the winding when
      // that points into the map instead of along the outward normal.
      const ex = s.nz !== 0 ? 1 : 0;
      const ez = s.nx !== 0 ? 1 : 0;
      const flip = ez * s.nx - ex * s.nz < 0;
      for (let q = 0; q < s.grid.length - 1; q++) {
        const ta = s.base + 2 * q;
        const ba = ta + 1;
        const tb = ta + 2;
        const bb = ta + 3;
        if (!flip) {
          index[o++] = ta;
          index[o++] = tb;
          index[o++] = ba;
          index[o++] = tb;
          index[o++] = bb;
          index[o++] = ba;
        } else {
          index[o++] = ta;
          index[o++] = ba;
          index[o++] = tb;
          index[o++] = tb;
          index[o++] = ba;
          index[o++] = bb;
        }
      }
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  /**
   * Recompute vertex heights (with the coast lift), normals and skirt tops
   * for the HeightField vertex range `r` (null = everything), and queue the
   * matching buffer uploads.
   */
  private refreshRelief(r: GridRange | null): void {
    const hf = this.hf;
    const cols = hf.cols;
    const rows = hf.rows;
    const full: GridRange = { i0: 0, j0: 0, i1: cols - 1, j1: rows - 1 };
    const dirty = r ?? full;
    this.reliefVersion = hf.version;
    const grow = (g: GridRange, by: number): GridRange => ({
      i0: Math.max(0, g.i0 - by),
      j0: Math.max(0, g.j0 - by),
      i1: Math.min(cols - 1, g.i1 + by),
      j1: Math.min(rows - 1, g.j1 + by),
    });

    // Cells holding the changed tiles (and one around, cheap).
    computeCellLand(
      hf.terrain,
      this.W,
      this.H,
      hf.step,
      this.cellsX,
      this.cellsY,
      this.cellLand,
      dirty.i0 - 1,
      dirty.j0 - 1,
      dirty.i1,
      dirty.j1,
    );
    // Heights of every vertex touching those cells, normals one ring wider.
    const yRange = grow(dirty, 1);
    const nRange = grow(yRange, 1);
    const pos = this.positions;
    const heights = hf.heights;
    for (let j = yRange.j0; j <= yRange.j1; j++) {
      for (let i = yRange.i0; i <= yRange.i1; i++) {
        const k = j * cols + i;
        let y = heights[k];
        if (
          y < COAST_LIFT &&
          vertexTouchesLand(this.cellLand, this.cellsX, this.cellsY, i, j)
        ) {
          y = COAST_LIFT;
        }
        pos[k * 3 + 1] = y;
      }
    }
    this.computeNormals(nRange);
    // Skirt tops follow the edge vertices (a few thousand: just redo all).
    for (const s of this.skirts) {
      for (let q = 0; q < s.grid.length; q++) {
        pos[(s.base + 2 * q) * 3 + 1] = pos[s.grid[q] * 3 + 1];
      }
    }

    const position = this.geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    const normal = this.geometry.getAttribute("normal") as
      | THREE.BufferAttribute
      | undefined;
    if (!position || !normal) return; // first build: attributes not created yet
    for (const attr of [position, normal]) {
      attr.clearUpdateRanges();
      if (r !== null) {
        attr.addUpdateRange(
          nRange.j0 * cols * 3,
          (nRange.j1 - nRange.j0 + 1) * cols * 3,
        );
        attr.addUpdateRange(this.gridCount * 3, this.skirtVertexCount * 3);
      }
      attr.needsUpdate = true;
    }
  }

  /** Grid normals from central differences of the displayed heights. */
  private computeNormals(r: GridRange): void {
    const hf = this.hf;
    const cols = hf.cols;
    const rows = hf.rows;
    const pos = this.positions;
    const nrm = this.normals;
    for (let j = r.j0; j <= r.j1; j++) {
      const jm = j > 0 ? j - 1 : j;
      const jp = j < rows - 1 ? j + 1 : j;
      const dz = hf.vertexY(jp) - hf.vertexY(jm);
      for (let i = r.i0; i <= r.i1; i++) {
        const im = i > 0 ? i - 1 : i;
        const ip = i < cols - 1 ? i + 1 : i;
        const dx = hf.vertexX(ip) - hf.vertexX(im);
        const gx =
          dx > 0
            ? (pos[(j * cols + ip) * 3 + 1] - pos[(j * cols + im) * 3 + 1]) / dx
            : 0;
        const gz =
          dz > 0
            ? (pos[(jp * cols + i) * 3 + 1] - pos[(jm * cols + i) * 3 + 1]) / dz
            : 0;
        // Surface y = h(x, z) has normal (-dh/dx, 1, -dh/dz), normalised.
        const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        const k = (j * cols + i) * 3;
        nrm[k] = -gx * inv;
        nrm[k + 1] = inv;
        nrm[k + 2] = -gz * inv;
      }
    }
  }
}
