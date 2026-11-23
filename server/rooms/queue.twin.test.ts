import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry, Member, RoomState, Token } from "#shared/model.ts";
import { projectLogEntry } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { hiddenIn, hookPool, IN_R, IN_SIDE, privTwins, revsIn, skewOf, skewTimers, type Hidden, type PoolHooks, type PrivTwins, type TwinName } from "#shared/privTestutil.ts";
import { FrameReader, T0, TRACK_END } from "#shared/seqTestutil.ts";
import { token } from "#shared/testutil.ts";
import { playerView } from "../http/playerView.ts";
import { RoomActor, ViewBusyError, type ActorDeps, type ActorOptions } from "./actor.ts";
import { SnapshotBudget, type SnapshotBudgetLimits } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { StoredRoomDb } from "./undoScopeTesting.ts";

/**
 * Twin rooms that differ only in what P1 and the table display never see
 * (shared/privTestutil.ts privTwins), on the stepped real clock: each
 * twin's clock and its mocked timers move together a millisecond at a
 * time on the 20 ms grid, and the room's numbers follow that clock as
 * production's do. In the first twin (A, the door twin) the DM works on
 * what players never see, or the room's own work runs longer: a commit
 * held, a deletion step, an ask read, a timer run late. The second (B)
 * takes only the shared steps, at the same clock times. Every frame P1's
 * sockets and the display got is scanned raw for the ids and names only
 * its own twin holds, then compared whole, history ids mapped, apart from
 * `clock` frames, which carry the time they were sent. Where a case says
 * so, numbers are compared by their order alone, since a run of answers
 * in one millisecond moves them.
 */

type Who = "dm" | "p1" | "p2";
type Wire = ServerMessage | { t: string };
type Event = Extract<ServerMessage, { t: "ev" }>;
/** A socket the test drives by hand: its frames, with the clock time past BASE each came at. */
type Device = { conn: Connection; sent: Wire[]; times: number[]; n: number; label: string; clientId: string };
/** What a reader that arrived at a moment answers from, as P1 reads it. */
type Read = { tick: number; through: string; log: string[]; view: string } | "busy";

/** Where each timed script starts by default, on a tick's edge, ms past T0. */
const BASE = 20_000;
const BATCH_MS = 20;
const draw = (sides: number) => Math.ceil(sides / 2);
const DISPLAY = "display:abcdefghijkl";
const P1: { memberId: string; role: "player" } = { memberId: "p1", role: "player" };
const chat = (text: string): Op => ({ t: "log.chat", text });
const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });
const hp = (tokenId: string, kind: "damage" | "heal", amount: number): Op => ({ t: "actor.hp", target: { tokenId }, change: { kind, amount } }) as Op;
/** The label P1 remembers in the side room, which the DM renames behind the fog. */
const ALTAR = "0199f0a0-0000-7000-8000-0000000000f1";
/** A creature every player sees when in sight, in the side room. */
const RAT = "0199f0a0-0000-7000-8000-0000000000e1";

/** Lets the in-memory database's promises and the actor's turns run, with the timers held. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Waits `ms` on the timers as they stand, mocked in a timed script. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

class Twin {
  readonly name: TwinName;
  readonly db: StoredRoomDb;
  readonly pool: ReturnType<StoredRoomDb["pool"]>;
  readonly hooks: PoolHooks;
  readonly clock = { now: T0 };
  readonly unseen: Hidden;
  readonly budget: SnapshotBudget;
  /** P1's sockets and the display's, whose frames are compared. */
  readonly devices: Device[] = [];
  readonly warnings: string[] = [];
  /** How many frames each device held when the timed script began (timed). */
  readonly marks = new Map<Device, number>();
  creatures: string[] = [];
  actor!: RoomActor;
  dm!: Device;
  p1!: Device;
  p2!: Device;
  display!: Device;
  readonly #t: TestContext;
  readonly #options: Partial<ActorOptions>;
  #pages = 1;

  constructor(t: TestContext, name: TwinName, state: RoomState, unseen: Hidden, options: Partial<ActorOptions>, budget: Partial<SnapshotBudgetLimits>) {
    this.#t = t;
    this.name = name;
    this.db = new StoredRoomDb(state);
    this.pool = this.db.pool();
    this.hooks = hookPool(this.pool);
    this.unseen = { ids: [...unseen.ids], names: [...unseen.names] };
    this.#options = options;
    this.budget = new SnapshotBudget(budget, () => this.clock.now);
  }

  /** Whether this is the twin where the room does more than P1 sees. */
  get a(): boolean {
    return this.name === "door";
  }

  member(who: Who): Member {
    return this.actor.committed.state.members[who === "dm" ? "dm1" : who]!;
  }

  async load(): Promise<void> {
    const warnings = this.warnings;
    const actor = await RoomActor.load({
      pool: this.pool,
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log: { info() {}, warn: (_o: unknown, msg?: string) => void warnings.push(msg ?? ""), error: (o: unknown, msg?: string) => void warnings.push(`error ${msg ?? ""} ${String((o as { err?: Error }).err?.stack ?? "").slice(0, 600)}`), debug() {} },
      budget: this.budget,
      gateway: {} as RoomGateway,
      // The production batch and number clock: the room's numbers follow the twin's clock. The id gate is off, since the
      // fixtures' ids are not dated by that clock (createIds.ts).
      options: { batchMs: BATCH_MS, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 3_600_000, grantRecheckMs: 3_600_000, snapshotOps: 1_000_000, draw, now: () => this.clock.now, idGate: false, ...this.#options },
    } satisfies ActorDeps);
    assert.ok(actor);
    this.actor = actor;
    this.#t.after(async () => {
      this.hooks.restore();
      await actor.shutdown({ code: 1012, snapshot: false });
    });
    this.dm = await this.open("dm", "dm");
    this.p1 = await this.open("p1", "p1#1");
    this.p2 = await this.open("p2", "p2");
    this.display = await this.open(null, "display#1");
  }

  /** A device's socket on the twin's clock, its hello sent and its snapshot waited for in real time, outside a timed script. */
  async open(who: Who | null, label: string): Promise<Device> {
    const device = this.attach(who, label);
    this.hello(device);
    for (let i = 0; i < 500 && !device.sent.some((m) => m.t === "snapshot"); i++) await delay(2);
    assert.ok(device.sent.some((m) => m.t === "snapshot"), `${this.name}: ${label}'s snapshot`);
    return device;
  }

  /**
   * A device's socket on the twin's clock, attached, with no hello yet.
   * `null` is the table display. P1's and the display's are compared.
   */
  attach(who: Who | null, label: string, previewOf?: string): Device {
    const sent: Wire[] = [];
    const times: number[] = [];
    const clock = this.clock;
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => void (sent.push(JSON.parse(text) as Wire), times.push(clock.now - T0 - BASE)), close() {}, terminate() {} };
    const grant = who === null ? { memberId: DISPLAY, role: "player" as const, display: true } : { memberId: this.member(who).id, role: who === "dm" ? ("dm" as const) : ("player" as const), ...(previewOf ? { previewOf } : {}) };
    const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", ...grant }, "203.0.113.9", { now: () => this.clock.now });
    this.actor.attach(conn);
    const device: Device = { conn, sent, times, n: 0, label, clientId: uuidv7() };
    if ((who === "p1" && previewOf === undefined) || who === null) this.devices.push(device);
    return device;
  }

  hello(device: Device): void {
    void this.actor.hello(device.conn, { clientId: device.clientId, resumeFrom: device.n + 1 });
  }

  /** P1's page reloads: the old socket goes and a new one says hello, unanswered yet. */
  reloadP1(): Device {
    this.actor.detach(this.p1.conn);
    const next = this.attach("p1", `p1#${++this.#pages}`);
    next.n = this.p1.n;
    next.clientId = this.p1.clientId;
    this.p1 = next;
    this.hello(next);
    return next;
  }

  /** Sends an op from a device, unanswered yet. */
  send(device: Device, op: Op | Record<string, unknown>, group?: string): number {
    const n = ++device.n;
    void this.actor.op(device.conn, n, op, group);
    return n;
  }

  /** The DM's work on a creature only the DM sees: an answer P1 never sees, its new name kept for the raw scan. */
  unseenAnswer(i: number): void {
    const name = `Shade ${this.name} ${i}`;
    this.unseen.names.push(name);
    this.send(this.dm, { t: "token.update", tokenId: this.creatures[i % this.creatures.length]!, patch: { name } });
  }

  /** A deletion step that holds the queue `ms` on the timers as they stand, deleting nothing. */
  hold(ms: number): Promise<unknown> {
    return this.actor.deletionStep(async () => {
      await wait(ms);
      return { deleted: [], result: null };
    });
  }

  from(device: Device): number {
    return this.marks.get(device) ?? 0;
  }

  /** What a reader arriving now answers from, as P1 would read it: started now, settled later. */
  read(): Promise<Read> {
    const arrived = this.clock.now;
    return this.actor.asOf(arrived).then(
      (view) => {
        const log = view.state.log.flatMap((l: LogEntry) => {
          const shown = projectLogEntry(view.state, l, P1, { sceneId: null });
          return shown ? [JSON.stringify(shown)] : [];
        });
        return { tick: view.tick - T0 - BASE, through: String(view.through), log, view: JSON.stringify(playerView(view.state, "s1")) };
      },
      (err: unknown) => {
        if (err instanceof ViewBusyError) return "busy" as const;
        throw err;
      },
    );
  }

  /** Until nothing is queued and nothing more is stored for longer than a batch's tick, on the real timers. */
  async settle(): Promise<void> {
    let stored = -1;
    let quiet = 0;
    while (quiet < 10) {
      const now = this.db.stored.length + this.hooks.statements.length;
      quiet = now === stored && this.actor.queueLength === 0 ? quiet + 1 : 0;
      stored = now;
      await delay(5);
    }
  }

  /** P1's and the display's frames, `clock` frames apart, each as one line, after the raw scan for the ids and names this twin alone holds. */
  frames(): string[] {
    const raw = this.devices.flatMap((d) => d.sent);
    assert.deepEqual(hiddenIn(raw, this.unseen), [], `${this.name}: no frame names what P1 and the display never see`);
    assert.deepEqual(revsIn(raw), [], `${this.name}: every rev P1 and the display hold is 0`);
    const reader = new FrameReader();
    return this.devices.flatMap((d) => d.sent.filter((m) => m.t !== "clock").map((m) => `${d.label} ${reader.text(m)}`));
  }

  /** How many rows of the steps (explore and map) the twin stored. */
  steps(): number {
    return this.db.stored.filter((op) => op.t === "sys.remember" || op.t === "sys.explore").length;
  }
}

type Pair = [Twin, Twin] & { fixture: PrivTwins };

type OpenOptions = {
  seed?: number;
  options?: Partial<ActorOptions>;
  budget?: Partial<SnapshotBudgetLimits>;
  music?: boolean;
  edit?: (state: RoomState, name: TwinName, fixture: PrivTwins) => void;
};

/** The twins, loaded, each with P1's first chat at 1 s, which explores what the fixture shows. */
async function open(t: TestContext, o: OpenOptions = {}): Promise<Pair> {
  const fixture = privTwins(o.seed ?? 1, { music: o.music === true });
  for (const name of ["door", "rock"] as const) o.edit?.(fixture[name], name, fixture);
  const make = (name: TwinName) => new Twin(t, name, fixture[name], fixture.hidden[name], o.options ?? {}, o.budget ?? {});
  const pair = [make("door"), make("rock")] as unknown as Pair;
  pair.fixture = fixture;
  for (const twin of pair) {
    twin.creatures = fixture.creatures[twin.name];
    await twin.load();
    twin.clock.now = T0 + 1_000;
    twin.send(twin.p1, chat("ready"));
    await twin.settle();
  }
  return pair;
}

/** Runs `step` in each twin in turn on the real timers, the twin's clock set to `ms` past T0 first. */
async function both(pair: Pair, ms: number, step: (twin: Twin) => unknown): Promise<void> {
  for (const twin of pair) {
    assert.ok(T0 + ms >= twin.clock.now, `${twin.name}: the clock never goes back`);
    twin.clock.now = T0 + ms;
    await step(twin);
    await twin.settle();
  }
}

type At = (ms: number) => Promise<void>;

/**
 * Runs `script` in each twin in turn with setTimeout mocked, from `base`
 * ms past T0, a tick's edge. `at(ms)` moves the twin's clock and its timers
 * together, a millisecond at a time, to `ms` past `base`, letting the room
 * work at each. `still(ms)` moves them with nothing but the timers'
 * callbacks and their promises let run, as an event loop held by long work
 * does: a turn the room left for later waits.
 */
async function timed(t: TestContext, pair: Pair, script: (twin: Twin, at: At, still: At) => Promise<void>, base = BASE): Promise<void> {
  for (const twin of pair) {
    assert.ok(T0 + base >= twin.clock.now, `${twin.name}: the clock never goes back`);
    twin.clock.now = T0 + base;
    await twin.settle();
    for (const d of [twin.dm, twin.p2, ...twin.devices]) twin.marks.set(d, d.sent.length);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const to = async (ms: number, letRun: boolean) => {
        assert.ok(T0 + base + ms >= twin.clock.now, `${twin.name}: the clock never goes back`);
        if (letRun) await flush();
        while (twin.clock.now < T0 + base + ms) {
          twin.clock.now += 1;
          t.mock.timers.tick(1);
          if (letRun) await flush();
          else for (let i = 0; i < 20; i++) await Promise.resolve();
        }
      };
      await script(
        twin,
        (ms) => to(ms, true),
        (ms) => to(ms, false),
      );
    } finally {
      t.mock.timers.reset();
    }
    twin.hooks.commitLength(0);
    await twin.settle();
  }
}

/** P1's and the display's frames are the same in both twins: whole, or with numbers compared by order alone. */
function same(pair: Pair, what: string, numbers: "whole" | "apart" = "whole"): void {
  const frames = pair.map((twin) => (numbers === "whole" ? twin.frames() : unnumbered(twin.frames())));
  assert.deepEqual(frames[0], frames[1], `${what}: P1 and the display get the same frames in both twins`);
}

/** The ack groups P1's frames since the timed script began carry. */
function ackGroups(twin: Twin): number[][] {
  return evs(twin, twin.p1).flatMap((e) => (e.acks.length > 0 ? [e.acks] : []));
}

/** A device's `ev` frames since the timed script began: when each came past BASE, its number past T0 + BASE, and its acks. */
function evs(twin: Twin, device: Device): Array<{ at: number; seq: number; acks: number[] }> {
  const out: Array<{ at: number; seq: number; acks: number[] }> = [];
  for (let i = twin.from(device); i < device.sent.length; i++) {
    const m = device.sent[i] as Event;
    if (m.t === "ev") out.push({ at: device.times[i]!, seq: m.seq - T0 - BASE, acks: m.acks ?? [] });
  }
  return out;
}

/** The numbers of P1's frames since the timed script began that acknowledge an op, past T0 + BASE. */
const ackedAt = (twin: Twin) => evs(twin, twin.p1).filter((e) => e.acks.length > 0).map((e) => e.seq);

/**
 * The lines with every room number, and every line time, which follows
 * its number, written as `#`, so two twins compare in all else.
 */
function unnumbered(lines: readonly string[]): string[] {
  return lines.map((line) =>
    line
      .replace(/("(?:seq|startSeq|pub|through)":)\d{10,}/g, "$1#")
      .replace(/("|log:|trapLog:|trapSeen:)\d{10,}(:\d+)/g, "$1#$2")
      .replace(/("at":)"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, "$1#"),
  );
}

/** The DM's ops after a case are taken as sent in each twin, and the DM's numbers never fall. */
async function dmAfter(pair: Pair, ms: number): Promise<void> {
  await both(pair, ms, async (twin) => {
    const from = twin.dm.sent.length;
    const n = twin.send(twin.dm, move("b", 7, 8));
    await twin.settle();
    const answer = twin.dm.sent.slice(from).find((m) => m.t === "ev" && ((m as Event).acks?.includes(n) ?? false));
    assert.ok(answer, `${twin.name}: the DM's move is taken`);
    const seqs = twin.dm.sent.filter((m) => m.t === "ev").map((m) => (m as Event).seq);
    assert.ok(seqs.every((s, i) => i === 0 || s >= seqs[i - 1]!), `${twin.name}: the DM's numbers never fall`);
  });
}

/** P1's ruler from the side room's creature, as P1's device sends it now. */
function ruler(twin: Twin): void {
  twin.actor.ephemeral(twin.p1.conn, { sceneId: "s1", e: { k: "ruler", id: "0199f0a0-0000-7000-8000-0000000000c1", points: [{ x: 7.5, y: 12.5, tokenId: RAT }, { x: 5.5, y: 12.5 }] } as never }, twin.clock.now);
}

/**
 * The side room's creature, which players see when the party has it in
 * sight, with party sight on the scene, so the display sees what P1 sees.
 */
function withRat(s: RoomState, at: Partial<Token> = {}): void {
  s.tokens[RAT] = token(RAT, { name: "Rat", x: 7, y: 12, ...at });
  const scene = s.scenes.s1!;
  const { perPlayer: _perPlayer, ...vision } = scene.vision!;
  s.scenes.s1 = { ...scene, vision };
}

describe("a tick's commands form one batch, whatever the room does that P1 never sees", () => {
  test("P1's 49 chats in one tick, with one of the DM's answers P1 never sees 3 ms before them in A, are acknowledged in one frame at the tick, and no reader mid-tick sees them", async (t) => {
    const pair = await open(t);
    const reads: Array<Array<Promise<Read>>> = [[], []];
    await timed(t, pair, async (twin, at) => {
      await at(2);
      if (twin.a) twin.unseenAnswer(0);
      await at(5);
      for (let i = 0; i < 49; i++) twin.send(twin.p1, chat(`at 5, ${i}`));
      await at(10);
      reads[pair.indexOf(twin)]!.push(twin.read());
      await at(19);
      reads[pair.indexOf(twin)]!.push(twin.read());
      await at(45);
    });
    for (const twin of pair) {
      const acked = evs(twin, twin.p1).filter((e) => e.acks.length > 0);
      assert.deepEqual(acked.map((e) => [e.at, e.acks.length]), [[20, 49]], `${twin.name}: one frame at the tick acknowledges all 49`);
    }
    const read = await Promise.all(reads.map((r) => Promise.all(r)));
    assert.deepEqual(read[0], read[1], "a reader mid-tick answers alike");
    for (const r of read[0]!) assert.ok(r !== "busy" && !r.log.some((l) => l.includes("at 5,")), `no reader mid-tick sees a chat of the tick: ${JSON.stringify(r).slice(0, 200)}`);
    same(pair, "chats in one tick");
    await dmAfter(pair, BASE + 1_000);
  });

  /** The five readers the old cap moved: what P1 sends at 5 ms, and how P1 or the display reads it at 8 ms. */
  const readers: Array<{ what: string; op: () => Op; by?: "dm"; read: (twin: Twin, n: number) => Promise<Read> | null }> = [
    { what: "ack groups", op: () => chat("at 5"), read: () => null },
    { what: "a log page", op: () => chat("at 5"), read: (twin) => twin.read() },
    { what: "a receipt", op: () => ({ t: "dice.roll", tag: "0199f0a0-0000-7000-8000-00000000d1ce", to: "all", rolls: [{ formula: "1d20" }] }) as Op, read: (twin) => twin.read() },
    {
      what: "a resend",
      op: () => chat("at 5"),
      read: (twin, n) => {
        void twin.actor.op(twin.p1.conn, n, chat("at 5"));
        return null;
      },
    },
    {
      // The DM shows a creature in P1's sight, and P1 measures from it.
      what: "a ruler",
      op: () => ({ t: "token.update", tokenId: RAT, patch: { visibility: "all" } }),
      by: "dm",
      read: (twin) => {
        ruler(twin);
        return null;
      },
    },
  ];

  for (const { what, op, by, read } of readers) {
    test(`49 answers P1 never sees at 1 ms in A, then P1's op at 5 ms and ${what} at 8 ms, read alike in both`, async (t) => {
      const pair = await open(t, { edit: (s) => withRat(s, { x: 5, y: 5, visibility: "dm" }) });
      const reads: Array<Promise<Read> | null> = [null, null];
      await timed(t, pair, async (twin, at) => {
        await at(1);
        if (twin.a) for (let i = 0; i < 49; i++) twin.unseenAnswer(i);
        await at(5);
        const n = twin.send(by === "dm" ? twin.dm : twin.p1, op());
        await at(8);
        reads[pair.indexOf(twin)] = read(twin, n);
        await at(45);
      });
      assert.deepEqual(ackGroups(pair[0]), ackGroups(pair[1]), "P1's ack groups");
      if (by === undefined) for (const twin of pair) assert.deepEqual(evs(twin, twin.p1).filter((e) => e.acks.length > 0).map((e) => e.at), [20], `${twin.name}: P1's op is acknowledged at the tick`);
      if (reads[0] !== null) {
        const [a, b] = await Promise.all(reads);
        assert.deepEqual(unnumbered([JSON.stringify(a)]), unnumbered([JSON.stringify(b)]), `${what}: the reader answers alike`);
      }
      same(pair, what, "apart");
    });
  }

  test("60 of the DM's answers P1 never sees in P1's tick in A leave P1's frames alike", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(1);
      if (twin.a) for (let i = 0; i < 60; i++) twin.unseenAnswer(i);
      await at(65);
      twin.send(twin.p1, chat("at 65"));
      await at(100);
    });
    for (const twin of pair) assert.deepEqual(evs(twin, twin.p1).filter((e) => e.acks.length > 0).map((e) => e.at), [80], `${twin.name}: P1's chat is acknowledged at its tick`);
    same(pair, "reload", "apart");
  });

  test("the batch timer fires 3 ms late in A, and P1's frame carries the tick in both", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      const skew = twin.a ? skewTimers(skewOf(3, (ms) => ms <= BATCH_MS, 1)) : null;
      try {
        await at(5);
        twin.send(twin.p1, chat("at 5"));
        await at(40);
      } finally {
        skew?.restore();
      }
      if (twin.a) assert.equal(skew?.skewed, 1, "one timer ran late");
    });
    for (const twin of pair) assert.deepEqual(ackedAt(twin), [20], `${twin.name}: the frame's number is its tick`);
    same(pair, "early timer");
  });

  test("the commit before takes 30 ms in A and 2 ms in B, and P1's ops at 5 and 25 ms get the same frames, ack groups and numbers", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      twin.hooks.commitLength(twin.a ? 30 : 2);
      await at(5);
      twin.send(twin.p1, chat("at 5"));
      await at(25);
      twin.send(twin.p1, chat("at 25"));
      await at(120);
    });
    for (const twin of pair) {
      assert.deepEqual(ackGroups(twin), [[2], [3]], `${twin.name}: one ack frame a tick`);
      assert.deepEqual(ackedAt(twin), [20, 40], `${twin.name}: each frame carries its tick`);
    }
    same(pair, "resend");
  });

  test("a deletion step holds the queue 50 ms in A, and P1's ops at 5, 25 and 45 ms form three batches at their ticks in both", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(1);
      const step = twin.a ? twin.hold(50) : null;
      await at(5);
      twin.send(twin.p1, chat("at 5"));
      await at(25);
      twin.send(twin.p1, chat("at 25"));
      await at(45);
      twin.send(twin.p1, chat("at 45"));
      await at(140);
      await step;
    });
    for (const twin of pair) {
      assert.deepEqual(ackGroups(twin), [[2], [3], [4]], `${twin.name}: three batches`);
      assert.deepEqual(ackedAt(twin), [20, 40, 60], `${twin.name}: each at its tick`);
    }
    same(pair, "ruler");
  });

  test("a DM ask reads from 2 to 45 ms in A, and P1's ops at 5 and 25 ms join the batches of 20 and 40 ms in both", async (t) => {
    const pair = await open(t);
    const ops = [0, 1, 2].map((x) => ({ t: "build.paint", sceneId: "s1", terrain: "wood", cells: [`${30 + x},12`] }));
    await timed(t, pair, async (twin, at, still) => {
      await at(2);
      if (twin.a) twin.send(twin.dm, { t: "build.ask", sceneId: "s1", ops, part: 0 }, uuidv7());
      // The ask reads in turns of its own: with the loop held, it reads on until 45 ms.
      const go = twin.a ? still : at;
      await go(5);
      twin.send(twin.p1, chat("at 5"));
      await go(25);
      twin.send(twin.p1, chat("at 25"));
      await go(45);
      await at(120);
    });
    for (const twin of pair) {
      assert.deepEqual(ackGroups(twin), [[2], [3]], `${twin.name}: P1's ops in two batches`);
      assert.deepEqual(ackedAt(twin), [20, 40], `${twin.name}: at 20 and 40 ms`);
    }
    same(pair, "DM ask");
  });

  test("the music's tick queued at 3 ms behind a 40 ms hold in A, and P1's op at 10 ms, give P1 the same batch in both", async (t) => {
    const base = TRACK_END - T0 + 1_000;
    const pair = await open(t, { music: true, options: { roomSound: true } });
    await timed(
      t,
      pair,
      async (twin, at) => {
        await at(1);
        const step = twin.a ? twin.hold(40) : null;
        await at(3);
        // A socket's coming places the music's timer afresh, which finds the track over: the tick, where music plays.
        twin.actor.attach(twin.p2.conn);
        await at(10);
        twin.send(twin.p1, chat("at 10"));
        await at(100);
        await step;
      },
      base,
    );
    assert.ok(pair[0].db.stored.some((op) => op.t === "sys.sound") && !pair[1].db.stored.some((op) => op.t === "sys.sound"), "the tick ran in A alone");
    for (const twin of pair) assert.deepEqual(ackedAt(twin).map((seq) => seq + BASE - base), [20], `${twin.name}: P1's op in the batch of 20 ms`);
    same(pair, "music");
  });

  test("P1's snapshot due at 30 ms fires 10 ms late in A, behind a hold with P1's ops at 40 and 60 ms queued, and joins the batch of 40 ms in both", async (t) => {
    const pair = await open(t, { budget: { ipCount: 6, windowMs: 70 } });
    // Six snapshots on P1's address 40 ms before, so a hello at 5 ms waits 25 ms.
    await both(pair, BASE - 40, async (twin) => {
      for (let i = 0; i < 6; i++) twin.actor.detach((await twin.open("dm", "dm-extra")).conn);
    });
    await timed(t, pair, async (twin, at) => {
      const skew = twin.a ? skewTimers(skewOf(10, (ms) => ms > 0 && ms <= 10, 1)) : null;
      try {
        await at(5);
        twin.reloadP1();
        await at(21);
        const step = twin.a ? twin.hold(40) : null;
        await at(40);
        twin.send(twin.p1, chat("at 40"));
        await at(60);
        twin.send(twin.p1, chat("at 60"));
        await at(160);
        await step;
      } finally {
        skew?.restore();
      }
    });
    for (const twin of pair) {
      const p1 = twin.p1;
      const snapshot = p1.sent.find((m) => m.t === "snapshot") as { seq: number } | undefined;
      assert.ok(p1.sent.some((m) => m.t === "wait"), `${twin.name}: the reload waited`);
      assert.equal((snapshot?.seq ?? 0) - T0 - BASE, 40, `${twin.name}: the snapshot in the batch of 40 ms`);
    }
    same(pair, "socket budget");
  });
});

describe("admission reads each command's arrival", () => {
  /** P1 spends both its buckets at 1 ms: 60 chats, the burst. */
  const spend = (twin: Twin) => {
    for (let i = 0; i < 60; i++) twin.send(twin.p1, chat(`spend ${i}`));
  };
  const retries = (twin: Twin) => twin.p1.sent.slice(twin.from(twin.p1)).filter((m) => m.t === "retry").map((m) => (m as { code: string }).code);

  test("P1's buckets are empty, A holds the queue 50 ms from 21 ms, and P1's next op at 30 ms is busy in both", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(1);
      spend(twin);
      await at(21);
      const step = twin.a ? twin.hold(50) : null;
      await at(30);
      twin.send(twin.p1, chat("at 30"));
      await at(120);
      await step;
    });
    for (const twin of pair) assert.deepEqual(retries(twin), ["busy"], `${twin.name}: busy`);
    same(pair, "R1");
  });

  test("P1's bucket is empty with an op queued at 30 ms, and P1's asset op at 80 ms meets its check before A's hold ends: the same decisions in both", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(1);
      spend(twin);
      await at(21);
      const step = twin.a ? twin.hold(70) : null;
      await at(30);
      twin.send(twin.p1, chat("at 30"));
      await at(80);
      twin.send(twin.p1, { t: "token.update", tokenId: "a", patch: { name: "Ayla" }, assetId: "0199f0a0-0000-7000-8000-00000000a5a5" });
      await at(180);
      await step;
    });
    const decisions = pair.map((twin) => twin.p1.sent.slice(twin.from(twin.p1)).flatMap((m) => (m.t === "retry" ? [`retry ${(m as { n: number }).n}`] : (m as Event).t === "ev" ? [...((m as Event).acks ?? []).map((n) => `ack ${n}`), ...((m as Event).rejects ?? []).map((r) => `reject ${r.n} ${r.code}`)] : [])));
    assert.deepEqual(decisions[0], decisions[1], "P1's decisions");
    same(pair, "R2");
  });

  test("P1's reload with its snapshot budget spent, and a commit of 30 ms in A: the same waits, values included, and the snapshot in the same batch", async (t) => {
    const pair = await open(t, { budget: { ipCount: 6, windowMs: 2_545 } });
    await both(pair, BASE - 40, async (twin) => {
      for (let i = 0; i < 6; i++) twin.actor.detach((await twin.open("dm", "dm-extra")).conn);
    });
    await timed(t, pair, async (twin, at) => {
      twin.hooks.commitLength(twin.a ? 30 : 2);
      await at(5);
      twin.reloadP1();
      await at(2_600);
    });
    for (const twin of pair) {
      const waits = twin.p1.sent.filter((m) => m.t === "wait").map((m) => (m as { ms: number }).ms);
      assert.deepEqual(waits, [2_500, 500], `${twin.name}: the waits read the hello's moment`);
      assert.equal(((twin.p1.sent.find((m) => m.t === "snapshot") as { seq: number } | undefined)?.seq ?? 0) - T0 - BASE, 2_520, `${twin.name}: the snapshot in the batch after its due time`);
    }
    same(pair, "R3");
  });
});

describe("resends are judged by whether their batch has closed", () => {
  test("P1's op in the batch of 20 ms, its resend at 22 ms, that batch's commit held to 45 ms in A and landed in B: the same frames", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(5);
      const n = twin.send(twin.p1, chat("at 5"));
      await at(19);
      const held = twin.a ? twin.hooks.holdCommits() : null;
      await at(22);
      void twin.actor.op(twin.p1.conn, n, chat("at 5"));
      await at(45);
      held?.release();
      await at(120);
    });
    for (const twin of pair) {
      const p1 = twin.p1.sent.slice(twin.from(twin.p1));
      assert.equal(p1.filter((m) => m.t === "history").length, 2, `${twin.name}: the op's history, and the resend's`);
      assert.deepEqual(ackedAt(twin), [20, 40], `${twin.name}: the op at 20 ms and the resend's ack at 40 ms`);
    }
    same(pair, "P6");
  });
});

describe("readers and live frames answer as of their arrival", () => {
  test("a log page, a receipt and the player view asked at 25 and 39 ms, the commit of 20 ms landing at 50 ms in A and at once in B, read alike", async (t) => {
    const pair = await open(t);
    const reads: Array<Array<Promise<Read>>> = [[], []];
    await timed(t, pair, async (twin, at) => {
      twin.hooks.commitLength(twin.a ? 30 : 0);
      await at(5);
      twin.send(twin.p1, { t: "dice.roll", tag: "0199f0a0-0000-7000-8000-00000000d1ce", to: "all", rolls: [{ formula: "1d20" }] } as Op);
      twin.send(twin.p1, move("a", IN_SIDE.x, IN_SIDE.y));
      await at(25);
      reads[pair.indexOf(twin)]!.push(twin.read());
      await at(39);
      reads[pair.indexOf(twin)]!.push(twin.read());
      await at(120);
    });
    const read = await Promise.all(reads.map((r) => Promise.all(r)));
    assert.deepEqual(read[0], read[1], "the readers answer alike");
    for (const r of read[0]!) assert.ok(r !== "busy" && r.tick === 20 && r.log.some((l) => l.includes("dice")), `the readers answer as of 20 ms, the roll in: ${JSON.stringify(r).slice(0, 200)}`);
    same(pair, "V1");
  });

  test("P1's ruler at 25 ms on a creature P1's walk at 5 ms brought into sight, the commit of 20 ms landing at 50 ms in A: the same frames", async (t) => {
    const pair = await open(t, { edit: (s) => withRat(s) });
    await timed(t, pair, async (twin, at) => {
      twin.hooks.commitLength(twin.a ? 30 : 0);
      await at(5);
      twin.send(twin.p1, move("a", IN_SIDE.x, IN_SIDE.y));
      await at(25);
      ruler(twin);
      await at(120);
    });
    for (const twin of pair) assert.ok(twin.display.sent.slice(twin.from(twin.display)).some((m) => m.t === "eph"), `${twin.name}: the display got the ruler`);
    same(pair, "V2");
  });

  for (const path of ["lock", "hide"] as const) {
    test(`P1's drag, then the DM's ${path} of the creature 9,990 ms on, published at 9,999 ms of the drag's age in A and 10,001 ms in B: the same cancels`, async (t) => {
      const pair = await open(t);
      await timed(t, pair, async (twin, at) => {
        await at(1);
        twin.actor.ephemeral(twin.p1.conn, { sceneId: "s1", e: { k: "dragStart", tokenId: "a", x: 4.5, y: 4.5 } }, twin.clock.now);
        twin.actor.ephemeral(twin.p1.conn, { sceneId: "s1", e: { k: "dragMove", tokenId: "a", x: 5.5, y: 4.5 } }, twin.clock.now);
        twin.hooks.commitLength(twin.a ? 0 : 2);
        await at(9_991);
        twin.send(twin.dm, path === "lock" ? { t: "token.update", tokenId: "a", patch: { locked: true } } : { t: "token.update", tokenId: "a", patch: { visibility: "dm" } });
        await at(10_060);
      });
      for (const twin of pair) assert.ok(twin.display.sent.some((m) => m.t === "eph"), `${twin.name}: the display saw the drag`);
      same(pair, `V3 ${path}`);
    });
  }

  test("P1's drag frames at 20, 21 and 23 ms, the batch of 20 ms published at once in B and held to 29 ms in A: every frame in both", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(5);
      twin.send(twin.p1, chat("at 5"));
      await at(19);
      const held = twin.a ? twin.hooks.holdCommits() : null;
      await at(20);
      twin.actor.ephemeral(twin.p1.conn, { sceneId: "s1", e: { k: "dragStart", tokenId: "a", x: 4.5, y: 4.5 } }, twin.clock.now);
      await at(21);
      twin.actor.ephemeral(twin.p1.conn, { sceneId: "s1", e: { k: "dragMove", tokenId: "a", x: 5.5, y: 4.5 } }, twin.clock.now);
      await at(23);
      twin.actor.ephemeral(twin.p1.conn, { sceneId: "s1", e: { k: "dragMove", tokenId: "a", x: 6.5, y: 4.5 } }, twin.clock.now);
      await at(29);
      held?.release();
      await at(80);
    });
    for (const twin of pair) assert.equal(twin.display.sent.slice(twin.from(twin.display)).filter((m) => m.t === "eph").length, 3, `${twin.name}: every drag frame reached the display`);
    same(pair, "V7");
  });

  test("thirty DM chats at 3 ms run the numbers past the tick, so P1's frame takes the last number, and P1's op at 45 ms takes its own and its tick", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(3);
      for (let i = 0; i < 30; i++) twin.send(twin.dm, chat(`DM at 3, ${i}`));
      await at(5);
      twin.send(twin.p1, chat("at 5"));
      await at(45);
      twin.send(twin.p1, chat("at 45"));
      await at(80);
    });
    for (const twin of pair) {
      const lines = twin.actor.committed.state.log.filter((l) => l.kind === "chat" && l.from === "p1");
      const numberOf = (text: string) => Number(lines.find((l) => l.text === text)!.id.split(":")[0]) - T0 - BASE;
      assert.deepEqual([numberOf("at 5"), numberOf("at 45")], [33, 45], `${twin.name}: a number is the clock's unless the answers before it in its millisecond ran past it`);
      assert.deepEqual(ackedAt(twin), [33, 60], `${twin.name}: a frame's number is its tick unless its answers ran past it`);
    }
    same(pair, "a burst P1 sees");
  });
});

describe("the steps before a walk run only at moments every player sees", () => {
  /** P1 remembers the side room's label as "Altar", and the DM renames it "Shrine" behind the fog, in both twins. */
  async function remembered(t: TestContext): Promise<Pair> {
    const pair = await open(t, {
      edit: (s) => void (s.labels = { [ALTAR]: { x: 6.5, y: 13.5, id: ALTAR, rev: 0, size: 1, text: "Altar", sceneId: "s1" } }),
    });
    await both(pair, 2_000, (twin) => twin.send(twin.p1, move("a", IN_SIDE.x, IN_SIDE.y)));
    await both(pair, 3_000, (twin) => twin.send(twin.p1, move("a", IN_R.x, IN_R.y)));
    await both(pair, 4_000, (twin) => twin.send(twin.dm, { t: "build.label", sceneId: "s1", labelId: ALTAR, label: { x: 6.5, y: 13.5, text: "Shrine", size: 1 } }));
    return pair;
  }

  /** The label P1's reload holds, in each twin. */
  async function labelP1Holds(pair: Pair, ms: number): Promise<string[]> {
    const out: string[] = [];
    await both(pair, ms, async (twin) => {
      const reload = twin.reloadP1();
      await twin.settle();
      const snapshot = reload.sent.find((m) => m.t === "snapshot") as { state: RoomState } | undefined;
      out.push(snapshot?.state.labels[ALTAR]?.text ?? "none");
    });
    return out;
  }

  /** The label twin: P1 walks into sight of the label at 3 ms, A alone takes `own` at 6 ms, and damage drops P1's sight at 9 ms. */
  async function labelTwin(t: TestContext, own: (twin: Twin, device: Device | null) => void, prepare?: (twin: Twin) => Device): Promise<Pair> {
    const pair = await remembered(t);
    await timed(t, pair, async (twin, at) => {
      await at(3);
      twin.send(twin.p1, move("a", IN_SIDE.x, IN_SIDE.y));
      const device = prepare?.(twin) ?? null;
      await at(6);
      if (twin.a) own(twin, device);
      await at(9);
      twin.send(twin.dm, hp("a", "damage", 200));
      await at(60);
    });
    return pair;
  }

  const refused: Array<{ what: string; own: (twin: Twin, device: Device | null) => void; prepare?: (twin: Twin) => Device }> = [
    { what: "a DM-only creature's walk", own: (twin) => twin.send(twin.dm, move(twin.creatures[0]!, 7, 2)) },
    { what: "a malformed DM move naming P1's creature", own: (twin) => twin.send(twin.dm, { t: "token.move", tokenId: "a", x: "far", y: 4 }) },
    { what: "P2's move of P1's creature, which P2 may not make", own: (twin) => twin.send(twin.p2, move("a", 5, 12)) },
    {
      what: "a move from the DM's View as P1, which only reads",
      // The view opens in both twins, and only A's moves.
      prepare: (twin) => {
        const view = twin.attach("dm", "dm-view", "p1");
        twin.hello(view);
        return view;
      },
      own: (twin, view) => void twin.send(view!, move("a", 5, 12)),
    },
  ];
  for (const { what, own, prepare } of refused) {
    test(`${what} in A, between P1's sight of the label and its loss, leaves P1's label "Altar" in both and stores no step row`, async (t) => {
      const pair = await labelTwin(t, own, prepare);
      assert.deepEqual(await labelP1Holds(pair, BASE + 1_000), ["Altar", "Altar"], "P1's label");
      assert.equal(pair[0].steps(), pair[1].steps(), "no step row in A beyond B's");
      same(pair, what);
    });
  }

  test(`a heal, the DM's move of P1's creature to its own place in A alone, then damage back, leaves P1's label "Altar" in both, the move stored and no step row`, async (t) => {
    const pair = await remembered(t);
    // P1's creature stands in the side room, dying, so P1 sees nothing there.
    await both(pair, 5_000, (twin) => twin.send(twin.dm, hp("a", "damage", 200)));
    await both(pair, 6_000, (twin) => twin.send(twin.dm, move("a", IN_SIDE.x, IN_SIDE.y)));
    await timed(t, pair, async (twin, at) => {
      await at(3);
      twin.send(twin.dm, hp("a", "heal", 200));
      await at(6);
      if (twin.a) twin.send(twin.dm, move("a", IN_SIDE.x, IN_SIDE.y));
      await at(9);
      twin.send(twin.dm, hp("a", "damage", 200));
      await at(60);
    });
    assert.deepEqual(await labelP1Holds(pair, BASE + 1_000), ["Altar", "Altar"], "P1's label");
    assert.equal(pair[0].db.stored.filter((op) => op.t === "token.move").length, pair[1].db.stored.filter((op) => op.t === "token.move").length + 1, "A stored the move");
    assert.equal(pair[0].steps(), pair[1].steps(), "no step row in A beyond B's");
    same(pair, "walk across");
  });

  test(`a DM's moveMany of P1's creature at its pose beside a creature only the DM sees that moves, in A alone, leaves P1's label "Altar" in both and no step row`, async (t) => {
    const pair = await labelTwin(t, (twin) => twin.send(twin.dm, { t: "token.moveMany", moves: [{ tokenId: "a", x: IN_SIDE.x, y: IN_SIDE.y }, { tokenId: twin.creatures[0]!, x: 7, y: 2 }] }));
    assert.deepEqual(await labelP1Holds(pair, BASE + 1_000), ["Altar", "Altar"], "P1's label");
    assert.equal(pair[0].steps(), pair[1].steps(), "no step row in A beyond B's");
    same(pair, "walk away");
  });

  test("P1's walk out and back to its own place, after an answer P1 never sees in A alone, takes one number and gives the same frames in both", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(3);
      if (twin.a) twin.unseenAnswer(0);
      await at(6);
      const a = twin.actor.committed.state.tokens.a!;
      twin.send(twin.p1, { t: "token.move", tokenId: "a", x: a.x, y: a.y, route: [[a.x + 1, a.y, 0, 0], [a.x, a.y, 0, 0]] });
      await at(12);
      twin.send(twin.p1, chat("at 12"));
      await at(60);
    });
    for (const twin of pair) {
      const line = twin.actor.committed.state.log.find((l) => l.kind === "chat" && l.text === "at 12")!;
      assert.equal(Number(line.id.split(":")[0]) - T0 - BASE, 12, `${twin.name}: the walk took one number, and the chat after it the clock's`);
    }
    same(pair, "walk back");
  });

  test("a DM-only creature walks into a public area at 6 ms in A, between P1's look into the side room and back, and P1's explored ground is alike", async (t) => {
    const pair = await open(t);
    await timed(t, pair, async (twin, at) => {
      await at(3);
      twin.send(twin.p1, move("a", IN_SIDE.x, IN_SIDE.y));
      await at(6);
      if (twin.a) twin.send(twin.dm, move(twin.creatures[0]!, 5, 4));
      await at(9);
      twin.send(twin.p1, move("a", IN_R.x, IN_R.y));
      await at(60);
    });
    same(pair, "area");
  });
});
