import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import type { Member, RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { UNCOUNTED_LINE } from "#shared/reducer/tx.ts";
import { classOfMember, holdsAny } from "#shared/secretDoorTestutil.ts";
import { FAMILIAR, FrameReader, IMAGE, IN_Q, numbersIn, seqTwins, T0, type SeqTwinOptions } from "#shared/seqTestutil.ts";
import { chance, int, pick, rng, trap } from "#shared/testutil.ts";
import { forgetRememberedStamps } from "../assets/cleanup.ts";
import { RoomActor, type ActorDeps, type ActorOptions } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import type { RoomGateway } from "./gateway.ts";
import { scopeObserver, ScopeClient, StoredRoomDb, until, type StoredRow } from "./undoScopeTesting.ts";

/**
 * The room count's random twin test (docs/design, the room count, section
 * 7): the secret door twins on Explore per player (shared/seqTestutil.ts
 * seqTwins), P2 a sight holder whose walks in room Q write P2's layer
 * alone, and per run music playing under Only DM devices or not, a stamp
 * in P2's memory or not, a familiar in Q that P2 owns in one twin only or
 * none, and an asset the sweep deletes in one twin or not. Both twins take
 * the same random events: everyone's moves, P2's walks in Q, chats, P2's
 * whispers to the DM, tagged rolls, initiative and Next over a turn-start
 * trap, P1's undo and redo, P2's familiar moved or renamed (taken in one
 * twin, refused in the other), the DM's edits on ground P2 remembers, an
 * image deleted, the clock past a track's end, the sweep, resends, page
 * reloads, room reloads through the stored room (a third with a snapshot
 * on the way down), and bursts of members' ops queued behind a held commit,
 * which the actor's own cap and walk rules split. A fifth of the runs cap
 * a batch at 3, and a third open cold: the tick, the image's delete and
 * P2's op on the familiar come before any other answer, while the sight
 * the fixture shows is still unexplored. Steps move the clock alike, and
 * nothing else does.
 *
 * Whether P1's and the display's frames are compared is decided from the
 * server's layers alone, apart from anything compared: until either's
 * class holds a square of room Q, the passage or beside them, every frame
 * each got is the same in both twins (I2). After every event, in every
 * run:
 * - I1: the count, the committed count and the stored `rooms.pub` are one
 *   number, the same in both twins.
 * - I3: on each device a frame's `seq` never goes down, across page and
 *   room reloads, and no number a frame carries is above the newest `seq`.
 * - I4: every row the room stored on its own carries the count at its
 *   staging and wrote no line, and a turn-start trap goes off at most once
 *   for each turn's start.
 */

type Who = "dm" | "p1" | "p2";
type Event = Extract<ServerMessage, { t: "ev" }>;
/** A socket whose frames are compared (`read`) and checked (`checked`), and the device it is a page of. */
type Watched = { label: string; device: string; sent: unknown[]; read: number; checked: number };

const DISPLAY = "display:abcdefghijkl";
const BOOKKEEPING = new Set(["sys.explore", "sys.remember", "sys.sound"]);
const draw = (sides: number) => Math.ceil(sides / 2);
/** The clock past the door twin's track, and the next one's, with time to spare. */
const PAST_A_TRACK = 61_000;

/** The turn-start trap over room R: whoever starts a turn there sets it off, and it is ready again next turn. */
const DART = trap("dart", {
  name: "Dart",
  zone: { cells: [{ x: 2, y: 2, w: 8, h: 8 }] },
  rig: { on: ["turnStart"], who: "any", floor: true, resets: "nextTurn", stops: false, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false, message: "A dart flies." },
});

class Twin {
  readonly name: "door" | "rock";
  readonly db: StoredRoomDb;
  readonly clock = { now: T0 };
  readonly watched: Watched[] = [];
  readonly reader = new FrameReader();
  /** Every row the room stored, by seq, kept here before a snapshot prunes it. */
  readonly rows = new Map<number, StoredRow>();
  /** What the actor logged at warn and error, which a refused bookkeeping op would say. */
  readonly logged: string[] = [];
  actor!: RoomActor;
  clients!: Record<Who, ScopeClient>;
  display!: { sent: unknown[]; conn: ScopeClient["conn"] };
  /** P1's last op, which a resend sends again. */
  last: Op = { t: "log.chat", text: "ready" };
  readonly #t: TestContext;
  readonly #options: Partial<ActorOptions>;
  #loads = 0;
  #pages = 0;

  constructor(t: TestContext, name: "door" | "rock", state: RoomState, options: Partial<ActorOptions>) {
    this.#t = t;
    this.name = name;
    this.db = new StoredRoomDb(state);
    this.#options = options;
  }

  member(who: Who): Member {
    return this.actor.committed.state.members[who === "dm" ? "dm1" : who]!;
  }

  async load(): Promise<void> {
    const keep = (_o: unknown, message?: string) => this.logged.push(`${String(message)} ${JSON.stringify(_o)}`);
    const actor = await RoomActor.load({
      pool: this.db.pool(),
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log: { info() {}, debug() {}, warn: keep, error: keep } as ActorDeps["log"],
      budget: new SnapshotBudget(),
      gateway: {} as RoomGateway,
      options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, roomSound: true, draw, now: () => this.clock.now, ...this.#options },
    });
    assert.ok(actor);
    this.actor = actor;
    this.#t.after(async () => {
      this.db.beforeCommit = undefined;
      await actor.shutdown({ code: 1012, snapshot: false });
    });
    this.#loads++;
    const open = (who: Who) => ScopeClient.open(actor, this.member(who), who === "dm" ? "dm" : "player");
    this.clients = { dm: await open("dm"), p1: await open("p1"), p2: await open("p2") };
    this.watched.push({ label: `p1#${++this.#pages}`, device: "p1", sent: this.clients.p1.sent, read: 0, checked: 0 });
    this.display = await scopeObserver(actor, { memberId: DISPLAY, role: "player", display: true });
    this.watched.push({ label: `display#${this.#loads}`, device: "display", sent: this.display.sent, read: 0, checked: 0 });
  }

  async restart(snapshot: boolean): Promise<void> {
    this.keepRows();
    this.db.beforeCommit = undefined;
    await this.actor.shutdown({ code: 1012, snapshot });
    await this.load();
  }

  async reloadPage(): Promise<void> {
    this.actor.detach(this.clients.p1.conn);
    this.clients.p1 = await ScopeClient.open(this.actor, this.member("p1"), "player");
    this.watched.push({ label: `p1#${++this.#pages}`, device: "p1", sent: this.clients.p1.sent, read: 0, checked: 0 });
  }

  /** Until the queue is empty and nothing more is stored: a commit's own work, and a tick a commit placed, land first. */
  async settle(): Promise<void> {
    let stored = -1;
    let quiet = 0;
    while (quiet < 2) {
      const now = this.db.stored.length;
      quiet = now === stored && this.actor.queueLength === 0 ? quiet + 1 : 0;
      stored = now;
      await delay(3);
    }
    this.keepRows();
  }

  keepRows(): void {
    for (const r of this.db.rows) this.rows.set(r.seq, r);
  }

  /** The frames each compared socket got since the last call, in the sockets' order, as this twin's reader reads them. */
  newFrames(): string[] {
    const out: string[] = [];
    for (const w of this.watched) {
      for (; w.read < w.sent.length; w.read++) out.push(`${w.label} ${this.reader.text(w.sent[w.read])}`);
    }
    return out;
  }

  /** The newest frame `seq` each device got, across its pages and the room's reloads (I3). */
  readonly newest = new Map<string, number>();

  bookkeeping(): number {
    return this.db.stored.filter((op) => BOOKKEEPING.has(op.t)).length;
  }
}

/** A step both twins take. Undo, redo and a resend name what each twin's own P1 holds. */
type Step =
  | { k: "op"; who: Who; op: Op }
  | { k: "undo" | "redo" | "resend" | "page" | "tick" | "image" | "sweep" }
  | { k: "room"; snapshot: boolean }
  | { k: "burst"; held: Op; ops: Array<[Who, Op]> };

/** `oneSided` counts the steps whose own work the twins stored differently. */
type Counts = { steps: number; oneSided: number; splits: number; rooms: number; pages: number; bursts: number; frames: number; springs: number };

const cell = (r: () => number, x0: number, x1: number, y0: number, y1: number) => ({ x: int(r, x0, x1), y: int(r, y0, y1) });
/** A square of room R. */
const inR = (r: () => number) => cell(r, 2, 9, 2, 9);
/** A square of room Q. */
const inQ = (r: () => number) => cell(r, 19, 25, 3, 9);
const tagOf = (r: () => number) => `0199f0a0-0000-7000-8000-${int(r, 0, 0xffffff).toString(16).padStart(6, "0")}${int(r, 0, 0xffffff).toString(16).padStart(6, "0")}`;

function memberOp(r: () => number, state: RoomState, opts: SeqTwinOptions): [Who, Op] {
  const b = state.tokens.b!;
  const bInQ = b.x >= 19;
  const roll = r();
  if (roll < 0.2) return ["p1", { t: "token.move", tokenId: "a", ...inR(r) }];
  if (roll < 0.4 && bInQ) return ["p2", { t: "token.move", tokenId: "b", ...inQ(r) }];
  if (roll < 0.5) return ["p1", { t: "log.chat", text: `p1 ${int(r, 0, 999)}` }];
  if (roll < 0.58) return ["p2", { t: "log.whisper", to: ["dm1"], text: `p2 ${int(r, 0, 999)}` }];
  if (roll < 0.66) return ["p1", { t: "dice.roll", tag: tagOf(r), to: "all", rolls: [{ formula: "1d20" }] } as Op];
  if (roll < 0.8 && opts.familiar) {
    return ["p2", chance(r, 0.5) ? { t: "token.move", tokenId: FAMILIAR, ...inQ(r) } : { t: "token.update", tokenId: FAMILIAR, patch: { name: `Owl ${int(r, 0, 99)}` } }];
  }
  if (roll < 0.9) return ["p2", { t: "log.chat", text: `p2 ${int(r, 0, 999)}` }];
  return ["p1", { t: "token.move", tokenId: "a", ...inR(r) }];
}

/** The DM's edit of a square of room Q: ground P2's layer remembers in the door twin, and that no layer holds in the twin of rock. */
function editInQ(r: () => number): Op {
  const at = inQ(r);
  const sub = r();
  if (sub < 0.6) return { t: "build.paint", sceneId: "s1", terrain: pick(r, ["stone", "wood"] as const), cells: [`${at.x},${at.y}`] };
  if (sub < 0.7) return { t: "build.height", sceneId: "s1", cells: [`${at.x},${at.y}`], height: pick(r, [0, 5]) };
  return { t: "build.erase", sceneId: "s1", cells: [`${at.x},${at.y}`] };
}

/** The steps by weight, of those the run's twins can take. */
function randomStep(r: () => number, state: RoomState, opts: SeqTwinOptions & { swept: boolean }): Step {
  const dm = (op: Op): Step => ({ k: "op", who: "dm", op });
  const kinds: Array<[number, () => Step]> = [
    [6, () => ({ k: "room", snapshot: chance(r, 1 / 3) })],
    [13, () => ({ k: "page" })],
    [2, () => ({ k: "resend" })],
    [
      18,
      () => {
        const ops: Array<[Who, Op]> = [];
        for (let i = int(r, 2, 4); i > 0; i--) ops.push(memberOp(r, state, opts));
        return { k: "burst", held: chance(r, 0.7) ? editInQ(r) : { t: "log.chat", text: "held" }, ops };
      },
    ],
    // Ayla stays in room R: P1's class never looks into Q. Bree goes in and out.
    [5, () => dm(chance(r, 0.3) ? { t: "token.move", tokenId: "a", ...inR(r) } : { t: "token.move", tokenId: "b", ...(chance(r, 0.7) ? inQ(r) : inR(r)) })],
    [5, () => dm(state.encounter === null ? ({ t: "encounter.start", entries: [{ id: "ea", tokenId: "a", value: 15 }, { id: "eb", tokenId: "b", value: 10 }] } as Op) : ({ t: "encounter.next" } as Op))],
    [5, () => ({ k: chance(r, 0.6) ? "undo" : "redo" })],
    [24, () => dm(editInQ(r))],
    [4, () => dm({ t: "fog.reset", sceneId: "s1", to: "hidden" })],
    ...(opts.music ? [[7, (): Step => ({ k: "tick" })] as [number, () => Step]] : []),
    ...(opts.stamp ? [[1, (): Step => ({ k: "image" })] as [number, () => Step]] : []),
    ...(opts.swept ? [[2, (): Step => ({ k: "sweep" })] as [number, () => Step]] : []),
    [
      18,
      () => {
        const [who, op] = memberOp(r, state, opts);
        return { k: "op", who, op };
      },
    ],
  ];
  let roll = r() * kinds.reduce((sum, [w]) => sum + w, 0);
  for (const [w, make] of kinds) {
    if (roll < w) return make();
    roll -= w;
  }
  return kinds.at(-1)![1]();
}

function rejected(event: Event, n: number): string {
  return event.rejects?.find((x) => x.n === n)?.code ?? "ok";
}

/** Takes a step in one twin and returns each member op's answer, in order. */
async function take(twin: Twin, step: Step, swept: string): Promise<string[]> {
  twin.clock.now += step.k === "tick" ? PAST_A_TRACK : 100;
  const p1 = twin.clients.p1;
  switch (step.k) {
    case "op": {
      const client = twin.clients[step.who];
      const answer = rejected(await client.send(step.op), client.n);
      if (step.who === "p1") twin.last = step.op;
      return [answer];
    }
    case "undo":
    case "redo": {
      const head = p1.history().play[step.k].head;
      // An empty history names an id no step has, so the server's head check answers it, as the toolbar's would.
      const op = { t: step.k, head: head?.id ?? "0199f0a0-0000-7000-8000-000000000000" } as Op;
      const answer = rejected(await p1.send(op), p1.n);
      twin.last = op;
      return [answer];
    }
    case "resend": {
      // A page just opened has sent nothing to send again.
      if (p1.n === 0) return [];
      const before = p1.sent.length;
      await twin.actor.op(p1.conn, p1.n, twin.last);
      await until(() => p1.sent.slice(before).find((m) => m.t === "ev" && m.acks?.includes(p1.n)), "the resend's answer");
      return [];
    }
    case "page":
      await twin.reloadPage();
      return [];
    case "room":
      await twin.restart(step.snapshot);
      return [];
    case "tick": {
      const stored = twin.db.stored.length;
      // A socket's coming places the tick's timer afresh, which finds it due.
      twin.actor.attach(twin.display.conn);
      if (twin.name === "door") await until(() => (twin.db.stored.length > stored ? true : undefined), "the tick");
      return [];
    }
    case "image":
      for (const op of forgetRememberedStamps(twin.actor.committed.state, new Set([IMAGE]))) await twin.actor.sys(op);
      return [];
    case "sweep":
      await twin.actor.deletionStep(async () => ({ deleted: twin.name === "door" ? [swept] : [], result: null }));
      return [];
    case "burst": {
      let release!: () => void;
      let enter!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (enter = resolve));
      twin.db.beforeCommit = async () => {
        twin.db.beforeCommit = undefined;
        enter();
        await held;
      };
      const first = twin.clients.dm.send(step.held);
      await entered;
      // Each send numbers its op before its first wait, so the ops queue in this order.
      const sent = step.ops.map(([who, op]) => {
        const client = twin.clients[who];
        const event = client.send(op);
        if (who === "p1") twin.last = op;
        return { n: client.n, event };
      });
      release();
      await first;
      return Promise.all(sent.map(async ({ n, event }) => rejected(await event, n)));
    }
  }
}

/**
 * I3 on each device's sockets, in the order they opened, each frame read
 * once: a frame's `seq` never goes down, and nothing a frame carries is
 * above the newest. A page reloaded or a room restarted sends no more to
 * the socket it replaced, so reading in that order is reading in time.
 */
function i3(twin: Twin, where: string): void {
  for (const w of twin.watched) {
    for (; w.checked < w.sent.length; w.checked++) {
      const frame = w.sent[w.checked];
      const f = frame as { t?: string; seq?: number };
      let newest = twin.newest.get(w.device) ?? 0;
      if ((f.t === "ev" || f.t === "snapshot" || f.t === "history") && typeof f.seq === "number") {
        assert.ok(f.seq >= newest, `${where}: ${twin.name} ${w.label}'s ${f.t} ${f.seq} after ${newest}`);
        newest = f.seq;
        twin.newest.set(w.device, newest);
      }
      for (const g of numbersIn([frame])) assert.ok(g.n <= newest, `${where}: ${twin.name} ${w.label} got ${g.text} past ${newest}`);
    }
  }
}

/** I4: each row the room stored on its own took the count as it stood, the row before its and the next counted row's around it, and wrote no line. */
function i4(twin: Twin, where: string): number {
  const rows = [...twin.rows.values()].sort((a, b) => a.seq - b.seq);
  const lines = new Set<number>();
  const state = twin.actor.committed.state;
  for (const line of [...state.log, ...(state.trapLog ?? []), ...(state.trapSeen ?? [])]) lines.add(Number(line.id.split(":")[0]));
  let pub = 0;
  for (const [i, row] of rows.entries()) {
    assert.notEqual(row.pub, null, `${where}: ${twin.name} row ${row.seq} carries its number`);
    const own = !BOOKKEEPING.has((row.op as Op).t);
    if (own) {
      assert.ok(row.pub! > pub, `${where}: ${twin.name} row ${row.seq} takes a number past the last`);
    } else {
      assert.ok(row.pub! >= pub, `${where}: ${twin.name} bookkeeping row ${row.seq} takes the count as it stands`);
      const next = rows.slice(i + 1).find((x) => !BOOKKEEPING.has((x.op as Op).t));
      if (next) assert.ok(row.pub! < next.pub!, `${where}: ${twin.name} bookkeeping row ${row.seq} is below the next answer's number`);
      const shares = rows.some((x) => x !== row && !BOOKKEEPING.has((x.op as Op).t) && x.pub === row.pub);
      if (!shares) assert.ok(!lines.has(row.pub!), `${where}: ${twin.name} bookkeeping row ${row.seq} wrote no line`);
    }
    pub = Math.max(pub, row.pub!);
  }
  assert.deepEqual(twin.logged.filter((l) => l.includes(UNCOUNTED_LINE)), [], `${where}: ${twin.name}: no bookkeeping op tried to write a line`);
  const springs = new Map<string, number>();
  for (const line of state.trapLog ?? []) {
    const data = line.data as { type?: string; how?: string } | undefined;
    if (data?.type !== "trap" || data.how !== "turnStart") continue;
    const at = line.id.split(":")[0]!;
    springs.set(at, (springs.get(at) ?? 0) + 1);
  }
  for (const [at, n] of springs) assert.equal(n, 1, `${where}: ${twin.name}: the turn starting at ${at} set the dart off once`);
  return springs.size;
}

async function run(t: TestContext, seed: number, steps: number, counts: Counts): Promise<void> {
  const r = rng(seed);
  const opts: SeqTwinOptions & { swept: boolean } = { music: chance(r, 0.5), stamp: chance(r, 0.5), familiar: chance(r, 0.7), swept: chance(r, 0.5) };
  const swept = tagOf(r);
  // No snapshot on the room's own schedule: I4 reads every row, which one would prune.
  const options: Partial<ActorOptions> = { snapshotOps: 1_000_000, ...(seed % 5 === 0 ? { maxBatchOps: 3 } : {}) };
  const w = seqTwins(opts);
  for (const s of [w.door, w.rock]) s.traps = { dart: structuredClone(DART) };
  const pair = [new Twin(t, "door", w.door, options), new Twin(t, "rock", w.rock, options)] as const;
  // A third of the runs open cold: the room's own work and P2's op on the familiar come before any other answer, while
  // the fixture's sight is still unexplored, and the frames compared from the first include them.
  const opening: Step[] = [];
  if (seed % 3 === 0) {
    if (opts.music) opening.push({ k: "tick" });
    if (opts.stamp) opening.push({ k: "image" });
    if (opts.familiar) opening.push({ k: "op", who: "p2", op: { t: "token.update", tokenId: FAMILIAR, patch: { name: "Hoot" } } });
  }
  for (const twin of pair) {
    await twin.load();
    for (const step of opening) {
      await take(twin, step, swept);
      await twin.settle();
    }
    // P1's chat, then Bree in Q.
    await twin.clients.p1.apply({ t: "log.chat", text: "ready" });
    await twin.clients.dm.apply({ t: "token.move", tokenId: "b", ...IN_Q });
    await twin.settle();
  }
  let comparing = true;
  for (let i = 0; i < steps; i++) {
    const where = `seed ${seed} (${JSON.stringify(opts)}${options.maxBatchOps ? ", cap 3" : ""}), step ${i}`;
    const step = randomStep(r, pair[0].actor.committed.state, opts);
    const kept = pair.map((twin) => twin.bookkeeping());
    const answers: string[][] = [];
    for (const twin of pair) {
      answers.push(await take(twin, step, swept));
      await twin.settle();
    }
    counts.steps++;
    // The step's own work differs between the twins: rows one stored that the other did not.
    const added = pair.map((twin, k) => JSON.stringify(twin.db.stored.filter((op) => BOOKKEEPING.has(op.t)).slice(kept[k])));
    if (added[0] !== added[1]) counts.oneSided++;
    if (step.k === "room") counts.rooms++;
    if (step.k === "page") counts.pages++;
    if (step.k === "burst" && new Set(step.ops.map(([who]) => who)).size >= 2) counts.bursts++;
    const familiarOp = (op: Op) => "tokenId" in op && op.tokenId === FAMILIAR;
    const ops = step.k === "op" ? [step.op] : step.k === "burst" ? step.ops.map(([, op]) => op) : [];
    for (const [j, answer] of (answers[0] ?? []).entries()) {
      if (answer === answers[1]![j]) continue;
      assert.ok(ops[j] && familiarOp(ops[j]!), `${where}: only an op on P2's familiar is answered differently (${step.k} ${JSON.stringify(ops[j])}: ${answer} against ${answers[1]![j]})`);
      counts.splits++;
    }
    // I1.
    const pubs = pair.map((twin) => twin.actor.committed.pub);
    assert.equal(pubs[0], pubs[1], `${where}: the twins' counts`);
    for (const twin of pair) assert.equal(twin.db.pub, twin.actor.committed.pub, `${where}: ${twin.name}'s stored count is its count`);
    // The boundary, from the server's layers alone: P1's class and the display's, the party's, have held no square of Q or the passage.
    const states = pair.map((twin) => twin.actor.committed.state);
    for (const layer of new Set([classOfMember(states[0]!, "p1"), classOfMember(states[1]!, "p1"), null])) {
      if (holdsAny(states, layer, w.banned)) comparing = false;
    }
    // I2.
    const frames = pair.map((twin) => twin.newFrames());
    if (comparing) {
      assert.deepEqual(frames[0], frames[1], `${where}: P1's and the display's frames`);
      counts.frames += frames[0]!.length;
    }
    for (const twin of pair) {
      i3(twin, where);
      i4(twin, where);
    }
  }
  counts.springs += i4(pair[0], `seed ${seed}, the end`);
}

describe("the room count's random twin test", () => {
  test("twins taking the same members' ops give P1 and the display the same frames, whatever the room does on its own", async (t) => {
    const counts: Counts = { steps: 0, oneSided: 0, splits: 0, rooms: 0, pages: 0, bursts: 0, frames: 0, springs: 0 };
    for (let seed = 1; seed <= 12; seed++) await run(t, seed, 80, counts);
    // Floors, so the runs test something: a mix that reaches them all.
    assert.ok(counts.oneSided >= 300, `steps whose own work differs between the twins: ${counts.oneSided} of ${counts.steps}`);
    assert.ok(counts.splits >= 40, `taken in one twin and refused in the other: ${counts.splits}`);
    assert.ok(counts.rooms >= 40, `room reloads: ${counts.rooms}`);
    assert.ok(counts.pages >= 100, `page reloads: ${counts.pages}`);
    assert.ok(counts.bursts >= 100, `bursts of two members or more: ${counts.bursts}`);
    assert.ok(counts.frames >= 2_000, `frames compared: ${counts.frames}`);
    assert.ok(counts.springs >= 1, `turn starts that set the dart off: ${counts.springs}`);
  });
});
