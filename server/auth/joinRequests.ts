import { randomToken } from "./tokens.ts";

/**
 * Join requests (docs/design/design-v1-join-requests.md 5.1): a newcomer
 * without the password asks, and a DM lets them in or turns them away.
 *
 * Everything lives here, in memory, beside the join tickets: a stranger's
 * typed name matters for 10 minutes and never reaches the database, and a
 * restart drops it all. Every step is synchronous, so of two racing calls
 * exactly one moves a request, and final admission checks and writes in one
 * step that no let-in, turn away, join or ending can slip into.
 *
 * `waiting` and `deciding` are live. A deciding request (a DM's let-in is
 * running) is moved by nothing but its own let-in: an ending that arrives
 * meanwhile is recorded in `endAfter` and applied if the let-in fails. Its
 * outcome is known before it leaves `deciding`, however long that takes.
 */

export const REQUEST_LIFE_MS = 10 * 60_000;
/** How long an ended request is kept, so a late wait still learns its outcome. */
export const ENDED_KEEP_MS = 2 * 60_000;
export const WAIT_HOLD_MS = 25_000;
export const SWEEP_MS = 15_000;
/** From an ask's first step to its final admission, Turnstile and lock waits included. */
export const ADMISSION_DEADLINE_MS = 30_000;
/** Twice the admission deadline, so every ask that started before a mark meets it. */
export const GOT_IN_MARK_MS = 60_000;
export const TURN_AWAY_HOLD_MS = 15 * 60_000;
// Waiting at once, memory bounds all three: a table of about 8 phones per
// address, 50 places a room, 500 on the server.
export const WAITING_PER_ADDRESS_ROOM = 8;
export const WAITING_PER_ROOM = 50;
export const WAITING_ON_SERVER = 500;

export type LiveState = "waiting" | "deciding";
export type Ending = "in" | "turned_away" | "expired" | "cancelled" | "closed" | "gone";
export type RequestState = LiveState | Ending;

export type JoinRequest = {
  readonly id: string;
  readonly roomId: string;
  /** The room's generation when the request was made. */
  readonly generation: number;
  /** The asking device's room session, or its ask token: one id either way, kept through promotion. */
  readonly sessionId: string;
  readonly ipKey: string;
  readonly name: string;
  readonly color: string;
  readonly askedAt: number;
  state: RequestState;
  /** An ending that arrived while deciding, applied if the let-in fails. */
  endAfter?: Ending | undefined;
  /** The let-in answered 202: its outcome is still being followed. The DM list shows it. */
  pending?: boolean | undefined;
  endedAt?: number | undefined;
};

/** What a held wait hears. `gone` answers 404 request_gone. */
export type WaitState = "waiting" | "in" | "superseded" | "turned_away" | "expired" | "closed" | "gone";

/** A place held for an ask that is still checking, so racing asks cannot overfill the caps. */
export type Reservation = {
  readonly id: number;
  readonly roomId: string;
  readonly ipKey: string;
  readonly startedAt: number;
  readonly generation: number;
};

export type Refusal = {
  ok: false;
  code: "busy" | "asks_off" | "room_not_found" | "request_deciding" | "already_in" | "asked_recently" | "asks_full";
  /** Seconds, for `asked_recently`: this device's own hold. */
  retryAfter?: number;
};

export type HeldWait = { answer: Promise<WaitState>; release(): void };

export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export type JoinRequestOptions = {
  now?: () => number;
  timers?: Timers;
  lifeMs?: number;
  holdMs?: number;
};

type Generation = { n: number; reason: "closed" | "deleted" | null };
type Waiter = { finish(state: WaitState): void };

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const ENDINGS: ReadonlySet<RequestState> = new Set<RequestState>(["in", "turned_away", "expired", "cancelled", "closed", "gone"]);

export function isEnding(state: RequestState): state is Ending {
  return ENDINGS.has(state);
}

/** What a requester may learn of an ending. A cancelled or replaced request is simply gone. */
function heard(state: Ending): WaitState {
  return state === "cancelled" ? "gone" : state;
}

export class JoinRequests {
  #now: () => number;
  #timers: Timers;
  #lifeMs: number;
  #holdMs: number;
  #signal: (roomId: string) => void = () => undefined;
  #requests = new Map<string, JoinRequest>();
  /** Each device's live request in a room, by `room|session`. */
  #live = new Map<string, string>();
  #reserved = new Map<number, Reservation>();
  #nextReservation = 1;
  #generations = new Map<string, Generation>();
  /** Turned-away devices, by `room|session`, until when. */
  #holds = new Map<string, number>();
  /** Devices that got in by a join, a DM claim or a let-in, by `room|session`, since when. */
  #marks = new Map<string, number>();
  #waits = new Map<string, Waiter>();
  #pendingSignals = new Set<string>();
  #closing = false;

  constructor(options: JoinRequestOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? realTimers;
    this.#lifeMs = options.lifeMs ?? REQUEST_LIFE_MS;
    this.#holdMs = options.holdMs ?? WAIT_HOLD_MS;
  }

  get lifeMs(): number {
    return this.#lifeMs;
  }

  /** The store's clock, which an ask's deadline is measured on. */
  now(): number {
    return this.#now();
  }

  /** The admission locks, per address and per room, taken in that order (5.2, the ask's step 6). */
  readonly locks = new KeyedLocks();

  /** The DMs' signal (shared/protocol.ts `joinRequests`), sent once per room per turn of the event loop. */
  onChange(signal: (roomId: string) => void): void {
    this.#signal = signal;
  }

  // ------------------------------------------------------------ reads

  /** The room's generation: bumped only by what ends its requests, a switch to With the password and a delete. */
  generation(roomId: string): number {
    return this.#generations.get(roomId)?.n ?? 0;
  }

  get(id: string): JoinRequest | undefined {
    return this.#requests.get(id);
  }

  /** Every record, for tests and their invariants. */
  all(): IterableIterator<JoinRequest> {
    return this.#requests.values();
  }

  reservations(): IterableIterator<Reservation> {
    return this.#reserved.values();
  }

  /**
   * The room's live requests, oldest first: what DM devices list. A request
   * being let in stays on the list, so the device that tapped Let in keeps
   * its row, and with it its busy words and any refusal, until the let-in
   * settles. The list marks it, and DM devices count, toast and turn away
   * only the waiting ones.
   */
  list(roomId: string): JoinRequest[] {
    this.#expireDue();
    return [...this.#requests.values()].filter((r) => r.roomId === roomId && !isEnding(r.state)).sort((a, b) => a.askedAt - b.askedAt);
  }

  /**
   * The device's live request in the room, or its kept ending that a
   * requester may hear: in, turned away, expired or closed. A cancelled or
   * replaced one is gone.
   */
  mine(roomId: string, sessionId: string): JoinRequest | null {
    this.#expireDue();
    const live = this.#live.get(key(roomId, sessionId));
    if (live) return this.#requests.get(live) ?? null;
    let newest: JoinRequest | null = null;
    for (const r of this.#requests.values()) {
      if (r.roomId !== roomId || r.sessionId !== sessionId || r.state === "cancelled" || r.state === "gone") continue;
      if (!newest || r.askedAt >= newest.askedAt) newest = r;
    }
    return newest;
  }

  expiresAt(r: JoinRequest): number {
    return r.askedAt + this.#lifeMs;
  }

  // ------------------------------------------------------------ the ask

  /** The ask's step 2, before anything is read from the database: a let-in running, or a turn-away hold. */
  deviceCheck(roomId: string, sessionId: string): Refusal | null {
    this.#expireDue();
    const live = this.#live.get(key(roomId, sessionId));
    if (live && this.#requests.get(live)?.state === "deciding") return { ok: false, code: "request_deciding" };
    return this.#held(roomId, sessionId);
  }

  /** Step 4: a place, synchronously, so racing asks cannot overfill the caps while the next steps wait. */
  reserve(roomId: string, ipKey: string, startedAt: number, generation: number): Reservation | Refusal {
    this.#expireDue();
    let address = 0;
    let room = 0;
    let server = 0;
    const count = (r: { roomId: string; ipKey: string }) => {
      server++;
      if (r.roomId === roomId) {
        room++;
        if (r.ipKey === ipKey) address++;
      }
    };
    for (const r of this.#requests.values()) if (!isEnding(r.state)) count(r);
    for (const r of this.#reserved.values()) count(r);
    if (address >= WAITING_PER_ADDRESS_ROOM || room >= WAITING_PER_ROOM || server >= WAITING_ON_SERVER) return { ok: false, code: "asks_full" };
    const reservation: Reservation = { id: this.#nextReservation++, roomId, ipKey, startedAt, generation };
    this.#reserved.set(reservation.id, reservation);
    return reservation;
  }

  /** Every refusal or error after step 4 gives the place back. Idempotent. */
  release(reservation: Reservation): void {
    this.#reserved.delete(reservation.id);
  }

  /**
   * Step 8, final admission: within the deadline, the generation unchanged,
   * the device's request here not deciding, the device not marked as got
   * in since the ask began, and not held. A waiting request of the device's
   * is replaced. The place becomes the request.
   */
  admit(reservation: Reservation, input: { sessionId: string; name: string; color: string }): { ok: true; request: JoinRequest } | Refusal {
    this.#expireDue();
    if (!this.#reserved.has(reservation.id)) return { ok: false, code: "busy" };
    const refuse = (refusal: Refusal): Refusal => {
      this.#reserved.delete(reservation.id);
      return refusal;
    };
    const { roomId } = reservation;
    const now = this.#now();
    if (now - reservation.startedAt > ADMISSION_DEADLINE_MS) return refuse({ ok: false, code: "busy" });
    const generation = this.#generations.get(roomId);
    if ((generation?.n ?? 0) !== reservation.generation) {
      return refuse({ ok: false, code: generation?.reason === "deleted" ? "room_not_found" : "asks_off" });
    }
    const deviceKey = key(roomId, input.sessionId);
    const liveId = this.#live.get(deviceKey);
    const live = liveId ? this.#requests.get(liveId) : undefined;
    if (live?.state === "deciding") return refuse({ ok: false, code: "request_deciding" });
    const mark = this.#marks.get(deviceKey);
    if (mark !== undefined && mark >= reservation.startedAt) return refuse({ ok: false, code: "already_in" });
    const held = this.#held(roomId, input.sessionId);
    if (held) return refuse(held);
    if (live) this.#end(live, "gone");

    const request: JoinRequest = {
      id: randomToken(),
      roomId,
      generation: reservation.generation,
      sessionId: input.sessionId,
      ipKey: reservation.ipKey,
      name: input.name,
      color: input.color,
      askedAt: now,
      state: "waiting",
    };
    this.#reserved.delete(reservation.id);
    this.#requests.set(request.id, request);
    this.#live.set(deviceKey, request.id);
    this.#changed(roomId);
    return { ok: true, request };
  }

  // ------------------------------------------------------------ the requester

  /**
   * A held wait on the device's own request. Null when the id, the room or
   * the device does not match, before any held wait is touched. A newer
   * wait on the same request answers the older one `superseded`, once. A
   * hold ends on the request's ending, at `holdMs` with `waiting`, or at
   * shutdown with `waiting`.
   */
  wait(roomId: string, id: string, sessionId: string): HeldWait | null {
    this.#expireDue();
    const r = this.#requests.get(id);
    if (!r || r.roomId !== roomId || r.sessionId !== sessionId) return null;
    if (isEnding(r.state)) return settled(heard(r.state));
    if (this.#closing) return settled("waiting");
    this.#waits.get(id)?.finish("superseded");
    let resolve!: (state: WaitState) => void;
    const answer = new Promise<WaitState>((res) => (resolve = res));
    let done = false;
    const waiter: Waiter = {
      finish: (state) => {
        if (done) return;
        done = true;
        this.#timers.clear(timer);
        if (this.#waits.get(id) === waiter) this.#waits.delete(id);
        resolve(state);
      },
    };
    const timer = this.#timers.set(() => waiter.finish("waiting"), this.#holdMs);
    this.#waits.set(id, waiter);
    return { answer, release: () => waiter.finish("waiting") };
  }

  /** Cancel. `deciding`: a let-in is committing, so the cancel is recorded and the let-in decides. */
  cancel(roomId: string, id: string, sessionId: string): "cancelled" | "deciding" | "ended" | "gone" {
    this.#expireDue();
    const r = this.#requests.get(id);
    if (!r || r.roomId !== roomId || r.sessionId !== sessionId) return "gone";
    if (r.state === "waiting") {
      this.#end(r, "cancelled");
      return "cancelled";
    }
    if (r.state === "deciding") {
      r.endAfter ??= "cancelled";
      return "deciding";
    }
    return "ended";
  }

  /**
   * The device got in another way, by `join/complete` or a DM claim: its
   * request here ends as gone, and the mark refuses every ask that started
   * before now.
   */
  gotIn(roomId: string, sessionId: string): void {
    const deviceKey = key(roomId, sessionId);
    const liveId = this.#live.get(deviceKey);
    const live = liveId ? this.#requests.get(liveId) : undefined;
    if (live?.state === "waiting") this.#end(live, "gone");
    else if (live?.state === "deciding") live.endAfter ??= "gone";
    this.#marks.set(deviceKey, this.#now());
  }

  // ------------------------------------------------------------ the DM

  /** A let-in takes a waiting request. */
  take(roomId: string, id: string): { ok: true; request: JoinRequest } | { ok: false; code: "request_gone" | "request_answered" } {
    this.#expireDue();
    const r = this.#requests.get(id);
    if (!r || r.roomId !== roomId) return { ok: false, code: "request_gone" };
    if (r.state === "waiting") {
      r.state = "deciding";
      this.#changed(roomId);
      return { ok: true, request: r };
    }
    if (r.state === "deciding" || r.state === "in" || r.state === "turned_away") return { ok: false, code: "request_answered" };
    return { ok: false, code: "request_gone" };
  }

  /** The let-in answered 202: every DM device's row says it is still letting them in. */
  markPending(id: string): void {
    const r = this.#requests.get(id);
    if (r?.state !== "deciding" || r.pending) return;
    r.pending = true;
    this.#changed(r.roomId);
  }

  /**
   * A let-in's outcome, once known. `in`: the grant committed and its
   * member is there, which wins over any ending recorded meanwhile. `gone`:
   * the device is in already, its session and token are both gone, or the
   * commit's outcome stayed unknown. `failed`: nothing was granted, so the
   * request takes the ending recorded meanwhile, or the one the room or the
   * clock calls for, or goes back to waiting with its place.
   */
  settle(id: string, outcome: "in" | "gone" | "closed" | "failed"): void {
    const r = this.#requests.get(id);
    if (r?.state !== "deciding") return;
    if (outcome === "closed") {
      // The let-in found the room With the password under its lock.
      this.#end(r, r.endAfter ?? "closed");
      return;
    }
    if (outcome === "in") {
      this.#end(r, "in");
      this.#marks.set(key(r.roomId, r.sessionId), this.#now());
      return;
    }
    if (outcome === "gone") {
      this.#end(r, "gone");
      return;
    }
    if (r.endAfter) {
      this.#end(r, r.endAfter);
      return;
    }
    const generation = this.#generations.get(r.roomId);
    if ((generation?.n ?? 0) !== r.generation) {
      this.#end(r, generation?.reason === "deleted" ? "gone" : "closed");
      return;
    }
    if (this.#now() - r.askedAt >= this.#lifeMs) {
      this.#end(r, "expired");
      return;
    }
    r.state = "waiting";
    r.pending = undefined;
    this.#changed(r.roomId);
  }

  /** Turns away the waiting requests among `ids` in this room, and holds their devices for 15 minutes. */
  turnAway(roomId: string, ids: readonly string[]): JoinRequest[] {
    this.#expireDue();
    const turned: JoinRequest[] = [];
    for (const id of ids) {
      const r = this.#requests.get(id);
      if (!r || r.roomId !== roomId || r.state !== "waiting") continue;
      this.#end(r, "turned_away");
      this.#holds.set(key(roomId, r.sessionId), this.#now() + TURN_AWAY_HOLD_MS);
      turned.push(r);
    }
    return turned;
  }

  /** The room switched to With the password, and that has committed: every live request ends as closed. */
  closeRoom(roomId: string): void {
    this.#bump(roomId, "closed");
  }

  /** The room is being deleted, and again once its row is gone: every live request ends as gone. */
  dropRoom(roomId: string): void {
    this.#bump(roomId, "deleted");
  }

  // ------------------------------------------------------------ upkeep

  /**
   * Every 15 s: ends what has expired, drops records ended more than 2
   * minutes ago, and forgets lapsed marks and holds.
   */
  sweep(): void {
    this.#expireDue();
    const now = this.#now();
    for (const [id, r] of this.#requests) if (r.endedAt !== undefined && now - r.endedAt >= ENDED_KEEP_MS) this.#requests.delete(id);
    for (const [k, at] of this.#marks) if (now - at >= GOT_IN_MARK_MS) this.#marks.delete(k);
    for (const [k, until] of this.#holds) if (until <= now) this.#holds.delete(k);
  }

  /** Shutdown: new waits answer at once, and every held one answers `waiting` now. */
  close(): void {
    this.#closing = true;
    for (const waiter of [...this.#waits.values()]) waiter.finish("waiting");
  }

  // ------------------------------------------------------------ internals

  #held(roomId: string, sessionId: string): Refusal | null {
    const until = this.#holds.get(key(roomId, sessionId));
    const now = this.#now();
    if (until === undefined || until <= now) return null;
    return { ok: false, code: "asked_recently", retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
  }

  #bump(roomId: string, reason: "closed" | "deleted"): void {
    const generation = this.#generations.get(roomId) ?? { n: 0, reason: null };
    this.#generations.set(roomId, { n: generation.n + 1, reason });
    const ending: Ending = reason === "closed" ? "closed" : "gone";
    for (const r of this.#requests.values()) {
      if (r.roomId !== roomId) continue;
      if (r.state === "waiting") this.#end(r, ending);
      else if (r.state === "deciding") r.endAfter ??= ending;
    }
    this.#changed(roomId);
  }

  #expireDue(): void {
    const now = this.#now();
    for (const r of this.#requests.values()) if (r.state === "waiting" && now - r.askedAt >= this.#lifeMs) this.#end(r, "expired");
  }

  #end(r: JoinRequest, ending: Ending): void {
    r.state = ending;
    r.endedAt = this.#now();
    r.endAfter = undefined;
    r.pending = undefined;
    const deviceKey = key(r.roomId, r.sessionId);
    if (this.#live.get(deviceKey) === r.id) this.#live.delete(deviceKey);
    this.#waits.get(r.id)?.finish(heard(ending));
    this.#changed(r.roomId);
  }

  #changed(roomId: string): void {
    if (this.#pendingSignals.size === 0) {
      queueMicrotask(() => {
        const rooms = [...this.#pendingSignals];
        this.#pendingSignals.clear();
        for (const room of rooms) this.#signal(room);
      });
    }
    this.#pendingSignals.add(roomId);
  }
}

/**
 * In-memory locks by key, so a waiting ask holds no pooled connection
 * (D-261102-109 rejected Postgres advisory locks for that). They live in the
 * one server process, as room actors do.
 */
export class KeyedLocks {
  #tails = new Map<string, Promise<void>>();

  /** Takes every key in the order given, and answers the one release for all of them. */
  async acquire(keys: readonly string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const k of keys) releases.push(await this.#one(k));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  async #one(k: string): Promise<() => void> {
    const before = this.#tails.get(k) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = before.then(() => mine);
    this.#tails.set(k, tail);
    await before;
    return () => {
      release();
      if (this.#tails.get(k) === tail) this.#tails.delete(k);
    };
  }
}

function key(roomId: string, sessionId: string): string {
  return `${roomId}|${sessionId}`;
}

function settled(state: WaitState): HeldWait {
  return { answer: Promise.resolve(state), release: () => undefined };
}

declare module "fastify" {
  interface FastifyInstance {
    /** For the room deletion path, which both the DM's route and the admin page take (server/http/rooms.ts). */
    joinRequests: JoinRequests;
  }
}
