import { DX, DY, type Board, type Doorway, type Side } from "./layout.ts";
import type { CorridorStyle } from "./settings.ts";

/*
 * Corridors (docs/design/design-v1-dungeon-generator.md 5.3 step 6 and
 * 5.4): a cost search over squares, or over 2 by 2 blocks on Wide, under
 * one budget of expansions for the whole dungeon. Costs are doubled so none
 * is a half: rock 2, a square already laid 1, so corridors join. Integer
 * costs, a binary heap with ties broken by insertion order, and a fixed
 * order of moves, so every device finds the same corridors.
 */

/** What a turn costs by corridor style, in the doubled units. */
export const TURN_COST: Readonly<Record<CorridorStyle, number>> = { straight: 12, bending: 2, winding: 1 };
/**
 * A seeded extra on each rock square, 0 to this, by style. Without it a
 * search takes the fewest turns whatever a turn costs, so Bending drew the
 * very corridors Straight did (D-261102-410).
 */
export const ROCK_NOISE: Readonly<Record<CorridorStyle, number>> = { straight: 0, bending: 4, winding: 6 };
const ROCK = 2;
const LAID = 1;
/** A search first stays in its ends' box grown by this many squares, then takes the whole map. */
const BOX_GROWTH = 12;

const DIRS: readonly Side[] = ["n", "e", "s", "w"];
const DIR_INDEX: Readonly<Record<Side, number>> = { n: 0, e: 1, s: 2, w: 3 };

export type Budget = { left: number };

export type RouteOptions = { wide: boolean; turn: number; noise: Uint8Array | null; budget: Budget };

/** Where a search ends: a doorway's anchor, or the scene edge on one side, reached heading out. */
export type Goal = { anchor: number[]; side: Side } | { edge: Side };

export type RouteResult = { ok: true; cells: number[] } | { ok: false; why: "none" | "budget" };

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
  readonly #heap = new Heap();
  #searches = 0;

  constructor(board: Board) {
    this.#board = board;
    const states = board.W * board.H * 4;
    this.#g = new Int32Array(states);
    this.#parent = new Int32Array(states);
    this.#stamp = new Int32Array(states);
    this.#done = new Int32Array(states);
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
   * only when its four squares are. The first try stays in the ends' box
   * grown by 12 squares, then the whole map. Every expansion spends one
   * from the budget, and an empty budget fails the search.
   */
  route(from: Doorway, goal: Goal, options: RouteOptions): RouteResult {
    const b = this.#board;
    const stub = "edge" in goal;
    const open = this.openSquares(stub);
    const size = options.wide ? 2 : 1;
    const start = blockOf(b, b.anchor(from), from.side, size);
    const target = "anchor" in goal ? blockOf(b, goal.anchor, goal.side, size) : -1;
    const ends = [start, target >= 0 ? target : edgeProjection(b, start, goal as { edge: Side }, size)];
    const xs = ends.map((k) => k % b.W);
    const ys = ends.map((k) => Math.floor(k / b.W));
    const box = { x0: Math.max(0, Math.min(...xs) - BOX_GROWTH), y0: Math.max(0, Math.min(...ys) - BOX_GROWTH), x1: Math.min(b.W - 1, Math.max(...xs) + BOX_GROWTH + size - 1), y1: Math.min(b.H - 1, Math.max(...ys) + BOX_GROWTH + size - 1) };
    const whole = { x0: 0, y0: 0, x1: b.W - 1, y1: b.H - 1 };
    for (const area of [box, whole]) {
      const found = this.#search(open, start, from.side, goal, target, area, size, options);
      if (found.ok || found.why === "budget") return found;
      if (area.x0 === whole.x0 && area.y0 === whole.y0 && area.x1 === whole.x1 && area.y1 === whole.y1) return found;
    }
    return { ok: false, why: "none" };
  }

  #search(open: Uint8Array, start: number, dir: Side, goal: Goal, target: number, area: { x0: number; y0: number; x1: number; y1: number }, size: number, options: RouteOptions): RouteResult {
    const b = this.#board;
    const W = b.W;
    const id = ++this.#searches;
    const heap = this.#heap;
    heap.clear();
    const fits = (k: number) => {
      const x = k % W;
      const y = (k - x) / W;
      if (x < area.x0 || y < area.y0 || x + size - 1 > area.x1 || y + size - 1 > area.y1) return false;
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) if (open[k + j * W + i] !== 1) return false;
      return true;
    };
    if (!fits(start)) return { ok: false, why: "none" };
    const edge = "edge" in goal ? goal.edge : null;
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
    const s0 = start * 4 + DIR_INDEX[dir];
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
      if (reached(k, d)) return { ok: true, cells: this.#cells(s, size) };
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
          cost += b.laid[c] === 1 ? LAID : ROCK + (options.noise ? options.noise[c]! : 0);
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

  /** The squares of a found way, from its start, each once. */
  #cells(end: number, size: number): number[] {
    const W = this.#board.W;
    const chain: number[] = [];
    for (let s = end; s >= 0; s = this.#parent[s]!) chain.push(s >> 2);
    chain.reverse();
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
