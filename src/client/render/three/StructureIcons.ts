/**
 * StructureIcons — the default renderer's structure icons (StructurePass)
 * as screen-space billboards anchored on the relief, so structures read by
 * type and owner at full-map and default zoom, where the 3D models are only
 * a few pixels wide.
 *
 * What an icon shows (same rules as structure.vert.glsl / structure.frag.glsl):
 * - type: a per-type shape (city circle, port pentagon, factory hexagon,
 *   defense post octagon, SAM square, silo triangle, scaled by
 *   `structure.shapes[type].scale`) and, above the dots threshold, the
 *   white glyph of `resources/atlases/icon-atlas.png` (same column order);
 * - owner: fill = territory colour × `fillDarken`, ring = border colour ×
 *   `borderDarken` (the territory colour for the local player); grey fill
 *   and ring while under construction; affiliation colours (self / ally /
 *   enemy, the default renderer's "unit" row) in the alt view;
 * - marked for deletion: the red X;
 * - build-menu highlight: white outline on the matching types, the others
 *   dimmed (`highlightOutlineWidth`, `highlightDimAlpha`).
 * The level number stays the StructureLayer's DOM badge, anchored above
 * the icon (no number is drawn here, so there is never a duplicate).
 *
 * Size (CSS px) is the default renderer's at the same zoom on the same
 * screen: `iconSize × iconScale(zoom × dpr) × shapeScale / dpr`, where
 * iconScale is `dotScale` up to `dotsZoomThreshold`, then `zoom / 3` up to
 * 1, then grows with the zoom from `iconGrowZoom`. StructureLayer only
 * shows icons below ~5 px per tile (see `iconFadeBand`), so they never get
 * large on screen.
 *
 * One instanced draw call (6 vertices per icon), no depth test, drawn in the
 * transparent queue after the models (renderOrder 15) and before FX,
 * overlays and status bars. Instance data (anchor, colours, type, mark)
 * changes only when the structures, the palette, the alt view or the
 * relations change; per frame only uniforms are written (sizes, crossfade
 * alpha, viewport, highlight mask).
 */

import { assetUrl } from "@openfront/shared/AssetUrls";
import * as THREE from "three";
import type { RenderSettings } from "../gl/RenderSettings";
import {
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
} from "../types";
import { nextCapacity } from "./ProceduralMeshes";
import type { FrameInfo } from "./types";

/** Structure types in icon-atlas column order (StructurePass's order). */
export const ICON_ATLAS_ORDER: readonly string[] = [
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
];
export const ICON_ATLAS_COLS = ICON_ATLAS_ORDER.length;

/** Atlas column (and shape) of a structure type, or -1 for other units. */
export function iconAtlasColumn(type: string): number {
  return ICON_ATLAS_ORDER.indexOf(type);
}

type StructureIconSettings = RenderSettings["structure"];

/**
 * structure.vert.glsl's `iconScale` at `zoomDevice` device px per tile:
 * dots (`dotScale`) up to `dotsZoomThreshold`, then `min(1, zoom / 3)`,
 * then `zoom / iconGrowZoom` (world-anchored) from `iconGrowZoom` on.
 */
export function defaultIconScale(
  zoomDevice: number,
  ss: StructureIconSettings,
): number {
  if (zoomDevice <= ss.dotsZoomThreshold) return ss.dotScale;
  if (zoomDevice >= ss.iconGrowZoom) return zoomDevice / ss.iconGrowZoom;
  return Math.min(1, zoomDevice / ss.iconScaleFactorZoomedOut);
}

/** Whether the default renderer draws glyphs (else plain shapes, "dots"). */
export function iconGlyphsAt(
  zoomDevice: number,
  ss: StructureIconSettings,
): boolean {
  return zoomDevice > ss.dotsZoomThreshold;
}

/** `structure.shapes[type]` with StructurePass's fallbacks. */
export function iconShape(
  type: string,
  ss: StructureIconSettings,
): { scale: number; iconFill: number } {
  return {
    scale: iconShapeScale(type, ss),
    iconFill: iconShapeFill(type, ss),
  };
}

/** `structure.shapes[type].scale` (1 when unset); allocation-free. */
export function iconShapeScale(
  type: string,
  ss: StructureIconSettings,
): number {
  return ss.shapes[type]?.scale ?? 1;
}

/** `structure.shapes[type].iconFill` (0.6 when unset); allocation-free. */
export function iconShapeFill(type: string, ss: StructureIconSettings): number {
  return ss.shapes[type]?.iconFill ?? 0.6;
}

/**
 * Side (CSS px) of the default renderer's icon quad for `type` at
 * `cssPxPerTile` on a screen with device pixel ratio `dpr` (StructurePass
 * works in device px: `iconSize × iconScale(zoom·dpr) × shapeScale`).
 */
export function structureIconCssPx(
  type: string,
  cssPxPerTile: number,
  dpr: number,
  ss: StructureIconSettings,
): number {
  const d = dpr > 0 ? dpr : 1;
  return (
    (ss.iconSize *
      defaultIconScale(cssPxPerTile * d, ss) *
      iconShapeScale(type, ss)) /
    d
  );
}

// ---- Icons ↔ models crossfade ----

/** Zoom band (CSS px per tile) where icons fade into the 3D models. */
export interface IconFadeBand {
  /** Below: icons only, no models drawn. */
  start: number;
  /** Above: models only, no icons drawn. */
  end: number;
}

/**
 * Default band: from 2.5 px per tile (where the camera starts to tilt) to
 * 5 (STRUCTURE_LOD_ZOOM, where the full models take over from the low-poly
 * ones), so low-poly models are only drawn inside the band.
 */
export const ICON_FADE_BAND: Readonly<IconFadeBand> = { start: 2.5, end: 5 };
/** `quality: "low"` keeps the icons longer (fewer model triangles). */
export const ICON_FADE_BAND_LOW: Readonly<IconFadeBand> = {
  start: 3.5,
  end: 7,
};
/** Models stay drawn down to `start / MODEL_HYSTERESIS` once on. */
export const MODEL_HYSTERESIS = 1.1;

export function iconFadeBand(low: boolean): Readonly<IconFadeBand> {
  return low ? ICON_FADE_BAND_LOW : ICON_FADE_BAND;
}

/**
 * Weight of the 3D models at `zoom`: 0 = icons only, 1 = models only,
 * smoothstep across the band. Icons are drawn with alpha `iconAlphaAt(weight)`.
 * A continuous function of the zoom, so nothing pops.
 */
export function modelWeightAt(zoom: number, band: IconFadeBand): number {
  const t = Math.min(
    1,
    Math.max(0, (zoom - band.start) / Math.max(1e-6, band.end - band.start)),
  );
  return t * t * (3 - 2 * t);
}

/** Model weight from which the icons start to fade out (see iconAlphaAt). */
export const ICON_FADE_FROM = 0.5;

/**
 * Icon opacity at model weight `w`: opaque over the first half of the band,
 * where the models growing out of the ground under them are still only
 * ~10-20 px wide, then fading out (smoothstep of w over 0.5 → 1) as the
 * models reach their full size. A continuous function of the zoom, so
 * nothing pops; the structures stay readable by type and owner across the
 * band (a plain `1 − w` left them at a third of their opacity over
 * 15-20 px models at 4 px per tile).
 */
export function iconAlphaAt(w: number): number {
  const t = Math.min(
    1,
    Math.max(0, (w - ICON_FADE_FROM) / (1 - ICON_FADE_FROM)),
  );
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Whether the 3D models are drawn at `zoom`, given whether they are now:
 * on from `band.start`, off again below `band.start / MODEL_HYSTERESIS`
 * (where their weight is 0 and the opaque icons cover them), so zooming
 * around the threshold does not rebuild the batches every frame.
 */
export function structureModelsAt(
  zoom: number,
  current: boolean,
  band: IconFadeBand,
): boolean {
  return current ? zoom >= band.start / MODEL_HYSTERESIS : zoom >= band.start;
}

/**
 * Size of a model fading in with weight `w`: (horizontal, vertical)
 * factors. It grows out of the ground under the fading icon (opaque at
 * w = 0), which is cheaper than making every structure material
 * transparent.
 */
export function modelFadeScale(w: number): [number, number] {
  return [modelFadeScaleX(w), modelFadeScaleY(w)];
}

/** Horizontal factor of `modelFadeScale` (allocation-free, per frame). */
export function modelFadeScaleX(w: number): number {
  return 0.35 + 0.65 * Math.min(1, Math.max(0, w));
}

/** Vertical factor of `modelFadeScale` (allocation-free, per frame). */
export function modelFadeScaleY(w: number): number {
  return 0.15 + 0.85 * Math.min(1, Math.max(0, w));
}

// ---- Colours ----

export type Rgb = [number, number, number];

/** Default renderer relations (`frame/derive` relation matrix values). */
const RELATION_FRIENDLY = 1;

/**
 * Alt-view colour of `owner` for the local player `local` (sRGB 0..1): the
 * default renderer's "unit" affiliation row (`AffiliationPalette` row 1):
 * self, ally, else enemy (neutral counts as enemy for units).
 */
export function unitAffiliationRgb(
  owner: number,
  local: number,
  relations: Uint8Array | null,
  size: number,
  aff: RenderSettings["affiliation"],
  out: Rgb = [0, 0, 0],
): Rgb {
  let rel = 0;
  if (
    relations !== null &&
    local > 0 &&
    owner > 0 &&
    owner < size &&
    local < size
  ) {
    rel = relations[local * size + owner] ?? 0;
  }
  if (owner > 0 && owner === local) {
    out[0] = aff.selfR;
    out[1] = aff.selfG;
    out[2] = aff.selfB;
  } else if (rel === RELATION_FRIENDLY) {
    out[0] = aff.allyR;
    out[1] = aff.allyG;
    out[2] = aff.allyB;
  } else {
    out[0] = aff.enemyR;
    out[1] = aff.enemyG;
    out[2] = aff.enemyB;
  }
  return out;
}

export interface IconColorInput {
  /** PaletteView data (row 0 fill, row 1 border). */
  palette: Float32Array;
  owner: number;
  localPlayerID: number;
  underConstruction: boolean;
  /** Alt-view affiliation colour (sRGB), or null outside the alt view. */
  affiliation: Readonly<Rgb> | null;
}

export interface IconColors {
  fill: Rgb;
  border: Rgb;
}

const PALETTE_ROW1 = 4096 * 4;

/**
 * Fill and ring colours of an icon (sRGB 0..1), as structure.frag.glsl
 * computes them: HSV value × `fillDarken` / `borderDarken` (a plain
 * multiply), the territory colour as ring for the local player, fixed greys
 * under construction, affiliation colours in the alt view. A palette entry
 * that is still empty reads as light grey instead of black.
 */
export function structureIconColors(
  input: IconColorInput,
  ss: StructureIconSettings,
  out: IconColors = { fill: [0, 0, 0], border: [0, 0, 0] },
): IconColors {
  const { fill, border } = out;
  if (input.underConstruction) {
    fill[0] = fill[1] = fill[2] = 198 / 255;
    border[0] = border[1] = border[2] = 127 / 255;
    return out;
  }
  if (input.affiliation !== null) {
    const a = input.affiliation;
    for (let i = 0; i < 3; i++) {
      fill[i] = a[i] * ss.fillDarken;
      border[i] = a[i] * ss.borderDarken;
    }
    return out;
  }
  const p = input.palette;
  const o = (input.owner & 4095) * 4;
  const empty = (p[o] ?? 0) + (p[o + 1] ?? 0) + (p[o + 2] ?? 0) <= 0;
  const ring = input.owner === input.localPlayerID ? o : PALETTE_ROW1 + o;
  for (let i = 0; i < 3; i++) {
    const f = empty ? 0.62 : (p[o + i] ?? 0);
    const b = empty ? 0.62 : (p[ring + i] ?? 0);
    fill[i] = f * ss.fillDarken;
    border[i] = b * ss.borderDarken;
  }
  return out;
}

// ---- Shaders ----

const VERT = /* glsl */ `
attribute vec3 aAnchor;
attribute vec3 aFill;   // sRGB
attribute vec3 aBorder; // sRGB
attribute vec2 aMeta;   // (atlas column, marked for deletion)
uniform vec2 uViewport;            // css px
uniform float uSizePx[${ICON_ATLAS_COLS}];      // quad side, css px
uniform float uShapeScales[${ICON_ATLAS_COLS}];
uniform float uIconFills[${ICON_ATLAS_COLS}];
varying vec2 vLocalPos;
varying vec2 vAtlasUV;
varying vec3 vFill;
varying vec3 vBorder;
varying float vCol;
varying float vMarked;
varying float vShapeScale;
void main() {
  int col = int(aMeta.x + 0.5);
  vec4 clip = projectionMatrix * viewMatrix * vec4(aAnchor, 1.0);
  vec2 local = position.xy; // unit quad, -0.5..0.5, +y up
  clip.xy += local * uSizePx[col] * 2.0 / uViewport * clip.w;
  gl_Position = clip;
  // structure.frag.glsl's local frame has +y down.
  vLocalPos = vec2(local.x, -local.y);
  float shapeScale = uShapeScales[col];
  vShapeScale = shapeScale;
  vec2 scaled = 0.5 + vLocalPos * (shapeScale / uIconFills[col]);
  vAtlasUV = vec2((float(col) + scaled.x) / ${ICON_ATLAS_COLS}.0, scaled.y);
  vFill = aFill;
  vBorder = aBorder;
  vCol = aMeta.x;
  vMarked = aMeta.y;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uGlyphs;            // 1 = glyphs (atlas loaded, above dots zoom)
uniform float uAlpha;             // crossfade × iconAlpha
uniform int uHighlightMask;       // atlas columns to highlight (0 = off)
uniform float uHighlightOutlineW;
uniform float uHighlightDimAlpha;
uniform vec3 uIconColor;          // sRGB
uniform float uIconDarken;
uniform vec3 uTint;               // build ghost tint (0 = none), sRGB
uniform float uGhostAlpha;        // build ghost opacity (1 = normal icons)
varying vec2 vLocalPos;
varying vec2 vAtlasUV;
varying vec3 vFill;
varying vec3 vBorder;
varying float vCol;
varying float vMarked;
varying float vShapeScale;

#define ICON_PI 3.14159265

float sdPolygon(vec2 p, float R, float n, float rot) {
  float an = ICON_PI / n;
  float a = atan(p.y, p.x) - rot;
  a = mod(a + an, 2.0 * an) - an;
  return length(p) * cos(a) - R * cos(an);
}

// 0 City circle, 1 Port pentagon, 2 Factory hexagon, 3 Defense Post
// octagon, 4 SAM square, 5 Silo triangle (structure.frag.glsl).
float shapeSDF(vec2 p, float R) {
  if (vCol < 0.5) return length(p) - R;
  if (vCol < 1.5) return sdPolygon(p, R, 5.0, ICON_PI * 0.5);
  if (vCol < 2.5) return sdPolygon(p, R, 6.0, ICON_PI / 6.0);
  if (vCol < 3.5) return sdPolygon(p, R, 8.0, 0.0);
  if (vCol < 4.5) return sdPolygon(p, R, 4.0, 0.0);
  return sdPolygon(p, R, 3.0, ICON_PI * 0.5);
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)),
             step(vec3(0.04045), c));
}

void main() {
  float dist = length(vLocalPos);
  float radius = 0.45;
  float borderWidth = 0.06 / vShapeScale;
  float sdf = shapeSDF(vLocalPos, radius);
  float fw = max(fwidth(dist), 1e-4);
  float outlineW = uHighlightMask != 0 ? uHighlightOutlineW / vShapeScale : 0.0;
  float outerAlpha = 1.0 - smoothstep(-fw, fw, sdf - outlineW);
  if (outerAlpha <= 0.0) discard;
  float borderMask = 1.0 - smoothstep(-fw, fw, sdf + borderWidth);
  vec3 bg = mix(vBorder, vFill, borderMask);

  float glyph = 0.0;
  if (uGlyphs > 0.5) {
    float colStart = vCol / ${ICON_ATLAS_COLS}.0;
    float colEnd = (vCol + 1.0) / ${ICON_ATLAS_COLS}.0;
    vec2 uv = vec2(clamp(vAtlasUV.x, colStart, colEnd), clamp(vAtlasUV.y, 0.0, 1.0));
    float inBounds = step(colStart, vAtlasUV.x) * step(vAtlasUV.x, colEnd)
                   * step(0.0, vAtlasUV.y) * step(vAtlasUV.y, 1.0);
    glyph = texture2D(uAtlas, uv).a * borderMask * inBounds;
  }
  vec3 glyphColor = uIconColor;
  if (uIconDarken > 0.0) {
    float lum = dot(vFill, vec3(0.299, 0.587, 0.114));
    glyphColor = lum < 0.25 ? uIconColor : vFill * uIconDarken;
  }
  vec3 rgb = mix(bg, glyphColor, glyph);

  if (vMarked > 0.5) {
    float lineW = max(0.025, fw * 1.5);
    float dMin = min(abs(vLocalPos.x - vLocalPos.y), abs(vLocalPos.x + vLocalPos.y)) * 0.7071;
    float maskR = max(radius * 1.55, fw * 6.0);
    float mask = 1.0 - smoothstep(maskR - fw, maskR, dist);
    float xLine = (1.0 - smoothstep(lineW - fw, lineW + fw, dMin)) * mask;
    rgb = mix(rgb, vec3(1.0, 0.25, 0.25), xLine * 0.95);
  }

  // Build ghost (structure.frag.glsl): the whole icon half-way to the tint.
  float tintOn = step(0.01, dot(uTint, uTint));
  rgb = mix(rgb, uTint, tintOn * 0.5);

  float alpha = outerAlpha * uAlpha * uGhostAlpha;
  if (uHighlightMask != 0) {
    int bit = 1 << int(vCol + 0.5);
    if ((uHighlightMask & bit) != 0) {
      float shapeEdge = 1.0 - smoothstep(-fw, fw, sdf);
      float band = outerAlpha - shapeEdge;
      rgb = mix(rgb, vec3(1.0), band);
    } else {
      alpha *= uHighlightDimAlpha;
    }
  }
  gl_FragColor = vec4(srgbToLinear(rgb), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Per-frame inputs of `StructureIcons.frame`. */
export interface IconFrameState {
  /** Crossfade opacity (1 − model weight), before `iconAlpha`. */
  alpha: number;
  /** Quad side per atlas column, CSS px. */
  sizesPx: ArrayLike<number>;
  /** Glyphs on (above the dots threshold); plain shapes otherwise. */
  glyphs: boolean;
}

const iconAtlasUrl = (): string => assetUrl("atlases/icon-atlas.png");

/** Instanced icon billboards (one draw call); see the file comment. */
export class StructureIcons {
  private readonly quad = new THREE.PlaneGeometry(1, 1);
  private geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly placeholder: THREE.DataTexture;
  private atlas: THREE.Texture | null = null;
  private atlasReady = false;
  private disposed = false;
  private anchors!: THREE.InstancedBufferAttribute;
  private fills!: THREE.InstancedBufferAttribute;
  private borders!: THREE.InstancedBufferAttribute;
  private metas!: THREE.InstancedBufferAttribute;
  private capacity = 0;
  private n = 0;
  private highlightMask = 0;

  /**
   * `atlasFrom`: share another instance's atlas (loaded once) instead of
   * loading one; the build ghost uses the structures' icons' atlas.
   */
  constructor(
    private readonly parent: THREE.Object3D,
    private readonly settings: RenderSettings,
    name = "structure-icons",
    renderOrder = 15,
    loadAtlas = true,
    private readonly atlasFrom: StructureIcons | null = null,
  ) {
    this.grow(64);
    this.placeholder = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 0]),
      1,
      1,
    );
    this.placeholder.needsUpdate = true;
    const ss = settings.structure;
    this.material = new THREE.ShaderMaterial({
      name,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uAtlas: { value: this.placeholder },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uSizePx: { value: new Float32Array(ICON_ATLAS_COLS) },
        uShapeScales: { value: new Float32Array(ICON_ATLAS_COLS) },
        uIconFills: { value: new Float32Array(ICON_ATLAS_COLS) },
        uGlyphs: { value: 0 },
        uAlpha: { value: 1 },
        uHighlightMask: { value: 0 },
        uHighlightOutlineW: { value: ss.highlightOutlineWidth },
        uHighlightDimAlpha: { value: ss.highlightDimAlpha },
        uIconColor: { value: new THREE.Vector3(ss.iconR, ss.iconG, ss.iconB) },
        uIconDarken: { value: ss.iconDarken },
        uTint: { value: new THREE.Vector3(0, 0, 0) },
        uGhostAlpha: { value: 1 },
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
    if (atlasFrom !== null) {
      // The same uniform object: the atlas shows up here when it loads.
      this.material.uniforms.uAtlas = atlasFrom.material.uniforms.uAtlas;
    } else if (loadAtlas) {
      this.loadAtlas(iconAtlasUrl());
    }
  }

  /** Icons written since `begin`. */
  get count(): number {
    return this.n;
  }

  /** Whether the icons are drawn this frame (one draw call). */
  get drawn(): boolean {
    return this.mesh.visible;
  }

  /** Glyphs are available (atlas loaded). */
  get glyphsReady(): boolean {
    return this.atlasFrom !== null
      ? this.atlasFrom.glyphsReady
      : this.atlasReady;
  }

  /**
   * Build ghost look (StructurePass's ghost draw): the icon mixed half-way
   * to `tint` (sRGB; black = no tint) at `alpha` opacity. Normal icons keep
   * (0, 0, 0) and 1.
   */
  setGhost(tint: Readonly<Rgb>, alpha: number): void {
    const u = this.material.uniforms;
    (u.uTint.value as THREE.Vector3).set(tint[0], tint[1], tint[2]);
    u.uGhostAlpha.value = alpha;
  }

  begin(): void {
    this.n = 0;
  }

  /**
   * Appends an icon for atlas column `col` centred on world point
   * (x, y, z); `fill` / `border` are sRGB. Returns its index.
   */
  push(
    x: number,
    y: number,
    z: number,
    col: number,
    fill: Readonly<Rgb>,
    border: Readonly<Rgb>,
    marked: boolean,
  ): number {
    const i = this.n;
    if (i >= this.capacity) this.grow(i + 1);
    const a = this.anchors.array as Float32Array;
    a[i * 3] = x;
    a[i * 3 + 1] = y;
    a[i * 3 + 2] = z;
    const m = this.metas.array as Float32Array;
    m[i * 2] = col;
    m[i * 2 + 1] = marked ? 1 : 0;
    this.n = i + 1;
    this.setColors(i, fill, border);
    return i;
  }

  /** Rewrites the colours of icon `i` (call `end` or `markColorsDirty`). */
  setColors(i: number, fill: Readonly<Rgb>, border: Readonly<Rgb>): void {
    const f = this.fills.array as Float32Array;
    const b = this.borders.array as Float32Array;
    for (let k = 0; k < 3; k++) {
      f[i * 3 + k] = fill[k];
      b[i * 3 + k] = border[k];
    }
  }

  /** Publishes the icons written since `begin`. */
  end(): void {
    this.geometry.instanceCount = this.n;
    for (const [attr, size] of [
      [this.anchors, 3],
      [this.metas, 2],
    ] as const) {
      markRange(attr, this.n * size);
    }
    this.markColorsDirty();
  }

  markColorsDirty(): void {
    markRange(this.fills, this.n * 3);
    markRange(this.borders, this.n * 3);
  }

  /** Build-menu highlight: bitmask of atlas columns (0 = off). */
  setHighlightMask(mask: number): void {
    this.highlightMask = mask;
  }

  /** Per-frame uniforms; hides the mesh when nothing would show. */
  frame(f: FrameInfo, state: IconFrameState): void {
    const u = this.material.uniforms;
    const ss = this.settings.structure;
    (u.uViewport.value as THREE.Vector2).set(
      Math.max(1, f.cssWidth),
      Math.max(1, f.cssHeight),
    );
    const sizes = u.uSizePx.value as Float32Array;
    const scales = u.uShapeScales.value as Float32Array;
    const fills = u.uIconFills.value as Float32Array;
    for (let c = 0; c < ICON_ATLAS_COLS; c++) {
      sizes[c] = state.sizesPx[c] ?? 0;
      const type = ICON_ATLAS_ORDER[c];
      scales[c] = iconShapeScale(type, ss);
      const fill = iconShapeFill(type, ss);
      fills[c] = fill > 0 ? fill : 1;
    }
    const alpha = Math.max(0, Math.min(1, state.alpha)) * ss.iconAlpha;
    u.uAlpha.value = alpha;
    u.uGlyphs.value = state.glyphs && this.glyphsReady ? 1 : 0;
    u.uHighlightMask.value = this.highlightMask;
    u.uHighlightOutlineW.value = ss.highlightOutlineWidth;
    u.uHighlightDimAlpha.value = ss.highlightDimAlpha;
    (u.uIconColor.value as THREE.Vector3).set(ss.iconR, ss.iconG, ss.iconB);
    u.uIconDarken.value = ss.iconDarken;
    this.mesh.visible = this.n > 0 && alpha > 0.002;
  }

  dispose(): void {
    this.disposed = true;
    this.parent.remove(this.mesh);
    this.geometry.dispose();
    this.quad.dispose();
    this.material.dispose();
    this.placeholder.dispose();
    this.atlas?.dispose();
    this.atlas = null;
  }

  private loadAtlas(url: string): void {
    if (typeof Image === "undefined") return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (this.disposed) return;
      const tex = new THREE.Texture(img);
      // structure.frag.glsl samples with v = 0 at the top row.
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      this.atlas = tex;
      this.atlasReady = true;
      this.material.uniforms.uAtlas.value = tex;
    };
    img.onerror = () => {
      console.warn("[StructureIcons] icon atlas failed to load:", url);
    };
    img.src = url;
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
    const make = (size: number, prev?: THREE.InstancedBufferAttribute) => {
      const arr = new Float32Array(cap * size);
      if (prev) arr.set(prev.array as Float32Array);
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    this.anchors = make(3, this.anchors);
    this.fills = make(3, this.fills);
    this.borders = make(3, this.borders);
    this.metas = make(2, this.metas);
    this.geometry.setAttribute("aAnchor", this.anchors);
    this.geometry.setAttribute("aFill", this.fills);
    this.geometry.setAttribute("aBorder", this.borders);
    this.geometry.setAttribute("aMeta", this.metas);
    this.geometry.instanceCount = this.n;
    this.capacity = cap;
    if (old !== null) {
      this.mesh.geometry = this.geometry;
      old.dispose();
    }
  }
}

/** Uploads the first `n` elements of an attribute (nothing when n = 0). */
function markRange(attr: THREE.BufferAttribute, n: number): void {
  if (n <= 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n);
  attr.needsUpdate = true;
}
