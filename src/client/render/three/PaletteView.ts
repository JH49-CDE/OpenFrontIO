/**
 * PaletteView — the player palette (4096 × 2 RGBA floats, written by
 * `writePaletteEntry` in gl/utils/PlayerPalette.ts) as CPU lookups plus one
 * shared GPU texture.
 *
 * Layout (index = owner smallID, rgb in 0..1, entry 0 = unowned stays zero):
 *   row 0, `[sid*4 .. +2]`           territory fill
 *   row 1, `[16384 + sid*4 .. +2]`   border (local player: light grey)
 * Shaders sample row 0 at v = 0.25 and row 1 at v = 0.75 (NEAREST, no flip),
 * or `texelFetch(tex, ivec2(sid, row), 0)`.
 */

import * as THREE from "three";

export const PALETTE_WIDTH = 4096;
const ROW1 = PALETTE_WIDTH * 4;

export class PaletteView {
  /** Own copy of the palette floats (the texture's backing store). */
  readonly data = new Float32Array(PALETTE_WIDTH * 2 * 4);
  readonly texture: THREE.DataTexture;
  /** Bumped on every `update`. */
  version = 0;

  constructor(initial?: Float32Array) {
    if (initial) this.copyFrom(initial);
    this.texture = new THREE.DataTexture(
      this.data,
      PALETTE_WIDTH,
      2,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    // Colours are already linear-ish 0..1 values consumed by shaders as-is.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  /** Replace the palette (a full 4096×2×4 array, or a prefix of one). */
  update(data: Float32Array): void {
    this.copyFrom(data);
    this.texture.needsUpdate = true;
    this.version++;
  }

  /** Territory fill colour of an owner, rgb 0..1 (palette row 0). */
  fill(sid: number): [number, number, number] {
    const o = (sid & (PALETTE_WIDTH - 1)) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2]];
  }

  /** Border colour of an owner, rgb 0..1 (palette row 1). */
  border(sid: number): [number, number, number] {
    const o = ROW1 + (sid & (PALETTE_WIDTH - 1)) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2]];
  }

  dispose(): void {
    this.texture.dispose();
  }

  private copyFrom(src: Float32Array): void {
    if (src === this.data) return;
    if (src.length >= this.data.length) {
      this.data.set(src.subarray(0, this.data.length));
    } else {
      this.data.set(src);
    }
  }
}
