import { DX, DY, type Board, type Rect, type Side } from "./layout.ts";
import type { Stream } from "./random.ts";

/*
 * Cave's rough shapes (phase 2, 5.1, D-261107-199). A cave room keeps its
 * rectangle for placement, the gaps between rooms and the squares touching
 * it, so every wall stays automatic and every corridor still meets the
 * room only at its doorways. Only then does it lose squares: its corners,
 * nibbles of its outer ring, and rock columns inside. Tunnels bulge
 * outward where a corridor could have gone, never toward a room or a run.
 */

const NIBBLE_CHANCE = [1, 6] as const;
const BULGE_CHANCE = [1, 4] as const;
/** Rooms this size or larger take rock columns. */
const COLUMN_MIN_ROOM = 7;
const COLUMNS_MOST = 3;

const SIDES: readonly Side[] = ["n", "e", "s", "w"];

/** A rectangle's outer ring, side by side from each corner, the four corners first. */
function ring(r: Rect): { corners: [number, number][]; sides: [number, number][][] } {
  const x1 = r.x + r.w - 1;
  const y1 = r.y + r.h - 1;
  const along = (from: number, to: number, at: (i: number) => [number, number]) => {
    const out: [number, number][] = [];
    for (let i = from; i <= to; i++) out.push(at(i));
    return out;
  };
  return {
    corners: [
      [r.x, r.y],
      [x1, r.y],
      [x1, y1],
      [r.x, y1],
    ],
    sides: [
      along(r.x + 1, x1 - 1, (x) => [x, r.y]),
      along(r.y + 1, y1 - 1, (y) => [x1, y]),
      along(r.x + 1, x1 - 1, (x) => [x, y1]),
      along(r.y + 1, y1 - 1, (y) => [r.x, y]),
    ],
  };
}

/**
 * The squares a cave room loses from its outer ring: its four corners, and
 * nibbles each ring square starts with a 1 in 6 chance, 1 or 2 squares long
 * along its side. `keep` holds what is never removed: the doorways' inside
 * squares and the ring squares beside them, the doorway lines, a dais and
 * its clear squares. Every other ring square touches the inset rectangle by
 * an edge, so the room stays one piece. Every draw is made whatever `keep`
 * says, so a kept square never moves a later nibble.
 */
export function erodeRoom(rng: Stream, board: Board, room: number, keep: (k: number) => boolean): Set<number> {
  const r = board.rooms[room]!;
  const out = new Set<number>();
  const { corners, sides } = ring(r);
  for (const [x, y] of corners) {
    const k = board.cell(x, y);
    if (!keep(k)) out.add(k);
  }
  for (const side of sides) {
    for (let i = 0; i < side.length; i++) {
      if (!rng.chance(...NIBBLE_CHANCE)) continue;
      const long = rng.int(1, 2);
      for (let j = i; j < Math.min(side.length, i + long); j++) {
        const [x, y] = side[j]!;
        const k = board.cell(x, y);
        if (!keep(k)) out.add(k);
      }
    }
  }
  return out;
}

/**
 * The ring squares beside a doorway's inside squares, along its side, which
 * erosion keeps so the opening never stands beside rock where a door would.
 */
export function besideDoorway(board: Board, inside: readonly number[], side: Side): number[] {
  const [ax, ay] = side === "n" || side === "s" ? [1, 0] : [0, 1];
  const first = inside[0]!;
  const last = inside[inside.length - 1]!;
  const out: number[] = [];
  for (const [k, sign] of [[first, -1], [last, 1]] as const) {
    const x = (k % board.W) + ax * sign;
    const y = Math.floor(k / board.W) + ay * sign;
    if (board.inMap(x, y)) out.push(board.cell(x, y));
  }
  return out;
}

/**
 * Tunnels that bulge (5.1): about one corridor square in four gains a
 * square beside it on a side facing rock, where the router could have
 * opened that square (`open`: not the margin, a room, a square touching a
 * room, a run or beside one). `plain` says which corridor squares may
 * bulge: not a run, a doorway's outside square or the stub's stairs.
 */
export function bulgeTunnels(rng: Stream, board: Board, paths: readonly (readonly number[])[], plain: (k: number) => boolean, open: Uint8Array): number[] {
  const added = new Set<number>();
  const W = board.W;
  for (const path of paths) {
    for (const k of path) {
      if (!rng.chance(...BULGE_CHANCE) || !plain(k)) continue;
      const sides = SIDES.filter((side) => {
        const x = (k % W) + DX[side];
        const y = Math.floor(k / W) + DY[side];
        if (!board.inMap(x, y)) return false;
        const n = board.cell(x, y);
        return open[n] === 1 && board.laid[n] !== 1 && !added.has(n);
      });
      if (sides.length === 0) continue;
      const side = rng.pick(sides);
      added.add(board.cell((k % W) + DX[side], Math.floor(k / W) + DY[side]));
    }
  }
  return [...added];
}

/**
 * Rock columns in a cave room 7 by 7 or larger (5.1): 1 to 3 unpainted
 * squares at least two in from the walls, and a square from each other and
 * from every square `clearOf` names (the doorway lines, a dais and its clear
 * squares, the pin square), so each stands alone and the room stays one
 * piece. Walled automatically, as any unpainted square.
 */
export function placeColumns(rng: Stream, board: Board, room: number, clearOf: (k: number) => boolean, painted: (k: number) => boolean): number[] {
  const r = board.rooms[room]!;
  if (r.w < COLUMN_MIN_ROOM || r.h < COLUMN_MIN_ROOM) return [];
  const want = rng.int(1, COLUMNS_MOST);
  const near = (x: number, y: number, hit: (k: number) => boolean) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (hit(board.cell(x + dx, y + dy))) return true;
    return false;
  };
  const out: number[] = [];
  for (let n = 0; n < want; n++) {
    const spots: number[] = [];
    for (let y = r.y + 2; y <= r.y + r.h - 3; y++) {
      for (let x = r.x + 2; x <= r.x + r.w - 3; x++) {
        const k = board.cell(x, y);
        if (!painted(k) || near(x, y, (q) => clearOf(q) || out.includes(q))) continue;
        spots.push(k);
      }
    }
    if (spots.length === 0) break;
    out.push(rng.pick(spots));
  }
  return out;
}
