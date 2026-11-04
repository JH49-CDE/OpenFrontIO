/**
 * WaterLayer — the sea surface: one plane at Y = 0 reaching 4 map sizes past
 * every edge (open ocean up to the horizon when tilted), one draw call.
 *
 * Shading (shaders/water.ts): depth tint from the water magnitude of the
 * tiles (shallow teal → deep navy, bilinear across tile centres), animated
 * sine-wave normals with per-octave anti-aliasing fades, sun glints, fresnel
 * sky reflection, animated shore foam, and see-through shallows over the
 * relief's seabed. Lakes use the same encoding, so they look the same.
 *
 * Land vs water is decided per tile from the terrain bytes (`discard` on
 * land tiles), never from the relief height: the relief is a low-pass grid.
 * Where the relief rises above the plane over water tiles, TerrainLayer
 * draws this same water shading itself.
 *
 * Boat (and nuke) trails over water tiles are painted here, with the same
 * GLSL and uniforms as TerrainLayer's (EffectTrails.ts, shared; TerrainLayer
 * sends the uploads).
 *
 * Draw order: transparent queue with `renderOrder` -10 (before other
 * transparent objects, which should keep renderOrder >= 0), depth-writing,
 * pushed back slightly with a polygon offset so coastal relief at sea level
 * wins the depth test.
 */

import * as THREE from "three";
import type { TerrainRect } from "../types";
import { EffectTrails } from "./EffectTrails";
import { environmentUniforms } from "./SceneEnvironment";
import { WATER_FRAG, WATER_VERT } from "./shaders/water";
import {
  createWaterUniforms,
  refreshWaterUniforms,
  TerrainByteTexture,
  type WaterUniforms,
  waterColorKey,
} from "./TerrainResources";
import type { FrameInfo, ThreeLayerContext } from "./types";

/** Water reaches this many map sizes past each edge. */
const OCEAN_PADDING_MAPS = 4;
/** Transparent-queue order: drawn before every default (0) transparent object. */
export const WATER_RENDER_ORDER = -10;

export class WaterLayer {
  private readonly terrainBytes: TerrainByteTexture;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly u: WaterUniforms & {
    uTerrain: { value: THREE.Texture };
    uMapSize: { value: THREE.Vector2 };
    uTime: { value: number };
    uAltView: { value: number };
    uSeabedDepth: { value: number };
    uPalette: { value: THREE.Texture };
  };
  private colorKey = "";
  private readonly trails: EffectTrails;

  constructor(private readonly ctx: ThreeLayerContext) {
    const W = ctx.mapWidth;
    const H = ctx.mapHeight;
    this.terrainBytes = TerrainByteTexture.acquire(ctx);
    this.trails = EffectTrails.acquire(ctx);

    this.u = {
      ...createWaterUniforms(),
      uTerrain: { value: this.terrainBytes.texture },
      uMapSize: { value: new THREE.Vector2(W, H) },
      uTime: { value: 0 },
      uAltView: { value: 0 },
      uSeabedDepth: { value: ctx.heightField.seabedDepth },
      // Trail colour without an effect (territory colour, row 0).
      uPalette: { value: ctx.palette.texture },
    };
    this.refreshColors();

    const pad = OCEAN_PADDING_MAPS * Math.max(W, H);
    const geometry = new THREE.PlaneGeometry(W + 2 * pad, H + 2 * pad);
    // PlaneGeometry lies in XY facing +Z; turn it to XZ facing up (+Y).
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      name: "three-water",
      glslVersion: THREE.GLSL3,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...environmentUniforms(ctx.scene),
        ...this.u,
        // Shared by reference with the terrain material.
        ...this.trails.uniforms,
      },
      transparent: true,
      depthWrite: true,
      fog: true,
      // A constant (slope-free) push of a few depth quanta: resolves the
      // coast-lifted relief (COAST_LIFT above sea level) when zoomed far
      // out, and is negligible zoomed in, where a slope-scaled offset would
      // let the shallow seabed poke through the surface.
      polygonOffset: true,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 4,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(W / 2, 0, H / 2);
    this.mesh.renderOrder = WATER_RENDER_ORDER;
    this.mesh.frustumCulled = false;
    this.mesh.name = "water";
    ctx.scene.add(this.mesh);
  }

  setTerrainBytes(
    rects: readonly TerrainRect[] | null,
    bytes: Uint8Array,
  ): void {
    // Shared with TerrainLayer: the first of the two calls uploads.
    this.terrainBytes.sync(rects, bytes);
  }

  update(frame: FrameInfo): void {
    // Same clock as TerrainLayer (it draws the coastal water with this GLSL).
    this.u.uTime.value = (frame.nowMs / 1000) % 3600;
    this.u.uAltView.value = frame.altView ? 1 : 0;
    if (waterColorKey(this.ctx.renderSettings.terrain) !== this.colorKey) {
      this.refreshColors();
    }
  }

  dispose(): void {
    this.ctx.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.terrainBytes.release();
    this.trails.release();
  }

  private refreshColors(): void {
    const t = this.ctx.renderSettings.terrain;
    refreshWaterUniforms(this.u, t);
    this.colorKey = waterColorKey(t);
  }
}
