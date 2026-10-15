import { FOG_SUBCELLS } from "#shared/model.ts";
import type { Rect } from "./camera.ts";
import type { FogMask } from "./fogTiles.ts";

/**
 * What "Fit map" shows (UP-20). A DM, or anyone on a scene without fog,
 * sees the whole scene. A player under fog sees what is revealed and their
 * own tokens, since the whole scene would be mostly black with the part
 * that matters in a corner. Nothing revealed and no tokens falls back to
 * the whole scene. A cell of room is left around the target.
 */
export function fitTarget(input: {
  bounds: { w: number; h: number };
  /** The revealed fog for a player, or null when the whole scene counts. */
  revealed: FogMask | null;
  /** The player's own tokens on this scene, as cell rectangles. */
  own: readonly Rect[];
}): Rect {
  const whole = { x: 0, y: 0, width: input.bounds.w, height: input.bounds.h };
  if (!input.revealed) return whole;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const { width, height, revealed } = input.revealed;
  for (let sy = 0; sy < height; sy++) {
    const row = sy * width;
    for (let sx = 0; sx < width; sx++) {
      if (revealed[row + sx] !== 1) continue;
      if (sx < minX) minX = sx;
      if (sx + 1 > maxX) maxX = sx + 1;
      if (sy < minY) minY = sy;
      if (sy + 1 > maxY) maxY = sy + 1;
    }
  }
  if (minX !== Infinity) {
    minX /= FOG_SUBCELLS;
    minY /= FOG_SUBCELLS;
    maxX /= FOG_SUBCELLS;
    maxY /= FOG_SUBCELLS;
  }
  for (const r of input.own) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (minX === Infinity) return whole;
  const x = Math.max(0, minX - 1);
  const y = Math.max(0, minY - 1);
  const right = Math.min(input.bounds.w, maxX + 1);
  const bottom = Math.min(input.bounds.h, maxY + 1);
  return { x, y, width: right - x, height: bottom - y };
}
