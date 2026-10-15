import type { WebSocket } from "ws";
import type { EntityKey } from "#shared/keys.ts";
import type { HeldEntry } from "#shared/project.ts";
import type { Viewer } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { FrameBudget, OpRate, TokenBucket, type Clock } from "./budgets.ts";

/** Close codes from design section 7.1. */
export const CLOSE = {
  grantRevoked: 4001,
  authFailure: 4003,
  abuse: 4008,
  roomClosed: 4009,
  evicted: 4010,
  tooBusy: 4011,
  restarting: 1012,
  /** A socket whose send buffer stayed full (design 10.4). Not an abuse code: the client reconnects normally. */
  stalled: 1013,
} as const;

export type ClientKey = string;

export function clientKey(sessionId: string, clientId: string): ClientKey {
  return `${sessionId}|${clientId}`;
}

/** What a socket sends through the ephemeral channel and may still be showing on other screens. */
export type PreviewKind = "drag" | "ruler" | "aoe";

export type ConnectionOptions = {
  now?: Clock;
  /** Per-socket ephemeral rate (design 7.6): 40 per second, burst 80. */
  ephPerSec?: number;
  ephBurst?: number;
};

let nextId = 1;

/**
 * One WebSocket bound to a grant (design 10.2): the session, the member and
 * the role read when the socket was upgraded. The held map (design 7.3) is
 * null until the first snapshot and again after every `resync`, which is
 * also the rule for whether events may be sent on this socket at all.
 */
export class Connection {
  readonly id = nextId++;
  readonly socket: WebSocket;
  readonly sessionId: string;
  readonly roomId: string;
  readonly ip: string;
  /**
   * A table display (docs/design-v1-dm-tools.md 3.1). Its role stays
   * `'player'`, the role every projection and routing rule reads, so it
   * receives what a player who owns nothing receives. This flag is read
   * only where a display differs: it sends nothing but `hello` and `ping`,
   * it is left out of `online`, it alone receives `view`, and its snapshot
   * says `'display'`.
   */
  readonly display: boolean;
  memberId: string;
  role: Viewer["role"];
  clientId: string | null = null;
  /** A DM's chosen scene. Players follow the room's player scene and ignore this. */
  sceneId: string | null = null;
  held: Map<EntityKey, HeldEntry> | null = null;
  /** `hello` is accepted first, then once after each `resync`. */
  helloAllowed = true;
  /** A hello that is being answered: the socket must not send another before the snapshot. */
  helloPending = false;
  /** How many hellos this socket has sent. The first one is a new request for the snapshot budget's abuse rule. */
  helloCount = 0;
  closed = false;
  /** The code the server closed this socket with, if it did. A table display's session is renewed on close unless it was 4001. */
  closedWith: number | null = null;
  alive = true;
  bytesSent = 0;
  readonly frames: FrameBudget;
  readonly opRate: OpRate;
  readonly eph: TokenBucket;
  /** Previews other viewers hold from this socket, keyed `kind:id`, with the scene they were sent for. */
  readonly previewsSent = new Map<string, { kind: PreviewKind; id: string; sceneId: string }>();
  /** Previews this viewer currently shows, keyed `from|kind:id`. */
  readonly previewsHeld = new Set<string>();
  /** Timers that belong to this socket and die with it. */
  readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    socket: WebSocket,
    grant: { sessionId: string; roomId: string; memberId: string; role: Viewer["role"]; display?: boolean },
    ip: string,
    opts: ConnectionOptions = {},
  ) {
    this.socket = socket;
    this.sessionId = grant.sessionId;
    this.roomId = grant.roomId;
    this.memberId = grant.memberId;
    this.role = grant.role;
    this.display = grant.display === true;
    this.ip = ip;
    const now = opts.now ?? Date.now;
    this.frames = new FrameBudget(now);
    this.opRate = new OpRate(now);
    this.eph = new TokenBucket(opts.ephPerSec ?? 40, opts.ephBurst ?? 80, now);
  }

  get viewer(): Viewer {
    return { memberId: this.memberId, role: this.role };
  }

  get key(): ClientKey | null {
    return this.clientId === null ? null : clientKey(this.sessionId, this.clientId);
  }

  /** Sends one message, returning its size in UTF-8 bytes as it goes on the wire, or 0 when the socket is gone. */
  send(msg: ServerMessage): number {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return 0;
    const text = JSON.stringify(msg);
    this.socket.send(text);
    const bytes = Buffer.byteLength(text);
    this.bytesSent += bytes;
    return bytes;
  }

  close(code: number, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.closedWith = code;
    this.clearTimers();
    try {
      if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
        this.socket.close(code, reason);
      }
    } catch {
      this.socket.terminate();
    }
  }

  terminate(): void {
    if (!this.closed) {
      this.closed = true;
      this.clearTimers();
    }
    this.socket.terminate();
  }

  after(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  every(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (this.closed) {
        clearInterval(timer);
        this.timers.delete(timer);
        return;
      }
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  cancel(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    clearInterval(timer);
    this.timers.delete(timer);
  }

  clearTimers(): void {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
  }
}
