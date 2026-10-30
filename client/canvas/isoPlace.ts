import { FOG_SUBCELLS } from "#shared/model.ts";
import { isometric, K, toView, toWorld, type Turn, type ViewPoint } from "../lib/view.ts";
import { cellCenter, type GroundSurface } from "../lib/groundCells.ts";
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

/**
 * The highest drawn ground under a box in cells, its far edges left out:
 * where a mark round a footprint stands, down in a pit when every cell is.
 * On hexes, the hexes whose centers lie inside the box (IsoGround.top), so
 * a creature's box reads its own hexes and not the ones its corners touch.
 */
export function boxGround(iso: Pick<IsoGround, "ground" | "top">, box: { x0: number; y0: number; x1: number; y1: number }): number {
  if (iso.top) return iso.top(box);
  const x0 = Math.floor(box.x0);
  const y0 = Math.floor(box.y0);
  const x1 = Math.max(x0 + 1, Math.ceil(box.x1));
  const y1 = Math.max(y0 + 1, Math.ceil(box.y1));
  // The box always covers a cell, so the start never survives.
  let top = -Infinity;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) top = Math.max(top, iso.ground(x + 0.5, y + 0.5));
  return top;
}

/** `boxGround` on a hex surface: the hexes whose centers lie strictly inside the box, or the one under its middle when none does. */
export function hexBoxGround(surface: Pick<GroundSurface, "grid" | "cellsIn" | "atCell" | "atPoint">, box: { x0: number; y0: number; x1: number; y1: number }): number {
  let top = -Infinity;
  for (const c of surface.cellsIn(box)) {
    const p = cellCenter(surface.grid, c);
    if (p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1) top = Math.max(top, surface.atCell(c));
  }
  return top === -Infinity ? surface.atPoint({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }) : top;
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

/** A part of a flat creature's press area: a piece of its footprint inside one cell, from the node's corner, in cells, and that cell's drawn ground. */
export type PressCell = { x: number; y: number; w: number; h: number; z: number };

/**
 * A flat creature's press area as the ground stage lays its picture: its
 * footprint cut at the cell lines, each piece on its own cell's drawn
 * ground, since a seen raised cell copies the picture over it up and the
 * rest stays down (ISO34-ASTRA-14). From the node's corner `at`.
 */
export function pressCells(at: Point, size: { w: number; h: number }, ground: (x: number, y: number) => number, hexes = false): PressCell[] {
  if (hexes) return hexPressCells(at, size, ground);
  const out: PressCell[] = [];
  for (let y = at.y; y < at.y + size.h - 1e-9; y = Math.min(Math.floor(y) + 1, at.y + size.h)) {
    const y1 = Math.min(Math.floor(y) + 1, at.y + size.h);
    for (let x = at.x; x < at.x + size.w - 1e-9; x = Math.min(Math.floor(x) + 1, at.x + size.w)) {
      const x1 = Math.min(Math.floor(x) + 1, at.x + size.w);
      out.push({ x: x - at.x, y: y - at.y, w: x1 - x, h: y1 - y, z: ground(Math.floor(x) + 0.5, Math.floor(y) + 0.5) });
    }
  }
  return out;
}

/**
 * On hexes the footprint is cut at the fog's quarter-cell lines instead,
 * each piece on the drawn ground under its middle, and pieces side by side
 * in a row on one ground merged: within a quarter cell of where the
 * ground stage's hex tops lift the picture, which no rectangle follows
 * exactly (docs/design-v1-iso-hex-relief.md 7).
 */
function hexPressCells(at: Point, size: { w: number; h: number }, ground: (x: number, y: number) => number): PressCell[] {
  const out: PressCell[] = [];
  const q = 1 / FOG_SUBCELLS;
  const line = (v: number) => Math.floor(v / q + 1e-9) * q + q;
  for (let y = at.y; y < at.y + size.h - 1e-9; ) {
    const y1 = Math.min(line(y), at.y + size.h);
    let open: PressCell | null = null;
    for (let x = at.x; x < at.x + size.w - 1e-9; ) {
      const x1 = Math.min(line(x), at.x + size.w);
      const z = ground((x + x1) / 2, (y + y1) / 2);
      if (open && open.z === z) open.w = x1 - at.x - open.x;
      else {
        open = { x: x - at.x, y: y - at.y, w: x1 - x, h: y1 - y, z };
        out.push(open);
      }
      x = x1;
    }
    y = y1;
  }
  return out;
}

/** The pieces of a press area as they draw in the ground plane, each lifted by its cell's ground. */
export function pressRects(turn: Turn, cells: readonly PressCell[]): { x: number; y: number; w: number; h: number }[] {
  return cells.map((c) => {
    const d = liftInPlane(turn, c.z);
    return { x: c.x + d.x, y: c.y + d.y, w: c.w, h: c.h };
  });
}

/** The view units a lift of `z` cells of height raises a thing on screen. */
export function liftView(z: number): number {
  return K * z;
}
