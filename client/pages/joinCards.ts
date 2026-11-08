import type { JoinMode } from "../lib/api.ts";

/**
 * Which cards the join page shows (docs/design/design-v1-join-requests.md
 * 2.2), apart from Join.tsx so the rules run under plain Node in the tests.
 *
 * - `pick`: the password step's "Who are you?".
 * - `loading`: the shared "Loading…" while the device's own request is
 *   looked up.
 * - `ask_only`: the ask card alone.
 * - `ask`: the ask card in With the password, or by asking.
 * - `password`: the password card, with No password? under it in `ask`.
 */
export type JoinCards = "pick" | "loading" | "ask_only" | "ask" | "password";

export function joinCards(input: {
  mode: JoinMode;
  /** A ticket from the password step is in hand. */
  picking: boolean;
  /** In `ask`, whether the ask card shows: the player tapped Ask to join, or the lookup found a request. */
  view: "password" | "ask";
  /** The device's own request has been looked up, found or not. */
  looked: boolean;
  /** A player link with its password was opened. In `ask` it joins at once, as ever. */
  linked: boolean;
}): JoinCards {
  // Only by asking lets nobody in by the password, so a "Who are you?" from
  // before the switch has nothing left to offer.
  if (input.picking && input.mode !== "ask_only") return "pick";
  // In the asking modes the device's own request decides the first card, so
  // no card shows before the lookup answers, never the password card for a
  // moment before a waiting card. A player link's password card is the
  // exception: the link is sent at once, whatever the lookup finds.
  if (input.mode === "ask_only") return input.looked ? "ask_only" : "loading";
  if (input.mode === "ask") {
    if (!input.looked && !input.linked) return "loading";
    return input.view === "ask" ? "ask" : "password";
  }
  return "password";
}

/** In `ask`, whether the ask card shows: a tap on Ask to join, or a request found on load that Back has not left. */
export function askView(input: { tapped: boolean; found: boolean; spent: boolean; linked: boolean }): "password" | "ask" {
  if (input.tapped) return "ask";
  return input.found && !input.spent && !input.linked ? "ask" : "password";
}

/** How often the page reads the room's mode again while it says "Requests are off" over the password card. */
export const CLOSED_POLL_MS = 15_000;

/** The parts of the browser the poll listens to, apart so a test can stand in for them. */
export type ClosedPollEnv = {
  page: { visibilityState: string; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
  win: { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
};

/**
 * Reads on a timer, on focus and when the page comes back into view, but
 * never for a hidden page, which would spend a request nobody sees.
 * Returns the stop that removes every listener and the timer, called when
 * the card it polled for is gone.
 */
export function startClosedPoll(refresh: () => void, env: ClosedPollEnv): () => void {
  const read = () => {
    if (env.page.visibilityState === "visible") refresh();
  };
  const timer = setInterval(read, CLOSED_POLL_MS);
  env.win.addEventListener("focus", read);
  env.page.addEventListener("visibilitychange", read);
  return () => {
    clearInterval(timer);
    env.win.removeEventListener("focus", read);
    env.page.removeEventListener("visibilitychange", read);
  };
}
