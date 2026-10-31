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
 * Only loaded through `import()` when the flag is on, so three stays out of
 * the default bundle.
 */

import type { MapLayer } from "@openfront/engine-api/game/MapFiles";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
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
import { SceneEnvironment } from "./SceneEnvironment";
import { StructureLayer } from "./StructureLayer";
import { TerrainLayer } from "./TerrainLayer";
import {
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

/** Context attributes for the shared WebGL2 context (three adopts it). */
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
  passes: { dispose(): void }[];
}

export class ThreeMapRenderer implements MapRendererLike {
  /**
   * Called after a lost WebGL context comes back. The owner re-uploads all
   * simulation state. (Rebuilding GPU resources is left to three's own
   * restore handling in this prototype.)
   */
  onContextRestored: (() => void) | null = null;

  readonly threeSettings: ThreeRenderSettings;
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
  private post: PostChain | null = null;

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
  ) {
    this.raf = raf ?? ((cb) => window.requestAnimationFrame(cb));
    this.caf = caf ?? ((id) => window.cancelAnimationFrame(id));
    this.threeSettings = readThreeSettingsFromUrl();
    const W = header.mapWidth;
    const H = header.mapHeight;
    this.camX = W / 2;
    this.camY = H / 2;

    // Same GPU gate as the default renderer: a software / missing context
    // throws GLUnavailableError, which the game-start path turns into the
    // WebGL gate. three adopts the context we acquired.
    const gl = initGL(canvas, CONTEXT_ATTRIBUTES);
    if (gl.gl === null) throw new GLUnavailableError(gl.status, gl.renderer);
    this.limited =
      gl.status === "limited"
        ? { renderer: gl.renderer, maxTextureSize: gl.maxTextureSize }
        : null;

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        context: gl.gl,
        ...CONTEXT_ATTRIBUTES,
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
      this.environment = new SceneEnvironment(this.ctx);
      this.terrain = new TerrainLayer(this.ctx);
      this.water = new WaterLayer(this.ctx);
      this.structures = new StructureLayer(this.ctx);
      this.units = new UnitLayer(this.ctx);
      this.overlay = new OverlayLayer(this.ctx);
      this.fx = new FxLayer(this.ctx);
      this.names = new NameLayer(this.ctx);
      this.terrain.setTerrainBytes(null, this.heightField.terrain);
      this.water.setTerrainBytes(null, this.heightField.terrain);

      if (this.threeSettings.bloom) this.post = this.createPost();

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
    } catch (err) {
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
    this.terrain.setTiles(tileState, changedTiles);
  }

  /** Trails are not drawn by the prototype. */
  uploadLiveTrailDelta(
    trailState: Uint16Array,
    dirtyRowMin: number,
    dirtyRowMax: number,
  ): void {}

  uploadTileAndTrailState(
    tileState: Uint16Array,
    trailState: Uint16Array,
  ): void {
    this.terrain.setTiles(tileState, null);
  }

  /**
   * Patch terrain bytes (water nukes, replay seeks): the shared HeightField is
   * updated first, then the layers are told which rects changed.
   */
  applyTerrainRects(rects: readonly TerrainRect[], bytes: Uint8Array): void {
    if (this.heightField.applyRects(rects, bytes) === null) return;
    this.terrain.setTerrainBytes(rects, bytes);
    this.water.setTerrainBytes(rects, bytes);
  }

  /** Terrain colours changed (graphics settings): re-bake. */
  rebuildTerrain(): void {
    this.terrain.rebuild();
  }

  updateRelations(data: Uint8Array, size: number): void {
    this.terrain.setRelations(data, size);
  }

  // ---- Players / palette ----

  updatePalette(paletteData: Float32Array): void {
    this.palette.update(paletteData);
  }

  /** Trail / structure effect colours are not used by the prototype. */
  updateEffectPalette(effectData: Float32Array): void {}

  addPlayers(
    players: PlayerStatic[],
    paletteData: Float32Array,
    patternMeta: Float32Array,
    patternData: Uint8Array,
  ): void {
    this.palette.update(paletteData);
    this.names.addPlayers(players);
  }

  /** New flags / crowns / colours: palette refresh + NameLayer upsert. */
  updatePlayerCosmetics(
    players: PlayerStatic[],
    paletteData: Float32Array,
    patternMeta: Float32Array,
    patternData: Uint8Array,
  ): void {
    this.palette.update(paletteData);
    this.names.addPlayers(players);
  }

  /** Territory skins are not drawn by the prototype. */
  setPlayerSkin(smallID: number, url: string | null): void {}

  /** Territory skins are not drawn by the prototype. */
  initSkinAtlas(urls: readonly string[]): void {}

  /** Only used to centre territory skins; not drawn by the prototype. */
  setPlayerSpawn(smallID: number, x: number, y: number): void {}

  setLocalPlayerID(id: number): void {
    this.localPlayerID = id;
  }

  // ---- Names / labels ----

  updateNames(
    names: Map<string, NameEntry>,
    players: Map<number, PlayerState>,
    snap: boolean,
    statusData?: Map<number, PlayerStatusData>,
  ): void {
    this.names.updateNames(names, players, snap, statusData);
  }

  refreshNames(displayNames: Map<string, string>): void {
    this.names.refreshNames(displayNames);
  }

  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.names.setAttackTroopLabels(labels);
  }

  // ---- Units / structures / FX ----

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    if (gameTick !== this.lastGameTick) {
      this.lastGameTick = gameTick;
      this.lastTickMs = performance.now();
    }
    this.units.updateUnits(units, gameTick);
    // Progress bars / deletion marks change every tick (BarPass parity).
    this.structures.updateStatus(units, gameTick);
  }

  updateStructures(units: Map<number, UnitState>): void {
    this.structures.updateStructures(units);
    this.terrain.setDefenseCoverage(units);
  }

  applyDeadUnits(deadUnits: DeadUnitFx[]): void {
    this.fx.applyDeadUnits(deadUnits);
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
  }

  /** SAM range rings are not drawn by the prototype. */
  setSAMAllianceClusters(clusters: Map<number, number>): void {}

  // ---- Overlays ----

  updateGhostPreview(data: GhostPreviewData | null): void {
    this.overlay.updateGhostPreview(data);
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

  /** The spawn-phase overlay is not drawn by the prototype. */
  updateSpawnOverlay(inSpawnPhase: boolean, centers: SpawnCenter[]): void {}

  /** The small-player glow is not drawn by the prototype. */
  updateSmallPlayerGlow(set: Uint8Array | null): void {}

  // ---- Railroads (tracks only) / spirals (not drawn by the prototype) ----

  uploadRailroadState(data: Uint8Array): void {
    this.units.setRailroads(data);
  }

  /** Construction dust and the rail colour effects are not drawn. */
  applyRailroadDust(tileRefs: number[]): void {}

  setLocalRailColor(r: number, g: number, b: number): void {}

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

  /** The tile grid view is not drawn by the prototype. */
  setGridView(active: boolean): void {}

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

    this.environment.update(f);
    this.terrain.update(f);
    this.water.update(f);
    this.structures.update(f);
    this.units.update(f);
    this.overlay.update(f);
    this.fx.update(f);

    if (this.post) this.post.composer.render(f.dtMs / 1000);
    else this.renderer.render(this.scene, this.rig.camera);

    this.names.update(f, this.project);
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

  /** RenderPass → UnrealBloomPass → OutputPass (tone mapping + sRGB). */
  private createPost(): PostChain {
    const s = this.threeSettings;
    // MSAA only at low pixel ratios: at 2× the resolution already smooths
    // edges and multisampled half-float targets get expensive.
    const samples = renderDpr() < 1.5 ? Math.max(0, s.msaaSamples) : 0;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
    });
    const composer = new EffectComposer(this.renderer, target);
    const renderPass = new RenderPass(this.scene, this.rig.camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      s.bloomStrength,
      s.bloomRadius,
      s.bloomThreshold,
    );
    const outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);
    return { composer, passes: [renderPass, bloomPass, outputPass] };
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
      "[ThreeMapRenderer] WebGL context restored — GPU resources are not rebuilt by the prototype",
    );
    this.contextLost = false;
    // Force a fresh resize on the next frame.
    this.appliedPixelRatio = 0;
    this.onContextRestored?.();
  };
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
