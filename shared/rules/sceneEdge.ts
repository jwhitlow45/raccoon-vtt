import type { Point } from "./geom.ts";
import { footprintSize, isSqueezed, occupiedHexes, placedOnHex, squeezedRect, type PlacedToken } from "./footprint.ts";
import { isHex, type Grid } from "./grid.ts";
import { hexAt, hexInScene, hexKey, hexNeighbors, type Hex } from "./hex.ts";

/**
 * Where a token's move may end relative to the scene's edge
 * (docs/design/design-v1-maps-vision.md 4.1, DROP-OFF-MAP): every spot a
 * move, a seat or a get-off puts a token on lies wholly inside the scene.
 * A teleport has said so since wave 4, and placements and dragged creatures
 * do too. This is that rule for a plain drop, so the device lands a token
 * by it (`pulledInside`) and the server refuses a player's move that ends
 * past it. It reads only the scene's bounds and the token's own footprint,
 * so a refusal tells a player nothing about what they cannot see.
 */

const EPS = 1e-9;

/** How far the ring search goes, and how many rings past the first fit it still reads. */
const MAX_RINGS = 24;
const EXTRA_RINGS = 3;

/**
 * Whether the footprint a token takes at its stored spot lies inside the
 * scene: on hexes every hex it stands on is the scene's, on squares its box
 * does, the squeezed one while it squeezes.
 */
export function standsInScene(g: Grid, bounds: { w: number; h: number }, token: PlacedToken): boolean {
  if (isHex(g)) return occupiedHexes(g, token).every((h) => hexInScene(g, bounds, h));
  const r = isSqueezed(token) ? squeezedRect(token) : { x: token.x, y: token.y, ...footprintSize(token) };
  return r.x >= -EPS && r.y >= -EPS && r.x + r.w <= bounds.w + EPS && r.y + r.h <= bounds.h + EPS;
}

/** The step a token's snap grid takes: half a cell under a cell wide, else whole cells (footprint.ts snapStep, without its token). */
function stepOf(w: number, h: number): number {
  return Math.min(w, h) < 1 ? 0.5 : 1;
}

/** `v` moved the least to put a side of `side` inside `bound` on the grid, or left alone where the bound is smaller than the side. */
function pulled(v: number, side: number, bound: number, step: number): number {
  if (side > bound + EPS) return v;
  return Math.min(Math.max(v, 0), Math.floor((bound - side) / step + EPS) * step) + 0;
}

/**
 * The spot `to` a drop aims at, moved the least to put the token's full
 * footprint inside the scene. On squares each axis is held at the edge, so
 * a token dragged along the edge slides. On hexes it is the spot of the
 * scene's hex whose full-size footprint lies inside and whose spot is
 * nearest `to`. A spot already inside, and a token the scene is too small
 * for, come back as they are.
 */
export function pulledInside(g: Grid, bounds: { w: number; h: number }, token: PlacedToken, to: Point): Point {
  const full: PlacedToken = { size: token.size, x: to.x, y: to.y, ...(token.w !== undefined ? { w: token.w } : {}), ...(token.h !== undefined ? { h: token.h } : {}) };
  if (!isHex(g)) {
    const { w, h } = footprintSize(full);
    const step = stepOf(w, h);
    return { x: pulled(to.x, w, bounds.w, step), y: pulled(to.y, h, bounds.h, step) };
  }
  if (standsInScene(g, bounds, full)) return to;
  const away = (p: Point) => (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
  let best = null as Point | null;
  let bestAway = Infinity;
  const consider = (hex: Hex) => {
    const p = placedOnHex(g, full, hex);
    const d = away(p);
    // Only a nearer spot is worth the footprint test, so a far drop costs one test per improvement.
    if (d >= bestAway - EPS || !standsInScene(g, bounds, { ...full, x: p.x, y: p.y })) return false;
    best = p;
    bestAway = d;
    return true;
  };
  // Rings of hexes round where `to` lands once clamped into the scene's box, so a far drop on a 200 by 200 scene costs a few dozen
  // hexes and not all of them (DROPMAP-OPUS-2). The nearest spot lies within a few rings of the first one that fits.
  const { w, h } = footprintSize(full);
  const clamped = { x: pulled(to.x, w, bounds.w, 1), y: pulled(to.y, h, bounds.h, 1) };
  const start = hexAt(g, { x: clamped.x + w / 2, y: clamped.y + h / 2 });
  const seen = new Set<string>([hexKey(start)]);
  let ring: Hex[] = [start];
  let foundAt = -1;
  for (let r = 0; r <= MAX_RINGS && ring.length > 0 && (foundAt < 0 || r <= foundAt + EXTRA_RINGS); r++) {
    for (const hex of ring) if (consider(hex) && foundAt < 0) foundAt = r;
    const next: Hex[] = [];
    for (const hex of ring) {
      for (const n of hexNeighbors(g, hex)) {
        if (seen.has(hexKey(n))) continue;
        seen.add(hexKey(n));
        next.push(n);
      }
    }
    ring = next;
  }
  // A scene too small for the footprint at all has no spot to pull to, and the drop stays where it was aimed.
  return best ?? to;
}
