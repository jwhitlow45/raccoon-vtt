import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { SHEET_MIN_HEIGHT, sheetCap, sheetFoot, sheetKeyboard, sheetMaxHeight, sheetRoom, sheetTop } from "../components/sheetCap.ts";
import { fieldScroll, keyboardView, keyboardViewNow, opensKeyboard, subscribeKeyboard, type FocusTarget, type ViewportSource } from "./keyboardInset.ts";

/** A 390 x 844 phone, as the Room lays its sheet: the 52 px top bar and the 60 px toolbar, no safe areas. */
const PHONE = { height: 844, safeTop: 0, safeBottom: 0, insetTop: 52, insetBottom: 60 };
/** iOS Safari's number pad and its bar on that phone, near enough: the visual viewport is 300 px shorter. */
const KEYBOARD = 300;
const field: FocusTarget = { tagName: "INPUT", type: "text" };

const shown = (height: number, offsetTop = 0, scale = 1): ViewportSource => ({ height, offsetTop, scale });

describe("the keyboard's view, from the visual viewport", () => {
  test("a keyboard 300 px tall hides the layout's last 300 px", () => {
    assert.deepEqual(keyboardView({ layoutHeight: 844, viewport: shown(844 - KEYBOARD), field: true }), { top: 0, height: 544, inset: 300 });
  });

  test("a page Safari panned up to show a field hides its top, and less of its bottom", () => {
    assert.deepEqual(keyboardView({ layoutHeight: 844, viewport: shown(544, 120), field: true }), { top: 120, height: 544, inset: 180 });
    // Panned all the way, nothing of the bottom is hidden, and the top still is.
    assert.deepEqual(keyboardView({ layoutHeight: 844, viewport: shown(544, 300), field: true }), { top: 300, height: 544, inset: 0 });
  });

  test("none without a visual viewport, without a field in focus, or with all of the page in view", () => {
    assert.equal(keyboardView({ layoutHeight: 844, viewport: null, field: true }), null);
    assert.equal(keyboardView({ layoutHeight: 844, viewport: shown(544), field: false }), null);
    assert.equal(keyboardView({ layoutHeight: 844, viewport: shown(844), field: true }), null);
    // Android Chrome resized the page itself (interactive-widget=resizes-content): the layout is as short as the visible area.
    assert.equal(keyboardView({ layoutHeight: 544, viewport: shown(544), field: true }), null);
    assert.equal(keyboardView({ layoutHeight: 844, viewport: shown(843.5), field: true }), null, "half a pixel is rounding, not a keyboard");
  });

  test("a pinch zoom shrinks the visual viewport too, and is no keyboard", () => {
    assert.equal(keyboardView({ layoutHeight: 844, viewport: shown(422, 200, 2), field: true }), null);
  });
});

describe("what opens the keyboard", () => {
  test("a text field of any typed kind, a text area and editable text", () => {
    for (const type of [undefined, "", "text", "search", "number", "email", "tel", "url", "password", "TEXT"]) assert.equal(opensKeyboard({ tagName: "INPUT", type }), true, `type ${type}`);
    assert.equal(opensKeyboard({ tagName: "TEXTAREA" }), true);
    assert.equal(opensKeyboard({ tagName: "DIV", isContentEditable: true }), true);
  });

  test("not a button, a box, a slider, a picker or a list, nor a field that cannot be typed in", () => {
    for (const type of ["button", "submit", "checkbox", "radio", "range", "color", "file", "date"]) assert.equal(opensKeyboard({ tagName: "INPUT", type }), false, `type ${type}`);
    for (const tagName of ["BUTTON", "SELECT", "A", "BODY"]) assert.equal(opensKeyboard({ tagName }), false, tagName);
    assert.equal(opensKeyboard({ tagName: "INPUT", type: "text", readOnly: true }), false);
    assert.equal(opensKeyboard({ tagName: "TEXTAREA", disabled: true }), false);
    assert.equal(opensKeyboard({ tagName: "INPUT", type: "text", inputMode: "none" }), false);
    assert.equal(opensKeyboard(null), false);
  });
});

/** A visual viewport with its events, which a test sizes as the keyboard would. */
class FakeViewport extends EventTarget implements ViewportSource {
  height = 844;
  offsetTop = 0;
  scale = 1;
  show(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event("resize"));
  }
}

describe("the keyboard's view as the page hears it, with a fake visual viewport", () => {
  const viewport = new FakeViewport();
  const doc = Object.assign(new EventTarget(), { activeElement: null as FocusTarget | null });
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  g.window = Object.assign(new EventTarget(), { innerHeight: 844, visualViewport: viewport });
  g.document = doc;
  after(() => {
    delete g.window;
    delete g.document;
  });

  test("follows the viewport's resize and the field's focus, and tells each listener once a change", () => {
    let heard = 0;
    const stop = subscribeKeyboard(() => heard++);
    assert.equal(keyboardViewNow(), null);
    doc.activeElement = field;
    doc.dispatchEvent(new Event("focusin"));
    assert.equal(heard, 0, "focus alone, before the keyboard is up, changes nothing");
    viewport.show(844 - KEYBOARD);
    assert.deepEqual(keyboardViewNow(), { top: 0, height: 544, inset: 300 });
    assert.equal(heard, 1);
    viewport.show(844 - KEYBOARD);
    assert.equal(heard, 1, "the same size again is no change");
    const before = keyboardViewNow();
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(keyboardViewNow(), before, "the same view keeps its identity, so a render that reads it again is skipped");
    // Safari pans the page with a scroll of the visual viewport, its size the same.
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event("scroll"));
    assert.deepEqual(keyboardViewNow(), { top: 120, height: 544, inset: 180 });
    assert.equal(heard, 2);
    doc.activeElement = { tagName: "BUTTON" };
    doc.dispatchEvent(new Event("focusout"));
    assert.equal(keyboardViewNow(), null, "focus on a button: no keyboard, whatever the viewport says");
    assert.equal(heard, 3);
    stop();
    doc.activeElement = field;
    viewport.show(400);
    assert.equal(heard, 3, "nothing heard once stopped");
    assert.deepEqual(keyboardViewNow(), { top: 0, height: 400, inset: 444 }, "read afresh with no one listening");
    viewport.show(844);
    doc.activeElement = null;
  });
});

describe("the sheet's cap with the keyboard open (components/sheetCap.ts)", () => {
  const view = (height: number, offsetTop = 0, layoutHeight = 844) => keyboardView({ layoutHeight, viewport: shown(height, offsetTop), field: true });

  test("no keyboard leaves the cap as it was", () => {
    assert.equal(sheetCap({ ...PHONE, keyboard: null }), sheetCap(PHONE));
    assert.equal(sheetMaxHeight({ top: 52, bottom: 60 }, 0, null), sheetMaxHeight({ top: 52, bottom: 60 }));
    assert.equal(sheetFoot(60, null), "calc(env(safe-area-inset-bottom, 0px) + 60px)");
    assert.equal(sheetTop(52, null), "calc(env(safe-area-inset-top, 0px) + 52px)");
  });

  test("its foot stands on the keyboard, and it fits between the bars' gap and the keyboard", () => {
    const keyboard = sheetKeyboard(view(844 - KEYBOARD), 1);
    assert.deepEqual(keyboard, { top: 0, inset: 300 });
    // 844 less the 52 px bar, the 24 px gap and the 300 px keyboard, which covers the toolbar.
    assert.equal(sheetRoom({ ...PHONE, keyboard }), 844 - 52 - 24 - 300);
    assert.equal(sheetCap({ ...PHONE, keyboard }), 468);
    assert.ok(sheetCap({ ...PHONE, keyboard }) < sheetCap(PHONE));
  });

  test("a keyboard shorter than the toolbar and its safe area leaves the sheet on the toolbar", () => {
    const keyboard = sheetKeyboard(view(844 - 40), 1);
    assert.equal(sheetCap({ ...PHONE, keyboard }), sheetCap(PHONE));
    assert.equal(sheetRoom({ ...PHONE, safeBottom: 34, keyboard: sheetKeyboard(view(844 - 80), 1) }), sheetRoom({ ...PHONE, safeBottom: 34 }));
  });

  test("a page panned up keeps the gap under the visible area's top, not the bars' foot", () => {
    const keyboard = sheetKeyboard(view(544, 120), 1);
    assert.equal(sheetRoom({ ...PHONE, keyboard }), 844 - 120 - 24 - 180);
    assert.equal(sheetRoom({ ...PHONE, keyboard }), 544 - 24, "the whole visible height less the gap");
  });

  test("at 130% the keyboard's pixels are the chrome's own over 1.3, and the dock's reserve still holds", () => {
    // 390 x 844 at 130%: 649 px tall in the chrome's own pixels, the keyboard 300 / 1.3 of them.
    const keyboard = sheetKeyboard(view(844 - KEYBOARD), 1.3);
    assert.ok(keyboard);
    assert.equal(Math.round(keyboard.inset), 231);
    assert.equal(Math.round(sheetCap({ ...PHONE, height: 844 / 1.3, keyboard })), Math.round(844 / 1.3 - 52 - 24 - 300 / 1.3));
    assert.equal(Math.round(sheetCap({ ...PHONE, height: 844 / 1.3, keyboard, reserveTop: 56 })), Math.round(844 / 1.3 - 52 - 56 - 300 / 1.3));
  });

  test("never under SHEET_MIN_HEIGHT, as on a 320 x 568 phone at 130% with the turn band and the dock", () => {
    const keyboard = sheetKeyboard(view(568 - 260, 0, 568), 1.3);
    assert.ok(sheetRoom({ height: 568 / 1.3, safeTop: 0, safeBottom: 0, insetTop: 100, insetBottom: 60, reserveTop: 56, keyboard }) < SHEET_MIN_HEIGHT);
    assert.equal(sheetCap({ height: 568 / 1.3, safeTop: 0, safeBottom: 0, insetTop: 100, insetBottom: 60, reserveTop: 56, keyboard }), SHEET_MIN_HEIGHT);
  });

  test("the CSS says the same: the 120 px floor and the 60% share, with the larger of the bars and the visible top, and of the toolbar and the keyboard", () => {
    const keyboard = { top: 120, inset: 180 };
    assert.equal(sheetFoot(60, keyboard), "max(calc(env(safe-area-inset-bottom, 0px) + 60px), 180px)");
    assert.equal(sheetTop(52, keyboard), "max(calc(env(safe-area-inset-top, 0px) + 52px), 120px)");
    assert.equal(
      sheetMaxHeight({ top: 52, bottom: 60 }, 56, keyboard),
      "max(120px, min(calc(60dvh / var(--rvtt-ui, 1)), calc(100% - max(calc(env(safe-area-inset-top, 0px) + 52px), 120px) - max(calc(env(safe-area-inset-bottom, 0px) + 60px), 180px) - 56px)))",
    );
    assert.match(sheetMaxHeight({ top: 52, bottom: 60 }, 8, keyboard), / - 24px\)\)\)$/, "a reserve under the gap keeps the gap");
  });
});

describe("how far a sheet's body scrolls to show a focused field", () => {
  // A body from 400 to 800 on the screen, the keyboard hiding from 544 down.
  const visible = { top: 400, bottom: 544 };
  const margin = 8;

  test("a field under the keyboard comes up with its form, Spend and Cancel, the margin clear of the keyboard", () => {
    const field = { top: 600, bottom: 644 };
    const group = { top: 600, bottom: 692 };
    assert.equal(fieldScroll({ field, group, visible, margin }), 692 - (544 - margin));
  });

  test("a field and form already in view stay put", () => {
    assert.equal(fieldScroll({ field: { top: 420, bottom: 464 }, group: { top: 420, bottom: 520 }, visible, margin }), 0);
  });

  test("a field scrolled up past the top comes down to the margin", () => {
    assert.equal(fieldScroll({ field: { top: 360, bottom: 404 }, group: { top: 360, bottom: 404 }, visible, margin }), 360 - (400 + margin));
  });

  test("a form taller than what shows counts as the field alone, so a field in view in a long form is not moved", () => {
    assert.equal(fieldScroll({ field: { top: 420, bottom: 464 }, group: { top: 300, bottom: 1200 }, visible, margin }), 0);
    assert.equal(fieldScroll({ field: { top: 700, bottom: 744 }, group: { top: 300, bottom: 1200 }, visible, margin }), 744 - (544 - margin));
  });

  test("a field taller than what shows, such as a long text area, shows its top", () => {
    const field = { top: 600, bottom: 800 };
    assert.equal(fieldScroll({ field, group: { top: 600, bottom: 850 }, visible: { top: 400, bottom: 520 }, margin }), 600 - (400 + margin));
  });
});
