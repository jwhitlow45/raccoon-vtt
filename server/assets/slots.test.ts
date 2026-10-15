import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AssetError } from "./errors.ts";
import { WindowLimiter } from "./limits.ts";
import { IntakeSlots, Semaphore, type SlotRequest } from "./slots.ts";

let n = 0;
function req(over: Partial<SlotRequest> = {}): SlotRequest {
  n++;
  return { kind: "upload", roomId: `room${n}`, ip: `ip${n}`, sessionId: `s${n}`, pinned: false, ...over };
}

describe("IntakeSlots", () => {
  test("unpinned rooms share 3 slots, the 4th is kept for pinned rooms", () => {
    const slots = new IntakeSlots();
    for (let i = 0; i < 3; i++) assert.ok(slots.tryAcquire(req()));
    assert.equal(slots.tryAcquire(req()), null);
    assert.ok(slots.tryAcquire(req({ pinned: true })));
    assert.equal(slots.tryAcquire(req({ pinned: true })), null);
    assert.equal(slots.inUse, 4);
  });

  test("acquire answers 503 with Retry-After and asks to close the connection", () => {
    const slots = new IntakeSlots({ total: 1, reservedForPinned: 0, perIp: 1, perRoom: 2, roomImports: 1 });
    slots.acquire(req());
    assert.throws(
      () => slots.acquire(req()),
      (err: unknown) => err instanceof AssetError && err.status === 503 && err.retryAfter! > 0 && err.closeConnection,
    );
  });

  test("one slot per IP in an unpinned room", () => {
    const slots = new IntakeSlots();
    assert.ok(slots.tryAcquire(req({ ip: "1.1.1.1" })));
    assert.equal(slots.tryAcquire(req({ ip: "1.1.1.1" })), null);
    assert.ok(slots.tryAcquire(req({ ip: "2.2.2.2" })));
  });

  test("in a pinned room the per-IP share is per session, so one table IP can upload twice at once", () => {
    const slots = new IntakeSlots();
    assert.ok(slots.tryAcquire(req({ ip: "9.9.9.9", roomId: "PINNED01", sessionId: "dm", pinned: true })));
    assert.ok(slots.tryAcquire(req({ ip: "9.9.9.9", roomId: "PINNED01", sessionId: "player", pinned: true })));
    assert.equal(slots.tryAcquire(req({ ip: "9.9.9.9", roomId: "PINNED02", sessionId: "dm", pinned: true })), null);
  });

  test("at most 2 per room, pinned or not", () => {
    const slots = new IntakeSlots();
    assert.ok(slots.tryAcquire(req({ roomId: "R1", pinned: true })));
    assert.ok(slots.tryAcquire(req({ roomId: "R1", pinned: true })));
    assert.equal(slots.tryAcquire(req({ roomId: "R1", pinned: true })), null);
  });

  test("at most 1 room import server-wide", () => {
    const slots = new IntakeSlots();
    assert.ok(slots.tryAcquire(req({ kind: "roomImport", roomId: undefined })));
    assert.equal(slots.tryAcquire(req({ kind: "roomImport", roomId: undefined })), null);
    assert.ok(slots.tryAcquire(req()));
  });

  test("releasing gives the slot back once, however often it is called", () => {
    const slots = new IntakeSlots();
    const r = req({ ip: "3.3.3.3", roomId: "R3" });
    const release = slots.tryAcquire(r)!;
    release();
    release();
    assert.equal(slots.inUse, 0);
    assert.ok(slots.tryAcquire(r));
    assert.equal(slots.inUse, 1);
  });
});

describe("Semaphore", () => {
  test("caps concurrent holders", () => {
    const sem = new Semaphore(4);
    const held = [1, 2, 3, 4].map(() => sem.tryAcquire());
    assert.ok(held.every(Boolean));
    assert.equal(sem.tryAcquire(), null);
    held[0]!();
    held[0]!();
    assert.equal(sem.inUse, 3);
    assert.ok(sem.tryAcquire());
  });
});

describe("WindowLimiter", () => {
  test("allows up to the limit in the window, then reports when to retry", () => {
    let now = 1_000_000;
    const limiter = new WindowLimiter(3600_000, () => now);
    const checks = [{ key: "s:a", limit: 2 }];
    assert.equal(limiter.retryAfter(checks), 0);
    limiter.record(checks);
    now += 1000;
    limiter.record(checks);
    // The oldest event leaves the window an hour after it happened.
    assert.equal(limiter.retryAfter(checks), 3599);
    now += 3600_000 - 1001;
    assert.equal(limiter.retryAfter(checks), 1);
    now += 1;
    assert.equal(limiter.retryAfter(checks), 0);
  });

  test("any exhausted key refuses, so a new session cannot reset the IP or room budget", () => {
    let now = 0;
    const limiter = new WindowLimiter(3600_000, () => now);
    const forSession = (s: string) => [
      { key: `s:${s}`, limit: 30 },
      { key: "ip:1.2.3.4", limit: 3 },
    ];
    for (const s of ["a", "b", "c"]) {
      assert.equal(limiter.retryAfter(forSession(s)), 0);
      limiter.record(forSession(s));
      now += 10;
    }
    assert.ok(limiter.retryAfter(forSession("d")) > 0);
  });
});
