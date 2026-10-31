import { Cell } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { describe, expect, it } from "vitest";
import { ZoomEvent } from "../../../src/client/InputHandler";
import {
  CameraRig,
  smoothstep,
  tiltForZoom,
} from "../../../src/client/render/three/CameraRig";
import { HeightField } from "../../../src/client/render/three/HeightField";
import { defaultThreeSettings } from "../../../src/client/render/three/ThreeSettings";
import type { CameraInputs } from "../../../src/client/render/three/types";
import {
  type MapProjector,
  TransformHandler,
} from "../../../src/client/TransformHandler";
import type { GameView } from "../../../src/client/view";

const MAP_W = 400;
const MAP_H = 300;
const CSS_W = 1280;
const CSS_H = 720;

function makeHandler(): TransformHandler {
  const game = {
    width: () => MAP_W,
    height: () => MAP_H,
    myPlayer: () => null,
  } as unknown as GameView;
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: CSS_W,
      bottom: CSS_H,
      x: 0,
      y: 0,
      width: CSS_W,
      height: CSS_H,
    }) as DOMRect;
  return new TransformHandler(game, new EventBus(), el);
}

/** The camera inputs ClientGameRunner derives from a TransformHandler. */
function inputsOf(th: TransformHandler): CameraInputs {
  const s = th.scale;
  return {
    centerX: th.offsetX + MAP_W / 2 + (CSS_W - MAP_W) / (2 * s),
    centerY: th.offsetY + MAP_H / 2 + (CSS_H - MAP_H) / (2 * s),
    cssPxPerTile: s,
    cssWidth: CSS_W,
    cssHeight: CSS_H,
  };
}

function projectorFor(rig: CameraRig, th: TransformHandler): MapProjector {
  return {
    canvasToWorld: (x, y) => {
      rig.updatePose(inputsOf(th));
      return rig.canvasToWorld(x, y);
    },
    worldToCanvas: (x, y) => {
      rig.updatePose(inputsOf(th));
      return rig.worldToCanvas(x, y);
    },
  };
}

/** Deterministic bumpy terrain: land with magnitudes 0..30 and some water. */
function bumpyTerrain(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.sin(x * 0.11) * Math.cos(y * 0.07) + 0.3;
      bytes[y * w + x] =
        v > 0 ? 0x80 | Math.min(30, Math.round(v * 30)) : Math.round(-v * 10);
    }
  }
  return bytes;
}

function expectClose(actual: number, expected: number, rel = 1e-6): void {
  const tol = rel * Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

describe("tilt curve", () => {
  const s = defaultThreeSettings();
  const maxTilt = (s.maxTiltDeg * Math.PI) / 180;

  it("is exactly top-down at and below tiltStartZoom", () => {
    expect(tiltForZoom(0.2, s)).toBe(0);
    expect(tiltForZoom(s.tiltStartZoom, s)).toBe(0);
  });

  it("reaches maxTilt at tiltEndZoom and stays there", () => {
    expect(tiltForZoom(s.tiltEndZoom, s)).toBeCloseTo(maxTilt, 12);
    expect(tiltForZoom(20, s)).toBeCloseTo(maxTilt, 12);
  });

  it("rises monotonically in between", () => {
    let prev = 0;
    for (let z = s.tiltStartZoom + 0.5; z < s.tiltEndZoom; z += 0.5) {
      const t = tiltForZoom(z, s);
      expect(t).toBeGreaterThan(prev);
      expect(t).toBeLessThan(maxTilt);
      prev = t;
    }
  });

  it("smoothstep has the Hermite endpoints and midpoint", () => {
    expect(smoothstep(2, 4, 1)).toBe(0);
    expect(smoothstep(2, 4, 3)).toBe(0.5);
    expect(smoothstep(2, 4, 5)).toBe(1);
  });
});

describe("CameraRig at tilt 0 over flat ground", () => {
  const settings = defaultThreeSettings();
  // Zoom below tiltStartZoom → tilt 0.
  const views = [
    { scale: 1.8, offsetX: -350, offsetY: -200 },
    { scale: 0.6, offsetX: -733.3, offsetY: -350 },
    { scale: 2.4, offsetX: -153, offsetY: -67.5 },
  ];
  const flatField = new HeightField(MAP_W, MAP_H, bumpyTerrain(MAP_W, MAP_H), {
    heightScale: 0,
    seabedDepth: 0,
    targetVertices: 50_000,
  });

  for (const surface of [null, flatField]) {
    for (const v of views) {
      it(`matches TransformHandler's 2D math (scale ${v.scale}, ${surface ? "flat field" : "plane"})`, () => {
        const th = makeHandler();
        th.scale = v.scale;
        th.offsetX = v.offsetX;
        th.offsetY = v.offsetY;
        const rig = new CameraRig(settings, MAP_W, MAP_H, surface);
        rig.update(inputsOf(th));
        expect(rig.tilt).toBe(0);

        let checked = 0;
        for (let px = 0; px <= CSS_W; px += 41) {
          for (let py = 0; py <= CSS_H; py += 29) {
            const expected = th.screenToWorldCoordinatesFloat(px, py);
            const got = rig.canvasToWorld(px, py);
            const inMap =
              expected.x >= 0 &&
              expected.x <= MAP_W &&
              expected.y >= 0 &&
              expected.y <= MAP_H;
            if (!inMap) {
              expect(got).toBeNull();
              continue;
            }
            expect(got).not.toBeNull();
            expectClose(got!.x, expected.x);
            expectClose(got!.y, expected.y);
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(10);

        for (const [wx, wy] of [
          [0, 0],
          [123.5, 77.25],
          [MAP_W, MAP_H],
          [-20, 400],
        ]) {
          const expected = th.worldToCanvasCoordinates(new Cell(wx, wy));
          const got = rig.worldToCanvas(wx, wy);
          expectClose(got.x, expected.x);
          expectClose(got.y, expected.y);
        }
      });
    }
  }

  it("leaves TransformHandler's results unchanged when installed as its projector", () => {
    const plain = makeHandler();
    const projected = makeHandler();
    projected.projector = projectorFor(
      new CameraRig(settings, MAP_W, MAP_H, null),
      projected,
    );
    for (const th of [plain, projected]) {
      th.scale = 2;
      th.offsetX = -100;
      th.offsetY = -50;
    }
    for (const [sx, sy] of [
      [640, 360],
      [200, 500],
      [780, 100],
    ]) {
      const a = plain.screenToWorldCoordinatesFloat(sx, sy);
      const b = projected.screenToWorldCoordinatesFloat(sx, sy);
      expectClose(b.x, a.x);
      expectClose(b.y, a.y);
    }
    // Zooming (still below the tilt threshold) pivots identically.
    plain.onZoom(new ZoomEvent(300, 200, -60));
    projected.onZoom(new ZoomEvent(300, 200, -60));
    expectClose(projected.scale, plain.scale);
    expectClose(projected.offsetX, plain.offsetX);
    expectClose(projected.offsetY, plain.offsetY);
  });
});

describe("CameraRig under tilt over relief", () => {
  const settings = defaultThreeSettings();
  const field = new HeightField(MAP_W, MAP_H, bumpyTerrain(MAP_W, MAP_H), {
    heightScale: settings.heightScale,
    seabedDepth: settings.seabedDepth,
    targetVertices: 50_000,
  });
  const inputs: CameraInputs = {
    centerX: 180,
    centerY: 140,
    cssPxPerTile: 14,
    cssWidth: CSS_W,
    cssHeight: CSS_H,
  };

  it("is tilted at high zoom", () => {
    const rig = new CameraRig(settings, MAP_W, MAP_H, field);
    rig.update(inputs);
    expect(rig.tilt).toBeCloseTo((settings.maxTiltDeg * Math.PI) / 180, 9);
  });

  it("round-trips canvas → world → canvas", () => {
    const rig = new CameraRig(settings, MAP_W, MAP_H, field);
    rig.update(inputs);
    let checked = 0;
    for (let px = 0; px <= CSS_W; px += 64) {
      for (let py = 0; py <= CSS_H; py += 48) {
        const w = rig.canvasToWorld(px, py);
        if (w === null) continue;
        const back = rig.worldToCanvas(w.x, w.y);
        expect(Math.abs(back.x - px)).toBeLessThan(1e-3);
        expect(Math.abs(back.y - py)).toBeLessThan(1e-3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("keeps north up and the screen centre on the target", () => {
    const rig = new CameraRig(settings, MAP_W, MAP_H, null);
    rig.update(inputs);
    const c = rig.canvasToWorld(CSS_W / 2, CSS_H / 2)!;
    expectClose(c.x, inputs.centerX);
    expectClose(c.y, inputs.centerY);
    const up = rig.canvasToWorld(CSS_W / 2, CSS_H / 4)!;
    expect(up.y).toBeLessThan(c.y);
    expectClose(up.x, inputs.centerX);
    // three's own projection agrees with the double-precision math.
    const v = rig.camera.position.clone();
    v.set(150, field.surfaceAt(150, 120), 120).project(rig.camera);
    const p = rig.worldToCanvas(150, 120, field.surfaceAt(150, 120));
    expect(Math.abs((v.x * 0.5 + 0.5) * CSS_W - p.x)).toBeLessThan(
      1e-6 * CSS_W,
    );
    expect(Math.abs((-v.y * 0.5 + 0.5) * CSS_H - p.y)).toBeLessThan(
      1e-6 * CSS_H,
    );
  });

  it("returns null off the map", () => {
    const rig = new CameraRig(settings, MAP_W, MAP_H, field);
    rig.update({ ...inputs, centerX: 2, centerY: 2 });
    expect(rig.canvasToWorld(0, CSS_H)).toBeNull();
  });

  it("re-pins the world point under the cursor when zooming", () => {
    const th = makeHandler();
    // Canvas centre on world (200, 150).
    th.scale = 10;
    th.offsetX = -44;
    th.offsetY = -21;
    th.projector = projectorFor(
      new CameraRig(settings, MAP_W, MAP_H, field),
      th,
    );
    const [sx, sy] = [900, 250];
    const before = th.screenToWorldCoordinatesFloat(sx, sy);
    expect(Number.isFinite(before.x)).toBe(true);
    th.onZoom(new ZoomEvent(sx, sy, -120)); // zoom in, tilt increases
    const after = th.screenToWorldCoordinatesFloat(sx, sy);
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.01);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.01);
  });
});
