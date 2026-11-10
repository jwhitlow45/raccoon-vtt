import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { Member, RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { COUNT_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { FAMILIAR, FrameReader, IMAGE, IN_Q, numbersIn, seqTwins, T0, TRACK_END, type SeqTwinOptions } from "#shared/seqTestutil.ts";
import { trap } from "#shared/testutil.ts";
import { forgetRememberedStamps } from "../assets/cleanup.ts";
import { stateThrough } from "../http/receipts.ts";
import { RoomActor, type ActorDeps, type ActorOptions } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import type { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { SizeGuard } from "./sizeGuard.ts";
import { UndoStacks } from "./undo.ts";
import { scopeObserver, ScopeClient, StoredRoomDb, until } from "./undoScopeTesting.ts";

/**
 * Twin rooms give their devices the same frames (docs/design, the room
 * count): the secret door twins on Explore per player
 * (shared/seqTestutil.ts seqTwins), where P2 walks in room Q, which is
 * painted in one twin and rock in the other, so the server's own explore
 * and map steps run differently in each. Both twins take the same members'
 * ops, and P1's every frame and the table display's, compared whole, are
 * the same in both: numbers, acks, refusals, history and revs. Each case
 * also checks the twins' stored bookkeeping did differ, so it compares
 * something. Steps move both twins' clocks alike, and nothing else does.
 */

type Who = "dm" | "p1" | "p2";
type Event = Extract<ServerMessage, { t: "ev" }>;
type Watched = { label: string; sent: unknown[] };

const DISPLAY = "display:abcdefghijkl";
/** Every die lands on its middle, the same in both twins. */
const draw = (sides: number) => Math.ceil(sides / 2);

/** The ops the server stores on its own, which the twins hold differently. */
const BOOKKEEPING = new Set(["sys.explore", "sys.remember", "sys.sound"]);

/**
 * One twin room: the real actor and fan-out on a stored room
 * (undoScopeTesting.ts StoredRoomDb), which restarts from what it stored,
 * its clock, and the sockets whose frames are compared: P1's, each page
 * and each restart of it in turn, and the table display's.
 */
class Twin {
  readonly name: string;
  readonly db: StoredRoomDb;
  readonly clock = { now: T0 };
  readonly watched: Watched[] = [];
  actor!: RoomActor;
  clients!: Record<Who, ScopeClient>;
  display!: { conn: Connection; sent: unknown[] };
  readonly #t: TestContext;
  readonly #options: Partial<ActorOptions>;
  #pages = 0;

  constructor(t: TestContext, name: string, state: RoomState, options: Partial<ActorOptions>, version?: number) {
    this.#t = t;
    this.name = name;
    this.db = new StoredRoomDb(state, version === undefined ? {} : { version });
    this.#options = options;
  }

  /** `version` is the stored snapshot's format, one from before the room count for a room this build has not saved yet. */
  static async open(t: TestContext, name: string, state: RoomState, options: Partial<ActorOptions> = {}, version?: number): Promise<Twin> {
    const twin = new Twin(t, name, state, options, version);
    await twin.load();
    return twin;
  }

  member(who: Who): Member {
    return this.actor.committed.state.members[who === "dm" ? "dm1" : who]!;
  }

  /** Loads the room from its rows and opens the DM's, P1's, P2's and the display's sockets. */
  async load(): Promise<void> {
    const info: ActorDeps["info"] = { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false };
    const actor = await RoomActor.load({
      pool: this.db.pool(),
      info,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      budget: new SnapshotBudget(),
      gateway: {} as RoomGateway,
      options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, draw, now: () => this.clock.now, ...this.#options },
    });
    assert.ok(actor);
    this.actor = actor;
    this.#t.after(async () => {
      this.db.beforeCommit = undefined;
      await actor.shutdown({ code: 1012, snapshot: false });
    });
    const open = (who: Who) => ScopeClient.open(actor, this.member(who), who === "dm" ? "dm" : "player");
    this.clients = { dm: await open("dm"), p1: await open("p1"), p2: await open("p2") };
    this.watched.push({ label: `p1#${++this.#pages}`, sent: this.clients.p1.sent });
    this.display = await scopeObserver(actor, { memberId: DISPLAY, role: "player", display: true });
    this.watched.push({ label: `display#${this.#pages}`, sent: this.display.sent });
  }

  /** The room stops, as a deploy (with its snapshot) or a crash after its last commit, and loads again from what it stored. */
  async restart(snapshot: boolean): Promise<void> {
    this.clock.now += 1_000;
    this.db.beforeCommit = undefined;
    await this.actor.shutdown({ code: 1012, snapshot });
    await this.load();
    await this.settle();
  }

  /** Moves the clock, sends the op and waits for its answer and anything the room does after it. */
  async send(who: Who, op: Op): Promise<Event> {
    this.clock.now += 1_000;
    const client = this.clients[who];
    const event = await client.send(op);
    await this.settle();
    return event;
  }

  async apply(who: Who, op: Op): Promise<Event> {
    const event = await this.send(who, op);
    assert.equal(event.rejects?.find((r) => r.n === this.clients[who].n), undefined, `${this.name}: ${who}'s ${op.t} taken`);
    return event;
  }

  /** P1's page reloads: a new socket and snapshot, compared from its first frame. */
  async reloadP1(): Promise<void> {
    this.clock.now += 1_000;
    this.actor.detach(this.clients.p1.conn);
    this.clients.p1 = await ScopeClient.open(this.actor, this.member("p1"), "player");
    this.watched.push({ label: `p1#${++this.#pages}`, sent: this.clients.p1.sent });
    await this.settle();
  }

  /** Waits until the queue is empty and nothing more is stored for a moment: a commit's bookkeeping and the music's tick land first. */
  async settle(): Promise<void> {
    let stored = -1;
    while (stored !== this.db.stored.length || this.actor.queueLength > 0) {
      stored = this.db.stored.length;
      await delay(15);
    }
  }

  /** The frames of every socket compared, in the order they opened, each as one line read by one reader. */
  frames(): string[] {
    const reader = new FrameReader();
    return this.watched.flatMap((w) => w.sent.map((f) => `${w.label} ${reader.text(f)}`));
  }

  /** The room numbers P1's sockets got, in order. */
  p1Numbers(): string[] {
    return numbersIn(this.watched.filter((w) => w.label.startsWith("p1")).flatMap((w) => w.sent)).map((g) => g.text);
  }

  /** The bookkeeping rows this twin stored, by type. */
  bookkeeping(): string[] {
    return this.db.stored.filter((op) => BOOKKEEPING.has(op.t)).map((op) => op.t);
  }
}

type Pair = [Twin, Twin];

/**
 * The twins, opened, with P1's first chat taken in both, whose batch
 * explores the sight the fixture shows. The cold cases open without it.
 */
async function twins(t: TestContext, opts: SeqTwinOptions = {}, options: Partial<ActorOptions> = {}, edit?: (state: RoomState) => void): Promise<Pair> {
  const w = seqTwins(opts);
  if (edit) for (const s of [w.door, w.rock]) edit(s);
  const pair: Pair = [await Twin.open(t, "door", w.door, options), await Twin.open(t, "rock", w.rock, options)];
  await both(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "ready" }));
  return pair;
}

/** Runs a step in each twin in turn, the door's first. */
async function both(pair: Pair, step: (twin: Twin) => Promise<unknown>): Promise<void> {
  for (const twin of pair) await step(twin);
}

/** P1's frames and the display's are the same in both twins, whole. */
function same(pair: Pair, what: string): void {
  assert.deepEqual(pair[0].frames(), pair[1].frames(), `${what}: P1 and the display get the same frames in both twins`);
}

/** The twins' own work did differ, so the comparison has something to tell apart. */
function bookkeepingDiffers(pair: Pair, what: string): void {
  assert.notDeepEqual(pair[0].bookkeeping(), pair[1].bookkeeping(), `${what}: the twins' bookkeeping differs`);
}

const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });

/** C1's steps: the DM puts Bree in room Q, P2 walks her about inside it, out of P1's sight, and P1 chats. */
const C1: Array<[Who, Op]> = [
  ["dm", move("b", IN_Q.x, IN_Q.y)],
  ["p2", move("b", 23, 6)],
  ["p2", move("b", 24, 8)],
  ["p2", move("b", 20, 4)],
  ["p1", { t: "log.chat", text: "hi" }],
];

async function c1(pair: Pair): Promise<void> {
  await both(pair, async (twin) => {
    for (const [who, op] of C1) await twin.apply(who, op);
  });
}

/** P1 sends its last op again, as a device that never saw its answer does, and gets the answer again. */
async function resendP1(twin: Twin, op: Op): Promise<void> {
  const p1 = twin.clients.p1;
  const before = p1.sent.length;
  await twin.actor.op(p1.conn, p1.n, op);
  await until(() => p1.sent.slice(before).find((m) => m.t === "ev" && m.acks?.includes(p1.n)), "the resend's ev");
  await twin.settle();
}

describe("twin rooms give their devices the same frames", () => {
  test("C1: P2 walks in room Q, painted or rock, and P1 chats", async (t) => {
    const pair = await twins(t);
    await c1(pair);
    bookkeepingDiffers(pair, "C1");
    same(pair, "C1");
    const chat = pair.map((twin) => twin.p1Numbers().filter((n) => n.startsWith("id ")).at(-1));
    assert.equal(chat[0], chat[1], "the chat line's id");
    assert.ok(chat[0], "P1 got the chat line");
  });

  test("C2: after C1, P1's page reloads and gets the same snapshot and history", async (t) => {
    const pair = await twins(t);
    await c1(pair);
    await both(pair, (twin) => twin.reloadP1());
    same(pair, "C2");
    for (const twin of pair) assert.ok(twin.clients.p1.sent.some((m) => m.t === "history"), `${twin.name}: the reloaded page got its history`);
  });

  test("C3: after C1, P1 resends an op already answered and gets the same resend frame", async (t) => {
    const pair = await twins(t);
    await c1(pair);
    await both(pair, (twin) => resendP1(twin, { t: "log.chat", text: "hi" }));
    same(pair, "C3");
  });

  test("C4: after C1, P1's tagged roll takes the same receipt number, and its state is there for the receipt", async (t) => {
    const pair = await twins(t);
    await c1(pair);
    const tag = uuidv7();
    await both(pair, (twin) => twin.apply("p1", { t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op));
    same(pair, "C4");
    const seqs = pair.map((twin) => [...twin.db.receipts.values()].filter((r) => r.tag === tag).map((r) => r.seq));
    assert.deepEqual(seqs[0], seqs[1], "the receipt's number");
    assert.equal(seqs[0]!.length, 1);
    for (const twin of pair) {
      const seq = seqs[0]![0]!;
      assert.ok(numbersIn(twin.clients.p1.sent).some((g) => g.what === "id" && g.n === seq), `${twin.name}: the receipt's number is the roll line's`);
      const state = await stateThrough(twin.actor, seq, AbortSignal.timeout(1_000));
      assert.equal(state, twin.actor.committed.state, `${twin.name}: the receipt's state is there at once`);
    }
  });

  test("C6: after C1, initiative and Next to P1, and P1 moves: the same turn numbers", async (t) => {
    // Hurt, so her turn's start writes her turn record.
    const pair = await twins(t, {}, {}, (s) => {
      const actor = s.tokens.a!.actor;
      if (actor && "inline" in actor) actor.inline.hp = { ...actor.inline.hp, cur: actor.inline.hp.max - 5 };
    });
    await c1(pair);
    await both(pair, async (twin) => {
      await twin.apply("dm", { t: "encounter.start", entries: [{ id: "eb", tokenId: "b", value: 20 }, { id: "ea", tokenId: "a", value: 10 }] } as Op);
      // Bree's turn first, then Ayla's.
      await twin.apply("dm", { t: "encounter.next" } as Op);
      await twin.apply("dm", { t: "encounter.next" } as Op);
      await twin.apply("p1", move("a", 5, 5));
      await twin.apply("p1", move("a", 6, 5));
    });
    bookkeepingDiffers(pair, "C6");
    same(pair, "C6");
    const numbers = pair[0].p1Numbers();
    assert.ok(numbers.some((n) => n.startsWith("turnStart.seq ")), "P1 got the turn's start");
    assert.ok(numbers.some((n) => n.startsWith("path.turn ")), "P1 got its path's turn");
    assert.ok(numbers.some((n) => n.startsWith("turnRecord.id ")), "P1 got its creature's turn record");
  });

  test("C7: after C1, a trap P1 sees springs, with the same line ids", async (t) => {
    const plate = trap("plate", { name: "Plate", zone: { cells: [{ x: 3, y: 8, w: 1, h: 1 }] }, rig: { ...trap("plate").rig!, message: "Click." } });
    const pair = await twins(t, {}, {}, (s) => (s.traps = { plate }));
    await c1(pair);
    await both(pair, async (twin) => {
      await twin.send("p1", move("a", 3, 8));
    });
    bookkeepingDiffers(pair, "C7");
    same(pair, "C7");
    assert.ok(pair[0].clients.p1.sent.some((m) => m.t === "ev" && m.changes.some((c) => c.key.startsWith("trapSeen:"))), "P1 saw the trap's line");
  });

  test("C8: a DM's build edit on ground only P2's layer remembers, or that none holds, gives P1 the same frames", async (t) => {
    const pair = await twins(t);
    await c1(pair);
    const stored = pair.map((twin) => twin.bookkeeping().filter((o) => o === "sys.remember").length);
    await both(pair, (twin) => twin.apply("dm", { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["23,6", "24,6"] }));
    await both(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "after" }));
    const steps = pair.map((twin, i) => twin.bookkeeping().filter((o) => o === "sys.remember").length - stored[i]!);
    assert.notEqual(steps[0], steps[1], "the edit's map step ran in one twin only");
    same(pair, "C8");
  });

  test("C9: deleting an image a stamp in P2's memory shows, or that nothing shows, gives P1 the same frames", async (t) => {
    const pair = await twins(t, { stamp: true });
    await both(pair, async (twin) => {
      twin.clock.now += 1_000;
      for (const op of forgetRememberedStamps(twin.actor.committed.state, new Set([IMAGE]))) await twin.actor.sys(op);
      await twin.settle();
      await twin.apply("p1", { t: "log.chat", text: "after" });
    });
    bookkeepingDiffers(pair, "C9");
    same(pair, "C9");
  });

  test("C10: with Only DM devices on, the music's tick past a track's end in one twin, silence in the other, gives P1 the same frames", async (t) => {
    const pair = await twins(t, { music: true }, { roomSound: true });
    await both(pair, async (twin) => {
      await tick(twin, TRACK_END + 1_000);
      await twin.apply("p1", { t: "log.chat", text: "after" });
    });
    assert.ok(!pair[1].bookkeeping().includes("sys.sound"), "no tick where nothing plays");
    assert.ok(pair[0].bookkeeping().includes("sys.sound"), "the tick ran where the music plays");
    same(pair, "C10");
  });

  test("C11: P2's op on a token P1 never sees, taken in one twin and refused in the other, reads alike at once, across a restart and after", async (t) => {
    const refusedAlike: Op = { t: "token.update", tokenId: "a", patch: { name: "Mine" } };
    for (const variant of ["taken or refused", "refused alike, with a tick in one twin"] as const) {
      const pair = await twins(t, { familiar: true, music: true }, { roomSound: true });
      const op = variant === "taken or refused" ? renameFamiliar : refusedAlike;
      await both(pair, (twin) => twin.send("p2", op));
      const refusals = pair.map((twin) => twin.clients.p2.sent.filter((m) => m.t === "ev" && (m.rejects?.length ?? 0) > 0).length);
      assert.deepEqual(refusals, variant === "taken or refused" ? [0, 1] : [1, 1], `${variant}: the answers`);
      // At once, before any op of P1's moves the room on: a resend and a page reload read the count.
      await both(pair, async (twin) => {
        await resendP1(twin, { t: "log.chat", text: "ready" });
        await twin.reloadP1();
      });
      same(pair, `${variant}, before the restart`);
      if (variant !== "taken or refused") {
        await both(pair, (twin) => tick(twin, TRACK_END + 1_000));
        bookkeepingDiffers(pair, variant);
      }
      await both(pair, (twin) => twin.restart(false));
      same(pair, `${variant}, after the restart`);
      await both(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "after" }));
      same(pair, `${variant}, after P1's chat`);
    }
  });

  test("a room loaded with sight it never explored explores it at its first answer, alike whether P2's op on a token P1 never sees is taken or refused, and never at a tick before it", async (t) => {
    const explores = (twin: Twin) => twin.db.stored.filter((op) => op.t === "sys.explore").length;
    for (const variant of ["taken or refused", "a tick in one twin first"] as const) {
      const familiar = variant === "taken or refused";
      const w = seqTwins(familiar ? { familiar: true } : { music: true });
      const options: Partial<ActorOptions> = familiar ? {} : { roomSound: true };
      const pair: Pair = [await Twin.open(t, "door", w.door, options), await Twin.open(t, "rock", w.rock, options)];
      if (familiar) {
        await both(pair, (twin) => twin.send("p2", renameFamiliar));
        const refusals = pair.map((twin) => twin.clients.p2.sent.filter((m) => m.t === "ev" && (m.rejects?.length ?? 0) > 0).length);
        assert.deepEqual(refusals, [0, 1], `${variant}: the answers`);
      } else {
        await both(pair, (twin) => tick(twin, TRACK_END + 1_000));
        assert.ok(pair[0].bookkeeping().includes("sys.sound") && !pair[1].bookkeeping().includes("sys.sound"), `${variant}: a tick in the door twin alone`);
        assert.deepEqual(pair.map(explores), [0, 0], `${variant}: the tick explored nothing`);
        same(pair, `${variant}, after the tick`);
        await both(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "after" }));
      }
      for (const twin of pair) assert.ok(explores(twin) > 0, `${variant}: ${twin.name}: the first answer explored the loaded sight`);
      for (const twin of pair) assert.ok(twin.clients.p1.sent.some((m) => m.t === "ev" && m.changes.length > 0), `${variant}: ${twin.name}: P1 got the explored ground`);
      same(pair, variant);
    }
  });

  test("C15: C1 with a restart after each step, each writing its snapshot after the twins' own work differed, or replaying every row, gives the same frames and C1's numbers", async (t) => {
    const plain = await twins(t);
    await c1(plain);
    for (const snapshot of [true, false]) {
      const what = `C15, ${snapshot ? "with snapshots" : "replaying the rows"}`;
      const pair = await twins(t);
      for (const [who, op] of C1) {
        await both(pair, async (twin) => {
          await twin.apply(who, op);
          await twin.restart(snapshot);
        });
      }
      bookkeepingDiffers(pair, what);
      same(pair, what);
      for (const [i, twin] of pair.entries()) {
        assert.equal(twin.actor.committed.pub, plain[i]!.actor.committed.pub, `${what}: ${twin.name}: the count is C1's without restarts`);
        if (snapshot) assert.ok(twin.db.snapshotWrites > 0 && twin.db.rows.every((r) => r.seq > twin.db.snapshot.seq), `${what}: ${twin.name}: the snapshots pruned the rows they cover`);
        else assert.ok(twin.db.snapshotWrites === 0 && twin.db.rows.length > C1.length, `${what}: ${twin.name}: every restart replayed the rows`);
      }
      const ids = (twin: Twin) => twin.actor.committed.state.log.map((line) => line.id);
      for (const [i, twin] of pair.entries()) assert.deepEqual(ids(twin), ids(plain[i]!), `${what}: ${twin.name}: the log's ids are C1's without restarts`);
    }
  });

  test("C19: after C1, P1's move undone and redone gives the same labels, history and numbers", async (t) => {
    const pair = await twins(t);
    await c1(pair);
    await both(pair, async (twin) => {
      await twin.apply("p1", move("a", 5, 6));
      await twin.apply("p1", { t: "undo", head: twin.clients.p1.head("play", "undo").id } as Op);
      await twin.apply("p1", { t: "redo", head: twin.clients.p1.head("play", "redo").id } as Op);
    });
    same(pair, "C19");
    const restored = pair.map((twin) => twin.clients.p1.sent.flatMap((m) => (m.t === "ev" ? (m.restored ?? []).map((r) => r.what) : [])));
    assert.equal(restored[0]!.length, 2, "the undo and the redo were each named");
  });

  test("C20: two DM sockets get the same numbers, and a DM's View as of P1 the same frames in both twins", async (t) => {
    const pair = await twins(t);
    const extra = new Map<Twin, Array<{ sent: unknown[] }>>();
    for (const twin of pair) {
      const dms = [await scopeObserver(twin.actor, { memberId: "dm1", role: "dm" }), await scopeObserver(twin.actor, { memberId: "dm1", role: "dm" })];
      extra.set(twin, dms);
      const preview = await scopeObserver(twin.actor, { memberId: "dm1", role: "dm", previewOf: "p1" });
      twin.watched.push({ label: "preview", sent: preview.sent });
    }
    await c1(pair);
    bookkeepingDiffers(pair, "C20");
    same(pair, "C20");
    for (const twin of pair) {
      const [a, b] = extra.get(twin)!.map((d) => numbersIn(d.sent).map((g) => g.text));
      assert.deepEqual(a, b, `${twin.name}: both DM sockets got the same numbers`);
    }
  });

  test("C26: twins that differ only in an asset the sweep deletes give P1 the same frames after it", async (t) => {
    const asset = uuidv7();
    const pair: Pair = [await Twin.open(t, "door", seqTwins().rock), await Twin.open(t, "rock", seqTwins().rock)];
    await both(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "ready" }));
    await both(pair, async (twin) => {
      twin.clock.now += 1_000;
      const deleted = twin.name === "door" ? [asset] : [];
      await twin.actor.deletionStep(async () => ({ deleted, result: null }));
      await twin.apply("p1", { t: "log.chat", text: "after" });
    });
    same(pair, "C26");
  });
});

/** P1's line drawn in room R. */
const SKETCH = "0199f0a0-0000-7000-8000-00000000d1d1";
const sketch: Op = { t: "drawing.create", drawing: { id: SKETCH, sceneId: "s1", kind: "line", points: [3, 3, 5, 5], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op;

describe("an op that faults before its install or after it", () => {
  const fault = new Error("a fault the test throws");
  for (const when of ["before", "after"] as const) {
    for (const barrier of [false, true]) {
      test(`C23: a fault ${when} the install, ${barrier ? "after" : "before"} the room's first save at today's format, across a restart`, async (t) => {
        const w = seqTwins();
        const pair: Pair = [await Twin.open(t, "door", w.door, {}, COUNT_SNAPSHOT_VERSION - 1), await Twin.open(t, "rock", w.rock, {}, COUNT_SNAPSHOT_VERSION - 1)];
        if (barrier) {
          await both(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "ready" }));
          for (const twin of pair) assert.equal(twin.db.snapshot.version, COUNT_SNAPSHOT_VERSION, `${twin.name}: the first commit saved the room at today's format`);
        }
        await both(pair, async (twin) => {
          for (const [who, op] of C1.slice(0, 4)) await twin.apply(who, op);
        });
        bookkeepingDiffers(pair, `C23 ${when}`);
        // Before the install the size guard throws, after it the history's push, which runs once the op is staged. The op is
        // P1's drawing, which moves no one's sight, so only its own keys can carry it to another member's device.
        const mocked = when === "before" ? t.mock.method(SizeGuard.prototype, "check") : t.mock.method(UndoStacks.prototype, "push");
        const dmFrom = pair.map((twin) => twin.clients.dm.sent.length);
        const before = pair.map((twin) => ({ pub: twin.actor.committed.pub, seq: twin.actor.committed.seq }));
        await both(pair, async (twin) => {
          mocked.mock.mockImplementationOnce(() => {
            throw fault;
          });
          twin.clock.now += 1_000;
          const p1 = twin.clients.p1;
          void twin.actor.op(p1.conn, ++p1.n, sketch);
          await twin.settle();
        });
        mocked.mock.restore();
        const drawn = (m: unknown) => (m as Event).t === "ev" && (m as Event).changes.some((c) => c.key === `drawing:${SKETCH}` && "value" in c);
        for (const [i, twin] of pair.entries()) {
          const { state, pub, seq } = twin.actor.committed;
          const rows = twin.db.rows.map((r) => r.seq);
          assert.deepEqual(rows, rows.map((_, k) => rows[0]! + k), `${twin.name}: no gap in the stored rows`);
          const stored = twin.db.rows.filter((r) => (r.op as { t: string }).t === "drawing.create");
          if (when === "before") {
            assert.equal(state.drawings[SKETCH], undefined, `${twin.name}: nothing of the op`);
            assert.equal(stored.length, 0, `${twin.name}: no row`);
            assert.equal(seq, before[i]!.seq, `${twin.name}: seq did not move`);
            assert.equal(pub, before[i]!.pub + 1, `${twin.name}: the refusal moved the count once`);
            assert.ok(twin.clients.p1.sent.some((m) => m.t === "ev" && m.rejects?.some((r) => r.n === twin.clients.p1.n)), `${twin.name}: P1 was told`);
          } else {
            assert.ok(state.drawings[SKETCH], `${twin.name}: the whole op`);
            assert.equal(stored.length, 1, `${twin.name}: its row once`);
            assert.ok(stored[0]!.pub === pub && pub === before[i]!.pub + 1, `${twin.name}: the op took the count's next number`);
            assert.ok(twin.clients.dm.sent.slice(dmFrom[i]).some(drawn), `${twin.name}: the DM's device got the drawing at once`);
          }
        }
        same(pair, `C23 ${when}, at once`);
        await both(pair, (twin) => twin.restart(false));
        for (const twin of pair) {
          assert.equal(twin.actor.committed.state.drawings[SKETCH] !== undefined, when === "after", `${twin.name}: the restart keeps what the fault left`);
          const snapshot = twin.clients.dm.sent.find((m) => m.t === "snapshot");
          const held = (snapshot?.state as { drawings?: Record<string, unknown> } | undefined)?.drawings?.[SKETCH];
          assert.equal(held !== undefined, when === "after", `${twin.name}: the DM's snapshot after the restart`);
          assert.equal(twin.db.snapshot.version, COUNT_SNAPSHOT_VERSION, `${twin.name}: saved at today's format`);
        }
        await both(pair, (twin) => twin.apply("p1", { t: "log.chat", text: "after" }));
        for (const twin of pair) {
          const ids = twin.actor.committed.state.log.map((line) => line.id);
          const last = ids.at(-1)!;
          assert.equal(new Set(ids).size, ids.length, `${twin.name}: every line id once`);
          assert.ok(ids.slice(0, -1).every((id) => Number(id.split(":")[0]) < Number(last.split(":")[0])), `${twin.name}: the next op's id is above every earlier one`);
          assert.equal(Number(last.split(":")[0]), twin.actor.committed.pub, `${twin.name}: and is the count's`);
        }
        same(pair, `C23 ${when}, after the restart`);
      });
    }
  }
});

/** P1's acknowledgments, as the evs grouped them. */
function ackGroups(twin: Twin): number[][] {
  return twin.watched.filter((w) => w.label.startsWith("p1")).flatMap((w) => w.sent.flatMap((m) => ((m as Event).t === "ev" && (m as Event).acks ? [(m as Event).acks!] : [])));
}

/** Holds the room's next commit at its COMMIT until released. `entered` resolves once it waits there. */
function holdCommit(twin: Twin): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let enter!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (enter = resolve));
  twin.db.beforeCommit = async () => {
    twin.db.beforeCommit = undefined;
    enter();
    await held;
  };
  return { entered, release };
}

/**
 * A burst: the DM's op commits and is held there, `meanwhile` runs, and
 * the members' ops queue behind the held commit in order, as a burst that
 * arrives while one is in flight does. On release the actor's own rules,
 * its cap and a walk's end of the batch, split them into batches.
 */
async function burst(twin: Twin, ops: Array<[Who, Op]>, meanwhile?: (twin: Twin) => Promise<void>): Promise<void> {
  twin.clock.now += 1_000;
  const hold = holdCommit(twin);
  const first = twin.clients.dm.send({ t: "log.chat", text: "held" });
  await hold.entered;
  await meanwhile?.(twin);
  const answers = ops.map(([who, op]) => twin.clients[who].send(op));
  hold.release();
  await first;
  await Promise.all(answers);
  await twin.settle();
}

/** With the clock past the door twin's track end, a tick queued behind the held commit there, and nothing in the twin of rock. */
async function queuedTick(twin: Twin): Promise<void> {
  twin.clock.now = Math.max(twin.clock.now, TRACK_END + 1_000);
  const queued = twin.actor.queueLength;
  // Attaching a socket again places the tick's timer afresh, which finds it due.
  twin.actor.attach(twin.display.conn);
  if (twin.name === "door") await until(() => (twin.actor.queueLength > queued ? true : undefined), "the queued tick");
  else await delay(15);
}

/** The cleanup's remember of IMAGE queued behind the held commit, where a stamp in P2's memory shows it. */
async function queuedRemember(twin: Twin): Promise<void> {
  for (const op of forgetRememberedStamps(twin.actor.committed.state, new Set([IMAGE]))) void twin.actor.sys(op);
}

const renameFamiliar: Op = { t: "token.update", tokenId: FAMILIAR, patch: { name: "Hoot" } };

describe("batches split by answers, whatever the room does on its own", () => {
  test("C24: a burst behind a held commit, P2's op on a token P1 never sees taken in one twin and refused in the other, splits alike at a cap of 3", async (t) => {
    for (const tick of [false, true]) {
      const pair = await twins(t, { familiar: true, music: true }, { maxBatchOps: 3, roomSound: true });
      const ops: Array<[Who, Op]> = [
        ["p1", { t: "log.chat", text: "one" }],
        ["p2", renameFamiliar],
        ["p1", { t: "log.chat", text: "two" }],
        ["p1", { t: "log.chat", text: "three" }],
      ];
      await both(pair, (twin) => burst(twin, ops, tick ? queuedTick : undefined));
      const answers = pair.map((twin) => twin.clients.p2.sent.flatMap((m) => ((m as Event).t === "ev" ? ((m as Event).rejects ?? []).map((r) => r.code) : [])));
      assert.deepEqual(answers.map((a) => a.length), [0, 1], "taken in the door twin, refused in the twin of rock");
      if (tick) assert.ok(pair[0].bookkeeping().includes("sys.sound") && !pair[1].bookkeeping().includes("sys.sound"), "a tick in the door twin alone");
      const groups = pair.map(ackGroups);
      assert.deepEqual(groups[0], groups[1], `tick ${tick}: P1's acks come in the same groups`);
      assert.deepEqual(groups[0]!.slice(-2), [[2, 3], [4]], `tick ${tick}: the cap closes the batch at its third answer`);
      same(pair, `C24, tick ${tick}`);
    }
  });

  test("C25: P1's walk after a lone tick, a lone cleanup remember, or P2's op taken or refused lands alike", async (t) => {
    const walk: [Who, Op] = ["p1", move("a", 5, 7)];
    // P1's own refusal first: an answer the batch holds without a row, which the walk's end of the batch must count.
    const refusedFirst: [Who, Op] = ["p1", { t: "token.update", tokenId: "b", patch: { name: "Mine" } }];
    const cases: Array<{ what: string; opts: SeqTwinOptions; meanwhile?: (twin: Twin) => Promise<void>; ops: Array<[Who, Op]> }> = [
      { what: "a lone tick", opts: { music: true }, meanwhile: queuedTick, ops: [walk] },
      { what: "a lone cleanup remember", opts: { stamp: true }, meanwhile: queuedRemember, ops: [walk] },
      { what: "P2's op taken or refused", opts: { familiar: true }, ops: [["p2", renameFamiliar], walk] },
      { what: "a tick, after P1's refusal", opts: { music: true }, meanwhile: queuedTick, ops: [refusedFirst, walk] },
      { what: "a cleanup remember, after P1's refusal", opts: { stamp: true }, meanwhile: queuedRemember, ops: [refusedFirst, walk] },
      { what: "P2's op taken or refused, after P1's refusal", opts: { familiar: true }, ops: [refusedFirst, ["p2", renameFamiliar], walk] },
    ];
    for (const { what, opts, meanwhile, ops } of cases) {
      const pair = await twins(t, opts, { roomSound: true });
      const rows = pair.map((twin) => twin.db.stored.length);
      await both(pair, (twin) => burst(twin, ops, meanwhile));
      assert.notEqual(pair[0].db.stored.length - rows[0]!, pair[1].db.stored.length - rows[1]!, `${what}: the twins stored different rows`);
      for (const twin of pair) assert.deepEqual([twin.actor.committed.state.tokens.a!.x, twin.actor.committed.state.tokens.a!.y], [5, 7], `${what}: ${twin.name}: the walk landed`);
      assert.deepEqual(ackGroups(pair[0]), ackGroups(pair[1]), `${what}: P1's acks come in the same groups`);
      same(pair, `C25, ${what}`);
    }
  });

  test("C28: a tick at 0 ms and P1's chats at 15 and 25 ms commit together at 35 ms, as with no tick", async (t) => {
    const pair = await twins(t, { music: true }, { roomSound: true, batchMs: 20 });
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    for (const twin of pair) {
      twin.clock.now = TRACK_END + 1_000;
      const p1 = twin.clients.p1;
      const from = p1.sent.length;
      const acked = () => p1.sent.slice(from).filter((m): m is Event => m.t === "ev" && (m.acks?.length ?? 0) > 0);
      const chat = (text: string) => void twin.actor.op(p1.conn, ++p1.n, { t: "log.chat", text });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        // Attaching a socket again places the tick's timer afresh: it is due now, at 0 ms.
        twin.actor.attach(twin.display.conn);
        t.mock.timers.tick(0);
        await flush();
        const ticked = twin.actor.queueLength;
        t.mock.timers.tick(15);
        twin.clock.now += 15;
        chat("at 15");
        await flush();
        t.mock.timers.tick(10);
        twin.clock.now += 10;
        chat("at 25");
        await flush();
        t.mock.timers.tick(9);
        await flush();
        assert.deepEqual(acked(), [], `${twin.name}: nothing committed by 34 ms (${ticked} queued)`);
        t.mock.timers.tick(1);
        await flush();
        assert.deepEqual(acked().map((m) => m.acks), [[p1.n - 1, p1.n]], `${twin.name}: both chats in one batch at 35 ms`);
      } finally {
        t.mock.timers.reset();
      }
      await twin.settle();
    }
    assert.ok(pair[0].bookkeeping().includes("sys.sound") && !pair[1].bookkeeping().includes("sys.sound"), "a tick in the door twin alone");
    same(pair, "C28");
  });
});

/** Moves the clock to `at` and lets the music's tick due by then run: a socket's coming places its timer afresh. */
async function tick(twin: Twin, at: number): Promise<void> {
  twin.clock.now = at;
  const stored = twin.db.stored.length;
  const observer = await scopeObserver(twin.actor, { memberId: "dm1", role: "dm" });
  if (twin.name === "door") await until(() => (twin.db.stored.length > stored ? true : undefined), "the tick");
  twin.actor.detach(observer.conn);
  await twin.settle();
}
