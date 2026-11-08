import type { Board, Side } from "./layout.ts";
import type { Stream } from "./random.ts";

/*
 * A sewer's water (phase 2, 5.1, D-261107-199 and 262). Water only costs
 * double (shared/rules/walk.ts), so it never closes a way. On Wide a dry
 * walkway runs beside the channel. On Narrow the channel fills the
 * corridor but at each ordinary doorway, so a corridor that runs dry to a
 * blank wall is never the sign of a secret door: a secret doorway's
 * outside square is water, as a dead end's tip is.
 */

const CISTERN_CHANCE = [1, 2] as const;
/** Rooms this size or larger may hold a cistern. */
const CISTERN_MIN_ROOM = 5;

/** A Wide corridor's way: its chain of block positions, or a spur's squares and side. */
export type Channel = { chain: readonly number[] } | { cells: readonly number[]; side: Side };

/**
 * The water a sewer's corridors hold. On Narrow, every corridor square but
 * those `dry` keeps (each ordinary doorway's outside square, the runs and
 * the stub's stairs). On Wide, by blocks: a block stepped east or west has
 * its south row as water and one stepped north or south its east column,
 * and a square under blocks of both kinds, at a turn, stays dry, so a
 * walkway runs along the north or west side. `dry` keeps the runs and the
 * stub's stairs there too.
 */
export function channelWater(board: Board, wide: boolean, corridor: ReadonlySet<number>, channels: readonly Channel[], dry: (k: number) => boolean): Set<number> {
  const out = new Set<number>();
  if (!wide) {
    for (const k of corridor) if (!dry(k)) out.add(k);
    return out;
  }
  const W = board.W;
  /** Bit 1: under a block stepped east or west. Bit 2: under one stepped north or south. */
  const kinds = new Map<number, number>();
  const wet = new Set<number>();
  const mark = (k: number, kind: 1 | 2) => kinds.set(k, (kinds.get(k) ?? 0) | kind);
  const block = (at: number, kind: 1 | 2) => {
    const squares = [at, at + 1, at + W, at + W + 1];
    for (const k of squares) mark(k, kind);
    for (const k of kind === 1 ? [at + W, at + W + 1] : [at + 1, at + W + 1]) wet.add(k);
  };
  for (const c of channels) {
    if ("chain" in c) {
      const chain = c.chain;
      for (let i = 0; i < chain.length; i++) {
        const step = i > 0 ? chain[i]! - chain[i - 1]! : chain.length > 1 ? chain[1]! - chain[0]! : 0;
        if (step === 0) continue;
        block(chain[i]!, Math.abs(step) === 1 ? 1 : 2);
      }
    } else {
      // A spur is two squares across, so its rows pair into blocks along its way.
      const kind = c.side === "e" || c.side === "w" ? 1 : 2;
      const xs = c.cells.map((k) => k % W);
      const ys = c.cells.map((k) => Math.floor(k / W));
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const x1 = Math.max(...xs);
      const y1 = Math.max(...ys);
      for (const k of c.cells) {
        mark(k, kind);
        const x = k % W;
        const y = Math.floor(k / W);
        if ((kind === 1 && y === y1 && y1 > y0) || (kind === 2 && x === x1 && x1 > x0)) wet.add(k);
      }
    }
  }
  for (const k of wet) if (corridor.has(k) && kinds.get(k) !== 3 && !dry(k)) out.add(k);
  return out;
}

/**
 * Cisterns (5.1): in about 1 of 2 rooms 5 by 5 or larger without a dais,
 * water over the room's inset rectangle less its ordinary doorway lines
 * (`walkways`), which cross it dry. A secret doorway's line takes the water
 * like the rest, so no walkway runs to a blank wall. One draw a room, in
 * the order given, whatever it holds.
 */
export function placeCisterns(rng: Stream, board: Board, rooms: readonly number[], hasDais: (room: number) => boolean, walkways: (room: number) => ReadonlySet<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const i of rooms) {
    const r = board.rooms[i]!;
    if (!rng.chance(...CISTERN_CHANCE)) continue;
    if (r.w < CISTERN_MIN_ROOM || r.h < CISTERN_MIN_ROOM || hasDais(i)) continue;
    const dry = walkways(i);
    const water: number[] = [];
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        const k = board.cell(x, y);
        if (!dry.has(k)) water.push(k);
      }
    }
    if (water.length > 0) out.set(i, water);
  }
  return out;
}
