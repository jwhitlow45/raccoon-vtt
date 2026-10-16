import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  allPagesShown,
  canPan,
  currentPage,
  END_PX,
  flingIsFast,
  flingStep,
  FLING_STOP,
  focusHandOff,
  isTap,
  KEEP_AHEAD,
  MOUNT_AHEAD,
  mountedPages,
  pageRects,
  pageStep,
  releaseVelocity,
  viewerFrame,
  visiblePages,
  wheelScroll,
  WHEEL_LINE_PX,
  clampView,
  contentBox,
  FIT,
  fitScale,
  frameOf,
  isDoubleTap,
  layoutPages,
  MAX_ZOOM,
  PAGE_GAP_SHARE,
  panView,
  pinchView,
  resetShown,
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
const frame: Frame = { stage: { width: 300, height: 400 }, fitted: { width: 300, height: 200 }, min: 1, pad: 0 };

describe("zooming inside the stage", () => {
  test("at the fit the picture is centered where it is smaller than the stage", () => {
    assert.deepEqual(clampView(FIT, frame), { scale: 1, x: 0, y: 100 });
    // Narrower across as well: centered both ways.
    assert.deepEqual(clampView({ scale: 1, x: 40, y: -40 }, { stage: { width: 500, height: 400 }, fitted: { width: 300, height: 200 }, min: 1, pad: 0 }), { scale: 1, x: 100, y: 100 });
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
    // The gap is 2% of the widest page, 20 page pixels here.
    const gap = 1000 * PAGE_GAP_SHARE;
    assert.equal(gap, 20);
    assert.deepEqual(two, {
      width: 1000,
      height: 1000 + gap + 600,
      pages: [
        { left: 100, top: 0, width: 800, height: 1000 },
        { left: 0, top: 1000 + gap, width: 1000, height: 600 },
      ],
    });
    const stage = { width: 500, height: 400 };
    assert.equal(fitScale(stage, two), 0.5);
    // Taller than the stage at the fit, so it starts at the top and scrolls down.
    const f = frameOf(stage, two);
    assert.deepEqual(clampView(FIT, f), { scale: 1, x: 0, y: 0 });
    assert.deepEqual(panView(FIT, 0, -10_000, f), { scale: 1, x: 0, y: 400 - (1600 + gap) * 0.5 });
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
  return { phase: viewerPhase(s), grown: s.grown, zoomOut: !zoomOutDisabled(s), reset: resetShown(s), zoomIn: !zoomInDisabled(s) };
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

/*
 * Several pages (docs/design-v1-pdf-handouts.md section 5): a phone's
 * whole-screen stage of 390 x 700, and round 2's mixed heights, pages
 * about 390, 301, 390 and 390 px tall at the width fit.
 */
const phone: Rect = { left: 0, top: 100, width: 390, height: 700 };
const mixed = layoutPages([
  { width: 390, height: 390 },
  { width: 390, height: 301 },
  { width: 390, height: 390 },
  { width: 390, height: 390 },
]);
/** A Letter page as a PDF page draws, 1584 x 2048, `n` times. */
const letters = (n: number) => layoutPages(Array.from({ length: n }, () => ({ width: 1584, height: 2048 })));

/** A viewer opened on these pages and measured, on a phone unless a card stage is given. */
function opened(layout: typeof mixed, stage: Rect = phone, opts: { card?: boolean; start?: number; pad?: number } = {}): ViewerState {
  return viewerStep(viewerStart(opts.card ?? false, opts.start ?? 0), { t: "layout", stage, layout, pad: opts.pad ?? 0 });
}

/** Steps, each followed by a measure of the stage where the dialog now is, as the component does. */
function walk(s: ViewerState, actions: ViewerAction[], stages: { card: Rect; window: Rect }): ViewerState {
  return actions.reduce((st, a) => {
    const next = viewerStep(st, a);
    return viewerStep(next, { t: "layout", stage: next.grown ? stages.window : stages.card });
  }, s);
}

/** The page, and the point on it in its own pixels, at the stage's center. */
function atCenter(s: ViewerState): { page: number; x: number; y: number } {
  const rects = pageRects(s)!;
  const cx = s.stage!.width / 2;
  const cy = s.stage!.height / 2;
  const page = rects.findIndex((r) => cy >= r.top && cy <= r.top + r.height + 1e-6);
  const r = rects[page]!;
  const box = s.layout!.pages[page]!;
  return { page, x: ((cx - r.left) / r.width) * box.width, y: ((cy - r.top) / r.height) * box.height };
}

describe("several pages: the column and its fits", () => {
  test("one column fitted to the width, with the end padded by the controls row", () => {
    const s = opened(letters(3), phone, { pad: 60 });
    const frame = viewerFrame(s)!;
    close(frame.fitted.width, 390, "the width fit");
    assert.equal(frame.pad, 60);
    const end = viewerStep(s, { t: "end" });
    const last = pageRects(end)!.at(-1)!;
    close(last.top + last.height, 700 - 60, "the last page's bottom clears the controls row");
  });

  test("the page fit shows the tallest page whole, and is the floor where it is below the width fit", () => {
    // A 320 x 480 phone, whose stage under the header is about 380 tall: a Letter page at the width fit is a little taller.
    const small: Rect = { left: 0, top: 100, width: 320, height: 380 };
    const s = opened(letters(2), small);
    const frame = viewerFrame(s)!;
    close(frame.min, 380 / 2048 / (320 / 1584), "the page fit, as a share of the width fit");
    let out = s;
    for (let i = 0; i < 5; i++) out = viewerStep(out, { t: "out" });
    close(out.view.scale, frame.min, "Zoom out stops at the page fit");
    assert.equal(zoomOutDisabled(out), true);
    const page = pageRects(out)![0]!;
    assert.ok(page.height <= 380 + 1e-6, "a whole page shows");
    // Where every page already shows whole at the width fit, the width fit is the floor.
    const short = opened(mixed);
    assert.equal(viewerFrame(short)!.min, 1);
    assert.equal(zoomOutDisabled(short), true);
  });

  test("the steps out of magnified on a card: the window's width fit, the card's width fit, then down to the card's page fit", () => {
    const cardAt: Rect = { left: 280, top: 120, width: 720, height: 600 };
    const windowAt: Rect = { left: 0, top: 60, width: 1280, height: 740 };
    const stages = { card: cardAt, window: windowAt };
    const start = opened(letters(3), cardAt, { card: true });
    const magnified = walk(start, [{ t: "in" }, { t: "in" }, { t: "in" }], stages);
    assert.equal(viewerPhase(magnified), "magnified");
    const states = [magnified];
    let s = magnified;
    while (!zoomOutDisabled(s)) {
      s = walk(s, [{ t: "out" }], stages);
      states.push(s);
      assert.ok(states.length < 20);
    }
    const phases = states.map((st) => `${viewerPhase(st)}@${st.view.scale.toFixed(3)}`);
    assert.equal(phases[phases.indexOf("window@1.000") + 1], "card@1.000", `the step after the window's width fit is the card's width fit: ${phases.join(" ")}`);
    close(s.view.scale, viewerFrame(s)!.min, "the floor is the card's page fit");
    assert.equal(s.grown, false);
    // Reset zoom from below the card's width fit goes back to it.
    const reset = walk(s, [{ t: "reset" }], stages);
    assert.equal(reset.view.scale, 1);
    assert.equal(reset.grown, false);
  });

  test("with Expand pressed, the window's page fit is the floor", () => {
    const cardAt: Rect = { left: 280, top: 120, width: 720, height: 600 };
    const windowAt: Rect = { left: 0, top: 60, width: 1280, height: 740 };
    const stages = { card: cardAt, window: windowAt };
    let s = walk(opened(letters(3), cardAt, { card: true }), [{ t: "expand" }, { t: "in" }], stages);
    for (let i = 0; !zoomOutDisabled(s); i++) {
      assert.ok(i < 20, "Zoom out never reached the floor");
      s = walk(s, [{ t: "out" }], stages);
    }
    assert.equal(s.grown, true, "never back to the card while Expand is pressed");
    close(s.view.scale, viewerFrame(s)!.min, "the window's page fit");
    assert.ok(viewerFrame(s)!.min < 1);
  });

  test("Reset zoom is hidden at the width fit, and shown above and below it", () => {
    const small: Rect = { left: 0, top: 100, width: 320, height: 380 };
    const s = opened(letters(2), small);
    assert.equal(resetShown(s), false);
    assert.equal(zoomOutDisabled(s), false, "Zoom out still goes to the page fit");
    assert.equal(resetShown(viewerStep(s, { t: "in" })), true);
    assert.equal(resetShown(viewerStep(s, { t: "out" })), true);
    assert.equal(viewerStep(viewerStep(s, { t: "out" }), { t: "reset" }).view.scale, 1);
  });

  test("a double tap below the width fit goes to the width fit about the tap", () => {
    const small: Rect = { left: 0, top: 100, width: 320, height: 380 };
    const below = viewerStep(opened(letters(3), small), { t: "out" });
    assert.ok(below.view.scale < 1);
    const tap = { x: 160, y: 200 };
    const before = pageRects(below)![0]!;
    const after = viewerStep(below, { t: "double", at: tap });
    assert.equal(after.view.scale, 1);
    const page = pageRects(after)![0]!;
    // The point of the page under the tap stays under it, as far as clamping lets it.
    close((tap.y - page.top) / page.height, (tap.y - before.top) / before.height, "down the page", 1e-3);
  });

  test("a column that fits whole: every page shows, and the page keys and buttons do nothing", () => {
    const two = layoutPages([
      { width: 390, height: 200 },
      { width: 390, height: 200 },
    ]);
    const s = opened(two);
    assert.equal(allPagesShown(s), true);
    assert.equal(pageStep(s, 1), null);
    assert.equal(pageStep(s, -1), null);
    for (const key of ["PageDown", "PageUp", "Home", "End", " "]) assert.equal(viewerKey(key, s, { onDialog: true }), null, key);
  });
});

describe("several pages: where the reader is", () => {
  test("the current page: page 1 at the top, the most height showing mid-way, the earlier on a tie, the last at the end however short", () => {
    const withShortLast = layoutPages([
      { width: 390, height: 390 },
      { width: 390, height: 390 },
      { width: 390, height: 390 },
      { width: 390, height: 40 },
    ]);
    const s = opened(withShortLast);
    assert.equal(currentPage(s), 0);
    const gap = 390 * PAGE_GAP_SHARE;
    // Page 2's top 100 px below the stage's top: page 1 shows 100 - gap px, page 2 all 390, page 3 the rest.
    const mid = viewerStep(s, { t: "scroll", dx: 0, dy: 390 + gap - 100 });
    assert.equal(currentPage(mid), 1);
    // A tie between two pages each showing 350 px goes to the earlier.
    const tieStage: Rect = { left: 0, top: 0, width: 390, height: 700 + gap };
    const tie = viewerStep(opened(withShortLast, tieStage), { t: "scroll", dx: 0, dy: 40 });
    const shown = pageRects(tie)!.map((r) => Math.min(r.top + r.height, tieStage.height) - Math.max(r.top, 0));
    close(shown[0]!, shown[1]!, "a tie");
    assert.equal(currentPage(tie), 0);
    const end = viewerStep(s, { t: "end" });
    assert.equal(currentPage(end), 3, "the short last page at the very end");
  });

  test("Next page and Previous page across mixed heights move the view with every press and reach both ends", () => {
    let s = opened(mixed);
    const seen: number[] = [];
    for (let i = 0; pageStep(s, 1) !== null; i++) {
      assert.ok(i < 10, "Next page never reached the end");
      const before = s.view.y;
      const step = pageStep(s, 1)!;
      s = viewerStep(s, { t: "step", dir: 1 });
      assert.ok(s.view.y < before - 1, "a press that did not move the view");
      assert.equal(currentPage(s), step.page, "the indicator shows the page the press brought");
      seen.push(step.page);
    }
    assert.equal(currentPage(s), 3);
    assert.equal(seen.at(-1), 3, "Next page clamped at the end shows the last page");
    for (let i = 0; pageStep(s, -1) !== null; i++) {
      assert.ok(i < 10, "Previous page never reached the start");
      const before = s.view.y;
      s = viewerStep(s, { t: "step", dir: -1 });
      assert.ok(s.view.y > before + 1, "a press that did not move the view");
    }
    assert.equal(currentPage(s), 0);
    assert.equal(s.view.y, 0);
  });

  test("the same, zoomed out below the width fit and zoomed in, keeping the zoom and the place across", () => {
    const short: Rect = { left: 0, top: 0, width: 390, height: 300 };
    for (const zoom of [{ t: "out" }, { t: "in" }] as const) {
      let s = viewerStep(opened(mixed, short), zoom);
      const scale = s.view.scale;
      assert.notEqual(scale, 1, zoom.t);
      if (zoom.t === "in") s = viewerStep(s, { t: "arrow", dx: 1, dy: 0 });
      const x = s.view.x;
      let presses = 0;
      while (pageStep(s, 1) !== null) {
        const before = s.view.y;
        s = viewerStep(s, { t: "step", dir: 1 });
        assert.ok(s.view.y < before - 1, `${zoom.t}: a press that did not move the view`);
        assert.equal(s.view.scale, scale, `${zoom.t}: the zoom changed`);
        assert.equal(s.view.x, x, `${zoom.t}: the place across changed`);
        assert.ok(++presses < 20);
      }
      assert.equal(currentPage(s), 3, zoom.t);
      while (pageStep(s, -1) !== null) {
        const before = s.view.y;
        s = viewerStep(s, { t: "step", dir: -1 });
        assert.ok(s.view.y > before + 1, `${zoom.t}: a press that did not move the view`);
        assert.ok(++presses < 40);
      }
      assert.equal(currentPage(s), 0, zoom.t);
    }
  });

  test("the indicator holds the page a button brought until the view moves another way", () => {
    // A short stage, so after Next page the next page shows more of itself than the one at the top.
    const short: Rect = { left: 0, top: 0, width: 390, height: 300 };
    const s = viewerStep(viewerStep(opened(mixed, short), { t: "scroll", dx: 0, dy: 300 }), { t: "step", dir: 1 });
    assert.equal(s.aligned, 1);
    assert.equal(currentPage(s), 1);
    const moved = viewerStep(s, { t: "scroll", dx: 0, dy: 1 });
    assert.equal(moved.aligned, null);
    // A layout that moves nothing keeps it.
    assert.equal(viewerStep(s, { t: "layout", stage: short }).aligned, 1);
  });

  test("with no page top past the edge, Next page goes to the end and Previous page to the start (SOL-11)", () => {
    // A last page taller than the stage.
    const tall = layoutPages([
      { width: 390, height: 390 },
      { width: 390, height: 1000 },
    ]);
    let s = viewerStep(opened(tall), { t: "step", dir: 1 });
    close(pageRects(s)![1]!.top, 0, "page 2 at the top");
    const next = pageStep(s, 1);
    assert.ok(next, "Next page is enabled while the tall last page goes on below");
    s = next.state;
    assert.equal(next.page, 1);
    assert.equal(pageStep(s, 1), null, "at the end");
    // The top of a magnified last page, taller than the stage at this zoom.
    let m = viewerStep(viewerStep(opened(mixed), { t: "in" }), { t: "in" });
    assert.ok(pageRects(m)![3]!.height > 700);
    for (let i = 0; pageRects(m)![3]!.top > 1; i++) {
      assert.ok(i < 20, "Next page never brought the last page up");
      m = viewerStep(m, { t: "step", dir: 1 });
    }
    const last = pageStep(m, 1);
    assert.ok(last, "Next page is enabled at the top of a magnified last page");
    assert.equal(last.page, 3);
    assert.equal(pageStep(last.state, 1), null);
    // Half a pixel from the start.
    const nudged = viewerStep(opened(mixed), { t: "scroll", dx: 0, dy: 0.5 });
    const back = pageStep(nudged, -1);
    assert.ok(back, "Previous page is enabled half a pixel from the start");
    assert.equal(back.state.view.y, 0);
    assert.equal(back.page, 0);
    // Within the end tolerance there is nothing to move.
    assert.equal(pageStep(viewerStep(opened(mixed), { t: "scroll", dx: 0, dy: END_PX / 2 }), -1), null);
  });

  test("pages load near the screen: within one stage height, kept until three away, on tall and on wide pages", () => {
    const tall = opened(letters(30));
    // A Letter page is about 504 px tall on this phone, so the pages in view and within one stage below are 1 to 3.
    assert.deepEqual(visiblePages(tall, 0), [0, 1]);
    assert.deepEqual(visiblePages(tall, MOUNT_AHEAD), [0, 1, 2]);
    assert.deepEqual(visiblePages(tall, KEEP_AHEAD), [0, 1, 2, 3, 4, 5]);
    const wide = opened(layoutPages(Array.from({ length: 30 }, () => ({ width: 2048, height: 1584 }))));
    // Wide pages are about 300 px tall, so more of them lie within the same distance.
    assert.deepEqual(visiblePages(wide, MOUNT_AHEAD), [0, 1, 2, 3, 4]);
    // Mounted ones stay until three stages away, and a fast fling mounts none.
    const mounted = mountedPages(new Set(), tall, false);
    assert.deepEqual([...mounted], [0, 1, 2]);
    const further = viewerStep(tall, { t: "scroll", dx: 0, dy: 1400 });
    const slow = mountedPages(mounted, further, false);
    assert.ok(slow.has(0), "page 1 unmounted too soon");
    assert.ok(slow.has(5), "the pages now near the screen did not mount");
    const fast = mountedPages(mounted, further, true);
    assert.deepEqual([...fast], [0, 1, 2], "a fast fling mounted a page, or dropped one still near");
    const far = viewerStep(tall, { t: "end" });
    assert.equal(mountedPages(slow, far, false).has(0), false, "page 1 stayed mounted at the end");
    // Nearest first, so the pages in view load before the ones beyond.
    assert.equal(visiblePages(viewerStep(tall, { t: "scroll", dx: 0, dy: 5000 }), MOUNT_AHEAD)[0], 9);
  });
});

describe("several pages: keys, wheel and fling", () => {
  test("PageDown and PageUp move a stage height less a tenth, Space only from the dialog, Home and End to the ends", () => {
    const s = opened(letters(5));
    const down = viewerStep(s, viewerKey("PageDown", s)!);
    close(down.view.y, -700 * 0.9, "PageDown");
    close(viewerStep(down, viewerKey("PageUp", down)!).view.y, 0, "PageUp");
    assert.deepEqual(viewerKey(" ", s, { onDialog: true }), { t: "screen", dir: 1 });
    assert.deepEqual(viewerKey(" ", s, { onDialog: true, shift: true }), { t: "screen", dir: -1 });
    assert.equal(viewerKey(" ", s, { onDialog: false }), null, "Space on a button presses the button");
    const end = viewerStep(s, viewerKey("End", s)!);
    assert.equal(currentPage(end), 4);
    assert.equal(pageStep(end, 1), null);
    const home = viewerStep(end, viewerKey("Home", end)!);
    assert.equal(home.view.y, 0);
    assert.equal(currentPage(home), 0);
    // One page keeps today's keys.
    const one = measured(viewerStart(true));
    for (const key of ["PageDown", "PageUp", "Home", "End", " "]) assert.equal(viewerKey(key, one, { onDialog: true }), null, key);
  });

  test("the wheel scrolls by pixels, lines and pages, and across with Shift or once zoomed wider than the stage", () => {
    const stage = { width: 390, height: 700 };
    assert.deepEqual(wheelScroll({ deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: false }, stage), { dx: 0, dy: 120 });
    assert.deepEqual(wheelScroll({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, stage), { dx: 0, dy: 3 * WHEEL_LINE_PX });
    assert.deepEqual(wheelScroll({ deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: false }, stage), { dx: 0, dy: 700 });
    assert.deepEqual(wheelScroll({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true }, stage), { dx: 100, dy: 0 });
    assert.deepEqual(wheelScroll({ deltaX: 30, deltaY: 0, deltaMode: 0, shiftKey: false }, stage), { dx: 30, dy: 0 });
    // A line-mode notch scrolls at least 100 px.
    const s = opened(letters(3));
    assert.ok(-viewerStep(s, { t: "scroll", ...wheelScroll({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, stage) }).view.y >= 100);
    // Across only once zoomed wider than the stage.
    assert.equal(viewerStep(s, { t: "scroll", dx: 50, dy: 0 }).view.x, s.view.x);
    const zoomed = viewerStep(s, { t: "in" });
    assert.ok(viewerStep(zoomed, { t: "scroll", dx: 50, dy: 0 }).view.x < zoomed.view.x);
  });

  test("a fling travels as far in the same time at 60 and at 120 frames a second, and ends under a small speed", () => {
    const run = (fps: number) => {
      let v = { x: 0, y: -3 };
      let travelled = 0;
      for (let frame = 0; frame < fps; frame++) {
        const step = flingStep(v, 1000 / fps);
        travelled += step.dy;
        v = step.velocity;
      }
      return travelled;
    };
    close(run(60), run(120), "distance", 1e-6);
    assert.ok(run(60) < -500, "a quick flick goes a good way");
    assert.equal(flingStep({ x: 0, y: FLING_STOP * 1.01 }, 16).done, true);
    assert.equal(flingStep({ x: 0, y: 2 }, 16).done, false);
  });

  test("a fling stops at the document's end", () => {
    let s = opened(letters(3));
    let v = { x: 0, y: -50 };
    let frames = 0;
    for (;;) {
      const step = flingStep(v, 16);
      v = step.velocity;
      const before = s.view;
      s = viewerStep(s, { t: "pan", base: s.view, dx: step.dx, dy: step.dy });
      frames++;
      if (step.done || (s.view.x === before.x && s.view.y === before.y)) break;
      assert.ok(frames < 1000);
    }
    assert.equal(pageStep(s, 1), null, "at the end");
    assert.ok(frames < 60, "the fling ran on past the end");
  });

  test("the finger's speed over its last moves, and none once it rested", () => {
    const moves = [
      { at: 0, p: { x: 0, y: 0 } },
      { at: 950, p: { x: 0, y: -10 } },
      { at: 1000, p: { x: 0, y: -60 } },
    ];
    assert.deepEqual(releaseVelocity(moves, 1000), { x: 0, y: -1 });
    assert.deepEqual(releaseVelocity(moves, 1300), { x: 0, y: 0 });
    assert.equal(flingIsFast({ x: 0, y: 3 }, { width: 390, height: 700 }), true);
    assert.equal(flingIsFast({ x: 0, y: 1 }, { width: 390, height: 700 }), false);
  });

  test("a touch during a fling only stops it, and is no tap", () => {
    assert.equal(isTap({ moved: false, lifted: true, stoppedFling: true }), false);
    assert.equal(isTap({ moved: false, lifted: true, stoppedFling: false }), true);
    assert.equal(isTap({ moved: true, lifted: true, stoppedFling: false }), false);
    assert.equal(isTap({ moved: false, lifted: false, stoppedFling: false }), false);
  });
});

describe("several pages: the place is kept", () => {
  const cardAt: Rect = { left: 280, top: 120, width: 720, height: 600 };
  const windowAt: Rect = { left: 0, top: 60, width: 1280, height: 740 };
  const stages = { card: cardAt, window: windowAt };

  test("the card growing and shrinking, Expand, Zoom out to a fit and Reset zoom keep the page at the stage's center", () => {
    const s = opened(letters(30), cardAt, { card: true, start: 13 });
    const before = atCenter(s);
    assert.equal(before.page, 13);
    for (const actions of [[{ t: "in" }], [{ t: "expand" }], [{ t: "in" }, { t: "out" }], [{ t: "in" }, { t: "in" }, { t: "reset" }], [{ t: "in" }, { t: "in" }, { t: "out" }, { t: "out" }]] as ViewerAction[][]) {
      const after = atCenter(walk(s, actions, stages));
      assert.equal(after.page, 13, actions.map((a) => a.t).join(", "));
      close(after.y, before.y, `${actions.map((a) => a.t).join(", ")}: down the page`, 1);
    }
    // Pressed and released, Expand comes back to the same place.
    assert.equal(atCenter(walk(s, [{ t: "expand" }, { t: "expand" }], stages)).page, 13);
    // A double tap back to the width fit keeps it too.
    const tapped = walk(s, [{ t: "in" }, { t: "double", at: { x: 640, y: 370 } }, { t: "double", at: { x: 100, y: 100 } }], stages);
    assert.equal(atCenter(tapped).page, 13);
  });

  test("a phone turned from 390 x 844 to 844 x 390 on page 14 keeps page 14 at the stage's center", () => {
    const portrait: Rect = { left: 0, top: 100, width: 390, height: 744 };
    const landscape: Rect = { left: 0, top: 60, width: 844, height: 330 };
    const s = opened(letters(30), portrait, { start: 13 });
    assert.equal(atCenter(s).page, 13);
    const turned = viewerStep(s, { t: "layout", stage: landscape });
    assert.equal(atCenter(turned).page, 13);
    assert.equal(turned.view.scale, 1, "still at the width fit");
    assert.equal(atCenter(viewerStep(turned, { t: "layout", stage: portrait })).page, 13);
  });

  test("a page a page button brought to the top stays there, with the indicator on it, as the phone turns", () => {
    const portrait: Rect = { left: 0, top: 100, width: 390, height: 744 };
    const landscape: Rect = { left: 0, top: 60, width: 844, height: 330 };
    // Short pages: with page 2 at the top, the stage's center lies on page 3.
    const s = viewerStep(opened(mixed, portrait), { t: "step", dir: 1 });
    assert.equal(currentPage(s), 1);
    assert.equal(atCenter(s).page, 2);
    const turned = viewerStep(s, { t: "layout", stage: landscape });
    assert.equal(currentPage(turned), 1);
    close(pageRects(turned)![1]!.top, 0, "page 2's top");
    // The view moving any other way lets the indicator go.
    assert.equal(viewerStep(turned, { t: "scroll", dx: 0, dy: 5 }).aligned, null);
  });

  test("a start at a remembered page puts its top at the stage's top", () => {
    const s = opened(letters(30), phone, { start: 5 });
    close(pageRects(s)![5]!.top, 0, "page 6's top");
    assert.equal(currentPage(s), 5);
    assert.equal(s.start, null);
    // Another showing starts at its own page once laid out again.
    const next = viewerStep(viewerStep(s, { t: "pages", start: 2 }), { t: "layout", layout: letters(30) });
    close(pageRects(next)![2]!.top, 0, "page 3's top");
    const fresh = viewerStep(viewerStep(s, { t: "pages" }), { t: "layout", layout: letters(30) });
    assert.equal(fresh.view.y, 0);
    // A remembered last page that cannot reach the top still reads as the page the reader was on.
    const short = opened(mixed, phone, { start: 2 });
    assert.equal(currentPage(short), 2);
    assert.equal(pageStep(short, 1) !== null, true, "Next page still goes to the end");
  });
});

describe("focus when a control leaves under a step (PDF-P-34)", () => {
  test("Reset zoom pressed from magnified hands focus to Zoom out, which still goes to the page fit", () => {
    const cardAt: Rect = { left: 280, top: 120, width: 720, height: 600 };
    const windowAt: Rect = { left: 0, top: 60, width: 1280, height: 740 };
    const magnified = walk(opened(letters(3), cardAt, { card: true }), [{ t: "in" }, { t: "in" }], { card: cardAt, window: windowAt });
    const reset = walk(magnified, [{ t: "reset" }], { card: cardAt, window: windowAt });
    assert.equal(resetShown(reset), false);
    assert.equal(focusHandOff("reset", reset), "out");
    // One page has nowhere lower to go, so Zoom in takes it.
    assert.equal(focusHandOff("reset", measured(viewerStart(true))), "in");
  });

  test("a page button at an end hands focus to the other, and Zoom out at the floor to Zoom in", () => {
    const end = viewerStep(opened(mixed), { t: "end" });
    assert.equal(focusHandOff("next", end), "prev");
    assert.equal(focusHandOff("prev", end), null, "Previous page stays enabled");
    assert.equal(focusHandOff("prev", opened(mixed)), "next");
    assert.equal(focusHandOff("out", opened(mixed)), "in");
  });
});
