import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { FakeClock } from "../state/testing.ts";
import type { TipEvent } from "./Tooltip.tsx";

const { FOCUS_MS, HOVER_MS, KEEP_MS, PRESS_MS, TipTimer, placeTip } = await import("./Tooltip.tsx");

/** The tooltip's rules (docs/design-v1-icons.md 3.2), on a fake clock and with plain boxes for the DOM. */

function timer() {
  const clock = new FakeClock();
  const changes: boolean[] = [];
  const tip = new TipTimer({ set: (run, ms) => clock.setTimeout(run, ms), clear: (h) => clock.clearTimeout(h) }, (shown) => changes.push(shown));
  return { clock, tip, changes };
}

describe("when a tooltip shows (docs/design-v1-icons.md 3.2)", () => {
  test("a mouse hover waits 500 ms, and a quick pass along a row shows nothing", () => {
    const { clock, tip, changes } = timer();
    tip.send({ t: "enter", pointer: "mouse" });
    clock.advance(HOVER_MS - 1);
    tip.send({ t: "leave" });
    clock.advance(2000);
    assert.deepEqual(changes, [], "passing over shows nothing");
    tip.send({ t: "enter", pointer: "mouse" });
    clock.advance(HOVER_MS);
    assert.equal(tip.shown, true);
    tip.send({ t: "leave" });
    assert.equal(tip.shown, false, "leaving closes it at once");
  });

  test("keyboard focus shows it after 150 ms, and focus by a mouse or a finger never does", () => {
    const { clock, tip } = timer();
    tip.send({ t: "focus", visible: false });
    clock.advance(2000);
    assert.equal(tip.shown, false);
    tip.send({ t: "focus", visible: true });
    clock.advance(FOCUS_MS);
    assert.equal(tip.shown, true);
    tip.send({ t: "blur" });
    assert.equal(tip.shown, false);
  });

  test("a held finger shows it after 500 ms and keeps it 1.5 s after lifting. A tap shows nothing", () => {
    const { clock, tip, changes } = timer();
    tip.send({ t: "enter", pointer: "touch" });
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(100);
    tip.send({ t: "up" });
    clock.advance(3000);
    assert.deepEqual(changes, [], "a tap is a tap");
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS);
    assert.equal(tip.shown, true);
    tip.send({ t: "up" });
    clock.advance(KEEP_MS - 1);
    assert.equal(tip.shown, true, "still up to be read");
    clock.advance(1);
    assert.equal(tip.shown, false);
  });

  test("Escape, a scroll and a mouse press close it", () => {
    for (const close of [{ t: "escape" }, { t: "scroll" }, { t: "down", pointer: "mouse" }] as TipEvent[]) {
      const { clock, tip } = timer();
      tip.send({ t: "enter", pointer: "mouse" });
      clock.advance(HOVER_MS);
      assert.equal(tip.shown, true);
      tip.send(close);
      assert.equal(tip.shown, false, close.t);
      clock.advance(5000);
      assert.equal(tip.shown, false, `${close.t} leaves nothing pending`);
    }
  });

  test("randomized: it shows only a full delay after what armed it, with nothing closing it between, and one timer at most waits", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const { clock, tip } = timer();
      // The reference: when the newest arming event came and how long it asks, cleared by any event that closes.
      let armed: { at: number; ms: number } | null = null;
      let keepUntil: number | null = null;
      const shownAt: number[] = [];
      for (let step = 0; step < 60; step++) {
        const e: TipEvent = pick(r, [
          { t: "enter", pointer: pick(r, ["mouse", "touch", "pen"]) },
          { t: "leave" },
          { t: "down", pointer: pick(r, ["mouse", "touch"]) },
          { t: "up" },
          { t: "focus", visible: chance(r, 0.5) },
          { t: "blur" },
          { t: "escape" },
          { t: "scroll" },
        ] satisfies TipEvent[]);
        const was = tip.shown;
        tip.send(e);
        if ((e.t === "enter" && e.pointer === "mouse") || (e.t === "down" && e.pointer === "touch")) {
          armed = { at: clock.t, ms: e.t === "enter" ? HOVER_MS : PRESS_MS };
          keepUntil = null;
        } else if (e.t === "focus") {
          if (e.visible) {
            armed = { at: clock.t, ms: FOCUS_MS };
            keepUntil = null;
          }
        } else if (e.t === "up") {
          armed = null;
          keepUntil = was ? clock.t + KEEP_MS : null;
        } else if (e.t !== "enter") {
          armed = null;
          keepUntil = null;
          assert.equal(tip.shown, false, `seed ${seed}: ${e.t} closes it at once`);
        }
        assert.ok(clock.pendingTimers <= 1, `seed ${seed}: one timer at most`);
        const wait = int(r, 0, 700);
        const before = tip.shown;
        clock.advance(wait);
        if (!before && tip.shown) {
          assert.ok(armed && clock.t - armed.at >= armed.ms, `seed ${seed}: shown only a full delay after it was armed`);
          shownAt.push(clock.t);
        }
        if (armed && clock.t - armed.at >= armed.ms) {
          assert.equal(tip.shown, true, `seed ${seed}: shown once its delay passed`);
          armed = null;
        }
        if (keepUntil !== null && clock.t >= keepUntil) {
          assert.equal(tip.shown, false, `seed ${seed}: a long press's name goes 1.5 s after the finger lifts`);
          keepUntil = null;
        }
      }
      tip.dispose();
      assert.equal(clock.pendingTimers, 0, `seed ${seed}: nothing waits once the control is gone`);
    }
  });
});

describe("where a tooltip goes (docs/design-v1-icons.md 3.2)", () => {
  test("above with a 6 px gap where there is room, centered on its control", () => {
    assert.deepEqual(placeTip({ top: 200, left: 100, width: 44, height: 44 }, { width: 80, height: 24 }, { width: 390 }), { top: 170, left: 82 });
  });

  test("below where the screen's top leaves no room, and kept 8 px inside the window's sides", () => {
    assert.deepEqual(placeTip({ top: 10, left: 0, width: 44, height: 44 }, { width: 120, height: 24 }, { width: 390 }), { top: 60, left: 8 });
    assert.equal(placeTip({ top: 300, left: 360, width: 44, height: 44 }, { width: 120, height: 24 }, { width: 390 }).left, 390 - 8 - 120);
  });

  test("randomized: it never covers its control", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const view = { width: int(r, 320, 1600) };
      const anchor = { top: int(r, 0, 900), left: int(r, 0, view.width - 44), width: int(r, 24, 200), height: int(r, 24, 60) };
      const tip = { width: int(r, 40, 240), height: int(r, 18, 80) };
      const at = placeTip(anchor, tip, view);
      const overlaps = at.top < anchor.top + anchor.height && at.top + tip.height > anchor.top && at.left < anchor.left + anchor.width && at.left + tip.width > anchor.left;
      assert.equal(overlaps, false, JSON.stringify({ anchor, tip, at }));
      assert.ok(at.left >= 8, "never past the left edge");
    }
  });
});
