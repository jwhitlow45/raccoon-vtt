import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ID_TIME_REFUSED, uuidv7 } from "#shared/ids.ts";
import { ID_BUDGET, ID_TIME, IDS_TOO_FAST } from "#shared/limits.ts";
import { ID_HELD_MS, ID_TAKEN, IdGate, idRow, seedRows, SERVER_MEMBER, type IdRow } from "./createIds.ts";

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const MINUTE = 60_000;

function clock(start = T0) {
  let now = start;
  return { now: () => now, set: (at: number) => void (now = at), add: (ms: number) => void (now += ms) };
}

const player = (memberId = "p1") => ({ memberId, role: "player" as const });
const dm = (memberId = "d1") => ({ memberId, role: "dm" as const });

/** Stages and commits one op's ids, as the actor does once the op applied and its batch landed. */
function take(gate: IdGate, ids: readonly string[], memberId: string, at: number): IdRow[] {
  const rows = ids.map((id) => idRow(id, memberId, at));
  gate.stage(rows);
  gate.committed(rows);
  return rows;
}

describe("the id gate's shape and clock", () => {
  test("a live op's id that is not version 7 is refused with the words the device retries on, and a stored one is not asked", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    for (const id of ["t1", crypto.randomUUID(), `auto-unconscious:${"0".repeat(64)}`]) {
      assert.deepEqual(gate.check([id], player()), { ok: false, code: "invalid", message: ID_TIME_REFUSED }, id);
      assert.deepEqual(gate.check([id], player(), false), { ok: true }, id);
    }
  });

  test("an id up to 5 seconds ahead or 30 minutes behind the server's clock passes, and one just past either is refused", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.equal(gate.check([uuidv7(T0 + ID_TIME.aheadMs)], player()).ok, true);
    assert.equal(gate.check([uuidv7(T0 - ID_TIME.behindMs)], player()).ok, true);
    assert.deepEqual(gate.check([uuidv7(T0 + ID_TIME.aheadMs + 1)], player()), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.deepEqual(gate.check([uuidv7(T0 - ID_TIME.behindMs - 1)], player()), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("a DM's id dated a minute ahead is refused, as the server's own would be", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.deepEqual(gate.check([uuidv7(T0 + MINUTE)], dm()), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.deepEqual(gate.check([uuidv7(T0 + MINUTE)], "server"), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("for 30 minutes after the cutover an id dated before it is refused, and after them the clock alone reads", () => {
    const c = clock();
    const gate = new IdGate(c.now, T0);
    c.add(10 * MINUTE);
    assert.deepEqual(gate.check([uuidv7(T0 - 1)], player()), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.equal(gate.check([uuidv7(T0)], player()).ok, true);
    c.set(T0 + ID_TIME.behindMs + MINUTE);
    assert.equal(gate.check([uuidv7(T0 + 2 * MINUTE)], player()).ok, true);
    assert.equal(gate.check([uuidv7(T0 + MINUTE - 1)], player()).ok, false, "past the window the clock's 30 minutes refuse it");
  });

  test("every id of the op is read: one bad id refuses the op", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.deepEqual(gate.check([uuidv7(T0), "e1"], player()), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });
});

describe("the id gate's rows", () => {
  test("an id staged or recorded answers gone until its row's time, whoever brings it, and the server too", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const id = uuidv7(T0);
    const [row] = [idRow(id, "p1", T0)];
    gate.stage([row!]);
    for (const sender of [player("p1"), player("p2"), dm(), "server" as const]) assert.deepEqual(gate.check([id], sender), { ok: false, code: "gone", message: ID_TAKEN });
    gate.committed([row!]);
    c.set(T0 + ID_TIME.behindMs);
    assert.deepEqual(gate.check([id], player("p2")), { ok: false, code: "gone", message: ID_TAKEN });
    assert.equal(gate.taken(id), true);
    c.set(row!.until);
    assert.equal(gate.taken(id), false, "its row is no longer read once step 2 can no longer pass the id");
    assert.deepEqual(gate.check([id], player("p2")), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("a row's times: read until its id's own time or its taking, whichever is later, passes the window, and asked about for 12 hours", () => {
    const ahead = uuidv7(T0 + 4_000);
    assert.deepEqual(idRow(ahead, "p1", T0), { id: ahead, memberId: "p1", acceptedAt: T0, until: T0 + 4_000 + ID_HELD_MS, askUntil: T0 + ID_TIME.askMs });
    const behind = uuidv7(T0 - 10 * MINUTE);
    assert.equal(idRow(behind, "p1", T0).until, T0 + ID_HELD_MS);
    assert.equal(ID_HELD_MS, ID_TIME.behindMs + ID_TIME.aheadMs);
  });

  test("a batch that never commits frees its ids and gives its budget back", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const ids = [uuidv7(T0), uuidv7(T0)];
    const rows = ids.map((id) => idRow(id, "p1", T0));
    gate.stage(rows);
    assert.equal(gate.spent("p1"), 2);
    gate.abandoned(rows);
    assert.equal(gate.spent("p1"), 0);
    assert.equal(gate.check(ids, player("p1")).ok, true);
  });

  test("rows loaded with the room hold their ids and their members' budgets", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const id = uuidv7(T0 - MINUTE);
    gate.load([idRow(id, "p1", T0 - MINUTE), idRow(uuidv7(T0 - 2 * MINUTE), "p1", T0 - 2 * MINUTE)]);
    assert.equal(gate.taken(id), true);
    assert.equal(gate.spent("p1"), 2);
  });
});

describe("the id budget", () => {
  test("a player's 2,001st id in 30 minutes is refused in its words, whatever became of the first 2,000", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    for (let i = 0; i < ID_BUDGET.player; i++) {
      const id = uuidv7(c.now());
      assert.equal(gate.check([id], player()).ok, true, `id ${i + 1}`);
      take(gate, [id], "p1", c.now());
      c.add(10);
    }
    assert.deepEqual(gate.check([uuidv7(c.now())], player()), { ok: false, code: "quota", message: IDS_TOO_FAST });
    assert.equal(gate.check([uuidv7(c.now())], player("p2")).ok, true, "another member's budget is their own");
    c.set(T0 + ID_BUDGET.windowMs + 1);
    assert.equal(gate.check([uuidv7(c.now())], player()).ok, true, "the window moves on");
  });

  test("an op that brings several ids spends one for each, and the DM's budget is 20,000", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    take(gate, Array.from({ length: ID_BUDGET.player - 1 }, () => uuidv7(T0)), "p1", T0);
    assert.equal(gate.check([uuidv7(T0)], player()).ok, true);
    assert.deepEqual(gate.check([uuidv7(T0), uuidv7(T0)], player()), { ok: false, code: "quota", message: IDS_TOO_FAST });
    take(gate, Array.from({ length: ID_BUDGET.dm }, () => uuidv7(T0)), "d1", T0);
    assert.deepEqual(gate.check([uuidv7(T0)], dm()), { ok: false, code: "quota", message: IDS_TOO_FAST });
  });

  test("the server's own ids spend no budget", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    take(gate, Array.from({ length: ID_BUDGET.dm + 1 }, () => uuidv7(T0)), SERVER_MEMBER, T0);
    assert.equal(gate.check([uuidv7(T0)], "server").ok, true);
    assert.equal(gate.spent(SERVER_MEMBER), 0);
  });
});

describe("rows a room's first load gives its ids", () => {
  test("every version 7 id the state names, as a key or a value, dated inside the window, until its own time passes it", () => {
    const now = T0;
    const recent = uuidv7(now - 10 * MINUTE);
    const ahead = uuidv7(now + 2 * 60 * MINUTE);
    const old = uuidv7(now - ID_TIME.behindMs - 1);
    const nested = uuidv7(now - MINUTE);
    const state = { tokens: { [recent]: { id: recent, actor: { inline: { effects: [{ id: nested }] } } } }, old: [old, "t1"], ahead };
    const rows = seedRows(state, now);
    assert.deepEqual(
      new Map(rows.map((r) => [r.id, r])),
      new Map([
        [recent, { id: recent, memberId: SERVER_MEMBER, acceptedAt: now, until: now - 10 * MINUTE + ID_HELD_MS, askUntil: now + ID_TIME.askMs }],
        [nested, { id: nested, memberId: SERVER_MEMBER, acceptedAt: now, until: now - MINUTE + ID_HELD_MS, askUntil: now + ID_TIME.askMs }],
        [ahead, { id: ahead, memberId: SERVER_MEMBER, acceptedAt: now, until: now + 2 * 60 * MINUTE + ID_HELD_MS, askUntil: now + ID_TIME.askMs }],
      ]),
    );
  });
});
