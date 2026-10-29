import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { CreatureHeader } = await import("./CreatureHeader.tsx");

/** A creature header's markup, drawn from props alone (docs/design-v1-design-pass.md 4.3). */
function header(actions?: readonly string[]): string {
  return renderToStaticMarkup(
    createElement(CreatureHeader, {
      picture: { image: undefined, shape: "circle", aspect: 1, ring: theme.color.ally, initials: "Th" },
      name: "Thorn",
      line: { kind: "Character", size: "Medium (5 ft)" },
      tags: [],
      children: createElement("div", { "data-quick-numbers": "" }, "AC 14"),
      ...(actions ? { actions: actions.map((words) => createElement("button", { key: words, type: "button" }, words)) } : {}),
    }),
  );
}

describe("a creature header's actions row", () => {
  test("stands after the quick numbers across both columns, from the picture's edge, holding its controls in order", () => {
    const markup = header(["Place a token", "View as Pat"]);
    const row = markup.indexOf("data-header-actions");
    assert.ok(row > markup.indexOf("data-quick-numbers"), "the row comes after the numbers");
    assert.match(markup.slice(markup.lastIndexOf("<div", row), row + 200), /grid-column:1 \/ -1/);
    assert.ok(markup.indexOf("Place a token") > row && markup.indexOf("View as Pat") > markup.indexOf("Place a token"));
  });

  test("is not drawn with no actions, so no row and no gap", () => {
    for (const markup of [header(), header([])]) assert.equal(markup.includes("data-header-actions"), false);
  });
});
