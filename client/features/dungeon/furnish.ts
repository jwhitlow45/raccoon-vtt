import { FOG_SUBCELLS } from "#shared/model.ts";
import { stampCells } from "#shared/project.ts";
import { hexAt, type HexGrid } from "#shared/rules/hex.ts";
import { hexGridOf, type Lattice } from "./lattice.ts";
import type { Side } from "./layout.ts";
import type { Board } from "./layout.ts";
import type { PlanStamp } from "./plan.ts";
import { stampSize, WALL_PIECES } from "./props.ts";
import type { Stream } from "./random.ts";
import { MAX_ROOM_STAMPS, MAX_STAMPS, type Dressing } from "./settings.ts";

/*
 * Dressing (phase 2, 5.5, D-261107-201): props from the shipped stamps,
 * each on a free block of whole squares wholly inside one room, so its box
 * never straddles a wall and map discovery shows it only with that room.
 * Pictures only: nothing here blocks a move or sight.
 */

/** Rooms Some dresses, in three: 2. */
const SOME_ROOMS = [2, 3] as const;
/** Draws a prop takes at a key and a turn before its room gives up on it. */
const PROP_TRIES = 6;
const TURNS = [0, 90, 180, 270] as const;
/** A wall piece's turn by the wall it stands against: a wide piece as drawn along the north wall. */
const WALL_TURN: Readonly<Record<Side, 0 | 90 | 180 | 270>> = { n: 0, e: 90, s: 180, w: 270 };

export type Furnished = { room: number; stamp: PlanStamp; squares: number[] };

export type FurnishInput = {
  board: Board;
  rooms: readonly number[];
  dressing: Dressing;
  /** The keys a room draws its props from. */
  props: (room: number) => readonly string[];
  /** Squares of the room a prop may take: free floor off the ways, the pin square and what stands there already. */
  free: (room: number, k: number) => boolean;
  /** Each square's ground, so a block never straddles a dais's edge. */
  ground: (k: number) => number;
  /** Stamps each room holds already (its light and statue) and the dungeon's total, inside the caps. */
  held: (room: number) => number;
  total: number;
};

/**
 * The props (5.5): Some puts 1 or 2 in about 2 rooms of 3, Full 2 to 4 in
 * every room, None none, each room at most MAX_ROOM_STAMPS with its light
 * and statue and the dungeon MAX_STAMPS. Each prop draws a key and a turn
 * (a side for a wall piece, which stands with a long side against it) and
 * then a block where it fits, centered there at the catalog's size. A room
 * that fits none of a prop's draws after a few tries holds what it has.
 */
export function furnish(rng: Stream, input: FurnishInput): Furnished[] {
  const { board } = input;
  const out: Furnished[] = [];
  if (input.dressing === "none") return out;
  let total = input.total;
  const used = new Set<number>();
  for (const i of input.rooms) {
    const list = input.props(i);
    let want = input.dressing === "full" ? rng.int(2, 4) : rng.chance(...SOME_ROOMS) ? rng.int(1, 2) : 0;
    want = Math.max(0, Math.min(want, MAX_ROOM_STAMPS - input.held(i), MAX_STAMPS - total));
    const r = board.rooms[i]!;
    const fits = (x: number, y: number, w: number, h: number) => {
      if (x < r.x || y < r.y || x + w > r.x + r.w || y + h > r.y + r.h) return false;
      const at = input.ground(board.cell(x, y));
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const k = board.cell(xx, yy);
          if (used.has(k) || !input.free(i, k) || input.ground(k) !== at) return false;
        }
      }
      return true;
    };
    for (let n = 0; n < want; n++) {
      for (let t = 0; t < PROP_TRIES; t++) {
        const key = rng.pick(list);
        const size = stampSize(key);
        const wall = WALL_PIECES.has(key);
        const side = wall ? rng.pick(["n", "e", "s", "w"] as const) : null;
        const rotation = side ? ((WALL_TURN[side] + (size && size.h > size.w ? 90 : 0)) % 360) as 0 | 90 | 180 | 270 : rng.pick(TURNS);
        if (!size) continue;
        const [rw, rh] = rotation % 180 === 0 ? [size.w, size.h] : [size.h, size.w];
        const bw = Math.ceil(rw);
        const bh = Math.ceil(rh);
        const spots: [number, number][] = [];
        for (let y = r.y; y + bh <= r.y + r.h; y++) {
          for (let x = r.x; x + bw <= r.x + r.w; x++) {
            if (side === "n" && y !== r.y) continue;
            if (side === "s" && y + bh !== r.y + r.h) continue;
            if (side === "w" && x !== r.x) continue;
            if (side === "e" && x + bw !== r.x + r.w) continue;
            if (fits(x, y, bw, bh)) spots.push([x, y]);
          }
        }
        if (spots.length === 0) continue;
        const [x, y] = rng.pick(spots);
        const squares: number[] = [];
        for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) squares.push(board.cell(xx, yy));
        for (const k of squares) used.add(k);
        out.push({ room: i, squares, stamp: { key, x: x + bw / 2, y: y + bh / 2, w: size.w, h: size.h, rotation } });
        total++;
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ hexes

/** A stamp's place and size, as its whole-cell box reads it. */
export type StampBox = Pick<PlanStamp, "x" | "y" | "w" | "h" | "rotation">;

/** Hex steps a stamp's box keeps from every doorway's inside hex (phase 3, 2.4): none within 2. */
export const STAMP_DOOR_STEPS = 2;

/** Steps between two cells of the hex rows lattice. */
export function latticeDistance(W: number, a: number, b: number): number {
  const ax = a % W;
  const ay = (a - ax) / W;
  const bx = b % W;
  const by = (b - bx) / W;
  const aq = ax - Math.floor(ay / 2);
  const bq = bx - Math.floor(by / 2);
  const dq = aq - bq;
  const dr = ay - by;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/**
 * The stamp rule on hexes (phase 3, 2.4, D-261110-178). A player gets a
 * stamp unless every fog sub-cell of its whole-cell box is fogged
 * (shared/project.ts `stampCells`), so a box reaching past its room's walls
 * would show the room's contents early. A stamp stands only where every
 * sub-cell of its box lies in a hex `allowed` passes: its own room's floor,
 * more than 2 steps from any doorway's inside hex.
 */
export class HexStamps {
  readonly #L: Lattice;
  readonly #g: HexGrid;
  readonly #cells = new Map<number, readonly number[]>();

  constructor(L: Lattice) {
    if (L.kind === "squares") throw new Error("HexStamps reads a hex lattice");
    this.#L = L;
    this.#g = hexGridOf(L.kind);
  }

  /** The lattice cells holding a scene cell's fog sub-cells, -1 for one off the scene's hexes. */
  hexesOf(cx: number, cy: number): readonly number[] {
    const id = cy * 100_000 + cx;
    const known = this.#cells.get(id);
    if (known) return known;
    const L = this.#L;
    const out = new Set<number>();
    for (let j = 0; j < FOG_SUBCELLS; j++) {
      for (let i = 0; i < FOG_SUBCELLS; i++) {
        const h = hexAt(this.#g, { x: cx + (i + 0.5) / FOG_SUBCELLS, y: cy + (j + 0.5) / FOG_SUBCELLS });
        const [x, y] = L.kind === "hexRows" ? [h.col, h.row] : [h.row, h.col];
        out.add(L.inMap(x, y) ? y * L.W + x : -1);
      }
    }
    const list = [...out];
    this.#cells.set(id, list);
    return list;
  }

  /** Every hex a stamp's box touches by a sub-cell, -1 among them when it reaches off the scene. */
  touched(stamp: StampBox): number[] {
    const box = stampCells(stamp);
    const out = new Set<number>();
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) for (const k of this.hexesOf(x, y)) out.add(k);
    return [...out];
  }

  fits(stamp: StampBox, allowed: (k: number) => boolean): boolean {
    return this.touched(stamp).every((k) => k >= 0 && allowed(k));
  }
}

export type HexFurnishInput = Omit<FurnishInput, "ground"> & {
  stamps: HexStamps;
  lattice: Lattice;
  /** Hexes of a room a stamp's box may cover: its floor away from the doorways and off what stands there. */
  allowed: (room: number, k: number) => boolean;
};

/**
 * Dressing on hexes (2.4): the draws of `furnish`, each room's count, key
 * and turn, but each prop centered on one of its room's free hexes where
 * the stamp rule holds and its box shares no hex with a prop before it. A
 * prop with no such spot is left out.
 */
export function furnishHex(rng: Stream, input: HexFurnishInput): Furnished[] {
  const { board, lattice: L } = input;
  const out: Furnished[] = [];
  if (input.dressing === "none") return out;
  let total = input.total;
  const used = new Set<number>();
  for (const i of input.rooms) {
    const list = input.props(i);
    let want = input.dressing === "full" ? rng.int(2, 4) : rng.chance(...SOME_ROOMS) ? rng.int(1, 2) : 0;
    want = Math.max(0, Math.min(want, MAX_ROOM_STAMPS - input.held(i), MAX_STAMPS - total));
    const r = board.rooms[i]!;
    const ok = (k: number) => !used.has(k) && input.allowed(i, k);
    for (let n = 0; n < want; n++) {
      for (let t = 0; t < PROP_TRIES; t++) {
        const key = rng.pick(list);
        const size = stampSize(key);
        const wall = WALL_PIECES.has(key);
        const side = wall ? rng.pick(["n", "e", "s", "w"] as const) : null;
        const rotation = side ? ((WALL_TURN[side] + (size && size.h > size.w ? 90 : 0)) % 360) as 0 | 90 | 180 | 270 : rng.pick(TURNS);
        if (!size) continue;
        const spots: { x: number; y: number; hexes: number[] }[] = [];
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const k = board.cell(x, y);
            if (!input.free(i, k) || !ok(k)) continue;
            const [px, py] = L.pointOf(x, y);
            const stamp = { x: px, y: py, w: size.w, h: size.h, rotation };
            const hexes = input.stamps.touched(stamp);
            if (hexes.every((h) => h >= 0 && ok(h))) spots.push({ x: px, y: py, hexes });
          }
        }
        if (spots.length === 0) continue;
        const spot = rng.pick(spots);
        for (const h of spot.hexes) used.add(h);
        out.push({ room: i, squares: spot.hexes, stamp: { key, x: spot.x, y: spot.y, w: size.w, h: size.h, rotation } });
        total++;
        break;
      }
    }
  }
  return out;
}
