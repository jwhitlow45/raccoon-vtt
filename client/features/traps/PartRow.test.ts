import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PartRow } = await import("./PartRow.tsx");

/** The markup's elements alone, with no attributes or text, to read where an element stands in the tree. */
function shape(markup: string): string {
  return markup.replace(/ [a-z-]+="[^"]*"/g, "").replace(/>[^<]+</g, "><");
}

/*
 * React keeps an element only while its place in the tree and its type
 * stay the same. A remove or a choice that comes or goes, such as Play
 * after a sound is chosen, must leave a focused field where it was, or
 * React replaces it and focus falls to the page (PL1-ASTRA-02). The
 * pane's own case, Play after a sound, is e2e/traps.e2e.ts pl1-c's.
 */
describe("a trap part's row", () => {
  const field = () => createElement("select", { "aria-label": "Sound" }, createElement("option", { value: "" }, "No sound"));
  const remove = createElement("button", { type: "button" }, "Remove");

  test("its fields stand at the same place whether or not the row has a remove or a choice under it", () => {
    const shapes = [
      renderToStaticMarkup(createElement(PartRow, { children: field() })),
      renderToStaticMarkup(createElement(PartRow, { end: remove, children: field() })),
      renderToStaticMarkup(createElement(PartRow, { under: createElement("span", null, "Lock"), children: field() })),
      renderToStaticMarkup(createElement(PartRow, { end: remove, under: createElement("span", null, "Lock"), children: field() })),
    ].map(shape);
    for (const s of shapes) assert.match(s, /^<div><div><select>/, s);
  });

  test("the remove holds a column of its own only while there is one", () => {
    const style = (markup: string) => /^<div style="([^"]*)"/.exec(markup)?.[1] ?? "";
    assert.match(style(renderToStaticMarkup(createElement(PartRow, { end: remove, children: field() }))), /grid-template-columns:minmax\(0, 1fr\) auto/);
    assert.match(style(renderToStaticMarkup(createElement(PartRow, { children: field() }))), /grid-template-columns:minmax\(0, 1fr\);/);
  });
});
