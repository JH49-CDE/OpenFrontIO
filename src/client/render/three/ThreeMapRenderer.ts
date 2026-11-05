/**
 * ThreeMapRenderer — opt-in Three.js map renderer (prototype), a drop-in for
 * the WebGL2 `MapRenderer` facade on the live-game path (`?renderer=three`).
 *
 * It owns the three WebGLRenderer, the scene, the camera rig, the layers, the
 * post-processing chain and the frame loop; consumers keep talking to the same
 * `MapRendererLike` surface (`implements` makes the compiler enforce it).
 *
 * Frame loop: like GPURenderer, it never calls `window.requestAnimationFrame`
 * itself — it re-arms through the injected `raf`, which ClientGameRunner's
 * `driveFrame` captures and invokes right after `setCameraState`. A throwing
 * frame is logged and the loop is still re-armed (otherwise the whole client
 * frame loop would stop).
 *
 * Settings come from the page-load `three_*` URL parameters
 * (`threeSettingsSearch()`: the address bar is rewritten when a game
 * starts). Anti-aliasing follows `planAntialias()`, independent of bloom.
 * With `three_perf=1` a `ThreePerfMonitor` times the frame; without it the
 * loop only pays a few null checks.
 *
 * Only loaded through `import()` when the flag is on, so three stays out of
 * the default bundle.
 */

import type { MapLayer } from "@openfront/engine-api/game/MapFiles";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { MapProjector } from "../../TransformHandler";
import type { SpiralRibbon } from "../frame/SpiralTrails";
import { GLUnavailableError, initGL } from "../gl/initGL";
import type { MapRendererLike } from "../gl/MapRenderer";
import type { SpawnCenter } from "../gl/passes/SpawnOverlayPass";
import type { AttackTroopLabel } from "../gl/passes/WorldTextPass";
import type { RenderSettings } from "../gl/RenderSettings";
import { renderDpr } from "../gl/utils/Dpr";
import type {
  AttackRingInput,
  BonusEvent,
  ConquestFx,
  DeadUnitFx,
  GhostPreviewData,
  NameEntry,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RendererConfig,
  TerrainRect,
  UnitState,
} from "../types";
import { CameraRig } from "./CameraRig";
import { FxLayer } from "./FxLayer";
import { HeightField } from "./HeightField";
import { NameLayer } from "./NameLayer";
import { OverlayLayer } from "./OverlayLayer";
import { PaletteView } from "./PaletteView";
import { threeSettingsSearch } from "./RendererSelection";
import { SceneEnvironment } from "./SceneEnvironment";
import { StructureLayer } from "./StructureLayer";
import { GRID_VIEW_KEY } from "./SurfaceOverlay";
import { TerrainLayer } from "./TerrainLayer";
import {
  type PerfLayer,
  type PerfLayerName,
  type ThreePerfConfig,
  ThreePerfMonitor,
} from "./ThreePerf";
import {
  type AntialiasPlan,
  planAntialias,
  readThreeSettingsFromUrl,
  type ThreeRenderSettings,
} from "./ThreeSettings";
import type {
  CameraInputs,
  FrameInfo,
  ProjectFn,
  ThreeLayerContext,
} from "./types";
import { UnitLayer } from "./UnitLayer";
import { WaterLayer } from "./WaterLayer";

/**
 * Context attributes for the shared WebGL2 context (three adopts it).
 * `antialias` is decided per renderer (`AntialiasPlan.contextMsaa`).
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  antialias: false,
  alpha: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  powerPreference: "high-performance",
};

/** Log the first few frame errors, then only every Nth (avoid console spam). */
const FRAME_ERROR_LOG_EVERY = 300;

interface PostChain {
  composer: EffectComposer;
  passes: Pass[];
}

/** A layer updated in the frame loop, before the scene is drawn. */
interface FrameLayer {
  update(frame: FrameInfo): void;
}

/**
 * Index of the names layer in the perf tool's layer list: the constructor
 * tracks the seven frame layers first (indexes 0-6, the order of
 * `frameLayers`), then the names.
 */
const PERF_NAMES_INDEX = 7;

export class ThreeMapRenderer implements MapRendererLike {
  /**
   * Called after a lost WebGL context comes back. The owner re-uploads all
   * simulation state. GPU resources are left to three's own restore
   * handling: it resets its GL state and re-uploads every geometry, texture
   * and program from the CPU-side copies the layers keep, on first use.
   */
  onContextRestored: (() => void) | null = null;

  readonly threeSettings: ThreeRenderSettings;
  /** How frames are anti-aliased and composed (fixed at construction). */
  readonly antialias: AntialiasPlan;
  /** Samples of the multisampled canvas (0 when it is not multisampled). */
  readonly canvasMsaaSamples: number;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly heightField: HeightField;
  readonly palette: PaletteView;
  readonly rig: CameraRig;
  /** DOM container for HTML overlays, inserted right after the canvas. */
  readonly overlayRoot: HTMLDivElement;

  private readonly ctx: ThreeLayerContext;
  private readonly environment: SceneEnvironment;
  private readonly terrain: TerrainLayer;
  private readonly water: WaterLayer;
  private readonly structures: StructureLayer;
  private readonly units: UnitLayer;
  private readonly overlay: OverlayLayer;
  private readonly fx: FxLayer;
  private readonly names: NameLayer;
  /** Updated in this order every frame (names come after the draw). */
  private readonly frameLayers: readonly FrameLayer[];
  private post: PostChain | null = null;
  /** Perf tool (`?three_perf=1`); null when off, which costs nothing. */
  private perf: ThreePerfMonitor | null = null;

  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private animId: number | null = null;
  private disposed = false;
  private contextLost = false;
  private frameErrors = 0;
  private readonly limited: { renderer: string; maxTextureSize: number } | null;

  // Camera state pushed by setCameraState (z = device px per tile).
  private camX: number;
  private camY: number;
  private camZ = 1;

  // Canvas size: CSS px observed by the ResizeObserver, and what the
  // renderer was last sized to (CSS px + pixel ratio).
  private cssW = 1;
  private cssH = 1;
  private appliedW = 0;
  private appliedH = 0;
  private appliedPixelRatio = 0;
  private resizeObs: ResizeObserver | null = null;

  // View state pushed by controllers / the frame builder.
  private localPlayerID = 0;
  private highlightOwner = 0;
  private altView = false;
  /** Persistent coordinate grid (M key), like GPURenderer.gridView. */
  private gridView = false;
  /** smallID → team, for the SAM rings' teammates (GPURenderer.playerTeams). */
  private readonly playerTeams = new Map<number, string>();
  private readonly samAllies = new Set<number>();

  // Tick timing for interpolation (tickAlpha).
  private lastGameTick = -1;
  private lastTickMs = 0;
  private lastFrameMs = 0;
  private readonly frame: FrameInfo;

  /** Projects for the camera of the frame being drawn (NameLayer). */
  private readonly project: ProjectFn = (wx, wy, wh) =>
    this.rig.project(wx, wy, wh);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly header: RendererConfig,
    private readonly terrainSource: () => Uint8Array,
    paletteData: Float32Array,
    private readonly config: Config,
    private readonly settings: RenderSettings,
    raf?: typeof requestAnimationFrame,
    caf?: typeof cancelAnimationFrame,
    threeSettings?: ThreeRenderSettings,
  ) {
    this.raf = raf ?? ((cb) => window.requestAnimationFrame(cb));
    this.caf = caf ?? ((id) => window.cancelAnimationFrame(id));
    // The page-load `three_*` parameters: the address bar was rewritten when
    // the game started, so location.search no longer has them.
    this.threeSettings =
      threeSettings ?? readThreeSettingsFromUrl(threeSettingsSearch());
    this.antialias = planAntialias(
      this.threeSettings,
      Math.min(renderDpr(), this.threeSettings.pixelRatioCap),
    );
    const contextAttributes: WebGLContextAttributes = {
      ...CONTEXT_ATTRIBUTES,
      antialias: this.antialias.contextMsaa,
    };
    const W = header.mapWidth;
    const H = header.mapHeight;
    this.camX = W / 2;
    this.camY = H / 2;

    // Same GPU gate as the default renderer: a software / missing context
    // throws GLUnavailableError, which the game-start path turns into the
    // WebGL gate. three adopts the context we acquired.
    const gl = initGL(canvas, contextAttributes);
    if (gl.gl === null) throw new GLUnavailableError(gl.status, gl.renderer);
    this.limited =
      gl.status === "limited"
        ? { renderer: gl.renderer, maxTextureSize: gl.maxTextureSize }
        : null;
    this.canvasMsaaSamples = this.antialias.contextMsaa
      ? canvasSamples(gl.gl)
      : 0;

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        context: gl.gl,
        ...contextAttributes,
      });
    } catch (err) {
      gl.gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw err;
    }
    this.overlayRoot = createOverlayRoot(canvas);

    try {
      // Khronos PBR Neutral keeps base colours (territory fills, terrain)
      // nearly untouched below ~0.8 and only rolls off highlights, so the
      // map stays as readable as the 2D renderer; ACES desaturated it.
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.toneMappingExposure = this.threeSettings.exposure;
      // renderer.info counts the whole frame (scene + post passes); it is
      // reset at the start of each frame (debugging via window.__webglView).
      this.renderer.info.autoReset = false;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;

      this.heightField = new HeightField(W, H, terrainSource(), {
        heightScale: this.threeSettings.heightScale,
        seabedDepth: this.threeSettings.seabedDepth,
        targetVertices: this.threeSettings.targetVertices,
      });
      this.palette = new PaletteView(paletteData);
      this.rig = new CameraRig(this.threeSettings, W, H, this.heightField);

      this.ctx = {
        renderer: this.renderer,
        scene: this.scene,
        mapWidth: W,
        mapHeight: H,
        heightField: this.heightField,
        palette: this.palette,
        settings: this.threeSettings,
        renderSettings: settings,
        config,
        overlayRoot: this.overlayRoot,
      };
      // Each layer's scene roots (what it added to the scene), for the perf
      // tool's per-layer triangle counts. Construction-time only.
      const perfLayers: PerfLayer[] = [];
      const track = <T extends object>(
        name: PerfLayerName,
        make: () => T,
      ): T => {
        const before = new Set(this.scene.children);
        const layer = make();
        const roots = this.scene.children.filter((c) => !before.has(c));
        perfLayers.push({ name, roots, source: layer });
        return layer;
      };
      this.environment = track(
        "environment",
        () => new SceneEnvironment(this.ctx),
      );
      this.terrain = track("terrain", () => new TerrainLayer(this.ctx));
      this.water = track("water", () => new WaterLayer(this.ctx));
      this.structures = track("structures", () => new StructureLayer(this.ctx));
      this.units = track("units", () => new UnitLayer(this.ctx));
      // Overlays drape on the drawn relief (TerrainLayer's surface).
      this.overlay = track(
        "overlay",
        () => new OverlayLayer(this.ctx, this.terrain),
      );
      this.fx = track("fx", () => new FxLayer(this.ctx));
      // Lot 3: the fallout smoke rises from the terrain's fallout cells.
      this.fx.setFallout(this.terrain.fallout);
      this.names = track("names", () => new NameLayer(this.ctx));
      this.frameLayers = [
        this.environment,
        this.terrain,
        this.water,
        this.structures,
        this.units,
        this.overlay,
        this.fx,
      ];
      this.terrain.setTerrainBytes(null, this.heightField.terrain);
      this.water.setTerrainBytes(null, this.heightField.terrain);
      // The grid toggle is remembered across games, as GPURenderer does.
      this.gridView = readGridView();
      this.terrain.setGridView(this.gridView);
      this.addTeams(header.players);

      if (this.antialias.composer) this.post = this.createPost();

      this.frame = {
        nowMs: 0,
        dtMs: 0,
        tickAlpha: 1,
        camera: this.rig.camera,
        cssPxPerTile: 1,
        tilt: 0,
        cssWidth: 1,
        cssHeight: 1,
        dpr: 1,
        localPlayerID: 0,
        highlightOwner: 0,
        altView: false,
      };

      if (this.threeSettings.perf) {
        this.perf = new ThreePerfMonitor({
          gl: gl.gl,
          // three swaps renderer.info on a context restore: read it live.
          info: () => this.renderer.info,
          scene: this.scene,
          layers: perfLayers,
          panelParent: this.overlayRoot,
          config: () => this.perfConfig(),
        });
      }
    } catch (err) {
      this.perf?.dispose();
      this.perf = null;
      this.overlayRoot.remove();
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      throw err;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.cssW = rect.width;
      this.cssH = rect.height;
    }
    this.resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.cssW = width;
          this.cssH = height;
        }
      }
    });
    this.resizeObs.observe(canvas);

    canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
    canvas.addEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
      false,
    );

    this.animId = this.raf(this.loop);
  }

  // ---- Projector (picking under tilt) ----

  /**
   * A screen↔world projector for TransformHandler. It owns its own rig and
   * recomputes the pose from `getInputs()` on every call, so picking never
   * lags the rendered frame. Canvas coords are CSS px; `canvasToWorld`
   * returns null off the map.
   */
  createProjector(getInputs: () => CameraInputs): MapProjector {
    const rig = new CameraRig(
      this.threeSettings,
      this.header.mapWidth,
      this.header.mapHeight,
      this.heightField,
    );
    return {
      canvasToWorld: (x, y) => {
        rig.updatePose(getInputs());
        return rig.canvasToWorld(x, y);
      },
      worldToCanvas: (x, y) => {
        rig.updatePose(getInputs());
        return rig.worldToCanvas(x, y);
      },
    };
  }

  /** Not limited by texture size unless the context reports it (#4357). */
  get glLimited(): { renderer: string; maxTextureSize: number } | null {
    return this.limited;
  }

  // ---- Camera ----

  setCameraState(x: number, y: number, z: number): void {
    this.camX = x;
    this.camY = y;
    this.camZ = z;
  }

  // ---- Territory / terrain ----

  uploadLiveDelta(
    tileState: Uint16Array,
    changedTiles: readonly number[],
  ): void {
    const t0 = this.perfNow();
    this.terrain.setTiles(tileState, changedTiles);
    this.perf?.call("uploadLiveDelta", performance.now() - t0);
  }

  /**
   * Rows of the trail buffer a tick stamped (TrailManager): diffed against
   * the trail texture's mirror, sent by the next frames within a budget
   * (EffectTrails.ts). Drawn on the relief and the sea.
   */
  uploadLiveTrailDelta(
    trailState: Uint16Array,
    dirtyRowMin: number,
    dirtyRowMax: number,
  ): void {
    const t0 = this.perfNow();
    this.terrain.applyTrailDelta(trailState, dirtyRowMin, dirtyRowMax);
    this.perf?.call("uploadLiveTrailDelta", performance.now() - t0);
  }

  /** Full tile and trail state (first tick, context restore): uploaded now. */
  uploadTileAndTrailState(
    tileState: Uint16Array,
    trailState: Uint16Array,
  ): void {
    const t0 = this.perfNow();
    this.terrain.setTiles(tileState, null);
    this.terrain.setTrailState(trailState);
    this.perf?.call("uploadTileAndTrailState", performance.now() - t0);
  }

  /**
   * Patch terrain bytes (water nukes, replay seeks): the shared HeightField is
   * updated first, then the layers are told which rects changed.
   */
  applyTerrainRects(rects: readonly TerrainRect[], bytes: Uint8Array): void {
    const t0 = this.perfNow();
    if (this.heightField.applyRects(rects, bytes) !== null) {
      this.terrain.setTerrainBytes(rects, bytes);
      this.water.setTerrainBytes(rects, bytes);
    }
    this.perf?.call("applyTerrainRects", performance.now() - t0);
  }

  /** Terrain colours changed (graphics settings): re-bake. */
  rebuildTerrain(): void {
    this.terrain.rebuild();
  }

  /**
   * Relation matrix (frame/derive/RelationMatrix.ts): territory colours and
   * trail colours (TerrainLayer) and structure icons / models
   * (StructureLayer) in the alt view tell allies from enemies.
   */
  updateRelations(data: Uint8Array, size: number): void {
    this.terrain.setRelations(data, size);
    this.structures.setRelations(data, size);
  }

  // ---- Players / palette ----

  updatePalette(paletteData: Float32Array): void {
    this.palette.update(paletteData);
  }

  /**
   * The cosmetic effect palette (RGBA32F 4096 × 48), mirrored in a texture
   * shared by the ground trails (boat / nuke) and the nukes' aerial
   * ribbons (EffectTrails.ts). The structure, warship, train and railway
   * blocks are not drawn yet.
   */
  updateEffectPalette(effectData: Float32Array): void {
    this.terrain.setEffectPalette(effectData);
  }

  addPlayers(
    players: PlayerStatic[],
    paletteData: Float32Array,
    patternMeta: Float32Array,
    patternData: Uint8Array,
  ): void {
    this.palette.update(paletteData);
    this.terrain.setPatterns(patternMeta, patternData);
    this.names.addPlayers(players);
    this.addTeams(players);
  }

  /**
   * Cosmetics visibility changed: palette, territory patterns, flags /
   * crowns / colours (NameLayer upsert).
   */
  updatePlayerCosmetics(
    players: PlayerStatic[],
    paletteData: Float32Array,
    patternMeta: Float32Array,
    patternData: Uint8Array,
  ): void {
    this.palette.update(paletteData);
    this.terrain.setPatterns(patternMeta, patternData);
    this.names.addPlayers(players);
  }

  /**
   * A player's territory skin (a URL given to `initSkinAtlas`; others are
   * ignored), or none (null). Drawn by the terrain shader
   * (TerritoryCosmetics.ts).
   */
  setPlayerSkin(smallID: number, url: string | null): void {
    this.terrain.setPlayerSkin(smallID, url);
  }

  /** The game's unique skin URLs, once at game start: one atlas layer each. */
  initSkinAtlas(urls: readonly string[]): void {
    this.terrain.initSkinAtlas(urls);
  }

  /** A player's spawn tile: the centre of their territory skin. */
  setPlayerSpawn(smallID: number, x: number, y: number): void {
    this.terrain.setPlayerSpawn(smallID, x, y);
  }

  setLocalPlayerID(id: number): void {
    this.localPlayerID = id;
    this.overlay.setLocalPlayer(id);
  }

  // ---- Names / labels ----

  updateNames(
    names: Map<string, NameEntry>,
    players: Map<number, PlayerState>,
    snap: boolean,
    statusData?: Map<number, PlayerStatusData>,
  ): void {
    const t0 = this.perfNow();
    this.names.updateNames(names, players, snap, statusData);
    this.syncSamAllies(players);
    this.perf?.call("updateNames", performance.now() - t0);
  }

  refreshNames(displayNames: Map<string, string>): void {
    this.names.refreshNames(displayNames);
  }

  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.names.setAttackTroopLabels(labels);
  }

  // ---- Units / structures / FX ----

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    const t0 = this.perfNow();
    if (gameTick !== this.lastGameTick) {
      this.lastGameTick = gameTick;
      this.lastTickMs = performance.now();
    }
    this.units.updateUnits(units, gameTick);
    // Progress bars / deletion marks change every tick (BarPass parity).
    this.structures.updateStatus(units, gameTick);
    this.overlay.setSamTick(gameTick);
    this.perf?.call("updateUnits", performance.now() - t0);
  }

  updateStructures(units: Map<number, UnitState>): void {
    const t0 = this.perfNow();
    this.structures.updateStructures(units);
    this.overlay.setSamStructures(units);
    this.terrain.setDefenseCoverage(units);
    this.perf?.call("updateStructures", performance.now() - t0);
  }

  applyDeadUnits(deadUnits: DeadUnitFx[]): void {
    const t0 = this.perfNow();
    this.fx.applyDeadUnits(deadUnits);
    this.perf?.call("applyDeadUnits", performance.now() - t0);
  }

  applyConquestEvents(events: ConquestFx[]): void {
    this.fx.applyConquestEvents(events);
    this.names.showConquest(events);
  }

  /** Same filter as the default renderer: local player only, all if none. */
  applyBonusEvents(events: BonusEvent[]): void {
    if (events.length === 0) return;
    const filtered =
      this.localPlayerID > 0
        ? events.filter((e) => e.smallID === this.localPlayerID)
        : events;
    if (filtered.length === 0) return;
    this.fx.applyBonusEvents(filtered);
    this.names.showBonus(filtered);
  }

  setSelectedUnits(unitIds: readonly number[]): void {
    this.units.setSelectedUnits(unitIds);
  }

  setHighlightStructureTypes(unitTypes: string[] | null): void {
    this.structures.setHighlightTypes(unitTypes);
    // SAM / bomb build buttons show the SAM range rings (GPURenderer).
    this.overlay.setHighlightStructureTypes(unitTypes);
  }

  /**
   * Alliance clusters (pushed every tick). The SAM rings only use them in
   * the "owner" colour mode, as SAMRadiusPass does; the rings themselves
   * come from `updateStructures` and show in build mode.
   */
  setSAMAllianceClusters(clusters: Map<number, number>): void {
    this.overlay.setSamAllianceClusters(clusters);
  }

  // ---- Overlays ----

  /**
   * Build ghost: the 3D model, range ring and SAM rings (OverlayLayer), and
   * the ghost icon while structures show as icons (StructureLayer).
   */
  updateGhostPreview(data: GhostPreviewData | null): void {
    this.overlay.updateGhostPreview(data);
    this.structures.setGhostPreview(data);
  }

  updateNukeTrajectory(data: NukeTrajectoryData | null): void {
    this.overlay.updateNukeTrajectory(data);
  }

  updateNukeTelegraphs(data: NukeTelegraphData[]): void {
    this.overlay.updateNukeTelegraphs(data);
  }

  updateAttackRings(rings: AttackRingInput[]): void {
    this.overlay.updateAttackRings(rings);
  }

  showMoveIndicator(tileX: number, tileY: number, ownerID: number): void {
    this.overlay.showMoveIndicator(tileX, tileY, ownerID);
  }

  triggerBlockedFlash(tileX: number, tileY: number): void {
    this.overlay.triggerBlockedFlash(tileX, tileY);
  }

  /**
   * Spawn halos (OverlayLayer / SpawnOverlay: the local player's breathing
   * halo, teammates', and other humans' spawn highlights; empty = off). The
   * phase itself also makes tile uploads immediate (no per-frame budget),
   * as the default renderer flushes its drip buckets then.
   */
  updateSpawnOverlay(inSpawnPhase: boolean, centers: SpawnCenter[]): void {
    this.terrain.setSpawnPhase(inSpawnPhase);
    this.overlay.updateSpawnOverlay(centers);
  }

  /** Small players' breathing red aura (TerrainLayer / SurfaceOverlay). */
  updateSmallPlayerGlow(set: Uint8Array | null): void {
    this.terrain.setSmallPlayerGlow(set);
  }

  // ---- Railroads (tracks only) / spirals (not drawn by the prototype) ----

  uploadRailroadState(data: Uint8Array): void {
    const t0 = this.perfNow();
    this.units.setRailroads(data);
    this.perf?.call("uploadRailroadState", performance.now() - t0);
  }

  /** Construction dust and the rail colour effects are not drawn. */
  applyRailroadDust(tileRefs: number[]): void {}

  setLocalRailColor(r: number, g: number, b: number): void {}

  /**
   * Spiral nuke-trail vortexes (the default's SpiralRibbonPass) are not
   * drawn: a spiral nuke trail shows its first colour on the ground track
   * and on the nuke's ribbon (EffectTrails.ts).
   */
  updateSpiralRibbons(ribbons: readonly SpiralRibbon[]): void {}

  // ---- Map layers (decorative art on 3 maps; not drawn by the prototype) ----

  setMapLayers(layers: MapLayer[], images: Map<string, ImageBitmap>): void {}

  setLayerVisible(layerId: string, visible: boolean): void {}

  setLayerAlpha(layerId: string, alpha: number): void {}

  markLayerTilesDestroyed(layerId: string, tileIndices: number[]): void {}

  setLayerDestroyedMask(layerId: string, mask: Uint8Array): void {}

  // ---- View state ----

  setAltView(active: boolean): void {
    this.altView = active;
  }

  /**
   * Persistent coordinate grid (M key; the alt view also shows it while
   * held). Remembered in localStorage under the default renderer's key.
   */
  setGridView(active: boolean): void {
    this.gridView = active;
    this.terrain.setGridView(active);
    try {
      window.localStorage.setItem(GRID_VIEW_KEY, active ? "true" : "false");
    } catch {
      // Storage unavailable: the toggle still works for this game.
    }
  }

  setHighlightOwner(ownerID: number): void {
    this.highlightOwner = ownerID;
  }

  /** Cursor position (tiles); unused by the prototype's layers so far. */
  setMouseWorldPos(x: number, y: number): void {}

  getSettings(): RenderSettings {
    return this.settings;
  }

  // ---- Lifecycle ----

  /**
   * Releases GPU / DOM resources and the WebGL context itself. Leaves the
   * canvas to its owner.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.animId !== null) {
      this.caf(this.animId);
      this.animId = null;
    }
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.onContextRestored = null;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    for (const layer of [
      this.names,
      this.fx,
      this.overlay,
      this.units,
      this.structures,
      this.water,
      this.terrain,
      this.environment,
    ]) {
      try {
        layer.dispose();
      } catch (err) {
        console.error("[ThreeMapRenderer] layer dispose failed", err);
      }
    }
    this.disposePost();
    this.palette.dispose();
    this.perf?.dispose();
    this.perf = null;
    // WebGLRenderer.dispose() only clears three's caches: the context keeps
    // counting against the browser's WebGL context limit until it is GC'd,
    // and the game's event listeners keep this facade reachable. Drop it
    // explicitly, like GPURenderer.dispose(). An already-lost context is left
    // alone (loseContext() on it is an INVALID_OPERATION).
    this.renderer.dispose();
    if (!this.contextLost) this.renderer.forceContextLoss();
    this.overlayRoot.remove();
  }

  // ---- Internals ----

  private readonly loop = (): void => {
    this.animId = null;
    if (this.disposed) return;
    if (!this.contextLost) {
      try {
        this.renderFrame();
      } catch (err) {
        this.perf?.abortFrame();
        if (this.frameErrors++ % FRAME_ERROR_LOG_EVERY === 0) {
          console.error(
            `[ThreeMapRenderer] frame failed (${this.frameErrors} so far)`,
            err,
          );
        }
      }
    }
    // Always re-arm, even after a failed frame.
    this.animId = this.raf(this.loop);
  };

  private renderFrame(): void {
    const now = performance.now();
    const perf = this.perf;
    perf?.beginFrame(now);
    const dt = this.lastFrameMs > 0 ? now - this.lastFrameMs : 0;
    this.lastFrameMs = now;

    this.applyResize();
    this.renderer.info.reset();

    const cssPxPerTile = this.camZ / renderDpr();
    this.rig.update({
      centerX: this.camX,
      centerY: this.camY,
      cssPxPerTile,
      cssWidth: this.cssW,
      cssHeight: this.cssH,
    });

    const f = this.frame;
    f.nowMs = now;
    f.dtMs = Math.min(100, Math.max(0, dt));
    f.tickAlpha =
      this.lastGameTick < 0
        ? 1
        : Math.min(
            1,
            Math.max(0, (now - this.lastTickMs) / this.config.msPerTick()),
          );
    f.cssPxPerTile = cssPxPerTile;
    f.tilt = this.rig.tilt;
    f.cssWidth = this.cssW;
    f.cssHeight = this.cssH;
    f.dpr = this.appliedPixelRatio;
    f.localPlayerID = this.localPlayerID;
    f.highlightOwner = this.highlightOwner;
    f.altView = this.altView;

    const layers = this.frameLayers;
    for (let i = 0; i < layers.length; i++) {
      if (perf === null) {
        layers[i].update(f);
      } else {
        const t0 = performance.now();
        layers[i].update(f);
        perf.layerUpdate(i, performance.now() - t0);
      }
    }

    const tRender = this.perfNow();
    perf?.beginRender();
    if (this.post) this.post.composer.render(f.dtMs / 1000);
    else this.renderer.render(this.scene, this.rig.camera);
    perf?.endRender();

    const tNames = this.perfNow();
    this.names.update(f, this.project);

    if (perf !== null) {
      const end = performance.now();
      perf.layerUpdate(PERF_NAMES_INDEX, end - tNames);
      perf.endFrame(tRender - now, tNames - tRender, end - tNames);
    }
  }

  private addTeams(players: readonly PlayerStatic[]): void {
    for (const p of players) {
      if (p.team !== null) this.playerTeams.set(p.smallID, p.team);
    }
    // Team game = any player has a team: skins are tinted by the territory
    // colour (GPURenderer.addPlayers).
    this.terrain.setTeamMode(this.playerTeams.size > 0);
  }

  /**
   * The local player's allies plus teammates, for the SAM ring colours
   * (GPURenderer.updateNames). The rings only rebuild when the set changed.
   */
  private syncSamAllies(players: Map<number, PlayerState>): void {
    const me = this.localPlayerID;
    if (me <= 0) return;
    const friendly = this.samAllies;
    friendly.clear();
    for (const a of players.get(me)?.allies ?? []) friendly.add(a);
    const team = this.playerTeams.get(me);
    if (team !== undefined) {
      for (const [sid, t] of this.playerTeams) {
        if (t === team && sid !== me) friendly.add(sid);
      }
    }
    this.overlay.setSamAllies(friendly);
  }

  /** performance.now() when the perf tool is on; 0 (no clock read) when off. */
  private perfNow(): number {
    return this.perf === null ? 0 : performance.now();
  }

  private perfConfig(): ThreePerfConfig {
    const s = this.threeSettings;
    return {
      quality: s.quality,
      bloom: s.bloom,
      antialias: s.antialias,
      canvasMsaaSamples: this.canvasMsaaSamples,
      targetMsaaSamples: this.post ? this.antialias.targetSamples : 0,
      fxaa: this.antialias.fxaa,
      composer: this.post !== null,
      pixelRatio: this.appliedPixelRatio,
      width: this.canvas.width,
      height: this.canvas.height,
      reliefVertices: this.heightField.vertexCount,
      maxTiltDeg: s.maxTiltDeg,
    };
  }

  /** Size the backing store to the observed CSS size × capped DPR. */
  private applyResize(): void {
    const pixelRatio = Math.min(renderDpr(), this.threeSettings.pixelRatioCap);
    if (
      this.cssW === this.appliedW &&
      this.cssH === this.appliedH &&
      pixelRatio === this.appliedPixelRatio
    ) {
      return;
    }
    this.appliedW = this.cssW;
    this.appliedH = this.cssH;
    this.appliedPixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    // false: keep the canvas's own 100% CSS size.
    this.renderer.setSize(this.cssW, this.cssH, false);
    if (this.post) {
      this.post.composer.setPixelRatio(pixelRatio);
      this.post.composer.setSize(this.cssW, this.cssH);
    }
  }

  /**
   * RenderPass → [UnrealBloomPass] → OutputPass (tone mapping + sRGB) →
   * [FXAAPass]. The HDR target is multisampled when the AA plan says so
   * (MSAA below 1.5× pixel ratio: above, the resolution already smooths
   * edges and multisampled half-float targets get expensive). FXAA runs on
   * the tone-mapped image, as it expects.
   */
  private createPost(): PostChain {
    const s = this.threeSettings;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.antialias.targetSamples,
    });
    const composer = new EffectComposer(this.renderer, target);
    const passes: Pass[] = [new RenderPass(this.scene, this.rig.camera)];
    if (s.bloom) {
      passes.push(
        new UnrealBloomPass(
          new THREE.Vector2(1, 1),
          s.bloomStrength,
          s.bloomRadius,
          s.bloomThreshold,
        ),
      );
    }
    passes.push(new OutputPass());
    if (this.antialias.fxaa) passes.push(new FXAAPass());
    for (const pass of passes) composer.addPass(pass);
    return { composer, passes };
  }

  private disposePost(): void {
    if (!this.post) return;
    for (const pass of this.post.passes) pass.dispose();
    this.post.composer.dispose();
    this.post = null;
  }

  private readonly handleContextLost = (e: Event): void => {
    // preventDefault asks the browser to restore the context; never call
    // loseContext() here (see MapRenderer.handleContextLost).
    e.preventDefault();
    this.contextLost = true;
    console.warn("[ThreeMapRenderer] WebGL context lost — awaiting restore");
  };

  private readonly handleContextRestored = (): void => {
    console.warn(
      "[ThreeMapRenderer] WebGL context restored — three re-uploads GPU resources on first use",
    );
    this.contextLost = false;
    this.perf?.contextRestored();
    this.terrain.contextRestored();
    // Force a fresh resize on the next frame.
    this.appliedPixelRatio = 0;
    this.onContextRestored?.();
  };
}

/** The remembered grid toggle (GPURenderer reads the same key). */
function readGridView(): boolean {
  try {
    return window.localStorage.getItem(GRID_VIEW_KEY) === "true";
  } catch {
    return false;
  }
}

/** Samples of the default framebuffer (the canvas) of a fresh context. */
function canvasSamples(gl: WebGL2RenderingContext): number {
  try {
    return Number(gl.getParameter(gl.SAMPLES)) || 0;
  } catch {
    return 0;
  }
}

/**
 * A fixed, full-viewport, click-through container placed right after the
 * canvas, so it stacks above the map and below `#game-input-overlay` (which
 * is appended to <body> later).
 */
function createOverlayRoot(canvas: HTMLCanvasElement): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "three-map-overlay";
  const st = root.style;
  st.position = "fixed";
  st.inset = "0";
  st.pointerEvents = "none";
  st.overflow = "hidden";
  if (canvas.parentNode) canvas.after(root);
  else document.body.appendChild(root);
  return root;
}
