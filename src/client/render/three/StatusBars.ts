/**
 * StatusBars — screen-space health / progress bars and veterancy pips
 * anchored on world points (one instanced draw call per owner layer).
 *
 * Same information and colours as the default renderer's BarPass
 * (render-settings `bar`): black frame and background, a fill coloured red →
 * orange → yellow → green by the 0.25 / 0.5 / 0.75 thresholds, and solid
 * gold veterancy pips. Unlike BarPass the bars have a fixed size in CSS px
 * (they are camera-facing billboards projected from their anchor), so they
 * stay readable under tilt and at every zoom; they are drawn without depth
 * test, above the relief and the models.
 *
 * Usage per frame: `begin(frame)`, `bar(...)` / `pip(...)` per instance,
 * `end()`. `fade` (0..1) dims everything, e.g. when zoomed far out.
 */

import * as THREE from "three";
import type { RenderSettings } from "../gl/RenderSettings";
import { nextCapacity } from "./ProceduralMeshes";
import type { FrameInfo } from "./types";

/** What an instance draws. */
export const BarKind = {
  /** Threshold-coloured fill up to `value`. */
  Progress: 0,
  /** Solid gold rectangle (veterancy pip). */
  Pip: 1,
} as const;
export type BarKind = (typeof BarKind)[keyof typeof BarKind];

/**
 * Fill colour index of a progress value: 0 red, 1 orange, 2 yellow,
 * 3 green, by the bar thresholds (strictly below each threshold).
 */
export function barColorIndex(
  value: number,
  thresholds: readonly [number, number, number],
): number {
  if (value < thresholds[0]) return 0;
  if (value < thresholds[1]) return 1;
  if (value < thresholds[2]) return 2;
  return 3;
}

const VERT = /* glsl */ `
attribute vec3 aAnchor;
attribute vec4 aRect;   // centre offset (css px, +y up), size (css px)
attribute vec2 aValue;  // (value 0..1, kind)
uniform vec2 uViewport; // css px
varying vec2 vPx;
varying vec2 vSize;
varying vec2 vValue;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(aAnchor, 1.0);
  vec2 local = position.xy; // unit quad, -0.5..0.5
  vec2 px = aRect.xy + local * aRect.zw;
  // Offsets in css px → NDC, times w so they survive the perspective divide.
  clip.xy += px * 2.0 / uViewport * clip.w;
  gl_Position = clip;
  vPx = (local + 0.5) * aRect.zw;
  vSize = aRect.zw;
  vValue = aValue;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColors[5]; // red, orange, yellow, green, gold (linear)
uniform vec3 uThresholds;
uniform float uFade;
varying vec2 vPx;
varying vec2 vSize;
varying vec2 vValue;
void main() {
  vec3 col;
  if (vValue.y > 0.5) {
    col = uColors[4];
  } else {
    // 1 px black frame, black background, fill from the left.
    bool frame = vPx.x < 1.0 || vPx.y < 1.0 ||
                 vPx.x > vSize.x - 1.0 || vPx.y > vSize.y - 1.0;
    float v = clamp(vValue.x, 0.0, 1.0);
    bool filled = !frame && (vPx.x - 1.0) < v * (vSize.x - 2.0);
    int k = v < uThresholds.x ? 0 : v < uThresholds.y ? 1 : v < uThresholds.z ? 2 : 3;
    col = filled ? uColors[k] : vec3(0.0);
  }
  gl_FragColor = vec4(col, uFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Bar size (CSS px) for a model `modelPx` CSS px across: `fraction` of it,
 * clamped to [minW, maxW], about 9:1 and at least 4 px tall — it grows with
 * the zoom so bars stay proportionate to the models.
 */
export function barSize(
  modelPx: number,
  fraction: number,
  minW: number,
  maxW: number,
): { w: number; h: number } {
  const w = Math.round(Math.min(maxW, Math.max(minW, fraction * modelPx)));
  return { w, h: Math.min(8, Math.max(4, Math.round(w / 9))) };
}

export class StatusBars {
  private readonly quad = new THREE.PlaneGeometry(1, 1);
  private geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private anchors!: THREE.InstancedBufferAttribute;
  private rects!: THREE.InstancedBufferAttribute;
  private values!: THREE.InstancedBufferAttribute;
  private capacity = 0;
  private n = 0;

  constructor(
    private readonly parent: THREE.Object3D,
    settings: RenderSettings["bar"],
    name: string,
    renderOrder = 60,
  ) {
    this.grow(64);
    const c = (r: number, g: number, b: number) =>
      new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    this.material = new THREE.ShaderMaterial({
      name,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uViewport: { value: new THREE.Vector2(1, 1) },
        uFade: { value: 1 },
        uThresholds: {
          value: new THREE.Vector3(
            settings.threshold1,
            settings.threshold2,
            settings.threshold3,
          ),
        },
        uColors: {
          value: [
            c(settings.colorRedR, settings.colorRedG, settings.colorRedB),
            c(
              settings.colorOrangeR,
              settings.colorOrangeG,
              settings.colorOrangeB,
            ),
            c(
              settings.colorYellowR,
              settings.colorYellowG,
              settings.colorYellowB,
            ),
            c(settings.colorGreenR, settings.colorGreenG, settings.colorGreenB),
            c(settings.veterancyR, settings.veterancyG, settings.veterancyB),
          ],
        },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Instances written since `begin`. */
  get count(): number {
    return this.n;
  }

  begin(frame: FrameInfo, fade = 1): void {
    this.n = 0;
    const u = this.material.uniforms;
    (u.uViewport.value as THREE.Vector2).set(
      Math.max(1, frame.cssWidth),
      Math.max(1, frame.cssHeight),
    );
    u.uFade.value = fade;
  }

  /**
   * A bar of `w`×`h` CSS px centred `dx`, `dy` px (+y = up) from the
   * projection of world point (x, y, z), filled to `value` (0..1).
   */
  bar(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    w: number,
    h: number,
    value: number,
  ): void {
    this.push(x, y, z, dx, dy, w, h, value, BarKind.Progress);
  }

  /** A solid gold `w`×`h` px rectangle (veterancy pip). */
  pip(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    w: number,
    h: number,
  ): void {
    this.push(x, y, z, dx, dy, w, h, 1, BarKind.Pip);
  }

  end(): void {
    const n = this.n;
    this.geometry.instanceCount = n;
    this.mesh.visible =
      n > 0 && (this.material.uniforms.uFade.value as number) > 0;
    if (n === 0) return;
    for (const [attr, size] of [
      [this.anchors, 3],
      [this.rects, 4],
      [this.values, 2],
    ] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.geometry.dispose();
    this.quad.dispose();
    this.material.dispose();
  }

  private push(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    w: number,
    h: number,
    value: number,
    kind: BarKind,
  ): void {
    const i = this.n;
    if (i >= this.capacity) this.grow(i + 1);
    const a = this.anchors.array as Float32Array;
    a[i * 3] = x;
    a[i * 3 + 1] = y;
    a[i * 3 + 2] = z;
    const r = this.rects.array as Float32Array;
    // Whole-pixel sizes keep the 1 px frame crisp.
    r[i * 4] = dx;
    r[i * 4 + 1] = dy;
    r[i * 4 + 2] = Math.round(w);
    r[i * 4 + 3] = Math.round(h);
    const v = this.values.array as Float32Array;
    v[i * 2] = value;
    v[i * 2 + 1] = kind;
    this.n = i + 1;
  }

  /**
   * Re-allocates the instance attributes (doubling) in a fresh geometry,
   * keeping the data, and releases the old geometry's buffers.
   */
  private grow(needed: number): void {
    const cap = nextCapacity(this.capacity, needed);
    const old = this.capacity > 0 ? this.geometry : null;
    if (old !== null) this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setIndex(this.quad.getIndex());
    this.geometry.setAttribute("position", this.quad.getAttribute("position"));
    const make = (size: number, old?: THREE.InstancedBufferAttribute) => {
      const arr = new Float32Array(cap * size);
      if (old) arr.set(old.array as Float32Array);
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    this.anchors = make(3, this.anchors);
    this.rects = make(4, this.rects);
    this.values = make(2, this.values);
    this.geometry.setAttribute("aAnchor", this.anchors);
    this.geometry.setAttribute("aRect", this.rects);
    this.geometry.setAttribute("aValue", this.values);
    this.capacity = cap;
    if (old !== null) {
      this.mesh.geometry = this.geometry;
      old.dispose();
    }
  }
}
