import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canPan,
  clampView,
  contentBox,
  FIT,
  fitScale,
  frameOf,
  isDoubleTap,
  layoutPages,
  MAX_ZOOM,
  PAGE_GAP,
  panView,
  pinchView,
  STEP_ZOOM,
  TAP_ZOOM,
  viewerKey,
  viewerPhase,
  viewerStart,
  viewerStep,
  zoomAround,
  zoomInDisabled,
  zoomOutDisabled,
  type Frame,
  type Rect,
  type ViewerAction,
  type ViewerState,
} from "./zoom.ts";

const close = (a: number, b: number, what: string, within = 1e-6) => assert.ok(Math.abs(a - b) <= within, `${what}: ${a} is not ${b}`);

/** A stage 300 x 400 holding a picture fitted to 300 x 200: narrower down than the stage, so centered there. */
const frame: Frame = { stage: { width: 300, height: 400 }, fitted: { width: 300, height: 200 } };

describe("zooming inside the stage", () => {
  test("at the fit the picture is centered where it is smaller than the stage", () => {
    assert.deepEqual(clampView(FIT, frame), { scale: 1, x: 0, y: 100 });
    // Narrower across as well: centered both ways.
    assert.deepEqual(clampView({ scale: 1, x: 40, y: -40 }, { stage: { width: 500, height: 400 }, fitted: { width: 300, height: 200 } }), { scale: 1, x: 100, y: 100 });
  });

  test("never under the fit nor past the largest zoom", () => {
    assert.equal(clampView({ scale: 0.5, x: 0, y: 0 }, frame).scale, 1);
    assert.equal(zoomAround(clampView(FIT, frame), { x: 0, y: 0 }, 100, frame).scale, MAX_ZOOM);
  });

  test("larger than the stage, it pans with no gap at an edge", () => {
    // 900 x 600 in a 300 x 400 stage.
    const big = { scale: 3, x: -300, y: -100 };
    assert.deepEqual(panView(big, 500, 500, frame), { scale: 3, x: 0, y: 0 });
    assert.deepEqual(panView(big, -2000, -2000, frame), { scale: 3, x: -600, y: -200 });
    // At 1.5 the picture is 450 across, wider than the stage, but 300 down, shorter: it pans across and stays centered down.
    assert.deepEqual(panView({ scale: 1.5, x: -50, y: 0 }, -500, 300, frame), { scale: 1.5, x: -150, y: 50 });
    // At the fit there is nowhere to pan.
    assert.deepEqual(panView(clampView(FIT, frame), 50, 50, frame), { scale: 1, x: 0, y: 100 });
  });

  test("the point under the anchor stays put while zooming", () => {
    const start = clampView(FIT, frame);
    const v = zoomAround(start, { x: 150, y: 200 }, 2, frame);
    assert.deepEqual(v, { scale: 2, x: -150, y: 0 });
    // The picture's point under (150, 200) is the one that was there: half way across, half way down.
    close((150 - v.x) / (300 * v.scale), 0.5, "across");
    close((200 - v.y) / (200 * v.scale), 0.5, "down");
  });

  test("a pinch follows the fingers from where they landed", () => {
    const base = { view: clampView(FIT, frame), mid: { x: 150, y: 200 }, dist: 100 };
    assert.deepEqual(pinchView(base, { mid: { x: 150, y: 200 }, dist: 300 }, frame), { scale: 3, x: -300, y: -100 });
    // Spreading and moving both fingers also pans.
    assert.deepEqual(pinchView(base, { mid: { x: 170, y: 190 }, dist: 300 }, frame), { scale: 3, x: -280, y: -110 });
  });

  test("two taps make a double tap only when close in time and place", () => {
    const first = { at: 1000, p: { x: 50, y: 50 } };
    assert.equal(isDoubleTap(first, { at: 1200, p: { x: 60, y: 55 } }), true);
    assert.equal(isDoubleTap(first, { at: 1400, p: { x: 50, y: 50 } }), false);
    assert.equal(isDoubleTap(first, { at: 1100, p: { x: 120, y: 50 } }), false);
    assert.equal(isDoubleTap(null, first), false);
  });
});

describe("the pages", () => {
  test("one page fits whole", () => {
    const one = layoutPages([{ width: 2000, height: 1000 }]);
    assert.deepEqual(one, { width: 2000, height: 1000, pages: [{ left: 0, top: 0, width: 2000, height: 1000 }] });
    // Limited across in a tall stage, down in a wide one.
    assert.equal(fitScale({ width: 400, height: 800 }, one), 0.2);
    assert.equal(fitScale({ width: 4000, height: 500 }, one), 0.5);
  });

  test("two lie in one column with a gap, centered across the widest, and fit its width", () => {
    const two = layoutPages([
      { width: 800, height: 1000 },
      { width: 1000, height: 600 },
    ]);
    assert.deepEqual(two, {
      width: 1000,
      height: 1000 + PAGE_GAP + 600,
      pages: [
        { left: 100, top: 0, width: 800, height: 1000 },
        { left: 0, top: 1000 + PAGE_GAP, width: 1000, height: 600 },
      ],
    });
    const stage = { width: 500, height: 400 };
    assert.equal(fitScale(stage, two), 0.5);
    // Taller than the stage at the fit, so it starts at the top and scrolls down.
    const f = frameOf(stage, two);
    assert.deepEqual(clampView(FIT, f), { scale: 1, x: 0, y: 0 });
    assert.deepEqual(panView(FIT, 0, -10_000, f), { scale: 1, x: 0, y: 400 - (1600 + PAGE_GAP) * 0.5 });
  });

  test("no pages have no size", () => {
    assert.deepEqual(layoutPages([]), { width: 0, height: 0, pages: [] });
    assert.equal(fitScale({ width: 100, height: 100 }, layoutPages([])), 1);
  });
});

/*
 * The viewer's states (docs/design-v1-layout-hierarchy.md 5.1), on a
 * computer at 1280 x 800 with a wide picture, 2000 x 1000. The card's
 * stage is 720 x 600, which fits the picture at 0.36. The window's stage
 * is 1280 x 740, which fits it at 0.64.
 */
const picture = layoutPages([{ width: 2000, height: 1000 }]);
const cardStage: Rect = { left: 280, top: 120, width: 720, height: 600 };
const windowStage: Rect = { left: 0, top: 60, width: 1280, height: 740 };

/** As the component does after each render: the stage measured where the dialog now is. */
function measured(s: ViewerState, windowAt: Rect = windowStage): ViewerState {
  return viewerStep(s, { t: "layout", stage: s.grown ? windowAt : cardStage, layout: picture });
}

function step(s: ViewerState, a: ViewerAction, windowAt: Rect = windowStage): ViewerState {
  return measured(viewerStep(s, a), windowAt);
}

function steps(s: ViewerState, ...actions: ViewerAction[]): ViewerState {
  return actions.reduce((st, a) => step(st, a), s);
}

const cardFit = measured(viewerStart(true));
const wholeScreen = measured(viewerStart(false));

/** A pinch by `factor` about `mid`, then both fingers lifting. */
function pinched(s: ViewerState, factor: number, mid = { x: 360, y: 300 }, windowAt: Rect = windowStage): { during: ViewerState; after: ViewerState } {
  const during = step(s, { t: "pinch", base: { view: s.view, mid, dist: 100 }, now: { mid, dist: 100 * factor } }, windowAt);
  return { during, after: step(during, { t: "release" }, windowAt) };
}

/** What the screen shows of a state: its phase, the dialog's size, and the buttons' availability. */
function shows(s: ViewerState) {
  return { phase: viewerPhase(s), grown: s.grown, zoomOut: !zoomOutDisabled(s), reset: !zoomOutDisabled(s), zoomIn: !zoomInDisabled(s) };
}

describe("the viewer's states on a card layout", () => {
  test("it opens at card fit, with Zoom out disabled and Reset zoom hidden", () => {
    assert.deepEqual(shows(cardFit), { phase: "card", grown: false, zoomOut: false, reset: false, zoomIn: true });
    assert.deepEqual(contentBox(cardFit), { left: 280, top: 240, width: 720, height: 360 });
  });

  test("the first step in from card fit goes to the window's fit, by Zoom in, the wheel or a double tap", () => {
    for (const a of [{ t: "in" }, { t: "wheel", at: { x: 10, y: 10 }, factor: 1.2 }, { t: "double", at: { x: 10, y: 10 } }] as const) {
      const s = step(cardFit, a);
      assert.deepEqual(shows(s), { phase: "window", grown: true, zoomOut: true, reset: true, zoomIn: true }, a.t);
      // Fitted to the larger stage, centered.
      assert.deepEqual(contentBox(s), { left: 0, top: 110, width: 1280, height: 640 }, a.t);
    }
  });

  test("from the window's fit, Zoom out and Reset zoom each go back to card fit", () => {
    const window = step(cardFit, { t: "in" });
    assert.deepEqual(shows(step(window, { t: "out" })), shows(cardFit));
    assert.deepEqual(contentBox(step(window, { t: "out" })), contentBox(cardFit));
    assert.deepEqual(shows(step(window, { t: "reset" })), shows(cardFit));
    // A wheel step out is a Zoom out too.
    assert.deepEqual(shows(step(window, { t: "wheel", at: { x: 0, y: 0 }, factor: 0.8 })), shows(cardFit));
  });

  test("magnified, Zoom out steps toward the window's fit, then to the card, and Reset zoom goes straight to the card", () => {
    const magnified = steps(cardFit, { t: "in" }, { t: "in" }, { t: "in" });
    assert.equal(viewerPhase(magnified), "magnified");
    close(magnified.view.scale, STEP_ZOOM * STEP_ZOOM, "two steps past the window's fit");
    const once = step(magnified, { t: "out" });
    close(once.view.scale, STEP_ZOOM, "one step back");
    const twice = step(once, { t: "out" });
    assert.equal(viewerPhase(twice), "window");
    assert.equal(twice.view.scale, 1);
    assert.equal(viewerPhase(step(twice, { t: "out" })), "card");
    assert.deepEqual(shows(step(magnified, { t: "reset" })), shows(cardFit));
  });

  test("each step past the window's fit is 1.5 times about the stage's center", () => {
    const window = step(cardFit, { t: "in" });
    const s = step(window, { t: "in" });
    // The picture's point at the stage's center, before and after.
    const at = (st: ViewerState) => {
      const box = contentBox(st)!;
      return { x: (windowStage.left + 640 - box.left) / box.width, y: (windowStage.top + 370 - box.top) / box.height };
    };
    assert.equal(s.view.scale, STEP_ZOOM);
    close(at(s).x, at(window).x, "across");
    close(at(s).y, at(window).y, "down");
  });

  test("Zoom in stops at 6 times the window's fit", () => {
    let s = step(cardFit, { t: "in" });
    for (let i = 0; i < 10; i++) s = step(s, { t: "in" });
    assert.equal(s.view.scale, MAX_ZOOM);
    assert.equal(zoomInDisabled(s), true);
    assert.equal(zoomInDisabled(step(s, { t: "out" })), false);
  });

  test("a double tap on the window's fit zooms in on the spot, and the next one goes back to the window's fit", () => {
    const window = step(cardFit, { t: "in" });
    const tapped = step(window, { t: "double", at: { x: 320, y: 370 } });
    assert.equal(tapped.view.scale, TAP_ZOOM);
    assert.equal(viewerPhase(step(tapped, { t: "double", at: { x: 0, y: 0 } })), "window");
  });

  test("Expand takes the card to the window's fit, Zoom out then stops there and Reset zoom goes there", () => {
    const expanded = step(cardFit, { t: "expand" });
    assert.equal(expanded.pinned, true);
    assert.deepEqual(shows(expanded), { phase: "window", grown: true, zoomOut: false, reset: false, zoomIn: true });
    const magnified = steps(expanded, { t: "in" }, { t: "in" });
    assert.equal(viewerPhase(magnified), "magnified");
    const out = steps(magnified, { t: "out" }, { t: "out" }, { t: "out" });
    assert.deepEqual(shows(out), shows(expanded));
    assert.deepEqual(shows(step(magnified, { t: "reset" })), shows(expanded));
    assert.deepEqual(shows(step(expanded, { t: "wheel", at: { x: 0, y: 0 }, factor: 0.5 })), shows(expanded));
    // Pressed again, back to the card.
    const back = step(expanded, { t: "expand" });
    assert.equal(back.pinned, false);
    assert.deepEqual(shows(back), shows(cardFit));
  });

  test("Expand pressed while already grown keeps the zoom", () => {
    const magnified = steps(cardFit, { t: "in" }, { t: "in" });
    const pinned = step(magnified, { t: "expand" });
    assert.deepEqual(pinned.view, magnified.view);
    assert.equal(pinned.pinned, true);
  });

  test("the next pages start at rest, Expand still pressed if it was", () => {
    const magnified = steps(cardFit, { t: "in" }, { t: "in" });
    const next = viewerStep(magnified, { t: "pages" });
    assert.equal(next.grown, false);
    assert.equal(next.layout, null);
    const pinnedNext = viewerStep(step(magnified, { t: "expand" }), { t: "pages" });
    assert.equal(pinnedNext.grown, true);
    assert.equal(pinnedNext.view.scale, 1);
  });
});

describe("a pinch on a card", () => {
  test("never grows the card mid-gesture", () => {
    const { during } = pinched(cardFit, 2.5);
    assert.equal(during.grown, false);
    assert.equal(during.view.scale, 2.5);
  });

  test("past the window's fit, the card grows and the picture's box on the screen stays", () => {
    const { during, after } = pinched(cardFit, 2.5);
    assert.equal(viewerPhase(after), "magnified");
    assert.equal(after.keep, null);
    const before = contentBox(during)!;
    const now = contentBox(after)!;
    for (const k of ["left", "top", "width", "height"] as const) close(now[k], before[k], k);
    // Worked out again against the window's fit: 2.5 times the card's fit of 0.36 is 1.40625 times the window's 0.64.
    close(after.view.scale, (2.5 * 0.36) / 0.64, "scale");
  });

  test("past the window's fit near an edge, the box keeps its size and shifts only as far as clamping needs", () => {
    // About the card's left edge: the picture's left side stays at the screen's 280, which in the window would leave a gap.
    const { during, after } = pinched(cardFit, 2, { x: 0, y: 300 });
    const before = contentBox(during)!;
    const now = contentBox(after)!;
    close(now.width, before.width, "width");
    assert.equal(before.left, 280);
    assert.equal(now.left, windowStage.left);
    // 720 down in a stage 740 tall: shorter than the stage that way, so centered.
    close(now.top, windowStage.top + (740 - now.height) / 2, "top");
  });

  test("short of the window's fit, it settles at the window's fit, centered, with Zoom out and Reset zoom showing", () => {
    // A window of 864 x 740 fits this picture at 0.432, 1.2 times the card's 0.36.
    const narrow: Rect = { left: 208, top: 60, width: 864, height: 740 };
    const s = measured(viewerStart(true), narrow);
    const { after } = pinched(s, 1.05, { x: 360, y: 300 }, narrow);
    assert.deepEqual(shows(after), { phase: "window", grown: true, zoomOut: true, reset: true, zoomIn: true });
    assert.equal(after.view.scale, 1);
    const box = contentBox(after)!;
    close(box.width, 864, "fitted across");
    close(box.left, narrow.left, "left");
    close(box.top - narrow.top, (740 - box.height) / 2, "centered down");
  });

  test("ended at the card's fit, or only just past it, the card stays as it is", () => {
    assert.deepEqual(shows(pinched(cardFit, 0.7).after), shows(cardFit));
    const nudged = pinched(cardFit, 1.01).after;
    assert.deepEqual(shows(nudged), shows(cardFit));
    assert.deepEqual(contentBox(nudged), contentBox(cardFit));
  });

  test("the window's stage measured before the card grew does not take the kept box", () => {
    const { during } = pinched(cardFit, 2.5);
    const released = viewerStep(during, { t: "release" });
    assert.notEqual(released.keep, null);
    // A layout of the pages alone, before the stage is measured again, keeps waiting.
    const waiting = viewerStep(released, { t: "layout", layout: { ...picture } });
    assert.notEqual(waiting.keep, null);
    assert.equal(viewerStep(waiting, { t: "layout", stage: windowStage }).keep, null);
  });
});

describe("the window's fit is the floor once the card has grown", () => {
  test("no sequence of steps shows the picture under the window's fit", () => {
    const windowFitted = frameOf(windowStage, picture).fitted.width;
    const actions: ((s: ViewerState) => ViewerState)[] = [
      (s) => step(s, { t: "in" }),
      (s) => step(s, { t: "out" }),
      (s) => step(s, { t: "reset" }),
      (s) => step(s, { t: "expand" }),
      (s) => step(s, { t: "wheel", at: { x: 100, y: 100 }, factor: 1.1 }),
      (s) => step(s, { t: "wheel", at: { x: 100, y: 100 }, factor: 0.9 }),
      (s) => step(s, { t: "double", at: { x: 400, y: 300 } }),
      (s) => step(s, { t: "arrow", dx: 1, dy: 1 }),
      (s) => pinched(s, 1.05).after,
      (s) => pinched(s, 3).after,
      (s) => pinched(s, 0.6).after,
    ];
    let checked = 0;
    const walk = (s: ViewerState, depth: number) => {
      if (s.grown) {
        assert.ok(contentBox(s)!.width >= windowFitted - 1e-6, `under the window's fit: ${JSON.stringify(s)}`);
        checked++;
      }
      if (depth === 0) return;
      for (const act of actions) walk(act(s), depth - 1);
    };
    walk(cardFit, 4);
    walk(wholeScreen, 3);
    assert.ok(checked > 1000);
  });
});

describe("the viewer on a whole-screen layout", () => {
  test("starts at the window's fit, which is its floor, with no card fit", () => {
    assert.deepEqual(shows(wholeScreen), { phase: "window", grown: true, zoomOut: false, reset: false, zoomIn: true });
    assert.deepEqual(shows(step(wholeScreen, { t: "out" })), shows(wholeScreen));
    assert.deepEqual(shows(step(wholeScreen, { t: "reset" })), shows(wholeScreen));
  });

  test("Zoom in magnifies, and Zoom out and Reset zoom come back to the fit", () => {
    const magnified = step(wholeScreen, { t: "in" });
    assert.equal(viewerPhase(magnified), "magnified");
    assert.equal(magnified.view.scale, STEP_ZOOM);
    assert.deepEqual(shows(step(magnified, { t: "out" })), shows(wholeScreen));
    assert.deepEqual(shows(step(magnified, { t: "reset" })), shows(wholeScreen));
  });

  test("a layout turning short grows a card, and one turning tall keeps the grown dialog", () => {
    const short = viewerStep(cardFit, { t: "layout", card: false });
    assert.equal(short.grown, true);
    assert.equal(zoomOutDisabled(short), true);
    const tall = viewerStep(short, { t: "layout", card: true });
    assert.equal(tall.grown, true);
    assert.equal(viewerPhase(step(tall, { t: "out" })), "card");
  });
});

describe("keys", () => {
  test("+ and = zoom in, minus zooms out, 0 resets", () => {
    assert.deepEqual(viewerKey("+", cardFit), { t: "in" });
    assert.deepEqual(viewerKey("=", cardFit), { t: "in" });
    assert.deepEqual(viewerKey("-", cardFit), { t: "out" });
    assert.deepEqual(viewerKey("0", cardFit), { t: "reset" });
    assert.equal(viewerKey("a", cardFit), null);
  });

  test("the arrows pan a tenth of the stage while magnified, and are left alone at a fit", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      assert.equal(viewerKey(key, cardFit), null, key);
      assert.equal(viewerKey(key, step(cardFit, { t: "in" })), null, key);
    }
    assert.equal(canPan(cardFit), false);
    const magnified = steps(cardFit, { t: "in" }, { t: "in" }, { t: "in" });
    assert.equal(canPan(magnified), true);
    const right = step(magnified, viewerKey("ArrowRight", magnified)!);
    close(right.view.x, magnified.view.x - windowStage.width / 10, "right");
    const down = step(magnified, viewerKey("ArrowDown", magnified)!);
    close(down.view.y, magnified.view.y - windowStage.height / 10, "down");
    const left = step(right, viewerKey("ArrowLeft", right)!);
    close(left.view.x, magnified.view.x, "back left");
  });
});
