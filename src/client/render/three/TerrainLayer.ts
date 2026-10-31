/**
 * TerrainLayer — the relief mesh, with terrain colours, lighting, territory
 * fill, borders, fallout and coastal water, in ONE draw call.
 *
 * Geometry: the HeightField grid (bounded vertex count) plus vertical
 * "skirts" down the four map edges, so a tilted view never looks under the
 * relief. Cells that hold any land tile are kept at or above
 * `COAST_LIFT` (the grid is a low-pass of the tiles, so thin land would
 * otherwise sink under the water plane): coastlines are then decided per
 * tile by the shader, and where the relief rises above sea level over water
 * tiles the shader draws the water surface itself (the same GLSL as
 * WaterLayer, so the two are seamless).
 *
 * Shading (shaders/terrain.ts) works at TILE resolution with texelFetch on:
 * terrain bytes (R8UI, shared with WaterLayer), tile state (R16UI, the live
 * engine buffer referenced directly), the relation matrix (R8UI) and the
 * palette (RGBA32F). Partial tile uploads are per-row texel spans; nothing
 * loops over tiles per frame.
 *
 * Contract notes:
 * - `setTiles(tileState, changed)`: `tileState` is the live engine-mirror
 *   buffer, mutated again on the next tick. The texture references it, so a
 *   row re-upload always sends current data. `changed === null` = full upload.
 * - `setTerrainBytes(null, bytes)`: `bytes` is the full-map array (the same
 *   instance as `ctx.heightField.terrain`). With rects, the facade has
 *   ALREADY patched `heightField.terrain` and recomputed the heights
 *   (`heightField.lastDirty` holds the changed vertex range).
 * - `setDefenseCoverage` is a documented no-op (the engine never sets the
 *   tile defense bit, and posts are drawn by StructureLayer).
 */

import * as THREE from "three";
import type { TerrainRect, UnitState } from "../types";
import type { GridRange, HeightField } from "./HeightField";
import { environmentUniforms } from "./SceneEnvironment";
import { TERRAIN_FRAG, TERRAIN_VERT } from "./shaders/terrain";
import {
  createIntegerTexture,
  createWaterUniforms,
  refreshWaterUniforms,
  setTextureData,
  TerrainByteTexture,
  textureData,
  uploadNow,
  type WaterUniforms,
  waterColorKey,
} from "./TerrainResources";
import {
  addTexelSpan,
  COAST_LIFT,
  computeCellLand,
  hexToSrgb01,
  type Rgb,
  RowSpans,
  vertexTouchesLand,
} from "./TerrainShading";
import type { FrameInfo, ThreeLayerContext } from "./types";

/** Size of the relation matrix (frame/derive/RelationMatrix.ts). */
const RELATION_SIZE = 1024;
/** Target border width in CSS px (clamped to [MIN_BORDER_TILES, 1] tile). */
const BORDER_CSS_PX = 1.3;
/**
 * Thinnest border, in tiles: zoomed in, borders grow with the zoom (the 2D
 * renderer's are a full tile) so they stay readable on busy relief.
 */
const MIN_BORDER_TILES = 0.2;
/**
 * Border emission (fraction of its colour): borders stay crisp under any
 * shading, and highlighted ones (3x) pass the bloom threshold and glow.
 */
const BORDER_GLOW = 0.25;
/** Skirt bottom, below the deepest seabed. */
const SKIRT_EXTRA_DEPTH = 1;

/** Fallbacks = render-settings.json defaults (sRGB 0..1). */
const DEFAULT_TERRAIN = {
  sand: [204, 203, 158],
  plains: [190, 220, 138],
  highland: [220, 203, 158],
  mountain: [230, 230, 230],
  void: [60, 60, 60],
} as const;

const v3 = (): { value: THREE.Vector3 } => ({ value: new THREE.Vector3() });
const f1 = (value: number): { value: number } => ({ value });

function srgb255(c: readonly [number, number, number]): Rgb {
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

/** Uniforms of the terrain material (besides environment / water / fog). */
function createTerrainUniforms() {
  return {
    uTerrain: { value: null as THREE.Texture | null },
    uTiles: { value: null as THREE.Texture | null },
    uRelations: { value: null as THREE.Texture | null },
    uPalette: { value: null as THREE.Texture | null },
    uMapSize: { value: new THREE.Vector2(1, 1) },
    uRelSize: f1(RELATION_SIZE),
    uTime: f1(0),
    uHeightScale: f1(1),
    uColSand: v3(),
    uColPlains: v3(),
    uColHighland: v3(),
    uColMountain: v3(),
    uColVoid: v3(),
    uFillAlpha: f1(0.588),
    uFillSaturation: f1(0.85),
    uHighlightFill: f1(0.15),
    uHighlightBorder: f1(0.25),
    uEmbargoTint: v3(),
    uEmbargoRatio: f1(0.35),
    uFriendlyTint: v3(),
    uFriendlyRatio: f1(0.35),
    uFalloutColor: v3(),
    uHighlightOwner: f1(0),
    uLocalPlayer: f1(0),
    uAltView: f1(0),
    uAltFillAlpha: f1(0.3),
    uAffSelf: v3(),
    uAffAlly: v3(),
    uAffNeutral: v3(),
    uAffEnemy: v3(),
    uBorderPx: f1(BORDER_CSS_PX),
    uMinBorder: f1(MIN_BORDER_TILES),
    uBorderGlow: f1(BORDER_GLOW),
  };
}
type TerrainUniforms = ReturnType<typeof createTerrainUniforms> & WaterUniforms;

/** One map edge's skirt: which grid vertices it hangs from, and its facing. */
interface SkirtEdge {
  /** Grid vertex index of each skirt column, in edge order. */
  grid: Int32Array;
  /** First skirt vertex (columns are [top, bottom] pairs). */
  base: number;
  nx: number;
  nz: number;
}

export class TerrainLayer {
  private readonly hf: HeightField;
  private readonly W: number;
  private readonly H: number;
  private readonly terrainBytes: TerrainByteTexture;
  private readonly tileTex: THREE.DataTexture;
  /** False until the tile texture got a full upload from us. */
  private tilesUploaded = false;
  private relTex: THREE.DataTexture;
  private relSize = RELATION_SIZE;
  private readonly spans: RowSpans;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly u: TerrainUniforms;
  private waterKey = "";

  // Relief geometry (grid vertices first, then skirt [top, bottom] pairs).
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly gridCount: number;
  private readonly skirts: SkirtEdge[] = [];
  private readonly skirtVertexCount: number;
  private readonly skirtBottomY: number;
  private readonly cellsX: number;
  private readonly cellsY: number;
  private readonly cellLand: Uint8Array;
  /** HeightField version the relief geometry was last built from. */
  private reliefVersion = -1;

  constructor(private readonly ctx: ThreeLayerContext) {
    const hf = ctx.heightField;
    this.hf = hf;
    this.W = ctx.mapWidth;
    this.H = ctx.mapHeight;
    this.spans = new RowSpans(this.W, this.H);

    // ---- Textures ----
    this.terrainBytes = TerrainByteTexture.acquire(ctx);
    // Placeholder until the first setTiles (lazily zero-filled memory).
    this.tileTex = createIntegerTexture(
      new Uint16Array(this.W * this.H),
      this.W,
      this.H,
      "R16UI",
    );
    this.relTex = createIntegerTexture(
      new Uint8Array(RELATION_SIZE * RELATION_SIZE),
      RELATION_SIZE,
      RELATION_SIZE,
      "R8UI",
    );

    // ---- Geometry ----
    this.cellsX = hf.cols - 1;
    this.cellsY = hf.rows - 1;
    this.cellLand = new Uint8Array(this.cellsX * this.cellsY);
    this.gridCount = hf.cols * hf.rows;
    this.skirtVertexCount = 2 * (2 * hf.cols + 2 * hf.rows);
    this.skirtBottomY = -(hf.seabedDepth + SKIRT_EXTRA_DEPTH);
    const vertexCount = this.gridCount + this.skirtVertexCount;
    this.positions = new Float32Array(vertexCount * 3);
    this.normals = new Float32Array(vertexCount * 3);
    this.buildStaticGeometry();
    this.refreshRelief(null);
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(this.normals, 3),
    );

    // ---- Material ----
    this.u = {
      ...createTerrainUniforms(),
      ...createWaterUniforms(),
    };
    this.u.uTerrain.value = this.terrainBytes.texture;
    this.u.uTiles.value = this.tileTex;
    this.u.uRelations.value = this.relTex;
    this.u.uPalette.value = ctx.palette.texture;
    this.u.uMapSize.value.set(this.W, this.H);
    this.u.uHeightScale.value = hf.heightScale;
    this.refreshColors();
    this.refreshOverlaySettings();
    this.material = new THREE.ShaderMaterial({
      name: "three-terrain",
      glslVersion: THREE.GLSL3,
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        // Shared by reference: values follow SceneEnvironment.
        ...environmentUniforms(ctx.scene),
        ...this.u,
      },
      fog: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = "terrain";
    ctx.scene.add(this.mesh);
  }

  setTiles(
    tileState: Uint16Array,
    changedTiles: readonly number[] | null,
  ): void {
    const W = this.W;
    if (tileState.length !== W * this.H) return;
    const tex = this.tileTex;
    if (
      changedTiles === null ||
      !this.tilesUploaded ||
      textureData(tex) !== tileState
    ) {
      setTextureData(tex, tileState);
      uploadNow(this.ctx.renderer, tex);
      this.tilesUploaded = true;
      return;
    }
    const n = this.spans.collect(changedTiles);
    if (n === 0) return;
    let texels = 0;
    for (let k = 0; k < n; k++) texels += this.spans.x1[k] - this.spans.x0[k];
    // Past half the map, one full upload beats thousands of row calls.
    if (texels + n > (W * this.H) / 2) {
      uploadNow(this.ctx.renderer, tex);
      return;
    }
    for (let k = 0; k < n; k++) {
      const x0 = this.spans.x0[k];
      addTexelSpan(tex, W, x0, this.spans.rows[k], this.spans.x1[k] - x0 + 1);
    }
    tex.needsUpdate = true;
  }

  setTerrainBytes(
    rects: readonly TerrainRect[] | null,
    bytes: Uint8Array,
  ): void {
    this.terrainBytes.sync(rects, bytes);
    // The HeightField version tells whether heights changed since we last
    // read them (the constructor already did, before the facade's first
    // full call).
    if (this.hf.version === this.reliefVersion) return;
    this.refreshRelief(rects === null ? null : this.hf.lastDirty);
  }

  /** Terrain colours / render settings changed. */
  rebuild(): void {
    this.refreshColors();
    this.refreshOverlaySettings();
  }

  setRelations(data: Uint8Array, size: number): void {
    if (!(size > 0) || data.length < size * size) return;
    if (size !== this.relSize) {
      this.relTex.dispose();
      this.relTex = createIntegerTexture(data, size, size, "R8UI");
      this.relSize = size;
      this.u.uRelations.value = this.relTex;
      this.u.uRelSize.value = size;
    } else {
      setTextureData(this.relTex, data);
    }
    uploadNow(this.ctx.renderer, this.relTex);
  }

  /** Not drawn: no defended-territory tint in the prototype. */
  setDefenseCoverage(units: ReadonlyMap<number, UnitState>): void {}

  update(frame: FrameInfo): void {
    const u = this.u;
    u.uTime.value = (frame.nowMs / 1000) % 3600;
    u.uHighlightOwner.value = frame.highlightOwner;
    u.uLocalPlayer.value = frame.localPlayerID;
    u.uAltView.value = frame.altView ? 1 : 0;
    u.uBorderPx.value = BORDER_CSS_PX * (frame.dpr > 0 ? frame.dpr : 1);
    this.refreshOverlaySettings();
    const key = waterColorKey(this.ctx.renderSettings.terrain);
    if (key !== this.waterKey) this.refreshColors();
  }

  dispose(): void {
    this.ctx.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.tileTex.dispose();
    this.relTex.dispose();
    this.terrainBytes.release();
  }

  // ---- Uniform refresh ----

  /** Terrain + water colours from `renderSettings.terrain`. */
  private refreshColors(): void {
    const t = this.ctx.renderSettings.terrain;
    const u = this.u;
    const set = (
      target: { value: THREE.Vector3 },
      hex: string,
      fallback: readonly [number, number, number],
    ) => target.value.fromArray(hexToSrgb01(hex, srgb255(fallback)));
    set(u.uColSand, t.sandColor, DEFAULT_TERRAIN.sand);
    set(u.uColPlains, t.plainsColor, DEFAULT_TERRAIN.plains);
    set(u.uColHighland, t.highlandColor, DEFAULT_TERRAIN.highland);
    set(u.uColMountain, t.mountainColor, DEFAULT_TERRAIN.mountain);
    set(u.uColVoid, t.backgroundColor, DEFAULT_TERRAIN.void);
    refreshWaterUniforms(u, t);
    this.waterKey = waterColorKey(t);
  }

  /** Territory look from `renderSettings.mapOverlay` / affiliation (cheap). */
  private refreshOverlaySettings(): void {
    const s = this.ctx.renderSettings;
    const o = s.mapOverlay;
    const a = s.affiliation;
    const u = this.u;
    // Same opacity as the default renderer: with neutral tone mapping the
    // fills read as in 2D, and the hillshade still shows through.
    u.uFillAlpha.value = Math.min(1, Math.max(0, o.territoryAlpha));
    u.uFillSaturation.value = o.territorySaturation;
    u.uHighlightFill.value = o.highlightFillBrighten;
    u.uHighlightBorder.value = o.highlightBrighten;
    u.uEmbargoTint.value.set(o.embargoTintR, o.embargoTintG, o.embargoTintB);
    u.uEmbargoRatio.value = o.embargoTintRatio;
    u.uFriendlyTint.value.set(
      o.friendlyTintR,
      o.friendlyTintG,
      o.friendlyTintB,
    );
    u.uFriendlyRatio.value = o.friendlyTintRatio;
    u.uFalloutColor.value.set(o.staleNukeR, o.staleNukeG, o.staleNukeB);
    u.uAffSelf.value.set(a.selfR, a.selfG, a.selfB);
    u.uAffAlly.value.set(a.allyR, a.allyG, a.allyB);
    u.uAffNeutral.value.set(a.neutralR, a.neutralG, a.neutralB);
    u.uAffEnemy.value.set(a.enemyR, a.enemyG, a.enemyB);
    // The alt view dims the terrain, so its fill can be stronger.
    u.uAltFillAlpha.value = Math.min(1, Math.max(0.3, 2 * s.altView.fillAlpha));
  }

  // ---- Geometry ----

  /** X/Z of all vertices, skirt normals and the index buffer (once). */
  private buildStaticGeometry(): void {
    const hf = this.hf;
    const cols = hf.cols;
    const rows = hf.rows;
    const pos = this.positions;
    for (let j = 0; j < rows; j++) {
      const z = hf.vertexY(j);
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 3;
        pos[k] = hf.vertexX(i);
        pos[k + 2] = z;
      }
    }

    // Skirts: north (z = 0), south (z = H), west (x = 0), east (x = W),
    // each running along +X or +Z.
    const edgeDefs: {
      n: number;
      at: (s: number) => number;
      nx: number;
      nz: number;
    }[] = [
      { n: cols, at: (s) => s, nx: 0, nz: -1 },
      { n: cols, at: (s) => (rows - 1) * cols + s, nx: 0, nz: 1 },
      { n: rows, at: (s) => s * cols, nx: -1, nz: 0 },
      { n: rows, at: (s) => s * cols + cols - 1, nx: 1, nz: 0 },
    ];
    let base = this.gridCount;
    for (const e of edgeDefs) {
      const grid = new Int32Array(e.n);
      for (let s = 0; s < e.n; s++) {
        grid[s] = e.at(s);
        for (const v of [base + 2 * s, base + 2 * s + 1]) {
          pos[v * 3] = pos[grid[s] * 3];
          pos[v * 3 + 2] = pos[grid[s] * 3 + 2];
          this.normals[v * 3] = e.nx;
          this.normals[v * 3 + 1] = 0;
          this.normals[v * 3 + 2] = e.nz;
        }
        pos[(base + 2 * s + 1) * 3 + 1] = this.skirtBottomY;
      }
      this.skirts.push({ grid, base, nx: e.nx, nz: e.nz });
      base += 2 * e.n;
    }

    // Index: grid cells, counter-clockwise seen from above (+Y), then skirt
    // quads facing outwards.
    const cells = (cols - 1) * (rows - 1);
    let skirtQuads = 0;
    for (const s of this.skirts) skirtQuads += s.grid.length - 1;
    const index = new Uint32Array((cells + skirtQuads) * 6);
    let o = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        index[o++] = a;
        index[o++] = c;
        index[o++] = b;
        index[o++] = b;
        index[o++] = c;
        index[o++] = d;
      }
    }
    for (const s of this.skirts) {
      // The edge runs along e = +X or +Z; triangle (top_a, top_b, bot_a)
      // has normal e × (0, -1, 0) = (e.z, 0, -e.x). Flip the winding when
      // that points into the map instead of along the outward normal.
      const ex = s.nz !== 0 ? 1 : 0;
      const ez = s.nx !== 0 ? 1 : 0;
      const flip = ez * s.nx - ex * s.nz < 0;
      for (let q = 0; q < s.grid.length - 1; q++) {
        const ta = s.base + 2 * q;
        const ba = ta + 1;
        const tb = ta + 2;
        const bb = ta + 3;
        if (!flip) {
          index[o++] = ta;
          index[o++] = tb;
          index[o++] = ba;
          index[o++] = tb;
          index[o++] = bb;
          index[o++] = ba;
        } else {
          index[o++] = ta;
          index[o++] = ba;
          index[o++] = tb;
          index[o++] = tb;
          index[o++] = ba;
          index[o++] = bb;
        }
      }
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  /**
   * Recompute vertex heights (with the coast lift), normals and skirt tops
   * for the HeightField vertex range `r` (null = everything), and queue the
   * matching buffer uploads.
   */
  private refreshRelief(r: GridRange | null): void {
    const hf = this.hf;
    const cols = hf.cols;
    const rows = hf.rows;
    const full: GridRange = { i0: 0, j0: 0, i1: cols - 1, j1: rows - 1 };
    const dirty = r ?? full;
    this.reliefVersion = hf.version;
    const grow = (g: GridRange, by: number): GridRange => ({
      i0: Math.max(0, g.i0 - by),
      j0: Math.max(0, g.j0 - by),
      i1: Math.min(cols - 1, g.i1 + by),
      j1: Math.min(rows - 1, g.j1 + by),
    });

    // Cells holding the changed tiles (and one around, cheap).
    computeCellLand(
      hf.terrain,
      this.W,
      this.H,
      hf.step,
      this.cellsX,
      this.cellsY,
      this.cellLand,
      dirty.i0 - 1,
      dirty.j0 - 1,
      dirty.i1,
      dirty.j1,
    );
    // Heights of every vertex touching those cells, normals one ring wider.
    const yRange = grow(dirty, 1);
    const nRange = grow(yRange, 1);
    const pos = this.positions;
    const heights = hf.heights;
    for (let j = yRange.j0; j <= yRange.j1; j++) {
      for (let i = yRange.i0; i <= yRange.i1; i++) {
        const k = j * cols + i;
        let y = heights[k];
        if (
          y < COAST_LIFT &&
          vertexTouchesLand(this.cellLand, this.cellsX, this.cellsY, i, j)
        ) {
          y = COAST_LIFT;
        }
        pos[k * 3 + 1] = y;
      }
    }
    this.computeNormals(nRange);
    // Skirt tops follow the edge vertices (a few thousand: just redo all).
    for (const s of this.skirts) {
      for (let q = 0; q < s.grid.length; q++) {
        pos[(s.base + 2 * q) * 3 + 1] = pos[s.grid[q] * 3 + 1];
      }
    }

    const position = this.geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    const normal = this.geometry.getAttribute("normal") as
      | THREE.BufferAttribute
      | undefined;
    if (!position || !normal) return; // first build: attributes not created yet
    for (const attr of [position, normal]) {
      attr.clearUpdateRanges();
      if (r !== null) {
        attr.addUpdateRange(
          nRange.j0 * cols * 3,
          (nRange.j1 - nRange.j0 + 1) * cols * 3,
        );
        attr.addUpdateRange(this.gridCount * 3, this.skirtVertexCount * 3);
      }
      attr.needsUpdate = true;
    }
  }

  /** Grid normals from central differences of the displayed heights. */
  private computeNormals(r: GridRange): void {
    const hf = this.hf;
    const cols = hf.cols;
    const rows = hf.rows;
    const pos = this.positions;
    const nrm = this.normals;
    for (let j = r.j0; j <= r.j1; j++) {
      const jm = j > 0 ? j - 1 : j;
      const jp = j < rows - 1 ? j + 1 : j;
      const dz = hf.vertexY(jp) - hf.vertexY(jm);
      for (let i = r.i0; i <= r.i1; i++) {
        const im = i > 0 ? i - 1 : i;
        const ip = i < cols - 1 ? i + 1 : i;
        const dx = hf.vertexX(ip) - hf.vertexX(im);
        const gx =
          dx > 0
            ? (pos[(j * cols + ip) * 3 + 1] - pos[(j * cols + im) * 3 + 1]) / dx
            : 0;
        const gz =
          dz > 0
            ? (pos[(jp * cols + i) * 3 + 1] - pos[(jm * cols + i) * 3 + 1]) / dz
            : 0;
        // Surface y = h(x, z) has normal (-dh/dx, 1, -dh/dz), normalised.
        const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        const k = (j * cols + i) * 3;
        nrm[k] = -gx * inv;
        nrm[k + 1] = inv;
        nrm[k + 2] = -gz * inv;
      }
    }
  }
}
