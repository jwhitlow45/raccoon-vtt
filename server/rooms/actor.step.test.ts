import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { OpOf, ServerMessage } from "#shared/protocol.ts";
import { ActorClosedError } from "./actor.ts";
import { memoryGrowth } from "./remember.ts";
import { scopeFixture, StoredRoomDb, storedActor, until, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * A deletion step on a loaded room waits for the batch being staged to
 * commit at its own tick, and runs once that commit lands with no batch
 * open, so the committed state it reads is the staged one
 * (RoomActor.deletionStep).
 */

type Ev = Extract<ServerMessage, { t: "ev" }>;

function ackGroups(client: ScopeClient): number[][] {
  return client.sent.flatMap((m) => (m.t === "ev" && (m as Ev).acks?.length ? [(m as Ev).acks!] : []));
}

/** A step that records what it was handed and when, and deletes nothing. */
function recorder() {
  const runs: Array<{ state: RoomState; seq: number }> = [];
  return { runs, run: async (state: RoomState, seq: number) => {
    runs.push({ state, seq });
    return { deleted: [] as string[], result: runs.length };
  } };
}

describe("a deletion step behind a batch", () => {
  test("waits for the batch's own commit, and ops queued after it join that batch and come before it", async (t) => {
    const f = scopeFixture();
    const h = await storedActor(t, new StoredRoomDb(f.state), { batchMs: 20 });
    const p1 = await h.connect(f.player);
    const from = p1.sent.length;
    const step = recorder();
    // One turn of the queue: a chat opens the batch, the step finds it open, a second chat follows.
    void h.actor.op(p1.conn, ++p1.n, { t: "log.chat", text: "before" });
    const ran = h.actor.deletionStep(step.run);
    void h.actor.op(p1.conn, ++p1.n, { t: "log.chat", text: "after" });
    assert.equal(await ran, 1, "it ran once");
    assert.deepEqual(ackGroups(p1).slice(-1), [[p1.n - 1, p1.n]], "both chats in one batch");
    assert.equal(p1.sent.slice(from).filter((m) => m.t === "ev").length, 1);
    const [seen] = step.runs;
    assert.ok(seen);
    assert.deepEqual(seen.state.log.slice(-2).map((line) => line.text), ["before", "after"], "it read the state with the op queued after it");
    assert.equal(seen.state, h.actor.committed.state);
    assert.equal(seen.seq, h.actor.committed.seq);
  });

  test("a batch an ask's reading opens during the commit keeps it waiting for that batch too, and it runs once after", async (t) => {
    const f = scopeFixture();
    const db = new StoredRoomDb(f.state);
    // Each op an ask reads takes longer than a turn of reading, so the ask reads across the commit below.
    const slow: typeof memoryGrowth = (...args) => {
      const until = performance.now() + 10;
      while (performance.now() < until);
      return memoryGrowth(...args);
    };
    const h = await storedActor(t, db, { batchMs: 1, memoryGrowth: slow });
    const dm = await h.connect(f.dm);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let commits = 0;
    db.beforeCommit = async () => {
      if (commits++ === 0) await held;
    };
    const step = recorder();
    const sceneId = f.sceneId;
    const ops: OpOf<"build.paint">[] = [0, 1, 2, 3].map((x) => ({ t: "build.paint", sceneId, terrain: "wood", cells: [`${x},9`] }));
    void h.actor.op(dm.conn, ++dm.n, { t: "log.chat", text: "opens the batch" });
    const ran = h.actor.deletionStep(step.run);
    const ask = ++dm.n;
    void h.actor.op(dm.conn, ask, { t: "build.ask", sceneId, ops, part: 0 }, "g1");
    // The chat's batch closes and holds at its COMMIT while the ask still reads, which then answers in a batch of its own.
    await until(() => (commits > 0 && !h.actor.askState.reading ? true : undefined), "the ask read across the held commit");
    assert.equal(step.runs.length, 0);
    release();
    assert.equal(await ran, 1);
    assert.equal(step.runs.length, 1, "it ran once");
    const answered = dm.sent.findIndex((m) => m.t === "ev" && (m as Ev).acks?.includes(ask));
    assert.ok(answered >= 0, "the ask was answered");
    assert.equal(commits, 2, "the ask's batch committed too");
    assert.equal(step.runs[0]!.seq, h.actor.committed.seq, "after the ask's batch, which stored nothing new");
  });

  test("a shutdown while it waits refuses it once and runs nothing", async (t) => {
    const f = scopeFixture();
    const db = new StoredRoomDb(f.state);
    const h = await storedActor(t, db, { batchMs: 20 });
    const p1 = await h.connect(f.player);
    const step = recorder();
    // The chat opens a batch and the step parks behind it, both in this turn, before the batch's tick.
    void h.actor.op(p1.conn, ++p1.n, { t: "log.chat", text: "open" });
    let refusals = 0;
    const ran = h.actor.deletionStep(step.run).catch((err: unknown) => {
      refusals++;
      throw err;
    });
    await h.actor.shutdown({ code: 1012, snapshot: false });
    await assert.rejects(ran, ActorClosedError);
    assert.equal(refusals, 1);
    assert.equal(step.runs.length, 0);
    assert.ok(db.rows.some((row) => (row.op as { t?: string }).t === "log.chat"), "the batch it waited for was stored");
  });
});
