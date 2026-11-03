import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { pick, rng } from "#shared/testutil.ts";
import { LAPSE_MS, LEASE_MS, POST_MS, TAKEOVER_MS } from "./handoff.ts";
import { randomRun, World } from "./handoffSim.testutil.ts";

/*
 * One page plays per browser (docs/design/design-v1-music.md 4.4 and 12):
 * pages of one room in one browser appearing, locking, freezing, stalling,
 * showing, hiding, closing and crashing, their contexts interrupted and
 * recovering by themselves, with and without Web Locks, in the world of
 * handoffSim.testutil.ts.
 *
 * Invariants, checked as each task runs and every 50 ms between:
 * - Two pages never sound at once, except without Web Locks a page that
 *   never heard from a stalled page that sounds.
 * - With Web Locks a page sounds only while it holds the lock.
 * - A page whose lease is armed has heard another page within the lapse.
 * - Settled (no stall, crash or change for long enough), exactly one
 *   eligible page sounds, a display when one is eligible, unless without
 *   Web Locks an unarmed owner crashed while another heard it, whose claim
 *   then keeps the rest quiet.
 * - Through tab switches alone the settled owner keeps playing.
 */

describe("one page plays per browser", () => {
  for (const locks of [true, false]) {
    test(`random pages ${locks ? "with" : "without"} Web Locks keep every invariant`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
          const failures = randomRun(seed, locks);
          assert.deepEqual(failures, [], `seed ${seed}`);
        }),
        { numRuns: Number(process.env.HANDOFF_RUNS ?? 2000) },
      );
    });
  }

  for (const locks of [true, false]) {
    test(`a lone page plays on through long stalls and slow timers, never arming its lease (${locks ? "with" : "without"} Web Locks)`, () => {
      const r = rng(7);
      const world = new World(locks, r);
      const page = world.open("member", false);
      world.runUntil(world.now + 4_000);
      assert.ok(page.audible(), "the lone page plays");
      for (let i = 0; i < 20; i++) {
        world.stall(page, pick(r, [900, 3_000, 9_000, 40_000]));
        world.runUntil(world.now + pick(r, [1_000, 10_000, 45_000]));
        assert.ok(page.audible(), `still plays after stall ${i}`);
      }
      assert.deepEqual(world.failures, []);
    });
  }

  test("with Web Locks a stalled owner plays on and the other page waits for its lock", () => {
    const world = new World(true, rng(1));
    const a = world.open("member", true);
    world.runUntil(world.now + 3_000);
    const b = world.open("member", false);
    world.runUntil(world.now + 3_000);
    assert.ok(a.audible() && !b.audible());
    world.stall(a, 8_000);
    world.runUntil(world.now + 8_500);
    assert.ok(a.audible(), "the stalled page renders on");
    assert.ok(!b.audible(), "the other waits for the lock");
    world.runUntil(world.now + 5_000);
    assert.ok(a.audible() && !b.audible(), "the owner keeps it once it runs again");
    assert.deepEqual(world.failures, []);
  });

  test("without Web Locks a stalled owner's lease silences it and the other page starts after 7 s", () => {
    const world = new World(false, rng(2));
    const a = world.open("member", true);
    world.runUntil(world.now + 3_000);
    const b = world.open("member", false);
    world.runUntil(world.now + 4_100);
    assert.ok(a.audible() && !b.audible());
    assert.ok(a.handoff.armed, "armed beside another live page");
    const stallAt = world.now;
    world.stall(a, 12_000);
    let silentAt = Infinity;
    let startedAt = Infinity;
    while (world.now < stallAt + 12_000) {
      world.runUntil(world.now + 50);
      if (!a.audible() && silentAt === Infinity) silentAt = world.now;
      if (b.audible() && startedAt === Infinity) startedAt = world.now;
    }
    assert.ok(silentAt <= stallAt + LEASE_MS, `silent by the lease, at ${silentAt - stallAt}`);
    assert.ok(startedAt > silentAt && startedAt <= stallAt + TAKEOVER_MS + 1_000, `the other starts after it, at ${startedAt - stallAt}`);
    world.runUntil(world.now + 5_000);
    assert.ok(!a.audible() && b.audible(), "the stalled page gives way once it runs");
    assert.deepEqual(world.failures, []);
  });

  for (const locks of [true, false]) {
    test(`A plays alone, B opens, A stalls before it sees B and renders past 30 s: one page sounds throughout (${locks ? "with" : "without"} Web Locks)`, () => {
      const world = new World(locks, rng(3));
      world.delay = 5;
      const a = world.open("member", true);
      world.runUntil(world.now + 4_000);
      assert.ok(a.audible());
      // B opens a moment before A's next post: B hears it, and A stalls before B's first post reaches it.
      const tick = world.now + POST_MS - (world.now % POST_MS);
      world.runUntil(tick - 1);
      const b = world.open("member", true);
      world.runUntil(tick + 1);
      world.stall(a, 35_000);
      for (let i = 0; i < 700; i++) {
        world.runUntil(world.now + 50);
        assert.ok(!(a.audible() && b.audible()), "never both");
      }
      assert.ok(a.audible(), "A renders on");
      world.runUntil(world.now + 6_000);
      assert.equal([a, b].filter((p) => p.audible()).length, 1);
      assert.deepEqual(world.failures, []);
    });
  }

  for (const locks of [true, false]) {
    test(`an owner's context interrupted, another page takes over, the first recovers by itself and stays quiet (${locks ? "with" : "without"} Web Locks)`, () => {
      const world = new World(locks, rng(4));
      const a = world.open("member", true);
      world.runUntil(world.now + 4_000);
      const b = world.open("member", false);
      world.runUntil(world.now + 4_000);
      assert.ok(a.audible());
      world.suspend(a);
      world.runUntil(world.now + 4_000);
      assert.ok(b.audible(), "the other page took over");
      world.recover(a);
      world.runUntil(world.now + 10_000);
      assert.ok(!a.audible() && b.audible(), "the first stays at 0");
      assert.deepEqual(world.failures, []);
    });
  }

  for (const locks of [true, false]) {
    test(`the DM switching between two room tabs keeps the tab that played (${locks ? "with" : "without"} Web Locks)`, () => {
      const world = new World(locks, rng(5));
      const a = world.open("member", true);
      world.runUntil(world.now + 4_000);
      const b = world.open("member", true);
      world.show(a, false);
      for (let i = 0; i < 10; i++) {
        world.runUntil(world.now + 1_500);
        world.show(a, i % 2 === 1);
        world.show(b, i % 2 === 0);
        assert.ok(a.audible() && !b.audible(), `switch ${i}`);
      }
      assert.deepEqual(world.failures, []);
    });
  }

  for (const locks of [true, false]) {
    test(`"Open on this device": the display plays, then the DM's page once the display's window is locked (${locks ? "with" : "without"} Web Locks)`, () => {
      const world = new World(locks, rng(6));
      const dm = world.open("member", true);
      world.runUntil(world.now + 4_000);
      assert.ok(dm.audible());
      const tv = world.open("display", true);
      world.runUntil(world.now + 4_000);
      assert.ok(tv.audible() && !dm.audible(), "the display plays");
      // A locked screen freezes the window, and the freeze releases its lock (MUS-OPUS-76).
      world.freeze(tv);
      world.runUntil(world.now + LAPSE_MS + 4_000);
      assert.ok(dm.audible() && !tv.audible(), "the DM's page plays");
      world.thaw(tv);
      world.runUntil(world.now + 4_000);
      assert.ok(tv.audible() && !dm.audible(), "the display plays again");
      assert.deepEqual(world.failures, []);
    });
  }

  test("a frozen owner never keeps the lock (MUS-OPUS-76)", () => {
    const world = new World(true, rng(8));
    const a = world.open("member", true);
    world.runUntil(world.now + 2_000);
    const b = world.open("member", false);
    world.runUntil(world.now + 2_000);
    world.freeze(a);
    world.runUntil(world.now + 100);
    assert.ok(!a.holdsLock, "the freeze let the lock go");
    world.runUntil(world.now + LAPSE_MS + 1_000);
    assert.ok(b.audible() && b.holdsLock);
    assert.deepEqual(world.failures, []);
  });

  test("a crashed owner's lock passes on", () => {
    const world = new World(true, rng(9));
    const a = world.open("member", true);
    world.runUntil(world.now + 2_000);
    const b = world.open("member", false);
    world.runUntil(world.now + 2_000);
    world.crash(a);
    world.runUntil(world.now + LAPSE_MS + 2_000);
    assert.ok(b.audible());
    assert.deepEqual(world.failures, []);
  });

  test("without Web Locks an unarmed owner that crashed leaves the others quiet, never taking over by time", () => {
    const world = new World(false, rng(10));
    world.delay = 5;
    const a = world.open("member", true);
    world.runUntil(world.now + 4_000);
    // B hears A's post, and A crashes before it hears B, so its last post was unarmed.
    const tick = world.now + POST_MS - (world.now % POST_MS);
    world.runUntil(tick - 1);
    const b = world.open("member", true);
    world.runUntil(tick + 1);
    world.crash(a);
    world.runUntil(world.now + 40_000);
    assert.ok(!b.audible(), "B keeps A's claim");
    assert.deepEqual(world.failures, []);
  });
});
