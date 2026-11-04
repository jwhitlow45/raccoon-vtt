import { Board, DX, DY, OPPOSITE, type Doorway, type Rect, type Run, type Side } from "./layout.ts";
import type { Stream } from "./random.ts";
import { raisedCount } from "./settings.ts";

/*
 * Raised and sunk rooms with their stair runs, and daises
 * (docs/design/design-v1-dungeon-generator.md 5.3 steps 5 and 9). On
 * squares a stair links only the two edges along the way it faces
 * (shared/rules/walls.ts stairs), and every other edge between two grounds
 * is a ledge. So each run is straight, reserved before any corridor, and
 * closed with the squares beside it, so no corridor square ever meets a
 * stair's side (D-261102-382).
 */

/** The grounds a raised or sunk room may take, in feet. */
export const RAISES: readonly number[] = [5, 10, -5, -10];
/** A dais stands this far above its room's floor. */
export const DAIS_RISE = 5;
const DAIS_MIN_ROOM = 6;
const DAIS_CHANCE = [1, 3] as const;
const DAIS_TRIES = 12;

/** The middle of a row of squares, in doubled coordinates so it stays whole. */
export function middle2(board: Board, cells: readonly number[]): [number, number] {
  const xs = cells.map((k) => k % board.W);
  const ys = cells.map((k) => Math.floor(k / board.W));
  return [Math.min(...xs) + Math.max(...xs) + 1, Math.min(...ys) + Math.max(...ys) + 1];
}

/** The unit step across a doorway's lanes, along its side. */
const across = (side: Side): [number, number] => (side === "n" || side === "s" ? [1, 0] : [0, 1]);

/**
 * A doorway's run for a room at `ground` (5.3 step 5): a near landing (the
 * doorway's outside squares) at the room's ground, then |ground| / 5 stairs,
 * the i-th at ground x (n - i) / n so the last is at 0 ft, then a far
 * landing at 0 ft, all straight out along the doorway's axis and as wide as
 * it. Every stair faces along that axis, toward the room when the room is
 * raised and away from it when it is sunk, so each points up the run.
 */
export function runFor(board: Board, d: Doorway, ground: number): Run {
  const n = Math.abs(ground) / 5;
  const [ax, ay] = across(d.side);
  const step = (k: number, t: number) => {
    const x = (k % board.W) + DX[d.side] * t;
    const y = Math.floor(k / board.W) + DY[d.side] * t;
    return board.cell(x, y);
  };
  const up: Side = ground > 0 ? OPPOSITE[d.side] : d.side;
  const near = [...d.outside];
  const stairs: Run["stairs"] = [];
  for (let i = 1; i <= n; i++) {
    // A sunk run's last stair works out to -0, which JSON and the ops would read as 0 but a strict compare would not.
    const ft = (ground * (n - i)) / n || 0;
    for (const k of d.outside) stairs.push({ cell: step(k, i), ground: ft, up });
  }
  const far = d.outside.map((k) => step(k, n + 1));
  const beside: number[] = [];
  const first = d.outside[0]!;
  const last = d.outside[d.outside.length - 1]!;
  for (let t = 0; t <= n; t++) {
    for (const [k, sign] of [[first, -1], [last, 1]] as const) {
      const x = (k % board.W) + DX[d.side] * t + ax * sign;
      const y = Math.floor(k / board.W) + DY[d.side] * t + ay * sign;
      if (board.inMap(x, y)) beside.push(board.cell(x, y));
    }
  }
  return { ground, near, stairs, far, beside };
}

/**
 * Where corridors leave each doorway: its outside squares and the squares
 * just out from them. A run must keep off every other doorway's, or that
 * doorway's corridor could never leave it.
 */
export function mouthCounts(board: Board): Uint8Array {
  const counts = new Uint8Array(board.W * board.H);
  for (const d of board.doorways) if (!d.removed) for (const k of mouthOf(board, d)) counts[k]!++;
  return counts;
}

function mouthOf(board: Board, d: Doorway): number[] {
  const out: number[] = [];
  for (const k of d.outside) {
    for (let t = 0; t <= d.width; t++) {
      const x = (k % board.W) + DX[d.side] * t;
      const y = Math.floor(k / board.W) + DY[d.side] * t;
      if (board.inMap(x, y)) out.push(board.cell(x, y));
    }
  }
  return out;
}

/**
 * Whether a run fits (5.3 step 5). The near landing may touch its own room
 * and nothing else. Every other square of the run stays inside the margin,
 * off rooms and the squares touching them, and off every other run and the
 * squares beside one. The squares beside it hold no other run's square, and
 * none of it lies where another doorway's corridor must leave.
 */
export function runFits(board: Board, d: Doorway, run: Run, mouths: Uint8Array): boolean {
  const own = new Set(mouthOf(board, d));
  const others = (k: number) => mouths[k]! - (own.has(k) ? 1 : 0) > 0;
  for (const k of run.near) if (board.runAt[k] !== 0 || board.besideAt[k] !== 0) return false;
  for (const k of [...run.stairs.map((s) => s.cell), ...run.far]) {
    const x = k % board.W;
    const y = (k - x) / board.W;
    if (!board.inside(x, y) || board.roomAt[k] !== 0 || board.halo(k) || board.runAt[k] !== 0 || board.besideAt[k] !== 0 || others(k)) return false;
  }
  for (const k of run.beside) if (board.runAt[k] !== 0 || others(k)) return false;
  return true;
}

/**
 * Raises or sinks `raisedCount(share, rooms)` of the rooms but the entrance
 * (D-261102-832). Rooms are tried in an order drawn at random, each at its
 * grounds in an order drawn too, and a room takes the first ground whose
 * runs fit every one of its doorways, else stays flat. Every draw is made
 * before any fit is tried, so neither the share nor what fits moves the
 * stream the rest of the dungeon draws from. A share the map has no room
 * for raises fewer.
 */
export function raiseRooms(rng: Stream, board: Board, entrance: number, share: number): void {
  // Drawn even for Flat, so moving Heights never moves the doors and dressing drawn after.
  const order = rng.shuffle(board.rooms.flatMap((r, i) => (i === entrance || r.dropped ? [] : [i])));
  const grounds = order.map(() => rng.shuffle([...RAISES]));
  const want = raisedCount(share, board.rooms.length);
  if (want === 0) return;
  const mouths = mouthCounts(board);
  let raised = 0;
  order.forEach((i, n) => {
    if (raised === want) return;
    const doors = board.doorways.filter((d) => d.room === i && !d.removed);
    if (doors.length === 0) return;
    for (const ground of grounds[n]!) {
      if (!reserveAll(board, doors, ground, mouths)) continue;
      board.rooms[i]!.ground = ground;
      raised++;
      return;
    }
  });
}

/** Reserves a run for each doorway at `ground`, or none of them when one does not fit. */
function reserveAll(board: Board, doors: readonly Doorway[], ground: number, mouths: Uint8Array): boolean {
  const reserved: Doorway[] = [];
  for (const d of doors) {
    const run = runFor(board, d, ground);
    if (!runFits(board, d, run, mouths)) {
      for (const r of reserved) {
        board.unreserve(r.run!);
        r.run = null;
      }
      return false;
    }
    board.reserve(d, run);
    reserved.push(d);
  }
  return true;
}

// ------------------------------------------------------------ daises

export type Dais = {
  rect: Rect;
  /** The floor square before the dais's side facing the nearest doorway, holding its stair. */
  stair: number;
  up: Side;
  /** The floor square before the stair. */
  before: number;
  /** The dais square at the stair's top. */
  top: number;
};

/**
 * A dais for a room 6 by 6 or larger (5.3 step 9): 2 by 2 to 4 by 3, 5 ft
 * above the floor, a square in from the walls and off the doorway lines,
 * with a stair on the floor square before its side facing the nearest
 * doorway, pointing up onto it. The stair and the square before it stay
 * inside the room. `blocked` marks squares a dais may not cover.
 */
export function placeDais(rng: Stream, board: Board, room: number, blocked: (k: number) => boolean): Dais | null {
  const r = board.rooms[room]!;
  if (r.w < DAIS_MIN_ROOM || r.h < DAIS_MIN_ROOM) return null;
  if (!rng.chance(...DAIS_CHANCE)) return null;
  const doors = board.doorways.filter((d) => d.room === room && !d.removed);
  if (doors.length === 0) return null;
  for (let t = 0; t < DAIS_TRIES; t++) {
    const long = rng.int(2, 4);
    const short = rng.int(2, 3);
    const [w, h] = rng.chance(1, 2) ? [long, short] : [short, long];
    if (w > r.w - 2 || h > r.h - 2) continue;
    const x = rng.int(r.x + 1, r.x + r.w - 1 - w);
    const y = rng.int(r.y + 1, r.y + r.h - 1 - h);
    const rect = { x, y, w, h };
    const mx2 = 2 * x + w;
    const my2 = 2 * y + h;
    // The nearest doorway by its inside squares' middle, ties by doorway order.
    let near = doors[0]!;
    let nearD = Infinity;
    for (const d of doors) {
      const [dx2, dy2] = middle2(board, d.inside);
      const dist = Math.abs(dx2 - mx2) + Math.abs(dy2 - my2);
      if (dist < nearD) {
        near = d;
        nearD = dist;
      }
    }
    const [ndx2, ndy2] = middle2(board, near.inside);
    const ndx = ndx2 - mx2;
    const ndy = ndy2 - my2;
    const face: Side = Math.abs(ndx) >= Math.abs(ndy) ? (ndx > 0 ? "e" : "w") : ndy > 0 ? "s" : "n";
    // The stair sits before the middle of the facing side.
    const [sx, sy] =
      face === "n" ? [x + Math.floor((w - 1) / 2), y - 1] : face === "s" ? [x + Math.floor((w - 1) / 2), y + h] : face === "w" ? [x - 1, y + Math.floor((h - 1) / 2)] : [x + w, y + Math.floor((h - 1) / 2)];
    const bx = sx + DX[face];
    const by = sy + DY[face];
    if (bx < r.x || by < r.y || bx >= r.x + r.w || by >= r.y + r.h) continue;
    let clear = true;
    for (let yy = y; yy < y + h && clear; yy++) for (let xx = x; xx < x + w; xx++) if (blocked(board.cell(xx, yy))) clear = false;
    if (!clear) continue;
    return { rect, stair: board.cell(sx, sy), up: OPPOSITE[face], before: board.cell(bx, by), top: board.cell(sx - DX[face], sy - DY[face]) };
  }
  return null;
}
