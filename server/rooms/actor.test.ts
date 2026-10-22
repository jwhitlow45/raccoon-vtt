import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { chunkKey } from "#shared/keys.ts";
import {
  BLOCK_SAVES_TOO_FAST,
  BLOCKS_AT_QUOTA,
  BLOCKS_ROOM_TOO_FULL,
  exploredReserve,
  HANDOUT_PAGES_FULL,
  LIMITS,
  NO_ROOM_TO_EXPLORE,
  serializedBytes,
  SHOWING_COUNTS_AGAIN,
  utf8Bytes,
} from "#shared/limits.ts";
import { partySight, type VisionWorld } from "#shared/rules/vision.ts";
import { groundAt } from "#shared/rules/heights.ts";
import { sceneWalls, splitCheck, splitRefusal } from "#shared/rules/walls.ts";
import { OP_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { MOVE_PLAYERS_FIRST } from "#shared/permissions.ts";
import type { Actor, FreeWall, Member, RoomState, Trap } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor as testActor, character as testCharacter, companionBlock as testBlock, token as testToken } from "#shared/testutil.ts";
import { RoomActor, RoomReplayFailed, SysOpRefused, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import { roomExport, type RoomExport } from "./exportRoom.ts";
import { assertWithinLimits } from "./importRoom.ts";
import { HttpError } from "../auth/http.ts";
import { remapState } from "./remap.ts";
import type { RoomGateway } from "./gateway.ts";
import { checkWholeScenes, measuredStateBytes, roomLevelBytes } from "./sizeGuard.ts";
import { loadRoom, type Pool } from "./persistence.ts";

/**
 * The actor's commit and replay failure paths (design 7.2 and 16.2), against
 * a pool that answers each statement from a test's own table. The real
 * database cannot be made to lose a COMMIT answer or a verification read on
 * cue, and these are exactly the paths where a mistake loops forever.
 */
type Result = { rows: unknown[]; rowCount?: number };

/**
 * A stand-in for the room's rows. `durableMax` is the highest seq stored, and
 * an insert at or below it fails on the primary key as Postgres would.
 * `freeze()` parks every later statement on a promise that never settles, so
 * a test that failed by looping leaves no timer behind to hold the process.
 */
class FakeDb {
  durableMax = 0;
  inserts = 0;
  assetLookups = 0;
  /** Every op written to the op log, as stored. */
  readonly storedOps: unknown[] = [];
  /** The same as op log rows, which a later load can replay. */
  readonly storedRows: unknown[] = [];
  #staged: number[] = [];
  #frozen = false;
  readonly snapshot: { state: RoomState; seq: number };
  readonly opRows: unknown[];
  readonly dmGrants: string[];
  /** The asset rows the room's lookups find (persistence.ts loadAssetFacts). */
  readonly assetRows: { id: string; room_id: string; kind: string; width: number; height: number; uploaders: string[] }[];
  readonly hooks: { commit?: (n: number) => void; verify?: (n: number) => void } = {};
  #commits = 0;
  #verifies = 0;

  constructor(opts: { state: RoomState; opRows?: unknown[]; dmGrants: string[]; assetRows?: FakeDb["assetRows"] }) {
    this.snapshot = { state: opts.state, seq: 0 };
    this.opRows = opts.opRows ?? [];
    this.dmGrants = opts.dmGrants;
    this.assetRows = opts.assetRows ?? [];
    this.durableMax = this.opRows.length;
  }

  get verifies(): number {
    return this.#verifies;
  }

  freeze(): void {
    this.#frozen = true;
  }

  pool(): Pool {
    const run = (sql: string, params: unknown[] = []): Promise<Result> => {
      if (this.#frozen) return new Promise(() => undefined);
      return Promise.resolve().then(() => this.#answer(sql.trim(), params));
    };
    return {
      query: run,
      connect: () => (this.#frozen ? new Promise(() => undefined) : Promise.resolve({ query: run, release: () => undefined })),
    } as unknown as Pool;
  }

  #answer(sql: string, params: unknown[]): Result {
    if (sql.includes("from room_snapshots")) return { rows: [{ seq: String(this.snapshot.seq), state: this.snapshot.state, schema_version: SNAPSHOT_VERSION }] };
    if (sql.includes("max(seq)")) {
      this.#verifies++;
      this.hooks.verify?.(this.#verifies);
      return { rows: [{ max: String(this.durableMax) }] };
    }
    if (sql.includes("from room_ops")) return { rows: this.opRows };
    if (sql.includes("from assets")) {
      this.assetLookups++;
      const ids = new Set((params[0] as string[] | undefined) ?? []);
      return { rows: this.assetRows.filter((row) => ids.has(row.id)) };
    }
    if (sql.includes("from grants")) return { rows: this.dmGrants.map((member_id) => ({ member_id })) };
    if (sql.startsWith("insert into room_ops")) {
      this.inserts++;
      const seqs = params[1] as number[];
      if (seqs.some((seq) => seq <= this.durableMax)) throw new Error('duplicate key value violates unique constraint "room_ops_pkey"');
      this.#staged = seqs;
      for (const op of params[5] as string[]) this.storedOps.push(JSON.parse(op));
      const [, , ats, members, roles, ops, version] = params as [string, number[], string[], string[], string[], string[], number];
      for (const [i, seq] of seqs.entries()) {
        this.storedRows.push({ seq: String(seq), at: new Date(ats[i]!), actor_member_id: members[i], actor_role: roles[i], op: JSON.parse(ops[i]!), op_version: version });
      }
      return { rows: [] };
    }
    if (sql === "commit") {
      this.#commits++;
      this.durableMax = Math.max(this.durableMax, ...this.#staged);
      this.#staged = [];
      this.hooks.commit?.(this.#commits);
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  }
}

const ROOM = "TESTR00M";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function deps(db: FakeDb, info: Partial<ActorDeps["info"]> = {}): ActorDeps {
  return {
    pool: db.pool(),
    info: { roomId: ROOM, pinned: false, createdIp: null, readOnly: false, ...info },
    log: quiet,
    budget: new SnapshotBudget(),
    gateway: {} as RoomGateway,
    options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000 },
  };
}

function member(name: string, kind: Member["kind"]): Member {
  return { id: uuidv7(), rev: 0, name, color: "#336699", kind, createdAt: new Date().toISOString() };
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

/** A room with one goblin on its scene, and the goblin's id. */
function roomWithGoblin(dm: Member): { state: RoomState; tokenId: string } {
  const initial = createInitialState({ roomName: "Fake", dm });
  const tokenId = uuidv7();
  const sceneId = initial.meta.playerSceneId!;
  const created = applyOp(
    initial,
    { t: "token.create", token: { id: tokenId, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline } } },
    { memberId: dm.id, role: "dm" },
    { seq: 1, at: new Date().toISOString() },
  );
  assert.ok(created.ok);
  return { state: created.state, tokenId };
}

/** An op row that cannot replay, as a bug or a hand edit would leave one. */
function brokenRow(dm: Member): unknown {
  return { seq: "1", at: new Date(), actor_member_id: dm.id, actor_role: "dm", op: { t: "token.delete", tokenId: "missing" }, op_version: 1 };
}

function within<T>(ms: number, work: Promise<T>): Promise<T | "stuck"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"stuck">((resolve) => {
    timer = setTimeout(() => resolve("stuck"), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A socket stand-in that keeps what the actor sends. */
function connect(actor: RoomActor, who: Member, role: "dm" | "player" = "dm"): { conn: Connection; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: ROOM, memberId: who.id, role }, "203.0.113.9");
  actor.attach(conn);
  return { conn, sent };
}

async function answerTo(sent: ServerMessage[], n: number): Promise<Extract<ServerMessage, { t: "ev" }> | "stuck"> {
  const found = (): Extract<ServerMessage, { t: "ev" }> | undefined =>
    sent.find((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev" && ((m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false)));
  return within(
    2_000,
    (async () => {
      for (;;) {
        const ev = found();
        if (ev) return ev;
        await new Promise((r) => setTimeout(r, 5));
      }
    })(),
  );
}

describe("room actor commits", () => {
  test("a lost COMMIT answer is read back until the read works, and the batch is never written twice", async () => {
    const dm = member("DM", "dm");
    const db = new FakeDb({ state: createInitialState({ roomName: "Lost answer", dm }), dmGrants: [dm.id] });
    // The first COMMIT is applied but its answer is lost, then the first read-back fails too.
    db.hooks.commit = (n) => {
      if (n === 1) throw new Error("Connection terminated unexpectedly");
    };
    db.hooks.verify = (n) => {
      if (n === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    };
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const joined = actor.sys({ t: "sys.memberJoin", member: { id: uuidv7(), name: "Pip", color: "#336699", kind: "player", createdAt: new Date().toISOString() } });
      assert.equal(await within(2_000, joined.then(() => "durable")), "durable");
      assert.equal(db.inserts, 1);
      assert.equal(db.verifies, 2);
      assert.equal(actor.committed.seq, 1);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("server-built ops", () => {
  test("one the protocol schema refuses is refused before it applies, since replay would stop on it", async () => {
    const dm = member("DM", "dm");
    const db = new FakeDb({ state: createInitialState({ roomName: "Checked", dm }), dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    const join = (name: string) =>
      actor.sys({ t: "sys.memberJoin", member: { id: uuidv7(), name, color: "#336699", kind: "player", createdAt: new Date().toISOString() } });
    try {
      for (const name of ["Sa\u2028m", "Sa\u2029m"]) {
        await assert.rejects(join(name), (err: unknown) => err instanceof SysOpRefused && err.code === "invalid");
      }
      assert.equal(db.inserts, 0);
      assert.equal(actor.committed.seq, 0);
      await join("Sam");
      assert.equal(actor.committed.seq, 1);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("replaying ops from before a rule tightened", () => {
  test("an Exhaustion level out of 1 to 6, stored before new ops were held to it, replays as it applied then", async () => {
    const dm = member("DM", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const target = { tokenId };
    const row = (seq: number, op: unknown) => ({ seq: String(seq), at: new Date(), actor_member_id: dm.id, actor_role: "dm", op, op_version: 2 });
    const opRows = [
      row(1, { t: "actor.effect.add", target, effect: { id: "x", key: "exhaustion", level: 7 } }),
      row(2, { t: "actor.effect.add", target, effect: { id: "y", key: "exhaustion", level: 0 } }),
      row(3, { t: "actor.effect.update", target, effectId: "x", patch: { level: null } }),
    ];
    const db = new FakeDb({ state, opRows, dmGrants: [dm.id] });
    try {
      const actor = await within(2_000, RoomActor.load(deps(db)));
      assert.ok(actor !== "stuck" && actor !== null, "the load finished");
      assert.equal(actor.replayFailed, false);
      const goblin = actor.committed.state.tokens[tokenId]!.actor;
      assert.deepEqual("inline" in goblin ? goblin.inline.effects.map((e) => [e.id, e.level]) : null, [["x", undefined], ["y", 0]]);
      // A new op is held to the rule, where it arrives.
      const table = connect(actor, dm);
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(table.conn, 1, { t: "actor.effect.add", target, effect: { id: "z", key: "exhaustion", level: 7 } });
      const answer = await answerTo(table.sent, 1);
      assert.ok(answer !== "stuck");
      assert.deepEqual(answer.rejects, [{ n: 1, code: "invalid", message: "Exhaustion is level 1 to 6" }]);
      await actor.shutdown({ code: 1012, snapshot: false });
    } finally {
      db.freeze();
    }
  });
});

describe("a room whose replay failed", () => {
  test("loads without waiting on a relabel it cannot write, and refuses roster changes", async () => {
    const dm = member("Former DM", "dm");
    // No DM grant is left, so loading would relabel this member, which needs a write.
    const db = new FakeDb({ state: createInitialState({ roomName: "Broken", dm }), opRows: [brokenRow(dm)], dmGrants: [] });
    try {
      const actor = await within(2_000, RoomActor.load(deps(db)));
      assert.ok(actor !== "stuck" && actor !== null, "the load finished");
      assert.equal(actor.replayFailed, true);
      assert.equal(actor.committed.state.members[dm.id]?.kind, "dm");
      await assert.rejects(
        actor.sys({ t: "sys.memberJoin", member: { id: uuidv7(), name: "Pip", color: "#336699", kind: "player", createdAt: new Date().toISOString() } }),
        RoomReplayFailed,
      );
      assert.equal(db.inserts, 0);
      await actor.shutdown({ code: 1012, snapshot: false });
    } finally {
      db.freeze();
    }
  });

  test("refuses deletions too, which only a room at its storage quota accepts", async () => {
    const dm = member("DM", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const db = new FakeDb({ state, opRows: [brokenRow(dm)], dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(conn, 1, { t: "token.delete", tokenId });
      const ev = await answerTo(sent, 1);
      assert.notEqual(ev, "stuck");
      assert.equal(ev !== "stuck" && ev.rejects?.[0]?.code, "quota");
      assert.equal(db.inserts, 0);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a room at its storage quota still takes a Withdraw and a Dismiss of an ask for saves, but no new ask (docs/design-v1-player-save-spell.md 5.4)", async () => {
    const dm = member("DM", "dm");
    const pc = member("Thorn's player", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[pc.id] = pc;
    const sceneId = state.meta.playerSceneId!;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [pc.id] };
    const at = new Date().toISOString();
    const ask = (id: string) => ({ id, rev: 1, by: pc.id, caster: tokenId, sceneId, spell: "Fireball", targets: [tokenId], at });
    state.casts = { k1: ask("k1"), k2: ask("k2") };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db, { readOnly: true }));
    assert.ok(actor);
    try {
      const player = connect(actor, pc, "player");
      await actor.hello(player.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(player.conn, 1, { t: "cast.close", castId: "k1", end: "withdrawn" });
      const withdrawn = await answerTo(player.sent, 1);
      assert.ok(withdrawn !== "stuck" && withdrawn.rejects === undefined);
      await actor.op(player.conn, 2, { t: "cast.ask", cast: { id: "k3", caster: tokenId, sceneId, spell: "Fireball", targets: [tokenId] } });
      const asked = await answerTo(player.sent, 2);
      assert.equal(asked !== "stuck" && asked.rejects?.[0]?.code, "quota");
      const desk = connect(actor, dm);
      await actor.hello(desk.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(desk.conn, 1, { t: "cast.close", castId: "k2", end: "dismissed" });
      const dismissed = await answerTo(desk.sent, 1);
      assert.ok(dismissed !== "stuck" && dismissed.rejects === undefined);
      assert.deepEqual(actor.committed.state.casts, {});
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("while a room at its storage quota still takes the deletion", async () => {
    const dm = member("DM", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db, { readOnly: true }));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(conn, 1, { t: "token.delete", tokenId });
      const ev = await answerTo(sent, 1);
      assert.notEqual(ev, "stuck");
      assert.equal(ev !== "stuck" && ev.rejects, undefined);
      assert.equal(actor.committed.state.tokens[tokenId], undefined);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  // The players' scene is deleted only once they are moved, so a full room refused the move and could never delete it (LP9F-1).
  test("while a room at its storage quota still moves its players, so the scene they left can be deleted", async () => {
    const dm = member("DM", "dm");
    const { state } = roomWithGoblin(dm);
    const first = state.meta.playerSceneId!;
    const road = uuidv7();
    const made = applyOp(state, { t: "scene.create", scene: { id: road, name: "Road", bounds: { w: 10, h: 10 } } }, { memberId: dm.id, role: "dm" }, { seq: 2, at: new Date().toISOString() });
    assert.ok(made.ok);
    const db = new FakeDb({ state: made.state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db, { readOnly: true }));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(conn, 1, { t: "scene.delete", sceneId: first });
      const refused = await answerTo(sent, 1);
      assert.ok(refused !== "stuck");
      assert.deepEqual(refused.rejects, [{ n: 1, code: "invalid", message: MOVE_PLAYERS_FIRST }]);
      await actor.op(conn, 2, { t: "room.setPlayerScene", sceneId: road });
      const moved = await answerTo(sent, 2);
      assert.ok(moved !== "stuck");
      assert.equal(moved.rejects, undefined, "the move was refused");
      await actor.op(conn, 3, { t: "scene.delete", sceneId: first });
      const deleted = await answerTo(sent, 3);
      assert.ok(deleted !== "stuck");
      assert.equal(deleted.rejects, undefined, "the delete was refused");
      assert.equal(actor.committed.state.meta.playerSceneId, road);
      assert.equal(actor.committed.state.scenes[first], undefined);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("op admission", () => {
  test("an op over its rate is turned away before its asset lookup reaches the database", async () => {
    const dm = member("DM", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      const image = { assetId: "0192f0aa-0000-4000-8000-000000000001", crop: { cx: 0, cy: 0, zoom: 1 } };
      await actor.op(conn, 1, { t: "token.update", tokenId, patch: { image } });
      assert.equal(db.assetLookups, 1);
      // Spend the socket's whole burst, as a flood would.
      while (conn.opRate.allow()) {
        // spent
      }
      await actor.op(conn, 2, { t: "token.update", tokenId, patch: { image } });
      assert.equal(db.assetLookups, 1);
      assert.deepEqual(sent.at(-1), { t: "retry", n: 2, code: "busy" });
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a page left open across the dragon turtle's rename places, saves and pictures it under the new id, which the room stores and loads again", async () => {
    const OLD = "dragon-tur-t-le";
    const NEW = "dragon-turtle";
    const dm = member("DM", "dm");
    const initial = createInitialState({ roomName: "Shell", dm });
    const db = new FakeDb({ state: initial, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      const tokenId = uuidv7();
      const entryId = uuidv7();
      const encounterId = uuidv7();
      const picture = { icon: "lorc/turtle", color: "#30a46c" };
      const stale: Op[] = [
        { t: "token.create", token: { id: tokenId, sceneId: initial.meta.playerSceneId!, kind: "monster", name: "Dragon Turtle", size: "gargantuan", x: 1, y: 1, actor: { inline: { ...inline, srdId: OLD } } } },
        { t: "savedEncounter.create", encounter: { id: encounterId, name: "Shell game", monsters: [{ srdId: OLD, count: 2 }] } },
        { t: "monster.setSrdImage", srdId: OLD, image: picture },
        { t: "encounter.start", entries: [{ id: entryId, tokenId, groupKey: OLD }] },
      ];
      for (const [i, op] of stale.entries()) {
        await actor.op(conn, i + 1, op);
        const answer = await answerTo(sent, i + 1);
        assert.ok(answer !== "stuck" && answer.acks?.includes(i + 1), `${op.t} is applied`);
      }
      const state = actor.committed.state;
      // A row's group key is kept as sent, which the tracker reads as today's id (rowGroup), so only it holds the old id.
      const { encounter, encounterHistory: _history, ...rest } = state;
      assert.equal(JSON.stringify(rest).includes(OLD), false);
      assert.deepEqual(state.tokens[tokenId]?.actor, { inline: { ...inline, srdId: NEW } });
      assert.deepEqual(state.savedEncounters[encounterId]?.monsters, [{ srdId: NEW, count: 2 }]);
      assert.deepEqual(Object.keys(state.srdImages), [NEW]);
      assert.equal(state.srdImages[NEW]?.id, NEW);
      assert.equal(encounter?.entries[0]?.groupKey, OLD);
      const storedOps = db.storedRows.map((row) => (row as { op: Op }).op);
      assert.equal(JSON.stringify(storedOps.filter((op) => op.t !== "encounter.start")).includes(OLD), false, "no other stored op names the old id");
      assert.ok(db.storedRows.every((row) => (row as { op_version: number }).op_version === OP_VERSION));

      // The fight's undo and redo take it back and bring it again under the id it was stored with.
      await actor.op(conn, 5, { t: "undo" });
      const undone = await answerTo(sent, 5);
      assert.ok(undone !== "stuck" && undone.acks?.includes(5));
      assert.equal(actor.committed.state.encounter, null);
      await actor.op(conn, 6, { t: "redo" });
      const redone = await answerTo(sent, 6);
      assert.ok(redone !== "stuck" && redone.acks?.includes(6));

      const reasons: string[] = [];
      const reloaded = new FakeDb({ state: initial, opRows: db.storedRows, dmGrants: [dm.id] });
      const loaded = await loadRoom(reloaded.pool(), ROOM, (_seq, reason) => reasons.push(reason));
      assert.deepEqual(reasons, []);
      assert.equal(loaded?.replayFailed, false);
      assert.deepEqual(loaded?.state, actor.committed.state);
      assert.deepEqual(loaded?.state.srdImages[NEW]?.image, picture);
      assert.equal(loaded?.state.encounter?.entries[0]?.groupKey, OLD);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("handout pages (docs/design-v1-pdf-handouts.md 3.1)", () => {
  /** A room with two handout images and a map, by id. */
  function handoutRoom() {
    const dm = member("DM", "dm");
    const state = createInitialState({ roomName: "Handouts", dm });
    const ids = { first: uuidv7(), second: uuidv7(), map: uuidv7() };
    const row = (id: string, kind: string, width: number, height: number) => ({ id, room_id: ROOM, kind, width, height, uploaders: [dm.id] });
    const assetRows = [row(ids.first, "handout", 1584, 2048), row(ids.second, "handout", 2048, 1448), row(ids.map, "map", 4096, 4096)];
    return { dm, ids, db: new FakeDb({ state, dmGrants: [dm.id], assetRows }) };
  }
  const page = (assetId: string, width = 1, height = 1) => ({ assetId, width, height });

  test("a show of pages takes each page's size from its row, whatever the client sent", async () => {
    const { dm, ids, db } = handoutRoom();
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      const pages = [page(ids.first, 9, 9), page(ids.second), page(ids.first, 8192, 1)];
      await actor.op(conn, 1, { t: "handout.show", handout: { id: "h1", pages, title: "Strange letter", to: "all" } });
      const ev = await answerTo(sent, 1);
      assert.ok(ev !== "stuck" && ev.rejects === undefined);
      const shown = actor.committed.state.handouts.h1;
      assert.equal(shown?.assetId, ids.first);
      assert.deepEqual(shown?.pages, [page(ids.first, 1584, 2048), page(ids.second, 2048, 1448), page(ids.first, 1584, 2048)]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a page with no row, or a row of another kind, keeps the client's size and the show is refused as not here", async () => {
    const { dm, ids, db } = handoutRoom();
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      for (const [n, other] of [[1, uuidv7()], [2, ids.map]] as const) {
        await actor.op(conn, n, { t: "handout.show", handout: { id: `h${n}`, pages: [page(ids.first), page(other)], title: "Strange letter", to: "all" } });
        const ev = await answerTo(sent, n);
        assert.ok(ev !== "stuck");
        assert.equal(ev.rejects?.[0]?.code, "gone");
      }
      assert.deepEqual(actor.committed.state.handouts, {});
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a saved document takes each page's size from its row too", async () => {
    const { dm, ids, db } = handoutRoom();
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(conn, 1, { t: "handoutDoc.create", doc: { id: "d1", title: "Strange letter", pages: [page(ids.second, 3, 3), page(ids.first)] } });
      const ev = await answerTo(sent, 1);
      assert.ok(ev !== "stuck" && ev.rejects === undefined);
      assert.deepEqual(actor.committed.state.handoutDocs.d1?.pages, [page(ids.second, 2048, 1448), page(ids.first, 1584, 2048)]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a room at its storage quota deletes a document but saves none (docs/design-v1-pdf-handouts.md 3.3)", async () => {
    const { dm, ids, db } = handoutRoom();
    db.snapshot.state.handoutDocs.d1 = { id: "d1", rev: 0, title: "Strange letter", pages: [page(ids.first, 1584, 2048)], createdAt: new Date().toISOString() };
    const actor = await RoomActor.load(deps(db, { readOnly: true }));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(conn, 1, { t: "handoutDoc.create", doc: { id: "d2", title: "Map pack", pages: [page(ids.second)] } });
      const refused = await answerTo(sent, 1);
      assert.ok(refused !== "stuck");
      assert.equal(refused.rejects?.[0]?.code, "quota");
      await actor.op(conn, 2, { t: "handoutDoc.delete", docId: "d1" });
      const taken = await answerTo(sent, 2);
      assert.ok(taken !== "stuck" && taken.rejects === undefined);
      assert.deepEqual(actor.committed.state.handoutDocs, {});
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a show past the room's handout pages says that showing counts a document's pages again, and a save past them says what frees some", async () => {
    const { dm, ids, db } = handoutRoom();
    const full = Array.from({ length: LIMITS.handoutPages }, () => page(ids.first, 1584, 2048));
    for (let i = 0; i < LIMITS.handoutPagesPerRoom / LIMITS.handoutPages; i++) {
      db.snapshot.state.handoutDocs[`d${i}`] = { id: `d${i}`, rev: 0, title: "Strange letter", pages: full, createdAt: new Date().toISOString() };
    }
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(conn, 1, { t: "handout.show", handout: { id: "h1", pages: [page(ids.second)], title: "Strange letter", to: "all" } });
      const shown = await answerTo(sent, 1);
      assert.ok(shown !== "stuck");
      assert.deepEqual(shown.rejects, [{ n: 1, code: "quota", message: `${HANDOUT_PAGES_FULL}. ${SHOWING_COUNTS_AGAIN}` }]);
      await actor.op(conn, 2, { t: "handoutDoc.create", doc: { id: "d99", title: "Map pack", pages: [page(ids.second)] } });
      const saved = await answerTo(sent, 2);
      assert.ok(saved !== "stuck");
      assert.deepEqual(saved.rejects, [{ n: 2, code: "quota", message: HANDOUT_PAGES_FULL }]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("undo", () => {
  test("a brush stroke sent in several ops under one undo group undoes in one step", async () => {
    const dm = member("DM", "dm");
    const state = createInitialState({ roomName: "Strokes", dm });
    const sceneId = state.meta.playerSceneId!;
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      // A stroke across two chunks, flushed three times.
      await actor.op(conn, 1, { t: "build.paint", sceneId, terrain: "stone", cells: ["1,1"] }, "stroke");
      await actor.op(conn, 2, { t: "build.paint", sceneId, terrain: "stone", cells: ["2,1", "3,1"] }, "stroke");
      await actor.op(conn, 3, { t: "build.paint", sceneId, terrain: "stone", cells: ["17,1"] }, "stroke");
      assert.notEqual(await answerTo(sent, 3), "stuck");
      assert.equal(Object.keys(actor.committed.state.buildChunks).length, 2);
      await actor.op(conn, 4, { t: "undo" });
      const undone = await answerTo(sent, 4);
      assert.ok(undone !== "stuck" && undone.acks?.includes(4));
      assert.deepEqual(actor.committed.state.buildChunks, {});
      await actor.op(conn, 5, { t: "undo" });
      const empty = await answerTo(sent, 5);
      assert.ok(empty !== "stuck" && empty.rejects?.[0]?.message === "nothing to undo");
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a folder of one scene renamed from its header undoes as the rename, and Move to folder as a move", async () => {
    const dm = member("DM", "dm");
    const state = createInitialState({ roomName: "Folders", dm });
    const sceneId = state.meta.playerSceneId!;
    state.scenes[sceneId] = { ...state.scenes[sceneId]!, name: "Crypt", folder: "Act one" };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      // As the Scenes panel sends a rename (client/features/scenes/folders.ts sendFolderRename): one op, under a group.
      await actor.op(conn, 1, { t: "scene.update", sceneId, patch: { folder: "Act two" } }, "rename");
      await actor.op(conn, 2, { t: "undo" });
      const renamed = await answerTo(sent, 2);
      assert.ok(renamed !== "stuck");
      assert.deepEqual(renamed.restored, [{ n: 2, what: "renaming the folder Act one to Act two" }]);
      // "Move to folder" sends the same op alone, and reads as the move it is.
      await actor.op(conn, 3, { t: "scene.update", sceneId, patch: { folder: "Act two" } });
      await actor.op(conn, 4, { t: "undo" });
      const moved = await answerTo(sent, 4);
      assert.ok(moved !== "stuck");
      assert.deepEqual(moved.restored, [{ n: 4, what: "moving the scene Crypt to the folder Act two" }]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("an encounter placed as one gesture undoes in one step, named for every token it added", async () => {
    const dm = member("DM", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const sceneId = state.meta.playerSceneId!;
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      await actor.op(conn, 1, { t: "encounter.start", entries: [{ id: uuidv7(), tokenId, value: 12 }] });
      // As the encounter builder sends it (client/features/encounters/drop.ts): the tokens, then their rows.
      const placed = [uuidv7(), uuidv7(), uuidv7()];
      let n = 2;
      for (const [i, id] of placed.entries()) {
        await actor.op(conn, n++, { t: "token.create", token: { id, sceneId, kind: "monster", name: "Wolf", size: "medium", x: 3 + i, y: 3, actor: { inline } } }, "drop");
      }
      await actor.op(conn, n++, { t: "encounter.add", entries: placed.map((id) => ({ id: uuidv7(), tokenId: id })) }, "drop");
      assert.notEqual(await answerTo(sent, n - 1), "stuck");
      assert.equal(actor.committed.state.encounter?.entries.length, 4);
      await actor.op(conn, n, { t: "undo" });
      const undone = await answerTo(sent, n);
      assert.ok(undone !== "stuck");
      assert.deepEqual(undone.restored, [{ n, what: "adding 3 tokens" }]);
      assert.deepEqual(Object.keys(actor.committed.state.tokens), [tokenId]);
      assert.equal(actor.committed.state.encounter?.entries.length, 1);
      await actor.op(conn, n + 1, { t: "redo" });
      const redone = await answerTo(sent, n + 1);
      assert.ok(redone !== "stuck");
      assert.deepEqual(redone.restored, [{ n: n + 1, what: "adding 3 tokens" }]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("undo answers", () => {
  test("undos of one token chain, say what they took back, and a refusal names the step", async () => {
    const dm = member("DM", "dm");
    const other = member("Laptop", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const db = new FakeDb({ state, dmGrants: [dm.id, other.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, dm);
      const laptop = connect(actor, other);
      await actor.hello(phone.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(laptop.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 2, y: 2 });
      await actor.op(phone.conn, 2, { t: "token.update", tokenId, patch: { name: "Snik" } });
      await actor.op(phone.conn, 3, { t: "token.move", tokenId, x: 3, y: 3 });
      await actor.op(phone.conn, 4, { t: "undo" });
      await actor.op(phone.conn, 5, { t: "undo" });
      const second = await answerTo(phone.sent, 5);
      assert.ok(second !== "stuck");
      const restored = phone.sent.flatMap((m) => (m.t === "ev" ? (m.restored ?? []) : []));
      assert.deepEqual(restored, [
        { n: 4, what: "moving Snik" },
        { n: 5, what: "renaming Goblin to Snik" },
      ]);
      assert.deepEqual([actor.committed.state.tokens[tokenId]!.name, actor.committed.state.tokens[tokenId]!.x], ["Goblin", 2]);
      // The laptop moves it, so the phone's first move is no longer its to take back.
      await actor.op(laptop.conn, 1, { t: "token.move", tokenId, x: 9, y: 9 });
      assert.notEqual(await answerTo(laptop.sent, 1), "stuck");
      await actor.op(phone.conn, 6, { t: "undo" });
      const refused = await answerTo(phone.sent, 6);
      assert.ok(refused !== "stuck");
      assert.deepEqual(refused.rejects, [{ n: 6, code: "invalid", message: "could not undo moving Goblin: it was changed since" }]);
      assert.equal(refused.restored, undefined);
      assert.equal(laptop.sent.some((m) => m.t === "ev" && m.restored), false, "only the member who undid hears what");
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("a player's undo of a drawing on a scene the players have left answers that it is not here, whether the scene is still there or not", async () => {
    const dm = member("DM", "dm");
    const ayla = member("Ayla", "player");
    const bram = member("Bram", "player");
    const { state } = roomWithGoblin(dm);
    state.members[ayla.id] = ayla;
    state.members[bram.id] = bram;
    const mat = state.meta.playerSceneId!;
    const cave = uuidv7();
    const made = applyOp(state, { t: "scene.create", scene: { id: cave, name: "Cave", bounds: { w: 10, h: 10 } } }, { memberId: dm.id, role: "dm" }, { seq: 2, at: new Date().toISOString() });
    assert.ok(made.ok);
    const db = new FakeDb({ state: made.state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phones = [connect(actor, ayla, "player"), connect(actor, bram, "player")];
      await actor.hello(table.conn, { clientId: "dm", resumeFrom: 1 });
      const drawings: string[] = [];
      for (const [i, phone] of phones.entries()) {
        const who = i === 0 ? ayla : bram;
        const id = uuidv7();
        drawings.push(id);
        await actor.hello(phone.conn, { clientId: who.name, resumeFrom: 1 });
        const drawing = { id, sceneId: mat, kind: "line" as const, points: [1, 1, 2, 2], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: who.id, visibility: "all" as const };
        await actor.op(phone.conn, 1, { t: "drawing.create", drawing });
        await actor.op(phone.conn, 2, { t: "drawing.delete", drawingId: id });
        assert.notEqual(await answerTo(phone.sent, 2), "stuck");
      }
      // The players move on, and the scene they drew on stays for Ayla's undo and is deleted before Bram's.
      await actor.op(table.conn, 1, { t: "room.setPlayerScene", sceneId: cave });
      assert.notEqual(await answerTo(table.sent, 1), "stuck");
      await actor.op(phones[0]!.conn, 3, { t: "undo" });
      const kept = await answerTo(phones[0]!.sent, 3);
      await actor.op(table.conn, 2, { t: "scene.delete", sceneId: mat });
      assert.notEqual(await answerTo(table.sent, 2), "stuck");
      await actor.op(phones[1]!.conn, 3, { t: "undo" });
      const deleted = await answerTo(phones[1]!.sent, 3);
      for (const answer of [kept, deleted]) {
        assert.ok(answer !== "stuck");
        assert.deepEqual(answer.rejects, [{ n: 3, code: "gone", message: "could not undo erasing a drawing: that is not here" }]);
      }
      assert.deepEqual(drawings.map((id) => actor.committed.state.drawings[id]), [undefined, undefined]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("taking an HP change back from the log", () => {
  test("the DM takes back anyone's change from its line, once, and a change since refuses it", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.meta.settings.playersApplyDamage = true;
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      const goblinHp = () => {
        const a = actor.committed.state.tokens[tokenId]!.actor;
        return "inline" in a ? a.inline.hp.cur : -1;
      };
      const lastHpLine = () => [...actor.committed.state.log].reverse().find((e) => e.data?.type === "hp" && !e.data.back)!.id;
      await actor.op(phone.conn, 1, { t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 3 } });
      assert.notEqual(await answerTo(phone.sent, 1), "stuck");
      const line = lastHpLine();
      await actor.op(phone.conn, 2, { t: "undo", log: line });
      const forbidden = await answerTo(phone.sent, 2);
      assert.ok(forbidden !== "stuck");
      assert.deepEqual(forbidden.rejects, [{ n: 2, code: "forbidden", message: "only the DM takes back a change from the log" }]);
      await actor.op(table.conn, 1, { t: "undo", log: line });
      const undone = await answerTo(table.sent, 1);
      assert.ok(undone !== "stuck");
      assert.deepEqual(undone.restored, [{ n: 1, what: "damaging Goblin" }]);
      assert.equal(goblinHp(), 7);
      // A change taken back from the log goes on no stack: Redo would put it back with no line to say so.
      await actor.op(table.conn, 2, { t: "redo" });
      const redone = await answerTo(table.sent, 2);
      assert.ok(redone !== "stuck");
      assert.deepEqual(redone.rejects, [{ n: 2, code: "invalid", message: "nothing to redo" }]);
      assert.equal(goblinHp(), 7);
      await actor.op(table.conn, 3, { t: "undo" });
      const undone3 = await answerTo(table.sent, 3);
      assert.ok(undone3 !== "stuck");
      assert.deepEqual(undone3.rejects, [{ n: 3, code: "invalid", message: "nothing to undo" }]);
      assert.equal(goblinHp(), 7);
      await actor.op(table.conn, 4, { t: "undo", log: line });
      const twice = await answerTo(table.sent, 4);
      assert.ok(twice !== "stuck");
      assert.deepEqual(twice.rejects, [{ n: 4, code: "invalid", message: "could not undo damaging Goblin: it was already taken back" }]);
      // Two more hits: the older one is no longer what the goblin holds.
      await actor.op(table.conn, 5, { t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 2 } });
      assert.notEqual(await answerTo(table.sent, 5), "stuck");
      const older = lastHpLine();
      await actor.op(table.conn, 6, { t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 1 } });
      assert.notEqual(await answerTo(table.sent, 6), "stuck");
      await actor.op(table.conn, 7, { t: "undo", log: older });
      const changed = await answerTo(table.sent, 7);
      assert.ok(changed !== "stuck");
      assert.deepEqual(changed.rejects, [{ n: 7, code: "invalid", message: "could not undo damaging Goblin: it was changed since" }]);
      assert.equal(goblinHp(), 4);
      const restores = db.storedOps.filter((op) => (op as { t: string }).t === "sys.restore") as { undid?: string; deps?: boolean }[];
      assert.ok(restores.some((op) => op.undid === line && op.deps === true), "the stored restore names its line");
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("a condition the DM hid", () => {
  test("gets the owner the same refusal, code and words alike, as a condition that is not there", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    const goblin = state.tokens[tokenId]!;
    const actorOf = goblin.actor as { inline: Actor };
    state.tokens[tokenId] = { ...goblin, ownerIds: [player.id], actor: { inline: { ...actorOf.inline, effects: [{ id: "secret", key: "poisoned", hiddenFromPlayers: true }] } } };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, player, "player");
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      const refusal = async (n: number, effectId: string, op: "update" | "remove") => {
        const target = { tokenId };
        await actor.op(phone.conn, n, op === "update" ? { t: "actor.effect.update", target, effectId, patch: { level: 2 } } : { t: "actor.effect.remove", target, effectId });
        const answer = await answerTo(phone.sent, n);
        assert.ok(answer !== "stuck");
        return answer.rejects?.map((r) => ({ code: r.code, message: r.message }));
      };
      assert.deepEqual(await refusal(1, "secret", "update"), await refusal(2, "removed", "update"));
      assert.deepEqual(await refusal(3, "secret", "remove"), await refusal(4, "removed", "remove"));
      assert.deepEqual(await refusal(5, "secret", "remove"), [{ code: "gone", message: "that is not here" }]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("a player's undo", () => {
  test("takes back their own move alone, keeps damage dealt since, and refuses once someone moved the token", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [player.id] };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 5, y: 5 });
      await actor.op(table.conn, 1, { t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 3 } });
      assert.notEqual(await answerTo(table.sent, 1), "stuck");
      await actor.op(phone.conn, 2, { t: "undo" });
      const undone = await answerTo(phone.sent, 2);
      assert.ok(undone !== "stuck");
      assert.deepEqual(undone.restored, [{ n: 2, what: "moving Goblin" }]);
      const goblin = () => actor.committed.state.tokens[tokenId]!;
      assert.deepEqual([goblin().x, goblin().y], [1, 1]);
      const hurt = goblin().actor;
      assert.equal("inline" in hurt && hurt.inline.hp.cur, 4);
      await actor.op(phone.conn, 3, { t: "redo" });
      assert.notEqual(await answerTo(phone.sent, 3), "stuck");
      assert.deepEqual([goblin().x, goblin().y], [5, 5]);
      // The DM moves it on, so the player's move is no longer theirs to take back.
      await actor.op(phone.conn, 4, { t: "undo" });
      await actor.op(phone.conn, 5, { t: "redo" });
      await actor.op(table.conn, 2, { t: "token.move", tokenId, x: 8, y: 8 });
      assert.notEqual(await answerTo(table.sent, 2), "stuck");
      await actor.op(phone.conn, 6, { t: "undo" });
      const refused = await answerTo(phone.sent, 6);
      assert.ok(refused !== "stuck");
      assert.deepEqual(refused.rejects, [{ n: 6, code: "invalid", message: "could not undo moving Goblin: it was moved or resized since" }]);
      assert.deepEqual([goblin().x, goblin().y], [8, 8]);
      const restores = db.storedOps.filter((op) => (op as { t: string }).t === "sys.restore");
      assert.ok(restores.length >= 3 && restores.every((op) => (op as { deps?: boolean }).deps === true));
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("takes back their own change of elevation after a move on its own, then the move", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [player.id] };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, player, "player");
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      const goblin = () => actor.committed.state.tokens[tokenId]!;
      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 5, y: 5 });
      await actor.op(phone.conn, 2, { t: "token.update", tokenId, patch: { elevation: 10 } });
      await actor.op(phone.conn, 3, { t: "undo" });
      const first = await answerTo(phone.sent, 3);
      assert.ok(first !== "stuck");
      assert.deepEqual(first.restored, [{ n: 3, what: "changing Goblin" }]);
      assert.deepEqual([goblin().x, goblin().y, goblin().elevation], [5, 5, 0]);
      await actor.op(phone.conn, 4, { t: "undo" });
      const second = await answerTo(phone.sent, 4);
      assert.ok(second !== "stuck");
      assert.deepEqual(second.restored, [{ n: 4, what: "moving Goblin" }]);
      assert.deepEqual([goblin().x, goblin().y, goblin().elevation], [1, 1, 0]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("the bar's undos walk a drag and its height changes back one step at a time, each named by its op", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [player.id] };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, player, "player");
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      const goblin = () => actor.committed.state.tokens[tokenId]!;
      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 5, y: 5 });
      for (const [n, elevation] of [[2, 5], [3, 10], [4, 15]] as const) await actor.op(phone.conn, n, { t: "token.update", tokenId, patch: { elevation } });
      for (const [n, of, after] of [[5, 4, [5, 5, 10]], [6, 3, [5, 5, 5]], [7, 2, [5, 5, 0]], [8, 1, [1, 1, 0]]] as const) {
        await actor.op(phone.conn, n, { t: "undo", of });
        const answer = await answerTo(phone.sent, n);
        assert.ok(answer !== "stuck" && answer.restored?.length === 1, `the undo of op ${of}`);
        assert.deepEqual([goblin().x, goblin().y, goblin().elevation], after);
      }
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("takes back their own change of elevation on a locked token, which they may make", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [player.id], locked: true };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, player, "player");
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(phone.conn, 1, { t: "token.update", tokenId, patch: { elevation: 10 } });
      await actor.op(phone.conn, 2, { t: "undo" });
      const undone = await answerTo(phone.sent, 2);
      assert.ok(undone !== "stuck");
      assert.deepEqual(undone.restored, [{ n: 2, what: "changing Goblin" }]);
      assert.equal(actor.committed.state.tokens[tokenId]!.elevation, 0);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("an undo meant for one move takes back that move or nothing, whatever this or another device did since", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [player.id] };
    const other = uuidv7();
    state.tokens[other] = { ...state.tokens[tokenId]!, id: other, name: "Wolf" };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, player, "player");
      const laptop = connect(actor, player, "player");
      await actor.hello(phone.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(laptop.conn, { clientId: "c2", resumeFrom: 1 });
      const at = (id: string) => [actor.committed.state.tokens[id]!.x, actor.committed.state.tokens[id]!.y];
      const notNewest = { code: "invalid", message: "could not undo that move: it is no longer your newest change" };

      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 5, y: 5 });
      await actor.op(phone.conn, 2, { t: "token.move", tokenId: other, x: 6, y: 6 });
      await actor.op(phone.conn, 3, { t: "undo" });
      assert.notEqual(await answerTo(phone.sent, 3), "stuck");
      assert.deepEqual(at(other), [1, 1]);
      // The Wolf's bar still offered its move: the Goblin's stays where it is.
      await actor.op(phone.conn, 4, { t: "undo", of: 2 });
      const stale = await answerTo(phone.sent, 4);
      assert.ok(stale !== "stuck");
      assert.deepEqual(stale.rejects, [{ n: 4, ...notNewest }]);
      assert.deepEqual(at(tokenId), [5, 5]);

      // The laptop's move, under the same op number, is not the phone's.
      await actor.op(laptop.conn, 1, { t: "token.move", tokenId: other, x: 7, y: 7 });
      assert.notEqual(await answerTo(laptop.sent, 1), "stuck");
      await actor.op(phone.conn, 5, { t: "undo", of: 1 });
      const covered = await answerTo(phone.sent, 5);
      assert.ok(covered !== "stuck");
      assert.deepEqual(covered.rejects, [{ n: 5, ...notNewest }]);
      assert.deepEqual(at(other), [7, 7]);

      await actor.op(laptop.conn, 2, { t: "undo", of: 1 });
      const own = await answerTo(laptop.sent, 2);
      assert.ok(own !== "stuck");
      assert.deepEqual(own.restored, [{ n: 2, what: "moving Wolf" }]);
      await actor.op(phone.conn, 6, { t: "undo", of: 1 });
      const first = await answerTo(phone.sent, 6);
      assert.ok(first !== "stuck");
      assert.deepEqual(first.restored, [{ n: 6, what: "moving Goblin" }]);
      assert.deepEqual(at(tokenId), [1, 1]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("refuses once the DM sent the token to another scene, though it stands on the same spot there", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [player.id] };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 5, y: 5 });
      const crypt = uuidv7();
      await actor.op(table.conn, 1, { t: "scene.create", scene: { id: crypt, name: "Crypt", bounds: { w: 30, h: 30 } } });
      await actor.op(table.conn, 2, { t: "token.update", tokenId, patch: { sceneId: crypt } });
      await actor.op(table.conn, 3, { t: "room.setPlayerScene", sceneId: crypt });
      assert.notEqual(await answerTo(table.sent, 3), "stuck");
      await actor.op(phone.conn, 2, { t: "undo" });
      const refused = await answerTo(phone.sent, 2);
      assert.ok(refused !== "stuck");
      assert.deepEqual(refused.rejects, [{ n: 2, code: "invalid", message: "could not undo moving Goblin: it was moved or resized since" }]);
      const goblin = actor.committed.state.tokens[tokenId]!;
      assert.deepEqual([goblin.sceneId, goblin.x, goblin.y], [crypt, 5, 5]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("names a token with a hidden name as the player saw it", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.meta.settings.playersMoveAny = [player.id];
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, name: "Doppelganger", number: 2, nameHidden: true, publicName: "Merchant" };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, player, "player");
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 5, y: 5 });
      await actor.op(phone.conn, 2, { t: "undo" });
      const undone = await answerTo(phone.sent, 2);
      assert.ok(undone !== "stuck");
      assert.deepEqual(undone.restored, [{ n: 2, what: "moving Merchant" }]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("undo and replay", () => {
  test("an undo is stored with the server's mark, so its reference checks apply live and on replay alike", async () => {
    const dm = member("DM", "dm");
    const other = member("Laptop", "dm");
    const db = new FakeDb({ state: createInitialState({ roomName: "Marked", dm }), dmGrants: [dm.id, other.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, dm);
      const laptop = connect(actor, other);
      await actor.hello(phone.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(laptop.conn, { clientId: "c2", resumeFrom: 1 });
      const sceneId = uuidv7();
      await actor.op(phone.conn, 1, { t: "scene.create", scene: { id: sceneId, name: "Crypt", bounds: { w: 30, h: 30 } } });
      assert.notEqual(await answerTo(phone.sent, 1), "stuck");
      const tokenId = uuidv7();
      await actor.op(laptop.conn, 1, { t: "token.create", token: { id: tokenId, sceneId, kind: "monster", name: "Rat", size: "tiny", x: 1, y: 1, actor: { inline } } });
      assert.notEqual(await answerTo(laptop.sent, 1), "stuck");
      // The laptop's token is on the scene, so the phone may not take the scene back.
      await actor.op(phone.conn, 2, { t: "undo" });
      const refused = await answerTo(phone.sent, 2);
      assert.ok(refused !== "stuck");
      assert.match(refused.rejects?.[0]?.message ?? "", /^could not undo .*: other work depends on it$/);
      assert.ok(actor.committed.state.scenes[sceneId]);
      await actor.op(laptop.conn, 2, { t: "undo" });
      const undone = await answerTo(laptop.sent, 2);
      assert.ok(undone !== "stuck" && undone.acks?.includes(2));
      assert.equal(actor.committed.state.tokens[tokenId], undefined);
      const restores = db.storedOps.filter((op) => (op as { t: string }).t === "sys.restore");
      assert.equal(restores.length, 1);
      assert.equal((restores[0] as { deps?: boolean }).deps, true);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("the path of a turn and a player's undo", () => {
  test("the bar's undos take back a mark that a move doesn't count, then the move with its leg, and damage dealt since stays", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, tokenId } = roomWithGoblin(dm);
    state.members[player.id] = player;
    state.tokens[tokenId] = { ...state.tokens[tokenId]!, ownerIds: [player.id] };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(table.conn, 1, { t: "encounter.start", entries: [{ id: uuidv7(), tokenId, value: 12 }] });
      await actor.op(table.conn, 2, { t: "encounter.next" });
      const goblin = () => actor.committed.state.tokens[tokenId]!;
      const legs = () => goblin().path?.stops.map((s) => [s.x, s.y, s.uncounted === true]);
      await actor.op(phone.conn, 1, { t: "token.move", tokenId, x: 5, y: 5 });
      await actor.op(phone.conn, 2, { t: "token.countLeg", tokenId, counts: false });
      await actor.op(table.conn, 3, { t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 3 } });
      assert.notEqual(await answerTo(table.sent, 3), "stuck");
      assert.deepEqual(legs(), [[1, 1, false], [5, 5, true]]);
      await actor.op(phone.conn, 3, { t: "undo", of: 2 });
      const unmarked = await answerTo(phone.sent, 3);
      assert.ok(unmarked !== "stuck");
      assert.deepEqual(unmarked.restored, [{ n: 3, what: "not counting the last move of Goblin" }]);
      assert.deepEqual(legs(), [[1, 1, false], [5, 5, false]]);
      await actor.op(phone.conn, 4, { t: "undo", of: 1 });
      assert.notEqual(await answerTo(phone.sent, 4), "stuck");
      assert.deepEqual([goblin().x, goblin().y, goblin().path], [1, 1, undefined]);
      const hurt = goblin().actor;
      assert.equal("inline" in hurt && hurt.inline.hp.cur, 4);
      await actor.op(phone.conn, 5, { t: "redo" });
      assert.notEqual(await answerTo(phone.sent, 5), "stuck");
      assert.deepEqual(legs(), [[1, 1, false], [5, 5, false]], "a redo puts the leg back with the move");
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("an area's damage", () => {
  test("takes every creature's HP back in one undo, named for how many it hit", async () => {
    const dm = member("DM", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const second = uuidv7();
    state.tokens[second] = { ...state.tokens[tokenId]!, id: second, x: 2, number: 2, actor: { inline: { ...inline, hp: { cur: 7, max: 7, temp: 3 } } } };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      const hp = (id: string) => {
        const a = actor.committed.state.tokens[id]!.actor;
        return "inline" in a ? a.inline.hp : null;
      };
      await actor.op(table.conn, 1, { t: "actor.damageMany", hits: [{ target: { tokenId }, amount: 6 }, { target: { tokenId: second }, amount: 6 }] });
      assert.notEqual(await answerTo(table.sent, 1), "stuck");
      assert.deepEqual([hp(tokenId), hp(second)], [{ cur: 1, max: 7, temp: 0 }, { cur: 4, max: 7, temp: 0 }]);
      await actor.op(table.conn, 2, { t: "undo" });
      const undone = await answerTo(table.sent, 2);
      assert.ok(undone !== "stuck");
      assert.deepEqual(undone.restored, [{ n: 2, what: "damaging 2 creatures" }]);
      assert.deepEqual([hp(tokenId), hp(second)], [{ cur: 7, max: 7, temp: 0 }, { cur: 7, max: 7, temp: 3 }]);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("logs each creature's HP as one change, so the DM takes one back alone, and the area's own undo then refuses", async () => {
    const dm = member("DM", "dm");
    const { state, tokenId } = roomWithGoblin(dm);
    const second = uuidv7();
    state.tokens[second] = { ...state.tokens[tokenId]!, id: second, x: 2, number: 2, actor: { inline: { ...inline, hp: { cur: 7, max: 7, temp: 3 } } } };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      const hp = (id: string) => {
        const a = actor.committed.state.tokens[id]!.actor;
        return "inline" in a ? a.inline.hp : null;
      };
      await actor.op(table.conn, 1, { t: "actor.damageMany", hits: [{ target: { tokenId }, amount: 6 }, { target: { tokenId: second }, amount: 6 }] });
      assert.notEqual(await answerTo(table.sent, 1), "stuck");
      const lineOf = (id: string) => {
        const entry = actor.committed.state.log.find((e) => e.data?.type === "hp" && e.data.tokenId === id && !e.data.back);
        assert.ok(entry?.data?.type === "hp");
        return { id: entry.id, data: entry.data };
      };
      assert.deepEqual([lineOf(tokenId).data.left, lineOf(tokenId).data.revert?.before.hp], [{ cur: 1, max: 7, temp: 0 }, { cur: 7, max: 7, temp: 0 }]);
      assert.deepEqual([lineOf(second).data.left, lineOf(second).data.revert?.before.hp], [{ cur: 4, max: 7, temp: 0 }, { cur: 7, max: 7, temp: 3 }]);
      await actor.op(table.conn, 2, { t: "undo", log: lineOf(second).id });
      const one = await answerTo(table.sent, 2);
      assert.ok(one !== "stuck");
      assert.deepEqual(one.restored, [{ n: 2, what: "damaging Goblin 2" }]);
      assert.deepEqual([hp(tokenId), hp(second)], [{ cur: 1, max: 7, temp: 0 }, { cur: 7, max: 7, temp: 3 }]);
      // The area's step would put back the creature the DM already took back, so it refuses and changes nothing.
      await actor.op(table.conn, 3, { t: "undo" });
      const whole = await answerTo(table.sent, 3);
      assert.ok(whole !== "stuck");
      assert.deepEqual(whole.rejects, [{ n: 3, code: "invalid", message: "could not undo damaging 2 creatures: it was changed since" }]);
      assert.deepEqual([hp(tokenId), hp(second)], [{ cur: 1, max: 7, temp: 0 }, { cur: 7, max: 7, temp: 3 }]);
      // The other creature's line still comes back on its own.
      await actor.op(table.conn, 4, { t: "undo", log: lineOf(tokenId).id });
      const other = await answerTo(table.sent, 4);
      assert.ok(other !== "stuck");
      assert.deepEqual(other.restored, [{ n: 4, what: "damaging Goblin" }]);
      assert.deepEqual(hp(tokenId), { cur: 7, max: 7, temp: 0 });
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("pit traps' walls counted ahead in the limits step (docs/design-v1-traps.md 6.7)", () => {
  test("a pit trap that would take a vision scene past its sight pieces is refused when made, and one without a pit never counts", async () => {
    const dm = member("DM", "dm");
    const state = createInitialState({ roomName: "Pits", dm });
    const sceneId = state.meta.playerSceneId!;
    state.scenes[sceneId] = { ...state.scenes[sceneId]!, bounds: { w: 200, h: 200 }, vision: { on: true, light: "bright" } };
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      let n = 0;
      const send = async (op: Op) => {
        await actor.op(conn, ++n, op);
        const answer = await answerTo(sent, n);
        assert.ok(answer !== "stuck");
        return answer.rejects?.find((r) => r.n === n) ?? null;
      };
      const rig = (pit: boolean) => ({ on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false, ...(pit ? { pit: { floor: -10 } } : {}) });
      // Pits of 20 x 20 squares, set apart so each counts its own rim, until the next is refused.
      let made = 0;
      let refusal = null;
      for (let i = 0; i < 49 && refusal === null; i++) {
        const x = (i % 8) * 24;
        const y = Math.floor(i / 8) * 24;
        refusal = await send({ t: "trap.create", trap: { id: `pit${i}`, sceneId, name: "Pit", zone: { cells: [{ x, y, w: 20, h: 20 }] }, rig: rig(true) } });
        if (refusal === null) made++;
      }
      assert.ok(made > 0 && refusal !== null, `${made} made`);
      assert.equal(refusal.code, "quota");
      assert.match(refusal.message, /more than vision can handle/);
      assert.equal(Object.keys(actor.committed.state.traps).length, made);
      // A plate opens nothing, so it is taken however full the count is.
      assert.equal(await send({ t: "trap.create", trap: { id: "plate", sceneId, name: "Plate", zone: { cells: [{ x: 0, y: 190, w: 20, h: 5 }] }, rig: rig(false) } }), null);
      // Taking a pit away is taken too.
      assert.equal(await send({ t: "trap.update", trapId: "pit0", patch: { rig: { pit: null } } }), null);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("the split's caps in the limits step", () => {
  const wall = (id: number, ax: number, ay: number, bx: number, by: number) => ({ id: `w${String(id).padStart(11, "0")}`, a: [ax, ay] as [number, number], b: [bx, by] as [number, number], f: { kind: "wall" as const } });

  test("a dense pile of free walls in one cell is refused at the op that would make it", async () => {
    const dm = member("DM", "dm");
    const state = createInitialState({ roomName: "Pile", dm });
    const sceneId = state.meta.playerSceneId!;
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      const pile = Array.from({ length: 300 }, (_, k) => wall(k, 10 + (k % 64) / 64, 10, 10 + ((k * 7) % 64) / 64, 11));
      await actor.op(conn, 1, { t: "build.walls", sceneId, put: pile.slice(0, 20) });
      await actor.op(conn, 2, { t: "build.walls", sceneId, put: pile });
      const accepted = await answerTo(sent, 1);
      assert.ok(accepted !== "stuck" && accepted.acks?.includes(1));
      const refused = await answerTo(sent, 2);
      assert.ok(refused !== "stuck");
      assert.deepEqual(refused.rejects, [{ n: 2, code: "quota", message: splitRefusal("pieces") }]);
      const walls = Object.values(actor.committed.state.buildChunks).flatMap((c) => c.walls ?? []);
      assert.equal(walls.length, 20);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("painting, drawing edges and turning automatic walls on are refused when their walls would cross free walls past a cap", async () => {
    const dm = member("DM", "dm");
    const state = createInitialState({ roomName: "Stripes", dm });
    const sceneId = state.meta.playerSceneId!;
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const { conn, sent } = connect(actor, dm);
      await actor.hello(conn, { clientId: "c1", resumeFrom: 1 });
      let n = 0;
      const send = async (op: Parameters<RoomActor["op"]>[2]) => {
        await actor.op(conn, ++n, op);
        const answer = await answerTo(sent, n);
        assert.ok(answer !== "stuck");
        return answer.rejects?.find((r) => r.n === n) ?? null;
      };
      const refused = { code: "quota", message: splitRefusal("pieces") };
      // Two batches of near-vertical free walls, which never meet each other, each a twentieth of the pieces cap.
      const size = LIMITS.splitPiecesPerScene / 20;
      const batch = (y0: number, base: number) => Array.from({ length: size }, (_, k) => wall(base + k, 0.5 + k / 32, y0, 0.5 + k / 32 + 1 / 64, y0 + 7));
      assert.equal(await send({ t: "build.walls", sceneId, put: batch(0.5, 0) }), null);
      assert.equal(await send({ t: "build.walls", sceneId, put: batch(8.5, size) }), null);
      const row = (y: number) => Array.from({ length: 18 }, (_, x) => `${x},${y}`);
      // Rows 1, 3, 5 and 7 painted: walls along y = 1 to 8, seven of them across the first batch, 7 x 2 pieces a wall, 70% of the cap.
      assert.equal(await send({ t: "build.paint", sceneId, terrain: "stone", cells: [1, 3, 5, 7].flatMap(row) }), null);
      // Four more lines across the second batch would add 40% more.
      assert.deepEqual(await send({ t: "build.paint", sceneId, terrain: "stone", cells: [9, 11].flatMap(row) }), { n, ...refused });
      const lines = [9, 10, 11, 12].flatMap((y) => Array.from({ length: 18 }, (_, x) => ({ key: `${x},${y},n`, feature: { kind: "wall" as const } })));
      assert.deepEqual(await send({ t: "build.edge", sceneId, edges: lines }), { n, ...refused });
      // With automatic walls off, the same paint makes no walls, and turning them back on is what is refused.
      assert.equal(await send({ t: "scene.update", sceneId, patch: { autoWalls: "off" } }), null);
      assert.equal(await send({ t: "build.paint", sceneId, terrain: "stone", cells: [9, 11].flatMap(row) }), null);
      assert.deepEqual(await send({ t: "scene.update", sceneId, patch: { autoWalls: "all" } }), { n, ...refused });
      assert.equal(actor.committed.state.scenes[sceneId]!.autoWalls, "off");
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("an undo that would put the scene over a cap says so", async () => {
    const dm = member("DM", "dm");
    const other = member("Laptop", "dm");
    const state = createInitialState({ roomName: "Undo pile", dm });
    const sceneId = state.meta.playerSceneId!;
    const db = new FakeDb({ state, dmGrants: [dm.id, other.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const phone = connect(actor, dm);
      const laptop = connect(actor, other);
      await actor.hello(phone.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(laptop.conn, { clientId: "c2", resumeFrom: 1 });
      // Two families of parallel walls on either side of the chunk border at x = 16. Each alone is fine, together they cross thousands of times.
      const west = Array.from({ length: 150 }, (_, k) => wall(k, 15, 10 + k / 64, 16.5, 10.5 + k / 64));
      const east = Array.from({ length: 150 }, (_, k) => wall(k, 15.5, 10.5 + k / 64, 17, 10 + k / 64));
      await actor.op(phone.conn, 1, { t: "build.walls", sceneId, put: west });
      await actor.op(phone.conn, 2, { t: "build.walls", sceneId, remove: west.map((w) => ({ cx: 0, cy: 0, id: w.id })) });
      await actor.op(laptop.conn, 1, { t: "build.walls", sceneId, put: east });
      const placed = await answerTo(laptop.sent, 1);
      assert.ok(placed !== "stuck" && placed.acks?.includes(1));
      await actor.op(phone.conn, 3, { t: "undo" });
      const undo = await answerTo(phone.sent, 3);
      assert.ok(undo !== "stuck");
      assert.equal(undo.rejects?.[0]?.code, "quota");
      assert.match(undo.rejects?.[0]?.message ?? "", /^could not undo .*: this scene's walls would cross too often: they would split into more than [\d,]+ extra pieces$/);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("the pillar cap in the limits step", () => {
  const W = 60;
  // The kth cell of a 60-wide scene, row by row.
  const cells = (from: number, count: number) => Array.from({ length: count }, (_, k) => `${(from + k) % W},${Math.floor((from + k) / W)}`);
  const refused = { code: "quota", message: `this scene can hold at most ${LIMITS.pillarsPerScene.toLocaleString("en-US")} pillars` };

  /** A room whose first scene is 60 x 40, with `pillars` pillar cells already stored. */
  function roomWith(name: string, dm: Member, pillars: number): { state: RoomState; sceneId: string } {
    const state = createInitialState({ roomName: name, dm });
    const sceneId = state.meta.playerSceneId!;
    state.scenes[sceneId] = { ...state.scenes[sceneId]!, bounds: { w: W, h: 40 } };
    for (const key of cells(0, pillars)) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const id = chunkKey(sceneId, Math.floor(x / 16), Math.floor(y / 16));
      const chunk = (state.buildChunks[id] ??= { sceneId, cx: Math.floor(x / 16), cy: Math.floor(y / 16), rev: 1, cells: {}, edges: {} });
      chunk.cells[key] = "pillar";
    }
    return { state, sceneId };
  }

  async function withActor(state: RoomState, dms: Member[], run: (actor: RoomActor, send: (who: number, op: Parameters<RoomActor["op"]>[2]) => Promise<{ n: number; code: string; message: string } | null>) => Promise<void>): Promise<void> {
    const db = new FakeDb({ state, dmGrants: dms.map((m) => m.id) });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const conns = dms.map((m) => connect(actor, m));
      for (const [i, c] of conns.entries()) await actor.hello(c.conn, { clientId: `c${i}`, resumeFrom: 1 });
      const counters = conns.map(() => 0);
      await run(actor, async (who, op) => {
        const n = ++counters[who]!;
        await actor.op(conns[who]!.conn, n, op);
        const answer = await answerTo(conns[who]!.sent, n);
        assert.ok(answer !== "stuck");
        return answer.rejects?.find((r) => r.n === n) ?? null;
      });
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  }

  test("painting pillars up to the cap is accepted, and one more is refused", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Columns", dm, 0);
    await withActor(state, [dm], async (actor, send) => {
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "pillar", cells: cells(0, LIMITS.pillarsPerScene) }), null);
      assert.deepEqual(await send(0, { t: "build.paint", sceneId, terrain: "pillar", cells: cells(LIMITS.pillarsPerScene, 1) }), { n: 2, ...refused });
      // Other terrain still paints, and a pillar painted over another pillar adds none.
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "stone", cells: cells(LIMITS.pillarsPerScene, 1) }), null);
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "pillar", cells: cells(0, 1) }), null);
      const pillars = Object.values(actor.committed.state.buildChunks).flatMap((c) => Object.values(c.cells)).filter((t) => t === "pillar");
      assert.equal(pillars.length, LIMITS.pillarsPerScene);
    });
  });

  test("a room already over the cap loads and takes other edits, and refuses only more pillars", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Old columns", dm, LIMITS.pillarsPerScene + 100);
    await withActor(state, [dm], async (_actor, send) => {
      const fresh = cells(LIMITS.pillarsPerScene + 200, 1);
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "stone", cells: fresh }), null);
      assert.equal(await send(0, { t: "build.label", sceneId, labelId: uuidv7(), label: { text: "Hall", x: 5.5, y: 39.5, size: 1 } }), null);
      assert.deepEqual(await send(0, { t: "build.paint", sceneId, terrain: "pillar", cells: fresh }), { n: 3, ...refused });
      // Taking pillars away is fine, and the count stays over the cap, so a new one is still refused.
      assert.equal(await send(0, { t: "build.erase", sceneId, cells: cells(0, 10) }), null);
      assert.deepEqual(await send(0, { t: "build.paint", sceneId, terrain: "pillar", cells: fresh }), { n: 5, ...refused });
    });
  });

  test("a scene over the cap cannot be duplicated, since the copy is a new scene whose count rises from none", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Old columns to copy", dm, LIMITS.pillarsPerScene + 100);
    await withActor(state, [dm], async (actor, send) => {
      const copyId = uuidv7();
      const include = { creatures: true, characters: false, fog: false, drawings: false };
      assert.deepEqual(await send(0, { t: "scene.duplicate", sceneId, newSceneId: copyId, name: "Copy", include }), { n: 1, ...refused });
      assert.equal(actor.committed.state.scenes[copyId], undefined);
    });
  });

  test("an undo that would bring pillars back past the cap says so", async () => {
    const phone = member("DM", "dm");
    const laptop = member("Laptop", "dm");
    const { state, sceneId } = roomWith("Undo columns", phone, 0);
    await withActor(state, [phone, laptop], async (actor, send) => {
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "pillar", cells: cells(0, LIMITS.pillarsPerScene) }), null);
      assert.equal(await send(0, { t: "build.erase", sceneId, cells: cells(0, 10) }), null);
      assert.equal(await send(1, { t: "build.paint", sceneId, terrain: "pillar", cells: cells(LIMITS.pillarsPerScene, 10) }), null);
      const undo = await send(0, { t: "undo" });
      assert.equal(undo?.code, "quota");
      assert.match(undo?.message ?? "", new RegExp(`^could not undo .*: ${refused.message}$`));
      const pillars = Object.values(actor.committed.state.buildChunks).flatMap((c) => Object.values(c.cells)).filter((t) => t === "pillar");
      assert.equal(pillars.length, LIMITS.pillarsPerScene);
    });
  });
});

describe("the door and window cap in the limits step", () => {
  const cap = LIMITS.doorsAndWindowsPerScene;
  const refused = { code: "quota", message: `this scene can hold at most ${cap.toLocaleString("en-US")} doors and windows` };
  // The kth west edge of a 60 x 40 scene, row by row.
  const key = (k: number) => `${1 + (k % 59)},${Math.floor(k / 59)},w`;
  const opening = (k: number) => (k % 3 === 0 ? ({ kind: "window" } as const) : ({ kind: "door", state: "closed", secret: k % 3 === 1, discovered: false } as const));
  const edges = (from: number, count: number) => Array.from({ length: count }, (_, k) => ({ key: key(from + k), feature: opening(from + k) }));

  /** A room whose first scene is 60 x 40, with `count` door and window edges already stored. */
  function roomWith(name: string, dm: Member, count: number): { state: RoomState; sceneId: string } {
    const state = createInitialState({ roomName: name, dm });
    const sceneId = state.meta.playerSceneId!;
    state.scenes[sceneId] = { ...state.scenes[sceneId]!, bounds: { w: 60, h: 40 } };
    for (let k = 0; k < count; k++) {
      const [x, y] = key(k).split(",").map(Number) as [number, number];
      const id = chunkKey(sceneId, Math.floor(x / 16), Math.floor(y / 16));
      const chunk = (state.buildChunks[id] ??= { sceneId, cx: Math.floor(x / 16), cy: Math.floor(y / 16), rev: 1, cells: {}, edges: {} });
      chunk.edges[key(k)] = opening(k);
    }
    return { state, sceneId };
  }

  async function withActor(state: RoomState, dms: Member[], run: (actor: RoomActor, send: (who: number, op: Parameters<RoomActor["op"]>[2]) => Promise<{ n: number; code: string; message: string } | null>) => Promise<void>): Promise<void> {
    const db = new FakeDb({ state, dmGrants: dms.map((m) => m.id) });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const conns = dms.map((m) => connect(actor, m));
      for (const [i, c] of conns.entries()) await actor.hello(c.conn, { clientId: `c${i}`, resumeFrom: 1 });
      const counters = conns.map(() => 0);
      await run(actor, async (who, op) => {
        const n = ++counters[who]!;
        await actor.op(conns[who]!.conn, n, op);
        const answer = await answerTo(conns[who]!.sent, n);
        assert.ok(answer !== "stuck");
        return answer.rejects?.find((r) => r.n === n) ?? null;
      });
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  }

  const count = (state: RoomState) =>
    Object.values(state.buildChunks).reduce(
      (sum, c) => sum + Object.values(c.edges).filter((f) => f.kind === "door" || f.kind === "window").length + (c.walls ?? []).filter((w) => w.f.kind !== "wall").length,
      0,
    );

  test("doors and windows up to the cap, free ones included, are accepted, and one more is refused", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Doors", dm, 0);
    await withActor(state, [dm], async (actor, send) => {
      const free = 300;
      for (let k = 0; k < cap - free; k += 500) assert.equal(await send(0, { t: "build.edge", sceneId, edges: edges(k, Math.min(500, cap - free - k)) }), null);
      const windows = Array.from({ length: free }, (_, k) => ({ id: `w${String(k).padStart(11, "0")}`, a: [0.5 + k / 8, 30] as [number, number], b: [0.5 + k / 8, 31] as [number, number], f: { kind: "window" as const } }));
      assert.equal(await send(0, { t: "build.walls", sceneId, put: windows }), null);
      assert.equal(count(actor.committed.state), cap);
      const past = await send(0, { t: "build.edge", sceneId, edges: edges(cap, 1) });
      assert.deepEqual(past && { code: past.code, message: past.message }, refused);
      // A plain wall still draws, and a door turned into a window adds none.
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: [{ key: key(cap), feature: { kind: "wall" } }] }), null);
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: [{ key: key(1), feature: { kind: "window" } }] }), null);
      assert.equal(count(actor.committed.state), cap);
    });
  });

  test("a room already over the cap loads and takes other edits, and refuses only more doors and windows", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Old doors", dm, cap + 100);
    await withActor(state, [dm], async (_actor, send) => {
      const fresh = edges(cap + 200, 1);
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "stone", cells: ["5,39"] }), null);
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: [{ key: fresh[0]!.key, feature: { kind: "wall" } }] }), null);
      assert.deepEqual(await send(0, { t: "build.edge", sceneId, edges: fresh }), { n: 3, ...refused });
      // Taking doors away is fine, and the count stays over the cap, so a new one is still refused.
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: edges(0, 10).map((e) => ({ key: e.key, feature: null })) }), null);
      assert.deepEqual(await send(0, { t: "build.edge", sceneId, edges: fresh }), { n: 5, ...refused });
    });
  });

  test("a scene over the cap cannot be duplicated", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Old doors to copy", dm, cap + 100);
    await withActor(state, [dm], async (actor, send) => {
      const copyId = uuidv7();
      const include = { creatures: true, characters: false, fog: false, drawings: false };
      assert.deepEqual(await send(0, { t: "scene.duplicate", sceneId, newSceneId: copyId, name: "Copy", include }), { n: 1, ...refused });
      assert.equal(actor.committed.state.scenes[copyId], undefined);
    });
  });

  test("an undo that would bring doors back past the cap says so", async () => {
    const phone = member("DM", "dm");
    const laptop = member("Laptop", "dm");
    const { state, sceneId } = roomWith("Undo doors", phone, cap);
    await withActor(state, [phone, laptop], async (actor, send) => {
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: edges(0, 10).map((e) => ({ key: e.key, feature: null })) }), null);
      assert.equal(await send(1, { t: "build.edge", sceneId, edges: edges(cap, 10) }), null);
      const undo = await send(0, { t: "undo" });
      assert.equal(undo?.code, "quota");
      assert.match(undo?.message ?? "", new RegExp(`^could not undo .*: ${refused.message}$`));
      assert.equal(count(actor.committed.state), cap);
    });
  });
});

describe("the drawn edge cap in the limits step", () => {
  const cap = LIMITS.drawnEdgesPerScene;
  const refused = { code: "quota", message: `this scene can hold at most ${cap.toLocaleString("en-US")} walls, doors, windows and No wall marks on the grid` };
  // The kth edge of a 120 x 100 scene, room for the cap and more: its west edges row by row, then its north ones.
  const W = 120;
  const H = 100;
  const west = (W - 1) * H;
  const key = (k: number) => (k < west ? `${1 + (k % (W - 1))},${Math.floor(k / (W - 1))},w` : `${(k - west) % W},${1 + Math.floor((k - west) / W)},n`);
  const edges = (from: number, count: number) => Array.from({ length: count }, (_, k) => ({ key: key(from + k), feature: { kind: "wall" as const } }));

  /** A room whose first scene is 120 x 100, with `count` drawn walls already stored. */
  function roomWith(name: string, dm: Member, count: number): { state: RoomState; sceneId: string } {
    const state = createInitialState({ roomName: name, dm });
    const sceneId = state.meta.playerSceneId!;
    state.scenes[sceneId] = { ...state.scenes[sceneId]!, bounds: { w: W, h: H } };
    for (let k = 0; k < count; k++) {
      const [x, y] = key(k).split(",").map(Number) as [number, number];
      const id = chunkKey(sceneId, Math.floor(x / 16), Math.floor(y / 16));
      const chunk = (state.buildChunks[id] ??= { sceneId, cx: Math.floor(x / 16), cy: Math.floor(y / 16), rev: 1, cells: {}, edges: {} });
      chunk.edges[key(k)] = { kind: "wall" };
    }
    return { state, sceneId };
  }

  async function withActor(state: RoomState, dms: Member[], run: (actor: RoomActor, send: (who: number, op: Parameters<RoomActor["op"]>[2]) => Promise<{ code: string; message: string } | null>) => Promise<void>): Promise<void> {
    const db = new FakeDb({ state, dmGrants: dms.map((m) => m.id) });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const conns = dms.map((m) => connect(actor, m));
      for (const [i, c] of conns.entries()) await actor.hello(c.conn, { clientId: `c${i}`, resumeFrom: 1 });
      const counters = conns.map(() => 0);
      await run(actor, async (who, op) => {
        const n = ++counters[who]!;
        await actor.op(conns[who]!.conn, n, op);
        const answer = await answerTo(conns[who]!.sent, n);
        assert.ok(answer !== "stuck");
        const r = answer.rejects?.find((x) => x.n === n);
        return r ? { code: r.code, message: r.message } : null;
      });
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  }

  const count = (state: RoomState) => Object.values(state.buildChunks).reduce((sum, c) => sum + Object.keys(c.edges).length, 0);

  test("drawn edges up to the cap are accepted, removals included, and one more is refused", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Walls", dm, 0);
    await withActor(state, [dm], async (actor, send) => {
      // A removed automatic wall is a stored entry too.
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: edges(0, 100).map((e) => ({ key: e.key, feature: { kind: "none" as const } })) }), null);
      for (let k = 100; k < cap; k += 500) assert.equal(await send(0, { t: "build.edge", sceneId, edges: edges(k, Math.min(500, cap - k)) }), null);
      assert.equal(count(actor.committed.state), cap);
      assert.deepEqual(await send(0, { t: "build.edge", sceneId, edges: edges(cap, 1) }), refused);
      // Redrawing a stored edge adds none, and painting still works.
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: [{ key: key(0), feature: { kind: "window" } }] }), null);
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "stone", cells: ["5,5"] }), null);
      assert.equal(count(actor.committed.state), cap);
    });
  });

  test("a room already over the cap loads and takes other edits, and refuses only more drawn edges", async () => {
    const dm = member("DM", "dm");
    const { state, sceneId } = roomWith("Old walls", dm, cap + 100);
    await withActor(state, [dm], async (_actor, send) => {
      assert.equal(await send(0, { t: "build.paint", sceneId, terrain: "stone", cells: ["5,39"] }), null);
      assert.equal(await send(0, { t: "build.label", sceneId, labelId: uuidv7(), label: { text: "Hall", x: 5.5, y: 30.5, size: 1 } }), null);
      assert.deepEqual(await send(0, { t: "build.edge", sceneId, edges: edges(cap + 200, 1) }), refused);
      // Taking edges away is fine, and the count stays over the cap, so a new one is still refused.
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: edges(0, 10).map((e) => ({ key: e.key, feature: null })) }), null);
      assert.deepEqual(await send(0, { t: "build.edge", sceneId, edges: edges(cap + 200, 1) }), refused);
    });
  });

  test("an undo that would bring drawn edges back past the cap says so", async () => {
    const phone = member("DM", "dm");
    const laptop = member("Laptop", "dm");
    const { state, sceneId } = roomWith("Undo walls", phone, cap);
    await withActor(state, [phone, laptop], async (actor, send) => {
      assert.equal(await send(0, { t: "build.edge", sceneId, edges: edges(0, 10).map((e) => ({ key: e.key, feature: null })) }), null);
      assert.equal(await send(1, { t: "build.edge", sceneId, edges: edges(cap, 10) }), null);
      const undo = await send(0, { t: "undo" });
      assert.equal(undo?.code, "quota");
      assert.match(undo?.message ?? "", new RegExp(`^could not undo .*: ${refused.message}$`));
      assert.equal(count(actor.committed.state), cap);
    });
  });
});

/**
 * A room whose battle mat has party vision in the dark, with fog: a
 * player's character with darkvision 30 ft at (2, 2) and a goblin three
 * cells east of it, which the party sees. A second scene has vision and fog
 * too, for moving players there.
 */
function darkRoom(dm: Member, player: Member): { state: RoomState; sceneId: string; otherSceneId: string; pcId: string; characterId: string; goblinId: string } {
  const state = createInitialState({ roomName: "Dark", dm });
  state.members[player.id] = player;
  const sceneId = state.meta.playerSceneId!;
  state.scenes[sceneId] = { ...state.scenes[sceneId]!, fogEnabled: true, vision: { on: true, light: "dark" } };
  const otherSceneId = uuidv7();
  state.scenes[otherSceneId] = { ...state.scenes[sceneId]!, id: otherSceneId, name: "Crypt", order: 1 };
  const characterId = uuidv7();
  state.characters[characterId] = testCharacter(characterId, { ownerIds: [player.id], actor: testActor({ senses: "Darkvision 30 ft." }) });
  const pcId = uuidv7();
  state.tokens[pcId] = testToken(pcId, { sceneId, kind: "pc", name: "Ayla", disposition: "ally", x: 2, y: 2, actor: { ref: characterId } });
  const goblinId = uuidv7();
  state.tokens[goblinId] = testToken(goblinId, { sceneId, x: 5, y: 2 });
  return { state, sceneId, otherSceneId, pcId, characterId, goblinId };
}

/** The keys of every change the socket was sent in `ev`s since `from`. */
function changedKeys(sent: ServerMessage[], from = 0): string[] {
  return sent.slice(from).flatMap((m) => (m.t === "ev" ? m.changes.map((c) => c.key) : []));
}

describe("the explore step (docs/design-v1-maps-vision.md 4.3.3)", () => {
  test("a move stores what the party explored right after it, in the same batch, and replay rebuilds the layer as stored", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, sceneId, pcId } = darkRoom(dm, player);
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      const marks = { dm: table.sent.length, player: phone.sent.length };
      await actor.op(phone.conn, 1, { t: "token.move", tokenId: pcId, x: 20, y: 2 });
      assert.notEqual(await answerTo(phone.sent, 1), "stuck");
      const stored = db.storedRows as { seq: string; actor_member_id: string; op: { t: string; sceneId?: string } }[];
      assert.deepEqual(
        stored.map((r) => [r.op.t, r.actor_member_id]),
        [
          ["token.move", player.id],
          ["sys.explore", "server"],
        ],
      );
      assert.equal(stored[1]!.op.sceneId, sceneId);
      const explored = Object.keys(actor.committed.state.exploredTiles).sort();
      assert.deepEqual(explored, [`${sceneId}:0,0`, `${sceneId}:1,0`]);
      // The DM receives the explored layer, and players their fog, the two layers merged, with the party's sight.
      const dmKeys = changedKeys(table.sent, marks.dm);
      assert.ok(dmKeys.includes(`explored:${sceneId}:1,0`));
      const playerKeys = changedKeys(phone.sent, marks.player);
      assert.ok(playerKeys.includes(`fog:${sceneId}:1,0`) && playerKeys.includes(`sight:${sceneId}:1,0`));
      assert.ok(!playerKeys.some((k) => k.startsWith("explored:")), "the explored layer is the DM's");

      const again = new FakeDb({ state, opRows: db.storedRows, dmGrants: [dm.id] });
      const replayed = await RoomActor.load(deps(again));
      assert.ok(replayed && !replayed.replayFailed);
      assert.equal(JSON.stringify(replayed.committed.state.exploredTiles), JSON.stringify(actor.committed.state.exploredTiles));
      again.freeze();
      void replayed.shutdown({ code: 1012, snapshot: false });
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });

  test("nothing is explored behind a blackout, nor on a vision scene the DM previews, and a hide is explored again where the party looks", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, sceneId, otherSceneId, pcId, goblinId } = darkRoom(dm, player);
    const elf = uuidv7();
    state.tokens[elf] = testToken(elf, { sceneId: otherSceneId, kind: "npc", partyVision: true, x: 4, y: 4, actor: { inline: testActor({ senses: "Darkvision 60 ft." }) } });
    await withRoom(state, dm, async (actor, send, db) => {
      const explores = () => db.storedOps.filter((op) => (op as { t: string }).t === "sys.explore").length;
      assert.equal(await send({ t: "token.move", tokenId: goblinId, x: 6, y: 2 }), null);
      assert.equal(explores(), 1, "the first batch records what the party already saw");
      assert.equal(await send({ t: "token.move", tokenId: elf, x: 6, y: 4 }), null);
      assert.equal(explores(), 1, "the DM's other scene is not where players are");
      assert.equal(await send({ t: "view.blackout", blackout: true }), null);
      assert.equal(await send({ t: "token.move", tokenId: pcId, x: 20, y: 2 }), null);
      assert.equal(explores(), 1, "players see nothing behind a blackout");
      assert.equal(actor.committed.state.exploredTiles[`${sceneId}:1,0`], undefined);
      assert.equal(await send({ t: "view.blackout", blackout: false }), null);
      assert.equal(explores(), 2, "lifting it explores what the party sees");
      // A hide over where the party looks clears the layer there, and the same batch explores it again.
      const before = actor.committed.state.exploredTiles[`${sceneId}:1,0`]!;
      assert.equal(await send({ t: "fog.live", sceneId, ops: [{ id: "h", mode: "hide", shape: { kind: "rect", x: 20, y: 0, w: 2, h: 20 } }] }), null);
      const after = actor.committed.state.exploredTiles[`${sceneId}:1,0`]!;
      assert.equal(after.bits, before.bits);
      assert.equal(after.rev, before.rev + 2, "cleared and explored again");
    });
  });

  test("the DM's immediate undo of a fog reset applies, with the batch's explore between, and keeps what the party sees", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, sceneId, goblinId } = darkRoom(dm, player);
    await withRoom(state, dm, async (actor, send) => {
      assert.equal(await send({ t: "fog.live", sceneId, ops: [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 30, h: 20 } }] }), null);
      assert.equal(await send({ t: "token.move", tokenId: goblinId, x: 6, y: 2 }), null);
      const explored = actor.committed.state.exploredTiles[`${sceneId}:0,0`]!;
      assert.equal(await send({ t: "fog.reset", sceneId, to: "hidden" }), null);
      assert.deepEqual(actor.committed.state.fogTiles, {});
      assert.equal(actor.committed.state.exploredTiles[`${sceneId}:0,0`]?.bits, explored.bits, "the same batch explored what the party sees again");
      assert.equal(await send({ t: "undo" }), null);
      assert.ok(Object.keys(actor.committed.state.fogTiles).length > 0, "the DM's fog is back");
      assert.equal(actor.committed.state.exploredTiles[`${sceneId}:0,0`]?.bits, explored.bits);
    });
  });

  test("an actor op on a character changes the party's sight for players, and what it shows", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, sceneId, characterId, goblinId } = darkRoom(dm, player);
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      const snapshot = phone.sent.find((m) => m.t === "snapshot") as Extract<ServerMessage, { t: "snapshot" }>;
      const view = snapshot.state as { tokens: Record<string, unknown>; sight: Record<string, unknown> };
      assert.ok(view.tokens[goblinId], "the party sees the goblin");
      assert.ok(view.sight[`${sceneId}:0,0`]);
      const mark = phone.sent.length;
      await actor.op(table.conn, 1, { t: "actor.effect.add", target: { characterId }, effect: { id: "b", key: "blinded" } });
      assert.notEqual(await answerTo(table.sent, 1), "stuck");
      const ev = phone.sent.slice(mark).find((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev");
      assert.ok(ev, "the player hears of it");
      // Blinded, the party sees nothing, so its sight tile goes and the goblin with it.
      const gone = new Set(ev.changes.filter((c) => "deleted" in c).map((c) => c.key));
      assert.ok(gone.has(`sight:${sceneId}:0,0`));
      assert.ok(gone.has(`token:${goblinId}`));
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

/** One DM driving a loaded room, op by op, with the refusal or null each op got. */
async function withRoom(
  state: RoomState,
  dm: Member,
  run: (actor: RoomActor, send: (op: Parameters<RoomActor["op"]>[2]) => Promise<{ code: string; message: string } | null>, db: FakeDb) => Promise<void>,
  options: Partial<ActorDeps["options"]> = {},
): Promise<void> {
  const db = new FakeDb({ state, dmGrants: [dm.id] });
  const base = deps(db);
  const actor = await RoomActor.load({ ...base, options: { ...base.options, ...options } });
  assert.ok(actor);
  try {
    const table = connect(actor, dm);
    await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
    let n = 0;
    await run(
      actor,
      async (op) => {
        n++;
        await actor.op(table.conn, n, op);
        const answer = await answerTo(table.sent, n);
        assert.ok(answer !== "stuck");
        const refusal = answer.rejects?.find((r) => r.n === n);
        return refusal ? { code: refusal.code, message: refusal.message } : null;
      },
      db,
    );
  } finally {
    db.freeze();
    void actor.shutdown({ code: 1012, snapshot: false });
  }
}

describe("the explored layer's reserve at a reduced room limit (docs/design-v1-maps-vision.md 2.4)", () => {
  test("explore spends only what was reserved, ordinary ops keep fitting around it, and moving players needs the new scene's reserve", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, sceneId, otherSceneId, pcId, goblinId } = darkRoom(dm, player);
    // Room for the player scene's whole layer and a few hundred bytes of play, and not for a second scene's layer.
    const stateLimit = serializedBytes(state) + exploredReserve(state) + 600;
    assert.ok(exploredReserve({ ...state, meta: { ...state.meta, playerSceneId: otherSceneId } }) > 1_200);
    await withRoom(
      state,
      dm,
      async (actor, send) => {
        const within = (when: string) => {
          const now = actor.committed.state;
          const bytes = serializedBytes(now);
          assert.ok(bytes + exploredReserve(now) <= stateLimit, `${when}: ${bytes} + ${exploredReserve(now)} over ${stateLimit}`);
        };
        assert.equal(await send({ t: "token.move", tokenId: pcId, x: 20, y: 2 }), null);
        within("after the first explore");
        // An op that fits the room but not the room and the reserve is refused as a full room.
        const big: Op = { t: "token.update", tokenId: goblinId, patch: { notes: "n".repeat(700) } };
        const alone = applyOp(actor.committed.state, big, { memberId: dm.id, role: "dm" }, { seq: 1_000, at: new Date().toISOString() });
        assert.ok(alone.ok && serializedBytes(alone.state) <= stateLimit, "it fits without the reserve");
        assert.deepEqual(await send(big), { code: "quota", message: `the room is full: it is at its ${Math.floor(stateLimit / 1024 / 1024)} MiB size limit` });

        // Each hide where the party looks clears explored bits and the batch explores them again, so the tile's rev climbs by two.
        const tile = () => actor.committed.state.exploredTiles[`${sceneId}:1,0`]!;
        const crossed = new Set<number>();
        for (let round = 0; tile().rev < 104; round++) {
          const digits = String(tile().rev).length;
          assert.equal(await send({ t: "fog.live", sceneId, ops: [{ id: `h${round}`, mode: "hide", shape: { kind: "rect", x: 20, y: 0, w: 2, h: 20 } }] }), null);
          within(`round ${round}`);
          if (String(tile().rev).length > digits) {
            crossed.add(tile().rev);
            // A move that adds nothing right after the layer grew a digit still fits.
            assert.equal(await send({ t: "token.move", tokenId: goblinId, x: round % 2 === 0 ? 6 : 5, y: 2 }), null);
            within(`the move after round ${round}`);
          }
        }
        assert.deepEqual([...crossed], [11, 101]);

        // The export carries the layer, and the import fits as the room did.
        const exported = JSON.parse(JSON.stringify(roomExport("TESTR00M", actor.committed.seq, actor.committed.state, [dm.id]))) as RoomExport;
        const imported = remapState(exported.state, { assets: new Map() });
        assert.equal(Object.keys(imported.exploredTiles).length, Object.keys(actor.committed.state.exploredTiles).length);
        assert.ok(serializedBytes(imported) + exploredReserve(imported) <= stateLimit);

        assert.deepEqual(await send({ t: "room.setPlayerScene", sceneId: otherSceneId }), { code: "quota", message: NO_ROOM_TO_EXPLORE });
        assert.equal(actor.committed.state.meta.playerSceneId, sceneId);
        // Turning vision off there takes its reserve away, and the move goes through.
        assert.equal(await send({ t: "scene.update", sceneId: otherSceneId, patch: { vision: { on: false, light: "dark" } } }), null);
        assert.equal(await send({ t: "room.setPlayerScene", sceneId: otherSceneId }), null);
        within("after moving players");
      },
      { sizeLimits: { stateLimit } },
    );
  });
});

describe("explore's growth under a scene ID that JSON escapes (docs/design-v1-maps-vision.md 2.4)", () => {
  test("the guard counts an explored tile's escaped key, so an edit right after explore that would pass the limit is refused", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const room = darkRoom(dm, player);
    // The same room with its player scene under 64 control characters, each six bytes once escaped.
    const sceneId = "\u0001".repeat(64);
    const state: RoomState = {
      ...room.state,
      meta: { ...room.state.meta, playerSceneId: sceneId },
      scenes: Object.fromEntries(Object.entries(room.state.scenes).map(([id, s]) => (id === room.sceneId ? [sceneId, { ...s, id: sceneId }] : [id, s]))),
      tokens: Object.fromEntries(Object.entries(room.state.tokens).map(([id, t]) => [id, t.sceneId === room.sceneId ? { ...t, sceneId } : t])),
    };
    const stateLimit = serializedBytes(state) + exploredReserve(state) + 200;
    await withRoom(
      state,
      dm,
      async (actor, send) => {
        assert.equal(await send({ t: "token.move", tokenId: room.goblinId, x: 6, y: 2 }), null);
        const explored = Object.values(actor.committed.state.exploredTiles);
        assert.ok(explored.length > 0, "the first batch explored what the party sees");
        assert.ok(utf8Bytes(JSON.stringify(`${sceneId}:0,0`)) > 380, "the key escapes to six bytes a character");
        // A hundred and fifty bytes more than the room has left once the layer's reserve is counted: less than the 310 bytes
        // an unescaped key would leave out of the explored tile, so a guard counting it short would let this through unmeasured.
        const note = (n: number): Op => ({ t: "token.update", tokenId: room.goblinId, patch: { notes: "n".repeat(n) } });
        const room0 = actor.committed.state;
        const spare = stateLimit - serializedBytes(room0) - exploredReserve(room0);
        assert.ok(spare >= 0 && spare < 300, `${spare} bytes spare`);
        assert.deepEqual(await send(note(spare + 150)), { code: "quota", message: `the room is full: it is at its ${Math.floor(stateLimit / 1024 / 1024)} MiB size limit` });
        assert.equal(await send(note(Math.max(0, spare - 40))), null, "an edit that fits still passes");
        const now = actor.committed.state;
        assert.ok(serializedBytes(now) + exploredReserve(now) <= stateLimit);
      },
      { sizeLimits: { stateLimit } },
    );
  });
});

describe("a turn ended from two places at once", () => {
  /** A fight with Ayla (the player's) at 20, then two goblins: the turn order the tests step through. */
  function fight(dm: Member, player: Member): { state: RoomState; rows: string[] } {
    const { state: start, tokenId: goblin } = roomWithGoblin(dm);
    const sceneId = start.meta.playerSceneId!;
    const ayla = uuidv7();
    const second = uuidv7();
    let state = { ...start, members: { ...start.members, [player.id]: player } };
    for (const token of [
      { id: ayla, sceneId, kind: "pc" as const, name: "Ayla", size: "medium" as const, x: 2, y: 2, ownerIds: [player.id], actor: { inline } },
      { id: second, sceneId, kind: "monster" as const, name: "Goblin", size: "medium" as const, x: 3, y: 3, actor: { inline } },
    ]) {
      const created = applyOp(state, { t: "token.create", token }, { memberId: dm.id, role: "dm" }, { seq: 1, at: new Date().toISOString() });
      assert.ok(created.ok);
      state = created.state;
    }
    const rows = [uuidv7(), uuidv7(), uuidv7()];
    const started = applyOp(
      state,
      { t: "encounter.start", entries: [{ id: rows[0]!, tokenId: ayla, value: 20 }, { id: rows[1]!, tokenId: goblin, value: 15 }, { id: rows[2]!, tokenId: second, value: 10 }] },
      { memberId: dm.id, role: "dm" },
      { seq: 1, at: new Date().toISOString() },
    );
    assert.ok(started.ok);
    return { state: started.state, rows };
  }

  async function taken(sent: ServerMessage[], n: number): Promise<void> {
    const answer = await answerTo(sent, n);
    assert.ok(answer !== "stuck", `op ${n} got no answer`);
    assert.ok(answer.acks?.includes(n), `op ${n} was refused: ${JSON.stringify(answer.rejects)}`);
  }

  test("a player's End Turn and the DM's Next, two DM devices, or a double tap each move the turn once, and the late press is taken quietly", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, rows } = fight(dm, player);
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    const active = () => actor.committed.state.encounter!.activeEntryId;
    try {
      const table = connect(actor, dm);
      const laptop = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(laptop.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c3", resumeFrom: 1 });
      // Start, pressed twice: the fight starts on the first row.
      await Promise.all([actor.op(table.conn, 1, { t: "encounter.next", from: { entry: null, round: 1 } }), actor.op(table.conn, 2, { t: "encounter.next", from: { entry: null, round: 1 } })]);
      await taken(table.sent, 1);
      await taken(table.sent, 2);
      assert.equal(active(), rows[0]);
      // Ayla's player ends her turn as the DM presses Next.
      await Promise.all([actor.op(phone.conn, 1, { t: "encounter.next", from: { entry: rows[0]!, round: 1 } }), actor.op(table.conn, 3, { t: "encounter.next", from: { entry: rows[0]!, round: 1 } })]);
      await taken(phone.sent, 1);
      await taken(table.sent, 3);
      assert.equal(active(), rows[1], "the first goblin's turn was skipped");
      // Two DM devices press Next for the first goblin.
      await Promise.all([actor.op(laptop.conn, 1, { t: "encounter.next", from: { entry: rows[1]!, round: 1 } }), actor.op(table.conn, 4, { t: "encounter.next", from: { entry: rows[1]!, round: 1 } })]);
      await taken(laptop.sent, 1);
      await taken(table.sent, 4);
      assert.equal(active(), rows[2]);
      // A double tap on Previous walks back one turn.
      await Promise.all([actor.op(table.conn, 5, { t: "encounter.prev", from: { entry: rows[2]!, round: 1 } }), actor.op(table.conn, 6, { t: "encounter.prev", from: { entry: rows[2]!, round: 1 } })]);
      await taken(table.sent, 5);
      await taken(table.sent, 6);
      assert.equal(active(), rows[1]);
      // A player's late press when it is no longer their turn says nothing either.
      await actor.op(phone.conn, 2, { t: "encounter.next", from: { entry: rows[0]!, round: 1 } });
      await taken(phone.sent, 2);
      assert.equal(active(), rows[1]);
      const turns = actor.committed.state.log.filter((e) => e.data?.type === "turn" && e.data.back !== true).map((e) => (e.data as { entryId: string }).entryId);
      assert.deepEqual(turns, [rows[0], rows[1], rows[2]]);
      await actor.shutdown({ code: 1012, snapshot: false });
    } finally {
      db.freeze();
    }
  });

  test("a lone combatant's turn pressed twice moves one round, not two", async () => {
    const dm = member("DM", "dm");
    const { state: start, tokenId } = roomWithGoblin(dm);
    const row = uuidv7();
    const started = applyOp(start, { t: "encounter.start", entries: [{ id: row, tokenId, value: 12 }] }, { memberId: dm.id, role: "dm" }, { seq: 1, at: new Date().toISOString() });
    assert.ok(started.ok);
    const db = new FakeDb({ state: started.state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const laptop = connect(actor, dm);
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(laptop.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(table.conn, 1, { t: "encounter.next", from: { entry: null, round: 1 } });
      await taken(table.sent, 1);
      await Promise.all([actor.op(table.conn, 2, { t: "encounter.next", from: { entry: row, round: 1 } }), actor.op(laptop.conn, 1, { t: "encounter.next", from: { entry: row, round: 1 } })]);
      await taken(table.sent, 2);
      await taken(laptop.sent, 1);
      assert.equal(actor.committed.state.encounter!.round, 2);
      assert.equal(actor.committed.state.encounter!.activeEntryId, row);
      await actor.shutdown({ code: 1012, snapshot: false });
    } finally {
      db.freeze();
    }
  });

  test("Next and Previous stored without the turn they end replay as they applied then", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, rows } = fight(dm, player);
    const row = (seq: number, op: unknown) => ({ seq: String(seq), at: new Date(), actor_member_id: dm.id, actor_role: "dm", op, op_version: 3 });
    const opRows = [
      row(1, { t: "encounter.next" }),
      row(2, { t: "encounter.next" }),
      row(3, { t: "encounter.next" }),
      row(4, { t: "encounter.prev" }),
      // A late press stored with the field stays the nothing it was.
      row(5, { t: "encounter.next", from: { entry: rows[0]!, round: 1 } }),
    ];
    const db = new FakeDb({ state, opRows, dmGrants: [dm.id] });
    try {
      const actor = await within(2_000, RoomActor.load(deps(db)));
      assert.ok(actor !== "stuck" && actor !== null, "the load finished");
      assert.equal(actor.replayFailed, false);
      assert.equal(actor.committed.state.encounter!.activeEntryId, rows[1]);
      await actor.shutdown({ code: 1012, snapshot: false });
    } finally {
      db.freeze();
    }
  });
});

describe("the lit token light cap in the limits step (docs/design-v1-maps-vision.md 2.4)", () => {
  const refused = { code: "quota", message: "This scene already has 20 lit token lights." };
  const lit = { bright: 20, dim: 20 };
  const dmOf = (dm: Member) => ({ memberId: dm.id, role: "dm" as const });
  const world: VisionWorld = { walls: sceneWalls };

  /**
   * A dark vision room, 30 x 20, walled across row 10. The player's unlit
   * character stands at (1, 1). Below the wall, out of the party's sight,
   * stand `shown` lit monsters, `hidden` lit monsters the DM hid, an unlit
   * one, and a hidden lit one in a fight whose turn comes after Ayla's.
   */
  function roomWith(dm: Member, player: Member, shown: number, hidden: number): { state: RoomState; pc: string; lurker: string; unlit: string } {
    let state = createInitialState({ roomName: "Torches", dm });
    const sceneId = state.meta.playerSceneId!;
    state.members[player.id] = player;
    state.scenes[sceneId] = { ...state.scenes[sceneId]!, fogEnabled: true, vision: { on: true, light: "dark" } };
    const at = { seq: 1, at: new Date().toISOString() };
    const walled = applyOp(state, { t: "build.edge", sceneId, edges: Array.from({ length: 30 }, (_, x) => ({ key: `${x},10,n`, feature: { kind: "wall" as const } })) }, dmOf(dm), at);
    assert.ok(walled.ok);
    state = walled.state;
    const pc = uuidv7();
    const lurker = uuidv7();
    const unlit = uuidv7();
    const tokens = [
      { id: pc, kind: "pc" as const, name: "Ayla", x: 1, y: 1, ownerIds: [player.id] },
      { id: lurker, kind: "monster" as const, name: "Lurker", x: 28, y: 18, visibility: "dm" as const, light: { bright: 10, dim: 10 } },
      { id: unlit, kind: "monster" as const, name: "Goblin", x: 28, y: 12 },
      ...Array.from({ length: shown }, (_, k) => ({ id: uuidv7(), kind: "monster" as const, name: "Goblin", x: k, y: 14, light: lit })),
      ...Array.from({ length: hidden }, (_, k) => ({ id: uuidv7(), kind: "monster" as const, name: "Goblin", x: k, y: 17, visibility: "dm" as const, light: lit })),
    ];
    for (const t of tokens) {
      const created = applyOp(state, { t: "token.create", token: { sceneId, size: "medium", actor: { inline }, ...t } }, dmOf(dm), at);
      assert.ok(created.ok);
      state = created.state;
    }
    const started = applyOp(state, { t: "encounter.start", entries: [{ id: uuidv7(), tokenId: pc, value: 20 }, { id: uuidv7(), tokenId: lurker, value: 10, hidden: true }] }, dmOf(dm), at);
    assert.ok(started.ok);
    return { state: started.state, pc, lurker, unlit };
  }

  async function withRoom(state: RoomState, dm: Member, player: Member, run: (actor: RoomActor, send: (who: "dm" | "player", op: Op) => Promise<{ n: number; code: string; message: string } | null>) => Promise<void>): Promise<void> {
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const conns = { dm: connect(actor, dm), player: connect(actor, player, "player") };
      await actor.hello(conns.dm.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(conns.player.conn, { clientId: "c2", resumeFrom: 1 });
      const counters = { dm: 0, player: 0 };
      await run(actor, async (who, op) => {
        const n = ++counters[who];
        await actor.op(conns[who].conn, n, op);
        const answer = await answerTo(conns[who].sent, n);
        assert.ok(answer !== "stuck");
        return answer.rejects?.find((r) => r.n === n) ?? null;
      });
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  }

  /** Whether the party sees Ayla's own square, which only her torch lights. */
  const aylaLit = (state: RoomState) => partySight(state, state.meta.playerSceneId!, world).seesToken({ size: "medium", x: 1, y: 1 });

  test("a player's torch is never refused, and lights, at 20 and 25 lit creatures, shown out of sight or hidden", async () => {
    const cap = LIMITS.litTokenLightsPerScene;
    for (const [shown, hidden] of [[cap, 0], [cap + 5, 0], [cap - 1, 6], [cap, 6]] as const) {
      const dm = member("DM", "dm");
      const player = member("Ayla", "player");
      const { state, pc } = roomWith(dm, player, shown, hidden);
      await withRoom(state, dm, player, async (actor, send) => {
        const label = `${shown} shown, ${hidden} hidden`;
        assert.equal(aylaLit(actor.committed.state), false, `${label}: lit before the torch`);
        assert.equal(await send("player", { t: "token.update", tokenId: pc, patch: { light: lit } }), null, label);
        assert.equal(aylaLit(actor.committed.state), true, `${label}: the torch lights`);
      });
    }
  });

  test("the DM's light past the cap is refused, so is showing a lit creature, and a reveal on its turn goes through", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, lurker, unlit, pc } = roomWith(dm, player, LIMITS.litTokenLightsPerScene, 3);
    await withRoom(state, dm, player, async (actor, send) => {
      const sceneId = actor.committed.state.meta.playerSceneId!;
      assert.deepEqual(await send("dm", { t: "token.update", tokenId: unlit, patch: { light: lit } }), { n: 1, ...refused });
      const created = { id: uuidv7(), sceneId, kind: "monster" as const, name: "Goblin", size: "medium" as const, x: 27, y: 13, actor: { inline }, light: lit };
      assert.deepEqual(await send("dm", { t: "token.create", token: created }), { n: 2, ...refused });
      assert.deepEqual(await send("dm", { t: "token.update", tokenId: lurker, patch: { visibility: "all" } }), { n: 3, ...refused });
      assert.equal(actor.committed.state.tokens[lurker]!.visibility, "dm");
      // The fight starts on Ayla's turn, and her player ends it: the hidden combatant is revealed, never refused.
      assert.equal(await send("dm", { t: "encounter.next" }), null);
      assert.equal(await send("player", { t: "encounter.next" }), null);
      const revealed = actor.committed.state.tokens[lurker]!;
      assert.deepEqual([revealed.visibility, revealed.fogExemptAuto], ["all", true]);
      // Over the cap now, the DM's edits that light no more go through, and the player's torch still lights.
      assert.equal(await send("dm", { t: "token.update", tokenId: lurker, patch: { name: "Lurker in the light" } }), null);
      assert.equal(await send("player", { t: "token.update", tokenId: pc, patch: { light: lit } }), null);
      assert.equal(aylaLit(actor.committed.state), true);
    });
  });
});

describe("every op's growth counts on the scenes it wrote into (docs/design-v1-dm-tools.md 2.4)", () => {
  /** A DM, a player who owns the second goblin, and three goblins with inline actors on the player scene. */
  function goblins(dm: Member, player: Member): { state: RoomState; sceneId: string; ids: string[] } {
    const { state: start, tokenId } = roomWithGoblin(dm);
    const sceneId = start.meta.playerSceneId!;
    let state: RoomState = { ...start, members: { ...start.members, [player.id]: player } };
    const ids = [tokenId];
    for (const ownerIds of [[player.id], []]) {
      const id = uuidv7();
      const created = applyOp(state, { t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, ownerIds, actor: { inline } } }, { memberId: dm.id, role: "dm" }, { seq: 1, at: new Date().toISOString() });
      assert.ok(created.ok);
      state = created.state;
      ids.push(id);
    }
    // A full log of chat lines a little longer than an effect's line, so every new line drops an older one and the
    // room-level part never grows: what an op adds to a scene is then all that can carry it past its limit.
    state = { ...state, log: Array.from({ length: 200 }, (_, i) => ({ id: `0:${i}`, at: new Date().toISOString(), kind: "chat" as const, from: dm.id, text: "c".repeat(80) })) };
    return { state, sceneId, ids };
  }

  test("conditions on inline actors, group edits, pins, pages and rolls are each held to the scene limit as they are applied", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, sceneId, ids } = goblins(dm, player);
    // Room for a few ops and no more, measured as a DM's projection of the scene, as the guard measures it.
    const sceneLimit = serializedBytes(projectState({ ...state, sight: {} } as unknown as RoomState, { memberId: dm.id, role: "dm" }, { sceneId })) + 900;
    let n = 0;
    const next = (): Op => {
      n++;
      switch (n % 6) {
        case 0:
          return { t: "actor.effects", add: ids.map((tokenId) => ({ target: { tokenId }, effect: { id: uuidv7(), key: "frightened", label: "Frightened of the dark" } })) };
        case 1:
          return { t: "token.updateMany", tokenIds: ids, patch: { image: { icon: "lorc/wolf-head", color: n % 4 === 1 ? "#336699" : "#99663300" } } };
        case 2:
          return { t: "pin.put", pin: { id: uuidv7(), sceneId, x: 1, y: 1, label: "A pin with a long label", color: "#ff8800", visibility: "all" } };
        case 3:
          return { t: "journal.create", page: { id: uuidv7(), title: "Notes", access: "dm", blocks: [{ id: "abcdefghijkl", text: "n".repeat(60) }] } };
        case 4:
          return { t: "roll.ask", request: { id: uuidv7(), test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ tokenId: ids[1]! }] } };
        default:
          return { t: "actor.effect.add", target: { tokenId: ids[2]! }, effect: { id: uuidv7(), key: "poisoned" } };
      }
    };
    await withRoom(
      state,
      dm,
      async (actor, send) => {
        let refused = 0;
        for (let i = 0; i < 60; i++) {
          const op = next();
          const answer = await send(op);
          if (answer) {
            assert.equal(answer.code, "quota", `${op.t}: ${answer.message}`);
            refused++;
          }
          // What the guard took op by op is what a whole check of the room takes: no op's growth escaped its scene.
          const whole = checkWholeScenes(actor.committed.state, sceneLimit);
          assert.ok(whole.ok, `after ${op.t} (${i}): ${whole.ok ? "" : whole.message}`);
        }
        assert.ok(refused > 0, "the limit was reached");
      },
      { sizeLimits: { sceneLimit } },
    );
  });

  test("conditions added to several creatures at once are refused when they would carry their scene past its limit", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, sceneId, ids } = goblins(dm, player);
    const sceneLimit = serializedBytes(projectState({ ...state, sight: {} } as unknown as RoomState, { memberId: dm.id, role: "dm" }, { sceneId })) + 300;
    const frighten = (label: string): Op => ({ t: "actor.effects", add: ids.map((tokenId) => ({ target: { tokenId }, effect: { id: uuidv7(), key: "frightened", label } })) });
    const long = "Frightened of the dark, the deep water and the thing that waits below the ford";
    // The op adds to the scene's tokens more than is left, while the room-level part, with its log, does not grow.
    const dmView = { memberId: dm.id, role: "dm" as const };
    const probe = applyOp(state, frighten(long), dmView, { seq: 2, at: new Date().toISOString() });
    assert.ok(probe.ok);
    assert.ok(roomLevelBytes(probe.state) <= roomLevelBytes(state));
    assert.ok(serializedBytes(projectState({ ...probe.state, sight: {} } as unknown as RoomState, dmView, { sceneId })) > sceneLimit);
    await withRoom(
      state,
      dm,
      async (actor, send) => {
        // Three effects of about 150 bytes each on the scene's tokens: past the 300 bytes left, though the op names no scene.
        assert.deepEqual(await send(frighten(long)), { code: "quota", message: "this scene is at its 0 MiB size limit" });
        assert.ok(checkWholeScenes(actor.committed.state, sceneLimit).ok);
        assert.equal(await send({ t: "actor.effects", add: [{ target: { tokenId: ids[0]! }, effect: { id: uuidv7(), key: "prone" } }] }), null, "one small one still fits");
      },
      { sizeLimits: { sceneLimit } },
    );
  });
});

describe("companion stat blocks at the room actor (docs/design-v1-companion-stat-blocks.md 3.4 to 3.6)", () => {
  /** Bree, the player's character, with her token on the players' scene and one block. */
  function breeRoom(dm: Member, player: Member): { state: RoomState; characterId: string; pcId: string } {
    const state = createInitialState({ roomName: "Familiars", dm });
    state.members[player.id] = player;
    const characterId = uuidv7();
    state.characters[characterId] = testCharacter(characterId, { name: "Bree", ownerIds: [player.id] });
    const pcId = uuidv7();
    state.tokens[pcId] = testToken(pcId, { sceneId: state.meta.playerSceneId!, kind: "pc", name: "Bree", x: 2, y: 2, actor: { ref: characterId } });
    state.companionBlocks.moth = testBlock("moth", characterId);
    return { state, characterId, pcId };
  }

  const create = (characterId: string, id = uuidv7()): Op => {
    const { rev: _rev, ...block } = testBlock(id, characterId);
    return { t: "companionBlock.create", block };
  };

  async function withSockets(
    state: RoomState,
    dm: Member,
    player: Member,
    run: (actor: RoomActor, sockets: { dm: ReturnType<typeof connect>; player: ReturnType<typeof connect> }) => Promise<void>,
    info: Partial<ActorDeps["info"]> = {},
    options: Partial<ActorDeps["options"]> = {},
  ): Promise<void> {
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const base = deps(db, info);
    const actor = await RoomActor.load({ ...base, options: { ...base.options, ...options } });
    assert.ok(actor);
    try {
      const sockets = { dm: connect(actor, dm), player: connect(actor, player, "player") };
      await actor.hello(sockets.dm.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(sockets.player.conn, { clientId: "c2", resumeFrom: 1 });
      await run(actor, sockets);
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  }

  /** The answer to op `n`: null when taken, else its refusal. */
  async function answer(sent: ServerMessage[], n: number): Promise<{ code: string; message: string } | null> {
    const ev = await answerTo(sent, n);
    assert.ok(ev !== "stuck", `op ${n} got no answer`);
    const refusal = ev.rejects?.find((r) => r.n === n);
    return refusal ? { code: refusal.code, message: refusal.message } : null;
  }

  test("a player's eleventh save in a burst is refused, never busy, the moves and HP changes after it go on at once, and one passes again 6 s later", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, characterId, pcId } = breeRoom(dm, player);
    const clock = { now: Date.now() };
    await withSockets(
      state,
      dm,
      player,
      async (actor, { dm: dmSocket, player: p }) => {
        // Ten saves, a delete among them, then the eleventh, then a move and an HP change, all sent before any answer.
        for (let n = 1; n <= 9; n++) await actor.op(p.conn, n, create(characterId));
        await actor.op(p.conn, 10, { t: "companionBlock.delete", blockId: "moth" });
        await actor.op(p.conn, 11, create(characterId));
        await actor.op(p.conn, 12, { t: "token.move", tokenId: pcId, x: 3, y: 2 });
        await actor.op(p.conn, 13, { t: "actor.hp", target: { tokenId: pcId }, change: { kind: "damage", amount: 2 } });
        for (let n = 1; n <= 10; n++) assert.equal(await answer(p.sent, n), null, `save ${n}`);
        assert.deepEqual(await answer(p.sent, 11), { code: "quota", message: BLOCK_SAVES_TOO_FAST });
        assert.equal(await answer(p.sent, 12), null, "the move after it is taken");
        assert.equal(await answer(p.sent, 13), null, "and the HP change");
        assert.ok(!p.sent.some((m) => m.t === "retry"), "no busy and no gap");
        assert.equal(actor.committed.state.tokens[pcId]!.x, 3);
        assert.equal(Object.keys(actor.committed.state.companionBlocks).length, 9);
        // One more after 6 s, and not two.
        clock.now += LIMITS.companionBlockWriteRefillMs;
        await actor.op(p.conn, 14, create(characterId));
        await actor.op(p.conn, 15, create(characterId));
        assert.equal(await answer(p.sent, 14), null);
        assert.deepEqual(await answer(p.sent, 15), { code: "quota", message: BLOCK_SAVES_TOO_FAST });
        // The DM's saves are not counted.
        for (let n = 1; n <= 15; n++) await actor.op(dmSocket.conn, n, create(characterId));
        for (let n = 1; n <= 15; n++) assert.equal(await answer(dmSocket.sent, n), null, `the DM's save ${n}`);
      },
      {},
      { now: () => clock.now },
    );
  });

  test("a room at its storage quota takes a block's delete from its player and the DM, and refuses a save in the blocks' words", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, characterId } = breeRoom(dm, player);
    state.companionBlocks.owl = testBlock("owl", characterId, { name: "Owl" });
    await withSockets(
      state,
      dm,
      player,
      async (actor, { dm: d, player: p }) => {
        await actor.op(p.conn, 1, create(characterId));
        assert.deepEqual(await answer(p.sent, 1), { code: "quota", message: BLOCKS_AT_QUOTA });
        await actor.op(p.conn, 2, { t: "companionBlock.update", blockId: "moth", patch: { ac: 13 } });
        assert.deepEqual(await answer(p.sent, 2), { code: "quota", message: BLOCKS_AT_QUOTA });
        await actor.op(p.conn, 3, { t: "companionBlock.delete", blockId: "moth" });
        assert.equal(await answer(p.sent, 3), null);
        await actor.op(d.conn, 1, { t: "companionBlock.update", blockId: "owl", patch: { ac: 13 } });
        assert.deepEqual(await answer(d.sent, 1), { code: "quota", message: BLOCKS_AT_QUOTA });
        await actor.op(d.conn, 2, { t: "companionBlock.delete", blockId: "owl" });
        assert.equal(await answer(d.sent, 2), null);
        assert.deepEqual(actor.committed.state.companionBlocks, {});
        // Other ops keep the room's own words.
        await actor.op(d.conn, 3, { t: "log.chat", text: "hi" });
        assert.equal((await answer(d.sent, 3))?.message, "the room is full: it is at its storage quota, so only deletions are accepted");
      },
      { readOnly: true },
    );
  });

  test("a block save the room's state limit refuses says what to do about it, keeping the code, and other ops keep the guard's words", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, characterId, pcId } = breeRoom(dm, player);
    const stateLimit = serializedBytes(state) + 2_500;
    await withSockets(
      state,
      dm,
      player,
      async (actor, { player: p }) => {
        // A small block fits, and one that carries the room past its limit does not.
        await actor.op(p.conn, 1, { t: "companionBlock.update", blockId: "moth", patch: { ac: 13 } });
        assert.equal(await answer(p.sent, 1), null);
        const { rev: _rev, ...big } = testBlock(uuidv7(), characterId, { traits: [{ name: "", text: "x".repeat(3_000) }] });
        await actor.op(p.conn, 2, { t: "companionBlock.create", block: big });
        assert.deepEqual(await answer(p.sent, 2), { code: "quota", message: BLOCKS_ROOM_TOO_FULL });
        await actor.op(p.conn, 3, { t: "companionBlock.update", blockId: "moth", patch: { traits: [{ name: "", text: "x".repeat(3_000) }] } });
        assert.deepEqual(await answer(p.sent, 3), { code: "quota", message: BLOCKS_ROOM_TOO_FULL });
        await actor.op(p.conn, 4, { t: "token.update", tokenId: pcId, patch: { notes: "n".repeat(3_000) } });
        assert.deepEqual(await answer(p.sent, 4), { code: "quota", message: "the room is full: it is at its 0 MiB size limit" });
        // A delete never grows the room.
        await actor.op(p.conn, 5, { t: "companionBlock.delete", blockId: "moth" });
        assert.equal(await answer(p.sent, 5), null);
      },
      {},
      { sizeLimits: { stateLimit } },
    );
  });

  /*
   * A character's own stat block (docs/design-v1-pc-stats.md 4.1) spends the same budget: a create carrying one, and an
   * update naming it, removing it included. An update of anything else is not counted.
   */
  const pcStats = (stats: object | null, characterId: string): Op => ({ t: "character.update", characterId, patch: { stats } as never });

  test("every player op that writes a character's stat block spends the blocks' budget, and other character edits do not", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, characterId } = breeRoom(dm, player);
    state.meta.settings.playersCreateCharacters = true;
    await withSockets(state, dm, player, async (actor, { player: p }) => {
      const mine = (id: string, stats?: object): Op => ({
        t: "character.create",
        character: { id, name: "Mira", size: "medium", ownerIds: [player.id], actor: { ...testActor(), dmNotes: "" }, ...(stats ? { stats } as never : {}) },
      });
      await actor.op(p.conn, 1, mine(uuidv7(), { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, saves: [], skills: {}, adjust: {}, defenses: {}, rolls: [] }));
      for (let n = 2; n <= 8; n++) await actor.op(p.conn, n, pcStats({ saves: n % 2 ? ["dex"] : [] }, characterId));
      await actor.op(p.conn, 9, pcStats(null, characterId));
      await actor.op(p.conn, 10, { t: "character.update", characterId, patch: { name: "Bree Tallow" } });
      await actor.op(p.conn, 11, mine(uuidv7()));
      await actor.op(p.conn, 12, create(characterId));
      await actor.op(p.conn, 13, pcStats({}, characterId));
      for (let n = 1; n <= 12; n++) assert.equal(await answer(p.sent, n), null, `op ${n}`);
      assert.deepEqual(await answer(p.sent, 13), { code: "quota", message: BLOCK_SAVES_TOO_FAST }, "a create with a block, seven saves, a removal and a companion block's create are ten");
    });
  });

  test("a room at its storage quota takes a character's block removal alone, and refuses its save in the blocks' words", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, characterId } = breeRoom(dm, player);
    state.characters[characterId] = { ...state.characters[characterId]!, stats: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, saves: [], skills: {}, adjust: {}, defenses: {}, rolls: [] } };
    await withSockets(
      state,
      dm,
      player,
      async (actor, { player: p }) => {
        await actor.op(p.conn, 1, pcStats({ saves: ["dex"] }, characterId));
        assert.deepEqual(await answer(p.sent, 1), { code: "quota", message: BLOCKS_AT_QUOTA });
        await actor.op(p.conn, 2, { t: "character.update", characterId, patch: { stats: null, name: "Bree" } });
        assert.equal((await answer(p.sent, 2))?.code, "quota", "a removal with another change is an edit");
        await actor.op(p.conn, 3, pcStats(null, characterId));
        assert.equal(await answer(p.sent, 3), null);
        assert.equal(actor.committed.state.characters[characterId]!.stats, undefined);
      },
      { readOnly: true },
    );
  });

  test("a character's block save the room's state limit refuses says what to do about it", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const { state, characterId } = breeRoom(dm, player);
    const stateLimit = serializedBytes(state) + 2_500;
    await withSockets(
      state,
      dm,
      player,
      async (actor, { player: p }) => {
        const rolls = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, name: "x".repeat(60), kind: "other", dice: [{ formula: "1d6".padEnd(40, " ") }] }));
        await actor.op(p.conn, 1, pcStats({ rolls }, characterId));
        assert.deepEqual(await answer(p.sent, 1), { code: "quota", message: BLOCKS_ROOM_TOO_FULL });
      },
      {},
      { sizeLimits: { stateLimit } },
    );
  });
});

describe("a player's undo of getting on and off (docs/design-v1-attach.md 8.3)", () => {
  test("Ride, then Undo move on the same turn, and Get off, then its undo, through the room actor's own steps", async () => {
    const dm = member("DM", "dm");
    const player = member("Ayla", "player");
    const initial = createInitialState({ roomName: "Fake", dm });
    const sceneId = initial.meta.playerSceneId!;
    initial.members[player.id] = player;
    initial.tokens.thorn = testToken("thorn", { sceneId, name: "Thorn", kind: "pc", disposition: "ally", ownerIds: [player.id], x: 4, y: 6, actor: { inline: testActor({ speeds: { walk: 30 } }) } });
    initial.tokens.horse = testToken("horse", { sceneId, name: "Warhorse", kind: "npc", size: "large", disposition: "ally", ownerIds: [player.id], x: 4, y: 4, actor: { inline: testActor({ speeds: { walk: 60 } }) } });
    const db = new FakeDb({ state: initial, dmGrants: [dm.id] });
    const actor = await RoomActor.load(deps(db));
    assert.ok(actor);
    try {
      const table = connect(actor, dm);
      const phone = connect(actor, player, "player");
      await actor.hello(table.conn, { clientId: "c1", resumeFrom: 1 });
      await actor.hello(phone.conn, { clientId: "c2", resumeFrom: 1 });
      await actor.op(table.conn, 1, { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eh", tokenId: "horse", value: 8 }] });
      await actor.op(table.conn, 2, { t: "encounter.next" });
      assert.notEqual(await answerTo(table.sent, 2), "stuck");
      const thorn = () => actor.committed.state.tokens.thorn!;
      const mounts = () => actor.committed.state.encounter?.turnStart?.mounts;
      const ok = async (n: number, op: Op) => {
        await actor.op(phone.conn, n, op);
        const ev = await answerTo(phone.sent, n);
        assert.ok(ev !== "stuck" && !(ev.rejects?.some((r) => r.n === n) ?? false), `${op.t} ${n}: ${JSON.stringify(ev)}`);
        return ev;
      };
      const ride: Op = { t: "token.attach", tokenId: "thorn", to: "horse", kind: "ride", steer: true, x: 4, y: 5, elevation: 0 };
      await ok(1, ride);
      assert.deepEqual(mounts(), ["horse"]);
      // A mistaken Ride is taken back by Undo move, link, seat and the turn's sharing alike.
      const undone = await ok(2, { t: "undo" });
      assert.deepEqual(undone.restored, [{ n: 2, what: "putting Thorn on Warhorse" }]);
      assert.equal(thorn().attached, undefined);
      assert.deepEqual([thorn().x, thorn().y], [4, 6]);
      assert.equal(mounts(), undefined);
      await ok(3, ride);
      await ok(4, { t: "token.detach", tokenId: "thorn", x: 6, y: 6 });
      assert.equal(mounts(), undefined);
      // Undoing the Get off on the same turn puts the ride back, and the mount on the turn's list (the restore's rides).
      await ok(5, { t: "undo" });
      assert.deepEqual(thorn().attached, { to: "horse", kind: "ride", steer: true });
      assert.deepEqual(mounts(), ["horse"]);
      const restores = db.storedOps.filter((op) => (op as { t: string }).t === "sys.restore") as { rides?: unknown[] }[];
      assert.ok(restores.some((op) => op.rides !== undefined), "the restore names the ride it puts back");
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});

describe("traps in the actor (docs/design-v1-traps.md 6.5 and 6.7)", () => {
  const plate = (sceneId: string, over: Partial<Trap["rig"]> = {}, x = 4): Trap => ({
    id: "plate",
    rev: 0,
    sceneId,
    name: "Plate",
    zone: { cells: [{ x, y: 2, w: 1, h: 1 }] },
    state: "armed",
    found: false,
    rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "Click.", ...over },
  });

  /** A DM and Thorn's player at one table, each op answered with its refusal or null. */
  async function withTable(
    state: RoomState,
    dm: Member,
    pc: Member,
    run: (actor: RoomActor, dmSend: (op: Op, group?: string) => Promise<{ code: string; message: string } | null>, pcSend: (op: Op, group?: string) => Promise<{ code: string; message: string } | null>) => Promise<void>,
    options: Partial<ActorDeps["options"]> = {},
  ): Promise<void> {
    const db = new FakeDb({ state, dmGrants: [dm.id] });
    const base = deps(db);
    const actor = await RoomActor.load({ ...base, options: { ...base.options, ...options } });
    assert.ok(actor);
    try {
      const sender = async (who: Member, role: "dm" | "player", client: string) => {
        const c = connect(actor, who, role);
        await actor.hello(c.conn, { clientId: client, resumeFrom: 1 });
        let n = 0;
        return async (op: Op, group?: string) => {
          n++;
          await actor.op(c.conn, n, op, group);
          const answer = await answerTo(c.sent, n);
          assert.ok(answer !== "stuck");
          const refusal = answer.rejects?.find((r) => r.n === n);
          return refusal ? { code: refusal.code, message: refusal.message } : null;
        };
      };
      await run(actor, await sender(dm, "dm", "c1"), await sender(pc, "player", "c2"));
    } finally {
      db.freeze();
      void actor.shutdown({ code: 1012, snapshot: false });
    }
  }

  function table(over: Partial<Trap["rig"]> = {}): { state: RoomState; dm: Member; pc: Member; sceneId: string } {
    const dm = member("DM", "dm");
    const pc = member("Thorn's player", "player");
    const state = createInitialState({ roomName: "Traps", dm });
    state.members[pc.id] = pc;
    const sceneId = state.meta.playerSceneId!;
    state.tokens.thorn = testToken("thorn", { sceneId, kind: "pc", name: "Thorn", disposition: "ally", x: 1, y: 2, ownerIds: [pc.id] });
    state.tokens.imp = testToken("imp", { sceneId, kind: "npc", name: "Imp", x: 1, y: 3, ownerIds: [pc.id], visibility: "dm" });
    state.tokens.gob = testToken("gob", { sceneId, name: "Goblin", x: 1, y: 2 + 2 });
    state.traps = { plate: plate(sceneId, over) };
    return { state, dm, pc, sceneId };
  }

  test("a player's undo of a move a trap stopped is refused and dropped, and the DM's takes it back", async () => {
    const { state, dm, pc } = table();
    await withTable(state, dm, pc, async (actor, dmSend, pcSend) => {
      assert.equal(await pcSend({ t: "token.move", tokenId: "thorn", x: 8, y: 2 }), null);
      assert.equal(actor.committed.state.tokens.thorn!.x, 4, "stopped on the plate");
      assert.deepEqual(await pcSend({ t: "undo" }), { code: "invalid", message: "could not undo moving Thorn: something happened on the way. Ask the DM" });
      assert.deepEqual(await pcSend({ t: "undo" }), { code: "invalid", message: "nothing to undo" }, "the step was dropped");
      assert.equal(actor.committed.state.tokens.thorn!.x, 4);
      assert.equal(await dmSend({ t: "token.move", tokenId: "gob", x: 8, y: 4 }), null);
      assert.equal(await dmSend({ t: "undo" }), null);
      assert.equal(actor.committed.state.tokens.gob!.x, 1);
    });
  });

  test("the ack marks a player's op whose trap step refuses its Undo move, and only that one", async () => {
    for (const [x, marked] of [[8, true], [4, false]] as const) {
      // Silent and never marking itself found: only a stop short of where the move asked shows.
      const { state, dm, pc } = table({ message: undefined, foundOnSpring: false });
      const db = new FakeDb({ state, dmGrants: [dm.id] });
      const actor = await RoomActor.load(deps(db));
      assert.ok(actor);
      try {
        const { conn, sent } = connect(actor, pc, "player");
        await actor.hello(conn, { clientId: "c2", resumeFrom: 1 });
        await actor.op(conn, 1, { t: "token.move", tokenId: "thorn", x, y: 2 });
        const answer = await answerTo(sent, 1);
        assert.ok(answer !== "stuck" && answer.acks?.includes(1));
        assert.equal(actor.committed.state.traps.plate!.state, "sprung");
        assert.deepEqual(answer.trapped, marked ? [1] : undefined, `a move to ${x}`);
        await actor.op(conn, 2, { t: "undo" });
        const undone = await answerTo(sent, 2);
        assert.ok(undone !== "stuck");
        assert.equal(undone.rejects?.length ?? 0, marked ? 1 : 0, "the undo answers as the mark says");
      } finally {
        db.freeze();
        void actor.shutdown({ code: 1012, snapshot: false });
      }
    }
  });

  test("one trapped op marks its whole gesture, so the merged step's undo is refused too", async () => {
    const { state, dm, pc } = table();
    await withTable(state, dm, pc, async (actor, _dmSend, pcSend) => {
      assert.equal(await pcSend({ t: "token.move", tokenId: "thorn", x: 2, y: 2 }, "drag-1"), null);
      assert.equal(await pcSend({ t: "token.move", tokenId: "thorn", x: 8, y: 2 }, "drag-1"), null);
      assert.equal(actor.committed.state.tokens.thorn!.x, 4);
      assert.equal((await pcSend({ t: "undo" }))?.message, "could not undo moving Thorn: something happened on the way. Ask the DM");
    });
  });

  test("after a silent trap, or one only the player's hidden imp set off, the player's undo moves the token back", async () => {
    const silent = table({ stops: false, message: undefined, foundOnSpring: false });
    await withTable(silent.state, silent.dm, silent.pc, async (actor, _dmSend, pcSend) => {
      assert.equal(await pcSend({ t: "token.move", tokenId: "thorn", x: 8, y: 2 }), null);
      assert.equal(actor.committed.state.traps.plate!.state, "sprung");
      assert.equal(await pcSend({ t: "undo" }), null);
      assert.equal(actor.committed.state.tokens.thorn!.x, 1);
      assert.equal(actor.committed.state.traps.plate!.state, "sprung", "the trap's writes stay");
    });
    const hidden = table();
    hidden.state.traps.plate = { ...hidden.state.traps.plate!, zone: { cells: [{ x: 4, y: 3, w: 1, h: 1 }] } };
    await withTable(hidden.state, hidden.dm, hidden.pc, async (actor, _dmSend, pcSend) => {
      assert.equal(await pcSend({ t: "token.moveMany", moves: [{ tokenId: "imp", x: 8, y: 3 }] }), null);
      assert.equal(actor.committed.state.tokens.imp!.x, 8);
      assert.equal(actor.committed.state.traps.plate!.rig!.due?.[0]?.hidden, true);
      assert.equal(await pcSend({ t: "undo" }), null);
      assert.equal(actor.committed.state.tokens.imp!.x, 1);
    });
  });

  test("the Passive Perception hint is the DM's alone: the player's undo of the move it came with moves the token back", async () => {
    const { state, dm, pc } = table({ notice: true, find: [{ ability: "wis", skill: "perception", dc: 5 }] });
    state.traps.plate = { ...state.traps.plate!, zone: { cells: [{ x: 8, y: 2, w: 1, h: 1 }] } };
    await withTable(state, dm, pc, async (actor, _dmSend, pcSend) => {
      assert.equal(await pcSend({ t: "token.move", tokenId: "thorn", x: 6, y: 2 }), null);
      assert.equal(actor.committed.state.traps.plate!.rig!.noticedBy, "thorn");
      assert.equal(actor.committed.state.trapLog.at(-1)?.data?.type, "trapNotice");
      assert.equal(await pcSend({ t: "undo" }), null);
      assert.equal(actor.committed.state.tokens.thorn!.x, 1);
      assert.equal(actor.committed.state.traps.plate!.rig!.noticedBy, "thorn", "the hint stays");
    });
  });

  test("a pit whose opened ground would split its scene's walls past the cap: the import refuses it, and a room holding one keeps it shut", async () => {
    // Short upright walls, 1/64 of a square apart, across four strips of pit: opened, each strip's two ledges cut every wall.
    // Each cut makes two pieces: 500 walls make 8,000 extra, past the cap of 5,000, and 250 make 4,000.
    const xs = Array.from({ length: 600 }, (_, k) => (1 + k) / 64).filter((x) => !Number.isInteger(x));
    const strips = [1, 3, 5, 7].map((y) => ({ x: 0, y, w: 20, h: 1 }));
    for (const count of [500, 250]) {
      const { state, dm, pc, sceneId } = table();
      state.scenes[sceneId] = { ...state.scenes[sceneId]!, bounds: { w: 40, h: 30 } };
      const walls: FreeWall[] = xs.slice(0, count).map((x, k) => ({ id: `w${String(k).padStart(11, "0")}`, a: [x, 0.5], b: [x, 8.5], f: { kind: "wall" } }));
      const built = applyOp(state, { t: "build.walls", sceneId, put: walls }, { memberId: dm.id, role: "dm" }, { seq: 1, at: new Date().toISOString() });
      assert.ok(built.ok);
      const room = built.state;
      room.traps = { plate: { ...plate(sceneId, { pit: { floor: -10 } }), zone: { cells: strips } } };
      // Past the walls' east end, so his walk meets no wall.
      room.tokens.thorn = { ...room.tokens.thorn!, x: 18 };
      const opens = count === 250;
      // The import counts every pit's border ahead, as the limits step does.
      if (opens) assert.doesNotThrow(() => assertWithinLimits(room));
      else assert.throws(() => assertWithinLimits(room), (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === splitRefusal("pieces"));
      // A room that holds such a pit anyway, as one kept from before a cap was lowered, skips it.
      await withTable(room, dm, pc, async (actor, _dmSend, pcSend) => {
        assert.equal(await pcSend({ t: "token.move", tokenId: "thorn", x: 18, y: 3 }), null);
        const line = actor.committed.state.trapLog.at(-1)?.data;
        assert.equal(line?.type, "trap");
        assert.deepEqual(line?.type === "trap" ? line.did : null, [{ action: -1, ok: opens }], `${count} walls`);
        assert.equal(groundAt(actor.committed.state.buildChunks, sceneId, 18, 3), opens ? -10 : 0);
        assert.ok(splitCheck(actor.committed.state, sceneId).ok, "the room stays within the split's caps");
      });
    }
  });

  test("rooms just under the size limit answer the same whether a silent trap goes off or not", async () => {
    const answers: string[][] = [];
    for (const armed of [true, false]) {
      const { state, dm, pc } = table({ stops: false, message: undefined, damage: [{ formula: "1d6", type: "fire" }] });
      if (!armed) state.traps.plate = { ...state.traps.plate!, state: "disarmed" };
      const stateLimit = measuredStateBytes(state) + exploredReserve(state) + 600;
      const out: string[] = [];
      await withTable(
        state,
        dm,
        pc,
        async (actor, dmSend, pcSend) => {
          assert.equal(await pcSend({ t: "token.move", tokenId: "thorn", x: 8, y: 2 }), null);
          assert.equal(actor.committed.state.traps.plate!.state, armed ? "sprung" : "disarmed");
          for (let extra = 0; extra < 12; extra++) {
            const room0 = actor.committed.state;
            const spare = stateLimit - measuredStateBytes(room0) - exploredReserve(room0);
            const had = room0.tokens.gob!.notes?.length ?? 0;
            const sent = await dmSend({ t: "token.update", tokenId: "gob", patch: { notes: "n".repeat(Math.max(0, had + spare - 30 + 4 * extra)) } });
            out.push(sent ? `${sent.code}: ${sent.message}` : "ok");
          }
        },
        { sizeLimits: { stateLimit } },
      );
      answers.push(out);
    }
    assert.deepEqual(answers[0], answers[1]);
    assert.ok(answers[0]!.includes("ok") && answers[0]!.some((a) => a.startsWith("quota")), answers[0]!.join(", "));
  });
});
