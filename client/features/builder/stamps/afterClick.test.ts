import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { afterTapClick, CLICK_WAIT_MS, type ClickWait } from "./afterClick.ts";

/** A page whose clicks and timers run by hand. */
function fakePage() {
  let listeners: (() => void)[] = [];
  let timers: { fn: () => void; ms: number }[] = [];
  const wait: ClickWait = {
    onNextClick(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    later(fn, ms) {
      const t = { fn, ms };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
  };
  return {
    wait,
    click: () => {
      for (const l of [...listeners]) l();
    },
    /** Runs every timer due by `ms`. */
    tick: (ms: number) => {
      const due = timers.filter((t) => t.ms <= ms);
      timers = timers.filter((t) => t.ms > ms);
      for (const t of due) t.fn();
    },
    waiting: () => listeners.length + timers.length,
  };
}

describe("waiting out a tap's click", () => {
  test("runs just after the tap's click has been handled, once, and stops waiting", () => {
    const page = fakePage();
    let runs = 0;
    afterTapClick(() => runs++, page.wait);
    assert.equal(runs, 0);
    page.click();
    assert.equal(runs, 0, "ran inside the click");
    page.tick(0);
    assert.equal(runs, 1);
    page.click();
    page.tick(Infinity);
    assert.equal(runs, 1);
    assert.equal(page.waiting(), 0);
  });

  test("runs anyway when no click comes, and a late click changes nothing", () => {
    const page = fakePage();
    let runs = 0;
    afterTapClick(() => runs++, page.wait);
    page.tick(CLICK_WAIT_MS - 1);
    assert.equal(runs, 0);
    page.tick(CLICK_WAIT_MS);
    assert.equal(runs, 1);
    page.click();
    page.tick(Infinity);
    assert.equal(runs, 1);
    assert.equal(page.waiting(), 0);
  });

  test("called off, it never runs", () => {
    const page = fakePage();
    let runs = 0;
    const off = afterTapClick(() => runs++, page.wait);
    page.click();
    off();
    page.tick(Infinity);
    assert.equal(runs, 0);
    assert.equal(page.waiting(), 0);
  });
});
