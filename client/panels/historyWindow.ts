import { compareLogIds } from "#shared/keys.ts";
import { mergeLog, trimmedOff } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { ApiError } from "../lib/api.ts";

/**
 * The Log panel's window on the room's archive (docs/design-v1-log-history.md
 * 5.3): which older or newer lines it holds besides the live log, and the
 * page it is waiting for.
 *
 * The live log stays as the room sends it. Show older adds archive pages
 * above it, and keeps the lines the live log drops off its front, so no gap
 * opens between the two while new lines come in. The panel draws at most
 * HISTORY_ROWS rows of history: past that, the oldest held rows go while
 * the window meets the live log, and once a page would push the live log
 * out the window parts from it ("history"). Then it holds archive rows
 * alone, Show newer pages forward, and Back to latest returns to the live
 * log. A phone never draws or keeps the whole archive.
 *
 * A page applies only when it answers the request still waiting, for the
 * same viewer, from the edge the window still has. Anything else, a late
 * answer after an abort, a reply for another room, viewer, scene, preview
 * or blackout state, or one from an edge the live log has since moved, is dropped, so a page
 * never merges into a window it was not read beside.
 */

/** The most rows of history the panel holds and draws. */
export const HISTORY_ROWS = 500;

export type Direction = "older" | "newer";

/** A page as GET /log gives it, oldest first. `nextAfter` is absent from a server before history paging. */
export type HistoryPage = { entries: readonly LogEntry[]; nextBefore: string | null; nextAfter?: string | null };

/** One page asked for: before an id, after one, or neither for the newest. */
export type PageAsk = { before?: string; after?: string };

export type HistoryState = {
  /** Who the window is for: room, member, role, scene, preview and blackout. A new one starts over. */
  readonly key: string;
  /** "live": `rows` sit above the live log, which goes on under them. "history": `rows` are the whole window. */
  readonly mode: "live" | "history";
  /** Oldest first. In "live" mode never a line the live log holds. */
  readonly rows: readonly LogEntry[];
  /**
   * The id the next older page reads before. In "live" mode null means the
   * live log's oldest line, or the newest page when the live log is empty.
   */
  readonly before: string | null;
  /** The last older page came back short or empty: nothing older is readable. */
  readonly start: boolean;
  /** "history" mode: the id the next newer page reads after, the window's newest row. */
  readonly after: string | null;
  /** "history" mode: the last newer page came back short or empty. */
  readonly end: boolean;
  readonly loading: Direction | null;
  readonly failed: { readonly dir: Direction; readonly error: unknown } | null;
  /** The server has no archive route (404). */
  readonly unavailable: boolean;
  /** What the last finished page did, for a polite status line. Never a count. */
  readonly said: string;
};

export const SAID = {
  older: "Older messages loaded.",
  // Not the visible line's words, which stand where Show older stood: a status saying the same would read twice.
  start: "You reached the start of the log.",
  newer: "Newer messages loaded.",
  noNewer: "No newer messages.",
} as const;

/**
 * Whose window it is: what the server projects a page for. A player's
 * lines, and a previewed player's, depend on the scene on screen (sight,
 * and who holds what there), so a new scene starts the window over and
 * drops a page still on its way. Blackout and resume also reset these
 * projected windows, since pausing changes which HP lines are readable.
 * A DM reads every line whole, so their own window stays across both.
 */
export function historyKey(viewer: { roomId: string; memberId: string; role: string; sceneId: string | null; previewOf: string | null; blackout: boolean }): string {
  const ownDm = viewer.role === "dm" && viewer.previewOf === null;
  const scene = ownDm ? "" : (viewer.sceneId ?? "");
  const blackout = ownDm ? "" : viewer.blackout ? "paused" : "live";
  return [viewer.roomId, viewer.memberId, viewer.role, viewer.previewOf ?? "", scene, blackout].join("|");
}

export function freshHistory(key: string): HistoryState {
  return { key, mode: "live", rows: [], before: null, start: false, after: null, end: false, loading: null, failed: null, unavailable: false, said: "" };
}

/** Where the next older page starts, as a request records it and its answer checks it. */
function olderEdge(state: HistoryState, main: readonly LogEntry[]): string | null {
  return state.before ?? (state.mode === "live" ? (main[0]?.id ?? null) : null);
}

/** A page's lines in id order, once each, and strictly past `at` in the direction asked. */
function pageLines(page: HistoryPage, dir: Direction, at: string | null): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const e of page.entries) {
    if (seen.has(e.id)) continue;
    if (at !== null && (dir === "older" ? compareLogIds(e.id, at) >= 0 : compareLogIds(e.id, at) <= 0)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => compareLogIds(a.id, b.id));
}

function withoutLive(rows: readonly LogEntry[], main: readonly LogEntry[]): LogEntry[] {
  if (main.length === 0) return [...rows];
  const live = new Set(main.map((e) => e.id));
  return rows.filter((e) => !live.has(e.id));
}

type Pending = { readonly dir: Direction; readonly at: string | null; readonly abort: AbortController };

export type HistoryOptions = {
  key: string;
  fetch(ask: PageAsk, signal: AbortSignal): Promise<HistoryPage>;
  /**
   * Called just before rows go in or out, so the panel can note the row its
   * reader is on and hold it in place: for a page that landed ("page"), or
   * for new live lines ("live"), which a reader at the end follows instead.
   */
  beforeMove?(why: "page" | "live"): void;
};

/**
 * The window and its one request at a time. The panel calls `sync` with
 * every live log it draws and its viewer's key, and draws `state`.
 */
export class HistoryWindow {
  #state: HistoryState;
  #main: readonly LogEntry[] = [];
  #liveCount = 0;
  #pending: Pending | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #fetch: HistoryOptions["fetch"];
  readonly #beforeMove: (why: "page" | "live") => void;

  constructor(options: HistoryOptions) {
    this.#state = freshHistory(options.key);
    this.#fetch = options.fetch;
    this.#beforeMove = options.beforeMove ?? (() => {});
  }

  get state(): HistoryState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The live log as the panel holds it now: the room log (`main`, without
   * trap lines, which reach no archive) and how many rows the live view
   * draws (`liveCount`, trap lines among them).
   */
  sync(key: string, main: readonly LogEntry[], liveCount: number): void {
    const prev = this.#main;
    this.#main = main;
    this.#liveCount = liveCount;
    if (key !== this.#state.key) {
      this.#cancel();
      this.#set(freshHistory(key));
      return;
    }
    const s = this.#state;
    // Nothing older held or asked for: the live view alone, as the room sends it.
    if (s.mode !== "live" || (s.rows.length === 0 && s.before === null)) return;
    // The live log jumped past every line the panel held, as after a long time offline, or came back
    // from empty beside held rows. Lines may lie between that no page ever read, and a first live line
    // looks the same whether it follows the held rows or not, so the window parts from the live log,
    // and Show newer reads on up to it.
    const jumped = prev.length > 0 && main.length > 0 && compareLogIds(prev[prev.length - 1]!.id, main[0]!.id) < 0;
    const refilled = prev.length === 0 && main.length > 0 && s.rows.length > 0;
    if (prev !== main && (jumped || refilled)) {
      this.#beforeMove("live");
      const all = mergeLog(s.rows, prev);
      const rows = all.slice(Math.max(0, all.length - HISTORY_ROWS));
      const cut = all.length > rows.length;
      this.#set({ ...s, mode: "history", rows, before: rows[0]!.id, start: cut ? false : s.start, after: rows[rows.length - 1]!.id, end: false });
      return;
    }
    const kept = prev === main ? s.rows : mergeLog(s.rows, trimmedOff(prev, main));
    const rows = withoutLive(kept, main);
    const room = Math.max(0, HISTORY_ROWS - liveCount);
    if (rows.length <= room) {
      if (rows.length !== s.rows.length || rows.some((e, i) => e !== s.rows[i])) this.#set({ ...s, rows });
      return;
    }
    // New lines push the oldest held rows out, and the next older page then starts after them again.
    this.#beforeMove("live");
    const left = rows.slice(rows.length - room);
    this.#set({ ...s, rows: left, before: left[0]?.id ?? null, start: false });
  }

  /** Show older. Ignored while a page is on its way, at the start, or on a server without the route. */
  older(): void {
    const s = this.#state;
    if (this.#pending || s.start || s.unavailable) return;
    const at = olderEdge(s, this.#main);
    // From here the live log's dropped lines are kept, so the page meets it without a gap.
    this.#ask("older", at, s.mode === "live" && s.before === null && at !== null ? { ...s, before: at } : s);
  }

  /** Show newer, in "history" mode. */
  newer(): void {
    const s = this.#state;
    if (this.#pending || s.mode !== "history" || s.end || s.after === null) return;
    this.#ask("newer", s.after, s);
  }

  /** Back to latest: the live log alone again. */
  latest(): void {
    this.#cancel();
    this.#set(freshHistory(this.#state.key));
  }

  /** Aborts the page on its way, as the panel closes. */
  dispose(): void {
    this.#cancel();
  }

  #ask(dir: Direction, at: string | null, from: HistoryState): void {
    const pending: Pending = { dir, at, abort: new AbortController() };
    this.#pending = pending;
    // Cleared while the page is on its way, so the same words when it lands are read out again.
    this.#set({ ...from, loading: dir, failed: null, said: "" });
    const ask: PageAsk = at === null ? {} : dir === "older" ? { before: at } : { after: at };
    let call: Promise<HistoryPage>;
    try {
      call = this.#fetch(ask, pending.abort.signal);
    } catch (err) {
      call = Promise.reject(err);
    }
    call.then(
      (page) => this.#answer(pending, page),
      (err: unknown) => this.#fail(pending, err),
    );
  }

  #cancel(): void {
    const p = this.#pending;
    this.#pending = null;
    p?.abort.abort();
  }

  #fail(p: Pending, error: unknown): void {
    if (this.#pending !== p) return;
    this.#pending = null;
    const s = this.#state;
    // A server without the archive route yet answers 404.
    if (error instanceof ApiError && error.status === 404) this.#set({ ...s, loading: null, unavailable: true });
    else this.#set({ ...s, loading: null, failed: { dir: p.dir, error } });
  }

  #answer(p: Pending, page: HistoryPage): void {
    // Back to latest and a new viewer abort the page on its way, so only the one still waiting may land.
    if (this.#pending !== p) return;
    this.#pending = null;
    const s = this.#state;
    const idle = { ...s, loading: null, failed: null };
    if (p.dir === "older") {
      // The live log moved the window's edge while this page was on its way: it would leave a gap, so it waits for another tap.
      if (olderEdge(s, this.#main) !== p.at) return this.#set(idle);
      const lines = pageLines(page, "older", p.at);
      // An empty page keeps the window and its way back, and ends only this direction.
      if (lines.length === 0) return this.#set({ ...idle, start: true, said: SAID.start });
      const start = page.nextBefore === null;
      const said = start ? `${SAID.older} ${SAID.start}` : SAID.older;
      this.#beforeMove("page");
      if (s.mode === "live") {
        const merged = withoutLive(mergeLog(lines, s.rows), this.#main);
        if (merged.length + this.#liveCount <= HISTORY_ROWS) return this.#set({ ...idle, rows: merged, before: lines[0]!.id, start, said });
        // The live log no longer fits under it: the window parts from the live log and keeps its oldest rows.
        const rows = mergeLog(merged, this.#main).slice(0, HISTORY_ROWS);
        return this.#set({ ...idle, mode: "history", rows, before: rows[0]!.id, start, after: rows[rows.length - 1]!.id, end: false, said });
      }
      const merged = mergeLog(lines, s.rows);
      const rows = merged.slice(0, HISTORY_ROWS);
      const cut = merged.length > rows.length;
      return this.#set({ ...idle, rows, before: rows[0]!.id, start, after: rows[rows.length - 1]!.id, end: cut ? false : s.end, said });
    }
    // Only an older page moves a newer edge, and it waits its turn, so a newer page always meets the window it left.
    const lines = pageLines(page, "newer", p.at);
    if (lines.length === 0) return this.#set({ ...idle, end: true, said: SAID.noNewer });
    this.#beforeMove("page");
    const merged = mergeLog(s.rows, lines);
    const rows = merged.slice(Math.max(0, merged.length - HISTORY_ROWS));
    const cut = merged.length > rows.length;
    this.#set({
      ...idle,
      rows,
      before: rows[0]!.id,
      start: cut ? false : s.start,
      after: rows[rows.length - 1]!.id,
      end: (page.nextAfter ?? null) === null,
      said: SAID.newer,
    });
  }

  #set(next: HistoryState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
