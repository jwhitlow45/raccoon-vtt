import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { idle, type IdleHost } from "./idle.ts";

/** idle(): the warm-up's wait for a quiet moment (docs/design/design-v1-roll-animation.md 6). */
describe("idle", () => {
  /** A host whose timers run only when the test fires them, so no wall time is involved. */
  function fakeTimers() {
    const timers = new Map<number, { cb: () => void; ms: number }>();
    let next = 1;
    const host: IdleHost = {
      setTimeout: (cb, ms) => { timers.set(next, { cb, ms }); return next++; },
      clearTimeout: (id) => void timers.delete(id as number),
    };
    return { host, timers };
  }

  test("with no requestIdleCallback, as in Safari, it still calls back within its maxMs", () => {
    for (const maxMs of [10, 200]) {
      const { host, timers } = fakeTimers();
      let ran = 0;
      idle(() => ran++, maxMs, host);
      assert.equal(timers.size, 1);
      const [timer] = [...timers.values()];
      assert.ok(timer!.ms <= maxMs, `${maxMs} ms asked, a ${timer!.ms} ms timer set`);
      timer!.cb();
      assert.equal(ran, 1);
    }
  });

  test("it passes maxMs as the idle callback's timeout where there is one, and a cancel stops it", () => {
    const asked: number[] = [];
    let cancelled = 0;
    const host: IdleHost = {
      requestIdleCallback: (_cb, options) => asked.push(options.timeout),
      cancelIdleCallback: () => cancelled++,
      setTimeout: () => assert.fail("no timer where idle callbacks exist"),
      clearTimeout: () => undefined,
    };
    const cancel = idle(() => assert.fail("not run"), 300, host);
    assert.deepEqual(asked, [300]);
    cancel();
    assert.equal(cancelled, 1);
  });

  test("a cancelled fallback never runs", () => {
    const { host, timers } = fakeTimers();
    let ran = false;
    idle(() => (ran = true), 5, host)();
    assert.equal(timers.size, 0, "the timer is cleared");
    assert.equal(ran, false);
  });
});
