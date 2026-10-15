import type { Token } from "#shared/model.ts";
import { footprint, snapPosition } from "../../lib/scene.ts";

/**
 * Tokens where they are being dragged to, for what follows a token: an aura
 * attached to it, and who stands in each area (features section 9).
 *
 * The room store holds a dragged token where the server last put it until
 * the drop commits, so these overlay the drags on the view's tokens. Each
 * drag counts at the cell it would drop on, which bounds the work: the areas
 * are recomputed when a dragged token crosses into another cell, not on each
 * of the 30 frames a second a drag sends. The spots travel as a short string
 * key, so a store selector can return it and React re-renders only when a
 * spot changes.
 */

export type Spot = { x: number; y: number };
type Placed = Pick<Token, "x" | "y" | "size" | "w" | "h">;

/** The cell each drag would drop its token on, leaving out drags that would not move it. */
export function dragSpots(
  tokens: Readonly<Record<string, Placed | undefined>>,
  drags: Iterable<{ tokenId: string; x: number; y: number }>,
): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  for (const d of drags) {
    const t = tokens[d.tokenId];
    if (!t || !Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    const at = snapPosition(d.x, d.y, footprint(t));
    if (at.x !== t.x || at.y !== t.y) spots.set(d.tokenId, at);
    else spots.delete(d.tokenId);
  }
  return spots;
}

export function spotsKey(spots: ReadonlyMap<string, Spot>): string {
  return [...spots]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, s]) => `${id}:${s.x},${s.y}`)
    .join(";");
}

export function parseSpotsKey(key: string): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  if (!key) return spots;
  for (const part of key.split(";")) {
    const colon = part.lastIndexOf(":");
    const [xs, ys] = part.slice(colon + 1).split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (colon > 0 && Number.isFinite(x) && Number.isFinite(y)) spots.set(part.slice(0, colon), { x, y });
  }
  return spots;
}

/** The tokens with each spot applied. The same map back when nothing moves, so caches keyed on it hold. */
export function withSpots<T extends { x: number; y: number }>(
  tokens: Readonly<Record<string, T | undefined>>,
  spots: ReadonlyMap<string, Spot>,
): Readonly<Record<string, T | undefined>> {
  let out: Record<string, T | undefined> | null = null;
  for (const [id, s] of spots) {
    const t = tokens[id];
    if (!t || (t.x === s.x && t.y === s.y)) continue;
    out ??= { ...tokens };
    out[id] = { ...t, x: s.x, y: s.y };
  }
  return out ?? tokens;
}
