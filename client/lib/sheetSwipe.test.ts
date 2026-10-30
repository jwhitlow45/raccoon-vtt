import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { subpageKey } from "../features/panels.ts";
import { TAP_SLOP_PX } from "./gestures.ts";
import {
  atTop,
  cancelPress,
  closeDistance,
  FLICK_SPEED,
  FRAME_MS,
  stepDistance,
  drawnAt,
  GRAB_ATTR,
  normalFromHeld,
  onControl,
  SheetSwipe,
  SLIDE_MS,
  SPEED_WINDOW_MS,
  slideDistance,
  speedAt,
  startsOn,
  stopsClaimed,
  SwipeSession,
  swipeEnd,
  swipePull,
  TypedValues,
  UP_CLAIM_PX,
  type FieldNode,
  type SessionStart,
  type SwipeGeometry,
  type SwipeHost,
  type SwipeLook,
  type SwipeNode,
  type SwipeStart,
  type SwipeStyle,
} from "./sheetSwipe.ts";

// ------------------------------------------------------------ a fake tree

type Fake = FieldNode & {
  style: { touchAction: string; overflowY: string };
  attrs: Map<string, string>;
  rect: { top: number; bottom: number; height: number };
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  value?: string;
  textContent: string | null;
};

function el(tag: string, parent: Fake | null, opts: Partial<Pick<Fake, "scrollTop" | "scrollHeight" | "clientHeight" | "value" | "isContentEditable">> & { attrs?: Record<string, string>; touchAction?: string; overflowY?: string; rect?: { top: number; bottom: number } } = {}): Fake {
  const attrs = new Map(Object.entries(opts.attrs ?? {}));
  const rect = opts.rect ? { ...opts.rect, height: opts.rect.bottom - opts.rect.top } : { top: 0, bottom: 0, height: 0 };
  return {
    tagName: tag.toUpperCase(),
    parentElement: parent,
    hasAttribute: (name: string) => attrs.has(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    isContentEditable: opts.isContentEditable,
    scrollTop: opts.scrollTop ?? 0,
    scrollHeight: opts.scrollHeight ?? 100,
    clientHeight: opts.clientHeight ?? 100,
    value: opts.value,
    textContent: null,
    getBoundingClientRect: () => rect,
    style: { touchAction: opts.touchAction ?? "auto", overflowY: opts.overflowY ?? "visible" },
    attrs,
    rect,
  };
}

const css: SwipeStyle = (n) => (n as Fake).style;

/** A sheet: its header with a button, its scrolling body with a list that scrolls too, a sideways table, fields, a drag handle, its footer. */
function sheet() {
  const surface = el("dialog", null, { rect: { top: 267, bottom: 607 } });
  const header = el("header", surface, { attrs: { [GRAB_ATTR]: "" }, touchAction: "pinch-zoom" });
  const close = el("button", header);
  const closeIcon = el("svg", close);
  const title = el("h2", header);
  const body = el("div", surface, { overflowY: "auto", scrollHeight: 900, clientHeight: 300 });
  const list = el("div", body, { overflowY: "auto", scrollHeight: 600, clientHeight: 200 });
  const row = el("div", list);
  const table = el("div", body, { overflowY: "hidden", scrollHeight: 100, clientHeight: 100 });
  const text = el("input", body, { attrs: { type: "text" } });
  const search = el("input", body, { attrs: { type: "search" } });
  const check = el("input", body, { attrs: { type: "checkbox" } });
  const range = el("input", body, { attrs: { type: "range" } });
  const select = el("select", body);
  const area = el("textarea", body);
  const editable = el("div", body, { isContentEditable: true });
  const handle = el("div", body, { touchAction: "none" });
  const footer = el("footer", surface);
  const dock = el("div", null, { rect: { top: 211, bottom: 259 } });
  const dockButton = el("button", dock);
  const dockGap = el("span", dock);
  return { surface, header, close, closeIcon, title, body, list, row, table, text, search, check, range, select, area, editable, handle, footer, dock, dockButton, dockGap };
}

function start(over: Partial<SwipeStart> = {}): SwipeStart {
  return { on: "grab", atTop: true, typing: false, fingers: 1, closeAt: 400, scale: 1, at: 0, stand: "normal", up: 0, ...over };
}

/** Moves straight down by each step, 30 ms apart, as the e2e's slow drag. */
function drag(swipe: SheetSwipe, dys: readonly number[], opts: { dx?: number; every?: number; from?: number; cancelable?: boolean } = {}) {
  const every = opts.every ?? 30;
  let at = opts.from ?? 0;
  return dys.map((dy) => {
    at += every;
    return swipe.move({ dx: opts.dx ?? 0, dy, at, cancelable: opts.cancelable ?? true });
  });
}

function ramp(to: number, step = 10): number[] {
  const out: number[] = [];
  const sign = Math.sign(to);
  for (let d = step; d < Math.abs(to); d += step) out.push(sign * d);
  out.push(to);
  return out;
}

// ------------------------------------------------------------ 1. who may start

describe("1. who may start", () => {
  test("the grab area, a rider and content at its top may start, content not at its top, an owned control and a second finger may not", () => {
    const t = sheet();
    const riders = [t.dock];
    assert.equal(startsOn(t.close, t.surface, riders, css), "grab", "a button in the header");
    assert.equal(startsOn(t.dockButton, t.surface, riders, css), "grab", "a rider");
    assert.equal(startsOn(t.row, t.surface, riders, css), "content");
    assert.equal(startsOn(t.footer, t.surface, riders, css), "content", "the footer is content");
    assert.equal(startsOn(t.text, t.surface, riders, css), "owned");
    assert.equal(new SheetSwipe().start(start({ on: "grab", atTop: false })), true, "the grab area ignores the content's scroll");
    assert.equal(new SheetSwipe().start(start({ on: "content", atTop: true })), true);
    assert.equal(new SheetSwipe().start(start({ on: "content", atTop: false })), false);
    assert.equal(new SheetSwipe().start(start({ on: "owned" })), false);
    assert.equal(new SheetSwipe().start(start({ fingers: 2 })), false, "a touch that starts with another finger down");
  });

  test("while a field that takes typing has focus, the grab area still moves the surface and content does not", () => {
    assert.equal(new SheetSwipe().start(start({ on: "grab", typing: true })), true);
    assert.equal(new SheetSwipe().start(start({ on: "content", typing: true })), false);
  });
});

// ------------------------------------------------------------ 2. inside the slop

describe("2. inside the slop", () => {
  test("moves of 2, 4 and 6 px down cancel nothing, show no offset and cancel no press, and a lift is a tap", () => {
    for (const on of ["grab", "content"] as const) {
      const swipe = new SheetSwipe();
      swipe.start(start({ on }));
      for (const step of drag(swipe, [2, 4, 6])) assert.deepEqual(step, { cancel: false, position: null, press: false });
      assert.deepEqual(swipe.end(100), { end: "tap", cancel: false });
    }
  });
});

// ------------------------------------------------------------ 3. the claim

describe("3. the claim at the first move past the slop", () => {
  const first = (m: { dx: number; dy: number; at?: number; cancelable?: boolean }, over: Partial<SwipeStart> = {}) => {
    const swipe = new SheetSwipe();
    swipe.start(start(over));
    return { swipe, step: swipe.move({ dx: m.dx, dy: m.dy, at: m.at ?? 30, cancelable: m.cancelable ?? true }) };
  };

  test("down, and down as far as sideways, claim it", () => {
    assert.deepEqual(first({ dx: 0, dy: 9 }).step, { cancel: true, position: 1, press: true });
    assert.equal(first({ dx: 7, dy: 7 }).step.press, true);
  });

  test("more sideways, up, and a move the browser marks not cancelable each let it go", () => {
    assert.equal(first({ dx: 9, dy: 3 }).step.cancel, false);
    assert.equal(first({ dx: 0, dy: -9 }, { on: "content" }).step.cancel, false);
    assert.equal(first({ dx: 0, dy: -9 }, { up: 0 }).step.cancel, false, "the grab area of a surface that cannot fill the screen");
    assert.equal(first({ dx: 0, dy: 9, cancelable: false }).step.cancel, false);
  });

  test("a content touch whose first move past the slop comes 400 ms in is a hold, and a grab touch then claims", () => {
    assert.equal(first({ dx: 0, dy: 9, at: 400 }, { on: "content" }).step.press, false);
    assert.equal(first({ dx: 0, dy: 9, at: 399 }, { on: "content" }).step.press, true);
    assert.equal(first({ dx: 0, dy: 9, at: 400 }, { on: "grab" }).step.press, true);
  });

  test("the decision never changes later in the touch", () => {
    const left = first({ dx: 9, dy: 0 });
    assert.deepEqual(drag(left.swipe, [40, 80], { from: 30 }), [{ cancel: false, position: null, press: false }, { cancel: false, position: null, press: false }]);
    assert.equal(left.swipe.end(200).end, null);
    const taken = first({ dx: 0, dy: 9 });
    const later = drag(taken.swipe, [20, 30], { dx: 200, from: 30 });
    assert.ok(later.every((s) => s.cancel && !s.press), "a claimed touch stays claimed, sideways or not, with one press");
  });
});

// ------------------------------------------------------------ 4. the press

describe("4. the press it takes", () => {
  test("one pointercancel goes out at the claim and none before, and the capture is released", () => {
    const sent: string[] = [];
    const released: number[] = [];
    const target = { isConnected: true, dispatchEvent: (e: Event) => (sent.push(e.type), true) };
    const holder = { hasPointerCapture: (id: number) => id === 7, releasePointerCapture: (id: number) => void released.push(id) };
    cancelPress({ id: 7, target }, holder, () => new Event("pointercancel"));
    assert.deepEqual([sent, released], [["pointercancel"], [7]]);
    const gone = { isConnected: false, dispatchEvent: (e: Event) => (sent.push(e.type), true) };
    cancelPress({ id: 8, target: gone }, holder, () => new Event("pointercancel"));
    assert.deepEqual(sent, ["pointercancel"], "a control gone from the page hears nothing");
  });

  test("the window stops the claimed pointer's later events and no other's", () => {
    assert.equal(stopsClaimed(7, { pointerId: 7 }), true);
    assert.equal(stopsClaimed(7, { pointerId: 8 }), false);
    assert.equal(stopsClaimed(null, { pointerId: 7 }), false);
  });

  test("the session takes the press once, at the claim, and the lift is cancelled only for a claimed touch", () => {
    const page = new FakePage();
    const session = new SwipeSession(page.host);
    session.begin(sessionStart({ on: "grab" }));
    session.move({ dx: 0, dy: 6, at: 10, cancelable: true });
    assert.equal(page.presses, 0);
    session.move({ dx: 0, dy: 12, at: 20, cancelable: true });
    session.move({ dx: 0, dy: 30, at: 30, cancelable: true });
    assert.equal(page.presses, 1);
    assert.equal(session.end(60), true);
    page.settle();
    session.lifted();
    session.begin(sessionStart({ on: "grab" }));
    session.move({ dx: 0, dy: 3, at: 10, cancelable: true });
    assert.equal(session.end(40), false, "a tap's lift is the browser's");
  });
});

// ------------------------------------------------------------ 5. the offset

describe("5. the offset", () => {
  test("the finger's travel less the slop, never below 0, back to 0 when the finger returns", () => {
    const swipe = new SheetSwipe();
    swipe.start(start());
    const shown = drag(swipe, [9, 30, 60, 20, 4, -40]).map((s) => s.position);
    assert.deepEqual(shown, [1, 22, 52, 12, 0, 0]);
  });

  test("its transform is the offset divided by each interface size, so it stays under the finger", () => {
    for (const scale of [0.85, 1, 1.15, 1.3]) {
      const g: SwipeGeometry = { normalTop: 267, normalBottom: 607, up: 0, scale, boxTop: 0, boxHeight: 667, off: 0, wholeScreen: false };
      assert.equal(drawnAt({ position: 52, clip: false }, g).transform, `translateY(${52 / scale}px)`);
    }
  });

  test("in the whole screen's box its top meets the finger, its foot stays at the toolbar, and at full the box meets the screen's top", () => {
    const g: SwipeGeometry = { normalTop: 207, normalBottom: 607, up: 207, scale: 1, boxTop: 0, boxHeight: 667, off: 0, wholeScreen: true };
    assert.deepEqual(drawnAt({ position: -100, clip: true }, g), { transform: "translateY(107px)", clip: "inset(0px 0 167px 0)" });
    assert.deepEqual(drawnAt({ position: -207, clip: false }, g), { transform: "translateY(0px)", clip: "inset(0px 0 0px 0)" });
    // A 47 px top safe area: the band above the header is uncovered as it rises, so the header starts under the finger.
    const notch = { ...g, off: 47 };
    assert.deepEqual(drawnAt({ position: 0, clip: true }, notch), { transform: "translateY(160px)", clip: "inset(47px 0 220px 0)" });
    assert.equal(drawnAt({ position: -207, clip: false }, notch).transform, "translateY(0px)");
  });
});

// ------------------------------------------------------------ 6. release

describe("6. release", () => {
  const release = (dys: readonly number[], over: Partial<SwipeStart> = {}, opts: { every?: number; liftAfter?: number } = {}) => {
    const swipe = new SheetSwipe();
    swipe.start(start(over));
    const steps = drag(swipe, dys, { every: opts.every });
    const at = dys.length * (opts.every ?? 30) + (opts.liftAfter ?? 5);
    return { end: swipe.end(at).end, last: steps[steps.length - 1]?.position };
  };

  test("a slow release goes to the nearest stand: closed only past half the way to fully off screen, at 100% and 130% (the appendix)", () => {
    // 375 x 667: the sheet draws 400 px at either size, so it is fully off screen 400 screen px down, and closes past 200 at both.
    for (const scale of [1, 1.3]) {
      assert.equal(release(ramp(8 + 199), { scale }).end, "normal", `199 px at ${scale}`);
      assert.equal(release(ramp(8 + 200), { scale }).end, "closed", `200 px at ${scale}`);
      assert.equal(release(ramp(8 + 150), { scale }).end, "normal", "past a quarter but short of half: springs back");
    }
    // 390 x 844: 506 px, so 253.
    assert.equal(release(ramp(8 + 252), { closeAt: 506 }).end, "normal");
    assert.equal(release(ramp(8 + 253), { closeAt: 506 }).end, "closed");
    // The dock rides it: off screen with the dock, 400 + 56, so half of that.
    assert.equal(release(ramp(8 + 227), { closeAt: 456 }).end, "normal");
    assert.equal(release(ramp(8 + 228), { closeAt: 456 }).end, "closed");
  });

  test("the floor keeps a small move in place", () => {
    assert.equal(closeDistance(100, 1.3), 44 * 1.3);
    assert.equal(stepDistance(60, 1), 44, "half of a 60 px rise is under the floor");
    assert.equal(release(ramp(-(16 + 40)), { up: 60 }).end, "normal", "40 px up, past half of 60 but under the floor");
    assert.equal(release(ramp(-(16 + 44)), { up: 60 }).end, "full");
  });

  test("a flick closes once past half the floor, and a fast sloppy tap springs back", () => {
    assert.equal(release(ramp(8 + 23), {}, { every: 2 }).end, "closed");
    assert.equal(release(ramp(8 + 21), {}, { every: 2 }).end, "normal");
    assert.equal(release(ramp(8 + 30), { scale: 1.3 }, { every: 2 }).end, "closed", "29 px at 130%");
    assert.equal(release(ramp(8 + 28), { scale: 1.3 }, { every: 2 }).end, "normal");
    const swipe = new SheetSwipe();
    swipe.start(start());
    swipe.move({ dx: 0, dy: 12, at: 15, cancelable: true });
    assert.deepEqual(swipe.end(16), { end: "normal", cancel: true }, "12 px in 15 ms: claimed, 4 px, under half the floor");
  });

  test("only a real flick closes in one go: a moderate lift and a slow swipe's last twitch do not", () => {
    // 0.7 px per ms over the last 100 ms, past a quarter, short of half: a flick under the old 0.5, now the nearest stand.
    assert.equal(release(ramp(8 + 150), {}, { every: 14 }).end, "normal");
    const twitch = new SheetSwipe();
    twitch.start(start());
    drag(twitch, ramp(158));
    // Coalesced, two moves a millisecond apart, then the lift.
    twitch.move({ dx: 0, dy: 168, at: 16 * 30 + 1, cancelable: true });
    twitch.move({ dx: 0, dy: 178, at: 16 * 30 + 2, cancelable: true });
    assert.equal(twitch.end(16 * 30 + 3).end, "normal", "170 px down, the last 20 in 2 ms");
  });

  test("a flick back up springs back however far the drag, and a rest of 100 ms before the lift goes to the nearest stand", () => {
    const swipe = new SheetSwipe();
    swipe.start(start());
    drag(swipe, ramp(300));
    for (let i = 1; i <= 4; i++) swipe.move({ dx: 0, dy: 300 - 10 * i, at: 900 + 2 * i, cancelable: true });
    assert.equal(swipe.end(910).end, "normal");
    assert.equal(release(ramp(8 + 210), {}, { liftAfter: 100 }).end, "closed", "speed 0, past half");
    assert.equal(release(ramp(8 + 150), {}, { liftAfter: 100 }).end, "normal");
  });

  test("a flick down after the drag went back up closes once past half the floor, and a drag that turns sideways follows only its vertical part", () => {
    const swipe = new SheetSwipe();
    swipe.start(start());
    drag(swipe, ramp(200));
    drag(swipe, [150, 100, 50, 20], { from: 200 * 3 });
    for (let i = 1; i <= 8; i++) swipe.move({ dx: 0, dy: 20 + 15 * i, at: 900 + 2 * i, cancelable: true });
    assert.equal(swipe.end(917).end, "closed", "140 - 8 = 132 px below its place, short of half, flicked");
    const turn = new SheetSwipe();
    turn.start(start());
    turn.move({ dx: 0, dy: 20, at: 30, cancelable: true });
    assert.equal(turn.move({ dx: 140, dy: 40, at: 60, cancelable: true }).position, 32, "only the 40 px down, less the slop");
  });

  test("the speed is read over the last 100 ms of the stroke, never over less than a frame", () => {
    assert.equal(speedAt([{ at: 0, dy: 0 }, { at: 50, dy: 10 }, { at: 100, dy: 40 }], 100), 0.4);
    near(speedAt([{ at: 0, dy: 0 }, { at: 190, dy: 10 }, { at: 200, dy: 40 }], 200), (40 - 1000 / 190) / 100, "a quick 30 px after a pause reads over the window, from where the finger stood as it opened");
    assert.equal(speedAt([{ at: 0, dy: 0 }, { at: 10, dy: 100 }], 200), 0, "a finger that rested still");
    assert.ok(speedAt([{ at: 0, dy: 0 }, { at: 10, dy: -60 }], 12) < -1, "up is negative");
  });

  test("a steady drag reads its own speed whatever the samples' times, so 0.9 px per ms is no flick", () => {
    for (const v of [0.8, 0.85, 0.9, 0.99]) {
      // Sampled every 16 ms, the window's opening falls between two samples.
      const trail = Array.from({ length: 8 }, (_, i) => ({ at: 16 * i, dy: v * 16 * i }));
      near(speedAt(trail, 112), v, `${v} px per ms`);
      assert.ok(speedAt(trail, 112) < FLICK_SPEED);
    }
    // Through the machine: a steady 0.9 px per ms drag of 100 px, from a 400 px sheet, springs back.
    const swipe = new SheetSwipe();
    swipe.start(start());
    for (let i = 1; i <= 8; i++) swipe.move({ dx: 0, dy: 0.9 * 16 * i, at: 16 * i, cancelable: true });
    assert.equal(swipe.end(128).end, "normal");
  });

  test("a px of tremor is no turn: a 1 px step back before an 18 px last frame reads over the window", () => {
    const trail = Array.from({ length: 7 }, (_, i) => ({ at: 16 * i, dy: 4.8 * i }));
    const tremor = [...trail, { at: 112, dy: 27.8 }, { at: 128, dy: 45.8 }];
    near(speedAt(tremor, 128), (45.8 - 8.4) / 100, "from where it stood as the window opened");
    assert.ok(speedAt(tremor, 128) < FLICK_SPEED);
    // A turn past a few px still starts its own stroke: a flick back up after a slow drag down.
    near(speedAt([...trail, { at: 112, dy: 8.8 }, { at: 128, dy: -11.2 }], 128), (-11.2 - 28.8) / 32, "from the turn, not the window's opening");
    assert.ok(speedAt([...trail, { at: 112, dy: 8.8 }, { at: 128, dy: -11.2 }], 128) <= -FLICK_SPEED);
  });

  test("clustered samples, as a browser coalesces moves, never make the speed spike", () => {
    near(speedAt([{ at: 0, dy: 0 }, { at: 300, dy: 20 }, { at: 301, dy: 30 }], 302), (30 - (20 * 202) / 300) / 100, "two samples a millisecond apart after a pause");
    assert.equal(speedAt([{ at: 0, dy: 0 }, { at: 1, dy: 10 }], 2), 10 / FRAME_MS, "a young touch's first two samples: over a frame, not 2 ms");
    assert.ok(speedAt([{ at: 0, dy: 0 }, { at: 1, dy: 10 }], 2) < FLICK_SPEED);
    const slow = Array.from({ length: 10 }, (_, i) => ({ at: 30 * (i + 1), dy: 10 * (i + 1) }));
    near(speedAt([{ at: 0, dy: 0 }, ...slow, { at: 301, dy: 105 }, { at: 302, dy: 110 }], 303), (110 - (60 + (10 * 23) / 30)) / 100, "a slow drag ending in a coalesced pair: its last 100 ms");
    // A stroke that turns back keeps its own speed: up 20 px in 6 ms after a slow drag down.
    assert.equal(speedAt([{ at: 0, dy: 0 }, { at: 90, dy: 90 }, { at: 100, dy: 100 }, { at: 102, dy: 90 }, { at: 104, dy: 80 }], 106), -20 / FRAME_MS);
  });
});

// ------------------------------------------------------------ 7. unsaved

describe("7. unsaved input", () => {
  test("read at the claim, the surface follows at half, and the release always springs back", () => {
    const swipe = new SheetSwipe();
    swipe.start(start());
    const claim = swipe.move({ dx: 0, dy: 28, at: 30, cancelable: true });
    assert.equal(claim.press, true);
    assert.equal(swipe.claimed(true), 10);
    assert.equal(drag(swipe, [108, 300], { from: 30 }).at(-1)?.position, 146);
    assert.equal(swipe.end(100).end, "normal");
    const flick = new SheetSwipe();
    flick.start(start());
    flick.move({ dx: 0, dy: 30, at: 2, cancelable: true });
    flick.claimed(true);
    flick.move({ dx: 0, dy: 90, at: 4, cancelable: true });
    assert.equal(flick.end(5).end, "normal", "a flick springs back too");
  });

  test("the close never runs", () => {
    const page = new FakePage({ unsaved: true });
    const session = new SwipeSession(page.host);
    session.begin(sessionStart());
    for (const [i, dy] of ramp(400).entries()) session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
    session.end(500);
    page.settle();
    assert.equal(page.closes, 0);
  });

  test("a focused field counts only with its value changed since it took focus, read at attach for one focused before", () => {
    const t = sheet();
    const values = new TypedValues();
    t.text.value = "Goblin";
    values.remember(t.text);
    assert.equal(values.changed(t.text), false, "focused, nothing typed");
    t.text.value = "Goblins";
    assert.equal(values.changed(t.text), true);
    t.search.value = "";
    values.remember(t.search);
    t.search.value = "orc";
    assert.equal(values.changed(t.search), false, "a search is a view of the list");
    values.remember(t.select);
    assert.equal(values.changed(t.select), false, "a select sends as it changes");
    t.area.value = "";
    assert.equal(values.changed(t.area), false, "a field never read has no start, so counts for nothing");
    // W6-P-21: the field already focused when the hook attaches is read then, and compared at the claim.
    const attached = new TypedValues();
    t.area.value = "draft";
    attached.remember(t.area);
    t.area.value = "draft more";
    assert.equal(attached.changed(t.area), true);
  });

  test("a surface that keeps everything on close, the roll card, never reads it", () => {
    const page = new FakePage({ unsaved: true });
    const session = new SwipeSession({ ...page.host, unsaved: () => false });
    session.begin(sessionStart());
    for (const [i, dy] of ramp(300).entries()) session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
    session.end(400);
    page.settle();
    assert.equal(page.closes, 1);
  });
});

// ------------------------------------------------------------ 8. cancel and replace

describe("8. cancel and replace", () => {
  test("a second finger at any point, or a touchcancel, springs back and closes nothing", () => {
    for (const at of [0, 1, 3, 8]) {
      const page = new FakePage();
      const session = new SwipeSession(page.host);
      session.begin(sessionStart());
      const moves = ramp(300);
      moves.forEach((dy, i) => {
        if (i === at) session.cancel();
        session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
      });
      session.end(1000);
      page.settle();
      assert.equal(page.closes, 0, `cancelled at move ${at}`);
      assert.equal(page.placed, false);
    }
  });

  test("a change of mode or a new item mid-drag puts it back without motion, and mid-slide drops the close", () => {
    const page = new FakePage();
    const session = new SwipeSession(page.host);
    session.begin(sessionStart());
    for (const [i, dy] of ramp(200).entries()) session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
    session.stop();
    assert.deepEqual(page.last, { look: null, ease: false });
    assert.equal(session.end(500), true, "its lift is still cancelled");
    page.settle();
    assert.equal(page.closes, 0);
    session.lifted();
    session.begin(sessionStart());
    for (const [i, dy] of ramp(300).entries()) session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
    session.end(500);
    assert.equal(session.sliding, true);
    session.stop();
    page.settle();
    assert.equal(page.closes, 0, "the slide stopped, the close dropped");
    assert.equal(page.placed, false);
  });

  test("a press during the slide is held to its end, after the slide too, and one at rest or after a replacement is not", () => {
    const page = new FakePage();
    const session = new SwipeSession(page.host);
    session.begin(sessionStart());
    for (const [i, dy] of ramp(300).entries()) session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
    session.end(500);
    assert.equal(session.sliding, true);
    assert.equal(session.press(7), true, "a tap on a button mid-slide");
    assert.equal(session.press(8), true, "a tap on a checkbox mid-slide");
    assert.equal(page.guarding, true);
    page.tick(SLIDE_MS);
    assert.equal(page.closes, 1);
    assert.equal(session.holds(7), true, "still held after the slide, to its end");
    session.release(7);
    session.release(8);
    assert.equal(page.guarding, false);
    assert.equal(session.press(9), false, "at rest");
    session.release(9);
    session.lifted();
    // A replacement mid-slide ends the slide, so the next press reaches its control.
    session.begin(sessionStart());
    for (const [i, dy] of ramp(300).entries()) session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
    session.end(500);
    session.stop();
    assert.equal(session.press(10), false);
    // Unmounted with a press held: nothing stays held.
    session.lifted();
    session.begin(sessionStart());
    for (const [i, dy] of ramp(300).entries()) session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
    session.end(500);
    assert.equal(session.press(11), true);
    session.dispose();
    assert.deepEqual([session.holding, page.guarding], [false, false]);
  });

  test("a subpage's key: two pages with one title and different ids differ, one page renamed does not", () => {
    assert.notEqual(subpageKey({ parent: "Journal", title: "Notes", id: "a" }), subpageKey({ parent: "Journal", title: "Notes", id: "b" }));
    assert.equal(subpageKey({ parent: "Journal", title: "Notes", id: "a" }), subpageKey({ parent: "Journal", title: "Old notes", id: "a" }));
    assert.notEqual(subpageKey({ parent: "Menu", title: "Members" }), subpageKey({ parent: "Menu", title: "Access" }));
  });
});

// ------------------------------------------------------------ 9. slideDistance

describe("9. slideDistance", () => {
  test("a sheet with a rider 56 px above, a dialog's card, a roll card standing 113 px above the screen's foot", () => {
    const panel = el("dialog", null, { rect: { top: 267, bottom: 607 } });
    const dock = el("div", null, { rect: { top: 211, bottom: 259 } });
    assert.equal(slideDistance(panel, [dock], "foot", 667), 340 + 56);
    assert.equal(slideDistance(panel, [], "foot", 667), 340);
    const card = el("section", null, { rect: { top: 300, bottom: 667 } });
    assert.equal(slideDistance(card, [], "screen", 667), 367);
    const roll = el("section", null, { rect: { top: 354, bottom: 554 } });
    assert.equal(slideDistance(roll, [], "screen", 667), 200 + 113);
  });
});

// ------------------------------------------------------------ 10. atTop and startsOn

describe("10. atTop and startsOn", () => {
  test("the surface's scroller, a nested scroller, a sideways-only scroller ignored, a fractional and a negative position, a footer outside the scroller", () => {
    const t = sheet();
    assert.equal(atTop(t.row, t.surface, t.body, css), true);
    t.body.scrollTop = 0.6;
    assert.equal(atTop(t.row, t.surface, t.body, css), true, "fractional, under 1 px");
    t.body.scrollTop = -12;
    assert.equal(atTop(t.row, t.surface, t.body, css), true, "iOS bouncing");
    t.body.scrollTop = 1;
    assert.equal(atTop(t.row, t.surface, t.body, css), false);
    assert.equal(atTop(t.footer, t.surface, t.body, css), false, "a footer drag with the body scrolled down");
    t.body.scrollTop = 0;
    t.list.scrollTop = 40;
    assert.equal(atTop(t.row, t.surface, t.body, css), false, "a list inside, scrolled");
    t.list.scrollTop = 0;
    t.table.scrollTop = 30;
    assert.equal(atTop(t.table, t.surface, t.body, css), true, "a sideways row is no vertical scroller");
  });

  test("a field, a range, touch-action none, the grab area, a button in it, a rider, content", () => {
    const t = sheet();
    const on = (n: SwipeNode) => startsOn(n, t.surface, [t.dock], css);
    assert.deepEqual([t.text, t.area, t.editable, t.select, t.range, t.handle].map(on), ["owned", "owned", "owned", "owned", "owned", "owned"]);
    assert.equal(on(t.check), "content", "a checkbox takes no typing: a tap, or a swipe");
    assert.deepEqual([t.header, t.close, t.dock, t.dockButton].map(on), ["grab", "grab", "grab", "grab"]);
    assert.deepEqual([t.row, t.body, t.footer, t.surface].map(on), ["content", "content", "content", "content"]);
    assert.equal(startsOn(el("div", null), t.surface, [t.dock], css), null, "outside the surface");
  });
});

// ------------------------------------------------------------ 11. three ends

describe("11. three ends", () => {
  // 375 x 667 at 100%: a 400 px sheet, 207 px below the screen's top. At 130%: 189.
  const normal = (over: Partial<SwipeStart> = {}) => start({ up: 207, ...over });
  const full = (over: Partial<SwipeStart> = {}) => start({ up: 207, stand: "full", ...over });

  test("an upward grab move at 12 px decides nothing and cancels nothing, and at 16 px claims", () => {
    const swipe = new SheetSwipe();
    swipe.start(normal());
    assert.deepEqual(drag(swipe, [-6, -12]), [
      { cancel: false, position: null, press: false },
      { cancel: false, position: null, press: false },
    ]);
    assert.deepEqual(swipe.end(100), { end: "tap", cancel: false }, "a tap on Close that drifts 12 px up");
    const up = new SheetSwipe();
    up.start(normal());
    assert.deepEqual(drag(up, [-12, -UP_CLAIM_PX, -40]), [
      { cancel: false, position: null, press: false },
      { cancel: true, position: 0, press: true },
      { cancel: true, position: -24, press: false },
    ]);
    assert.equal(UP_CLAIM_PX, 2 * TAP_SLOP_PX);
  });

  test("a header touch that drifts up past the slop first can still swipe down: past the slop below where it went down, it claims downward", () => {
    const back = new SheetSwipe();
    back.start(normal());
    assert.deepEqual(drag(back, [-6, -12, -4, 4, 8]).map((step) => step.press), [false, false, false, false, false], "back down inside the slop below: nothing yet");
    assert.deepEqual(back.move({ dx: 0, dy: 9, at: 200, cancelable: true }), { cancel: true, position: 1, press: true });
    drag(back, ramp(120).filter((d) => d > 9), { from: 200 });
    const far = new SheetSwipe();
    far.start(normal());
    drag(far, [-6, -12, -4, 9]);
    drag(far, ramp(220).filter((d) => d > 9), { from: 120 });
    assert.equal(far.end(1000).end, "closed", "a backswing then a slow drag past half");
    assert.equal(back.end(1000).end, "normal", "a backswing then a slow drag short of half");
    const across = new SheetSwipe();
    across.start(normal());
    drag(across, [-12, 4]);
    assert.equal(across.move({ dx: 40, dy: 12, at: 90, cancelable: true }).press, false, "more sideways than down decides nothing");
    assert.deepEqual(across.end(100), { end: "tap", cancel: false });
  });

  test("from normal: up past half of up fills the screen, short of it does not, and a flick up fills it above the normal top", () => {
    const end = (dys: readonly number[], every = 30) => {
      const swipe = new SheetSwipe();
      swipe.start(normal());
      drag(swipe, dys, { every });
      return swipe.end(dys.length * every + 5).end;
    };
    assert.equal(end(ramp(-(16 + 104))), "full", "104 px up, past half of 207");
    assert.equal(end(ramp(-(16 + 103))), "normal");
    assert.equal(end(ramp(-(16 + 30)), 2), "full", "a flick up");
    const below = new SheetSwipe();
    below.start(normal());
    drag(below, ramp(80));
    for (let i = 1; i <= 3; i++) below.move({ dx: 0, dy: 80 - 10 * i, at: 240 + 2 * i, cancelable: true });
    assert.equal(below.end(250).end, "normal", "a flick up below the normal top returns it");
    assert.equal(end([...ramp(-100), ...ramp(200).filter((d) => d > -100)]), "closed", "up then down past half the way to closed");
  });

  test("from full: half of up down steps down, more than halfway past normal toward closed closes, a flick closes, short stays", () => {
    // Fully off screen from full screen: the screen's foot, 667 - 207 + 1 below the normal top.
    const end = (dys: readonly number[], over: Partial<SwipeStart> = {}, every = 30) => {
      const swipe = new SheetSwipe();
      swipe.start(full({ closeAt: 461, ...over }));
      drag(swipe, dys, { every });
      return swipe.end(dys.length * every + 5).end;
    };
    assert.equal(end(ramp(8 + 104)), "normal");
    assert.equal(end(ramp(8 + 103)), "full");
    assert.equal(end(ramp(8 + 207 + 231)), "closed", "the long swipe: 207 + half of 461");
    assert.equal(end(ramp(8 + 207 + 230)), "normal", "a slow drag well past normal, short of half, steps to normal");
    assert.equal(end(ramp(8 + 30), {}, 2), "closed", "a flick down");
    assert.equal(end(ramp(8 + 189 + 240), { scale: 1.3, up: 189, closeAt: 479 }), "closed", "at 130%: 189 + half of 479");
    assert.equal(end(ramp(8 + 189 + 239), { scale: 1.3, up: 189, closeAt: 479 }), "normal");
  });

  test("with unsaved input every close ends normal, and with up 0 no upward claim happens", () => {
    for (const s of [normal(), full()]) {
      const swipe = new SheetSwipe();
      swipe.start(s);
      swipe.move({ dx: 0, dy: 20, at: 10, cancelable: true });
      swipe.claimed(true);
      drag(swipe, ramp(800), { from: 10 });
      assert.equal(swipe.end(1000).end, "normal");
    }
    const none = new SheetSwipe();
    none.start(start({ up: 0 }));
    assert.equal(drag(none, [-20, -60]).some((s) => s.press), false);
  });

  test("the positions at 100% and 130% (the appendix), and never above full", () => {
    for (const [scale, up, step] of [[1, 207, 207 / 2], [1.3, 189, 189 / 2]] as const) {
      assert.equal(stepDistance(up, scale), step);
      assert.equal(swipeEnd({ stand: "normal", position: -step, speed: 0, closeAt: 400, up, scale, unsaved: false }), "full");
      assert.equal(swipeEnd({ stand: "normal", position: -step + 0.5, speed: 0, closeAt: 400, up, scale, unsaved: false }), "normal");
      const swipe = new SheetSwipe();
      swipe.start(normal({ up, scale }));
      assert.equal(Math.min(...drag(swipe, ramp(-600)).map((s) => s.position ?? 0)), -up);
    }
  });

  test("the close distance from full is measured from the normal top held, never from the full sheet's top, and after a change of layout size from the cap for the layout now", () => {
    const held = { height: 400, foot: 60, scale: 1, stale: false };
    assert.deepEqual(normalFromHeld(held, { scale: 1, screen: 667, cap: 400 }), { height: 400, normalTop: 207, normalBottom: 607, up: 207 });
    assert.equal(swipeEnd({ stand: "full", position: 231, speed: 0, closeAt: 461, up: 207, scale: 1, unsaved: false }), "closed");
    assert.equal(swipeEnd({ stand: "full", position: 230, speed: 0, closeAt: 461, up: 207, scale: 1, unsaved: false }), "normal", "half of the whole screen from the full top would ask for 333 from the normal top less");
    assert.equal(swipeEnd({ stand: "full", position: 300, speed: 0, closeAt: 461, up: 207, scale: 1, unsaved: true }), "normal", "unsaved input: the nearest stand that is not closed");
    // A 200 px panel held, then turned sideways and back: the cap for the layout now.
    const after = normalFromHeld({ height: 200, foot: 60, scale: 1, stale: true }, { scale: 1, screen: 667, cap: 400 });
    assert.equal(after.height, 400);
    const sized = normalFromHeld({ height: 400, foot: 60, scale: 1, stale: false }, { scale: 1.3, screen: 667, cap: 308 });
    assert.deepEqual([Math.round(sized.height), sized.normalBottom], [400, 667 - 78], "a new interface size: the cap, and the foot at the new size");
  });
});

// ------------------------------------------------------------ 13. the held glow

describe("13. the held glow", () => {
  test("a press on the grab area clear of its controls holds the surface from the press, and the lift lets go", () => {
    const page = new FakePage();
    const session = new SwipeSession(page.host);
    session.begin(sessionStart({ on: "grab", control: false }));
    assert.equal(page.heldOn, true, "held from the press, before any move");
    session.move({ dx: 0, dy: 4, at: 10, cancelable: true });
    assert.equal(page.heldOn, true, "inside the slop");
    assert.equal(session.end(200), false, "a tap's lift");
    assert.deepEqual(page.helds, [true, false]);
  });

  test("held through the claim and the drag, and let go at the release, before the slide runs", () => {
    const page = new FakePage();
    const session = new SwipeSession(page.host);
    session.begin(sessionStart({ on: "grab" }));
    for (const [i, dy] of ramp(300).entries()) {
      session.move({ dx: 0, dy, at: 10 * (i + 1), cancelable: true });
      assert.equal(page.heldOn, true, `at ${dy} px`);
    }
    session.end(500);
    assert.equal(session.sliding, true);
    assert.equal(page.heldOn, false, "the finger lifted, though the surface still slides");
    page.settle();
    assert.deepEqual(page.helds, [true, false], "one hold, told once each way");
  });

  test("a press on Back, Close or a dock button holds nothing while it may be a tap, and holds the surface once it claims", () => {
    const page = new FakePage();
    const session = new SwipeSession(page.host);
    session.begin(sessionStart({ on: "grab", control: true }));
    session.move({ dx: 0, dy: 5, at: 10, cancelable: true });
    session.end(80);
    assert.deepEqual(page.helds, [], "a tap on Close");
    session.lifted();
    session.begin(sessionStart({ on: "grab", control: true }));
    assert.equal(page.heldOn, false);
    session.move({ dx: 0, dy: 20, at: 20, cancelable: true });
    assert.equal(page.heldOn, true, "dragged from Close, the finger holds the sheet");
    session.end(400);
    assert.equal(page.heldOn, false);
  });

  test("content holds the surface only from the claim, so a tap on a checkbox never lights the grabber", () => {
    const page = new FakePage();
    const session = new SwipeSession(page.host);
    session.begin(sessionStart({ on: "content", atTop: true }));
    session.move({ dx: 0, dy: 6, at: 10, cancelable: true });
    assert.equal(page.heldOn, false, "inside the slop");
    session.move({ dx: 0, dy: 30, at: 40, cancelable: true });
    assert.equal(page.heldOn, true, "claimed: the X-card's drag holds it");
    session.end(400);
    assert.equal(page.heldOn, false);
  });

  test("a touch left to the browser, a cancelled touch, a new item and an unmount each let go at once", () => {
    const cases: [string, (session: InstanceType<typeof SwipeSession>) => void][] = [
      ["a sideways move", (s) => s.move({ dx: 30, dy: 2, at: 30, cancelable: true })],
      ["a move the browser will not let the page cancel", (s) => s.move({ dx: 0, dy: 20, at: 30, cancelable: false })],
      // Both DOM events use this cancel. swipe.e2e.ts checks the second finger's document listener.
      ["a cancelled touch", (s) => s.cancel()],
      ["a new item", (s) => s.stop()],
      ["an unmount", (s) => s.dispose()],
    ];
    for (const [what, act] of cases) {
      for (const claimFirst of [false, true]) {
        const page = new FakePage();
        const session = new SwipeSession(page.host);
        session.begin(sessionStart({ on: "grab" }));
        if (claimFirst && !what.startsWith("a sideways") && !what.startsWith("a move")) session.move({ dx: 0, dy: 40, at: 20, cancelable: true });
        assert.equal(page.heldOn, true, what);
        act(session);
        assert.equal(page.heldOn, false, `${what}${claimFirst ? " after the claim" : ""}`);
        session.end(600);
        page.settle();
        assert.equal(page.heldOn, false, `${what}: held again by the lift`);
      }
    }
  });

  test("a touch that may not swipe holds nothing: an owned control, a second finger down, content scrolled down", () => {
    for (const over of [{ on: "owned" as const }, { fingers: 2 }, { on: "content" as const, atTop: false }]) {
      const page = new FakePage();
      const session = new SwipeSession(page.host);
      session.begin(sessionStart(over));
      session.move({ dx: 0, dy: 40, at: 20, cancelable: true });
      session.end(300);
      assert.deepEqual(page.helds, [], JSON.stringify(over));
    }
  });

  test("onControl: Back, Close and a dock button are controls, the header's own ground, its title and a gap in the dock are not", () => {
    const t = sheet();
    const riders = [t.dock];
    assert.equal(onControl(t.close, riders), true, "Close");
    assert.equal(onControl(t.closeIcon, riders), true, "the icon inside Close");
    assert.equal(onControl(t.dockButton, riders), true, "a dock button");
    assert.equal(onControl(t.header, riders), false, "the header's own ground");
    assert.equal(onControl(t.title, riders), false, "the title");
    assert.equal(onControl(t.dockGap, riders), false, "a gap in the dock");
    const link = el("span", t.header, { attrs: { role: "link" } });
    assert.equal(onControl(link, riders), true, "a role that taps");
    // The walk stops at the grab area: a surface inside a button would be no reason to call its header one.
    const wrapper = el("button", null);
    const outer = el("header", wrapper, { attrs: { [GRAB_ATTR]: "" } });
    assert.equal(onControl(el("h2", outer), []), false);
  });

  for (const type of ["checkbox", "radio", "button"]) {
    test(`FU39-B: a bare ${type} input in the header is a control and its tap never holds the sheet`, () => {
      const t = sheet();
      const input = el("input", t.header, { attrs: { type } });
      const control = onControl(input, []);
      assert.equal(control, true);
      const page = new FakePage();
      const session = new SwipeSession(page.host);
      session.begin(sessionStart({ on: startsOn(input, t.surface, [], css)!, control }));
      session.end(100);
      assert.deepEqual(page.helds, []);
    });
  }

  for (const role of ["menuitemcheckbox", "menuitemradio", "slider", "spinbutton"]) {
    test(`FU39-B: a ${role} and its child in the header are controls`, () => {
      const t = sheet();
      const control = el("div", t.header, { attrs: { role } });
      assert.equal(onControl(control, []), true);
      assert.equal(onControl(el("span", control), []), true);
    });
  }
});

// ------------------------------------------------------------ 12. randomized

/** A record of the page a session acts on, with a clock for its slides. */
class FakePage {
  closes = 0;
  stands: boolean[] = [];
  presses = 0;
  placed = false;
  risen = false;
  watching = false;
  /** The window's listener for held presses' ends. */
  guarding = false;
  /** Whether the surface's owner keeps it open after its close. */
  keepsOpen = false;
  shown = true;
  /** The held glow as the host was last told, and every change it was told of. */
  heldOn = false;
  helds: boolean[] = [];
  unsavedNow: boolean;
  last: { look: SwipeLook | null; ease: boolean } | null = null;
  pulls: number[] = [];
  looks: SwipeLook[] = [];
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  private now = 0;
  readonly host: SwipeHost;

  constructor(opts: { unsaved?: boolean; reduced?: boolean } = {}) {
    this.unsavedNow = opts.unsaved ?? false;
    this.host = {
      place: (look, ease, pull) => {
        if (pull !== undefined) this.pulls.push(pull);
        this.placed = look !== null;
        this.last = { look, ease };
        if (look) this.looks.push(look);
      },
      rise: (on) => {
        assert.notEqual(this.risen, on, "a rise asked twice");
        this.risen = on;
      },
      guard: (on) => {
        assert.notEqual(this.guarding, on, "a guard asked twice");
        this.guarding = on;
      },
      watch: (on) => {
        assert.notEqual(this.watching, on, "a watch asked twice");
        this.watching = on;
      },
      takePress: () => void this.presses++,
      later: (ms, fn) => {
        const timer = { at: this.now + ms, fn, live: true };
        this.timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
      close: () => {
        this.closes++;
        this.shown = this.keepsOpen;
      },
      stand: (full) => void this.stands.push(full),
      shows: () => this.shown,
      reducedMotion: () => opts.reduced ?? false,
      unsaved: () => this.unsavedNow,
      held: (on) => {
        assert.notEqual(this.heldOn, on, "the hold told twice");
        this.heldOn = on;
        this.helds.push(on);
      },
    };
  }

  /** Lets the clock run by `ms`, firing what falls due. */
  tick(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      this.now = next.at;
      next.fn();
    }
    this.now = until;
    this.timers = this.timers.filter((t) => t.live);
  }

  /** Runs every slide and check to its end. */
  settle(): void {
    for (let i = 0; i < 20 && this.timers.some((t) => t.live); i++) this.tick(SLIDE_MS);
  }

  get pending(): boolean {
    return this.timers.some((t) => t.live);
  }
}

function sessionStart(over: Partial<SessionStart> = {}): SessionStart {
  return { ...start(over), closeAt: 400, ...over };
}

function near(actual: number, expected: number, what = ""): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);
}

/** A small seeded generator, so a failure names a sequence that can be run again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("12a. randomized strokes for the lift's speed", () => {
  test("a steady stroke never reads faster than the finger, at any sampling, and a px of tremor never makes a flick", () => {
    for (let run = 1; run <= 3000; run++) {
      const rnd = random(run * 7919);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const v = (rnd() * 2 - 1) * pick([0.3, 0.9, 2]);
      const trail = [{ at: 0, dy: 0 }];
      const tremor = rnd() < 0.5 ? 1 : 0;
      let at = 0;
      const count = 1 + Math.floor(rnd() * 20);
      for (let i = 0; i < count; i++) {
        // Coalesced pairs a millisecond apart among frames and dropped frames.
        at += pick([1, 1, 2, 5, 8, 16, 16, 33]);
        const shake = i === count - 1 ? 0 : (rnd() * 2 - 1) * tremor;
        trail.push({ at, dy: v * at + shake });
      }
      const lift = at + pick([0, 0, 1, 5, 20, 60]);
      const speed = speedAt(trail, lift);
      const where = `run ${run}: ${v} px per ms, ${count} samples, lift ${lift - at} ms after the last`;
      if (tremor === 0) assert.ok(Math.abs(speed) <= Math.abs(v) + 1e-9, `${where}: read ${speed}`);
      if (tremor === 0 && lift === at && at >= SPEED_WINDOW_MS) near(speed, v, where);
      if (Math.abs(v) <= 0.9) assert.ok(Math.abs(speed) < FLICK_SPEED, `${where}: tremor made a flick of ${speed}`);
    }
  });
});

describe("12. randomized touches, from both stands", () => {
  test("the invariants hold after every event of many random sequences", () => {
    const RUNS = 1500;
    // What the sequences reached, so a generator that stopped reaching an end fails rather than passing on nothing.
    const reached = { closes: 0, fills: 0, stepsDown: 0, claims: 0, taps: 0, heldPresses: 0, freePresses: 0, heldPastSlide: 0, backswings: 0, holds: 0 };
    let pointer = 100;
    for (let run = 1; run <= RUNS; run++) {
      const rnd = random(run);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const page = new FakePage({ reduced: rnd() < 0.15 });
      page.keepsOpen = rnd() < 0.15;
      const session = new SwipeSession(page.host);
      let stand: "normal" | "full" = "normal";
      const where = `run ${run}`;
      for (let touchNo = 0; touchNo < 10; touchNo++) {
        const canFill = rnd() < 0.6;
        const up = canFill ? 150 + Math.floor(rnd() * 200) : 0;
        if (!canFill) stand = "normal";
        // The Expand sheet button fills it between touches too.
        else if (rnd() < 0.3) stand = "full";
        const s = sessionStart({
          on: pick(["grab", "content", "owned"] as const),
          atTop: rnd() < 0.7,
          typing: rnd() < 0.15,
          fingers: rnd() < 0.1 ? 2 : 1,
          scale: pick([0.85, 1, 1.15, 1.3]),
          at: 0,
          stand,
          up,
          closeAt: 300 + Math.floor(rnd() * 300),
          control: rnd() < 0.3,
        });
        page.unsavedNow = rnd() < 0.25;
        const closesBefore = page.closes;
        const standsBefore = page.stands.length;
        const pressesBefore = page.presses;
        const followed = session.begin(s);
        // The held glow (4.8): from the press only on the grab area clear of its controls.
        assert.equal(page.heldOn, followed && s.on === "grab" && !s.control, `${where}: held at the press`);
        let at = 0;
        let dx = 0;
        let dy = 0;
        /** Whether the touch passed its claim distance: the slop, or twice it for an upward start in a grab area that can fill the screen. */
        let firstPast: "up" | "other" | null = null;
        let passed = false;
        let claimedAt: number | null = null;
        let cancelledMove = false;
        let stopped = false;
        let unsavedAtClaim = false;
        /** The finger as the machine samples it, for the release's own read of its speed. */
        const trail = [{ at: 0, dy: 0 }];
        const steps = 1 + Math.floor(rnd() * 25);
        const drift = pick([-12, -4, 4, 12]);
        for (let i = 0; i < steps; i++) {
          const roll = rnd();
          if (roll < 0.04) {
            session.cancel();
            stopped = true;
          } else if (roll < 0.07) {
            session.stop();
            stopped = true;
          } else if (roll < 0.1) {
            page.unsavedNow = !page.unsavedNow;
          } else {
            at += pick([1, 2, 5, 16, 30, 120, 450]);
            dx += Math.round((rnd() - 0.5) * pick([2, 10, 40]));
            dy += Math.round((rnd() - 0.5) * pick([4, 16, 60, 160]) + drift);
            const presses = page.presses;
            const cancel = session.move({ dx, dy, at, cancelable: rnd() < 0.95 });
            trail.push({ at, dy });
            if (page.presses > presses) {
              claimedAt = i;
              unsavedAtClaim = page.unsavedNow;
            }
            if (cancel && claimedAt === null) assert.fail(`${where}: a move was cancelled before the claim`);
            if (cancel) cancelledMove = true;
            if (firstPast === null && Math.hypot(dx, dy) > TAP_SLOP_PX) firstPast = s.on === "grab" && s.stand === "normal" && up > 0 && dy < 0 && -dy >= Math.abs(dx) ? "up" : "other";
            if (firstPast === "other" || (firstPast === "up" && (-dy >= UP_CLAIM_PX || (dy > TAP_SLOP_PX && dy >= Math.abs(dx))))) passed = true;
            if (firstPast === "up" && page.presses > presses && dy > 0) reached.backswings++;
            if (!followed) assert.equal(cancel, false, `${where}: a touch that may not swipe cancelled a move`);
          }
          // Never above full screen, and never above its place for a surface that cannot fill it.
          for (const look of page.looks) assert.ok(look.position >= -up - 1e-9, `${where}: shown above full at ${look.position}`);
          page.looks = [];
          // The glow follows the machine's own hold: on from a claim until the touch stops, never for a control's tap or a touch that may not swipe.
          assert.equal(page.heldOn, session.touch.holding, `${where}: the host's glow differs from the hold`);
          const pull = session.touch.pull;
          const closing = s.stand === "normal" && session.touch.position > 0;
          assert.ok(pull >= 0 && pull <= (unsavedAtClaim && closing ? 0.5 : 1), `${where}: pull escaped its bounds`);
          if (session.touch.phase !== "claimed") assert.equal(pull, 0, `${where}: an inactive touch has pull`);
          if (!followed || stopped) assert.equal(page.heldOn, false, `${where}: held by a touch that may not swipe, or one stopped`);
          else if (claimedAt !== null) assert.equal(page.heldOn, true, `${where}: a claimed touch not held`);
          else if (s.control) assert.equal(page.heldOn, false, `${where}: a tap on a control held the surface`);
          if (page.heldOn) reached.holds++;
        }
        at += pick([1, 5, 40, 150]);
        const atLift = session.touch.position;
        const speed = speedAt(trail, at);
        const liftCancelled = session.end(at);
        assert.equal(page.heldOn, false, `${where}: held past the lift`);
        assert.equal(session.touch.pull, 0, `${where}: pull survived the lift`);
        if (liftCancelled) assert.notEqual(claimedAt, null, `${where}: a lift cancelled for an unclaimed touch`);
        // Other presses on the surface or a rider while it slides or rests: one held is stopped to its end, after the slide too, and one at rest is never held.
        const presses2 = new Map<number, boolean>();
        const stopAt = rnd() < 0.3 ? Math.floor(rnd() * 6) : -1;
        for (let k = 0; k < 6; k++) {
          if (k === stopAt) session.stop();
          const roll = rnd();
          if (roll < 0.45) {
            const id = pointer++;
            const sliding = session.sliding;
            const held = session.press(id);
            assert.equal(held, sliding, `${where}: a press during a slide not held, or one at rest held`);
            presses2.set(id, held);
            if (held) reached.heldPresses++;
            else reached.freePresses++;
          } else if (roll < 0.75 && presses2.size > 0) {
            const [id, held] = [...presses2.entries()][Math.floor(rnd() * presses2.size)]!;
            assert.equal(session.holds(id), held, `${where}: a held press let go before its end, or a free one held`);
            if (held && !session.sliding) reached.heldPastSlide++;
            session.release(id);
            presses2.delete(id);
          } else page.tick(pick([0, 20, 60, 120, 250]));
          assert.equal(page.guarding, session.holding, `${where}: the window's guard does not match the held presses`);
        }
        for (const [id, held] of presses2) {
          assert.equal(session.holds(id), held);
          session.release(id);
        }
        assert.equal(session.holding, false);
        assert.equal(page.guarding, false, `${where}: the window's guard left on`);
        if (rnd() < 0.3) session.stop();
        session.lifted();
        page.settle();
        assert.equal(session.press(pointer++), false, `${where}: a press at rest held`);
        for (const look of page.looks) assert.ok(look.position >= -up - 1e-9, `${where}: slid above full to ${look.position}`);
        page.looks = [];
        const presses = page.presses - pressesBefore;
        assert.ok(presses <= 1, `${where}: ${presses} pointercancels in one touch`);
        if (claimedAt === null) {
          assert.equal(presses, 0);
          assert.equal(cancelledMove, false, `${where}: a touch that never claimed cancelled a move`);
        }
        if (!passed) {
          assert.equal(claimedAt, null, `${where}: claimed short of its claim distance`);
          assert.equal(liftCancelled, false, `${where}: a tap's lift was cancelled`);
        }
        const ends = page.closes - closesBefore + (page.stands.length - standsBefore);
        assert.ok(ends <= 1, `${where}: ${ends} ends in one touch`);
        if (stopped || claimedAt === null) assert.equal(ends, 0, `${where}: an end after a cancel, a replacement or no claim`);
        if (page.closes > closesBefore) assert.equal(unsavedAtClaim, false, `${where}: closed with unsaved input`);
        // Only a real flick closes in one go: a slow release closes only past half the way to fully off screen, and fills the screen only past half the way up.
        if (page.closes > closesBefore) assert.ok(speed >= FLICK_SPEED || atLift >= closeDistance(s.closeAt, s.scale) - 1e-9, `${where}: a slow release at ${atLift} closed, short of ${closeDistance(s.closeAt, s.scale)}`);
        if (page.stands.slice(standsBefore).includes(true)) assert.ok(speed <= -FLICK_SPEED || -atLift >= stepDistance(up, s.scale) - 1e-9, `${where}: a slow release at ${atLift} filled the screen, short of ${stepDistance(up, s.scale)}`);
        if (claimedAt !== null) reached.claims++;
        else if (followed && !stopped) reached.taps++;
        reached.closes += page.closes - closesBefore;
        for (const full of page.stands.slice(standsBefore)) {
          if (full) reached.fills++;
          else reached.stepsDown++;
          if (full) assert.ok(up > 0, `${where}: full screen for a surface that cannot fill it`);
          stand = full ? "full" : "normal";
        }
        if (page.closes > closesBefore && !page.keepsOpen) stand = "normal";
        page.shown = true;
        // Once the last finger lifts and the motion settles, nothing is left set.
        assert.equal(page.pending, false, `${where}: a timer outlived the motion`);
        assert.equal(page.placed, false, `${where}: a transform left set`);
        assert.equal(page.risen, false, `${where}: the whole screen's box left on`);
        assert.equal(page.watching, false, `${where}: a document listener left`);
        assert.equal(session.sliding, false);
      }
      // Unmounted with a press held mid-slide: nothing stays held or listened for.
      session.dispose();
      assert.equal(page.heldOn, false);
      assert.equal(page.watching, false);
      assert.equal(page.guarding, false);
      assert.equal(session.holding, false);
    }
    for (const [what, count] of Object.entries(reached)) assert.ok(count > 20, `only ${count} ${what} in ${RUNS} runs`);
  });
});

describe("FL-8. pull toward the next stand", () => {
  test("rest, partway, at and past the closing threshold, scaled by the sheet's height", () => {
    for (const closeAt of [200, 400, 800]) {
      for (const share of [0, 0.25, 0.5, 1, 1.4]) {
        near(swipePull({ stand: "normal", position: closeAt / 2 * share, closeAt, up: 0, scale: 1, unsaved: false }), Math.min(1, share));
      }
    }
    near(swipePull({ stand: "normal", position: 50, closeAt: 200, up: 0, scale: 1, unsaved: false }), 0.5);
    near(swipePull({ stand: "normal", position: 50, closeAt: 800, up: 0, scale: 1, unsaved: false }), 0.125);
  });

  test("both directions between normal and full, including a pull beyond the next stand", () => {
    for (const up of [200, 400]) {
      for (const stand of ["normal", "full"] as const) {
        for (const share of [0, 0.25, 0.5, 1, 2, 3]) {
          const position = stand === "normal" ? -up / 2 * share : -up + up / 2 * share;
          near(swipePull({ stand, position, closeAt: 400, up, scale: 1, unsaved: false }), Math.min(1, share));
        }
      }
    }
  });

  test("the minimum travel agrees with a slow release, including at 130%", () => {
    for (const scale of [1, 1.3]) {
      for (const position of [22 * scale, 44 * scale]) {
        const i = { stand: "normal" as const, position, closeAt: 60, up: 80, scale, unsaved: false };
        near(swipePull(i), position / (44 * scale));
        assert.equal(swipeEnd({ ...i, speed: 0 }) === "closed", position === 44 * scale);
        near(swipePull({ ...i, position: -position }), position / (44 * scale));
        assert.equal(swipeEnd({ ...i, position: -position, speed: 0 }) === "full", position === 44 * scale);
      }
    }
  });

  test("no pull toward a missing stand, or upward from full screen", () => {
    for (const position of [-10, -100, -1000]) near(swipePull({ stand: "normal", position, closeAt: 400, up: 0, scale: 1, unsaved: false }), 0);
    near(swipePull({ stand: "normal", position: 100, closeAt: 0, up: 0, scale: 1, unsaved: false }), 0);
    near(swipePull({ stand: "full", position: -350, closeAt: 400, up: 300, scale: 1, unsaved: false }), 0);
  });

  test("unsaved resistance uses the shown position, and caps only pulls toward closing at half", () => {
    const touch = new SheetSwipe();
    touch.start(start({ up: 200 }));
    touch.move({ dx: 0, dy: 108, at: 30, cancelable: true });
    assert.equal(touch.claimed(true), 50);
    near(touch.pull, 0.25);
    for (const dy of [208, 408, 1008]) {
      touch.move({ dx: 0, dy, at: 60, cancelable: true });
      near(touch.pull, 0.5);
    }
    touch.move({ dx: 0, dy: -200, at: 90, cancelable: true });
    near(touch.pull, 1, "unsaved input still allows full screen");
    touch.move({ dx: 0, dy: 408, at: 120, cancelable: true });
    near(touch.pull, 0.5, "reversing toward closing restores the cap");
  });

  test("unsaved input reaches full pull at either permitted stand, including a step down beyond normal", () => {
    for (const scale of [1, 1.3]) {
      for (const up of [80, 200]) {
        for (const share of [0, 0.25, 0.5, 1, 2, 3]) {
          const distance = Math.max(up / 2, 44 * scale) * share;
          near(swipePull({ stand: "normal", position: -distance, closeAt: 400, up, scale, unsaved: true }), Math.min(1, share));
          near(swipePull({ stand: "full", position: -up + distance, closeAt: 400, up, scale, unsaved: true }), Math.min(1, share));
        }
      }
    }
    const touch = new SheetSwipe();
    touch.start(start({ up: 200 }));
    touch.move({ dx: 0, dy: -116, at: 30, cancelable: true });
    touch.claimed(true);
    near(touch.pull, 1);
    assert.equal(touch.end(160).end, "full", "full pull must agree with a slow release toward full");
    touch.start(start({ stand: "full", up: 200 }));
    touch.move({ dx: 0, dy: 108, at: 30, cancelable: true });
    touch.claimed(true);
    near(touch.pull, 1);
    assert.equal(touch.end(160).end, "normal", "full pull must agree with the permitted step down");
  });

  test("holding without moving, a reversal, cancel and a new touch never retain pull", () => {
    const touch = new SheetSwipe();
    assert.equal(touch.pull, 0);
    touch.start(start());
    assert.equal(touch.holding, true);
    assert.equal(touch.pull, 0);
    touch.move({ dx: 0, dy: 108, at: 30, cancelable: true });
    near(touch.pull, 0.5);
    touch.move({ dx: 0, dy: 0, at: 60, cancelable: true });
    near(touch.pull, 0);
    touch.move({ dx: 0, dy: 208, at: 90, cancelable: true });
    near(touch.pull, 1);
    touch.cancel();
    assert.equal(touch.holding, false);
    assert.equal(touch.pull, 0);
    touch.start(start({ stand: "full", up: 300 }));
    assert.equal(touch.pull, 0);
    touch.end(100);
    assert.equal(touch.pull, 0);
  });

  test("a flick commits with less than full pull", () => {
    const touch = new SheetSwipe();
    touch.start(start());
    touch.move({ dx: 0, dy: 48, at: 20, cancelable: true });
    near(touch.pull, 0.2);
    assert.equal(touch.end(21).end, "closed");
    assert.equal(touch.pull, 0);
  });

  test("the session passes pull after reading unsaved input, with reduced motion too, and clears the hold on cancel", () => {
    for (const reduced of [false, true]) {
      const page = new FakePage({ unsaved: true, reduced });
      const session = new SwipeSession(page.host);
      session.begin(sessionStart());
      assert.equal(session.touch.pull, 0);
      session.move({ dx: 0, dy: 108, at: 30, cancelable: true });
      assert.deepEqual(page.pulls, [0.25]);
      session.move({ dx: 0, dy: 608, at: 60, cancelable: true });
      assert.deepEqual(page.pulls, [0.25, 0.5]);
      session.cancel();
      assert.equal(session.touch.pull, 0);
      assert.equal(page.heldOn, false);
      assert.equal(session.sliding, !reduced);
      page.settle();
      assert.equal(page.closes, 0);
      assert.equal(page.placed, false);
      assert.deepEqual(page.pulls, [0.25, 0.5], "settling never sends a target as finger pull");
    }
  });
});
