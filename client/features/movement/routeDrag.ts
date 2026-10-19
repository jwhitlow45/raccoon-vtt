import type { Point } from "#shared/rules/geom.ts";
import { openLeg, WalkSearch, WalkWorld, type WalkInput, type WalkRoute } from "#shared/rules/walk.ts";

/**
 * A lone token drag's route search (docs/design-v1-movement.md 5.2), as a
 * small state machine kept free of React and Konva so it is tested under
 * plain Node: the finger aims at spots, the search runs in slices of at
 * most SLICE_MS a frame until the spot aimed at is settled, and a drop
 * lands once it is. One search serves every spot of the drag, since its
 * start is fixed.
 *
 * Its promises, which routeDrag.test.ts checks over random runs: a drop
 * lands at most once, nothing lands after a cancel, the route a drop lands
 * with is the settled route to the drop's own spot in the world as it is
 * then, and no search state outlives the drag.
 */

/** The most a frame gives the search (5.2), in milliseconds. */
export const SLICE_MS = 4;

/** What the search says of the spot aimed at: the straight leg is the route, a route, no route, or still searching since a time. */
export type RouteAnswer = { kind: "open" } | { kind: "route"; route: WalkRoute } | { kind: "none"; capped: boolean } | { kind: "searching"; since: number };

export type Settled = Exclude<RouteAnswer, { kind: "searching" }>;

/** The clock and the frames a search runs in: `performance.now` and `requestAnimationFrame` in a browser. */
export type Frames = { now(): number; request(run: () => void): number; cancel(handle: number): void };

export class RouteDrag {
  readonly #input: () => WalkInput | null;
  readonly #frames: Frames;
  readonly #changed: () => void;
  #world: WalkWorld | null = null;
  #search: WalkSearch | null = null;
  #built = false;
  #target: Point | null = null;
  #answer: RouteAnswer = { kind: "open" };
  #handle: number | null = null;
  #landing: ((answer: Settled) => void) | null = null;
  #over = false;

  /**
   * `input` builds the public world when the search first needs it, and
   * again after `rebuild`, null where there is none to walk (the scene is
   * not loaded): every spot then reads as the straight leg. `changed` hears
   * every change of the answer.
   */
  constructor(input: () => WalkInput | null, frames: Frames, changed: () => void = () => {}) {
    this.#input = input;
    this.#frames = frames;
    this.#changed = changed;
  }

  get answer(): RouteAnswer {
    return this.#answer;
  }

  get target(): Point | null {
    return this.#target;
  }

  /** The drag landed or was cancelled. */
  get over(): boolean {
    return this.#over;
  }

  /** Whether it holds any search state: a world, a search, a frame asked for or a drop waiting. */
  get holding(): boolean {
    return this.#world !== null || this.#search !== null || this.#handle !== null || this.#landing !== null;
  }

  /** The finger is over a new spot, the spot the drop would land on. Once the finger is up and a drop waits, it aims nowhere else. */
  aim(to: Point): RouteAnswer {
    if (this.#over || this.#landing) return this.#answer;
    if (this.#target && this.#target.x === to.x && this.#target.y === to.y) return this.#answer;
    this.#target = { x: to.x, y: to.y };
    this.#solve();
    return this.#answer;
  }

  /** The room changed under the drag, its walls, doors, creatures or areas: the world is built again and the spot answered in it. */
  rebuild(): void {
    if (this.#over) return;
    this.#stopFrames();
    this.#world = null;
    this.#search = null;
    this.#built = false;
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

  #solve(): void {
    const to = this.#target!;
    const world = this.#worldNow();
    if (!world || openLeg(world, to)) {
      this.#stopFrames();
      this.#set({ kind: "open" });
      this.#landed();
      return;
    }
    this.#search ??= new WalkSearch(world);
    this.#slice();
  }

  #slice(): void {
    const search = this.#search!;
    const to = this.#target!;
    const result = search.settle(to, this.#frames.now() + SLICE_MS);
    if (result === "paused") {
      if (this.#answer.kind !== "searching") this.#set({ kind: "searching", since: this.#frames.now() });
      this.#schedule();
      return;
    }
    this.#stopFrames();
    const route = result === "settled" ? search.routeTo(to) : null;
    this.#set(route ? { kind: "route", route } : { kind: "none", capped: result === "capped" });
    this.#landed();
  }

  /** A drop waiting for this answer lands with it, and the drag is over. */
  #landed(): void {
    const land = this.#landing;
    if (!land || this.#answer.kind === "searching") return;
    const answer = this.#answer;
    this.#end();
    land(answer);
  }

  #schedule(): void {
    if (this.#handle !== null) return;
    this.#handle = this.#frames.request(() => {
      this.#handle = null;
      // A frame that fires after the drag ended, or after a rebuild dropped its search, does nothing.
      if (this.#over || !this.#search || !this.#target) return;
      this.#slice();
    });
  }

  #stopFrames(): void {
    if (this.#handle === null) return;
    this.#frames.cancel(this.#handle);
    this.#handle = null;
  }

  #worldNow(): WalkWorld | null {
    if (!this.#built) {
      this.#built = true;
      const input = this.#input();
      this.#world = input ? new WalkWorld(input) : null;
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
    this.#stopFrames();
    this.#landing = null;
    this.#world = null;
    this.#search = null;
  }
}
