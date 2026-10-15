import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ListItem, OutlineRow } from "./rows.ts";

/*
 * The outliner's rows are buttons that show their item on the map. With
 * `role="listitem"` on each row's button, its list item role replaced its
 * button role, and a screen reader heard nothing to press, while a group's
 * header sat in the list as no item at all (LPD-REGRESS-4). Every line is
 * a list item holding its button.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { WindowedList } = await import("./OutlinerPanel.tsx");

function row(id: string, name: string): OutlineRow {
  return { key: `token:${id}`, group: "tokens", kind: "token", id, name, detail: "Monster", mark: null, rect: { x: 0, y: 0, width: 1, height: 1 }, search: name.toLowerCase() };
}

describe("the outliner's list", () => {
  test("every line is a list item holding a button that keeps its button role", () => {
    const items: ListItem[] = [
      { kind: "header", group: "tokens", title: "Creatures and objects", count: 2, folded: false },
      { kind: "row", row: row("g1", "Goblin") },
      { kind: "row", row: row("g2", "Goblin Boss") },
    ];
    const markup = renderToStaticMarkup(createElement(WindowedList, { items, onPick: () => {}, onToggle: () => {} }));
    assert.match(markup, /^<div role="list" aria-label="Everything on the scene"/);
    const lines = [...markup.matchAll(/<div role="listitem"[^>]*>(<[a-z]+)([^>]*)>/g)];
    assert.equal(lines.length, 3);
    for (const [, tag, attrs] of lines) {
      assert.equal(tag, "<button", "a list item holds its line's button");
      assert.doesNotMatch(attrs ?? "", /\brole=/, "the button keeps its own role");
    }
    assert.match(markup, /title="Show Goblin Boss on the map"/);
  });
});
