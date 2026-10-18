import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { FakeClock } from "../state/testing.ts";
import type { TipClick, TipEvent } from "./Tooltip.tsx";

const { FOCUS_MS, HOVER_MS, KEEP_MS, PRESS_MS, TipStage, TipTimer, addsWords, placeTip, placeTipZoomed, tipMaxWidth } = await import("./Tooltip.tsx");

/** The tooltip's rules (docs/design-v1-icons.md 3.2), on a fake clock and with plain boxes for the DOM. */

// Clicks as browsers send them: a finger's lift, Enter or Space (`detail` 0), a screen reader's (no pointer named), a mouse's, and Safari's, which names no pointer at all.
const FINGER: TipClick = { detail: 1, pointerType: "touch" };
const KEYBOARD: TipClick = { detail: 0, pointerType: "" };
const READER: TipClick = { detail: 1, pointerType: "" };
const MOUSE: TipClick = { detail: 1, pointerType: "mouse" };
const UNNAMED: TipClick = { detail: 1 };

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
    tip.send({ t: "leave", pointer: "mouse" });
    clock.advance(2000);
    assert.deepEqual(changes, [], "passing over shows nothing");
    tip.send({ t: "enter", pointer: "mouse" });
    clock.advance(HOVER_MS);
    assert.equal(tip.shown, true);
    tip.send({ t: "leave", pointer: "mouse" });
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

  test("a held finger shows it after 500 ms and keeps it 1.5 s after lifting, through the leave a lift sends. A tap shows nothing", () => {
    const { clock, tip, changes } = timer();
    // A touch's events in the order browsers send them (Pointer Events): enter, down, up, then leave at once.
    tip.send({ t: "enter", pointer: "touch" });
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(100);
    tip.send({ t: "up" });
    tip.send({ t: "leave", pointer: "touch" });
    clock.advance(3000);
    assert.deepEqual(changes, [], "a tap is a tap");
    assert.equal(tip.takeClick(FINGER), false, "a tap's click reaches the control");
    tip.send({ t: "enter", pointer: "touch" });
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS);
    assert.equal(tip.shown, true);
    tip.send({ t: "up" });
    tip.send({ t: "leave", pointer: "touch" });
    clock.advance(KEEP_MS - 1);
    assert.equal(tip.shown, true, "still up to be read");
    clock.advance(1);
    assert.equal(tip.shown, false);
  });

  test("a pen's lift keeps it too, and a mouse leaving closes it at once", () => {
    const { clock, tip } = timer();
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS);
    tip.send({ t: "up" });
    tip.send({ t: "leave", pointer: "pen" });
    assert.equal(tip.shown, true);
    tip.send({ t: "leave", pointer: "mouse" });
    assert.equal(tip.shown, false);
  });

  test("the click a long press's lift makes is the name's, once, and never a tap's or a cancelled press's", () => {
    const { clock, tip } = timer();
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS);
    tip.send({ t: "up" });
    assert.equal(tip.takeClick(FINGER), true, "the long press's click is swallowed");
    assert.equal(tip.takeClick(FINGER), false, "only that once");
    // A press the browser cancels for a scroll closes the name and keeps nothing for a later click.
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS);
    tip.send({ t: "cancel" });
    assert.equal(tip.shown, false);
    assert.equal(tip.takeClick(FINGER), false);
    // A long press whose click never came (Android's context menu) does not eat the next tap's.
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS);
    tip.send({ t: "up" });
    tip.send({ t: "down", pointer: "touch" });
    clock.advance(100);
    tip.send({ t: "up" });
    assert.equal(tip.takeClick(FINGER), false);
    // A mouse held as long is a click as usual.
    tip.send({ t: "enter", pointer: "mouse" });
    clock.advance(HOVER_MS);
    tip.send({ t: "down", pointer: "mouse" });
    clock.advance(PRESS_MS);
    tip.send({ t: "up" });
    assert.equal(tip.takeClick(FINGER), false);
  });

  test("a long press whose click never came takes no later click: a keyboard's or a reader's runs the control at once, and any once the name has gone", () => {
    const hold = () => {
      const t = timer();
      t.tip.send({ t: "enter", pointer: "touch" });
      t.tip.send({ t: "down", pointer: "touch" });
      t.clock.advance(PRESS_MS);
      t.tip.send({ t: "up" });
      t.tip.send({ t: "leave", pointer: "touch" });
      assert.equal(t.tip.shown, true);
      return t;
    };
    {
      // Android's context menu ate the click. Then Enter, then a screen reader's click, each runs the control.
      const { tip } = hold();
      assert.equal(tip.takeClick(KEYBOARD), false, "Enter or Space runs the control");
      assert.equal(tip.takeClick(READER), false, "and so does a screen reader's click");
    }
    {
      const { tip } = hold();
      assert.equal(tip.takeClick(READER), false, "a screen reader's click, while the name is still up, runs the control");
    }
    {
      const { tip } = hold();
      assert.equal(tip.takeClick(MOUSE), false, "a mouse's click runs the control");
    }
    {
      const { tip } = hold();
      assert.equal(tip.takeClick(UNNAMED), true, "where the browser names no pointer, the hold's lift is still taken");
    }
    {
      const { clock, tip } = hold();
      clock.advance(KEEP_MS);
      assert.equal(tip.shown, false);
      assert.equal(tip.takeClick(UNNAMED), false, "once the name has gone, nothing is taken");
    }
    for (const e of [{ t: "key" }, { t: "blur" }, { t: "focus", visible: true }, { t: "escape" }, { t: "scroll" }] as TipEvent[]) {
      const { tip } = hold();
      tip.send(e);
      assert.equal(tip.takeClick(UNNAMED), false, `after ${e.t}, a click runs the control`);
    }
    {
      // A finger's own focus comes between its lift and its click, and is no reason to let the click through.
      const { tip } = hold();
      tip.send({ t: "focus", visible: false });
      assert.equal(tip.takeClick(FINGER), true);
    }
  });

  test("randomized: a click is taken only from a finger, a pen or an unnamed pointer, never Enter or Space, only while the name is up, and once a press", () => {
    let takes = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const { clock, tip } = timer();
      let takenThisPress = false;
      // A browser clicks only once no finger is down.
      let pressing = false;
      for (let step = 0; step < 80; step++) {
        if (!pressing && chance(r, 0.2)) {
          // A whole long press as a browser sends it, so lifts that showed the name come often.
          tip.send({ t: "down", pointer: "touch" });
          takenThisPress = false;
          clock.advance(PRESS_MS + int(r, 0, 300));
          tip.send({ t: "up" });
          tip.send({ t: "leave", pointer: "touch" });
        } else if (!pressing && chance(r, 0.4)) {
          const click = pick(r, [FINGER, KEYBOARD, READER, MOUSE, UNNAMED, { detail: 1, pointerType: "pen" }]);
          const shown = tip.shown;
          const taken = tip.takeClick(click);
          if (taken) {
            assert.notEqual(click.detail, 0, `seed ${seed}: never a keyboard's click`);
            assert.ok(click.pointerType === undefined || click.pointerType === "touch" || click.pointerType === "pen", `seed ${seed}: never a ${click.pointerType || "reader"}'s click`);
            assert.ok(shown, `seed ${seed}: only while the name is up`);
            assert.equal(takenThisPress, false, `seed ${seed}: once a press`);
            takenThisPress = true;
            takes++;
          }
        } else {
          const e: TipEvent = pick(r, [
            { t: "enter", pointer: pick(r, ["mouse", "touch"]) },
            { t: "leave", pointer: pick(r, ["mouse", "touch"]) },
            { t: "down", pointer: pick(r, ["mouse", "touch"]) },
            { t: "up" },
            { t: "cancel" },
            { t: "focus", visible: chance(r, 0.5) },
            { t: "blur" },
            { t: "key" },
            { t: "escape" },
            { t: "scroll" },
          ] satisfies TipEvent[]);
          tip.send(e);
          if (e.t === "down") takenThisPress = false;
          if (e.t === "down" || e.t === "up" || e.t === "cancel") pressing = e.t === "down" && e.pointer === "touch";
        }
        clock.advance(chance(r, 0.5) ? 0 : int(r, 0, 900));
      }
      tip.dispose();
    }
    assert.ok(takes > 50, `the run reaches a held lift's click often enough to mean something: ${takes}`);
  });

  test("Escape, a scroll, a cancelled pointer and a mouse press close it", () => {
    for (const close of [{ t: "escape" }, { t: "scroll" }, { t: "cancel" }, { t: "down", pointer: "mouse" }] as TipEvent[]) {
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
          { t: "leave", pointer: pick(r, ["mouse", "touch", "pen"]) },
          { t: "down", pointer: pick(r, ["mouse", "touch"]) },
          { t: "up" },
          { t: "cancel" },
          { t: "focus", visible: chance(r, 0.5) },
          { t: "blur" },
          { t: "key" },
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
        } else if ((e.t === "leave" && e.pointer !== "mouse") || e.t === "key") {
          // A finger's or pen's leave comes with its lift, and a key only stops a hold taking a click: neither changes what shows.
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

describe("one tooltip at a time", () => {
  /** Tips of one page on one clock, as useTooltip makes them. */
  function page(count: number) {
    const clock = new FakeClock();
    const stage = new TipStage();
    const tips = Array.from({ length: count }, () => new TipTimer({ set: (run, ms) => clock.setTimeout(run, ms), clear: (h) => clock.clearTimeout(h) }, () => undefined, stage));
    return { clock, tips };
  }

  test("a long press on the next icon 300 ms after the first closes the first's name as its own shows", () => {
    const { clock, tips } = page(2);
    const [find, fit] = tips as [InstanceType<typeof TipTimer>, InstanceType<typeof TipTimer>];
    find.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS + 50);
    find.send({ t: "up" });
    clock.advance(300);
    fit.send({ t: "down", pointer: "touch" });
    clock.advance(PRESS_MS - 1);
    assert.deepEqual([find.shown, fit.shown], [true, false], "the first keeps its 1.5 s until the next shows");
    clock.advance(1);
    assert.deepEqual([find.shown, fit.shown], [false, true]);
    fit.send({ t: "up" });
    clock.advance(KEEP_MS);
    assert.deepEqual([find.shown, fit.shown], [false, false], "nothing waits to bring the first back");
  });

  test("a hover over another tool closes the name keyboard focus showed", () => {
    const { clock, tips } = page(2);
    const [ruler, fog] = tips as [InstanceType<typeof TipTimer>, InstanceType<typeof TipTimer>];
    ruler.send({ t: "focus", visible: true });
    clock.advance(FOCUS_MS);
    fog.send({ t: "enter", pointer: "mouse" });
    clock.advance(HOVER_MS);
    assert.deepEqual([ruler.shown, fog.shown], [false, true]);
    // Focus coming back shows it again, and closes the hover's.
    ruler.send({ t: "focus", visible: true });
    clock.advance(FOCUS_MS);
    assert.deepEqual([ruler.shown, fog.shown], [true, false]);
  });

  test("a control that goes while its name shows leaves the page free for the next", () => {
    const { clock, tips } = page(2);
    const [gone, next] = tips as [InstanceType<typeof TipTimer>, InstanceType<typeof TipTimer>];
    gone.send({ t: "focus", visible: true });
    clock.advance(FOCUS_MS);
    gone.dispose();
    next.send({ t: "enter", pointer: "mouse" });
    clock.advance(HOVER_MS);
    assert.equal(next.shown, true);
  });

  test("randomized: whatever reaches four icons and when, at most one name shows, and the one showing is the newest to show", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const { clock, tips } = page(4);
      let newest: InstanceType<typeof TipTimer> | null = null;
      const shownBefore = new Set<InstanceType<typeof TipTimer>>();
      for (let step = 0; step < 80; step++) {
        const tip = pick(r, tips);
        tip.send(
          pick(r, [
            { t: "enter", pointer: pick(r, ["mouse", "touch"]) },
            { t: "leave", pointer: pick(r, ["mouse", "touch"]) },
            { t: "down", pointer: pick(r, ["mouse", "touch"]) },
            { t: "up" },
            { t: "cancel" },
            { t: "focus", visible: chance(r, 0.7) },
            { t: "blur" },
            { t: "escape" },
          ] satisfies TipEvent[]),
        );
        for (let ms = int(r, 0, 900); ms > 0; ms -= 50) {
          clock.advance(Math.min(50, ms));
          for (const t of tips) {
            if (t.shown && !shownBefore.has(t)) newest = t;
          }
          shownBefore.clear();
          for (const t of tips) if (t.shown) shownBefore.add(t);
          const up = tips.filter((t) => t.shown);
          assert.ok(up.length <= 1, `seed ${seed}: ${up.length} names show at once`);
          if (up.length === 1) assert.equal(up[0], newest, `seed ${seed}: an older name shows over the newest`);
        }
      }
    }
  });
});

describe("whether a tooltip describes its control", () => {
  test("only words its name lacks are read as a description", () => {
    assert.equal(addsWords("Roll again", "Roll again: 1d20+5 Stealth"), false, "said already in the name");
    assert.equal(addsWords("Hide panels", "Hide panels"), false);
    assert.equal(addsWords("Show this roll in Recent rolls", "Show roll"), true);
    assert.equal(addsWords(undefined, "Delete"), false);
    assert.equal(addsWords("", "Delete"), false);
    assert.equal(addsWords("Delete, asks first", undefined), true);
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

  test("inside a 130% zoom, the measured boxes are divided by it, so the tip lands beside its control and inside the screen as drawn", () => {
    const z = 1.3;
    // Drawn pixels, as getBoundingClientRect gives them: a button near the bottom right of a 1280 px window, and its tip.
    const anchor = { top: 700, left: 1220, width: 57.2, height: 57.2 };
    const tip = { width: 104, height: 31.2 };
    const at = placeTipZoomed(anchor, tip, { width: 1280 }, z);
    const drawn = { top: at.top * z, left: at.left * z };
    assert.ok(Math.abs(drawn.top + tip.height - (anchor.top - 6 * z)) < 0.01, `6 px above it, as drawn: ${JSON.stringify(drawn)}`);
    assert.ok(Math.abs(drawn.left + tip.width - (1280 - 8 * z)) < 0.01, `8 px inside the right edge, as drawn: ${JSON.stringify(drawn)}`);
    assert.deepEqual(placeTipZoomed(anchor, tip, { width: 1280 }, 1), placeTip(anchor, tip, { width: 1280 }), "no zoom changes nothing");
  });

  test("at 320 px and 130%, the widest tip is capped to the window less both margins, and drawn 8 px inside both sides", () => {
    const z = 1.3;
    const view = { width: 320 };
    const cap = tipMaxWidth(view, z);
    assert.ok(Math.abs(cap - (320 / z - 16)) < 1e-9, `${cap}`);
    assert.equal(tipMaxWidth({ width: 1280 }, z), 240, "240 px where the window has room");
    assert.equal(tipMaxWidth({ width: 320 }, 1), 240, "and at 100% on a 320 px phone");
    // The widest tip, as drawn, under a control at either edge and in the middle.
    const tip = { width: cap * z, height: 2 * 18 * z };
    for (const left of [0, 130, 320 - 44 * z]) {
      const anchor = { top: 400, left, width: 44 * z, height: 44 * z };
      const at = placeTipZoomed(anchor, tip, view, z);
      const drawn = at.left * z;
      assert.ok(drawn >= 8 * z - 1e-9, `${left}: ${drawn} past the left edge`);
      assert.ok(drawn + tip.width <= 320 - 8 * z + 1e-9, `${left}: ${drawn + tip.width} past the right edge`);
    }
  });

  test("randomized: at 85% to 130% the tip as drawn never covers its control and stays inside the window", () => {
    const r = rng(11);
    for (let i = 0; i < 2000; i++) {
      const z = pick(r, [0.85, 1, 1.15, 1.3]);
      const view = { width: int(r, 320, 1600) };
      const anchor = { top: int(r, 0, 900), left: int(r, 0, view.width - 60), width: int(r, 24, 200) * z, height: int(r, 24, 60) * z };
      const tip = { width: Math.min(int(r, 40, 240), tipMaxWidth(view, z)) * z, height: int(r, 18, 80) * z };
      const at = placeTipZoomed(anchor, tip, view, z);
      const drawn = { top: at.top * z, left: at.left * z };
      const overlaps = drawn.top < anchor.top + anchor.height && drawn.top + tip.height > anchor.top && drawn.left < anchor.left + anchor.width && drawn.left + tip.width > anchor.left;
      assert.equal(overlaps, false, JSON.stringify({ z, anchor, tip, drawn }));
      assert.ok(drawn.left >= 8 * z - 1e-9, "never past the left edge");
      assert.ok(drawn.left + tip.width <= view.width - 8 * z + 1e-9, "never past the right edge");
    }
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
