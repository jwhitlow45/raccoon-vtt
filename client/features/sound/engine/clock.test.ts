import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FIRST_PROBES, PROBE_EVERY_MS, PROBE_GAP_MS, RTT_MAX_MS, SAMPLES_KEPT, ServerClock } from "./clock.ts";

/*
 * The time frames' epochs (docs/design/design-v1-music.md 5.1): five probes
 * 250 ms apart, then one every 25 s while sound plays, the shortest of the
 * epoch's last 8 round trips, nothing over a second, the store's offset
 * before the first answer, and a new epoch on a wake or a reconnect that
 * drops every earlier sample and every answer to an earlier epoch's probe.
 */

type Timer = { at: number; fn: () => void };

function world(fallback?: number | (() => number | undefined)) {
  const w = {
    now: 0,
    sent: [] as { k: number; at: number }[],
    timers: [] as Timer[],
    open: true,
  };
  const clock = new ServerClock({
    now: () => w.now,
    send: (k) => {
      if (!w.open) return false;
      w.sent.push({ k, at: w.now });
      return true;
    },
    setTimer: (ms, fn) => {
      const t = { at: w.now + ms, fn };
      w.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      w.timers = w.timers.filter((x) => x !== t);
    },
    fallback: () => (typeof fallback === "function" ? fallback() : fallback),
  });
  const run = (until: number) => {
    for (;;) {
      w.timers.sort((a, b) => a.at - b.at);
      const t = w.timers[0];
      if (!t || t.at > until) break;
      w.timers.shift();
      w.now = t.at;
      t.fn();
    }
    w.now = until;
  };
  return { w, clock, run };
}

describe("the server's time for sound", () => {
  test("sends five probes 250 ms apart, then one every 25 s, and none once stopped", () => {
    const { w, clock, run } = world();
    clock.start();
    run(PROBE_GAP_MS * (FIRST_PROBES - 1));
    assert.deepEqual(
      w.sent.map((s) => s.at),
      [0, 250, 500, 750, 1000],
    );
    run(1000 + PROBE_EVERY_MS);
    assert.equal(w.sent.length, FIRST_PROBES + 1);
    assert.equal(w.sent.at(-1)!.at, 1000 + PROBE_EVERY_MS);
    clock.stop();
    run(200_000);
    assert.equal(w.sent.length, FIRST_PROBES + 1);
  });

  test("uses the store's offset until the epoch's first answer, then the shortest round trip", () => {
    const { w, clock, run } = world(-80);
    clock.start();
    assert.equal(clock.offset(), -80);
    // The server's clock is 5000 ms ahead of this page's.
    const answer = (k: number, rtt: number) => {
      const sent = w.sent.find((s) => s.k === k)!;
      w.now = sent.at + rtt;
      clock.answer(k, sent.at + rtt / 2 + 5000);
    };
    answer(1, 120);
    assert.equal(clock.offset(), 5000);
    run(250);
    // A slow answer whose midpoint guess is off by 30 ms loses to the faster one.
    const sent = w.sent.find((s) => s.k === 2)!;
    w.now = sent.at + 400;
    clock.answer(2, sent.at + 230 + 5000);
    assert.equal(clock.offset(), 5000);
    run(500);
    answer(3, 40);
    assert.equal(clock.offset(), 5000);
    assert.ok(clock.measured);
  });

  test("drops an answer over a second, an unknown k and a k answered twice", () => {
    const { w, clock, run } = world(7);
    clock.start();
    w.now = RTT_MAX_MS + 1;
    clock.answer(1, 99_999);
    assert.equal(clock.offset(), 7);
    clock.answer(42, 99_999);
    assert.equal(clock.offset(), 7);
    run(w.now + PROBE_EVERY_MS);
    const last = w.sent.at(-1)!;
    w.now = last.at + 10;
    clock.answer(last.k, last.at + 5 + 300);
    clock.answer(last.k, last.at + 5 + 900);
    assert.equal(clock.offset(), 300);
  });

  test("keeps the best of the last 8 only", () => {
    const { w, clock, run } = world();
    clock.start();
    // The first answer is the fastest, then eight slower ones push it out.
    let k = 0;
    const answerNext = (rtt: number, skew: number) => {
      k++;
      const sent = w.sent.find((s) => s.k === k)!;
      w.now = Math.max(w.now, sent.at + rtt);
      clock.answer(k, sent.at + rtt / 2 + skew);
    };
    answerNext(10, 1000);
    for (let i = 0; i < SAMPLES_KEPT; i++) {
      run(w.now + (i < 4 ? PROBE_GAP_MS : PROBE_EVERY_MS));
      answerNext(50 + i, 2000);
    }
    assert.equal(clock.offset(), 2000);
  });

  test("a new epoch drops the old samples and answers to its probes, so after a long sleep a slower round trip is used", () => {
    const { w, clock, run } = world();
    clock.start();
    const first = w.sent[0]!;
    w.now = first.at + 20;
    clock.answer(first.k, first.at + 10 + 1000);
    assert.equal(clock.offset(), 1000);
    run(600);
    const before = w.sent.at(-1)!;
    // A long sleep: the page wakes, and the server's clock has moved 3 s on against this page's.
    w.now = 600_000;
    clock.restart();
    // The answer to a probe sent before the wake is from the old epoch.
    clock.answer(before.k, 0);
    assert.equal(clock.offset(), undefined, "nothing measured this epoch, and no fallback");
    const fresh = w.sent.at(-1)!;
    assert.ok(fresh.at === 600_000);
    w.now = fresh.at + 300;
    clock.answer(fresh.k, fresh.at + 150 + 4000);
    assert.equal(clock.offset(), 4000, "the slower fresh round trip, not the old best");
  });

  test("a wake keeps the last epoch's reading until its first answer while the store's offset agrees within a second, so the wake's forced check reads no network delay as drift", () => {
    let store = 4_960;
    const { w, clock: real } = world(() => store);
    real.start();
    assert.equal(real.offset(), 4_960, "the store's before any answer");
    const first = w.sent.at(-1)!;
    w.now = first.at + 20;
    real.answer(first.k, first.at + 10 + 5_000);
    assert.equal(real.offset(), 5_000);
    // Shown again: a new epoch, and the store's offset still one network delay, 40 ms, under the reading.
    w.now = 30_000;
    real.restart();
    assert.equal(real.offset(), 5_000, "the last reading, not the store's 40 ms off");
    const fresh = w.sent.at(-1)!;
    w.now = fresh.at + 30;
    real.answer(fresh.k, fresh.at + 15 + 5_012);
    assert.equal(real.offset(), 5_012, "the epoch's own first answer");
    // A sleep stopped this page's clock 3 s while the server's ran: the store's offset moved 3 s, so the old reading goes.
    w.now = 40_000;
    store = 7_970;
    real.restart();
    assert.equal(real.offset(), 7_970, "the store's after a sleep, not a reading 3 s behind");
  });

  test("a restart while stopped sends nothing", () => {
    const { w, clock } = world();
    clock.restart();
    assert.equal(w.sent.length, 0);
  });
});
