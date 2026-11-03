import type { JoinRequestState, Me } from "../lib/api.ts";
import { freeColor } from "../lib/memberColor.ts";
import { MEMBER_COLORS } from "../lib/theme.ts";

/**
 * The ask page's wait loop as a pure reducer (design join-requests 2.2 and
 * 5.2). The page holds no logic of its own: it feeds this reducer the
 * answers of its calls and runs the one effect `effectOf` names. Kept apart
 * so late, reversed and failed answers can be driven at random in a test
 * without a browser.
 *
 * Every call carries the `seq` it started under, and an answer for any other
 * `seq` is ignored. That is what keeps a late wait from moving a page that
 * has since cancelled, been displaced or asked again.
 */

/** Waits after a failed call, in milliseconds. Never longer than the last. */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000];

/** The answers of a held wait, as the server names them. */
export type WaitState = "waiting" | "in" | "turned_away" | "expired" | "closed" | "superseded";

/** Where the page stops once no wait is going. */
export type Outcome = "turned_away" | "expired" | "closed" | "other_tab" | "ended";

/**
 * Cancel: tapped and not sent yet, sent, or refused because a DM's let-in
 * is committing. While it is sent no wait runs: the held one is cut off as
 * Cancel goes out, so its answer can never overtake Cancel's own.
 */
export type CancelStep = "none" | "queued" | "sent" | "deciding";

/** One call's progress. A pause before a retry is the same call, asleep. */
export type Io = {
  step: "idle" | "inflight";
  /** Set while the call waits before trying again. */
  sleepMs: number | null;
  /** Failed calls in a row. */
  failures: number;
  /** The number the running call started under. */
  seq: number;
};

export type AskState =
  /** The ask card. */
  | { kind: "form" }
  /** The ask is on its way. */
  | { kind: "asking" }
  | { kind: "waiting"; requestId: string; name: string; io: Io; cancel: CancelStep; cancelFailed: boolean }
  /** GET /me, asked before "Request ended" and on `already_in`, so an approved phone never reads either. */
  | { kind: "checking"; requestId: string | null; io: Io }
  | { kind: "outcome"; outcome: Outcome; requestId: string | null; name: string | null }
  | { kind: "in"; me: Me };

export type AskEvent =
  | { type: "send" }
  | { type: "asked"; requestId: string; name: string }
  | { type: "askFailed" }
  /** The ask answered `already_in`. */
  | { type: "alreadyIn" }
  /** A request this device already holds, found on page load. A request a DM is letting in reads as waiting. */
  | { type: "found"; requestId: string; name: string; state: JoinRequestState }
  | { type: "begin" }
  | { type: "slept"; seq: number }
  | { type: "answer"; seq: number; requestId: string; state: WaitState; me?: Me }
  | { type: "waitFailed"; seq: number; requestId: string; gone: boolean }
  | { type: "meResult"; seq: number; me: Me | null | "error" }
  | { type: "cancel" }
  | { type: "cancelDone"; requestId: string }
  | { type: "cancelDeciding"; requestId: string }
  /** `gone`: the request is no longer waiting (gone, or already answered), so the page asks GET /me. */
  | { type: "cancelFailed"; requestId: string; gone: boolean }
  | { type: "waitHere" }
  /** The page is going away, or its call was cut off: whatever was in flight starts again when the page is back. */
  | { type: "rewind" }
  | { type: "reset" };

export type Effect =
  | { kind: "wait"; requestId: string; seq: number }
  | { kind: "sleep"; ms: number; seq: number }
  | { kind: "me"; seq: number }
  | { kind: "cancel"; requestId: string };

const FRESH_IO: Io = { step: "idle", sleepMs: null, failures: 0, seq: 0 };

export function initialAskState(): AskState {
  return { kind: "form" };
}

function ending(outcome: Outcome, requestId: string | null, name: string | null = null): AskState {
  return { kind: "outcome", outcome, requestId, name };
}

function checking(requestId: string | null, seq: number): AskState {
  return { kind: "checking", requestId, io: { ...FRESH_IO, seq } };
}

/** The seq of whatever call the state holds, so a new call never reuses one a late answer may still carry. */
function seqOf(state: AskState): number {
  return state.kind === "waiting" || state.kind === "checking" ? state.io.seq : 0;
}

function retry(io: Io): Io {
  const failures = io.failures + 1;
  return { ...io, step: "idle", failures, sleepMs: BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? 5000 };
}

/**
 * `issued` is the highest `seq` the driver ever started. A request begun
 * from here on numbers its calls above it, so a late answer to an earlier
 * request's call can match nothing.
 */
export function reduceAsk(state: AskState, event: AskEvent, issued = 0): AskState {
  const seqFloor = Math.max(issued, seqOf(state));
  switch (event.type) {
    case "send":
      return state.kind === "form" ? { kind: "asking" } : state;
    case "askFailed":
      return state.kind === "asking" ? { kind: "form" } : state;
    case "asked":
      if (state.kind !== "asking") return state;
      return { kind: "waiting", requestId: event.requestId, name: event.name, io: { ...FRESH_IO, seq: seqFloor }, cancel: "none", cancelFailed: false };
    case "alreadyIn":
      return state.kind === "asking" ? checking(null, seqFloor) : state;
    case "found": {
      if (state.kind !== "form") return state;
      switch (event.state) {
        case "waiting":
          return { kind: "waiting", requestId: event.requestId, name: event.name, io: { ...FRESH_IO, seq: seqFloor }, cancel: "none", cancelFailed: false };
        case "in":
          // The grant may already be there, so this page asks rather than assuming.
          return checking(event.requestId, seqFloor);
        default:
          return ending(event.state, event.requestId);
      }
    }
    case "begin": {
      if (state.kind !== "waiting" && state.kind !== "checking") return state;
      const seq = state.io.seq + 1;
      const io: Io = { ...state.io, step: "inflight", seq };
      return { ...state, io };
    }
    case "slept": {
      if ((state.kind !== "waiting" && state.kind !== "checking") || state.io.seq !== event.seq || state.io.step !== "inflight") return state;
      return { ...state, io: { ...state.io, step: "idle", sleepMs: null } };
    }
    case "answer": {
      if (state.kind !== "waiting" || state.requestId !== event.requestId || state.io.seq !== event.seq || state.io.step !== "inflight") return state;
      switch (event.state) {
        case "waiting":
          return { ...state, io: { ...state.io, step: "idle", failures: 0, sleepMs: null } };
        case "in":
          return event.me ? { kind: "in", me: event.me } : checking(state.requestId, seqFloor);
        case "superseded":
          return ending("other_tab", state.requestId, state.name);
        default:
          return ending(event.state, state.requestId);
      }
    }
    case "waitFailed": {
      if (state.kind !== "waiting" || state.requestId !== event.requestId || state.io.seq !== event.seq || state.io.step !== "inflight") return state;
      if (event.gone) return checking(state.requestId, seqFloor);
      return { ...state, io: retry(state.io) };
    }
    case "meResult": {
      if (state.kind !== "checking" || state.io.seq !== event.seq || state.io.step !== "inflight") return state;
      if (event.me === "error") {
        // A page that cannot reach the server keeps trying for the three
        // pauses, then says the request ended, which is true of its page.
        return state.io.failures >= BACKOFF_MS.length ? ending("ended", state.requestId) : { ...state, io: retry(state.io) };
      }
      return event.me ? { kind: "in", me: event.me } : ending("ended", state.requestId);
    }
    case "cancel":
      return state.kind === "waiting" && (state.cancel === "none") ? { ...state, cancel: "queued", cancelFailed: false } : state;
    case "cancelDone":
      // Once Cancel got its 204, nothing the wait says moves the page.
      return state.kind === "waiting" && state.requestId === event.requestId && state.cancel === "sent" ? { kind: "form" } : state;
    case "cancelDeciding":
      return state.kind === "waiting" && state.requestId === event.requestId && state.cancel === "sent" ? { ...state, cancel: "deciding" } : state;
    case "cancelFailed": {
      if (state.kind !== "waiting" || state.requestId !== event.requestId || state.cancel !== "sent") return state;
      if (event.gone) return checking(state.requestId, seqFloor);
      return { ...state, cancel: "none", cancelFailed: true };
    }
    case "waitHere":
      // Taking the request back is a new wait, which displaces the other tab's.
      return state.kind === "outcome" && state.outcome === "other_tab" && state.requestId && state.name !== null
        ? { kind: "waiting", requestId: state.requestId, name: state.name, io: { ...FRESH_IO, seq: seqFloor }, cancel: "none", cancelFailed: false }
        : state;
    case "rewind":
      if ((state.kind !== "waiting" && state.kind !== "checking") || state.io.step !== "inflight") return state;
      return { ...state, io: { ...state.io, step: "idle" } };
    case "reset":
      return state.kind === "outcome" ? { kind: "form" } : state;
  }
}

/** The one call the page should start now, or null while one runs or nothing is due. */
export function effectOf(state: AskState): Effect | null {
  if (state.kind === "waiting") {
    if (state.cancel === "queued") return { kind: "cancel", requestId: state.requestId };
    // Cancel's answer decides what comes next: waiting on, the form, or GET /me.
    if (state.cancel === "sent") return null;
    const { io } = state;
    if (io.step !== "idle") return null;
    // A pause comes first, as the same call asleep.
    if (io.sleepMs !== null) return { kind: "sleep", ms: io.sleepMs, seq: io.seq + 1 };
    return { kind: "wait", requestId: state.requestId, seq: io.seq + 1 };
  }
  if (state.kind === "checking") {
    const { io } = state;
    if (io.step !== "idle") return null;
    if (io.sleepMs !== null) return { kind: "sleep", ms: io.sleepMs, seq: io.seq + 1 };
    return { kind: "me", seq: io.seq + 1 };
  }
  return null;
}

/**
 * Applies the effect's start to the state: `begin` for a wait, a me check or
 * a pause, `cancel` sent. Returns the state to render and the effect to run,
 * so the driver never starts one call twice.
 */
export function start(state: AskState): { state: AskState; effect: Effect | null } {
  const effect = effectOf(state);
  if (!effect) return { state, effect: null };
  if (effect.kind === "cancel") {
    // The wait in flight, or its pause, stops here: the driver cuts off a
    // call the state no longer runs, so the held wait's answer to this
    // cancel never arrives ahead of Cancel's own.
    return { state: state.kind === "waiting" ? { ...state, cancel: "sent", io: { ...state.io, step: "idle", sleepMs: null } } : state, effect };
  }
  return { state: reduceAsk(state, { type: "begin" }), effect };
}

/** The whole step of a driver: apply an event, then start whatever is due. */
export function advance(state: AskState, event: AskEvent, issued = 0): { state: AskState; effect: Effect | null } {
  return start(reduceAsk(state, event, issued));
}

/** Whether the page shows the muted "Reconnecting…" line. */
export function reconnecting(state: AskState): boolean {
  return state.kind === "waiting" && state.io.failures > 0;
}

/**
 * Whether a `GET /me` answer opens the room. A grant whose member is gone
 * (data from before members were written first) is not a way in, so the
 * page shows the join page instead (design 2.2). Every place the client
 * reads `GET /me` to enter asks this.
 */
export function hasMember(me: Me): boolean {
  return Boolean((me as { member?: unknown }).member);
}

/** The first color on the ask card: the first that is not the DM's yellow. */
export function askStartColor(): string {
  return freeColor([], [MEMBER_COLORS[0]!]);
}

/** Words for the cards the page stops on. Each heading takes focus. */
export const OUTCOME_CARDS: Record<Outcome, { title: string; body: string }> = {
  turned_away: { title: "The DM said no", body: "You can ask again in 15 minutes." },
  expired: { title: "No answer yet", body: "The DM may be away. Ask again later, or ask the DM for the player link." },
  closed: { title: "Requests are off", body: "The DM stopped taking requests." },
  other_tab: { title: "Waiting in another tab", body: "This request is waiting in another tab or window." },
  ended: { title: "Request ended", body: "That request ended. Ask again." },
};

/**
 * The buttons under an outcome, from the design's table. Back returns to
 * the password card, or to the ask card where there is none. This page
 * shows only in the asking modes, so "Requests are off" here means the DM
 * turned requests on again since (the server keeps the ending 2 minutes),
 * and Ask again is the way on. With the password, the join page shows that
 * card itself, above the password card, with no buttons.
 */
export function outcomeButtons(outcome: Outcome): ("back" | "again" | "here")[] {
  switch (outcome) {
    case "turned_away":
      return ["back"];
    case "expired":
      return ["again", "back"];
    case "ended":
    case "closed":
      return ["again"];
    case "other_tab":
      return ["here"];
  }
}

/** "You asked to join as Quinn." */
export function waitingLine(name: string): string {
  return `You asked to join as ${name}.`;
}

/** What the waiting card says under its line while Cancel waits on a let-in. */
export const LETTING_IN = "The DM is letting you in…";

/** Pauses before "Who are you?" tries a busy completion again, in milliseconds (design 2.2). */
export const COMPLETE_RETRY_MS: readonly number[] = [1000, 2000, 5000];

/**
 * Finishes the player join when the server answers `busy` or `already_in`
 * (design 2.2): ask GET /me first and enter if the join went through, else
 * try again after 1, 2 and 5 s while the server settles the attempt.
 * `refused` says whether an error is one of those two answers. Any other
 * error is the caller's, and so is the last one when the retries run out.
 */
export async function completeWithRecovery<T>(deps: {
  complete(): Promise<T>;
  getMe(): Promise<T | null>;
  sleep(ms: number): Promise<void>;
  recoverable(err: unknown): boolean;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.complete();
    } catch (err) {
      if (!deps.recoverable(err)) throw err;
      const me = await deps.getMe().catch(() => null);
      if (me) return me;
      const pause = COMPLETE_RETRY_MS[attempt];
      if (pause === undefined) throw err;
      await deps.sleep(pause);
    }
  }
}
