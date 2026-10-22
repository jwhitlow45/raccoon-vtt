import type { Point } from "#shared/rules/geom.ts";
import { LegCheck, WalkSearch, WalkWorld, WorkBudget, worldUnits, type WalkInput, type WalkRoute } from "#shared/rules/walk.ts";
import type { RouteJob, RouteWork } from "./routeWork.ts";

/**
 * A lone token drag's route search (docs/design-v1-movement.md 5.2), as a
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
 * alone would go is `follower` (docs/design-v1-attach.md 4.2).
 */
export type RouteAnswer = { kind: "open" } | { kind: "route"; route: WalkRoute } | { kind: "none"; capped: boolean; follower?: string } | { kind: "searching"; since: number };

export type Settled = Exclude<RouteAnswer, { kind: "searching" }>;

export class RouteDrag {
  readonly #input: () => WalkInput | null;
  readonly #work: Pick<RouteWork, "run" | "drop" | "now">;
  readonly #changed: () => void;
  #world: WalkWorld | null = null;
  #search: WalkSearch | null = null;
  /** The walker's search without the creatures it drags, asked only once theirs finds no way, to say whether they are what keeps it from one. */
  #alone: WalkSearch | null = null;
  #built = false;
  #target: Point | null = null;
  #check: LegCheck | null = null;
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
  get world(): WalkWorld | null {
    return this.#world;
  }

  /** The drag landed or was cancelled. */
  get over(): boolean {
    return this.#over;
  }

  /** Whether it holds any search state: a world, a search, work waiting or a drop waiting. */
  get holding(): boolean {
    return this.#world !== null || this.#search !== null || this.#alone !== null || this.#queued || this.#landing !== null;
  }

  /** The finger is over a new spot, the spot the drop would land on. Once the finger is up and a drop waits, it aims nowhere else. */
  aim(to: Point): RouteAnswer {
    if (this.#over || this.#landing) return this.#answer;
    if (this.#target && this.#target.x === to.x && this.#target.y === to.y) return this.#answer;
    this.#target = { x: to.x, y: to.y };
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
    this.#built = false;
    this.#check = null;
    if (this.#target) this.#solve();
  }

  /**
   * The drop at `to`: `land` hears the answer for it once it is known, at
   * once when it is, else when the search settles it. A drop ends the drag.
   */
  drop(to: Point, land: (answer: Settled) => void): void {
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
    // The straight leg first: most drags need no search (5.2).
    this.#check ??= new LegCheck(world, to);
    if (!this.#check.done && !this.#check.run(late)) return false;
    if (this.#check.open) return this.#answered({ kind: "open" });
    if (!this.#search) {
      if (budget.spent) return false;
      this.#search = new WalkSearch(world);
      budget.charge(Math.ceil((world.nx * world.ny) / 400));
    }
    const result = this.#search.settle(to, budget);
    if (result === "paused") return false;
    const route = result === "settled" ? this.#search.traceTo(to, budget) : null;
    if (route === "paused") return false;
    if (route) return this.#answered({ kind: "route", route });
    if (result !== "unreachable" || !world.tows) return this.#answered({ kind: "none", capped: result === "capped" });
    const follower = this.#follower(world, to, budget);
    if (follower === "paused") return false;
    return this.#answered({ kind: "none", capped: false, ...(follower ? { follower } : {}) });
  }

  /**
   * Which creature the walker drags beside it cannot follow, once their
   * search finds no way to `to`: the first one the walker's own way there
   * leaves behind, or null when the walker has no way there either. The
   * walker's own search shares the drag's budget as the first one does.
   */
  #follower(world: WalkWorld, to: Point, budget: WorkBudget): string | null | "paused" {
    if (!this.#alone) {
      if (budget.spent) return "paused";
      const { towed: _towed, ...input } = world.input;
      const alone = new WalkWorld(input);
      budget.charge(worldUnits(alone) + Math.ceil((alone.nx * alone.ny) / 400));
      this.#alone = new WalkSearch(alone);
    }
    const result = this.#alone.settle(to, budget);
    if (result === "paused") return "paused";
    const route = result === "settled" ? this.#alone.traceTo(to, budget) : null;
    if (route === "paused") return "paused";
    return route ? (world.cannotFollow(route.points) ?? world.input.towed![0]!.id) : null;
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
  #worldNow(budget: WorkBudget): WalkWorld | null {
    if (!this.#built) {
      this.#built = true;
      const input = this.#input();
      this.#world = input ? new WalkWorld(input) : null;
      if (this.#world) budget.charge(worldUnits(this.#world));
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
    this.#check = null;
  }
}
