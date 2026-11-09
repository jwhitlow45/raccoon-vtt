import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInitialState } from "#shared/initial.ts";
import { uuidv7 } from "#shared/ids.ts";
import { OP_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Actor, Member, RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { RESERVED_ID } from "#shared/reducer/tx.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import type { Pool } from "./persistence.ts";

/**
 * PROTO-IDS-ARRAY-IDS in the room: a live op that adds an effect or an
 * initiative entry named for a member of Object.prototype is refused with
 * the reserved-id words, and the same id stored before the rule replays.
 */

const ROOM = "RESERVEDR";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** The rows a room keeps, answered the way persistence.ts asks for them. */
class FakeDb {
  durableMax: number;
  #staged: number[] = [];
  readonly state: RoomState;
  readonly opRows: unknown[];
  readonly dmId: string;
  constructor(state: RoomState, dmId: string, opRows: unknown[] = []) {
    this.state = state;
    this.dmId = dmId;
    this.opRows = opRows;
    this.durableMax = opRows.length;
  }
  pool(): Pool {
    const run = (sql: string, params: unknown[] = []) => Promise.resolve().then(() => this.#answer(sql.trim(), params));
    return { query: run, connect: () => Promise.resolve({ query: run, release: () => undefined }) } as unknown as Pool;
  }
  #answer(sql: string, params: unknown[]): { rows: unknown[]; rowCount?: number } {
    if (sql.includes("from room_snapshots")) return { rows: [{ seq: "0", state: this.state, schema_version: SNAPSHOT_VERSION }] };
    if (sql.includes("max(seq)")) return { rows: [{ max: String(this.durableMax) }] };
    if (sql.includes("from room_ops")) return { rows: this.opRows };
    if (sql.includes("from grants")) return { rows: [{ member_id: this.dmId }] };
    if (sql.startsWith("insert into room_ops")) this.#staged = params[1] as number[];
    if (sql === "commit") {
      this.durableMax = Math.max(this.durableMax, ...this.#staged);
      this.#staged = [];
    }
    return { rows: [], rowCount: 0 };
  }
}

const inline: Actor = {
  hp: { cur: 7, max: 7, temp: 0 },
  life: "alive",
  ac: 15,
  speeds: { walk: 30 },
  initBonus: 2,
  passivePerception: 9,
  senses: "",
  effects: [],
  deathSaves: { ok: 0, fail: 0 },
  notes: "",
  dmNotes: "",
};

function setup(): { dm: Member; state: RoomState; tokenId: string } {
  const dm: Member = { id: uuidv7(), rev: 0, name: "DM", color: "#336699", kind: "dm", createdAt: new Date().toISOString() };
  const initial = createInitialState({ roomName: "Reserved", dm });
  const tokenId = uuidv7();
  const created = applyOp(
    initial,
    { t: "token.create", token: { id: tokenId, sceneId: initial.meta.playerSceneId!, kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline } } },
    { memberId: dm.id, role: "dm" },
    { seq: 1, at: new Date().toISOString() },
  );
  assert.ok(created.ok);
  return { dm, state: created.state, tokenId };
}

function load(db: FakeDb): Promise<RoomActor | null> {
  const deps: ActorDeps = {
    pool: db.pool(),
    info: { roomId: ROOM, pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget: new SnapshotBudget(),
    gateway: {} as RoomGateway,
    options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000 },
  };
  return RoomActor.load(deps);
}

function connect(actor: RoomActor, who: Member): { conn: Connection; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: ROOM, memberId: who.id, role: "dm" }, "203.0.113.9");
  actor.attach(conn);
  return { conn, sent };
}

async function answerTo(sent: ServerMessage[], n: number): Promise<Extract<ServerMessage, { t: "ev" }>> {
  for (let i = 0; i < 1000; i++) {
    const ev = sent.find((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev" && ((m.acks ?? []).includes(n) || (m.rejects ?? []).some((r) => r.n === n)));
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`op ${n} never answered`);
}

describe("a live op that adds an array entry with a reserved id", () => {
  test("is refused for an effect and an initiative entry, and an ordinary id goes through", async () => {
    const { dm, state, tokenId } = setup();
    const db = new FakeDb(state, dm.id);
    const actor = await load(db);
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      const target = { tokenId };
      const ops = [
        { t: "actor.effect.add", target, effect: { id: "__proto__", key: "blessed" } },
        { t: "actor.effect.add", target, effect: { id: "constructor", key: "blessed" } },
        { t: "encounter.start", entries: [{ id: "toString", tokenId, value: 3 }] },
        { t: "actor.effect.add", target, effect: { id: "e1", key: "blessed" } },
        { t: "encounter.start", entries: [{ id: "en1", tokenId, value: 3 }] },
      ];
      for (const [i, op] of ops.entries()) await actor.op(conn, i + 1, op);
      const refused = [];
      for (let n = 1; n <= ops.length; n++) refused.push((await answerTo(sent, n)).rejects?.find((r) => r.n === n)?.message ?? null);
      assert.deepEqual(refused, [RESERVED_ID, RESERVED_ID, RESERVED_ID, null, null]);
      const goblin = actor.committed.state.tokens[tokenId]!.actor;
      assert.deepEqual("inline" in goblin ? goblin.inline.effects.map((e) => e.id) : null, ["e1"]);
      assert.deepEqual(actor.committed.state.encounter?.entries.map((e) => e.id), ["en1"]);
    } finally {
      await actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("replays as stored, so a room that holds such an id still loads", async () => {
    const { dm, state, tokenId } = setup();
    const row = (seq: number, op: unknown) => ({ seq: String(seq), at: new Date(), actor_member_id: dm.id, actor_role: "dm", op, op_version: OP_VERSION, pub: String(seq) });
    const db = new FakeDb(state, dm.id, [row(1, { t: "actor.effect.add", target: { tokenId }, effect: { id: "constructor", key: "blessed" } })]);
    const actor = await load(db);
    assert.ok(actor);
    try {
      assert.equal(actor.replayFailed, false);
      const goblin = actor.committed.state.tokens[tokenId]!.actor;
      assert.deepEqual("inline" in goblin ? goblin.inline.effects.map((e) => e.id) : null, ["constructor"]);
    } finally {
      await actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});
