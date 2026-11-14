import type { Point } from "#shared/rules/geom.ts";
import { hexKey } from "#shared/rules/hex.ts";
import { hexLegOf, hexStandHexes } from "#shared/rules/movement.ts";
import type { RoutePoint } from "#shared/rules/route.ts";
import { WorkBudget, type WalkInput, type WalkRoute } from "#shared/rules/walk.ts";
import { HexWalkWorld, routeLegCheck, routeSearch, routeWorld, routeWorldUnits, type RouteLegCheck, type RouteSearch, type RouteWorld } from "#shared/rules/hexWalk.ts";
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
 * names it, LP40-MOVE-2).
 */
export type RouteAnswer = { kind: "open" } | { kind: "route"; route: WalkRoute } | { kind: "none"; capped: boolean; follower?: string; creature?: number } | { kind: "searching"; since: number };

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
    return this.#world !== null || this.#search !== null || this.#alone !== null || this.#open !== null || this.#queued || this.#landing !== null;
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
    return this.#closed(world, to, budget);
  }

  /** No way to `to` in `world` that the search could miss: the answer, naming the creature that closes the way where one does (`#inTheWay`). */
  #closed(world: RouteWorld, to: Point, budget: WorkBudget): boolean {
    const creature = this.#inTheWay(world, to, budget);
    if (creature === "paused") return false;
    return this.#answered({ kind: "none", capped: false, ...(creature !== null ? { creature } : {}) });
  }

  /**
   * The creature that closes the way to `to` once the search in `world`
   * finds none: where a search with the spaces of the creatures the walker
   * cannot pass open finds a way, the first of them that way goes on from
   * (`crossedCreature`), by its place in the world's creatures. Null where
   * that way is closed too. Its search shares the drag's budget as the
   * first one does.
   */
  #inTheWay(world: RouteWorld, to: Point, budget: WorkBudget): number | null | "paused" {
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
    return route ? crossedCreature(world, route.points) : null;
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
    if (!route) return result === "unreachable" ? this.#closed(alone.world, to, budget) : this.#answered({ kind: "none", capped: result === "capped" });
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
    this.#check = null;
  }
}

/**
 * The first creature the walker cannot pass whose space a walk along
 * `points` goes on from, by its place in the creatures of `world`, which
 * holds their spaces closed: read at each step of each piece by the test
 * the search itself stops at there (walk.ts `blockedBy`, hexWalk.ts
 * `endOnly`), on the footprint the search reads there, squeezed where the
 * walker squeezes (review LP40FIX-SOL-02), and leaving out the walk's last
 * spot, since a walk may end in such a space. Null where the walk crosses
 * none.
 */
function crossedCreature(world: RouteWorld, points: readonly RoutePoint[]): number | null {
  const creatures = world.input.creatures;
  const last = points.length - 1;
  if (world instanceof HexWalkWorld) {
    for (let i = 1; i <= last; i++) {
      const leg = hexLegOf(world.g, world.standOf(world.nodeAt(points[i - 1]!)), world.standOf(world.nodeAt(points[i]!)));
      const end = i === last ? leg.line.length - 1 : leg.line.length;
      for (let k = 1; k < end; k++) {
        const stand = { size: leg.walk, ref: leg.line[k]!, squeezed: leg.squeezed };
        if (!world.endOnly(stand)) continue;
        const under = new Set(hexStandHexes(world.g, stand).map(hexKey));
        const elevation = world.elevationOf(stand);
        const at = creatures.findIndex((c) => c.way === "blocked" && c.lo < elevation + world.height && elevation < c.hi && c.hexes?.some((h) => under.has(h)) === true);
        if (at >= 0) return at;
      }
    }
    return null;
  }
  for (let i = 1; i <= last; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const n = Math.max(1, Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / world.L));
    for (let k = 1; k <= (i === last ? n - 1 : n); k++) {
      // On the walker's lattice, as a cut of a piece steps it (drop.ts walkersStop).
      const x = a.x + Math.round(((b.x - a.x) * k) / n / world.L) * world.L;
      const y = a.y + Math.round(((b.y - a.y) * k) / n / world.L) * world.L;
      const node = world.nodeAt({ x, y });
      const at = world.blockedBy(x, y, node >= 0 ? world.elevationAt(node) : b.elevation);
      if (at >= 0) return at;
    }
  }
  return null;
}
