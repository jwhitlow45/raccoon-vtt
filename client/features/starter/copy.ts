/**
 * One copy of a starter work into the room at a time (docs/design-v1-starter-art.md
 * 5), for the places that pick one outside the image picker: New scene and
 * Handouts. Use is busy from the tap until the server answers, a second
 * tap meanwhile is refused, Cancel stops the request, and an answer that
 * arrives after a cancel or after the picker closed is dropped, so it can
 * never make a scene or pick a handout nobody asked for any more.
 *
 * Plain state with a listener, so the randomized test drives it without
 * React (copy.test.ts).
 */

export type CopyState = { busy: boolean; waiting: boolean; error: string | null };

export type CopyStep<T> = (signal: AbortSignal, onWaiting: (waiting: boolean) => void) => Promise<T>;

export const IDLE: CopyState = { busy: false, waiting: false, error: null };

export class CopyRun {
  #state: CopyState = IDLE;
  #current: AbortController | null = null;
  #closed = false;
  readonly #onChange: (state: CopyState) => void;
  readonly #errorText: (err: unknown) => string;

  constructor(onChange: (state: CopyState) => void, errorText: (err: unknown) => string) {
    this.#onChange = onChange;
    this.#errorText = errorText;
  }

  get state(): CopyState {
    return this.#state;
  }

  #set(next: CopyState): void {
    this.#state = next;
    if (!this.#closed) this.#onChange(next);
  }

  /**
   * Runs `step` and hands its answer to `onDone`. False, and nothing runs,
   * while another copy is under way or once the run is closed.
   */
  start<T>(step: CopyStep<T>, onDone: (value: T) => void): boolean {
    if (this.#current || this.#closed) return false;
    const controller = new AbortController();
    this.#current = controller;
    this.#set({ busy: true, waiting: false, error: null });
    const mine = () => this.#current === controller && !controller.signal.aborted;
    void step(controller.signal, (waiting) => {
      if (mine()) this.#set({ ...this.#state, waiting });
    }).then(
      (value) => {
        if (!mine()) return;
        this.#current = null;
        this.#set(IDLE);
        onDone(value);
      },
      (err: unknown) => {
        if (!mine()) return;
        this.#current = null;
        this.#set({ busy: false, waiting: false, error: this.#errorText(err) });
      },
    );
    return true;
  }

  /** Stops the copy under way. Its answer, whenever it comes, is dropped. */
  cancel(): void {
    const controller = this.#current;
    if (!controller) return;
    this.#current = null;
    controller.abort();
    this.#set(IDLE);
  }

  /** The picker closed: the copy stops, and nothing is reported or applied after. */
  close(): void {
    this.#closed = true;
    this.cancel();
  }
}
