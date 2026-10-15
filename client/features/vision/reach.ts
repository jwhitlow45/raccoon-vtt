import type { TokenLight } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { MAX_LIGHT_FT } from "#shared/model.ts";
import { lightCells, senseCells } from "#shared/rules/vision.ts";

/**
 * How far a sense or a light really reaches on the room's grid
 * (docs/design-v1-maps-vision.md section 2.4). Sight stops a sense at
 * LIMITS.senseMaxCells and each light radius at LIMITS.lightRadiusMaxCells
 * as well as at their feet, so a grid finer than 5 ft per cell costs what
 * 5 ft does. There a 60 ft darkvision reaches 30 cells, which is 30 ft at
 * 1 ft per cell. Wherever a range is shown, it says so only when the grid
 * cuts it short, so a 5 ft grid reads as it always has. The cuts are the
 * server's own (shared/rules/vision.ts), so the words match the sight.
 */

function perCell(feetPerCell: number): number {
  return feetPerCell > 0 ? feetPerCell : 5;
}

function tenths(v: number): number {
  return Math.round(v * 10) / 10;
}

/** What a sense of `feet` reaches on this grid, or null when the grid does not cut it short. */
export function senseOnGrid(feet: number, feetPerCell: number): number | null {
  const fpc = perCell(feetPerCell);
  const cells = senseCells(feet, fpc);
  return cells < feet / fpc ? tenths(cells * fpc) : null;
}

/** What a light reaches on this grid, as radii in feet, or null when the grid does not cut it short. */
export function lightOnGrid(light: TokenLight, feetPerCell: number): TokenLight | null {
  const fpc = perCell(feetPerCell);
  const { rb, rd } = lightCells(light.bright, light.dim, fpc);
  if (rb === light.bright / fpc && rd === (light.bright + light.dim) / fpc) return null;
  const bright = tenths(rb * fpc);
  return { bright, dim: tenths(rd * fpc - bright) };
}

/** The words added after a range the grid cuts short. */
export function reachesOnGrid(text: string): string {
  return ` (reaches ${text} on this grid)`;
}

/** A sense's range in words: "60 ft", or "60 ft (reaches 30 ft on this grid)". */
export function senseFeetText(feet: number, feetPerCell: number): string {
  const cut = senseOnGrid(feet, feetPerCell);
  return cut === null ? `${feet} ft` : `${feet} ft${reachesOnGrid(`${cut} ft`)}`;
}

/** The longest any light radius reaches on this grid, in feet: 120, or less on a grid finer than 5 ft. */
export function radiusCapFt(feetPerCell: number): number {
  return Math.min(MAX_LIGHT_FT, LIMITS.lightRadiusMaxCells * perCell(feetPerCell));
}
