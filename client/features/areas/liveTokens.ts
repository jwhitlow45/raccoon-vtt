import type { Token } from "#shared/model.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { atDragSpot, footprint, frameAim, snapPosition } from "../../lib/scene.ts";

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

/** A spot, with the squeeze its landing has where the drag knows it (state/localDrags.ts DragSpot). */
export type Spot = { x: number; y: number; squeeze?: boolean };
type Placed = Pick<Token, "x" | "y" | "size" | "w" | "h" | "squeeze">;

/**
 * The spot each drag would drop its token on, from where it aims in rules
 * coordinates, snapped on its scene's grid (`gridOf`), leaving out drags
 * that would not move it. A drag that names its landing's squeeze is a lone
 * drag's planned landing, already a spot the drop lands on, and a squeezed
 * one is half a cell off the grid, so it is kept as it is, never snapped
 * again (SNAPBUILD-ASTRA-04).
 */
export function dragSpots<T extends Placed>(
  tokens: Readonly<Record<string, T | undefined>>,
  drags: Iterable<{ tokenId: string; x: number; y: number; squeeze?: boolean }>,
  gridOf: (token: T) => Grid,
): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  for (const d of drags) {
    const t = tokens[d.tokenId];
    if (!t || !Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    const at: Spot = d.squeeze === undefined ? snapPosition(gridOf(t), d.x, d.y, footprint(t)) : { x: d.x, y: d.y, squeeze: d.squeeze };
    if (!standsAt(t, at)) spots.set(d.tokenId, at);
    else spots.delete(d.tokenId);
  }
  return spots;
}

/** Whether a token at a spot is where it stands now, squeezed as it is. */
function standsAt(t: Pick<Token, "x" | "y" | "squeeze">, s: Spot): boolean {
  return t.x === s.x && t.y === s.y && (s.squeeze === undefined || s.squeeze === (t.squeeze === true));
}

/**
 * The spot each of other devices' drag frames would drop its token on
 * (`dragSpots`). A frame carries the drawn point, which aims as the dragging
 * device's own drag does, so a nudged token's aura and areas count where
 * that device's drop would (lib/scene.ts frameAim, SNAPBUILD-ASTRA-02).
 */
export function frameSpots<T extends Placed & Pick<Token, "nudge">>(
  tokens: Readonly<Record<string, T | undefined>>,
  frames: Iterable<{ tokenId: string; x: number; y: number; free?: boolean; ended?: boolean }>,
  gridOf: (token: T) => Grid,
): Map<string, Spot> {
  const aimed: { tokenId: string; x: number; y: number }[] = [];
  for (const f of frames) {
    const t = tokens[f.tokenId];
    if (t) aimed.push({ tokenId: f.tokenId, ...frameAim(t, f) });
  }
  return dragSpots(tokens, aimed, gridOf);
}

export function spotsKey(spots: ReadonlyMap<string, Spot>): string {
  return [...spots]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, s]) => `${id}:${s.x},${s.y}${s.squeeze === undefined ? "" : s.squeeze ? ",s" : ",u"}`)
    .join(";");
}

export function parseSpotsKey(key: string): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  if (!key) return spots;
  for (const part of key.split(";")) {
    const colon = part.lastIndexOf(":");
    const [xs, ys, squeezed] = part.slice(colon + 1).split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (colon > 0 && Number.isFinite(x) && Number.isFinite(y)) spots.set(part.slice(0, colon), squeezed === undefined ? { x, y } : { x, y, squeeze: squeezed === "s" });
  }
  return spots;
}

/** The tokens with each spot applied, squeezed where its landing is (lib/scene.ts atDragSpot). The same map back when nothing moves, so caches keyed on it hold. */
export function withSpots<T extends Pick<Token, "x" | "y" | "squeeze">>(
  tokens: Readonly<Record<string, T | undefined>>,
  spots: ReadonlyMap<string, Spot>,
): Readonly<Record<string, T | undefined>> {
  let out: Record<string, T | undefined> | null = null;
  for (const [id, s] of spots) {
    const t = tokens[id];
    if (!t || standsAt(t, s)) continue;
    out ??= { ...tokens };
    out[id] = atDragSpot(t, s);
  }
  return out ?? tokens;
}
