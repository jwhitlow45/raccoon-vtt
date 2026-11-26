import { historyMessageSchema } from "#shared/undoContract.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import { expandGroup, loneEphSchema, serverMessageSchema, type ClientMessage, type EphEvent, type GroupFrame, type GroupRoster, type PreviewPace, type ServerMessage } from "#shared/protocol.ts";
import { mainFloorId, sameScene } from "#shared/rules/floors.ts";
import { shouldReloadForBuild, type BuildReload } from "../lib/buildReload.ts";
import type { RoomStore } from "./store.ts";
import { backoffDelay, BACKOFF_CAP_MS, realClock, Timer, type Clock } from "./timing.ts";
import type { You } from "./types.ts";

/**
 * The connection lifecycle (design section 7.5). One socket at a time per
 * room page. The store (store.ts) keeps the state and the op queue, and this
 * module decides when a socket exists, when it is trusted, and when to give
 * up on it.
 *
 * - `open` is reported only once the snapshot has arrived, so a socket stuck
 *   behind a database retry on the server never looks like a healthy room.
 * - A heartbeat catches the half-open sockets iOS leaves after a suspend.
 * - A snapshot deadline catches control messages the server's frame budget
 *   dropped, so heartbeats alone can never keep a client waiting forever.
 * - The server's close codes decide between reconnecting at once, after a
 *   wait, with backoff, or never.
 */

export const PING_INTERVAL_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const SNAPSHOT_DEADLINE_MS = 5_000;
/** A socket that is open without its snapshot for this long counts as not connected (design 7.5). */
export const STALE_SNAPSHOT_MS = 3_000;
/** The server allows one `scene` per 2 s, so a refused one is retried after that window. */
export const SCENE_RETRY_MS = 2_000;
/** Not in the design: a socket still connecting after this long is abandoned, since a phone can hang in CONNECTING for minutes. */
export const OPEN_TIMEOUT_MS = 10_000;
export const UNLOADED_WAIT_MS = 30_000;
export const BUSY_BACKOFF_CAP_MS = 60_000;
export const EPH_PER_SECOND = 30;
/** Previews still in progress are repeated this often, so receivers never time them out while a finger rests. */
export const EPH_KEEPALIVE_MS = 1_000;
/** How early a drag's keepalive may count as due, so a timer's rounding never leaves one due but not taken. */
const KEEPALIVE_SLACK_MS = 0.001;

/*
 * What one socket lets itself send, under the server's frame budget
 * (server/rooms/budgets.ts FrameBudget: 200 frames a second with a burst of
 * 400 for every frame, and 256 KiB a second with a burst of 512 KiB for
 * every frame but a preview), so the server never drops an op's frame
 * unread and the op never waits for OP_ANSWER_MS to go again
 * (H3-FOG-BURST). A server older than group frames counted 100 frames and
 * 256 KiB a second, with a burst of twice that, for every frame, previews
 * included. Half that burst and three quarters of that rate keep within
 * both: frames the network or a busy server bunches up, and the frames
 * other than ops that always go, still fit in what either holds.
 */
export const SEND_BYTES_PER_SEC = 192 * 1024;
export const SEND_BYTES_BURST = 256 * 1024;
export const SEND_FRAMES_PER_SEC = 75;
export const SEND_FRAMES_BURST = 100;

const utf8 = new TextEncoder();

/** The frames and bytes a socket may still send (SEND_*), refilled with time as the server's budget refills. */
class SendBudget {
  #bytes = SEND_BYTES_BURST;
  #frames = SEND_FRAMES_BURST;
  #at: number;
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
    this.#at = clock.now();
  }

  #refill(): void {
    const now = this.#clock.now();
    const seconds = Math.max(0, now - this.#at) / 1000;
    this.#at = now;
    this.#bytes = Math.min(SEND_BYTES_BURST, this.#bytes + seconds * SEND_BYTES_PER_SEC);
    this.#frames = Math.min(SEND_FRAMES_BURST, this.#frames + seconds * SEND_FRAMES_PER_SEC);
  }

  /** Spends a frame of `bytes` when there is room for it, or when the budget is full, so a frame larger than the burst is never held for good. */
  take(bytes: number): boolean {
    this.#refill();
    if (this.#bytes < Math.min(bytes, SEND_BYTES_BURST) || this.#frames < 1) return false;
    this.#bytes -= bytes;
    this.#frames -= 1;
    return true;
  }

  /** Spends a frame that goes with room or without, so what waits for room waits longer. */
  force(bytes: number): void {
    this.#refill();
    this.#bytes -= bytes;
    this.#frames -= 1;
  }

  /** How long until a frame of `bytes` fits, a millisecond over so the refill has surely come. */
  waitFor(bytes: number): number {
    this.#refill();
    const seconds = Math.max((Math.min(bytes, SEND_BYTES_BURST) - this.#bytes) / SEND_BYTES_PER_SEC, (1 - this.#frames) / SEND_FRAMES_PER_SEC, 0);
    return Math.ceil(seconds * 1000) + 1;
  }
}

export const CLOSE_REVOKED = 4001;
export const CLOSE_DENIED = 4003;
export const CLOSE_ABUSE = 4008;
export const CLOSE_DELETED = 4009;
export const CLOSE_UNLOADED = 4010;
export const CLOSE_TOO_BUSY = 4011;
export const CLOSE_RESTARTING = 1012;
/** Our own close for a socket we stopped trusting. Application codes start at 4000. */
const CLOSE_CLIENT_GAVE_UP = 4000;

/** The parts of a browser WebSocket this module uses, so tests and the dev fixture can supply their own. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

const OPEN = 1;

/** The page events that wake a sleeping connection (design 7.5). */
export type ConnectionEnv = {
  isOnline(): boolean;
  /** Returns an unsubscribe function. */
  subscribe(handlers: { wake(): void; online(): void; offline(): void }): () => void;
};

export function browserEnv(): ConnectionEnv {
  return {
    isOnline: () => navigator.onLine !== false,
    subscribe(handlers) {
      const onVisibility = () => {
        if (document.visibilityState === "visible") handlers.wake();
      };
      const onPageShow = () => handlers.wake();
      const onOnline = () => handlers.online();
      const onOffline = () => handlers.offline();
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pageshow", onPageShow);
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pageshow", onPageShow);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      };
    },
  };
}

export function roomSocketUrl(roomId: string, loc: { protocol: string; host: string } = location): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/ws?room=${encodeURIComponent(roomId)}`;
}

/** A DM's preview socket for one player (docs/design/design-v1-per-player-vision.md 7.4): the room's, asking `as` that member. */
export function previewSocketUrl(roomId: string, memberId: string, loc: { protocol: string; host: string } = location): string {
  return `${roomSocketUrl(roomId, loc)}&as=${encodeURIComponent(memberId)}`;
}

export type RoomSocketOptions = {
  url: string;
  room: RoomStore;
  createSocket?: (url: string) => SocketLike;
  clock?: Clock;
  random?: () => number;
  env?: ConnectionEnv;
  /** requestAnimationFrame, for coalescing ephemeral frames. */
  frame?: (cb: () => void) => unknown;
  /**
   * How many ephemeral frames a second each preview sends, read at each
   * flush: EPH_PER_SECOND, or fewer in low-power mode (features/device),
   * which can change while the room is open. On a server older than group
   * frames it caps all of this device's previews together.
   */
  ephPerSecond?: () => number;
  /**
   * Asked after a 4001 close: whether this device still holds a grant (GET
   * /api/rooms/:id/me). A grant means the close was a role change, so the
   * socket reconnects with the new role. Null means the grant is gone.
   * Without it, 4001 is terminal at once.
   */
  recheck?: () => Promise<You | null>;
  /**
   * A DM's preview of this player (docs/design/design-v1-per-player-vision.md
   * 7.4, previewSocketUrl). It is read only: it sends only `hello` and
   * pings, never an op, an ephemeral event or a scene, which the server
   * answers by closing it. A snapshot for anyone but this player as a
   * player is refused unread, so a server that does not honour `as` never
   * shows the DM's own view as the player's. Any close before the first
   * snapshot ends it, since the preview then says it could not load
   * rather than wait on a retry.
   */
  previewOf?: string;
  /**
   * What a page does when the server says it runs newer code: notes the
   * update, then reloads once the queued edits are answered. Without it the
   * page never reloads itself (a preview, a development room).
   */
  buildReload?: BuildReload;
};

/** How long the update note shows before the reload, so a person sees why the page went blank. */
export const BUILD_RELOAD_NOTE_MS = 1_500;

/** A token that moves with a drag's pressed token, at the spot it is drawn on as the drag starts (design 7.6). */
export type DragMember = { readonly tokenId: string; readonly x: number; readonly y: number };

type GroupMove = Extract<GroupFrame, { k: "dragMove" }>;

/**
 * One step of a drag for all its tokens: the pressed token's point, which
 * every member moves by, its route fields or the movement lead's (`lead`),
 * and each member's cost in member order (`fts`).
 */
export type DragMove = Omit<GroupMove, "k" | "tokenId" | "g" | "with" | "from">;

/** Where a token of a drag lands, or null for one that ends where it stood. */
export type DragLanding = Extract<GroupFrame, { k: "groupEnd" }>["at"][number];

/** A drag's previews, from its start to its end. Once it ended, every call does nothing. */
export type OutgoingDrag = {
  /**
   * A step of the drag, with where the pressed token and each member are
   * drawn now. Those move only when a token's own spot changes during the
   * drag, and then the drag's next message says so.
   */
  move(step: DragMove, from: { readonly x: number; readonly y: number }, members: readonly DragMember[]): void;
  /** The drop: each token's landing, the pressed token's first and then the members' in order. */
  end(at: readonly DragLanding[]): void;
  /** The drag ended without a move. */
  cancel(): void;
};

export type RoomSocket = {
  start(): void;
  dispose(): void;
  /** DM only: view another scene. At most one switch is in flight, and the latest pick wins. */
  switchScene(sceneId: string): void;
  /** Sends an ephemeral event on the next animation frame, coalesced with others of the same preview. Drags go by `startDrag`. */
  sendEph(e: EphEvent): void;
  /**
   * Starts a drag's previews (design 7.6): the pressed token `tokenId`,
   * drawn at `from`, and every token that moves with it, in the order the
   * drag moves them. Its first frame goes at the next flush.
   */
  startDrag(tokenId: string, from: { readonly x: number; readonly y: number }, members: readonly DragMember[]): OutgoingDrag;
  /** For tests and diagnostics. */
  readonly debug: { readonly phase: Phase; readonly attempt: number };
};

type Phase =
  /** Not started, or between sockets while a reconnect waits. */
  | "idle"
  /** The socket exists and is not open yet. */
  | "connecting"
  /** `hello` is sent and the snapshot has not arrived. */
  | "hello"
  /** The snapshot arrived: ops and ephemeral frames flow. */
  | "open"
  | "ended"
  | "disposed";

/** Ephemeral events that replace each other within one frame share a slot. Pings never merge. */
function ephSlot(e: EphEvent, unique: () => number): string {
  switch (e.k) {
    case "dragStart":
    case "dragMove":
    case "dragEnd":
    case "dragCancel":
      return `drag:${e.tokenId}`;
    case "ruler":
    case "rulerEnd":
      return `ruler:${e.id}`;
    case "aoe":
    case "aoeEnd":
      return `aoe:${e.id}`;
    case "laser":
      return "laser";
    case "focus":
      return "focus";
    case "view":
      return "view";
    case "ping":
      return `ping:${unique()}`;
  }
}

/** Frames that open or continue a preview, which receivers drop after 3 s without one. */
function keepsAlive(e: EphEvent | GroupFrame): boolean {
  return e.k === "dragStart" || e.k === "dragMove" || e.k === "ruler" || e.k === "aoe";
}

function isDrag(e: EphEvent): boolean {
  return e.k === "dragStart" || e.k === "dragMove" || e.k === "dragEnd" || e.k === "dragCancel";
}

/** The kinds a socket at the `off` pace still sends: the camera, focus, the laser and pings. */
function sentWhenOff(e: EphEvent | GroupFrame): boolean {
  return e.k === "view" || e.k === "focus" || e.k === "laser" || e.k === "ping";
}

function groupRoster(from: { readonly x: number; readonly y: number }, members: readonly DragMember[]): GroupRoster {
  const starts = new Float64Array(members.length * 2);
  for (const [i, m] of members.entries()) {
    starts[2 * i] = m.x;
    starts[2 * i + 1] = m.y;
  }
  return { from: { x: from.x, y: from.y }, ids: members.map((m) => m.tokenId), starts };
}

function sameRoster(version: RosterVersion, from: { readonly x: number; readonly y: number }, members: readonly DragMember[]): boolean {
  if (version.roster.from.x !== from.x || version.roster.from.y !== from.y || version.members.length !== members.length) return false;
  return members.every((m, i) => {
    const was = version.members[i]!;
    return was.tokenId === m.tokenId && was.x === m.x && was.y === m.y;
  });
}

/** A drag's roster as it stood when a frame was made: each frame names the version it moves by. */
type RosterVersion = { readonly n: number; readonly roster: GroupRoster; readonly members: readonly DragMember[] };

function rosterVersion(n: number, from: { readonly x: number; readonly y: number }, members: readonly DragMember[]): RosterVersion {
  return { n, roster: groupRoster(from, members), members: members.map((m) => ({ tokenId: m.tokenId, x: m.x, y: m.y })) };
}

/**
 * A drag's previews sent as each token's own frames, for what carries
 * ephemeral events without a socket of its own, such as a test's room.
 */
export function loneDrag(tokenId: string, from: { readonly x: number; readonly y: number }, members: readonly DragMember[], send: (e: EphEvent) => void): OutgoingDrag {
  let roster = groupRoster(from, members);
  let done = false;
  const out = (e: GroupFrame) => {
    for (const one of expandGroup(e, roster)) send(one);
  };
  out({ k: "dragStart", tokenId, g: 0, x: from.x, y: from.y });
  return {
    move(step, at, now) {
      if (done) return;
      roster = groupRoster(at, now);
      out({ ...step, k: "dragMove", tokenId, g: 0 });
    },
    end(at) {
      if (done) return;
      done = true;
      out({ k: "groupEnd", tokenId, g: 0, at: [...at] });
    },
    cancel() {
      if (done) return;
      done = true;
      out({ k: "dragCancel", tokenId, g: 0 });
    },
  };
}

/** The bare end of a preview's frame, for the floor the preview leaves, or null for an event that is no preview's frame. */
function endOf(e: EphEvent): EphEvent | null {
  switch (e.k) {
    case "dragStart":
    case "dragMove":
      return { k: "dragCancel", tokenId: e.tokenId };
    case "ruler":
      return { k: "rulerEnd", id: e.id };
    case "aoe":
      return { k: "aoeEnd", id: e.id };
    default:
      return null;
  }
}

/**
 * The room sound's time frames (docs/design/design-v1-music.md 5.1): the
 * engine sends `{ t: "time", k }` and the server answers `{ t: "time", k,
 * at }` with its own `Date.now()`, as it answers a ping. Not the pong:
 * older pages' strict schema would drop a pong with a time and reconnect.
 * The sound engine finds its room's link by the room's store, which is all
 * a page under RoomProvider holds of it.
 */
export type SoundTimeLink = {
  /** Sends a time frame, false while the socket is not open. */
  send(k: number): boolean;
  /** Each answer as it arrives. Returns the unsubscribe. */
  listen(fn: (k: number, at: number) => void): () => void;
};

const soundTimeLinks = new WeakMap<object, SoundTimeLink>();

/** The time link of the socket that feeds this room store, or null. */
export function soundTimeLink(store: object): SoundTimeLink | null {
  return soundTimeLinks.get(store) ?? null;
}

/** A time answer: the shape is checked here, before the protocol's schema, so the link needs nothing of it. */
function timeAnswer(json: unknown): { k: number; at: number } | null {
  if (!json || typeof json !== "object") return null;
  const m = json as { t?: unknown; k?: unknown; at?: unknown };
  if (m.t !== "time" || typeof m.k !== "number" || !Number.isSafeInteger(m.k) || typeof m.at !== "number" || !Number.isFinite(m.at)) return null;
  return { k: m.k, at: m.at };
}

/**
 * A drag in progress on this page (design 7.6). Its number `g` and its
 * members hold for its whole life, across sockets and floors.
 */
type Gesture = {
  readonly g: number;
  readonly tokenId: string;
  /** Its roster now, which a frame made from here on moves by. */
  roster: RosterVersion;
  /** The floor its frames go to, null before its first. */
  sceneId: string | null;
  /** Its latest start or move, which the keepalive repeats, or null once it ended. */
  last: GroupFrame | null;
  queuedAt: number;
  /**
   * On this socket: the roster version last named and the floor it went on,
   * or null when the drag's next message names it, as after a cancel the
   * server closes its rosters by.
   */
  named: { readonly on: string; readonly n: number } | null;
  /** On this socket: the floor of its last message sent, null before one. */
  sentOn: string | null;
};

/** A queued message: another preview's event, or a drag's frame, which names the drag's members when it goes if the socket needs them. */
type SlotEntry =
  | {
      readonly sceneId: string | null;
      readonly e: EphEvent;
      readonly gesture?: undefined;
      /** An old floor's end, which goes in the same flush as the new floor's frame queued after it. */
      readonly pair?: boolean;
    }
  | {
      readonly sceneId: string | null;
      readonly e: GroupFrame;
      readonly gesture: Gesture;
      /** The roster the frame was made with, named on it when the socket does not hold that one. */
      readonly roster: RosterVersion;
      /** The drag's own end, after which it is gone. */
      readonly ends: boolean;
      /** An old floor's cancel, which goes in the same flush as the new floor's frame queued after it. */
      readonly pair: boolean;
    };

/** One preview's queue and the times it sent in the last second. */
type Slot = { queue: SlotEntry[]; sent: number[]; last: number };

export function createRoomSocket(options: RoomSocketOptions): RoomSocket {
  const { room, url } = options;
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const createSocket = options.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  const env = options.env;
  const frame = options.frame ?? ((cb: () => void) => requestAnimationFrame(cb));

  let ws: SocketLike | null = null;
  let phase: Phase = "idle";
  /** Whether any snapshot ever arrived: the difference between "connecting" and "reconnecting". */
  let everOpen = false;
  let attempt = 0;
  let capMs = BACKOFF_CAP_MS;
  /** A wait the server asked for (4010, 4011), which a wake-up must not cut short. */
  let serverHold = false;
  let unsubscribeEnv: (() => void) | null = null;

  const reconnectTimer = new Timer(clock);
  const openTimer = new Timer(clock);
  const pingTimer = new Timer(clock);
  const pongTimer = new Timer(clock);
  const deadline = new Timer(clock);
  const staleTimer = new Timer(clock);
  const sceneRetryTimer = new Timer(clock);
  const buildReloadTimer = new Timer(clock);
  /** The server's op version, once a `build` frame said it. */
  let newerBuild: number | null = null;
  /** The server version this page already answered no to, so it asks the tab's storage once for it. */
  let noReloadFor: number | null = null;
  let unsubscribeStore: (() => void) | null = null;
  /** Wakes the outbox once the op it could not send fits the socket's budget. */
  const paceTimer = new Timer(clock);
  let budget = new SendBudget(clock);
  let pingK = 0;
  /** The `k` of the oldest ping still waiting for its pong. */
  let unansweredK: number | null = null;

  /** The scene a DM picked last. Null until the DM picks, so the server's default stands. */
  let wantedScene: string | null = null;
  /** The scene the in-flight `scene` or `hello` asked for. */
  let requestedScene: string | null = null;
  let sceneInFlight = false;
  /** Whether the hello waiting for its snapshot went on a socket that was open, a resync's or a scene switch's. */
  let helloWhileOpen = false;

  // Ephemeral sending. Each event keeps the floor it was made on, the floor shown then, so a switch before the flush sends it on its own floor (docs/design/design-v1-floors.md 8.2).
  /**
   * What this socket's `takes` said: it sends drags as group frames, each
   * preview paced on its own, at this pace. Null before it, and on a server
   * older than group frames, which gets each token's own frames under one
   * window for all, as before.
   */
  let takes: { pace: PreviewPace } | null = null;
  /** Without `takes`: the latest event of each slot, sent under the one window (ephSent, lastEphFlush). */
  const ephQueue = new Map<string, { e: EphEvent; sceneId: string | null }>();
  /** With `takes`: each slot's queue and its own window, so what one preview sends never moves another's frames. */
  const slots = new Map<string, Slot>();
  /** With `takes`: the floor each preview other than a drag last sent a frame to on this socket, where its end goes. */
  const previewFloors = new Map<string, string>();
  /** Previews in progress other than drags, by slot, with their floor and when each was last sent. */
  const openPreviews = new Map<string, { e: EphEvent; sceneId: string | null; sentAt: number }>();
  /** Drags in progress, and ended ones whose end is still queued, by gesture number. */
  const gestures = new Map<number, Gesture>();
  /** Every drag of this page takes a new number, kept across sockets, since a drag goes on through a reconnect. */
  let nextGesture = 0;
  let ephFrameScheduled = false;
  const ephDelay = new Timer(clock);
  const keepAliveTimer = new Timer(clock);
  const dragKeepAliveTimer = new Timer(clock);
  const ephSent: number[] = [];
  let lastEphFlush = Number.NEGATIVE_INFINITY;
  let pingSlot = 0;
  let ephScene: string | null = null;
  /** Kinds already reported, so a malformed frame sent 30 times a second logs once. */
  const reported = new Set<string>();

  const role = () => room.store.getState().you?.role ?? "player";
  const previewOf = options.previewOf;

  const timeListeners = new Set<(k: number, at: number) => void>();
  soundTimeLinks.set(room.store, {
    send(k) {
      // A preview plays nothing, so it measures nothing.
      if (!ws || ws.readyState !== OPEN || phase !== "open" || previewOf !== undefined) return false;
      const data = JSON.stringify({ t: "time", k });
      budget.force(utf8.encode(data).length);
      try {
        ws.send(data);
        return true;
      } catch {
        return false;
      }
    },
    listen(fn) {
      timeListeners.add(fn);
      return () => timeListeners.delete(fn);
    },
  });

  function setConnection(state: "connecting" | "open" | "reconnecting" | "offline"): void {
    room.setConnection(state);
  }

  function lostState(): "connecting" | "reconnecting" | "offline" {
    if (env && !env.isOnline()) return "offline";
    return everOpen ? "reconnecting" : "connecting";
  }

  /**
   * Sends a frame, counted against the socket's budget (SendBudget). An op
   * that does not fit is not sent: it waits in the outbox, pending and so
   * saving, until the budget has room for it. Every other frame goes at once,
   * since a hello, a ping or a preview is small and late would be wrong, and
   * the ops after it wait that much longer. A server that `takes` group
   * frames counts previews apart from every other frame, so they are sent
   * outside the budget (`budgeted` false) and leave all of it to ops.
   */
  function sendRaw(msg: ClientMessage, paced = false, budgeted = true): boolean {
    if (!ws || ws.readyState !== OPEN) return false;
    if (previewOf !== undefined && msg.t !== "hello" && msg.t !== "ping") return false;
    const data = JSON.stringify(msg);
    const bytes = budgeted ? utf8.encode(data).length : 0;
    if (budgeted && !paced) budget.force(bytes);
    else if (budgeted && !budget.take(bytes)) {
      paceTimer.set(budget.waitFor(bytes), () => room.flushOutbox());
      return false;
    }
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ lifecycle

  function connect(): void {
    if (phase === "ended" || phase === "disposed") return;
    reconnectTimer.clear();
    serverHold = false;
    phase = "connecting";
    setConnection(lostState());
    let socket: SocketLike;
    try {
      socket = createSocket(url);
    } catch {
      phase = "idle";
      scheduleReconnect(backoffDelay(attempt++, random, capMs));
      return;
    }
    ws = socket;
    // The server's budget is per connection, and a new one starts full.
    budget = new SendBudget(clock);
    // So is what it holds of each drag's members. What the last socket was told, and each preview's window, went with it (detach).
    for (const gesture of gestures.values()) {
      gesture.named = null;
      gesture.sentOn = null;
    }
    socket.onopen = () => {
      if (ws !== socket) return;
      openTimer.clear();
      startHeartbeat();
      sendHello();
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      receive(ev.data);
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      closed(ev.code);
    };
    socket.onerror = () => {
      // A close event always follows.
    };
    openTimer.set(OPEN_TIMEOUT_MS, () => giveUp("open timeout"));
  }

  /** Clears everything tied to the current socket, without deciding what comes next. */
  function detach(): void {
    const socket = ws;
    ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    openTimer.clear();
    pingTimer.clear();
    pongTimer.clear();
    deadline.clear();
    staleTimer.clear();
    sceneRetryTimer.clear();
    paceTimer.clear();
    unansweredK = null;
    sceneInFlight = false;
    helloWhileOpen = false;
    ephQueue.clear();
    // Queued ends go with the socket, whose close the server ends its previews by, and so does each preview's window.
    // A drag still in progress goes on on the next.
    takes = null;
    dropSlots();
    // A first load the server held said "Still loading…": without the socket it is connecting again.
    room.trackScene({ t: "lost" });
    room.suspend();
    if (phase !== "ended" && phase !== "disposed") phase = "idle";
  }

  /**
   * We stopped trusting the socket (no pong, no snapshot, never opened). A
   * half-open socket may never deliver its close event, so it is detached
   * first and its close, if one comes, is ignored.
   */
  function giveUp(reason: string): void {
    if (reason === "no snapshot") room.trackScene({ t: "timeout" });
    const socket = ws;
    detach();
    try {
      socket?.close(CLOSE_CLIENT_GAVE_UP, reason);
    } catch {
      // Already closed.
    }
    if (previewOf !== undefined && !everOpen) {
      end("denied", CLOSE_CLIENT_GAVE_UP);
      return;
    }
    setConnection(lostState());
    scheduleReconnect(backoffDelay(attempt++, random, capMs));
  }

  function closed(code: number): void {
    detach();
    if (previewOf !== undefined && !everOpen) {
      end("denied", code);
      return;
    }
    switch (code) {
      case CLOSE_DENIED:
        end("denied", code);
        return;
      case CLOSE_DELETED:
        end("deleted", code);
        return;
      case CLOSE_REVOKED:
        revoked();
        return;
      case CLOSE_RESTARTING:
        attempt = 0;
        setConnection(lostState());
        scheduleReconnect(0);
        return;
      case CLOSE_UNLOADED:
        setConnection(lostState());
        scheduleReconnect(UNLOADED_WAIT_MS + backoffDelay(attempt++, random, capMs), true);
        return;
      case CLOSE_TOO_BUSY:
        capMs = BUSY_BACKOFF_CAP_MS;
        setConnection(lostState());
        scheduleReconnect(backoffDelay(attempt++, random, capMs), true);
        return;
      case CLOSE_ABUSE:
      default:
        setConnection(lostState());
        scheduleReconnect(backoffDelay(attempt++, random, capMs));
    }
  }

  function revoked(): void {
    if (!options.recheck) {
      end("revoked", CLOSE_REVOKED);
      return;
    }
    // Hold the reconnect until the answer is in. A failed check is a
    // network problem, not an answer, so it retries like any other close.
    phase = "idle";
    setConnection(lostState());
    options.recheck().then(
      (you) => {
        if (phase === "disposed" || phase === "ended") return;
        if (!you) {
          end("revoked", CLOSE_REVOKED);
          return;
        }
        room.setYou(you);
        scheduleReconnect(0);
      },
      () => {
        if (phase === "disposed" || phase === "ended") return;
        scheduleReconnect(backoffDelay(attempt++, random, capMs));
      },
    );
  }

  function end(kind: "revoked" | "denied" | "deleted", code: number): void {
    phase = "ended";
    reconnectTimer.clear();
    room.setEnded({ kind, code });
    setConnection("offline");
  }

  function scheduleReconnect(ms: number, hold = false): void {
    if (phase === "ended" || phase === "disposed") return;
    serverHold = hold;
    reconnectTimer.set(ms, connect);
  }

  /** Visibility, pageshow and online: try now and start the backoff over (design 7.5). */
  function wake(): void {
    if (phase === "ended" || phase === "disposed") return;
    if (phase === "open") {
      // The socket may be half open after a suspend. A ping now finds out
      // within the pong timeout instead of at the next heartbeat.
      sendPing();
      return;
    }
    if (reconnectTimer.pending && !serverHold) {
      attempt = 0;
      connect();
    }
  }

  // ------------------------------------------------------------ heartbeat

  function startHeartbeat(): void {
    pingTimer.set(PING_INTERVAL_MS, heartbeat);
  }

  function heartbeat(): void {
    sendPing();
    pingTimer.set(PING_INTERVAL_MS, heartbeat);
  }

  function sendPing(): void {
    const k = ++pingK;
    if (!sendRaw({ t: "ping", k })) return;
    if (unansweredK === null) {
      unansweredK = k;
      pongTimer.set(PONG_TIMEOUT_MS, () => giveUp("no pong"));
    }
  }

  // ------------------------------------------------------------ hello, scene and the snapshot deadline

  function sendHello(): void {
    const { clientId, resumeFrom } = room.prepareHello();
    // The scene projected, a main floor: a switch of floors within it asks for nothing.
    const current = room.store.getState().projectedSceneId;
    const sceneId = role() === "dm" ? (wantedScene ?? current ?? undefined) : undefined;
    requestedScene = sceneId ?? null;
    if (sceneId && sceneId !== current) room.trackScene({ t: "request", sceneId });
    // Every page of this build asks for its member's id key (store.ts newId), so the room reads it as keyed.
    const msg: ClientMessage = { t: "hello", clientId, resumeFrom, ackDetails: true, sealIds: true, opVersion: OP_VERSION, ...(sceneId ? { sceneId } : {}) };
    if (!sendRaw(msg)) return;
    const wasOpen = phase === "open";
    phase = "hello";
    // For a scene switch the deadline already covers the whole exchange.
    if (!deadline.pending) startDeadline();
    if (wasOpen) {
      helloWhileOpen = true;
      staleTimer.set(STALE_SNAPSHOT_MS, () => setConnection("reconnecting"));
    }
  }

  function startDeadline(): void {
    deadline.set(SNAPSHOT_DEADLINE_MS, () => giveUp("no snapshot"));
  }

  function sendScene(): void {
    if (wantedScene === null) return;
    if (!sendRaw({ t: "scene", sceneId: wantedScene })) return;
    requestedScene = wantedScene;
    sceneInFlight = true;
    startDeadline();
  }

  /**
   * Reloads for newer server code once the socket is open and nothing of this page's work would be lost: the queued
   * edits are answered and no create still waits on the room's answer about its ids (a reload drops both,
   * client/lib/chunkLoad.ts reloadGate). Asked again as each of those changes.
   */
  function considerBuildReload(): void {
    const reload = options.buildReload;
    if (!reload || previewOf !== undefined || newerBuild === null || newerBuild === noReloadFor || buildReloadTimer.pending) return;
    if (phase !== "open" || unsaved()) return;
    const serverOp = newerBuild;
    if (!shouldReloadForBuild(serverOp, reload.ownOp, reload.tried())) {
      // Settled for this version, so the store's later changes read no storage for it.
      noReloadFor = serverOp;
      return;
    }
    // Pending before the note, which publishes a store change that asks this function again.
    buildReloadTimer.set(BUILD_RELOAD_NOTE_MS, () => {
      if (phase !== "open" || unsaved()) return;
      if (!reload.remember(serverOp)) {
        noReloadFor = serverOp;
        return;
      }
      reload.reload();
    });
    room.ui.notify("RaccoonVTT was updated. Reloading…");
  }

  function unsaved(): boolean {
    const s = room.store.getState();
    return s.pending.length > 0 || s.idsSettling > 0;
  }

  function onSnapshot(msg: Extract<ServerMessage, { t: "snapshot" }>): void {
    if (previewOf !== undefined && (msg.you.memberId !== previewOf || msg.you.role !== "player")) {
      // Never applied: it is not this player's view.
      const socket = ws;
      detach();
      try {
        socket?.close(CLOSE_CLIENT_GAVE_UP, "not the player asked for");
      } catch {
        // Already closed.
      }
      end("denied", CLOSE_DENIED);
      return;
    }
    deadline.clear();
    staleTimer.clear();
    helloWhileOpen = false;
    phase = "open";
    everOpen = true;
    attempt = 0;
    capMs = BACKOFF_CAP_MS;
    sceneInFlight = false;
    setConnection("open");
    room.applySnapshot(msg);
    if (msg.you.role !== "dm") {
      wantedScene = null;
    } else if (wantedScene !== null && wantedScene !== requestedScene && wantedScene !== msg.you.sceneId) {
      // The DM picked again while this exchange was in flight: the latest pick wins.
      sendScene();
    } else {
      wantedScene = null;
    }
    // A DM made a player mid-switch has nothing left to load.
    room.trackScene(msg.you.role === "dm" ? { t: "snapshot", sceneId: msg.you.sceneId, next: sceneInFlight ? requestedScene : null } : { t: "cancel" });
    if (msg.you.sceneId !== ephScene) {
      ephScene = msg.you.sceneId;
      openPreviews.clear();
      gestures.clear();
      keepAliveTimer.clear();
      dragKeepAliveTimer.clear();
    }
    flushEph();
    considerBuildReload();
  }

  function receive(data: unknown): void {
    let json: unknown;
    try {
      json = typeof data === "string" ? JSON.parse(data) : null;
    } catch {
      return;
    }
    const time = timeAnswer(json);
    if (time) {
      // Any answer is a reading of the server's clock, whoever asked: new ids are dated by it.
      room.receiveTime(time.at);
      for (const fn of [...timeListeners]) fn(time.k, time.at);
      return;
    }
    if (json && typeof json === "object" && "t" in json && json.t === "history") {
      const history = historyMessageSchema.safeParse(json);
      if (history.success && phase === "open" && previewOf === undefined) room.applyHistory(history.data);
      return;
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("raccoon: ignoring a message that does not match the protocol", json);
      return;
    }
    const msg = parsed.data;
    switch (msg.t) {
      case "snapshot":
        onSnapshot(msg);
        return;
      case "ev":
        room.applyEv(msg);
        return;
      case "retry":
        if (msg.n !== undefined) {
          room.retryOps(msg.n);
          return;
        }
        // Only a `scene` request was refused. The op queue is untouched.
        // A stray one with no scene in flight must not stop the deadline of
        // a hello waiting on its snapshot (design 7.5).
        if (!sceneInFlight) return;
        deadline.clear();
        sceneInFlight = false;
        room.trackScene({ t: "slow" });
        sceneRetryTimer.set(SCENE_RETRY_MS, () => {
          if (phase !== "open" || wantedScene === null) return;
          if (wantedScene !== room.store.getState().projectedSceneId) {
            sendScene();
            return;
          }
          // The DM went back to the scene on screen while the refusal waited.
          wantedScene = null;
          room.wantFloor(null);
          room.trackScene({ t: "cancel" });
        });
        return;
      case "eph":
        room.receiveEph(msg.from, msg.sceneId, msg.e);
        return;
      case "presence":
        room.setPresence(msg.online, msg.displays);
        return;
      case "access":
        room.accessChanged();
        return;
      case "joinRequests":
        room.joinRequestsChanged();
        return;
      case "xcard":
        room.receiveXcard(msg.at);
        return;
      case "clock":
        room.receiveClock(msg.at);
        return;
      case "refusals":
        room.keepRefusals(msg.rejects);
        return;
      case "ids":
        room.receiveIds(msg);
        return;
      case "wait":
        // Only a request still waiting for its snapshot has a deadline to move.
        if (phase === "hello" || sceneInFlight) {
          deadline.set(msg.ms + SNAPSHOT_DEADLINE_MS, () => giveUp("no snapshot"));
          room.trackScene({ t: "slow" });
          // The server is holding the snapshot, so the socket is live: one that was open stays open (design 7.5).
          if (helloWhileOpen) {
            staleTimer.clear();
            setConnection("open");
          }
        }
        return;
      case "build":
        newerBuild = msg.opVersion;
        return;
      case "takes":
        takes = { pace: msg.pace };
        // Only a server that never said `takes` fills this queue, and it is not this one.
        ephQueue.clear();
        // A drag's own frames from before go as its group frames from now on.
        for (const slot of openPreviews.keys()) if (slot.startsWith("drag:")) openPreviews.delete(slot);
        // A raised pace sends from each preview's next frame or keepalive, and a drag's carries its members, which nothing sent at `off` named.
        return;
      case "need": {
        const gesture = gestures.get(msg.g);
        if (gesture && gesture.tokenId === msg.id) gesture.named = null;
        return;
      }
      case "pong":
        if (unansweredK !== null && msg.k >= unansweredK) {
          unansweredK = null;
          pongTimer.clear();
        }
        return;
      case "resync":
        room.suspend();
        sendHello();
        return;
    }
  }

  // ------------------------------------------------------------ ephemeral

  function ephRate(): number {
    return Math.min(EPH_PER_SECOND, Math.max(1, options.ephPerSecond?.() ?? EPH_PER_SECOND));
  }

  function scheduleEphFlush(): void {
    // Without `takes`, a window still closed holds every slot until its timer.
    if (ephFrameScheduled || (!takes && ephDelay.pending)) return;
    ephFrameScheduled = true;
    frame(() => {
      ephFrameScheduled = false;
      flushEph();
    });
  }

  /**
   * At most one flush per animation frame (design 7.6). With `takes`, each
   * slot sends at most one message per flush, 30 a second (fewer in low
   * power) with a gap between, on its own window, so how many previews or
   * members this device has never moves the frames of another. Without it,
   * as an older server needs, all slots share the one window and each slot
   * sends its latest event only.
   */
  function flushEph(): void {
    if (takes) flushSlots();
    else flushQueue();
  }

  function flushQueue(): void {
    if (ephQueue.size === 0) return;
    if (phase !== "open") {
      ephQueue.clear();
      return;
    }
    const now = clock.now();
    const rate = ephRate();
    // Frames land on the display's refresh, so a gap of exactly 1/30 s would
    // often wait one refresh too many. The window below is the hard cap.
    const gap = (1000 / rate) * 0.8;
    while (ephSent.length > 0 && now - ephSent[0]! >= 1000) ephSent.shift();
    const wait = Math.max(lastEphFlush + gap - now, ephSent.length >= rate ? ephSent[0]! + 1000 - now : 0);
    if (wait > 0) {
      ephDelay.set(wait, () => scheduleEphFlush());
      return;
    }
    lastEphFlush = now;
    for (const [slot, { e, sceneId }] of ephQueue) {
      if (ephSent.length >= rate) break;
      ephQueue.delete(slot);
      // One made with no floor shown has nowhere to go.
      if (sceneId === null || !sendRaw({ t: "eph", sceneId, e })) continue;
      ephSent.push(now);
      const open = openPreviews.get(slot);
      if (open) open.sentAt = now;
    }
    if (ephQueue.size > 0) scheduleEphFlush();
  }

  /** Empties every slot, and forgets each drag whose end was waiting in one. `windows` false keeps what each sent, for the same socket. */
  function dropSlots(windows = true): void {
    if (windows) {
      slots.clear();
      previewFloors.clear();
    } else for (const slot of slots.values()) slot.queue = [];
    for (const [g, gesture] of gestures) if (gesture.last === null) gestures.delete(g);
  }

  function flushSlots(): void {
    // Nothing goes between a resync's hello and its snapshot, as without `takes`.
    if (phase !== "open") {
      dropSlots(false);
      return;
    }
    const now = clock.now();
    const rate = ephRate();
    const gap = (1000 / rate) * 0.8;
    let waiting = false;
    for (const [key, slot] of slots) {
      while (slot.sent.length > 0 && now - slot.sent[0]! >= 1000) slot.sent.shift();
      const head = slot.queue[0];
      if (!head) {
        if (slot.sent.length === 0) slots.delete(key);
        continue;
      }
      // An old floor's cancel and the new floor's frame go together, the cancel first, as the server needs them.
      const n = head.pair && slot.queue.length > 1 && rate >= 2 ? 2 : 1;
      const over = slot.sent.length + n - rate;
      const due = Math.max(slot.last + gap - now, over > 0 ? slot.sent[over - 1]! + 1000 - now : 0);
      if (due > 0) {
        waiting = true;
        continue;
      }
      slot.last = now;
      for (const entry of slot.queue.splice(0, n)) if (sendEntry(key, entry)) slot.sent.push(now);
      waiting ||= slot.queue.length > 0;
    }
    // A slot that waits looks again at each frame, not at a timer, so it goes at the first frame it may, whatever other slots wake.
    if (waiting) scheduleEphFlush();
  }

  function sendEntry(key: string, entry: SlotEntry): boolean {
    // One made with no floor shown has nowhere to go.
    if (entry.sceneId === null) return false;
    if (!entry.gesture) {
      if (!sendRaw({ t: "eph", sceneId: entry.sceneId, e: entry.e }, false, false)) return false;
      const open = openPreviews.get(key);
      if (open) open.sentAt = clock.now();
      if (keepsAlive(entry.e)) previewFloors.set(key, entry.sceneId);
      else previewFloors.delete(key);
      return true;
    }
    const gesture = entry.gesture;
    if (entry.ends) gestures.delete(gesture.g);
    // A drag's first message on this socket names its members, and so do its first on a floor, its first after a cancel or
    // `need`, and its first made with a changed roster: always the roster the frame was made with.
    const was = gesture.named;
    const naming = was === null || was.on !== entry.sceneId || was.n !== entry.roster.n;
    const { members, roster } = entry.roster;
    const e: GroupFrame = naming ? { ...entry.e, with: members.map((m) => ({ tokenId: m.tokenId, x: m.x, y: m.y })), from: { ...roster.from } } : entry.e;
    if (!sendRaw({ t: "eph", sceneId: entry.sceneId, e }, false, false)) return false;
    // The old floor's cancel ends the drag there and closes every roster the server holds for it, so the next frame names its own.
    if (entry.pair) {
      gesture.named = null;
      gesture.sentOn = null;
      return true;
    }
    if (naming) gesture.named = { on: entry.sceneId, n: entry.roster.n };
    gesture.sentOn = entry.sceneId;
    return true;
  }

  function slotOf(key: string): Slot {
    let slot = slots.get(key);
    if (!slot) {
      slot = { queue: [], sent: [], last: Number.NEGATIVE_INFINITY };
      slots.set(key, slot);
    }
    return slot;
  }

  /** Whether a slot holds something still to send. */
  function queued(key: string): boolean {
    return takes ? (slots.get(key)?.queue.length ?? 0) > 0 : ephQueue.has(key);
  }

  function gestureSlot(gesture: Gesture): string {
    return `drag:${gesture.tokenId}#${gesture.g}`;
  }

  /**
   * A drag's frame, for every token it moves. The end goes to the floor its
   * frames went to, and a frame on another floor than the last ends the
   * drag on that floor first, as `sendEph` does for every preview.
   */
  function stepGesture(gesture: Gesture, e: GroupFrame): void {
    if (gestures.get(gesture.g) !== gesture) return;
    const keeps = keepsAlive(e);
    const shown = room.store.getState().sceneId;
    const sceneId = !keeps && gesture.sceneId !== null ? gesture.sceneId : shown;
    const left = keeps && gesture.sceneId !== null && gesture.sceneId !== shown ? gesture.sceneId : null;
    gesture.sceneId = sceneId;
    gesture.last = keeps ? e : null;
    gesture.queuedAt = clock.now();
    armDragKeepAlive();
    if (phase === "open") {
      if (takes) queueGroup(gesture, e, sceneId);
      else queueLone(gesture, e, sceneId, left);
      scheduleEphFlush();
    }
    // An end that waits in a slot keeps its drag until it goes.
    if (!keeps && !queued(gestureSlot(gesture))) gestures.delete(gesture.g);
  }

  /**
   * Queues a drag's frame in its slot. A start or a move on another floor
   * than the last one sent is put against that floor alone, however many
   * switches came before the flush: what waits for any other floor never
   * goes, and one cancel on the floor sent last goes first, in the same
   * flush, or none where nothing went or it is the same floor again.
   */
  function queueGroup(gesture: Gesture, e: GroupFrame, sceneId: string | null): void {
    // An `off` socket sends no drag at all. Its drag still counts its frames, so a raised pace goes on from the next.
    if (takes?.pace === "off") return;
    const slot = slotOf(gestureSlot(gesture));
    if (keepsAlive(e)) {
      const kept = slot.queue.filter((q) => !q.pair && (!keepsAlive(q.e) || q.sceneId === sceneId));
      const sentOn = gesture.sentOn;
      slot.queue =
        sentOn !== null && sentOn !== sceneId ? [{ sceneId: sentOn, e: { k: "dragCancel", tokenId: gesture.tokenId, g: gesture.g }, gesture, roster: gesture.roster, ends: false, pair: true }, ...kept] : kept;
    }
    // A move replaces a queued move. A start is never replaced, and an end goes after the move before it.
    const tail = slot.queue.at(-1);
    if (e.k === "dragMove" && tail?.gesture && tail.e.k === "dragMove" && tail.sceneId === sceneId) slot.queue.pop();
    slot.queue.push({ sceneId, e, gesture, roster: gesture.roster, ends: !keepsAlive(e), pair: false });
  }

  /** For a server older than group frames: each token's own frames, each passing the lone check, as the page sent them before. */
  function queueLone(gesture: Gesture, e: GroupFrame, sceneId: string | null, left: string | null): void {
    for (const one of expandGroup(e, gesture.roster.roster)) {
      if (!loneEphSchema.safeParse(one).success) {
        if (!reported.has(one.k)) {
          reported.add(one.k);
          console.error("raccoon: refusing to send a malformed ephemeral event", one);
        }
        continue;
      }
      const slot = ephSlot(one, () => ++pingSlot);
      const end = left !== null ? endOf(one) : null;
      if (left !== null && end) {
        // Out of the queue first, so the old floor's end goes before the new floor's frame, the order the server needs.
        ephQueue.delete(slot);
        ephQueue.set(`${slot}@${left}`, { e: end, sceneId: left });
      }
      ephQueue.set(slot, { e: one, sceneId });
    }
  }

  function armKeepAlive(): void {
    if (openPreviews.size === 0) {
      keepAliveTimer.clear();
      return;
    }
    if (keepAliveTimer.pending) return;
    keepAliveTimer.set(EPH_KEEPALIVE_MS, () => {
      const now = clock.now();
      for (const [slot, open] of openPreviews) {
        if (now - open.sentAt >= EPH_KEEPALIVE_MS && !queued(slot)) queueEph(slot, open.e, open.sceneId, null);
      }
      scheduleEphFlush();
      armKeepAlive();
    });
  }

  /**
   * A drag held still repeats its last frame a keepalive after its last,
   * each on its own time, so when one drag repeats never moves another's.
   */
  function armDragKeepAlive(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const gesture of gestures.values()) if (gesture.last !== null) next = Math.min(next, gesture.queuedAt + EPH_KEEPALIVE_MS);
    if (next === Number.POSITIVE_INFINITY) {
      dragKeepAliveTimer.clear();
      return;
    }
    dragKeepAliveTimer.set(Math.max(0, next - clock.now()), () => {
      const now = clock.now();
      for (const gesture of gestures.values()) {
        const last = gesture.last;
        if (last === null || now < gesture.queuedAt + EPH_KEEPALIVE_MS - KEEPALIVE_SLACK_MS) continue;
        // Counted as sent whether or not it can go now, so a closed socket's drag waits a keepalive again.
        gesture.queuedAt = now;
        if (phase !== "open" || queued(takes ? gestureSlot(gesture) : `drag:${gesture.tokenId}`)) continue;
        if (takes) queueGroup(gesture, last, gesture.sceneId);
        else queueLone(gesture, last, gesture.sceneId, null);
      }
      scheduleEphFlush();
      armDragKeepAlive();
    });
  }

  /** Queues another preview's event, its slot's latest, after the old floor's end where the preview left one. */
  function queueEph(slot: string, e: EphEvent, sceneId: string | null, left: EphEvent | null): void {
    const leftOn = left ? openPreviews.get(slot)?.sceneId : null;
    if (!takes) {
      if (left && leftOn) {
        // Out of the queue first, so the old floor's end goes before the new floor's frame, the order the server needs.
        ephQueue.delete(slot);
        ephQueue.set(`${slot}@${leftOn}`, { e: left, sceneId: leftOn });
      }
      ephQueue.set(slot, { e, sceneId });
      return;
    }
    if (takes.pace === "off" && !sentWhenOff(e)) return;
    // Against the floor the preview's last frame went to on this socket, however many switches came before the flush.
    const sentOn = previewFloors.get(slot);
    const queue = slotOf(slot);
    if (!keepsAlive(e)) {
      // An end goes where the frames went.
      queue.queue = [{ e, sceneId: sentOn ?? sceneId }];
      return;
    }
    // A frame on another floor goes after that floor's end, in the same flush and the preview's own slot, so the end never
    // reaches the server after the frame and takes the new floor's preview with it.
    const end = sentOn !== undefined && sentOn !== sceneId ? endOf(e) : null;
    queue.queue = end ? [{ e: end, sceneId: sentOn!, pair: true }, { e, sceneId }] : [{ e, sceneId }];
  }

  // ------------------------------------------------------------ the socket object

  return {
    start() {
      if (phase !== "idle" || unsubscribeEnv) return;
      room.setOutbox({ send: (msg) => sendRaw(msg, true) });
      if (options.buildReload) unsubscribeStore = room.store.subscribe(considerBuildReload);
      unsubscribeEnv =
        env?.subscribe({
          wake,
          online: () => {
            if (phase !== "open") setConnection(everOpen ? "reconnecting" : "connecting");
            wake();
          },
          offline: () => {
            if (phase === "open") sendPing();
            else setConnection("offline");
          },
        }) ?? null;
      connect();
    },

    dispose() {
      const socket = ws;
      detach();
      phase = "disposed";
      soundTimeLinks.delete(room.store);
      timeListeners.clear();
      reconnectTimer.clear();
      ephDelay.clear();
      keepAliveTimer.clear();
      dragKeepAliveTimer.clear();
      openPreviews.clear();
      gestures.clear();
      unsubscribeEnv?.();
      unsubscribeEnv = null;
      unsubscribeStore?.();
      unsubscribeStore = null;
      buildReloadTimer.clear();
      room.setOutbox(null);
      try {
        socket?.close(1000, "leaving");
      } catch {
        // Already closed.
      }
    },

    switchScene(asked) {
      if (role() !== "dm") return;
      const state = room.store.getState();
      const projected = state.projectedSceneId;
      // Another floor of the scene projected is in the view already: shown at once, with nothing sent (docs/design/design-v1-floors.md 10).
      const settled = wantedScene === null && !sceneInFlight && !sceneRetryTimer.pending;
      if (state.view && projected !== null && settled && sameScene(state.view, asked, projected)) {
        room.showFloor(asked);
        return;
      }
      // The `scene` message names a main floor, and the floor asked shows once its snapshot lands.
      const sceneId = state.view ? mainFloorId(state.view, asked) : asked;
      room.wantFloor(asked === sceneId ? null : asked);
      wantedScene = sceneId;
      // A hello in flight, a scene in flight or a refused scene waiting out
      // its window all end in a snapshot or a timer that sends the latest pick.
      if (phase !== "open" || sceneInFlight || sceneRetryTimer.pending) {
        room.trackScene({ t: "request", sceneId });
        return;
      }
      if (sceneId === projected) {
        wantedScene = null;
        room.wantFloor(null);
        room.trackScene({ t: "cancel" });
        room.showFloor(asked);
        return;
      }
      room.trackScene({ t: "request", sceneId });
      sendScene();
    },

    sendEph(e) {
      // A page that takes group frames sends a drag only as one, by startDrag.
      if (takes && isDrag(e)) return;
      const slot = ephSlot(e, () => ++pingSlot);
      const shown = room.store.getState().sceneId;
      const open = openPreviews.get(slot);
      // The server routes an end only to the floor it names, so a preview ends on the floor its frames went to, though
      // the floor shown changed since, and one that goes on after a switch ends there first. Otherwise a screen holding
      // only the old floor keeps it until its own timeout (docs/design/design-v1-floors.md 8.2).
      const sceneId = !keepsAlive(e) && open ? open.sceneId : shown;
      const left = open && open.sceneId !== null && open.sceneId !== shown ? endOf(e) : null;
      if (phase === "open") queueEph(slot, e, sceneId, left);
      if (keepsAlive(e)) openPreviews.set(slot, { e, sceneId, sentAt: open?.sentAt ?? Number.NEGATIVE_INFINITY });
      else openPreviews.delete(slot);
      armKeepAlive();
      if (phase === "open") scheduleEphFlush();
    },

    startDrag(tokenId, from, members) {
      const g = nextGesture++;
      const gesture: Gesture = {
        g,
        tokenId,
        roster: rosterVersion(0, from, members),
        sceneId: null,
        last: null,
        queuedAt: Number.NEGATIVE_INFINITY,
        named: null,
        sentOn: null,
      };
      gestures.set(g, gesture);
      let done = false;
      stepGesture(gesture, { k: "dragStart", tokenId, g, x: from.x, y: from.y });
      return {
        move(step, at, now) {
          if (done) return;
          // A token's own spot moved during the drag: frames from here on move by a new roster, which the first of them names.
          if (!sameRoster(gesture.roster, at, now)) gesture.roster = rosterVersion(gesture.roster.n + 1, at, now);
          stepGesture(gesture, { ...step, k: "dragMove", tokenId, g });
        },
        end(at) {
          if (done) return;
          done = true;
          stepGesture(gesture, { k: "groupEnd", tokenId, g, at: [...at] });
        },
        cancel() {
          if (done) return;
          done = true;
          stepGesture(gesture, { k: "dragCancel", tokenId, g });
        },
      };
    },

    debug: {
      get phase() {
        return phase;
      },
      get attempt() {
        return attempt;
      },
    },
  };
}
