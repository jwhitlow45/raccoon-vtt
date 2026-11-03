import { ApiError } from "../lib/api.ts";
import type { Turnstile } from "../components/Turnstile.tsx";

/**
 * The password step's side of the join challenge (design 10.3). Once a room
 * has seen many wrong passwords in an hour, the server answers a join
 * without a solved Turnstile check with `turnstile_required`. The page then
 * shows the check and sends the password again once it is solved. Kept apart
 * from the page, so the choices can be tested without a browser.
 */

export const CHALLENGE_NOTICE = "Too many wrong passwords have been tried for this room. Please confirm you're human.";

export type JoinRefusal = {
  /** Shown under the password field. Null when the challenge notice says all there is to say. */
  error: string | null;
  /** The room asks for the check, so the page shows it from now on. */
  challenged: boolean;
  /**
   * Send the same password again as soon as the check gives a token. Only
   * for `turnstile_required`, where the password was never checked. After a
   * rejected token the player presses Next again, so a check that keeps
   * failing cannot send request after request on its own.
   */
  resend: boolean;
  /** The server checked the password and it was wrong. */
  wrongPassword: boolean;
  /** The DM changed how new players join since this page loaded, so the page reads the mode again. Present only when true. */
  modeChanged?: boolean;
};

/** A player link's password was refused: the DM changed it since, or the link was mangled on the way. */
export const LINK_REFUSED = "This link no longer works. Ask your DM for a new one, or type the new password here.";
/** A player link whose password could not be read at all. */
export const LINK_CUT_OFF = "This link looks cut off. Ask your DM for a new one, or type the password here.";

/** `fromLink`: the password came from a player link, not from the player's typing. */
export function joinRefusal(err: unknown, fromLink = false): JoinRefusal {
  const refused = (error: string): JoinRefusal => ({ error, challenged: false, resend: false, wrongPassword: false });
  if (!(err instanceof ApiError)) return refused("Something went wrong. Try again.");
  switch (err.code) {
    case "turnstile_required":
      return { error: null, challenged: true, resend: true, wrongPassword: false };
    case "turnstile_failed":
      return { error: "The human check did not pass. Try again.", challenged: true, resend: false, wrongPassword: false };
    case "turnstile_unavailable":
      return { error: "The human check is not answering. Try again in a minute.", challenged: true, resend: false, wrongPassword: false };
    case "busy":
      // The server's password checks are all taken, which says nothing about this password.
      return refused("The server is busy. Try again in a moment.");
    case "asks_only":
      // Only by asking was switched on since the page loaded. Nothing was checked, so no password was wrong.
      return { ...refused(""), error: null, modeChanged: true };
  }
  if (err.status === 401 || err.status === 403) {
    return { ...refused(fromLink ? LINK_REFUSED : "That password is not right."), wrongPassword: true };
  }
  if (err.status === 429) return refused(`Too many wrong tries. Wait ${minutes(err.retryAfterMs)} and try again.`);
  return refused(err.message);
}

export type JoinSend =
  /** Send now, with the check's token when the room asks for one. */
  | { kind: "send"; turnstileToken?: string }
  /** The check is still loading or running. Send once its token arrives. */
  | { kind: "wait" }
  /** The room asks for a check this page has no way to show. */
  | { kind: "unavailable" };

/** What pressing Next does, given whether the room asks for the check and where the check is. */
export function joinSend(challenged: boolean, turnstile: Pick<Turnstile, "pending" | "required" | "token">): JoinSend {
  if (!challenged) return { kind: "send" };
  if (turnstile.token) return { kind: "send", turnstileToken: turnstile.token };
  // No site key arrived (Turnstile looks off to this page, or its settings
  // could not be read), so no check can appear to give a token.
  if (!turnstile.pending && !turnstile.required) return { kind: "unavailable" };
  return { kind: "wait" };
}

/** Whether a page waiting for the check should act now: send with a fresh token, or say the check cannot load. */
export function resumesWaiting(challenged: boolean, turnstile: Pick<Turnstile, "pending" | "required" | "token">): boolean {
  return joinSend(challenged, turnstile).kind !== "wait";
}

export const CHALLENGE_UNAVAILABLE = "The human check could not load. Check your connection, then reload the page.";

export function minutes(ms: number | null): string {
  if (ms === null) return "a few minutes";
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m === 1 ? "a minute" : `${m} minutes`;
}

export type AskRefusal = {
  /** Shown under the Ask to join button. Null when the card says all there is to say. */
  error: string | null;
  /** The room asks for the check, so the page shows it from now on. */
  challenged: boolean;
  /** Send the same ask again as soon as the check gives a token. Only for `turnstile_required`. */
  resend: boolean;
  /** The DM changed how new players join since this page loaded, so the page reads the mode again. */
  modeChanged: boolean;
  /** This device is in already, or a request of its own is being decided. The page asks the server where it stands. */
  alreadyHere: "in" | "deciding" | null;
};

const NO_ASK_REFUSAL: AskRefusal = { error: null, challenged: false, resend: false, modeChanged: false, alreadyHere: null };

/** What a refused ask says, in the words of design join-requests 2.2. `retryAfterMs` counts only this device's or this address's own window. */
export function askRefusal(err: unknown): AskRefusal {
  const refused = (error: string): AskRefusal => ({ ...NO_ASK_REFUSAL, error });
  if (!(err instanceof ApiError)) return refused("Something went wrong. Try again.");
  switch (err.code) {
    case "turnstile_required":
      return { ...NO_ASK_REFUSAL, challenged: true, resend: true };
    case "turnstile_failed":
      return { ...refused("The human check did not pass. Try again."), challenged: true };
    case "turnstile_unavailable":
      return { ...refused("The human check is not answering. Try again in a minute."), challenged: true };
    case "asks_off":
    case "asks_only":
      return { ...NO_ASK_REFUSAL, modeChanged: true };
    case "already_in":
      return { ...NO_ASK_REFUSAL, alreadyHere: "in" };
    case "request_deciding":
      return { ...NO_ASK_REFUSAL, alreadyHere: "deciding" };
    case "asks_full":
      return refused("Several people are waiting for the DM already. Try again in a few minutes.");
    case "asked_recently":
      return refused(`The DM said no a few minutes ago. Ask again in ${minutes(err.retryAfterMs)}.`);
    case "rate_limited":
      return refused(`Too many requests from here. Try again in ${minutes(err.retryAfterMs)}.`);
    case "busy":
      return refused("The server is busy. Try again in a moment.");
  }
  if (err.status === 429) return refused(`Too many requests from here. Try again in ${minutes(err.retryAfterMs)}.`);
  if (err.code === "network") return refused(err.message);
  return refused("Something went wrong. Try again.");
}
