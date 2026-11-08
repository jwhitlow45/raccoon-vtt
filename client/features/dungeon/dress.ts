import type { TerrainId } from "#shared/model.ts";
import type { Dais } from "./heights.ts";
import { type Board, type Doorway } from "./layout.ts";
import type { Stream } from "./random.ts";
import type { ThemeSpec } from "./themes.ts";

/*
 * Doors and dressing (docs/design/design-v1-dungeon-generator.md 5.3 steps
 * 8 and 9). Nothing stands where the party must walk: a doorway's inside
 * square, the lines from a room's doorways to its middle, a dais's stair,
 * the square before it and the dais square at its top.
 */

/**
 * Crypt rooms this size or larger get pillars: a 5 by 5 room's ring holds
 * one at each corner. From 6, Sparse rooms (3 to 6 squares a side) almost
 * never had one, so a Sparse Crypt read as a Dungeon with more locks
 * (D-261102-836).
 */
const PILLAR_MIN_ROOM = 5;

/**
 * The squares from each of a room's doorways to its middle: straight in
 * from the doorway to the middle's row or column, then along it, as wide as
 * the doorway, so a Large creature on Wide finds its way clear. `skip`
 * leaves out doorways whose lines count as plain floor: a secret doorway's
 * leaves no mark (phase 2, D-261107-262).
 */
export function doorLines(board: Board, room: number, skip: (d: Doorway) => boolean = () => false): Set<number> {
  const r = board.rooms[room]!;
  const out = new Set<number>();
  for (const d of board.doorways) {
    if (d.room !== room || d.removed || skip(d)) continue;
    const mx = r.x + Math.floor((r.w - d.width) / 2);
    const my = r.y + Math.floor((r.h - d.width) / 2);
    const xs = d.inside.map((k) => k % board.W);
    const ys = d.inside.map((k) => Math.floor(k / board.W));
    const add = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.add(board.cell(x, y));
    };
    const w = d.width - 1;
    if (d.side === "n" || d.side === "s") {
      const c = Math.min(...xs);
      add(c, ys[0]!, c + w, my + (d.side === "n" ? w : 0));
      add(Math.min(c, mx), my, Math.max(c, mx) + w, my + w);
    } else {
      const c = Math.min(...ys);
      add(xs[0]!, c, mx + (d.side === "w" ? w : 0), c + w);
      add(mx, Math.min(c, my), mx + w, Math.max(c, my) + w);
    }
  }
  return out;
}

/**
 * Each kept doorway's door, a Wide doorway's two edges alike: closed or
 * locked by theme, the entrance's own door always closed. A theme without
 * doors (Cave) draws none.
 */
export function doorStates(rng: Stream, doorways: readonly Doorway[], theme: ThemeSpec, stub: Doorway | null): Map<number, "closed" | "locked"> {
  const out = new Map<number, "closed" | "locked">();
  if (!theme.doors) return out;
  for (const d of doorways) {
    if (d.removed) continue;
    const locked = rng.chance(theme.lockedIn100, 100);
    out.set(d.id, d === stub || !locked ? "closed" : "locked");
  }
  return out;
}

/** The floor each kept room is painted with: the theme's, and wood in about a fifth of a Dungeon's rooms. */
export function roomFloors(rng: Stream, board: Board, theme: ThemeSpec): TerrainId[] {
  return board.rooms.map((r) => (r.dropped || !theme.wood ? theme.floor : rng.chance(...theme.wood) ? "wood" : theme.floor));
}

/**
 * Rubble in the theme's share of the corridors: 1 to 3 squares in a row
 * along the corridor's way, never on a run, a flattened run, a doorway's
 * outside square or the stub's stairs.
 */
export function placeRubble(rng: Stream, corridors: readonly (readonly number[])[], chance: readonly [number, number], kept: (k: number) => boolean, out: Map<number, TerrainId>): void {
  for (const path of corridors) {
    if (!rng.chance(...chance)) continue;
    const n = rng.int(1, 3);
    const free = (k: number) => kept(k) && !out.has(k);
    const starts = path.map((_, i) => i).filter((i) => free(path[i]!));
    if (starts.length === 0) continue;
    let i = rng.pick(starts);
    for (let placed = 0; placed < n && i < path.length && free(path[i]!); placed++, i++) out.set(path[i]!, "rubble");
  }
}

/**
 * A Pit in the theme's share of the rooms, on squares `free` allows:
 * Dungeon's of 1 or 2 squares, the second beside the first, and Mine's
 * 1-square shafts.
 */
export function placePits(rng: Stream, board: Board, rooms: readonly number[], pits: NonNullable<ThemeSpec["pits"]>, free: (room: number, k: number) => boolean, out: Map<number, TerrainId>): void {
  for (const i of rooms) {
    if (!rng.chance(...pits.chance)) continue;
    const r = board.rooms[i]!;
    const size = pits.most === 1 ? 1 : rng.int(1, 2);
    const ok = (k: number) => free(i, k) && !out.has(k);
    const spots: number[][] = [];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const k = board.cell(x, y);
        if (!ok(k)) continue;
        if (size === 1) spots.push([k]);
        else {
          if (x + 1 < r.x + r.w && ok(k + 1)) spots.push([k, k + 1]);
          if (y + 1 < r.y + r.h && ok(k + board.W)) spots.push([k, k + board.W]);
        }
      }
    }
    if (spots.length === 0) continue;
    for (const k of rng.pick(spots)) out.set(k, "pit");
  }
}

/**
 * Pillars in a Crypt's rooms 5 by 5 or larger: every other square of the
 * ring a square in from the walls, where `free` allows. A pillar may stand
 * on a dais but never on the square at the top of its stair.
 */
export function placePillars(board: Board, rooms: readonly number[], free: (room: number, k: number) => boolean, out: Map<number, TerrainId>): void {
  for (const i of rooms) {
    const r = board.rooms[i]!;
    if (r.w < PILLAR_MIN_ROOM || r.h < PILLAR_MIN_ROOM) continue;
    const x0 = r.x + 1;
    const y0 = r.y + 1;
    const x1 = r.x + r.w - 2;
    const y1 = r.y + r.h - 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
        // Every other square round the ring, so the party walks between them.
        if ((x - x0 + y - y0) % 2 !== 0) continue;
        const k = board.cell(x, y);
        if (free(i, k) && !out.has(k)) out.set(k, "pillar");
      }
    }
  }
}

/** The squares a dais keeps clear of everything: its stair, the square before it and the square at its top. */
export function daisClear(dais: Dais): number[] {
  return [dais.stair, dais.before, dais.top];
}
