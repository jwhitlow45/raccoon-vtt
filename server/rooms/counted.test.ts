import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { COUNT_OP_VERSION, OP_VERSION } from "#shared/migrate.ts";
import { member } from "#shared/testutil.ts";
import { clientOps, serverOnlyOps, type OpType } from "#shared/protocol.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { counted } from "./counted.ts";
import { forgetSceneOp } from "./remember.ts";
import { scopeActor, scopeFixture } from "./undoScopeTesting.ts";

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
