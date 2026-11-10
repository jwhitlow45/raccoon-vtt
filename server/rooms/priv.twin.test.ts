import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import type { Member, RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { hiddenIn, IN_R, IN_SIDE, idFrom, privTwins, revsIn, StampCopy, stampAt, type Hidden, type PrivTwins, type TwinName } from "#shared/privTestutil.ts";
import { FrameReader, IMAGE, numbersIn, T0, TRACK_END, type SeqTwinOptions } from "#shared/seqTestutil.ts";
import { rng, scene, token } from "#shared/testutil.ts";
import { forgetRememberedStamps } from "../assets/cleanup.ts";
import { topZ } from "../../client/features/builder/stamps/rules.ts";
import { RoomActor, type ActorDeps, type ActorOptions } from "./actor.ts";
import { SnapshotBudget, type SnapshotBudgetLimits } from "./budgets.ts";
import type { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { scopeObserver, ScopeClient, StoredRoomDb, until } from "./undoScopeTesting.ts";

/**
 * Twin rooms whose copies for P1 and the table display match give those
 * devices the same frames, whatever else each room holds or does: the
 * room count's twins (shared/privTestutil.ts privTwins) with hidden
 * stamps, creatures and areas drawn apart, and per case work only one
 * twin takes, the DM's on what players never see. Both twins take the
 * shared steps at the same clock times, and every frame P1's sockets and
 * the display got is scanned raw for its own twin's hidden ids and names,
 * then compared whole, every rev and number included.
 */

type Who = "dm" | "p1" | "p2";
type Event = Extract<ServerMessage, { t: "ev" }>;
type Watched = { label: string; sent: unknown[] };
type Mark = Map<unknown[], number>;

const DISPLAY = "display:abcdefghijkl";
const draw = (sides: number) => Math.ceil(sides / 2);
const chat = (text: string): Op => ({ t: "log.chat", text });
const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });

class Twin {
  readonly name: TwinName;
  readonly db: StoredRoomDb;
  readonly clock = { now: T0 };
  readonly watched: Watched[] = [];
  readonly hidden: Hidden;
  readonly budget: SnapshotBudget;
  actor!: RoomActor;
  clients!: Record<Who, ScopeClient>;
  display!: { conn: Connection; sent: unknown[] };
  readonly #t: TestContext;
  readonly #options: Partial<ActorOptions>;
  #pages = 0;

  constructor(t: TestContext, name: TwinName, state: RoomState, hidden: Hidden, options: Partial<ActorOptions>, budget: Partial<SnapshotBudgetLimits>) {
    this.#t = t;
    this.name = name;
    this.db = new StoredRoomDb(state);
    this.hidden = { ids: [...hidden.ids], names: [...hidden.names] };
    this.#options = options;
    this.budget = new SnapshotBudget(budget, () => this.clock.now);
  }

  member(who: Who): Member {
    return this.actor.committed.state.members[who === "dm" ? "dm1" : who]!;
  }

  async load(): Promise<void> {
    const actor = await RoomActor.load({
      pool: this.db.pool(),
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      budget: this.budget,
      gateway: {} as RoomGateway,
      options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, snapshotOps: 1_000_000, draw, now: () => this.clock.now, ...this.#options },
    } satisfies ActorDeps);
    assert.ok(actor);
    this.actor = actor;
    this.#t.after(async () => {
      this.db.beforeCommit = undefined;
      await actor.shutdown({ code: 1012, snapshot: false });
    });
    const open = (who: Who) => ScopeClient.open(actor, this.member(who), who === "dm" ? "dm" : "player");
    this.clients = { dm: await open("dm"), p1: await open("p1"), p2: await open("p2") };
    this.watch(`p1#${++this.#pages}`, this.clients.p1.sent);
    this.display = await scopeObserver(actor, { memberId: DISPLAY, role: "player", display: true });
    this.watch(`display#${this.#pages}`, this.display.sent);
  }

  watch(label: string, sent: unknown[]): void {
    this.watched.push({ label, sent });
  }

  /** Sets the clock `ms` past T0. Shared steps happen at the same clock times in both twins. */
  to(ms: number): void {
    assert.ok(T0 + ms >= this.clock.now, `${this.name}: the clock never goes back`);
    this.clock.now = T0 + ms;
  }

  async send(who: Who, op: Op): Promise<Event> {
    const event = await this.clients[who].send(op);
    await this.settle();
    return event;
  }

  async apply(who: Who, op: Op): Promise<Event> {
    const event = await this.send(who, op);
    assert.equal(event.rejects?.find((r) => r.n === this.clients[who].n), undefined, `${this.name}: ${who}'s ${op.t} taken`);
    return event;
  }

  async reloadP1(): Promise<void> {
    this.actor.detach(this.clients.p1.conn);
    this.clients.p1 = await ScopeClient.open(this.actor, this.member("p1"), "player");
    this.watch(`p1#${++this.#pages}`, this.clients.p1.sent);
    await this.settle();
  }

  async restart(snapshot: boolean): Promise<void> {
    this.db.beforeCommit = undefined;
    await this.actor.shutdown({ code: 1012, snapshot });
    await this.load();
    await this.settle();
  }

  async settle(): Promise<void> {
    let stored = -1;
    let quiet = 0;
    while (quiet < 2) {
      const now = this.db.stored.length;
      quiet = now === stored && this.actor.queueLength === 0 ? quiet + 1 : 0;
      stored = now;
      await delay(3);
    }
  }

  /** Every frame compared, raw. */
  raw(): unknown[] {
    return this.watched.flatMap((w) => w.sent);
  }

  /** How many frames each compared socket holds now, for `frames` to read on from. */
  mark(): Mark {
    return new Map(this.watched.map((w) => [w.sent, w.sent.length]));
  }

  /**
   * The frames compared, each as one line, after the raw scan for this
   * twin's hidden ids and names. With a mark, only the frames each socket
   * got since, a socket opened since in whole.
   */
  frames(since?: Mark): string[] {
    assert.deepEqual(hiddenIn(this.raw(), this.hidden), [], `${this.name}: no frame names what P1 and the display never see`);
    const reader = new FrameReader();
    return this.watched.flatMap((w) => w.sent.map((f, i) => [i, `${w.label} ${reader.text(f)}`] as const).filter(([i]) => i >= (since?.get(w.sent) ?? 0)).map(([, line]) => line));
  }

  /** The room numbers a socket got, in order. */
  numbers(label: string): number[] {
    return numbersIn(this.watched.find((w) => w.label === label)!.sent).map((g) => g.n);
  }

  /** The newest number of the frames since `from` on the socket. */
  latest(label: string, from: number): number | undefined {
    const sent = this.watched.find((w) => w.label === label)!.sent.slice(from);
    return numbersIn(sent).filter((g) => g.what === "ev" || g.what === "snapshot" || g.what === "history").at(-1)?.n;
  }

  get p1(): Watched {
    return this.watched.filter((w) => w.label.startsWith("p1#")).at(-1)!;
  }
}

type Pair = [Twin, Twin] & { fixture: PrivTwins };

type OpenOptions = {
  seed?: number;
  seq?: SeqTwinOptions;
  options?: Partial<ActorOptions>;
  budget?: Partial<SnapshotBudgetLimits>;
  edit?: (state: RoomState, name: TwinName, fixture: PrivTwins) => void;
};

/** The twins, opened, each with P1's first chat at 1 s, which explores what the fixture shows. */
async function open(t: TestContext, o: OpenOptions = {}): Promise<Pair> {
  const fixture = privTwins(o.seed ?? 1, o.seq);
  for (const name of ["door", "rock"] as const) o.edit?.(fixture[name], name, fixture);
  const make = (name: TwinName) => new Twin(t, name, fixture[name], fixture.hidden[name], o.options ?? {}, o.budget ?? {});
  const pair = [make("door"), make("rock")] as unknown as Pair;
  pair.fixture = fixture;
  for (const twin of pair) {
    await twin.load();
    twin.to(1_000);
    await twin.apply("p1", chat("ready"));
  }
  return pair;
}

async function both(pair: Pair, step: (twin: Twin) => Promise<unknown>): Promise<void> {
  for (const twin of pair) await step(twin);
}

/** P1's and the display's frames are the same in both twins, after each twin's raw scan, with no rev but 0 and stamps drawn in rank order. */
function same(pair: Pair, what: string, since?: [Mark, Mark]): void {
  assert.deepEqual(pair[0].frames(since?.[0]), pair[1].frames(since?.[1]), `${what}: P1 and the display get the same frames in both twins`);
  for (const twin of pair) {
    assert.deepEqual(revsIn(twin.raw()), [], `${what}: ${twin.name}: every rev P1 and the display hold is 0`);
    for (const w of twin.watched) assert.deepEqual(new StampCopy().read(w.sent).notRanks(), [], `${what}: ${twin.name} ${w.label}: stamps carry their ranks`);
  }
}

/** The twins stored different rows, so the comparison has something to tell apart. */
function storedDiffers(pair: Pair, what: string): void {
  assert.notDeepEqual(pair[0].db.stored.map((op) => op.t), pair[1].db.stored.map((op) => op.t), `${what}: the twins stored different rows`);
}

/** One more hidden creature in each twin, last of the fixture's, which casts nothing. */
function extraShade(s: RoomState, name: TwinName, fixture: PrivTwins): void {
  const id = idFrom(rng(name === "door" ? 7 : 8));
  s.tokens[id] = token(id, { name: `Shade ${id.slice(-6)}`, visibility: "dm", x: 8, y: 2 });
  fixture.hidden[name].ids.push(id);
  fixture.hidden[name].names.push(`Shade ${id.slice(-6)}`);
  fixture.creatures[name].push(id);
}

/** The DM undoes their last step, in whichever history holds it. */
async function undoLast(twin: Twin): Promise<void> {
  const history = twin.clients.dm.history();
  const scope = history.setup?.undo.head ? "setup" : "play";
  await twin.apply("dm", { t: "undo", scope, head: twin.clients.dm.head(scope, "undo").id } as Op);
}

/** The DM renames a hidden creature, a name P1 must never get. */
async function hiddenRename(twin: Twin, pair: Pair, at: number): Promise<void> {
  const id = pair.fixture.creatures[twin.name][0]!;
  const name = `Shade ${twin.name} ${at}`;
  twin.hidden.names.push(name);
  twin.to(at);
  await twin.apply("dm", { t: "token.update", tokenId: id, patch: { name } });
}

describe("twin rooms give P1 and the display the same frames, hidden work apart", () => {
  test("a hidden creature worked on once or three times gives P1's chat the same frames and line id", async (t) => {
    const pair = await open(t);
    await both(pair, async (twin) => {
      for (const at of twin.name === "door" ? [2_100] : [2_100, 2_200, 2_300]) await hiddenRename(twin, pair, at);
      twin.to(3_000);
      await twin.apply("p1", chat("hi"));
    });
    storedDiffers(pair, "renames");
    same(pair, "renames");
    const ids = pair.map((twin) => twin.actor.committed.state.log.at(-1)!.id);
    assert.equal(ids[0], ids[1], "the chat line's id");
  });

  test("one or three hidden rows passed with Next give P1 the same turn start, path turn and turn record", async (t) => {
    const pair = await open(t, {
      edit: (s) => {
        // Hidden rows stay hidden on their turns.
        s.meta = { ...s.meta, settings: { ...s.meta.settings, revealHiddenOnTurn: false } };
        // Hurt, so her turn's start writes her turn record.
        const actor = s.tokens.a!.actor;
        if (actor && "inline" in actor) actor.inline.hp = { ...actor.inline.hp, cur: actor.inline.hp.max - 5 };
      },
    });
    await both(pair, async (twin) => {
      const shades = pair.fixture.creatures[twin.name];
      const hidden = twin.name === "door" ? 1 : 3;
      const rows = Array.from({ length: hidden }, (_, i) => ({ id: `eh${i}`, tokenId: shades[i % shades.length]!, value: 15 - i }));
      twin.to(2_000);
      await twin.apply("dm", { t: "encounter.start", entries: [{ id: "ea", tokenId: "a", value: 20 }, ...rows, { id: "eb", tokenId: "b", value: 5 }] } as Op);
      twin.to(2_050);
      await twin.apply("dm", { t: "encounter.next" } as Op);
      for (let i = 0; i < hidden; i++) {
        twin.to(2_100 + 100 * i);
        await twin.apply("dm", { t: "encounter.next" } as Op);
      }
      // Bree's turn, then Ayla's in the next round, and her move.
      twin.to(3_000);
      await twin.apply("dm", { t: "encounter.next" } as Op);
      twin.to(4_000);
      await twin.apply("dm", { t: "encounter.next" } as Op);
      twin.to(5_000);
      await twin.apply("p1", move("a", 5, 5));
    });
    storedDiffers(pair, "Next");
    same(pair, "Next");
    const given = numbersIn(pair[0].p1.sent).map((g) => g.what);
    for (const what of ["turnStart.seq", "path.turn", "turnRecord.id"]) assert.ok(given.some((w) => w.endsWith(what)), `P1 got a ${what}`);
  });

  /** The reads of a device that sent no op, each after hidden work in the door twin and a wait of 5 s. */
  const reads: Array<{ what: string; read: (twin: Twin) => Promise<string> }> = [
    {
      what: "a reconnect",
      read: async (twin) => {
        await twin.reloadP1();
        return twin.p1.label;
      },
    },
    {
      what: "a resend of P1's first op, and the history after it",
      read: async (twin) => {
        const p1 = twin.clients.p1;
        const before = p1.sent.length;
        await twin.actor.op(p1.conn, 1, chat("ready"));
        await until(() => p1.sent.slice(before).find((m) => m.t === "history"), "the history after the resend");
        await twin.settle();
        return twin.p1.label;
      },
    },
    {
      what: "a DM's View as P1",
      read: async (twin) => {
        const preview = await scopeObserver(twin.actor, { memberId: "dm1", role: "dm", previewOf: "p1" });
        twin.watch("preview", preview.sent);
        await twin.settle();
        return "preview";
      },
    },
    {
      what: "a display opened",
      read: async (twin) => {
        const display = await scopeObserver(twin.actor, { memberId: DISPLAY, role: "player", display: true });
        twin.watch("display-new", display.sent);
        await twin.settle();
        return "display-new";
      },
    },
    {
      what: "a restart",
      read: async (twin) => {
        await twin.restart(false);
        return twin.p1.label;
      },
    },
  ];

  for (const { what, read } of reads) {
    test(`after hidden work in one twin and a wait of 5 s, ${what} gives P1 the same numbers, each at or after the request`, async (t) => {
      const pair = await open(t);
      await both(pair, async (twin) => {
        if (twin.name === "door") for (const at of [2_100, 2_200, 2_300]) await hiddenRename(twin, pair, at);
        twin.to(7_300);
        const asked = twin.clock.now;
        const label = await read(twin);
        const n = twin.latest(label, 0);
        assert.ok(n !== undefined && n >= asked, `${twin.name}: ${what}: the number ${n} is at or after the request at ${asked}`);
      });
      storedDiffers(pair, what);
      same(pair, what);
    });
  }

  test("after hidden work in one twin and a wait of 5 s, a delayed snapshot gives P1 the same wait and the same number, at or after its wait's end", async (t) => {
    const pair = await open(t, { budget: { ipCount: 6, windowMs: 50 } });
    await both(pair, async (twin) => {
      if (twin.name === "door") for (const at of [2_100, 2_200, 2_300]) await hiddenRename(twin, pair, at);
      twin.to(7_300);
      // Five snapshots on P1's address in the window, then P1's reload waits for the oldest to leave it.
      for (let i = 0; i < 6; i++) {
        const dm = await ScopeClient.open(twin.actor, twin.member("dm"), "dm");
        twin.actor.detach(dm.conn);
      }
      twin.actor.detach(twin.clients.p1.conn);
      const reload = ScopeClient.open(twin.actor, twin.member("p1"), "player");
      await delay(5);
      twin.to(7_400);
      twin.clients.p1 = await reload;
      twin.watch("p1#waited", twin.clients.p1.sent);
      await twin.settle();
      const sent = twin.clients.p1.sent;
      assert.ok(sent.some((m) => m.t === "wait"), `${twin.name}: the reload waited`);
      const n = twin.latest("p1#waited", 0);
      assert.ok(n !== undefined && n >= T0 + 7_400, `${twin.name}: the snapshot's number ${n} is at or after its wait's end`);
    });
    same(pair, "a delayed snapshot");
  });

  for (const lone of ["the music's tick", "a cleanup's remember"] as const) {
    test(`a batch of ${lone} alone in one twin leaves the stored number as it was and P1's reads the same`, async (t) => {
      const seq: SeqTwinOptions = lone === "the music's tick" ? { music: true } : { stamp: true };
      const pair = await open(t, { seq, options: { roomSound: true } });
      await both(pair, async (twin) => {
        const pub = twin.db.pub;
        const stored = twin.db.stored.length;
        if (lone === "the music's tick") {
          // A socket's coming places the tick's timer afresh, which finds it due where the music plays.
          twin.to(TRACK_END - T0 + 1_000);
          const observer = await scopeObserver(twin.actor, { memberId: "dm1", role: "dm" });
          if (twin.name === "door") await until(() => (twin.db.stored.length > stored ? true : undefined), "the tick");
          twin.actor.detach(observer.conn);
        }
        if (twin.name === "door") {
          if (lone === "a cleanup's remember") {
            twin.to(2_000);
            for (const op of forgetRememberedStamps(twin.actor.committed.state, new Set([IMAGE]))) await twin.actor.sys(op);
          }
          await twin.settle();
          assert.ok(twin.db.stored.length > stored, `${lone} stored a row`);
          assert.equal(twin.db.pub, pub, `${lone} left the stored number as it was`);
        }
        twin.to(TRACK_END - T0 + 6_000);
        await twin.reloadP1();
        const p1 = twin.clients.p1;
        const before = p1.sent.length;
        await twin.actor.op(p1.conn, 1, chat("ready"));
        await until(() => p1.sent.slice(before).find((m) => m.t === "history"), "the history after the resend");
        await twin.settle();
        const display = await scopeObserver(twin.actor, { memberId: DISPLAY, role: "player", display: true });
        twin.watch("display-new", display.sent);
        await twin.settle();
      });
      storedDiffers(pair, lone);
      same(pair, lone);
    });
  }

  test("three hidden answers in P1's millisecond put P1's number ahead by three, and 5 ms later the numbers are the same again", async (t) => {
    const pair = await open(t);
    const leads: number[] = [];
    const from: Mark[] = [];
    await both(pair, async (twin) => {
      twin.to(2_000);
      const id = pair.fixture.creatures[twin.name][0]!;
      const hidden = twin.name === "door" ? [1, 2, 3].map((i) => twin.clients.dm.send({ t: "token.update", tokenId: id, patch: { name: `Shade ${twin.name} ${i}` } })) : [];
      for (const i of [1, 2, 3]) twin.hidden.names.push(`Shade ${twin.name} ${i}`);
      const before = twin.actor.serverTime();
      const mine = twin.clients.p1.send(chat("now"));
      await Promise.all([...hidden, mine]);
      const after = twin.actor.serverTime();
      await twin.settle();
      assert.equal(before, after, "P1's brackets read one clock time");
      const line = twin.actor.committed.state.log.find((l) => l.kind === "chat" && l.text === "now")!;
      const acked = (await mine).seq;
      assert.equal(Number(line.id.split(":")[0]), acked, `${twin.name}: the chat's number is its event's`);
      leads.push(acked - after);
      from.push(twin.mark());
      twin.to(2_005);
      await twin.apply("p1", chat("later"));
    });
    assert.deepEqual(leads, [3, 0], "P1's number leads the clock by the hidden answers in its millisecond, and only by them");
    same(pair, "5 ms later", [from[0]!, from[1]!]);
  });

  test("a visible area whose hidden caster changes sends P1 no frame, as hidden work elsewhere sends none", async (t) => {
    const pair = await open(t, { edit: extraShade });
    const from = pair.map((twin) => twin.mark());
    await both(pair, async (twin) => {
      if (twin.name === "door") {
        twin.to(2_000);
        await twin.apply("dm", { t: "template.update", templateId: pair.fixture.area, patch: { casterId: pair.fixture.creatures.door.at(-1)! } } as Op);
      } else await hiddenRename(twin, pair, 2_000);
    });
    for (const [i, twin] of pair.entries()) assert.deepEqual(twin.frames(from[i]), [], `${twin.name}: no frame for P1 or the display`);
    same(pair, "the caster");
  });

  test("a visible area whose hidden caster stays or is deleted gives P1 the same frames, live and on a reconnect", async (t) => {
    const pair = await open(t);
    const from = pair.map((twin) => twin.mark());
    await both(pair, async (twin) => {
      const caster = pair.fixture.creatures[twin.name][0]!;
      if (twin.name === "door") await hiddenRename(twin, pair, 2_000);
      else {
        twin.to(2_000);
        await twin.apply("dm", { t: "token.delete", tokenId: caster });
        assert.equal(twin.actor.committed.state.templates[pair.fixture.area]?.casterId, undefined, `${twin.name}: the area lost its caster`);
      }
    });
    for (const [i, twin] of pair.entries()) assert.deepEqual(twin.frames(from[i]), [], `${twin.name}: no frame for P1 or the display`);
    await both(pair, async (twin) => {
      twin.to(3_000);
      await twin.apply("p1", chat("still here"));
      twin.to(4_000);
      await twin.reloadP1();
    });
    storedDiffers(pair, "the caster");
    same(pair, "the caster", [from[0]!, from[1]!]);
  });

  /** The kinds a player gets that each hide and show their own way, with an edit and its undo while hidden. */
  const kinds: Array<{ kind: string; make: Op; edit: Op; show: Op }> = [
    {
      kind: "a drawing",
      make: { t: "drawing.create", drawing: { id: "0199f0a0-0000-7000-8000-0000000000d1", sceneId: "s2", kind: "line", points: [3, 3, 5, 5], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "dm1", visibility: "all" } } as Op,
      edit: { t: "drawing.delete", drawingId: "0199f0a0-0000-7000-8000-0000000000d1" },
      show: { t: "room.setPlayerScene", sceneId: "s2" },
    },
    {
      kind: "a stamp",
      make: { t: "build.stamps", sceneId: "s2", put: [{ id: "0199f0a0-0000-7000-8000-0000000000d2", art: { key: "chest" }, x: 4.5, y: 4.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] },
      edit: { t: "build.stamps", sceneId: "s2", put: [{ id: "0199f0a0-0000-7000-8000-0000000000d2", art: { key: "chest" }, x: 6.5, y: 4.5, w: 2, h: 1, rotation: 90, z: 0, visibility: "all" }] },
      show: { t: "room.setPlayerScene", sceneId: "s2" },
    },
    {
      kind: "a label",
      make: { t: "build.label", sceneId: "s2", labelId: "0199f0a0-0000-7000-8000-0000000000d3", label: { x: 4, y: 4, text: "Crypt", size: 1 } },
      edit: { t: "build.label", sceneId: "s2", labelId: "0199f0a0-0000-7000-8000-0000000000d3", label: { x: 5, y: 4, text: "Tomb", size: 1 } },
      show: { t: "room.setPlayerScene", sceneId: "s2" },
    },
    {
      kind: "a pin",
      make: { t: "pin.put", pin: { id: "0199f0a0-0000-7000-8000-0000000000d4", sceneId: "s2", x: 4, y: 4, label: "Here", color: "#ff0000", visibility: "all" } },
      edit: { t: "pin.put", pin: { id: "0199f0a0-0000-7000-8000-0000000000d4", sceneId: "s2", x: 6, y: 4, label: "There", color: "#ff0000", visibility: "all" } },
      show: { t: "room.setPlayerScene", sceneId: "s2" },
    },
    {
      kind: "an area",
      make: { t: "template.create", template: { id: "0199f0a0-0000-7000-8000-0000000000d5", sceneId: "s2", shape: "sphere", size: 10, origin: { x: 4.5, y: 4.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "dm1", visibility: "all" } } as Op,
      edit: { t: "template.update", templateId: "0199f0a0-0000-7000-8000-0000000000d5", patch: { color: "#00ff00" } } as Op,
      show: { t: "room.setPlayerScene", sceneId: "s2" },
    },
  ];

  for (const { kind, make, edit, show } of kinds) {
    test(`${kind} edited and put back while P1 cannot see it gives P1 the same frames once shown`, async (t) => {
      const pair = await open(t, { edit: (s) => void (s.scenes.s2 = scene("s2", { order: 1 })) });
      await both(pair, async (twin) => {
        twin.to(2_000);
        await twin.apply("dm", make);
        if (twin.name === "door") {
          twin.to(2_100);
          await twin.apply("dm", edit);
          twin.to(2_200);
          await undoLast(twin);
        }
        twin.to(3_000);
        await twin.apply("dm", show);
      });
      storedDiffers(pair, kind);
      same(pair, kind);
    });
  }
});

describe("stamps draw for a player in their rank among the stamps the copy holds", () => {
  test("stamps placed between hidden ones, brought to front, reloaded, and remembered give P1 the same ranks 0 to n-1", async (t) => {
    const pair = await open(t);
    const placed = ["0199f0a0-0000-7000-8000-0000000000e1", "0199f0a0-0000-7000-8000-0000000000e2"];
    await both(pair, async (twin) => {
      // The DM's placement helper takes the top of every stamp on the scene, hidden ones included.
      const put = (id: string, x: number, at: number) => {
        twin.to(at);
        const z = topZ(Object.values(twin.actor.committed.state.stamps).filter((s) => s.sceneId === "s1"));
        return twin.apply("dm", { t: "build.stamps", sceneId: "s1", put: [{ ...stampAt(id, x, 6, z), rev: undefined, sceneId: undefined }].map(({ rev: _r, sceneId: _s, ...s }) => s) } as Op);
      };
      await put(placed[0]!, 3, 2_000);
      await put(placed[1]!, 5, 3_000);
      // Bring to front: the first placed goes over everything again.
      await put(placed[0]!, 3, 4_000);
      twin.to(5_000);
      await twin.reloadP1();
      // Ayla walks to the side room and back: room R's stamps are remembered, then live again.
      twin.to(6_000);
      await twin.apply("p1", move("a", IN_SIDE.x, IN_SIDE.y));
      twin.to(7_000);
      await twin.apply("p1", move("a", IN_R.x, IN_R.y));
      twin.to(8_000);
      await twin.reloadP1();
    });
    const zs = pair.map((twin) => placed.map((id) => twin.actor.committed.state.stamps[id]!.z));
    assert.notDeepEqual(zs[0], zs[1], "the stored orders differ");
    same(pair, "placements");
    const held = new StampCopy().read(pair[0].p1.sent).orders().s1 ?? {};
    for (const id of [...pair.fixture.stampsR, ...placed]) assert.ok(id in held, `P1 holds ${id}`);
  });

  test("a stamp reordered above another behind fog, then the upper one edited, sends P1 nothing and a reload gives the remembered order", async (t) => {
    const pair = await open(t);
    const [lower, upper] = pair.fixture.stampsSide as [string, string];
    await both(pair, async (twin) => {
      // Both players' sides remember the side room's stamps.
      twin.to(2_000);
      await twin.apply("p1", move("a", IN_SIDE.x, IN_SIDE.y));
      twin.to(3_000);
      await twin.apply("p1", move("a", IN_R.x, IN_R.y));
    });
    const from = pair.map((twin) => twin.mark()) as [Mark, Mark];
    await both(pair, async (twin) => {
      if (twin.name !== "door") return;
      const stamps = twin.actor.committed.state.stamps;
      const input = (id: string, patch: Partial<{ z: number; tint: string }>) => {
        const { rev: _r, sceneId: _s, ...s } = stamps[id]!;
        return { ...s, ...patch };
      };
      twin.to(4_000);
      await twin.apply("dm", { t: "build.stamps", sceneId: "s1", put: [input(lower, { z: topZ(Object.values(stamps)) })] } as Op);
      twin.to(4_100);
      await twin.apply("dm", { t: "build.stamps", sceneId: "s1", put: [input(upper, { tint: "#ff0000" })] } as Op);
    });
    for (const [i, twin] of pair.entries()) assert.deepEqual(twin.frames(from[i]), [], `${twin.name}: no frame for P1 or the display`);
    await both(pair, async (twin) => {
      twin.to(5_000);
      await twin.reloadP1();
    });
    same(pair, "reordered behind fog");
    const order = new StampCopy().read(pair[0].p1.sent).orders().s1!;
    assert.ok(order[lower]! < order[upper]!, "the reload gives the remembered order");
  });

  test("a remembered stamp deleted from the live build in one twin ranks by its remembered order, and P1 and P2 each rank by their own memory", async (t) => {
    const pair = await open(t);
    const [lower, upper] = pair.fixture.stampsSide as [string, string];
    const p2Sent = new Map<Twin, unknown[]>();
    await both(pair, async (twin) => {
      twin.to(2_000);
      await twin.apply("p1", move("a", IN_SIDE.x, IN_SIDE.y));
      twin.to(3_000);
      await twin.apply("p1", move("a", IN_R.x, IN_R.y));
      // The DM swaps the order, and then P2's Bree sees the side room: P2 remembers the other order.
      const stamps = twin.actor.committed.state.stamps;
      const { rev: _r, sceneId: _s, ...s } = stamps[lower]!;
      twin.to(4_000);
      await twin.apply("dm", { t: "build.stamps", sceneId: "s1", put: [{ ...s, z: topZ(Object.values(stamps)) }] } as Op);
      twin.to(5_000);
      await twin.apply("p2", move("b", IN_SIDE.x + 1, IN_SIDE.y));
      twin.to(6_000);
      await twin.apply("p2", move("b", 6, 7));
      if (twin.name === "door") {
        twin.to(6_500);
        await twin.apply("dm", { t: "build.stamps", sceneId: "s1", remove: [upper] });
      }
      twin.to(7_000);
      await twin.reloadP1();
      const p2 = await ScopeClient.open(twin.actor, twin.member("p2"), "player");
      p2Sent.set(twin, p2.sent);
      await twin.settle();
    });
    same(pair, "remembered orders");
    const p1Order = new StampCopy().read(pair[0].p1.sent).orders().s1!;
    const p2Order = new StampCopy().read(p2Sent.get(pair[0])!).orders().s1!;
    assert.ok(p1Order[lower]! < p1Order[upper]!, "P1 ranks by the order it remembers");
    assert.ok(p2Order[lower]! > p2Order[upper]!, "P2 ranks by the order it remembers");
    assert.deepEqual(new StampCopy().read(p2Sent.get(pair[0])!).orders(), new StampCopy().read(p2Sent.get(pair[1])!).orders(), "P2's ranks are the same in both twins");
  });
});

describe("waits and batches go by the clock and P1's own requests", () => {
  test("the DM's snapshots on P1's address, large or small, give P1 the same wait and delivery", async (t) => {
    const pair = await open(t, {
      budget: { ipBytes: 400_000 },
      edit: (s, name, fixture) => {
        if (name !== "door") return;
        // Many hidden creatures: the DM's snapshots here are large.
        const r = rng(99);
        for (let i = 0; i < 80; i++) {
          const id = idFrom(r);
          s.tokens[id] = token(id, { name: `Shade ${id.slice(-6)}`, visibility: "dm", x: 9, y: 9 });
          fixture.hidden.door.ids.push(id);
        }
      },
    });
    const sizes: number[] = [];
    await both(pair, async (twin) => {
      twin.to(2_000);
      for (let i = 0; i < 33; i++) {
        const dm = await ScopeClient.open(twin.actor, twin.member("dm"), "dm");
        if (i === 0) sizes.push(JSON.stringify(dm.sent.find((m) => m.t === "snapshot")).length);
        twin.actor.detach(dm.conn);
      }
      twin.to(3_000);
      await twin.reloadP1();
    });
    assert.ok(sizes[0]! * 33 > 400_000 && sizes[1]! * 33 < 400_000, `the DM's snapshots differ in size across the limit: ${sizes.join(", ")}`);
    same(pair, "the DM's snapshots");
    for (const twin of pair) assert.ok(!twin.clients.p1.sent.some((m) => m.t === "wait"), `${twin.name}: P1's reload did not wait`);
  });

  /** Flushes the promises the in-memory database and the actor chain, with the timers held. */
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  /** Runs `script` in each twin with setTimeout mocked, the clock and the timers moved together by `step`. */
  async function timed(t: TestContext, pair: Pair, script: (twin: Twin, step: (ms: number) => Promise<void>) => Promise<void>): Promise<void> {
    for (const twin of pair) {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const step = async (ms: number) => {
          for (let i = 0; i < ms; i++) {
            twin.clock.now += 1;
            t.mock.timers.tick(1);
            await flush();
          }
        };
        await script(twin, step);
      } finally {
        t.mock.timers.reset();
      }
      await twin.settle();
    }
  }

  const acksOf = (twin: Twin) => twin.watched.filter((w) => w.label.startsWith("p1#")).flatMap((w) => w.sent.flatMap((m) => ((m as Event).t === "ev" && (m as Event).acks ? [(m as Event).acks!] : [])));

  test("a hidden op at 0 ms and P1's chats at 15 and 25 ms give the same acknowledgment groups and frames as no hidden op", async (t) => {
    const pair = await open(t, { options: { batchMs: 20 } });
    const from = pair.map((twin) => twin.mark()) as [Mark, Mark];
    await timed(t, pair, async (twin, step) => {
      twin.to(20_000);
      const p1 = twin.clients.p1;
      if (twin.name === "door") void twin.clients.dm.send({ t: "token.update", tokenId: pair.fixture.creatures.door[0]!, patch: { name: "Shade door 0" } });
      twin.hidden.names.push("Shade door 0");
      await flush();
      await step(15);
      void twin.actor.op(p1.conn, ++p1.n, chat("at 15"));
      await flush();
      await step(10);
      void twin.actor.op(p1.conn, ++p1.n, chat("at 25"));
      await flush();
      await step(25);
    });
    assert.deepEqual(acksOf(pair[0]), acksOf(pair[1]), "P1's acknowledgments come in the same groups");
    same(pair, "a hidden op first", from);
    assert.equal(pair[0].frames(from[0]).length, pair[1].frames(from[1]).length);
  });

  test("twins differing in an asset the sweep deletes, swept while P1's batch is open, give the same acknowledgment groups", async (t) => {
    const pair = await open(t, { options: { batchMs: 20 } });
    await timed(t, pair, async (twin, step) => {
      twin.to(20_000);
      const p1 = twin.clients.p1;
      await step(3);
      void twin.actor.op(p1.conn, ++p1.n, chat("at 3"));
      await flush();
      await step(4);
      // Only the twin whose library holds the asset runs the sweep's step.
      if (twin.name === "door") void twin.actor.deletionStep(async () => ({ deleted: ["0199f0a0-0000-7000-8000-00000000f1f1"], result: null }));
      await flush();
      await step(5);
      void twin.actor.op(p1.conn, ++p1.n, chat("at 12"));
      await flush();
      await step(30);
    });
    assert.deepEqual(acksOf(pair[0]), acksOf(pair[1]), "P1's acknowledgments come in the same groups");
    same(pair, "the sweep");
  });

  for (const variant of ["a hidden answer at 5 ms", "a hidden walk at 7 ms after P1's", "a hidden answer, then the DM deletes the walker after the walk"] as const) {
    test(`P1's walk with ${variant} in one twin is acknowledged at the tick, alike, with one event and the same number`, async (t) => {
      const pair = await open(t, { options: { batchMs: 20 } });
      const from = pair.map((twin) => twin.mark()) as [Mark, Mark];
      const at = new Map<Twin, number>();
      await timed(t, pair, async (twin, step) => {
        twin.to(20_000);
        const p1 = twin.clients.p1;
        const shade = pair.fixture.creatures[twin.name][0]!;
        const start = p1.sent.length;
        const acked = () => p1.sent.slice(start).some((m) => (m as Event).t === "ev" && (m as Event).acks?.includes(p1.n));
        const walkAt = variant === "a hidden walk at 7 ms after P1's" ? 3 : 15;
        if (variant !== "a hidden walk at 7 ms after P1's") {
          await step(5);
          if (twin.name === "door") void twin.clients.dm.send({ t: "token.update", tokenId: shade, patch: { name: "Shade door 5" } });
          twin.hidden.names.push("Shade door 5");
          await flush();
          await step(walkAt - 5);
        } else await step(walkAt);
        void twin.actor.op(p1.conn, ++p1.n, move("a", 5, 4));
        await flush();
        if (variant === "a hidden walk at 7 ms after P1's") {
          await step(7);
          if (twin.name === "door") void twin.clients.dm.send(move(shade, 8, 3));
          await flush();
        }
        if (variant === "a hidden answer, then the DM deletes the walker after the walk") {
          await step(2);
          void twin.clients.dm.send({ t: "token.delete", tokenId: "a" });
          await flush();
        }
        for (let i = 0; i < 40 && !acked(); i++) await step(1);
        at.set(twin, twin.clock.now - T0);
      });
      assert.deepEqual([at.get(pair[0]), at.get(pair[1])], [20_020, 20_020], "P1's walk is acknowledged at the 20 ms tick in both");
      same(pair, variant, from);
      for (const twin of pair) {
        const evs = twin.p1.sent.slice(-3).filter((m) => (m as Event).t === "ev");
        assert.ok(evs.length >= 1, `${twin.name}: one event for the walk's tick`);
        if (variant === "a hidden answer, then the DM deletes the walker after the walk") {
          assert.equal(twin.actor.committed.state.tokens.a, undefined, `${twin.name}: the delete applied after the walk`);
          const ops = twin.db.stored.map((o) => o.t);
          assert.ok(ops.lastIndexOf("token.move") < ops.lastIndexOf("token.delete"), `${twin.name}: the walk is stored before the delete`);
        } else assert.deepEqual([twin.actor.committed.state.tokens.a!.x, twin.actor.committed.state.tokens.a!.y], [5, 4], `${twin.name}: the walk landed`);
      }
    });
  }

  test("the DM's Next, move, delete, undo and snapshot are taken in each twin after hidden work, and the DM's numbers rise", async (t) => {
    const pair = await open(t, { edit: extraShade });
    await both(pair, async (twin) => {
      if (twin.name === "door") for (const at of [2_100, 2_200]) await hiddenRename(twin, pair, at);
      const dm = twin.clients.dm;
      twin.to(3_000);
      await twin.apply("dm", { t: "encounter.start", entries: [{ id: "ea", tokenId: "a", value: 20 }, { id: "eb", tokenId: "b", value: 5 }] } as Op);
      twin.to(3_100);
      await twin.apply("dm", { t: "encounter.next" } as Op);
      twin.to(3_200);
      await twin.apply("dm", move("b", 7, 7));
      twin.to(3_300);
      await twin.apply("dm", { t: "token.delete", tokenId: pair.fixture.creatures[twin.name].at(-1)! });
      twin.to(3_400);
      await twin.apply("dm", { t: "undo", head: dm.head("play", "undo").id } as Op);
      twin.to(3_500);
      const fresh = await ScopeClient.open(twin.actor, twin.member("dm"), "dm");
      const seqs = [...dm.sent, ...fresh.sent].filter((m) => m.t === "ev" || m.t === "snapshot").map((m) => (m as { seq: number }).seq);
      assert.ok(seqs.every((s, i) => i === 0 || s >= seqs[i - 1]!), `${twin.name}: the DM's numbers never fall`);
      assert.ok(seqs.at(-1)! > seqs[0]!, `${twin.name}: the DM's numbers rise`);
    });
    same(pair, "the DM's work");
  });
});
