import { DX, DY, type Board, type Doorway, type Side } from "./layout.ts";
import type { Stream } from "./random.ts";
import type { CorridorStyle } from "./settings.ts";

/*
 * Corridors (docs/design/design-v1-dungeon-generator.md 5.3 step 6 and
 * 5.4): a cost search over squares, or over 2 by 2 blocks on Wide, under
 * one budget of expansions for the whole dungeon. Costs are doubled so none
 * is a half: rock 2, a square already laid 1, so corridors join. Integer
 * costs, a binary heap with ties broken by insertion order, and a fixed
 * order of moves, so every device finds the same corridors.
 *
 * A cheapest way is always a shortest one, so costs alone cannot make a
 * corridor wind: a search with any turn cost or per-square noise picked
 * among the shortest ways, and between doorways on one row that is the one
 * straight line whatever the style (D-261102-830). So a style sets the
 * waypoints a corridor passes through: Straight none, Bending one or two set
 * off to a side, Winding many, alternating sides. Each leg is its own
 * search, and a corridor that cannot pass its waypoints takes the direct way.
 * Where doorways go is the plan's part (plan.ts): Bending and Winding aim
 * them off the line between rooms, and Winding moves them round a room when
 * the rock between is too narrow to wind in.
 */

/** What a turn costs, in the doubled units: six squares of rock, so each leg keeps to the fewest turns and a corridor bends where its waypoints ask. */
export const TURN_COST = 12;
const ROCK = 2;
const LAID = 1;
/** Extra on a rock square beside another corridor, so a corridor joins one or keeps a square of rock from it, rarely running alongside as one wide patch. */
const BESIDE = 3;
/** A search first stays in its ends' box grown by this many squares, then takes the whole map. */
const BOX_GROWTH = 12;
/** How far a waypoint may move to the nearest open square or block. */
const SNAP_REACH = 2;

const DIRS: readonly Side[] = ["n", "e", "s", "w"];
const DIR_INDEX: Readonly<Record<Side, number>> = { n: 0, e: 1, s: 2, w: 3 };

export type Budget = { left: number };

/** A square or a block's top-left square, as x and y. */
export type XY = readonly [number, number];

export type RouteOptions = { wide: boolean; turn: number; budget: Budget };

/** Where a search ends: a doorway's anchor, or the scene edge on one side, reached heading out. */
export type Goal = { anchor: number[]; side: Side } | { edge: Side };

/** A found way: its squares, each once, and its search positions (a block's top-left on Wide) in order. */
export type RouteResult = { ok: true; cells: number[]; chain: number[] } | { ok: false; why: "none" | "budget" };

type Area = { x0: number; y0: number; x1: number; y1: number };
type Found = { ok: true; chain: number[]; dir: number } | { ok: false; why: "none" | "budget" };

/** Bending's waypoints: one from this length (two squares more on Wide), two from the next. */
const BEND_MIN = 6;
const BEND_TWO = 18;
/** How far a bend may stand off the line, at most, in squares (blocks on Wide). */
const BEND_REACH = 5;
/** Winding's waypoints: one per this many squares (one more on Wide), less one, so the last leaves room before the far end. */
const WIND_SPACING = 3;
const WIND_MAX = 12;
/** How far a winding waypoint stands off the line: 2 to this (one more each on Wide). */
const WIND_REACH = 3;

/**
 * The waypoints a style bends a corridor through, between its ends `a` and
 * `b` (block positions on Wide, where `size` is 2): points along the line
 * between them, each set off across it. Bending takes one, or two on a long
 * way, each to a side drawn at random, so it jogs aside and back. Winding
 * takes one every few squares, alternating sides, so it snakes. Points keep
 * a few squares apart and from the far end, since each leg turns at its
 * point and must not run beside the leg before it: a way too short for one
 * takes none.
 */
export function bends(rng: Stream, style: CorridorStyle, a: XY, b: XY, size = 1): XY[] {
  if (style === "straight") return [];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.abs(dx) + Math.abs(dy);
  const wider = size - 1;
  const count = style === "bending" ? (length < BEND_MIN + 2 * wider ? 0 : length < BEND_TWO ? 1 : 2) : Math.min(WIND_MAX, Math.floor(length / (WIND_SPACING + wider)) - 1);
  // Offsets go across the longer axis, so the jogs show along the way.
  const acrossY = Math.abs(dx) >= Math.abs(dy);
  const [least, most] = style === "bending" ? [2 * size, Math.max(2 * size, Math.min(BEND_REACH * size, Math.floor(length / 3)))] : [2 + wider, WIND_REACH + wider];
  let sign = rng.chance(1, 2) ? 1 : -1;
  const out: XY[] = [];
  for (let i = 1; i <= count; i++) {
    // The i-th of count points evenly along the line, rounded half up in whole numbers.
    const along = (d: number) => Math.floor((2 * d * i + count + 1) / (2 * (count + 1)));
    const reach = sign * rng.int(least, most);
    out.push(acrossY ? [a[0] + along(dx), a[1] + along(dy) + reach] : [a[0] + along(dx) + reach, a[1] + along(dy)]);
    sign = style === "winding" ? -sign : rng.chance(1, 2) ? 1 : -1;
  }
  return out;
}

/** A min-heap of search states by cost, then by insertion order. */
class Heap {
  #f = new Int32Array(1024);
  #seq = new Int32Array(1024);
  #state = new Int32Array(1024);
  #n = 0;
  #next = 0;

  get size(): number {
    return this.#n;
  }

  clear(): void {
    this.#n = 0;
    this.#next = 0;
  }

  #less(i: number, j: number): boolean {
    return this.#f[i]! < this.#f[j]! || (this.#f[i] === this.#f[j] && this.#seq[i]! < this.#seq[j]!);
  }

  #swap(i: number, j: number): void {
    for (const a of [this.#f, this.#seq, this.#state]) {
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
  }

  push(f: number, state: number): void {
    if (this.#n === this.#f.length) {
      const grow = (a: Int32Array) => {
        const b = new Int32Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.#f = grow(this.#f);
      this.#seq = grow(this.#seq);
      this.#state = grow(this.#state);
    }
    let i = this.#n++;
    this.#f[i] = f;
    this.#seq[i] = this.#next++;
    this.#state[i] = state;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.#state[0]!;
    this.#n--;
    if (this.#n > 0) {
      this.#f[0] = this.#f[this.#n]!;
      this.#seq[0] = this.#seq[this.#n]!;
      this.#state[0] = this.#state[this.#n]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.#n && this.#less(l, m)) m = l;
        if (r < this.#n && this.#less(r, m)) m = r;
        if (m === i) break;
        this.#swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/**
 * The search's working arrays, kept across one dungeon's searches. A stamp
 * per state says which search last wrote it, so nothing is cleared between.
 */
export class Router {
  readonly #board: Board;
  readonly #g: Int32Array;
  readonly #parent: Int32Array;
  readonly #stamp: Int32Array;
  readonly #done: Int32Array;
  readonly #beside: Uint8Array;
  readonly #heap = new Heap();
  #searches = 0;

  constructor(board: Board) {
    this.#board = board;
    const states = board.W * board.H * 4;
    this.#g = new Int32Array(states);
    this.#parent = new Int32Array(states);
    this.#stamp = new Int32Array(states);
    this.#done = new Int32Array(states);
    this.#beside = new Uint8Array(board.W * board.H);
  }

  /**
   * Which squares a corridor may use now (5.3 step 6): not the margin
   * (unless this is the entrance stub), no room, no square touching a room
   * but a flat room's doorways' outside squares, no reserved run square but
   * a far landing, and nothing beside a run.
   */
  openSquares(stub: boolean): Uint8Array {
    const b = this.#board;
    const open = new Uint8Array(b.W * b.H);
    const mouths = new Uint8Array(b.W * b.H);
    for (const d of b.doorways) if (!d.removed && !d.run) for (const k of d.outside) mouths[k] = 1;
    for (let y = 0; y < b.H; y++) {
      for (let x = 0; x < b.W; x++) {
        const k = y * b.W + x;
        if (!stub && !b.inside(x, y)) continue;
        if (b.roomAt[k] !== 0 || b.besideAt[k] !== 0) continue;
        if (b.runAt[k] !== 0 && b.farAt[k] === 0) continue;
        if (b.halo(k) && mouths[k] === 0) continue;
        open[k] = 1;
      }
    }
    return open;
  }

  /**
   * A corridor from a doorway's anchor, leaving outward, to a goal. On
   * Wide a position is the block's top-left square, and a block is open
   * only when its four squares are. Every expansion spends one from the
   * budget, and an empty budget fails the search.
   *
   * With `bend`, the corridor first tries the waypoints it gives for its
   * ends, one search per leg, each in its ends' box grown by 12 squares. A
   * leg never crosses or runs back over the legs before it. A waypoint on a
   * closed square moves to the nearest open one within 2, or is left out.
   * If a leg finds no way, the corridor takes the direct way: the ends' box
   * grown by 12 squares first, then the whole map.
   */
  route(from: Doorway, goal: Goal, options: RouteOptions, bend?: (a: XY, b: XY) => XY[]): RouteResult {
    const b = this.#board;
    const stub = "edge" in goal;
    const open = this.openSquares(stub);
    this.#markBeside();
    const size = options.wide ? 2 : 1;
    const start = blockOf(b, b.anchor(from), from.side, size);
    const dir = DIR_INDEX[from.side];
    const end: { at: number } | { edge: Side } = "anchor" in goal ? { at: blockOf(b, goal.anchor, goal.side, size) } : { edge: goal.edge };
    if (bend && "at" in end) {
      const points = this.#snap(open, bend(this.#xy(start), this.#xy(end.at)), start, end.at, size);
      if (points.length > 0) {
        const legs = this.#legs(open, start, dir, points, end.at, size, options);
        if (legs.ok || legs.why === "budget") return legs;
      }
    }
    const box = this.#box([start, "at" in end ? end.at : edgeProjection(b, start, end, size)], size);
    const whole = { x0: 0, y0: 0, x1: b.W - 1, y1: b.H - 1 };
    for (const area of [box, whole]) {
      const found = this.#search(open, start, dir, end, area, size, options);
      if (found.ok) return { ok: true, chain: found.chain, cells: this.#cells(found.chain, size) };
      if (found.why === "budget") return found;
      if (area.x0 === whole.x0 && area.y0 === whole.y0 && area.x1 === whole.x1 && area.y1 === whole.y1) return found;
    }
    return { ok: false, why: "none" };
  }

  /** Marks the rock squares beside a laid corridor square, for BESIDE. */
  #markBeside(): void {
    const b = this.#board;
    const near = this.#beside;
    near.fill(0);
    for (let k = 0; k < near.length; k++) {
      if (b.laid[k] !== 1) continue;
      const x = k % b.W;
      if (x > 0) near[k - 1] = 1;
      if (x < b.W - 1) near[k + 1] = 1;
      if (k >= b.W) near[k - b.W] = 1;
      if (k + b.W < near.length) near[k + b.W] = 1;
    }
  }

  #xy(k: number): XY {
    return [k % this.#board.W, Math.floor(k / this.#board.W)];
  }

  #box(ends: readonly number[], size: number): Area {
    const b = this.#board;
    const xs = ends.map((k) => k % b.W);
    const ys = ends.map((k) => Math.floor(k / b.W));
    return { x0: Math.max(0, Math.min(...xs) - BOX_GROWTH), y0: Math.max(0, Math.min(...ys) - BOX_GROWTH), x1: Math.min(b.W - 1, Math.max(...xs) + BOX_GROWTH + size - 1), y1: Math.min(b.H - 1, Math.max(...ys) + BOX_GROWTH + size - 1) };
  }

  #fits(open: Uint8Array, k: number, size: number): boolean {
    const W = this.#board.W;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) if (open[k + j * W + i] !== 1) return false;
    return true;
  }

  /**
   * Waypoints moved onto open positions: each to the nearest open one
   * within SNAP_REACH, in a fixed order, or left out. A waypoint next to an
   * end, or on the one before it, adds no bend and is left out too.
   */
  #snap(open: Uint8Array, points: readonly XY[], start: number, target: number, size: number): number[] {
    const b = this.#board;
    const out: number[] = [];
    const near = (k: number, o: number) => Math.abs((k % b.W) - (o % b.W)) + Math.abs(Math.floor(k / b.W) - Math.floor(o / b.W)) <= 1;
    for (const [px, py] of points) {
      let found = -1;
      for (let r = 0; r <= SNAP_REACH && found < 0; r++) {
        for (let dy = -r; dy <= r && found < 0; dy++) {
          for (const dx of r === Math.abs(dy) ? [r - Math.abs(dy)] : [-(r - Math.abs(dy)), r - Math.abs(dy)]) {
            const x = px + dx;
            const y = py + dy;
            if (x < 0 || y < 0 || x > b.W - size || y > b.H - size) continue;
            const k = y * b.W + x;
            if (this.#fits(open, k, size)) {
              found = k;
              break;
            }
          }
        }
      }
      if (found < 0 || near(found, start) || near(found, target) || (out.length > 0 && near(found, out.at(-1)!))) continue;
      out.push(found);
    }
    return out;
  }

  /**
   * A corridor through its waypoints, a search per leg. Each leg closes its
   * own squares and the squares beside them to the legs after it, but for
   * the block where the next one starts and the squares it turns out by, so
   * the corridor never crosses itself or runs alongside itself as a wide
   * patch. A waypoint no leg reaches is passed over. When the last leg finds
   * no way to the goal, the leg before it is taken back and the goal tried
   * from the waypoint before, down to the doorway itself.
   */
  #legs(open: Uint8Array, start: number, dir: number, points: readonly number[], target: number, size: number, options: RouteOptions): RouteResult {
    const W = this.#board.W;
    const stops: { at: number; dir: number; chain: number[]; free: Uint8Array }[] = [{ at: start, dir, chain: [start], free: open.slice() }];
    let i = 0;
    for (;;) {
      const from = stops.at(-1)!;
      const goal = i < points.length ? points[i]! : target;
      const found = this.#search(from.free, from.at, from.dir, { at: goal }, this.#box([from.at, goal], size), size, options);
      if (found.ok) {
        const chain = [...from.chain, ...found.chain.slice(1)];
        if (goal === target) return { ok: true, chain, cells: this.#cells(chain, size) };
        stops.push({ at: goal, dir: found.dir, chain, free: closeLeg(from.free, found.chain, size, W) });
        i++;
        continue;
      }
      if (found.why === "budget") return found;
      if (goal !== target) i++;
      else if (stops.length > 1) stops.pop();
      else return found;
    }
  }

  #search(open: Uint8Array, start: number, dir: number, end: { at: number } | { edge: Side }, area: Area, size: number, options: RouteOptions): Found {
    const b = this.#board;
    const W = b.W;
    const id = ++this.#searches;
    const heap = this.#heap;
    heap.clear();
    const fits = (k: number) => {
      const x = k % W;
      const y = (k - x) / W;
      if (x < area.x0 || y < area.y0 || x + size - 1 > area.x1 || y + size - 1 > area.y1) return false;
      return this.#fits(open, k, size);
    };
    if (!fits(start)) return { ok: false, why: "none" };
    const edge = "edge" in end ? end.edge : null;
    const target = "at" in end ? end.at : -1;
    const tx = target >= 0 ? target % W : 0;
    const ty = target >= 0 ? Math.floor(target / W) : 0;
    const minStep = LAID * size;
    const heuristic = (k: number) => {
      const x = k % W;
      const y = (k - x) / W;
      // Each step costs at least a laid square's, so the estimate never passes the true cost and the first way found is a cheapest.
      if (edge === null) return (Math.abs(x - tx) + Math.abs(y - ty)) * minStep;
      const away = edge === "w" ? x : edge === "n" ? y : edge === "e" ? W - size - x : b.H - size - y;
      return away * minStep;
    };
    const reached = (k: number, d: number) => {
      if (edge === null) return k === target;
      if (DIRS[d] !== edge) return false;
      const x = k % W;
      const y = (k - x) / W;
      return edge === "w" ? x === 0 : edge === "n" ? y === 0 : edge === "e" ? x === W - size : y === b.H - size;
    };
    const s0 = start * 4 + dir;
    this.#stamp[s0] = id;
    this.#g[s0] = 0;
    this.#parent[s0] = -1;
    heap.push(heuristic(start), s0);
    while (heap.size > 0) {
      const s = heap.pop();
      if (this.#done[s] === id) continue;
      if (options.budget.left <= 0) return { ok: false, why: "budget" };
      options.budget.left--;
      this.#done[s] = id;
      const k = s >> 2;
      const d = s & 3;
      if (reached(k, d)) {
        const chain: number[] = [];
        for (let t = s; t >= 0; t = this.#parent[t]!) chain.push(t >> 2);
        return { ok: true, chain: chain.reverse(), dir: d };
      }
      const g = this.#g[s]!;
      const x = k % W;
      const y = (k - x) / W;
      for (let nd = 0; nd < 4; nd++) {
        // Never back over its own squares.
        if (nd === (d + 2) % 4) continue;
        const side = DIRS[nd]!;
        const nx = x + DX[side];
        const ny = y + DY[side];
        if (nx < 0 || ny < 0 || nx > W - size || ny > b.H - size) continue;
        const nk = ny * W + nx;
        if (!fits(nk)) continue;
        const ns = nk * 4 + nd;
        if (this.#done[ns] === id) continue;
        let cost = nd === d ? 0 : options.turn;
        // The squares the block moves onto: its leading row.
        for (let j = 0; j < size; j++) {
          const c = leading(nk, side, j, size, W);
          cost += b.laid[c] === 1 ? LAID : ROCK + (this.#beside[c] === 1 ? BESIDE : 0);
        }
        const ng = g + cost;
        if (this.#stamp[ns] === id && this.#g[ns]! <= ng) continue;
        this.#stamp[ns] = id;
        this.#g[ns] = ng;
        this.#parent[ns] = s;
        heap.push(ng + heuristic(nk), ns);
      }
    }
    return { ok: false, why: "none" };
  }

  /** The squares of a way's positions, from its start, each once. */
  #cells(chain: readonly number[], size: number): number[] {
    const W = this.#board.W;
    const seen = new Set<number>();
    const out: number[] = [];
    for (const k of chain) {
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const c = k + j * W + i;
          if (!seen.has(c)) {
            seen.add(c);
            out.push(c);
          }
        }
      }
    }
    return out;
  }
}

/**
 * The open squares after a leg: its squares closed, and the squares beside
 * them, but for its last block where the next leg starts and the squares
 * beside the block before it, which the next leg turns out by.
 */
function closeLeg(open: Uint8Array, chain: readonly number[], size: number, W: number): Uint8Array {
  const free = open.slice();
  const last = chain.at(-1)!;
  const keep = new Set<number>();
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) keep.add(last + j * W + i);
  const close = (c: number) => {
    if (c >= 0 && c < free.length && !keep.has(c)) free[c] = 0;
  };
  chain.forEach((k, n) => {
    const beside = n <= chain.length - 1 - size;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const c = k + j * W + i;
        close(c);
        if (!beside) continue;
        const x = c % W;
        if (x > 0) close(c - 1);
        if (x < W - 1) close(c + 1);
        close(c - W);
        close(c + W);
      }
    }
  });
  return free;
}

/** The `j`-th square of a block's leading row when it moves toward `side`. */
function leading(k: number, side: Side, j: number, size: number, W: number): number {
  switch (side) {
    case "n":
      return k + j;
    case "s":
      return k + (size - 1) * W + j;
    case "w":
      return k + j * W;
    case "e":
      return k + j * W + size - 1;
  }
}

/**
 * The search position of a doorway's anchor: the square itself, or on Wide
 * the block of its two squares and the two just out from them.
 */
function blockOf(b: Board, anchor: readonly number[], side: Side, size: number): number {
  if (size === 1) return anchor[0]!;
  const cells = [...anchor, ...anchor.map((k) => k + DX[side] + DY[side] * b.W)];
  const xs = cells.map((k) => k % b.W);
  const ys = cells.map((k) => Math.floor(k / b.W));
  return Math.min(...ys) * b.W + Math.min(...xs);
}

/** Where a straight way from `start` meets the edge, for the search's box. */
function edgeProjection(b: Board, start: number, goal: { edge: Side }, size: number): number {
  const x = start % b.W;
  const y = Math.floor(start / b.W);
  switch (goal.edge) {
    case "w":
      return y * b.W;
    case "e":
      return y * b.W + b.W - size;
    case "n":
      return x;
    case "s":
      return (b.H - size) * b.W + x;
  }
}
