import { CHUNK_CELLS, type BuildChunk } from "../model.ts";
import type { BuildState } from "../ruleHooks.ts";
import type { DiagonalCounter, DistanceSettings } from "./distance.ts";
import { canSqueeze, footprintSize, squeezedSize } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { footprintGround, standing } from "./heights.ts";
import { legStop, stepTester, type MovingToken, type StepTester } from "./movement.ts";
import { routeLattice, trueLength, type RoutePiece, type RoutePoint } from "./route.ts";

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

/**
 * The most states the fewest-corners trace looks at (5.3, review MV-O-17).
 * Past it, the walk is the one the search first arrived by, as before the
 * trace: as cheap, maybe bent once more. The count depends only on the
 * settled search, so every device makes the same choice.
 */
export const MAX_TRACED = 10_000;

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
  /** How far the squeezed footprint stands in from the full one on each side (4.1, 4.5). */
  readonly #ox: number;
  readonly #oy: number;
  // Scratch for #box, so the hot loop makes no arrays.
  readonly #seenBox = new Float64Array(5);
  readonly #endBox = new Float64Array(5);
  readonly #fromBox = new Float64Array(5);
  readonly #toBox = new Float64Array(5);
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
    const squeezed = squeezedSize(token);
    this.#ox = (this.w - squeezed.w) / 2;
    this.#oy = (this.h - squeezed.h) / 2;
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

  /** Whether the footprint at a stored position lies on ground the search may read: every square under it seen, under the squeezed footprint where it squeezes. */
  seenAt(x: number, y: number, n = -2): boolean {
    if (!this.input.seen) return true;
    const flags = this.flags;
    const box = this.#box(x, y, n, this.#seenBox);
    const x0 = box[0]!;
    const y0 = box[1]!;
    const x1 = box[2]!;
    const y1 = box[3]!;
    for (let cy = Math.floor(y0 + EPS); cy < Math.ceil(y1 - EPS); cy++)
      for (let cx = Math.floor(x0 + EPS); cx < Math.ceil(x1 - EPS); cx++) {
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
    const box = this.#box(x, y, -2, this.#endBox);
    const x0 = box[0]!;
    const y0 = box[1]!;
    const x1 = box[2]!;
    const y1 = box[3]!;
    if (this.mode === "ground") {
      for (let cy = Math.max(0, Math.floor(y0 + EPS)); cy < Math.min(this.H, Math.ceil(y1 - EPS)); cy++)
        for (let cx = Math.max(0, Math.floor(x0 + EPS)); cx < Math.min(this.W, Math.ceil(x1 - EPS)); cx++) if ((this.flags[cy * this.W + cx]! & PIT) !== 0) return true;
    }
    let blocked = false;
    this.#creaturesUnder(x0, y0, x1, y1, (c) => {
      if (c.way === "blocked" && overlaps(c, x0, y0, x1, y1) && c.lo < elevation + this.height && elevation < c.hi) blocked = true;
    });
    return blocked;
  }

  /**
   * The footprint the rules read at a stored position (4.1), as x0, y0, x1
   * and y1 in `out`: the squeezed one where the squeeze rule finds a narrow
   * space, centered in the full one `#ox` and `#oy` in from each side, else
   * the full one. Seen ground, entry costs, pits and creatures all read it.
   * `n` is the position's node, -1 off the lattice, or -2 to look it up.
   */
  #box(x: number, y: number, n: number, out: Float64Array): Float64Array {
    const k = this.squeezes && this.#pinched(x, y, n === -2 ? this.nodeAt({ x, y }) : n) ? 1 : 0;
    out[0] = x + k * this.#ox;
    out[1] = y + k * this.#oy;
    out[2] = x + this.w - k * this.#ox;
    out[3] = y + this.h - k * this.#oy;
    out[4] = k;
    return out;
  }

  /**
   * The step from A to B: its extra feet per foot and whether one of them is
   * the swimming foot (4.1). Ground sources pay by entry on the continuous
   * footprint: the step pays when the part of B's rectangle outside A's
   * overlaps a source's inside, so leaving rubble pays nothing and a Large
   * creature's two half steps across a square of it pay half each. Where a
   * spot squeezes, its rectangle is the squeezed one, so a Large creature in
   * a 5 ft corridor never pays for rubble beside the corridor. Ground
   * sources are a walker's alone, while creatures' spaces count wherever
   * heights overlap and squeezing for any creature. Crawling and dragging pay
   * on every step.
   */
  extraOf(ax: number, ay: number, bx: number, by: number, elevation: number, b: number): { extra: number; swim: 0 | 1 } {
    if (this.mode === "inside") return { extra: this.input.drag ?? 0, swim: 0 };
    const from = this.#box(ax, ay, -2, this.#fromBox);
    const to = this.#box(bx, by, b, this.#toBox);
    const ax0 = from[0]!;
    const ay0 = from[1]!;
    const ax1 = from[2]!;
    const ay1 = from[3]!;
    const bx0 = to[0]!;
    const by0 = to[1]!;
    const bx1 = to[2]!;
    const by1 = to[3]!;
    let ground = 0;
    let swim = false;
    if (this.mode === "ground") {
      for (let cy = Math.max(0, Math.floor(by0 + EPS)); cy < Math.min(this.H, Math.ceil(by1 - EPS)); cy++) {
        for (let cx = Math.max(0, Math.floor(bx0 + EPS)); cx < Math.min(this.W, Math.ceil(bx1 - EPS)); cx++) {
          const f = this.flags[cy * this.W + cx]!;
          if ((f & (DIFFICULT | QUARTER | WATER)) === 0) continue;
          if (!newlyCovered(Math.max(cx, bx0), Math.max(cy, by0), Math.min(cx + 1, bx1), Math.min(cy + 1, by1), ax0, ay0, ax1, ay1)) continue;
          if (f & QUARTER) ground = 3;
          else if (f & DIFFICULT) ground = Math.max(ground, 1);
          if (f & WATER) swim = true;
        }
      }
    }
    if (ground < 1) {
      this.#creaturesUnder(bx0, by0, bx1, by1, (c) => {
        if (c.way === "free" || ground >= 1) return;
        if (!(c.lo < elevation + this.height && elevation < c.hi)) return;
        const x0 = Math.max(c.x0, bx0);
        const y0 = Math.max(c.y0, by0);
        const x1 = Math.min(c.x1, bx1);
        const y1 = Math.min(c.y1, by1);
        if (x1 - x0 > EPS && y1 - y0 > EPS && newlyCovered(x0, y0, x1, y1, ax0, ay0, ax1, ay1)) ground = 1;
      });
    }
    if (ground < 1 && to[4] === 1) ground = 1;
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

  #creaturesUnder(x0: number, y0: number, x1: number, y1: number, fn: (c: WalkCreature) => void): void {
    const creatures = this.input.creatures;
    if (creatures.length === 0 || this.mode === "inside") return;
    const stamp = ++this.#stamp;
    for (let cy = Math.max(0, Math.floor(y0 + EPS)); cy < Math.min(this.H, Math.ceil(y1 - EPS)); cy++) {
      for (let cx = Math.max(0, Math.floor(x0 + EPS)); cx < Math.min(this.W, Math.ceil(x1 - EPS)); cx++) {
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

/** A walk as steps: its nodes from the start, and for each the step that reached it (the start's is empty). */
export type WalkSteps = { nodes: number[]; dir: number[]; extra: number[]; swim: number[]; dz: number[] };

type TraceEdge = { from: number; to: number; d: number; extra: number; swim: number; dz: number };

/**
 * A trace under way for one spot, in phases that each go a few states at a
 * time: back over the steps of the cheapest walks, forward over them in an
 * order where every step's start comes before its end, counting corners,
 * then the chosen walk's steps, then its pieces. `steps` is null past
 * MAX_TRACED, for the first arrival's walk.
 */
type TraceJob = {
  target: number;
  phase: "back" | "forward" | "walk" | "pieces" | "done";
  q: number;
  index: Map<number, number>;
  states: number[];
  goals: number[];
  start: number;
  edges: TraceEdge[];
  into: number[][];
  out: number[][];
  waiting: number[];
  ready: number[];
  corners: Float64Array | null;
  len: Float64Array | null;
  prev: Int32Array | null;
  via: Int32Array | null;
  at: number;
  steps: WalkSteps;
  pieces: PieceBuilder | null;
  route: WalkRoute | null;
};

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
  /** States at the starting vertical residue, by node and horizontal residue. Others by key. */
  readonly #dense: Int32Array;
  readonly #sparse = new Map<number, number>();
  /** The first state settled at each node: the cheapest way there. */
  readonly #best: Int32Array;
  #heap = new Heap();
  #capped = false;
  /** Each traced spot's walk, by node. */
  readonly #routes = new Map<number, WalkRoute>();
  /**
   * The trace under way. One at a time, and never thrown away: asked for
   * another spot first, it is finished in that caller's slices, and kept,
   * before the next begins, so two rulers on one search never undo each
   * other's progress (review ASTRA-12). A drag's finger gone on to another
   * spot pays at most the one trace it left.
   */
  #job: TraceJob | null = null;
  readonly #traced: number;
  readonly #clock: () => number;
  /** Units of work done, a state settled or traced or a lattice step checked: the deterministic measure of a slice, for tests. */
  work = 0;
  #toH = 0;
  #toV = 0;
  #toCost = 0;
  /** Nodes with a state off the starting vertical residue, so a trace looks them up by key only there. */
  readonly #offResidue: Uint8Array;

  /** `traced` lowers MAX_TRACED, and `clock` stands for `performance.now`, for tests. */
  constructor(world: WalkWorld, traced = MAX_TRACED, clock: () => number = () => performance.now()) {
    this.world = world;
    this.#traced = traced;
    this.#clock = clock;
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
    this.#offResidue = new Uint8Array(this.#fiveTen ? nodes : 0);
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
      if (deadline !== Infinity && ++polled % 256 === 0 && this.#clock() > deadline) return "paused";
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
      if (deadline !== Infinity && ++polled % 256 === 0 && this.#clock() > deadline) return "paused";
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
    this.work++;
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
      if (!world.seenAt(bx, by, b) || !world.wallsClear(a, d, b)) continue;
      const eb = world.elevationAt(b);
      const { extra, swim } = world.extraOf(ax, ay, bx, by, eb, b);
      this.#relax(s, b, d, extra, swim, eb - ea);
    }
  }

  /** The residues and the cost a step from state `s` in direction `d` reaches, left in `#toH`, `#toV` and `#toCost` so the hot loop makes no objects. */
  #advance(s: number, d: number, extra: number, dzFt: number): void {
    const diagonal = d >= 4;
    const Z = Math.round(Math.abs(dzFt) * 2);
    let h = this.#h[s]!;
    let v = this.#v[s]!;
    let step: number;
    if (this.#euclid) {
      const L = this.world.L;
      const fpc = this.world.input.rules.feetPerCell;
      step = trueLength(L, diagonal ? L : 0, Math.abs(dzFt) / fpc) * fpc;
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
    this.#toH = h;
    this.#toV = v;
    this.#toCost = this.#cost[s]! + step * (1 + extra);
  }

  #relax(s: number, b: number, d: number, extra: number, swim: 0 | 1, dzFt: number): void {
    const diagonal = d >= 4;
    this.#advance(s, d, extra, dzFt);
    const h = this.#toH;
    const v = this.#toV;
    const cost = this.#toCost;
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
      this.#offResidue[node] = 1;
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
   * route is pulled taut (5.4). The whole trace at once: a drag and a
   * ruler use `traceTo` a slice at a time.
   */
  routeTo(to: Point): WalkRoute | null {
    const route = this.traceTo(to);
    return route === "paused" ? null : route;
  }

  /**
   * `routeTo` within a time slice, as `settle` runs (review ASTRA-08):
   * every phase from the trace to the last piece, true distance's pulling
   * taut included, pauses past `deadline`, and asked again it goes on where
   * it stopped. Its answer is the same however it was sliced. Once a spot is
   * traced its walk is kept, so the finger's every return to it and a
   * ruler's every frame reuse it.
   */
  traceTo(to: Point, deadline = Infinity): WalkRoute | null | "paused" {
    const n = this.world.nodeAt(to);
    if (n < 0 || this.#best[n]! < 0) return null;
    const known = this.#routes.get(n);
    if (known) return known;
    const late = this.#lateness(deadline);
    // Another spot's trace under way is finished first, never thrown away.
    if (this.#job && this.#job.target !== n) {
      if (!this.#runTrace(this.#job, late)) return "paused";
      this.#routes.set(this.#job.target, this.#job.route!);
      this.#job = null;
    }
    this.#job ??= this.#startTrace(n);
    if (!this.#runTrace(this.#job, late)) return "paused";
    const route = this.#job.route!;
    this.#job = null;
    this.#routes.set(n, route);
    return route;
  }

  /** A slice's clock: each call counts `units` of work, and every 16 or more units it says whether `deadline` has passed. */
  #lateness(deadline: number): (units?: number) => boolean {
    let since = 0;
    return (units = 1) => {
      this.work += units;
      since += units;
      if (deadline === Infinity || since < 16) return false;
      since = 0;
      return this.#clock() > deadline;
    };
  }

  /*
   * The walk to a settled node with the fewest corners, then the shortest
   * length on the map, among all its cheapest walks (5.3). The search keeps
   * one state per node and residues, so two equal arrivals from different
   * directions keep only the first, and the one dropped may have bent less
   * on the way on. So the trace looks again over every step that keeps the
   * cost exact, the steps of some cheapest walk, back from the node, then
   * forward from the start, counting corners by the direction each step
   * arrives from. It leaves the search as it was. Past MAX_TRACED states it
   * gives up for the first arrival's walk.
   */
  #startTrace(target: number): TraceJob {
    const goalCost = this.#cost[this.#best[target]!]!;
    const job: TraceJob = { target, phase: "back", q: 0, index: new Map(), states: [], goals: [], start: -1, edges: [], into: [], out: [], waiting: [], ready: [], corners: null, len: null, prev: null, via: null, at: -1, steps: { nodes: [], dir: [], extra: [], swim: [], dz: [] }, pieces: null, route: null };
    // Every state at the spot as cheap as the first settled there, settled or not: once all cheaper states are settled their costs are final, so the trace is the same however far the search has run.
    for (const s of this.#statesAt(target)) if (this.#cost[s] === goalCost) job.goals.push(this.#traceAdd(job, s));
    return job;
  }

  #traceAdd(job: TraceJob, s: number): number {
    const known = job.index.get(s);
    if (known !== undefined) return known;
    const k = job.states.length;
    job.index.set(s, k);
    job.states.push(s);
    job.into.push([]);
    job.out.push([]);
    job.waiting.push(0);
    if (this.#parent[s] === -1) job.start = k;
    return k;
  }

  /** Runs a trace until it is done (true) or its slice is over (false). */
  #runTrace(job: TraceJob, late: (units?: number) => boolean): boolean {
    if (job.phase === "back") {
      for (; job.q < job.states.length; job.q++) {
        if (job.states.length > this.#traced) {
          this.#walkFrom(job, -1);
          break;
        }
        if (late()) return false;
        this.#traceBack(job, job.q);
        // Every step into a state is found as the trace reaches it, so its count of steps to wait for is final here.
        if (job.waiting[job.q] === 0) job.ready.push(job.q);
      }
      if (job.phase === "back") {
        if (job.start < 0) {
          this.#walkFrom(job, -1);
        } else {
          const m = job.states.length;
          job.corners = new Float64Array(m * 9).fill(Infinity);
          job.len = new Float64Array(m * 9).fill(Infinity);
          job.prev = new Int32Array(m * 9).fill(-1);
          job.via = new Int32Array(m * 9).fill(-1);
          job.phase = "forward";
          job.q = 0;
        }
      }
    }
    // Forward, each state once every state with a step into it is done, an order with no sort to pay at once: the fewest corners and then the shortest length into each state by each direction it can arrive from, 8 standing for the start.
    if (job.phase === "forward") {
      const corners = job.corners!;
      const len = job.len!;
      const prev = job.prev!;
      const via = job.via!;
      for (; job.q < job.ready.length; job.q++) {
        if (late()) return false;
        const k = job.ready[job.q]!;
        if (k === job.start) {
          corners[k * 9 + 8] = 0;
          len[k * 9 + 8] = 0;
        }
        for (const e of job.into[k]!) {
          const edge = job.edges[e]!;
          const from = edge.from;
          const step = (edge.d >= 4 ? Math.SQRT2 : 1) * this.world.L;
          for (let dd = 0; dd < 9; dd++) {
            const c0 = corners[from * 9 + dd]!;
            if (c0 === Infinity) continue;
            const c = c0 + (dd !== 8 && dd !== edge.d ? 1 : 0);
            const l = len[from * 9 + dd]! + step;
            const at = k * 9 + edge.d;
            if (c < corners[at]! || (c === corners[at]! && l < len[at]!)) {
              corners[at] = c;
              len[at] = l;
              prev[at] = from * 9 + dd;
              via[at] = e;
            }
          }
        }
        for (const e of job.out[k]!) {
          const to = job.edges[e]!.to;
          if (--job.waiting[to]! === 0) job.ready.push(to);
        }
      }
      // The goal state and arrival with the fewest corners, then the shortest length.
      let end = -1;
      for (const k of job.goals) {
        for (let dd = 0; dd < 9; dd++) {
          const at = k * 9 + dd;
          if (corners[at] === Infinity) continue;
          if (end < 0 || corners[at]! < corners[end]! || (corners[at] === corners[end] && len[at]! < len[end]!)) end = at;
        }
      }
      this.#walkFrom(job, end);
    }
    // The chosen walk's steps, back from the goal: by the trace's labels, or past MAX_TRACED by the search's own first arrivals.
    if (job.phase === "walk") {
      const walk = job.steps;
      for (; job.at >= 0; job.at = job.corners ? job.prev![job.at]! : this.#parent[job.at]!) {
        if (late()) return false;
        if (job.corners) {
          const v = job.via![job.at]!;
          const edge = v >= 0 ? job.edges[v]! : null;
          walk.nodes.push(this.#node[job.states[Math.floor(job.at / 9)]!]!);
          walk.dir.push(edge ? edge.d : -1);
          walk.extra.push(edge ? edge.extra : 0);
          walk.swim.push(edge ? edge.swim : 0);
          walk.dz.push(edge ? edge.dz : 0);
        } else {
          const s = job.at;
          const start = this.#parent[s] === -1;
          walk.nodes.push(this.#node[s]!);
          walk.dir.push(start ? -1 : this.#dir[s]!);
          walk.extra.push(start ? 0 : this.#extra[s]!);
          walk.swim.push(start ? 0 : this.#swim[s]!);
          walk.dz.push(start ? 0 : this.#dz[s]!);
        }
      }
      walk.nodes.reverse();
      walk.dir.reverse();
      walk.extra.reverse();
      walk.swim.reverse();
      walk.dz.reverse();
      job.pieces = new PieceBuilder(this.world, walk);
      job.phase = "pieces";
    }
    if (job.phase === "pieces") {
      const route = job.pieces!.run(late);
      if (!route) return false;
      job.route = route;
      job.phase = "done";
    }
    return true;
  }

  /** Starts the walk phase at a trace label, or with none (-1) at the search's own arrival. */
  #walkFrom(job: TraceJob, end: number): void {
    job.phase = "walk";
    if (end < 0) {
      job.corners = null;
      job.at = this.#best[job.target]!;
    } else {
      job.at = end;
    }
  }

  /** One state of the back phase: every settled state with a step into it that keeps its cost exact. */
  #traceBack(job: TraceJob, toK: number): void {
    const world = this.world;
    const t = job.states[toK]!;
    const b = this.#node[t]!;
    const bx = world.xOf(b);
    const by = world.yOf(b);
    if (!world.seenAt(bx, by, b)) return;
    const eb = world.elevationAt(b);
    const bi = b % world.nx;
    const bj = Math.floor(b / world.nx);
    for (let d = 0; d < 8; d++) {
      const ai = bi - DX[d]!;
      const aj = bj - DY[d]!;
      if (ai < 0 || aj < 0 || ai >= world.nx || aj >= world.ny) continue;
      const a = aj * world.nx + ai;
      const from = this.#statesAt(a).filter((s) => this.#done[s] === 1 && this.#cost[s]! < this.#cost[t]!);
      if (from.length === 0 || !world.wallsClear(a, d, b)) continue;
      const ax = world.xOf(a);
      const ay = world.yOf(a);
      const ea = world.elevationAt(a);
      const stops = world.endOnly(ax, ay, ea);
      const { extra, swim } = world.extraOf(ax, ay, bx, by, eb, b);
      for (const s of from) {
        if (stops && this.#parent[s] !== -1) continue;
        this.#advance(s, d, extra, eb - ea);
        if (this.#toH !== this.#h[t] || this.#toV !== this.#v[t] || this.#toCost !== this.#cost[t]) continue;
        const fromK = this.#traceAdd(job, s);
        const e = job.edges.length;
        job.edges.push({ from: fromK, to: toK, d, extra, swim, dz: Math.round((eb - ea) * 2) });
        job.into[toK]!.push(e);
        job.out[fromK]!.push(e);
        job.waiting[toK]!++;
      }
    }
  }

  /** Every state at a node: its horizontal residues at the starting vertical one, and the others where it has any. */
  #statesAt(node: number): number[] {
    const out: number[] = [];
    for (let h = 0; h < this.#hr; h++) {
      const s = this.#dense[node * this.#hr + h]!;
      if (s >= 0) out.push(s);
      if (this.#offResidue[node] !== 1) continue;
      for (let v = 0; v < 2 * this.#S; v++) {
        if (v === this.#v0) continue;
        const found = this.#sparse.get((node * this.#hr + h) * 2 * this.#S + v);
        if (found !== undefined) out.push(found);
      }
    }
    return out;
  }

}

/**
 * A walk's pieces (5.2, 5.4), from its steps, built a few steps at a time
 * so a slice can stop between any two. On the grid rules a piece runs while the direction, the
 * extra, the swimming foot and the change of height per step stay the
 * same, a 5-10-5 diagonal that climbs alone. Under true distance it runs
 * from each corner to the farthest later step reachable by an allowed
 * straight leg along which every step pays the same public extra and the
 * ground keeps its height, so a walk round a wall's corner reads its true
 * length and a walk across rubble has corners where the rubble starts and
 * ends.
 */
export class PieceBuilder {
  readonly #world: WalkWorld;
  readonly #steps: WalkSteps;
  readonly #fiveTen: boolean;
  readonly #euclid: boolean;
  readonly #points: RoutePoint[];
  readonly #pieces: RoutePiece[] = [];
  // The grid rules' place.
  #k = 1;
  #key = "";
  #alone = false;
  // True distance's place: the corner a piece runs from, the farthest step found, the next to try and the misses since.
  #i = 0;
  #j = -1;
  #best = 0;
  #misses = 0;

  constructor(world: WalkWorld, steps: WalkSteps) {
    this.#world = world;
    this.#steps = steps;
    this.#fiveTen = world.input.rules.diagonal === "fiveTen";
    this.#euclid = world.input.rules.diagonal === "euclid";
    const first = steps.nodes[0]!;
    this.#points = [{ x: world.xOf(first), y: world.yOf(first), elevation: world.input.token.elevation }];
  }

  /** Builds until done, the route, or until `late` says the slice is over, null, to go on when asked again. */
  run(late: (units?: number) => boolean): WalkRoute | null {
    if (this.#euclid ? !this.#taut(late) : !this.#grid(late)) return null;
    const last = this.#points[this.#points.length - 1]!;
    return { pieces: this.#pieces, points: this.#points, endsBlocked: this.#world.endOnly(last.x, last.y, last.elevation) };
  }

  #spot(k: number): RoutePoint {
    const node = this.#steps.nodes[k]!;
    return { x: this.#world.xOf(node), y: this.#world.yOf(node), elevation: this.#world.elevationAt(node) };
  }

  #grid(late: (units?: number) => boolean): boolean {
    const walk = this.#steps;
    for (; this.#k < walk.nodes.length; this.#k++) {
      if (late()) return false;
      const k = this.#k;
      const d = walk.dir[k]!;
      const climbs = this.#fiveTen && d >= 4 && walk.dz[k] !== 0;
      const next = `${d},${walk.extra[k]},${walk.swim[k]},${walk.dz[k]}`;
      const p = this.#spot(k);
      if (k > 1 && next === this.#key && !this.#alone && !climbs) {
        this.#points[this.#points.length - 1] = p;
        const last = this.#pieces[this.#pieces.length - 1]!;
        this.#pieces[this.#pieces.length - 1] = [p.x, p.y, last[2], last[3]];
      } else {
        this.#points.push(p);
        this.#pieces.push([p.x, p.y, walk.extra[k]!, walk.swim[k] === 1 ? 1 : 0]);
      }
      this.#key = next;
      this.#alone = climbs;
    }
    return true;
  }

  #taut(late: (units?: number) => boolean): boolean {
    const walk = this.#steps;
    const n = walk.nodes.length;
    while (this.#i < n - 1) {
      const i = this.#i;
      const e = walk.extra[i + 1]!;
      const w = walk.swim[i + 1]!;
      if (this.#j < 0) {
        if (late()) return false;
        this.#best = i + 1;
        this.#misses = 0;
        this.#j = i + 2;
      }
      const from = this.#spot(i);
      for (; this.#j < n; this.#j++) {
        const j = this.#j;
        if (walk.extra[j] !== e || walk.swim[j] !== w || walk.dz[j] !== 0 || walk.dz[i + 1] !== 0) break;
        const { holds, steps } = straightHolds(this.#world, from, this.#spot(j), e, w);
        if (holds) {
          this.#best = j;
          this.#misses = 0;
        } else if (++this.#misses > 16) break;
        // One straight leg is checked whole, at most the scene's width in lattice steps, and counted as its steps.
        if (late(steps)) {
          this.#j++;
          return false;
        }
      }
      const to = this.#spot(this.#best);
      this.#points.push(to);
      this.#pieces.push([to.x, to.y, e, w === 1 ? 1 : 0]);
      this.#i = this.#best;
      this.#j = -1;
    }
    return true;
  }
}

/** Whether the straight leg from A to B is a piece: clear of walls, on seen ground, and every lattice step along it paying `extra`. `steps` is how many lattice steps it looked at. */
function straightHolds(world: WalkWorld, a: RoutePoint, b: RoutePoint, extra: number, swim: number): { holds: boolean; steps: number } {
  if (world.tester && !world.tester.clear(a.x, a.y, b.x, b.y)) return { holds: false, steps: 1 };
  const L = world.L;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / L - EPS));
  let px = a.x;
  let py = a.y;
  for (let k = 1; k <= n; k++) {
    const x = k === n ? b.x : a.x + Math.round(((b.x - a.x) * k) / n / L) * L;
    const y = k === n ? b.y : a.y + Math.round(((b.y - a.y) * k) / n / L) * L;
    if (x === px && y === py) continue;
    const fail = { holds: false, steps: k };
    if (!world.seenAt(x, y)) return fail;
    const node = world.nodeAt({ x, y });
    if (node < 0) return fail;
    const e = world.elevationAt(node);
    if (e !== a.elevation || (k < n && world.endOnly(x, y, e))) return fail;
    const step = world.extraOf(px, py, x, y, e, node);
    if (step.extra !== extra || step.swim !== swim) return fail;
    px = x;
    py = y;
  }
  return { holds: true, steps: n };
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
 *
 * The straight leg counts only the change of height between its ends,
 * while a walk counts each piece's (4.6). So the ground must also rise or
 * fall evenly all the way, as one piece of the search would: a walk over a
 * rise and down again, or up a step partway, is searched. Under 5-10-5 a
 * diagonal that climbs is a piece of its own, so it holds for one step only.
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
  // Off the eight directions the samples are not lattice steps, so only level ground keeps one rise per step.
  const even = exact ? (n === 1 || world.input.rules.diagonal !== "fiveTen" || Math.abs(dx) < EPS || Math.abs(dy) < EPS ? "slope" : "level") : "level";
  let rise: number | null = null;
  let px = token.x;
  let py = token.y;
  let pe = token.elevation;
  for (let k = 1; k <= n; k++) {
    const x = k === n ? to.x : token.x + (exact ? (dx * k) / n : Math.round((dx * k) / n / L) * L);
    const y = k === n ? to.y : token.y + (exact ? (dy * k) / n : Math.round((dy * k) / n / L) * L);
    if (x === px && y === py) continue;
    const node = world.nodeAt({ x, y });
    const e = node >= 0 ? world.elevationAt(node) : pe;
    const dz = e - pe;
    if (even === "level" ? Math.abs(dz) > EPS : rise !== null && Math.abs(dz - rise) > EPS) return false;
    rise = dz;
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
