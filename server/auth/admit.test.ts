import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Member } from "#shared/model.ts";
import { ADMISSION_ROUTE_MS, Admissions, KICK_MEMORY_MS, revokeMember, type AdmitAnswer, type AdmitOutcome, type AdmitPlan, type AdmitWho } from "./admit.ts";
import { HttpError } from "./http.ts";
import { FakeAccessDb, FakeRoomGateway } from "./testing.ts";

const ROOM = "ROOMAAAA";
const SESSION = "11111111-1111-4111-8111-111111111111";

function member(id: string, kind: Member["kind"] = "player"): Member {
  return { id, rev: 1, name: id, color: "#123456", kind, createdAt: "2026-11-02T10:00:00.000Z" };
}

function setup(options: { memberMs?: number; checkoutMs?: number; answerMs?: number; now?: () => number } = {}) {
  const db = new FakeAccessDb();
  db.addRoom(ROOM, { player_epoch: 3, dm_epoch: 5 });
  const gateway = new FakeRoomGateway();
  // The answer's bound is past the checkout's unless a test says otherwise, so a refused checkout is answered as busy.
  const answerMs = options.answerMs ?? options.memberMs ?? 200;
  const admissions = new Admissions({ pool: db.pool, gateway, options: { memberMs: options.memberMs ?? 40, checkoutMs: options.checkoutMs ?? 40, answerMs, ...(options.now ? { now: options.now } : {}) } });
  const settled: AdmitOutcome[] = [];
  const plan = (who: AdmitWho, over: Partial<AdmitPlan> = {}): AdmitPlan => ({
    roomId: ROOM,
    sessionId: SESSION,
    who,
    locked: async () => undefined,
    settled: (o) => settled.push(o),
    ...over,
  });
  return { db, gateway, admissions, settled, plan };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (a: AdmitAnswer) => (a.kind === "refused" && a.error instanceof HttpError ? a.error.code : a.kind);
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe("admitPlayer", () => {
  test("a new player's member is written before its grant, and leaves flight once in", async () => {
    const { db, gateway, admissions, settled, plan } = setup();
    let memberAtGrant: boolean | undefined;
    let inFlightAtGrant: boolean | undefined;
    db.before = (sql) => {
      if (sql.startsWith("insert into grants")) {
        memberAtGrant = gateway.room(ROOM).has("q1");
        inFlightAtGrant = admissions.inFlight(ROOM).has("q1");
      }
    };
    const answer = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.equal(answer.kind, "in");
    assert.equal(memberAtGrant, true, "MEMBER-FIRST");
    assert.equal(inFlightAtGrant, true, "the member is in flight until its grant commits");
    assert.deepEqual(db.grant(SESSION, ROOM), { session_id: SESSION, room_id: ROOM, member_id: "q1", role: "player", epoch: 3 });
    assert.equal(admissions.inFlight(ROOM).size, 0);
    assert.equal(settled.length, 1);
  });

  test("a refusal under the room lock takes the member back off: revoke, remove, revoke", async () => {
    const { db, gateway, admissions, settled, plan } = setup();
    const answer = await admissions.admit(
      plan({ kind: "new", member: member("q1") }, {
        locked: async () => {
          throw new HttpError(403, "stale_ticket");
        },
      }),
    );
    assert.equal(answer.kind, "refused");
    assert.equal(answer.kind === "refused" && answer.error instanceof HttpError && answer.error.code, "stale_ticket");
    // The refusal is answered at once, and the member comes off behind it.
    await admissions.followUp();
    assert.deepEqual(gateway.calls, ["add q1", "remove q1"]);
    const revokes = db.statements.filter((s) => s.startsWith("delete from grants where room_id = $1 and member_id = $2"));
    assert.equal(revokes.length, 2, "revoked before and after the removal");
    assert.equal(gateway.room(ROOM).has("q1"), false);
    assert.equal(db.grant(SESSION, ROOM), undefined);
    assert.equal(admissions.inFlight(ROOM).size, 0);
    assert.deepEqual(settled.map((o) => o.kind), ["refused"]);
  });

  test("a statement error or a checkout that never comes is busy, with the member removed", async () => {
    const { db, gateway, admissions, plan } = setup();
    db.before = (sql) => {
      if (sql.startsWith("insert into grants")) throw new Error("canceling statement due to statement timeout");
    };
    const failed = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.equal(failed.kind === "refused" && failed.error instanceof HttpError && failed.error.code, "busy");
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q1"), false);

    db.before = () => undefined;
    const stalled = gate();
    let first = true;
    db.connecting = async () => {
      if (first) {
        first = false;
        await stalled.wait;
      }
    };
    const timedOut = await admissions.admit(plan({ kind: "new", member: member("q2") }));
    stalled.open();
    assert.equal(timedOut.kind === "refused" && timedOut.error instanceof HttpError && timedOut.error.code, "busy");
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q2"), false);
    assert.equal(db.grant(SESSION, ROOM), undefined);
  });

  test("a full room writes nothing and removes nothing", async () => {
    const { gateway, admissions, plan } = setup();
    for (let i = 0; i < 50; i++) gateway.room(ROOM).set(`m${i}`, member(`m${i}`));
    const answer = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.equal(answer.kind === "refused" && answer.error.name, "RoomFullError");
    assert.deepEqual(gateway.calls, ["add q1"]);
    assert.equal(admissions.inFlight(ROOM).size, 0);
  });

  test("a lost COMMIT answer whose grant landed is read back as in", async () => {
    const { db, admissions, plan } = setup();
    db.loseCommit = "applied";
    let healed = 0;
    const answer = await admissions.admit(plan({ kind: "new", member: member("q1") }, { maybeCommitted: () => healed++ }));
    assert.equal(answer.kind, "in");
    assert.equal(healed, 1, "the promotion's callbacks run again in the reconcile");
    assert.equal(db.grant(SESSION, ROOM)?.member_id, "q1");
  });

  test("a lost COMMIT answer whose grant did not land, or was replaced since, stays unknown and keeps the member", async () => {
    const { db, gateway, admissions, settled, plan } = setup();
    db.loseCommit = "dropped";
    const dropped = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.equal(dropped.kind, "unknown", "UNKNOWN-ENDS");
    assert.equal(gateway.room(ROOM).has("q1"), true, "an unknown outcome removes no member");
    assert.equal(admissions.inFlight(ROOM).size, 0);

    // A password join on the same session replaced the grant before the reconcile read it.
    db.loseCommit = "applied";
    let commits = 0;
    db.before = (sql) => {
      if (sql === "commit") commits++;
      // The reconcile's transaction starts after the lost COMMIT.
      if (sql === "begin" && commits === 1) db.tables.grants.set(`${SESSION}|${ROOM}`, { session_id: SESSION, room_id: ROOM, member_id: "other", role: "player", epoch: 3 });
    };
    const replaced = await admissions.admit(plan({ kind: "new", member: member("q2") }));
    assert.equal(replaced.kind, "unknown");
    assert.equal(gateway.room(ROOM).has("q2"), true);
    assert.deepEqual(settled.map((o) => o.kind), ["unknown", "unknown"]);
  });

  test("a device's own DM link upgrading the grant before the reconcile counts as committed by dm_epoch", async () => {
    const { db, admissions, plan } = setup();
    db.loseCommit = "applied";
    let commits = 0;
    db.before = (sql) => {
      if (sql === "commit") commits++;
      if (sql === "begin" && commits === 1) db.tables.grants.set(`${SESSION}|${ROOM}`, { session_id: SESSION, room_id: ROOM, member_id: "q1", role: "dm", epoch: 5 });
    };
    const answer = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.equal(answer.kind, "in");
  });

  test("a reconcile that cannot read answers pending at once and is settled by the sweep, with nothing settled meanwhile", async () => {
    const { db, gateway, admissions, settled, plan } = setup({ answerMs: 5_000 });
    db.loseCommit = "applied";
    let down = true;
    db.connecting = () => {
      if (down && db.statements.includes("commit")) throw new Error("no connection");
    };
    const started = Date.now();
    const answer = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.deepEqual(answer, { kind: "pending", memberId: "q1" }, "the caller never waits on the sweep");
    assert.ok(Date.now() - started < 1_000, "long before the answer's bound");
    assert.equal(settled.length, 0, "NO-RESTORE-WHILE-UNKNOWN");
    assert.equal(admissions.inFlight(ROOM).has("q1"), true);
    await admissions.followUp();
    assert.equal(settled.length, 0);
    down = false;
    await admissions.followUp();
    assert.deepEqual(settled.map((o) => o.kind), ["in"]);
    assert.equal(admissions.followUps, 0);
    assert.equal(gateway.room(ROOM).has("q1"), true);
  });

  test("a cold room past the bound answers pending, then the member and grant land and the attempt settles", async () => {
    const { db, gateway, admissions, settled, plan } = setup({ memberMs: 30 });
    const load = gate();
    gateway.hold = (call) => (call === "add" ? load.wait : undefined);
    const answer = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.deepEqual(answer, { kind: "pending", memberId: "q1" });
    assert.equal(db.grant(SESSION, ROOM), undefined, "no grant while the member is out");
    assert.equal(admissions.inFlight(ROOM).has("q1"), true);
    load.open();
    for (let i = 0; i < 20 && settled.length === 0; i++) await sleep(5);
    assert.deepEqual(settled.map((o) => o.kind), ["in"]);
    assert.equal(db.grant(SESSION, ROOM)?.member_id, "q1");
  });

  test("an actor that keeps a member op past the bound and then refuses it settles as refused, with nothing granted", async () => {
    const { db, gateway, admissions, settled, plan } = setup({ memberMs: 30 });
    const load = gate();
    gateway.hold = async (call) => {
      if (call !== "add") return;
      await load.wait;
      throw new HttpError(409, "read_only");
    };
    assert.equal((await admissions.admit(plan({ kind: "new", member: member("q1") }))).kind, "pending");
    load.open();
    for (let i = 0; i < 20 && settled.length === 0; i++) await sleep(5);
    assert.equal(settled[0]?.kind, "refused");
    assert.equal(db.grant(SESSION, ROOM), undefined);
    assert.equal(admissions.inFlight(ROOM).size, 0);
  });

  test("past the member, every phase answers within the bound: a stalled grant checkout, a carry-on's, and a read-back after the commit", { timeout: 5_000 }, async () => {
    // A checkout bound longer than the answer's: the grant's own refusal would come too late.
    const { db, gateway, admissions, settled, plan } = setup({ checkoutMs: 400, answerMs: 40 });
    const stalled = gate();
    db.connecting = () => stalled.wait;
    for (const who of [{ kind: "new", member: member("q1") }, { kind: "member", memberId: "pip" }] as const) {
      if (who.kind === "member") gateway.room(ROOM).set("pip", member("pip"));
      const started = Date.now();
      const answer = await admissions.admit(plan(who));
      assert.equal(answer.kind, "pending", `${who.kind}: ANSWER-BOUNDED`);
      assert.ok(Date.now() - started < 300, `${who.kind}: answered in ${Date.now() - started} ms`);
    }
    for (let i = 0; i < 40 && settled.length < 2; i++) await sleep(25);
    assert.deepEqual(settled.map(codeOf), ["busy", "busy"], "each settles once its checkout gives up");
    stalled.open();
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q1"), false);

    // The member read back after the commit hangs: the answer still comes, and the attempt settles as in on its own bound.
    const late = setup({ answerMs: 40 });
    const hang = gate();
    late.gateway.getMember = async (roomId, memberId) => {
      if (memberId === "q2") await hang.wait;
      return late.gateway.room(roomId).get(memberId) ?? null;
    };
    const answer = await late.admissions.admit(late.plan({ kind: "new", member: member("q2") }));
    assert.ok(answer.kind === "pending" || answer.kind === "in", answer.kind);
    for (let i = 0; i < 20 && late.settled.length === 0; i++) await sleep(10);
    assert.deepEqual(late.settled.map((o) => o.kind), ["in"], "the grant stands without the read");
    hang.open();
  });

  test("an undo whose revokes get no connection answers the refusal at once and is owed, the member in flight until it comes off", { timeout: 5_000 }, async () => {
    const { db, gateway, admissions, plan } = setup({ checkoutMs: 40, answerMs: 2_000 });
    const stalled = gate();
    // The grant's transaction is refused under the lock. Every connection after it stalls.
    let connections = 0;
    db.connecting = async () => {
      if (++connections > 1) await stalled.wait;
    };
    const started = Date.now();
    const answer = await admissions.admit(plan({ kind: "new", member: member("q1") }, { locked: () => Promise.reject(new HttpError(403, "stale_ticket")) }));
    assert.equal(codeOf(answer), "stale_ticket");
    assert.ok(Date.now() - started < 30, "the refusal never waits for the undo");
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q1"), true, "the revoke timed out, so the removal is owed");
    assert.equal(admissions.inFlight(ROOM).has("q1"), true, "IN-FLIGHT-UNCLAIMED");
    assert.equal(admissions.followUps, 1);
    stalled.open();
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q1"), false);
    assert.equal(admissions.followUps, 0);
  });

  test("a removal that does not land is owed and retried by the sweep, the member in flight until it lands", async () => {
    const { gateway, admissions, plan } = setup();
    let fail = true;
    gateway.hold = (call) => {
      if (call === "remove" && fail) throw new Error("actor busy");
    };
    await admissions.admit(plan({ kind: "new", member: member("q1") }, { locked: () => Promise.reject(new HttpError(403, "stale_ticket")) }));
    assert.equal(gateway.room(ROOM).has("q1"), true);
    assert.equal(admissions.inFlight(ROOM).has("q1"), true, "IN-FLIGHT-UNCLAIMED while its removal is owed");
    assert.equal(admissions.followUps, 1);
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q1"), true);
    fail = false;
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q1"), false);
    assert.equal(admissions.inFlight(ROOM).size, 0);
    assert.equal(admissions.followUps, 0);
  });

  test("a relabel the room's actor keeps past its bound leaves the kick done and the label owed, set back by the sweep unless the member is a DM again", { timeout: 5_000 }, async () => {
    const { db, gateway, admissions } = setup();
    const kick = (memberId: string) => revokeMember({ pool: db.pool, gateway, admissions }, ROOM, memberId);
    const dmGrant = (memberId: string) => db.tables.grants.set(`s-${memberId}|${ROOM}`, { session_id: `s-${memberId}`, room_id: ROOM, member_id: memberId, role: "dm", epoch: 5 });
    for (const id of ["dee", "eve"]) {
      gateway.room(ROOM).set(id, member(id, "dm"));
      dmGrant(id);
    }
    let stall = true;
    // Never opened: a relabel the actor keeps for good.
    const stalled = gate();
    gateway.hold = async (call) => {
      if (call === "kind" && stall) await stalled.wait;
    };
    const started = Date.now();
    const kicked = await kick("dee");
    assert.ok(Date.now() - started < 500, "the kick answers within the relabel's bound");
    assert.deepEqual(kicked.unlabeled, ["dee"]);
    assert.equal(db.grant("s-dee", ROOM), undefined, "the kick is done");
    await kick("eve");
    assert.equal(admissions.followUps, 2, "both labels are owed");
    await admissions.followUp();
    assert.equal(admissions.followUps, 2, "still owed while the actor stalls, and the sweep's run ended anyway");
    // Claimed back as a DM meanwhile: the label it has now is right.
    dmGrant("eve");
    stall = false;
    await admissions.followUp();
    assert.equal(admissions.followUps, 0);
    assert.equal(gateway.room(ROOM).get("dee")?.kind, "player");
    assert.equal(gateway.room(ROOM).get("eve")?.kind, "dm");
  });

  test("a room whose relabels stall holds up no other room's follow-ups, and its own run ends within its bounds", { timeout: 5_000 }, async () => {
    const OTHER = "ROOMBBBB";
    const { db, gateway, admissions, plan } = setup({ memberMs: 300 });
    db.addRoom(OTHER, { player_epoch: 1, dm_epoch: 1 });
    const refused = { locked: () => Promise.reject(new HttpError(403, "stale_ticket")) };
    // The other room's removal fails once, so its undo is owed to the sweep.
    let otherFails = 1;
    gateway.hold = async (call, roomId) => {
      if (call === "remove" && roomId === OTHER && otherFails-- > 0) throw new Error("actor busy");
      if (call === "kind" && roomId === ROOM) await gate().wait;
    };
    await admissions.admit(plan({ kind: "new", member: member("q2") }, { roomId: OTHER, ...refused }));
    for (let i = 0; i < 50 && !gateway.calls.includes("remove q2"); i++) await sleep(2);
    await sleep(5);
    assert.equal(gateway.room(OTHER).has("q2"), true, "the other room's removal is owed");
    // This room's undo is running now, stuck in its relabels.
    await admissions.admit(plan({ kind: "new", member: member("q1") }, refused));
    const started = Date.now();
    const all = admissions.followUp();
    for (let i = 0; i < 100 && gateway.room(OTHER).has("q2"); i++) await sleep(2);
    assert.equal(gateway.room(OTHER).has("q2"), false, "the other room's owed removal lands");
    assert.ok(Date.now() - started < 200, `without waiting on this room's relabels: ${Date.now() - started} ms`);
    assert.equal(gateway.room(ROOM).has("q1"), true, "this room's undo is still in its first relabel");
    await all;
    assert.equal(gateway.room(ROOM).has("q1"), false, "a relabel past its bound is moot for an undo: the member comes off");
    assert.equal(admissions.followUps, 0);
  });

  test("a member the DM removed just after the commit gives up exactly that grant", async () => {
    const { db, gateway, admissions, plan } = setup();
    gateway.room(ROOM).set("pip", member("pip"));
    db.before = (sql) => {
      if (sql === "commit" && db.tables.grants.size === 0) gateway.room(ROOM).delete("pip");
    };
    const answer = await admissions.admit(plan({ kind: "member", memberId: "pip" }));
    assert.equal(answer.kind === "refused" && answer.error instanceof HttpError && answer.error.code, "member_removed");
    assert.equal(db.grant(SESSION, ROOM), undefined);
    assert.ok(db.statements.some((s) => s.includes("and session_id = $2 and member_id = $3 and role = $4 and epoch = $5")), "matched on session, member, role and epoch");
  });

  test("a kick between a new member and its grant answers first, and the admission writes no grant (JR-SOL-01's order)", async () => {
    const { db, gateway, admissions, settled, plan } = setup();
    const held = gate();
    const atGrant = gate();
    let first = true;
    db.connecting = async () => {
      // The admission's grant transaction is the first connection: the kick's comes while it waits.
      if (!first) return;
      first = false;
      atGrant.open();
      await held.wait;
    };
    const answer = admissions.admit(plan({ kind: "new", member: member("q1") }));
    await atGrant.wait;
    assert.equal(gateway.room(ROOM).has("q1"), true, "the member is on the roster, so a DM can kick it");
    const kick = await revokeMember({ pool: db.pool, gateway, admissions }, ROOM, "q1");
    assert.deepEqual(kick.removed, [], "no grant yet to revoke");
    held.open();
    assert.equal(codeOf(await answer), "member_removed");
    assert.equal(db.grant(SESSION, ROOM), undefined, "KICK-ORDERED: no grant lands after the kick answered");
    assert.deepEqual(settled.map((o) => o.kind), ["refused"]);
    for (let i = 0; i < 20 && gateway.room(ROOM).has("q1"); i++) await sleep(5);
    assert.equal(gateway.room(ROOM).has("q1"), false, "a grant never written is a rollback: the member comes off");
  });

  test("a kick while a grant is being written waits on the room lock for its commit, then deletes it", async () => {
    const { db, gateway, admissions, plan } = setup();
    gateway.room(ROOM).set("pip", member("pip"));
    const held = gate();
    const atInsert = gate();
    db.before = async (sql) => {
      if (!sql.startsWith("insert into grants")) return;
      atInsert.open();
      await held.wait;
    };
    const answer = admissions.admit(plan({ kind: "member", memberId: "pip" }));
    await atInsert.wait;
    let kickAnswered = false;
    const kick = revokeMember({ pool: db.pool, gateway, admissions }, ROOM, "pip").then((r) => {
      kickAnswered = true;
      return r;
    });
    await sleep(30);
    assert.equal(kickAnswered, false, "the kick waits for the grant holding the room lock");
    held.open();
    assert.equal((await answer).kind, "in", "the grant was past its check, so it commits");
    assert.deepEqual((await kick).removed.map((r) => r.sessionId), [SESSION], "and the kick deletes it");
    assert.equal(db.grant(SESSION, ROOM), undefined, "KICK-ORDERED");
  });

  test("a carry-on whose route began before a kick of its member is refused, and one begun after it is a new decision", async () => {
    const { db, gateway, admissions, plan } = setup();
    gateway.room(ROOM).set("pip", member("pip"));
    // join/complete and let-in take `begun` before they read the roster.
    const begun = admissions.begin();
    await revokeMember({ pool: db.pool, gateway, admissions }, ROOM, "pip");
    const stale = await admissions.admit(plan({ kind: "member", memberId: "pip" }, { begun }));
    assert.equal(codeOf(stale), "member_removed");
    assert.equal(db.grant(SESSION, ROOM), undefined);
    assert.equal(gateway.room(ROOM).has("pip"), true, "a carry-on adds no member, so none comes off");
    // A kick of another member, or one from before the route began, refuses nothing.
    await revokeMember({ pool: db.pool, gateway, admissions }, ROOM, "someone-else");
    assert.equal((await admissions.admit(plan({ kind: "member", memberId: "pip" }))).kind, "in");
  });

  test("a route that outlives the kicks' memory writes no grant, so a forgotten kick never lets its member back (JR-SOL-01 after pruning)", async () => {
    const clock = { t: 1_000 };
    const { db, gateway, admissions, plan } = setup({ now: () => clock.t });
    gateway.room(ROOM).set("pip", member("pip"));
    const kick = (memberId: string) => revokeMember({ pool: db.pool, gateway, admissions }, ROOM, memberId);
    // A route stalls before its admission, its member is kicked, and a later kick of someone else forgets that one.
    const stalled = admissions.begin();
    await kick("pip");
    clock.t += KICK_MEMORY_MS + 1;
    await kick("someone-else");
    assert.equal(codeOf(await admissions.admit(plan({ kind: "member", memberId: "pip" }, { begun: stalled }))), "busy", "past its deadline, the route writes no grant");
    assert.equal(db.grant(SESSION, ROOM), undefined, "KICK-ORDERED across the prune");
    // At its deadline a route still meets every kick since it began, even with a prune in between.
    const late = admissions.begin();
    await kick("pip");
    clock.t += ADMISSION_ROUTE_MS;
    await kick("someone-else");
    assert.equal(codeOf(await admissions.admit(plan({ kind: "member", memberId: "pip" }, { begun: late }))), "member_removed");
    // One past its deadline with no kick at all is refused too, and nothing is taken off.
    const slow = admissions.begin();
    clock.t += ADMISSION_ROUTE_MS + 1;
    assert.equal(codeOf(await admissions.admit(plan({ kind: "member", memberId: "pip" }, { begun: slow }))), "busy");
    assert.equal(gateway.room(ROOM).has("pip"), true);
    // A route begun after the kicks, within its deadline, is a new decision.
    assert.equal((await admissions.admit(plan({ kind: "member", memberId: "pip" }, { begun: admissions.begin() }))).kind, "in");
  });

  test("a carry-on pick of a former DM and a device already in are refused under the lock", async () => {
    const { db, gateway, admissions, plan } = setup();
    gateway.room(ROOM).set("old", member("old"));
    db.tables.dmMembers.add(`${ROOM}|old`);
    const dm = await admissions.admit(plan({ kind: "member", memberId: "old" }));
    assert.equal(dm.kind === "refused" && dm.error instanceof HttpError && dm.error.code, "not_a_player");

    gateway.room(ROOM).set("me", member("me"));
    db.tables.grants.set(`${SESSION}|${ROOM}`, { session_id: SESSION, room_id: ROOM, member_id: "me", role: "player", epoch: 3 });
    const again = await admissions.admit(plan({ kind: "new", member: member("q1") }));
    assert.equal(again.kind === "refused" && again.error instanceof HttpError && again.error.code, "already_in");
    await admissions.followUp();
    assert.equal(gateway.room(ROOM).has("q1"), false);
  });
});
