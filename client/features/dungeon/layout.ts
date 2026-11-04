import type { Stream } from "./random.ts";
import type { Density, DungeonSettings } from "./settings.ts";

/*
 * Rooms, the entrance, the links between rooms and their doorways
 * (docs/design/design-v1-dungeon-generator.md 5.3 steps 1 to 4), and the
 * board every later step reads and marks. Cells are indices, y * w + x.
 */

/** Squares round the map's edge that no room or corridor enters. Only the entrance stub crosses them. */
export const MARGIN = 2;

export type Side = "n" | "e" | "s" | "w";
/** The entrance's tie order: west, north, east, south. */
export const SIDE_ORDER: readonly Side[] = ["w", "n", "e", "s"];
export const DX: Readonly<Record<Side, number>> = { n: 0, e: 1, s: 0, w: -1 };
export const DY: Readonly<Record<Side, number>> = { n: -1, e: 0, s: 1, w: 0 };
export const OPPOSITE: Readonly<Record<Side, Side>> = { n: "s", e: "w", s: "n", w: "e" };

export type Rect = { x: number; y: number; w: number; h: number };

const SIDE_RANGE: Readonly<Record<Density, readonly [number, number]>> = { sparse: [3, 6], normal: [4, 9], dense: [5, 12] };
/** Wide doorways are 2 squares and never at a corner, so a Wide room's side is at least 4. */
const WIDE_MIN_SIDE = 4;
/** Rock between two rooms, so a corridor with rock on both sides fits between any two. */
const GAP: Readonly<Record<"narrow" | "wide", Readonly<Record<Density, number>>>> = {
  narrow: { sparse: 6, normal: 4, dense: 3 },
  wide: { sparse: 7, normal: 5, dense: 4 },
};
const ROOM_TRIES = 60;

export function roomGap(density: Density, wide: boolean): number {
  return GAP[wide ? "wide" : "narrow"][density];
}

export function sideRange(density: Density, wide: boolean): readonly [number, number] {
  const [lo, hi] = SIDE_RANGE[density];
  return [wide ? Math.max(lo, WIDE_MIN_SIDE) : lo, hi];
}

/** Sums of `occupied` over [0, x) by [0, y), so any rectangle's count is four reads. */
function prefixSums(occupied: Uint8Array, w: number, h: number): Int32Array {
  const sums = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += occupied[y * w + x]!;
      sums[(y + 1) * (w + 1) + x + 1] = sums[y * (w + 1) + x + 1]! + row;
    }
  }
  return sums;
}

/** Whole layouts tried before taking the one that fit the most rooms. */
const LAYOUT_TRIES = 12;

/**
 * Up to `rooms` rectangles inside the margin, each `gap` squares of rock
 * from every other. Random spots jam well before a map is full, so a layout
 * that leaves rooms out is tried again from the start, up to 12 times, and
 * the first that fits them all wins, else the first that fit the most.
 */
export function placeRooms(rng: Stream, s: Pick<DungeonSettings, "w" | "h" | "rooms" | "density" | "wide">): Rect[] {
  let best: Rect[] = [];
  for (let t = 0; t < LAYOUT_TRIES && best.length < s.rooms; t++) {
    const rooms = layoutOnce(rng, s);
    if (rooms.length > best.length) best = rooms;
  }
  return best;
}

/**
 * One layout. Each room takes up to 60 tries: a size drawn from the
 * density's range, then a spot drawn from every spot that size fits, so a
 * crowded map still finds the gaps a blind try would miss. A size that
 * fits nowhere rules out every size at least as large for that room.
 */
function layoutOnce(rng: Stream, s: Pick<DungeonSettings, "w" | "h" | "rooms" | "density" | "wide">): Rect[] {
  const { w: W, h: H } = s;
  const [lo, hi] = sideRange(s.density, s.wide);
  const gap = roomGap(s.density, s.wide);
  const occupied = new Uint8Array(W * H);
  const spots = new Int32Array(W * H);
  const rooms: Rect[] = [];
  for (let r = 0; r < s.rooms; r++) {
    const sums = prefixSums(occupied, W, H);
    const count = (x0: number, y0: number, x1: number, y1: number) => {
      const a = Math.max(0, x0), b = Math.max(0, y0), c = Math.min(W, x1), d = Math.min(H, y1);
      return sums[d * (W + 1) + c]! - sums[b * (W + 1) + c]! - sums[d * (W + 1) + a]! + sums[b * (W + 1) + a]!;
    };
    const tooBig: [number, number][] = [];
    let placed = false;
    for (let t = 0; t < ROOM_TRIES && !placed; t++) {
      const w = rng.int(lo, hi);
      const h = rng.int(lo, hi);
      if (tooBig.some(([bw, bh]) => w >= bw && h >= bh)) continue;
      let n = 0;
      for (let y = MARGIN; y + h <= H - MARGIN; y++) {
        for (let x = MARGIN; x + w <= W - MARGIN; x++) if (count(x - gap, y - gap, x + w + gap, y + h + gap) === 0) spots[n++] = y * W + x;
      }
      if (n === 0) {
        tooBig.push([w, h]);
        continue;
      }
      const at = spots[rng.below(n)]!;
      const room = { x: at % W, y: Math.floor(at / W), w, h };
      rooms.push(room);
      for (let y = room.y; y < room.y + h; y++) occupied.fill(1, y * W + room.x, y * W + room.x + w);
      placed = true;
    }
    // A room that fit nowhere in 60 tries leaves no room for those after it either.
    if (!placed) break;
  }
  return rooms;
}

/** A room's distance to a side of the map, in squares of rock. */
export function edgeDistance(r: Rect, side: Side, W: number, H: number): number {
  switch (side) {
    case "w":
      return r.x;
    case "n":
      return r.y;
    case "e":
      return W - (r.x + r.w);
    case "s":
      return H - (r.y + r.h);
  }
}

/** The room nearest a scene edge, and that edge. Ties go west, north, east, south, then by room order. */
export function chooseEntrance(rooms: readonly Rect[], W: number, H: number): { room: number; side: Side } {
  let best = { room: 0, side: "w" as Side, d: Infinity };
  for (const side of SIDE_ORDER) {
    rooms.forEach((r, i) => {
      const d = edgeDistance(r, side, W, H);
      if (d < best.d) best = { room: i, side, d };
    });
  }
  return { room: best.room, side: best.side };
}

/** Grid distance between two rooms' middles, doubled so a middle on a half square stays whole. */
export function middleDistance(a: Rect, b: Rect): number {
  return Math.abs(2 * a.x + a.w - (2 * b.x + b.w)) + Math.abs(2 * a.y + a.h - (2 * b.y + b.h));
}

export type Link = { a: number; b: number; kind: "tree" | "loop" };

/**
 * Prim's tree from the entrance over the rooms' middles. Each tree link's
 * `a` is the room already joined, `b` the room it joins, in the order
 * they join, so a room's whole branch comes after its own link.
 */
export function treeLinks(rooms: readonly Rect[], entrance: number): Link[] {
  const n = rooms.length;
  const joined = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(-1);
  const links: Link[] = [];
  let next = entrance;
  for (let step = 0; step < n; step++) {
    joined[next] = true;
    if (from[next]! >= 0) links.push({ a: from[next]!, b: next, kind: "tree" });
    for (let i = 0; i < n; i++) {
      if (joined[i]) continue;
      const d = middleDistance(rooms[next]!, rooms[i]!);
      if (d < best[i]!) {
        best[i] = d;
        from[i] = next;
      }
    }
    next = -1;
    for (let i = 0; i < n; i++) if (!joined[i] && (next < 0 || best[i]! < best[next]!)) next = i;
    if (next < 0) break;
  }
  return links;
}

/**
 * Extra ways around: up to `count` of the shortest links not in the tree
 * whose way round the tree is at least twice as long, so each one saves a
 * real walk back. `fits` says whether one more still fits the door cap.
 */
export function loopLinks(rooms: readonly Rect[], tree: readonly Link[], count: number, fits: (taken: number) => boolean): Link[] {
  const n = rooms.length;
  const adjacent: { to: number; d: number }[][] = Array.from({ length: n }, () => []);
  for (const l of tree) {
    const d = middleDistance(rooms[l.a]!, rooms[l.b]!);
    adjacent[l.a]!.push({ to: l.b, d });
    adjacent[l.b]!.push({ to: l.a, d });
  }
  const treeDistance = (from: number): number[] => {
    const dist = new Array<number>(n).fill(-1);
    dist[from] = 0;
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop()!;
      for (const { to, d } of adjacent[at]!) {
        if (dist[to]! >= 0) continue;
        dist[to] = dist[at]! + d;
        stack.push(to);
      }
    }
    return dist;
  };
  const candidates: { a: number; b: number; d: number }[] = [];
  for (let a = 0; a < n; a++) {
    const round = treeDistance(a);
    for (let b = a + 1; b < n; b++) {
      if (adjacent[a]!.some((e) => e.to === b)) continue;
      const d = middleDistance(rooms[a]!, rooms[b]!);
      if (round[b]! >= 2 * d) candidates.push({ a, b, d });
    }
  }
  candidates.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
  const out: Link[] = [];
  for (const c of candidates) {
    if (out.length >= count || !fits(out.length + 1)) break;
    out.push({ a: c.a, b: c.b, kind: "loop" });
  }
  return out;
}

// ------------------------------------------------------------ the board

export type Room = Rect & { ground: number; dropped: boolean };

/** A stair run reserved outward from a raised or sunk room's doorway (heights.ts). */
export type Run = {
  ground: number;
  /** The doorway's outside squares, at the room's ground. */
  near: number[];
  /** Each stair's cell, ground and the way it points up. */
  stairs: { cell: number; ground: number; up: Side }[];
  /** Where the run meets 0 ft and its corridor starts. */
  far: number[];
  /** Squares beside the near landing and the stairs, closed to every corridor. */
  beside: number[];
};

export type Doorway = {
  id: number;
  room: number;
  side: Side;
  /** Squares along the side from the room's corner, the first of `width`. */
  at: number;
  width: 1 | 2;
  inside: number[];
  outside: number[];
  /** Index of its link, or -1 for the entrance stub. */
  link: number;
  run: Run | null;
  /** A run flattened by the retry (5.4): its squares, now flat corridor from the door to the old far landing. */
  flat: number[] | null;
  /** Gone with its door and run: its corridor was never built, or its room was dropped. */
  removed: boolean;
};

/**
 * What every step reads and marks: the rooms, their doorways, the reserved
 * runs and the corridors laid so far.
 */
export class Board {
  readonly W: number;
  readonly H: number;
  readonly rooms: Room[];
  readonly doorways: Doorway[] = [];
  /** Room index + 1 on each room square. */
  readonly roomAt: Int16Array;
  /** Doorway id + 1 on each reserved run square: near landing, stairs and far landing. */
  readonly runAt: Int16Array;
  readonly farAt: Uint8Array;
  /** How many runs each square is beside. */
  readonly besideAt: Uint8Array;
  readonly laid: Uint8Array;

  constructor(W: number, H: number, rects: readonly Rect[]) {
    this.W = W;
    this.H = H;
    this.rooms = rects.map((r) => ({ ...r, ground: 0, dropped: false }));
    this.roomAt = new Int16Array(W * H);
    this.runAt = new Int16Array(W * H);
    this.farAt = new Uint8Array(W * H);
    this.besideAt = new Uint8Array(W * H);
    this.laid = new Uint8Array(W * H);
    this.rooms.forEach((r, i) => this.#fillRoom(r, i + 1));
  }

  #fillRoom(r: Rect, v: number): void {
    for (let y = r.y; y < r.y + r.h; y++) this.roomAt.fill(v, y * this.W + r.x, y * this.W + r.x + r.w);
  }

  cell(x: number, y: number): number {
    return y * this.W + x;
  }

  inMap(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }

  inside(x: number, y: number): boolean {
    return x >= MARGIN && y >= MARGIN && x < this.W - MARGIN && y < this.H - MARGIN;
  }

  /** Whether a square touches a room by an edge, without being one. */
  halo(k: number): boolean {
    if (this.roomAt[k] !== 0) return false;
    const x = k % this.W;
    const y = (k - x) / this.W;
    return (x > 0 && this.roomAt[k - 1] !== 0) || (x < this.W - 1 && this.roomAt[k + 1] !== 0) || (y > 0 && this.roomAt[k - this.W] !== 0) || (y < this.H - 1 && this.roomAt[k + this.W] !== 0);
  }

  /** Drops a room: its squares go back to rock and every doorway on it goes. */
  drop(room: number): void {
    const r = this.rooms[room]!;
    if (r.dropped) return;
    r.dropped = true;
    this.#fillRoom(r, 0);
    for (const d of this.doorways) if (d.room === room) this.removeDoorway(d);
  }

  removeDoorway(d: Doorway): void {
    if (d.removed) return;
    d.removed = true;
    if (d.run) this.unreserve(d.run);
  }

  reserve(d: Doorway, run: Run): void {
    d.run = run;
    for (const k of [...run.near, ...run.stairs.map((s) => s.cell), ...run.far]) this.runAt[k] = d.id + 1;
    for (const k of run.far) this.farAt[k] = 1;
    for (const k of run.beside) this.besideAt[k]!++;
  }

  unreserve(run: Run): void {
    for (const k of [...run.near, ...run.stairs.map((s) => s.cell), ...run.far]) this.runAt[k] = 0;
    for (const k of run.far) this.farAt[k] = 0;
    for (const k of run.beside) this.besideAt[k]!--;
  }

  /**
   * Makes a raised or sunk room flat (5.4): each run's squares become flat
   * corridor from the door to its far landing, so a corridor already routed
   * there still reaches the door, and the squares beside open.
   */
  flatten(room: number): void {
    const r = this.rooms[room]!;
    if (r.ground === 0) return;
    r.ground = 0;
    for (const d of this.doorways) {
      if (d.room !== room || d.removed || !d.run) continue;
      const run = d.run;
      this.unreserve(run);
      d.run = null;
      d.flat = [...run.near, ...run.stairs.map((s) => s.cell), ...run.far];
      for (const k of d.flat) this.laid[k] = 1;
    }
  }

  /** The squares a doorway's corridor starts from: its far landing when it has a run or a flattened one, else its outside squares. */
  anchor(d: Doorway): number[] {
    if (d.run) return d.run.far;
    if (d.flat) return d.flat.slice(-d.width);
    return d.outside;
  }
}

// ------------------------------------------------------------ doorways

/** A side's length and the cell `i` squares along it, inside the room. */
export function sideCells(r: Rect, side: Side): { length: number; at: (i: number) => [number, number] } {
  switch (side) {
    case "n":
      return { length: r.w, at: (i) => [r.x + i, r.y] };
    case "s":
      return { length: r.w, at: (i) => [r.x + i, r.y + r.h - 1] };
    case "w":
      return { length: r.h, at: (i) => [r.x, r.y + i] };
    case "e":
      return { length: r.h, at: (i) => [r.x + r.w - 1, r.y + i] };
  }
}

/** The grid edge between an inside square and the outside square across `side`, as "x,y,n" or "x,y,w". */
export function doorEdge(x: number, y: number, side: Side): string {
  switch (side) {
    case "n":
      return `${x},${y},n`;
    case "s":
      return `${x},${y + 1},n`;
    case "w":
      return `${x},${y},w`;
    case "e":
      return `${x + 1},${y},w`;
  }
}

/** The rock between two rooms across their larger gap. */
export function rockBetween(r: Rect, o: Rect): number {
  return Math.max(o.x - (r.x + r.w), r.x - (o.x + o.w), o.y - (r.y + r.h), r.y - (o.y + o.h));
}

/** The side of `r` facing `o`: across the larger gap, the middles' offset breaking a tie. Then the other axis's side. */
export function facingSides(r: Rect, o: Rect): [Side, Side] {
  const xgap = Math.max(o.x - (r.x + r.w), r.x - (o.x + o.w));
  const ygap = Math.max(o.y - (r.y + r.h), r.y - (o.y + o.h));
  const dx = 2 * o.x + o.w - (2 * r.x + r.w);
  const dy = 2 * o.y + o.h - (2 * r.y + r.h);
  const ew: Side = dx > 0 ? "e" : "w";
  const ns: Side = dy > 0 ? "s" : "n";
  const across = xgap !== ygap ? xgap > ygap : Math.abs(dx) >= Math.abs(dy);
  return across ? [ew, ns] : [ns, ew];
}

/**
 * Places a doorway on a room: on the first of `sides` with a free spot,
 * nearest to the middle of `target` along it (the other room, or the room
 * itself for the entrance stub's), never at
 * a corner, a square clear of the side's other doorways, and with open rock
 * outside it for its corridor to leave by. The entrance stub's may open
 * into the margin. `aim`, given the last spot a side has, picks the spot to
 * start from instead of the one facing the target's middle.
 */
export function placeDoorway(board: Board, room: number, sides: readonly Side[], target: Rect, width: 1 | 2, link: number, stub = false, aim?: (last: number) => number): Doorway | null {
  const r = board.rooms[room]!;
  for (const side of sides) {
    const { length, at } = sideCells(r, side);
    const last = length - 1 - width;
    if (last < 1) continue;
    const start = side === "n" || side === "s" ? r.x : r.y;
    const toward = middleAlong(target, side) - Math.floor((width - 1) / 2);
    const want = aim ? aim(last) : Math.min(last, Math.max(1, toward - start));
    const taken = board.doorways.filter((d) => d.room === room && d.side === side && !d.removed);
    for (let off = 0; off <= last; off++) {
      for (const i of off === 0 ? [want] : [want - off, want + off]) {
        if (i < 1 || i > last) continue;
        if (taken.some((d) => i <= d.at + d.width && d.at <= i + width)) continue;
        const inside: number[] = [];
        const outside: number[] = [];
        for (let j = 0; j < width; j++) {
          const [x, y] = at(i + j);
          inside.push(board.cell(x, y));
          outside.push(board.cell(x + DX[side], y + DY[side]));
        }
        if (!stub && !approachOpen(board, outside, side, width)) continue;
        if (stub && !outside.every((k) => board.inMap(k % board.W, Math.floor(k / board.W)))) continue;
        const d: Doorway = { id: board.doorways.length, room, side, at: i, width, inside, outside, link, run: null, flat: null, removed: false };
        board.doorways.push(d);
        return d;
      }
    }
  }
  return null;
}

/**
 * Whether the squares a corridor leaves a doorway by are open rock: the
 * outside squares inside the margin, and the next row out (two on Wide, so
 * the corridor's block can turn) clear of rooms and of the squares
 * touching them.
 */
function approachOpen(board: Board, outside: readonly number[], side: Side, width: 1 | 2): boolean {
  for (const k of outside) {
    const x = k % board.W;
    const y = (k - x) / board.W;
    if (!board.inside(x, y)) return false;
    for (let step = 1; step <= width; step++) {
      const ax = x + DX[side] * step;
      const ay = y + DY[side] * step;
      if (!board.inside(ax, ay)) return false;
      const a = board.cell(ax, ay);
      if (board.roomAt[a] !== 0 || board.halo(a)) return false;
    }
  }
  return true;
}

/** The coordinate along `side`'s axis of a room's middle, for aiming a doorway at it. */
export function middleAlong(o: Rect, side: Side): number {
  return side === "n" || side === "s" ? o.x + Math.floor((o.w - 1) / 2) : o.y + Math.floor((o.h - 1) / 2);
}
