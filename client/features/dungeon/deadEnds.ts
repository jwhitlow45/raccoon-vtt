import { DX, DY, type Board, type Side } from "./layout.ts";
import type { Stream } from "./random.ts";
import { MAX_DEAD_ENDS } from "./settings.ts";

/*
 * Dead ends (phase 2, 5.2, D-261107-206): straight spurs off the corridors
 * that end in rock, so not every corridor that stops hides a secret door.
 * Each keeps a square of rock from every room and every other corridor, so
 * it never ends against a room's wall, where only a secret door may.
 */

const SIDES: readonly Side[] = ["n", "e", "s", "w"];
const SHORTEST = 3;
const LONGEST = 8;
const TRIES = 10;
/** About one dead end per this many kept rooms. */
const ROOMS_PER_DEAD_END = 4;

/** Dead ends a dungeon of `rooms` kept rooms takes: about one per four, at least 1 and at most MAX_DEAD_ENDS. */
export function deadEndCount(rooms: number): number {
  return Math.min(MAX_DEAD_ENDS, Math.max(1, Math.floor((rooms + ROOMS_PER_DEAD_END / 2) / ROOMS_PER_DEAD_END)));
}

export type Spur = {
  /** Its squares, row by row out from the corridor. */
  cells: number[];
  /** The way it runs out from the corridor, which sets a Wide sewer's channel. */
  side: Side;
};

export type SpurInput = {
  board: Board;
  /** 1 on Narrow, 2 on Wide. */
  width: 1 | 2;
  /** Where a spur may start: a corridor square, or a Wide block's top-left, that is not a run, a doorway's outside square or the stub's stairs. */
  starts: readonly number[];
  /** Every corridor square so far. Spurs join it as they are laid. */
  corridor: Set<number>;
  /** Squares the router could open (corridors.ts `openSquares`). */
  open: Uint8Array;
  count: number;
};

/**
 * The spurs (5.2): each from a start drawn at random, toward a side drawn
 * at random, 3 to 8 squares long and as wide as the corridor. Every spur
 * square is one the router could open and touches no corridor square but
 * the one it grows from, so the spur ends in rock at least a square from
 * any room and any other corridor. A start with fewer than 3 squares free
 * that way is passed over, at most 10 tries a dead end. Every try draws
 * its start, side and length before it is tested.
 */
export function placeDeadEnds(rng: Stream, input: SpurInput): Spur[] {
  const { board, width, corridor, open } = input;
  const out: Spur[] = [];
  if (input.starts.length === 0) return out;
  for (let n = 0; n < input.count; n++) {
    for (let t = 0; t < TRIES; t++) {
      const start = rng.pick(input.starts);
      const side = rng.pick(SIDES);
      const long = rng.int(SHORTEST, LONGEST);
      const rows = spurRows(board, start, side, width, long);
      let free = 0;
      for (let i = 0; i < rows.length; i++) {
        const prev = i === 0 ? face(board, start, side, width) : rows[i - 1]!;
        if (!rows[i]!.every((k) => fits(board, k, open, corridor, [...prev, ...rows[i]!]))) break;
        free++;
      }
      if (free < SHORTEST) continue;
      const cells = rows.slice(0, free).flat();
      for (const k of cells) {
        corridor.add(k);
        board.laid[k] = 1;
      }
      out.push({ cells, side });
      break;
    }
  }
  return out;
}

/** The squares of a corridor's side a spur grows from: the start square, or a Wide block's two squares on that side. */
function face(board: Board, start: number, side: Side, width: 1 | 2): number[] {
  if (width === 1) return [start];
  const W = board.W;
  switch (side) {
    case "n":
      return [start, start + 1];
    case "s":
      return [start + W, start + W + 1];
    case "w":
      return [start, start + W];
    case "e":
      return [start + 1, start + W + 1];
  }
}

/** The spur's rows of `width` squares, 1 to `long` steps out from its face, cut where the map ends. */
function spurRows(board: Board, start: number, side: Side, width: 1 | 2, long: number): number[][] {
  const rows: number[][] = [];
  const from = face(board, start, side, width);
  for (let t = 1; t <= long; t++) {
    const row: number[] = [];
    for (const k of from) {
      const x = (k % board.W) + DX[side] * t;
      const y = Math.floor(k / board.W) + DY[side] * t;
      if (!board.inMap(x, y)) return rows;
      row.push(board.cell(x, y));
    }
    rows.push(row);
  }
  return rows;
}

/** Whether a spur square is open rock whose every other neighbor is rock: `own` holds the squares it may touch. */
function fits(board: Board, k: number, open: Uint8Array, corridor: ReadonlySet<number>, own: readonly number[]): boolean {
  if (open[k] !== 1 || corridor.has(k) || board.laid[k] === 1) return false;
  const x = k % board.W;
  const y = (k - x) / board.W;
  for (const side of SIDES) {
    const nx = x + DX[side];
    const ny = y + DY[side];
    if (!board.inMap(nx, ny)) continue;
    const n = board.cell(nx, ny);
    if (own.includes(n)) continue;
    if (corridor.has(n) || board.laid[n] === 1 || board.roomAt[n] !== 0) return false;
  }
  return true;
}
