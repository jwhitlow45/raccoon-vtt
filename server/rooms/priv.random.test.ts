import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import type { Member, RoomState, Stamp } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { hiddenIn, IN_SIDE, idFrom, privTwins, revsIn, StampCopy, type Hidden, type PrivTwins, type TwinName } from "#shared/privTestutil.ts";
import { FrameReader, IMAGE, numbersIn, T0, type SeqTwinOptions } from "#shared/seqTestutil.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { forgetRememberedStamps } from "../assets/cleanup.ts";
import { topZ } from "../../client/features/builder/stamps/rules.ts";
import { RoomActor, type ActorOptions } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import type { RoomGateway } from "./gateway.ts";
import { scopeObserver, ScopeClient, StoredRoomDb, until } from "./undoScopeTesting.ts";

/**
 * The random twin test of what a player's device receives: two rooms
 * whose copies for P1 and the table display match (shared/privTestutil.ts
 * privTwins, on the room count's twins), on one schedule. Every shared
 * event has a clock time drawn once and runs in both twins at it: P1's
 * chats, walks in room R and into the side room and back, tagged rolls,
 * reads of every kind (page reloads, resends, room reloads, a display
 * opened, a DM's View as P1, a second socket of P1's), the DM's public
 * stamp placements through the real placement helper, Bring to front,
 * edits P1 sees, Next to a visible row, the DM's snapshots on P1's
 * address and bursts behind a held commit. Between shared events each
 * twin draws its own hidden events, at least 2 ms from any shared one but
 * anywhere in a shared event's batch tick: the DM's work on hidden
 * creatures and stamps, moves of public stamps among hidden ones, a
 * visible area's hidden caster changed, Next over hidden rows, P2's
 * whispers, the music's tick, a cleanup's remember and the sweep. The run
 * never fills a batch to its cap with hidden answers.
 *
 * After every shared event, in every run:
 * - P1: every frame P1's sockets and the display got is the same in both
 *   twins, byte for byte, in number and order, after each twin's frames
 *   are scanned raw for its own hidden ids and names.
 * - P2: P1's acknowledgments, refusals and waits are in those frames, and
 *   P1's receipts carry the same numbers and outcomes in both twins.
 * - P3: no rev but 0 in any copy P1 or the display holds, and each
 *   socket's stamps carry ranks 0 to n-1, equal to a fresh snapshot's.
 * - P4, in each twin: a socket's numbers never fall, each answer to a
 *   request is numbered at or after the request's clock time, the stored
 *   number is at least every number in a stored row, and a step that
 *   answered no one leaves the stored number as it was.
 * - P5, in each twin: the DM's ops are taken as sent.
 */

type Who = "dm" | "p1" | "p2";
type Event = Extract<ServerMessage, { t: "ev" }>;
type Watched = { label: string; device: string; sent: unknown[]; read: number; checked: number };

const DISPLAY = "display:abcdefghijkl";
const BATCH_MS = 5;
const draw = (sides: number) => Math.ceil(sides / 2);
const BOOKKEEPING = new Set(["sys.explore", "sys.remember", "sys.sound"]);

class Twin {
  readonly name: TwinName;
  readonly db: StoredRoomDb;
  readonly clock = { now: T0 };
  readonly watched: Watched[] = [];
  readonly reader = new FrameReader();
  readonly hidden: Hidden;
  readonly creatures: string[];
  readonly newest = new Map<string, number>();
  actor!: RoomActor;
  clients!: Record<Who, ScopeClient>;
  display!: { sent: unknown[]; conn: ScopeClient["conn"] };
  second: { sent: unknown[]; conn: ScopeClient["conn"] } | null = null;
  readonly #t: TestContext;
  readonly #options: Partial<ActorOptions>;
  #pages = 0;
  #loads = 0;

  constructor(t: TestContext, name: TwinName, fixture: PrivTwins, options: Partial<ActorOptions>) {
    this.#t = t;
    this.name = name;
    this.db = new StoredRoomDb(fixture[name]);
    this.hidden = { ids: [...fixture.hidden[name].ids], names: [...fixture.hidden[name].names] };
    this.creatures = fixture.creatures[name];
    this.#options = options;
  }

  member(who: Who): Member {
    return this.actor.committed.state.members[who === "dm" ? "dm1" : who]!;
  }

  async load(): Promise<void> {
    const actor = await RoomActor.load({
      pool: this.db.pool(),
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      // Counts only: a wait would stand still on a clock that moves only with the steps.
      budget: new SnapshotBudget({ ipCount: 100_000, sessionCount: 100_000 }, () => this.clock.now),
      gateway: {} as RoomGateway,
      options: { batchMs: BATCH_MS, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, snapshotOps: 1_000_000, roomSound: true, draw, now: () => this.clock.now, ...this.#options },
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
    this.watch(`p1#${++this.#pages}`, "p1", this.clients.p1.sent);
    this.display = await scopeObserver(actor, { memberId: DISPLAY, role: "player", display: true });
    this.watch(`display#${this.#loads}`, "display", this.display.sent);
    this.second = null;
  }

  watch(label: string, device: string, sent: unknown[]): void {
    this.watched.push({ label, device, sent, read: 0, checked: 0 });
  }

  async reloadPage(): Promise<void> {
    this.actor.detach(this.clients.p1.conn);
    this.clients.p1 = await ScopeClient.open(this.actor, this.member("p1"), "player");
    this.watch(`p1#${++this.#pages}`, "p1", this.clients.p1.sent);
  }

  async restart(snapshot: boolean): Promise<void> {
    this.db.beforeCommit = undefined;
    await this.actor.shutdown({ code: 1012, snapshot });
    await this.load();
  }

  /** Until nothing is queued and nothing more is stored for longer than a batch's tick. */
  async settle(): Promise<void> {
    let stored = -1;
    let quiet = 0;
    while (quiet < 4) {
      const now = this.db.stored.length;
      quiet = now === stored && this.actor.queueLength === 0 ? quiet + 1 : 0;
      stored = now;
      await delay(3);
    }
  }

  /** The frames since the last call, raw-scanned for this twin's hidden ids and names, then read. */
  newFrames(where: string): string[] {
    const out: string[] = [];
    const raw: unknown[] = [];
    for (const w of this.watched) {
      for (; w.read < w.sent.length; w.read++) {
        raw.push(w.sent[w.read]);
        out.push(`${w.label} ${this.reader.text(w.sent[w.read])}`);
      }
    }
    assert.deepEqual(hiddenIn(raw, this.hidden), [], `${where}: ${this.name}: no frame names what P1 and the display never see`);
    assert.deepEqual(revsIn(raw), [], `${where}: ${this.name}: every rev P1 and the display hold is 0`);
    return out;
  }
}

/** A shared event, taken by both twins at its clock time. */
type Shared =
  | { k: "chat" | "page" | "resend" | "display" | "preview" | "second" | "dmsnap" | "next" | "fresh" | "side" | "back" | "inout" | "sideEdit" | "music" }
  | { k: "walk"; x: number; y: number }
  | { k: "bree"; x: number; y: number }
  | { k: "roll"; tag: string }
  | { k: "room"; snapshot: boolean }
  | { k: "place"; id: string; x: number; y: number }
  | { k: "front"; id: string }
  | { k: "burst"; ops: Op[] };

/** A hidden event, one twin's own. `tick` puts it in the shared event's batch tick, before it. */
type HiddenEvent = { k: "rename" | "walk" | "stampEdit" | "reorder" | "caster" | "area" | "whisper" | "remember" | "sweep" | "next"; tick: boolean };

type Counts = {
  steps: number;
  hidden: number;
  readsAfterHidden: number;
  hiddenBeforeWalk: number;
  inouts: number;
  stampEntries: number;
  reorders: number;
  rooms: number;
  pages: number;
  bursts: number;
  sharedAddress: number;
  frames: number;
};

const inR = (r: () => number) => ({ x: int(r, 2, 9), y: int(r, 4, 9) });
const tagOf = (r: () => number) => idFrom(r);

function sharedEvent(r: () => number, ctx: { inSide: boolean; encounter: boolean; publics: string[] }): Shared {
  const kinds: Array<[number, () => Shared]> = [
    [10, () => ({ k: "chat" })],
    [14, () => (ctx.inSide ? { k: "back" } : chance(r, 0.25) ? { k: "side" } : { k: "walk", ...inR(r) })],
    [5, () => ({ k: "inout" })],
    [6, () => ({ k: "roll", tag: tagOf(r) })],
    [16, () => ({ k: "page" })],
    [3, () => ({ k: "resend" })],
    [7, () => ({ k: "room", snapshot: chance(r, 1 / 3) })],
    [3, () => ({ k: "display" })],
    [2, () => ({ k: "preview" })],
    [3, () => ({ k: "second" })],
    [5, () => ({ k: "dmsnap" })],
    [5, () => ({ k: "place", id: idFrom(r), ...inR(r) })],
    [3, () => ({ k: "front", id: pick(r, ctx.publics) })],
    [3, () => ({ k: "sideEdit" })],
    [4, () => ({ k: "bree", ...inR(r) })],
    [ctx.encounter ? 6 : 0, () => ({ k: "next" })],
    [2, () => ({ k: "fresh" })],
    [2, () => ({ k: "music" })],
    [
      16,
      () => {
        const ops: Op[] = [];
        for (let i = int(r, 2, 4); i > 0; i--) ops.push(chance(r, 0.6) ? { t: "log.chat", text: `burst ${int(r, 0, 999)}` } : ({ t: "token.move", tokenId: "a", ...inR(r) } as Op));
        return { k: "burst", ops };
      },
    ],
  ];
  let roll = r() * kinds.reduce((sum, [w]) => sum + w, 0);
  for (const [w, make] of kinds) {
    if (roll < w) return make();
    roll -= w;
  }
  return { k: "chat" };
}

function hiddenEvents(r: () => number, opts: SeqTwinOptions & { swept: boolean }, name: TwinName, sharedK: Shared["k"]): HiddenEvent[] {
  const out: HiddenEvent[] = [];
  const kinds: HiddenEvent["k"][] = ["rename", "walk", "stampEdit", "reorder", "reorder", "caster", "area", "whisper", ...(opts.stamp && name === "door" ? (["remember"] as const) : []), ...(opts.swept && name === "door" ? (["sweep"] as const) : [])];
  for (let i = int(r, 0, 2); i > 0; i--) out.push({ k: pick(r, kinds), tick: false });
  // A hidden answer in the same tick as P1's walk, before it.
  if ((sharedK === "walk" || sharedK === "side" || sharedK === "back" || sharedK === "chat") && chance(r, 0.5)) out.push({ k: pick(r, ["rename", "walk", "stampEdit", "whisper"] as const), tick: true });
  return out;
}

/**
 * A higher z for a public stamp that passes no other public stamp's z,
 * live or remembered by any side, so every copy's order stands. Only ever
 * raising keeps the live top above every remembered z, so a stamp placed
 * on top is on top in every copy.
 */
function zRaised(r: () => number, state: RoomState, id: string, publics: ReadonlySet<string>): number | null {
  const own = state.stamps[id];
  if (!own) return null;
  const values: number[] = [];
  for (const s of Object.values(state.stamps)) if (s.id !== id && publics.has(s.id)) values.push(s.z);
  for (const chunk of [...Object.values(state.memory ?? {}), ...Object.values(state.memoryBy ?? {})]) {
    for (const [sid, s] of Object.entries(chunk.stamps ?? {})) if (sid !== id && s && publics.has(sid)) values.push(s.z);
  }
  const above = values.filter((z) => z > own.z);
  const hi = above.length > 0 ? Math.min(...above) : own.z + 6;
  return hi - own.z < 2 ? null : int(r, own.z + 1, hi - 1);
}

const inputOf = (s: Stamp, patch: Partial<Stamp> = {}) => {
  const { rev: _r, sceneId: _s, ...rest } = { ...s, ...patch };
  return rest;
};

async function takeHidden(twin: Twin, e: HiddenEvent, r: () => number, publics: ReadonlySet<string>, swept: string, wait: boolean): Promise<boolean> {
  const state = twin.actor.committed.state;
  const dm = twin.clients.dm;
  const send = async (who: Who, op: Op) => {
    const answer = twin.clients[who].send(op);
    if (wait) {
      const ev = await answer;
      assert.equal(ev.rejects?.find((x) => x.n === twin.clients[who].n), undefined, `${twin.name}: the ${who}'s hidden ${op.t} taken`);
    }
  };
  switch (e.k) {
    case "rename": {
      const name = `Shade ${twin.name} ${int(r, 0, 1e9)}`;
      twin.hidden.names.push(name);
      await send("dm", { t: "token.update", tokenId: pick(r, twin.creatures), patch: { name } });
      return true;
    }
    case "walk":
      await send("dm", { t: "token.move", tokenId: pick(r, twin.creatures), x: int(r, 6, 9), y: int(r, 2, 3) });
      return true;
    case "stampEdit": {
      const hiddenStamps = Object.values(state.stamps).filter((s) => s.visibility === "dm");
      if (hiddenStamps.length === 0) return false;
      const s = pick(r, hiddenStamps);
      await send("dm", { t: "build.stamps", sceneId: "s1", put: [inputOf(s, { tint: pick(r, ["#ff0000", "#00ff00", "#0000ff"]), rotation: int(r, 0, 3) * 90 })] } as Op);
      return true;
    }
    case "reorder": {
      const id = pick(r, [...publics].filter((p) => state.stamps[p]));
      const z = id === undefined ? null : zRaised(r, state, id, publics);
      if (z === null) return false;
      await send("dm", { t: "build.stamps", sceneId: "s1", put: [inputOf(state.stamps[id!]!, { z })] } as Op);
      return true;
    }
    case "caster": {
      const area = Object.values(state.templates).find((tpl) => tpl.visibility === "all" && tpl.casterId !== undefined);
      const other = twin.creatures.filter((c) => c !== area?.casterId && state.tokens[c]);
      if (!area || other.length === 0) return false;
      await send("dm", { t: "template.update", templateId: area.id, patch: { casterId: pick(r, other) } } as Op);
      return true;
    }
    case "area": {
      const areas = Object.values(state.templates).filter((tpl) => tpl.visibility === "dm");
      if (areas.length === 0) return false;
      await send("dm", { t: "template.update", templateId: pick(r, areas).id, patch: { color: pick(r, ["#112233", "#445566"]) } } as Op);
      return true;
    }
    case "whisper": {
      const text = `whisper ${twin.name} ${int(r, 0, 1e9)}`;
      twin.hidden.names.push(text);
      await send("p2", { t: "log.whisper", to: ["dm1"], text });
      return true;
    }
    case "remember": {
      if (e.tick) return false;
      const ops = forgetRememberedStamps(state, new Set([IMAGE]));
      for (const op of ops) await twin.actor.sys(op);
      return ops.length > 0;
    }
    case "sweep":
      if (e.tick) return false;
      await twin.actor.deletionStep(async () => ({ deleted: [swept], result: null }));
      return true;
    case "next":
      await send("dm", { t: "encounter.next" } as Op);
      return true;
  }
}

/** Whether the row after the active one is hidden, in this twin. */
function nextIsHidden(state: RoomState): boolean {
  const enc = state.encounter;
  if (!enc) return false;
  const i = enc.entries.findIndex((e) => e.id === enc.activeEntryId);
  const next = enc.entries[(i + 1) % enc.entries.length];
  return next?.hidden === true;
}

/** Takes a shared event in one twin. The requests' clock times go to `asked`, by socket label. */
async function takeShared(twin: Twin, e: Shared, asked: Map<string, number>): Promise<void> {
  const p1 = twin.clients.p1;
  const dm = twin.clients.dm;
  const at = twin.clock.now;
  const mine = async (op: Op) => {
    asked.set(twin.watched.filter((w) => w.device === "p1").at(-1)!.label, at);
    await p1.send(op);
  };
  const dmApply = async (op: Op) => {
    const ev = await dm.send(op);
    assert.equal(ev.rejects?.find((x) => x.n === dm.n), undefined, `${twin.name}: the DM's ${op.t} taken as sent`);
  };
  switch (e.k) {
    case "chat":
      return mine({ t: "log.chat", text: "hello" });
    case "walk":
      return mine({ t: "token.move", tokenId: "a", x: e.x, y: e.y });
    case "side":
      return mine({ t: "token.move", tokenId: "a", ...IN_SIDE });
    case "back":
      return mine({ t: "token.move", tokenId: "a", x: 4, y: 6 });
    case "inout": {
      // Into sight of the side room and out of it in one tick.
      const a = p1.send({ t: "token.move", tokenId: "a", ...IN_SIDE });
      const b = p1.send({ t: "token.move", tokenId: "a", x: 4, y: 6 });
      asked.set(twin.watched.filter((w) => w.device === "p1").at(-1)!.label, at);
      await Promise.all([a, b]);
      return;
    }
    case "roll":
      return mine({ t: "dice.roll", tag: e.tag, to: "all", rolls: [{ formula: "1d20" }] } as Op);
    case "page":
      await twin.reloadPage();
      asked.set(twin.watched.at(-1)!.label, at);
      return;
    case "resend": {
      if (p1.n === 0) return;
      const before = p1.sent.length;
      asked.set(twin.watched.filter((w) => w.device === "p1").at(-1)!.label, at);
      await twin.actor.op(p1.conn, p1.n, { t: "log.chat", text: "again" });
      await until(() => p1.sent.slice(before).find((m) => m.t === "history"), "the resend's history");
      return;
    }
    case "room":
      await twin.restart(e.snapshot);
      for (const w of twin.watched.slice(-2)) asked.set(w.label, at);
      return;
    case "display": {
      twin.actor.detach(twin.display.conn);
      twin.display = await scopeObserver(twin.actor, { memberId: DISPLAY, role: "player", display: true });
      twin.watch(`display@${at}`, "display", twin.display.sent);
      asked.set(`display@${at}`, at);
      return;
    }
    case "preview": {
      const preview = await scopeObserver(twin.actor, { memberId: "dm1", role: "dm", previewOf: "p1" });
      twin.watch(`preview@${at}`, `preview@${at}`, preview.sent);
      asked.set(`preview@${at}`, at);
      await twin.settle();
      twin.actor.detach(preview.conn);
      return;
    }
    case "second": {
      if (twin.second) {
        twin.actor.detach(twin.second.conn);
        twin.second = null;
        return;
      }
      const second = await ScopeClient.open(twin.actor, twin.member("p1"), "player");
      twin.second = { sent: second.sent, conn: second.conn };
      twin.watch(`second@${at}`, `second@${at}`, second.sent);
      asked.set(`second@${at}`, at);
      return;
    }
    case "dmsnap": {
      const other = await ScopeClient.open(twin.actor, twin.member("dm"), "dm");
      twin.actor.detach(other.conn);
      return;
    }
    case "place": {
      const state = twin.actor.committed.state;
      const z = topZ(Object.values(state.stamps).filter((s) => s.sceneId === "s1"));
      return dmApply({ t: "build.stamps", sceneId: "s1", put: [{ id: e.id, art: { key: "barrel" }, x: e.x + 0.5, y: e.y + 0.5, w: 1, h: 1, rotation: 0, z, visibility: "all" }] });
    }
    case "front": {
      const state = twin.actor.committed.state;
      const s = state.stamps[e.id];
      if (!s) return;
      return dmApply({ t: "build.stamps", sceneId: "s1", put: [inputOf(s, { z: topZ(Object.values(state.stamps).filter((x) => x.sceneId === "s1")) })] } as Op);
    }
    case "sideEdit": {
      const state = twin.actor.committed.state;
      const side = Object.values(state.stamps).filter((s) => s.visibility === "all" && s.y > 12 && s.y < 13);
      const s = side[0];
      if (!s) return;
      return dmApply({ t: "build.stamps", sceneId: "s1", put: [inputOf(s, { tint: s.tint === "#ffcc00" ? "#00ccff" : "#ffcc00" })] } as Op);
    }
    case "bree":
      return dmApply({ t: "token.move", tokenId: "b", x: e.x, y: e.y });
    case "next":
      return dmApply({ t: "encounter.next" } as Op);
    case "fresh":
      return;
    case "music": {
      // A minute on, and a socket's coming places the music's timer afresh: the tick runs where music plays, the door
      // twin's when the run has music, and nowhere in the other.
      const stored = twin.db.stored.length;
      twin.actor.attach(twin.display.conn);
      if (twin.actor.committed.state.playing?.music) await until(() => (twin.db.stored.length > stored ? true : undefined), "the tick");
      return;
    }
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
      const first = dm.send({ t: "token.move", tokenId: "b", x: 6, y: 8 });
      await entered;
      asked.set(twin.watched.filter((w) => w.device === "p1").at(-1)!.label, at);
      const sent = e.ops.map((op) => p1.send(op));
      release();
      await first;
      await Promise.all(sent);
      return;
    }
  }
}

/** P4's number checks on the frames since the last call: no socket's numbers fall, and an answer to a request is numbered at or after it. */
function numbersHold(twin: Twin, asked: Map<string, number>, where: string): void {
  for (const w of twin.watched) {
    const floor = asked.get(w.label);
    let first = true;
    for (; w.checked < w.sent.length; w.checked++) {
      const f = w.sent[w.checked] as { t?: string; seq?: number };
      if (!((f.t === "ev" || f.t === "snapshot" || f.t === "history") && typeof f.seq === "number")) continue;
      const newest = twin.newest.get(w.label) ?? 0;
      assert.ok(f.seq >= newest, `${where}: ${twin.name} ${w.label}'s ${f.t} ${f.seq} after ${newest}`);
      twin.newest.set(w.label, f.seq);
      if (first && floor !== undefined) assert.ok(f.seq >= floor, `${where}: ${twin.name} ${w.label}'s answer ${f.seq} is at or after its request at ${floor}`);
      first = false;
      for (const g of numbersIn([f])) assert.ok(g.n <= f.seq || f.t === "history", `${where}: ${twin.name} ${w.label} got ${g.text} past its frame's ${f.seq}`);
    }
    asked.delete(w.label);
  }
  const pub = twin.db.pub ?? 0;
  for (const row of twin.db.rows) assert.ok(row.pub === null || row.pub <= pub, `${where}: ${twin.name}: the stored number ${pub} is at least row ${row.seq}'s ${row.pub}`);
}

async function run(t: TestContext, seed: number, steps: number, counts: Counts): Promise<void> {
  const r = rng(seed);
  const opts: SeqTwinOptions & { swept: boolean } = { music: chance(r, 0.5), stamp: chance(r, 0.5), swept: chance(r, 0.5) };
  const fixture = privTwins(seed, { music: opts.music, stamp: opts.stamp });
  const swept = idFrom(r);
  for (const name of ["door", "rock"] as const) {
    const s = fixture[name];
    s.meta = { ...s.meta, settings: { ...s.meta.settings, revealHiddenOnTurn: false } };
  }
  const options: Partial<ActorOptions> = seed % 5 === 0 ? { maxBatchOps: 3 } : {};
  const pair = [new Twin(t, "door", fixture, options), new Twin(t, "rock", fixture, options)] as const;
  const publics = new Set([...fixture.stampsR, ...fixture.stampsSide]);
  // Each twin draws its hidden events from its own source.
  const own = { door: rng(seed * 7 + 1), rock: rng(seed * 7 + 2) };
  let at = 1_000;
  for (const twin of pair) {
    await twin.load();
    twin.clock.now = T0 + at;
    await twin.clients.p1.apply({ t: "log.chat", text: "ready" });
    // Both sides remember the side room: Ayla looks in and comes back.
    twin.clock.now = T0 + at + 100;
    await twin.clients.p1.apply({ t: "token.move", tokenId: "a", ...IN_SIDE });
    twin.clock.now = T0 + at + 200;
    await twin.clients.p1.apply({ t: "token.move", tokenId: "a", x: 4, y: 6 });
    twin.clock.now = T0 + at + 300;
    const rows = [{ id: "ea", tokenId: "a", value: 20 }, ...twin.creatures.map((c, i) => ({ id: `eh${i}`, tokenId: c, value: 15 - i, hidden: true })), { id: "eb", tokenId: "b", value: 5 }];
    await twin.clients.dm.apply({ t: "encounter.start", entries: rows } as Op);
    twin.clock.now = T0 + at + 400;
    await twin.clients.dm.apply({ t: "encounter.next" } as Op);
    await twin.settle();
  }
  at += 400;
  // The opening's frames are compared and checked once, so each step's first frame on a socket is its own.
  const opened = pair.map((twin) => twin.newFrames(`seed ${seed}, the opening`));
  assert.deepEqual(opened[0], opened[1], `seed ${seed}: the opening's frames`);
  for (const twin of pair) numbersHold(twin, new Map(), `seed ${seed}, the opening`);
  let inSide = false;
  let dmSnapshots = false;
  let hiddenSince = false;
  for (let i = 0; i < steps; i++) {
    const where = `seed ${seed} (${JSON.stringify(opts)}${options.maxBatchOps ? ", cap 3" : ""}), step ${i}`;
    const shared = sharedEvent(r, { inSide, encounter: pair[0].actor.committed.state.encounter !== null, publics: [...publics] });
    // The shared event's time, and its tick's start: hidden events of the tick fall in it at least 2 ms before.
    const gap = int(r, 3, 12) * BATCH_MS + (shared.k === "music" ? 61_000 : 0);
    const sharedAt = at + gap + int(r, 3, BATCH_MS - 1);
    const tickStart = sharedAt - (sharedAt % BATCH_MS);
    const asked = pair.map(() => new Map<string, number>());
    let anyHidden = false;
    for (const [k, twin] of pair.entries()) {
      const r2 = own[twin.name];
      const events = hiddenEvents(r2, opts, twin.name, shared.k);
      // Next over hidden rows: each twin passes its own hidden rows before a shared Next lands on a visible one.
      // The twin's own clock for its hidden events, 2 ms past the last shared event and 2 ms short of the next one's tick.
      let hc = at + 2;
      if (shared.k === "next") {
        let extra = 0;
        while (nextIsHidden(twin.actor.committed.state) && extra < 5) {
          twin.clock.now = T0 + hc;
          hc += 1;
          await takeHidden(twin, { k: "next", tick: false }, r2, publics, swept, true);
          await twin.settle();
          extra++;
          counts.hidden++;
          anyHidden = true;
        }
      }
      const between = events.filter((e) => !e.tick);
      for (const e of between) {
        if (hc > tickStart - 2) break;
        twin.clock.now = T0 + hc;
        hc += 2;
        const before = twin.db.pub;
        const answered = e.k !== "remember" && e.k !== "sweep";
        if (await takeHidden(twin, e, r2, publics, swept, true)) {
          counts.hidden++;
          anyHidden = true;
          if (e.k === "reorder") counts.reorders++;
        }
        await twin.settle();
        if (!answered) assert.equal(twin.db.pub, before, `${where}: ${twin.name}: the room's own ${e.k} left the stored number as it was`);
      }
      const inTick = events.find((e) => e.tick);
      if (inTick && sharedAt - tickStart >= 2 && !(options.maxBatchOps && shared.k === "burst")) {
        twin.clock.now = T0 + tickStart;
        if (await takeHidden(twin, inTick, r2, publics, swept, false)) {
          counts.hidden++;
          anyHidden = true;
          if (shared.k === "walk" || shared.k === "side" || shared.k === "back") counts.hiddenBeforeWalk++;
        }
      }
      twin.clock.now = T0 + sharedAt;
      await takeShared(twin, shared, asked[k]!);
      await twin.settle();
    }
    at = sharedAt;
    counts.steps++;
    if (anyHidden) hiddenSince = true;
    if (shared.k === "side") inSide = true;
    if (shared.k === "back") inSide = false;
    if (shared.k === "place") publics.add(shared.id);
    const read = ["page", "resend", "room", "display", "preview", "second", "fresh"].includes(shared.k);
    if (read && hiddenSince) counts.readsAfterHidden++;
    if (!read && shared.k !== "dmsnap") hiddenSince = false;
    if (shared.k === "inout") counts.inouts++;
    if (shared.k === "side" || shared.k === "place" || shared.k === "inout") counts.stampEntries++;
    if (shared.k === "room") counts.rooms++;
    if (shared.k === "page") counts.pages++;
    if (shared.k === "burst") counts.bursts++;
    if (shared.k === "dmsnap") dmSnapshots = true;
    if (shared.k === "page" && dmSnapshots) counts.sharedAddress++;
    // P1.
    const frames = pair.map((twin) => twin.newFrames(where));
    assert.deepEqual(frames[0], frames[1], `${where}: ${shared.k}: P1's and the display's frames`);
    counts.frames += frames[0]!.length;
    // P2: P1's receipts.
    const receipts = pair.map((twin) => [...twin.db.receipts.values()].filter((x) => x.memberId === "p1").map((x) => ({ tag: x.tag, part: x.part, state: x.state, seq: x.seq, code: x.code })));
    assert.deepEqual(receipts[0], receipts[1], `${where}: P1's receipts`);
    // P3 and P4.
    for (const [k, twin] of pair.entries()) {
      numbersHold(twin, asked[k]!, where);
      for (const w of twin.watched) assert.deepEqual(new StampCopy().read(w.sent).notRanks(), [], `${where}: ${twin.name} ${w.label}: stamps carry their ranks`);
    }
    if (shared.k === "fresh") {
      for (const twin of pair) {
        const fresh = await scopeObserver(twin.actor, { memberId: "p1", role: "player" });
        await twin.settle();
        const live = new StampCopy().read(twin.clients.p1.sent).orders();
        assert.deepEqual(hiddenIn(fresh.sent, twin.hidden), [], `${where}: ${twin.name}: no frame of P1's fresh socket names what P1 never sees`);
        assert.deepEqual(revsIn(fresh.sent), [], `${where}: ${twin.name}: every rev P1's fresh socket holds is 0`);
        const snapshot = new StampCopy().read(fresh.sent);
        assert.deepEqual(snapshot.notRanks(), [], `${where}: ${twin.name}: a fresh snapshot's stamps carry their ranks`);
        assert.deepEqual(live, snapshot.orders(), `${where}: ${twin.name}: P1's live ranks equal a fresh snapshot's`);
        twin.actor.detach(fresh.conn);
        await twin.settle();
      }
      for (const twin of pair) twin.newFrames(where);
    }
  }
  // P5: the DM's ops at the end, in each twin.
  for (const twin of pair) {
    twin.clock.now = T0 + at + 1_000;
    await twin.clients.dm.apply({ t: "token.move", tokenId: "b", x: 7, y: 8 });
    await twin.settle();
  }
}

describe("the random twin test of what a player's device receives", () => {
  test("twins whose copies for P1 and the display match give those devices the same frames and answers, whatever else each room holds or does", async (t) => {
    const counts: Counts = { steps: 0, hidden: 0, readsAfterHidden: 0, hiddenBeforeWalk: 0, inouts: 0, stampEntries: 0, reorders: 0, rooms: 0, pages: 0, bursts: 0, sharedAddress: 0, frames: 0 };
    for (let seed = 1; seed <= 12; seed++) await run(t, seed, 70, counts);
    // Floors, so the runs test something.
    const floors: Array<[keyof Counts, number]> = [
      ["hidden", 300],
      ["readsAfterHidden", 100],
      ["hiddenBeforeWalk", 40],
      ["inouts", 20],
      ["stampEntries", 40],
      ["reorders", 20],
      ["rooms", 40],
      ["pages", 100],
      ["bursts", 100],
      ["sharedAddress", 30],
      ["frames", 2_000],
    ];
    for (const [k, n] of floors) assert.ok(counts[k] >= n, `${k}: ${counts[k]} of at least ${n} (${JSON.stringify(counts)})`);
  });
});
