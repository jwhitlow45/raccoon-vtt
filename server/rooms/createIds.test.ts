import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import { ID_TIME_REFUSED, idKeyOf, idTime, sealedId, uuidv7 } from "#shared/ids.ts";
import { ID_BUDGET, ID_PAGE_OLD, ID_SEAL_GRACE_MS, ID_TIME, IDS_TOO_FAST } from "#shared/limits.ts";
import { ID_HELD_MS, ID_TAKEN, IdGate, idRow, LATEST_UNTIL, recordedRow, seedRows, SERVER_MEMBER, type IdRow, type IdSeal } from "./createIds.ts";

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const MINUTE = 60_000;

function clock(start = T0) {
  let now = start;
  return { now: () => now, set: (at: number) => void (now = at), add: (ms: number) => void (now += ms) };
}

const key = (label: string) => idKeyOf(createHash("sha256").update(label).digest());
/** A socket that holds no key, before any cutover: version 7 ids are read in the clear. */
const OPEN: IdSeal = { keyed: false, key: key("unkeyed") };

/** A version 7 id's row, held from its own time. */
function v7Row(id: string, memberId: string, at: number): IdRow {
  return idRow(id, memberId, at, idTime(id) ?? at);
}

const player = (memberId = "p1") => ({ memberId, role: "player" as const });
const dm = (memberId = "d1") => ({ memberId, role: "dm" as const });

/** Stages and commits one op's ids, as the actor does once the op applied and its batch landed. */
function take(gate: IdGate, ids: readonly string[], memberId: string, at: number): IdRow[] {
  const rows = ids.map((id) => v7Row(id, memberId, at));
  gate.stage(rows);
  gate.committed(rows);
  return rows;
}

describe("the id gate's shape and clock", () => {
  test("a live op's id that is neither version 7 nor one the sender's key reads is refused with the words the device retries on, and a stored one is not asked", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    for (const id of ["t1", crypto.randomUUID(), `auto-unconscious:${"0".repeat(64)}`, sealedId(key("another"), T0)]) {
      assert.deepEqual(gate.check([id], player(), OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED }, id);
      assert.equal(gate.check([id], player(), OPEN, false).ok, true, id);
    }
  });

  test("an id up to 5 seconds ahead or 30 minutes behind the server's clock passes, and one just past either is refused", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.equal(gate.check([uuidv7(T0 + ID_TIME.aheadMs)], player(), OPEN).ok, true);
    assert.equal(gate.check([uuidv7(T0 - ID_TIME.behindMs)], player(), OPEN).ok, true);
    assert.deepEqual(gate.check([uuidv7(T0 + ID_TIME.aheadMs + 1)], player(), OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.deepEqual(gate.check([uuidv7(T0 - ID_TIME.behindMs - 1)], player(), OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("a DM's id dated a minute ahead is refused, as the server's own would be", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.deepEqual(gate.check([uuidv7(T0 + MINUTE)], dm(), OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.deepEqual(gate.check([uuidv7(T0 + MINUTE)], "server", OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("for 30 minutes after the cutover an id dated before it is refused, and after them the clock alone reads", () => {
    const c = clock();
    const gate = new IdGate(c.now, T0);
    c.add(10 * MINUTE);
    assert.deepEqual(gate.check([uuidv7(T0 - 1)], player(), OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.equal(gate.check([uuidv7(T0)], player(), OPEN).ok, true);
    c.set(T0 + ID_TIME.behindMs + MINUTE);
    assert.equal(gate.check([uuidv7(T0 + 2 * MINUTE)], player(), OPEN).ok, true);
    assert.equal(gate.check([uuidv7(T0 + MINUTE - 1)], player(), OPEN).ok, false, "past the window the clock's 30 minutes refuse it");
  });

  test("a recorded id may be dated any time before now, but no further ahead than a minted one, whether or not the room holds it", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.deepEqual(gate.checkRecorded([uuidv7(T0 - 3 * 60 * MINUTE), "e1"], false), { ok: true });
    assert.deepEqual(gate.checkRecorded([uuidv7(T0 + ID_TIME.aheadMs)], false), { ok: true });
    const ahead = uuidv7(T0 + ID_TIME.aheadMs + 1);
    assert.deepEqual(gate.checkRecorded([ahead], false), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    gate.load(seedRows({ tokens: { [ahead]: {} } }, T0));
    assert.deepEqual(gate.checkRecorded([ahead], false), { ok: false, code: "invalid", message: ID_TIME_REFUSED }, "held already, the same answer");
  });

  test("every id of the op is read: one bad id refuses the op", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.deepEqual(gate.check([uuidv7(T0), "e1"], player(), OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });
});

describe("the id gate's rows", () => {
  test("an id staged or recorded answers gone until its row's time, whoever brings it, and the server too", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const id = uuidv7(T0);
    const [row] = [v7Row(id, "p1", T0)];
    gate.stage([row!]);
    for (const sender of [player("p1"), player("p2"), dm(), "server" as const]) assert.deepEqual(gate.check([id], sender, OPEN), { ok: false, code: "gone", message: ID_TAKEN });
    gate.committed([row!]);
    c.set(T0 + ID_TIME.behindMs);
    assert.deepEqual(gate.check([id], player("p2"), OPEN), { ok: false, code: "gone", message: ID_TAKEN });
    assert.equal(gate.taken(id), true);
    c.set(row!.until);
    assert.equal(gate.taken(id), false, "its row is no longer read once step 2 can no longer pass the id");
    assert.deepEqual(gate.check([id], player("p2"), OPEN), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("a row's times: read until its id's own time or its taking, whichever is later, passes the window, and asked about for 12 hours", () => {
    const ahead = uuidv7(T0 + 4_000);
    assert.deepEqual(v7Row(ahead, "p1", T0), { id: ahead, memberId: "p1", acceptedAt: T0, until: T0 + 4_000 + ID_HELD_MS, askUntil: T0 + ID_TIME.askMs });
    const behind = uuidv7(T0 - 10 * MINUTE);
    assert.equal(v7Row(behind, "p1", T0).until, T0 + ID_HELD_MS);
    assert.equal(ID_HELD_MS, ID_TIME.behindMs + ID_TIME.aheadMs);
  });

  test("a row dated far ahead holds its id until its own time, and holds no later row in memory past its time", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    // A hash id of version 7 shape, thousands of years ahead, as an old room's state can hold, seeded at the first load.
    const far = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    gate.load(seedRows({ tokens: { [far]: {} } }, T0));
    for (let i = 0; i < 100; i++) take(gate, [uuidv7(T0 + i)], "p1", T0 + i);
    assert.equal(gate.heldCount, 101);
    c.add(ID_HELD_MS + 1_000);
    assert.equal(gate.taken(far), true, "the far id stays taken");
    assert.equal(gate.heldCount, 1, "the rows past their time leave memory");
    c.add(1e15);
    assert.equal(gate.taken(far), false, "past its own time");
    assert.equal(gate.heldCount, 0);
  });

  test("members who never send again leave the budget's memory once their window has passed", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    for (let m = 0; m < 5; m++) take(gate, [uuidv7(T0)], `gone${m}`, T0);
    assert.equal(gate.taken(uuidv7(T0)), false);
    assert.equal(gate.budgetMembers, 5);
    c.add(ID_BUDGET.windowMs + MINUTE);
    take(gate, [uuidv7(c.now())], "p1", c.now());
    assert.equal(gate.taken(uuidv7(c.now())), false);
    assert.equal(gate.budgetMembers, 1, "only the member who sent in the window");
  });

  test("a batch that never commits frees its ids and gives its budget back", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const ids = [uuidv7(T0), uuidv7(T0)];
    const rows = ids.map((id) => v7Row(id, "p1", T0));
    gate.stage(rows);
    assert.equal(gate.spent("p1"), 2);
    gate.abandoned(rows);
    assert.equal(gate.spent("p1"), 0);
    assert.equal(gate.check(ids, player("p1"), OPEN).ok, true);
  });

  test("rows loaded with the room hold their ids and their members' budgets", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const id = uuidv7(T0 - MINUTE);
    gate.load([v7Row(id, "p1", T0 - MINUTE), v7Row(uuidv7(T0 - 2 * MINUTE), "p1", T0 - 2 * MINUTE)]);
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
      assert.equal(gate.check([id], player(), OPEN).ok, true, `id ${i + 1}`);
      take(gate, [id], "p1", c.now());
      c.add(10);
    }
    assert.deepEqual(gate.check([uuidv7(c.now())], player(), OPEN), { ok: false, code: "quota", message: IDS_TOO_FAST });
    assert.equal(gate.check([uuidv7(c.now())], player("p2"), OPEN).ok, true, "another member's budget is their own");
    c.set(T0 + ID_BUDGET.windowMs + 1);
    assert.equal(gate.check([uuidv7(c.now())], player(), OPEN).ok, true, "the window moves on");
  });

  test("an op that brings several ids spends one for each, and the DM's budget is 20,000", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    take(gate, Array.from({ length: ID_BUDGET.player - 1 }, () => uuidv7(T0)), "p1", T0);
    assert.equal(gate.check([uuidv7(T0)], player(), OPEN).ok, true);
    assert.deepEqual(gate.check([uuidv7(T0), uuidv7(T0)], player(), OPEN), { ok: false, code: "quota", message: IDS_TOO_FAST });
    take(gate, Array.from({ length: ID_BUDGET.dm }, () => uuidv7(T0)), "d1", T0);
    assert.deepEqual(gate.check([uuidv7(T0)], dm(), OPEN), { ok: false, code: "quota", message: IDS_TOO_FAST });
  });

  test("the server's own ids spend no budget", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    take(gate, Array.from({ length: ID_BUDGET.dm + 1 }, () => uuidv7(T0)), SERVER_MEMBER, T0);
    assert.equal(gate.check([uuidv7(T0)], "server", OPEN).ok, true);
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

describe("version 8 ids under the sender's key", () => {
  const ana = key("member ana");
  const bea = key("member bea");
  const server = key("server");
  const KEYED_ANA: IdSeal = { keyed: true, key: ana };

  test("a keyed socket's id sealed under its member's key passes, its row held from the time read", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const id = sealedId(ana, T0 - MINUTE);
    const verdict = gate.check([id], player("ana"), KEYED_ANA);
    assert.ok(verdict.ok);
    assert.deepEqual([...verdict.times], [[id, T0 - MINUTE]]);
    assert.equal(idRow(id, "ana", T0, verdict.times.get(id)!).until, T0 + ID_HELD_MS);
    const ahead = sealedId(ana, T0 + 4_000);
    const later = gate.check([ahead], player("ana"), KEYED_ANA);
    assert.ok(later.ok);
    assert.equal(idRow(ahead, "ana", T0, later.times.get(ahead)!).until, T0 + 4_000 + ID_HELD_MS);
  });

  test("the window reads the sealed time: 5 seconds ahead or 30 minutes behind passes, a step past either is refused", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.equal(gate.check([sealedId(ana, T0 + ID_TIME.aheadMs)], player("ana"), KEYED_ANA).ok, true);
    assert.equal(gate.check([sealedId(ana, T0 - ID_TIME.behindMs)], player("ana"), KEYED_ANA).ok, true);
    assert.deepEqual(gate.check([sealedId(ana, T0 + ID_TIME.aheadMs + 1)], player("ana"), KEYED_ANA), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.deepEqual(gate.check([sealedId(ana, T0 - ID_TIME.behindMs - 1)], player("ana"), KEYED_ANA), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("a keyed socket's version 7 id is refused with the words its page retries on, before and after the cutover", () => {
    const c = clock();
    const gate = new IdGate(c.now, null, T0);
    assert.deepEqual(gate.check([uuidv7(T0)], player("ana"), KEYED_ANA), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    c.add(ID_SEAL_GRACE_MS);
    assert.deepEqual(gate.check([uuidv7(c.now())], player("ana"), KEYED_ANA), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
  });

  test("a socket that holds no key brings version 7 ids until the cutover's hour has passed, then is told to reload", () => {
    const c = clock();
    const gate = new IdGate(c.now, null, T0);
    const open: IdSeal = { keyed: false, key: ana };
    assert.equal(gate.check([uuidv7(c.now())], player("ana"), open).ok, true);
    c.add(ID_SEAL_GRACE_MS - 1);
    assert.equal(gate.check([uuidv7(c.now())], player("ana"), open).ok, true, "still in the hour");
    c.add(1);
    assert.deepEqual(gate.check([uuidv7(c.now())], player("ana"), open), { ok: false, code: "invalid", message: ID_PAGE_OLD });
    assert.equal(gate.check([sealedId(ana, c.now())], player("ana"), open).ok, true, "a sealed id is read under the member's key whatever the socket asked");
    assert.equal(new IdGate(c.now, null, null).check([uuidv7(c.now())], player("ana"), open).ok, true, "with no cutover read, none");
  });

  test("an id sealed under another member's key, one forged, and one only of the sealed shape are refused", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const own = sealedId(ana, T0);
    // The tag's last digit changed: the shape holds, the HMAC does not.
    const forged = `${own.slice(0, 22)}${own[22] === "0" ? "1" : "0"}${own.slice(23)}`;
    // A derived id (shared/reducer/duplicate.ts derivedId) keeps the version digit but reads under no key.
    const derived = "0123abcd-4567-8abc-9def-0123456789ab";
    for (const id of [sealedId(bea, T0), sealedId(server, T0), forged, derived]) {
      if (id === forged || id === derived) assert.equal(gate.check([id], player("ana"), KEYED_ANA).ok, false, id);
      else assert.deepEqual(gate.check([id], player("ana"), KEYED_ANA), { ok: false, code: "invalid", message: ID_TIME_REFUSED }, id);
    }
  });

  test("the server's own ids are read under the room's server key", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    assert.equal(gate.check([sealedId(server, T0)], "server", { keyed: true, key: server }).ok, true);
    assert.equal(gate.check([sealedId(ana, T0)], "server", { keyed: true, key: server }).ok, false);
  });

  test("a recorded version 8 id is never refused for its time, and a version 7 one only past the clock or the cutover", () => {
    const c = clock();
    const gate = new IdGate(c.now, null, T0);
    assert.deepEqual(gate.checkRecorded([sealedId(ana, T0 + 2 * 60 * MINUTE), sealedId(bea, 1)], true), { ok: true });
    assert.deepEqual(gate.checkRecorded([uuidv7(T0 - 3 * 60 * MINUTE)], true), { ok: true }, "a plan made before the deploy, applied in the hour");
    c.add(ID_SEAL_GRACE_MS);
    assert.deepEqual(gate.checkRecorded([uuidv7(T0)], true), { ok: false, code: "invalid", message: ID_TIME_REFUSED });
    assert.deepEqual(gate.checkRecorded([uuidv7(T0)], false), { ok: false, code: "invalid", message: ID_PAGE_OLD });
    assert.deepEqual(gate.checkRecorded([sealedId(ana, 5)], false), { ok: true });
  });

  test("a recorded id the sender sealed two hours ahead keeps its row until that time and 30 minutes 5 seconds, so a later create of it is gone", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const ahead = T0 + 2 * 60 * MINUTE;
    const id = sealedId(ana, ahead);
    const row = recordedRow(id, T0, [ana, bea, server]);
    assert.deepEqual(row, { id, memberId: SERVER_MEMBER, acceptedAt: T0, until: ahead + ID_HELD_MS, askUntil: T0 + ID_TIME.askMs });
    gate.stage([row]);
    gate.committed([row]);
    c.set(ahead);
    assert.deepEqual(gate.check([id], player("ana"), KEYED_ANA), { ok: false, code: "gone", message: ID_TAKEN });
    c.set(ahead + ID_TIME.behindMs);
    assert.deepEqual(gate.check([id], player("ana"), KEYED_ANA), { ok: false, code: "gone", message: ID_TAKEN }, "the last moment the clock passes it");
    assert.equal(gate.taken(id), true);
    c.set(ahead + ID_TIME.behindMs + 1);
    assert.deepEqual(gate.check([id], player("ana"), KEYED_ANA), { ok: false, code: "invalid", message: ID_TIME_REFUSED }, "past the window, the clock refuses it");
    c.set(ahead + ID_HELD_MS);
    assert.equal(gate.taken(id), false, "and its row is read no longer");
  });

  test("another member's id two hours ahead, recorded by the DM, holds its row under that member's key, so they never take it", () => {
    const c = clock();
    const gate = new IdGate(c.now);
    const ahead = T0 + 2 * 60 * MINUTE;
    // Bea's id, recorded by a DM whose own key reads nothing of it: the row reads every member's key.
    const id = sealedId(bea, ahead);
    const row = recordedRow(id, T0, [ana, bea, server]);
    assert.equal(row.until, ahead + ID_HELD_MS);
    const onlyTheDms = recordedRow(id, T0, [ana]);
    assert.equal(onlyTheDms.until, T0 + ID_HELD_MS, "read under the DM's key alone, it would end at its taking");
    gate.stage([row]);
    gate.committed([row]);
    const KEYED_BEA: IdSeal = { keyed: true, key: bea };
    for (const at of [ahead - ID_TIME.aheadMs, ahead, ahead + ID_TIME.behindMs]) {
      c.set(at);
      assert.deepEqual(gate.check([id], player("bea"), KEYED_BEA), { ok: false, code: "gone", message: ID_TAKEN }, `at ${at - T0}`);
    }
  });

  test("a row's end is capped at 9999-12-31, which no time read under any key passes", () => {
    const far = 2 ** 48 - 1;
    assert.equal(idRow(sealedId(ana, far), "ana", T0, far).until, LATEST_UNTIL);
    assert.equal(new Date(LATEST_UNTIL).toISOString(), "9999-12-31T23:59:59.000Z");
    assert.equal(recordedRow(sealedId(ana, far), T0, [ana]).until, LATEST_UNTIL);
  });
});
