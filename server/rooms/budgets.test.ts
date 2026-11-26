import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import { DEFAULT_PREVIEW_POOL_MB, DEFAULT_SNAPSHOT_BUDGET, DEFAULT_SOCKET_CAPS, DM_RESERVED_ALLOWANCES, EphRate, FrameBudget, PreviewPool, OpRate, SlidingWindow, SnapshotBudget, SocketRegistry, SustainedViolation, TokenBucket, type DueOutcome } from "./budgets.ts";

function clock(start = 0): { now: () => number; tick: (ms: number) => void } {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

describe("TokenBucket", () => {
  test("spends the burst, then refills at the rate", () => {
    const c = clock();
    const b = new TokenBucket(10, 20, c.now);
    for (let i = 0; i < 20; i++) assert.equal(b.take(), true);
    assert.equal(b.take(), false);
    c.tick(500);
    assert.equal(b.take(5), true);
    assert.equal(b.take(1), false);
    c.tick(10_000);
    assert.equal(b.tokens, 20);
  });
});

describe("FrameBudget", () => {
  test("drops frames over the count before parsing and flags abuse after 10 s without a break", () => {
    const c = clock();
    const f = new FrameBudget(c.now);
    for (let i = 0; i < 400; i++) assert.equal(f.accept(10), "ok");
    assert.equal(f.accept(10), "drop");
    // Twice the budget for ten seconds: half the frames pass, the drops never pause, so it is abuse.
    let verdict: string = "drop";
    for (let step = 0; step < 101 && verdict !== "abuse"; step++) {
      c.tick(100);
      for (let i = 0; i < 40; i++) verdict = f.accept(10);
    }
    assert.equal(verdict, "abuse");
    // A pause ends the streak: the same flood after a quiet 5 s starts over at "drop".
    const g = new FrameBudget(c.now);
    for (let step = 0; step < 60; step++) {
      c.tick(100);
      for (let i = 0; i < 40; i++) g.accept(10);
    }
    c.tick(5_000);
    let after: string = "ok";
    for (let step = 0; step < 50; step++) {
      c.tick(100);
      for (let i = 0; i < 40; i++) after = g.accept(10);
    }
    assert.equal(after, "drop");
  });

  test("raw bytes before parsing count apart from the bytes a message pays once parsed", () => {
    const c = clock();
    const f = new FrameBudget(c.now);
    // The raw guard: 4 MiB at once, then 2 MiB a second.
    assert.equal(f.accept(4 * 1024 * 1024), "ok");
    assert.equal(f.accept(1), "drop");
    c.tick(1_000);
    assert.equal(f.accept(2 * 1024 * 1024), "ok");
    // The byte bucket, which every parsed message but `eph` pays: 512 KiB at once, then 256 KiB a second.
    const g = new FrameBudget(c.now);
    assert.equal(g.charge(512 * 1024), "ok");
    assert.equal(g.charge(1), "drop");
    c.tick(1_000);
    assert.equal(g.charge(256 * 1024), "ok");
    // A frame the raw guard took leaves the byte bucket whole.
    const h = new FrameBudget(c.now);
    assert.equal(h.accept(512 * 1024), "ok");
    assert.equal(h.charge(512 * 1024), "ok");
  });
});

describe("EphRate", () => {
  test("one token a message whatever its size: 400 at once, then 100 a second", () => {
    const c = clock(1_000);
    const r = new EphRate(c.now);
    for (let i = 0; i < 400; i++) assert.equal(r.accept(), "ok");
    assert.equal(r.accept(), "drop");
    c.tick(100);
    for (let i = 0; i < 10; i++) assert.equal(r.accept(), "ok");
    assert.equal(r.accept(), "drop");
  });

  test("past three times the rate for 10 s is abuse, at three times it is not", () => {
    for (const [perSecond, abuse] of [
      [300, false],
      [301, true],
    ] as const) {
      const c = clock(1_000);
      const r = new EphRate(c.now);
      let verdict = "ok";
      for (let second = 0; second <= 11 && verdict !== "abuse"; second++) {
        for (let i = 0; i < perSecond && verdict !== "abuse"; i++) verdict = r.accept();
        c.tick(1_000);
      }
      assert.equal(verdict === "abuse", abuse, `${perSecond} a second`);
    }
  });
});

describe("OpRate", () => {
  test("allows a burst of 60 then 20 per second, and reports sustained abuse", () => {
    const c = clock(1_000);
    const r = new OpRate(c.now);
    for (let i = 0; i < 60; i++) {
      assert.equal(r.count(), false);
      assert.equal(r.allow(), true);
    }
    assert.equal(r.allow(), false);
    c.tick(1_000);
    for (let i = 0; i < 20; i++) assert.equal(r.allow(), true);
    assert.equal(r.allow(), false);
    // 61 messages in one second is over three times the limit. Kept up for 10 s it closes.
    let closed = false;
    for (let s = 0; s < 11 && !closed; s++) {
      c.tick(1_000);
      for (let i = 0; i < 61; i++) if (r.count()) closed = true;
    }
    assert.equal(closed, true);
  });
});

describe("SustainedViolation", () => {
  test("a gap without violations ends the streak, a reset too", () => {
    const c = clock();
    const v = new SustainedViolation(10_000, c.now);
    assert.equal(v.over(), false);
    c.tick(2_000);
    assert.equal(v.over(), false);
    c.tick(500);
    assert.equal(v.over(), false);
    for (let i = 0; i < 20; i++) {
      c.tick(500);
      v.over();
    }
    assert.equal(v.over(), true);
    v.reset();
    assert.equal(v.over(), false);
  });
});

describe("SlidingWindow", () => {
  test("counts per key within the window", () => {
    const c = clock();
    const w = new SlidingWindow(10_000, 4, c.now);
    for (let i = 0; i < 4; i++) assert.equal(w.tryAdd("a"), true);
    assert.equal(w.tryAdd("a"), false);
    assert.equal(w.tryAdd("b"), true);
    c.tick(10_001);
    assert.equal(w.tryAdd("a"), true);
  });
});

describe("dead keys", () => {
  test("a sliding window drops keys with no live events at its next sweep", () => {
    const c = clock();
    const w = new SlidingWindow(2_000, 1, c.now);
    for (let i = 0; i < 100; i++) w.tryAdd(`c:${i}`);
    assert.equal(w.size, 100);
    c.tick(61_000);
    w.tryAdd("c:new");
    assert.equal(w.size, 1);
  });

  test("the snapshot budget drops spent windows and abuse clocks nobody uses any more", () => {
    const c = clock();
    const b = new SnapshotBudget({ sessionCount: 1 }, c.now);
    for (let i = 0; i < 50; i++) {
      const keys = b.keys(`session-${i}`, `ip-${i}`, false);
      b.record(keys, 1_000);
      b.request(`session-${i}`, b.delay(keys) > 0);
    }
    assert.equal(b.size, 150);
    // A spend is kept a window past its own, for a call that reads a slightly earlier time.
    c.tick(61_000);
    b.record(b.keys("fresh", "ip-fresh", false), 1_000);
    assert.equal(b.size, 102, "the abuse clocks go after their window, the spends not yet");
    c.tick(60_000);
    b.record(b.keys("later", "ip-later", false), 1_000);
    assert.equal(b.size, 4);
  });
});

describe("SnapshotBudget", () => {
  test("a request at a time counts no spend recorded later at a later time", () => {
    const c = clock(100_000);
    const b = new SnapshotBudget({}, c.now);
    const keys = b.keys("s1", "ip1", false);
    for (let i = 0; i < 19; i++) b.record(keys, 1_000, 100_000 + i);
    b.record(keys, 1_000, 150_000);
    assert.equal(b.delay(keys, 120_000), 0, "the spend at 150,000 is no part of a request at 120,000");
    assert.equal(b.delay(keys, 150_000), 10_000, "a request at 150,000 counts all 20");
  });

  test("a reserved spend counts at once, and its bytes once they are given, at the time it was reserved", () => {
    const c = clock(100_000);
    const b = new SnapshotBudget({ sessionCount: 3, sessionBytes: 10_000 }, c.now);
    const keys = b.keys("s1", "ip1", false);
    b.record(keys, 4_000, 100_000);
    const sent = b.reserve(keys, 100_010);
    b.record(keys, 4_000, 100_005);
    assert.equal(b.delay(keys, 100_020), 59_980, "the third request in the minute counts: the next waits for the first to leave");
    assert.equal(b.delay(keys, 160_000), 0, "a spend not sent yet holds no bytes");
    sent(7_000);
    assert.equal(b.delay(keys, 160_000), 5, "once sent, its bytes count from its place, after the one at 100,005");
  });

  test("a call at a later time keeps every spend a request a little earlier still counts", () => {
    const c = clock(100_000);
    const b = new SnapshotBudget({}, c.now);
    const keys = b.keys("s1", "ip1", false);
    for (let i = 0; i < 20; i++) b.record(keys, 1_000, 100_000 + i * 50);
    assert.equal(b.delay(keys, 161_000), 0, "the 20 left the window by 161,000");
    b.record(b.keys("s2", "ip2", false), 1_000, 161_000);
    assert.equal(b.delay(keys, 159_000), 1_000, "the 20 spent still hold a request at 159,000 until the oldest leaves at 160,000");
  });

  test("delays the 21st snapshot of a session until the oldest leaves the minute", () => {
    const c = clock(100_000);
    const b = new SnapshotBudget({}, c.now);
    const keys = b.keys("s1", "ip1", false);
    for (let i = 0; i < 20; i++) {
      assert.equal(b.delay(keys), 0);
      b.record(keys, 1_000);
      c.tick(1_000);
    }
    assert.equal(b.delay(keys), 40_000);
    c.tick(40_000);
    assert.equal(b.delay(keys), 0);
  });

  test("the default takes ten of the largest DM snapshot, 6 MiB with companion blocks, a minute per session and twenty per pinned room's session", () => {
    const largest = LIMITS.projectedSceneBytes + LIMITS.companionBlocksBytes;
    assert.equal(DEFAULT_SNAPSHOT_BUDGET.sessionBytes, 10 * largest);
    assert.equal(DEFAULT_SNAPSHOT_BUDGET.ipBytes, 20 * largest);
    const c = clock(100_000);
    const b = new SnapshotBudget({}, c.now);
    const keys = b.keys("s1", "ip1", false);
    for (let i = 0; i < 10; i++) {
      assert.equal(b.delay(keys), 0, `snapshot ${i + 1}`);
      b.record(keys, largest);
      c.tick(1_000);
    }
    assert.ok(b.delay(keys) > 0, "the eleventh waits");
    // A second session at the same address still gets its ten.
    const other = b.keys("s2", "ip1", false);
    for (let i = 0; i < 10; i++) {
      assert.equal(b.delay(other), 0, `second session's snapshot ${i + 1}`);
      b.record(other, largest);
    }
  });

  test("bytes delay a session and a pinned room's share of it, and an address counts requests alone", () => {
    const c = clock(100_000);
    const b = new SnapshotBudget({ sessionBytes: 10_000, ipBytes: 15_000 }, c.now);
    const a = b.keys("s1", "ip1", false);
    const other = b.keys("s2", "ip1", false);
    b.record(a, 9_000);
    assert.equal(b.delay(a), 0);
    b.record(a, 2_000);
    assert.ok(b.delay(a) > 0);
    // The address holds s1's 11,000 bytes and s2's 5,000, past its 15,000, and s2 still waits for nothing.
    b.record(other, 5_000);
    assert.equal(b.delay(other), 0);
    // A pinned room's share is per session and counts bytes: 16,000 is past it.
    const pinned = b.keys("s3", "ip1", true);
    b.record(pinned, 16_000);
    assert.ok(b.delay(pinned) > 0);
  });

  test("a player's snapshot waits the same after the DM's 33 on its address, large or small", () => {
    const waits = [1, 4].map((mib) => {
      const c = clock(100_000);
      const b = new SnapshotBudget({}, c.now);
      // Eleven DM sessions of three snapshots each, so no session of theirs is past its own bytes.
      for (let i = 0; i < 33; i++) {
        b.record(b.keys(`dm${i % 11}`, "ip1", false), mib * 1024 * 1024);
        c.tick(1_000);
      }
      const p1 = b.keys("p1", "ip1", false);
      const before = b.delay(p1);
      for (let i = 0; i < 7; i++) b.record(p1, 1_000);
      return [before, b.delay(p1)];
    });
    assert.deepEqual(waits[0], waits[1]);
    assert.equal(waits[0]![0], 0, "33 of 40 leave room for the player");
    assert.ok(waits[0]![1]! > 0, "the address's 41st waits");
  });

  test("the abuse rule fires only for a session that keeps making new requests while over budget", () => {
    const c = clock(0);
    const b = new SnapshotBudget({ abuseMs: 30_000 }, c.now);
    assert.equal(b.request("s1", true), false);
    c.tick(29_000);
    assert.equal(b.request("s1", true), false);
    c.tick(2_000);
    assert.equal(b.request("s1", true), true);
    // Cleared after the close, and a request that goes through resets it.
    assert.equal(b.request("s1", true), false);
    c.tick(31_000);
    assert.equal(b.request("s1", false), false);
    assert.equal(b.request("s1", true), false);
  });

  test("a session that stopped asking for longer than the abuse window starts a new clock, with no sweep between", () => {
    const c = clock(0);
    const b = new SnapshotBudget({ abuseMs: 30_000 }, c.now);
    assert.equal(b.request("s1", true), false);
    c.tick(40_000);
    assert.equal(b.request("s1", true), false, "two delayed requests 40 s apart are not abuse");
    c.tick(29_000);
    assert.equal(b.request("s1", true), false, "29 s from the new clock's start");
    c.tick(2_000);
    assert.equal(b.request("s1", true), true, "requests kept up for 30 s still are");
    // Kept up every 10 s for 30 s, the same.
    for (const at of [0, 10_000, 20_000]) {
      c.tick(at === 0 ? 50_000 : 10_000);
      assert.equal(b.request("s2", true), false, `at ${at}`);
    }
    c.tick(10_000);
    assert.equal(b.request("s2", true), true);
  });

  test("a session may have twice as many requests waiting at once as it may hold sockets, and an address likewise", () => {
    assert.deepEqual([DEFAULT_SNAPSHOT_BUDGET.sessionWaiting, DEFAULT_SNAPSHOT_BUDGET.ipWaiting], [2 * DEFAULT_SOCKET_CAPS.perSession, 2 * DEFAULT_SOCKET_CAPS.perIp]);
    const b = new SnapshotBudget({ sessionWaiting: 2, ipWaiting: 3 }, () => 0);
    const one = b.keys("s1", "ip-1", false);
    const two = b.keys("s2", "ip-1", false);
    b.wait("X|s1|a", one, 5_000, 0);
    b.wait("X|s1|b", one, 8_000, 0);
    assert.equal(b.mayWait(one, 0), false, "the session's two");
    assert.equal(b.mayWait(two, 0), true, "another session at the address, which holds two");
    b.wait("X|s2|a", two, 8_000, 0);
    assert.equal(b.mayWait(two, 0), false, "the address's three");
    // The same id takes the old request's place, and a dropped request counts no more.
    b.wait("X|s1|a", one, 6_000, 0);
    assert.deepEqual([b.waiting, b.mayWait(one, 0)], [3, false]);
    b.drop("X|s1|a", 0);
    assert.deepEqual([b.waiting, b.mayWait(one, 0)], [2, true]);
    // The pinned room's second key counts per session.
    assert.equal(b.mayWait(b.keys("s3", "ip-1", true), 0), true);
  });

  test("requests due by a call's time are settled first, earliest first, so one that waits again still counts", () => {
    const c = clock(0);
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000, sessionWaiting: 2 }, c.now);
    const keys = b.keys("s1", "ip-1", false);
    b.record(keys, 1, 0);
    const heard: string[] = [];
    const hear = (id: string) => (o: DueOutcome) => void heard.push(`${id} ${o.at} ${o.kind === "waits" ? `waits ${o.delay}` : "fits"}`);
    b.wait("X|s1|late", keys, 1_000, 200, hear("late"));
    b.wait("X|s1|early", keys, 1_000, 100, hear("early"));
    b.drop("X|s1|early", 100);
    b.wait("X|s1|early", keys, 900, 100, hear("early"));
    // No timer has fired by 1,500 ms, and the call settles both before it reads the budget.
    assert.equal(b.mayWait(keys, 1_500), true);
    assert.deepEqual(heard, ["early 900 waits 100", "late 1000 fits", "early 1000 waits 1000"]);
    assert.equal(b.waiting, 1);
    assert.equal(b.delay(keys, 1_500), 500);
  });

  test("every call that reads, spends or drops settles the requests due by its time first", () => {
    const run = (call: (b: SnapshotBudget, keys: ReturnType<SnapshotBudget["keys"]>) => void) => {
      const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, () => 0);
      const keys = b.keys("s1", "ip-1", false);
      b.record(keys, 1, 0);
      const heard: number[] = [];
      b.wait("X|s1|a", keys, 1_000, 0, (o) => void heard.push(o.at));
      call(b, keys);
      return [heard, b.waiting];
    };
    assert.deepEqual(run((b, keys) => b.delay(keys, 1_500)), [[1_000], 0]);
    assert.deepEqual(run((b, keys) => b.reserve(keys, 1_500)), [[1_000], 0]);
    assert.deepEqual(run((b, keys) => b.mayWait(keys, 1_500)), [[1_000], 0]);
    assert.deepEqual(run((b) => b.drop("X|s1|a", 1_500)), [[1_000], 0], "a request due before its drop spent its place");
    assert.deepEqual(run((b) => b.drop("X|s1|a", 900)), [[], 0], "one dropped before it is due spends nothing");
  });

  test("a request dropped as it arrives leaves nothing behind, however many sockets come and go", () => {
    const b = new SnapshotBudget({}, () => 0);
    for (let i = 0; i < 1_000; i++) {
      const keys = b.keys("s1", `ip-${i % 7}`, false);
      b.wait(`X|s1|${i}`, keys, 60_000, i);
      b.drop(`X|s1|${i}`, i);
    }
    assert.deepEqual([b.waiting, b.size], [0, 0]);
  });

  test("a timer that fires late settles every request due by then, each at its own due time, and sets the next from then", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const c = clock(0);
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, c.now);
    const heard: string[] = [];
    const hear = (o: DueOutcome) => void heard.push(`${o.at} ${o.kind}`);
    // Three sessions, each with its one place taken, ask at once and come due at 1,000, 1,100 and 2,000 ms.
    const asks = [["s1", 0, 1_000], ["s2", 100, 1_100], ["s3", 1_000, 2_000]] as const;
    for (const [session, spent] of asks) b.record(b.keys(session, `ip-${session}`, false), 1, spent);
    for (const [session, , due] of asks) b.wait(`X|${session}|a`, b.keys(session, `ip-${session}`, false), due, 0, hear);
    assert.deepEqual(heard, []);
    // The loop is busy until 1,500 ms, when the first timer fires, with no other call to the budget.
    c.tick(1_500);
    t.mock.timers.tick(1_000);
    assert.deepEqual(heard, ["1000 fits", "1100 fits"]);
    // The next timer runs 500 ms on from then, at 2,000.
    c.tick(500);
    t.mock.timers.tick(500);
    assert.deepEqual(heard, ["1000 fits", "1100 fits", "2000 fits"]);
    assert.equal(b.waiting, 0);
  });

  test("a room that fails to take its due time stops neither the other requests nor the timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const c = clock(0);
    const warned: string[] = [];
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, c.now, { warn: (_obj, msg) => void warned.push(msg) });
    const heard: string[] = [];
    const asks = [
      ["s1", 1_000, () => { throw new Error("room failed"); }],
      ["s2", 1_000, (o: DueOutcome) => void heard.push(`s2 ${o.at}`)],
      ["s3", 2_000, (o: DueOutcome) => void heard.push(`s3 ${o.at}`)],
    ] as const;
    for (const [session, due] of asks) b.record(b.keys(session, `ip-${session}`, false), 1, due - 1_000);
    for (const [session, due, onDue] of asks) b.wait(`X|${session}|a`, b.keys(session, `ip-${session}`, false), due, 0, onDue);
    assert.deepEqual(heard, []);
    // A call from another room settles the two requests due by 1,000 ms, and returns.
    assert.equal(b.mayWait(b.keys("s4", "ip-s4", false), 1_000), true);
    assert.deepEqual([heard, warned.length, b.waiting], [["s2 1000"], 1, 1]);
    c.tick(2_000);
    t.mock.timers.tick(2_000);
    assert.deepEqual(heard, ["s2 1000", "s3 2000"]);
  });

  test("settling many requests due at once reads each one's due time a few times, not once for every other request", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, () => 0);
    const n = 2_000;
    let reads = 0;
    const heard: string[] = [];
    for (let i = 0; i < n; i++) {
      const keys = b.keys(`s${i}`, `ip-${i}`, false);
      b.record(keys, 1, i % 7);
      const request = b.wait(`X|s${i}|a`, keys, 1_000 + (i % 7), 0, (o) => void heard.push(`s${i} ${o.at}`));
      let due = request.due;
      Object.defineProperty(request, "due", {
        get: () => (reads++, due),
        set: (value: number) => void (due = value),
      });
    }
    // Every request fits at its due time, earliest first and in arrival order among equals.
    assert.equal(b.mayWait(b.keys("other", "ip-other", false), 1_006), true);
    const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => (x % 7) - (y % 7) || x - y);
    assert.deepEqual(heard, order.map((i) => `s${i} ${1_000 + (i % 7)}`));
    assert.equal(b.waiting, 0);
    assert.ok(reads < 20 * n, `${reads} reads of a due time for ${n} requests`);
  });

  test("a dropped request's due time neither settles nor sets the timer, and the next request's does", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const c = clock(0);
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, c.now);
    const heard: string[] = [];
    for (const [session, due] of [["s1", 1_000], ["s2", 1_500], ["s3", 1_500]] as const) {
      const keys = b.keys(session, `ip-${session}`, false);
      b.record(keys, 1, due - 1_000);
      b.wait(`X|${session}|a`, keys, due, 0, (o) => void heard.push(`${session} ${o.at}`));
    }
    b.drop("X|s1|a", 0);
    // The same id waits again, now after s3, so it settles after s3 though its due time matches.
    b.wait("X|s2|a", b.keys("s2", "ip-s2", false), 1_500, 0, (o) => void heard.push(`s2 again ${o.at}`));
    c.tick(1_000);
    t.mock.timers.tick(1_000);
    assert.deepEqual(heard, []);
    c.tick(500);
    t.mock.timers.tick(500);
    assert.deepEqual(heard, ["s3 1500", "s2 again 1500"]);
    assert.equal(b.waiting, 0);
  });

  test("requests dropped long before their due time leave the due heap near the size of those still waiting", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 60_000 }, () => 0);
    const keys = b.keys("s1", "ip-1", false);
    b.record(keys, 1, 0);
    b.wait("X|s1|kept", keys, 60_000, 0);
    for (let i = 0; i < 500; i++) {
      b.wait(`X|s1|${i}`, keys, 60_001 + i, 0);
      b.drop(`X|s1|${i}`, 0);
    }
    assert.equal(b.waiting, 1);
    assert.ok(b.places <= 2 * b.waiting + 16, `${b.places} places for ${b.waiting} request`);
  });

  test("a request told to wait again keeps its turn ahead of a later request due at the same time", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const c = clock(0);
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, c.now);
    const heard: string[] = [];
    const a = b.keys("sa", "ip-a", false);
    b.record(a, 1, 500);
    b.wait("X|sa|a", a, 1_000, 0, (o) => void heard.push(`sa ${o.kind} ${o.at}`));
    const later = b.keys("sb", "ip-b", false);
    b.record(later, 1, 500);
    b.wait("X|sb|a", later, 1_500, 0, (o) => void heard.push(`sb ${o.kind} ${o.at}`));
    c.tick(1_500);
    t.mock.timers.tick(1_500);
    assert.deepEqual(heard, ["sa waits 1000", "sa fits 1500", "sb fits 1500"]);
  });

  test("the budget's own timer settles a request at its due time with no call to the budget, and holds no process open", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, () => 0);
    const keys = b.keys("s1", "ip-1", false);
    b.record(keys, 1, 0);
    const heard: DueOutcome[] = [];
    b.wait("X|s1|a", keys, 1_000, 0, (o) => void heard.push(o));
    t.mock.timers.tick(999);
    assert.equal(heard.length, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(heard.map((o) => [o.at, o.kind]), [[1_000, "fits"]]);
    assert.equal(b.waiting, 0);
  });
});

describe("SocketRegistry", () => {
  test("caps per session, room, IP and total", () => {
    const r = new SocketRegistry({ perSession: 2, perRoom: 3, perIp: 2, total: 4 });
    const releases = [r.open("s1", "r1", "ip1"), r.open("s1", "r1", "ip2")];
    assert.equal(r.canOpen("s1", "r2", "ip3"), false);
    assert.equal(r.canOpen("s2", "r1", "ip1"), true);
    releases.push(r.open("s2", "r1", "ip1"));
    assert.equal(r.canOpen("s3", "r1", "ip3"), false);
    assert.equal(r.canOpen("s3", "r2", "ip1"), false);
    releases.push(r.open("s3", "r2", "ip3"));
    assert.equal(r.canOpen("s4", "r3", "ip4"), false);
    for (const release of releases) release();
    assert.equal(r.total, 0);
    releases[0]!();
    assert.equal(r.total, 0);
  });

  test("remoteDevices counts each other address once, and never this computer's loopback or network address (D-261113-095)", () => {
    const r = new SocketRegistry();
    const own = new Set(["127.0.0.1", "10.0.0.5"]);
    const isThisComputer = (ip: string) => own.has(ip);
    assert.equal(r.remoteDevices(isThisComputer), 0);
    // The DM's tabs at localhost and at the LAN address on the host.
    const dm = [r.open("dm", "r1", "127.0.0.1"), r.open("dm", "r1", "127.0.0.1"), r.open("dm2", "r1", "10.0.0.5")];
    assert.equal(r.remoteDevices(isThisComputer), 0);
    const phone = r.open("p1", "r1", "10.0.0.20");
    r.open("p1", "r2", "10.0.0.20");
    const tablet = r.open("p2", "r1", "172.16.0.7");
    assert.equal(r.remoteDevices(isThisComputer), 2);
    assert.equal(r.total, 6);
    tablet();
    assert.equal(r.remoteDevices(isThisComputer), 1);
    phone();
    assert.equal(r.remoteDevices(isThisComputer), 1, "one socket from that address is still open");
    for (const release of dm) release();
    assert.equal(r.remoteDevices(isThisComputer), 1);
  });
});

describe("times given by the caller, as a queued command's arrival", () => {
  test("a bucket given a time before the last it read refills nothing, and its time stays where it was", () => {
    const b = new TokenBucket(1, 1, () => 0);
    assert.equal(b.take(1, 10_000), true);
    assert.equal(b.take(1, 5_000), false, "an earlier time refills nothing");
    assert.equal(b.available(10_500), 0.5, "refilled from 10,000, not from 5,000");
  });

  test("an op rate's window and its sustained streak never move back", () => {
    const rate = new OpRate(() => 0, { perSec: 1, holdMs: 0 });
    for (let i = 0; i < 3; i++) assert.equal(rate.count(2_500), false);
    assert.equal(rate.count(1_500), true, "an earlier second counts in the window already open");
    const streak = new SustainedViolation(1_000, () => 0, 1_000);
    assert.equal(streak.over(10_000), false);
    assert.equal(streak.over(5_000), false);
    assert.equal(streak.over(10_900), false);
    assert.equal(streak.over(11_100), true, "the streak still runs from 10,000: its last time stayed there");
  });

  test("an op rate spends and reads its bucket at the time given", () => {
    const rate = new OpRate(() => 0, { perSec: 10, burst: 2 });
    assert.equal(rate.allow(2, 0), true);
    assert.equal(rate.wouldAllow(1, 50), false);
    assert.equal(rate.wouldAllow(1, 100), true);
    assert.equal(rate.allow(1, 100), true);
    assert.equal(rate.allow(1, 100), false);
  });

  test("the snapshot budget reads the time given and keeps spends in time order whatever order rooms record them in", () => {
    const budget = new SnapshotBudget({ sessionCount: 2, windowMs: 60_000 }, () => 0);
    const keys = budget.keys("s1", "203.0.113.1", false);
    budget.record(keys, 10, 30_000);
    budget.record(keys, 10, 10_000);
    assert.equal(budget.delay(keys, 50_000), 20_000, "the oldest spend leaves the window first");
    assert.equal(budget.delay(keys, 70_001), 0);
    assert.equal(budget.request("s1", true, 40_000), false);
    assert.equal(budget.request("s1", true, 35_000), false, "an earlier request does not move the abuse clock back");
  });
});

describe("PreviewPool", () => {
  type Sock = { id: number; role: "dm" | "player"; roomId: string; promote: () => boolean; raised: number; gone: boolean };
  let nextId = 1;
  const sock = (role: "dm" | "player", roomId: string): Sock => {
    const s: Sock = { id: nextId++, role, roomId, raised: 0, gone: false, promote: () => (s.gone ? false : (s.raised++, true)) };
    return s;
  };
  function pool(mb = DEFAULT_PREVIEW_POOL_MB) {
    const logged: { role: string }[] = [];
    return { pool: new PreviewPool(mb, { warn: (obj) => void logged.push(obj as { role: string }) }), logged };
  }
  /** 13 rooms of six players and a DM. */
  const table = () => Array.from({ length: 13 }, (_, r) => [sock("dm", `room${r}`), ...Array.from({ length: 6 }, () => sock("player", `room${r}`))]);

  test("128 MiB holds 154 full shares at 848 KiB, 50 kept for DM sockets, and 106 MiB still holds 50 and 78", () => {
    assert.equal(new PreviewPool().full, 154);
    assert.equal(new PreviewPool().reserved, DM_RESERVED_ALLOWANCES);
    const floor = new PreviewPool(106);
    assert.ok(floor.full - floor.reserved >= 78 && floor.reserved === 50, `${floor.full}`);
  });

  for (const order of ["players first", "DMs first", "shuffled"] as const) {
    test(`91 sockets of 13 rooms, ${order}: every one full`, () => {
      const { pool: p, logged } = pool();
      const rooms = table();
      let all = rooms.flat();
      if (order === "players first") all = [...all.filter((s) => s.role === "player"), ...all.filter((s) => s.role === "dm")];
      if (order === "DMs first") all = [...all.filter((s) => s.role === "dm"), ...all.filter((s) => s.role === "player")];
      if (order === "shuffled") all = [...all].sort((a, b) => ((a.id * 7919) % 97) - ((b.id * 7919) % 97));
      for (const s of all) assert.equal(p.admit(s), "full", `${s.role} ${s.roomId}`);
      assert.deepEqual(p.counts, { reserve: 13, general: 78, off: 0 });
      assert.deepEqual(logged, []);
    });
  }

  test("all 78 players reconnect while their old sockets linger: each takes its old share, and all end full", () => {
    const { pool: p } = pool();
    const rooms = table();
    for (const s of rooms.flat()) p.admit(s);
    for (const old of rooms.flat().filter((s) => s.role === "player")) assert.equal(p.admit(sock("player", old.roomId), old), "full");
    assert.deepEqual(p.counts, { reserve: 13, general: 78, off: 0 });
    // The old sockets' close events come later and give back nothing they no longer hold.
    for (const old of rooms.flat().filter((s) => s.role === "player")) p.release(old);
    assert.deepEqual(p.counts, { reserve: 13, general: 78, off: 0 });
  });

  test("pages that reload as new clients go off past the general shares, and are raised as the old sockets close", () => {
    const { pool: p } = pool();
    const rooms = table();
    for (const s of rooms.flat()) p.admit(s);
    const olds = rooms.flat().filter((s) => s.role === "player");
    const news = olds.map((old) => sock("player", old.roomId));
    const verdicts = news.map((s) => p.admit(s));
    assert.equal(verdicts.filter((v) => v === "full").length, 104 - 78);
    for (const old of olds) p.release(old);
    assert.deepEqual(p.counts, { reserve: 13, general: 78, off: 0 });
    assert.ok(news.filter((_, i) => verdicts[i] === "off").every((s) => s.raised === 1), "each off socket raised once");
  });

  test("off past 104 general sockets for a player or a DM's second device, and for a DM's first only past 50 rooms' DMs too, each logged with its role", () => {
    const { pool: p, logged } = pool();
    for (let i = 0; i < 104; i++) assert.equal(p.admit(sock("player", "big")), "full");
    assert.equal(p.admit(sock("player", "big")), "off");
    assert.equal(p.admit(sock("dm", "big")), "full", "the room's DM takes its kept share");
    assert.equal(p.admit(sock("dm", "big")), "off", "its second device takes none");
    for (let r = 0; r < 49; r++) assert.equal(p.admit(sock("dm", `r${r}`)), "full");
    assert.equal(p.admit(sock("dm", "r49")), "off", "the 51st room's DM");
    assert.deepEqual(logged.map((l) => l.role), ["player", "dm", "dm"]);
  });

  test("a share that comes back raises the oldest off socket it may serve, a kept DM share only a DM socket of a room without one", () => {
    const { pool: p } = pool(1);
    // 1 MiB: one full share, kept for a DM.
    assert.equal(p.full, 1);
    const dmA = sock("dm", "a");
    const player = sock("player", "a");
    const dmA2 = sock("dm", "a");
    const dmB = sock("dm", "b");
    assert.equal(p.admit(dmA), "full");
    assert.equal(p.admit(player), "off");
    assert.equal(p.admit(dmA2), "off");
    assert.equal(p.admit(dmB), "off");
    p.release(dmA);
    // The player and room a's second DM came first, but a kept share serves a DM: room a's second device, which holds none now.
    assert.deepEqual([player.raised, dmA2.raised, dmB.raised], [0, 1, 0]);
    dmA2.gone = true;
    p.release(dmA2);
    assert.deepEqual([player.raised, dmB.raised], [0, 1]);
  });

  test("a socket gone before its share comes back passes it on to the next", () => {
    const { pool: p } = pool();
    const holders = Array.from({ length: 104 }, () => sock("player", "a"));
    for (const s of holders) p.admit(s);
    const gone = sock("player", "a");
    const next = sock("player", "a");
    assert.equal(p.admit(gone), "off");
    assert.equal(p.admit(next), "off");
    gone.gone = true;
    p.release(holders[0]!);
    assert.deepEqual([gone.raised, next.raised], [0, 1]);
    // The gone socket holds nothing now, so its own close later gives back nothing.
    assert.deepEqual(p.counts, { reserve: 0, general: 104, off: 0 });
    p.release(gone);
    assert.deepEqual(p.counts, { reserve: 0, general: 104, off: 0 });
  });

  test("a replacement takes its predecessor's share only when its role may hold it", () => {
    const { pool: p } = pool();
    const dm = sock("dm", "a");
    assert.equal(p.admit(dm), "full");
    const waiting = sock("dm", "b");
    // Fill the general shares and every kept one but room a's.
    for (let i = 0; i < 104; i++) p.admit(sock("player", "x"));
    for (let r = 0; r < 49; r++) p.admit(sock("dm", `k${r}`));
    assert.equal(p.admit(waiting), "off");
    // A role change between the two sockets: the demoted player's replacement takes no kept DM share.
    const demoted = sock("player", "a");
    assert.equal(p.admit(demoted, dm), "off", "no general share is free either");
    assert.equal(waiting.raised, 1, "the kept share went to the oldest off DM socket");
    // A DM's replacement keeps the kept share, and a player's its general one.
    const again = sock("dm", "b");
    assert.equal(p.admit(again, waiting), "full");
    assert.deepEqual(p.counts.reserve, 50);
  });
});
