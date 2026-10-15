import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FrameBudget, OpRate, SlidingWindow, SnapshotBudget, SocketRegistry, SustainedViolation, TokenBucket } from "./budgets.ts";

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
  test("drops over-budget frames and flags abuse after 10 s without a break", () => {
    const c = clock();
    const f = new FrameBudget(c.now);
    for (let i = 0; i < 200; i++) assert.equal(f.accept(10), "ok");
    assert.equal(f.accept(10), "drop");
    // Twice the budget for ten seconds: half the frames pass, the drops never pause, so it is abuse.
    let verdict: string = "drop";
    for (let step = 0; step < 101 && verdict !== "abuse"; step++) {
      c.tick(100);
      for (let i = 0; i < 20; i++) verdict = f.accept(10);
    }
    assert.equal(verdict, "abuse");
    // A pause ends the streak: the same flood after a quiet 5 s starts over at "drop".
    const g = new FrameBudget(c.now);
    for (let step = 0; step < 60; step++) {
      c.tick(100);
      for (let i = 0; i < 20; i++) g.accept(10);
    }
    c.tick(5_000);
    let after: string = "ok";
    for (let step = 0; step < 50; step++) {
      c.tick(100);
      for (let i = 0; i < 20; i++) after = g.accept(10);
    }
    assert.equal(after, "drop");
  });

  test("bytes count on their own", () => {
    const c = clock();
    const f = new FrameBudget(c.now);
    assert.equal(f.accept(512 * 1024), "ok");
    assert.equal(f.accept(1), "drop");
    c.tick(1_000);
    assert.equal(f.accept(256 * 1024), "ok");
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
    c.tick(61_000);
    b.record(b.keys("fresh", "ip-fresh", false), 1_000);
    assert.equal(b.size, 2);
  });
});

describe("SnapshotBudget", () => {
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

  test("bytes delay too, and a pinned room counts the IP share per session", () => {
    const c = clock(100_000);
    const b = new SnapshotBudget({ sessionBytes: 10_000, ipBytes: 15_000 }, c.now);
    const a = b.keys("s1", "ip1", false);
    const other = b.keys("s2", "ip1", false);
    b.record(a, 9_000);
    assert.equal(b.delay(a), 0);
    b.record(a, 2_000);
    assert.ok(b.delay(a) > 0);
    // The IP is shared: s2 is over the IP bytes after s1's 11,000 and its own.
    b.record(other, 5_000);
    assert.ok(b.delay(other) > 0);
    const pinned = b.keys("s3", "ip1", true);
    assert.equal(b.delay(pinned), 0);
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
});
