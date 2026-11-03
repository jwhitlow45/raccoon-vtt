/**
 * Pure parts of the DM's side of join requests (docs/design/design-v1-join-requests.md
 * 2.3 and 5.3): the toast throttle and its words, ages, badge words, the
 * carry-on note and the name hint, the answer errors, and the numbered,
 * retrying fetch of the list. Kept apart from the components so they run
 * under plain Node in the tests.
 */
import type { Member } from "#shared/model.ts";
import type { JoinMode, JoinRequestList, JoinRequestRow, MemberSummary } from "../../lib/api.ts";
import type { Clock } from "../../state/timing.ts";

export type { JoinMode, JoinRequestList, JoinRequestRow };
type CarryOnPlayer = MemberSummary;

/** "Asked just now" or "Asked 3 min ago". */
export function askedText(askedAt: string, now: number): string {
  const at = Date.parse(askedAt);
  // A device clock behind the server's reads as just now, never as a negative age.
  const minutes = Number.isNaN(at) ? 0 : Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Asked just now";
  if (minutes < 60) return `Asked ${minutes} min ago`;
  return `Asked ${Math.floor(minutes / 60)} h ago`;
}

/** The next time an age on screen reads differently, or null when none shows. */
export function nextAgeTickMs(requests: readonly JoinRequestRow[], now: number): number | null {
  let soonest: number | null = null;
  for (const r of requests) {
    const at = Date.parse(r.askedAt);
    if (Number.isNaN(at)) continue;
    const into = Math.max(0, now - at) % 60_000;
    const wait = 60_000 - into;
    if (soonest === null || wait < soonest) soonest = wait;
  }
  return soonest;
}

/** "1 join request" or "2 join requests". */
export function joinRequestsWords(count: number): string {
  return count === 1 ? "1 join request" : `${count} join requests`;
}

/**
 * The DM panel's badge words: the upload's and the requests', in that
 * order, leaving out the one at zero ("1 upload waiting, 2 join requests").
 */
export function dmBadgeLabel(uploadWaiting: number, requests: number): string {
  return [uploadWaiting > 0 ? "1 upload waiting" : "", requests > 0 ? joinRequestsWords(requests) : ""].filter(Boolean).join(", ");
}

/** The Panels button's words: "2 unread, 1 upload waiting, 2 join requests", in that order. */
export function panelsButtonLabel(unread: number, uploadWaiting: number, requests: number): string {
  return [unread > 0 ? `${unread} unread` : "", dmBadgeLabel(uploadWaiting, requests)].filter(Boolean).join(", ");
}

/** What a typed name is compared by: NFKC, then case folded. Look-alike letters still defeat it, so a match is only ever a hint. */
export function foldName(name: string): string {
  return name.normalize("NFKC").trim().toUpperCase().toLowerCase();
}

/** The player whose name the requester typed, or null. A hint only (design 4.1, impersonation). */
export function typedNameMatch(typed: string, players: readonly CarryOnPlayer[]): CarryOnPlayer | null {
  const key = foldName(typed);
  if (key === "") return null;
  return players.find((p) => foldName(p.name) === key) ?? null;
}

/**
 * What the carry-on list hangs on: who is in the room, as whom, and as what
 * kind. A password join, a rename, a removal or a player gaining DM rights
 * changes it, and the list is fetched again, since only the join request
 * signal would otherwise refresh it.
 */
export function rosterKey(members: Readonly<Record<string, Pick<Member, "id" | "name" | "kind">>> | undefined): string {
  if (!members) return "";
  return Object.values(members)
    .map((m) => `${m.id}\u0000${m.kind}\u0000${m.name}`)
    .sort()
    .join("\u0001");
}

/**
 * "Let in as" between the list's fetches: the server's players, under the
 * names the room knows now, without any since removed or made a DM. The
 * fetch that follows a roster change adds a player who just joined.
 */
export function carryOnPlayers(listed: readonly CarryOnPlayer[], members: Readonly<Record<string, Pick<Member, "id" | "name" | "color" | "kind">>> | undefined): CarryOnPlayer[] {
  if (!members) return [...listed];
  return listed.flatMap((p) => {
    const now = members[p.id];
    return now && now.kind === "player" ? [{ id: p.id, name: now.name, color: now.color }] : [];
  });
}

/** Shown whenever "Let in as" names a player, so a DM never hands over a player's seat without reading what it holds. */
export function carryOnNote(player: Pick<CarryOnPlayer, "name">, online: boolean, typedMatches: boolean): string {
  const base = `This device will be ${player.name}: ${player.name}'s characters, tokens and whispers. Only pick ${player.name} if you know it is them.`;
  const parts = [base];
  if (online) parts.push(`${player.name} is online now.`);
  if (typedMatches) parts.push(`The name they typed matches ${player.name}.`);
  return parts.join(" ");
}

/** What a row says while its answer is out, or null when it is idle. */
export type RowBusy = "letting" | "turning" | "still";

/** The requests that wait for an answer: what the badge counts, what toasts, and what Turn away all may turn away. */
export function waitingRows(rows: readonly JoinRequestRow[]): JoinRequestRow[] {
  return rows.filter((r) => !r.deciding);
}

/**
 * What a row shows: this device's own answer while it is out, else what the
 * list says of a let-in running from any DM device, so a co-DM's row is busy
 * too and the tapping device's row stays busy across the list's fetches.
 */
export function rowBusy(own: RowBusy | null, row: Pick<JoinRequestRow, "deciding" | "pending">): RowBusy | null {
  if (own === "turning") return "turning";
  if (own === "still" || row.pending) return "still";
  if (own === "letting" || row.deciding) return "letting";
  return null;
}

/**
 * This device's own answer on a row. `sent`: the list on screen when it
 * went out. `heard`: what its HTTP answer said, `pending` for a 202 and
 * `final` for let in or turned away. `finalAt`: the list on screen when a
 * final answer came.
 */
export type OwnAnswer<L> = { busy: RowBusy; sent: L; heard: "none" | "pending" | "final"; finalAt: L | null };

/**
 * Whether this device's answer is over, so the row shows only what the
 * list says. A 202 is over once a list newer than the one it went out
 * from shows no let-in running, whichever came first, that list or the
 * 202. A final answer is over at the next list after it, which no longer
 * has the row. One still out is never over: a refusal ends it itself.
 */
export function ownAnswerOver<L>(own: OwnAnswer<L>, latest: L, deciding: boolean): boolean {
  if (own.heard === "pending") return latest !== own.sent && !deciding;
  if (own.heard === "final") return latest !== own.finalAt;
  return false;
}

export function rowBusyText(busy: RowBusy, name: string): string {
  if (busy === "letting") return "Letting in…";
  if (busy === "turning") return "Turning away…";
  return `Still letting ${name} in…`;
}

/**
 * The words for a refused answer, from the server's error code. Every
 * refusal makes the list fetch again, so a row that no longer waits goes.
 */
export function answerErrorText(code: string | undefined, name: string): string {
  switch (code) {
    case "request_gone":
      return `${name} is no longer asking.`;
    case "request_answered":
      return "Another DM already answered.";
    case "already_in":
      return `${name} is in the room already.`;
    case "room_full":
      return "The room is full: it holds 50 members. Remove a member first.";
    case "member_removed":
    case "not_a_player":
      return "That player was just removed. Let them in as someone new.";
    case "busy":
      return "The server is busy. Try again in a moment.";
    default:
      return "Something went wrong. Try again.";
  }
}

/**
 * Turn away all's refusal. Turn away skips whatever no longer waits, so the
 * only refusals left are the server's own, and none names a person: the
 * button answers for several at once.
 */
export function turnAwayAllErrorText(code: string | undefined): string {
  return answerErrorText(code === "busy" ? "busy" : undefined, "");
}

/** The Joining setting's three choices (design 2.1). */
export const JOIN_MODE_OPTIONS: readonly { value: JoinMode; label: string; help: string }[] = [
  { value: "password", label: "With the password", help: "The password and the player link let new devices in." },
  { value: "ask", label: "With the password, or by asking", help: "Someone without the password can ask, and a DM lets them in." },
  {
    value: "ask_only",
    label: "Only by asking",
    help: "Every new device asks, and a DM lets it in. The password and the player link stop letting anyone new in. Devices already in stay in, and a kicked player stays out. If asking stops working, switch to With the password, or by asking, and share the player link.",
  },
];

export const JOIN_MODE_ERRORS: Readonly<Record<string, string>> = {
  no_password: "This room has no player password to go back to. Set a new player password first.",
};

/* ---------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------- */

/** At most one join toast this often (design 2.3). */
export const JOIN_TOAST_GAP_MS = 20_000;

export const JOIN_FLOOD_TEXT = "Many people are asking to join. Turn them away, or switch Joining to With the password, or by asking.";

function newest(rows: readonly JoinRequestRow[]): JoinRequestRow {
  let best = rows[0]!;
  for (const r of rows) if (Date.parse(r.askedAt) >= Date.parse(best.askedAt)) best = r;
  return best;
}

/** "Quinn asks to join.", "Quinn and 2 more ask to join.", or the waiting forms for a DM who just opened the room. */
export function joinToastText(unseen: readonly JoinRequestRow[], opening: boolean): string {
  const first = newest(unseen);
  if (unseen.length === 1) return opening ? `${first.name} is waiting to join.` : `${first.name} asks to join.`;
  return `${first.name} and ${unseen.length - 1} more ${opening ? "are waiting to join" : "ask to join"}.`;
}

export type JoinToaster = {
  /** The newest list from the server. A hold keeps new toasts back (View as a player). */
  update(list: JoinRequestList, hold: boolean): void;
  stop(): void;
};

/**
 * Decides when a DM device toasts. Each request is toasted once, by id,
 * whatever reconnects and fetches come between, and at most one toast shows
 * every 20 seconds: a request that arrives sooner waits for the gap, and the
 * toast then names the newest of those still waiting and counts them.
 * Past the room's ask threshold requests stop toasting, and one notice
 * says why. A device that opens with requests already waiting says so once.
 * `show` raises the toast with its Review button.
 */
export function createJoinToaster(deps: { clock: Clock; show(text: string): void }): JoinToaster {
  const { clock } = deps;
  /**
   * Ids already toasted or silenced. Kept while the list holds them, which
   * it does while a let-in decides them, so only an id that ended leaves,
   * and an ended id never comes back.
   */
  let seen = new Set<string>();
  let lastToastAt: number | null = null;
  let opening = true;
  let floodTold = false;
  /** The notice is owed for this challenge and waits out the gap, as any join toast does. */
  let floodDue = false;
  let latest: JoinRequestList | null = null;
  let held = false;
  let timer: unknown = null;

  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const run = () => {
    clearTimer();
    if (!latest || held) return;
    const list = latest;
    seen = new Set([...seen].filter((id) => list.requests.some((r) => r.id === id)));
    // A request being let in never toasts, and stays seen while it is decided, so one whose let-in fails and comes back to waiting is not news.
    const unseen = waitingRows(list.requests).filter((r) => !seen.has(r.id));
    if (!list.challenged) {
      floodTold = false;
      floodDue = false;
    }
    if (list.challenged) {
      // Past the threshold no ask toasts on its own. The one notice owed
      // says why, once per challenge, and only once the gap allows.
      for (const r of unseen) seen.add(r.id);
      if (unseen.length > 0) {
        opening = false;
        if (!floodTold) floodDue = true;
      }
      if (!floodDue) return;
      const wait = lastToastAt === null ? 0 : lastToastAt + JOIN_TOAST_GAP_MS - clock.now();
      if (wait > 0) {
        timer = clock.setTimeout(run, wait);
        return;
      }
      floodDue = false;
      floodTold = true;
      lastToastAt = clock.now();
      deps.show(JOIN_FLOOD_TEXT);
      return;
    }
    if (unseen.length === 0) {
      opening = false;
      return;
    }
    const wait = lastToastAt === null ? 0 : lastToastAt + JOIN_TOAST_GAP_MS - clock.now();
    if (wait > 0) {
      timer = clock.setTimeout(run, wait);
      return;
    }
    for (const r of unseen) seen.add(r.id);
    const text = joinToastText(unseen, opening);
    opening = false;
    lastToastAt = clock.now();
    deps.show(text);
  };

  return {
    update(list, hold) {
      latest = list;
      held = hold;
      run();
    },
    stop() {
      clearTimer();
      latest = null;
    },
  };
}

/* ---------------------------------------------------------------------------
 * The list's fetches
 * ------------------------------------------------------------------------- */

/** A failed fetch tries again after these, then every 30 seconds (design 2.3). */
export const RETRY_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];
export const RETRY_LAST_MS = 30_000;

export type JoinRequestsState =
  /** No fetch has answered yet. */
  | { kind: "loading" }
  | { kind: "shown"; list: JoinRequestList; stale: boolean }
  /** The first fetches failed: nothing to show but a plain error, retrying meanwhile. */
  | { kind: "error"; message: string };

export type JoinRequestsLoader = {
  readonly state: JoinRequestsState;
  /** A signal (or a snapshot) says the list may have changed. Starts a fresh numbered fetch and drops the retry wait. */
  refresh(): void;
  subscribe(listener: () => void): () => void;
  stop(): void;
};

/**
 * The list's fetches, numbered as the player link's are
 * (playerLinkLoader.ts): only the newest answer shows, so an old answer
 * landing late never undoes a newer one. A failed fetch tries again on the
 * back-off above until one answers or a newer signal starts a fresh fetch.
 * A list already showing keeps its rows and says it is stale.
 */
export function createJoinRequestsLoader(deps: {
  clock: Clock;
  fetch(): Promise<JoinRequestList>;
  describe(err: unknown): string;
}): JoinRequestsLoader {
  let state: JoinRequestsState = { kind: "loading" };
  let latest = 0;
  let failures = 0;
  let retry: unknown = null;
  let stopped = false;
  const listeners = new Set<() => void>();
  const set = (next: JoinRequestsState) => {
    state = next;
    for (const l of [...listeners]) l();
  };
  const clearRetry = () => {
    if (retry !== null) deps.clock.clearTimeout(retry);
    retry = null;
  };

  const start = async (fresh: boolean) => {
    if (stopped) return;
    clearRetry();
    if (fresh) failures = 0;
    const request = ++latest;
    let list: JoinRequestList | null = null;
    let error: unknown = null;
    try {
      list = await deps.fetch();
    } catch (err) {
      error = err;
    }
    if (request !== latest || stopped) return;
    if (list) {
      failures = 0;
      set({ kind: "shown", list, stale: false });
      return;
    }
    set(state.kind === "shown" ? { kind: "shown", list: state.list, stale: true } : { kind: "error", message: deps.describe(error) });
    const wait = RETRY_MS[failures] ?? RETRY_LAST_MS;
    failures++;
    retry = deps.clock.setTimeout(() => {
      retry = null;
      void start(false);
    }, wait);
  };

  return {
    get state() {
      return state;
    },
    refresh() {
      void start(true);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      latest++;
      clearRetry();
    },
  };
}
