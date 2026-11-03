import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CSSProperties, ReactElement } from "react";
import { statusBand, theme } from "../lib/theme.ts";

const { createElement } = await import("react");
const { Dialog, DIALOG_PHONE_MAX, fillsScreen } = await import("./Dialog.tsx");
const { drawn } = await import("./testing/drawn.ts");

/*
 * The iPhone home-screen app's black strip under its status bar on a light
 * page (docs/design/design-v1-light-theme.md 6.4, D-261102-368). A dialog
 * stands in the top layer, over App's own strip, so every backdrop draws
 * the strip itself, and a whole-screen card, which covers its backdrop,
 * draws it too. An inset shadow the safe top tall in the dialog's own
 * zoomed px, so it takes no room and needs no padding (the backdrop has
 * none).
 */

/** The dialog element and its card, as Dialog draws them for `props`. */
function draw(props: Partial<Parameters<typeof Dialog>[0]>): { backdrop: CSSProperties; card: CSSProperties } {
  // Just enough page for Dialog's render: its portal's target and the focus its modal hook reads.
  const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { document: { body: { nodeType: 1 }, activeElement: null }, HTMLElement: class {} });
  try {
    const portal = drawn(Dialog, { title: "A dialog", onClose() {}, children: createElement("p", null, "Body"), ...props }) as unknown as { children: ReactElement<{ children: ReactElement<{ style: CSSProperties; children: ReactElement<{ style: CSSProperties }> }> }> };
    const dialog = portal.children.props.children;
    return { backdrop: dialog.props.style, card: dialog.props.children.props.style };
  } finally {
    Object.assign(globalThis, previous);
  }
}

describe("the status strip in a dialog", () => {
  test("every backdrop draws it, at the interface size's scale or at 1 where the dialog does not zoom", () => {
    assert.equal(draw({}).backdrop.boxShadow, statusBand(1));
    assert.equal(draw({ zoom: false, scrim: theme.color.overlay }).backdrop.boxShadow, statusBand(1));
    assert.equal(draw({ phone: "sheet" }).backdrop.boxShadow, statusBand(1));
  });

  test("a whole-screen card draws it over its own shadow, and a card in the middle keeps its shadow alone", () => {
    assert.equal(draw({ full: true }).card.boxShadow, `${statusBand(1)}, ${theme.shadow.dialog}`);
    assert.equal(draw({}).card.boxShadow, theme.shadow.dialog);
  });

  test("the strip's height is the safe top in the element's own px", () => {
    assert.equal(statusBand(1.3), `inset 0 calc(${theme.safe.top} / 1.3) 0 0 var(--rvtt-status-band, transparent)`);
  });

  test("a card fills the screen when asked, or on a phone unless it is a sheet", () => {
    assert.equal(fillsScreen(1280, { full: true }), true);
    assert.equal(fillsScreen(1280, {}), false);
    assert.equal(fillsScreen(DIALOG_PHONE_MAX - 1, {}), true);
    assert.equal(fillsScreen(DIALOG_PHONE_MAX - 1, { phone: "fill" }), true);
    assert.equal(fillsScreen(DIALOG_PHONE_MAX - 1, { phone: "sheet" }), false);
    assert.equal(fillsScreen(DIALOG_PHONE_MAX, {}), false);
  });
});
