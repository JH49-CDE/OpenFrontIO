/**
 * Surface overlays painted ON the drawn ground: the coordinate grid and the
 * small-player glow. Owned by TerrainLayer.
 *
 * Semantics (default renderer):
 * - Coordinate grid (gl/passes/CoordinateGridPass.ts): white lines at the
 *   cell boundaries (render-settings `mapOverlay.coordinateGridOpacity`,
 *   ~1.25 px wide) and a label per cell (rows A, B, … AA, AB…; columns 1, 2…)
 *   at its top-left corner once a cell spans 60+ device px. Cells are
 *   `gridCellSize(W, H)` tiles (about 10 across the short side, at most 50
 *   columns). Shown while the grid view is on (M key, remembered in
 *   localStorage `renderer:grid_view_enabled`, like the default renderer) or
 *   the alt view is held (space). Labels are row letters and numbers, not
 *   words, so nothing goes through translateText.
 * - Small-player glow (gl/passes/SmallPlayerGlowPass.ts): a soft breathing
 *   red aura around (and over) the territory of the players in the set
 *   pushed by `WebGLFrameBuilder.syncSmallPlayerGlow` (alive humans with
 *   ≤ 0.2% of the land, after the first minute; null = none). Colour, alpha
 *   and pulse from render-settings `smallPlayerGlow`; `strength` (a
 *   graphics setting, 0 = off) is read live every frame.
 *
 * 3D: both are computed per fragment from the world position, so they are
 * draped exactly on whatever is drawn, at any tilt:
 * - land (and the coastal water the relief draws itself): the terrain
 *   shader composites `surfaceOverlay()` (SURFACE_OVERLAY_GLSL) after
 *   lighting, before fog;
 * - open water: a plane at sea level over the map (2 triangles, drawn after
 *   the water, behind the relief) composites the same function on water
 *   tiles only. Water is a separate translucent plane, so the terrain
 *   shader alone would leave the overlays under it.
 * Grid lines are anti-aliased with `fwidth`, so they stay ~1.25 px wide
 * everywhere on a tilted view. Labels keep the default's size at the screen
 * centre and are stretched along the view direction by 1 / cos(tilt) so they
 * read upright under tilt.
 *
 * The glow mask is built on the GPU, like the default renderer: an extract
 * pass marks every 4×4-tile block holding a highlighted owner, then a 5-tap
 * separable blur (two passes) at that 1/4 resolution. Three draws into a
 * (W/4 × H/4) RGBA8 target pair (World: 500×250, 0.5 MB each), only when a
 * new set is pushed (~1/s); the terrain shader samples it.
 *
 * Cost when off (grid off, alt view released, no set or strength 0): no
 * draw call, no mask pass, and the terrain shader skips the block on a
 * uniform branch.
 */

import * as THREE from "three";
import type { RenderSettings } from "../gl/RenderSettings";
import { FRAG_OUTPUT } from "./shaders/water";
import { createIntegerTexture, uploadNow } from "./TerrainResources";
import type { FrameInfo } from "./types";

/** localStorage key of the grid toggle, shared with the default renderer. */
export const GRID_VIEW_KEY = "renderer:grid_view_enabled";

const BASE_CELL_COUNT = 10;
const MAX_COLUMNS = 50;
const MIN_ROWS = 2;
/** Labels show once a cell spans this many device px (default renderer). */
export const GRID_LABEL_MIN_CELL_PX = 60;
/** Glyph cells of the label atlas (px); twice the default's, for tilt. */
const GLYPH_W = 32;
const GLYPH_H = 48;
const GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Glow mask resolution: one texel per 4×4 tiles (default renderer). */
export const GLOW_TILE_SCALE = 4;
/** Owner ids the glow set can hold (the palette size). */
const GLOW_SET_SIZE = 4096;
/** Largest per-frame advance of the glow pulse (ms), as the default. */
const GLOW_MAX_DT_MS = 100;

/**
 * Grid cell size in tiles: CoordinateGridPass's `computeCellSize` (upstream
 * CoordinateGridLayer.computeGrid).
 */
export function gridCellSize(mapW: number, mapH: number): number {
  const raw = Math.min(mapW, mapH) / BASE_CELL_COUNT;
  let rows = Math.max(1, Math.round(mapH / raw));
  let cols = Math.max(1, Math.round(mapW / raw));
  if (cols > MAX_COLUMNS) {
    const maxRows = Math.floor((MAX_COLUMNS * mapH) / mapW);
    rows = Math.max(MIN_ROWS, Math.min(rows, maxRows));
    cols = MAX_COLUMNS;
  }
  return Math.min(mapW / cols, mapH / rows);
}

/**
 * Label of a grid cell (TS mirror of the shader's glyph choice): row letters
 * (A…Z, then AA, AB…) and the 1-based column number.
 */
export function gridLabel(row: number, col: number): string {
  const letter = (i: number) => String.fromCharCode(65 + i);
  const rowPart =
    row < 26
      ? letter(row)
      : letter(Math.floor(row / 26) - 1) + letter(row % 26);
  return `${rowPart}${col + 1}`;
}

/** Label font size in device px at a zoom (device px per tile), as default. */
export function gridFontPx(base: number, zoom: number): number {
  return Math.min(base * 1.6, Math.max(base * 0.9, base + (zoom - 1) * 1.2));
}

/**
 * GLSL of the overlays. Declares its uniforms and
 * `vec4 surfaceOverlay(vec2 p, vec2 fw)`: the premultiplied linear colour
 * at world xz `p` (fw = fwidth(p), tiles per device px).
 */
export const SURFACE_OVERLAY_GLSL = /* glsl */ `
uniform float uOverlayOn;      // grid or glow on (master switch)
uniform vec2 uOverlayMapSize;  // W, H
uniform float uGridOn;
uniform float uGridCell;       // cell size, tiles
uniform float uGridOpacity;
uniform float uGridZoom;       // device px per tile at the screen centre
uniform float uGridFontPx;     // label size, device px
uniform float uGridStretch;    // 1 / cos(tilt): labels upright on screen
uniform float uGridLabels;     // 1 = draw labels
uniform sampler2D uGridGlyphs; // 36 glyphs (0-9, A-Z) in one row
uniform float uGlowOn;
uniform sampler2D uGlowMask;   // blurred mask, 1 texel = 4x4 tiles
uniform vec2 uGlowMaskTiles;   // tiles the mask covers (texels x 4)
uniform vec3 uGlowColor;       // linear
uniform float uGlowIntensity;  // alpha * pulse * strength

// Glyph index (0-9 digits, 10-35 letters) of character ci of a cell label.
int gridGlyph(int row, int col, int ci, out int count) {
  int c0;
  int c1 = -1;
  int c2 = -1;
  int c3 = -1;
  int n;
  if (row < 26) { c0 = row + 10; n = 1; }
  else { c0 = row / 26 - 1 + 10; c1 = row - (row / 26) * 26 + 10; n = 2; }
  int num = col + 1;
  if (n == 1) {
    if (num < 10) { c1 = num; n = 2; }
    else { c1 = num / 10; c2 = num - (num / 10) * 10; n = 3; }
  } else {
    if (num < 10) { c2 = num; n = 3; }
    else { c2 = num / 10; c3 = num - (num / 10) * 10; n = 4; }
  }
  count = n;
  return ci == 0 ? c0 : (ci == 1 ? c1 : (ci == 2 ? c2 : c3));
}

vec4 gridOverlay(vec2 p, vec2 fw) {
  float cs = uGridCell;
  vec2 cell = floor(p / cs);
  vec2 inCell = p - cell * cs;
  // Lines ~1.25 device px wide on the cell boundaries, anti-aliased.
  vec2 dpx = min(inCell, vec2(cs) - inCell) / fw;
  vec2 cov = clamp(vec2(1.125) - dpx, 0.0, 1.0);
  float lineA = max(cov.x, cov.y) * uGridOpacity;
  vec4 o = vec4(vec3(lineA), lineA);
  if (uGridLabels > 0.5) {
    float px = 1.0 / uGridZoom;
    float font = clamp(uGridFontPx + (uGridZoom - 1.0) * 1.2, uGridFontPx * 0.9, uGridFontPx * 1.6);
    float gw = font * 0.6 * px;
    float gh = font * px * uGridStretch;
    vec2 l = inCell - vec2(8.0 * px, 8.0 * px * uGridStretch);
    if (l.x >= 0.0 && l.y >= 0.0 && l.y < gh) {
      int ci = int(floor(l.x / gw));
      int count;
      int g = gridGlyph(int(cell.y), int(cell.x), min(ci, 3), count);
      if (ci < count) {
        vec2 uv = vec2((float(g) + fract(l.x / gw)) / 36.0, l.y / gh);
        vec4 t = textureLod(uGridGlyphs, uv, 0.0);
        float a = t.a * uGridOpacity;
        // Label over the line.
        o = vec4(t.rgb * a, a) + o * (1.0 - a);
      }
    }
  }
  return o;
}

vec4 surfaceOverlay(vec2 p, vec2 fw) {
  vec4 o = vec4(0.0);
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, uOverlayMapSize))) return o;
  if (uGlowOn > 0.5) {
    float g = textureLod(uGlowMask, p / uGlowMaskTiles, 0.0).r;
    float a = clamp(g * uGlowIntensity, 0.0, 1.0);
    o = vec4(uGlowColor * a, a);
  }
  // The grid draws over the glow (default pass order).
  if (uGridOn > 0.5) {
    vec4 gr = gridOverlay(p, fw);
    o = gr + o * (1.0 - gr.a);
  }
  return o;
}
`;

/** Uniforms of SURFACE_OVERLAY_GLSL (shared by reference). */
export function createSurfaceOverlayUniforms(mapW: number, mapH: number) {
  return {
    uOverlayOn: { value: 0 },
    uOverlayMapSize: { value: new THREE.Vector2(mapW, mapH) },
    uGridOn: { value: 0 },
    uGridCell: { value: gridCellSize(mapW, mapH) },
    uGridOpacity: { value: 0.5 },
    uGridZoom: { value: 1 },
    uGridFontPx: { value: 24 },
    uGridStretch: { value: 1 },
    uGridLabels: { value: 0 },
    uGridGlyphs: { value: null as THREE.Texture | null },
    uGlowOn: { value: 0 },
    uGlowMask: { value: null as THREE.Texture | null },
    uGlowMaskTiles: { value: new THREE.Vector2(mapW, mapH) },
    uGlowColor: { value: new THREE.Vector3(1, 0.012, 0.01) },
    uGlowIntensity: { value: 0 },
  };
}
export type SurfaceOverlayUniforms = ReturnType<
  typeof createSurfaceOverlayUniforms
>;

// ---------------------------------------------------------------------------
// Sea-level plane
// ---------------------------------------------------------------------------

const PLANE_VERT = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const PLANE_FRAG = /* glsl */ `
${FRAG_OUTPUT}
uniform highp usampler2D uTerrain; // R8UI terrain bytes
uniform ivec2 uMapSize;
${SURFACE_OVERLAY_GLSL}
varying vec3 vWorld;
#include <fog_pars_fragment>
void main() {
  vec2 p = vWorld.xz;
  vec2 fw = max(fwidth(p), vec2(1e-5));
  ivec2 t = ivec2(floor(p));
  if (any(lessThan(t, ivec2(0))) || any(greaterThanEqual(t, uMapSize))) discard;
  // Land tiles: the terrain shader draws the overlays there.
  if ((texelFetch(uTerrain, t, 0).r & 0x80u) != 0u) discard;
  vec4 o = surfaceOverlay(p, fw);
  if (o.a < 0.002) discard;
  gl_FragColor = vec4(o.rgb / o.a, o.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** After the water (-10), before every other transparent overlay. */
export const SEA_OVERLAY_RENDER_ORDER = -9;

// ---------------------------------------------------------------------------
// Glow mask (GPU)
// ---------------------------------------------------------------------------

const QUAD_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const EXTRACT_FRAG = /* glsl */ `
${FRAG_OUTPUT}
uniform highp usampler2D uTiles; // R16UI tile state
uniform highp usampler2D uSet;   // R8UI, 1 texel per owner id
uniform ivec2 uMapSize;
void main() {
  // Territory is sparse (often lone tiles): scan the whole 4x4 block.
  ivec2 base = ivec2(gl_FragCoord.xy) * ${GLOW_TILE_SCALE};
  float hit = 0.0;
  for (int j = 0; j < ${GLOW_TILE_SCALE}; j++) {
    for (int i = 0; i < ${GLOW_TILE_SCALE}; i++) {
      ivec2 tc = base + ivec2(i, j);
      if (tc.x >= uMapSize.x || tc.y >= uMapSize.y) continue;
      uint owner = texelFetch(uTiles, tc, 0).r & 0xfffu;
      if (owner != 0u && texelFetch(uSet, ivec2(int(owner), 0), 0).r > 0u) hit = 1.0;
    }
  }
  gl_FragColor = vec4(hit);
}
`;

const BLUR_FRAG = /* glsl */ `
${FRAG_OUTPUT}
uniform sampler2D uSrc;
uniform vec2 uDir;  // one texel along the blur axis (uv)
uniform vec2 uSize; // target size (texels)
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 r = texture(uSrc, uv) * 0.375;
  r += (texture(uSrc, uv + uDir) + texture(uSrc, uv - uDir)) * 0.25;
  r += (texture(uSrc, uv + 2.0 * uDir) + texture(uSrc, uv - 2.0 * uDir)) * 0.0625;
  gl_FragColor = r;
}
`;

/** Renders the blurred small-player mask into a render target pair. */
class GlowMask {
  readonly width: number;
  readonly height: number;
  private readonly a: THREE.WebGLRenderTarget;
  private readonly b: THREE.WebGLRenderTarget;
  private readonly setTex: THREE.DataTexture;
  private readonly setData = new Uint8Array(GLOW_SET_SIZE);
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly extract: THREE.ShaderMaterial;
  private readonly blurH: THREE.ShaderMaterial;
  private readonly blurV: THREE.ShaderMaterial;

  constructor(mapW: number, mapH: number, tiles: THREE.Texture) {
    this.width = Math.max(1, Math.ceil(mapW / GLOW_TILE_SCALE));
    this.height = Math.max(1, Math.ceil(mapH / GLOW_TILE_SCALE));
    const target = () =>
      new THREE.WebGLRenderTarget(this.width, this.height, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
    this.a = target();
    this.b = target();
    this.setTex = createIntegerTexture(this.setData, GLOW_SET_SIZE, 1, "R8UI");
    const size = new THREE.Vector2(this.width, this.height);
    const material = (fragmentShader: string, uniforms: object) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: QUAD_VERT,
        fragmentShader,
        uniforms: uniforms as Record<string, THREE.IUniform>,
        depthTest: false,
        depthWrite: false,
      });
    this.extract = material(EXTRACT_FRAG, {
      uTiles: { value: tiles },
      uSet: { value: this.setTex },
      uMapSize: { value: new THREE.Vector2(mapW, mapH) },
    });
    this.blurH = material(BLUR_FRAG, {
      uSrc: { value: this.a.texture },
      uDir: { value: new THREE.Vector2(1 / this.width, 0) },
      uSize: { value: size },
    });
    this.blurV = material(BLUR_FRAG, {
      uSrc: { value: this.b.texture },
      uDir: { value: new THREE.Vector2(0, 1 / this.height) },
      uSize: { value: size },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.extract);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** The blurred mask (sample with linear filtering). */
  get texture(): THREE.Texture {
    return this.a.texture;
  }

  /** Copies the set; true when it differs from the uploaded one. */
  setOwners(set: Uint8Array): boolean {
    const n = Math.min(set.length, GLOW_SET_SIZE);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const v = set[i] > 0 ? 1 : 0;
      if (this.setData[i] !== v) {
        this.setData[i] = v;
        changed = true;
      }
    }
    for (let i = n; i < GLOW_SET_SIZE; i++) {
      if (this.setData[i] !== 0) {
        this.setData[i] = 0;
        changed = true;
      }
    }
    return changed;
  }

  uploadSet(renderer: THREE.WebGLRenderer): void {
    uploadNow(renderer, this.setTex);
  }

  /** Extract + horizontal + vertical blur; restores the render target. */
  build(renderer: THREE.WebGLRenderer): void {
    const prev = renderer.getRenderTarget();
    const pass = (m: THREE.ShaderMaterial, rt: THREE.WebGLRenderTarget) => {
      this.quad.material = m;
      renderer.setRenderTarget(rt);
      renderer.render(this.scene, this.camera);
    };
    pass(this.extract, this.a);
    pass(this.blurH, this.b);
    pass(this.blurV, this.a);
    renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
    this.setTex.dispose();
    this.quad.geometry.dispose();
    this.extract.dispose();
    this.blurH.dispose();
    this.blurV.dispose();
  }
}

// ---------------------------------------------------------------------------
// Overlay owner
// ---------------------------------------------------------------------------

/** Linear rgb of an sRGB triple (0..1). */
function srgbToLinear3(c: readonly number[]): [number, number, number] {
  const f = (v: number) =>
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return [f(c[0] ?? 1), f(c[1] ?? 0), f(c[2] ?? 0)];
}

export interface SurfaceOverlayStats {
  gridOn: number;
  glowOn: number;
  glowMaskBuilds: number;
  glowSetUploads: number;
  /** Texels written per mask build (3 passes over W/4 × H/4). */
  glowMaskTexels: number;
}

export class SurfaceOverlay {
  /** Shared by reference with the terrain material and the sea plane. */
  readonly uniforms: SurfaceOverlayUniforms;
  readonly plane: THREE.Mesh;
  private readonly planeMaterial: THREE.ShaderMaterial;
  private glow: GlowMask | null = null;
  private glyphs: THREE.Texture | null = null;
  private glyphsTried = false;

  private gridView = false;
  private glowSet = false;
  /** A new set was pushed: rebuild the mask before it is next drawn. */
  private glowDirty = false;
  private glowAnim = 0;
  /** sRGB glow colour `uGlowColor` was last converted from. */
  private readonly glowColorSrgb = [NaN, NaN, NaN];

  private glowMaskBuilds = 0;
  private glowSetUploads = 0;

  constructor(
    private readonly renderSettings: RenderSettings,
    private readonly mapW: number,
    private readonly mapH: number,
    private readonly tiles: THREE.Texture,
    terrain: THREE.Texture,
    fogUniforms: Record<string, THREE.IUniform>,
  ) {
    this.uniforms = createSurfaceOverlayUniforms(mapW, mapH);
    this.planeMaterial = new THREE.ShaderMaterial({
      name: "three-sea-overlay",
      glslVersion: THREE.GLSL3,
      vertexShader: PLANE_VERT,
      fragmentShader: PLANE_FRAG,
      uniforms: {
        ...fogUniforms,
        ...this.uniforms,
        uTerrain: { value: terrain },
        uMapSize: { value: new THREE.Vector2(mapW, mapH) },
      },
      transparent: true,
      depthWrite: false,
      fog: true,
      // Behind coastal relief that sits just above sea level, in front of
      // the water plane (pushed back by 4 units).
      polygonOffset: true,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 2,
    });
    const geometry = new THREE.PlaneGeometry(mapW, mapH);
    geometry.rotateX(-Math.PI / 2);
    this.plane = new THREE.Mesh(geometry, this.planeMaterial);
    this.plane.position.set(mapW / 2, 0, mapH / 2);
    this.plane.name = "sea-overlay";
    this.plane.renderOrder = SEA_OVERLAY_RENDER_ORDER;
    this.plane.frustumCulled = false;
    this.plane.visible = false;
  }

  /** The persistent grid toggle (the alt view adds it while held). */
  setGridView(on: boolean): void {
    this.gridView = on;
  }

  /** Small-player set (1 byte per owner smallID), or null for none. */
  setSmallPlayers(set: Uint8Array | null, renderer: THREE.WebGLRenderer): void {
    if (set === null) {
      this.glowSet = false;
      return;
    }
    this.glow ??= new GlowMask(this.mapW, this.mapH, this.tiles);
    this.uniforms.uGlowMask.value = this.glow.texture;
    this.uniforms.uGlowMaskTiles.value.set(
      this.glow.width * GLOW_TILE_SCALE,
      this.glow.height * GLOW_TILE_SCALE,
    );
    if (this.glow.setOwners(set)) {
      this.glow.uploadSet(renderer);
      this.glowSetUploads++;
    }
    this.glowSet = true;
    // Rebuilt on every push, like the default (territories move).
    this.glowDirty = true;
  }

  /**
   * The mask's render targets come back empty after a context loss (three
   * re-uploads the set texture itself on first use): rebuild it.
   */
  contextRestored(): void {
    if (this.glowSet) this.glowDirty = true;
  }

  /**
   * Per frame, after the tile uploads: uniforms, the glow pulse and (when a
   * new set came) the mask passes.
   */
  update(frame: FrameInfo, renderer: THREE.WebGLRenderer): void {
    const u = this.uniforms;
    const rs = this.renderSettings;
    // --- Grid ---
    const grid = this.gridView || frame.altView;
    u.uGridOn.value = grid ? 1 : 0;
    if (grid) {
      const zoom = Math.max(1e-3, frame.cssPxPerTile * (frame.dpr || 1));
      u.uGridZoom.value = zoom;
      u.uGridFontPx.value = rs.altView.gridFontSize;
      u.uGridOpacity.value = rs.mapOverlay.coordinateGridOpacity;
      u.uGridStretch.value = 1 / Math.max(0.2, Math.cos(frame.tilt));
      const glyphs = this.glyphTexture();
      u.uGridGlyphs.value = glyphs;
      u.uGridLabels.value =
        glyphs !== null && u.uGridCell.value * zoom >= GRID_LABEL_MIN_CELL_PX
          ? 1
          : 0;
    }
    // --- Glow ---
    const s = rs.smallPlayerGlow;
    const strength = Math.min(1, s.strength);
    const glow = this.glowSet && strength > 0 && this.glow !== null;
    u.uGlowOn.value = glow ? 1 : 0;
    if (glow) {
      this.glowAnim += Math.min(frame.dtMs, GLOW_MAX_DT_MS) * s.pulseSpeed;
      u.uGlowIntensity.value = glowIntensity(s.alpha, this.glowAnim, strength);
      // Converted only when the setting changes (no per-frame allocation).
      const c = s.color;
      const last = this.glowColorSrgb;
      if (c[0] !== last[0] || c[1] !== last[1] || c[2] !== last[2]) {
        last[0] = c[0];
        last[1] = c[1];
        last[2] = c[2];
        u.uGlowColor.value.fromArray(srgbToLinear3(c));
      }
      if (this.glowDirty) {
        this.glow!.build(renderer);
        this.glowDirty = false;
        this.glowMaskBuilds++;
      }
    }
    const on = grid || glow;
    u.uOverlayOn.value = on ? 1 : 0;
    this.plane.visible = on;
  }

  perfStats(): SurfaceOverlayStats {
    const g = this.glow;
    return {
      gridOn: this.uniforms.uGridOn.value,
      glowOn: this.uniforms.uGlowOn.value,
      glowMaskBuilds: this.glowMaskBuilds,
      glowSetUploads: this.glowSetUploads,
      glowMaskTexels: g === null ? 0 : 3 * g.width * g.height,
    };
  }

  dispose(): void {
    this.plane.parent?.remove(this.plane);
    this.plane.geometry.dispose();
    this.planeMaterial.dispose();
    this.glow?.dispose();
    this.glow = null;
    this.glyphs?.dispose();
    this.glyphs = null;
  }

  /** The label atlas, drawn once on first use (null without a 2D canvas). */
  private glyphTexture(): THREE.Texture | null {
    if (this.glyphsTried) return this.glyphs;
    this.glyphsTried = true;
    this.glyphs = createGlyphAtlas();
    return this.glyphs;
  }
}

/** Glow alpha × pulse × strength (SmallPlayerGlowPass's composite input). */
export function glowIntensity(
  alpha: number,
  animTime: number,
  strength: number,
): number {
  return alpha * (0.5 + 0.5 * Math.sin(animTime)) * Math.min(1, strength);
}

/**
 * 0-9 and A-Z in one row, white with a black outline (CoordinateGridPass's
 * atlas at twice the resolution).
 */
function createGlyphAtlas(): THREE.Texture | null {
  let ctx: CanvasRenderingContext2D | null = null;
  const canvas = document.createElement("canvas");
  canvas.width = GLYPHS.length * GLYPH_W;
  canvas.height = GLYPH_H;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (ctx === null) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "black";
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.fillStyle = "white";
  ctx.font = `bold ${GLYPH_H - 10}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < GLYPHS.length; i++) {
    const x = i * GLYPH_W + GLYPH_W / 2;
    ctx.strokeText(GLYPHS[i], x, GLYPH_H / 2);
    ctx.fillText(GLYPHS[i], x, GLYPH_H / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
