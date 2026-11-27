import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";

/*
 * The dice set picker's tiles in rows of four (docs/design/design-v1-roll-animation.md
 * 9.2). The chosen tile drew a 2 px border where the others drew 1 px, so its
 * row stood 2 px taller than the other, and choosing a set in the other row
 * moved every tile under it (LP9-DICE-1).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DiceSetPicker, tileStyle } = await import("./DiceSetPicker.tsx");
const { resetAllFeatures, setModuleShown } = await import("../modules/store.ts");
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
  test("every tile has the same border and padding, chosen or not", () => {
    assert.deepEqual(frame(tileStyle(true)), frame(tileStyle(false)), "chosen and not differ");
    assert.equal(tileStyle(true).padding, tileStyle(false).padding);
    assert.equal(px(tileStyle(true).border)[0], px(tileStyle(false).border)[0], "the same border width");
  });

  test("the chosen tile still reads heavier: an inset second line, in the accent", () => {
    assert.equal(theme.line.border + 1, theme.line.strong, "the ring's 1 px completes the strong line");
    assert.equal(tileStyle(true).boxShadow, `inset 0 0 0 1px ${theme.color.accent}`);
    assert.equal(tileStyle(false).boxShadow, undefined);
    assert.equal(tileStyle(false).border, `${theme.line.border}px solid ${theme.color.border}`);
  });

  test("the die's canvas flows in its box, so the alignment check sees it", () => {
    const html = renderToStaticMarkup(
      createElement(RoomProvider, {
        store: createStore(() => ({ view: null, roomId: "r1", connection: "open", you: null, local: { selectedIds: [], multi: false } })) as never,
        actions: { dispatch: () => 1 } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(DiceSetPicker) }),
      }),
    );
    assert.doesNotMatch(html, /<canvas[^>]*position:absolute/);
  });
});

/*
 * The Dice legend stood right on its tiles: a fieldset's gap never reaches
 * a rendered legend, which is no grid item (docs/design/design-v1-spacing-pass.md S2).
 */
describe("the dice legend's gaps", () => {
  /** The picker as a room draws it, with no room loaded, for `role` where one is given. */
  const render = (role: "dm" | "player" | null = null) =>
    renderToStaticMarkup(
      createElement(RoomProvider, {
        store: createStore(() => ({ view: null, roomId: "r1", connection: "open", you: role ? { memberId: "m1", role } : null, local: { selectedIds: [], multi: false } })) as never,
        actions: { dispatch: () => 1 } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(DiceSetPicker) }),
      }),
    );
  /** The style attribute of the first element some markup opens with `open`. */
  const styleOf = (markup: string, open: RegExp) => new RegExp(`${open.source}[^>]*?style="([^"]*)"`).exec(markup)?.[1] ?? null;

  test("the tiles stand space(2) under the legend, and the fieldset has no gap", () => {
    const markup = render();
    const fieldset = styleOf(markup, /^<fieldset/);
    assert.ok(fieldset !== null && !/(^|;)(row-)?gap:/.test(fieldset), `the fieldset sets no gap: ${fieldset}`);
    assert.match(markup, /^<fieldset[^>]*><legend[^>]*>Dice<\/legend><div style="display:grid;min-width:0">/, "one column under the legend");
    assert.match(styleOf(markup, /<div data-card-group=""/) ?? "", new RegExp(`margin-top:${theme.space(2)}px`), "the tiles stand space(2) under the legend");
  });
});

/*
 * The picker follows this role's Dice animation (docs/design/design-v1-features.md 3,
 * D-261127-396): marked as the part's own, and gone while the part hides,
 * as the Roll animation switch above it turns it off.
 */
describe("the dice set picker and Dice animation", () => {
  const render = (role: "dm" | "player") =>
    renderToStaticMarkup(
      createElement(RoomProvider, {
        store: createStore(() => ({ view: null, roomId: "r1", connection: "open", you: { memberId: "m1", role }, local: { selectedIds: [], multi: false } })) as never,
        actions: { dispatch: () => 1 } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(DiceSetPicker) }),
      }),
    );

  test("shown, it draws marked as Dice animation's, and hidden for a role it draws nothing for that role", () => {
    try {
      resetAllFeatures();
      assert.match(render("dm"), /^<fieldset data-part="diceAnimation"/);
      setModuleShown("diceAnimation", "dm", false);
      assert.equal(render("dm"), "");
      assert.match(render("player"), /^<fieldset data-part="diceAnimation"/, "the DM's choice is not the player's");
    } finally {
      resetAllFeatures();
    }
  });
});
