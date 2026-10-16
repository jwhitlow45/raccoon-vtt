import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "../state/scope.ts";
import { chromeRect, needsPlace, popoverPlace, type PlaceInput, type Rect } from "./popoverPlace.ts";
import {
  escapeCloses,
  focusAfterLeave,
  focusMoveCloses,
  focusOnClose,
  isMapTarget,
  openFocus,
  openingStop,
  popoverSlot,
  pressStep,
  tabOut,
  type CloseReason,
  type MapPress,
  type PopoverEntry,
  type PressEvent,
} from "./popoverRules.ts";

/*
 * The shared popover base (docs/design-v1-tool-options.md 7.1), for every
 * consumer: the tool options' popovers, Setup and Tools, and the side
 * panel's More (docs/design-v1-panel-tabs.md 4.2 and 4.3).
 */

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

/** A popover above a chip in a phone's options row: the map less its safe areas, under the top bar. */
function above(over: Partial<PlaceInput> = {}): PlaceInput {
  return {
    anchor: rect(100, 700, 160, 744),
    bound: rect(0, 60, 390, 760),
    rise: null,
    side: "above",
    gap: 6,
    margin: 8,
    content: { width: 200, height: 150 },
    minHeight: 0,
    ...over,
  };
}

describe("where a popover stands", () => {
  test("its start edge at the anchor's, above it by the gap, as tall as its content", () => {
    assert.deepEqual(popoverPlace(above()), { left: 100, top: 544, width: 200, height: 150, scrolls: false, rose: false });
  });

  test("below its anchor, as More's menu opens", () => {
    const place = popoverPlace(above({ side: "below", anchor: rect(100, 100, 160, 144) }));
    assert.equal(place.top, 150);
    assert.equal(place.height, 150);
  });

  test("moved back inside the bound's far edge, then inside its near edge, which wins", () => {
    assert.equal(popoverPlace(above({ anchor: rect(300, 700, 360, 744) })).left, 390 - 8 - 200, "the far edge");
    assert.equal(popoverPlace(above({ anchor: rect(-20, 700, 40, 744) })).left, 8, "the near edge");
    // Wider than the bound: capped, so both edges hold, from the near one.
    const wide = popoverPlace(above({ anchor: rect(300, 700, 360, 744), content: { width: 600, height: 150 } }));
    assert.deepEqual([wide.left, wide.width], [8, 374]);
  });

  test("at least its anchor's width and at most the bound's less both margins", () => {
    assert.equal(popoverPlace(above({ anchor: rect(10, 700, 300, 744), content: { width: 120, height: 100 } })).width, 290);
    assert.equal(popoverPlace(above({ anchor: rect(10, 700, 380, 744), bound: rect(0, 60, 300, 760) })).width, 284, "the cap wins over the anchor");
  });

  test("as tall as the room to the bound's edge, less the margin, and its content scrolls past that", () => {
    const place = popoverPlace(above({ content: { width: 200, height: 900 } }));
    assert.equal(place.top, 68);
    assert.equal(place.height, 700 - 6 - 68);
    assert.equal(place.scrolls, true);
    const below = popoverPlace(above({ side: "below", anchor: rect(100, 100, 160, 144), content: { width: 200, height: 900 } }));
    assert.equal(below.height, 760 - 8 - 150);
    assert.equal(below.scrolls, true);
  });

  /*
   * 480 x 320 at 130% in a fight: the bound under the top bar and the turn
   * band leaves a popover above the options less than its title and a row.
   */
  test("below its minimum height it grows into the rise region, up to that region's edge", () => {
    const cramped = above({ anchor: rect(60, 112, 120, 156), bound: rect(0, 100, 369, 225), content: { width: 200, height: 160 }, minHeight: 90 });
    const without = popoverPlace(cramped);
    assert.equal(without.height, 0, "with no rise region it keeps inside the bound and scrolls");
    assert.equal(without.rose, false);
    const rose = popoverPlace({ ...cramped, rise: rect(0, 0, 369, 225) });
    assert.equal(rose.rose, true);
    assert.equal(rose.top, 0);
    assert.equal(rose.height, 106);
    assert.equal(rose.scrolls, true);
  });

  test("it does not rise while the bound leaves its minimum height, or while its content fits", () => {
    assert.equal(popoverPlace(above({ rise: rect(0, 0, 390, 760), minHeight: 90 })).rose, false);
    const fits = popoverPlace(above({ anchor: rect(60, 112, 120, 156), bound: rect(0, 60, 369, 225), rise: rect(0, 0, 369, 225), content: { width: 100, height: 30 }, minHeight: 90 }));
    assert.deepEqual([fits.rose, fits.height, fits.top], [false, 30, 76]);
  });

  /* docs/design-v1-panel-tabs.md 4.2: More's menu in the side panel's inner box, below More, with no region to rise into. */
  test("a bound like the side panel's: below the anchor, moved left inside it, never rising", () => {
    const panel = rect(920, 0, 1280, 800);
    const more = rect(1160, 160, 1240, 204);
    const place = popoverPlace({ anchor: more, bound: panel, rise: null, side: "below", gap: 6, margin: 8, content: { width: 180, height: 900 }, minHeight: 0 });
    assert.equal(place.left, 1280 - 8 - 180);
    assert.equal(place.top, 210);
    assert.equal(place.height, 800 - 8 - 210);
    assert.deepEqual([place.scrolls, place.rose], [true, false]);
    assert.equal(popoverPlace({ anchor: more, bound: panel, side: "below", gap: 6, margin: 8, content: { width: 40, height: 100 }, minHeight: 0 }).width, 80, "at least More's width");
  });

  test("placed again when its anchor, its bound or its rise region changes, never when only its content grows", () => {
    const frame = { anchor: rect(100, 700, 160, 744), bound: rect(0, 60, 390, 760), rise: null };
    assert.equal(needsPlace(null, frame), true, "as it opens");
    assert.equal(needsPlace(frame, { ...frame }), false);
    assert.equal(needsPlace(frame, { ...frame, anchor: rect(100.2, 700, 160.2, 744) }), false, "subpixel rounding");
    assert.equal(needsPlace(frame, { ...frame, anchor: rect(140, 700, 200, 744) }), true, "the anchor moved");
    assert.equal(needsPlace(frame, { ...frame, anchor: rect(100, 700, 190, 744) }), true, "the anchor grew");
    assert.equal(needsPlace(frame, { ...frame, bound: rect(0, 108, 390, 760) }), true, "a turn band came");
    assert.equal(needsPlace(frame, { ...frame, rise: rect(0, 0, 390, 760) }), true, "a rise region came");
    // Content is no input of the frame: a choice that adds a line inside moves nothing.
    assert.equal(Object.keys(frame).includes("content"), false);
  });

  test("measured rectangles are taken in the chrome's own px", () => {
    assert.deepEqual(chromeRect({ left: 200, top: 100, right: 400, bottom: 200 }, 2), rect(100, 50, 200, 100));
  });
});

/** An entry that records its closes, as usePopover's closes it and releases it. */
function entry(key: string, closes: string[], room: { release(key: string): void }): PopoverEntry {
  return {
    key,
    where: () => "elsewhere",
    close(reason: CloseReason) {
      closes.push(`${key}:${reason}`);
      room.release(key);
    },
  };
}

describe("one open popover in the room", () => {
  test("opening a second closes the first, across consumers: a tool popover and More", () => {
    const room = new RoomScope().get(popoverSlot);
    const closes: string[] = [];
    let heard = 0;
    room.subscribe(() => void heard++);
    const chip = entry("stroke", closes, room);
    const more = entry("more", closes, room);
    room.open(chip);
    assert.equal(room.current()?.key, "stroke");
    room.open(more);
    assert.equal(room.current()?.key, "more");
    assert.deepEqual(closes, ["stroke:replaced"], "the chip closed and left its release to the new one");
    room.open(chip);
    assert.deepEqual(closes, ["stroke:replaced", "more:replaced"]);
    room.release("more");
    assert.equal(room.current()?.key, "stroke", "a stale release leaves the open one");
    room.release("stroke");
    assert.equal(room.current(), null);
    assert.ok(heard >= 4);
  });

  test("each Room page has its own: the player preview's popovers never close the DM's", () => {
    const dm = new RoomScope().get(popoverSlot);
    const preview = new RoomScope().get(popoverSlot);
    const closes: string[] = [];
    dm.open(entry("setup", closes, dm));
    preview.open(entry("more", closes, preview));
    assert.deepEqual([dm.current()?.key, preview.current()?.key, closes], ["setup", "more", []]);
  });
});

describe("Escape", () => {
  test("closes from inside, from the anchor, from the map and the page", () => {
    assert.equal(escapeCloses({ textField: false, inside: true, modalOver: false }), true, "inside");
    assert.equal(escapeCloses({ textField: true, inside: true, modalOver: false }), true, "the popover's own spell field, or the field it hangs from");
    assert.equal(escapeCloses({ textField: false, inside: false, modalOver: false }), true, "the map, the page, a button elsewhere");
  });

  test("leaves a text field or a select outside to keep its own, and does nothing under a modal dialog", () => {
    assert.equal(escapeCloses({ textField: true, inside: false, modalOver: false }), false, "a journal page being typed in the side panel");
    assert.equal(escapeCloses({ textField: false, inside: true, modalOver: true }), false);
    assert.equal(escapeCloses({ textField: false, inside: false, modalOver: true }), false);
  });
});

describe("focus", () => {
  test("a key open goes to the chosen option, else the first control, and a pointer open stays on the anchor", () => {
    assert.equal(openingStop([false, true, false]), 1, "the chosen option");
    assert.equal(openingStop([false, false]), 0, "the first control");
    assert.equal(openingStop([]), -1, "nothing to focus: the box itself");
    assert.equal(openFocus({ by: "key", from: "first" }), "inside", "Enter or Space on the anchor, or Down on a menu's");
    assert.equal(openFocus({ by: "key", from: "last" }), "inside", "Up on a menu's anchor");
    assert.equal(openFocus({ by: "pointer", from: "first" }), "anchor", "the base focuses the anchor itself, also where the browser would not (Safari)");
  });

  test("Tab past a popover's last control, or at once in a menu, closes it and moves on as from the anchor", () => {
    assert.equal(tabOut({ kind: "dialog", shift: false, index: 2, count: 3 }), "onward");
    assert.equal(tabOut({ kind: "dialog", shift: false, index: 1, count: 3 }), null, "stays inside");
    assert.equal(tabOut({ kind: "dialog", shift: false, index: -1, count: 3 }), null, "from the box, Tab reaches its first control");
    assert.equal(tabOut({ kind: "dialog", shift: false, index: -1, count: 0 }), "onward");
    assert.equal(tabOut({ kind: "menu", shift: false, index: 4, count: 9 }), "onward");
    assert.equal(focusOnClose("tab", "outside"), null, "focus stays where Tab moved it");
    assert.equal(focusOnClose("tab", "page"), null);
  });

  test("Shift+Tab before a popover's first control, or at once in a menu, closes it with focus on the anchor", () => {
    assert.equal(tabOut({ kind: "dialog", shift: true, index: 0, count: 3 }), "anchor");
    assert.equal(tabOut({ kind: "dialog", shift: true, index: -1, count: 3 }), "anchor", "from the box");
    assert.equal(tabOut({ kind: "dialog", shift: true, index: 2, count: 3 }), null);
    assert.equal(tabOut({ kind: "menu", shift: true, index: 4, count: 9 }), "anchor");
    assert.equal(focusOnClose("shiftTab", "inside"), "anchor");
  });

  test("Escape, a pick and Back put focus on the anchor, and a press leaves it where the press put it", () => {
    for (const reason of ["escape", "pick", "shiftTab"] as const) {
      assert.equal(focusOnClose(reason, "inside"), "anchor", reason);
      assert.equal(focusOnClose(reason, "page"), "anchor", `${reason} from the page`);
    }
    assert.equal(focusOnClose("back", "inside"), "anchor");
    assert.equal(focusOnClose("press", "outside"), null);
    assert.equal(focusOnClose("map", "page"), null);
    assert.equal(focusOnClose("replaced", "outside"), null, "the new popover's opener decides");
  });

  test("any other close puts focus on the anchor only while it is inside or on the anchor", () => {
    for (const reason of ["gone", "state", "back", "anchor"] as const) {
      assert.equal(focusOnClose(reason, "inside"), "anchor", reason);
      assert.equal(focusOnClose(reason, "anchor"), "anchor", reason);
      assert.equal(focusOnClose(reason, "page"), null, reason);
      assert.equal(focusOnClose(reason, "outside"), null, reason);
    }
  });

  test("a move to another element outside closes it, and focus falling to the page does not", () => {
    assert.equal(focusMoveCloses("outside"), true);
    assert.equal(focusMoveCloses("page"), false);
    assert.equal(focusMoveCloses("inside"), false);
    assert.equal(focusMoveCloses("anchor"), false);
    assert.equal(focusOnClose("focus", "outside"), null, "focus stays where it went");
  });

  test("a focused control that leaves hands focus to the next one, else the one before, else the anchor", () => {
    const controls = ["shape", "draft", "undo", "reveal", "discard"];
    const gone = new Set(["undo", "reveal", "discard"]);
    const alive = (c: string) => !gone.has(c);
    assert.equal(focusAfterLeave(controls, "reveal", (c) => c !== "reveal"), "discard", "the next");
    assert.equal(focusAfterLeave(controls, "discard", alive), "draft", "the one before, the ones between gone too");
    assert.equal(focusAfterLeave(["discard"], "discard", () => false), null, "the anchor");
    assert.equal(focusAfterLeave(controls, "missing", alive), null);
  });
});

describe("a press while a popover is open", () => {
  const down = (pointerId: number, over: Partial<Extract<PressEvent, { type: "down" }>> = {}): PressEvent => ({ type: "down", pointerId, where: "map", open: true, pan: false, ...over });
  const up = (pointerId: number): PressEvent => ({ type: "up", pointerId });

  function run(events: readonly PressEvent[]): { closes: string[]; suppressed: boolean[]; state: MapPress } {
    let state: MapPress = null;
    const closes: string[] = [];
    const suppressed: boolean[] = [];
    for (const e of events) {
      const step = pressStep(state, e);
      state = step.state;
      if (step.close) closes.push(step.close);
      suppressed.push(step.suppress);
    }
    return { closes, suppressed, state };
  }

  test("one pointer down then up on the map closes it as the pointer lifts, and the tool does nothing with either", () => {
    assert.deepEqual(run([down(1), up(1)]), { closes: ["end"], suppressed: [true, true], state: null });
  });

  test("a second touch before the first lifts cancels the close for that whole gesture", () => {
    assert.deepEqual(run([down(1), down(2), up(2), up(1)]).closes, [], "a pinch");
    assert.deepEqual(run([down(1), down(2), up(1), up(2)]).closes, [], "one of two fingers lifting first, then the other");
    assert.deepEqual(run([down(1), down(2, { where: "elsewhere" }), up(1), up(2)]).closes, [], "the second finger beside the map");
    assert.deepEqual(run([down(1), down(2), up(1), up(2)]).suppressed, [true, true, true, true], "the tool stays out of the whole gesture, the pinch still the map's");
  });

  test("the next gesture is judged afresh", () => {
    assert.deepEqual(run([down(1), down(2), up(1), up(2), down(3), up(3)]).closes, ["end"]);
  });

  test("a right, middle or Space press and the wheel never close it, and the map pans as usual", () => {
    assert.deepEqual(run([down(1, { pan: true }), up(1)]), { closes: [], suppressed: [false, false], state: null });
    assert.deepEqual(run([{ type: "wheel" }]), { closes: [], suppressed: [false], state: null });
  });

  test("a pointer the browser cancels ends the press without closing", () => {
    assert.deepEqual(run([down(1), { type: "cancel", pointerId: 1 }]).closes, []);
  });

  test("a press elsewhere closes it at once, and one on it or its anchor does nothing here", () => {
    assert.deepEqual(run([down(1, { where: "elsewhere" }), up(1)]), { closes: ["now"], suppressed: [false, false], state: null });
    assert.deepEqual(run([down(1, { where: "inside" }), up(1)]).closes, []);
    assert.deepEqual(run([down(1, { where: "anchor" }), up(1)]).closes, [], "the anchor's own click closes it");
  });

  test("with nothing open, the map is the tool's", () => {
    assert.deepEqual(run([down(1, { open: false }), up(1)]), { closes: [], suppressed: [false, false], state: null });
  });

  /*
   * The tool is suppressed from the first down for every consumer, More
   * included: the room reads it, not the popover, and keeps it until the
   * last pointer's event has reached the map, after the popover closed.
   */
  test("the room suppresses the map's tool from the first down until the last event has reached the map", () => {
    const room = new RoomScope().get(popoverSlot);
    const closes: string[] = [];
    room.open(entry("more", closes, room));
    assert.equal(room.suppressesTool(), false);
    room.press(down(1));
    assert.equal(room.suppressesTool(), true);
    const step = room.press(up(1));
    assert.equal(step.close, "end");
    room.current()?.close("map");
    assert.equal(room.current(), null);
    assert.equal(room.suppressesTool(), true, "the lifting pointer's event still reaches the map suppressed");
    room.settle();
    assert.equal(room.suppressesTool(), false);
    room.press(down(2, { open: false }));
    assert.equal(room.suppressesTool(), false, "the next press with nothing open is the tool's");
  });

  test("a press on the map is one inside Konva's element, and a pane over the map is not", () => {
    const at = (inMap: boolean) => ({ closest: (selector: string) => (inMap && selector === ".konvajs-content" ? {} : null) });
    assert.equal(isMapTarget(at(true)), true);
    assert.equal(isMapTarget(at(false)), false);
    assert.equal(isMapTarget(null), false);
  });
});
