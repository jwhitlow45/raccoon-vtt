import type { BuildChunk } from "../model.ts";
import { CHUNK_CELLS } from "../model.ts";
import { canSqueeze, footprintSize, hexSqueezedSize, sizeCategory, tokenHeightFt, type SizeCategory } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { isHex, sceneGrid } from "./grid.ts";
import { hexCenter, hexDistance, hexInScene, hexNeighbors, hexSubcells, sceneHexSpan, type Hex, type HexGrid } from "./hex.ts";
import { footing, type Standing } from "./heights.ts";
import {
  hexEdgeState,
  hexEndStand,
  hexFitWall,
  hexLegOf,
  hexLegStop,
  hexNarrow,
  hexRestand,
  hexStandAt,
  hexStandHexes,
  hexStandPlace,
  hexStartStand,
  hexWallsOf,
  walkFrom,
  type HexStand,
  type HexWalls,
} from "./movement.ts";
import type { RoutePiece, RoutePoint } from "./route.ts";
import { LegCheck, MAX_SETTLED, WalkSearch, WalkWorld, WorkBudget, worldUnits, type SettleResult, type Slice, type WalkInput, type WalkRoute } from "./walk.ts";

/**
 * Finding the way a creature walks on a hex scene (docs/design-v1-hex-grids.md
 * phase H2): walk.ts's search on the six-neighbor anchor lattice. A node
 * is a reference hex and whether the creature squeezes there (movement.ts
 * HexStand). A step goes to one of the six neighbors at the same squeeze
 * when HX-D8 allows it, and a creature that can squeeze changes between
 * full and squeezed in place for nothing, the squeezed hexes of a
 * reference hex lying among the full ones, standing up only where the full
 * footprint fits. Each step costs one hex times one plus its extra, which
 * the square search's rules give (docs/design-v1-movement.md 4.1): ground
 * difficult or under a slowing area newly entered, another creature's
 * space where heights overlap, a squeezed step (HX-D17), crawling and
 * dragging. Hex scenes hold no heights, painted ground or water until H3,
 * so a walk keeps its elevation and nothing swims.
 *
 * The client calls it through `routeWorld`, `routeSearch` and
 * `routeLegCheck`, which hand a square scene to walk.ts unchanged, so a
 * drag, an arrow key and the walking ruler run the same work either way.
 * A found walk becomes pieces each the hex line between its ends, as the
 * server walks a piece (route.ts hexPiece), so its spots and its checks
 * read the very hexes the search did.
 */

const SEEN_KNOWN = 1;
const SEEN = 2;
const DIFFICULT = 4;
const QUARTER = 8;

/** How a node was reached: by a step in one of the six directions, in place by a squeeze or standing up, or not at all (the start). */
const IN_PLACE = 6;
const START = 7;

export class HexWalkWorld {
  readonly input: WalkInput;
  readonly g: HexGrid;
  /** The movement set to test steps against, or null on a scene that stops no moves. */
  readonly walls: HexWalls | null;
  /** The index space of reference hexes: the columns and rows the scene's hex keys run over. */
  readonly cols: number;
  readonly rows: number;
  /** The lattice's size for the budget's charges, as walk.ts's world has it. */
  readonly nx: number;
  readonly ny: number;
  /** Dragged creatures are attach's on hexes (HX-7): this search walks the mover alone. */
  readonly tows = false;
  readonly full: SizeCategory;
  readonly small: SizeCategory | null;
  readonly start: HexStand;
  readonly startNode: number;
  readonly mode: Standing;
  readonly elevation: number;
  readonly height: number;
  readonly #bounds: { w: number; h: number };
  readonly #edges: Uint8Array;
  readonly #flags: Uint8Array;
  readonly #fit: Uint8Array;
  readonly #byHex = new Map<number, number[]>();
  /** The scene's walls for the narrow space test, which a squeeze needs even where they stop no moves. */
  readonly #narrowWalls: HexWalls | null;

  constructor(input: WalkInput) {
    this.input = input;
    const { token, build } = input;
    const scene = build.scenes[token.sceneId]!;
    const g = sceneGrid(scene);
    if (!isHex(g)) throw new Error("a hex walk on a square scene");
    this.g = g;
    this.#bounds = scene.bounds;
    this.#narrowWalls = hexWallsOf(build, token);
    this.walls = scene.blockMovement === true ? this.#narrowWalls : null;
    const span = sceneHexSpan(g, scene.bounds);
    this.cols = span.cols;
    this.rows = span.rows;
    this.nx = this.cols * 2;
    this.ny = this.rows;
    this.full = sizeCategory(token);
    this.small = canSqueeze(token) ? hexSqueezedSize(this.full) : null;
    this.start = hexStartStand(g, token);
    this.startNode = this.nodeOf(this.start);
    const walking = walkFrom(build.buildChunks, token);
    this.mode = footing(build.buildChunks, walking);
    this.elevation = walking.elevation;
    this.height = tokenHeightFt(token, input.rules.feetPerCell);
    const hexes = this.cols * this.rows;
    this.#edges = new Uint8Array(hexes * 6);
    this.#flags = new Uint8Array(hexes);
    this.#fit = new Uint8Array(hexes * 2);
    if (this.mode === "ground") this.#markGround(scene.id);
    if (this.mode !== "inside") {
      for (const [n, c] of input.creatures.entries()) {
        for (const key of c.hexes ?? []) {
          const [col, row] = key.split(",").map(Number) as [number, number];
          const i = this.#index({ col, row });
          if (i < 0) continue;
          const list = this.#byHex.get(i);
          if (list) list.push(n);
          else this.#byHex.set(i, [n]);
        }
      }
    }
  }

  /** Difficult ground by hex keys in the scene's chunks (docs/design-v1-movement.md 6.3), and the areas that slow a walk, on seen ground only. */
  #markGround(sceneId: string): void {
    for (const chunk of Object.values(this.input.build.buildChunks) as (BuildChunk | undefined)[]) {
      if (!chunk || chunk.sceneId !== sceneId || !chunk.rough) continue;
      for (let k = 0; k < chunk.rough.length; k++) {
        if (chunk.rough[k] !== "d") continue;
        const i = this.#index({ col: chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS), row: chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS) });
        if (i >= 0) this.#flags[i]! |= DIFFICULT;
      }
    }
    for (const area of this.input.areas) {
      for (const { x, y } of area.cells) {
        const i = this.#index({ col: x, row: y });
        if (i >= 0) this.#flags[i]! |= area.extra === 3 ? QUARTER : DIFFICULT;
      }
    }
  }

  #index(h: Hex): number {
    return h.col < 0 || h.row < 0 || h.col >= this.cols || h.row >= this.rows ? -1 : h.row * this.cols + h.col;
  }

  #hexAt(i: number): Hex {
    return { col: i % this.cols, row: Math.floor(i / this.cols) };
  }

  /** A stand's node, or -1 when its reference hex lies outside the index. */
  nodeOf(s: Pick<HexStand, "ref" | "squeezed">): number {
    const i = this.#index(s.ref);
    return i < 0 ? -1 : i * 2 + (s.squeezed ? 1 : 0);
  }

  standOf(node: number): HexStand {
    const squeezed = (node & 1) === 1;
    return { size: squeezed ? this.small! : this.full, ref: this.#hexAt(node >> 1), squeezed };
  }

  /** The node of the stand a drop at `p` aims at, as the leg there reads it (movement.ts hexEndStand). */
  nodeAt(p: Point): number {
    return this.nodeOf(hexEndStand(this.g, this.input.token, p));
  }

  /** Where a stand puts the creature's stored box. */
  place(s: HexStand): Point {
    return hexStandPlace(this.g, this.input.token, s);
  }

  /** Whether every hex of a stand lies inside the scene and on ground the search may read. */
  standable(s: Pick<HexStand, "size" | "ref">): boolean {
    for (const h of hexStandHexes(this.g, s)) {
      const i = this.#index(h);
      if (i < 0 || !this.#seen(i, h)) return false;
    }
    return hexStandHexes(this.g, s).length > 0 && this.#inside(s);
  }

  #inside(s: Pick<HexStand, "size" | "ref">): boolean {
    return hexStandHexes(this.g, s).every((h) => this.#index(h) >= 0 && hexInScene(this.g, this.#bounds, h));
  }

  /** A hex is on ground the search reads where any fog sub-cell of it is, as a creature on it is seen by any (HX-D10). */
  #seen(i: number, h: Hex): boolean {
    const { seen, seenSub } = this.input;
    if (!seen && !seenSub) return true;
    const f = this.#flags[i]!;
    if (f & SEEN_KNOWN) return (f & SEEN) !== 0;
    const c = hexCenter(this.g, h);
    const yes = seenSub ? hexSubcells(this.g, h).some(([sx, sy]) => seenSub(sx, sy)) : seen!(Math.floor(c.x), Math.floor(c.y));
    this.#flags[i]! |= SEEN_KNOWN | (yes ? SEEN : 0);
    return yes;
  }

  /** The segment from a hex's center to its neighbor's in direction `d` (movement.ts hexEdgeState), kept per hex inside the index. */
  #edge(h: Hex, d: number): 1 | 2 | 3 {
    const walls = this.walls!;
    const i = this.#index(h);
    if (i < 0) return hexEdgeState(walls, h, d);
    const known = this.#edges[i * 6 + d]!;
    if (known !== 0) return known as 1 | 2 | 3;
    const state = hexEdgeState(walls, h, d);
    this.#edges[i * 6 + d] = state;
    return state;
  }

  /** Whether a stand's footprint fits between the walls (HX-D8). */
  fits(s: HexStand): boolean {
    if (!this.walls) return true;
    const node = this.nodeOf(s);
    if (node >= 0 && this.#fit[node] !== 0) return this.#fit[node] === 1;
    const hexes = hexStandHexes(this.g, s);
    const keys = new Set(hexes.map((h) => `${h.col},${h.row}`));
    let ok = true;
    for (const h of hexes) {
      const around = hexNeighbors(this.g, h);
      for (let d = 0; d < 3 && ok; d++) if (keys.has(`${around[d]!.col},${around[d]!.row}`) && this.#edge(h, d) !== 1) ok = false;
      if (!ok) break;
    }
    if (node >= 0) this.#fit[node] = ok ? 1 : 2;
    return ok;
  }

  /** Whether a full footprint fits between the scene's walls, stopping moves or not, as the landing reads it: no squeeze is tried there. */
  #fitsAnyway(s: HexStand): boolean {
    return this.walls ? this.fits(s) : !this.#narrowWalls || hexFitWall(this.#narrowWalls, s) < 0;
  }

  /** Whether stand `a` steps in direction `d` to `b` (HX-D8): `b` standable and fitting, and no hex's step meets a wall, but one it leaves on a first step. */
  stepOk(a: HexStand, b: HexStand, d: number, first: boolean): boolean {
    if (!this.standable(b)) return false;
    if (!this.walls) return true;
    for (const h of hexStandHexes(this.g, a)) {
      const e = this.#edge(h, d);
      if (e === 2 || (e === 3 && !first)) return false;
    }
    return this.fits(b);
  }

  /** Whether the creature may stand up in place from a squeezed stand, or squeeze in place from a full one. */
  restandOk(to: HexStand): boolean {
    return this.standable(to) && (to.squeezed || this.fits(to));
  }

  /**
   * A step's extra feet per foot (docs/design-v1-movement.md 4.1): by
   * entry, on the hexes `b` holds that `a` does not, ground sources for a
   * walker alone (3 for a quarter-speed area, else 1 for difficult ground or
   * a slowing area), else another creature's space where heights overlap,
   * else a squeezed step, each 1 at most together, then crawling and
   * dragging on top.
   */
  extraOf(a: HexStand, b: HexStand): number {
    const { prone, drag } = this.input;
    if (this.mode === "inside") return drag ?? 0;
    const before = new Set(hexStandHexes(this.g, a).map((h) => `${h.col},${h.row}`));
    const entered = hexStandHexes(this.g, b).filter((h) => !before.has(`${h.col},${h.row}`));
    let ground = 0;
    if (this.mode === "ground") {
      for (const h of entered) {
        const f = this.#flags[this.#index(h)] ?? 0;
        if (f & QUARTER) ground = 3;
        else if (f & DIFFICULT) ground = Math.max(ground, 1);
      }
    }
    if (ground < 1) {
      for (const h of entered) {
        for (const c of this.#creaturesOn(h)) if (c.way !== "free" && this.#overlaps(c)) ground = 1;
      }
    }
    if (ground < 1 && b.squeezed) ground = 1;
    return ground + (prone ? 1 : 0) + (drag ?? 0);
  }

  #creaturesOn(h: Hex): WalkInput["creatures"][number][] {
    const list = this.#byHex.get(this.#index(h));
    return list ? list.map((n) => this.input.creatures[n]!) : [];
  }

  #overlaps(c: { lo: number; hi: number }): boolean {
    return c.lo < this.elevation + this.height && this.elevation < c.hi;
  }

  /** Whether a walk may end at a stand but never go on from it: over a creature it cannot pass whose height it shares. */
  endOnly(s: HexStand): boolean {
    if (this.mode === "inside") return false;
    return hexStandHexes(this.g, s).some((h) => this.#creaturesOn(h).some((c) => c.way === "blocked" && this.#overlaps(c)));
  }

  /** What the creature drags beside it never holds it back here (`tows`). */
  cannotFollow(_points: readonly Point[]): string | null {
    return null;
  }

  /**
   * The stands a drop at `to` may end at, in the order a search tries
   * them: the stand there when it fits, else the squeezed stands within
   * its footprint that are real narrow spaces (HX-D17), nearest its middle
   * first, as a drop's landing tries them (movement.ts hexLanding).
   */
  ends(to: Point): HexStand[] {
    const g = this.g;
    const aimed = hexEndStand(g, this.input.token, to);
    // A squeeze is judged by the walls whether or not they stop moves here, as the drop's landing judges it (movement.ts landing).
    const walls = this.#narrowWalls;
    if (aimed.squeezed) return walls && hexNarrow(walls, this.input.token, aimed) && this.standable(aimed) ? [aimed] : [];
    // Where the full footprint fits the drop lands on it, as the landing does, even off the scene, where no walk reaches it.
    if (this.#fitsAnyway(aimed)) return [aimed];
    if (!this.small || !walls) return [];
    const token = this.input.token;
    const within = hexStandHexes(g, aimed);
    const holds = (s: HexStand) => hexStandHexes(g, s).every((h) => within.some((f) => f.col === h.col && f.row === h.row));
    const { w, h } = footprintSize(token);
    const mid = { x: to.x + w / 2, y: to.y + h / 2 };
    return within
      .map((ref) => hexRestand(token, { ...aimed, ref }, true))
      .filter((s) => holds(s) && this.standable(s) && hexNarrow(walls, token, s))
      .map((s) => {
        const p = this.place(s);
        const dx = p.x + w / 2 - mid.x;
        const dy = p.y + h / 2 - mid.y;
        return { s, d: dx * dx + dy * dy };
      })
      .sort((a, b) => a.d - b.d || a.s.ref.row - b.s.ref.row || a.s.ref.col - b.s.ref.col)
      .map((e) => e.s);
  }

  /**
   * A walk's nodes as route pieces (docs/design-v1-movement.md 5.2, "Pieces"),
   * each the hex line between its ends that the server walks (route.ts
   * hexPiece): from each corner the piece runs to the farthest later node
   * whose hex line takes as many steps as the walk did, every step of it
   * allowed at the extra the walk paid, at the size the walk squeezed at
   * between them. So a walk across open hexes that zigzags is one piece,
   * and every piece costs what the walk did. `charge` counts the checks.
   */
  piecesOf(nodes: readonly number[], via: readonly number[], extras: readonly number[], charge: (units?: number) => void = () => {}): { pieces: RoutePiece[]; points: RoutePoint[] } {
    const pieces: RoutePiece[] = [];
    const points: RoutePoint[] = [{ x: this.input.token.x, y: this.input.token.y, elevation: this.elevation }];
    let i = 0;
    while (i < nodes.length - 1) {
      let j = i + 1;
      while (j + 1 < nodes.length && this.#pieceHolds(nodes, via, extras, i, j + 1, charge)) j++;
      const end = this.standOf(nodes[j]!);
      const at = this.place(end);
      pieces.push([at.x, at.y, this.#pieceExtra(via, extras, i, j), 0]);
      points.push({ x: at.x, y: at.y, elevation: this.elevation });
      i = j;
    }
    return { pieces, points };
  }

  /** The extra a piece pays: its first step's, every step of it the same. Zero for a piece that only squeezes or stands up in place. */
  #pieceExtra(via: readonly number[], extras: readonly number[], i: number, j: number): number {
    for (let k = i + 1; k <= j; k++) if (via[k] !== IN_PLACE) return extras[k]!;
    return 0;
  }

  #pieceHolds(nodes: readonly number[], via: readonly number[], extras: readonly number[], i: number, j: number, charge: (units?: number) => void): boolean {
    const a = this.standOf(nodes[i]!);
    const b = this.standOf(nodes[j]!);
    const squeezed = a.squeezed || b.squeezed;
    let steps = 0;
    let extra = -1;
    for (let k = i + 1; k <= j; k++) {
      if (k < j && this.standOf(nodes[k]!).squeezed !== squeezed) return false;
      if (via[k] === IN_PLACE) continue;
      steps++;
      if (extra === -1) extra = extras[k]!;
      else if (extras[k] !== extra) return false;
    }
    if (steps !== hexDistance(this.g, a.ref, b.ref)) return false;
    const leg = hexLegOf(this.g, a, b);
    const line = leg.line;
    charge(line.length);
    let from: HexStand = { size: leg.walk, ref: line[0]!, squeezed: leg.squeezed };
    for (let k = 1; k < line.length; k++) {
      const to: HexStand = { size: leg.walk, ref: line[k]!, squeezed: leg.squeezed };
      const d = hexNeighbors(this.g, from.ref).findIndex((n) => n.col === to.ref.col && n.row === to.ref.row);
      if (d < 0 || !this.stepOk(from, to, d, k === 1)) return false;
      if (this.extraOf(from, to) !== Math.max(0, extra)) return false;
      if (k < line.length - 1 && this.endOnly(to)) return false;
      from = to;
    }
    return true;
  }
}

/** A min-heap of nodes by cost, then corners, then the order they were pushed, so every device settles them alike. */
class Heap {
  #cost: number[] = [];
  #corners: number[] = [];
  #seq: number[] = [];
  #node: number[] = [];
  #n = 0;
  get size(): number {
    return this.#n;
  }
  push(node: number, cost: number, corners: number, seq: number): void {
    let i = this.#n++;
    this.#cost[i] = cost;
    this.#corners[i] = corners;
    this.#seq[i] = seq;
    this.#node[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }
  /** The least entry: its node, cost and corners. */
  pop(): { node: number; cost: number; corners: number } | null {
    if (this.#n === 0) return null;
    const out = { node: this.#node[0]!, cost: this.#cost[0]!, corners: this.#corners[0]! };
    this.#n--;
    if (this.#n > 0) {
      this.#swap(0, this.#n);
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
    return out;
  }
  #less(a: number, b: number): boolean {
    const ca = this.#cost[a]!;
    const cb = this.#cost[b]!;
    if (ca !== cb) return ca < cb;
    const ka = this.#corners[a]!;
    const kb = this.#corners[b]!;
    return ka !== kb ? ka < kb : this.#seq[a]! < this.#seq[b]!;
  }
  #swap(a: number, b: number): void {
    for (const arr of [this.#cost, this.#corners, this.#seq, this.#node]) {
      const t = arr[a]!;
      arr[a] = arr[b]!;
      arr[b] = t;
    }
  }
}

/**
 * The cheapest walks from where the creature stands (docs/design-v1-movement.md
 * 5.2): a uniform-cost search over the world's nodes, grown on demand,
 * by cost in hexes times their multipliers, then by corners, then by the
 * order found, so every device settles the same walk. Capped at
 * MAX_SETTLED nodes as the square search is.
 */
export class HexWalkSearch {
  readonly world: HexWalkWorld;
  settled = 0;
  readonly #cost: Float64Array;
  readonly #corners: Int32Array;
  readonly #parent: Int32Array;
  readonly #via: Uint8Array;
  readonly #heading: Int8Array;
  readonly #extra: Int8Array;
  readonly #done: Uint8Array;
  readonly #heap = new Heap();
  #seq = 0;
  readonly #ends = new Map<string, HexStand[]>();

  constructor(world: HexWalkWorld) {
    this.world = world;
    const n = world.cols * world.rows * 2;
    this.#cost = new Float64Array(n).fill(Infinity);
    this.#corners = new Int32Array(n);
    this.#parent = new Int32Array(n).fill(-1);
    this.#via = new Uint8Array(n);
    this.#heading = new Int8Array(n).fill(-1);
    this.#extra = new Int8Array(n);
    this.#done = new Uint8Array(n);
    const s = world.startNode;
    if (s >= 0) {
      this.#cost[s] = 0;
      this.#via[s] = START;
      this.#heap.push(s, 0, 0, this.#seq++);
    }
  }

  #endsOf(to: Point): HexStand[] {
    const key = `${to.x},${to.y}`;
    let ends = this.#ends.get(key);
    if (!ends) this.#ends.set(key, (ends = this.world.ends(to)));
    return ends;
  }

  /** The end a drop at `to` reaches, once settled: the first of its ends the search settled, the cheapest. */
  #reached(to: Point): number {
    let best = -1;
    for (const s of this.#endsOf(to)) {
      const n = this.world.nodeOf(s);
      if (n < 0 || this.#done[n] === 0) continue;
      if (best < 0 || this.#cost[n]! < this.#cost[best]!) best = n;
    }
    return best;
  }

  /** Settles nodes until an end of a drop at `to` is settled (walk.ts WalkSearch settle). */
  settle(to: Point, slice: Slice = Infinity): SettleResult {
    const ends = this.#endsOf(to).map((s) => this.world.nodeOf(s)).filter((n) => n >= 0);
    if (ends.length === 0) return "unreachable";
    const budget = typeof slice === "number" ? (slice === Infinity ? WorkBudget.all() : WorkBudget.until(slice)) : slice;
    while (!ends.some((n) => this.#done[n] === 1)) {
      if (this.settled >= MAX_SETTLED) return "capped";
      if (budget.spent) return "paused";
      const top = this.#heap.pop();
      if (!top) return "unreachable";
      if (this.#done[top.node] === 1 || top.cost !== this.#cost[top.node] || top.corners !== this.#corners[top.node]) continue;
      this.#settle(top.node);
      budget.charge();
    }
    return "settled";
  }

  #settle(a: number): void {
    const world = this.world;
    this.#done[a] = 1;
    this.settled++;
    const A = world.standOf(a);
    if (this.#via[a] !== START && world.endOnly(A)) return;
    // A leg's first step may leave a wall its hexes' centers touch, so the start and a squeeze or stand in place there step first.
    const first = this.#via[a] === START || (this.#via[a] === IN_PLACE && this.#via[this.#parent[a]!] === START);
    const neighbors = hexNeighbors(world.g, A.ref);
    for (let d = 0; d < 6; d++) {
      const B: HexStand = { size: A.size, ref: neighbors[d]!, squeezed: A.squeezed };
      const b = world.nodeOf(B);
      if (b < 0 || this.#done[b] === 1 || !world.stepOk(A, B, d, first)) continue;
      const extra = world.extraOf(A, B);
      const heading = this.#heading[a]!;
      this.#relax(a, b, this.#cost[a]! + 1 + extra, this.#corners[a]! + (heading >= 0 && heading !== d ? 1 : 0), d, d, extra);
    }
    if (world.small) {
      const B = hexRestand(world.input.token, A, !A.squeezed);
      const b = world.nodeOf(B);
      if (b >= 0 && this.#done[b] === 0 && world.restandOk(B)) this.#relax(a, b, this.#cost[a]!, this.#corners[a]!, IN_PLACE, this.#heading[a]!, 0);
    }
  }

  #relax(a: number, b: number, cost: number, corners: number, via: number, heading: number, extra: number): void {
    const known = this.#cost[b]!;
    if (cost > known || (cost === known && corners >= this.#corners[b]!)) return;
    this.#cost[b] = cost;
    this.#corners[b] = corners;
    this.#parent[b] = a;
    this.#via[b] = via;
    this.#heading[b] = heading;
    this.#extra[b] = extra;
    this.#heap.push(b, cost, corners, this.#seq++);
  }

  /** The settled walk to a drop at `to` as a route (walk.ts WalkSearch traceTo), null when the start is the end, or "paused" when the budget ran out. */
  traceTo(to: Point, slice: Slice = Infinity): WalkRoute | null | "paused" {
    const end = this.#reached(to);
    if (end < 0) return null;
    const budget = typeof slice === "number" ? (slice === Infinity ? WorkBudget.all() : WorkBudget.until(slice)) : slice;
    if (budget.spent) return "paused";
    const nodes: number[] = [];
    for (let n = end; n >= 0; n = this.#parent[n]!) nodes.push(n);
    nodes.reverse();
    if (nodes.length < 2) return null;
    const via = nodes.map((n) => this.#via[n]!);
    const extras = nodes.map((n) => this.#extra[n]!);
    const { pieces, points } = this.world.piecesOf(nodes, via, extras, (units = 1) => budget.charge(units));
    return { pieces, points, endsBlocked: this.world.endOnly(this.world.standOf(end)) };
  }

  /** The whole walk to `to`, searched to the end with no slices, or null when none reaches it. */
  routeTo(to: Point): WalkRoute | null {
    if (this.settle(to) !== "settled") return null;
    const route = this.traceTo(to);
    return route === "paused" ? null : route;
  }
}

/**
 * The straight leg on hexes as the client checks it before any search
 * (walk.ts LegCheck): `open` when the leg is allowed, every step of it
 * costs nothing extra and the walk never stands on a creature it cannot
 * pass short of its end, so the plain drop is the route. `stopped` when
 * the leg test stops it. With `route` asked for, the leg as route pieces,
 * its steps' extras as the search reads them, null where a step leaves
 * the scene or the ground the walk may read.
 */
export class HexLegCheck {
  readonly #world: HexWalkWorld;
  readonly #to: Point;
  readonly #wantRoute: boolean;
  #done = false;
  #open = true;
  #route: WalkRoute | null = null;
  stopped = false;

  constructor(world: HexWalkWorld, to: Point, route = false) {
    this.#world = world;
    this.#to = { x: to.x, y: to.y };
    this.#wantRoute = route;
  }

  get done(): boolean {
    return this.#done;
  }

  get open(): boolean {
    return this.#open;
  }

  get route(): WalkRoute | null {
    return this.#route;
  }

  /** The whole check is a few steps, so it runs to the end once `late` lets it start. */
  run(late: (units?: number) => boolean): boolean {
    if (this.#done) return true;
    if (late()) return false;
    const world = this.#world;
    const { token } = world.input;
    const to = this.#to;
    this.#done = true;
    if (to.x === token.x && to.y === token.y) return true;
    const leg = hexLegOf(world.g, world.start, hexEndStand(world.g, token, to));
    if (world.walls && hexLegStop(world.walls, leg) !== null) {
      this.stopped = true;
      this.#open = false;
    }
    late(leg.line.length);
    // The leg as the walk's nodes: a squeeze in place first, its steps at the size it walks at, and standing up in place last.
    const walking = (ref: Hex): HexStand => ({ size: leg.walk, ref, squeezed: leg.squeezed });
    const nodes: HexStand[] = [leg.from];
    const via: number[] = [START];
    if (leg.squeezed && !leg.from.squeezed) {
      nodes.push(walking(leg.line[0]!));
      via.push(IN_PLACE);
    }
    for (let k = 1; k < leg.line.length; k++) {
      const s = walking(leg.line[k]!);
      nodes.push(s);
      via.push(hexNeighbors(world.g, leg.line[k - 1]!).findIndex((n) => n.col === s.ref.col && n.row === s.ref.row));
    }
    if (leg.squeezed && !leg.to.squeezed) {
      nodes.push(leg.to);
      via.push(IN_PLACE);
    }
    const extras: number[] = [0];
    let inside = true;
    for (let k = 1; k < nodes.length; k++) {
      const a = nodes[k - 1]!;
      const b = nodes[k]!;
      if (via[k] === IN_PLACE) {
        extras.push(0);
        if (!world.restandOk(b)) inside = false;
        continue;
      }
      if (!world.standable(b)) inside = false;
      const extra = world.extraOf(a, b);
      extras.push(extra);
      if (extra !== 0) this.#open = false;
      if (k < nodes.length - 1 && world.endOnly(b)) this.#open = false;
    }
    if (!inside) this.#open = false;
    if (!this.#wantRoute || !inside || nodes.length < 2) return true;
    const ids = nodes.map((s) => world.nodeOf(s));
    if (ids.some((n) => n < 0)) return true;
    const { pieces, points } = world.piecesOf(ids, via, extras, late);
    // The leg's own end, not a stand placed for it, so the route ends where the drop does.
    const last = pieces[pieces.length - 1]!;
    pieces[pieces.length - 1] = [to.x, to.y, last[2], last[3]];
    points[points.length - 1] = { x: to.x, y: to.y, elevation: points[points.length - 1]!.elevation };
    this.#route = { pieces, points, endsBlocked: world.endOnly(leg.to) };
    return true;
  }
}

/** A route world for either grid: walk.ts's on squares, the hex world on hexes. */
export type RouteWorld = WalkWorld | HexWalkWorld;
export type RouteSearch = WalkSearch | HexWalkSearch;
export type RouteLegCheck = LegCheck | HexLegCheck;

/** Whether the walker's scene is hexes, so its walks are this file's. */
export function walksOnHexes(input: Pick<WalkInput, "build" | "token">): boolean {
  const scene = input.build.scenes[input.token.sceneId];
  return scene !== undefined && isHex(sceneGrid(scene));
}

export function routeWorld(input: WalkInput): RouteWorld {
  return walksOnHexes(input) ? new HexWalkWorld(input) : new WalkWorld(input);
}

export function routeSearch(world: RouteWorld): RouteSearch {
  return world instanceof HexWalkWorld ? new HexWalkSearch(world) : new WalkSearch(world);
}

export function routeLegCheck(world: RouteWorld, to: Point, route = false): RouteLegCheck {
  return world instanceof HexWalkWorld ? new HexLegCheck(world, to, route) : new LegCheck(world, to, route);
}

/** The units a world's build charges (walk.ts worldUnits): on hexes its index of reference hexes. */
export function routeWorldUnits(world: RouteWorld): number {
  return world instanceof HexWalkWorld ? Math.ceil((world.cols * world.rows) / 400) : worldUnits(world);
}

/** The straight leg to `to` as a route, checked whole, on either grid (walk.ts stepRoute). */
export function routeStep(world: RouteWorld, to: Point): WalkRoute | null {
  const check = routeLegCheck(world, to, true);
  check.run(() => false);
  return check.route;
}

/** The whole answer for one spot on either grid (walk.ts findRoute): null when the plain straight leg is the route, else the route, or "none". */
export function findRouteOn(input: WalkInput, to: Point): WalkRoute | null | "none" {
  const world = routeWorld(input);
  const check = routeLegCheck(world, to);
  check.run(() => false);
  if (check.open) return null;
  if (world instanceof HexWalkWorld) return new HexWalkSearch(world).routeTo(to) ?? "none";
  const search = new WalkSearch(world);
  return search.settle(to) === "settled" ? (search.routeTo(to) ?? "none") : "none";
}
