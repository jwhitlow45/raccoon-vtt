import type { TerrainId } from "#shared/model.ts";
import type { Dais } from "./heights.ts";
import { type Board, type Doorway } from "./layout.ts";
import type { Stream } from "./random.ts";
import type { Theme } from "./settings.ts";

/*
 * Doors and dressing (docs/design/design-v1-dungeon-generator.md 5.3 steps
 * 8 and 9). Nothing stands where the party must walk: a doorway's inside
 * square, the lines from a room's doorways to its middle, a dais's stair,
 * the square before it and the dais square at its top.
 */

/** Locked doors in a hundred, by theme. The rest are closed. */
const LOCKED_IN_100: Readonly<Record<Theme, number>> = { dungeon: 15, crypt: 25 };
const WOOD_CHANCE = [1, 5] as const;
const RUBBLE_CHANCE = [1, 3] as const;
const PIT_CHANCE = [1, 6] as const;
/** Crypt rooms this size or larger get pillars. */
const PILLAR_MIN_ROOM = 6;

/**
 * The squares from each of a room's doorways to its middle: straight in
 * from the doorway to the middle's row or column, then along it, as wide as
 * the doorway, so a Large creature on Wide finds its way clear.
 */
export function doorLines(board: Board, room: number): Set<number> {
  const r = board.rooms[room]!;
  const out = new Set<number>();
  for (const d of board.doorways) {
    if (d.room !== room || d.removed) continue;
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
 * locked by theme, the entrance's own door always closed.
 */
export function doorStates(rng: Stream, doorways: readonly Doorway[], theme: Theme, stub: Doorway | null): Map<number, "closed" | "locked"> {
  const out = new Map<number, "closed" | "locked">();
  for (const d of doorways) {
    if (d.removed) continue;
    const locked = rng.chance(LOCKED_IN_100[theme], 100);
    out.set(d.id, d === stub || !locked ? "closed" : "locked");
  }
  return out;
}

/** The floor each kept room is painted with: wood in about a fifth of a Dungeon's rooms, else stone. */
export function roomFloors(rng: Stream, board: Board, theme: Theme): TerrainId[] {
  return board.rooms.map((r) => (r.dropped || theme !== "dungeon" ? "stone" : rng.chance(...WOOD_CHANCE) ? "wood" : "stone"));
}

/**
 * Rubble in about a third of a Dungeon's corridors: 1 to 3 squares in a row
 * along the corridor's way, never on a run, a flattened run, a doorway's
 * outside square or the stub's stairs.
 */
export function placeRubble(rng: Stream, corridors: readonly (readonly number[])[], kept: (k: number) => boolean, out: Map<number, TerrainId>): void {
  for (const path of corridors) {
    if (!rng.chance(...RUBBLE_CHANCE)) continue;
    const n = rng.int(1, 3);
    const free = (k: number) => kept(k) && !out.has(k);
    const starts = path.map((_, i) => i).filter((i) => free(path[i]!));
    if (starts.length === 0) continue;
    let i = rng.pick(starts);
    for (let placed = 0; placed < n && i < path.length && free(path[i]!); placed++, i++) out.set(path[i]!, "rubble");
  }
}

/**
 * A Pit of 1 or 2 squares in a few of a Dungeon's rooms, on squares
 * `free` allows, the second beside the first.
 */
export function placePits(rng: Stream, board: Board, rooms: readonly number[], free: (room: number, k: number) => boolean, out: Map<number, TerrainId>): void {
  for (const i of rooms) {
    if (!rng.chance(...PIT_CHANCE)) continue;
    const r = board.rooms[i]!;
    const size = rng.int(1, 2);
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
 * Pillars in a Crypt's rooms 6 by 6 or larger: every other square of the
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
