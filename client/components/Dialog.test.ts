import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tokenPattern } from "./testing/tokenPattern.ts";

/*
 * Escape in the journal's or the monster's editor with unsaved changes
 * asks before it discards, and a second Escape discards. Shown as plain
 * text, the question was never read out, so a screen reader user heard
 * nothing between the two (LPD-DESK-8).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DiscardQuestion, dialogCard, DIALOG_PHONE_MAX, fillsScreen, TALL_SHEET_GAP } = await import("./Dialog.tsx");
const { theme } = await import("../lib/theme.ts");

describe("the question an editor asks before it discards", () => {
  test("is an alert, so it is read out as it appears", () => {
    const markup = renderToStaticMarkup(createElement(DiscardQuestion));
    assert.match(markup, /^<span role="alert"[^>]*>Throw away your changes\?<\/span>$/);
  });
});

/*
 * The handout viewer fills the window on a short layout and once it grows
 * (docs/design/design-v1-layout-hierarchy.md 5.1), where a computer's card would
 * leave dim room around it. `full` gives any width the phone's card.
 */
describe("the shape of a dialog's card", () => {
  const screen = {
    width: "100%",
    height: "100%",
    border: "none",
    borderRadius: 0,
    paddingTop: theme.safe.top,
    paddingBottom: theme.safe.bottom,
    paddingLeft: theme.safe.left,
    paddingRight: theme.safe.right,
  };

  test("full takes the whole screen inside the safe areas at a computer's width", () => {
    for (const width of [DIALOG_PHONE_MAX, 844, 1280]) {
      assert.deepEqual(dialogCard(width, { full: true, width: "lg" }), { card: screen, bottom: false }, `at ${width}`);
      assert.deepEqual(dialogCard(width, { full: true, phone: "sheet" }), { card: screen, bottom: false }, `a sheet at ${width}`);
    }
  });

  test("without it a computer keeps the card, and a phone the whole screen or a sheet", () => {
    const card = dialogCard(1280, { width: "lg", phone: "fill" });
    assert.equal(card.bottom, false);
    assert.equal(card.card.width, `min(${theme.layout.dialog.lg}px, calc(100% - ${theme.space(8)}px))`);
    assert.equal(card.card.height, `min(calc(100% - ${theme.space(8)}px), 760px)`);
    assert.deepEqual(dialogCard(DIALOG_PHONE_MAX - 1, { width: "lg" }), { card: screen, bottom: false });
    assert.equal(dialogCard(390, { phone: "sheet" }).bottom, true);
  });
});

/*
 * The Music window's tall sheet (docs/design/design-v1-music-player.md 3.2):
 * on a phone a bottom card as tall as the screen less its top inset and a
 * 12 px strip of the room, keeping the bottom card's grabber, swipe and,
 * with a mouse, PS-B's Down arrow as Put away sheet with no Up, since it has
 * no full stand. On a computer it is an editor's card, 1040 px at `xl`.
 */
describe("the tall sheet", () => {
  test("a phone gets a bottom card one height tall, under the top inset and a strip of the room, and a computer the editor's card", () => {
    assert.equal(TALL_SHEET_GAP, 12);
    for (const width of [320, 390, DIALOG_PHONE_MAX - 1]) {
      const { card, bottom } = dialogCard(width, { phone: "tall", width: "xl" });
      assert.equal(bottom, true, `at ${width}`);
      assert.equal(card.height, `calc(100% - ${theme.safe.top} - 12px)`);
      assert.equal(card.maxHeight, undefined, "one height whatever it shows");
      assert.equal(card.borderRadius, `${theme.radius.lg}px ${theme.radius.lg}px 0 0`);
      assert.equal(card.paddingBottom, theme.safe.bottom);
      assert.equal(fillsScreen(width, { phone: "tall" }), false, "a strip of the room shows above it");
    }
    assert.equal(dialogCard(390, { phone: "sheet" }).card.maxHeight, "92%", "a sheet still fits its content");
    const computer = dialogCard(1440, { phone: "tall", width: "xl" });
    assert.equal(computer.bottom, false);
    assert.equal(theme.layout.dialog.xl, 1040);
    assert.equal(computer.card.width, `min(1040px, calc(100% - ${theme.space(8)}px))`);
    assert.equal(computer.card.height, `min(calc(100% - ${theme.space(8)}px), 760px)`, "an editor's one height");
  });

  test("its header has the grabber, and with a mouse Put away sheet and no Expand sheet", async () => {
    const { Dialog } = await import("./Dialog.tsx");
    const { drawn } = await import("./testing/drawn.ts");
    const g = globalThis as Record<string, unknown>;
    const previous = { window: g.window, document: g.document, HTMLElement: g.HTMLElement, matchMedia: g.matchMedia };
    // Just enough page for a phone's render: its width, the portal's target, the focus the modal hook reads, and a mouse or none.
    const draw = (mouse: boolean, phone: "tall" | "fill") => {
      Object.assign(g, {
        window: { innerWidth: 390, innerHeight: 844 },
        document: { body: { nodeType: 1 }, activeElement: null },
        HTMLElement: class {},
        matchMedia: (q: string) => ({ matches: mouse && q === "(any-pointer: fine)", addEventListener() {}, removeEventListener() {} }),
      });
      const portal = drawn(Dialog, { title: "Music", onClose() {}, phone, width: "xl", children: createElement("p", null, "Up next") }) as unknown as { children: ReturnType<typeof createElement> };
      return renderToStaticMarkup(portal.children);
    };
    try {
      const tall = draw(true, "tall");
      assert.match(tall, /data-sheet-grabber/, "the bottom card's grabber");
      assert.match(tall, /<button[^>]*data-sheet-step="down"[^>]*>/);
      assert.match(tall, /aria-label="Put away sheet"/);
      assert.doesNotMatch(tall, /data-sheet-step="up"/, "no full stand, so no Up");
      assert.doesNotMatch(tall, /Expand sheet/);
      assert.match(tall, new RegExp(`height:calc\\(100% - ${escaped(theme.safe.top)} - 12px\\)`));
      const touch = draw(false, "tall");
      assert.match(touch, /data-sheet-grabber/, "a phone's finger swipes it");
      assert.doesNotMatch(touch, /data-sheet-step/, "and gets no arrows");
      assert.doesNotMatch(draw(true, "fill"), /data-sheet-grabber|data-sheet-step/, "a whole-screen card does not swipe");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete g[key];
        else g[key] = value;
      }
    }
  });
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * A dialog opened from a held page, such as Change it on the group save
 * page, portals out of the page's disabled fieldset, so its controls act.
 * They must look it too: the dialog ends the held group (Held.tsx).
 */
describe("a dialog opened inside a held group", () => {
  test("draws its controls enabled, since its portal leaves the held fieldset", async () => {
    const { Dialog } = await import("./Dialog.tsx");
    const { Held } = await import("./Held.tsx");
    const { Button } = await import("./Button.tsx");
    const { drawn } = await import("./testing/drawn.ts");
    // Just enough page for Dialog's render: its portal's target and the focus its modal hook reads.
    const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };
    Object.assign(globalThis, { document: { body: { nodeType: 1 }, activeElement: null }, HTMLElement: class {} });
    try {
      const button = createElement(Button, { onClick() {} }, "Save");
      const portal = drawn(Dialog, { title: "Change it", onClose() {}, children: button }, (child) => createElement(Held, { held: true, children: child })) as unknown as { children: ReturnType<typeof createElement> };
      // The portal's content, drawn where the opener is: inside the held group, as React's context reaches it.
      const markup = renderToStaticMarkup(createElement(Held, { held: true, children: portal.children }));
      assert.match(markup, />Save</);
      assert.doesNotMatch(markup, new RegExp(`color:${tokenPattern(theme.color.textDisabled)}`, "i"));
      assert.doesNotMatch(markup.replace(/^<fieldset disabled=""[^>]*>/, ""), /<button[^>]*\sdisabled=""/);
    } finally {
      Object.assign(globalThis, previous);
    }
  });
});
