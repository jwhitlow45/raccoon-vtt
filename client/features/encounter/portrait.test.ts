import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";

/*
 * A tracker row or the turn strip's picture of a creature this view cannot
 * place, on a scene a DM is not looking at: the "?" of an unknown creature,
 * not initials of the placeholder name ("CO" for "Creature on another
 * scene"), which read as a name and were the same for every such row.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { Portrait } = await import("./parts.tsx");

function render(entry: { tokenId?: string; label?: string }): string {
  const view = { tokens: { gob: { id: "gob", name: "Goblin", number: 2, disposition: "hostile", actor: { inline: {} } } }, characters: {} };
  const store = createStore(() => ({ view }));
  const assets = { url: () => "" };
  return renderToStaticMarkup(
    createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, assets: assets as never, children: createElement(Portrait, { entry, size: 26 }) }),
  );
}

test("a creature on another scene draws the unknown creature's ?, and one this view holds keeps its initials", () => {
  assert.match(render({ tokenId: "elsewhere" }), />\?<\/span>$/);
  assert.doesNotMatch(render({ tokenId: "elsewhere" }), /CO/);
  assert.match(render({ tokenId: "gob" }), />G2<\/span>$/);
  assert.match(render({ tokenId: "elsewhere", label: "Hidden archer" }), />HA<\/span>$/, "a row the DM labeled keeps the label's initials");
});
