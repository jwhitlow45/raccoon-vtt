import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { Member } from "#shared/model.ts";
import { runSettings } from "#shared/propertyTestutil.ts";
import { Admissions, type AdmitOutcome } from "./admit.ts";
import { RoomFullError } from "../rooms/gateway.ts";
import { HttpError } from "./http.ts";
import {
  ENDED_KEEP_MS,
  GOT_IN_MARK_MS,
  isEnding,
  JoinRequests,
  REQUEST_LIFE_MS,
  SWEEP_MS,
  TURN_AWAY_HOLD_MS,
  WAIT_HOLD_MS,
  WAITING_PER_ADDRESS_ROOM,
  WAITING_PER_ROOM,
  type JoinRequest,
  type Reservation,
  type Timers,
  type WaitState,
} from "./joinRequests.ts";
import { FakeAccessDb, FakeRoomGateway } from "./testing.ts";

/**
 * The join request store and admitPlayer under random event sequences
 * (docs/design/design-v1-join-requests.md 10, Property tests). Each named
 * invariant is checked after every step.
 */

class FakeTime implements Timers {
  now = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();
  #next = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = end;
  }
}

const ROOMS = ["ROOMAAAA", "ROOMBBBB"] as const;
const DEVICES = ["d0", "d1", "d2", "d3"] as const;
const IPS = ["203.0.113.1", "203.0.113.2"] as const;

type Action =
  | { t: "ask"; room: number; device: number; ip: number }
  | { t: "admit"; i: number }
  | { t: "fail"; i: number }
  | { t: "take"; room: number; i: number }
  | { t: "settle"; i: number; outcome: "in" | "gone" | "failed" }
  | { t: "turnAway"; room: number; i: number; all: boolean }
  | { t: "cancel"; i: number; own: boolean }
  | { t: "gotIn"; room: number; device: number }
  | { t: "close"; room: number }
  | { t: "drop"; room: number }
  | { t: "wait"; i: number; own: boolean }
  | { t: "advance"; ms: number }
  | { t: "sweep" };

const room = fc.nat({ max: ROOMS.length - 1 });
const device = fc.nat({ max: DEVICES.length - 1 });
const index = fc.nat({ max: 20 });
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("ask" as const), room, device, ip: fc.nat({ max: IPS.length - 1 }) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("admit" as const), i: index }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("fail" as const), i: index }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("take" as const), room, i: index }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("settle" as const), i: index, outcome: fc.constantFrom("in" as const, "gone" as const, "failed" as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("turnAway" as const), room, i: index, all: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("cancel" as const), i: index, own: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("gotIn" as const), room, device }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("close" as const), room }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("drop" as const), room }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("wait" as const), i: index, own: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("advance" as const), ms: fc.constantFrom(1, 1_000, 10_000, WAIT_HOLD_MS, 60_000, 3 * 60_000, 6 * 60_000) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("sweep" as const) }) },
);

type Ask = { res: Reservation; device: string; startedAt: number; step: number };
type Held = { requestId: string; answers: WaitState[]; startedAt: number };

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

async function runStore(actions: Action[]): Promise<void> {
  const time = new FakeTime();
  const store = new JoinRequests({ now: () => time.now, timers: time });
  const asks: Ask[] = [];
  const waits: Held[] = [];
  const firstEnding = new Map<string, string>();
  const turnedAwayAt = new Map<string, number>();
  const markedAt = new Map<string, number>();
  const generationAt = new Map<string, number>();
  let lastSweep = 0;
  const key = (r: string, d: string) => `${r}|${d}`;
  const pick = <T>(list: readonly T[], i: number): T | undefined => (list.length === 0 ? undefined : list[i % list.length]);
  const requests = () => [...store.all()];
  const deciding = () => requests().filter((r) => r.state === "deciding");

  for (const [step, a] of actions.entries()) {
    const before = new Map(requests().map((r) => [r.id, { state: r.state, endAfter: r.endAfter }]));
    let admitted: JoinRequest | null = null;
    let admittedAsk: Ask | null = null;
    switch (a.t) {
      case "ask": {
        const r = ROOMS[a.room] ?? ROOMS[0];
        const d = DEVICES[a.device] ?? DEVICES[0];
        if (store.deviceCheck(r, d)) break;
        const res = store.reserve(r, IPS[a.ip] ?? IPS[0], time.now, store.generation(r));
        if ("id" in res) asks.push({ res, device: d, startedAt: time.now, step });
        break;
      }
      case "admit": {
        const ask = pick(asks, a.i);
        if (!ask) break;
        asks.splice(asks.indexOf(ask), 1);
        const out = store.admit(ask.res, { sessionId: ask.device, name: "Quinn", color: "#3e8ef7" });
        if (out.ok) {
          admitted = out.request;
          admittedAsk = ask;
        }
        break;
      }
      case "fail": {
        const ask = pick(asks, a.i);
        if (!ask) break;
        asks.splice(asks.indexOf(ask), 1);
        store.release(ask.res);
        break;
      }
      case "take": {
        const r = pick(store.list(ROOMS[a.room] ?? ROOMS[0]), a.i);
        if (r) store.take(r.roomId, r.id);
        break;
      }
      case "settle": {
        const r = pick(deciding(), a.i);
        if (!r) break;
        const recorded = r.endAfter;
        store.settle(r.id, a.outcome);
        if (a.outcome === "in") markedAt.set(key(r.roomId, r.sessionId), time.now);
        // NO-RESTORE-AFTER-END
        if (a.outcome === "failed" && recorded) assert.equal(r.state, recorded, "NO-RESTORE-AFTER-END");
        break;
      }
      case "turnAway": {
        const roomId = ROOMS[a.room] ?? ROOMS[0];
        const list = store.list(roomId);
        const ids = a.all ? list.map((r) => r.id) : [pick(list, a.i)?.id ?? "none"];
        for (const r of store.turnAway(roomId, ids)) turnedAwayAt.set(key(roomId, r.sessionId), time.now);
        break;
      }
      case "cancel": {
        const r = pick(requests(), a.i);
        if (r) store.cancel(r.roomId, r.id, a.own ? r.sessionId : "intruder");
        break;
      }
      case "gotIn": {
        const r = ROOMS[a.room] ?? ROOMS[0];
        const d = DEVICES[a.device] ?? DEVICES[0];
        store.gotIn(r, d);
        markedAt.set(key(r, d), time.now);
        break;
      }
      case "close":
      case "drop": {
        const r = ROOMS[a.room] ?? ROOMS[0];
        if (a.t === "close") store.closeRoom(r);
        else store.dropRoom(r);
        generationAt.set(r, step);
        break;
      }
      case "wait": {
        const r = pick(requests(), a.i);
        if (!r) break;
        const held = store.wait(r.roomId, r.id, a.own ? r.sessionId : "intruder");
        if (!a.own) {
          assert.equal(held, null, "a wrong device is refused");
          break;
        }
        assert.ok(held);
        const entry: Held = { requestId: r.id, answers: [], startedAt: time.now };
        waits.push(entry);
        void held.answer.then((s) => entry.answers.push(s));
        break;
      }
      case "advance":
        time.advance(a.ms);
        break;
      case "sweep":
        store.sweep();
        lastSweep = time.now;
        break;
    }
    if (time.now - lastSweep >= SWEEP_MS) {
      store.sweep();
      lastSweep = time.now;
    }
    await flush();

    // Expire lazily through the public reads, as every route does.
    for (const r of ROOMS) store.list(r);
    const all = requests();

    for (const r of all) {
      const prior = before.get(r.id);
      // ONE-END
      const first = firstEnding.get(r.id);
      if (first !== undefined) assert.equal(r.state, first, "ONE-END");
      else if (isEnding(r.state)) firstEnding.set(r.id, r.state);
      // IN-FROM-DECIDING
      if (r.state === "in" && prior?.state !== "in") assert.equal(prior?.state, "deciding", "IN-FROM-DECIDING");
      // NO-REPLACE-DECIDING
      if (a.t === "admit" && prior?.state === "deciding") assert.equal(r.state, "deciding", "NO-REPLACE-DECIDING");
      // LIFE
      if (r.state === "waiting") assert.ok(time.now - r.askedAt < REQUEST_LIFE_MS, "LIFE");
      // GENERATION
      if (r.state === "waiting") assert.equal(r.generation, store.generation(r.roomId), "GENERATION");
      // SWEEP
      if (r.endedAt !== undefined) assert.ok(time.now - r.endedAt < ENDED_KEEP_MS + SWEEP_MS, "SWEEP");
    }
    if (admitted && admittedAsk) {
      const k = key(admitted.roomId, admitted.sessionId);
      // HOLD
      const turned = turnedAwayAt.get(k);
      if (turned !== undefined) assert.ok(time.now - turned >= TURN_AWAY_HOLD_MS, "HOLD");
      // MARK-OUTLIVES
      const mark = markedAt.get(k);
      if (mark !== undefined && time.now - mark < GOT_IN_MARK_MS) assert.ok(mark < admittedAsk.startedAt, "MARK-OUTLIVES");
      // GENERATION: nothing admitted across a bump that came after the ask began
      const bumped = generationAt.get(admitted.roomId);
      if (bumped !== undefined) assert.ok(bumped < admittedAsk.step, "GENERATION at admission");
    }
    // CAPS
    const reserved = [...store.reservations()];
    const live = all.filter((r) => !isEnding(r.state));
    assert.ok(live.length + reserved.length <= 500, "CAPS server");
    for (const r of ROOMS) {
      assert.ok(live.filter((x) => x.roomId === r).length + reserved.filter((x) => x.roomId === r).length <= WAITING_PER_ROOM, "CAPS room");
      for (const ip of IPS) {
        const n = live.filter((x) => x.roomId === r && x.ipKey === ip).length + reserved.filter((x) => x.roomId === r && x.ipKey === ip).length;
        assert.ok(n <= WAITING_PER_ADDRESS_ROOM, "CAPS address");
      }
      for (const d of DEVICES) assert.ok(live.filter((x) => x.roomId === r && x.sessionId === d).length <= 1, "CAPS one per device");
    }
    // RESERVE: places only for asks still in flight.
    assert.equal(reserved.length, asks.length, "RESERVE");
    // AT-MOST-ONE-WAIT and ANSWERED
    for (const w of waits) {
      assert.ok(w.answers.length <= 1, "AT-MOST-ONE-WAIT: one answer per held wait");
      if (time.now - w.startedAt >= WAIT_HOLD_MS) assert.equal(w.answers.length, 1, "ANSWERED by 25 s");
    }
    const unanswered = new Map<string, number>();
    for (const w of waits) if (w.answers.length === 0) unanswered.set(w.requestId, (unanswered.get(w.requestId) ?? 0) + 1);
    for (const n of unanswered.values()) assert.ok(n <= 1, "AT-MOST-ONE-WAIT: one held wait per request");
  }
  store.close();
  await flush();
  for (const w of waits) assert.equal(w.answers.length, 1, "ANSWERED at shutdown");
}

type Fault = {
  member: "land" | "full" | "broken" | "slow" | "slowRefused";
  grant: "ok" | "refused" | "statement" | "loseApplied" | "loseDropped";
  reconcileDown: boolean;
  removedByDm: boolean;
  removalFailures: number;
};

const fault: fc.Arbitrary<Fault> = fc.record({
  member: fc.constantFrom("land", "land", "full", "broken", "slow", "slowRefused"),
  grant: fc.constantFrom("ok", "ok", "refused", "statement", "loseApplied", "loseDropped"),
  reconcileDown: fc.boolean(),
  removedByDm: fc.boolean(),
  removalFailures: fc.nat({ max: 2 }),
});

const ROOM = "ROOMAAAA";

function member(id: string): Member {
  return { id, rev: 1, name: id, color: "#123456", kind: "player", createdAt: "2026-11-02T10:00:00.000Z" };
}

async function runAdmissions(faults: Fault[]): Promise<void> {
  const db = new FakeAccessDb();
  db.addRoom(ROOM, { player_epoch: 2, dm_epoch: 1 });
  const gateway = new FakeRoomGateway();
  const admissions = new Admissions({ pool: db.pool, gateway, options: { memberMs: 5, checkoutMs: 50 } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const [n, f] of faults.entries()) {
    const id = `m${n}`;
    const session = `s${n}`;
    const lost = f.grant === "loseApplied" || f.grant === "loseDropped";
    let removalFailures = f.removalFailures;
    let commitSent = false;
    // Only the read-back after a lost COMMIT is ever cut off here.
    let down = f.reconcileDown && lost;
    const settled: AdmitOutcome[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    gateway.hold = async (call, _room, memberId) => {
      if (memberId !== id) return;
      if (call === "add") {
        if (f.member === "full") throw new RoomFullError();
        if (f.member === "broken") throw new Error("actor fault");
        if (f.member === "slow" || f.member === "slowRefused") {
          await slow;
          if (f.member === "slowRefused") throw new HttpError(409, "read_only");
        }
      }
      if (call === "remove" && removalFailures > 0) {
        removalFailures--;
        throw new Error("actor busy");
      }
    };
    db.loseCommit = null;
    db.connecting = () => {
      if (commitSent && down) throw new Error("no connection");
    };
    db.before = (sql) => {
      if (sql.startsWith("insert into grants")) {
        assert.equal(gateway.room(ROOM).has(id), true, "MEMBER-FIRST");
        assert.equal(admissions.inFlight(ROOM).has(id), true, "IN-FLIGHT-UNCLAIMED");
        if (f.grant === "statement") throw new Error("statement timeout");
      }
      // The grant transaction's own COMMIT: its last statement wrote the grant.
      if (sql === "commit" && db.statements.at(-2)?.startsWith("insert into grants")) {
        commitSent = true;
        if (f.grant === "loseApplied") db.loseCommit = "applied";
        if (f.grant === "loseDropped") db.loseCommit = "dropped";
        if (f.removedByDm && (f.grant === "ok" || f.grant === "loseApplied")) gateway.room(ROOM).delete(id);
      }
    };
    const outcome = admissions.admit({
      roomId: ROOM,
      sessionId: session,
      who: { kind: "new", member: member(id) },
      locked: async () => {
        if (f.grant === "refused") throw new HttpError(403, "stale_ticket");
      },
      settled: (o) => settled.push(o),
    });
    if (f.member === "slow" || f.member === "slowRefused") {
      assert.equal((await outcome).kind, "pending");
      assert.equal(settled.length, 0, "nothing settles while the member is out");
      release();
    }
    await sleep(15);
    if (down && commitSent) assert.equal(settled.length, 0, "NO-RESTORE-WHILE-UNKNOWN");
    down = false;
    for (let i = 0; i < 40 && (settled.length === 0 || admissions.followUps > 0); i++) {
      await admissions.followUp();
      await sleep(1);
    }
    assert.equal(settled.length, 1, "DECIDING-ENDS: settled exactly once");
    const o = settled[0];
    assert.ok(o);
    const grant = db.grant(session, ROOM);
    const present = gateway.room(ROOM).has(id);
    const landed = f.member === "land" || f.member === "slow";
    const committed = landed && (f.grant === "ok" || f.grant === "loseApplied");
    if (!landed) {
      assert.equal(o.kind, "refused");
      assert.equal(grant, undefined);
      assert.equal(present, false);
    } else if (f.grant === "loseDropped") {
      assert.equal(o.kind, "unknown", "UNKNOWN-ENDS");
      assert.equal(present, true, "UNDO-ONLY-ON-ROLLBACK: an unknown outcome removes no member");
      assert.equal(grant, undefined);
    } else if (committed && f.removedByDm) {
      assert.equal(o.kind, "refused");
      assert.equal(grant, undefined, "the exact grant given up");
    } else if (committed) {
      assert.equal(o.kind, "in");
      assert.equal(grant?.member_id, id);
      assert.equal(present, true);
    } else {
      assert.equal(o.kind, "refused");
      assert.equal(grant, undefined);
      assert.equal(present, false, "UNDO-ONLY-ON-ROLLBACK: a confirmed rollback removes the member");
    }
    if (grant) assert.equal(present, true, "no grant without its member");
    assert.equal(admissions.followUps, 0);
    assert.equal(admissions.inFlight(ROOM).has(id), false, "leaves flight once settled");
  }
}

// holds() takes a synchronous property, so the async ones run on its seed and run count directly.
const { seed, runs } = runSettings(process.env);

describe("join requests under random event sequences", () => {
  test("the store keeps every named invariant", async () => {
    await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 60 }), (actions) => runStore(actions)), { seed, numRuns: runs ?? 200 });
  });

  test("admitPlayer keeps member-first, undo-only-on-rollback and its settlements", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fault, { minLength: 1, maxLength: 5 }), (faults) => runAdmissions(faults)), { seed, numRuns: runs ?? 25 });
  });
});
