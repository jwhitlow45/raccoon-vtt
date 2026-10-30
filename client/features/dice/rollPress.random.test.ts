import assert from "node:assert/strict";
import { test } from "node:test";
import { rng, int } from "#shared/testutil.ts";
import { RollPress, attachConsumedTouch } from "./rollPress.ts";

test("seeded gesture sequences: single opening, no cancelled hold or release selection, terminal cleanup and usable later keys", () => {
  const coverage = new Set<number>();
  for (let seed = 1; seed <= 120; seed++) {
    const random = rng(seed); let now = 0, serial = 0, open = false, opens = 0, hint = false;
    const timers = new Map<number, { at: number; run(): void }>();
    const listeners = new Set<string>();
    const target = { addEventListener(type: string) { listeners.add(type); }, removeEventListener(type: string) { listeners.delete(type); } };
    let detach: (() => void) | null = null;
    const press = new RollPress({ releaseTouch: () => { detach?.(); detach = null; }, open: () => open, show: () => { open = true; opens++; }, close: () => { open = false; }, hint: (on) => { hint = on; }, clock: { set(run, ms) { const id = ++serial; timers.set(id, { at: now + ms, run }); return id; }, clear(id) { timers.delete(id as number); } } });
    const advance = (ms: number) => { const end = now + ms; while (true) { const next = [...timers].sort((a,b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; timers.delete(next[0]); next[1].run(); } now = end; };
    for (let gesture = 0; gesture < 100; gesture++) {
      open = false; press.fresh(); const before = opens;
      press.down({ id: 1, x: 0, y: 0 }, "touch");
      detach = attachConsumedTouch(target, () => press.consumed);
      let cancelled = false;
      for (let step = 0; step < 8; step++) {
        const event = int(random, 0, 6); coverage.add(event);
        const already = opens > before;
        if (event === 0) advance(int(random, 0, 550));
        if (event === 1) { const x = int(random, 0, 12); press.move({ id: 1, x, y: 0 }); if (x > 8 && !already) cancelled = true; }
        if (event === 2) { press.cancel(); cancelled = true; }
        if (event === 3) { press.down({ id: 2, x: 0, y: 0 }, "touch", false); cancelled = true; }
        if (event === 4) press.context("touch");
        if (event === 5) advance(200);
        if (event === 6) { press.up(1); cancelled = true; }
        assert.ok(opens - before <= 1, `one menu per press, seed ${seed}`);
        if (cancelled && !already) assert.equal(opens, before, `no opening after cancellation, seed ${seed}`);
        if (press.activeId === null) { assert.equal(timers.size, 0); assert.equal(hint, false); assert.equal(press.consumed, false); assert.equal(listeners.size, 0, "no consumed-touch listener after a terminal event"); }
      }
      const held = opens > before;
      press.up(1); assert.equal(timers.size, 0); assert.equal(hint, false);
      if (held) assert.equal(press.click(1, false), false, "held release cannot select a row");
      press.key(); assert.equal(press.click(0, false), true, "no later keyboard click swallowed");
    }
    press.dispose(); advance(2000); assert.equal(timers.size, 0); assert.equal(press.click(0), false);
  }
  assert.equal(coverage.size, 7);
});
