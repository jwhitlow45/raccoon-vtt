import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { idle, type IdleHost } from "./idle.ts";

/** idle(): the warm-up's wait for a quiet moment (docs/design-v1-roll-animation.md 6). */
describe("idle", () => {
  test("with no requestIdleCallback, as in Safari, it still calls back within its maxMs", async () => {
    const host: IdleHost = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
    for (const maxMs of [10, 200]) {
      const start = performance.now();
      const took = await new Promise<number>((done) => idle(() => done(performance.now() - start), maxMs, host));
      assert.ok(took <= maxMs + 25, `${maxMs} ms asked, ${took.toFixed(0)} ms taken`);
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

  test("a cancelled fallback never runs", async () => {
    let ran = false;
    const host: IdleHost = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
    idle(() => (ran = true), 5, host)();
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(ran, false);
  });
});
