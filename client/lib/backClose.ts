import { useEffect, useRef } from "react";

/**
 * Android's Back gesture, and the browser's Back button, close what floats
 * over the room (a phone's panel sheet or token action bar, a handout)
 * before they leave the room. Phones teach that habit, and leaving the
 * room by accident drops a player out of the game.
 *
 * Whatever floats registers here while it is open. While anything is open,
 * one history entry for the same URL sits on top of the room's own, marked
 * in its state. Back pops it, and the overlay opened last closes. If more
 * stay open, a new entry goes on top. Closing the last one some other way
 * (its close button) takes the entry off again with history.back(), so
 * Forward and Back keep meaning what they did. The router sees no change
 * at all: the URL never changes.
 */

const MARK = "rvttOverlay";

export type HistoryLike = {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  back(): void;
};

/** Whether a history entry is the one this module put on top of the page. */
export function isOverlayEntry(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[MARK] === true;
}

/** An entry's state with this module's mark taken off, and the page's own state kept. */
export function withoutMark(state: unknown): unknown {
  if (!isOverlayEntry(state)) return state;
  const { [MARK]: _mark, ...rest } = state as Record<string, unknown>;
  return Object.keys(rest).length === 0 ? null : rest;
}

/** The Navigation API's view of the session history, where the browser has it. */
type NavigationLike = { currentEntry: { index: number; url: string | null } | null; entries(): { url: string | null }[] };

/**
 * Whether the entry behind the current one is this same page (its URL),
 * read from the Navigation API. False where the browser lacks it or the
 * entry behind is another page, since history alone cannot see it.
 */
export function sameEntryBehind(navigation: NavigationLike | undefined): boolean {
  const current = navigation?.currentEntry;
  if (!navigation || !current || current.url === null || current.index < 1) return false;
  return navigation.entries()[current.index - 1]?.url === current.url;
}

type Entry = { close(): void };

export class BackCloser {
  readonly #history: HistoryLike;
  readonly #open: Entry[] = [];
  /** Our entry is in the history, above the page's own. */
  #pushed = false;
  /** We called history.back() and its popstate has not arrived yet. */
  #leaving = false;

  /**
   * `sameBehind` says whether the entry behind the current one is this same
   * page, as far as the browser can show (`sameEntryBehind`). False when it
   * cannot tell.
   */
  constructor(history: HistoryLike, sameBehind: () => boolean = () => false) {
    this.#history = history;
    // A page reloaded with a sheet open still has the sheet's entry on top,
    // though nothing is open after the reload. Left there, the first Back
    // would only step off it and seem to do nothing, so it goes now, but
    // only onto an entry shown to be this page. A sheet's entry pushed just
    // as a reload began can land on the room's own entry instead (Chrome,
    // seen after a phone's resize), and stepping back from there leaves the
    // room. Where the entry behind is another page, or the browser cannot
    // show it, the mark is taken off this entry in place, and the room
    // stays. Without the Navigation API that costs one more Back after a
    // reload with a sheet open: it lands on the room's own entry, and only
    // the next leaves.
    if (isOverlayEntry(history.state)) {
      if (sameBehind()) {
        this.#leaving = true;
        history.back();
      } else history.replaceState(withoutMark(history.state), "");
    }
  }

  /** Registers something open. Returns the function that unregisters it once it closed. */
  open(close: () => void): () => void {
    const entry: Entry = { close };
    this.#open.push(entry);
    this.#sync();
    return () => {
      const i = this.#open.indexOf(entry);
      if (i === -1) return;
      this.#open.splice(i, 1);
      this.#sync();
    };
  }

  /** Call on every popstate. */
  popped(state: unknown): void {
    if (this.#leaving) {
      this.#leaving = false;
      this.#sync();
      return;
    }
    if (!this.#pushed || isOverlayEntry(state)) return;
    this.#pushed = false;
    // The overlay opened last is closed and dropped now, not when its owner
    // gets round to unregistering it (after a render), so whatever is still
    // open under it gets a new entry at once and the next Back closes that
    // too. An owner that shows something else in its place, such as the next
    // handout, registers that anew (useBackClose).
    this.#open.pop()?.close();
    this.#sync();
  }

  #sync(): void {
    if (this.#leaving) return;
    const want = this.#open.length > 0;
    if (want && !this.#pushed) {
      const prev = this.#history.state;
      this.#history.pushState({ ...(typeof prev === "object" && prev !== null ? prev : {}), [MARK]: true }, "");
      this.#pushed = true;
    } else if (!want && this.#pushed) {
      this.#pushed = false;
      // Only our own entry is taken off. When the page moved on (a link to
      // Home pushed past it), Back from there must not be undone here.
      if (!isOverlayEntry(this.#history.state)) return;
      this.#leaving = true;
      this.#history.back();
    }
  }
}

let shared: BackCloser | null = null;

function closer(): BackCloser {
  if (!shared) {
    const instance = new BackCloser(window.history, () => sameEntryBehind((window as unknown as { navigation?: NavigationLike }).navigation));
    window.addEventListener("popstate", (e) => instance.popped(e.state));
    shared = instance;
  }
  return shared;
}

/**
 * While `open` is set, Back calls `close` instead of leaving the page.
 *
 * `open` may name what is shown, such as a handout's key. Something new
 * shown in the same place is then registered anew: the Back that closed
 * the last one used up its history entry, and without a new one the next
 * Back would leave the room with the next handout still on screen.
 */
export function useBackClose(open: boolean | string | null, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    // Made when the room first shows, not when something first opens, so
    // an entry left by a reload is gone before the first Back.
    const backCloser = closer();
    if (!open) return;
    return backCloser.open(() => closeRef.current());
  }, [open]);
}
