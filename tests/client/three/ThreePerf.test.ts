/**
 * The `?three_perf=1` tool: rolling statistics, triangle counting per layer,
 * the GPU timer (EXT_disjoint_timer_query_webgl2, with disjoint handling and
 * a graceful "unsupported"), the monitor's snapshot / `window.__threePerf`
 * and its panel. GPU-independent: everything runs on fakes.
 */
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countTriangles,
  formatPanel,
  GpuTimer,
  hasPerfStats,
  type MeshCount,
  type PerfLayer,
  type PerfRendererInfo,
  RollingWindow,
  type ThreePerfConfig,
  ThreePerfMonitor,
  type ThreePerfSnapshot,
} from "../../../src/client/render/three/ThreePerf";

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

interface FakeQuery {
  id: number;
  available: boolean;
  ns: number;
}

/** Enough of a WebGL2 context for GpuTimer. */
function fakeGl(supported: boolean) {
  let next = 0;
  const state = {
    disjoint: false,
    created: [] as FakeQuery[],
    began: [] as FakeQuery[],
    ended: 0,
    deleted: 0,
    extensionAsked: 0,
  };
  const gl = {
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    getExtension(name: string) {
      if (name !== "EXT_disjoint_timer_query_webgl2") return null;
      state.extensionAsked++;
      return supported ? { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT } : null;
    },
    createQuery(): FakeQuery {
      const q = { id: next++, available: false, ns: 0 };
      state.created.push(q);
      return q;
    },
    beginQuery(target: number, q: FakeQuery) {
      expect(target).toBe(TIME_ELAPSED_EXT);
      state.began.push(q);
    },
    endQuery(target: number) {
      expect(target).toBe(TIME_ELAPSED_EXT);
      state.ended++;
    },
    deleteQuery() {
      state.deleted++;
    },
    getParameter(p: number) {
      return p === GPU_DISJOINT_EXT ? state.disjoint : null;
    },
    getQueryParameter(q: FakeQuery, p: number) {
      return p === gl.QUERY_RESULT_AVAILABLE ? q.available : q.ns;
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, state };
}

function config(): ThreePerfConfig {
  return {
    quality: "high",
    bloom: true,
    antialias: "msaa",
    canvasMsaaSamples: 0,
    targetMsaaSamples: 4,
    fxaa: false,
    composer: true,
    pixelRatio: 1,
    width: 800,
    height: 600,
    reliefVertices: 1000,
    maxTiltDeg: 50,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (globalThis as { __threePerf?: unknown }).__threePerf;
});

describe("RollingWindow", () => {
  it("keeps the last N samples: average, max, p99, last", () => {
    const w = new RollingWindow(4);
    expect(w.stat()).toEqual({ avg: 0, p99: 0, max: 0, last: 0 });
    for (const v of [1, 2, 3, 4, 10]) w.push(v); // 1 drops out
    expect(w.count).toBe(4);
    expect(w.avg()).toBe(4.75);
    expect(w.max()).toBe(10);
    expect(w.last).toBe(10);
    expect(w.percentile(0.99)).toBe(10);
    expect(w.percentile(0.5)).toBe(3);
  });

  it("p99 of 120 frames is the second-worst frame", () => {
    const w = new RollingWindow(120);
    for (let i = 0; i < 120; i++) w.push(i === 7 ? 50 : i === 9 ? 40 : 16);
    expect(w.percentile(0.99)).toBe(40);
    expect(w.max()).toBe(50);
  });
});

describe("countTriangles", () => {
  const material = new THREE.MeshBasicMaterial();

  it("counts indexed, non-indexed and draw-ranged meshes", () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(), material); // 12
    const soup = new THREE.BufferGeometry();
    soup.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(9 * 3), 3),
    );
    const tri3 = new THREE.Mesh(soup, material); // 3
    const ranged = new THREE.Mesh(new THREE.BoxGeometry(), material);
    ranged.geometry.setDrawRange(0, 6); // 2
    const group = new THREE.Group();
    group.add(box, tri3, ranged);
    expect(countTriangles([group])).toEqual({
      triangles: 17,
      meshes: 3,
      instances: 3,
    });
  });

  it("multiplies instanced meshes by what they draw", () => {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 10);
    inst.count = 4; // 48
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute(
      "iOffset",
      new THREE.InstancedBufferAttribute(new Float32Array(30), 3),
    );
    geo.instanceCount = 5; // 2 × 5
    const particles = new THREE.Mesh(geo, material);
    const unbounded = new THREE.InstancedBufferGeometry();
    unbounded.setIndex(quad.getIndex());
    unbounded.setAttribute("position", quad.getAttribute("position"));
    unbounded.setAttribute(
      "iOffset",
      new THREE.InstancedBufferAttribute(new Float32Array(21), 3),
    ); // instanceCount Infinity → 7 from the attribute: 14
    const lines = new THREE.Mesh(unbounded, material);
    const sprite = new THREE.Sprite(); // 2
    const top: MeshCount[] = [];
    inst.name = "ships";
    expect(
      countTriangles([inst, particles, lines, sprite], "units", top),
    ).toEqual({ triangles: 74, meshes: 4, instances: 17 });
    expect(top[0]).toEqual({
      layer: "units",
      name: "ships",
      triangles: 48,
      instances: 4,
      trianglesPerInstance: 12,
    });
  });

  it("skips hidden objects, hidden ancestors, empty instancing and lines", () => {
    const parent = new THREE.Group();
    const root = new THREE.Group();
    parent.add(root);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), material);
    hidden.visible = false;
    const inHidden = new THREE.Group();
    inHidden.visible = false;
    inHidden.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const empty = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 3);
    empty.count = 0;
    const line = new THREE.Line(new THREE.BufferGeometry());
    root.add(hidden, inHidden, empty, line);
    expect(countTriangles([root]).triangles).toBe(0);

    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    expect(countTriangles([root]).triangles).toBe(12);
    parent.visible = false;
    expect(countTriangles([root]).triangles).toBe(0);
  });
});

describe("GpuTimer", () => {
  it("brackets frames with TIME_ELAPSED queries and reads them later", () => {
    const { gl, state } = fakeGl(true);
    const timer = new GpuTimer(gl);
    expect(timer.supported).toBe(true);
    const got: number[] = [];

    timer.begin();
    timer.begin(); // already active: ignored
    timer.end();
    expect(state.began).toHaveLength(1);
    expect(state.ended).toBe(1);

    timer.poll((ms) => got.push(ms));
    expect(got).toEqual([]); // not available yet

    state.began[0].available = true;
    state.began[0].ns = 2_500_000;
    timer.poll((ms) => got.push(ms));
    expect(got).toEqual([2.5]);

    // The query is recycled.
    timer.begin();
    timer.end();
    expect(state.created).toHaveLength(1);
  });

  it("drops every result in flight after a disjoint event", () => {
    const { gl, state } = fakeGl(true);
    const timer = new GpuTimer(gl);
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      timer.begin();
      timer.end();
    }
    for (const q of state.began) {
      q.available = true;
      q.ns = 1e6;
    }
    state.disjoint = true;
    timer.poll((ms) => got.push(ms));
    expect(got).toEqual([]);
    expect(timer.disjointResets).toBe(1);

    state.disjoint = false;
    timer.poll((ms) => got.push(ms));
    expect(got).toEqual([]);
  });

  it("stops timing while too many results are pending, and discards aborted frames", () => {
    const { gl, state } = fakeGl(true);
    const timer = new GpuTimer(gl);
    for (let i = 0; i < 20; i++) {
      timer.begin();
      timer.end();
    }
    expect(state.began).toHaveLength(8);

    const { gl: gl2, state: state2 } = fakeGl(true);
    const t2 = new GpuTimer(gl2);
    t2.begin();
    t2.end(false);
    state2.began[0].available = true;
    const got: number[] = [];
    t2.poll((ms) => got.push(ms));
    expect(got).toEqual([]);
  });

  it("does nothing without the extension", () => {
    const { gl, state } = fakeGl(false);
    const timer = new GpuTimer(gl);
    expect(timer.supported).toBe(false);
    timer.begin();
    timer.end();
    timer.poll(() => {
      throw new Error("no results expected");
    });
    expect(state.began).toHaveLength(0);
    timer.dispose();
  });

  it("re-acquires the extension after a context restore", () => {
    const { gl, state } = fakeGl(true);
    const timer = new GpuTimer(gl);
    timer.begin();
    timer.reset();
    expect(state.extensionAsked).toBe(2);
    timer.begin(); // the stale active query is forgotten
    expect(state.began).toHaveLength(2);
  });
});

describe("ThreePerfMonitor", () => {
  function setup(supported = true) {
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicMaterial();
    const terrainMesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const unitsGroup = new THREE.Group();
    const ships = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      material,
      100,
    );
    ships.count = 10;
    unitsGroup.add(ships);
    const stray = new THREE.Mesh(new THREE.BoxGeometry(), material);
    scene.add(terrainMesh, unitsGroup, stray);
    const unitsLayer = {
      perfStats: () => ({ railRebuilds: 3, railMsAvg: 0.12345 }),
    };
    const layers: PerfLayer[] = [
      { name: "terrain", roots: [terrainMesh], source: {} },
      { name: "units", roots: [unitsGroup], source: unitsLayer },
      { name: "names", roots: [], source: {} },
    ];
    const info: PerfRendererInfo = {
      render: { calls: 33, triangles: 1234 },
      memory: { geometries: 5, textures: 7 },
      programs: [1, 2],
    };
    const { gl, state } = fakeGl(supported);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const monitor = new ThreePerfMonitor({
      gl,
      info: () => info,
      scene,
      layers,
      panelParent: parent,
      config,
    });
    return { monitor, state, parent };
  }

  function frame(
    monitor: ThreePerfMonitor,
    now: number,
    spans: [number, number, number] = [1, 2, 0.5],
  ): void {
    monitor.beginFrame(now);
    monitor.layerUpdate(0, 0.25);
    monitor.layerUpdate(1, 0.75);
    monitor.beginRender();
    monitor.endRender();
    monitor.layerUpdate(2, spans[2]);
    monitor.endFrame(...spans);
  }

  it("summarises frames, layers, calls and GPU time", () => {
    const { monitor, state } = setup();
    monitor.call("updateUnits", 1.5);
    monitor.call("uploadLiveDelta", 0.5);
    frame(monitor, 0);
    frame(monitor, 16);
    state.began[0].available = true;
    state.began[0].ns = 3e6;
    frame(monitor, 32, [2, 4, 1]);

    const s = (globalThis as { __threePerf?: () => ThreePerfSnapshot })
      .__threePerf!();
    expect(s.frames).toBe(3);
    expect(s.windowFrames).toBe(120);
    expect(s.fps).toBe(62.5);
    expect(s.frameMs).toEqual({ avg: 16, p99: 16, max: 16, last: 16 });
    expect(s.jsMs.last).toBe(7);
    expect(s.jsMs.max).toBe(7);
    expect(s.updateMs.last).toBe(2);
    expect(s.renderMs.last).toBe(4);
    expect(s.namesMs.last).toBe(1);
    expect(s.gpu).toEqual({ supported: true, disjointResets: 0 });
    expect(s.gpuMs).toEqual({ avg: 3, p99: 3, max: 3, last: 3 });
    expect(s.drawCalls.last).toBe(33);
    expect(s.triangles.last).toBe(1234);
    expect(s.betweenFramesMs.max).toBe(2);
    expect(s.betweenFramesMs.last).toBe(0);
    expect(s.calls.updateUnits.max).toBe(1.5);
    expect(s.calls.uploadLiveDelta.max).toBe(0.5);

    expect(s.layers.terrain.triangles).toBe(12);
    expect(s.layers.terrain.updateMs.last).toBe(0.25);
    expect(s.layers.units).toMatchObject({
      triangles: 120,
      meshes: 1,
      instances: 10,
      stats: { railRebuilds: 3, railMsAvg: 0.123 },
    });
    expect(s.layers.names.updateMs.last).toBe(1);
    expect(s.layers.other.triangles).toBe(12); // unclaimed scene child
    expect(s.topMeshes[0]).toMatchObject({ layer: "units", triangles: 120 });
    expect(s.memory).toEqual({ geometries: 5, textures: 7, programs: 2 });
    expect(s.config.width).toBe(800);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("times only the draw on the GPU, never outside a frame", () => {
    const { monitor, state } = setup();
    monitor.beginRender(); // no frame in progress: ignored
    expect(state.began).toHaveLength(0);
    monitor.beginFrame(0);
    expect(state.began).toHaveLength(0);
    monitor.beginRender();
    expect(state.began).toHaveLength(1);
    monitor.endRender();
    expect(state.ended).toBe(1);
    monitor.endFrame(1, 1, 1);
    expect(state.ended).toBe(1);
  });

  it("reports GPU time as n/a without the extension", () => {
    const { monitor, parent } = setup(false);
    frame(monitor, 0);
    const s = monitor.snapshot();
    expect(s.gpu.supported).toBe(false);
    expect(s.gpuMs).toBeNull();
    expect(parent.textContent).toContain("three_perf.gpu_na");
  });

  it("shows a click-through panel with translated labels", () => {
    const { monitor, parent } = setup();
    frame(monitor, 0);
    const panel = parent.querySelector<HTMLElement>("#three-perf-panel");
    expect(panel).not.toBeNull();
    expect(panel!.style.pointerEvents).toBe("none");
    const text = panel!.textContent ?? "";
    for (const key of [
      "three_perf.title",
      "three_perf.fps",
      "three_perf.js",
      "three_perf.draws",
      "three_perf.between_frames",
      "three_perf.layers_header",
      "three_perf.layer_line",
    ]) {
      expect(text).toContain(key);
    }
    expect(text).toContain("railRebuilds 3");
  });

  it("drops an aborted frame's GPU query", () => {
    const { monitor, state } = setup();
    monitor.beginFrame(0);
    monitor.layerUpdate(1, 5);
    monitor.beginRender(); // the draw throws before endRender
    monitor.abortFrame();
    monitor.endFrame(1, 1, 1); // ignored: no frame in progress
    state.began[0].available = true;
    state.began[0].ns = 9e6;
    frame(monitor, 16);
    const s = monitor.snapshot();
    expect(s.frames).toBe(1);
    expect(s.gpuMs).toBeNull();
    expect(s.layers.units.updateMs.max).toBe(0.75);
  });

  it("removes its panel and window.__threePerf on dispose", () => {
    const { monitor, parent, state } = setup();
    frame(monitor, 0);
    const g = globalThis as { __threePerf?: unknown };
    expect(typeof g.__threePerf).toBe("function");
    monitor.dispose();
    monitor.dispose();
    expect(g.__threePerf).toBeUndefined();
    expect(parent.querySelector("#three-perf-panel")).toBeNull();
    expect(state.deleted).toBe(1);
  });
});

describe("perf helpers", () => {
  it("detects perfStats providers", () => {
    expect(hasPerfStats({ perfStats: () => ({}) })).toBe(true);
    expect(hasPerfStats({ perfStats: 1 })).toBe(false);
    expect(hasPerfStats(null)).toBe(false);
  });

  it("formats a snapshot without a GPU timer", () => {
    const stat = { avg: 1, p99: 2, max: 3, last: 1 };
    const text = formatPanel({
      frames: 1,
      windowFrames: 120,
      config: { ...config(), fxaa: true },
      fps: 60,
      frameMs: stat,
      jsMs: stat,
      updateMs: stat,
      renderMs: stat,
      namesMs: stat,
      gpuMs: null,
      gpu: { supported: false, disjointResets: 0 },
      drawCalls: stat,
      triangles: stat,
      betweenFramesMs: stat,
      calls: {},
      layers: {},
      topMeshes: [],
      memory: { geometries: 0, textures: 0, programs: 0 },
    });
    expect(text.split("\n")).toHaveLength(7);
    expect(text).toContain("three_perf.gpu_na");
  });
});
