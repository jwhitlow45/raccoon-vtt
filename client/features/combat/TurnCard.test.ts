import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The folded turn card's chevron leads its words inside one button, named
 * "Show {title}". That label hid the count the words carry, so the count
 * is the button's description (ICONS2-ASTRA-05).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { TurnCard } = await import("./TurnCard.tsx");

function folded(count: number): string {
  const model = { id: "t1", name: "Adult Red Dragon", blocks: [], count, loading: false, failed: false };
  return renderToStaticMarkup(createElement(TurnCard, { model, folded: true, foldable: true, onShow: () => {}, onDismiss: () => {} }));
}

describe("a folded turn card", () => {
  for (const [count, words] of [[3, "3 uses"], [1, "1 use"]] as const) {
    test(`keeps its name and says "${words}" as its description`, () => {
      const markup = folded(count);
      const button = /<button[^>]*>/.exec(markup)?.[0] ?? "";
      assert.match(button, /aria-label="Show Adult Red Dragon&#x27;s turn"/);
      const id = /aria-describedby="([^"]+)"/.exec(button)?.[1];
      assert.ok(id, "described");
      assert.match(markup, new RegExp(`<span id="${id}">${words}</span>`));
      assert.match(markup, new RegExp(`Adult Red Dragon&#x27;s turn: <span id="${id}">`), "the words read as before");
    });
  }
});
