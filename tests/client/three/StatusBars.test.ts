import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import {
  barColorIndex,
  barSize,
  StatusBars,
} from "../../../src/client/render/three/StatusBars";
import type { FrameInfo } from "../../../src/client/render/three/types";

function frame(): FrameInfo {
  return {
    nowMs: 0,
    dtMs: 16,
    tickAlpha: 1,
    camera: new THREE.PerspectiveCamera(),
    cssPxPerTile: 8,
    tilt: 0,
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
    localPlayerID: 0,
    highlightOwner: 0,
    altView: false,
  };
}

describe("StatusBars", () => {
  it("colours fills by the BarPass thresholds", () => {
    const t = [0.25, 0.5, 0.75] as const;
    expect(barColorIndex(0.1, t)).toBe(0); // red
    expect(barColorIndex(0.25, t)).toBe(1); // orange
    expect(barColorIndex(0.6, t)).toBe(2); // yellow
    expect(barColorIndex(0.75, t)).toBe(3); // green
    expect(barColorIndex(1, t)).toBe(3);
  });

  it("sizes bars with the model, within bounds", () => {
    expect(barSize(10, 0.6, 20, 80)).toEqual({ w: 20, h: 4 });
    expect(barSize(100, 0.6, 20, 80)).toEqual({ w: 60, h: 7 });
    expect(barSize(1000, 0.6, 20, 80)).toEqual({ w: 80, h: 8 });
  });

  it("grows past its initial capacity and keeps the instances", () => {
    const parent = new THREE.Group();
    const bars = new StatusBars(parent, createRenderSettings().bar, "bars");
    bars.begin(frame());
    for (let i = 0; i < 100; i++) bars.bar(i, 1, 2, 0, 6, 30, 5, i / 100);
    bars.pip(0, 0, 0, 20, 6, 6, 2);
    bars.end();
    expect(bars.count).toBe(101);
    const mesh = parent.getObjectByName("bars") as THREE.Mesh;
    const geo = mesh.geometry as THREE.InstancedBufferGeometry;
    expect(mesh.visible).toBe(true);
    expect(geo.instanceCount).toBe(101);
    const anchors = geo.getAttribute("aAnchor");
    expect(anchors.getX(0)).toBe(0);
    expect(anchors.getX(99)).toBe(99);
    const values = geo.getAttribute("aValue");
    expect(values.getX(50)).toBeCloseTo(0.5, 6);
    expect(values.getY(100)).toBe(1); // the pip

    // Faded out: nothing drawn.
    bars.begin(frame(), 0);
    bars.bar(0, 0, 0, 0, 0, 20, 4, 1);
    bars.end();
    expect(mesh.visible).toBe(false);
    bars.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
