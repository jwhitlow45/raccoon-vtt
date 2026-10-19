import { CHUNK_CELLS, type BuildChunk } from "../model.ts";
import type { BuildState } from "../ruleHooks.ts";
import type { DiagonalCounter, DistanceSettings } from "./distance.ts";
import { canSqueeze, footprintSize } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { footprintGround, standing } from "./heights.ts";
import { legStop, stepTester, type MovingToken, type StepTester } from "./movement.ts";
import { routeLattice, type RoutePiece, type RoutePoint } from "./route.ts";

/**
 * Finding the way a creature walks (docs/design-v1-movement.md section 5):
 * the cheapest route to where a drag is, around walls, closed doors and
 * ledges, counting difficult terrain, water, other creatures' spaces and
 * squeezing. Pure and shared, run by the client alone: the server never
 * searches, it checks the route an op carries.
 *
 * The search works on a lattice of the footprint's top-left corner from
 * where the token stands (whole squares, half squares for Tiny creatures and
 * for creatures that squeeze, 4.5). A step goes to one of the eight
 * neighbours when the core's straight sweep is clear (movement.ts
 * `stepTester`), so a route's pieces always pass the leg test the server
 * runs. Costs are exact: half feet for the grid rules, carried with the
 * 5-10-5 counters' residues where they matter (4.7).
 *
 * The caller builds the inputs from the public world (5.5): only what every
 * player sees reaches here, so every device finds the same route.
 */

/** A creature in the mover's way, as players see it (4.3). */
export type WalkCreature = {
  /** Its footprint where it stands, squeezed if it squeezes, in cells: `[x0, x1)` by `[y0, y1)`. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Its vertical extent in feet. */
  lo: number;
  hi: number;
  /**
   * How it stands in the way: `free` for an ally or a Tiny creature, whose
   * space costs nothing, `difficult` for one the mover may pass through as
   * difficult terrain, `blocked` for one it cannot pass, where a route may
   * end but never goes on from.
   */
  way: "free" | "difficult" | "blocked";
};

/** Ground squares an area covers that cost to walk: 1 extra foot (difficult terrain) or 3 (Plant Growth's 4 ft per foot). */
export type WalkArea = { extra: 1 | 3; cells: readonly Point[] };

export type WalkInput = {
  build: BuildState;
  /** The mover where it stands. */
  token: MovingToken;
  rules: DistanceSettings;
  /** The ground the search may read, as squares players have seen, or null for all of it. Terrain and marks count only there. */
  seen: ((x: number, y: number) => boolean) | null;
  creatures: readonly WalkCreature[];
  areas: readonly WalkArea[];
  /** Crawling: the mover is Prone as players see it, and every step costs 1 extra foot. */
  prone: boolean;
  /** The 5-10-5 counters the walk runs on from: the public ones (5.5). */
  counter: DiagonalCounter;
  /** attach's dragging foot, every step: 0 or 1. */
  drag?: 0 | 1;
};

/** What a found route is: its pieces as the op carries them, the walk's points with their ground, and what the search paid. */
export type WalkRoute = {
  pieces: RoutePiece[];
  /** The start, then each piece's end. Elevations are the ground for a walker and the start's height for any other: the caller sets the landing's. */
  points: RoutePoint[];
  /** Whether the walk ends in the space of a creature the mover could not have passed, or in a pit. */
  endsBlocked: boolean;
};

/** The search's cap (5.2): settled states, never a time, so every device finds the same route or none. */
export const MAX_SETTLED = 200_000;

/** The eight steps in lattice units, straight ones first. Their order fixes the route among equal ones, on every device. */
const DX = [1, 0, -1, 0, 1, -1, -1, 1] as const;
const DY = [0, 1, 0, -1, 1, 1, -1, -1] as const;

// Per-cell flags of the ground a walker reads.
const DIFFICULT = 1;
const QUARTER = 2;
const WATER = 4;
const PIT = 8;
const SEEN = 16;

const EPS = 1e-9;

/** How the mover stands where it starts (4.6): walking on the ground, flying, or inside the ground. */
type Mode = "ground" | "flying" | "inside";

/*
 * Step answers by lattice node and direction, kept across drags while the
 * wall set (by identity), the core, the ledges that count and the lattice
 * stay the same (5.1). A few per wall set: a drag of another token, or of
 * one standing on another lattice, makes its own.
 */
let stepCaches = new WeakMap<object, Map<string, Uint8Array>>();

/** Drops every kept step answer, so a benchmark times a drag's first search as a phone pays it. */
export function forgetStepCaches(): void {
  stepCaches = new WeakMap();
}

function stepCache(walls: object, key: string, size: number): Uint8Array {
  let byKey = stepCaches.get(walls);
  if (!byKey) stepCaches.set(walls, (byKey = new Map()));
  let cache = byKey.get(key);
  if (!cache || cache.length !== size) {
    if (byKey.size >= 4) byKey.delete(byKey.keys().next().value!);
    byKey.set(key, (cache = new Uint8Array(size)));
  }
  return cache;
}

/**
 * The world a drag walks in, built once per drag: the lattice, the per-cell
 * ground, the creatures by cell, and the step test. `extraOf` and `endOf`
 * answer for any two spots on the lattice, and the search caches them.
 */
export class WalkWorld {
  readonly input: WalkInput;
  readonly mode: Mode;
  readonly L: number;
  readonly w: number;
  readonly h: number;
  /** Lattice size and where the start sits on it. */
  readonly nx: number;
  readonly ny: number;
  readonly i0: number;
  readonly j0: number;
  readonly W: number;
  readonly H: number;
  readonly tester: StepTester | null;
  readonly squeezes: boolean;
  readonly height: number;
  readonly flags: Uint8Array;
  readonly #ground: Float64Array;
  readonly #byCell: Int32Array;
  readonly #cellItems: Int32Array;
  readonly #walls: Uint8Array | null;
  readonly #pinch: Uint8Array;
  readonly #stamps: Uint32Array;
  #stamp = 0;

  constructor(input: WalkInput) {
    this.input = input;
    const { token, build } = input;
    const scene = build.scenes[token.sceneId];
    this.W = scene?.bounds.w ?? 0;
    this.H = scene?.bounds.h ?? 0;
    const chunks = build.buildChunks;
    const fp = footprintSize(token);
    this.w = fp.w;
    this.h = fp.h;
    this.L = routeLattice(token);
    this.mode = standing(token.elevation, footprintGround(chunks, token));
    this.height = heightFt(token, input.rules.feetPerCell);
    const L = this.L;
    // The lattice from where the token stands: x = token.x + (i - i0) * L, inside the scene.
    this.i0 = Math.floor(token.x / L + EPS);
    this.j0 = Math.floor(token.y / L + EPS);
    const x0 = token.x - this.i0 * L;
    const y0 = token.y - this.j0 * L;
    this.nx = Math.max(0, Math.floor((this.W - this.w - x0) / L + EPS) + 1);
    this.ny = Math.max(0, Math.floor((this.H - this.h - y0) / L + EPS) + 1);
    const blocks = scene?.blockMovement === true;
    this.tester = blocks ? stepTester(build, { ...token, squeeze: undefined }) : null;
    this.squeezes = canSqueeze(token) && this.tester !== null;
    const nodes = this.nx * this.ny;
    this.#pinch = new Uint8Array(this.squeezes ? nodes : 0);
    this.#ground = new Float64Array(this.mode === "ground" ? nodes : 0).fill(NaN);
    this.#walls = this.tester
      ? stepCache(this.tester.walls, `${this.w},${this.h},${this.mode === "flying" ? token.elevation : this.mode},${L},${x0},${y0},${this.nx},${this.ny}`, nodes * 8)
      : null;
    this.flags = cellFlags(input, this.W, this.H, this.mode === "ground");
    // Creatures by the cells their footprints overlap, for the few a step's footprint can meet.
    const counts = new Int32Array(this.W * this.H + 1);
    const each = (c: WalkCreature, fn: (cell: number) => void) => {
      for (let y = Math.max(0, Math.floor(c.y0)); y < Math.min(this.H, Math.ceil(c.y1 - EPS)); y++)
        for (let x = Math.max(0, Math.floor(c.x0)); x < Math.min(this.W, Math.ceil(c.x1 - EPS)); x++) fn(y * this.W + x);
    };
    const creatures = this.mode === "inside" ? [] : input.creatures;
    for (const c of creatures) each(c, (cell) => counts[cell + 1]!++);
    for (let k = 1; k < counts.length; k++) counts[k]! += counts[k - 1]!;
    const items = new Int32Array(counts[counts.length - 1]!);
    const fill = counts.slice();
    for (const [n, c] of creatures.entries()) each(c, (cell) => (items[fill[cell]!++] = n));
    this.#byCell = counts;
    this.#cellItems = items;
    this.#stamps = new Uint32Array(creatures.length);
  }

  /** The stored position of lattice node `n`. */
  xOf(n: number): number {
    return this.input.token.x + ((n % this.nx) - this.i0) * this.L;
  }

  yOf(n: number): number {
    return this.input.token.y + (Math.floor(n / this.nx) - this.j0) * this.L;
  }

  /** The node at a stored position on the lattice, or -1 off it or outside the scene. */
  nodeAt(p: Point): number {
    const i = Math.round((p.x - this.input.token.x) / this.L) + this.i0;
    const j = Math.round((p.y - this.input.token.y) / this.L) + this.j0;
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
    if (Math.abs(this.input.token.x + (i - this.i0) * this.L - p.x) > 1e-7 || Math.abs(this.input.token.y + (j - this.j0) * this.L - p.y) > 1e-7) return -1;
    return j * this.nx + i;
  }

  get startNode(): number {
    return this.i0 < this.nx && this.j0 < this.ny && this.i0 >= 0 && this.j0 >= 0 ? this.j0 * this.nx + this.i0 : -1;
  }

  /** The elevation at a node: the ground under the footprint for a walker, the start's height for any other. */
  elevationAt(n: number): number {
    if (this.mode !== "ground") return this.input.token.elevation;
    let g = this.#ground[n]!;
    if (Number.isNaN(g)) {
      g = footprintGround(this.input.build.buildChunks, { ...this.input.token, x: this.xOf(n), y: this.yOf(n), squeeze: undefined });
      this.#ground[n] = g;
    }
    return g;
  }

  /** Whether the step from node `a` in direction `d` is clear of walls and ledges, cached across drags. */
  wallsClear(a: number, d: number, b: number): boolean {
    const cache = this.#walls;
    if (!cache || !this.tester) return true;
    const k = a * 8 + d;
    const known = cache[k]!;
    if (known !== 0) return known === 1;
    const ok = this.tester.clear(this.xOf(a), this.yOf(a), this.xOf(b), this.yOf(b));
    cache[k] = ok ? 1 : 2;
    return ok;
  }

  /** Whether the footprint at a stored position lies on ground the search may read: every square under it seen. */
  seenAt(x: number, y: number): boolean {
    if (!this.input.seen) return true;
    const flags = this.flags;
    for (let cy = Math.floor(y + EPS); cy < Math.ceil(y + this.h - EPS); cy++)
      for (let cx = Math.floor(x + EPS); cx < Math.ceil(x + this.w - EPS); cx++) {
        if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H || (flags[cy * this.W + cx]! & SEEN) === 0) return false;
      }
    return true;
  }

  /**
   * Whether a walk may end at a stored position but never go on from it: a
   * walker's footprint over a pit, or over a creature it cannot pass whose
   * height it shares.
   */
  endOnly(x: number, y: number, elevation: number): boolean {
    if (this.mode === "inside") return false;
    const x1 = x + this.w;
    const y1 = y + this.h;
    if (this.mode === "ground") {
      for (let cy = Math.max(0, Math.floor(y + EPS)); cy < Math.min(this.H, Math.ceil(y1 - EPS)); cy++)
        for (let cx = Math.max(0, Math.floor(x + EPS)); cx < Math.min(this.W, Math.ceil(x1 - EPS)); cx++) if ((this.flags[cy * this.W + cx]! & PIT) !== 0) return true;
    }
    let blocked = false;
    this.#creaturesUnder(x, y, (c) => {
      if (c.way === "blocked" && overlaps(c, x, y, x1, y1) && c.lo < elevation + this.height && elevation < c.hi) blocked = true;
    });
    return blocked;
  }

  /**
   * The step from A to B: its extra feet per foot and whether one of them is
   * the swimming foot (4.1). Ground sources pay by entry on the continuous
   * footprint: the step pays when the part of B's rectangle outside A's
   * overlaps a source's inside, so leaving rubble pays nothing and a Large
   * creature's two half steps across a square of it pay half each. Ground
   * sources are a walker's alone, while creatures' spaces count wherever
   * heights overlap and squeezing for any creature. Crawling and dragging pay
   * on every step.
   */
  extraOf(ax: number, ay: number, bx: number, by: number, elevation: number, b: number): { extra: number; swim: 0 | 1 } {
    if (this.mode === "inside") return { extra: this.input.drag ?? 0, swim: 0 };
    const { w, h } = this;
    const bx1 = bx + w;
    const by1 = by + h;
    let ground = 0;
    let swim = false;
    if (this.mode === "ground") {
      for (let cy = Math.max(0, Math.floor(by + EPS)); cy < Math.min(this.H, Math.ceil(by1 - EPS)); cy++) {
        for (let cx = Math.max(0, Math.floor(bx + EPS)); cx < Math.min(this.W, Math.ceil(bx1 - EPS)); cx++) {
          const f = this.flags[cy * this.W + cx]!;
          if ((f & (DIFFICULT | QUARTER | WATER)) === 0) continue;
          if (!newlyCovered(Math.max(cx, bx), Math.max(cy, by), Math.min(cx + 1, bx1), Math.min(cy + 1, by1), ax, ay, ax + w, ay + h)) continue;
          if (f & QUARTER) ground = 3;
          else if (f & DIFFICULT) ground = Math.max(ground, 1);
          if (f & WATER) swim = true;
        }
      }
    }
    if (ground < 1) {
      this.#creaturesUnder(bx, by, (c) => {
        if (c.way === "free" || ground >= 1) return;
        if (!(c.lo < elevation + this.height && elevation < c.hi)) return;
        const x0 = Math.max(c.x0, bx);
        const y0 = Math.max(c.y0, by);
        const x1 = Math.min(c.x1, bx1);
        const y1 = Math.min(c.y1, by1);
        if (x1 - x0 > EPS && y1 - y0 > EPS && newlyCovered(x0, y0, x1, y1, ax, ay, ax + w, ay + h)) ground = 1;
      });
    }
    if (ground < 1 && this.squeezes && this.#pinched(bx, by, b)) ground = 1;
    const crawl = this.input.prone;
    return { extra: ground + (swim || crawl ? 1 : 0) + (this.input.drag ?? 0), swim: swim && !crawl ? 1 : 0 };
  }

  #pinched(x: number, y: number, n: number): boolean {
    if (n < 0) return this.tester!.pinched(x, y);
    const known = this.#pinch[n]!;
    if (known !== 0) return known === 1;
    const p = this.tester!.pinched(x, y);
    this.#pinch[n] = p ? 1 : 2;
    return p;
  }

  #creaturesUnder(x: number, y: number, fn: (c: WalkCreature) => void): void {
    const creatures = this.input.creatures;
    if (creatures.length === 0 || this.mode === "inside") return;
    const stamp = ++this.#stamp;
    for (let cy = Math.max(0, Math.floor(y + EPS)); cy < Math.min(this.H, Math.ceil(y + this.h - EPS)); cy++) {
      for (let cx = Math.max(0, Math.floor(x + EPS)); cx < Math.min(this.W, Math.ceil(x + this.w - EPS)); cx++) {
        const cell = cy * this.W + cx;
        for (let p = this.#byCell[cell]!; p < this.#byCell[cell + 1]!; p++) {
          const k = this.#cellItems[p]!;
          if (this.#stamps[k] === stamp) continue;
          this.#stamps[k] = stamp;
          fn(creatures[k]!);
        }
      }
    }
  }
}

function heightFt(token: MovingToken, feetPerCell: number): number {
  const t = token as MovingToken & { height?: number };
  if (t.height !== undefined && Number.isFinite(t.height) && t.height >= 0) return t.height;
  const { w, h } = footprintSize(token);
  return Math.min(w, h) * feetPerCell;
}

function overlaps(c: WalkCreature, x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.min(c.x1, x1) - Math.max(c.x0, x0) > EPS && Math.min(c.y1, y1) - Math.max(c.y0, y0) > EPS;
}

/** Whether the rectangle R, part of B, reaches outside A: then part of it is newly covered with some area. */
function newlyCovered(rx0: number, ry0: number, rx1: number, ry1: number, ax0: number, ay0: number, ax1: number, ay1: number): boolean {
  if (rx1 - rx0 <= EPS || ry1 - ry0 <= EPS) return false;
  return rx0 < ax0 - EPS || rx1 > ax1 + EPS || ry0 < ay0 - EPS || ry1 > ay1 + EPS;
}

/*
 * A chunk's own ground flags, its cells in row-major order, parsed once per
 * stored chunk: a chunk is replaced, never changed, when it is written.
 */
const chunkFlagCache = new WeakMap<BuildChunk, Uint8Array>();

function chunkFlags(chunk: BuildChunk): Uint8Array {
  let flags = chunkFlagCache.get(chunk);
  if (flags) return flags;
  flags = new Uint8Array(CHUNK_CELLS * CHUNK_CELLS);
  for (const [key, terrain] of Object.entries(chunk.cells)) {
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma)) - chunk.cx * CHUNK_CELLS;
    const y = Number(key.slice(comma + 1)) - chunk.cy * CHUNK_CELLS;
    if (x < 0 || y < 0 || x >= CHUNK_CELLS || y >= CHUNK_CELLS) continue;
    const k = y * CHUNK_CELLS + x;
    if (terrain === "difficult" || terrain === "rubble") flags[k]! |= DIFFICULT;
    else if (terrain === "water") flags[k]! |= WATER;
    else if (terrain === "pit") flags[k]! |= PIT;
  }
  const rough = (chunk as BuildChunk & { rough?: string }).rough;
  if (rough) for (let i = 0; i < rough.length && i < flags.length; i++) if (rough[i] === "d") flags[i]! |= DIFFICULT;
  chunkFlagCache.set(chunk, flags);
  return flags;
}

/** The ground a walker reads, square by square: difficult, Plant Growth, water and pits, only where the search may read the ground. */
function cellFlags(input: WalkInput, W: number, H: number, walker: boolean): Uint8Array {
  const flags = new Uint8Array(W * H);
  const sceneId = input.token.sceneId;
  const seen = input.seen;
  if (seen) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (seen(x, y)) flags[y * W + x] = SEEN;
  } else flags.fill(SEEN);
  if (!walker) return flags;
  for (const chunk of Object.values(input.build.buildChunks)) {
    if (!chunk || chunk.sceneId !== sceneId) continue;
    const own = chunkFlags(chunk);
    const x0 = chunk.cx * CHUNK_CELLS;
    const y0 = chunk.cy * CHUNK_CELLS;
    for (let k = 0; k < own.length; k++) {
      const f = own[k]!;
      if (f === 0) continue;
      const x = x0 + (k % CHUNK_CELLS);
      const y = y0 + Math.floor(k / CHUNK_CELLS);
      if (x >= W || y >= H || (flags[y * W + x]! & SEEN) === 0) continue;
      flags[y * W + x]! |= f;
    }
  }
  for (const area of input.areas) {
    for (const { x, y } of area.cells) {
      if (x < 0 || y < 0 || x >= W || y >= H || (flags[y * W + x]! & SEEN) === 0) continue;
      flags[y * W + x]! |= area.extra === 3 ? QUARTER : DIFFICULT;
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The search

/** The answer to `settle`: the spot is settled, no route reaches it, the search hit its cap, or the time slice ran out. */
export type SettleResult = "settled" | "unreachable" | "capped" | "paused";

/**
 * A uniform-cost search from the drag's start (5.2), grown on demand: each
 * call to `settle` runs until the spot asked for is settled, so one search
 * serves every spot the finger visits. It orders by cost, then by fewer
 * corners, then by the shorter length on the map (5.3), so among equal
 * routes it takes the one with the fewest bends, closest to straight.
 */
export class WalkSearch {
  readonly world: WalkWorld;
  /** Settled states so far, against MAX_SETTLED. */
  settled = 0;
  readonly #fiveTen: boolean;
  readonly #euclid: boolean;
  readonly #S: number;
  readonly #Lu: number;
  readonly #hr: number;
  readonly #h0: number;
  readonly #v0: number;
  // State slots, grown as the search reaches new states.
  #n = 0;
  #cost = new Float64Array(1024);
  #corners = new Int32Array(1024);
  #len = new Float64Array(1024);
  #parent = new Int32Array(1024);
  #node = new Int32Array(1024);
  #h = new Int32Array(1024);
  #v = new Int32Array(1024);
  #dir = new Int8Array(1024);
  #extra = new Int8Array(1024);
  #swim = new Int8Array(1024);
  #dz = new Int32Array(1024);
  #done = new Uint8Array(1024);
  /** States at the starting vertical residue, by node and horizontal residue; others by key. */
  readonly #dense: Int32Array;
  readonly #sparse = new Map<number, number>();
  /** The first state settled at each node: the cheapest way there. */
  readonly #best: Int32Array;
  #heap = new Heap();
  #capped = false;

  constructor(world: WalkWorld) {
    this.world = world;
    const rules = world.input.rules;
    this.#fiveTen = rules.diagonal === "fiveTen";
    this.#euclid = rules.diagonal === "euclid";
    this.#S = 2 * rules.feetPerCell;
    this.#Lu = Math.round(world.L * this.#S);
    this.#hr = this.#fiveTen ? Math.round((2 * this.#S) / this.#Lu) : 1;
    this.#h0 = this.#fiveTen ? mod(Math.round(world.input.counter.h * this.#S), 2 * this.#S) : 0;
    this.#v0 = this.#fiveTen ? mod(Math.round(world.input.counter.v * this.#S), 2 * this.#S) : 0;
    const nodes = world.nx * world.ny;
    this.#dense = new Int32Array(nodes * this.#hr).fill(-1);
    this.#best = new Int32Array(nodes).fill(-1);
    const start = world.startNode;
    if (start >= 0) {
      const s = this.#slot(start, 0, this.#v0);
      this.#cost[s] = 0;
      this.#corners[s] = 0;
      this.#len[s] = 0;
      this.#parent[s] = -1;
      this.#dir[s] = -1;
      this.#heap.push(0, 0, 0, s);
    }
  }

  /** Whether `to` is settled: the cheapest route to it is known. */
  isSettled(to: Point): boolean {
    const n = this.world.nodeAt(to);
    return n >= 0 && this.#best[n]! >= 0;
  }

  /**
   * Runs until `to` is settled, nothing more can be reached, the cap is hit,
   * or `deadline` (a `performance.now()` time) passes, checked every few
   * hundred states.
   */
  settle(to: Point, deadline = Infinity): SettleResult {
    const target = this.world.nodeAt(to);
    if (target < 0) return "unreachable";
    let polled = 0;
    while (this.#best[target]! < 0) {
      if (this.#capped) return "capped";
      if (deadline !== Infinity && ++polled % 256 === 0 && performance.now() > deadline) return "paused";
      const s = this.#heap.popValid((slot, cost, corners, len) => this.#done[slot] === 0 && this.#cost[slot] === cost && this.#corners[slot] === corners && this.#len[slot] === len);
      if (s < 0) return "unreachable";
      this.#settle(s);
    }
    return "settled";
  }

  /**
   * Settles every state the search can reach at a cost up to `limit`, in
   * its own units (half feet, or feet under true distance), or all of them:
   * every route within a Dash, or a flood of the whole scene.
   */
  flood(limit = Infinity, deadline = Infinity): "done" | "capped" | "paused" {
    let polled = 0;
    for (;;) {
      if (this.#capped) return "capped";
      if (deadline !== Infinity && ++polled % 256 === 0 && performance.now() > deadline) return "paused";
      const s = this.#heap.popValid((slot, cost, corners, len) => this.#done[slot] === 0 && this.#cost[slot] === cost && this.#corners[slot] === corners && this.#len[slot] === len);
      if (s < 0) return "done";
      if (this.#cost[s]! > limit) {
        this.#heap.push(this.#cost[s]!, this.#corners[s]!, this.#len[s]!, s);
        return "done";
      }
      this.#settle(s);
    }
  }

  #settle(s: number): void {
    this.#done[s] = 1;
    this.settled++;
    if (this.settled >= MAX_SETTLED) this.#capped = true;
    const world = this.world;
    const a = this.#node[s]!;
    if (this.#best[a]! < 0) this.#best[a] = s;
    const ax = world.xOf(a);
    const ay = world.yOf(a);
    const ea = world.elevationAt(a);
    // A walk may end in a pit or a creature it cannot pass, never go on from one, unless it started there.
    if (this.#parent[s] !== -1 && world.endOnly(ax, ay, ea)) return;
    const i = a % world.nx;
    const j = Math.floor(a / world.nx);
    for (let d = 0; d < 8; d++) {
      const bi = i + DX[d]!;
      const bj = j + DY[d]!;
      if (bi < 0 || bj < 0 || bi >= world.nx || bj >= world.ny) continue;
      const b = bj * world.nx + bi;
      if (this.#best[b]! >= 0 && !this.#fiveTen) continue;
      const bx = world.xOf(b);
      const by = world.yOf(b);
      if (!world.seenAt(bx, by) || !world.wallsClear(a, d, b)) continue;
      const eb = world.elevationAt(b);
      const { extra, swim } = world.extraOf(ax, ay, bx, by, eb, b);
      this.#relax(s, b, d, extra, swim, eb - ea);
    }
  }

  #relax(s: number, b: number, d: number, extra: number, swim: 0 | 1, dzFt: number): void {
    const diagonal = d >= 4;
    const Z = Math.round(Math.abs(dzFt) * 2);
    let h = this.#h[s]!;
    let v = this.#v[s]!;
    let step: number;
    if (this.#euclid) {
      const L = this.world.L;
      const fpc = this.world.input.rules.feetPerCell;
      step = Math.hypot(L, diagonal ? L : 0, Math.abs(dzFt) / fpc) * fpc;
    } else if (!this.#fiveTen) step = Math.max(this.#Lu, Z);
    else {
      const S2 = 2 * this.#S;
      const Lu = this.#Lu;
      const ha = mod(this.#h0 + h * Lu, S2);
      const horizontal = diagonal ? Lu + this.#S * (Math.floor((ha + Lu) / S2) - Math.floor(ha / S2)) : Lu;
      if (diagonal) h = (h + 1) % this.#hr;
      const vMin = Math.min(horizontal, Z);
      step = Math.max(horizontal, Z) + this.#S * (Math.floor((v + vMin) / S2) - Math.floor(v / S2));
      v = (v + vMin) % S2;
    }
    const cost = this.#cost[s]! + step * (1 + extra);
    const corners = this.#corners[s]! + (this.#dir[s]! >= 0 && this.#dir[s] !== d ? 1 : 0);
    const len = this.#len[s]! + (diagonal ? Math.SQRT2 : 1) * this.world.L;
    const t = this.#slot(b, h, v);
    if (this.#done[t] === 1) return;
    if (this.#parent[t] !== -2 && !less(cost, corners, len, this.#cost[t]!, this.#corners[t]!, this.#len[t]!)) return;
    this.#cost[t] = cost;
    this.#corners[t] = corners;
    this.#len[t] = len;
    this.#parent[t] = s;
    this.#dir[t] = d;
    this.#extra[t] = extra;
    this.#swim[t] = swim;
    this.#dz[t] = Math.round(dzFt * 2);
    this.#heap.push(cost, corners, len, t);
  }

  /** The state for a node and residues, made unreached (parent -2) the first time it is asked for. */
  #slot(node: number, h: number, v: number): number {
    let s: number;
    if (v === this.#v0) {
      const k = node * this.#hr + h;
      s = this.#dense[k]!;
      if (s >= 0) return s;
      s = this.#grow();
      this.#dense[k] = s;
    } else {
      const k = (node * this.#hr + h) * 2 * this.#S + v;
      const found = this.#sparse.get(k);
      if (found !== undefined) return found;
      s = this.#grow();
      this.#sparse.set(k, s);
    }
    this.#node[s] = node;
    this.#h[s] = h;
    this.#v[s] = v;
    this.#parent[s] = -2;
    this.#cost[s] = Infinity;
    return s;
  }

  #grow(): number {
    const s = this.#n++;
    if (s >= this.#cost.length) {
      const size = this.#cost.length * 2;
      const grow = <T extends Float64Array | Int32Array | Int8Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(size);
        b.set(a);
        return b;
      };
      this.#cost = grow(this.#cost);
      this.#corners = grow(this.#corners);
      this.#len = grow(this.#len);
      this.#parent = grow(this.#parent);
      this.#node = grow(this.#node);
      this.#h = grow(this.#h);
      this.#v = grow(this.#v);
      this.#dir = grow(this.#dir);
      this.#extra = grow(this.#extra);
      this.#swim = grow(this.#swim);
      this.#dz = grow(this.#dz);
      this.#done = grow(this.#done);
    }
    return s;
  }

  /** The cost the search paid to a settled spot, in its own units: half feet, or feet under true distance. */
  costTo(to: Point): number | null {
    const n = this.world.nodeAt(to);
    const s = n >= 0 ? this.#best[n]! : -1;
    return s >= 0 ? this.#cost[s]! : null;
  }

  /**
   * The cheapest route to a settled spot, as straight pieces split wherever
   * the direction, the extra, the swimming foot or the change of height per
   * step changes, a 5-10-5 diagonal that climbs on its own, so a piece's
   * feet are its steps' (route.ts `routeFeet`). Under true distance the
   * route is pulled taut (5.4).
   */
  routeTo(to: Point): WalkRoute | null {
    const world = this.world;
    const n = world.nodeAt(to);
    const end = n >= 0 ? this.#best[n]! : -1;
    if (end < 0) return null;
    const chain: number[] = [];
    for (let s = end; s >= 0; s = this.#parent[s]!) chain.push(s);
    chain.reverse();
    const first = chain[0]!;
    const points: RoutePoint[] = [{ x: world.xOf(this.#node[first]!), y: world.yOf(this.#node[first]!), elevation: world.input.token.elevation }];
    const pieces: RoutePiece[] = [];
    if (this.#euclid) {
      this.#taut(chain, points, pieces);
    } else {
      let key = "";
      let alone = false;
      for (let k = 1; k < chain.length; k++) {
        const s = chain[k]!;
        const d = this.#dir[s]!;
        const climbs = this.#fiveTen && d >= 4 && this.#dz[s] !== 0;
        const next = `${d},${this.#extra[s]},${this.#swim[s]},${this.#dz[s]}`;
        const node = this.#node[s]!;
        const p = { x: world.xOf(node), y: world.yOf(node), elevation: world.elevationAt(node) };
        if (k > 1 && next === key && !alone && !climbs) {
          points[points.length - 1] = p;
          const last = pieces[pieces.length - 1]!;
          pieces[pieces.length - 1] = [p.x, p.y, last[2], last[3]];
        } else {
          points.push(p);
          pieces.push([p.x, p.y, this.#extra[s]!, this.#swim[s] === 1 ? 1 : 0]);
        }
        key = next;
        alone = climbs;
      }
    }
    const last = points[points.length - 1]!;
    return { pieces, points, endsBlocked: world.endOnly(last.x, last.y, last.elevation) };
  }

  /*
   * True distance (5.4): from each corner the piece runs to the farthest
   * later spot of the traced walk reachable by an allowed straight leg along
   * which every step pays the same public extra and the ground keeps its
   * height, so a walk around a wall's corner reads its true length and a
   * walk across rubble has corners where the rubble starts and ends.
   */
  #taut(chain: readonly number[], points: RoutePoint[], pieces: RoutePiece[]): void {
    const world = this.world;
    const spot = (k: number) => {
      const node = this.#node[chain[k]!]!;
      return { x: world.xOf(node), y: world.yOf(node), elevation: world.elevationAt(node) };
    };
    let i = 0;
    while (i < chain.length - 1) {
      const e = this.#extra[chain[i + 1]!]!;
      const w = this.#swim[chain[i + 1]!]!;
      let best = i + 1;
      let misses = 0;
      const from = spot(i);
      for (let j = i + 2; j < chain.length; j++) {
        const s = chain[j]!;
        if (this.#extra[s] !== e || this.#swim[s] !== w || this.#dz[s] !== 0 || this.#dz[chain[i + 1]!] !== 0) break;
        if (this.#straightHolds(from, spot(j), e, w)) {
          best = j;
          misses = 0;
        } else if (++misses > 16) break;
      }
      const to = spot(best);
      points.push(to);
      pieces.push([to.x, to.y, e, w === 1 ? 1 : 0]);
      i = best;
    }
  }

  /** Whether the straight leg from A to B is a piece: clear of walls, on seen ground, and every lattice step along it paying `extra`. */
  #straightHolds(a: RoutePoint, b: RoutePoint, extra: number, swim: number): boolean {
    const world = this.world;
    if (world.tester && !world.tester.clear(a.x, a.y, b.x, b.y)) return false;
    const L = world.L;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / L - EPS));
    let px = a.x;
    let py = a.y;
    for (let k = 1; k <= n; k++) {
      const x = k === n ? b.x : a.x + Math.round(((b.x - a.x) * k) / n / L) * L;
      const y = k === n ? b.y : a.y + Math.round(((b.y - a.y) * k) / n / L) * L;
      if (x === px && y === py) continue;
      if (!world.seenAt(x, y)) return false;
      const node = world.nodeAt({ x, y });
      if (node < 0) return false;
      const e = world.elevationAt(node);
      if (e !== a.elevation || (k < n && world.endOnly(x, y, e))) return false;
      const step = world.extraOf(px, py, x, y, e, node);
      if (step.extra !== extra || step.swim !== swim) return false;
      px = x;
      py = y;
    }
    return true;
  }
}

function less(c1: number, k1: number, l1: number, c2: number, k2: number, l2: number): boolean {
  if (c1 !== c2) return c1 < c2;
  if (k1 !== k2) return k1 < k2;
  return l1 < l2;
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** A binary heap of states by cost, then corners, then length, then slot, so pops are the same on every device. */
class Heap {
  #cost = new Float64Array(1024);
  #corners = new Int32Array(1024);
  #len = new Float64Array(1024);
  #slot = new Int32Array(1024);
  #n = 0;

  push(cost: number, corners: number, len: number, slot: number): void {
    if (this.#n === this.#cost.length) this.#grow();
    let i = this.#n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#before(cost, corners, len, slot, p)) break;
      this.#move(p, i);
      i = p;
    }
    this.#set(i, cost, corners, len, slot);
  }

  /** Pops entries until one passes `valid`, the lazy deletion of entries a cheaper one replaced. Returns its slot, or -1. */
  popValid(valid: (slot: number, cost: number, corners: number, len: number) => boolean): number {
    while (this.#n > 0) {
      const slot = this.#slot[0]!;
      const cost = this.#cost[0]!;
      const corners = this.#corners[0]!;
      const len = this.#len[0]!;
      this.#popTop();
      if (valid(slot, cost, corners, len)) return slot;
    }
    return -1;
  }

  #popTop(): void {
    const n = --this.#n;
    if (n === 0) return;
    const cost = this.#cost[n]!;
    const corners = this.#corners[n]!;
    const len = this.#len[n]!;
    const slot = this.#slot[n]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && this.#less(r, l) ? r : l;
      if (!this.#before(this.#cost[c]!, this.#corners[c]!, this.#len[c]!, this.#slot[c]!, -1, cost, corners, len, slot)) break;
      this.#move(c, i);
      i = c;
    }
    this.#set(i, cost, corners, len, slot);
  }

  /** Whether the entry (cost, corners, len, slot) comes before entry `j`, or before the given one when `j` is -1. */
  #before(cost: number, corners: number, len: number, slot: number, j: number, c2 = 0, k2 = 0, l2 = 0, s2 = 0): boolean {
    if (j >= 0) {
      c2 = this.#cost[j]!;
      k2 = this.#corners[j]!;
      l2 = this.#len[j]!;
      s2 = this.#slot[j]!;
    }
    if (cost !== c2) return cost < c2;
    if (corners !== k2) return corners < k2;
    if (len !== l2) return len < l2;
    return slot < s2;
  }

  #less(a: number, b: number): boolean {
    return this.#before(this.#cost[a]!, this.#corners[a]!, this.#len[a]!, this.#slot[a]!, b);
  }

  #move(from: number, to: number): void {
    this.#set(to, this.#cost[from]!, this.#corners[from]!, this.#len[from]!, this.#slot[from]!);
  }

  #set(i: number, cost: number, corners: number, len: number, slot: number): void {
    this.#cost[i] = cost;
    this.#corners[i] = corners;
    this.#len[i] = len;
    this.#slot[i] = slot;
  }

  #grow(): void {
    const size = this.#cost.length * 2;
    const c = new Float64Array(size);
    c.set(this.#cost);
    this.#cost = c;
    const k = new Int32Array(size);
    k.set(this.#corners);
    this.#corners = k;
    const l = new Float64Array(size);
    l.set(this.#len);
    this.#len = l;
    const s = new Int32Array(size);
    s.set(this.#slot);
    this.#slot = s;
  }
}

// ---------------------------------------------------------------------------
// Open ground

/**
 * Whether the plain straight leg to `to` is the route (5.2, "Open ground
 * first"): the leg test allows it and no spot along it, stepped as the
 * reducer's spots are, costs extra or stops a walk short. Most drags are,
 * and need no search. Unseen ground reads as plain, as a straight drop into
 * the fog does today.
 */
export function openLeg(world: WalkWorld, to: Point): boolean {
  const { token, build } = world.input;
  if (to.x === token.x && to.y === token.y) return true;
  if (world.tester) {
    if (legStop(build, token, { x: to.x, y: to.y, elevation: token.elevation }) !== null) return false;
  }
  const L = world.L;
  const dx = to.x - token.x;
  const dy = to.y - token.y;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / L - EPS));
  const exact = Math.abs(dx) < EPS || Math.abs(dy) < EPS || Math.abs(Math.abs(dx) - Math.abs(dy)) < EPS;
  let px = token.x;
  let py = token.y;
  let pe = token.elevation;
  for (let k = 1; k <= n; k++) {
    const x = k === n ? to.x : token.x + (exact ? (dx * k) / n : Math.round((dx * k) / n / L) * L);
    const y = k === n ? to.y : token.y + (exact ? (dy * k) / n : Math.round((dy * k) / n / L) * L);
    if (x === px && y === py) continue;
    const node = world.nodeAt({ x, y });
    const e = node >= 0 ? world.elevationAt(node) : pe;
    if (k < n && world.endOnly(x, y, e)) return false;
    if (world.extraOf(px, py, x, y, e, node).extra !== 0) return false;
    px = x;
    py = y;
    pe = e;
  }
  return true;
}

/**
 * The whole answer for one spot, searched to the end with no time slices:
 * null when the plain straight leg is the route, else the route, or
 * `"none"` when no route reaches it within the cap. Tests, the walking
 * ruler and redo use it. A drag runs `WalkSearch` itself, a slice a frame.
 */
export function findRoute(input: WalkInput, to: Point, search?: WalkSearch): WalkRoute | null | "none" {
  const world = search?.world ?? new WalkWorld(input);
  if (openLeg(world, to)) return null;
  const s = search ?? new WalkSearch(world);
  return s.settle(to) === "settled" ? (s.routeTo(to) ?? "none") : "none";
}
