import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MeasuringContext } = await import("../../components/measuring.ts");
const { Segmented } = await import("../../components/Segmented.tsx");
const { Swatches } = await import("../../components/Swatches.tsx");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { ConfirmButton, shortName, StableWords, ValueChip } = await import("./controls.tsx");

/*
 * The options kit's controls (docs/design-v1-tool-options.md 6.2 and 11),
 * drawn to static markup. The strip's fit is pages/optionsLayout.ts's,
 * tested there.
 */

function html(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element);
}

function inRoom(element: ReturnType<typeof createElement>): string {
  return html(createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }));
}

describe("a measuring copy", () => {
  test("draws a choice's options with no radio, so it never joins the real group's name", () => {
    const options = [
      { value: "a", label: "Clear fog" },
      { value: "b", label: "Add fog" },
    ];
    const real = html(createElement(Segmented, { label: "Clear or add fog", value: "a", options, onChange: () => {} }));
    const copy = html(createElement(MeasuringContext.Provider, { value: true }, createElement(Segmented, { label: "Clear or add fog", value: "a", options, onChange: () => {} })));
    assert.match(real, /type="radio"/);
    assert.doesNotMatch(copy, /<input/);
    assert.match(copy, /Clear fog/);
    const swatches = html(createElement(MeasuringContext.Provider, { value: true }, createElement(Swatches, { label: "Color", value: "#f7df00", options: ["#f7df00", "#30a46c"], onChange: () => {} })));
    assert.doesNotMatch(swatches, /<input/);
  });
});

describe("stable widths (6.2)", () => {
  test("every value stands in one cell, hidden from sight and screen readers, and only the current one shows", () => {
    const markup = html(createElement(StableWords, { current: "Mid", all: ["Thin", "Mid", "Thick"] }));
    assert.equal((markup.match(/aria-hidden="true"/g) ?? []).length, 3);
    assert.equal((markup.match(/visibility:hidden/g) ?? []).length, 3);
    assert.match(markup, /white-space:nowrap">Mid<\/span><\/span>$/, "the shown one last, unhidden");
  });

  test("a confirm button outside a slot shows only its words, as in a pane on the map", () => {
    const markup = html(createElement(ConfirmButton, { label: "Delete", confirm: "Tap again to delete", onConfirm: () => {} }));
    assert.doesNotMatch(markup, /Tap again/);
  });
});

describe("a compact choice's name (FU20B-OP-1)", () => {
  test("holds the short words it shows, before the option's own where they are not part of them", () => {
    assert.equal(shortName({ value: "straight", label: "Straight", short: "Line" }), "Line (Straight)");
    assert.equal(shortName({ value: "walking", label: "Walking", short: "Walk" }), "Walking", "Walk is part of Walking");
    assert.equal(shortName({ value: "a", label: "Clear fog" }), "Clear fog", "no short words, the option's own");
    assert.equal(shortName(undefined), undefined);
  });
});

describe("a value chip (11)", () => {
  test("is named for what it sets and its value, and says it opens a dialog", () => {
    const markup = inRoom(
      createElement(
        ValueChip,
        {
          label: "Drawing tool",
          kind: "choice",
          value: "free",
          options: [
            { key: "free", words: "Pen" },
            { key: "line", words: "Line" },
          ],
          children: "tiles",
        },
      ),
    );
    assert.match(markup, /aria-label="Drawing tool: Pen"/);
    assert.match(markup, /aria-haspopup="dialog"/);
    assert.match(markup, /aria-expanded="false"/);
    assert.doesNotMatch(markup, /tiles/, "its popover's content draws only while it is open");
  });

  test("a chip with no value is named by its visible words", () => {
    const markup = inRoom(createElement(ValueChip, { label: "Nudge", kind: "setting", plain: true, value: "nudge", options: [{ key: "nudge", words: "Nudge" }], title: "Move or size the box a pixel at a time", children: "arrows" }));
    assert.doesNotMatch(markup, /aria-label=/);
    assert.match(markup, /title="Move or size the box a pixel at a time"/);
  });
});
