import type { MemberId, RoomState, SceneId } from "#shared/model.ts";
import type { ClientOp, EphEvent, RefusalCode } from "#shared/protocol.ts";
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
  path?: number[];
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
export type ViewRequest = { id: number; from: MemberId; x: number; y: number; w: number; h: number; at: number };

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

export type Toast = { id: number; text: string; tone: "error" | "info" };

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
  /** Told the op's answer once it settles (OpAnswer), with the reason when it was refused. */
  onAnswer?: (answer: OpAnswer, refusal?: OpRefusal) => void;
  /** No toast answers it: the caller says what became of it (DispatchOptions). */
  quiet?: true;
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
  /** "Select several": a tap adds a token to the selection or takes it out, instead of picking only it. */
  multi: boolean;
  /** Whether the selected token's action bar shows (design 14.3). It opens on a tap and steps aside for the token's panel. */
  actionBar: boolean;
  /** The panel open as a sheet on phones, or null. */
  panel: string | null;
  /** A phone's Panels sheet, the list of every panel, is open (pages/Room.tsx). Read with `sheetOpen`. */
  panelList: boolean;
  /** The side panel's tab from 900 px up. */
  tab: string;
};

export const DEFAULT_TOOL = "select";

export const INITIAL_LOCAL: LocalUi = Object.freeze({
  tool: DEFAULT_TOOL,
  selectedId: null,
  selectedIds: Object.freeze([]) as readonly string[],
  multi: false,
  actionBar: false,
  panel: null,
  panelList: false,
  tab: "tracker",
});

/**
 * Whether a sheet covers the bottom of a phone's map: a panel, or the list
 * of panels. What floats over the map, such as the fight's alert cards,
 * steps aside or folds for either.
 */
export function sheetOpen(local: Pick<LocalUi, "panel" | "panelList">): boolean {
  return local.panel !== null || local.panelList;
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
  roomId: string;
  you: You | null;
  /**
   * The projected state with pending ops replayed (design section 7.4).
   * Null until the first snapshot is applied: the fail-closed gate (section
   * 13.3) keys on this, so nothing from any scene draws before it. Entities
   * that did not change keep their object identity across updates.
   */
  view: RoomState | null;
  /** The scene shown: always the player scene for players, the DM's pick for a DM. */
  sceneId: SceneId | null;
  /** `open` only once the snapshot has arrived (section 7.5). */
  connection: ConnectionState;
  /** The scene this device asked for and is waiting on (sceneLoad.ts). A read-only player preview leaves it out. */
  sceneLoad?: SceneLoad;
  /** Members with at least one open socket. */
  online: MemberId[];
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
};

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
  dispatch(op: ClientOp, opts?: { group?: string; onAnswer?: (answer: OpAnswer, refusal?: OpRefusal) => void; quiet?: boolean }): number | null;
  /**
   * Sends an ephemeral event on the current scene, coalesced to one per
   * animation frame (design 7.6), and shows it locally as this member's own.
   * `localOnly` shows it here without sending, for a preview that is private
   * until the person shares it, such as an AoE being aimed.
   */
  sendEph(e: EphEvent, opts?: { localOnly?: boolean }): void;
  /** DM only: view another scene. The latest pick wins. */
  switchScene(sceneId: SceneId): void;
  undo(): void;
  redo(): void;
  /** A UUIDv7 for a create op (design section 6). */
  newId(): string;
  moveToken(tokenId: string, x: number, y: number): void;
  /** Moves several tokens at once, as one `token.moveMany` (lib/group.ts). */
  moveTokens(moves: readonly { tokenId: string; x: number; y: number }[]): void;
};
