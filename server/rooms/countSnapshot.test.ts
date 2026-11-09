import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { COUNT_OP_VERSION, COUNT_SNAPSHOT_VERSION, SNAPSHOT_VERSION, runMigrations, snapshotMigrations } from "#shared/migrate.ts";
import type { Member, RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import type { ActorDeps } from "./actor.ts";
import { Connection } from "./connection.ts";
import { snapshotJson } from "./persistence.ts";
import { memoryGrowth } from "./remember.ts";
import { restartStored, scopeFixture, storedActor, StoredRoomDb, until, type StoredRow } from "./undoScopeTesting.ts";

/**
 * The snapshot a room saved before the room count writes again here
 * (actor.ts #countSnapshot): in the transaction of the room's first commit
 * that answered something, refusals and watermarks alone included, at
 * today's version, so an older build refuses the room once a number past
 * its own sequence could have reached a device. Never for a room whose
 * replay failed, nor for one made here or whose load already wrote its
 * snapshot. A build that throws lets its batch commit without it and tries
 * again later, and a running snapshot write finishes first.
 */

const OLD = COUNT_SNAPSHOT_VERSION - 1;

/** Whether a build from before the count, which migrates nothing down, refuses the stored snapshot. */
function olderRefuses(db: StoredRoomDb): boolean {
  try {
    runMigrations(db.snapshot.state, db.snapshot.version, OLD, snapshotMigrations);
    return false;
  } catch (err) {
    assert.match((err as Error).message, /down/);
    return true;
  }
}

/** A chat row as a build before the count stored it. */
const oldChat = (seq: number, who: Member, text = `line ${seq}`): StoredRow => ({ seq, at: new Date(Date.UTC(2026, 10, 1, 12, 0, seq)).toISOString(), actorMemberId: who.id, actorRole: "dm", op: { t: "log.chat", text }, opVersion: COUNT_OP_VERSION - 1, pub: null });

/** A socket that says hello as a page that settled `settled` ops would, and the frames it gets. */
async function settledHello(actor: Awaited<ReturnType<typeof storedActor>>["actor"], who: Member, settled: number) {
  const sent: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close() {}, terminate() {} };
  const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", memberId: who.id, role: "dm" }, "203.0.113.20");
  actor.attach(conn);
  await actor.hello(conn, { clientId: uuidv7(), resumeFrom: settled + 1 });
  return { sent, snapshot: await until(() => sent.find((m) => m.t === "snapshot"), "snapshot") };
}

describe("the first commit of a room saved before the count", () => {
  test("a refusal alone stores the snapshot at today's version with the count in its transaction, which an older build refuses", async (t) => {
    const f = scopeFixture();
    const db = new StoredRoomDb(f.state, { version: OLD });
    const h = await storedActor(t, db);
    const dm = await h.connect(f.dm);
    assert.equal(olderRefuses(db), false, "loaded as it was");
    let landed: { version: number; pub: number | null } | null = null;
    db.beforeCommit = async () => {
      landed = { version: db.snapshot.version, pub: db.pub };
    };
    const refused = await dm.send({ t: "undo", head: uuidv7() });
    assert.equal(refused.rejects?.length, 1);
    assert.deepEqual(landed, { version: OLD, pub: null }, "nothing written before the commit");
    assert.equal(db.rows.length, 0);
    assert.equal(db.snapshotWrites, 1);
    assert.equal(db.snapshot.version, SNAPSHOT_VERSION);
    assert.equal(db.pub, 1);
    assert.equal(refused.seq, 1);
    assert.equal(olderRefuses(db), true, "an older build refuses the room once the count passed its sequence");
    // Written once: the next commit carries none.
    await dm.apply({ t: "log.chat", text: "after" });
    assert.equal(db.snapshotWrites, 1);
  });

  test("a hello's watermark alone does too", async (t) => {
    const f = scopeFixture();
    const db = new StoredRoomDb(f.state, { version: OLD });
    const h = await storedActor(t, db);
    const { snapshot } = await settledHello(h.actor, f.dm, 4);
    assert.equal(snapshot.watermark, 4);
    assert.equal(db.snapshotWrites, 1);
    assert.equal(db.snapshot.version, SNAPSHOT_VERSION);
    assert.equal(db.pub, 0, "a hello moves no count, and the count is written all the same");
    assert.equal(olderRefuses(db), true);
  });

  test("a room made here, and an old room whose load wrote its snapshot, carry none in a commit", async (t) => {
    const f = scopeFixture();
    const made = new StoredRoomDb(f.state);
    const fresh = await storedActor(t, made);
    await (await fresh.connect(f.dm)).apply({ t: "log.chat", text: "new room" });
    assert.equal(made.snapshotWrites, 0);
    assert.equal(made.pub, 1);

    const g = scopeFixture();
    const loaded = new StoredRoomDb(g.state, { version: OLD, rows: [oldChat(1, g.dm), oldChat(2, g.dm), oldChat(3, g.dm)] });
    const old = await storedActor(t, loaded, { snapshotOps: 2 });
    await until(() => (loaded.snapshotWrites === 1 ? true : undefined), "the load's own snapshot");
    assert.equal(loaded.snapshot.version, SNAPSHOT_VERSION);
    assert.equal(loaded.snapshot.seq, 3);
    const chat = await (await old.connect(g.dm)).apply({ t: "log.chat", text: "after the load" });
    assert.equal(chat.seq, 4, "the count went on from the last stored seq");
    assert.equal(loaded.snapshotWrites, 1, "the load's snapshot was the one at today's version");
  });

  test("a room whose replay failed writes the count past every stored number and keeps its snapshot, and its repaired replay numbers a new line", async (t) => {
    const f = scopeFixture();
    const broken: StoredRow = { ...oldChat(2, f.dm), op: { t: "token.delete", tokenId: "missing" } };
    const db = new StoredRoomDb(f.state, { version: OLD, rows: [oldChat(1, f.dm), broken, oldChat(3, f.dm, "the tail's last")] });
    const h = await storedActor(t, db);
    assert.equal(h.actor.replayFailed, true);
    const dm = await h.connect(f.dm);
    const refused = await dm.send({ t: "log.chat", text: "read only" });
    assert.equal(refused.rejects?.length, 1);
    assert.equal(db.pub, 4, "past the 3 the stored tail holds, the refusal's own count included");
    assert.equal(db.snapshotWrites, 0, "a fixed build can still rebuild it from its rows");
    assert.equal(db.snapshot.version, OLD);
    assert.deepEqual(db.rows.map((r) => r.seq), [1, 2, 3]);
    // A fixed build replays it whole and numbers on from the stored count.
    db.rows[1] = { ...broken, op: { t: "log.chat", text: "line 2" } };
    const fixed = await restartStored(t, h, { snapshot: false });
    assert.equal(fixed.actor.replayFailed, false);
    const chat = await (await fixed.connect(f.dm)).apply({ t: "log.chat", text: "after the repair" });
    assert.equal(chat.seq, 5);
    const log = fixed.actor.committed.state.log;
    assert.deepEqual(log.map((l) => l.id), ["1:0", "2:0", "3:0", "5:0"]);
    assert.equal(log.find((l) => l.id === "3:0")?.text, "the tail's last", "no stored line was numbered again");
    assert.equal(db.snapshotWrites, 1, "the repaired room's first commit carries the snapshot");
  });
});

describe("numbers an older build made", () => {
  test("a count stored here never falls below the rows and snapshot an older build wrote after it", async (t) => {
    // A room this build counted to 3, then loaded by an older build, which went on numbering by its seq.
    const f = scopeFixture();
    const snapshotted = new StoredRoomDb(f.state, { version: OLD, seq: 9, pub: 3 });
    const chat = await (await (await storedActor(t, snapshotted)).connect(f.dm)).apply({ t: "log.chat", text: "back here" });
    assert.equal(chat.seq, 10, "past the older build's snapshot at 9");
    const g = scopeFixture();
    const rowed = new StoredRoomDb(g.state, { version: OLD, seq: 2, pub: 3, rows: [oldChat(3, g.dm), oldChat(4, g.dm), oldChat(5, g.dm)] });
    const next = await (await (await storedActor(t, rowed)).connect(g.dm)).apply({ t: "log.chat", text: "back here" });
    assert.equal(next.seq, 6, "past the older build's rows to 5");
  });
});

describe("the build and the write of that snapshot", () => {
  test("a build that throws commits the batch without it and logs once, and a commit past the wait stores it", async (t) => {
    const f = scopeFixture();
    const db = new StoredRoomDb(f.state, { version: OLD });
    let clock = Date.UTC(2026, 10, 9, 12);
    let throws = 2;
    const errors: string[] = [];
    const log: ActorDeps["log"] = { info() {}, warn() {}, debug() {}, error: (_o: unknown, msg?: string) => void errors.push(msg ?? "") };
    const build = (state: RoomState) => {
      if (throws-- > 0) throw new Error("scripted snapshot build fault");
      return snapshotJson(state);
    };
    const h = await storedActor(t, db, { now: () => clock, snapshotJson: build }, log);
    const dm = await h.connect(f.dm, "dm", () => clock);
    const first = await dm.apply({ t: "log.chat", text: "one" });
    assert.equal(first.seq, 1, "the batch committed without it");
    assert.equal(db.snapshotWrites, 0);
    assert.equal(olderRefuses(db), false, "until a later commit stores it, an older build still loads the snapshot");
    assert.equal(db.pub, 1);
    // Within the wait no commit tries again.
    await dm.apply({ t: "log.chat", text: "two" });
    assert.equal(throws, 1, "no second build within the wait");
    clock += 60_001;
    await dm.apply({ t: "log.chat", text: "three" });
    assert.equal(db.snapshotWrites, 0, "the second build threw too");
    assert.equal(errors.filter((m) => m.startsWith("snapshot build failed")).length, 1, "logged once a run");
    clock += 60_001;
    await dm.apply({ t: "log.chat", text: "four" });
    assert.equal(db.snapshotWrites, 1);
    assert.equal(db.snapshot.seq, 4);
    assert.equal(olderRefuses(db), true);
  });

  for (const fails of [0, 1]) {
    test(`a snapshot write running as the first commit starts finishes first, and the two never write at once${fails ? ", a failed one tried again first" : ""}`, async (t) => {
      const g = scopeFixture();
      // Past snapshotOps from the start, so the load writes its snapshot, and a failed write is tried again at once.
      const db = new StoredRoomDb(g.state, { version: OLD, rows: [oldChat(1, g.dm), oldChat(2, g.dm)] });
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      // Let go before the actor's own shutdown, so a failed check never leaves its commit waiting.
      t.after(() => release());
      let failing = fails;
      db.beforeSnapshot = async () => {
        order.push("write starts");
        await held;
        if (failing-- > 0) {
          order.push("write fails");
          throw new Error("scripted snapshot write failure");
        }
        order.push("write lands");
      };
      db.beforeCommit = async () => void order.push(`commit, ${db.snapshotWrites} written`);
      const h = await storedActor(t, db, { snapshotOps: 2 });
      await until(() => (order.length > 0 ? true : undefined), "the load's snapshot write");
      const dm = await h.connect(g.dm);
      const pending = dm.apply({ t: "log.chat", text: "while it writes" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(order, ["write starts"], "the commit waits for the write");
      release();
      const chat = await pending;
      assert.equal(chat.seq, 3);
      const writes = fails ? ["write starts", "write fails", "write starts", "write lands"] : ["write starts", "write lands"];
      assert.deepEqual(order, [...writes, "commit, 1 written"], "never at once");
      // The write that landed was at today's version, so the commit carried none of its own.
      assert.equal(db.snapshotWrites, 1);
      assert.equal(db.snapshot.version, SNAPSHOT_VERSION);
      assert.equal(db.snapshot.seq, 2);
      assert.equal(olderRefuses(db), true);
    });
  }

  test("a batch that answered nothing carries no snapshot, and the answer after it carries it", async (t) => {
    const f = scopeFixture();
    const sceneId = f.sceneId;
    const db = new StoredRoomDb(f.state, { version: OLD });
    let clock = Date.UTC(2026, 10, 9, 12);
    let throws = 1;
    let reading = false;
    // Each op of the ask reads past a turn (ASK_TURN_MS), so its reading spans turns while commits land around it, and each
    // grows a layer, so the reading begins a batch of its own (#memoryEstimate).
    const slow: typeof memoryGrowth = (...args) => {
      const growth = memoryGrowth(...args);
      if (!reading) return growth;
      const until = performance.now() + 12;
      while (performance.now() < until);
      return growth.size > 0 ? growth : new Map([[JSON.stringify([sceneId, null]), 0]]);
    };
    const build = (state: RoomState) => {
      if (throws-- > 0) throw new Error("scripted snapshot build fault");
      return snapshotJson(state);
    };
    const h = await storedActor(t, db, { now: () => clock, memoryGrowth: slow, snapshotJson: build });
    const dm = await h.connect(f.dm, "dm", () => clock);
    // The first commit's build throws, so the room stays armed past it and no commit tries again within the wait.
    assert.equal((await dm.apply({ t: "log.chat", text: "one" })).seq, 1);
    assert.equal(db.snapshotWrites, 0);
    // What each commit found stored as it began, so each one's own writes are the difference to the next.
    type Stored = { rows: number; marks: number; writes: number; pub: number | null };
    const now = (): Stored => ({ rows: db.rows.length, marks: [...db.watermarks.values()].reduce((a, b) => a + b, 0), writes: db.snapshotWrites, pub: db.pub });
    const began: Stored[] = [];
    db.beforeCommit = async () => {
      began.push(now());
      // The wait is over once the chat ahead of the ask commits, so the batch the reading began could try.
      clock += 60_001;
      // Each commit stays in flight across a turn of the reading, so the reading begins a batch meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    reading = true;
    const cells = (y: number) => Array.from({ length: 4 }, (_, x) => `${x},${y}`);
    const ops = Array.from({ length: 16 }, (_, y) => ({ t: "build.paint", sceneId, terrain: "stone", cells: cells(y) }));
    const chat = dm.send({ t: "log.chat", text: "ahead of the ask" });
    const asked = dm.send({ t: "build.ask", sceneId, ops, part: 0 }, "g1");
    const [said, answered] = await Promise.all([chat, asked]);
    reading = false;
    assert.equal(said.acks?.length, 1);
    assert.ok(answered.acks?.length);
    const own = began.map((b, i) => {
      const next = began[i + 1] ?? now();
      return { rows: next.rows - b.rows, marks: next.marks - b.marks, snapshot: next.writes > b.writes };
    });
    const empty = own.filter((c) => c.rows === 0 && c.marks === 0);
    assert.ok(empty.length > 0, `a commit landed while the ask read and answered nothing: ${JSON.stringify(own)}`);
    assert.ok(empty.every((c) => !c.snapshot), "no snapshot rode on a commit that answered nothing");
    assert.equal(db.snapshotWrites, 1);
    assert.ok(own.some((c) => c.snapshot && c.marks > 0), `the snapshot rode on the ask's answer: ${JSON.stringify(own)}`);
    assert.equal(db.pub, 3);
  });
});
