import { serverMessageSchema, type ClientMessage, type EphEvent, type ServerMessage } from "#shared/protocol.ts";
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

/** A DM's preview socket for one player (docs/design-v1-per-player-vision.md 7.4): the room's, asking `as` that member. */
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
   * How many ephemeral frames a second this device sends, read at each
   * flush: EPH_PER_SECOND, or fewer in low-power mode (features/device), which
   * can change while the room is open.
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
   * A DM's preview of this player (docs/design-v1-per-player-vision.md
   * 7.4, previewSocketUrl). It is read only: it sends only `hello` and
   * pings, never an op, an ephemeral event or a scene, which the server
   * answers by closing it. A snapshot for anyone but this player as a
   * player is refused unread, so a server that does not honour `as` never
   * shows the DM's own view as the player's. Any close before the first
   * snapshot ends it, since the preview then says it could not load
   * rather than wait on a retry.
   */
  previewOf?: string;
};

export type RoomSocket = {
  start(): void;
  dispose(): void;
  /** DM only: view another scene. At most one switch is in flight, and the latest pick wins. */
  switchScene(sceneId: string): void;
  /** Sends an ephemeral event on the next animation frame, coalesced with others of the same preview. */
  sendEph(e: EphEvent): void;
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
function keepsAlive(e: EphEvent): boolean {
  return e.k === "dragStart" || e.k === "dragMove" || e.k === "ruler" || e.k === "aoe";
}

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
  let pingK = 0;
  /** The `k` of the oldest ping still waiting for its pong. */
  let unansweredK: number | null = null;

  /** The scene a DM picked last. Null until the DM picks, so the server's default stands. */
  let wantedScene: string | null = null;
  /** The scene the in-flight `scene` or `hello` asked for. */
  let requestedScene: string | null = null;
  let sceneInFlight = false;

  // Ephemeral sending.
  const ephQueue = new Map<string, EphEvent>();
  /** Previews in progress, by slot, with when each was last sent. */
  const openPreviews = new Map<string, { e: EphEvent; sentAt: number }>();
  let ephFrameScheduled = false;
  const ephDelay = new Timer(clock);
  const keepAliveTimer = new Timer(clock);
  const ephSent: number[] = [];
  let lastEphFlush = Number.NEGATIVE_INFINITY;
  let pingSlot = 0;
  let ephScene: string | null = null;

  const role = () => room.store.getState().you?.role ?? "player";
  const previewOf = options.previewOf;

  function setConnection(state: "connecting" | "open" | "reconnecting" | "offline"): void {
    room.setConnection(state);
  }

  function lostState(): "connecting" | "reconnecting" | "offline" {
    if (env && !env.isOnline()) return "offline";
    return everOpen ? "reconnecting" : "connecting";
  }

  function sendRaw(msg: ClientMessage): boolean {
    if (!ws || ws.readyState !== OPEN) return false;
    if (previewOf !== undefined && msg.t !== "hello" && msg.t !== "ping") return false;
    try {
      ws.send(JSON.stringify(msg));
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
    unansweredK = null;
    sceneInFlight = false;
    ephQueue.clear();
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
    const current = room.store.getState().sceneId;
    const sceneId = role() === "dm" ? (wantedScene ?? current ?? undefined) : undefined;
    requestedScene = sceneId ?? null;
    if (sceneId && sceneId !== current) room.trackScene({ t: "request", sceneId });
    const msg: ClientMessage = sceneId ? { t: "hello", clientId, resumeFrom, sceneId } : { t: "hello", clientId, resumeFrom };
    if (!sendRaw(msg)) return;
    const wasOpen = phase === "open";
    phase = "hello";
    // For a scene switch the deadline already covers the whole exchange.
    if (!deadline.pending) startDeadline();
    if (wasOpen) staleTimer.set(STALE_SNAPSHOT_MS, () => setConnection("reconnecting"));
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
      keepAliveTimer.clear();
    }
    flushEph();
  }

  function receive(data: unknown): void {
    let json: unknown;
    try {
      json = typeof data === "string" ? JSON.parse(data) : null;
    } catch {
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
          if (wantedScene !== room.store.getState().sceneId) {
            sendScene();
            return;
          }
          // The DM went back to the scene on screen while the refusal waited.
          wantedScene = null;
          room.trackScene({ t: "cancel" });
        });
        return;
      case "eph":
        room.receiveEph(msg.from, msg.e);
        return;
      case "presence":
        room.setPresence(msg.online, msg.displays);
        return;
      case "access":
        room.accessChanged();
        return;
      case "xcard":
        room.receiveXcard(msg.at);
        return;
      case "wait":
        // Only a request still waiting for its snapshot has a deadline to move.
        if (phase === "hello" || sceneInFlight) {
          deadline.set(msg.ms + SNAPSHOT_DEADLINE_MS, () => giveUp("no snapshot"));
          room.trackScene({ t: "slow" });
        }
        return;
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

  function scheduleEphFlush(): void {
    if (ephFrameScheduled || ephDelay.pending) return;
    ephFrameScheduled = true;
    frame(() => {
      ephFrameScheduled = false;
      flushEph();
    });
  }

  /**
   * At most one flush per animation frame and at most 30 frames a second
   * (design 7.6). Within a flush each slot sends its latest event only.
   */
  function flushEph(): void {
    if (ephQueue.size === 0) return;
    const sceneId = room.store.getState().sceneId;
    if (phase !== "open" || !sceneId) {
      ephQueue.clear();
      return;
    }
    const now = clock.now();
    const rate = Math.min(EPH_PER_SECOND, Math.max(1, options.ephPerSecond?.() ?? EPH_PER_SECOND));
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
    for (const [slot, e] of ephQueue) {
      if (ephSent.length >= rate) break;
      ephQueue.delete(slot);
      if (!sendRaw({ t: "eph", sceneId, e })) continue;
      ephSent.push(now);
      const open = openPreviews.get(slot);
      if (open) open.sentAt = now;
    }
    if (ephQueue.size > 0) scheduleEphFlush();
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
        if (now - open.sentAt >= EPH_KEEPALIVE_MS && !ephQueue.has(slot)) ephQueue.set(slot, open.e);
      }
      scheduleEphFlush();
      armKeepAlive();
    });
  }

  // ------------------------------------------------------------ the socket object

  return {
    start() {
      if (phase !== "idle" || unsubscribeEnv) return;
      room.setOutbox({ send: sendRaw });
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
      reconnectTimer.clear();
      ephDelay.clear();
      keepAliveTimer.clear();
      openPreviews.clear();
      unsubscribeEnv?.();
      unsubscribeEnv = null;
      room.setOutbox(null);
      try {
        socket?.close(1000, "leaving");
      } catch {
        // Already closed.
      }
    },

    switchScene(sceneId) {
      if (role() !== "dm") return;
      wantedScene = sceneId;
      // A hello in flight, a scene in flight or a refused scene waiting out
      // its window all end in a snapshot or a timer that sends the latest pick.
      if (phase !== "open" || sceneInFlight || sceneRetryTimer.pending) {
        room.trackScene({ t: "request", sceneId });
        return;
      }
      if (sceneId === room.store.getState().sceneId) {
        wantedScene = null;
        room.trackScene({ t: "cancel" });
        return;
      }
      room.trackScene({ t: "request", sceneId });
      sendScene();
    },

    sendEph(e) {
      const slot = ephSlot(e, () => ++pingSlot);
      if (keepsAlive(e)) {
        const prev = openPreviews.get(slot);
        openPreviews.set(slot, { e, sentAt: prev?.sentAt ?? Number.NEGATIVE_INFINITY });
        armKeepAlive();
      } else {
        openPreviews.delete(slot);
        armKeepAlive();
      }
      if (phase !== "open") return;
      ephQueue.set(slot, e);
      scheduleEphFlush();
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
