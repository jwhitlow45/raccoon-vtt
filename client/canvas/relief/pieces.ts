import { CHUNK_CELLS, type BuildChunk, type TerrainId } from "#shared/model.ts";
import { isHex, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { chunkMarks } from "#shared/rules/heights.ts";
import type { Point } from "../../lib/camera.ts";
import { cellCenter, cellInScene, cellPolygon, neighborOf, sideCount, sideEnds, sideOutward } from "../../lib/groundCells.ts";
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

/** A connected set of pit cells, side by side, whose openings at 0 clip what is drawn below 0 in any of them (docs/design-v1-iso-hex-relief.md 5.2). */
export type PitRegion = { id: number; cells: CellPiece[] };

/**
 * A raised cell (drawn ground above 0) or a pit (below 0), with its
 * neighbors' drawn ground side by side: a square's four in SIDES order, a
 * hex's six in hex.ts hexNeighbors order. `x` and `y` are its key, a hex's
 * column and row on a hex scene, and `poly` and `center` are where it is.
 */
export type CellPiece = {
  kind: "column" | "pit";
  id: string;
  x: number;
  y: number;
  /** Drawn ground in cells. */
  z: number;
  around: readonly number[];
  /** Its polygon in world cells (groundCells.ts cellPolygon). */
  poly: readonly Point[];
  /** Its center in world cells, the point it sorts by. */
  center: Point;
  /** Each side's two ends and its outward step, side by side as `around`. */
  sides: readonly { a: Point; b: Point; out: Point }[];
  look: SideLook;
  stair: boolean;
  /** A pit's connected region, set by the index once every bucket is built. */
  region?: PitRegion;
};

/**
 * A standing wall piece, from `base` up `rise`, in cells (wallItems). On
 * hexes `hosts` are the hexes it stands in, one, or the two either side of
 * the hex side it runs along, and it sorts with the nearer.
 */
export type WallItem = { kind: "wall"; id: string; piece: WallPiece; base: number; rise: number; hosts: readonly Point[] | null; region?: PitRegion };

export type StaticPiece = CellPiece | WallItem;

/** How high a wall piece stands, in cells (ISO-D7): rooms read as rooms and stay open to a phone that turns all the time. An automatic wall beside raised ground stands less (wallItems). */
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
  /** The side's index, SIDES's on squares, hexNeighbors's on hexes. */
  side: number;
};

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
 * to the far neighbor's ground or 0, whichever is lower. A side faces the
 * viewer when its outward step brings a point nearer: on hexes three of
 * the six at every turn, whatever the heights.
 */
export function facesOf(p: CellPiece, turn: Turn): Face[] {
  const out: Face[] = [];
  const { c, s } = turnAxes(turn);
  const centerU = c * p.center.x - s * p.center.y;
  for (let i = 0; i < p.sides.length; i++) {
    const side = p.sides[i]!;
    const near = depth(turn, side.out.x, side.out.y) > 0;
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
    const midU = c * ((side.a.x + side.b.x) / 2) - s * ((side.a.y + side.b.y) / 2);
    out.push({ ax: side.a.x, ay: side.a.y, bx: side.b.x, by: side.b.y, z0, z1, left: midU < centerU, side: i });
  }
  return out;
}

const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

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

/** A polygon's view box at heights from z0 to z1. */
export function polyBox(turn: Turn, poly: readonly Point[], z0: number, z1: number): VBox {
  const box: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of poly) grow(box, turn, p.x, p.y, z0, z1);
  return box;
}

/**
 * A piece's full projected bounds at a turn, in view units (5.7): a column
 * with its sides and top, a pit from its opening down to its floor (its
 * floor can show through a neighbor's opening, so its own opening alone
 * cannot bound it), and a wall piece with its rise.
 */
export function boundsOf(p: StaticPiece, turn: Turn): VBox {
  const box: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  if (p.kind === "wall" && p.piece.kind === "pillar") {
    // A pillar's drum stands inside its cell: the cell's corners bound it.
    for (const [cx, cy] of CORNERS) grow(box, turn, p.piece.ax + cx, p.piece.ay + cy, p.base, p.base + p.rise);
    return box;
  }
  if (p.kind === "wall") {
    grow(box, turn, p.piece.ax, p.piece.ay, p.base, p.base + p.rise);
    grow(box, turn, p.piece.bx, p.piece.by, p.base, p.base + p.rise);
    return box;
  }
  // A column's sides reach down to 0 at the lowest. A pit's floor and far sides lie between its floor and 0.
  return polyBox(turn, p.poly, Math.min(0, p.z), Math.max(0, p.z));
}

/**
 * A point's depth as the sort compares it, rounded to a billionth of a cell,
 * so two points at one depth, such as two cell centers on one diagonal,
 * tie exactly and fall to the tie order, whatever rounding their sums took.
 */
export function sortKey(turn: Turn, x: number, y: number): number {
  return Math.round(depth(turn, x, y) * 1e9) / 1e9;
}

/**
 * The point a piece sorts by: a cell's center, and a wall piece's midpoint
 * on squares. A hex wall piece sorts with its host hex's center, the nearer
 * host's at this turn on a shared side, so a run at a far hex's near corner
 * never passes the next hex's center (docs/design-v1-iso-hex-relief.md 6.1).
 */
export function keyOf(p: StaticPiece, turn: Turn): number {
  if (p.kind === "wall") {
    if (p.hosts) return Math.max(...p.hosts.map((h) => sortKey(turn, h.x, h.y)));
    return sortKey(turn, (p.piece.ax + p.piece.bx) / 2, (p.piece.ay + p.piece.by) / 2);
  }
  return sortKey(turn, p.center.x, p.center.y);
}

/** The order inside one key and kind: a hex wall piece's midpoint depth, so two runs in one host keep their own order. 0 for the rest. */
export function localKeyOf(p: StaticPiece, turn: Turn): number {
  if (p.kind !== "wall" || !p.hosts) return 0;
  return sortKey(turn, (p.piece.ax + p.piece.bx) / 2, (p.piece.ay + p.piece.by) / 2);
}

/** What a bucket's pieces read of the room. */
export type PieceSource = {
  /** Drawn ground in cells at a cell key (view.ts DrawnHeights.at): 0 where this viewer has not seen it, off the scene, or heights lie flat. */
  ground(x: number, y: number): number;
  /** The cell's terrain from its chunk, if any. */
  terrain(x: number, y: number): TerrainId | null;
  /** How a cell's side looks: its terrain's texture, or a tone. */
  look(x: number, y: number, terrain: TerrainId | null): SideLook;
  bounds: { w: number; h: number };
  /** The scene's grid. Squares when left out. */
  grid?: Grid;
};

/** The column and pit pieces of one 16 by 16 bucket of keys, the chunk at cx, cy. */
export function cellPieces(src: PieceSource, cx: number, cy: number, chunk: BuildChunk | undefined): CellPiece[] {
  const grid = src.grid ?? SQUARES;
  const out: CellPiece[] = [];
  const marks = chunk ? chunkMarks(chunk) : null;
  const x0 = cx * CHUNK_CELLS;
  const y0 = cy * CHUNK_CELLS;
  const hex = isHex(grid);
  for (let j = 0; j < CHUNK_CELLS; j++) {
    const y = y0 + j;
    if (y < 0 || (!hex && y >= src.bounds.h)) continue;
    for (let i = 0; i < CHUNK_CELLS; i++) {
      const x = x0 + i;
      if (x < 0 || (!hex && x >= src.bounds.w)) continue;
      const cell = { col: x, row: y };
      if (hex && !cellInScene(grid, src.bounds, cell)) continue;
      const z = src.ground(x, y);
      if (z === 0) continue;
      // Painted ground stays square: a hex side wears its stair's swatch or its map tint.
      const terrain = hex ? null : src.terrain(x, y);
      const stair = marks !== null && marks[j * CHUNK_CELLS + i] !== ".";
      const n = sideCount(grid);
      const sides: { a: Point; b: Point; out: Point }[] = [];
      const around: number[] = [];
      for (let k = 0; k < n; k++) {
        const [a, b] = sideEnds(grid, cell, k);
        const next = neighborOf(grid, cell, k);
        sides.push({ a, b, out: sideOutward(grid, cell, k) });
        around.push(src.ground(next.col, next.row));
      }
      out.push({
        kind: z > 0 ? "column" : "pit",
        id: `c${x},${y}`,
        x,
        y,
        z,
        around,
        poly: cellPolygon(grid, cell),
        center: cellCenter(grid, cell),
        sides,
        look: src.look(x, y, stair ? "stairs" : terrain),
        stair,
      });
    }
  }
  return out;
}

/**
 * The wall pieces of one bucket. A piece stands WALL_RISE tall on the higher
 * drawn ground beside it, or on its own cell's for a free wall or a pillar.
 * An automatic wall instead keeps its top WALL_RISE above the lower ground
 * (D-261026-27): the walls around a room stay one height whatever is raised
 * along them, the part above a low platform shows, and beside ground that
 * reaches that top no piece stands, since the raised ground's own side is
 * the wall. A pit's floor never brings that top below a wall on the ground
 * at 0, so a pit at a room's edge and a sunken room keep their rim.
 */
export function wallItems(src: Pick<PieceSource, "ground">, pieces: readonly WallPiece[]): WallItem[] {
  const out: WallItem[] = [];
  for (const piece of pieces) {
    const id = `w${piece.id}`;
    if (piece.hosts) {
      // On hexes a run stands on its host's ground, on a shared side the higher of the two, off the scene on 0 (D-261030-461).
      const base = Math.max(...piece.hosts.map((h) => src.ground(h.cell.col, h.cell.row)));
      out.push({ kind: "wall", id, piece, base, rise: WALL_RISE, hosts: piece.hosts.map((h) => h.center) });
      continue;
    }
    if (!piece.beside) {
      out.push({ kind: "wall", id, piece, base: src.ground(piece.cx, piece.cy), rise: WALL_RISE, hosts: null });
      continue;
    }
    const a = src.ground(piece.beside[0], piece.beside[1]);
    const b = src.ground(piece.beside[2], piece.beside[3]);
    const high = Math.max(a, b);
    if (!piece.auto) {
      out.push({ kind: "wall", id, piece, base: high, rise: WALL_RISE, hosts: null });
      continue;
    }
    const top = Math.min(high, Math.max(Math.min(a, b), 0)) + WALL_RISE;
    // Ground is whole feet over feet per cell, so a top level with the higher ground can land a float's hair above it, which would draw a hairline. A real rise is at least 1 / 200 cell.
    if (top - high < 1e-9) continue;
    out.push({ kind: "wall", id, piece, base: high, rise: top - high, hosts: null });
  }
  return out;
}
