import type { Board, Doorway, Link, Side } from "./layout.ts";
import type { KeyDoor, KeyRoom } from "./plan.ts";
import type { Stream } from "./random.ts";

/*
 * The DM key's rooms (phase 2, 5.6): each room's pin square, its number,
 * and what the key's line for it says. Pin squares are chosen whatever DM
 * key says, before lights and dressing, so the switch never moves a prop
 * (D-261107-268).
 */

/**
 * A room's pin square: its floor square nearest its middle, ties by reading
 * order. `floor` says which squares are free floor: painted, and not water,
 * a pit, a pillar or a dais. A room always has its doorway lines, which
 * reach its middle dry, so one is found. The middle itself when none is.
 */
export function pinSquare(board: Board, room: number, floor: (k: number) => boolean): number {
  const r = board.rooms[room]!;
  const mx = 2 * r.x + r.w;
  const my = 2 * r.y + r.h;
  let best = -1;
  let bestD = Infinity;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const k = board.cell(x, y);
      if (!floor(k)) continue;
      const dx = 2 * x + 1 - mx;
      const dy = 2 * y + 1 - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        best = k;
        bestD = d;
      }
    }
  }
  return best >= 0 ? best : board.cell(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2));
}

/** The SRD's Trinkets table is a d100 table: its lines are indexed 0 to 99 (shared/srd/trinkets.ts `TRINKETS`). */
export const TRINKET_LINES = 100;

/**
 * The rooms' numbers (5.6): breadth first over the tree from the entrance,
 * which is 1, each room's children in the order Prim's tree joined them.
 * Only kept rooms, whose tree links all stand.
 */
export function numberRooms(links: readonly Link[], kept: readonly number[], entrance: number): Map<number, number> {
  const keptSet = new Set(kept);
  const out = new Map<number, number>();
  if (!keptSet.has(entrance)) return out;
  const queue = [entrance];
  out.set(entrance, 1);
  for (let i = 0; i < queue.length; i++) {
    const room = queue[i]!;
    for (const l of links) {
      if (l.kind !== "tree" || l.a !== room || !keptSet.has(l.b) || out.has(l.b)) continue;
      out.set(l.b, out.size + 1);
      queue.push(l.b);
    }
  }
  return out;
}

export type KeyInputs = {
  kept: readonly number[];
  links: readonly Link[];
  entrance: number;
  /** Each kept doorway with its door: closed, locked, secret, or open on a cave. */
  doors: readonly { doorway: Doorway; state: KeyDoor["state"] }[];
  /** Each room's trap names, its light's label, and what stands in it. */
  traps: (room: number) => string[];
  light: (room: number) => string | undefined;
  secret: (room: number) => boolean;
  dais: (room: number) => boolean;
  pit: (room: number) => boolean;
  cistern: (room: number) => boolean;
};

const SIDE_ORDER: Readonly<Record<Side, number>> = { n: 0, e: 1, s: 2, w: 3 };

/**
 * The key's rooms in number order (5.6), each with its doorways (by side,
 * then along it), its light, its traps, what stands in it, and a trinket
 * drawn without repeats from the key's own lane. No seed is ever in it.
 * `room` is each room's index in the plan's rooms, the kept rooms in board
 * order.
 */
export function keyRooms(rng: Stream, input: KeyInputs): KeyRoom[] {
  const numbers = numberRooms(input.links, input.kept, input.entrance);
  const order = [...numbers.entries()].sort((a, b) => a[1] - b[1]).map(([room]) => room);
  const trinkets = rng.shuffle(Array.from({ length: TRINKET_LINES }, (_, i) => i));
  return order.map((i, n): KeyRoom => {
    const doors = input.doors
      .filter((d) => d.doorway.room === i)
      .sort((a, b) => SIDE_ORDER[a.doorway.side] - SIDE_ORDER[b.doorway.side] || a.doorway.at - b.doorway.at)
      .map(({ doorway, state }): KeyDoor => {
        const link = doorway.link >= 0 ? input.links[doorway.link]! : null;
        const other = link ? (link.a === i ? link.b : link.a) : -1;
        return { side: doorway.side, to: other >= 0 ? (numbers.get(other) ?? "edge") : "edge", state };
      });
    const room: KeyRoom = { n: numbers.get(i)!, room: input.kept.indexOf(i), doors, traps: input.traps(i), trinket: trinkets[n % TRINKET_LINES]! };
    const light = input.light(i);
    if (light !== undefined) room.light = light;
    if (input.secret(i)) room.secret = true;
    if (input.dais(i)) room.dais = true;
    if (input.pit(i)) room.pit = true;
    if (input.cistern(i)) room.cistern = true;
    return room;
  });
}
