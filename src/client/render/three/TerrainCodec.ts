/**
 * Pure helpers for the per-tile terrain byte and tile-state word, shared by
 * every Three.js layer. No three import, so tests and workers can use it.
 *
 * Terrain byte (packages/engine-lib/src/game/GameMapImpl.ts):
 *   bit 7 land, bit 6 shoreline, bit 5 ocean (water only), bits 0-4 magnitude.
 *   Land magnitude is elevation (0-30; 31 = impassable "void"), water
 *   magnitude is distance from shore / 2 (0 at the shoreline, capped at 31).
 * Tile state (Uint16): bits 0-11 owner smallID (0 = unowned), bit 13 fallout,
 *   bit 14 defense bonus.
 */

export const LAND_BIT = 0x80;
export const SHORELINE_BIT = 0x40;
export const OCEAN_BIT = 0x20;
export const MAGNITUDE_MASK = 0x1f;
export const IMPASSABLE_MAGNITUDE = 31;
/** Highest land magnitude the map generator emits for passable land. */
export const MAX_LAND_MAGNITUDE = 30;

export const OWNER_MASK = 0xfff;
export const FALLOUT_BIT = 1 << 13;
export const DEFENSE_BIT = 1 << 14;

/** Coarse terrain class used for colouring and height. */
export const TerrainKind = {
  Water: 0,
  Plains: 1,
  Highland: 2,
  Mountain: 3,
  Impassable: 4,
} as const;
export type TerrainKind = (typeof TerrainKind)[keyof typeof TerrainKind];

export function isLand(tb: number): boolean {
  return (tb & LAND_BIT) !== 0;
}
export function isShoreline(tb: number): boolean {
  return (tb & SHORELINE_BIT) !== 0;
}
export function isOcean(tb: number): boolean {
  return (tb & OCEAN_BIT) !== 0;
}
export function magnitude(tb: number): number {
  return tb & MAGNITUDE_MASK;
}
export function isImpassable(tb: number): boolean {
  return (
    (tb & (LAND_BIT | MAGNITUDE_MASK)) === (LAND_BIT | IMPASSABLE_MAGNITUDE)
  );
}

/** Same thresholds as the engine's `terrainType()`. */
export function terrainKind(tb: number): TerrainKind {
  if (!isLand(tb)) return TerrainKind.Water;
  const m = tb & MAGNITUDE_MASK;
  if (m === IMPASSABLE_MAGNITUDE) return TerrainKind.Impassable;
  if (m < 10) return TerrainKind.Plains;
  if (m < 20) return TerrainKind.Highland;
  return TerrainKind.Mountain;
}

export function ownerOf(state: number): number {
  return state & OWNER_MASK;
}
export function hasFallout(state: number): boolean {
  return (state & FALLOUT_BIT) !== 0;
}

/** World Y of passable land at magnitude 0, as a fraction of heightScale. */
export const LAND_BASE_FRACTION = 0.03;
/** Impassable tiles sit flat at this fraction of heightScale. */
export const IMPASSABLE_HEIGHT_FRACTION = LAND_BASE_FRACTION;
/** Shallowest seabed (shoreline water) as a fraction of seabedDepth. */
export const SHORE_DEPTH_FRACTION = 0.08;
/** Water magnitude at which the seabed reaches full depth. */
export const FULL_DEPTH_MAGNITUDE = 12;
/** Exponent of the land elevation curve: >1 keeps plains low, peaks sharp. */
export const LAND_HEIGHT_EXPONENT = 1.6;

/**
 * World height (Y, tiles) of a tile with this terrain byte. Sea level is 0.
 *
 * - Land: `heightScale * (base + (1 - base) * (m/30)^1.6)`, so magnitude 0 is
 *   just above the water and 30 reaches `heightScale`.
 * - Impassable: flat, just above the water (it is drawn as "void").
 * - Water: `-seabedDepth * (shore + (1 - shore) * sqrt(min(m, 12)/12))`, a
 *   shelf that drops quickly away from the coast.
 */
export function heightForTerrainByte(
  tb: number,
  heightScale: number,
  seabedDepth: number,
): number {
  const m = tb & MAGNITUDE_MASK;
  if ((tb & LAND_BIT) !== 0) {
    if (m === IMPASSABLE_MAGNITUDE) {
      return heightScale * IMPASSABLE_HEIGHT_FRACTION;
    }
    const t = Math.min(m, MAX_LAND_MAGNITUDE) / MAX_LAND_MAGNITUDE;
    return (
      heightScale *
      (LAND_BASE_FRACTION +
        (1 - LAND_BASE_FRACTION) * Math.pow(t, LAND_HEIGHT_EXPONENT))
    );
  }
  const d = Math.min(m, FULL_DEPTH_MAGNITUDE) / FULL_DEPTH_MAGNITUDE;
  return (
    -seabedDepth *
    (SHORE_DEPTH_FRACTION + (1 - SHORE_DEPTH_FRACTION) * Math.sqrt(d))
  );
}

/** `heightForTerrainByte` for all 256 byte values (index = byte). */
export function buildHeightLut(
  heightScale: number,
  seabedDepth: number,
): Float32Array {
  const lut = new Float32Array(256);
  for (let b = 0; b < 256; b++) {
    lut[b] = heightForTerrainByte(b, heightScale, seabedDepth);
  }
  return lut;
}
