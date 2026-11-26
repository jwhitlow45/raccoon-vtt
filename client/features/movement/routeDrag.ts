import type { Point } from "#shared/rules/geom.ts";
import { hexKey } from "#shared/rules/hex.ts";
import { hexLegOf, hexStandHexes } from "#shared/rules/movement.ts";
import type { RoutePoint } from "#shared/rules/route.ts";
import { WorkBudget, type WalkInput, type WalkRoute } from "#shared/rules/walk.ts";
import { HexWalkSearch, HexWalkWorld, routeLegCheck, routeSearch, routeWorld, routeWorldUnits, type RouteLegCheck, type RouteSearch, type RouteWorld } from "#shared/rules/hexWalk.ts";
import { hexStandPlace, type HexStand } from "#shared/rules/movement.ts";
import { snapStep } from "#shared/rules/footprint.ts";
import type { RouteJob, RouteWork } from "./routeWork.ts";

/**
 * A lone token drag's route search (docs/design/design-v1-movement.md 5.2), as a
 * small state machine kept free of React and Konva so it is tested under
 * plain Node: the finger aims at spots, and the drag's work, its world's
 * build, the open-ground check and then the search, runs through the
 * board's route work (routeWork.ts) on the frame's shared budget until the
 * spot aimed at is answered. A drop lands once it is. One search serves
 * every spot of the drag, since its start is fixed.
 *
 * Its promises, which routeDrag.test.ts checks over random runs: a drop
 * lands at most once, nothing lands after a cancel, the route a drop lands
 * with is the settled route to the drop's own spot in the world as it is
 * then, and no search state outlives the drag.
 */

/**
 * What the search says of the spot aimed at: the straight leg is the route,
 * a route, no route, or still searching since a time. With no route, a
 * creature the walker drags beside it that cannot follow where the walker
 * alone would go is `follower` (docs/design/design-v1-attach.md 4.2), and
 * else a creature the walker cannot pass that closes the way is `creature`,
 * by its place in the world's creatures (walkWorld.ts PublicWorld `spaces`
 * names it, LP40-MOVE-2). A route marked `ledge` goes only as far as a
 * ledge lets the walk: no way reaches the spot, but one would over flat
 * ground, so the walk holds short of the ledge (D-261114-035).
 */
export type RouteAnswer = { kind: "open" } | { kind: "route"; route: WalkRoute; ledge?: true } | { kind: "none"; capped: boolean; follower?: string; creature?: number } | { kind: "searching"; since: number };

export type Settled = Exclude<RouteAnswer, { kind: "searching" }>;

export class RouteDrag {
  readonly #input: () => WalkInput | null;
  readonly #work: Pick<RouteWork, "run" | "drop" | "now">;
  readonly #changed: () => void;
  #world: RouteWorld | null = null;
  #search: RouteSearch | null = null;
  /** The walker's search without the creatures it drags, asked only once theirs finds no way, to say whether they are what keeps it from one. */
  #alone: RouteSearch | null = null;
  /** A search of `from`, the world a search found no way in, with the spaces of the creatures the walker cannot pass open: asked only then, to say whether one of them closes the way. */
  #open: { from: RouteWorld; search: RouteSearch } | null = null;
  /** A search of `from`, the world a search found no way in, on its ground with every height flattened: asked only where no creature closes the way, to say whether a ledge does. */
  #flat: { from: RouteWorld; search: RouteSearch } | null = null;
  #built = false;
  #target: Point | null = null;
  /** Whether the drop at the target ends squeezed, so what the walker drags follows it in single file (route.ts fileRoutes, hexFileRoutes). */
  #squeezed = false;
  #check: RouteLegCheck | null = null;
  #answer: RouteAnswer = { kind: "open" };
  #landing: ((answer: Settled) => void) | null = null;
  #over = false;
  #queued = false;
  readonly #job: RouteJob = { first: true, run: (budget) => this.#run(budget) };

  /**
   * `input` builds the public world when the search first needs it, and
   * again after `rebuild`, null where there is none to walk (the scene is
   * not loaded): every spot then reads as the straight leg. `changed` hears
   * every change of the answer.
   */
  constructor(input: () => WalkInput | null, work: Pick<RouteWork, "run" | "drop" | "now">, changed: () => void = () => {}) {
    this.#input = input;
    this.#work = work;
    this.#changed = changed;
  }

  get answer(): RouteAnswer {
    return this.#answer;
  }

  get target(): Point | null {
    return this.#target;
  }

  /** The world the drag walks in, once built. */
  get world(): RouteWorld | null {
    return this.#world;
  }

  /** The drag landed or was cancelled. */
  get over(): boolean {
    return this.#over;
  }

  /** Whether it holds any search state: a world, a search, work waiting or a drop waiting. */
  get holding(): boolean {
    return this.#world !== null || this.#search !== null || this.#alone !== null || this.#open !== null || this.#flat !== null || this.#queued || this.#landing !== null;
  }

  /** The finger is over a new spot, the spot the drop would land on, squeezed there or not. Once the finger is up and a drop waits, it aims nowhere else. */
  aim(to: Point & { squeeze?: boolean }): RouteAnswer {
    if (this.#over || this.#landing) return this.#answer;
    if (this.#target && this.#target.x === to.x && this.#target.y === to.y && this.#squeezed === (to.squeeze === true)) return this.#answer;
    this.#target = { x: to.x, y: to.y };
    this.#squeezed = to.squeeze === true;
    this.#check = null;
    this.#solve();
    return this.#answer;
  }

  /** The room changed under the drag, its walls, doors, creatures or areas: the world is built again and the spot answered in it. */
  rebuild(): void {
    if (this.#over) return;
    this.#world = null;
    this.#search = null;
    this.#alone = null;
    this.#open = null;
    this.#flat = null;
    this.#built = false;
    this.#check = null;
    if (this.#target) this.#solve();
  }

  /**
   * The drop at `to`: `land` hears the answer for it once it is known, at
   * once when it is, else when the search settles it. A drop ends the drag.
   */
  drop(to: Point & { squeeze?: boolean }, land: (answer: Settled) => void): void {
    if (this.#over || this.#landing) return;
    this.aim(to);
    if (this.#answer.kind === "searching") {
      this.#landing = land;
      return;
    }
    const answer = this.#answer;
    this.#end();
    land(answer);
  }

  /** The drag ended without a drop, or the board went away. A drop still waiting never lands. */
  cancel(): void {
    this.#end();
  }

  /**
   * A drop still waiting lands now, its work run to the end at once: a new
   * drag or a key press would otherwise throw it away. This is the one
   * route work that keeps to no frame's budget. With nothing waiting it
   * does nothing.
   */
  flush(): void {
    if (this.#over || !this.#landing) return;
    this.#run(WorkBudget.all());
  }

  /** Asks for the spot aimed at, now if the frame has budget left, else in the frames after, the answer "searching" meanwhile. */
  #solve(): void {
    this.#queued = true;
    if (this.#work.run(this.#job)) return;
    if (this.#answer.kind !== "searching" && !this.#over) this.#set({ kind: "searching", since: this.#work.now() });
  }

  /** The drag's work on `budget`: true once the spot aimed at is answered. */
  #run(budget: WorkBudget): boolean {
    if (this.#over || !this.#target) {
      this.#queued = false;
      return true;
    }
    const to = this.#target;
    const late = (units = 1) => {
      budget.charge(units);
      return budget.spent;
    };
    const world = this.#worldNow(budget);
    if (!world) return this.#answered({ kind: "open" });
    if (this.#squeezed && world.followsInFile) return this.#inFile(world, to, budget);
    // The straight leg first: most drags need no search (5.2).
    this.#check ??= routeLegCheck(world, to);
    if (!this.#check.done && !this.#check.run(late)) return false;
    if (this.#check.open) return this.#answered({ kind: "open" });
    if (!this.#search) {
      if (budget.spent) return false;
      this.#search = routeSearch(world);
      budget.charge(Math.ceil((world.nx * world.ny) / 400));
    }
    const result = this.#search.settle(to, budget);
    if (result === "paused") return false;
    const route = result === "settled" ? this.#search.traceTo(to, budget) : null;
    if (route === "paused") return false;
    if (route) return this.#answered({ kind: "route", route });
    if (result !== "unreachable") return this.#answered({ kind: "none", capped: result === "capped" });
    const follower = world.tows ? this.#follower(world, to, budget) : null;
    if (follower === "paused") return false;
    if (follower) return this.#answered({ kind: "none", capped: false, follower });
    if (!this.#alone) return this.#closed(this.#search, to, budget);
    // The walker's own search, as a drop in single file reads it: the creatures it drags cannot follow past the one that closes the way either, so the creatures' spaces opened in their world find no way, and the note named a wall (live play 42, LP42-MOVE-3).
    const alone = this.#alone.settle(to, budget);
    if (alone === "paused") return false;
    return alone === "capped" ? this.#answered({ kind: "none", capped: true }) : this.#closed(this.#alone, to, budget, this.#search);
  }

  /**
   * No way to `to` that `closed`, a search run out of states, could miss:
   * the answer, naming the creature that closes the way where one does
   * (`#inTheWay`), else the walk to the foot of a ledge that does
   * (`#overLedge`), found by `walking`, a search run out of states too,
   * the one whose routes the creatures the walker drags follow. The
   * walker's own search would find a way to the foot that one of them
   * meets a wall or a ledge on, so the walk is cut short of the foot
   * (attach/walk.random.test.ts). A drop in single file, whose followers
   * walk the walker's own way, names a creature only, as before
   * (`walking` null).
   */
  #closed(closed: RouteSearch, to: Point, budget: WorkBudget, walking: RouteSearch | null = closed): boolean {
    const creature = this.#inTheWay(closed, to, budget);
    if (creature === "paused") return false;
    if (creature !== null) return this.#answered({ kind: "none", capped: false, creature });
    const held = walking ? this.#overLedge(walking, to, budget) : null;
    if (held === "paused") return false;
    return this.#answered(held ? { kind: "route", route: held, ledge: true } : { kind: "none", capped: false });
  }

  /**
   * Where a ledge closes the way to `to` once the search `closed` finds
   * none and no creature does: where a search of the same ground with
   * every height flattened finds a way, the walk `closed` finds to the last
   * spot of that way it reaches and may go on from, on the walker's own
   * grid, standing between the walker's level and the drop's, the foot of
   * a rise or the edge of a pit. A drop onto a level the walk cannot reach
   * then holds there, where it held wherever the straight leg met a wall
   * first, often in the corridor it came from, and said the wall stopped
   * it (live play 42, D-261114-035, D-261114-036). A spot of the way below
   * both levels or above both is no such foot: the walk reaches it only by
   * stairs off the way and would climb back from it, as from one half of
   * a platform split by a wall, down its stair and round to the ground
   * under the other half, 10 ft below where it started and where it was
   * dropped (D-261115-030). Null where flat ground has no way either. Its
   * search shares the drag's budget as the first one does.
   */
  #overLedge(closed: RouteSearch, to: Point, budget: WorkBudget): WalkRoute | null | "paused" {
    const world = closed.world;
    if (this.#flat?.from !== world) {
      const flat = flatSearchOf(world, budget);
      if (flat === "paused") return "paused";
      this.#flat = { from: world, search: flat };
    }
    return ledgeHold(closed, this.#flat.search, to, budget);
  }

  /**
   * The creature that closes the way to `to` once the search `closed`
   * finds none: where a search with the spaces of the creatures the walker
   * cannot pass open finds a way, the one that way meets where it leaves
   * all that `closed` reaches (`closingCreature`), by its place in the
   * world's creatures. Null where that way is closed too. Its search shares
   * the drag's budget as the first one does.
   */
  #inTheWay(closed: RouteSearch, to: Point, budget: WorkBudget): number | null | "paused" {
    const world = closed.world;
    const creatures = world.input.creatures;
    if (!creatures.some((c) => c.way === "blocked")) return null;
    if (this.#open?.from !== world) {
      if (budget.spent) return "paused";
      const open = routeWorld({ ...world.input, creatures: creatures.map((c) => (c.way === "blocked" ? { ...c, way: "free" as const } : c)) });
      budget.charge(routeWorldUnits(open) + Math.ceil((open.nx * open.ny) / 400));
      this.#open = { from: world, search: routeSearch(open) };
    }
    const search = this.#open.search;
    const result = search.settle(to, budget);
    if (result === "paused") return "paused";
    const route = result === "settled" ? search.traceTo(to, budget) : null;
    if (route === "paused") return "paused";
    return route ? closingCreature(closed, route.points) : null;
  }

  /**
   * Which creature the walker drags beside it cannot follow, once their
   * search finds no way to `to`: the first one the walker's own way there
   * leaves behind, or null when the walker has no way there either. The
   * walker's own search shares the drag's budget as the first one does.
   */
  #follower(world: RouteWorld, to: Point, budget: WorkBudget): string | null | "paused" {
    const alone = this.#aloneSearch(world, budget);
    if (alone === "paused") return "paused";
    const result = alone.settle(to, budget);
    if (result === "paused") return "paused";
    const route = result === "settled" ? alone.traceTo(to, budget) : null;
    if (route === "paused") return "paused";
    return route ? (world.cannotFollow(route.points) ?? world.input.towed![0]!.id) : null;
  }

  /** The walker's search without the creatures it drags, built on the drag's budget when first asked for. */
  #aloneSearch(world: RouteWorld, budget: WorkBudget): RouteSearch | "paused" {
    if (!this.#alone) {
      if (budget.spent) return "paused";
      const { towed: _towed, ...input } = world.input;
      const alone = routeWorld(input);
      budget.charge(routeWorldUnits(alone) + Math.ceil((alone.nx * alone.ny) / 400));
      this.#alone = routeSearch(alone);
    }
    return this.#alone;
  }

  /**
   * A drop that ends squeezed, so what the walker drags follows it in
   * single file along its own walk (D-261101-250, route.ts fileRoutes, on
   * hexes D-261107-172 and route.ts hexFileRoutes, for creatures of one
   * hex), as the server's move takes them: the walker's own way there, the
   * straight leg first, taken when every one of them follows it so on
   * ground the search may read (walk.ts and hexWalk.ts fileBlocked), else
   * no way, naming the first that cannot follow.
   */
  #inFile(world: RouteWorld, to: Point, budget: WorkBudget): boolean {
    const late = (units = 1) => {
      budget.charge(units);
      return budget.spent;
    };
    const alone = this.#aloneSearch(world, budget);
    if (alone === "paused") return false;
    this.#check ??= routeLegCheck(alone.world, to);
    if (!this.#check.done && !this.#check.run(late)) return false;
    const start = world.input.token;
    if (this.#check.open) {
      const follower = world.fileBlocked([start, to]);
      return this.#answered(follower === null ? { kind: "open" } : { kind: "none", capped: false, follower });
    }
    const result = alone.settle(to, budget);
    if (result === "paused") return false;
    const route = result === "settled" ? alone.traceTo(to, budget) : null;
    if (route === "paused") return false;
    if (!route) return result === "unreachable" ? this.#closed(alone, to, budget, null) : this.#answered({ kind: "none", capped: result === "capped" });
    const follower = world.fileBlocked(route.points);
    return this.#answered(follower === null ? { kind: "route", route } : { kind: "none", capped: false, follower });
  }

  /** The spot is answered: a drop waiting for it lands with it, and the drag is over. */
  #answered(answer: Settled): true {
    this.#queued = false;
    this.#set(answer);
    const land = this.#landing;
    if (land) {
      this.#end();
      land(answer);
    }
    return true;
  }

  /** The drag's world, built when first needed, its build charged to the budget as one step that cannot stop partway. */
  #worldNow(budget: WorkBudget): RouteWorld | null {
    if (!this.#built) {
      this.#built = true;
      const input = this.#input();
      this.#world = input ? routeWorld(input) : null;
      if (this.#world) budget.charge(routeWorldUnits(this.#world));
    }
    return this.#world;
  }

  #set(answer: RouteAnswer): void {
    if (answer === this.#answer) return;
    this.#answer = answer;
    this.#changed();
  }

  #end(): void {
    this.#over = true;
    this.#work.drop(this.#job);
    this.#queued = false;
    this.#landing = null;
    this.#world = null;
    this.#search = null;
    this.#alone = null;
    this.#open = null;
    this.#flat = null;
    this.#check = null;
  }
}

/** A search of `world`'s ground with every height flattened, built on `budget` as one step that cannot stop partway, or "paused" when the budget is spent. */
export function flatSearchOf(world: RouteWorld, budget: WorkBudget): RouteSearch | "paused" {
  if (budget.spent) return "paused";
  const flat = routeWorld(flattened(world.input));
  budget.charge(routeWorldUnits(flat) + Math.ceil((flat.nx * flat.ny) / 400));
  return routeSearch(flat);
}

/**
 * The walk `closed` finds to the foot of the ledge that closes the way to `to`, given `flat`, a search of the same ground with
 * every height flattened (RouteDrag `#overLedge` says which spot is a foot): null where flat ground has no way either. Of the
 * spots along the flat way that qualify, the one nearest the drop is held at, and the earliest along the way on a tie, so the
 * walk does not run on along a platform's edge to a wall's end that is no nearer the drop (LP43-POLISH-LEDGE).
 */
export function ledgeHold(closed: RouteSearch, flat: RouteSearch, to: Point, budget: WorkBudget): WalkRoute | null | "paused" {
  const world = closed.world;
  const result = flat.settle(to, budget);
  if (result === "paused") return "paused";
  const way = result === "settled" ? flat.traceTo(to, budget) : null;
  if (way === "paused") return "paused";
  if (!way) return null;
  const step = snapStep(world.input.token);
  const onGrid = (v: number, from: number) => Math.abs((v - from) / step - Math.round((v - from) / step)) < 1e-9;
  const start = world.input.token;
  const spots = spotsAlong(closed, way.points);
  const from = startLevel(closed);
  const aim = spots.at(-1)?.elevation ?? from;
  const between = (e: number) => e >= Math.min(from, aim) && e <= Math.max(from, aim);
  const away = (s: { at: Point }) => (s.at.x - to.x) ** 2 + (s.at.y - to.y) ** 2;
  let foot: (typeof spots)[number] | null = null;
  for (const s of spots) {
    if (!s.reached || !s.open || !between(s.elevation)) continue;
    if (!(closed instanceof HexWalkSearch || (onGrid(s.at.x, start.x) && onGrid(s.at.y, start.y)))) continue;
    if (!foot || away(s) < away(foot) - 1e-9) foot = s;
  }
  return foot ? closed.traceTo(foot.at, budget) : null;
}

/**
 * The creature that closes the way along `points`, a walk found with the
 * spaces of the creatures the walker cannot pass open, by its place in the
 * creatures of the world `closed` searched, which holds them closed, run
 * out of states: the one under the last spot of the walk that `closed`
 * reaches, where the walk leaves all it reaches for good, since `closed`
 * stops there only because that space may be ended in and never passed
 * through, or else under the spot after it. A creature the walk crosses in
 * the open, which `closed` walks round, is not it: a goblin standing in a
 * room on the way to a corridor an orc closes was named for the orc (live
 * play 41, LP41-MOVE-1). Nor is the first spot `closed` does not reach:
 * a Large walker steps half a square at a time, so inside the goblin's
 * space are spots `closed` never reaches, though it reaches the far side
 * (live play 42, LP42-MOVE-2). Where the spots do not show it, the first
 * creature the walk crosses.
 */
function closingCreature(closed: RouteSearch, points: readonly RoutePoint[]): number | null {
  const spots = spotsAlong(closed, points);
  const k = spots.findLastIndex((s) => s.reached);
  const at = k >= 0 ? spots[k]!.creature : -1;
  if (at >= 0) return at;
  const after = spots[k + 1];
  if (after && !after.end && after.creature >= 0) return after.creature;
  const crossed = spots.find((s) => !s.end && s.creature >= 0);
  return crossed ? crossed.creature : null;
}

/**
 * Each spot a walk along `points` steps onto after its start, in order:
 * the creature it cannot pass there, by its place in the world's
 * creatures, or -1, read by the test the search itself stops at there
 * (walk.ts `blockedBy`, hexWalk.ts `endOnly`) on the footprint the search
 * reads there, squeezed where the walker squeezes (review LP40FIX-SOL-02),
 * whether `search` reaches it, whether a walk may go on from it, not a pit
 * or such a space, where it is, the walker's elevation there, and whether
 * it is the walk's last.
 */
function spotsAlong(search: RouteSearch, points: readonly RoutePoint[]): { creature: number; reached: boolean; open: boolean; at: Point; elevation: number; end: boolean }[] {
  const spots: { creature: number; reached: boolean; open: boolean; at: Point; elevation: number; end: boolean }[] = [];
  const last = points.length - 1;
  if (search instanceof HexWalkSearch) {
    const world = search.world;
    for (let i = 1; i <= last; i++) {
      const leg = hexLegOf(world.g, world.standOf(world.nodeAt(points[i - 1]!)), world.standOf(world.nodeAt(points[i]!)));
      for (let k = 1; k < leg.line.length; k++) {
        const stand = { size: leg.walk, ref: leg.line[k]!, squeezed: leg.squeezed };
        spots.push({ creature: hexCreatureAt(world, stand), reached: search.isSettled(stand), open: !world.endOnly(stand), at: hexStandPlace(world.g, world.input.token, stand), elevation: world.elevationOf(stand), end: i === last && k === leg.line.length - 1 });
      }
    }
    return spots;
  }
  const world = search.world;
  for (let i = 1; i <= last; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const n = Math.max(1, Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / world.L));
    for (let k = 1; k <= n; k++) {
      // On the walker's lattice, as a cut of a piece steps it (drop.ts walkersStop).
      const x = a.x + Math.round(((b.x - a.x) * k) / n / world.L) * world.L;
      const y = a.y + Math.round(((b.y - a.y) * k) / n / world.L) * world.L;
      const node = world.nodeAt({ x, y });
      const elevation = node >= 0 ? world.elevationAt(node) : b.elevation;
      spots.push({ creature: world.blockedBy(x, y, elevation), reached: search.isSettled({ x, y }), open: !world.endOnly(x, y, elevation), at: { x, y }, elevation, end: i === last && k === n });
    }
  }
  return spots;
}

/** The walker's elevation where `search` starts, read as `spotsAlong` reads each spot's. */
function startLevel(search: RouteSearch): number {
  if (search instanceof HexWalkSearch) return search.world.elevationOf(search.world.start);
  const world = search.world;
  return world.startNode >= 0 ? world.elevationAt(world.startNode) : world.input.token.elevation;
}

/**
 * Whether the walker standing at the stored spot `at` of `world` would
 * stand in the space of creature `k`, by its place in the world's
 * creatures, which it cannot pass: read as the search reads a spot it may
 * end in but never pass through (walk.ts `blockedBy`, hexWalk.ts
 * `endOnly`), so a drop's straight walk is held short of the creature its
 * note names, and only that one (drop.ts heldShortOfCreature, LP42-MOVE-1).
 */
export function meetsCreature(world: RouteWorld, at: Point, k: number): boolean {
  const node = world.nodeAt(at);
  // A spot with no creature reads -1, so no creature (k -1) must meet nothing rather than every clear spot (review LP42R-4).
  if (k < 0 || node < 0) return false;
  if (world instanceof HexWalkWorld) return hexCreatureAt(world, world.standOf(node), k) === k;
  return world.blockedBy(at.x, at.y, world.elevationAt(node), k) === k;
}

/** On hexes, the creature the walker cannot pass under the stand `stand` at its height there, the first or only `only`, or -1. */
function hexCreatureAt(world: HexWalkWorld, stand: HexStand, only = -1): number {
  if (!world.endOnly(stand)) return -1;
  const under = new Set(hexStandHexes(world.g, stand).map(hexKey));
  const elevation = world.elevationOf(stand);
  return world.input.creatures.findIndex((c, k) => (only < 0 || k === only) && c.way === "blocked" && c.lo < elevation + world.height && elevation < c.hi && c.hexes?.some((h) => under.has(h)) === true);
}

/** The walk's world on its ground with every height and stair taken off its chunks: its walls, doors and creatures as they are, and no ledge. */
function flattened(input: WalkInput): WalkInput {
  const chunks: Record<string, (typeof input.build.buildChunks)[string]> = {};
  for (const [key, chunk] of Object.entries(input.build.buildChunks)) {
    if (!chunk || (chunk.heights === undefined && chunk.up === undefined)) {
      chunks[key] = chunk;
      continue;
    }
    const { heights: _heights, up: _up, ...flat } = chunk;
    chunks[key] = flat;
  }
  return { ...input, build: { ...input.build, buildChunks: chunks } };
}
