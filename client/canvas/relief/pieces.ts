import { CHUNK_CELLS, type BuildChunk, type TerrainId } from "#shared/model.ts";
import { chunkMarks } from "#shared/rules/heights.ts";
import { depth, K, turnAxes, type Turn } from "../../lib/view.ts";
import type { WallPiece } from "./runs.ts";

/**
 * The pieces the relief layer draws in depth order
 * (docs/design-v1-isometric-view.md 5.5 and 5.6): columns for raised cells,
 * openings for pits, and standing wall pieces. Standees are the fourth kind,
 * placed among them by buckets.ts. Everything here is in world cells and
 * heights in cells, the drawn heights of view.ts (`drawnGround`), so a
 * viewer's pieces never read terrain they have not seen.
 */

/** A cell's four sides, in the order every list here keeps: north (y - 1), east (x + 1), south (y + 1), west (x - 1). */
export const SIDES = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** How a cell's side is drawn: its terrain's texture, or a flat tone where it has none or its texture has not loaded. */
export type SideLook = { texture: TerrainId | null; color: string };

/** A raised cell (drawn ground above 0) or a pit (below 0), with its neighbors' drawn ground, side by side as SIDES lists them. */
export type CellPiece = {
  kind: "column" | "pit";
  id: string;
  x: number;
  y: number;
  /** Drawn ground in cells. */
  z: number;
  around: readonly [number, number, number, number];
  look: SideLook;
  stair: boolean;
};

/** A standing wall piece on the higher drawn ground beside it, in cells. */
export type WallItem = { kind: "wall"; id: string; piece: WallPiece; base: number };

export type StaticPiece = CellPiece | WallItem;

/** How high a wall piece stands, in cells (ISO-D7): rooms read as rooms and stay open to a phone that turns all the time. */
export const WALL_RISE = 0.5;

/** Ties in depth draw columns first, then pits, then walls, then standees (5.6). */
export const RANK = { column: 0, pit: 1, wall: 2, standee: 3 } as const;

export type Face = {
  /** The side's ends on the ground plane, in cells. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** From this height up to `z1`, in cells. */
  z0: number;
  z1: number;
  /** Which way it faces on screen, for the light from the left: lighter left, darker right. */
  left: boolean;
  /** SIDES's index of the side. */
  side: number;
};

/** The ends of side `i` of the cell at x, y. */
function sideEnds(x: number, y: number, i: number): [number, number, number, number] {
  switch (i) {
    case 0:
      return [x, y, x + 1, y];
    case 1:
      return [x + 1, y, x + 1, y + 1];
    case 2:
      return [x, y + 1, x + 1, y + 1];
    default:
      return [x, y, x, y + 1];
  }
}

/** Whether side `i` faces the viewer at this turn: its outward step brings a point nearer (larger depth). */
export function facesViewer(turn: Turn, i: number): boolean {
  const [dx, dy] = SIDES[i]!;
  return depth(turn, dx, dy) > 0;
}

/**
 * The sides a piece draws at a turn. A column draws each side facing the
 * viewer where the neighbor is lower, from the neighbor's ground (or 0
 * where the neighbor is a pit, whose own far side carries on below) up to
 * its top. A pit draws its far sides, inside its opening, from its floor up
 * to the far neighbor's ground or 0, whichever is lower.
 */
export function facesOf(p: CellPiece, turn: Turn): Face[] {
  const out: Face[] = [];
  const { c, s } = turnAxes(turn);
  const centerU = c * (p.x + 0.5) - s * (p.y + 0.5);
  for (let i = 0; i < 4; i++) {
    const near = facesViewer(turn, i);
    const n = p.around[i]!;
    let z0: number;
    let z1: number;
    if (p.kind === "column") {
      if (!near || n >= p.z) continue;
      z0 = Math.max(n, 0);
      z1 = p.z;
    } else {
      if (near) continue;
      z0 = p.z;
      z1 = Math.min(n, 0);
      if (z1 <= z0) continue;
    }
    const [ax, ay, bx, by] = sideEnds(p.x, p.y, i);
    const midU = c * ((ax + bx) / 2) - s * ((ay + by) / 2);
    out.push({ ax, ay, bx, by, z0, z1, left: midU < centerU, side: i });
  }
  return out;
}

/** A box in view units. */
export type VBox = { x0: number; y0: number; x1: number; y1: number };

/** The view box of the ground point x, y at heights from z0 to z1. */
function grow(box: VBox, turn: Turn, x: number, y: number, z0: number, z1: number): void {
  const { c, s } = turnAxes(turn);
  const u = c * x - s * y;
  const v = (s * x + c * y) / 2;
  box.x0 = Math.min(box.x0, u);
  box.x1 = Math.max(box.x1, u);
  box.y0 = Math.min(box.y0, v - K * Math.max(z0, z1));
  box.y1 = Math.max(box.y1, v - K * Math.min(z0, z1));
}

/**
 * A piece's full projected bounds at a turn, in view units (5.7): a column
 * with its sides and top, a pit's opening (all it draws is clipped to it),
 * and a wall piece with its rise.
 */
export function boundsOf(p: StaticPiece, turn: Turn): VBox {
  const box: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  if (p.kind === "wall") {
    grow(box, turn, p.piece.ax, p.piece.ay, p.base, p.base + WALL_RISE);
    grow(box, turn, p.piece.bx, p.piece.by, p.base, p.base + WALL_RISE);
    return box;
  }
  // A column's sides reach down to 0 at the lowest. A pit draws only inside its opening at 0.
  const high = p.kind === "column" ? p.z : 0;
  for (const [cx, cy] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const) {
    grow(box, turn, p.x + cx, p.y + cy, 0, high);
  }
  return box;
}

/**
 * A point's depth as the sort compares it, rounded to a billionth of a cell,
 * so two points at one depth, such as two cell centers on one diagonal,
 * tie exactly and fall to the tie order, whatever rounding their sums took.
 */
export function sortKey(turn: Turn, x: number, y: number): number {
  return Math.round(depth(turn, x, y) * 1e9) / 1e9;
}

/** The point a piece sorts by: a cell's center, a wall piece's midpoint. */
export function keyOf(p: StaticPiece, turn: Turn): number {
  if (p.kind === "wall") return sortKey(turn, (p.piece.ax + p.piece.bx) / 2, (p.piece.ay + p.piece.by) / 2);
  return sortKey(turn, p.x + 0.5, p.y + 0.5);
}

/** What a bucket's pieces read of the room. */
export type PieceSource = {
  /** Drawn ground in cells at a cell (view.ts DrawnHeights.at): 0 where this viewer has not seen it or heights lie flat. */
  ground(x: number, y: number): number;
  /** The cell's terrain from its chunk, if any. */
  terrain(x: number, y: number): TerrainId | null;
  /** How a cell's side looks: its terrain's texture, or a tone. */
  look(x: number, y: number, terrain: TerrainId | null): SideLook;
  bounds: { w: number; h: number };
};

/** The column and pit pieces of one 16 by 16 bucket, the chunk at cx, cy. */
export function cellPieces(src: PieceSource, cx: number, cy: number, chunk: BuildChunk | undefined): CellPiece[] {
  const out: CellPiece[] = [];
  const marks = chunk ? chunkMarks(chunk) : null;
  const x0 = cx * CHUNK_CELLS;
  const y0 = cy * CHUNK_CELLS;
  for (let j = 0; j < CHUNK_CELLS; j++) {
    const y = y0 + j;
    if (y < 0 || y >= src.bounds.h) continue;
    for (let i = 0; i < CHUNK_CELLS; i++) {
      const x = x0 + i;
      if (x < 0 || x >= src.bounds.w) continue;
      const z = src.ground(x, y);
      if (z === 0) continue;
      const terrain = src.terrain(x, y);
      const stair = marks !== null && marks[j * CHUNK_CELLS + i] !== ".";
      out.push({
        kind: z > 0 ? "column" : "pit",
        id: `c${x},${y}`,
        x,
        y,
        z,
        around: [src.ground(x, y - 1), src.ground(x + 1, y), src.ground(x, y + 1), src.ground(x - 1, y)],
        look: src.look(x, y, stair ? "stairs" : terrain),
        stair,
      });
    }
  }
  return out;
}

/** The wall pieces of one bucket, each on the higher drawn ground beside it. */
export function wallItems(src: Pick<PieceSource, "ground">, pieces: readonly WallPiece[]): WallItem[] {
  return pieces.map((piece) => {
    const base = piece.beside ? Math.max(src.ground(piece.beside[0], piece.beside[1]), src.ground(piece.beside[2], piece.beside[3])) : src.ground(piece.cx, piece.cy);
    return { kind: "wall", id: `w${piece.id}`, piece, base };
  });
}
