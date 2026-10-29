import type { BuildChunk } from "../model.ts";
import { CHUNK_CELLS } from "../model.ts";
import { canSqueeze, footprintSize, hexSqueezedSize, isSqueezed, sizeCategory, tokenHeightFt, type SizeCategory } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { isHex, sceneGrid } from "./grid.ts";
import { hexCenter, hexDistance, hexInScene, hexNeighbors, hexSubcells, sceneHexSpan, type Hex, type HexGrid } from "./hex.ts";
import { footing, hexesGround, standing, type Standing } from "./heights.ts";
import { legFeet } from "./distance.ts";
import {
  hexEdgeState,
  hexEndStand,
  hexFitWall,
  hexPairWall,
  hexLegOf,
  hexLegStop,
  hexNarrow,
  hexRestand,
  hexStandAt,
  hexStandHexes,
  hexStandPlace,
  hexStartStand,
  hexWallsOf,
  onSqueezedLattice,
  walkFrom,
  type HexStand,
  type HexWalls,
  type Walker,
} from "./movement.ts";
import { followedHeight, seatShift, type FollowLead, type Follower, type RoutePiece, type RoutePoint } from "./route.ts";
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
 * dragging, times the step's length with its rise by the room's rule, as
 * the square search counts a climb (from H3, a walker standing on the
 * ground of the hexes it takes). Ledges stop steps by the walker's floor
 * (movement.ts hexWallsOf). Hex scenes hold no painted ground or water,
 * so nothing swims.
 * Where walls stop moves, each creature it drags beside it takes every
 * step with it by the same rule, so a found way is one they all fit
 * through (docs/design-v1-attach.md 4.2).
 *
 * The client calls it through `routeWorld`, `routeSearch` and
 * `routeLegCheck`, which hand a square scene to walk.ts unchanged, so a
 * drag, an arrow key and the walking ruler run the same work either way.
 * A found walk becomes pieces each the hex line between its ends, as the
 * server walks a piece (route.ts hexPiece), so its spots and its checks
 * read the very hexes the search did.
 */

/** A creature the walker drags beside it (WalkInput `towed`), and its place beside the walker's stored box. */
type Towed = { walker: Walker & { id: string }; dx: number; dy: number };

/** Where the walker is when a dragged creature's height is read: its stored box, its stand there when known, and whether that is the walk's start. */
type LeadAt = { place: Point; stand: HexStand | null; start: boolean };

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
  /** A walker's ground per node, worked out when first asked. */
  readonly #ground: Float64Array;
  readonly #byHex = new Map<number, number[]>();
  /** The scene's walls for the narrow space test, which a squeeze needs even where they stop no moves. */
  readonly #narrowWalls: HexWalls | null;
  /** The creatures the walker drags beside it (WalkInput `towed`), each with its place beside the walker's stored box. */
  readonly #towed: readonly Towed[];
  /** Every creature the walk takes along, by id: the links a dragged creature's height follows (WalkInput `group`). */
  readonly #members: ReadonlyMap<string, Follower>;
  /** The walk its followers are read against (route.ts followedHeight). */
  readonly #lead: FollowLead;

  constructor(input: WalkInput) {
    this.input = input;
    const { token, build } = input;
    const scene = build.scenes[token.sceneId]!;
    const g = sceneGrid(scene);
    if (!isHex(g)) throw new Error("a hex walk on a square scene");
    this.g = g;
    this.#bounds = scene.bounds;
    const walking = walkFrom(build.buildChunks, token);
    this.#narrowWalls = hexWallsOf(build, walking);
    this.walls = scene.blockMovement === true ? this.#narrowWalls : null;
    // Only where walls stop moves, as the server tests them there alone (permissions.ts draggedWalls).
    this.#towed = this.walls ? (input.towed ?? []).map((t) => ({ walker: t, dx: t.x - token.x, dy: t.y - token.y })) : [];
    this.#members = new Map((input.group ?? input.towed ?? []).map((m) => [m.id, m]));
    const span = sceneHexSpan(g, scene.bounds);
    this.cols = span.cols;
    this.rows = span.rows;
    this.nx = this.cols * 2;
    this.ny = this.rows;
    this.full = sizeCategory(token);
    this.small = canSqueeze(token) ? hexSqueezedSize(this.full) : null;
    this.start = hexStartStand(g, token);
    this.startNode = this.nodeOf(this.start);
    this.mode = footing(build.buildChunks, walking);
    const lead: Walker & { id?: string } = token;
    this.#lead = { id: lead.id, elevation: token.elevation, grounded: this.mode === "ground" };
    this.elevation = walking.elevation;
    this.height = tokenHeightFt(token, input.rules.feetPerCell);
    const hexes = this.cols * this.rows;
    this.#edges = new Uint8Array(hexes * 6);
    this.#flags = new Uint8Array(hexes);
    this.#fit = new Uint8Array(hexes * 2);
    this.#ground = new Float64Array(this.mode === "ground" ? hexes * 2 : 0).fill(NaN);
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

  /** Whether a stand's footprint fits between the walls (HX-D8), a stair band's zigzag side no wall inside it (movement.ts hexPairWall). */
  fits(s: HexStand): boolean {
    const walls = this.walls;
    if (!walls) return true;
    const node = this.nodeOf(s);
    if (node >= 0 && this.#fit[node] !== 0) return this.#fit[node] === 1;
    const hexes = hexStandHexes(this.g, s);
    const keys = new Set(hexes.map((h) => `${h.col},${h.row}`));
    let ok = true;
    for (const h of hexes) {
      const around = hexNeighbors(this.g, h);
      for (let d = 0; d < 3 && ok; d++) if (keys.has(`${around[d]!.col},${around[d]!.row}`) && this.#edge(h, d) !== 1 && hexPairWall(walls, h, d) >= 0) ok = false;
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
    return this.fits(b) && this.#towedStep(a, b, d, first);
  }

  /** Whether the walker drags a creature beside it that a step can leave behind. */
  get tows(): boolean {
    return this.#towed.length > 0;
  }

  /**
   * Where a creature dragged beside the walker stands while the walker's
   * stored box is at `p`, squeezed there or not: as itself, never squeezed
   * (route.ts followerTrace), offset by its place, and moved with the seat
   * of a token sitting on the walker that drags it, as a rider drags a
   * goblin, where the walker squeezes (route.ts seatShift, review
   * DP34-ASTRA-01), as the move takes it along (moveLeg.ts follow).
   */
  #towedStand(t: Towed, p: Point, squeezed: boolean): HexStand {
    const by = this.#seatShift(t, p, squeezed);
    return hexStandAt(this.g, t.walker, { x: p.x + t.dx + by.x, y: p.y + t.dy + by.y }, false);
  }

  #seatShift(t: Towed, p: Point, squeezed: boolean): Point {
    const { token } = this.input;
    // Where the walk starts, as it stands, each creature stands where it is, as the move's first point leaves it (moveLeg.ts squeezedSeats).
    if (p.x === token.x && p.y === token.y && squeezed === isSqueezed(token)) return { x: 0, y: 0 };
    return seatShift(this.g, token as Walker & { id?: string }, (m) => this.#members.get(m), t.walker.id, p, squeezed);
  }

  /** Whether the walker stands squeezed with its box at `at`: by its stand where the search has one, at the walk's start as it stands, else by where it is (route.ts walkSqueezes). */
  #leadSqueezed(at: LeadAt): boolean {
    if (at.stand) return at.stand.squeezed;
    return at.start ? isSqueezed(this.input.token) : onSqueezedLattice(this.g, this.input.token, at.place);
  }

  /** Whether a creature dragged beside the walker walks its own straight leg between two stands, on stands the search may read, as the server's leg test runs it (permissions.ts draggedWalls). */
  #towedJump(from: HexStand, to: HexStand, walls: HexWalls): boolean {
    const leg = hexLegOf(this.g, from, to);
    return leg.line.every((ref) => this.standable({ size: to.size, ref })) && hexLegStop(walls, leg) === null && hexFitWall(walls, to) < 0;
  }

  /**
   * Whether every creature dragged beside the walker takes the walker's step
   * from `a` to `b` with it, by the step rule the walker's own step takes,
   * so a found way is one they all fit through (docs/design-v1-attach.md 4.2).
   */
  #towedStep(a: HexStand, b: HexStand, d: number, first: boolean): boolean {
    if (this.#towed.length === 0) return true;
    const pa = this.place(a);
    const pb = this.place(b);
    const at: LeadAt = { place: pa, stand: a, start: this.nodeOf(a) === this.startNode };
    const next: LeadAt = { place: pb, stand: b, start: false };
    for (const t of this.#towed) {
      const from = this.#towedStand(t, pa, a.squeezed);
      const to = this.#towedStand(t, pb, b.squeezed);
      const n = hexNeighbors(this.g, from.ref)[d]!;
      const walls = this.#towedWalls(t, at, next);
      // A seat that moves with the step takes the creature it drags on a leg of its own, not the walker's step.
      if (n.col !== to.ref.col || n.row !== to.ref.row) {
        const sa = this.#seatShift(t, pa, a.squeezed);
        const sb = this.#seatShift(t, pb, b.squeezed);
        if ((sa.x === sb.x && sa.y === sb.y) || !this.#towedJump(from, to, walls)) return false;
        continue;
      }
      if (!this.standable(to)) return false;
      for (const h of hexStandHexes(this.g, from)) {
        const e = walls === this.walls ? this.#edge(h, d) : hexEdgeState(walls, h, d);
        if (e === 2 || (e === 3 && !first)) return false;
      }
      if (hexFitWall(walls, to) >= 0) return false;
    }
    return true;
  }

  /**
   * The walls as a creature dragged beside the walker meets them on its leg
   * from beside the walker at `a` to beside it at `b`: by its own ledge
   * floor, as the server's leg test reads its trace (movement.ts
   * ledgeFloor), never the walker's, so a flier never takes the creature
   * beside it over a ledge. One whose height the search does not follow
   * meets every ledge, the most any walk of it could.
   */
  #towedWalls(t: Towed, a: LeadAt, b: LeadAt): HexWalls {
    const walls = this.walls!;
    if (!walls.walls.hasRelief) return walls;
    const ea = this.#heightAt(t.walker.id, a, this.#seatShift(t, a.place, this.#leadSqueezed(a)));
    const eb = this.#heightAt(t.walker.id, b, this.#seatShift(t, b.place, this.#leadSqueezed(b)));
    if (ea === null || eb === null) return walls.floor === -Infinity ? walls : { ...walls, floor: -Infinity };
    const how = standing(ea, this.#towedGround(t, a.place, this.#leadSqueezed(a)));
    const floor = how === "ground" ? -Infinity : how === "flying" ? Math.min(ea, eb) : Infinity;
    return floor === walls.floor ? walls : { ...walls, floor };
  }

  /** A creature's height with the walker at `at`: at the walk's start as it stands, past it as the move takes it along (route.ts followedHeight), or null where it is not followed. `by` is how far its seat moved it (`#seatShift`). */
  #heightAt(id: string, at: LeadAt, by: Point = { x: 0, y: 0 }): number | null {
    const token = this.input.token;
    if (at.start) return id === this.#lead.id ? token.elevation : (this.#members.get(id)?.elevation ?? null);
    const leadNow = this.elevationOf(at.stand ?? hexEndStand(this.g, token, at.place));
    return followedHeight(this.input.build.buildChunks, this.#lead, (m) => this.#members.get(m), id, { x: at.place.x - token.x + by.x, y: at.place.y - token.y + by.y }, leadNow);
  }

  /** The ground under a creature dragged beside the walker while the walker's stored box is at `p`. */
  #towedGround(t: Towed, p: Point, squeezed: boolean): number {
    return hexesGround(this.input.build.buildChunks, this.input.token.sceneId, hexStandHexes(this.g, this.#towedStand(t, p, squeezed)));
  }

  /** Whether a creature dragged beside the walker walks the leg from beside it at `a` to beside it at `b`, by the leg test the server runs on it (permissions.ts draggedWalls), on ground the search may read. */
  #towedLeg(t: Towed, a: LeadAt, b: LeadAt): boolean {
    const from = this.#towedStand(t, a.place, this.#leadSqueezed(a));
    const end = this.#towedStand(t, b.place, this.#leadSqueezed(b));
    const leg = hexLegOf(this.g, from, end);
    const walls = this.#towedWalls(t, a, b);
    return leg.line.every((ref) => this.standable({ size: end.size, ref })) && hexLegStop(walls, leg) === null;
  }

  /** Whether every creature dragged beside the walker walks the straight leg to `to` with it (walk.ts towedFollow). */
  towedFollow(to: Point): boolean {
    for (const t of this.#towed) if (!this.#towedLeg(t, { place: this.input.token, stand: null, start: true }, { place: to, stand: null, start: false })) return false;
    return true;
  }

  /**
   * Whether every creature dragged beside the walker walks a piece of the
   * walk from node `i` to node `j` as the server takes it along: straight
   * from beside the walker at the piece's start to beside it at its end.
   * One whose seat stays put along the piece walks it as the walker's own
   * steps have it (`#towedStep`), so only one whose seat moves on it needs
   * the leg of its own (review DP34-ASTRA-01).
   */
  #towedPiece(nodes: readonly number[], i: number, j: number): boolean {
    if (this.#towed.length === 0) return true;
    const stands = nodes.slice(i, j + 1).map((n) => this.standOf(n));
    const a: LeadAt = { place: this.place(stands[0]!), stand: stands[0]!, start: nodes[i] === this.startNode };
    const b: LeadAt = { place: this.place(stands[stands.length - 1]!), stand: stands[stands.length - 1]!, start: false };
    for (const t of this.#towed) {
      const shifts = stands.map((s) => this.#seatShift(t, this.place(s), s.squeezed));
      if (shifts.every((by) => by.x === shifts[0]!.x && by.y === shifts[0]!.y)) continue;
      if (!this.#towedLeg(t, a, b)) return false;
    }
    return true;
  }

  /**
   * Whether the creature may stand up in place from a squeezed stand, or
   * squeeze in place from a full one, and each creature that a token
   * sitting on it drags walks with that token's new seat (`#towedStand`).
   */
  restandOk(to: HexStand): boolean {
    if (!this.standable(to) || !(to.squeezed || this.fits(to))) return false;
    if (this.#towed.length === 0) return true;
    const from = hexRestand(this.input.token, to, !to.squeezed);
    const pa = this.place(from);
    const pb = this.place(to);
    const a: LeadAt = { place: pa, stand: from, start: this.nodeOf(from) === this.startNode };
    const b: LeadAt = { place: pb, stand: to, start: false };
    for (const t of this.#towed) {
      const sa = this.#seatShift(t, pa, from.squeezed);
      const sb = this.#seatShift(t, pb, to.squeezed);
      if (sa.x === 0 && sa.y === 0 && sb.x === 0 && sb.y === 0) continue;
      if (!this.#towedJump(this.#towedStand(t, pa, from.squeezed), this.#towedStand(t, pb, to.squeezed), this.#towedWalls(t, a, b))) return false;
    }
    return true;
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
        for (const c of this.#creaturesOn(h)) if (c.way !== "free" && this.#overlaps(c, this.elevationOf(b))) ground = 1;
      }
    }
    if (ground < 1 && b.squeezed) ground = 1;
    return ground + (prone ? 1 : 0) + (drag ?? 0);
  }

  #creaturesOn(h: Hex): WalkInput["creatures"][number][] {
    const list = this.#byHex.get(this.#index(h));
    return list ? list.map((n) => this.input.creatures[n]!) : [];
  }

  #overlaps(c: { lo: number; hi: number }, elevation: number): boolean {
    return c.lo < elevation + this.height && elevation < c.hi;
  }

  /** The elevation at a stand: the ground under its hexes for a walker, the start's height for any other (walk.ts elevationAt). */
  elevationOf(s: HexStand): number {
    if (this.mode !== "ground") return this.elevation;
    const n = this.nodeOf(s);
    const known = n >= 0 ? this.#ground[n]! : NaN;
    if (!Number.isNaN(known)) return known;
    const ground = hexesGround(this.input.build.buildChunks, this.input.token.sceneId, hexStandHexes(this.g, s));
    if (n >= 0) this.#ground[n] = ground;
    return ground;
  }

  /** A step's length in hexes with its rise from `a` to `b` by the room's rule, 1 on level ground (route.ts hexRouteFeet counts the same). Under 5-10-5 it is a climb from an even count: the search carries the counter itself (HexWalkSearch). */
  stepLength(a: HexStand, b: HexStand): number {
    const dz = this.elevationOf(b) - this.elevationOf(a);
    if (dz === 0) return 1;
    const { feetPerCell, diagonal } = this.input.rules;
    return legFeet(1, 0, Math.abs(dz) / feetPerCell, diagonal, feetPerCell, { h: 0, v: 0 }) / feetPerCell;
  }

  /** Whether a walk may end at a stand but never go on from it: over a creature it cannot pass whose height it shares. */
  endOnly(s: HexStand): boolean {
    if (this.mode === "inside") return false;
    const elevation = this.elevationOf(s);
    return hexStandHexes(this.g, s).some((h) => this.#creaturesOn(h).some((c) => c.way === "blocked" && this.#overlaps(c, elevation)));
  }

  /** The first creature dragged beside the walker that a walk along `points` leaves behind, piece by piece, or null when all of them follow it. */
  cannotFollow(points: readonly Point[]): string | null {
    for (let i = 1; i < points.length; i++) {
      for (const t of this.#towed) if (!this.#towedLeg(t, { place: points[i - 1]!, stand: null, start: i === 1 }, { place: points[i]!, stand: null, start: false })) return t.walker.id;
    }
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
      points.push({ x: at.x, y: at.y, elevation: this.elevationOf(end) });
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
    // A piece counts its rise whole (route.ts hexRouteFeet), which is each step's only where every step rises alike, as the square pieces split.
    const rise = line.length > 1 ? this.elevationOf({ size: leg.walk, ref: line[1]!, squeezed: leg.squeezed }) - this.elevationOf(from) : 0;
    for (let k = 1; k < line.length; k++) {
      const to: HexStand = { size: leg.walk, ref: line[k]!, squeezed: leg.squeezed };
      const d = hexNeighbors(this.g, from.ref).findIndex((n) => n.col === to.ref.col && n.row === to.ref.row);
      if (d < 0 || !this.stepOk(from, to, d, k === 1)) return false;
      if (this.elevationOf(to) - this.elevationOf(from) !== rise) return false;
      if (this.extraOf(from, to) !== Math.max(0, extra)) return false;
      if (k < line.length - 1 && this.endOnly(to)) return false;
      from = to;
    }
    return this.#towedPiece(nodes, i, j);
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
 * MAX_SETTLED states as the square search is.
 *
 * Under the 5-10-5 rule a state is a node and the vertical counter's
 * residue, started from the walk's own counter, as walk.ts WalkSearch
 * keeps it: every other climb costs 5 ft more, so the cheapest way on from
 * a node depends on how many climbs led there. A hex step is never
 * diagonal, so the horizontal counter never moves.
 */
export class HexWalkSearch {
  readonly world: HexWalkWorld;
  settled = 0;
  readonly #fiveTen: boolean;
  /** Counter units per cell: half feet, so heights in whole feet stay whole. */
  readonly #S: number;
  // State slots, grown as the search reaches new states.
  #n = 0;
  #node = new Int32Array(1024);
  #v = new Int32Array(1024);
  #cost = new Float64Array(1024);
  #corners = new Int32Array(1024);
  #parent = new Int32Array(1024);
  #via = new Uint8Array(1024);
  #heading = new Int8Array(1024);
  #extra = new Int8Array(1024);
  #done = new Uint8Array(1024);
  /** States at the starting residue, by node, and the others by key. */
  readonly #dense: Int32Array;
  readonly #sparse = new Map<number, number>();
  readonly #v0: number;
  /** The first state settled at each node: the cheapest way there. */
  readonly #best: Int32Array;
  readonly #heap = new Heap();
  #seq = 0;
  readonly #ends = new Map<string, HexStand[]>();

  constructor(world: HexWalkWorld) {
    this.world = world;
    const { rules, counter } = world.input;
    this.#fiveTen = rules.diagonal === "fiveTen";
    this.#S = 2 * rules.feetPerCell;
    this.#v0 = this.#fiveTen ? mod(Math.round(counter.v * this.#S), 2 * this.#S) : 0;
    const n = world.cols * world.rows * 2;
    this.#dense = new Int32Array(n).fill(-1);
    this.#best = new Int32Array(n).fill(-1);
    const start = world.startNode;
    if (start >= 0) {
      const s = this.#slot(start, this.#v0);
      this.#cost[s] = 0;
      this.#via[s] = START;
      this.#heap.push(s, 0, 0, this.#seq++);
    }
  }

  /** The state of a node at a residue, or -1. */
  #find(node: number, v: number): number {
    return v === this.#v0 ? this.#dense[node]! : (this.#sparse.get(node * 2 * this.#S + v) ?? -1);
  }

  /** The state of a node at a residue, made when new. */
  #slot(node: number, v: number): number {
    const known = this.#find(node, v);
    if (known >= 0) return known;
    if (this.#n === this.#node.length) this.#grow();
    const s = this.#n++;
    this.#node[s] = node;
    this.#v[s] = v;
    this.#cost[s] = Infinity;
    this.#parent[s] = -1;
    this.#heading[s] = -1;
    if (v === this.#v0) this.#dense[node] = s;
    else this.#sparse.set(node * 2 * this.#S + v, s);
    return s;
  }

  #grow(): void {
    const size = this.#node.length * 2;
    const grown = <T extends Int32Array | Float64Array | Uint8Array | Int8Array>(a: T, make: (n: number) => T): T => {
      const b = make(size);
      b.set(a);
      return b;
    };
    this.#node = grown(this.#node, (n) => new Int32Array(n));
    this.#v = grown(this.#v, (n) => new Int32Array(n));
    this.#cost = grown(this.#cost, (n) => new Float64Array(n));
    this.#corners = grown(this.#corners, (n) => new Int32Array(n));
    this.#parent = grown(this.#parent, (n) => new Int32Array(n));
    this.#via = grown(this.#via, (n) => new Uint8Array(n));
    this.#heading = grown(this.#heading, (n) => new Int8Array(n));
    this.#extra = grown(this.#extra, (n) => new Int8Array(n));
    this.#done = grown(this.#done, (n) => new Uint8Array(n));
  }

  #endsOf(to: Point): HexStand[] {
    const key = `${to.x},${to.y}`;
    let ends = this.#ends.get(key);
    if (!ends) this.#ends.set(key, (ends = this.world.ends(to)));
    return ends;
  }

  /** The state a drop at `to` reaches, once settled: the cheapest of the first states settled at its ends. */
  #reached(to: Point): number {
    let best = -1;
    for (const end of this.#endsOf(to)) {
      const n = this.world.nodeOf(end);
      const s = n < 0 ? -1 : this.#best[n]!;
      if (s >= 0 && (best < 0 || this.#cost[s]! < this.#cost[best]!)) best = s;
    }
    return best;
  }

  /** Settles states until an end of a drop at `to` is settled (walk.ts WalkSearch settle). */
  settle(to: Point, slice: Slice = Infinity): SettleResult {
    const ends = this.#endsOf(to).map((s) => this.world.nodeOf(s)).filter((n) => n >= 0);
    if (ends.length === 0) return "unreachable";
    const budget = typeof slice === "number" ? (slice === Infinity ? WorkBudget.all() : WorkBudget.until(slice)) : slice;
    while (!ends.some((n) => this.#best[n]! >= 0)) {
      if (this.settled >= MAX_SETTLED) return "capped";
      if (budget.spent) return "paused";
      const top = this.#heap.pop();
      if (!top) return "unreachable";
      const s = top.node;
      if (this.#done[s] === 1 || top.cost !== this.#cost[s] || top.corners !== this.#corners[s]) continue;
      this.#settle(s);
      budget.charge();
    }
    return "settled";
  }

  #settle(s: number): void {
    const world = this.world;
    this.#done[s] = 1;
    this.settled++;
    const a = this.#node[s]!;
    if (this.#best[a]! < 0) this.#best[a] = s;
    const A = world.standOf(a);
    if (this.#via[s] !== START && world.endOnly(A)) return;
    // A leg's first step may leave a wall its hexes' centers touch, so the start and a squeeze or stand in place there step first.
    const first = this.#via[s] === START || (this.#via[s] === IN_PLACE && this.#via[this.#parent[s]!] === START);
    const neighbors = hexNeighbors(world.g, A.ref);
    for (let d = 0; d < 6; d++) {
      const B: HexStand = { size: A.size, ref: neighbors[d]!, squeezed: A.squeezed };
      const b = world.nodeOf(B);
      if (b < 0) continue;
      const { length, v } = this.#step(A, B, this.#v[s]!);
      const known = this.#find(b, v);
      if ((known >= 0 && this.#done[known] === 1) || !world.stepOk(A, B, d, first)) continue;
      const extra = world.extraOf(A, B);
      const heading = this.#heading[s]!;
      this.#relax(s, b, v, this.#cost[s]! + (1 + extra) * length, this.#corners[s]! + (heading >= 0 && heading !== d ? 1 : 0), d, d, extra);
    }
    if (world.small) {
      const B = hexRestand(world.input.token, A, !A.squeezed);
      const b = world.nodeOf(B);
      const known = b < 0 ? -1 : this.#find(b, this.#v[s]!);
      if (b >= 0 && !(known >= 0 && this.#done[known] === 1) && world.restandOk(B)) this.#relax(s, b, this.#v[s]!, this.#cost[s]!, this.#corners[s]!, IN_PLACE, this.#heading[s]!, 0);
    }
  }

  /** A step's length in hexes and the vertical residue after it: under 5-10-5 by the counter (distance.ts legFeet in half feet, as walk.ts WalkSearch advances), else by the world's rule. */
  #step(A: HexStand, B: HexStand, v: number): { length: number; v: number } {
    if (!this.#fiveTen) return { length: this.world.stepLength(A, B), v };
    const S = this.#S;
    const Z = Math.round(Math.abs(this.world.elevationOf(B) - this.world.elevationOf(A)) * 2);
    if (Z === 0) return { length: 1, v };
    const vMin = Math.min(S, Z);
    const units = Math.max(S, Z) + S * (Math.floor((v + vMin) / (2 * S)) - Math.floor(v / (2 * S)));
    return { length: units / S, v: (v + vMin) % (2 * S) };
  }

  #relax(from: number, b: number, v: number, cost: number, corners: number, via: number, heading: number, extra: number): void {
    const known = this.#find(b, v);
    if (known >= 0 && (cost > this.#cost[known]! || (cost === this.#cost[known]! && corners >= this.#corners[known]!))) return;
    const t = known >= 0 ? known : this.#slot(b, v);
    this.#cost[t] = cost;
    this.#corners[t] = corners;
    this.#parent[t] = from;
    this.#via[t] = via;
    this.#heading[t] = heading;
    this.#extra[t] = extra;
    this.#heap.push(t, cost, corners, this.#seq++);
  }

  /** The settled walk to a drop at `to` as a route (walk.ts WalkSearch traceTo), null when the start is the end, or "paused" when the budget ran out. */
  traceTo(to: Point, slice: Slice = Infinity): WalkRoute | null | "paused" {
    const end = this.#reached(to);
    if (end < 0) return null;
    const budget = typeof slice === "number" ? (slice === Infinity ? WorkBudget.all() : WorkBudget.until(slice)) : slice;
    if (budget.spent) return "paused";
    const states: number[] = [];
    for (let s = end; s >= 0; s = this.#parent[s]!) states.push(s);
    states.reverse();
    if (states.length < 2) return null;
    const nodes = states.map((s) => this.#node[s]!);
    const via = states.map((s) => this.#via[s]!);
    const extras = states.map((s) => this.#extra[s]!);
    const { pieces, points } = this.world.piecesOf(nodes, via, extras, (units = 1) => budget.charge(units));
    return { pieces, points, endsBlocked: this.world.endOnly(this.world.standOf(this.#node[end]!)) };
  }

  /** The whole walk to `to`, searched to the end with no slices, or null when none reaches it. */
  routeTo(to: Point): WalkRoute | null {
    if (this.settle(to) !== "settled") return null;
    const route = this.traceTo(to);
    return route === "paused" ? null : route;
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
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
    } else if (world.tows && !world.towedFollow(to)) {
      // The walker's own leg is clear, but a creature it drags beside it is left behind: a search finds a way they all fit, or none.
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
    let rise: number | null = null;
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
      // The straight leg counts only the rise between its ends (walk.ts LegCheck), a walk each piece's, so only ground rising evenly is open.
      const dz = world.elevationOf(b) - world.elevationOf(a);
      if (rise !== null && dz !== rise) this.#open = false;
      rise = dz;
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
