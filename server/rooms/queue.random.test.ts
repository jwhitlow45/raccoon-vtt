import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry, Member, RoomState } from "#shared/model.ts";
import { eventReach, projectLogEntry } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { hiddenIn, hookPool, idFrom, IN_R, IN_SIDE, privTwins, revsIn, skewOf, skewTimers, type Hidden, type Hold, type PoolHooks, type PrivTwins, type TwinName } from "#shared/privTestutil.ts";
import { FrameReader, numbersIn, T0 } from "#shared/seqTestutil.ts";
import { chance, int, pick, rng, template } from "#shared/testutil.ts";
import { MAX_WAITING_READERS, RoomActor, ViewBusyError, type ActorDeps, type ActorOptions } from "./actor.ts";
import { OP_RATE, SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import * as persistence from "./persistence.ts";
import { StoredRoomDb } from "./undoScopeTesting.ts";

/**
 * The random twin test of the room's queue: two rooms whose copies for P1
 * and the table display match (shared/privTestutil.ts privTwins), with
 * two public areas that remind on entering and a fight on, on one
 * schedule of shared steps drawn from the seed, each on the stepped real
 * clock with its mocked timers, the 20 ms grid and the production number
 * clock. Every shared event has one time and runs in both twins at it:
 * P1's chats and runs of up to 49 in a tick, ops until its buckets are
 * empty, walks into and out of sight, the DM's damage and healing that
 * take P1's sight away and give it back, gap ops, asset ops behind a
 * queued chat, resends across a closed batch, reconnects with an `ids`
 * ask, readers and receipt lookups as of their arrival, ruler and drag
 * frames past a preview's 10 s age, a second socket of P1's, rolls, the
 * DM's moves P1 sees, and pauses longer than two marks. Before each, each
 * twin draws its own work P1 never sees: runs of answers (the DM's
 * renames of its own creatures, then P2's whispers to the DM) of up to
 * 108 in a tick, walks of its creatures while P1 sees the side room,
 * refused moves naming P1's creature, accepted moves that change
 * nothing, walks out and back, area lines no player reads, commits of 0
 * to 40 ms, held commits past the pending bound, lost COMMIT answers,
 * deletion steps of up to 50 ms, timers run late or early, a late delayed
 * snapshot, ask reads over several turns and readers that reach the room
 * late. In A, work in flight comes just ahead of the shared events that
 * read across it. A run of k answers keeps k + 2 ms clear of the next
 * shared answer, and the DM's own work leaves its buckets room for the
 * shared ops.
 *
 * In each twin, P1's and the display's frames are compared with the
 * other's, device by device, in number and order (those a batch's publish
 * sends), and as a set (those sent as a command is handled or on the
 * clock, whose place among the published ones follows commits), `clock`
 * frames apart, after each twin's raw scan for its own ids and names. So
 * is every reader's and lookup's answer and the rows the steps before a
 * walk store. Each twin checks the queue's rules on what it sent, built
 * and stored (QI1 to QI12 below), and the run counts what it covered
 * against floors.
 */

type Wire = ServerMessage | { t: string };
type Event = Extract<ServerMessage, { t: "ev" }>;
/** A device's socket, its frames with the clock time each came at past T0, and when each of its ops was sent. */
type Device = { conn: Connection; sent: Wire[]; times: number[]; n: number; label: string; clientId: string; sentAt: Map<number, number>; resent: Set<number> };
type Who = "dm" | "p1" | "p2";

const SEEDS = Number(process.env.QUEUE_RANDOM_SEEDS ?? 16);
const STEPS = Number(process.env.QUEUE_RANDOM_STEPS ?? 80);
const BATCH_MS = 20;
/** The closed batches that may wait for their commits before handling waits for the oldest. */
const PENDING_BOUND = 25;
/** The DM's ops its own work leaves in its buckets for the shared ones, so a shared op is never busy in one twin alone. */
const RESERVE = 6;
/** The longest run of answers of a twin's own, which with RESERVE fits the DM's buckets when full. */
const OWN_RUN_MAX = OP_RATE.burst - RESERVE;
/** Ayla's hit points: this much damage leaves her dying, short of the massive damage that kills outright. */
const AYLA_HP = 20;
/** The marks' period on the server clock. */
const MARK_MS = 10_000;
/** A pause in the shared steps longer than two marks, through which A's own answers go on. */
const IDLE_MS = 2 * MARK_MS + 1_000;
const PREVIEW_STALE_MS = 10_000;
const DISPLAY = "display:abcdefghijkl";
const P1 = { memberId: "p1", role: "player" as const };
const draw = (sides: number) => Math.ceil(sides / 2);
/** The tick a moment's commands belong to: the first multiple of the batch after it. */
const tickOf = (ms: number) => (Math.floor(ms / BATCH_MS) + 1) * BATCH_MS;
const chat = (text: string): Op => ({ t: "log.chat", text });
const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });
const hp = (kind: "damage" | "heal", amount: number): Op => ({ t: "actor.hp", target: { tokenId: "a" }, change: { kind, amount } }) as Op;
/** An asset id no library holds: its op meets the asset check and its lookup, and is refused alike in both twins. */
const ASSET = "0199f0a0-0000-7000-8000-00000000a5a5";
/** Frames sent as a command is handled or on the clock, not by a batch's publish. */
const AT_ONCE = new Set(["retry", "presence", "wait"]);
/** Public areas in room R that remind when a creature enters, where the twins' own creatures roam. */
const AREAS = ["0199f0a0-0000-7000-8000-0000000000b1", "0199f0a0-0000-7000-8000-0000000000b2"];

/** The coverage the floors read. */
type Counts = {
  frames: number;
  ownOps: number;
  bigTicks: number;
  slowCommits: number;
  walksInSight: number;
  refusedInSight: number;
  unchangedInSight: number;
  roundTrips: number;
  unreadLines: number;
  asksReading: number;
  emptiedAcrossHolds: number;
  assetChecksAfterQueued: number;
  resendsAcrossHeld: number;
  stepsUnderTraffic: number;
  lateDelayed: number;
  previewsPastAge: number;
  idsAsks: number;
  lateReaders: number;
  lookupsAcrossLost: number;
  marksOwnOnly: number;
  backpressure: number;
};

/** One shared event: its time in ms past T0, and what P1, the display or the DM does then in both twins. */
type Shared =
  | { at: number; k: "chat" | "side" | "back" | "inout" | "down" | "up" | "gap" | "over" | "idle" | "asset" | "resend" | "reconnect" | "second" | "roll" | "bree" | "ruler" | "dragStart" | "dragOn" | "delayed" }
  | { at: number; k: "run"; n: number }
  | { at: number; k: "read" | "lookup"; late: number };

/** One twin's own work, at its time. */
type Own =
  | { at: number; k: "answers"; n: number }
  | { at: number; k: "walk" | "refused" | "forbidden" | "unchanged" | "roundTrip" | "area" }
  | { at: number; k: "commit"; ms: number }
  | { at: number; k: "hold"; ticks: number }
  | { at: number; k: "lost"; mode: "committed" | "rolledBack" }
  | { at: number; k: "step"; ms: number }
  | { at: number; k: "skew"; by: number }
  | { at: number; k: "ask"; turns: number };

/** A model of a token bucket that reads the time it is given, never moving back (budgets.ts TokenBucket). */
class ModelBucket {
  #tokens: number;
  #last: number;
  readonly #perSec: number;
  readonly #burst: number;
  constructor(perSec: number, burst: number, at: number) {
    this.#perSec = perSec;
    this.#burst = burst;
    this.#tokens = burst;
    this.#last = at;
  }
  take(at: number, k = 1): boolean {
    if (!this.has(at, k)) return false;
    this.#tokens -= k;
    return true;
  }
  has(at: number, k: number): boolean {
    this.#tokens = Math.min(this.#burst, this.#tokens + (Math.max(0, at - this.#last) / 1000) * this.#perSec);
    this.#last = Math.max(this.#last, at);
    return this.#tokens >= k;
  }
}

class RTwin {
  readonly name: TwinName;
  readonly db: StoredRoomDb;
  readonly pool: ReturnType<StoredRoomDb["pool"]>;
  readonly hooks: PoolHooks;
  readonly clock = { now: T0 };
  readonly unseen: Hidden;
  readonly devices: Device[] = [];
  readonly warnings: string[] = [];
  readonly budget: SnapshotBudget;
  /** P1's browser session, which every socket of P1's shares. */
  readonly p1Session = uuidv7();
  /** Readers' answers, in the order they arrived, each with the step it arrived in. */
  readonly reads: Array<{ step: number; answer: Promise<string> }> = [];
  /** How many frames each device held at each step's end, by its label, to say where a difference began. */
  readonly stepEnds: Array<Map<string, number>> = [];
  /** The rows of the steps before a walk and of a batch's close, in the order stored. */
  readonly stepRows: string[] = [];
  /** How many members' rows each commit stored. */
  readonly commitRows: number[] = [];
  /** Each receipt row written, by its key, with its time. */
  readonly receiptRows = new Map<string, string[]>();
  /** When each mark built the snapshot, and when each snapshot row was written, past T0. */
  readonly builds: number[] = [];
  readonly writes: number[] = [];
  /** When this twin sent work of its own, and when a shared event came, past T0. */
  readonly ownTimes: number[] = [];
  readonly sharedTimes: number[] = [];
  /** When each deletion step arrived and ran, past T0. */
  readonly stepRuns: Array<{ arrived: number; ran: number }> = [];
  /** P1's ops the room should answer `busy` by the model of its buckets at their arrival, by device label and n. */
  readonly busyByModel = new Set<string>();
  readonly creatures: string[];
  waiting = 0;
  maxWaiting = 0;
  actor!: RoomActor;
  dm!: Device;
  p1!: Device;
  p2!: Device;
  display!: Device;
  second: Device | null = null;
  #pages = 1;
  readonly #t: TestContext;
  readonly #options: Partial<ActorOptions>;
  readonly #members = new Map<string, ModelBucket>();
  readonly #sockets = new Map<Connection, { op: ModelBucket; lookup: ModelBucket; member: string; p1: boolean }>();

  constructor(t: TestContext, name: TwinName, fixture: PrivTwins, options: Partial<ActorOptions>) {
    this.#t = t;
    this.name = name;
    this.db = new StoredRoomDb(structuredClone(fixture[name]));
    this.pool = this.db.pool();
    this.hooks = hookPool(this.pool);
    this.unseen = { ids: [...fixture.hidden[name].ids], names: [...fixture.hidden[name].names] };
    this.creatures = fixture.creatures[name];
    this.#options = options;
    // P1's session may take three snapshots in 400 ms, and a fourth waits.
    this.budget = new SnapshotBudget({ ipCount: 100_000, sessionCount: 3, windowMs: 400 }, () => this.clock.now);
    this.hooks.observe((sql, params) => this.#observe(sql, params));
  }

  /** What each commit stores, read as its statements start. */
  #observe(sql: string, params: readonly unknown[]): void {
    if (sql.startsWith("insert into room_snapshots")) this.writes.push(this.clock.now - T0);
    if (sql.startsWith("insert into room_ops")) {
      const members = params[3] as string[];
      const ops = params[5] as string[];
      this.commitRows.push(members.filter((m) => m !== "server").length);
      for (const op of ops) if (/"t":"sys\.(explore|remember)"/.test(op)) this.stepRows.push(op);
    }
    if (sql.startsWith("insert into roll_receipts (")) {
      const [, m, tags, parts, , , , , ats] = params as [string, string[], string[], number[], unknown, unknown, unknown, unknown, string[]];
      for (let i = 0; i < m.length; i++) {
        const key = `${m[i]} ${tags[i]} ${parts[i]}`;
        this.receiptRows.set(key, [...(this.receiptRows.get(key) ?? []), ats[i]!]);
      }
    }
  }

  member(who: Who): Member {
    return this.actor.committed.state.members[who === "dm" ? "dm1" : who]!;
  }

  async load(step: (ms: number) => Promise<void>): Promise<void> {
    const warnings = this.warnings;
    const clock = this.clock;
    const actor = await RoomActor.load({
      pool: this.pool,
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log: { info() {}, warn: (_o: unknown, msg?: string) => void warnings.push(msg ?? ""), error: (_o: unknown, msg?: string) => void warnings.push(`error: ${msg ?? ""}`), debug() {} },
      budget: this.budget,
      gateway: {} as RoomGateway,
      options: {
        batchMs: BATCH_MS,
        retryBaseMs: 5,
        retryMaxMs: 20,
        grantRecheckMs: 3_600_000,
        draw,
        now: () => clock.now,
        standingClock: true,
        idGate: false,
        // Each build a mark makes, by its time.
        ...({
          snapshotJson: (state: RoomState) => (this.builds.push(clock.now - T0), persistence.snapshotJson(state)),
          snapshotSlices: (state: RoomState) => (this.builds.push(clock.now - T0), persistence.snapshotSlices(state)),
        } as unknown as Partial<ActorOptions>),
        ...this.#options,
      },
    } satisfies ActorDeps);
    assert.ok(actor);
    this.actor = actor;
    this.#t.after(async () => {
      this.hooks.restore();
      await actor.shutdown({ code: 1012, snapshot: false });
    });
    this.dm = await this.open("dm", "dm", step);
    this.p1 = await this.open("p1", "p1#1", step);
    this.p2 = await this.open("p2", "p2", step);
    this.display = await this.open(null, "display#1", step);
  }

  async open(who: Who | null, label: string, step: (ms: number) => Promise<void>): Promise<Device> {
    const device = this.attach(who, label);
    this.hello(device);
    for (let i = 0; i < 200 && !device.sent.some((m) => m.t === "snapshot"); i++) await step(1);
    assert.ok(device.sent.some((m) => m.t === "snapshot"), `${this.name}: ${label}'s snapshot`);
    return device;
  }

  attach(who: Who | null, label: string): Device {
    const sent: Wire[] = [];
    const times: number[] = [];
    const clock = this.clock;
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => void (sent.push(JSON.parse(text) as Wire), times.push(clock.now - T0)), close() {}, terminate() {} };
    const grant = who === null ? { memberId: DISPLAY, role: "player" as const, display: true } : { memberId: this.member(who).id, role: who === "dm" ? ("dm" as const) : ("player" as const) };
    const conn = new Connection(socket as never, { sessionId: who === "p1" ? this.p1Session : uuidv7(), roomId: "UNDOSCOPE", ...grant }, "203.0.113.9", { now: () => this.clock.now });
    this.actor.attach(conn);
    const device: Device = { conn, sent, times, n: 0, label, clientId: uuidv7(), sentAt: new Map(), resent: new Set() };
    if (who === "p1" || who === null) this.devices.push(device);
    if (who !== null) this.#sockets.set(conn, { op: new ModelBucket(OP_RATE.perSec, OP_RATE.burst, clock.now), lookup: new ModelBucket(OP_RATE.perSec, OP_RATE.burst, clock.now), member: grant.memberId, p1: who === "p1" });
    return device;
  }

  hello(device: Device): void {
    void this.actor.hello(device.conn, { clientId: device.clientId, resumeFrom: device.n + 1 });
  }

  /**
   * Sends an op from a device. The model of its buckets says whether the
   * room should answer `busy`, by the op's arrival: its socket's lookup
   * bucket for an op naming an asset, then its socket's and its member's,
   * an ask's ops apiece. P1's are checked against the room's answers
   * (QI7). A device sends the next op under the number the room answered
   * `busy`, as a page does.
   */
  send(device: Device, op: Op | Record<string, unknown>, group?: string, reserve = 0): number {
    const n = device.n + 1;
    const buckets = this.#sockets.get(device.conn);
    const at = this.clock.now;
    let member: ModelBucket | undefined;
    if (buckets) {
      member = this.#members.get(buckets.member);
      if (!member) this.#members.set(buckets.member, (member = new ModelBucket(OP_RATE.perSec, OP_RATE.burst, at)));
    }
    // An ask costs one op apiece of those it carries, the first already spent whether the rest fit or not.
    const more = (op as { t: string; ops?: unknown[] }).t === "build.ask" ? (op as { ops: unknown[] }).ops.length - 1 : 0;
    if (reserve > 0 && buckets && member && !(buckets.op.has(at, 1 + more + reserve) && member.has(at, 1 + more + reserve))) return -1;
    device.sentAt.set(n, at - T0);
    let busy = false;
    if (buckets && member) {
      const asset = JSON.stringify(op).includes(ASSET);
      if (asset && !buckets.lookup.take(at)) busy = true;
      else {
        if (!buckets.op.take(at) || !member.take(at)) busy = true;
        if (!busy && more > 0) {
          if (buckets.op.has(at, more) && member.has(at, more)) {
            buckets.op.take(at, more);
            member.take(at, more);
          } else busy = true;
        }
      }
      if (busy && buckets.p1) this.busyByModel.add(`${device.label} ${n}`);
    }
    if (!busy) device.n = n;
    void this.actor.op(device.conn, n, op, group);
    return n;
  }

  /** An `ids` ask, which spends its socket's op rate as an op does. */
  ids(device: Device, k: number, ids: string[]): void {
    this.#sockets.get(device.conn)?.op.take(this.clock.now);
    this.actor.ids(device.conn, { k, ids });
  }

  reloadP1(): Device {
    this.actor.detach(this.p1.conn);
    const next = this.attach("p1", `p1#${++this.#pages}`);
    next.n = this.p1.n;
    next.clientId = this.p1.clientId;
    next.sentAt = this.p1.sentAt;
    next.resent = this.p1.resent;
    this.p1 = next;
    this.hello(next);
    return next;
  }

  /** A reader as P1 would read it, arrived at `arrived` past T0, asking now. */
  read(arrived: number): Promise<string> {
    this.waiting++;
    this.maxWaiting = Math.max(this.maxWaiting, this.waiting);
    return this.actor.asOf(T0 + arrived).then(
      (view) => {
        this.waiting--;
        const log = view.state.log.flatMap((l: LogEntry) => {
          const shown = projectLogEntry(view.state, l, P1, { sceneId: null });
          return shown ? [JSON.stringify(shown)] : [];
        });
        return `log ${log.join(" ")}`;
      },
      (err: unknown) => {
        this.waiting--;
        if (err instanceof ViewBusyError) return "busy";
        throw err;
      },
    );
  }

  /**
   * A receipt lookup of P1's as the route reads it, arrived at `arrived`
   * past T0: the room as of its arrival, then both receipt tables up to its
   * tick (persistence.ts readReceipts).
   */
  lookup(arrived: number, tag: string): Promise<string> {
    const read = (persistence as unknown as { readReceipts?: (q: unknown, roomId: string, memberId: string, tag: string, before: number) => Promise<unknown[]> }).readReceipts;
    this.waiting++;
    this.maxWaiting = Math.max(this.maxWaiting, this.waiting);
    return this.actor.asOf(T0 + arrived).then(
      async () => {
        this.waiting--;
        const at = T0 + arrived;
        return `receipts ${JSON.stringify(read ? await read(this.pool, "UNDOSCOPE", this.member("p1").id, tag, at - (at % BATCH_MS)) : null)}`;
      },
      (err: unknown) => {
        this.waiting--;
        if (err instanceof ViewBusyError) return "busy";
        throw err;
      },
    );
  }

  /**
   * Each compared device's frames, `clock` frames apart, by its label,
   * after the raw scan for this twin's own ids and names: those a batch's
   * publish sends, in order, and apart from them those sent as a command
   * is handled or on the clock (`retry`, `presence`, `wait`), as a set,
   * since when a batch publishes against them follows its commit, and a
   * presence frame comes both ways. History ids are mapped by one reader
   * over every device in turn.
   */
  frames(): Map<string, string[]> {
    const raw = this.devices.flatMap((d) => d.sent);
    assert.deepEqual(hiddenIn(raw, this.unseen), [], `${this.name}: no frame names what P1 and the display never see`);
    assert.deepEqual(revsIn(raw), [], `${this.name}: every rev P1 and the display hold is 0`);
    const reader = new FrameReader();
    const out = new Map<string, string[]>();
    for (const d of this.devices) {
      out.set(d.label, d.sent.filter((m) => m.t !== "clock" && !AT_ONCE.has(m.t)).map((m) => reader.text(m)));
      out.set(`${d.label} at once`, d.sent.filter((m) => AT_ONCE.has(m.t)).map((m) => reader.text(m)).sort());
    }
    return out;
  }

  /** Area lines of the public areas no player reads, by id, gathered at each step's end before the log's ring drops them. */
  readonly unread = new Set<string>();
  noteUnread(): void {
    const state = this.actor.committed.state;
    for (const l of state.log) {
      if (l.data?.type !== "area" || !AREAS.includes(l.data.templateId) || this.unread.has(l.id)) continue;
      const reach = eventReach(state, l.data);
      if (reach !== "all" && reach.length === 0) this.unread.add(l.id);
    }
  }

  counts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const d of this.devices) {
      out.set(d.label, d.sent.filter((m) => m.t !== "clock" && !AT_ONCE.has(m.t)).length);
      out.set(`${d.label} at once`, d.sent.filter((m) => AT_ONCE.has(m.t)).length);
    }
    return out;
  }
}

/** The shared schedule: steps of a few ticks, each with its shared events, drawn from the seed alone. */
function schedule(r: () => number, steps: number): Shared[][] {
  const out: Shared[][] = [];
  let at = 1_000;
  let inSide = false;
  let down = false;
  let dragging = false;
  let rolled = false;
  for (let i = 0; i < steps; i++) {
    at = at - (at % BATCH_MS) + int(r, 3, 8) * BATCH_MS;
    const first = at + int(r, 3, 17);
    const kinds: Array<[number, () => Shared]> = [
      [8, () => ({ at: first, k: "chat" })],
      [9, () => ({ at: first, k: "run", n: int(r, 2, 49) })],
      // P1's creature walks back only on its feet: a dying one is healed first.
      [10, () => ({ at: first, k: inSide ? (down ? "up" : "back") : chance(r, 0.7) ? "side" : "inout" })],
      [inSide ? 6 : 0, () => ({ at: first, k: down ? "up" : "down" })],
      [3, () => ({ at: first, k: "gap" })],
      [20, () => ({ at: first, k: "over" })],
      [14, () => ({ at: first, k: "asset" })],
      [17, () => ({ at: first, k: "resend" })],
      [2, () => ({ at: first + IDLE_MS, k: "idle" })],
      [6, () => ({ at: first, k: "reconnect" })],
      [3, () => ({ at: first, k: "second" })],
      [5, () => ({ at: first, k: "roll" })],
      [4, () => ({ at: first, k: "bree" })],
      [4, () => ({ at: first, k: "ruler" })],
      [dragging ? 0 : 8, () => ({ at: first, k: "dragStart" })],
      [6, () => ({ at: first, k: "read", late: chance(r, 0.6) ? int(r, 1, 60) : 0 })],
      [rolled ? 7 : 0, () => ({ at: first, k: "lookup", late: chance(r, 0.6) ? int(r, 1, 60) : 0 })],
      [2, () => ({ at: first, k: "delayed" })],
    ];
    let roll = r() * kinds.reduce((sum, [w]) => sum + w, 0);
    let main: Shared = { at: first, k: "chat" };
    for (const [w, make] of kinds) {
      if (roll < w) {
        main = make();
        break;
      }
      roll -= w;
    }
    const events: Shared[] = [main];
    if (main.k === "side" || main.k === "inout") inSide = main.k === "side";
    if (main.k === "back") inSide = false;
    if (main.k === "roll") rolled = true;
    if (main.k === "down") down = true;
    if (main.k === "up") down = false;
    if (main.k === "dragStart") dragging = true;
    // A delayed snapshot's wait (the budget's 400 ms window) and its late timer pass with nothing else shared.
    if (main.k === "delayed") {
      out.push(events);
      at = main.at + 560;
      continue;
    }
    if (main.k === "idle") {
      out.push(events);
      at = main.at;
      continue;
    }
    // A drag's next frame past its preview's age.
    if (dragging && main.k !== "dragStart" && chance(r, 0.7)) {
      // A step of its own, so the work before it is drawn just ahead of it.
      out.push(events);
      at = main.at - (main.at % BATCH_MS) + PREVIEW_STALE_MS - int(r, 0, 3) * BATCH_MS;
      out.push([{ at: at + int(r, 3, 17), k: "dragOn" }]);
      at += 20;
      dragging = false;
      continue;
    } else if (chance(r, 0.3)) {
      // A later tick's event, inside the tick as the first is, clear of its edges.
      const later = first - (first % BATCH_MS) + int(r, 1, 3) * BATCH_MS + int(r, 3, 17);
      events.push(chance(r, 0.5) ? { at: later, k: "chat" } : { at: later, k: "read", late: chance(r, 0.6) ? int(r, 1, 60) : 0 });
    }
    out.push(events);
    at = Math.max(...events.map((e) => e.at));
  }
  return out;
}

/** Shared events whose rule is about work in flight: before them A holds or slows its commits, or loses an answer. */
const ACROSS = new Set<Shared["k"]>(["run", "over", "asset", "resend", "dragOn", "lookup"]);

/**
 * One twin's own work after `from`, the newest number a shared answer
 * took, and before `next`, the step's shared event, of kind `before`. A
 * run of k answers ends k + 2 ms before `next`, so its numbers run past
 * its tick only while no shared answer is due. Holds and steps end before
 * `settledBy`, the next socket opened or closed, and steps before
 * `lookupBy`, the next asset op. In A, work in flight is drawn last, just
 * ahead of a shared event that reads across it.
 */
function own(r: () => number, from: number, next: number, before: Shared["k"], isA: boolean, inSight: boolean, settledBy: number, lookupBy: number): Own[] {
  const out: Own[] = [];
  let t = from + 1;
  const room = (k: number) => t + k + 2 <= end;
  // In A, work in flight just ahead of a shared event that reads across it, with an answer of its own so a commit runs.
  const across: Own[] = [];
  let end = next;
  if (isA && ACROSS.has(before) && t < next - 4 && chance(r, 0.9)) {
    const at = Math.max(t, before === "asset" ? next - 3 : next - int(r, 2, 3) * BATCH_MS);
    if (before === "lookup") {
      if (at + 6 * BATCH_MS <= settledBy) across.push({ at, k: "lost", mode: chance(r, 0.5) ? "committed" : "rolledBack" }, { at, k: "answers", n: 1 });
    } else if (before === "asset") {
      // An ask read holds the loop past the asset op, so P1's chat ahead of it is still queued.
      if (at + 4 * BATCH_MS <= settledBy) across.push({ at, k: "ask", turns: 4 });
    } else if (at + 12 * BATCH_MS <= settledBy) across.push({ at, k: "hold", ticks: int(r, 4, 8) }, { at, k: "answers", n: 1 });
    if (across.length > 0) end = at;
  }
  for (let i = int(r, 1, 4); i > 0 && t < end - 4; i--) {
    const roll = r();
    if (roll < (inSight ? 0.25 : 0.35)) {
      const n = chance(r, 0.6) ? int(r, 51, OWN_RUN_MAX * 2) : int(r, 1, 20);
      if (room(n)) {
        out.push({ at: t, k: "answers", n });
        t += n + 1;
      } else t = tickOf(t) + 1;
    } else if (roll < (inSight ? 0.7 : 0.55)) {
      const k = pick(r, inSight ? (["walk", "walk", "refused", "forbidden", "unchanged", "unchanged", "roundTrip", "area"] as const) : (["walk", "area", "area", "area", "roundTrip", "unchanged"] as const));
      if (room(2)) {
        out.push({ at: t, k });
        t += 4;
      }
    } else if (roll < 0.74) {
      if (t + 8 * BATCH_MS <= settledBy) out.push({ at: t, k: "commit", ms: chance(r, 0.5) ? int(r, BATCH_MS + 1, 40) : int(r, 0, BATCH_MS) });
    } else if (roll < 0.78) {
      // With an answer of its own at once, so the loss falls on this twin's next commit, before a socket opens or closes.
      if (room(1) && t + 6 * BATCH_MS <= settledBy) {
        out.push({ at: t, k: "lost", mode: chance(r, 0.5) ? "committed" : "rolledBack" }, { at: t, k: "answers", n: 1 });
        t += 2;
      }
    } else if (roll < 0.86) {
      const ms = int(r, 1, 50);
      if (t + ms + 3 * BATCH_MS <= Math.min(settledBy, lookupBy, end)) out.push({ at: t, k: "step", ms });
    } else if (roll < 0.9) {
      // With an answer of its own at once, whose batch's timer is the one moved.
      if (room(1) && t + 4 * BATCH_MS <= settledBy) {
        out.push({ at: t, k: "skew", by: chance(r, 0.7) ? int(r, 1, 6) : -int(r, 1, 6) }, { at: t, k: "answers", n: 1 });
        t += 2;
      }
    } else if (roll < 0.94) {
      if (room(1) && t + 4 * BATCH_MS <= settledBy) {
        out.push({ at: t, k: "ask", turns: int(r, 2, 4) });
        t += 1;
      }
    } else {
      const ticks = roll < 0.965 ? int(r, 2, 8) : PENDING_BOUND + int(r, 1, 4);
      if (t + (ticks + 4) * BATCH_MS <= Math.min(settledBy, end)) out.push({ at: t, k: "hold", ticks });
    }
  }
  return [...out, ...across];
}

/**
 * One twin's whole run on the schedule, under its own mocked timers, its
 * own work drawn from `ownR`. What both twins are compared on is kept for
 * after both ran.
 */
async function runTwin(t: TestContext, twin: RTwin, plan: Shared[][], ownR: () => number, counts: Counts): Promise<void> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Every timer armed, by its due time on the twin's clock, so the clock jumps from one to the next and the room
  // works at each: a millisecond at a time would cost the event loop a turn each.
  const dues: number[] = [];
  const mocked = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    dues.push(twin.clock.now + Math.max(0, ms ?? 0));
    return mocked(fn, ms, ...args);
  }) as typeof globalThis.setTimeout;
  // The loop's clock, which the drain and an ask's reading spend their turns on (actor.ts DRAIN_TURN_MS, ASK_TURN_MS),
  // is the twin's clock too. Read in real time, a slow machine ends their turns early, and commands the room has not
  // handled in the few turns `work` gives it wait past a shared event that opens or closes a socket, as no command does
  // on the stepped clock.
  const loop = t.mock.method(performance, "now", () => twin.clock.now);
  let skew: { restore(): void } | null = null;
  let stillUntil = -1;
  /** Until when this twin's commits are held or slow, or its queue held, for the floors. */
  let busyUntil = -1;
  const held: Hold[] = [];
  const isA = twin.name === "door";
  try {
    /** Lets the room work: its promises, and its turns unless the loop is held (an ask read). */
    const work = async () => {
      if (twin.clock.now - T0 < stillUntil) for (let j = 0; j < 40; j++) await Promise.resolve();
      else for (let j = 0; j < 3; j++) await new Promise((resolve) => setImmediate(resolve));
    };
    /** Moves the clock to `at` past T0, stopping at each timer due on the way. */
    const to = async (at: number) => {
      const target = T0 + at;
      await work();
      for (let guard = 0; guard < 1_000_000; guard++) {
        let next = Number.POSITIVE_INFINITY;
        let w = 0;
        for (const d of dues) {
          if (d < twin.clock.now) continue;
          dues[w++] = d;
          if (d < next) next = d;
        }
        dues.length = w;
        if (next > target) break;
        const gap = next - twin.clock.now;
        // Timers due now that already ran are dropped before the tick, so only ones armed since stay.
        for (let i = dues.length - 1; i >= 0; i--) if (dues[i] === next) dues.splice(i, 1);
        twin.clock.now = next;
        t.mock.timers.tick(gap);
        await work();
      }
      if (twin.clock.now < target) {
        t.mock.timers.tick(target - twin.clock.now);
        twin.clock.now = target;
        await work();
      }
    };
    const now = () => twin.clock.now - T0;
    await twin.load((ms) => to(now() + ms));
    await to(500);
    twin.send(twin.p1, chat("ready"));
    await to(900);
    let frontier = 900;
    /** Until when this twin's own work waits: past a delayed snapshot's due time and its late timer. */
    let quietUntil = 0;
    // Where P1's creature stands once every op taken so far lands, the committed state lagging it while commits are held,
    // and whether it is down. P1 sees the side room from it there on its feet.
    const first = twin.actor.committed.state.tokens.a!;
    let aAt: { x: number; y: number } = { x: first.x, y: first.y };
    let aDown = false;
    const sees = () => aAt.x === IN_SIDE.x && aAt.y === IN_SIDE.y && !aDown;
    /** The newest number this twin's own answers took. */
    let ownEnd = 0;
    /** When A last lost a COMMIT answer, and P1's last roll's tag and time, for the lookups across a lost answer. */
    let lostAt = -1;
    let lastRoll: { tag: string; at: number } | null = null;
    const dm = (op: Op | Record<string, unknown>, group?: string) => twin.send(twin.dm, op, group, RESERVE);
    // A socket opened or closed sees what was published before it, so every commit and hold of this twin's own has
    // ended by then: when a batch publishes, against a page's lifetime, is the commit's to answer for.
    const lifetimes = new Set<Shared["k"]>(["reconnect", "second", "delayed"]);
    const settledBy = plan.map((_, i) => Math.min(...plan.slice(i).flatMap((events) => events.filter((e) => lifetimes.has(e.k)).map((e) => e.at - 5 * BATCH_MS)), Number.POSITIVE_INFINITY));
    // An asset op's lookup waits out a deletion step, and its arrival is taken after its lookup, so a step of this
    // twin's own ends before the next asset op: a lookup in queue order is left for later.
    const lookupBy = plan.map((_, i) => Math.min(...plan.slice(i).flatMap((events) => events.filter((e) => e.k === "asset").map((e) => e.at)), Number.POSITIVE_INFINITY));
    for (const [i, events] of plan.entries()) {
      const life = events.some((e) => lifetimes.has(e.k));
      const next = life ? events[0]!.at - 5 * BATCH_MS : events[0]!.at;
      const mine = own(ownR, Math.max(frontier, quietUntil, now()), next, events[0]!.k, isA, sees(), settledBy[i]!, lookupBy[i]!);
      for (const o of mine) {
        await to(o.at);
        twin.ownTimes.push(o.at);
        switch (o.k) {
          case "answers": {
            // The DM's renames of its own creatures, and past what its buckets hold, P2's whispers to the DM.
            let sent = 0;
            for (let j = 0; j < o.n; j++) {
              const name = `Shade ${twin.name} ${int(ownR, 0, 1e9)}`;
              twin.unseen.names.push(name);
              if (j < OWN_RUN_MAX ? dm({ t: "token.update", tokenId: pick(ownR, twin.creatures), patch: { name } }) > 0 : twin.send(twin.p2, { t: "log.whisper", to: [twin.member("dm").id], text: name }, undefined, 1) > 0) sent++;
            }
            counts.ownOps += sent;
            ownEnd = Math.max(ownEnd, now() + sent);
            break;
          }
          case "walk":
            if (dm(move(pick(ownR, twin.creatures), int(ownR, 6, 9), int(ownR, 2, 3))) > 0) {
              counts.ownOps++;
              if (sees()) counts.walksInSight++;
            }
            break;
          case "refused":
            if (dm({ t: "token.move", tokenId: "a", x: "far", y: 4 }) > 0 && sees()) counts.refusedInSight++;
            break;
          case "forbidden":
            if (twin.send(twin.p2, move("a", 9, 9)) > 0 && sees()) counts.refusedInSight++;
            break;
          case "unchanged":
            if (dm(move("a", aAt.x, aAt.y)) > 0 && sees()) counts.unchangedInSight++;
            break;
          case "roundTrip": {
            const c = twin.actor.committed.state.tokens[pick(ownR, twin.creatures)];
            if (c && dm({ t: "token.move", tokenId: c.id, x: c.x, y: c.y, route: [[c.x, c.y + 1, 0, 0], [c.x, c.y, 0, 0]] }) > 0 && sees()) counts.roundTrips++;
            break;
          }
          case "area": {
            // A creature only the DM sees walks out of the public areas and back into one, in the fight's turn.
            const id = pick(ownR, twin.creatures);
            dm(move(id, 9, 8));
            dm(move(id, pick(ownR, [7, 8]), 3));
            counts.ownOps += 2;
            break;
          }
          case "commit":
            // For three ticks, so the commits waiting behind them catch up before a socket opens or closes.
            twin.hooks.commitLength(o.ms);
            globalThis.setTimeout(() => twin.hooks.commitLength(0), 3 * BATCH_MS);
            if (o.ms > BATCH_MS) {
              if (isA) counts.slowCommits++;
              busyUntil = Math.max(busyUntil, now() + 4 * BATCH_MS);
            }
            break;
          case "lost":
            twin.hooks.loseCommits([o.mode]);
            if (isA) lostAt = now();
            break;
          case "hold": {
            const h = twin.hooks.holdCommits();
            held.push(h);
            const until = now() + o.ticks * BATCH_MS;
            busyUntil = Math.max(busyUntil, until);
            if (isA) counts.slowCommits++;
            if (o.ticks >= PENDING_BOUND && isA) counts.backpressure++;
            // Past the pending bound the DM answers every tick meanwhile, so closed batches wait behind the held commit.
            const release = () => {
              twin.hooks.commitLength(0);
              h.release();
            };
            const tick = () => {
              if (now() >= until) return release();
              // Clear of every number a shared answer took or will take this millisecond.
              if (Math.max(frontier, ownEnd) >= now() - 1) return void globalThis.setTimeout(tick, BATCH_MS);
              const name = `Shade ${twin.name} ${int(ownR, 0, 1e9)}`;
              twin.unseen.names.push(name);
              dm({ t: "token.update", tokenId: twin.creatures[0]!, patch: { name } });
              globalThis.setTimeout(tick, BATCH_MS);
            };
            if (o.ticks >= PENDING_BOUND) globalThis.setTimeout(tick, BATCH_MS - (now() % BATCH_MS) + 1);
            else globalThis.setTimeout(release, o.ticks * BATCH_MS);
            break;
          }
          case "step": {
            const arrived = now();
            const ms = o.ms;
            busyUntil = Math.max(busyUntil, arrived + ms + 2 * BATCH_MS);
            void twin.actor
              .deletionStep(async () => {
                twin.stepRuns.push({ arrived, ran: now() });
                await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
                return { deleted: [], result: null };
              })
              .catch(() => undefined);
            counts.stepsUnderTraffic++;
            break;
          }
          case "skew": {
            skew?.restore();
            // An early timer still fires a millisecond or more after it was armed: one in the same millisecond reads as a
            // test's standing clock, which closes at the first firing (actor.ts #armTimer).
            const by = o.by;
            let left = 1;
            skew = skewTimers((ms) => {
              if (left === 0 || ms <= 1 || ms > BATCH_MS) return 0;
              left--;
              return by > 0 ? by : Math.max(by, 1 - ms);
            });
            break;
          }
          case "ask": {
            const cells = Array.from({ length: 3 }, (_, j) => `${28 + j},${int(ownR, 10, 13)}`);
            if (dm({ t: "build.ask", sceneId: "s1", ops: cells.map((c) => ({ t: "build.paint", sceneId: "s1", terrain: "wood", cells: [c] })), part: 0 }, uuidv7()) > 0) {
              // Its reading goes on over turns of its own while the loop is held.
              stillUntil = now() + o.turns * 5;
              counts.asksReading++;
            }
            break;
          }
        }
      }
      // Through a pause, A answers on its own every 2 s, so marks pass with its work alone.
      if (events[0]!.k === "idle" && isA) {
        for (let x = now() + 2_000; x < next - 200; x += 2_000) {
          await to(x);
          twin.ownTimes.push(x);
          const name = `Shade ${twin.name} ${int(ownR, 0, 1e9)}`;
          twin.unseen.names.push(name);
          dm({ t: "token.update", tokenId: twin.creatures[0]!, patch: { name } });
        }
      }
      if (life) {
        await to(next);
        twin.hooks.commitLength(0);
      }
      for (const e of events) {
        await to(e.at);
        twin.sharedTimes.push(e.at);
        const p1 = twin.p1;
        const busy = now() < busyUntil;
        // A device moves on to its next number only when the model takes the op.
        const taken = (n: number) => p1.n === n;
        switch (e.k) {
          case "chat":
          case "idle":
            twin.send(p1, chat(`chat ${i}`));
            frontier = e.at;
            break;
          case "run":
            for (let j = 0; j < e.n; j++) twin.send(p1, chat(`run ${i} ${j}`));
            frontier = e.at + e.n;
            if (busy && isA && twin.busyByModel.has(`${p1.label} ${p1.n}`)) counts.emptiedAcrossHolds++;
            break;
          case "side":
            if (taken(twin.send(p1, move("a", IN_SIDE.x, IN_SIDE.y)))) aAt = IN_SIDE;
            frontier = e.at;
            break;
          case "back":
            if (taken(twin.send(p1, move("a", IN_R.x, IN_R.y)))) aAt = IN_R;
            frontier = e.at;
            break;
          case "inout":
            if (taken(twin.send(p1, move("a", IN_SIDE.x, IN_SIDE.y)))) aAt = IN_SIDE;
            if (taken(twin.send(p1, move("a", IN_R.x, IN_R.y)))) aAt = IN_R;
            frontier = e.at + 1;
            break;
          case "down":
            // P1's only sight goes, with no walk: the DM's damage leaves Ayla dying, short of the massive damage that kills.
            twin.send(twin.dm, hp("damage", AYLA_HP));
            aDown = true;
            frontier = e.at;
            break;
          case "up":
            twin.send(twin.dm, hp("heal", AYLA_HP));
            aDown = false;
            frontier = e.at;
            break;
          case "over": {
            // P1 sends until its buckets are empty, and twice more: each of those is answered busy.
            let k = 0;
            for (let more = true; more && k < 3 * OP_RATE.burst; k++) more = taken(twin.send(p1, chat(`over ${i} ${k}`)));
            for (let j = 0; j < 2; j++, k++) twin.send(p1, chat(`over ${i} ${k}`));
            frontier = e.at + k;
            // Each op that met the empty buckets while A's commits were held or slow.
            if (busy && isA) counts.emptiedAcrossHolds += 3;
            break;
          }
          case "gap":
            // An op past the next number: answered `gap`, and the device goes on from its own next.
            void twin.actor.op(p1.conn, p1.n + 2, chat("gap"));
            break;
          case "asset":
            // Behind a chat of P1's still queued: the asset check reads the buckets at the op's own arrival.
            twin.send(p1, chat(`before ${i}`));
            if (isA && twin.actor.queueLength > 0) counts.assetChecksAfterQueued++;
            twin.send(p1, { t: "token.update", tokenId: "a", patch: { name: "Ayla" }, assetId: ASSET });
            frontier = e.at + 1;
            break;
          case "resend":
            if (p1.n > 0) {
              p1.resent.add(p1.n);
              void twin.actor.op(p1.conn, p1.n, chat("again"));
              if (isA && busy) counts.resendsAcrossHeld++;
            }
            break;
          case "reconnect": {
            const page = twin.reloadP1();
            twin.ids(page, i, [idFrom(rng(i))]);
            if (isA) counts.idsAsks++;
            break;
          }
          case "second":
            if (twin.second) {
              twin.actor.detach(twin.second.conn);
              twin.second = null;
            } else {
              twin.second = twin.attach("p1", `second#${i}`);
              twin.hello(twin.second);
            }
            break;
          case "roll": {
            const tag = idFrom(rng(1_000 + i));
            if (taken(twin.send(p1, { t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op))) lastRoll = { tag, at: e.at };
            frontier = e.at;
            break;
          }
          case "lookup": {
            // P1 looks its last roll up, late in A as a reader held at its grant read, across a lost answer there.
            const arrived = e.at;
            const late = isA ? e.late : 0;
            const roll = lastRoll;
            if (roll === null) break;
            if (isA && lostAt > roll.at) counts.lookupsAcrossLost++;
            twin.reads.push({
              step: i,
              answer: (async () => {
                if (late > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, late));
                return twin.lookup(arrived, roll.tag);
              })(),
            });
            break;
          }
          case "bree":
            twin.send(twin.dm, move("b", 3 + (i % 5), 7));
            frontier = e.at;
            break;
          case "ruler":
            twin.actor.ephemeral(p1.conn, { sceneId: "s1", e: { k: "ruler", id: "0199f0a0-0000-7000-8000-0000000000c1", points: [{ x: 3.5, y: 3.5 }, { x: 5.5, y: 3.5 }] } as never }, twin.clock.now);
            break;
          case "dragStart":
            twin.actor.ephemeral(p1.conn, { sceneId: "s1", e: { k: "dragStart", tokenId: "a", x: 4.5, y: 4.5 } }, twin.clock.now);
            break;
          case "dragOn":
            twin.actor.ephemeral(p1.conn, { sceneId: "s1", e: { k: "dragMove", tokenId: "a", x: 5.5, y: 5.5 } }, twin.clock.now);
            if (isA && busy) counts.previewsPastAge++;
            break;
          case "read": {
            const arrived = e.at;
            // A reader that reaches the room late in A, as one held at its grant read does, asks as of its arrival.
            const late = isA ? e.late : 0;
            if (late > 0) counts.lateReaders++;
            twin.reads.push({
              step: i,
              answer: (async () => {
                if (late > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, late));
                return twin.read(arrived);
              })(),
            });
            break;
          }
          case "delayed": {
            // P1's page reloads four times in a row, and the fourth waits for its session's budget. Its due timer runs late
            // in A.
            for (let j = 0; j < 3; j++) {
              twin.reloadP1();
              await to(now() + 1);
            }
            if (isA) {
              skew?.restore();
              skew = skewTimers(skewOf(int(ownR, 1, 30), (ms) => ms > BATCH_MS && ms <= 400, 1));
              counts.lateDelayed++;
            }
            twin.reloadP1();
            // Nothing of this twin's own is taken between its due time and its late timer, which would move it to a later
            // batch: a loop held that long is the event loop's to answer for, as every frame it holds is.
            quietUntil = e.at + 520;
            break;
          }
        }
      }
      await to(Math.max(...events.map((e) => e.at)) + 6 * BATCH_MS);
      twin.stepEnds.push(twin.counts());
      twin.noteUnread();
    }
    for (const h of held) h.release();
    twin.hooks.commitLength(0);
    stillUntil = -1;
    await to(now() + 2_000);
    // A command still queued here has sent nothing yet, so the frames and answers compared below would miss it.
    assert.equal(twin.actor.queueLength, 0, `${twin.name}: every command was handled before the run ended`);
  } finally {
    skew?.restore();
    globalThis.setTimeout = mocked;
    loop.mock.restore();
    t.mock.timers.reset();
  }
}

/** The step a device's frame at `index` came in, by the counts at each step's end. */
function stepOf(twin: RTwin, label: string, index: number): number {
  return twin.stepEnds.findIndex((ends) => (ends.get(label) ?? 0) > index);
}

/**
 * P1's and the display's frames in both twins, device by device, every
 * reader's answer, and the rows the steps stored. A difference names the
 * step whose frames first differ.
 */
async function compare(seed: number, plan: Shared[][], pair: readonly [RTwin, RTwin], counts: Counts): Promise<void> {
  const [a, b] = pair.map((twin) => twin.frames());
  assert.deepEqual([...a!.keys()], [...b!.keys()], `seed ${seed}: the same devices`);
  for (const [label, frames] of a!) {
    const other = b!.get(label)!;
    const i = frames.findIndex((f, k) => f !== other[k]);
    const first = i >= 0 ? i : frames.length !== other.length ? Math.min(frames.length, other.length) : -1;
    if (first >= 0) {
      const step = stepOf(pair[0], label, first);
      assert.deepEqual(frames.slice(first, first + 4), other.slice(first, first + 4), `seed ${seed}, ${label}, frame ${first}, step ${step} (${plan[step]?.map((e) => e.k).join(", ")}): P1's and the display's frames`);
    }
    counts.frames += frames.length;
  }
  const answers = await Promise.all(pair.map((twin) => Promise.all(twin.reads.map((r) => r.answer))));
  for (const [i, answer] of answers[0]!.entries()) {
    assert.notEqual(answer, "busy", `seed ${seed}, step ${pair[0].reads[i]!.step}: the reader was answered`);
    assert.equal(answer, answers[1]![i], `seed ${seed}, step ${pair[0].reads[i]!.step}: the reader's answer`);
  }
  // QI6 and QI8: the steps before a walk stored rows only where every player saw that moment, so both twins stored the
  // same explore and map rows.
  assert.deepEqual(pair[0].stepRows, pair[1].stepRows, `seed ${seed}: the rows the steps stored`);
}

/** The queue's rules, as one twin's devices and rows show them (QI1 to QI12). */
function invariants(seed: number, twin: RTwin, counts: Counts): void {
  const where = `seed ${seed}, ${twin.name}`;
  const devices = [...twin.devices, twin.dm, twin.p2];
  for (const d of devices) {
    let lastSeq = 0;
    let lastTick = 0;
    for (const [k, m] of d.sent.entries()) {
      const f = m as { t: string; seq?: number };
      if ((f.t === "ev" || f.t === "snapshot" || f.t === "history") && typeof f.seq === "number") {
        // QI2 and QI3: no socket's number falls, and batches publish in tick order.
        assert.ok(f.seq >= lastSeq, `${where}: ${d.label}'s ${f.t} ${f.seq - T0} after ${lastSeq - T0}`);
        lastSeq = f.seq;
        // QI5: every number a frame carries is at or below the frame's.
        if (f.t !== "history") for (const g of numbersIn([f])) assert.ok(g.n <= f.seq, `${where}: ${d.label} got ${g.text} past its frame's ${f.seq - T0}`);
      }
      if (f.t !== "ev") continue;
      const ev = m as Event;
      const answered = [...(ev.acks ?? []), ...(ev.rejects ?? []).map((r) => r.n)].filter((n) => !d.resent.has(n) && d.sentAt.has(n));
      if (answered.length === 0) continue;
      // QI1: a batch answers one tick's commands, each tick's after the one before.
      const ticks = new Set(answered.map((n) => tickOf(d.sentAt.get(n)!)));
      assert.equal(ticks.size, 1, `${where}: ${d.label}'s frame at ${d.times[k]} answers ops of the ticks ${[...ticks].join(", ")}`);
      const tick = [...ticks][0]!;
      assert.ok(tick >= lastTick, `${where}: ${d.label}'s ops of the tick ${tick} answered after the tick ${lastTick}'s`);
      lastTick = tick;
      // QI2: the frame's number is at least its tick.
      assert.ok(ev.seq - T0 >= tick, `${where}: ${d.label}'s frame of the tick ${tick} carries ${ev.seq - T0}`);
    }
  }
  // QI7: P1's ops were answered `busy` exactly where its buckets, read at each op's arrival, were empty.
  const busy = new Set<string>();
  for (const d of twin.devices) for (const m of d.sent) if (m.t === "retry" && (m as { code: string }).code === "busy") busy.add(`${d.label} ${(m as { n: number }).n}`);
  assert.deepEqual([...busy].sort(), [...twin.busyByModel].sort(), `${where}: P1's busy answers follow its buckets at each op's arrival`);
  // QI8: no walk reduced again without its steps showed players anything.
  assert.ok(!twin.warnings.includes("walk result moved by its steps"), `${where}: a walk without its steps moved what players see`);
  // QI9: no command of a tick later than a deletion step's own was answered before the step ran.
  for (const run of twin.stepRuns) {
    for (const d of devices) {
      for (const [k, m] of d.sent.entries()) {
        if (m.t !== "ev" || d.times[k]! >= run.ran) continue;
        for (const n of (m as Event).acks ?? []) {
          const sent = d.sentAt.get(n);
          if (sent === undefined || d.resent.has(n) || sent < run.arrived) continue;
          assert.ok(tickOf(sent) <= tickOf(run.arrived), `${where}: ${d.label}'s op of the tick ${tickOf(sent)} answered before the step of the tick ${tickOf(run.arrived)} ran`);
        }
      }
    }
  }
  // QI4: a build at every mark while the room is loaded, one mark's period apart (a late timer may build late), and a
  // snapshot row written only as a mark builds.
  assert.ok(twin.builds.length >= 2, `${where}: ${twin.builds.length} builds`);
  for (let k = 1; k < twin.builds.length; k++) {
    const gap = twin.builds[k]! - twin.builds[k - 1]!;
    assert.ok(gap >= MARK_MS - 50 && gap <= MARK_MS + 50, `${where}: builds at ${twin.builds[k - 1]} and ${twin.builds[k]}`);
  }
  for (const at of twin.writes) assert.ok(twin.builds.includes(at), `${where}: a snapshot row written at ${at}, at no mark`);
  if (twin.name === "door") {
    for (let k = 1; k < twin.builds.length; k++) {
      const [from, to] = [twin.builds[k - 1]!, twin.builds[k]!];
      const inside = (times: number[]) => times.some((x) => x > from && x <= to);
      if (inside(twin.ownTimes) && !inside(twin.sharedTimes)) counts.marksOwnOnly++;
    }
  }
  // QI10: readers stayed within their bound.
  assert.ok(twin.maxWaiting <= MAX_WAITING_READERS, `${where}: ${twin.maxWaiting} readers waited`);
  // QI11: each of P1's walks that was taken is stored once.
  const walks = twin.db.rows.filter((r) => r.actorMemberId === "p1" && (r.op as { t: string }).t === "token.move").length;
  let acked = 0;
  for (const d of twin.devices.filter((x) => x.label.startsWith("p1#"))) for (const m of d.sent) if (m.t === "ev") for (const n of (m as Event).acks ?? []) if (!d.resent.has(n)) acked++;
  assert.ok(walks <= acked, `${where}: ${walks} walks stored for ${acked} ops acknowledged`);
  // QI12: no receipt row was written twice.
  for (const [key, ats] of twin.receiptRows) assert.equal(ats.length, 1, `${where}: the receipt ${key} written ${ats.length} times`);
  counts.bigTicks += twin.commitRows.filter((n) => n > 50).length;
  counts.unreadLines += twin.unread.size;
}

/** Two public areas in room R that remind on entering, where the twins' own creatures walk in, during Bree's turn. */
function withAreas(s: RoomState): void {
  for (const [i, id] of AREAS.entries()) s.templates[id] = template(id, { origin: { x: 7.5 + i, y: 3.5, z: 0 }, size: 5, ownerId: "dm1", triggers: ["enter"] });
  s.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [{ id: "e1", tokenId: "b", value: 10, tieOrder: 0 }] } as unknown as RoomState["encounter"];
}

describe("the random twin test of the room's queue", () => {
  test("twins whose copies for P1 and the display match give those devices the same frames and readers the same answers, whatever else each room does", async (t) => {
    const counts: Counts = { frames: 0, ownOps: 0, bigTicks: 0, slowCommits: 0, walksInSight: 0, refusedInSight: 0, unchangedInSight: 0, roundTrips: 0, unreadLines: 0, asksReading: 0, emptiedAcrossHolds: 0, assetChecksAfterQueued: 0, resendsAcrossHeld: 0, stepsUnderTraffic: 0, lateDelayed: 0, previewsPastAge: 0, idsAsks: 0, lateReaders: 0, lookupsAcrossLost: 0, marksOwnOnly: 0, backpressure: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const fixture = privTwins(seed);
      withAreas(fixture.door);
      withAreas(fixture.rock);
      const plan = schedule(rng(seed), STEPS);
      const pair = [new RTwin(t, "door", fixture, {}), new RTwin(t, "rock", fixture, {})] as const;
      await runTwin(t, pair[0], plan, rng(seed * 7 + 1), counts);
      await runTwin(t, pair[1], plan, rng(seed * 7 + 2), counts);
      for (const twin of pair) invariants(seed, twin, counts);
      await compare(seed, plan, pair, counts);
      for (const twin of pair) await twin.actor.shutdown({ code: 1012, snapshot: false });
    }
    if (SEEDS < 16 || STEPS < 80) return;
    // Floors, so the runs test what they say they test.
    const floors: Array<[keyof Counts, number]> = [
      ["bigTicks", 200],
      ["slowCommits", 100],
      ["walksInSight", 50],
      ["refusedInSight", 50],
      ["unchangedInSight", 50],
      ["roundTrips", 20],
      ["unreadLines", 50],
      ["asksReading", 40],
      ["emptiedAcrossHolds", 100],
      ["assetChecksAfterQueued", 40],
      ["resendsAcrossHeld", 50],
      ["stepsUnderTraffic", 20],
      ["lateDelayed", 20],
      ["previewsPastAge", 50],
      ["idsAsks", 40],
      ["lateReaders", 40],
      ["lookupsAcrossLost", 20],
      ["marksOwnOnly", 4],
      ["backpressure", 4],
      ["frames", 2_000],
    ];
    for (const [k, n] of floors) assert.ok(counts[k] >= n, `${k}: ${counts[k]} of at least ${n} (${JSON.stringify(counts)})`);
  });
});
