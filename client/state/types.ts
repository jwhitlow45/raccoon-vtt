import type { HistoryActivation, HistoryCommand, HistoryView } from "./history.ts";
import type { UndoGroupOptions } from "#shared/undoContract.ts";
import type { DiceRoll, MemberId, RoomState, SceneId } from "#shared/model.ts";
import type { ClientOp, EphEvent, RefusalCode } from "#shared/protocol.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { ConnectionState } from "../lib/connection.ts";
import type { SceneLoad } from "./sceneLoad.ts";

/**
 * The shapes the Room page reads, kept free of React and the DOM so the
 * store and its tests run under plain Node.
 */

/** Who this device is in the room, from its grant. Authority is the server's: this only shapes the UI. */
export type You = { memberId: MemberId; role: "dm" | "player" };

type AoeEvent = Extract<EphEvent, { k: "aoe" }>;
type RulerEvent = Extract<EphEvent, { k: "ruler" }>;

/**
 * Ephemeral previews by member (design section 7.6). `local` marks this
 * device's own previews, echoed here so a renderer draws everyone's the
 * same way. Local previews never time out: the tool that made one ends it.
 * Remote ones are cleared when their end frame arrives, an `ev` settles
 * their token, the sender goes offline, the scene changes, a snapshot
 * replaces the state, or 3 s pass without a frame.
 */
export type DragPreview = {
  from: MemberId;
  tokenId: string;
  /** The latest frame's top-left corner, in cells. */
  x: number;
  y: number;
  /** The live route's corners, top-left, flattened (docs/design-v1-movement.md 6.5). */
  path?: number[];
  /** The leg's cost, which only the DM and the token's owners receive. */
  ft?: number;
  /** A `dragEnd` arrived. The preview holds the drop point until the token's `ev` lands, so the token never flashes back. */
  ended: boolean;
  /** When the latest frame arrived, in the store clock's milliseconds. */
  at: number;
};

export type RulerPreview = Omit<RulerEvent, "k" | "shared"> & { from: MemberId; shared: boolean; local: boolean; at: number };

export type AoePreview = Omit<AoeEvent, "k" | "shared"> & { from: MemberId; shared: boolean; local: boolean; at: number };

export type Ping = { id: number; from: MemberId; x: number; y: number; local: boolean; at: number };

/** Laser points carry their own time, so a renderer can fade the tail of the stroke. */
export type LaserTrail = { from: MemberId; on: boolean; points: { x: number; y: number; at: number }[]; local: boolean; at: number };

/** A DM's "look here". Only players' stores record one. `id` changes for every request, so a camera can react once. */
export type FocusRequest = { id: number; from: MemberId; x: number; y: number; zoom: number; at: number };

/**
 * A DM device's camera for table displays (docs/design-v1-dm-tools.md 3.1):
 * the center and size of its visible map area, in cells. Only a display's
 * store records one, since the server sends `view` to displays alone. `id`
 * changes for every event, so a display's camera can follow each once.
 */
export type ViewRequest = { id: number; from: MemberId; x: number; y: number; w: number; h: number; at: number; iso?: { turn: number; vw: number; vh: number } };

export type Ephemeral = {
  /** Keyed `"<from>|<tokenId>"`. */
  drags: Readonly<Record<string, DragPreview>>;
  /** Keyed `"<from>|<id>"`. */
  rulers: Readonly<Record<string, RulerPreview>>;
  /** Keyed `"<from>|<id>"`. */
  aoes: Readonly<Record<string, AoePreview>>;
  pings: readonly Ping[];
  /** Keyed by member. */
  lasers: Readonly<Record<MemberId, LaserTrail>>;
  focus: FocusRequest | null;
  /** The latest DM camera for table displays. Absent until one arrives. */
  view?: ViewRequest | null;
};

export const EMPTY_EPHEMERAL: Ephemeral = Object.freeze({
  drags: Object.freeze({}),
  rulers: Object.freeze({}),
  aoes: Object.freeze({}),
  pings: Object.freeze([]) as readonly Ping[],
  lasers: Object.freeze({}),
  focus: null,
});

/**
 * A refusal or notice on screen for a few seconds (store.ts toastsLeft).
 * `shownAt` is when it was first drawn, by `Date.now()`, kept on the toast
 * rather than by whatever draws it, so a blackout that takes the toasts
 * off screen and back never restarts its time (review LP16-R1-1). A toast
 * not drawn yet, as one waiting behind the one row over a short band, has
 * none, and its time has not started (docs/design-v1-bar-compact.md 3.5,
 * review BC-OPUS-35). `pausedAt` is when its time stopped while it shows
 * whole.
 * `logged` marks one whose words the log keeps, as a whisper's or a roll's,
 * the only kind a stack too tall for its room may drop (review
 * FU22B-OP-4): a refusal or an error that the log never sees stays.
 */
export type Toast = { id: number; text: string; rolls?: readonly DiceRoll[]; tone: "error" | "info"; die?: ToastDie; action?: ToastAction; shownAt?: number; pausedAt?: number; logged?: true };

/**
 * A toast's one button, beside its words, such as the falling off
 * reminder's "Ask for the save" (docs/design-v1-attach.md 4.5). Pressing it
 * runs `run` and dismisses the toast. A toast with one stays a while longer,
 * so there is time to reach it.
 */
/** A toast's button. While `ready` answers false a press does nothing, and the toast stays for a later one. */
export type ToastAction = { label: string; run(): void; ready?(): boolean };

/**
 * The flat d20 that leads a toast of someone else's D20 Test
 * (docs/design-v1-roll-animation.md 4): its kept face, a ring for a natural
 * 20 or a critical hit against an AC, an outline for a natural 1, and the
 * verdict's words for a screen reader.
 */
export type ToastDie = { face: number; ring: boolean; fumble: boolean; verdict: string | null };

/**
 * Someone tapped the X-card (docs/design-v1-dm-tools.md 3.11). `id` grows by
 * one for every card the server sends, so a device shows each card once
 * and can tell a new one from the one it dismissed. It names no one.
 */
export type XCardSignal = { id: number; at: string };

/**
 * What became of an op this page sent, told once to whoever asked when
 * dispatching it: `taken` only when the server acknowledged it, `refused`
 * when the server refused it, and `unknown` when it left the queue with no
 * answer heard. A snapshot after a reconnect settles the ops it covers
 * without saying which applied, and an op too old to send is dropped.
 */
export type OpAnswer = "taken" | "refused" | "unknown";

/**
 * How an `unknown` answer came about (docs/design-v1-pdf-handouts.md 4.1.5).
 * `snapshot`: a reconnect's snapshot settled the op, and the view already
 * holds that snapshot, so what the op did, if anything, is in it now.
 * `expired`: the op was too old to send and was dropped while the store
 * prepared its hello, before any new snapshot, so the view may still lack
 * an op that did commit, and only the next snapshot says.
 */
export type UnknownCause = "snapshot" | "expired";

/**
 * Told once what became of an op: its answer, the reason when refused, how
 * an `unknown` came about, when taken with a sync record that had no `at`,
 * the `at` the server wrote on it (docs/design-v1-resync.md 3.4), and when
 * taken as a walk the real build stopped short, `blocked`
 * (docs/design-v1-map-discovery.md 6): it landed at its last clear spot.
 */
export type OnAnswer = (answer: OpAnswer, refusal?: OpRefusal, unknown?: UnknownCause, stamped?: string, blocked?: true) => void;

/**
 * Why the server refused an op, told with a `refused` answer, for a sender
 * that shows the reason itself, such as a dialog over the room where a toast
 * would be out of sight. `text` is the toast's own wording (store.ts refusalText).
 */
export type OpRefusal = { code: RefusalCode; message: string; text: string };

export type PendingOp = {
  n: number;
  op: ClientOp;
  /** When the op was made, in the store clock's milliseconds. */
  at: number;
  /** The undo group it was sent under, if any (design 7.7). */
  group?: string;
  groupScope?: "setup";
  /** Told the op's answer once it settles (OpAnswer), with the reason when it was refused. */
  onAnswer?: OnAnswer;
  /** The caller says what became of it, except retained history blockers (DispatchOptions). */
  quiet?: true;
  /** A gesture's last ask: the ops it holds until it is answered, none once the gesture was cancelled (DispatchOptions). */
  holds?: () => readonly ClientOp[];
};

/**
 * Why the room closed for good (design section 7.1 close codes): the grant
 * was revoked (4001, after GET /me confirms no grant is left), the server
 * refused this device (4003), or the room was deleted (4009).
 */
export type Ended = { kind: "revoked" | "denied" | "deleted"; code: number };

/** UI state that never leaves the device (design section 14.1, `local`). */
export type LocalUi = {
  /** The active tool's id from client/features/tools.ts. */
  tool: string;
  /** The selected token: the last of `selectedIds`, the one the single-token views show. */
  selectedId: string | null;
  /** Every selected token, in the order picked (state/selection.ts). */
  selectedIds: readonly string[];
  /** "Multi-select": a tap adds a token to the selection or takes it out, instead of picking only it. */
  multi: boolean;
  /** Whether the selected token's action bar shows (design 14.3). It opens on a tap and steps aside for the token's panel. */
  actionBar: boolean;
  /**
   * The viewer's latest opening of the action bar, a new object for each:
   * a tap, Actions or another show, or a select that asks for it, naming
   * the token it opened for. `gather` marks a tap that gathers or takes
   * out a token in Multi-select. An upright phone's strip may move the map
   * once for it to clear the token (state/selection.ts,
   * docs/design-v1-bar-compact.md 3.6). Null once the bar is off.
   */
  opening: Opening | null;
  /** The panel open as a sheet on phones, or null. */
  panel: string | null;
  /** A phone's Panels sheet, the list of every panel, is open (pages/Room.tsx). Read with `sheetOpen`. */
  panelList: boolean;
  /** The side panel's tab from 900 px up. */
  tab: string;
  /**
   * The side panel is hidden, from 900 px up (docs/design-v1-layout-hierarchy.md
   * 4.1). Its first value on a page comes from this device's choice or the
   * short screen's default (pages/sidePanel.ts).
   */
  sidePanelHidden: boolean;
  /**
   * A phone's open panel is hidden by Hide in its sheet's header (4.2): the
   * panel stays mounted with its state and scroll, and Panels shows it again.
   * Only for this page, never stored.
   */
  sheetHidden: boolean;
  /**
   * The panel below `tab` in the side panel (docs/design-v1-split-panel.md),
   * or null with one panel: the split. Kept on a phone and in a side panel
   * too short for two, so the pair shows again once there is room, and
   * never `tab` itself or a phone-only panel.
   */
  below: string | null;
  /**
   * Whether the side panel holds two panels (3.2), set by the Room page:
   * false below 900 px, and null while unknown, as while the side panel is
   * hidden, since a hidden box measures nothing. Only for this page.
   */
  splitFits: boolean | null;
  /** A request to open a panel that waits for the room to be measured before it is placed (5.1, `withSplitFits`). */
  pendingOpen: PendingOpen | null;
  /**
   * A phone's upright sheet fills the screen (docs/design-v1-sheet-swipe.md
   * 4.7), by a swipe up or its Expand sheet button. Every open starts at the
   * normal height, and only the sheet's closing or its replacement ends it:
   * a subpage, Hide, a rotation and the crossing of 900 px keep it latent,
   * shaping nothing until the sheet stands upright again. Never stored.
   */
  sheetExpanded: boolean;
};

/**
 * How a panel was asked for (docs/design-v1-split-panel.md 5.1): in a pane
 * by name, the top by a tab, More or a phone's list and the bottom by the
 * bar's name, or by a link inside a panel, `from` naming that panel. Left
 * out for every path outside the panels.
 */
export type PanelHow = { pane: "top" | "below" } | { from: string };

export type PendingOpen = { id: string; how?: PanelHow };

export const DEFAULT_TOOL = "select";

/** One opening of the action bar by the viewer (LocalUi `opening`). */
export type Opening = { tokenId: string; gather: boolean };

export const INITIAL_LOCAL: LocalUi = Object.freeze({
  tool: DEFAULT_TOOL,
  selectedId: null,
  selectedIds: Object.freeze([]) as readonly string[],
  multi: false,
  actionBar: false,
  opening: null,
  panel: null,
  panelList: false,
  tab: "tracker",
  sidePanelHidden: false,
  sheetHidden: false,
  below: null,
  splitFits: null,
  pendingOpen: null,
  sheetExpanded: false,
});

/**
 * Whether a sheet covers the bottom of a phone's map: a panel, or the list
 * of panels. What floats over the map, such as the fight's alert cards,
 * steps aside or folds for either. A hidden sheet covers nothing.
 */
export function sheetOpen(local: Pick<LocalUi, "panel" | "panelList" | "sheetHidden">): boolean {
  return (local.panel !== null && !local.sheetHidden) || local.panelList;
}

/**
 * What the panels show (docs/design-v1-layout-hierarchy.md 4.2): the panel
 * that is mounted, in a phone's sheet or as the side panel's tab, whether it
 * is on screen, whether a phone's list of panels shows, and whether the
 * Token panel is the one on screen. A hidden sheet or side panel keeps its
 * panel mounted, so every reader asks this rather than `local.panel`.
 */
export type PanelView = { panel: string | null; shown: boolean; list: boolean; tokenShown: boolean };

export function panelView(local: Pick<LocalUi, "panel" | "panelList" | "tab" | "sidePanelHidden" | "sheetHidden">, wide: boolean): PanelView {
  if (wide) {
    const shown = !local.sidePanelHidden;
    return { panel: local.tab, shown, list: false, tokenShown: shown && local.tab === "token" };
  }
  const shown = local.panel !== null && !local.sheetHidden;
  return { panel: local.panel, shown, list: local.panelList && !shown, tokenShown: shown && local.panel === "token" };
}

/*
 * The panels' changes of state, shared by the room's store and a "view as a
 * player" preview (features/dm/preview.ts), so the two follow one rule. Each
 * hands back the same object when nothing changes, so nothing renders.
 */

/** The same object when every field of `patch` already holds, so nothing renders. */
function patched(local: LocalUi, patch: Partial<LocalUi>): LocalUi {
  return (Object.keys(patch) as (keyof LocalUi)[]).every((k) => local[k] === patch[k]) ? local : { ...local, ...patch };
}

/** Whether two panels show: a split is kept and the side panel holds both (3.2). */
export function twoShow(local: Pick<LocalUi, "below" | "splitFits">): boolean {
  return local.below !== null && local.splitFits === true;
}

/** Which panel goes on top and which below, by the rules of docs/design-v1-split-panel.md 5.1. Pure and total. */
function placed(local: LocalUi, id: string, how: PanelHow | undefined): Pick<LocalUi, "tab" | "below"> {
  const { tab, below } = local;
  const same = { tab, below };
  const swapped = { tab: below ?? tab, below: below === null ? null : tab };
  // Rule 1: one shows. The panel goes on top, and a kept split never holds it twice.
  if (!twoShow(local)) return id === below ? swapped : { tab: id, below };
  // Rule 2: a pane named. The panel goes there, taken from the other one by a swap.
  if (how && "pane" in how) {
    if (how.pane === "top") return id === tab ? same : id === below ? swapped : { tab: id, below };
    return id === below ? same : id === tab ? swapped : { tab, below: id };
  }
  // Rule 3: a link to a panel already open leaves it where it is.
  if (id === tab || id === below) return same;
  // Rule 4: a link opens in the pane it was not pressed in, so it never covers the panel it sits in.
  return how && how.from === below ? { tab: id, below } : { tab, below: id };
}

/**
 * Opens a panel (docs/design-v1-split-panel.md 5.1): as a sheet below
 * 900 px, and from there up on top or below by how it was asked. A hidden
 * side panel or sheet never swallows a request to see a panel. `panel`,
 * the phone's sheet, becomes it, so a rotation shows the panel opened last.
 *
 * A phone-only panel (rule 0) becomes the sheet alone and leaves the pair
 * as it was, so the side panel never meets it. With a split kept and the
 * room unknown, the request waits in `pendingOpen` until the Room page
 * measures it (withSplitFits), since which pane it lands in depends on
 * whether two show. A later request replaces a waiting one.
 */
export function withPanel(local: LocalUi, id: string, how?: PanelHow, phoneOnly = false): LocalUi {
  const shown = { panelList: false, sidePanelHidden: false, sheetHidden: false } as const;
  // Another panel opens at its normal height (docs/design-v1-sheet-swipe.md 4.7).
  const sheetExpanded = local.panel === id && local.sheetExpanded;
  if (phoneOnly) return patched(local, { ...shown, panel: id, pendingOpen: null, sheetExpanded });
  if (local.below !== null && local.splitFits === null) return patched(local, { ...shown, pendingOpen: how ? { id, how } : { id } });
  return patched(local, { ...shown, ...placed(local, id, how), panel: id, pendingOpen: null, sheetExpanded });
}

/** The panel the bottom pane starts on (4.2): the role's stats, the DM's Token or a player's Characters, or Initiative when the stats are on top. */
export function startBelow(top: string, role: "dm" | "player"): string {
  const stats = role === "dm" ? "token" : "characters";
  return top === stats ? "tracker" : stats;
}

/**
 * Opens the split ("Two panels", 4.1): the open panel stays on top and the
 * role's start panel goes below. `pair`, a split this device stored (8),
 * sets both instead. An open split, or a pair that names one panel twice,
 * changes nothing.
 */
export function withSplit(local: LocalUi, role: "dm" | "player", pair?: { top: string; below: string }): LocalUi {
  if (pair) return pair.top === pair.below ? local : patched(local, { tab: pair.top, below: pair.below });
  return local.below !== null ? local : { ...local, below: startBelow(local.tab, role) };
}

/**
 * Closes the bottom panel. The phone's sheet, which named it, names the
 * top one instead. A request that waited on the room's measure no longer
 * depends on it, so it is placed at once.
 */
export function withoutBelow(local: LocalUi): LocalUi {
  if (local.below === null) return local;
  const replaced = local.panel === local.below;
  const closed = { ...local, below: null, panel: replaced ? local.tab : local.panel, pendingOpen: null, sheetExpanded: !replaced && local.sheetExpanded };
  return local.pendingOpen ? withPanel(closed, local.pendingOpen.id, local.pendingOpen.how) : closed;
}

/** The two panels change places. */
export function withSwap(local: LocalUi): LocalUi {
  return local.below === null ? local : { ...local, tab: local.below, below: local.tab };
}

/**
 * The Room page's measure of the side panel (3.2): whether it holds two,
 * false below 900 px, null while unknown. A request that waited for it
 * (`pendingOpen`) is placed in the same change, so it never paints a frame
 * in the wrong pane.
 */
export function withSplitFits(local: LocalUi, fits: boolean | null): LocalUi {
  const next = local.splitFits === fits ? local : { ...local, splitFits: fits };
  const waiting = next.pendingOpen;
  if (waiting === null || fits === null) return next;
  return withPanel({ ...next, pendingOpen: null }, waiting.id, waiting.how);
}

/**
 * Opens or closes a phone's list of panels. Opening it drops a hidden
 * panel, as opening another panel would. Closing it leaves a hidden panel
 * hidden, which would otherwise pop up.
 */
export function withPanelList(local: LocalUi, open: boolean): LocalUi {
  if (open && local.sheetHidden) return { ...local, panel: null, panelList: true, sheetHidden: false, sheetExpanded: false };
  return local.panelList === open ? local : { ...local, panelList: open, sheetExpanded: false };
}

/** Closes the open panel for good. */
export function withoutPanel(local: LocalUi): LocalUi {
  if (local.panel === null && !local.sheetHidden) return local;
  return { ...local, panel: null, sheetHidden: false, sheetExpanded: false };
}

/** Closes whatever sheet stands over a phone's map, hidden or not. */
export function withoutSheets(local: LocalUi): LocalUi {
  if (local.panel === null && !local.panelList && !local.sheetHidden && !local.sheetExpanded) return local;
  return { ...local, panel: null, panelList: false, sheetHidden: false, sheetExpanded: false };
}

/** Fills the screen with a phone's upright sheet, or brings it back to its normal height. With no sheet there is nothing to fill. */
export function withSheetExpanded(local: LocalUi, on: boolean): LocalUi {
  const next = on && (local.panel !== null || local.panelList);
  return local.sheetExpanded === next ? local : { ...local, sheetExpanded: next };
}

/** Hides a phone's open panel, or shows it again. With no panel open there is nothing to hide. */
export function withSheetHidden(local: LocalUi, hidden: boolean): LocalUi {
  const next = hidden && local.panel !== null;
  return local.sheetHidden === next ? local : { ...local, sheetHidden: next };
}

export function withSidePanelHidden(local: LocalUi, hidden: boolean): LocalUi {
  return local.sidePanelHidden === hidden ? local : { ...local, sidePanelHidden: hidden };
}

/**
 * The layout crossed 900 px. A phone's hidden sheet means nothing beside a
 * side panel, which shows that panel's tab, shown or hidden by its own
 * state. Back below 900 px the side panel's tab opens as a sheet, as
 * `panel` holds it, hidden when the side panel was, so a panel the viewer
 * hid never pops up on a rotation. A sheet that fills the screen stays so,
 * latent, until it closes (withSheetExpanded).
 */
export function crossWide(local: LocalUi, wide: boolean): LocalUi {
  if (wide) return local.sheetHidden ? { ...local, sheetHidden: false } : local;
  return local.sidePanelHidden && local.panel !== null && !local.sheetHidden ? { ...local, sheetHidden: true } : local;
}

/**
 * The read-only view of a room that the Room page draws from.
 *
 * Read it with narrow selectors that return values already in the state,
 * such as `s => s.view?.tokens[id]`, so a component re-renders only when its
 * own slice changes. A selector must not build a new object or array on
 * every call. Derive those with useMemo from stable slices instead.
 */
export type RoomView = {
  history?: HistoryView;
  historyReview?: { scope: "play" | "setup"; direction?: "undo" | "redo" } | null;
  roomId: string;
  you: You | null;
  /**
   * The projected state with pending ops replayed (design section 7.4).
   * Null until the first snapshot is applied: the fail-closed gate (section
   * 13.3) keys on this, so nothing from any scene draws before it. Entities
   * that did not change keep their object identity across updates.
   */
  view: (RoomState & { meta: ProjectedState["meta"] }) | null;
  /** The scene shown: always the player scene for players, the DM's pick for a DM. */
  sceneId: SceneId | null;
  /** `open` only once the snapshot has arrived (section 7.5). */
  connection: ConnectionState;
  /** The scene this device asked for and is waiting on (sceneLoad.ts). A read-only player preview leaves it out. */
  sceneLoad?: SceneLoad;
  /** Members with at least one open socket. */
  online: MemberId[];
  /**
   * What the server is known to hold: the projected state before this
   * device's pending ops. A player preview leaves it out. Read it only to
   * learn what happened on the server, as a PDF upload's save does
   * (docs/design-v1-pdf-handouts.md 4.1.5). Everything shown reads `view`.
   */
  confirmed?: ProjectedState | null;
  /** Sequence of confirmed, before this device's pending operations. A player preview leaves it out. */
  seq?: number;
  /** A snapshot has arrived on the current connection. False during reconnect or resync, even while the old view remains visible. */
  confirmedReady?: boolean;
  /**
   * The server's time less this page's monotonic clock (Clock.elapsed), in
   * ms, learned from the times of log lines as they arrive (D-261031-140,
   * D-261031-170). The network's delay makes each reading low, never high,
   * so a time reckoned from it is never ahead of the server's. Anchored to
   * the monotonic clock, it holds through any correction of the device's
   * own clock. Absent until the first line arrives.
   */
  serverOffset?: number;
  /**
   * How many snapshots this page has applied, the first included, so code
   * that waits on the next one (an `expired` answer, UnknownCause) can tell
   * when it is in. A player preview, which applies none, leaves it out.
   */
  snapshots?: number;
  /** DM views only: how many table displays have a socket open (docs/design-v1-dm-tools.md 3.1). Absent reads as none. */
  displays?: number;
  /**
   * Counts the server's `access` signals, sent to DM sockets when the
   * player password changes or a DM device is added or signed out (design
   * 10.2), and every snapshot, the first included, since a signal sent
   * while this device held none never arrives. DM views that show either ask the
   * server again when it moves.
   */
  accessVersion: number;
  ephemeral: Ephemeral;
  /**
   * Entity keys (shared/keys.ts) that a pending op cannot predict and waits
   * on the server for, such as damage to a creature whose HP the player sees
   * only as a label. Show a small spinner on these.
   */
  busy: Readonly<Record<string, true>>;
  toasts: readonly Toast[];
  /** Since when a builder gesture has waited on its asks (store.ts holdBuild), while one does. It stops the time of a toast whose button waits on it (toastsLeft). A preview, which builds nothing, leaves it out. */
  buildHeldSince?: number;
  /** The latest X-card the server sent this page, if any (features/xcard). A player preview, which has no socket, leaves it out. */
  xcard?: XCardSignal;
  /**
   * The id of the last X-card dismissed on this device. It lives with the
   * room rather than in the card, since the handout popup waits while a
   * card shows (features/handouts/HandoutPopup.tsx).
   */
  xcardDismissed?: number;
  ended: Ended | null;
  local: LocalUi;
  /**
   * Ops sent or queued and not yet answered, oldest first (design 7.4). They
   * live only in this page's memory, so anything that reloads the page waits
   * for this to empty first.
   */
  pending: readonly PendingOp[];
  /**
   * The `n`s of this page's latest ops the server refused, oldest first, at
   * most MAX_REFUSED. An offer to follow up on an op, such as the token
   * bar's "Undo move", reads it to stop offering. A player preview, which
   * sends nothing, leaves it out.
   */
  refused?: readonly number[];
  /**
   * The `n`s of this page's latest ops whose trap step refuses their Undo
   * move, oldest first, at most MAX_REFUSED, as the server's ack marks them
   * (docs/design-v1-traps.md 6.5). The token bar reads it to stop offering
   * Undo move.
   */
  trapped?: readonly number[];
  /**
   * The DM's builder ops the server asked about before they push players'
   * remembered map past its cap (docs/design-v1-map-discovery.md 5.3,
   * FORGET_ASK), for the builder's forget question to answer once per
   * gesture: each refused op with its undo group, and once the DM said
   * yes, the `n`s it sent again with `forget`, until all are answered.
   */
  forgetAsk?: ForgetAsk | null;
};

/**
 * One gesture's ops waiting on the forget question (RoomView.forgetAsk).
 * `unsure` marks a yes one of whose ops was settled with its answer lost
 * while others still waited, so the question says the outcome is not known
 * whenever it closes (MD4-ASTRA-8).
 */
export type ForgetAsk = { asks: readonly ({ n: number; op: ClientOp } & UndoGroupOptions)[]; sending?: readonly number[]; unsure?: true };

/** How many refused op numbers RoomView.refused keeps. One `ev` rarely refuses more than a handful. */
export const MAX_REFUSED = 20;

/**
 * What the page can ask the room to do. Calls never wait for the server:
 * the view shows the predicted result at once, and a refusal snaps it back
 * with a toast (design section 7.4).
 */
export type RoomActions = {
  /**
   * Queues an op. Returns its `n`, or null when the op is malformed and was
   * not queued. Ops of one gesture that go out as several (a brush stroke,
   * a room sent in bands) share `group`, a fresh id from newId(), so one
   * undo takes the whole gesture back (design 7.7). `onAnswer` hears once
   * what became of it (OpAnswer).
   */
  dispatch(op: ClientOp | HistoryCommand, opts?: UndoGroupOptions & { onAnswer?: OnAnswer; quiet?: boolean; holds?: () => readonly ClientOp[] }): number | null;
  /**
   * Sends an ephemeral event on the current scene, coalesced to one per
   * animation frame (design 7.6), and shows it locally as this member's own.
   * `localOnly` shows it here without sending, for a preview that is private
   * until the person shares it, such as an AoE being aimed.
   */
  sendEph(e: EphEvent, opts?: { localOnly?: boolean }): void;
  /** DM only: view another scene. The latest pick wins. */
  switchScene(sceneId: SceneId): void;
  /** Sends an undo, or while a builder gesture waits on its asks, cancels the newest such gesture instead (holdBuild). */
  undo(options?: HistoryActivation): void;
  /** Sends a redo, or while a builder gesture waits on its asks, does nothing (holdBuild). */
  redo(options?: HistoryActivation): void;
  /**
   * A builder gesture waiting on its asks (builder/ask.ts, D-261027-07):
   * until the returned release is called, the store refuses at input
   * (null) every builder edit and every Undo or Redo of the stack's top,
   * whoever sends it (store.ts `overtakes`), so none overtakes it. Undo
   * calls `cancel` instead of sending an undo, and Redo does nothing.
   * Absent where nothing waits, as on a preview.
   */
  holdBuild?(cancel: () => void): () => void;
  /** A UUIDv7 for a create op (design section 6). */
  newId(): string;
  moveToken(tokenId: string, x: number, y: number): void;
  /** Moves several tokens at once, as one `token.moveMany` (lib/group.ts). */
  moveTokens(moves: readonly { tokenId: string; x: number; y: number }[]): void;
};
