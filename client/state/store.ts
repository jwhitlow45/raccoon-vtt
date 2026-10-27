import { createStore, type StoreApi } from "zustand/vanilla";
import { uuidv7 } from "#shared/ids.ts";
import { parseKey } from "#shared/keys.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { applyChanges, projectLogEntry, type ProjectedState } from "#shared/project.ts";
import {
  clientOpSchema,
  type ClientMessage,
  type ClientOp,
  type EphEvent,
  type RefusalCode,
  type ServerMessage,
} from "#shared/protocol.ts";
import { reads, satisfies } from "#shared/reads.ts";
import { applyOp } from "#shared/reducer.ts";
import type { ConnectionState } from "../lib/connection.ts";
import { applyEph, clearTokens, keepLocal, keepMembers, nextExpiry, sweepEph } from "./ephemeral.ts";
import { SCENE_LOAD_IDLE, sceneLoadFailureText, stepSceneLoad, type SceneLoad, type SceneLoadEvent } from "./sceneLoad.ts";
import { shareRecord, shareState } from "./share.ts";
import { backoffDelay, realClock, Timer, type Clock } from "./timing.ts";
import { addToSelection, doneSelecting, keepSelected, selectToken, setMultiSelect, showActions, tapToken } from "./selection.ts";
import { panelById } from "../features/panels.ts";
import { crossWide, EMPTY_EPHEMERAL, INITIAL_LOCAL, MAX_REFUSED, withoutBelow, withoutPanel, withoutSheets, withPanel, withPanelList, withSheetExpanded, withSheetHidden, withSidePanelHidden, withSplit, withSplitFits, withSwap, type Ended, type LocalUi, type OnAnswer, type OpAnswer, type OpRefusal, type PanelHow, type PendingOp, type RoomView, type Toast, type ToastAction, type ToastDie, type UnknownCause, type You } from "./types.ts";

export type { PendingOp } from "./types.ts";

/**
 * The optimistic client (design section 7.4): `confirmed` is the last
 * projected state from the server, `pending` the ops sent or queued but not
 * yet answered, and `view` is `confirmed` with every pending op the client
 * can predict replayed through the shared reducer. Components read only
 * `view` and the other RoomView fields.
 *
 * The socket (socket.ts) owns the connection and feeds server messages in.
 * The store owns the op queue: numbering, sending in order, the answers,
 * retries, and resending after a reconnect.
 */

/** An op that has had no answer this long is resent with everything after it (design 7.4). */
export const OP_ANSWER_MS = 10_000;
/** Pending ops older than this are dropped on reconnect: the server keeps watermarks much longer, but nobody wants a 12 hour old edit. */
export const MAX_OP_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_TOASTS = 3;
/**
 * How long a toast (`notify`) stays on screen. The height readout
 * (features/builder/heights) stays as long, so a note and a reading that
 * show together go together.
 */
export const TOAST_MS = 5_000;

/** How long a toast with a button stays (types.ts ToastAction). */
export const ACTION_TOAST_MS = 12_000;

/**
 * How long each toast has left, counted from when it was first drawn
 * (`shownAt`), so a toast that comes or goes never gives the others more
 * time: TOAST_MS, or ACTION_TOAST_MS for one with a button. Counted from
 * each change instead, a stack that keeps changing, as whispers and
 * refusals arriving in turn, kept every toast up long past its time.
 *
 * A toast not drawn yet has its whole time left, and one shown whole has
 * what it had left as it stopped (`pausedAt`). Neither `runs`, so neither
 * gets a timer, and neither runs out unseen (docs/design-v1-bar-compact.md
 * 3.5, review BC-OPUS-35).
 */
export function toastsLeft(toasts: readonly Toast[], now: number): { id: number; ms: number; runs: boolean }[] {
  return toasts.map((t) => {
    const whole = t.action ? ACTION_TOAST_MS : TOAST_MS;
    if (t.shownAt === undefined) return { id: t.id, ms: whole, runs: false };
    const at = t.pausedAt ?? now;
    return { id: t.id, ms: Math.max(0, t.shownAt + whole - at), runs: t.pausedAt === undefined };
  });
}

/** The toasts with each of `ids` drawn for the first time stamped `now`, starting its time. The same array when none is new. */
export function drawnToasts(toasts: readonly Toast[], ids: readonly number[], now: number): readonly Toast[] {
  if (!toasts.some((t) => t.shownAt === undefined && ids.includes(t.id))) return toasts;
  return toasts.map((t) => (t.shownAt === undefined && ids.includes(t.id) ? { ...t, shownAt: now } : t));
}

/**
 * The toasts with one held while it shows whole, its time stopped at
 * `now`, or let go, its start moved on by the time it was held so it runs
 * on from what it had left. A toast not drawn yet, or already in that
 * state, stays as it is. The same array when nothing changes.
 */
export function heldToasts(toasts: readonly Toast[], id: number, held: boolean, now: number): readonly Toast[] {
  const at = toasts.findIndex((t) => t.id === id);
  const toast = toasts[at];
  if (!toast || toast.shownAt === undefined || (toast.pausedAt !== undefined) === held) return toasts;
  const { pausedAt, ...rest } = toast;
  const next: Toast = held ? { ...toast, pausedAt: now } : { ...rest, shownAt: toast.shownAt + (now - (pausedAt ?? now)) };
  return toasts.map((t, i) => (i === at ? next : t));
}

/**
 * The toasts with one more added. Past MAX_TOASTS, only the oldest whose
 * words the log keeps and that has no button gives way, as when a stack
 * runs past its room (canvas/barDock.ts fitToasts, review FU22B-OP-4), so
 * a refusal, an error or a trap's Save and damage is never pushed off by
 * the toasts that follow it (reviews LP18-TO-1 and LP18-ASTRA-01). With
 * none such older than the new one, the stack grows past three instead,
 * and scrolls where it runs past its room. Each still goes with its own
 * time. The new toast always stays.
 */
export function withToast(toasts: readonly Toast[], toast: Toast): Toast[] {
  let out = [...toasts, toast];
  while (out.length > MAX_TOASTS) {
    const plain = out.slice(0, -1).findIndex((t) => t.logged === true && t.action === undefined);
    if (plain === -1) break;
    out = out.filter((_, i) => i !== plain);
  }
  return out;
}

/** Options for one dispatched op. */
export type DispatchOptions = {
  /**
   * An undo group id. Ops dispatched with the same group, one after
   * another, undo as one step: one brush stroke, or one room sent in bands.
   */
  group?: string;
  /** Told what became of the op once it settles (OpAnswer), with the reason when it was refused and how an `unknown` came about. */
  onAnswer?: OnAnswer;
  /**
   * The caller says itself what became of the op, so the store shows no
   * toast for its answer: "Teleport here" takes the stopped walk back with
   * an undo, and "Undid moving Thorn." would read as if the teleport had
   * been taken back.
   */
  quiet?: boolean;
};

export type RoomStoreState = RoomView & {
  /** The server's projected state, from the snapshot and every `ev` since. */
  confirmed: ProjectedState | null;
  /** The `seq` of the last snapshot or `ev`. */
  seq: number;
  /** Ops sent or queued, oldest first. A refusal or an ack removes one in the same update that applies its batch. */
  pending: readonly PendingOp[];
  sceneLoad: SceneLoad;
};

type Snapshot = Extract<ServerMessage, { t: "snapshot" }>;
type Ev = Extract<ServerMessage, { t: "ev" }>;

/** Where the store sends ops. `send` returns false when the socket is not open. */
export type Outbox = { send(msg: ClientMessage): boolean };

/** UI state setters for `local` (design section 14.1). They never touch the room. */
export type RoomUi = {
  setTool(id: string): void;
  /**
   * Selects a token, leaving its action bar as it is. Null lets go. `opens`
   * marks the viewer's own opening, such as a token just placed or
   * duplicated, which may move the map once so an upright phone's strip
   * clears the token (docs/design-v1-bar-compact.md 3.6).
   */
  select(tokenId: string | null, opts?: { opens?: boolean }): void;
  /** A tap on a token, on the map or its initiative row: select it and open its action bar (selection.ts). `add` adds it to the selection. */
  tap(tokenId: string | null, add?: boolean): void;
  /** Adds tokens to the selection, from a box dragged over them. */
  selectMany(tokenIds: readonly string[]): void;
  /** Drops tokens that are gone from the selection. */
  keepSelected(present: (tokenId: string) => boolean): void;
  setMultiSelect(on: boolean): void;
  /** Ends "Multi-select" and lets go of the group, as its Done does (selection.ts doneSelecting). */
  doneSelecting(): void;
  showActions(open: boolean): void;
  /** Opens a panel, in the pane `how` asks for or the one its rules choose (state/types.ts withPanel, docs/design-v1-split-panel.md 5.1). */
  openPanel(id: string, how?: PanelHow): void;
  closePanel(): void;
  /**
   * Opens or closes the side panel's second panel (state/types.ts withSplit,
   * withoutBelow): the role's start panel below the open one, or `pair`,
   * a split this device stored. Storing it is the page's (pages/splitPanes.ts).
   */
  splitPanels(on: boolean, pair?: { top: string; below: string }): void;
  /** The side panel's two panels change places. */
  swapPanels(): void;
  /** Whether the side panel holds two panels, as the Room page measured it, null while unknown (state/types.ts withSplitFits). */
  fitSplit(fits: boolean | null): void;
  /** Opens or closes a phone's list of every panel. Opening a panel takes the list's place. */
  showPanelList(open: boolean): void;
  /** Closes whatever sheet stands over a phone's map, a panel or the list of panels, in one change. */
  closeSheets(): void;
  /** Hides a phone's open panel with its state kept, or shows it again (state/types.ts withSheetHidden). */
  hideSheet(hidden: boolean): void;
  /** Fills the screen with a phone's upright sheet, or brings it back to its normal height (state/types.ts withSheetExpanded). */
  expandSheet(on: boolean): void;
  /** Hides or shows the side panel from 900 px up. Storing the choice is the page's (pages/sidePanel.ts). */
  hideSidePanel(hidden: boolean): void;
  /** The layout crossed 900 px, wider or narrower (state/types.ts crossWide). */
  crossWide(wide: boolean): void;
  /**
   * A short note from this page rather than the server, for this device
   * only: why a drag did nothing, or a whisper that arrived while the Log
   * is closed. Someone else's D20 Test leads with its die, and a reminder
   * may carry one button. `logged` says the log keeps its words too
   * (types.ts Toast).
   */
  notify(text: string, tone?: Toast["tone"], die?: ToastDie, action?: ToastAction, logged?: boolean): void;
  dismissToast(id: number): void;
  /** The toast layer drew these toasts: each drawn for the first time starts its time (toastsLeft). */
  toastsDrawn(ids: readonly number[]): void;
  /** A toast shown whole stops its time, and runs on from what it had left once it shrinks back (heldToasts, docs/design-v1-bar-compact.md 3.5). */
  holdToast(id: number, held: boolean): void;
  /** Hides the X-card with this id on this device (features/xcard). */
  dismissXcard(id: number): void;
};

export type RoomStore = {
  readonly store: StoreApi<RoomStoreState>;
  /** Fresh for every page load and kept only in memory, so a reload never reuses an `n` (design 7.4). */
  readonly clientId: string;
  readonly ui: RoomUi;

  // From the page.

  /** Queues an op, shows its predicted result at once, and sends it when the socket allows. Returns its `n`, or null when the op is malformed. */
  dispatch(op: ClientOp, opts?: DispatchOptions): number | null;
  /** Shows one of this device's own ephemeral events, as if it had come back from the server. */
  recordLocalEph(e: EphEvent): void;
  pushToast(text: string, tone?: Toast["tone"]): void;

  // From the socket.

  setOutbox(outbox: Outbox | null): void;
  /** Drops ops too old to save and says where the server should resume. Call right before sending `hello`. */
  prepareHello(): { clientId: string; resumeFrom: number };
  applySnapshot(msg: Snapshot): void;
  applyEv(msg: Ev): void;
  /** `retry` for one op: `busy` or `gap` (design 7.4). Scene retries are the socket's. */
  retryOps(n: number): void;
  receiveEph(from: string, e: EphEvent): void;
  /** `displays` is the number of table display sockets, which the server sends DM sockets only. */
  setPresence(online: string[], displays?: number): void;
  /** The server's `access` signal: what DM views show about getting in changed. */
  accessChanged(): void;
  /** The server's `xcard` message: someone tapped the X-card. */
  receiveXcard(at: string): void;
  /** The socket lost its snapshot (it closed, or the server asked for a resync): hold ops until the next snapshot. */
  suspend(): void;
  setConnection(state: ConnectionState): void;
  setYou(you: You): void;
  setEnded(ended: Ended): void;
  /** A step of a scene switch (sceneLoad.ts). A switch that fails says so in a toast. */
  trackScene(e: SceneLoadEvent): void;

  /** Stops every timer. The store still answers reads. */
  dispose(): void;
};

export type RoomStoreOptions = {
  roomId: string;
  you: You | null;
  clock?: Clock;
  random?: () => number;
  clientId?: string;
};

/**
 * Whether a refusal is the normal result of two people acting at once,
 * which needs no explanation: the thing was deleted or hidden under you,
 * and the view simply snaps back.
 */
function isRace(code: RefusalCode): boolean {
  return code === "gone";
}

/**
 * The toast for a refused op. A quota refusal says itself what is full,
 * the room or one scene (shared/limits.ts), so it is shown as it is: a
 * scene at one of its caps is not a full room.
 */
export function refusalText(code: RefusalCode, message: string): string {
  const detail = message.trim().replace(/\.$/, "");
  const sentence = detail ? detail[0]!.toUpperCase() + detail.slice(1) + "." : "";
  switch (code) {
    case "quota":
      return sentence ? `Not saved. ${sentence}` : "Not saved.";
    case "forbidden":
      return sentence || "You are not allowed to do that.";
    default:
      return sentence ? `Not saved. ${sentence}` : "Not saved.";
  }
}

/**
 * The toast that answers an undo or redo (design 7.7). Undo always says
 * what it took back, because the last change may be one the person forgot,
 * and a refusal reads as its own sentence: "Not saved." would be wrong,
 * since nothing was being saved.
 */
export function undoAnswer(t: "undo" | "redo", answer: { what: string | undefined } | { refused: string }): { text: string; tone: Toast["tone"] } {
  if ("what" in answer) {
    const verb = t === "undo" ? "Undid" : "Redid";
    return { text: answer.what ? `${verb} ${answer.what}.` : `${verb} your last ${t === "undo" ? "change" : "undone change"}.`, tone: "info" };
  }
  const detail = answer.refused.trim().replace(/\.$/, "");
  if (!detail) return { text: `Could not ${t}.`, tone: "error" };
  const text = detail[0]!.toUpperCase() + detail.slice(1) + ".";
  return { text, tone: /^nothing to /i.test(detail) ? "info" : "error" };
}

/** The entity keys an op names, for the `busy` spinners of ops that wait. */
function readKeys(op: ClientOp, state: RoomState): string[] {
  const r = reads(op, state);
  return "never" in r ? [] : r.keys.map((k) => k.key);
}

/**
 * The predicted op's log lines as the viewer's projection keeps them, by
 * the projection's own rules (shared/project.ts projectLogEntry): a player
 * keeps its shared lines and their own copies, without part readers, the
 * parts they could not read or the DM line a copy names, and with what
 * they may read of each event, such as HP and a hidden roll's mark, and
 * the DM keeps every line but the copies. No area reminder is shown ahead:
 * whether one reaches this viewer rests on the turn's record of who read
 * what (shared/reducer/reminded.ts), which only the server holds, so the
 * confirmed log brings it.
 */
export function predictedLines(state: RoomState, viewer: Viewer, seq: number, sceneId: string | null): RoomState {
  const prefix = `${seq}:`;
  if (!state.log.some((e) => e.id.startsWith(prefix))) return state;
  const log: LogEntry[] = [];
  for (const entry of state.log) {
    if (!entry.id.startsWith(prefix)) log.push(entry);
    else {
      const kept = keptLine(state, entry, viewer, sceneId);
      if (kept) log.push(kept);
    }
  }
  return { ...state, log };
}

function keptLine(state: RoomState, entry: LogEntry, viewer: Viewer, sceneId: string | null): LogEntry | null {
  if (entry.data?.type === "area") return null;
  return projectLogEntry(state, entry, viewer, { sceneId });
}

/**
 * Replays pending ops on top of `confirmed` (design 7.4). An op is replayed
 * only when the view holds everything it reads. An op whose target is gone,
 * or that the reducer refuses for any reason, is skipped: the server's
 * answer settles it either way.
 */
export function replayPending(input: {
  confirmed: ProjectedState;
  seq: number;
  pending: readonly PendingOp[];
  viewer: Viewer | null;
  sceneId: string | null;
}): { state: RoomState; waiting: string[] } {
  let state = input.confirmed as unknown as RoomState;
  const waiting: string[] = [];
  const viewer = input.viewer;
  input.pending.forEach((p, i) => {
    let predicted = false;
    if (viewer) {
      try {
        if (satisfies(reads(p.op, state), state as unknown as ProjectedState, viewer, { sceneId: input.sceneId })) {
          predicted = true;
          const seq = input.seq + 1 + i;
          const result = applyOp(state, p.op, viewer, { seq, at: new Date(p.at).toISOString() });
          if (result.ok) state = predictedLines(result.state, viewer, seq, input.sceneId);
        }
      } catch {
        // A projection can lack fields the reducer assumes. Not predicting is always safe.
        predicted = false;
      }
    }
    if (!predicted) {
      try {
        waiting.push(...readKeys(p.op, state));
      } catch {
        // Nothing to mark.
      }
    }
  });
  return { state, waiting };
}

const EMPTY_BUSY: Readonly<Record<string, true>> = Object.freeze({});

export function createRoomStore(options: RoomStoreOptions): RoomStore {
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const clientId = options.clientId ?? uuidv7();

  const initialLocal: LocalUi = INITIAL_LOCAL;
  const store = createStore<RoomStoreState>()(() => ({
    roomId: options.roomId,
    you: options.you,
    view: null,
    sceneId: null,
    connection: "connecting",
    online: [],
    accessVersion: 0,
    snapshots: 0,
    ephemeral: EMPTY_EPHEMERAL,
    busy: EMPTY_BUSY,
    toasts: [],
    ended: null,
    local: initialLocal,
    confirmed: null,
    seq: 0,
    pending: [],
    refused: [],
    trapped: [],
    sceneLoad: SCENE_LOAD_IDLE,
  }));

  let nextN = 1;
  let outbox: Outbox | null = null;
  /** A snapshot is applied on the current socket, so ops may go out. */
  let ready = false;
  /** When each op went out on the current socket. Kept out of the store, so sending causes no render. */
  const sentAt = new Map<number, number>();
  let retryAttempt = 0;
  const retryTimer = new Timer(clock);
  const answerTimer = new Timer(clock);
  const sweepTimer = new Timer(clock);
  let toastSeq = 0;
  let disposed = false;

  const get = () => store.getState();

  /** Rebuilds the view from `confirmed` and `pending`, sharing every entity that did not change. */
  function derive(next: Pick<RoomStoreState, "confirmed" | "seq" | "pending" | "you" | "sceneId">): Pick<RoomStoreState, "view" | "busy"> {
    const prev = get();
    if (!next.confirmed) return { view: null, busy: EMPTY_BUSY };
    let state = next.confirmed as unknown as RoomState;
    let busy: Readonly<Record<string, true>> = EMPTY_BUSY;
    if (next.pending.length > 0) {
      const replay = replayPending({
        confirmed: next.confirmed,
        seq: next.seq,
        pending: next.pending,
        viewer: next.you,
        sceneId: next.sceneId,
      });
      state = replay.state;
      if (replay.waiting.length > 0) busy = shareRecord(prev.busy, Object.fromEntries(replay.waiting.map((k) => [k, true as const])));
    }
    return { view: shareState(prev.view, state), busy };
  }

  /** One store update with a fresh view. */
  /**
   * Tells each settled op's sender what became of it (OpAnswer), after the
   * store holds the settled state, so a sender that reads the view sees it.
   * Each op is told once: it has left `pending` by then.
   */
  function tell(ops: readonly PendingOp[], answer: (p: PendingOp) => OpAnswer, refusal?: (p: PendingOp) => OpRefusal | undefined, unknown?: UnknownCause, stamped?: ReadonlyMap<number, string>, blocked?: ReadonlySet<number>): void {
    for (const p of ops) {
      const a = answer(p);
      const at = a === "taken" ? stamped?.get(p.n) : undefined;
      if (a === "unknown" && unknown) p.onAnswer?.(a, undefined, unknown);
      else if (a === "taken" && blocked?.has(p.n)) p.onAnswer?.(a, undefined, undefined, at, true);
      else if (at !== undefined) p.onAnswer?.(a, undefined, undefined, at);
      else p.onAnswer?.(a, refusal?.(p));
    }
  }

  function commit(patch: Partial<RoomStoreState>): void {
    const s = get();
    const next = {
      confirmed: patch.confirmed !== undefined ? patch.confirmed : s.confirmed,
      seq: patch.seq ?? s.seq,
      pending: patch.pending ?? s.pending,
      you: patch.you !== undefined ? patch.you : s.you,
      sceneId: patch.sceneId !== undefined ? patch.sceneId : s.sceneId,
    };
    store.setState({ ...patch, ...derive(next) });
  }

  function setEphemeral(ephemeral: RoomStoreState["ephemeral"], extra: Partial<RoomStoreState> = {}): void {
    if (ephemeral !== get().ephemeral) store.setState({ ...extra, ephemeral });
    else if (Object.keys(extra).length > 0) store.setState(extra);
    armSweep();
  }

  function armSweep(): void {
    if (disposed) return;
    const due = nextExpiry(get().ephemeral);
    if (due === null) {
      sweepTimer.clear();
      return;
    }
    if (sweepTimer.pending && sweepTimer.due === due) return;
    sweepTimer.set(Math.max(0, due - clock.now()), () => {
      const swept = sweepEph(get().ephemeral, clock.now());
      setEphemeral(swept);
    });
  }

  function pushToast(text: string, tone: Toast["tone"] = "error", die?: ToastDie, action?: ToastAction, logged = false): void {
    const toasts = get().toasts;
    if (toasts.some((t) => t.text === text)) return;
    store.setState({ toasts: withToast(toasts, { id: ++toastSeq, text, tone, ...(die ? { die } : {}), ...(action ? { action } : {}), ...(logged ? { logged: true as const } : {}) }) });
  }

  // ------------------------------------------------------------ sending

  /** Sends every op not yet sent on this socket, oldest first, and stops at the first that cannot go. */
  function flush(): void {
    if (!ready || !outbox || retryTimer.pending || disposed) return;
    const now = clock.now();
    for (const p of get().pending) {
      if (sentAt.has(p.n)) continue;
      if (!outbox.send(p.group === undefined ? { t: "op", n: p.n, op: p.op } : { t: "op", n: p.n, op: p.op, g: p.group })) break;
      sentAt.set(p.n, now);
    }
    armAnswerTimer();
  }

  function resendAll(): void {
    sentAt.clear();
    flush();
  }

  /** One timer for the oldest unanswered op, so a quiet socket costs nothing. */
  function armAnswerTimer(): void {
    if (!ready || retryTimer.pending || disposed || sentAt.size === 0) {
      answerTimer.clear();
      return;
    }
    let oldest = Number.POSITIVE_INFINITY;
    for (const t of sentAt.values()) oldest = Math.min(oldest, t);
    const due = oldest + OP_ANSWER_MS;
    if (answerTimer.pending && answerTimer.due === due) return;
    answerTimer.set(Math.max(0, due - clock.now()), () => {
      const now = clock.now();
      if ([...sentAt.values()].some((t) => now - t >= OP_ANSWER_MS)) resendAll();
      else armAnswerTimer();
    });
  }

  // ------------------------------------------------------------ the store object

  const setLocal = (local: LocalUi) => {
    if (local !== get().local) store.setState({ local });
  };

  const ui: RoomUi = {
    setTool(id) {
      const local = get().local;
      if (local.tool !== id) store.setState({ local: { ...local, tool: id } });
    },
    select(tokenId, opts) {
      setLocal(selectToken(get().local, tokenId, opts?.opens === true));
    },
    tap(tokenId, add) {
      setLocal(tapToken(get().local, tokenId, add));
    },
    selectMany(tokenIds) {
      setLocal(addToSelection(get().local, tokenIds));
    },
    keepSelected(present) {
      setLocal(keepSelected(get().local, present));
    },
    setMultiSelect(on) {
      setLocal(setMultiSelect(get().local, on));
    },
    doneSelecting() {
      setLocal(doneSelecting(get().local));
    },
    showActions(open) {
      setLocal(showActions(get().local, open));
    },
    openPanel(id, how) {
      setLocal(withPanel(get().local, id, how, panelById(id)?.narrowOnly === true));
    },
    splitPanels(on, pair) {
      const local = get().local;
      setLocal(on ? withSplit(local, get().you?.role ?? "player", pair) : withoutBelow(local));
    },
    swapPanels() {
      setLocal(withSwap(get().local));
    },
    fitSplit(fits) {
      setLocal(withSplitFits(get().local, fits));
    },
    showPanelList(open) {
      setLocal(withPanelList(get().local, open));
    },
    closePanel() {
      setLocal(withoutPanel(get().local));
    },
    closeSheets() {
      setLocal(withoutSheets(get().local));
    },
    hideSheet(hidden) {
      setLocal(withSheetHidden(get().local, hidden));
    },
    expandSheet(on) {
      setLocal(withSheetExpanded(get().local, on));
    },
    hideSidePanel(hidden) {
      setLocal(withSidePanelHidden(get().local, hidden));
    },
    crossWide(wide) {
      setLocal(crossWide(get().local, wide));
    },
    notify(text, tone = "info", die, action, logged) {
      pushToast(text, tone, die, action, logged);
    },
    dismissToast(id) {
      const toasts = get().toasts;
      if (toasts.some((t) => t.id === id)) store.setState({ toasts: toasts.filter((t) => t.id !== id) });
    },
    toastsDrawn(ids) {
      const toasts = drawnToasts(get().toasts, ids, Date.now());
      if (toasts !== get().toasts) store.setState({ toasts: [...toasts] });
    },
    holdToast(id, held) {
      const toasts = heldToasts(get().toasts, id, held, Date.now());
      if (toasts !== get().toasts) store.setState({ toasts: [...toasts] });
    },
    dismissXcard(id) {
      if ((get().xcardDismissed ?? 0) < id) store.setState({ xcardDismissed: id });
    },
  };

  return {
    store,
    clientId,
    ui,

    dispatch(op, opts) {
      const parsed = clientOpSchema.safeParse(op);
      if (!parsed.success) {
        console.error("raccoon: refusing to send a malformed op", op, parsed.error);
        pushToast("That change could not be sent.");
        return null;
      }
      const n = nextN++;
      const pendingOp: PendingOp = { n, op: parsed.data, at: clock.now() };
      if (opts?.group !== undefined) pendingOp.group = opts.group;
      if (opts?.onAnswer !== undefined) pendingOp.onAnswer = opts.onAnswer;
      if (opts?.quiet === true) pendingOp.quiet = true;
      commit({ pending: [...get().pending, pendingOp] });
      flush();
      return n;
    },

    recordLocalEph(e) {
      const s = get();
      if (!s.you) return;
      setEphemeral(applyEph(s.ephemeral, s.you.memberId, e, clock.now(), { local: true, role: s.you.role }));
    },

    pushToast,

    setOutbox(next) {
      outbox = next;
    },

    prepareHello() {
      const now = clock.now();
      const pending = get().pending;
      const fresh = pending.filter((p) => now - p.at <= MAX_OP_AGE_MS);
      const dropped = pending.length - fresh.length;
      if (dropped > 0) {
        for (const p of pending) if (now - p.at > MAX_OP_AGE_MS) sentAt.delete(p.n);
        commit({ pending: fresh });
        tell(pending.filter((p) => !fresh.includes(p)), () => "unknown", undefined, "expired");
        pushToast(dropped === 1 ? "1 offline edit was too old to save." : `${dropped} offline edits were too old to save.`, "info");
      }
      return { clientId, resumeFrom: fresh[0]?.n ?? nextN };
    },

    applySnapshot(msg) {
      const s = get();
      // A table display's projection is a player's who owns nothing (docs/design-v1-dm-tools.md 3.1), so its rules are a player's.
      const you: You = { memberId: msg.you.memberId, role: msg.you.role === "dm" ? "dm" : "player" };
      const sceneId = msg.you.sceneId;
      // Everything up to the watermark is already in the snapshot. A higher
      // watermark than anything sent would mean a reused clientId: never
      // hand out an `n` the server already considers settled.
      nextN = Math.max(nextN, msg.watermark + 1);
      const pending = s.pending.filter((p) => p.n > msg.watermark);
      // The snapshot holds what the server made of these, but not whether it refused one: its answer was lost with the socket.
      const lost = s.pending.filter((p) => p.n <= msg.watermark);
      sentAt.clear();
      retryTimer.clear();
      retryAttempt = 0;
      ready = true;
      const ephemeral = sceneId === s.sceneId ? keepLocal(s.ephemeral) : EMPTY_EPHEMERAL;
      // The server sends `access` only to a socket holding a snapshot, and
      // every snapshot ends a time without one: the first connection (the
      // room renders, and a DM view may fetch, before the first snapshot), a
      // reconnect, or a resync such as a scene switch. A signal may have been
      // missed in any of them, so each snapshot counts as one and the DM views
      // ask again.
      const accessVersion = s.accessVersion + 1;
      commit({
        confirmed: msg.state as ProjectedState,
        seq: msg.seq,
        pending,
        you,
        sceneId,
        ephemeral,
        accessVersion,
        snapshots: (s.snapshots ?? 0) + 1,
      });
      // Told after the commit, so a sender that looks at the view finds this snapshot in it.
      tell(lost, () => "unknown", undefined, "snapshot");
      armSweep();
      flush();
    },

    applyEv(msg) {
      const s = get();
      if (!s.confirmed) return;
      const confirmed = applyChanges(s.confirmed, msg.changes);
      const settled = new Set<number>(msg.acks ?? []);
      for (const r of msg.rejects ?? []) settled.add(r.n);
      let pending = s.pending;
      let refused = s.refused;
      let trapped = s.trapped;
      let toasts = s.toasts;
      const toast = (text: string, tone: Toast["tone"]) => {
        if (!toasts.some((t) => t.text === text)) toasts = withToast(toasts, { id: ++toastSeq, text, tone });
      };
      // Two undos of one kind of change read the same. The answer to the
      // second replaces the first as a new toast, so each press visibly lands.
      const renew = (text: string, tone: Toast["tone"]) => {
        toasts = withToast(toasts.filter((t) => t.text !== text), { id: ++toastSeq, text, tone });
      };
      if (settled.size > 0) {
        const restored = new Map((msg.restored ?? []).map((r) => [r.n, r.what]));
        for (const n of msg.acks ?? []) {
          const sent = pending.find((p) => p.n === n);
          const op = sent?.op;
          if ((op?.t !== "undo" && op?.t !== "redo") || sent?.quiet) continue;
          const answer = undoAnswer(op.t, { what: restored.get(n) });
          renew(answer.text, answer.tone);
        }
        for (const r of msg.rejects ?? []) {
          const sent = pending.find((p) => p.n === r.n);
          const op = sent?.op;
          if (!op || sent.quiet) continue;
          if (op.t === "undo" || op.t === "redo") {
            const answer = undoAnswer(op.t, { refused: r.message });
            renew(answer.text, answer.tone);
            continue;
          }
          if (isRace(r.code)) continue;
          toast(refusalText(r.code, r.message), "error");
        }
        pending = pending.filter((p) => !settled.has(p.n));
        if (msg.rejects?.length) refused = [...(refused ?? []), ...msg.rejects.map((r) => r.n)].slice(-MAX_REFUSED);
        if (msg.trapped?.length) trapped = [...(trapped ?? []), ...msg.trapped].slice(-MAX_REFUSED);
        for (const n of settled) sentAt.delete(n);
        retryAttempt = 0;
      }
      // An `ev` that touches a token settles any drag preview of it (design 7.6).
      const touchedTokens = new Set<string>();
      for (const change of msg.changes) {
        const parsed = parseKey(change.key);
        if (parsed?.kind === "token") touchedTokens.add(parsed.id);
      }
      let ephemeral = clearTokens(s.ephemeral, touchedTokens);
      // A player always sees the player scene, and the server moves players by
      // sending the new scene's contents in an ordinary `ev` rather than a
      // resync. So a player's scene follows the room's player scene here, or
      // the page would keep pointing at a scene the view no longer holds.
      let sceneId = s.sceneId;
      if (s.you?.role === "player" && confirmed.meta.playerSceneId !== s.sceneId) {
        sceneId = confirmed.meta.playerSceneId;
        ephemeral = EMPTY_EPHEMERAL;
      }
      commit({ confirmed, seq: msg.seq, pending, refused, trapped, toasts, ephemeral, sceneId });
      const refusedNow = new Map((msg.rejects ?? []).map((r) => [r.n, { code: r.code, message: r.message, text: refusalText(r.code, r.message) }]));
      tell(
        s.pending.filter((p) => settled.has(p.n)),
        (p) => (refusedNow.has(p.n) ? "refused" : "taken"),
        (p) => refusedNow.get(p.n),
        undefined,
        new Map((msg.stamped ?? []).map((s) => [s.n, s.at])),
        new Set(msg.blocked ?? []),
      );
      if (ephemeral !== s.ephemeral) armSweep();
      armAnswerTimer();
    },

    retryOps(n) {
      if (!get().pending.some((p) => p.n === n)) return;
      // Later retries in the same burst ride on the resend already scheduled.
      if (retryTimer.pending) return;
      answerTimer.clear();
      retryTimer.set(backoffDelay(retryAttempt++, random), resendAll);
    },

    receiveEph(from, e) {
      const s = get();
      if (e.k === "dragStart" || e.k === "dragMove" || e.k === "dragEnd") {
        // A preview of a token this view cannot show has nothing to draw.
        if (!s.view?.tokens[e.tokenId]) return;
      }
      setEphemeral(applyEph(s.ephemeral, from, e, clock.now(), { local: false, role: s.you?.role ?? "player" }));
    },

    setPresence(online, displays) {
      const s = get();
      setEphemeral(keepMembers(s.ephemeral, new Set(online)), { online, displays: displays ?? 0 });
    },

    accessChanged() {
      store.setState({ accessVersion: get().accessVersion + 1 });
    },

    receiveXcard(at) {
      store.setState({ xcard: { id: (get().xcard?.id ?? 0) + 1, at } });
    },

    suspend() {
      ready = false;
      sentAt.clear();
      retryTimer.clear();
      answerTimer.clear();
      const s = get();
      // Remote previews stop arriving with the socket. This device's own stay.
      setEphemeral(keepLocal(s.ephemeral));
    },

    setConnection(connection) {
      if (get().connection !== connection) store.setState({ connection });
    },

    setYou(you) {
      const s = get();
      if (s.you?.memberId === you.memberId && s.you.role === you.role) return;
      commit({ you });
    },

    trackScene(e) {
      const s = get();
      const { load, failed } = stepSceneLoad(s.sceneLoad, e);
      if (load !== s.sceneLoad) store.setState({ sceneLoad: load });
      if (failed) pushToast(sceneLoadFailureText(failed, s.view?.scenes[failed.sceneId]?.name));
    },

    setEnded(ended) {
      ready = false;
      retryTimer.clear();
      answerTimer.clear();
      store.setState({ ended });
    },

    dispose() {
      disposed = true;
      ready = false;
      outbox = null;
      retryTimer.clear();
      answerTimer.clear();
      sweepTimer.clear();
    },
  };
}
