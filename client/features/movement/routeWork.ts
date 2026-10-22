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
 * what is left over waits there. The budget opens with the frame's first
 * work, an event's or the frame's own turn, so a frame has one, whatever
 * order its events and its turn come in. The frame's turn runs the drag
 * and the presses first, then the rest each in turn, starting each frame
 * past the last that ran, so no ruler waits behind the others for long.
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
  #openedAt = -Infinity;
  /** The budget was opened by an event since the frame's last turn. */
  #early = false;
  #period = 1000 / 60;
  #lastTurn = -Infinity;
  readonly #jobs: RouteJob[] = [];
  #next = 0;
  #handle: number | null = null;

  /**
   * `open` makes a frame's budget, by default SLICE_MS of work timed by
   * `frames.now`. `observe` hears each frame's units as its budget closes,
   * for tests.
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

  /**
   * The frame's budget. An event that comes once a frame has gone by since
   * the last opened opens the next frame's, and the frame's turn takes it
   * over. A clock that does not move (tests) opens one each turn.
   */
  budget(): WorkBudget {
    const now = this.#frames.now();
    if (!this.#budget || (Number.isFinite(now) && now - this.#openedAt >= 0.75 * this.#period)) {
      this.#openFrame(now);
      this.#early = true;
    }
    return this.#budget!;
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
    this.#jobs.splice(k, 1);
    const firsts = this.#jobs.filter((j) => j.first).length;
    if (!job.first && k - firsts < this.#next) this.#next--;
  }

  #openFrame(now: number): void {
    if (this.#budget) this.#observe?.(this.#budget.units);
    this.#budget = this.#open();
    this.#openedAt = now;
  }

  #ask(): void {
    if (this.#handle === null) this.#handle = this.#frames.request(() => this.#turn());
  }

  /** The frame's turn: first work, then the rest in turn, while the budget lasts. */
  #turn(): void {
    this.#handle = null;
    const now = this.#frames.now();
    if (Number.isFinite(now) && Number.isFinite(this.#lastTurn) && now - this.#lastTurn < 50) this.#period = Math.min(34, Math.max(6, now - this.#lastTurn));
    this.#lastTurn = now;
    // An event earlier in this frame already opened its budget.
    if (!(this.#early && Number.isFinite(now) && now - this.#openedAt < 0.5 * this.#period)) this.#openFrame(now);
    this.#early = false;
    const budget = this.#budget!;
    const firsts = this.#jobs.filter((j) => j.first);
    const rest = this.#jobs.filter((j) => !j.first);
    const start = rest.length > 0 ? this.#next % rest.length : 0;
    const order = [...firsts, ...rest.slice(start), ...rest.slice(0, start)];
    let ran = -1;
    for (const [k, job] of order.entries()) {
      if (budget.spent) break;
      const done = budget.timed(() => job.run(budget));
      if (k >= firsts.length) ran = k - firsts.length;
      if (done) this.drop(job);
    }
    // Next frame the rest start past the last that ran.
    const left = this.#jobs.filter((j) => !j.first).length;
    if (ran >= 0) this.#next = left > 0 ? (start + ran + 1) % Math.max(1, rest.length) : 0;
    if (this.#jobs.length > 0) this.#ask();
  }
}
