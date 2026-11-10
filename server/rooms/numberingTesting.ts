import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fogRoom, paint } from "#shared/discoveryTestutil.ts";
import type { Member, RoomState, Token } from "#shared/model.ts";
import { tableNumber } from "#shared/numbering.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { FrameReader } from "#shared/seqTestutil.ts";
import { member, token } from "#shared/testutil.ts";
import { RoomActor, type ActorDeps, type ActorOptions } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot } from "./fanout.ts";
import type { RoomGateway } from "./gateway.ts";
import { ScopeClient, StoredRoomDb, type StoredRow } from "./undoScopeTesting.ts";

/**
 * Rooms for the creature number tests: the real actor on a stored room
 * (undoScopeTesting.ts StoredRoomDb), with the DM's, P1's and P2's
 * sockets. Two rooms take the same members' ops, and what each sent P1 is
 * scanned raw, then compared whole as a socket's bytes are, every key in
 * its order (shared/seqTestutil.ts FrameReader). Nothing here runs in the
 * app.
 */

/** The DM, the second and third DMs some tests take steps with, and the two players. */
export type Who = "dm" | "dm2" | "dm3" | "p1" | "p2";
export type Event = Extract<ServerMessage, { t: "ev" }>;

export const T0 = Date.parse("2026-11-10T20:00:00.000Z");
const draw = (sides: number) => Math.ceil(sides / 2);

/** A socket kept for reading: its label, its frames, and how many of them a check has read. */
type Page = { label: string; client: ScopeClient; read: number };

export class Room {
  readonly name: string;
  readonly db: StoredRoomDb;
  readonly clock = { now: T0 };
  /** P1's pages in order, each from its first frame, across page and room reloads. */
  readonly pages: Page[] = [];
  /** What the actor logged at warn and error. */
  readonly logged: string[] = [];
  /** Every row the room stored, by seq, kept here before a snapshot prunes it. */
  readonly rows = new Map<number, StoredRow>();
  actor!: RoomActor;
  clients!: Record<Who, ScopeClient>;
  readonly #t: TestContext;
  readonly #options: Partial<ActorOptions>;

  constructor(t: TestContext, name: string, state: RoomState, options: Partial<ActorOptions> = {}, version?: number) {
    this.#t = t;
    this.name = name;
    this.db = new StoredRoomDb(state, version === undefined ? {} : { version });
    this.#options = options;
  }

  member(who: Who): Member {
    return this.state.members[who === "dm" ? "dm1" : who]!;
  }

  get state(): RoomState {
    return this.actor.committed.state;
  }

  async load(): Promise<void> {
    const keep = (o: unknown, message?: string) => this.logged.push(`${String(message)} ${JSON.stringify(o)}`);
    const actor = await RoomActor.load({
      pool: this.db.pool(),
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log: { info() {}, debug() {}, warn: keep, error: keep } as ActorDeps["log"],
      budget: new SnapshotBudget(),
      gateway: {} as RoomGateway,
      options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, draw, now: () => this.clock.now, ...this.#options },
    });
    assert.ok(actor, `${this.name} loads`);
    this.actor = actor;
    this.#t.after(async () => {
      this.db.beforeCommit = undefined;
      await actor.shutdown({ code: 1012, snapshot: false });
    });
    const open = (who: Who) => ScopeClient.open(actor, this.member(who), who.startsWith("dm") ? "dm" : "player");
    const clients = { dm: await open("dm"), p1: await open("p1"), p2: await open("p2") } as Record<Who, ScopeClient>;
    for (const dm of ["dm2", "dm3"] as const) if (this.state.members[dm]) clients[dm] = await open(dm);
    this.clients = clients;
    this.pages.push({ label: `p1#${this.pages.length + 1}`, client: this.clients.p1, read: 0 });
  }

  /** The room stops, as a deploy (with its snapshot) or a crash after its last commit, and loads again from what it stored. */
  async restart(snapshot: boolean): Promise<void> {
    this.clock.now += 1_000;
    this.db.beforeCommit = undefined;
    await this.actor.shutdown({ code: 1012, snapshot });
    await this.load();
    await this.settle();
  }

  /** P1's page reloads: a new socket and snapshot, read from its first frame. */
  async reloadP1(): Promise<void> {
    this.clock.now += 1_000;
    this.actor.detach(this.clients.p1.conn);
    this.clients.p1 = await ScopeClient.open(this.actor, this.member("p1"), "player");
    this.pages.push({ label: `p1#${this.pages.length + 1}`, client: this.clients.p1, read: 0 });
    await this.settle();
  }

  async send(who: Who, op: Op): Promise<Event> {
    this.clock.now += 1_000;
    const event = await this.clients[who].send(op);
    await this.settle();
    return event;
  }

  async apply(who: Who, op: Op): Promise<Event> {
    const event = await this.send(who, op);
    assert.equal(event.rejects?.find((r) => r.n === this.clients[who].n), undefined, `${this.name}: ${who}'s ${op.t} taken: ${JSON.stringify(event.rejects)}`);
    return event;
  }

  /** A member takes back the newest step of a history scope, or puts it back. */
  async restore(direction: "undo" | "redo" = "undo", scope: "play" | "setup" = "play", who: Who = "dm"): Promise<void> {
    this.clock.now += 1_000;
    await this.clients[who].restore(scope, direction);
    await this.settle();
  }

  /** Waits until the queue is empty and nothing more is stored for a moment. */
  async settle(): Promise<void> {
    let stored = -1;
    let quiet = 0;
    while (quiet < 2) {
      const now = this.db.stored.length;
      quiet = now === stored && this.actor.queueLength === 0 ? quiet + 1 : 0;
      stored = now;
      await delay(3);
    }
    for (const row of this.db.rows) this.rows.set(row.seq, row);
  }

  /** P1's frames as one reader reads them, every page in order, each as sent with its keys in their order. */
  p1Frames(): string[] {
    const reader = new FrameReader();
    return this.pages.flatMap((p) => p.client.sent.map((f) => `${p.label} ${reader.text(f)}`));
  }

  /** P1's frames no check has read yet, raw, each with its page, marked read. */
  unread(): Array<{ label: string; frame: unknown }> {
    const out: Array<{ label: string; frame: unknown }> = [];
    for (const p of this.pages) {
      for (const frame of p.client.sent.slice(p.read)) out.push({ label: p.label, frame });
      p.read = p.client.sent.length;
    }
    return out;
  }

  /** What P1 holds now: its page's snapshot with every `ev` since folded in. */
  p1View(): ProjectedState {
    return viewOf(this.clients.p1.sent);
  }
}

export type Rooms = [Room, Room];

/** Opens room A and room B, each from its own state, and loads them. */
export async function openRooms(t: TestContext, a: RoomState, b: RoomState, options: Partial<ActorOptions> = {}, version?: number): Promise<Rooms> {
  const rooms: Rooms = [new Room(t, "A", a, options, version), new Room(t, "B", b, options, version)];
  for (const room of rooms) await room.load();
  return rooms;
}

/** Runs a step in each room in turn, A's first. */
export async function each(rooms: Rooms, step: (room: Room) => Promise<unknown>): Promise<void> {
  for (const room of rooms) await step(room);
}

/** Every key in a value, at any depth. */
function keysIn(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysIn(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  }
  return out;
}

/** Each creature a frame carries whole, by id: an `ev` change's token value, or a snapshot's tokens. */
function tokensIn(frame: unknown): Array<[string, Partial<Token>]> {
  const f = frame as ServerMessage;
  if (f.t === "snapshot") return Object.entries((f.state as ProjectedState).tokens as Record<string, Partial<Token>>);
  if (f.t !== "ev") return [];
  const out: Array<[string, Partial<Token>]> = [];
  for (const c of f.changes as Change[]) if (c.key.startsWith("token:") && "value" in c && c.value) out.push([c.key.slice(6), c.value as Partial<Token>]);
  return out;
}

/**
 * Reads P1's new frames in one room, raw, before anything is compared:
 * none holds a creature's group mark, a scene's numbers or the room's
 * group count, or any of `hidden` (ids and names this room holds and P1's
 * copy never does), and every number a creature carries is the one the
 * table gives it in the room now.
 */
export function scanP1(room: Room, hidden: readonly string[], what: string): void {
  for (const { label, frame } of room.unread()) {
    const raw = JSON.stringify(frame);
    for (const word of hidden) assert.ok(!raw.includes(word), `${what}: ${room.name}: ${label} holds ${JSON.stringify(word)}: ${raw.slice(0, 400)}`);
    const keys = keysIn(frame, new Set());
    for (const key of ["met", "numbers", "numbering"]) assert.ok(!keys.has(key), `${what}: ${room.name}: ${label} holds the key ${key}: ${raw.slice(0, 400)}`);
    for (const [id, t] of tokensIn(frame)) {
      if (t.number === undefined) continue;
      const stored = room.state.tokens[id];
      assert.ok(stored, `${what}: ${room.name}: ${label} numbers ${id}, which the room no longer holds`);
      assert.equal(t.number, tableNumber(room.state, stored), `${what}: ${room.name}: ${label} numbers ${id} as the table does`);
    }
  }
}

/** Scans both rooms' new frames raw (`hidden` by room), then compares P1's frames whole, key order included. */
export function same(rooms: Rooms, what: string, hidden: { a?: readonly string[]; b?: readonly string[] } = {}): void {
  scanP1(rooms[0], hidden.a ?? [], what);
  scanP1(rooms[1], hidden.b ?? [], what);
  const frames = rooms.map((room) => room.p1Frames());
  const at = frames[0]!.findIndex((f, i) => f !== frames[1]![i]);
  const first = at < 0 ? "" : `, first apart at frame ${at}:\nA ${frames[0]![at] ?? "(none)"}\nB ${frames[1]![at] ?? "(none)"}`;
  assert.ok(at < 0 && frames[0]!.length === frames[1]!.length, `${what}: P1 gets the same frames in both rooms${first}`);
}

/** The view a socket holds: its last snapshot with every `ev` since folded in. */
export function viewOf(sent: readonly unknown[]): ProjectedState {
  let view: ProjectedState | null = null;
  for (const raw of sent) {
    const m = raw as ServerMessage;
    if (m.t === "snapshot") view = structuredClone(m.state) as ProjectedState;
    else if (m.t === "ev" && view) view = applyChanges(view, m.changes as Change[]);
  }
  assert.ok(view, "the socket got a snapshot");
  return view;
}

const silent = { readyState: 1, OPEN: 1, CONNECTING: 0, send: () => undefined, close: () => undefined, terminate: () => undefined };

/** What a fresh snapshot gives a member now, on the scene a DM's socket views. */
export function freshView(room: Room, memberId: string, role: "dm" | "player", sceneId: string | null = null): ProjectedState {
  const conn = new Connection(silent as never, { sessionId: "fresh", roomId: "UNDOSCOPE", memberId, role }, "203.0.113.9");
  conn.sceneId = sceneId;
  return JSON.parse(JSON.stringify(buildSnapshot(room.state, 0, conn, 0).message.state)) as ProjectedState;
}

/** A socket's live view is what a fresh snapshot gives it. */
export function liveIsFresh(room: Room, who: Who, what: string): void {
  const live = JSON.parse(JSON.stringify(viewOf(room.clients[who].sent))) as ProjectedState;
  assert.equal(stableStringify(live), stableStringify(freshView(room, room.member(who).id, room.clients[who].conn.role, room.clients[who].conn.sceneId)), `${what}: ${room.name}: ${who}'s live view is a fresh snapshot`);
}

/** The numbers a view's creatures carry, by id, those without one left out. */
export function numbersIn(view: ProjectedState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, t] of Object.entries(view.tokens as Record<string, Partial<Token>>)) if (typeof t.number === "number") out[id] = t.number;
  return out;
}

/** The party's room R, where Ayla (P1's) and Bree (P2's) stand, and room F, apart from it behind rock. */
export const R = { x: 2, y: 2, w: 10, h: 8 } as const;
export const F = { x: 24, y: 2, w: 10, h: 8 } as const;

/** A cell in room R or F by column and row inside it. */
export const inR = (i: number, j = 0) => ({ x: 7 + i, y: 3 + j });
export const inF = (i: number, j = 0) => ({ x: 26 + i, y: 3 + j });

/**
 * A room whose player scene s1 has fog and party sight on: rooms R and F
 * painted apart, so sight in R never reaches F, and the party's Ayla and
 * Bree in R. The party's copy holds what stands in R and nothing in F. A
 * second DM, `dm2`, takes the steps one room alone takes, so the first
 * DM's history reads alike in both.
 */
export function numberingRoom(): RoomState {
  const state = fogRoom({ vision: true });
  paint(state, R);
  paint(state, F);
  state.tokens.a = token("a", { kind: "pc", name: "Ayla", ownerIds: ["p1"], disposition: "ally", x: 3, y: 3 });
  state.tokens.b = token("b", { kind: "pc", name: "Bree", ownerIds: ["p2"], disposition: "ally", x: 3, y: 7 });
  state.members.dm2 = member("dm2", "dm");
  return { ...state, playedScenes: { s1: { sceneId: "s1", rev: 0 } } };
}

/** A Goblin, or another creature, at a cell. */
export function creature(id: string, at: { x: number; y: number }, overrides: Partial<Token> = {}): Token {
  return token(id, { ...at, ...overrides });
}

/** The DM moves a creature to a cell. */
export const move = (tokenId: string, at: { x: number; y: number }): Op => ({ t: "token.move", tokenId, ...at });
/** The DM makes a Goblin, or another creature, at a cell. */
export const make = (id: string, at: { x: number; y: number }, overrides: Partial<Token> = {}): Op => {
  const { rev: _rev, fogExemptAuto: _auto, ...made } = creature(id, at, overrides);
  return { t: "token.create", token: made } as Op;
};
export const patch = (tokenId: string, p: Record<string, unknown>): Op => ({ t: "token.update", tokenId, patch: p }) as Op;
