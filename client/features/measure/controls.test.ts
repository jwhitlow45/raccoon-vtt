import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MeasuringContext } = await import("../../components/measuring.ts");
const { Segmented } = await import("../../components/Segmented.tsx");
const { Swatches } = await import("../../components/Swatches.tsx");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { ChoiceTiles, ConfirmButton, OptButton, OptionsStrip, shortName, StableWords, ValueChip } = await import("./controls.tsx");
const { theme } = await import("../../lib/theme.ts");

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

describe("a tile's name (7.2)", () => {
  test("a tile with spoken words is named by them, or by its title where the title holds them, as a tile's shown words are (review FU33-O4)", () => {
    const markup = html(
      createElement(ChoiceTiles, {
        label: "Mode",
        value: "walls",
        onChange: () => {},
        options: [
          { value: "walls", label: "Walls/doors", spoken: "Walls and doors" },
          { value: "heights", label: "Heights/stairs", spoken: "Heights and stairs", title: "Heights and stairs (H)" },
          { value: "ground", label: "Difficult", spoken: "Difficult ground", title: "Slows anyone crossing it" },
          { value: "brush", label: "Brush", title: "Brush (B)" },
        ],
      }),
    );
    const names = [...markup.matchAll(/<input [^>]*>/g)].map(([input]) => [/value="([^"]*)"/.exec(input)?.[1], /aria-label="([^"]*)"/.exec(input)?.[1]]);
    assert.deepEqual(names, [
      ["walls", "Walls and doors"],
      ["heights", "Heights and stairs (H)"],
      ["ground", "Difficult ground"],
      ["brush", "Brush (B)"],
    ]);
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

describe("a kept ruler's remove (docs/design-v1-look-pass-2.md D17)", () => {
  const remove = (row: boolean) =>
    inRoom(createElement(OptButton, { tone: "danger", icon: "eraser", row, label: "Remove the kept ruler: Pat · 30 ft", onClick: () => undefined, children: "Pat · 30 ft" }));

  test("is a danger row as wide as its popover, the eraser and its words at the left, as ⋯'s rows are", () => {
    const markup = remove(true);
    assert.match(markup, /justify-content:flex-start/);
    assert.match(markup, /width:100%/);
    assert.match(markup, /<svg[\s\S]*<\/svg>[\s\S]*Pat · 30 ft<\/button>/, "the eraser stands before the words");
    assert.match(markup, /aria-label="Remove the kept ruler: Pat · 30 ft"/, "its name is kept");
  });

  test("outside a popover's rows a kit button keeps the centered look", () => {
    assert.doesNotMatch(remove(false), /justify-content:flex-start/);
  });
});

/*
 * The line keeps a 14 px reading's height, so the map's reserve never
 * changes as a hint turns into a reading. A 13 px hint laid at the top of
 * that height stood above its middle, 2 px at 130%. The line is a column
 * that centers its words in its height (docs/design-v1-polish.md R8).
 */
describe("the options line (8)", () => {
  const line = (tone: "hint" | "reading", content: string) => {
    const markup = inRoom(createElement(OptionsStrip, { tool: "Ruler", line: { tone, content }, slots: [] }));
    return /<div[^>]*data-options-line="shown"[^>]*style="([^"]*)"/.exec(markup)?.[1] ?? "";
  };

  test("centers a hint's words in a reading's height", () => {
    const hint = line("hint", "Drag to measure.");
    assert.match(hint, /display:flex/);
    assert.match(hint, /flex-direction:column/);
    assert.match(hint, /justify-content:center/);
    assert.match(hint, new RegExp(`font-size:${theme.font.small}px`));
    // Its least height is a reading's line, its padding and its border, as a reading's is.
    const least = /min-height:([\d.]+)px/.exec(hint)?.[1];
    assert.equal(Number(least), theme.font.body14 * theme.leading.body + 2 * theme.space(1.5) + 2 * theme.line.border);
    assert.equal(/min-height:([\d.]+)px/.exec(line("reading", "30 ft"))?.[1], least, "a hint and a reading stand at different heights");
  });
});
