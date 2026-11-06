import { CHUNK_CELLS, type BuildChunk, type TerrainId } from "#shared/model.ts";
import { isHex, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { chunkMarks, STEP } from "#shared/rules/heights.ts";
import type { Point } from "../../lib/camera.ts";
import { cellCenter, cellInScene, cellPolygon, neighborOf, sideCount, sideEnds, sideOutward } from "../../lib/groundCells.ts";
import { treadAt, treadHeight, TREADS, treadUnder, type StairRuns, type StairStep } from "../../lib/stairRuns.ts";
import { depth, K, turnAxes, type Turn } from "../../lib/view.ts";
import { postShare, type WallPiece } from "./runs.ts";

/**
 * The pieces the relief layer draws in depth order
 * (docs/design/design-v1-isometric-view.md 5.5 and 5.6): columns for raised cells,
 * openings for pits, stairs that climb in steps
 * (docs/design/design-v1-iso-depth.md 5.2), and standing wall pieces.
 * Standees are the fifth kind, placed among them by buckets.ts. Everything
 * here is in world cells and heights in cells, the drawn heights of view.ts
 * (`drawnGround`), so a viewer's pieces never read terrain they have not
 * seen.
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

/** A connected set of pit cells, side by side, whose openings at 0 clip what is drawn below 0 in any of them (docs/design/design-v1-iso-hex-relief.md 5.2). */
export type PitRegion = { id: number; cells: CellPiece[] };

/**
 * A raised cell (drawn ground above 0), a pit (below 0), or a stair that
 * climbs in steps at any height, 0 included, with its neighbors' drawn
 * ground side by side: a square's four in SIDES order, a hex's six in
 * hex.ts hexNeighbors order. `x` and `y` are its key, a hex's column and
 * row on a hex scene, and `poly` and `center` are where it is.
 */
export type CellPiece = {
  kind: "column" | "pit" | "steps";
  id: string;
  x: number;
  y: number;
  /** Drawn ground in cells. */
  z: number;
  around: readonly number[];
  /**
   * The span of a stair in a run that steps (lib/stairRuns.ts), whatever the
   * detail: its bounds take the whole span, so they never change with the
   * zoom (docs/design/design-v1-iso-depth.md 6). It draws as steps only as
   * a `steps` piece.
   */
  span?: StairStep;
  /** The neighbors that are stepping stairs, side by side with `around`, while the detail shows: a face reads their treads along the shared side. */
  aroundSteps?: readonly (StairStep | undefined)[];
  /** Its polygon in world cells (groundCells.ts cellPolygon). */
  poly: readonly Point[];
  /** Its center in world cells, the point it sorts by. */
  center: Point;
  /** Each side's two ends and its outward step, side by side as `around`. */
  sides: readonly { a: Point; b: Point; out: Point }[];
  look: SideLook;
  stair: boolean;
  /**
   * On squares, side by side with `around`: which ends of each side meet
   * the same side of the cell beside it along that line with the same top,
   * the same foot and the same look (1 for the side's `a` end, 2 for `b`).
   * No line is stroked there, so a long even side reads as one face
   * (docs/design/design-v1-iso-depth.md 5.1). Left out where none joins.
   */
  joins?: readonly number[];
  /** A pit's connected region, set by the index once every bucket is built. */
  region?: PitRegion;
};

/**
 * A standing wall piece, from `base` up `rise`, in cells (wallItems). On
 * hexes `hosts` are the hexes it stands in, one, or the two either side of
 * the hex side it runs along, and it sorts with the nearer. `framed`, while
 * the detail shows, draws a door or window as its share of its frame
 * (`frameParts`), and an open leaf stands only then.
 */
export type WallItem = { kind: "wall"; id: string; piece: WallPiece; base: number; rise: number; hosts: readonly Point[] | null; region?: PitRegion; framed?: true; slab?: Slab };

/**
 * A wall piece standing as a stone slab, while the detail shows on squares
 * (docs/design/design-v1-iso-depth.md 5.6): from `a` to `b` on the ground,
 * its line's ends moved along it as its neighbors say (slabOf), WALL_THICK
 * across and centered on its line. `face` says whether each end may show
 * its end face, and `line` whether the end's corners are stroked: neither
 * where the next slab of the wall carries on along the line. `lean` points
 * into the slab from the ends that stop at another slab's side, which
 * breaks its tie in depth with that slab (keyOf).
 */
export type Slab = { a: Point; b: Point; face: readonly [boolean, boolean]; line: readonly [boolean, boolean]; lean: Point };

export type StaticPiece = CellPiece | WallItem;

/** How high a wall piece stands, in cells (ISO-D7): rooms read as rooms and stay open to a phone that turns all the time. An automatic wall beside raised ground stands less (wallItems). */
export const WALL_RISE = 0.5;

/** A wall slab's thickness, in cells (5.6). */
export const WALL_THICK = 0.14;

/** A door frame's posts, across the door, in cells (docs/design/design-v1-iso-depth.md 5.5). */
export const POST_THICK = 0.2;
/** A closed door's leaf, across the door, in cells. */
export const LEAF_THICK = 0.07;
/** A door leaf's height, as a share of its frame's. */
export const LEAF_RISE = 0.92;

/**
 * One upright box of a door's or window's frame: from `a` to `b` on the
 * ground, `thick` across that line and centered on it, unless `side` puts
 * all of its thickness on one side (an open leaf, which lies beside its
 * hinge's line), from `z0` up to `z1`. A pane has no thickness.
 */
export type FramePart = { look: "post" | "leaf" | "pane"; a: Point; b: Point; thick: number; side?: Point; z0: number; z1: number };

/**
 * The parts of a framed piece (5.5): the posts over the first and last
 * share of its door's length, a closed door's leaf or a window's pane
 * between them, each cut to the piece's own range, so pieces split by fog
 * or crossings draw one frame between them. An open door's frame has
 * nothing between its posts. An open leaf is one part, upright on its hinge.
 */
export function frameParts(w: WallItem): FramePart[] {
  const p = w.piece;
  const z0 = w.base;
  const z1 = w.base + w.rise;
  if (p.kind === "leaf" && p.leaf) return [{ look: "leaf", a: { x: p.ax, y: p.ay }, b: { x: p.bx, y: p.by }, thick: p.leaf.w, side: { x: p.leaf.ux, y: p.leaf.uy }, z0, z1: z0 + w.rise * LEAF_RISE }];
  const f = p.frame;
  if (!f) return [];
  const post = postShare(f);
  const at = (t: number) => ({ x: f.ax + (f.bx - f.ax) * t, y: f.ay + (f.by - f.ay) * t });
  const out: FramePart[] = [];
  const add = (look: FramePart["look"], t0: number, t1: number, thick: number, top: number) => {
    const lo = Math.max(t0, f.t0);
    const hi = Math.min(t1, f.t1);
    if (hi - lo > 1e-9) out.push({ look, a: at(lo), b: at(hi), thick, z0, z1: top });
  };
  add("post", 0, post, POST_THICK, z1);
  if (p.kind === "door") add("leaf", post, 1 - post, LEAF_THICK, z0 + w.rise * LEAF_RISE);
  if (p.kind === "window") add("pane", post, 1 - post, 0, z1);
  add("post", 1 - post, 1, POST_THICK, z1);
  return out;
}

/** A frame part's corners on the ground, in order round it: its line's ends moved across by its thickness. */
export function partCorners(q: FramePart): Point[] {
  const dx = q.b.x - q.a.x;
  const dy = q.b.y - q.a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Across the line: its own normal for a centered part, else the side it lies to, all of its thickness there.
  const nx = -dy / len;
  const ny = dx / len;
  if (q.side) {
    const t = q.thick;
    return [q.a, q.b, { x: q.b.x + q.side.x * t, y: q.b.y + q.side.y * t }, { x: q.a.x + q.side.x * t, y: q.a.y + q.side.y * t }];
  }
  const h = q.thick / 2;
  return [
    { x: q.a.x + nx * h, y: q.a.y + ny * h },
    { x: q.b.x + nx * h, y: q.b.y + ny * h },
    { x: q.b.x - nx * h, y: q.b.y - ny * h },
    { x: q.a.x - nx * h, y: q.a.y - ny * h },
  ];
}

/** Ties in depth draw columns and steps first, then pits, then walls, then standees (5.6). */
export const RANK = { column: 0, steps: 0, pit: 1, wall: 2, standee: 3 } as const;

/** Whether a cell piece is an opening at 0, drawn below it inside its pit region's openings: a pit, or a stair whose steps start below 0. */
export function isOpening(p: CellPiece): boolean {
  return p.kind === "pit" || (p.kind === "steps" && p.span!.lo < 0);
}

/** The height a piece's lowest surface stands at, in cells: a stair's lowest tread, else its drawn ground. A standee at or above it draws after it (buckets.ts). */
export function lowestOf(p: CellPiece): number {
  return p.kind === "steps" ? p.span!.lo : p.z;
}

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
  /** The side's index, SIDES's on squares, hexNeighbors's on hexes, or -1 for a riser inside a stair's square. */
  side: number;
  /** On a stepping stair, the tread whose part of the side, or whose riser, this is: it draws with that tread. */
  tread?: number;
};

/** Whether side `i` faces the viewer at this turn: its outward step brings a point nearer (larger depth). */
export function facesViewer(turn: Turn, i: number): boolean {
  const [dx, dy] = SIDES[i]!;
  return depth(turn, dx, dy) > 0;
}

/**
 * The face between a cell whose surface along a side is at `own` and a
 * neighbor's at `other`, by the side's facing: toward the viewer the higher
 * cell's side, from the lower surface (or 0, where the lower one is an
 * opening whose own far side carries on below) up to the higher. Away from
 * it, an opening's far side from its floor up to the neighbor's surface or
 * 0, whichever is lower. Null where none shows.
 */
function faceSpan(near: boolean, own: number, other: number): { z0: number; z1: number } | null {
  if (near) return own > 0 && other < own ? { z0: Math.max(other, 0), z1: own } : null;
  if (own >= 0) return null;
  const z1 = Math.min(other, 0);
  return z1 > own ? { z0: own, z1 } : null;
}

/**
 * The sides a piece draws at a turn. A column draws each side facing the
 * viewer where the neighbor is lower, from the neighbor's ground (or 0
 * where the neighbor is a pit, whose own far side carries on below) up to
 * its top. A pit draws its far sides, inside its opening, from its floor up
 * to the far neighbor's ground or 0, whichever is lower. A side faces the
 * viewer when its outward step brings a point nearer: on hexes three of
 * the six at every turn, whatever the heights.
 *
 * Every face reads both cells' edge profiles along the side they share,
 * never a stepping stair's stored ground (docs/design/design-v1-iso-depth.md
 * 5.2): a plain cell's is its drawn ground, flat, and a stepping stair's is
 * its treads along that side, flat at its lowest tread on its foot side, at
 * its top tread on its head side, and stepped on its outer sides. So a side
 * beside a stair's outer side is cut in fifths, one face for each run of
 * fifths with the same ends, and a stair's faces each carry their tread.
 */
export function facesOf(p: CellPiece, turn: Turn): Face[] {
  const out: Face[] = [];
  const { c, s } = turnAxes(turn);
  const centerU = c * p.center.x - s * p.center.y;
  const own = p.kind === "steps" ? p.span : undefined;
  for (let i = 0; i < p.sides.length; i++) {
    const side = p.sides[i]!;
    const near = depth(turn, side.out.x, side.out.y) > 0;
    const midU = c * ((side.a.x + side.b.x) / 2) - s * ((side.a.y + side.b.y) / 2);
    const left = midU < centerU;
    const other = p.aroundSteps?.[i];
    if (!own && !other) {
      const span = faceSpan(near, p.z, p.around[i]!);
      if (span) out.push({ ax: side.a.x, ay: side.a.y, bx: side.b.x, by: side.b.y, z0: span.z0, z1: span.z1, left, side: i });
      continue;
    }
    // A square's side, in fifths: the neighbor's key is across it.
    const nx = p.x + side.out.x;
    const ny = p.y + side.out.y;
    let last: Face | null = null;
    for (let j = 0; j < TREADS; j++) {
      const at = (f: number) => ({ x: side.a.x + (side.b.x - side.a.x) * f, y: side.a.y + (side.b.y - side.a.y) * f });
      const a = at(j / TREADS);
      const b = at((j + 1) / TREADS);
      const mid = at((j + 0.5) / TREADS);
      const tread = own ? treadAt(own, p.x, p.y, mid) : undefined;
      const span = faceSpan(near, own ? treadHeight(own, tread!) : p.z, other ? treadUnder(other, nx, ny, mid) : p.around[i]!);
      if (!span) {
        last = null;
        continue;
      }
      if (last && last.z0 === span.z0 && last.z1 === span.z1 && last.tread === tread) {
        last.bx = b.x;
        last.by = b.y;
        continue;
      }
      last = { ax: a.x, ay: a.y, bx: b.x, by: b.y, z0: span.z0, z1: span.z1, left, side: i, ...(tread === undefined ? {} : { tread }) };
      out.push(last);
    }
  }
  return out;
}

/** The lowest of the neighbor's edge profile along side `i`: its lowest tread along that side for a stepping stair, else its drawn ground. */
export function edgeLow(p: CellPiece, i: number): number {
  const other = p.aroundSteps?.[i];
  if (!other) return p.around[i]!;
  const side = p.sides[i]!;
  let low = Infinity;
  for (let j = 0; j < TREADS; j++) {
    const f = (j + 0.5) / TREADS;
    low = Math.min(low, treadUnder(other, p.x + side.out.x, p.y + side.out.y, { x: side.a.x + (side.b.x - side.a.x) * f, y: side.a.y + (side.b.y - side.a.y) * f }));
  }
  return low;
}

/**
 * A stepping stair's risers inside its square at a turn: between each
 * tread and the one below it, facing down the stair, where that faces the
 * viewer. A riser facing away is covered by its own tread's slab, or lies
 * in the ground under an opening's treads. Each draws with its upper tread.
 */
export function risersOf(p: CellPiece, turn: Turn): Face[] {
  const s = p.span;
  if (p.kind !== "steps" || !s) return [];
  const [dx, dy] = STEP[s.d];
  if (depth(turn, -dx, -dy) <= 0) return [];
  const { c, s: sn } = turnAxes(turn);
  const left = c * -dx - sn * -dy < 0;
  const out: Face[] = [];
  for (let k = 1; k < TREADS; k++) {
    const [a, b] = treadLine(s, p.x, p.y, k);
    out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, z0: treadHeight(s, k - 1), z1: treadHeight(s, k), left, side: -1, tread: k });
  }
  return out;
}

/** The line across a stair's square between tread k - 1 and tread k, `k` fifths of the way up: its foot side at 0, its head side at TREADS. */
function treadLine(s: StairStep, x: number, y: number, k: number): [Point, Point] {
  const f = k / TREADS;
  switch (s.d) {
    case "e":
      return [{ x: x + f, y }, { x: x + f, y: y + 1 }];
    case "w":
      return [{ x: x + 1 - f, y }, { x: x + 1 - f, y: y + 1 }];
    case "s":
      return [{ x, y: y + f }, { x: x + 1, y: y + f }];
    default:
      return [{ x, y: y + 1 - f }, { x: x + 1, y: y + 1 - f }];
  }
}

/** Tread k's part of a stair's square, from k fifths of the way up to k + 1, its corners clockwise from the top left as a square's are. */
export function treadPolygon(s: StairStep, x: number, y: number, k: number): Point[] {
  const pts = [...treadLine(s, x, y, k), ...treadLine(s, x, y, k + 1)];
  const x0 = Math.min(...pts.map((q) => q.x));
  const y0 = Math.min(...pts.map((q) => q.y));
  const x1 = Math.max(...pts.map((q) => q.x));
  const y1 = Math.max(...pts.map((q) => q.y));
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/** The order a stepping stair's treads draw in at a turn: far to near along its climb. */
export function treadOrder(s: StairStep, turn: Turn): readonly number[] {
  const [dx, dy] = STEP[s.d];
  return depth(turn, dx, dy) > 0 ? ASCENDING : DESCENDING;
}

const ASCENDING = Array.from({ length: TREADS }, (_, k) => k);
const DESCENDING = [...ASCENDING].reverse();

const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

/** A box in view units. */
export type VBox = { x0: number; y0: number; x1: number; y1: number };

/** A slab's corners on the ground, in order round it: its line from `a` to `b` carried on `past` cells beyond each end, and `half` cells to either side of it. */
export function slabCorners(a: Point, b: Point, half: number, past = half): Point[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const a0 = { x: a.x - ux * past, y: a.y - uy * past };
  const b0 = { x: b.x + ux * past, y: b.y + uy * past };
  // The normal, a quarter turn from the line.
  const nx = -uy * half;
  const ny = ux * half;
  return [
    { x: a0.x + nx, y: a0.y + ny },
    { x: b0.x + nx, y: b0.y + ny },
    { x: b0.x - nx, y: b0.y - ny },
    { x: a0.x - nx, y: a0.y - ny },
  ];
}

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
    // A frame's posts and leaf, and a slab's half thickness past every side and end, reach past its line, drawn or not, so the bounds hold at both detail levels (docs/design/design-v1-iso-depth.md 6).
    for (const q of frameParts(p)) for (const c of partCorners(q)) grow(box, turn, c.x, c.y, q.z0, q.z1);
    for (const c of slabCorners({ x: p.piece.ax, y: p.piece.ay }, { x: p.piece.bx, y: p.piece.by }, WALL_THICK / 2)) grow(box, turn, c.x, c.y, p.base, p.base + p.rise);
    return box;
  }
  // A column's sides reach down to 0 at the lowest. A pit's floor and far sides lie between its floor and 0. A stair's steps may reach either end of its span, whatever the detail (6).
  return polyBox(turn, p.poly, Math.min(0, p.z, p.span?.lo ?? 0), Math.max(0, p.z, p.span?.hi ?? 0));
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
 * never passes the next hex's center (docs/design/design-v1-iso-hex-relief.md 6.1).
 */
export function keyOf(p: StaticPiece, turn: Turn): number {
  if (p.kind === "wall") {
    // An open leaf has no hosts (wallItems), so it sorts by its own middle, from its hinge to its far end, apart from its frame (docs/design/design-v1-iso-depth.md 6).
    if (p.hosts) return Math.max(...p.hosts.map((h) => sortKey(turn, h.x, h.y)));
    const key = sortKey(turn, (p.piece.ax + p.piece.bx) / 2, (p.piece.ay + p.piece.by) / 2);
    // A slab that stops at another's side lies in front of it exactly when it runs toward the viewer from there. Two such slabs' middles can tie in depth, so the stopping one leans a hair that way (slabOf).
    if (p.slab) return key + SLAB_LEAN * Math.sign(depth(turn, p.slab.lean.x, p.slab.lean.y));
    return key;
  }
  return sortKey(turn, p.center.x, p.center.y);
}

/** How far a slab leans in depth from its middle's key, below every difference between two keys that are not tied. */
const SLAB_LEAN = 1e-7;

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
  /** The stairs that climb in steps (view.ts DrawnHeights.runs), whatever the zoom. None when left out. */
  runs?: StairRuns;
  /** Whether the detail shows (view.ts heightsDetail): only then does a stepping stair draw its steps, and its neighbors' faces read them. */
  detail?: boolean;
};

/** The column, pit and steps pieces of one 16 by 16 bucket of keys, the chunk at cx, cy. */
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
      const span = hex ? undefined : src.runs?.at(x, y);
      const steps = span !== undefined && src.detail === true;
      if (z === 0 && !steps) continue;
      // Painted ground stays square: a hex side wears its stair's swatch or its map tint.
      const terrain = hex ? null : src.terrain(x, y);
      const stair = marks !== null && marks[j * CHUNK_CELLS + i] !== ".";
      const n = sideCount(grid);
      const sides: { a: Point; b: Point; out: Point }[] = [];
      const around: number[] = [];
      const aroundSteps: (StairStep | undefined)[] = [];
      let steppedBeside = false;
      for (let k = 0; k < n; k++) {
        const [a, b] = sideEnds(grid, cell, k);
        const next = neighborOf(grid, cell, k);
        sides.push({ a, b, out: sideOutward(grid, cell, k) });
        around.push(src.ground(next.col, next.row));
        const beside = !hex && src.detail === true ? src.runs?.at(next.col, next.row) : undefined;
        aroundSteps.push(beside);
        steppedBeside ||= beside !== undefined;
      }
      // A stair's sides wear the floor it is painted on, stone under Stairs terrain, or its map tint (docs/design/design-v1-iso-depth.md 5.3). A hex keeps the stairs swatch.
      const look = hex ? src.look(x, y, stair ? "stairs" : null) : squareLook(src, x, y, terrain);
      const joins = hex || steps ? null : sideJoins(src, x, y, z, around, sides, aroundSteps, look);
      out.push({
        kind: steps ? "steps" : z > 0 ? "column" : "pit",
        id: `c${x},${y}`,
        x,
        y,
        z,
        around,
        ...(span ? { span } : {}),
        ...(steppedBeside ? { aroundSteps } : {}),
        poly: cellPolygon(grid, cell),
        center: cellCenter(grid, cell),
        sides,
        look,
        stair,
        ...(joins ? { joins } : {}),
      });
    }
  }
  return out;
}

/** A square's side look, from its terrain: a stair's floor is stone under Stairs terrain (5.3). */
function squareLook(src: PieceSource, x: number, y: number, terrain: TerrainId | null): SideLook {
  return src.look(x, y, terrain === "stairs" ? "stone" : terrain);
}

/**
 * Which ends of each side of a square join the same side of the square
 * beside it along that line (CellPiece.joins): that square's ground and its
 * neighbor's across the line equal this one's and its neighbor's, and its
 * look the same, so whichever face the side shows at a turn, both show the
 * same one. A side beside a stepping stair, or whose line meets one, is
 * cut by treads and joins nothing. The squares read lie at most one square
 * from this one, diagonals included, so a bucket reads its own chunk and
 * the eight around it (buckets.ts). Null where nothing joins.
 */
function sideJoins(src: PieceSource, x: number, y: number, z: number, around: readonly number[], sides: readonly { a: Point; b: Point; out: Point }[], aroundSteps: readonly (StairStep | undefined)[], look: SideLook): number[] | null {
  const stepping = (qx: number, qy: number) => src.detail === true && src.runs?.at(qx, qy) !== undefined;
  const inScene = (qx: number, qy: number) => qx >= 0 && qy >= 0 && qx < src.bounds.w && qy < src.bounds.h;
  let any = false;
  const joins = sides.map((side, i) => {
    if (aroundSteps[i]) return 0;
    const mx = (side.a.x + side.b.x) / 2;
    const my = (side.a.y + side.b.y) / 2;
    let bits = 0;
    for (const [e, bit] of [
      [side.a, 1],
      [side.b, 2],
    ] as const) {
      const qx = x + Math.sign(e.x - mx);
      const qy = y + Math.sign(e.y - my);
      const ox = qx + side.out.x;
      const oy = qy + side.out.y;
      if (!inScene(qx, qy) || stepping(qx, qy) || stepping(ox, oy)) continue;
      if (src.ground(qx, qy) !== z || src.ground(ox, oy) !== around[i]) continue;
      const other = squareLook(src, qx, qy, src.terrain(qx, qy));
      if (other.texture !== look.texture || other.color !== look.color) continue;
      bits |= bit;
    }
    any ||= bits !== 0;
    return bits;
  });
  return any ? joins : null;
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
export function wallItems(src: Pick<PieceSource, "ground" | "detail">, pieces: readonly WallPiece[], near: readonly WallPiece[] = pieces): WallItem[] {
  const out: WallItem[] = [];
  const detail = src.detail === true;
  for (const piece of pieces) {
    // Below the detail level an open door draws nothing upright, its leaf lying flat on the ground stage (docs/design/design-v1-iso-depth.md 7).
    if (!detail && (piece.kind === "open" || piece.kind === "leaf")) continue;
    const stand = standOf(src, piece);
    if (!stand) continue;
    const framed = detail && (piece.frame !== undefined || piece.kind === "leaf") ? { framed: true as const } : {};
    // On hexes an open leaf sorts by its own middle (keyOf), not with a host.
    const hosts = piece.hosts && piece.kind !== "leaf" ? piece.hosts.map((h) => h.center) : null;
    out.push({ kind: "wall", id: `w${piece.id}`, piece, base: stand.base, rise: stand.rise, hosts, ...framed });
  }
  if (!detail) return out;
  let ends: EndIndex | null = null;
  for (const w of out) {
    if (w.piece.kind !== "wall" || w.piece.hosts) continue;
    const slab = slabOf(w, (ends ??= endIndex(src, near)));
    if (slab) w.slab = slab;
  }
  return out;
}

/** Where a piece stands, from `base` up `rise` cells (wallItems), or null where an automatic wall has nothing left to show. */
function standOf(src: Pick<PieceSource, "ground">, piece: WallPiece): { base: number; rise: number } | null {
  // On hexes a run stands on its host's ground, on a shared side the higher of the two, off the scene on 0 (D-261030-461).
  if (piece.hosts) return { base: Math.max(...piece.hosts.map((h) => src.ground(h.cell.col, h.cell.row))), rise: WALL_RISE };
  if (!piece.beside) return { base: src.ground(piece.cx, piece.cy), rise: WALL_RISE };
  const a = src.ground(piece.beside[0], piece.beside[1]);
  const b = src.ground(piece.beside[2], piece.beside[3]);
  const high = Math.max(a, b);
  if (!piece.auto) return { base: high, rise: WALL_RISE };
  const top = Math.min(high, Math.max(Math.min(a, b), 0)) + WALL_RISE;
  // Ground is whole feet over feet per cell, so a top level with the higher ground can land a float's hair above it, which would draw a hairline. A real rise is at least 1 / 200 cell.
  if (top - high < 1e-9) return null;
  return { base: high, rise: top - high };
}

/** A standing piece at one of its ends: its other end, its height, and whether it stands in a frame or as a wall. */
type EndEntry = { id: string; other: Point; base: number; top: number; framed: boolean };
type EndIndex = Map<string, EndEntry[]>;

const endKey = (p: Point) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;

/** The standing walls and frames on squares near a bucket, filed by each of their ends. */
function endIndex(src: Pick<PieceSource, "ground">, near: readonly WallPiece[]): EndIndex {
  const index: EndIndex = new Map();
  for (const q of near) {
    if (q.hosts || (q.kind !== "wall" && q.kind !== "door" && q.kind !== "open" && q.kind !== "window")) continue;
    const stand = standOf(src, q);
    if (!stand) continue;
    const a = { x: q.ax, y: q.ay };
    const b = { x: q.bx, y: q.by };
    for (const [at, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const key = endKey(at);
      const entry = { id: q.id, other, base: stand.base, top: stand.base + stand.rise, framed: q.kind !== "wall" };
      const list = index.get(key);
      if (list) list.push(entry);
      else index.set(key, [entry]);
    }
  }
  return index;
}

const SLAB_HALF = WALL_THICK / 2;

/**
 * A wall piece's slab (5.6, D-261102-888): each end by what meets it there.
 *
 * - The next slab of the wall along the line, with the same base and top:
 *   the two meet with no end face and no line between them.
 * - A frame along the line: the slab stops at the post, which covers its end.
 * - A slab along the line of another height: it stops there, its end face showing.
 * - Two slabs through the end across it (a wall ending on another): it
 *   stops at their side, half a thickness short.
 * - One slab across it (a corner): the taller, or the first by id, carries
 *   on half a thickness over the corner and the other stops at its side, so
 *   the corner shows no notch and neither slab stands inside the other.
 * - Nothing: it carries on half a thickness, so a free end looks square.
 *
 * Each slab sorts by its line's middle, a slab that stops short leaning
 * toward its own side of the slab it stops at (keyOf), so of two slabs
 * meeting at a corner the nearer draws last.
 */
function slabOf(w: WallItem, ends: EndIndex): Slab | null {
  const p = w.piece;
  const len = Math.hypot(p.bx - p.ax, p.by - p.ay);
  if (!(len > 1e-9)) return null;
  const ux = (p.bx - p.ax) / len;
  const uy = (p.by - p.ay) / len;
  const top = w.base + w.rise;
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const endOf = (at: Point, out: Point): { shift: number; face: boolean; line: boolean } => {
    const along: EndEntry[] = [];
    const across: EndEntry[] = [];
    for (const q of ends.get(endKey(at)) ?? []) {
      if (q.id === p.id) continue;
      const qx = q.other.x - at.x;
      const qy = q.other.y - at.y;
      const ql = Math.hypot(qx, qy);
      if (!(ql > 1e-9)) continue;
      if (Math.abs(ux * qy - uy * qx) / ql < 1e-6) {
        // Along the line, beyond this end: the next piece of the wall.
        if (qx * out.x + qy * out.y > 0) along.push(q);
      } else if (!q.framed) across.push(q);
    }
    if (along.some((q) => !q.framed && same(q.base, w.base) && same(q.top, top))) return { shift: 0, face: false, line: false };
    if (along.some((q) => q.framed)) return { shift: 0, face: false, line: true };
    if (along.length > 0) return { shift: 0, face: true, line: true };
    const dirOf = (q: EndEntry) => {
      const l = Math.hypot(q.other.x - at.x, q.other.y - at.y);
      return { x: (q.other.x - at.x) / l, y: (q.other.y - at.y) / l };
    };
    // Two of them going on from here in opposite directions along one line.
    const through = across.some((q, i) =>
      across.some((r, j) => {
        if (j <= i) return false;
        const d = dirOf(q);
        const e = dirOf(r);
        return Math.abs(d.x * e.y - d.y * e.x) < 1e-6 && d.x * e.x + d.y * e.y < 0;
      }),
    );
    if (through) return { shift: -1, face: true, line: true };
    if (across.length === 1) {
      const q = across[0]!;
      const covers = top > q.top + 1e-9 || (same(top, q.top) && p.id < q.id);
      return { shift: covers ? 1 : -1, face: true, line: true };
    }
    return { shift: 1, face: true, line: true };
  };
  const ea = endOf({ x: p.ax, y: p.ay }, { x: -ux, y: -uy });
  const eb = endOf({ x: p.bx, y: p.by }, { x: ux, y: uy });
  // A piece shorter than the two pulls back is a sliver inside the walls across it: it keeps its own line.
  if (len + (ea.shift + eb.shift) * SLAB_HALF < 1e-6) return null;
  const lean = { x: ((ea.shift < 0 ? 1 : 0) - (eb.shift < 0 ? 1 : 0)) * ux, y: ((ea.shift < 0 ? 1 : 0) - (eb.shift < 0 ? 1 : 0)) * uy };
  return {
    lean,
    a: { x: p.ax - ux * ea.shift * SLAB_HALF, y: p.ay - uy * ea.shift * SLAB_HALF },
    b: { x: p.bx + ux * eb.shift * SLAB_HALF, y: p.by + uy * eb.shift * SLAB_HALF },
    face: [ea.face, eb.face],
    line: [ea.line, eb.line],
  };
}
