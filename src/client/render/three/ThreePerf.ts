/**
 * Performance tool of the Three.js renderer prototype (`?three_perf=1`).
 *
 * `ThreePerfMonitor` collects, over a rolling window of `PERF_WINDOW` frames:
 * frame interval (FPS, p99), JS time inside the render loop split into
 * update / render / names, per-layer update time, GPU time
 * (`EXT_disjoint_timer_query_webgl2`, "n/a" when the browser lacks it), draw
 * calls and triangles from `renderer.info`, JS time the facade spends in its
 * update calls between frames (simulation ticks), and, sampled on demand,
 * triangles per layer (a walk of each layer's scene roots) plus each layer's
 * own counters (`perfStats()`, see `PerfStatsSource`).
 *
 * It shows a small click-through panel and installs `window.__threePerf()`,
 * which returns the same data as JSON. The facade only creates a monitor when
 * the flag is on: with it off there are no timer queries, no traversal and no
 * DOM.
 */

import type * as THREE from "three";
import { translateText } from "../../Utils";
import type { ThreeAntialias, ThreeQuality } from "./ThreeSettings";

/** Frames in the rolling window (≈ 2 s at 60 FPS). */
export const PERF_WINDOW = 120;
/** How often the on-screen panel is redrawn, ms. */
const PANEL_REFRESH_MS = 500;
/** Timer queries in flight before new frames go untimed. */
const MAX_PENDING_QUERIES = 8;
/** Meshes listed in `topMeshes`. */
const TOP_MESHES = 12;

/**
 * Contract for a layer's own counters. A layer object (or anything else the
 * facade registers) that has `perfStats()` gets its result included, under
 * its layer name, in the panel and in `__threePerf().layers[name].stats`.
 *
 * - Called at most a few times a second (panel refresh, `__threePerf()`),
 *   never per frame. Keep it cheap and free of side effects: do not reset
 *   counters on read (two readers share it).
 * - Values are plain numbers: cumulative counters (`railRebuilds`), current
 *   sizes (`railInstances`, `texelsPending`) or the layer's own recent
 *   averages / maxima (`railMsAvg`, `railMsMax`). Name time values with an
 *   `Ms` suffix.
 * - Instrumentation that costs anything per frame should run only when
 *   `ctx.settings.perf` is true.
 */
export interface PerfStatsSource {
  perfStats(): Record<string, number>;
}

export function hasPerfStats(value: unknown): value is PerfStatsSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<PerfStatsSource>).perfStats === "function"
  );
}

/** Layer names, in frame order. */
export type PerfLayerName =
  | "environment"
  | "terrain"
  | "water"
  | "structures"
  | "units"
  | "overlay"
  | "fx"
  | "names";

/** A layer as the monitor sees it. */
export interface PerfLayer {
  readonly name: PerfLayerName;
  /** Scene children the layer added; walked for triangle counts. */
  readonly roots: readonly THREE.Object3D[];
  /** The layer object, asked for `perfStats()` if it has one. */
  readonly source: object;
}

/** Rolling summary of one per-frame quantity. */
export interface PerfStat {
  avg: number;
  p99: number;
  max: number;
  /** Value of the most recent frame. */
  last: number;
}

/** What `renderer.info` offers (only the fields read here). */
export interface PerfRendererInfo {
  readonly render: { readonly calls: number; readonly triangles: number };
  readonly memory: { readonly geometries: number; readonly textures: number };
  readonly programs: readonly unknown[] | null;
}

/** Fixed facts about the renderer, reported with every snapshot. */
export interface ThreePerfConfig {
  quality: ThreeQuality;
  bloom: boolean;
  antialias: ThreeAntialias;
  /** Samples of the multisampled canvas (0 = not multisampled). */
  canvasMsaaSamples: number;
  /** Samples of the post-processing target (0 = none, or no composer). */
  targetMsaaSamples: number;
  fxaa: boolean;
  composer: boolean;
  pixelRatio: number;
  /** Backing-store size, device px. */
  width: number;
  height: number;
  reliefVertices: number;
  maxTiltDeg: number;
}

export interface ThreePerfLayerSnapshot {
  /** Triangles of the layer's visible meshes (frustum culling ignored). */
  triangles: number;
  /** Visible meshes with at least one triangle. */
  meshes: number;
  /** Instances drawn by those meshes (1 for a plain mesh). */
  instances: number;
  updateMs: PerfStat;
  /** The layer's `perfStats()`, or {} without one. */
  stats: Record<string, number>;
}

export interface MeshCount {
  layer: string;
  /** Object name, else `<parent name>/<type>`. */
  name: string;
  triangles: number;
  instances: number;
  trianglesPerInstance: number;
}

/** What `window.__threePerf()` returns. Times in ms. */
export interface ThreePerfSnapshot {
  /** Frames in the rolling window so far (at most `windowFrames`). */
  frames: number;
  windowFrames: number;
  config: ThreePerfConfig;
  /** Average frames per second over the window. */
  fps: number;
  /** Frame-to-frame interval (what the player feels; p99 = hitches). */
  frameMs: PerfStat;
  /** JS inside the render loop: update + render + names. */
  jsMs: PerfStat;
  /** Resize, camera and every layer's `update`. */
  updateMs: PerfStat;
  /** `composer.render` (or `renderer.render` without post-processing). */
  renderMs: PerfStat;
  /** DOM labels (`NameLayer.update`). */
  namesMs: PerfStat;
  /** GPU time of the frame; null when unsupported or no result yet. */
  gpuMs: PerfStat | null;
  gpu: { supported: boolean; disjointResets: number };
  drawCalls: PerfStat;
  /** Triangles actually submitted (`renderer.info`), post passes included. */
  triangles: PerfStat;
  /** JS in the facade's update calls between two frames (ticks, input). */
  betweenFramesMs: PerfStat;
  /** The same, per facade method (ms per frame). */
  calls: Record<string, PerfStat>;
  layers: Record<string, ThreePerfLayerSnapshot>;
  /** Heaviest visible meshes by triangles. */
  topMeshes: MeshCount[];
  memory: { geometries: number; textures: number; programs: number };
}

// ---- Rolling window ----

/** Fixed-size ring of samples; no allocation per push. */
export class RollingWindow {
  private readonly buf: Float64Array;
  private readonly scratch: Float64Array;
  private n = 0;
  private next = 0;
  last = 0;

  constructor(readonly size: number = PERF_WINDOW) {
    this.buf = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }

  get count(): number {
    return this.n;
  }

  push(v: number): void {
    this.buf[this.next] = v;
    this.next = (this.next + 1) % this.size;
    if (this.n < this.size) this.n++;
    this.last = v;
  }

  clear(): void {
    this.n = 0;
    this.next = 0;
    this.last = 0;
  }

  avg(): number {
    if (this.n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.n; i++) sum += this.buf[i];
    return sum / this.n;
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.buf[i] > m) m = this.buf[i];
    return m;
  }

  /** Nearest-rank percentile, p in [0, 1]. */
  percentile(p: number): number {
    if (this.n === 0) return 0;
    const s = this.scratch.subarray(0, this.n);
    s.set(this.buf.subarray(0, this.n));
    s.sort();
    const rank = Math.min(this.n, Math.max(1, Math.ceil(p * this.n)));
    return s[rank - 1];
  }

  stat(): PerfStat {
    return {
      avg: round3(this.avg()),
      p99: round3(this.percentile(0.99)),
      max: round3(this.max()),
      last: round3(this.last),
    };
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---- Triangle counting ----

export interface TriangleCount {
  triangles: number;
  meshes: number;
  instances: number;
}

type CountedGeometry = THREE.BufferGeometry & {
  isInstancedBufferGeometry?: boolean;
  instanceCount?: number;
  _maxInstanceCount?: number;
};

/** Triangles one instance of `geometry` draws (index or position / 3). */
function trianglesPerInstance(geometry: THREE.BufferGeometry): number {
  const index = geometry.index;
  const position = geometry.getAttribute("position") as
    | THREE.BufferAttribute
    | THREE.InterleavedBufferAttribute
    | undefined;
  const count = index !== null ? index.count : (position?.count ?? 0);
  const start = Math.max(0, geometry.drawRange.start);
  const end = Math.min(count, start + geometry.drawRange.count);
  return Math.max(0, Math.floor((end - start) / 3));
}

/** Instances an InstancedBufferGeometry draws, as three resolves it. */
function geometryInstances(geometry: CountedGeometry): number {
  let max = geometry._maxInstanceCount ?? Infinity;
  if (!Number.isFinite(max)) {
    for (const attr of Object.values(geometry.attributes)) {
      const a = attr as {
        isInstancedBufferAttribute?: boolean;
        meshPerAttribute?: number;
        count: number;
        data?: {
          isInstancedInterleavedBuffer?: boolean;
          meshPerAttribute?: number;
          count: number;
        };
      };
      if (a.isInstancedBufferAttribute) {
        max = Math.min(max, a.count * (a.meshPerAttribute ?? 1));
      } else if (a.data?.isInstancedInterleavedBuffer) {
        max = Math.min(max, a.data.count * (a.data.meshPerAttribute ?? 1));
      }
    }
  }
  const n = Math.min(geometry.instanceCount ?? Infinity, max);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * Triangles of the visible meshes under `roots` (an object counts when it and
 * all its ancestors are visible; frustum culling is ignored). A plain mesh
 * counts index (or position) count / 3 within its draw range, an
 * InstancedMesh multiplies by `count`, an InstancedBufferGeometry by its
 * instance count, and a sprite counts 2. Lines and points count 0.
 *
 * When `top` is given, one entry per counted mesh is appended to it.
 */
export function countTriangles(
  roots: readonly THREE.Object3D[],
  layer = "",
  top?: MeshCount[],
): TriangleCount {
  const out: TriangleCount = { triangles: 0, meshes: 0, instances: 0 };
  for (const root of roots) {
    if (!ancestorsVisible(root)) continue;
    root.traverseVisible((obj) => {
      let perInstance = 0;
      let instances = 1;
      const mesh = obj as THREE.Mesh & {
        isInstancedMesh?: boolean;
        count?: number;
        isSprite?: boolean;
      };
      if (mesh.isMesh === true) {
        const geometry = mesh.geometry as CountedGeometry;
        perInstance = trianglesPerInstance(geometry);
        if (mesh.isInstancedMesh === true) instances = mesh.count ?? 0;
        else if (geometry.isInstancedBufferGeometry === true) {
          instances = geometryInstances(geometry);
        }
      } else if (mesh.isSprite === true) {
        perInstance = 2;
      } else {
        return;
      }
      const triangles = perInstance * instances;
      if (triangles <= 0) return;
      out.triangles += triangles;
      out.meshes++;
      out.instances += instances;
      top?.push({
        layer,
        name:
          obj.name ||
          `${obj.parent?.name ? `${obj.parent.name}/` : ""}${obj.type}`,
        triangles,
        instances,
        trianglesPerInstance: perInstance,
      });
    });
  }
  return out;
}

function ancestorsVisible(obj: THREE.Object3D): boolean {
  for (let o = obj.parent; o !== null; o = o.parent) {
    if (!o.visible) return false;
  }
  return true;
}

// ---- GPU timer ----

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/**
 * GPU time per frame with `EXT_disjoint_timer_query_webgl2`. One
 * TIME_ELAPSED query brackets a frame; results arrive a few frames later and
 * are read with `poll`. A disjoint event (GPU clock change, context switch)
 * invalidates every result in flight, which are then dropped.
 */
export class GpuTimer {
  private ext: TimerQueryExt | null = null;
  private readonly free: WebGLQuery[] = [];
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  disjointResets = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.acquire();
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  /** Starts timing a frame (skipped while too many results are pending). */
  begin(): void {
    if (this.ext === null || this.active !== null) return;
    if (this.pending.length >= MAX_PENDING_QUERIES) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    if (query === null) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  /** Ends the frame's query. `keep` false discards it (failed frame). */
  end(keep = true): void {
    if (this.ext === null || this.active === null) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    (keep ? this.pending : this.free).push(this.active);
    this.active = null;
  }

  /** Hands every result that became available to `sink`, in ms. */
  poll(sink: (ms: number) => void): void {
    if (this.ext === null || this.pending.length === 0) return;
    const gl = this.gl;
    // Results arrive in order: nothing to read until the oldest is ready.
    if (!gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      return;
    }
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.disjointResets++;
      this.free.push(...this.pending);
      this.pending.length = 0;
      return;
    }
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
      this.pending.shift();
      this.free.push(query);
      sink(ns / 1e6);
    }
  }

  /** After a context restore: the old queries died with the old context. */
  reset(): void {
    this.free.length = 0;
    this.pending.length = 0;
    this.active = null;
    this.acquire();
  }

  dispose(): void {
    if (this.ext !== null && this.active !== null) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.free.push(this.active);
    }
    this.active = null;
    for (const q of [...this.free, ...this.pending]) this.gl.deleteQuery(q);
    this.free.length = 0;
    this.pending.length = 0;
    this.ext = null;
  }

  private acquire(): void {
    try {
      this.ext = this.gl.getExtension(
        "EXT_disjoint_timer_query_webgl2",
      ) as TimerQueryExt | null;
    } catch {
      this.ext = null;
    }
  }
}

// ---- Monitor ----

/** en.json keys of the layer names shown on the panel. */
const LAYER_LABEL_KEYS: Record<PerfLayerName, string> = {
  environment: "three_perf.layer_environment",
  terrain: "three_perf.layer_terrain",
  water: "three_perf.layer_water",
  structures: "three_perf.layer_structures",
  units: "three_perf.layer_units",
  overlay: "three_perf.layer_overlay",
  fx: "three_perf.layer_fx",
  names: "three_perf.layer_names",
};

/** Name of the bucket for scene children no layer claimed. */
const OTHER_LAYER = "other";

export interface ThreePerfOptions {
  gl: WebGL2RenderingContext;
  /**
   * The renderer's current `info`. A getter, not the object: three replaces
   * `renderer.info` when a lost context is restored.
   */
  info: () => PerfRendererInfo;
  scene: THREE.Object3D;
  /** In frame order; `layerUpdate(i, …)` indexes this list. */
  layers: readonly PerfLayer[];
  /** Where the panel goes; null for none (tests). */
  panelParent: HTMLElement | null;
  /** Current renderer facts (sizes can change between snapshots). */
  config: () => ThreePerfConfig;
}

type GlobalWithPerf = typeof globalThis & {
  __threePerf?: () => ThreePerfSnapshot;
};

export class ThreePerfMonitor {
  private readonly frameMs = new RollingWindow();
  private readonly jsMs = new RollingWindow();
  private readonly updateMs = new RollingWindow();
  private readonly renderMs = new RollingWindow();
  private readonly namesMs = new RollingWindow();
  private readonly gpuMs = new RollingWindow();
  private readonly drawCalls = new RollingWindow();
  private readonly triangles = new RollingWindow();
  private readonly betweenMs = new RollingWindow();
  private readonly layerMs: RollingWindow[];
  private readonly layerPending: Float64Array;
  private readonly calls = new Map<
    string,
    { window: RollingWindow; pending: number }
  >();
  private betweenPending = 0;
  private readonly gpu: GpuTimer;
  private readonly panel: HTMLPreElement | null;
  private readonly snapshotFn = (): ThreePerfSnapshot => this.snapshot();
  private readonly pushGpu = (ms: number): void => this.gpuMs.push(ms);
  private lastFrameStart = -1;
  private lastPanelMs = -Infinity;
  private inFrame = false;
  private disposed = false;

  constructor(private readonly opts: ThreePerfOptions) {
    this.layerMs = opts.layers.map(() => new RollingWindow());
    this.layerPending = new Float64Array(opts.layers.length);
    this.gpu = new GpuTimer(opts.gl);
    this.panel = opts.panelParent ? createPanel(opts.panelParent) : null;
    (globalThis as GlobalWithPerf).__threePerf = this.snapshotFn;
  }

  /** Start of a frame. Collects the GPU times that became available. */
  beginFrame(nowMs: number): void {
    if (this.lastFrameStart >= 0)
      this.frameMs.push(nowMs - this.lastFrameStart);
    this.lastFrameStart = nowMs;
    this.gpu.poll(this.pushGpu);
    this.inFrame = true;
  }

  /**
   * Brackets the frame's draw (`composer.render` / `renderer.render`, where
   * three also uploads the textures and buffers marked for update) with the
   * GPU timer. The layers' JS before it stays out, so the GPU never idles
   * inside the bracket waiting for it.
   */
  beginRender(): void {
    if (this.inFrame) this.gpu.begin();
  }

  endRender(): void {
    this.gpu.end();
  }

  /** Time spent in `layers[index].update` this frame. */
  layerUpdate(index: number, ms: number): void {
    this.layerPending[index] += ms;
  }

  /** JS time of a facade method called outside the frame loop. */
  call(name: string, ms: number): void {
    let entry = this.calls.get(name);
    if (entry === undefined) {
      entry = { window: new RollingWindow(), pending: 0 };
      this.calls.set(name, entry);
    }
    entry.pending += ms;
    this.betweenPending += ms;
  }

  /** End of a frame that completed; spans in ms. */
  endFrame(updateMs: number, renderMs: number, namesMs: number): void {
    if (!this.inFrame) return;
    this.inFrame = false;
    this.gpu.end(); // no-op unless endRender was skipped
    this.updateMs.push(updateMs);
    this.renderMs.push(renderMs);
    this.namesMs.push(namesMs);
    this.jsMs.push(updateMs + renderMs + namesMs);
    const info = this.opts.info();
    this.drawCalls.push(info.render.calls);
    this.triangles.push(info.render.triangles);
    for (let i = 0; i < this.layerMs.length; i++) {
      this.layerMs[i].push(this.layerPending[i]);
      this.layerPending[i] = 0;
    }
    this.betweenMs.push(this.betweenPending);
    this.betweenPending = 0;
    for (const entry of this.calls.values()) {
      entry.window.push(entry.pending);
      entry.pending = 0;
    }
    if (
      this.panel !== null &&
      this.lastFrameStart - this.lastPanelMs >= PANEL_REFRESH_MS
    ) {
      this.lastPanelMs = this.lastFrameStart;
      this.panel.textContent = formatPanel(this.snapshot());
    }
  }

  /** The frame threw: drop its GPU query and per-layer partial times. */
  abortFrame(): void {
    if (!this.inFrame) return;
    this.inFrame = false;
    this.gpu.end(false);
    this.layerPending.fill(0);
  }

  /** A lost context came back: timer queries must be recreated. */
  contextRestored(): void {
    this.inFrame = false;
    this.gpu.reset();
  }

  snapshot(): ThreePerfSnapshot {
    const { layers, scene } = this.opts;
    const info = this.opts.info();
    const top: MeshCount[] = [];
    const out: Record<string, ThreePerfLayerSnapshot> = {};
    const claimed = new Set<THREE.Object3D>();
    layers.forEach((layer, i) => {
      for (const root of layer.roots) claimed.add(root);
      out[layer.name] = {
        ...countTriangles(layer.roots, layer.name, top),
        updateMs: this.layerMs[i].stat(),
        stats: readPerfStats(layer.source),
      };
    });
    const others = scene.children.filter((c) => !claimed.has(c));
    if (others.length > 0) {
      const counted = countTriangles(others, OTHER_LAYER, top);
      if (counted.triangles > 0) {
        out[OTHER_LAYER] = {
          ...counted,
          updateMs: new RollingWindow(1).stat(),
          stats: {},
        };
      }
    }
    top.sort((a, b) => b.triangles - a.triangles);
    const calls: Record<string, PerfStat> = {};
    for (const [name, entry] of this.calls) calls[name] = entry.window.stat();
    const frameAvg = this.frameMs.avg();
    return {
      frames: this.jsMs.count,
      windowFrames: PERF_WINDOW,
      config: this.opts.config(),
      fps: frameAvg > 0 ? round3(1000 / frameAvg) : 0,
      frameMs: this.frameMs.stat(),
      jsMs: this.jsMs.stat(),
      updateMs: this.updateMs.stat(),
      renderMs: this.renderMs.stat(),
      namesMs: this.namesMs.stat(),
      gpuMs: this.gpuMs.count > 0 ? this.gpuMs.stat() : null,
      gpu: {
        supported: this.gpu.supported,
        disjointResets: this.gpu.disjointResets,
      },
      drawCalls: this.drawCalls.stat(),
      triangles: this.triangles.stat(),
      betweenFramesMs: this.betweenMs.stat(),
      calls,
      layers: out,
      topMeshes: top.slice(0, TOP_MESHES),
      memory: {
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gpu.dispose();
    this.panel?.remove();
    const g = globalThis as GlobalWithPerf;
    if (g.__threePerf === this.snapshotFn) delete g.__threePerf;
  }
}

function readPerfStats(source: object): Record<string, number> {
  if (!hasPerfStats(source)) return {};
  try {
    const stats = source.perfStats();
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === "number") out[key] = round3(value);
    }
    return out;
  } catch (err) {
    console.warn("[ThreePerf] perfStats() failed", err);
    return {};
  }
}

// ---- Panel ----

function createPanel(parent: HTMLElement): HTMLPreElement {
  const panel = document.createElement("pre");
  panel.id = "three-perf-panel";
  const st = panel.style;
  st.position = "absolute";
  st.left = "8px";
  st.bottom = "8px";
  st.margin = "0";
  st.padding = "6px 8px";
  st.maxWidth = "min(420px, calc(100vw - 16px))";
  st.whiteSpace = "pre-wrap";
  st.font =
    "11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  st.color = "#e8f0e8";
  st.background = "rgba(10, 14, 20, 0.72)";
  st.borderRadius = "4px";
  st.pointerEvents = "none";
  st.userSelect = "none";
  parent.appendChild(panel);
  return panel;
}

function ms(v: number): string {
  return v < 10 ? v.toFixed(2) : v.toFixed(1);
}

function count(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function qualityLabel(q: ThreeQuality): string {
  return q === "low"
    ? translateText("three_perf.quality_low")
    : translateText("three_perf.quality_high");
}

function antialiasLabel(c: ThreePerfConfig): string {
  if (c.fxaa) return translateText("three_perf.aa_fxaa");
  const samples = c.canvasMsaaSamples || c.targetMsaaSamples;
  if (samples > 0) {
    return translateText("three_perf.aa_msaa", { samples: String(samples) });
  }
  return translateText("three_perf.aa_off");
}

function layerLabel(name: string): string {
  const key = LAYER_LABEL_KEYS[name as PerfLayerName];
  return key !== undefined
    ? translateText(key)
    : translateText("three_perf.layer_other");
}

/** The panel's text for a snapshot. */
export function formatPanel(s: ThreePerfSnapshot): string {
  const c = s.config;
  const lines = [
    translateText("three_perf.title", {
      quality: qualityLabel(c.quality),
      bloom: c.bloom
        ? translateText("three_perf.bloom_on")
        : translateText("three_perf.bloom_off"),
      aa: antialiasLabel(c),
    }),
    translateText("three_perf.fps", {
      fps: s.fps.toFixed(1),
      avg: ms(s.frameMs.avg),
      p99: ms(s.frameMs.p99),
    }),
    translateText("three_perf.js", {
      total: ms(s.jsMs.avg),
      update: ms(s.updateMs.avg),
      render: ms(s.renderMs.avg),
      names: ms(s.namesMs.avg),
      max: ms(s.jsMs.max),
    }),
    s.gpuMs !== null
      ? translateText("three_perf.gpu", {
          avg: ms(s.gpuMs.avg),
          p99: ms(s.gpuMs.p99),
        })
      : translateText("three_perf.gpu_na"),
    translateText("three_perf.draws", {
      calls: String(Math.round(s.drawCalls.last)),
      triangles: count(s.triangles.last),
    }),
    translateText("three_perf.between_frames", {
      avg: ms(s.betweenFramesMs.avg),
      max: ms(s.betweenFramesMs.max),
    }),
    translateText("three_perf.layers_header"),
  ];
  for (const [name, layer] of Object.entries(s.layers)) {
    let line = translateText("three_perf.layer_line", {
      layer: layerLabel(name),
      triangles: count(layer.triangles),
      avg: ms(layer.updateMs.avg),
      max: ms(layer.updateMs.max),
    });
    const extra = Object.entries(layer.stats)
      .map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`)
      .join(" · ");
    if (extra !== "") line += `\n    ${extra}`;
    lines.push(line);
  }
  return lines.join("\n");
}
