/**
 * Keeps the computer from sleeping while anyone plays (design 7): held while
 * any socket is open, the DM's own tabs included, and let go 60 s after the
 * count reaches 0. The delay rides out a phone that reconnects, a reload and
 * the server's restart for the switch, which close every socket for a moment.
 */
export const POWER_RELEASE_MS = 60_000;

export type PowerDeps = {
  /** Electron's powerSaveBlocker.start("prevent-app-suspension"), returning its id. */
  start(): number;
  stop(id: number): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
};

export class PowerBlocker {
  readonly #deps: PowerDeps;
  #id: number | null = null;
  #releaseTimer: unknown = null;

  constructor(deps: PowerDeps) {
    this.#deps = deps;
  }

  /** Whether sleep is blocked now. */
  get held(): boolean {
    return this.#id !== null;
  }

  /** Called with every status's `sockets`. */
  update(sockets: number): void {
    if (sockets > 0) {
      this.#cancelRelease();
      if (this.#id === null) this.#id = this.#deps.start();
      return;
    }
    if (this.#id === null || this.#releaseTimer !== null) return;
    this.#releaseTimer = this.#deps.setTimer(() => {
      this.#releaseTimer = null;
      this.#release();
    }, POWER_RELEASE_MS);
  }

  /** Lets go at once, for quitting: nothing is left to keep awake. */
  stop(): void {
    this.#cancelRelease();
    this.#release();
  }

  #cancelRelease(): void {
    if (this.#releaseTimer === null) return;
    this.#deps.clearTimer(this.#releaseTimer);
    this.#releaseTimer = null;
  }

  #release(): void {
    if (this.#id === null) return;
    this.#deps.stop(this.#id);
    this.#id = null;
  }
}
