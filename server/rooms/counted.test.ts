import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { COUNT_OP_VERSION, OP_VERSION } from "#shared/migrate.ts";
import { retainedSaveOutcome } from "#shared/saveOutcomes.ts";
import { member } from "#shared/testutil.ts";
import { clientOps, serverOnlyOps, type OpType } from "#shared/protocol.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { IMAGE, seqTwins } from "#shared/seqTestutil.ts";
import { forgetRememberedStamps } from "../assets/cleanup.ts";
import { counted } from "./counted.ts";
import { forgetSceneOp } from "./remember.ts";
import { restartStored, scopeActor, scopeFixture, StoredRoomDb, storedActor, until } from "./undoScopeTesting.ts";

/**
 * The room count's classes (counted.ts): which ops move the count, frozen
 * for every op version, and the member changes over HTTP that move it only
 * when they apply.
 */

const BOOKKEEPING = new Set<OpType>(["sys.explore", "sys.remember", "sys.sound"]);

function typeOf(schema: unknown): OpType {
  const shape = (schema as { shape?: { t?: { value?: unknown } } }).shape;
  const t = shape?.t?.value;
  assert.equal(typeof t, "string");
  return t as OpType;
}

describe("the counted classes", () => {
  const types = [...new Set([...clientOps.map(typeOf), ...serverOnlyOps.map(typeOf)])];

  test("every server-only type is classed, and only the server's explore, remember and music ops are uncounted", () => {
    assert.deepEqual(serverOnlyOps.map(typeOf).sort(), ["sys.dice", "sys.explore", "sys.memberJoin", "sys.memberRemove", "sys.memberSetKind", "sys.remember", "sys.restore", "sys.sound"]);
    assert.ok(types.length > 100, `every op type, ${types.length}`);
    for (const version of [COUNT_OP_VERSION, OP_VERSION]) {
      for (const type of types) assert.equal(counted(type, version), !BOOKKEEPING.has(type), `${type} at ${version}`);
    }
  });

  test("before the room count every row took the next number, so every type counts there", () => {
    for (let version = 1; version < COUNT_OP_VERSION; version++) {
      for (const type of types) assert.equal(counted(type, version), true, `${type} at ${version}`);
    }
  });
});

describe("member changes over HTTP", () => {
  test("one already done or refused leaves the count, and one applied moves it once", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const first = await dm.apply({ t: "log.chat", text: "one" });
    const start = first.seq;
    assert.equal(h.actor.committed.pub, start);
    // A join retried after its member arrived, a kind the member has, and a member gone: no row, no number.
    await h.actor.sys({ t: "sys.memberJoin", member: { id: f.player.id, name: f.player.name, color: f.player.color, kind: "player", createdAt: f.player.createdAt } });
    await h.actor.sys({ t: "sys.memberSetKind", memberId: f.player.id, kind: "player" });
    await assert.rejects(h.actor.sys({ t: "sys.memberSetKind", memberId: uuidv7(), kind: "dm" }), /not here/);
    await h.actor.sys({ t: "sys.memberRemove", memberId: uuidv7() });
    const second = await dm.apply({ t: "log.chat", text: "two" });
    assert.equal(second.seq, start + 1, "nothing moved the count between the chats");
    assert.ok(h.actor.committed.state.log.some((l) => l.id === `${start + 1}:0`));
    // An applied join takes the next number.
    const joining = member(uuidv7());
    await h.actor.sys({ t: "sys.memberJoin", member: { id: joining.id, name: "Wren", color: joining.color, kind: "player", createdAt: joining.createdAt } });
    assert.equal(h.actor.committed.pub, start + 2);
    const third = await dm.apply({ t: "log.chat", text: "three" });
    assert.equal(third.seq, start + 3);
  });
});

describe("the server's own ops", () => {
  test("a batch's explore and a cleanup's remember store rows and leave the count", async (t) => {
    const room = twins({ cover: "auto", explore: true }).door;
    const h = await scopeActor(t, room);
    const dm = await h.connect(room.members.dm1!);
    const first = await dm.apply({ t: "log.chat", text: "one" });
    assert.deepEqual(h.db.stored.map((op) => op.t), ["log.chat", "sys.explore"], "the chat's batch explored what the party sees");
    assert.equal(first.seq, 1, "the explore took no number of its own");
    const forget = forgetSceneOp(h.actor.committed.state, "s1");
    assert.ok(forget);
    await h.actor.sys(forget);
    assert.deepEqual(h.db.stored.map((op) => op.t), ["log.chat", "sys.explore", "sys.remember"]);
    assert.equal(h.actor.committed.pub, first.seq);
    const second = await dm.apply({ t: "log.chat", text: "two" });
    assert.equal(second.seq, first.seq + 1);
  });
});

/** A multiple of the batch window, so a frozen clock closes each batch at its own reading. */
const T0 = Date.parse("2026-11-10T20:00:00.000Z");

describe("numbers follow the number clock", () => {
  test("a standing number clock counts by one and dates lines by the server's clock", async (t) => {
    const f = scopeFixture();
    const clock = T0 + 1_234;
    const h = await scopeActor(t, f.state, { now: () => clock });
    const dm = await h.connect(f.dm, "dm", () => clock);
    const first = await dm.apply({ t: "log.chat", text: "one" });
    const second = await dm.apply({ t: "log.chat", text: "two" });
    assert.equal(second.seq, first.seq + 1);
    const lines = h.actor.committed.state.log.slice(-2);
    assert.deepEqual(lines.map((line) => line.id), [`${first.seq}:0`, `${second.seq}:0`]);
    assert.deepEqual(lines.map((line) => line.at), [new Date(clock).toISOString(), new Date(clock).toISOString()]);
  });

  test("on the real clock an answer takes the clock, a line's time is its number, and answers in one millisecond count on by one", async (t) => {
    const f = scopeFixture();
    let clock = T0;
    const h = await storedActor(t, new StoredRoomDb(f.state), { now: () => clock, numberClock: () => clock });
    // Its snapshot was handed T0, the clock as the hello's batch closed.
    const dm = await h.connect(f.dm, "dm", () => clock);
    clock = T0 + 5;
    const sent = [dm.send({ t: "log.chat", text: "a" }), dm.send({ t: "log.chat", text: "b" })];
    await Promise.all(sent);
    const [a, b] = h.actor.committed.state.log.slice(-2);
    assert.deepEqual([a?.id, b?.id], [`${T0 + 5}:0`, `${T0 + 6}:0`]);
    assert.deepEqual([a?.at, b?.at], [new Date(T0 + 5).toISOString(), new Date(T0 + 6).toISOString()]);
    clock = T0 + 900;
    await dm.apply({ t: "log.chat", text: "c" });
    assert.equal(h.actor.committed.state.log.at(-1)?.id, `${T0 + 900}:0`);
  });

  test("a read, then a batch of a cleanup's remember alone, then a restart: the stored number never takes the number the read was handed, and every number after stays above it", async (t) => {
    const room = twins({ cover: "auto", explore: true }).door;
    let clock = T0;
    const options = { now: () => clock, numberClock: () => clock };
    const db = new StoredRoomDb(room);
    const h = await storedActor(t, db, options);
    const dm = await h.connect(room.members.dm1!, "dm", () => clock);
    clock = T0 + 5;
    await dm.apply({ t: "log.chat", text: "one" });
    const stored = db.pub;
    assert.equal(stored, T0 + 5);
    // P1 opens the room at 50: a batch of that read alone hands P1 the clock, and stores nothing.
    clock = T0 + 50;
    const p1 = await h.connect(room.members.p1!, "player", () => clock);
    const handed = p1.sent.find((m) => m.t === "snapshot")!.seq;
    assert.equal(handed, T0 + 50);
    assert.equal(db.pub, stored);
    // A cleanup's remember at 60, in a batch of its own: its row and the room's stored number keep the number stored before the read.
    clock = T0 + 60;
    const rows = db.rows.length;
    const forget = forgetSceneOp(h.actor.committed.state, "s1");
    assert.ok(forget);
    await h.actor.sys(forget);
    const [remember] = db.rows.slice(rows);
    assert.equal((remember?.op as { t?: string }).t, "sys.remember");
    assert.equal(remember?.pub, stored, "a bookkeeping row's envelope is the stored number");
    assert.equal(db.pub, stored, "a commit that answered nothing keeps the stored number");
    // After a restart, P1's reconnect and chat are both above the number it was handed before.
    const again = await restartStored(t, h, { snapshot: false }, options);
    clock = T0 + 70;
    const back = await again.connect(room.members.p1!, "player", () => clock);
    const reconnected = back.sent.find((m) => m.t === "snapshot")!.seq;
    const chat = await back.apply({ t: "log.chat", text: "back" });
    assert.ok(reconnected > handed, `the reconnect's ${reconnected} is above ${handed}`);
    assert.ok(Number(again.actor.committed.state.log.at(-1)!.id.split(":")[0]) > handed);
    assert.ok(chat.seq > handed);
  });

  test("after a batch of a cleanup's remember alone, which no device is sent, reads stop at the stored number, below the number an op staged in the same millisecond takes", async (t) => {
    const room = seqTwins({ stamp: true }).door;
    let clock = T0;
    const db = new StoredRoomDb(room);
    const h = await storedActor(t, db, { now: () => clock, numberClock: () => clock });
    const p1 = await h.connect(room.members.p1!, "player", () => clock);
    clock = T0 + 1_000;
    await p1.apply({ t: "log.chat", text: "ready" });
    const stored = db.pub;
    assert.equal(stored, T0 + 1_000);
    // At 5 s a cleanup forgets a stamp only P2 remembers, in a batch of its own that P1 is sent nothing for.
    clock = T0 + 5_000;
    const frames = p1.sent.length;
    const forgets = forgetRememberedStamps(h.actor.committed.state, new Set([IMAGE]));
    assert.ok(forgets.length > 0);
    for (const op of forgets) await h.actor.sys(op);
    assert.equal(p1.sent.length, frames, "no frame for P1");
    assert.equal(db.pub, stored, "the remember stored no number of its own");
    assert.equal(h.actor.committed.through, stored, "reads stop at the stored number, not at the batch's number no op took");
    // P1's chat in the same millisecond, its commit held, so the committed state does not hold it yet.
    let release: (() => void) | undefined;
    db.beforeCommit = () => new Promise<void>((resolve) => (release = resolve));
    const sent = p1.send({ t: "log.chat", text: "same millisecond" });
    await until(() => release, "the commit held");
    const through = h.actor.committed.through;
    db.beforeCommit = undefined;
    release!();
    await sent;
    const number = Number(h.actor.committed.state.log.at(-1)!.id.split(":")[0]);
    assert.equal(number, T0 + 5_000);
    assert.ok(through < number, `reads stopped at ${through} while the chat numbered ${number} was staged`);
  });

  test("a room that loads with numbers an hour ahead warns once, counts on by one, and dates its lines by the clock", async (t) => {
    const f = scopeFixture();
    const clock = T0 + 5;
    const ahead = clock + 3_600_000;
    const warnings: { aheadMs?: number; message: string }[] = [];
    const log = { info() {}, warn(o: { aheadMs?: number }, message?: string) { warnings.push({ ...o, message: String(message) }); }, error() {}, debug() {} };
    const h = await storedActor(t, new StoredRoomDb(f.state, { pub: ahead }), { now: () => clock, numberClock: () => clock }, log as never);
    const dm = await h.connect(f.dm, "dm", () => clock);
    await dm.apply({ t: "log.chat", text: "one" });
    await dm.apply({ t: "log.chat", text: "two" });
    const warned = warnings.filter((w) => w.message === "room numbers are ahead of the server's clock: check the clock");
    assert.deepEqual(warned.map((w) => w.aheadMs), [3_600_000]);
    const lines = h.actor.committed.state.log.slice(-2);
    assert.deepEqual(lines.map((line) => line.id), [`${ahead + 1}:0`, `${ahead + 2}:0`]);
    assert.deepEqual(lines.map((line) => line.at), [new Date(clock).toISOString(), new Date(clock).toISOString()], "an hour ahead is no line's time");
    // A group save's Apply is dated by the clock too, so its retention runs from now.
    const id = uuidv7(clock);
    await dm.apply({ t: "actor.outcome", label: "Fireball", plan: id, page: { id, expectRevision: 0 }, targets: [{ target: { tokenId: f.goblin }, amount: 3 }] });
    const record = h.actor.committed.state.saveOutcomes?.[id];
    assert.equal(record?.firstAppliedAt, new Date(clock).toISOString());
    assert.ok(retainedSaveOutcome(h.actor.committed.state, id, new Date(clock + 60_000).toISOString()), "in retention a minute on");
  });
});
