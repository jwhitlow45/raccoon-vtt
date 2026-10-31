import assert from "node:assert/strict";
import { test } from "node:test";
import { RollPress, attachConsumedTouch, type RollPressClock } from "./rollPress.ts";

export function probe() {
  let now = 0, seq = 0, opens = 0, open = false, hint = false;
  const timers = new Map<number, { at: number; run(): void }>();
  const clock: RollPressClock = { set(run, ms) { const id = ++seq; timers.set(id, { at: now + ms, run }); return id; }, clear(id) { timers.delete(id as number); } };
  const press = new RollPress({ clock, open: () => open, show: () => { opens++; open = true; }, close: () => { open = false; }, hint: (on) => { hint = on; } });
  return { press, timers, get opens() { return opens; }, get open() { return open; }, get hint() { return hint; }, tick(ms: number) {
    const end = now + ms;
    while (true) { const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; timers.delete(next[0]); next[1].run(); }
    now = end;
  } };
}
const point = (x = 0) => ({ id: 1, x, y: 0 });
test("499ms tap, 200ms hint, 500ms hold, and no selection on its release", () => {
  const p = probe(); p.press.down(point(), "touch"); p.tick(199); assert.equal(p.hint, false); p.tick(1); assert.equal(p.hint, true);
  p.tick(299); p.press.up(1); assert.equal(p.opens, 0); assert.equal(p.press.click(1), true);
  p.press.down(point(), "touch"); p.tick(500); assert.equal(p.opens, 1); assert.equal(p.hint, false); p.press.up(1);
  assert.equal(p.press.click(1, false), false); assert.equal(p.press.click(0, false), true); assert.equal(p.timers.size, 0);
});
test("8px boundary, permanent cancellation, second pointer and terminal cleanup", () => {
  const p = probe(); p.press.down(point(), "touch"); p.press.move(point(8)); p.tick(500); assert.equal(p.opens, 1);
  for (const stop of [(p: RollPress) => p.move(point(8.01)), (p: RollPress) => p.cancel(), (p: RollPress) => p.down({ id: 2, x: 0, y: 0 }, "touch", false)]) {
    const q = probe(); q.press.down(point(), "touch"); stop(q.press); q.press.move(point()); q.tick(1000);
    assert.equal(q.opens, 0); assert.equal(q.press.click(1), false); assert.equal(q.timers.size, 0); assert.equal(q.hint, false);
    q.press.context("touch"); assert.equal(q.opens, 0);
  }
});
test("native touch context menu deduplicates, late events do nothing, mouse holds never open", () => {
  const p = probe(); p.press.down(point(), "touch"); p.press.context("touch"); p.tick(1000); p.press.context("touch"); assert.equal(p.opens, 1); assert.equal(p.open, true);
  p.press.up(1); p.press.context("touch"); assert.equal(p.opens, 1);
  const m = probe(); m.press.down(point(), "mouse"); m.tick(2000); assert.equal(m.opens, 0); m.press.context("mouse"); assert.equal(m.opens, 1);
});
test("source dismissal never rolls, a fresh menu tap and a later key remain usable", () => {
  const p = probe(); p.press.context("key"); p.press.down(point(), "touch"); assert.equal(p.open, false); p.tick(1000); p.press.up(1); assert.equal(p.press.click(1), false);
  p.press.key(); assert.equal(p.press.click(0), true);
  p.press.down(point(), "touch"); p.tick(500); p.press.up(1); p.press.fresh(); assert.equal(p.press.click(1, false), true);
  p.press.dispose(); p.tick(1000); assert.equal(p.timers.size, 0); assert.equal(p.press.click(0), false);
});
test("non-passive touchmove is attached before hold, inert until consumed, scoped and removed", () => {
  const listeners = new Map<string, EventListener>(); const attached: [string, unknown][] = [];
  const target = { addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: unknown) { listeners.set(type, listener as EventListener); attached.push([type, options]); }, removeEventListener(type: string) { listeners.delete(type); } };
  let consumed = false, prevented = 0;
  const stop = attachConsumedTouch(target, () => consumed);
  assert.deepEqual(attached[1], ["touchmove", { capture: true, passive: false }]);
  const event = (id: number) => ({ changedTouches: [{ identifier: id }], cancelable: true, preventDefault() { prevented++; } }) as unknown as Event;
  listeners.get("touchstart")!(event(7)); listeners.get("touchmove")!(event(7)); assert.equal(prevented, 0);
  consumed = true; listeners.get("touchmove")!(event(8)); assert.equal(prevented, 0); listeners.get("touchmove")!(event(7)); assert.equal(prevented, 1);
  stop(); assert.equal(listeners.size, 0);
});

test("a reader click after a held release clears suppression without a pointerdown", () => {
  const p = probe(); p.press.down(point(), "touch"); p.tick(500); p.press.up(1);
  assert.equal(p.press.click(0, false), true);
  assert.equal(p.press.click(1, false), true);
});

test("a containing scroll cancels a touch hold without swallowing mouse or released taps", () => {
  const mouse = probe(); mouse.press.down(point(), "mouse"); mouse.press.cancel();
  assert.equal(mouse.press.click(1), true, "scroll anchoring during a mouse press cannot swallow its click");
  const tap = probe(); tap.press.down(point(), "touch"); tap.tick(100); tap.press.up(1); tap.press.cancel();
  assert.equal(tap.press.click(1), true, "a scroll after touchup cannot turn a short tap into a held press");
  for (const elapsed of [0, 199, 200, 499, 500]) {
    const touch = probe(); touch.press.down(point(), "touch"); touch.tick(elapsed); touch.press.cancel(); touch.tick(1000);
    assert.equal(touch.opens, elapsed === 500 ? 1 : 0);
    assert.equal(touch.press.click(1), false, "an eligible or fired touch press consumes its trailing click");
    assert.equal(touch.press.click(1, false), true, "only that touch click is consumed");
    assert.equal(touch.timers.size, 0);
    assert.equal(touch.hint, false);
  }
  const close = probe(); close.press.context("key"); close.press.down(point(), "mouse"); close.press.cancel();
  assert.equal(close.press.click(1), false, "cancellation does not erase source dismissal suppression");
});
