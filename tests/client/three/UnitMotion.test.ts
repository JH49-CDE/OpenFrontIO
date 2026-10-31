import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { trajectoryPoints } from "../../../src/client/render/three/OverlayLayer";
import {
  constructionScale,
  structureLevelScale,
} from "../../../src/client/render/three/StructureLayer";
import {
  MAX_MIN_SIZE_SCALE,
  minScreenScale,
  MIRV_CLIMB_TILES,
  MIRV_CRUISE_ALTITUDE,
  nukeAltitude,
  nukeArcHeight,
  NukeFlight,
  nukeProgress,
  smoothAngle,
  tickEase,
  wrapAngle,
} from "../../../src/client/render/three/UnitLayer";
import type { NukeTrajectoryData } from "../../../src/client/render/types";
import { UT_CITY, UT_FACTORY } from "../../../src/client/render/types";

describe("wrapAngle / smoothAngle", () => {
  it("wraps into [-π, π)", () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(-Math.PI);
    expect(wrapAngle(-Math.PI / 2 - 4 * Math.PI)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(7)).toBeCloseTo(7 - 2 * Math.PI);
  });

  it("turns along the shorter arc across ±π", () => {
    const from = Math.PI - 0.1;
    const to = -Math.PI + 0.1; // 0.2 rad away through π, not 6.08 rad back
    const out = smoothAngle(from, to, 1000, 100); // ~fully converged
    expect(Math.abs(wrapAngle(out - to))).toBeLessThan(1e-3);
    const half = smoothAngle(from, to, 69.3147, 100); // ln 2 · τ → halfway
    expect(wrapAngle(half - from)).toBeCloseTo(0.1, 3);
  });

  it("is frame-rate independent", () => {
    const one = smoothAngle(0, 1, 32, 120);
    const two = smoothAngle(smoothAngle(0, 1, 16, 120), 1, 16, 120);
    expect(two).toBeCloseTo(one, 10);
  });

  it("snaps when tau ≤ 0 and ignores negative dt", () => {
    expect(smoothAngle(0.3, 1.2, 16, 0)).toBeCloseTo(1.2);
    expect(smoothAngle(0.3, 1.2, -50, 100)).toBeCloseTo(0.3);
  });
});

describe("minScreenScale", () => {
  it("is 1 when the model is already big enough", () => {
    expect(minScreenScale(10, 4, 11)).toBe(1);
    expect(minScreenScale(10, 1, 10)).toBe(1);
  });

  it("scales up to the minimum pixel size when zoomed out", () => {
    // 5 tiles at 0.5 px/tile = 2.5 px → ×4 to reach 10 px.
    expect(minScreenScale(10, 0.5, 5)).toBeCloseTo(4);
    // Resulting on-screen size equals the minimum.
    const s = minScreenScale(14, 0.3, 8.64);
    expect(s * 0.3 * 8.64).toBeCloseTo(14);
  });

  it("is capped (and safe at zero zoom)", () => {
    expect(minScreenScale(10, 0.001, 1)).toBe(MAX_MIN_SIZE_SCALE);
    expect(minScreenScale(10, 0, 5)).toBe(MAX_MIN_SIZE_SCALE);
    expect(minScreenScale(10, 0.001, 1, 7)).toBe(7);
  });
});

describe("nuke altitude model", () => {
  it("clamps the arc height to [15, 120] (0.3 × span)", () => {
    expect(nukeArcHeight(10)).toBe(15);
    expect(nukeArcHeight(200)).toBeCloseTo(60);
    expect(nukeArcHeight(1000)).toBe(120);
  });

  it("progress = dO / (dO + dT), equal to dist ratio on a straight path", () => {
    expect(nukeProgress(0, 50)).toBe(0);
    expect(nukeProgress(50, 0)).toBe(1);
    expect(nukeProgress(0, 0)).toBe(1);
    // Straight path of length 200, 30% along.
    expect(nukeProgress(60, 140)).toBeCloseTo(60 / 200);
    // Bowed path: equidistant point is the apex (½), never above 1.
    expect(nukeProgress(38.8, 38.8)).toBeCloseTo(0.5);
  });

  it("arc: zero at launch and impact, apex arcH halfway", () => {
    const span = 300;
    const h = nukeArcHeight(span);
    expect(nukeAltitude(NukeFlight.Arc, 0, span, span).altitude).toBeCloseTo(0);
    expect(nukeAltitude(NukeFlight.Arc, span, 0, span).altitude).toBeCloseTo(0);
    const apex = nukeAltitude(NukeFlight.Arc, span / 2, span / 2, span);
    expect(apex.altitude).toBeCloseTo(h);
    expect(apex.slope).toBeCloseTo(0);
    // Climbs on the way up, dives on the way down.
    expect(nukeAltitude(NukeFlight.Arc, 50, 250, span).slope).toBeGreaterThan(
      0,
    );
    expect(nukeAltitude(NukeFlight.Arc, 250, 50, span).slope).toBeLessThan(0);
  });

  it("arc slope matches the numeric derivative along a straight path", () => {
    const span = 400;
    for (const s of [20, 120, 200, 333]) {
      const eps = 1e-3;
      const a = nukeAltitude(NukeFlight.Arc, s - eps, span - s + eps, span);
      const b = nukeAltitude(NukeFlight.Arc, s + eps, span - s - eps, span);
      const mid = nukeAltitude(NukeFlight.Arc, s, span - s, span);
      expect(mid.slope).toBeCloseTo((b.altitude - a.altitude) / (2 * eps), 4);
    }
  });

  it("MIRV climbs to cruise; its warheads start at cruise and dive to 0", () => {
    expect(nukeAltitude(NukeFlight.Climb, 0, 500, 500).altitude).toBe(0);
    expect(
      nukeAltitude(NukeFlight.Climb, MIRV_CLIMB_TILES * 2, 100, 500).altitude,
    ).toBeCloseTo(MIRV_CRUISE_ALTITUDE);
    // Continuous hand-over at separation.
    expect(nukeAltitude(NukeFlight.Dive, 0, 80, 80).altitude).toBeCloseTo(
      MIRV_CRUISE_ALTITUDE,
    );
    expect(nukeAltitude(NukeFlight.Dive, 80, 0, 80).altitude).toBeCloseTo(0);
    expect(nukeAltitude(NukeFlight.Dive, 40, 40, 80).slope).toBeLessThan(0);
    // Climb slope = numeric derivative.
    const eps = 1e-3;
    const at = (d: number) =>
      nukeAltitude(NukeFlight.Climb, d, 100, 500).altitude;
    expect(nukeAltitude(NukeFlight.Climb, 60, 100, 500).slope).toBeCloseTo(
      (at(60 + eps) - at(60 - eps)) / (2 * eps),
      4,
    );
  });

  it("trajectory preview uses the same arc (0 at the ends, apex mid-way)", () => {
    // Straight east-west Bézier (control points on the line).
    const d: NukeTrajectoryData = {
      p0x: 100,
      p0y: 50,
      p1x: 150,
      p1y: 50,
      p2x: 250,
      p2y: 50,
      p3x: 300,
      p3y: 50,
      tUntargetableStart: -1,
      tUntargetableEnd: -1,
      tSamIntercept: 1,
    };
    const pts = trajectoryPoints(d, [0, 0.5, 1], () => 2);
    expect(pts[0].alt).toBeCloseTo(0);
    expect(pts[2].alt).toBeCloseTo(0);
    expect(pts[1].alt).toBeCloseTo(nukeArcHeight(200));
    expect(pts[1].x).toBeCloseTo(200.5);
    expect(pts[1].ground).toBe(2);
  });
});

describe("tickEase", () => {
  it("is linear while cruising and smoothstep from rest", () => {
    expect(tickEase(0.25, true)).toBeCloseTo(0.25);
    expect(tickEase(0.25, false)).toBeCloseTo(0.15625);
    expect(tickEase(0.5, false)).toBeCloseTo(0.5);
    expect(tickEase(1.7, false)).toBe(1);
    expect(tickEase(-1, true)).toBe(0);
  });
});

describe("structure helpers", () => {
  it("stretches single-model types with level, capped at 6", () => {
    expect(structureLevelScale(UT_FACTORY, 1)).toEqual([1, 1]);
    const [x3, y3] = structureLevelScale(UT_FACTORY, 3);
    expect(y3).toBeGreaterThan(x3);
    expect(x3).toBeGreaterThan(1);
    expect(structureLevelScale(UT_FACTORY, 40)).toEqual(
      structureLevelScale(UT_FACTORY, 6),
    );
    // Cities encode the level in their model instead.
    expect(structureLevelScale(UT_CITY, 5)).toEqual([1, 1]);
  });

  it("grows a construction site from ~0.5 to ~0.75", () => {
    expect(constructionScale(0, 0)).toBeCloseTo(0.5);
    expect(constructionScale(1e6, 0)).toBeCloseTo(0.75);
    expect(constructionScale(-5, 0)).toBeCloseTo(0.5);
    const pulse = constructionScale(1e6, Math.PI / 8);
    expect(pulse).toBeGreaterThan(0.75);
    expect(pulse).toBeLessThanOrEqual(0.78 + 1e-9);
  });
});

describe("three sanity", () => {
  it("runs with the installed three", () => {
    expect(new THREE.Vector3(1, 2, 2).length()).toBe(3);
  });
});
