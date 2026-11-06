import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { pick, rng } from "#shared/testutil.ts";
import { CLAIM_MS, LAPSE_MS, LEASE_MS, LISTEN_MS, POST_MS, TAKEOVER_MS } from "./handoff.ts";
import { randomRun, World, type Browser, type Release } from "./handoffSim.testutil.ts";

/*
 * One page plays per browser (docs/design/design-v1-music.md 4.4 and 12):
 * pages of one room in one browser appearing, locking, freezing, stalling,
 * showing, hiding, closing and crashing, their contexts interrupted and
 * recovering by themselves, with and without Web Locks, in the world of
 * handoffSim.testutil.ts, where a hidden page's timers wake as Chrome's,
 * Safari's or Firefox's throttling lets them, and a stall, which may start
 * between any two of a page's tasks, releases what waited in any order a
 * browser may run it.
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

  test("without Web Locks an owner that wakes from a stall gives way to a page that started meanwhile and is stalled itself, lapsed but unarmed", () => {
    const world = new World(false, rng(11));
    world.delay = 5;
    const a = world.open("member", true);
    world.runUntil(world.now + 4_000);
    assert.ok(a.audible() && !a.handoff.armed, "A plays alone, unarmed");
    // B loads while A's main thread stands still, so B never hears A: the one exception, B plays beside it.
    world.stall(a, 31_000);
    world.runUntil(world.now + 100);
    const b = world.open("member", true);
    world.runUntil(world.now + 4_000);
    assert.ok(b.audible(), "B plays, alone as far as it knows");
    // B stalls too, before A wakes. A then sees B's last post: it played, unarmed, and its claim outlives its entry.
    world.stall(b, 31_000);
    world.runUntil(world.now + 40_000);
    world.runUntil(world.now + 30_000);
    assert.equal([a, b].filter((p) => p.audible()).length, 1, "one page sounds once both run");
    assert.deepEqual(world.failures, []);
  });

  test("without Web Locks a page whose claim window ends in a stall hears the posts that waited before it plays, even when another timer runs first (seed 583274154)", () => {
    const world = new World(false, rng(12));
    world.delay = 5;
    const a = world.open("member", true);
    world.runUntil(world.now + 400);
    const b = world.open("member", false);
    // A's listen window ends at 2.5 s and its claim window runs to 2.9 s. B is shown then, so B outranks A, and A stalls before B's post reaches it.
    world.runUntil(world.now + 2_100);
    world.show(b, true);
    world.runUntil(world.now + 1);
    world.stall(a, 1_500);
    // B claims and plays meanwhile. The stall ends just after A's post timer was due, so that timer runs first and looks on time.
    world.runUntil(world.now + 3_000);
    assert.ok(b.audible() && !a.audible(), "B plays and A gives way");
    assert.deepEqual(world.failures, []);
  });

  test("without Web Locks a page whose claim window ends in a stall hears the posts that waited before it plays, even when an older post runs first", () => {
    const world = new World(false, rng(13));
    world.delay = 5;
    const t0 = world.now;
    const b = world.open("member", true);
    world.runUntil(t0 + 3_000);
    // A is shown last, so it outranks B, but B plays on as the owner.
    const a = world.open("member", true);
    world.runUntil(t0 + 4_000);
    world.show(b, false);
    // B turns its sound off and on: A starts its claim on B's release, and stalls before B's next post, eligible and outranked, reaches it.
    world.runUntil(t0 + 7_005);
    world.enable(b, false);
    world.runUntil(t0 + 7_006);
    world.enable(b, true);
    world.runUntil(t0 + 7_010);
    world.stall(a, 1_500);
    // B is shown meanwhile, so it outranks A and plays. A wakes before its post timer is due, so that older post from B runs first.
    world.runUntil(t0 + 7_100);
    world.show(b, true);
    world.runUntil(t0 + 11_000);
    assert.ok(b.audible() && !a.audible(), "B plays and A gives way");
    assert.deepEqual(world.failures, []);
  });

  test("without Web Locks a page opened hidden and alone starts, though Chrome wakes its timers only once a second", () => {
    const world = new World(false, rng(14), "chrome");
    world.phase = 300;
    const page = world.open("member", false);
    world.runUntil(world.now + LISTEN_MS + CLAIM_MS + 2_000);
    assert.ok(page.audible(), "the hidden page plays");
    assert.deepEqual(world.failures, []);
  });

  /** How long B, the only eligible page left, takes to sound once A, the playing tab, goes. */
  function takeover(browser: Browser, locks: boolean, end: "closes" | "crashes", hiddenFor: number, seed: number, shown: boolean): number {
    const world = new World(locks, rng(seed), browser);
    world.phase = (seed * 137) % 1_000;
    const a = world.open("member", true);
    world.runUntil(world.now + 3_000 + seed * 97);
    const b = world.open("member", shown);
    world.runUntil(world.now + hiddenFor + seed * 31);
    assert.ok(a.audible() && !b.audible(), "A plays and B waits");
    const t0 = world.now;
    if (end === "closes") world.close(a);
    else world.crash(a);
    while (!b.audible() && world.now < t0 + 120_000) world.runUntil(world.now + 50);
    assert.deepEqual(world.failures, []);
    return world.now - t0;
  }

  for (const browser of ["chrome", "safari"] as const) {
    for (const locks of [true, false]) {
      test(`the only eligible page left, hidden, takes the sound over within 2 s of a shown page's time once the playing tab closes or crashes (${browser}, ${locks ? "with" : "without"} Web Locks)`, () => {
        // Hidden 40 s, Chrome wakes its timers once a second. Hidden 10 minutes, a timer 5 deep in a chain once a minute, and Safari a timer 10 deep on a grid that has grown. Seeds 4 and 6 to 8 caught a decision timer set from the post timer's chain.
        for (const end of ["closes", "crashes"] as const) {
          for (const hiddenFor of [40_000, 600_000]) {
            for (let seed = 1; seed <= 8; seed++) {
              const shown = takeover(browser, locks, end, hiddenFor, seed, true);
              const hidden = takeover(browser, locks, end, hiddenFor, seed, false);
              assert.ok(hidden <= shown + 2_000, `A ${end} after ${hiddenFor / 1_000} s, seed ${seed}: hidden ${hidden} ms, shown ${shown} ms`);
            }
          }
        }
      });
    }
  }

  /**
   * MB-ASTRA-06: A, hidden, has its claim window run out at `windowEnd` and
   * stalls 1 s before what confirms its start runs. B, a display, turns its
   * sound on and plays meanwhile, and once the stall ends A's timers run
   * before the posts that waited. Chrome wakes A's timers only on whole
   * seconds, so there the window runs out later.
   */
  function confirmStalls(browser: Browser, release: Release, windowEnd: number): { failures: string[]; sounding: string[] } {
    const world = new World(false, () => 0.5, browser);
    world.delay = 5;
    world.release = release;
    const t0 = world.now;
    const a = world.open("member", false);
    const b = world.open("display", true);
    world.enable(b, false);
    world.runUntil(t0 + windowEnd - 300);
    world.later(a, 300, () => world.stall(a, 1_000));
    world.later(b, 400, () => world.enable(b, true));
    world.runUntil(t0 + windowEnd + 6_000);
    return { failures: world.failures, sounding: world.pages.filter((p) => p.audible()).map((p) => p.name) };
  }

  for (const [browser, windowEnd] of [["firefox", 2_900], ["safari", 2_900], ["chrome", 4_000]] as const) {
    test(`without Web Locks a hidden page whose start waits through a stall hears the posts that waited before it plays (MB-ASTRA-06, ${browser})`, () => {
      for (const release of ["timers", "ready", "posts", "creation"] as const) {
        const { failures, sounding } = confirmStalls(browser, release, windowEnd);
        assert.deepEqual(failures, [], `released ${release} first`);
        assert.deepEqual(sounding, ["p01"], `the display plays, released ${release} first`);
      }
    });
  }

  test("without Web Locks a page fading out for a display goes quiet at once when it hears another page plays (seed 1006099)", () => {
    const world = new World(false, rng(17));
    world.delay = 5;
    const t0 = world.now;
    const a = world.open("member", true);
    world.runUntil(t0 + 4_000);
    // A plays alone and stalls. B opens meanwhile and never hears A. A display opens and turns its sound off at once, so B plays.
    world.stall(a, 6_000);
    world.runUntil(t0 + 4_100);
    const b = world.open("member", false);
    world.runUntil(t0 + 6_000);
    const c = world.open("display", true);
    world.enable(c, false);
    world.runUntil(t0 + 9_900);
    assert.ok(a.audible() && b.audible() && !c.audible(), "A, stalled, and B play, each unheard by the other");
    // The display's sound comes on just before A runs again: B fades for it, and A, hearing the display's older post first, fades too.
    world.enable(c, true);
    world.runUntil(t0 + 20_000);
    assert.deepEqual(world.failures, []);
    assert.deepEqual(world.pages.filter((p) => p.audible()), [c], "the display plays");
  });

  test("without Web Locks a page whose claim window runs out waits for its own post to come back, with no timer meanwhile", () => {
    const world = new World(false, rng(15));
    world.delay = 15;
    const t0 = world.now;
    const page = world.open("member", true);
    world.runUntil(t0 + LISTEN_MS + CLAIM_MS);
    assert.ok(!page.audible(), "the window has just run out");
    const timers = world.tasks.filter((t) => t.page === page.id && t.timer && t.at < world.now + 15);
    assert.deepEqual(timers, [], "no timer runs before the post comes back");
    world.runUntil(world.now + 15);
    assert.ok(page.audible(), "its post came back, so it plays");
    assert.deepEqual(world.failures, []);
  });

  test("without a channel that hears its own posts a lone page still starts, hidden and shown", () => {
    for (const shown of [false, true]) {
      const world = new World(false, rng(16), "chrome");
      world.echo = false;
      const page = world.open("member", shown);
      world.runUntil(world.now + LISTEN_MS + CLAIM_MS + 2_000);
      assert.ok(page.audible(), shown ? "shown" : "hidden");
      assert.deepEqual(world.failures, []);
    }
  });

  test("random runs that once broke an invariant without Web Locks keep them all", () => {
    // Seeds of randomRun in this world, so a change to the world reshuffles them. Each failed once a rule went: 153980 a post that waited, late, counts as a stall. 4265, 10509 and 13252 a start by time waits for a post on time. 1761, 6601 and 6984 with none at hand that is the page's own post come back, not a 0 ms timer (MB-ASTRA-06). 2270 and 4742 its own post counts only on time.
    for (const seed of [153980, 4265, 10509, 13252, 1761, 6601, 6984, 2270, 4742]) {
      assert.deepEqual(randomRun(seed, false), [], `seed ${seed}`);
    }
  });
});
