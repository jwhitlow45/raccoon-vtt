import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * This scene's "Delete scene" turns unavailable on the players' scene
 * (LP9-PLAY-2): off, but still focusable, so a button that turns off while
 * it has focus keeps it, with the line that says why as its description.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ConfirmButton } = await import("./controls.tsx");

function render(props: { disabled?: boolean; unavailable?: boolean; describedBy?: string }): string {
  return renderToStaticMarkup(createElement(ConfirmButton, { label: "Delete scene", confirm: "Tap again to delete", onConfirm() {}, ...props }));
}

describe("a two-tap button that is unavailable", () => {
  test("is aria-disabled, never natively disabled, and named by its reason's line", () => {
    const html = render({ unavailable: true, describedBy: "why" });
    assert.match(html, /aria-disabled="true"/);
    assert.doesNotMatch(html, / disabled=""/);
    assert.match(html, /aria-describedby="why"/);
  });

  test("disabled wins: natively disabled, with no aria-disabled", () => {
    const html = render({ disabled: true, unavailable: true });
    assert.match(html, / disabled=""/);
    assert.doesNotMatch(html, /aria-disabled/);
  });

  test("at rest it is neither", () => {
    const html = render({});
    assert.doesNotMatch(html, /disabled/);
  });
});
