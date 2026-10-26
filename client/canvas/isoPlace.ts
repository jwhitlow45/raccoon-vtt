import { isometric, K, toView, toWorld, type Turn, type ViewPoint } from "../lib/view.ts";
import type { IsoGround } from "./relief/context.ts";

/**
 * Where the board's marks go in the isometric view
 * (docs/design-v1-isometric-view.md 5.1 and 5.3), as plain functions, so the
 * rules run under node --test. A renderer may draw in up to three places
 * (features/layers.ts IsoPlace), and reads which one through
 * useIsoGround().place:
 *
 * - the ground stage, in cells inside the ground plane's groups, at height
 *   0, where raised ground's tops copy it up;
 * - the drag layer ("moving"), in the same plane, each mark lifted by its
 *   drawn height, for what moves frame by frame;
 * - the overlay ("upright"), in view space, for what stands up.
 */

type Point = { x: number; y: number };

/**
 * The offset in the ground plane's own units, the world's cells, that lifts
 * what it holds `z` cells of height on screen: toView's lift of K·z view
 * units, seen back through the plane at 0. The same for every point.
 */
export function liftInPlane(turn: Turn, z: number): Point {
  if (z === 0) return { x: 0, y: 0 };
  const view = isometric(turn);
  const up = toView(view, { x: 0, y: 0 }, z);
  return toWorld(view, up);
}

/** A world point at its drawn height in view space, or at `z` cells when given. In Top-down, the point itself. */
export function viewPointOf(iso: Pick<IsoGround, "turn" | "ground"> | null, p: Point, z?: number): ViewPoint {
  if (!iso) return { x: p.x, y: p.y } as ViewPoint;
  return toView(isometric(iso.turn), p, z ?? iso.ground(p.x, p.y));
}

/** The highest drawn ground under a box in cells, its far edges left out: where a mark round a footprint stands, down in a pit when every cell is. */
export function boxGround(iso: Pick<IsoGround, "ground">, box: { x0: number; y0: number; x1: number; y1: number }): number {
  const x0 = Math.floor(box.x0);
  const y0 = Math.floor(box.y0);
  const x1 = Math.max(x0 + 1, Math.ceil(box.x1));
  const y1 = Math.max(y0 + 1, Math.ceil(box.y1));
  // The box always covers a cell, so the start never survives.
  let top = -Infinity;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) top = Math.max(top, iso.ground(x + 0.5, y + 0.5));
  return top;
}

/**
 * Whether this place draws a thing that stands by the stand rule (5.2)
 * when `stands`: Top-down draws everything as it always has, the ground
 * stage draws it flat when it does not stand, and the overlay draws it
 * upright when it does. The drag layer draws neither, so no thing is drawn
 * twice or not at all.
 */
export function drawsHere(iso: Pick<IsoGround, "place"> | null, stands: boolean): boolean {
  if (!iso) return true;
  if (iso.place === "ground") return !stands;
  if (iso.place === "upright") return stands;
  return false;
}

/** The view units a lift of `z` cells of height raises a thing on screen. */
export function liftView(z: number): number {
  return K * z;
}
