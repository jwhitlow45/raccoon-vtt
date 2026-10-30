import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";

/*
 * The dice set picker's tiles in rows of four (docs/design-v1-roll-animation.md
 * 9.2). The chosen tile drew a 2 px border where the others drew 1 px, so its
 * row stood 2 px taller than the other, and choosing a set in the other row
 * moved every tile under it (LP9-DICE-1).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DiceSetPicker, tileStyle } = await import("./DiceSetPicker.tsx");
const { setRollAnimation } = await import("./settings.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { RoomProvider } = await import("../../state/view.ts");
const { theme } = await import("../../lib/theme.ts");

/** The px numbers of a CSS shorthand, in order. */
function px(value: unknown): number[] {
  return [...String(value).matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
}

/** What a tile's border and padding add around its content, across and down. */
function frame(style: ReturnType<typeof tileStyle>): { across: number; down: number } {
  const [border] = px(style.border);
  const [vertical, horizontal] = px(style.padding);
  return { across: 2 * (border! + horizontal!), down: 2 * (border! + vertical!) };
}

describe("the dice set picker's tiles", () => {
  test("a chosen tile is the same size as the others, with or without the switch on", () => {
    for (const on of [true, false]) assert.deepEqual(frame(tileStyle(true, on)), frame(tileStyle(false, on)), `chosen and not differ with the switch ${on ? "on" : "off"}`);
  });

  test("the chosen tile still reads heavier: a strong border, in the accent while the switch is on", () => {
    assert.equal(tileStyle(true, true).border, `${theme.line.strong}px solid ${theme.color.accent}`);
    assert.equal(tileStyle(false, true).border, `${theme.line.border}px solid ${theme.color.border}`);
  });

  test("with the switch off the chosen tile keeps its mark, a dim outline with no tint, as a chosen option that cannot change now does (docs/design-v1-look-pass-2.md D37)", () => {
    assert.equal(tileStyle(true, false).border, `${theme.line.strong}px solid ${theme.color.textDisabled}`);
    assert.equal(tileStyle(true, false).background, "transparent");
    assert.equal(tileStyle(false, false).border, `${theme.line.border}px solid ${theme.color.border}`);
  });
});

/*
 * The Dice legend stood right on its tiles, and on its help with Roll
 * animation off: a fieldset's gap never reaches a rendered legend, which
 * is no grid item (docs/design-v1-spacing-pass.md S2).
 */
describe("the dice legend's gaps", () => {
  /** The picker as a room draws it, with no room loaded: it reads this device's settings alone. */
  const render = () =>
    renderToStaticMarkup(
      createElement(RoomProvider, {
        store: createStore(() => ({ view: null, roomId: "r1", connection: "open", you: null, local: { selectedIds: [], multi: false } })) as never,
        actions: { dispatch: () => 1 } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(DiceSetPicker) }),
      }),
    );
  /** The style attribute of the first element some markup opens with `open`. */
  const styleOf = (markup: string, open: RegExp) => new RegExp(`${open.source}[^>]*?style="([^"]*)"`).exec(markup)?.[1] ?? null;

  test("the help stands space(1) under the legend and the tiles space(2) under what stands above them, with Roll animation on and off, and the fieldset has no gap", () => {
    try {
      for (const on of [true, false]) {
        setRollAnimation(on);
        const markup = render();
        const fieldset = styleOf(markup, /^<fieldset/);
        assert.ok(fieldset !== null && !/(^|;)(row-)?gap:/.test(fieldset), `the fieldset sets no gap: ${fieldset}`);
        assert.match(markup, /^<fieldset[^>]*><legend[^>]*>Dice<\/legend><div style="display:grid;min-width:0">/, "one column under the legend");
        const help = styleOf(markup, /<p/);
        if (on) assert.equal(help, null, "no help while the switch is on");
        else assert.match(help ?? "", new RegExp(`margin-top:${theme.space(1)}px`), "the help stands space(1) under the legend");
        assert.match(styleOf(markup, /<div data-card-group=""/) ?? "", new RegExp(`margin-top:${theme.space(2)}px`), `the tiles stand space(2) under ${on ? "the legend" : "the help"}`);
      }
    } finally {
      setRollAnimation(true);
    }
  });
});
