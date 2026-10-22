import { WorkBudget } from "#shared/rules/walk.ts";

/** The most route work a frame does (docs/design-v1-movement.md 5.2), in milliseconds. */
export const SLICE_MS = 4;

/**
 * One consumer's route work: a drag's search, a ruler's walk, an arrow
 * key's press. `run` works on the frame's budget and says whether it is
 * done. Undone, it goes on in a later frame. `first` work, a drag's or a
 * press's, runs before the rest, in the order it came.
 */
export type RouteJob = { run(budget: WorkBudget): boolean; readonly first?: boolean };

/** The clock and the frames work runs in: `performance.now` and `requestAnimationFrame` in a browser. */
export type Frames = { now(): number; request(run: () => void): number; cancel(handle: number): void };

/**
 * The one owner of route work on the board (docs/design-v1-movement.md
 * 5.2, review ASTRA-14). Every drag's aim, ruler leg, open-ground check
 * and arrow key's press runs through it, on one budget a frame that all of
 * them share: once it is spent nothing else runs until the next frame, and
 * what is left over waits there. A frame is what a browser paints at once:
 * the events since the last animation callback, then the next callback's
 * turn. The first work of a frame opens its budget, the turn goes on with
 * it, and the turn's end closes it, so the events and the turn share one,
 * however the events fall, and a budget a turn left over never passes to
 * the next frame (review ASTRA-14). Any work asks for the next callback,
 * so a budget an event opens always closes. The frame's turn runs the drag
 * and the presses first, then the rest each in turn, starting each frame
 * past the last that ran, so no ruler waits behind the others for long. Work
 * dropped, because what it was for ended, never runs again, not even
 * later in the turn that dropped it.
 *
 * The one guaranteed bit of progress is the frame's own: the first work of
 * a frame always gets on, and nothing else gets an allowance. So a frame's
 * work runs past its budget by at most one step that cannot stop partway:
 * a world's build, a leg test, or one straight leg's check while true
 * distance pulls a route taut.
 *
 * A drop still waiting when a new drag starts or a key is pressed is the
 * one exception: it is run to its end at once (RouteDrag `flush`).
 */
export class RouteWork {
  readonly #frames: Frames;
  readonly #open: () => WorkBudget;
  readonly #observe: ((units: number) => void) | null;
  #budget: WorkBudget | null = null;
  readonly #jobs: RouteJob[] = [];
  /** The rest's work that runs first in the next turn: the one after the last that ran. */
  #next: RouteJob | null = null;
  #handle: number | null = null;

  /**
   * `open` makes a frame's budget, by default SLICE_MS of work timed by
   * `frames.now`. `observe` hears each frame's units as its turn closes its
   * budget, for tests.
   */
  constructor(frames: Frames, open?: () => WorkBudget, observe?: (units: number) => void) {
    this.#frames = frames;
    this.#open = open ?? (() => new WorkBudget({ ms: SLICE_MS, clock: () => frames.now() }));
    this.#observe = observe ?? null;
  }

  now(): number {
    return this.#frames.now();
  }

  /** Whether any work waits for a later frame. */
  get waiting(): boolean {
    return this.#jobs.length > 0;
  }

  /** The frame's budget, until the next animation callback's turn closes it. Asking for it asks for that callback. */
  budget(): WorkBudget {
    this.#budget ??= this.#open();
    this.#ask();
    return this.#budget;
  }

  /** Runs `fn` now on what is left of the frame's budget, its time counted. Reading what is known costs nothing once it is spent. */
  within<T>(fn: (budget: WorkBudget) => T): T {
    const budget = this.budget();
    return budget.timed(() => fn(budget));
  }

  /**
   * Runs `job` now on what is left of the frame's budget, and if it is not
   * done, in the frames after until it is. Says whether it is done now.
   */
  run(job: RouteJob): boolean {
    const budget = this.budget();
    if (!budget.spent) {
      const done = budget.timed(() => job.run(budget));
      if (done) {
        this.drop(job);
        return true;
      }
    }
    this.add(job);
    return false;
  }

  /** Queues `job` for the frames after, without running it now. */
  add(job: RouteJob): void {
    if (!this.#jobs.includes(job)) this.#jobs.push(job);
    this.#ask();
  }

  /** `job` will not run again: it ended, or what it worked for went away. */
  drop(job: RouteJob): void {
    const k = this.#jobs.indexOf(job);
    if (k < 0) return;
    if (job === this.#next) this.#next = this.#after(job);
    this.#jobs.splice(k, 1);
  }

  /** The rest's work after `job`, in the order it came and round to the start. Null when there is no other. */
  #after(job: RouteJob): RouteJob | null {
    const rest = this.#jobs.filter((j) => !j.first);
    const next = rest[(rest.indexOf(job) + 1) % rest.length] ?? null;
    return next === job ? null : next;
  }

  #ask(): void {
    if (this.#handle === null) this.#handle = this.#frames.request(() => this.#turn());
  }

  /** The frame's turn, the animation callback: first work, then the rest in turn, on what is left of the frame's budget, which then closes. */
  #turn(): void {
    this.#handle = null;
    const budget = (this.#budget ??= this.#open());
    const firsts = this.#jobs.filter((j) => j.first);
    const rest = this.#jobs.filter((j) => !j.first);
    const start = this.#next ? Math.max(0, rest.indexOf(this.#next)) : 0;
    const order = [...firsts, ...rest.slice(start), ...rest.slice(0, start)];
    for (const job of order) {
      if (budget.spent) break;
      // Dropped by work earlier in this turn: what it was for has ended.
      if (!this.#jobs.includes(job)) continue;
      // Held by the job, not its place, so work that ends or is dropped during the turn moves no other's turn (review MV-O-25).
      if (!job.first) this.#next = job;
      const done = budget.timed(() => job.run(budget));
      if (done) this.drop(job);
      else if (this.#next === job) this.#next = this.#after(job);
    }
    this.#observe?.(budget.units);
    this.#budget = null;
    if (this.#jobs.length > 0) this.#ask();
  }
}
