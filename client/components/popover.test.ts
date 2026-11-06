import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mousePans } from "../lib/gestures.ts";
import { RoomScope } from "../state/scope.ts";
import { visibleSpan } from "../lib/keyboardInset.ts";
import { anchorInView, chromeRect, clipToVisible, needsPlace, popoverPlace, type PlaceInput, type Rect } from "./popoverPlace.ts";
import {
  closesAfterTab,
  dismissedBy,
  escapeCloses,
  focusAfterLeave,
  focusMoveCloses,
  focusOnClose,
  isMapTarget,
  openFocus,
  openingStop,
  popoverSlot,
  outsideTouchStep,
  pressStep,
  tabOut,
  type CloseReason,
  type MapPress,
  type OutsideEvent,
  type OutsideTouch,
  type PopoverEntry,
  type PressEvent,
} from "./popoverRules.ts";

/*
 * The shared popover base (docs/design/design-v1-tool-options.md 7.1), for every
 * consumer: the tool options' popovers, Setup and Tools, and the side
 * panel's More (docs/design/design-v1-panel-tabs.md 4.2 and 4.3).
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

  /* docs/design/design-v1-panel-tabs.md 4.2: More's menu in the side panel's inner box, below More, with no region to rise into. */
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

  /* FL-17: a roll's menu, the whole window its bound, at 320 x 568 at 130% (246 x 437 in the chrome's own px), its four rows 202 px tall. */
  test("one that may flip opens on the other side where its content fits only there, or where the other side has more room", () => {
    const menu = (anchorTop: number, over: Partial<PlaceInput> = {}) => popoverPlace(above({ anchor: rect(17, anchorTop, 229, anchorTop + 44), bound: rect(0, 0, 246, 437), content: { width: 212, height: 202 }, flip: true, ...over }));
    assert.deepEqual(menu(300), { left: 17, top: 92, width: 212, height: 202, scrolls: false, rose: false }, "room above: above, as without flip");
    assert.deepEqual(menu(150), { left: 17, top: 200, width: 212, height: 202, scrolls: false, rose: false }, "a roll near the top: below it, whole");
    assert.deepEqual(menu(150, { flip: false }), { left: 17, top: 8, width: 212, height: 136, scrolls: true, rose: false }, "without flip it keeps above and scrolls");
    const middle = menu(190);
    assert.deepEqual([middle.top, middle.height, middle.scrolls, middle.covers], [437 - 8 - 202, 202, false, true], "room for it on neither side: the roomier, below, slid up over its anchor until whole (FL17-AGAIN-320)");
    const higher = menu(200);
    assert.deepEqual([higher.top, higher.height, higher.scrolls, higher.covers], [8, 202, false, true], "the roomier side above, slid down over its anchor");
    assert.deepEqual([menu(190, { content: { width: 212, height: 430 } }).height, menu(190, { content: { width: 212, height: 430 } }).scrolls], [189, true], "taller than the bound: the roomier side, and it scrolls as before");
    assert.equal(menu(190, { flip: false }).scrolls, true, "a popover that may not flip never covers its anchor");
    assert.equal(popoverPlace(above({ side: "below", anchor: rect(17, 380, 229, 424), bound: rect(0, 0, 246, 437), content: { width: 212, height: 202 }, flip: true })).top, 380 - 6 - 202, "from below it flips above");
  });

  test("measured rectangles are taken in the chrome's own px", () => {
    assert.deepEqual(chromeRect({ left: 200, top: 100, right: 400, bottom: 200 }, 2), rect(100, 50, 200, 100));
  });
});

describe("a popover over the on-screen keyboard (lib/keyboardInset.ts)", () => {
  // A 390 x 844 phone, the bars at 52 and 784, the keyboard hiding from 544 down.
  const bound = rect(0, 52, 390, 784);

  test("its bound and rise region end where the keyboard starts", () => {
    assert.deepEqual(clipToVisible(bound, { top: 0, bottom: 544 }), rect(0, 52, 390, 544));
  });

  test("a page panned up keeps it under the visible area's top", () => {
    assert.deepEqual(clipToVisible(bound, { top: 120, bottom: 664 }), rect(0, 120, 390, 664));
  });

  test("no keyboard, or one below the bound, changes nothing", () => {
    assert.equal(clipToVisible(bound, null), bound);
    assert.deepEqual(clipToVisible(bound, { top: 0, bottom: 800 }), bound);
  });

  test("a bound wholly under the keyboard is empty, never inverted", () => {
    assert.deepEqual(clipToVisible(rect(0, 600, 390, 784), { top: 0, bottom: 544 }), rect(0, 600, 390, 600));
  });

  test("the visible span comes in the chrome's own px at the interface size", () => {
    assert.deepEqual(visibleSpan({ top: 0, height: 544, inset: 300 }, 1), { top: 0, bottom: 544 });
    assert.deepEqual(visibleSpan({ top: 130, height: 520, inset: 194 }, 1.3), { top: 100, bottom: 500 });
    assert.equal(visibleSpan(null, 1.3), null);
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

  test("the room closes the open one for a reason of its own, a scene change, and does nothing with none open", () => {
    const room = new RoomScope().get(popoverSlot);
    const closes: string[] = [];
    room.closeOpen("state");
    assert.deepEqual(closes, []);
    room.open(entry("color", closes, room));
    room.closeOpen("state");
    assert.deepEqual(closes, ["color:state"]);
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

describe("a dismissal", () => {
  test("is every close the person makes, and neither the consumer's own nor the anchor leaving", () => {
    for (const reason of ["anchor", "press", "map", "escape", "back", "tab", "shiftTab", "pick", "focus", "replaced"] as const) assert.equal(dismissedBy(reason), true, reason);
    for (const reason of ["gone", "state"] as const) assert.equal(dismissedBy(reason), false, reason);
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

  test("after Tab moved focus on, the popover closes unless focus stayed with it, and never an opening made since", () => {
    assert.equal(closesAfterTab({ sameOpening: true, at: "page" }), true, "past the page's last control, focus landed nowhere");
    assert.equal(closesAfterTab({ sameOpening: true, at: "outside" }), true);
    assert.equal(closesAfterTab({ sameOpening: true, at: "inside" }), false);
    assert.equal(closesAfterTab({ sameOpening: true, at: "anchor" }), false);
    // Tab closed More's menu, then a key on More opened it again before the check ran (paneltabs.e2e.ts 3 on a busy laptop).
    assert.equal(closesAfterTab({ sameOpening: false, at: "page" }), false);
    assert.equal(closesAfterTab({ sameOpening: false, at: "outside" }), false);
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

  /*
   * A sheet's swipe cancels the press it takes and then stops that
   * pointer's events at the window, after this room's listeners, which it
   * cannot run before (lib/sheetSwipe.ts). The up still reaches the room,
   * for a pointer it no longer tracks.
   */
  test("the up of a press a sheet's swipe cancelled does nothing", () => {
    assert.deepEqual(run([down(1), { type: "cancel", pointerId: 1 }, up(1)]), { closes: [], suppressed: [true, true, false], state: null });
    assert.deepEqual(run([down(1, { where: "inside" }), { type: "cancel", pointerId: 1 }, up(1)]).closes, [], "a press on the popover");
  });

  test("a press elsewhere closes it at once, and one on it or its anchor does nothing here", () => {
    assert.deepEqual(run([down(1, { where: "elsewhere" }), up(1)]), { closes: ["now"], suppressed: [false, false], state: null });
    assert.deepEqual(run([down(1, { where: "inside" }), up(1)]).closes, []);
    assert.deepEqual(run([down(1, { where: "anchor" }), up(1)]).closes, [], "the anchor's own click closes it");
  });

  test("a touch elsewhere is the outside touch rule's, so the map press rule does not close it at once", () => {
    assert.deepEqual(run([down(1, { where: "elsewhere", touch: true }), up(1)]), { closes: [], suppressed: [false, false], state: null });
    assert.deepEqual(run([down(1, { where: "elsewhere", touch: false }), up(1)]).closes, ["now"], "a mouse's or a pen's");
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

  test("whether a press pans the map is the map's to say, with its own Space, and with no map a middle or right press pans", () => {
    const room = new RoomScope().get(popoverSlot);
    const mouse = (button: number) => ({ pointerType: "mouse", button });
    assert.deepEqual([room.pans(mouse(0)), room.pans(mouse(1)), room.pans(mouse(2)), room.pans({ pointerType: "touch", button: 0 })], [false, true, true, false]);
    let space = true;
    room.mapPans = (e) => mousePans(e, space);
    assert.equal(room.pans(mouse(0)), true, "the left button with Space held, as canvas/Stage.tsx judges it");
    space = false;
    assert.equal(room.pans(mouse(0)), false, "Space let go, or held while a control has focus");
    assert.equal(mousePans({ pointerType: "pen", button: 0 }, true), false, "only a mouse pans by button");
  });

  test("a press on the map is one inside Konva's element, and a pane over the map is not", () => {
    const at = (inMap: boolean) => ({ closest: (selector: string) => (inMap && selector === ".konvajs-content" ? {} : null) });
    assert.equal(isMapTarget(at(true)), true);
    assert.equal(isMapTarget(at(false)), false);
    assert.equal(isMapTarget(null), false);
  });
});

/* FL-17: a finger outside the open popover may start a scroll of the panel under it. */
describe("a touch outside the open popover and its anchor", () => {
  const down = (pointerId: number, over: Partial<Extract<OutsideEvent, { type: "down" }>> = {}): OutsideEvent => ({ type: "down", pointerId, where: "elsewhere", touch: true, key: "roll", ...over });
  const up = (pointerId: number): OutsideEvent => ({ type: "up", pointerId, taken: false });
  const cancel = (pointerId: number, taken: boolean): OutsideEvent => ({ type: "cancel", pointerId, taken });

  function run(events: readonly OutsideEvent[]): { closes: string[]; state: OutsideTouch } {
    let state: OutsideTouch = null;
    const closes: string[] = [];
    for (const e of events) {
      const step = outsideTouchStep(state, e);
      state = step.state;
      if (step.close !== null) closes.push(step.close);
    }
    return { closes, state };
  }

  test("lifted as a tap, it closes the popover open as it began", () => {
    assert.deepEqual(run([down(1), up(1)]), { closes: ["roll"], state: null });
  });

  test("taken by the browser for a scroll or a zoom, it leaves the popover open", () => {
    assert.deepEqual(run([down(1), cancel(1, true)]), { closes: [], state: null });
    assert.deepEqual(run([down(1), cancel(1, true), up(1)]).closes, [], "an up after the browser's cancel is no tap");
  });

  test("taken by a swipe of the page's own, a sheet's or a back swipe, it closes the popover as a tap does", () => {
    assert.deepEqual(run([down(1), cancel(1, false), up(1)]).closes, ["roll"]);
  });

  test("a second finger makes it a pinch, which leaves the popover open", () => {
    assert.deepEqual(run([down(1), down(2, { where: "map", touch: true }), up(2), up(1)]).closes, []);
    assert.deepEqual(run([down(1), down(2), up(1), up(2), down(3), up(3)]).closes, ["roll"], "the next touch is judged afresh");
  });

  test("a mouse's or a pen's press, one inside or on the anchor or the map, and one with nothing open are not its", () => {
    for (const over of [{ touch: false }, { where: "inside" as const }, { where: "anchor" as const }, { where: "map" as const }, { key: null }]) {
      assert.deepEqual(run([down(1, over), up(1)]), { closes: [], state: null }, JSON.stringify(over));
    }
  });

  test("a first finger down starts afresh, so a touch whose end never reached the room cannot keep outside touches from closing (FL17-OPUS-02)", () => {
    assert.deepEqual(run([down(1, { primary: true }), down(2, { primary: true }), up(2)]), { closes: ["roll"], state: null });
    assert.deepEqual(run([down(1, { primary: true }), down(2), up(2), up(1)]).closes, [], "a second finger of the same touch is still a pinch");
    const room = new RoomScope().get(popoverSlot);
    const closes: string[] = [];
    room.open(entry("roll", closes, room));
    // A swipe kept this finger's up from the room.
    room.outsideTouch(down(1, { primary: true }));
    room.outsideTouch(down(2, { primary: true }));
    room.outsideTouch(up(2));
    assert.deepEqual(closes, ["roll:press"]);
    // The map press rule as well: a press on the map whose end was lost is dropped by the next first finger.
    assert.equal(pressStep({ pointers: [1], close: true }, { type: "down", pointerId: 2, where: "map", open: true, pan: false, touch: true, primary: true }).state?.close, true);
    assert.equal(pressStep({ pointers: [1], close: true }, { type: "down", pointerId: 2, where: "map", open: true, pan: false, touch: true, primary: false }).state?.close, false, "a second finger of the same press");
  });

  /** One gesture through the room as Popover.tsx attachRoom runs it: the outside touch rule first on a down, then the map press rule. */
  function gesture(steps: readonly { type: "down" | "up"; pointerId: number; where?: "map" | "elsewhere"; primary?: boolean }[]): string[] {
    const room = new RoomScope().get(popoverSlot);
    const closes: string[] = [];
    room.open(entry("roll", closes, room));
    for (const e of steps) {
      if (e.type === "down") {
        const where = e.where ?? "elsewhere";
        room.outsideTouch({ type: "down", pointerId: e.pointerId, where, touch: true, key: room.current()?.key ?? null, primary: e.primary ?? false });
        const step = room.press({ type: "down", pointerId: e.pointerId, where, open: room.current() !== null, pan: false, touch: true, primary: e.primary ?? false });
        if (step.close === "now") room.current()?.close("press");
      } else {
        room.outsideTouch({ type: "up", pointerId: e.pointerId, taken: false });
        if (room.press({ type: "up", pointerId: e.pointerId }).close === "end") room.current()?.close("map");
      }
    }
    return closes;
  }

  test("a finger outside and one on the map, in either order, are a pinch that leaves it open (FL17-OPUS-03)", () => {
    assert.deepEqual(gesture([{ type: "down", pointerId: 1, primary: true }, { type: "down", pointerId: 2, where: "map" }, { type: "up", pointerId: 2 }, { type: "up", pointerId: 1 }]), [], "outside, then the map");
    assert.deepEqual(gesture([{ type: "down", pointerId: 1, primary: true }, { type: "down", pointerId: 2, where: "map" }, { type: "up", pointerId: 1 }, { type: "up", pointerId: 2 }]), [], "outside, then the map, the first finger lifting first");
    assert.deepEqual(gesture([{ type: "down", pointerId: 1, where: "map", primary: true }, { type: "down", pointerId: 2 }, { type: "up", pointerId: 2 }, { type: "up", pointerId: 1 }]), [], "the map, then outside");
    assert.deepEqual(gesture([{ type: "down", pointerId: 1, where: "map", primary: true }, { type: "down", pointerId: 2 }, { type: "up", pointerId: 1 }, { type: "up", pointerId: 2 }]), [], "the map, then outside, the first finger lifting first");
    assert.deepEqual(gesture([{ type: "down", pointerId: 1, primary: true }, { type: "up", pointerId: 1 }]), ["roll:press"], "one finger outside is a tap");
    assert.deepEqual(gesture([{ type: "down", pointerId: 1, where: "map", primary: true }, { type: "up", pointerId: 1 }]), ["roll:map"], "one finger on the map is a tap");
  });

  test("the room closes the popover the touch began over, and never one opened since", () => {
    const room = new RoomScope().get(popoverSlot);
    const closes: string[] = [];
    room.open(entry("roll", closes, room));
    room.outsideTouch(down(1));
    room.outsideTouch(up(1));
    assert.deepEqual(closes, ["roll:press"]);
    room.open(entry("roll", closes, room));
    room.outsideTouch(down(2));
    // A hold on another roll's button opens its menu while the finger is down.
    room.open(entry("other", closes, room));
    room.outsideTouch(up(2));
    assert.deepEqual(closes, ["roll:press", "roll:replaced"]);
    assert.equal(room.current()?.key, "other");
  });
});

test("an anchor stays in view while it meets both what scrolled and the window, and leaves it at any edge (FL17-OPUS-01)", () => {
  const scroller = { left: 0, top: 100, right: 390, bottom: 700 };
  const viewport = { left: 0, top: 0, right: 390, bottom: 844 };
  const at = (top: number, bottom: number, left = 20, right = 120) => anchorInView({ left, top, right, bottom }, scroller, viewport);
  assert.equal(at(300, 344), true);
  assert.equal(at(80, 101), true, "a sliver still shows");
  assert.equal(at(56, 100), false, "scrolled up past the scroller's top, though still in the window");
  assert.equal(at(700, 744), false, "scrolled down past its bottom");
  assert.equal(at(300, 344, 390, 450), false, "scrolled sideways out");
  assert.equal(anchorInView({ left: 20, top: 860, right: 120, bottom: 900 }, { ...scroller, bottom: 1000 }, viewport), false, "below the window, though inside a taller scroller");
  assert.equal(at(300, 300), false, "no area");
});

test("the box goes to the top layer once, as a manual popover, and a browser without popovers keeps it where it is", async () => {
  const { showInTopLayer } = await import("./Popover.tsx");
  let shown = 0;
  let open = false;
  const box = { isConnected: true, showPopover() { shown++; open = true; }, matches: (selector: string) => selector === ":popover-open" && open };
  showInTopLayer(box as unknown as HTMLElement);
  showInTopLayer(box as unknown as HTMLElement);
  assert.equal(shown, 1);
  showInTopLayer({ isConnected: true, matches: () => false } as unknown as HTMLElement);
  showInTopLayer({ ...box, isConnected: false } as unknown as HTMLElement);
  showInTopLayer(null);
  assert.equal(shown, 1);
});

test("the open box is a manual popover, laid out before it is shown, at no inset or margin of the browser's own", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { RoomScopeProvider } = await import("../state/scope.ts");
  const { Popover, usePopover } = await import("./Popover.tsx");
  const scope = new RoomScope();
  try {
    function Open() {
      const handle = usePopover({ kind: "menu" });
      return createElement(Popover, { handle: { ...handle, open: true }, side: "above", bound: rect(0, 0, 390, 844), children: "Rows" });
    }
    const html = renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: createElement(Open) }));
    assert.match(html, /<div[^>]*data-rvtt-popover=""[^>]*popover="manual"/);
    assert.match(html, /style="display:block;position:fixed;right:auto;bottom:auto;margin:0;/);
  } finally { scope.dispose(); }
});

test("natural measurement keeps a focused popover at its placed position", async () => {
  const { measurePopoverContent } = await import("./Popover.tsx");
  const inner = { scrollTop: 278 };
  const writes: string[] = [];
  const style = new Proxy({ top: "400px", left: "80px" } as Record<string, string>, { set(target, key: string, value: string) {
    writes.push(key);
    if ((key === "top" || key === "left") && value === "0px") inner.scrollTop = 0;
    target[key] = value;
    return true;
  } });
  const bounds = { width: 280, height: 400 } as DOMRect;
  const box = { style, getBoundingClientRect() { assert.equal(style.width, "max-content"); return bounds; } };
  let fitted = false;
  assert.equal(measurePopoverContent(box as unknown as HTMLElement, 300, 80, () => { fitted = true; }), bounds);
  assert.equal(fitted, true);
  assert.equal(inner.scrollTop, 278);
  assert.equal(style.top, "400px");
  assert.equal(style.left, "80px");
  assert.deepEqual(writes, ["height", "width", "maxWidth", "minWidth"]);
});

test("keyboard opening does not snapshot or restore ancestor scroll offsets", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { RoomScopeProvider } = await import("../state/scope.ts");
  const { usePopover } = await import("./Popover.tsx");
  const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node };
  class FakeNode {}
  Object.assign(globalThis, { window: new EventTarget(), document: { activeElement: null, body: null }, Node: FakeNode });
  const scope = new RoomScope();
  try {
    let reads = 0, writes = 0, top = 278;
    const scroller = {
      parentElement: null, isConnected: true,
      get scrollTop() { reads++; return top; }, set scrollTop(value: number) { writes++; top = value; },
      get scrollLeft() { reads++; return 30; }, set scrollLeft(_value: number) { writes++; },
    };
    let handle: ReturnType<typeof usePopover> | undefined;
    function Probe() { handle = usePopover({ kind: "menu" }); return null; }
    renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: createElement(Probe) }));
    handle!.anchor.current = { parentElement: scroller, focus(options: FocusOptions) { assert.equal(options.preventScroll, true); } } as unknown as HTMLElement;
    handle!.show({ by: "key", from: "first" });
    top = 300;
    handle!.close("anchor");
    assert.equal(top, 300, "an intervening real scroll keeps its offset");
    assert.equal(reads, 0, "opening takes no ancestor snapshot");
    assert.equal(writes, 0, "closing restores no ancestor offsets");
  } finally { scope.dispose(); Object.assign(globalThis, previous); }
});

describe("focus stays inside the popover's scroll boundary", () => {
  async function fixture(scale = 1) {
    const { focusInView } = await import("./Popover.tsx");
    const outer = { scrollTop: 278, scrollLeft: 30 };
    const focus: FocusOptions[] = [];
    let nativeScrolls = 0;
    const box = {
      scrollTop: 100, scrollLeft: 20, clientTop: 1, clientLeft: 1,
      clientHeight: 100, clientWidth: 200, offsetWidth: 202, currentCSSZoom: scale as number | undefined,
      getBoundingClientRect: () => ({ top: 200, left: 50, right: 50 + 202 * scale, bottom: 200 + 102 * scale, width: 202 * scale, height: 102 * scale }),
    };
    const itemStyle = { scrollMarginTop: "0px", scrollMarginBottom: "0px", scrollMarginLeft: "0px", scrollMarginRight: "0px" };
    const boxStyle = { scrollPaddingTop: "auto", scrollPaddingBottom: "auto", scrollPaddingLeft: "auto", scrollPaddingRight: "auto" };
    const control = {
      top: 120, left: 40, height: 44, width: 100,
      closest: (): unknown => box,
      focus: (options: FocusOptions) => focus.push(options),
      scrollIntoView: () => { nativeScrolls++; outer.scrollTop = 0; outer.scrollLeft = 0; },
      getBoundingClientRect: () => {
        const top = 200 + (box.clientTop + control.top - box.scrollTop) * scale;
        const left = 50 + (box.clientLeft + control.left - box.scrollLeft) * scale;
        return { top, left, bottom: top + control.height * scale, right: left + control.width * scale };
      },
    };
    return { outer, box, control, itemStyle, boxStyle, focus, get nativeScrolls() { return nativeScrolls; }, run: () => {
      const previous = globalThis.getComputedStyle;
      globalThis.getComputedStyle = (node) => (node === control as unknown as HTMLElement ? itemStyle : boxStyle) as CSSStyleDeclaration;
      try { focusInView(control as unknown as HTMLElement); }
      finally { globalThis.getComputedStyle = previous; }
    } };
  }

  test("focusing an item already in view cannot reset the Dice or sheet scroller", async () => {
    const f = await fixture();
    f.run();
    assert.deepEqual(f.focus, [{ preventScroll: true }]);
    assert.deepEqual(f.outer, { scrollTop: 278, scrollLeft: 30 });
    assert.deepEqual([f.box.scrollTop, f.box.scrollLeft], [100, 20]);
    assert.equal(f.nativeScrolls, 0, "scrollIntoView is allowed to move every ancestor");
  });

  test("keyboard navigation reveals clipped items by scrolling only the popover, at both interface scales", async () => {
    for (const scale of [1, 1.3]) {
      for (const [top, left, expectedTop, expectedLeft] of [
        [80, 40, 80, 20],
        [180, 40, 124, 20],
        [120, 0, 100, 0],
        [120, 180, 100, 80],
      ]) {
        for (const exactZoom of [true, false]) {
          const f = await fixture(scale);
          if (!exactZoom) f.box.currentCSSZoom = undefined;
          f.control.top = top!; f.control.left = left!;
          f.run(); f.run();
          assert.ok(Math.abs(f.box.scrollTop - expectedTop!) < 1e-9, `vertical scroll at ${scale}`);
          assert.ok(Math.abs(f.box.scrollLeft - expectedLeft!) < 1e-9, `horizontal scroll at ${scale}`);
          assert.deepEqual(f.outer, { scrollTop: 278, scrollLeft: 30 });
          assert.equal(f.nativeScrolls, 0);
        }
      }
    }
  });

  test("tracker scroll margins and popover scroll padding keep their nearest-edge spacing", async () => {
    const above = await fixture(1.3);
    above.control.top = 90; above.control.left = 25;
    above.itemStyle.scrollMarginTop = "12px"; above.itemStyle.scrollMarginLeft = "4px";
    above.boxStyle.scrollPaddingTop = "8px"; above.boxStyle.scrollPaddingLeft = "8px";
    above.run();
    assert.ok(Math.abs(above.box.scrollTop - 70) < 1e-9);
    assert.ok(Math.abs(above.box.scrollLeft - 13) < 1e-9);
    const below = await fixture(1.3);
    below.control.top = 180; below.control.left = 180;
    below.itemStyle.scrollMarginBottom = "6px"; below.itemStyle.scrollMarginRight = "6px";
    below.boxStyle.scrollPaddingBottom = "10px"; below.boxStyle.scrollPaddingRight = "12px";
    below.run();
    assert.ok(Math.abs(below.box.scrollTop - 140) < 1e-9);
    assert.ok(Math.abs(below.box.scrollLeft - 98) < 1e-9);
    for (const f of [above, below]) assert.deepEqual(f.outer, { scrollTop: 278, scrollLeft: 30 });
  });

  test("an oversized item keeps nearest-edge behavior without moving ancestors", async () => {
    for (const [top, expected] of [[50, 100], [120, 120], [-100, 0]]) {
      const f = await fixture(); f.control.top = top!; f.control.height = 200;
      f.run();
      assert.equal(f.box.scrollTop, expected);
      assert.deepEqual(f.outer, { scrollTop: 278, scrollLeft: 30 });
    }
  });

  test("focus without a popover or before it has room never falls back to a containing scroller", async () => {
    const f = await fixture(); f.control.top = 300;
    f.box.clientHeight = 0;
    f.run();
    assert.deepEqual([f.box.scrollTop, f.box.scrollLeft], [100, 20]);
    assert.equal(f.nativeScrolls, 0);
    f.control.closest = () => null;
    f.run();
    assert.equal(f.focus.length, 2);
    f.control.closest = () => f.control;
    f.run();
    assert.equal(f.focus.length, 3, "the empty popover itself can take focus without scrolling");
    assert.deepEqual(f.outer, { scrollTop: 278, scrollLeft: 30 });
  });
});

describe("a popover that steps back before it closes (docs/design/design-v1-stat-block-rolls.md 5.3)", async () => {
  await import("./testing/register.ts");
  const { backStep } = await import("./Popover.tsx");

  test("with no step back, or one that declines, Escape and Back close it as before", () => {
    for (const reason of ["escape", "back"] as const) {
      assert.equal(backStep(reason, undefined), "close");
      assert.equal(backStep(reason, () => false), "close");
    }
  });

  test("a step back keeps it open, and only a Back renews its registration, since only a Back used up its history entry (D-261031-170)", () => {
    const told: string[] = [];
    const stepBack = (reason: "escape" | "back") => {
      told.push(reason);
      return true;
    };
    assert.equal(backStep("escape", stepBack), "stay");
    assert.equal(backStep("back", stepBack), "renew");
    assert.deepEqual(told, ["escape", "back"], "the step back is told which it was");
  });
});

describe("a close that takes its anchor away (usePopover anchorGoes, docs/design/design-v1-sound-layout.md 5.1)", async () => {
  await import("./testing/register.ts");
  const { anchorStays } = await import("./Popover.tsx");

  test("focus goes back to a drawn anchor unless its consumer is leaving or says the close takes the anchor away", () => {
    assert.equal(anchorStays(false, undefined), true, "as before: a popover that names nothing");
    assert.equal(anchorStays(false, () => false), true, "the Now playing chip while something still plays");
    assert.equal(anchorStays(false, () => true), false, "the chip once nothing plays: it goes as its player closes");
    assert.equal(anchorStays(true, undefined), false, "as before: its consumer is unmounting");
    assert.equal(anchorStays(true, () => false), false);
  });

  test("the answer is read as the close happens, not as the popover opened", () => {
    let plays = true;
    const goes = () => !plays;
    assert.equal(anchorStays(false, goes), true);
    plays = false;
    assert.equal(anchorStays(false, goes), false);
  });
});
