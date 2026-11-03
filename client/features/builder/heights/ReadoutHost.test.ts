import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The height pill lies on the board, so it keeps the board's dark look in
 * either scheme (docs/design/design-v1-light-theme.md 6.4): the dark palette
 * in scope on its root, and a fill an SVG attribute could not read from a
 * variable set as a style instead (6.2).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PillShape } = await import("./ReadoutHost.tsx");
const { BOARD_SCOPE, theme } = await import("../../../lib/theme.ts");
const { tokenPattern } = await import("../../../components/testing/tokenPattern.ts");

const draw = () => renderToStaticMarkup(createElement(PillShape, { words: { pill: "↑10 ft", spoken: "Raised 10 feet", edge: "raised" }, width: 60, place: { left: 10, top: 20, pointer: { side: "down", x: 30 } } }));
const declares = (style: string, property: string, value: string) => new RegExp(`(^|;)${tokenPattern(property)}:${tokenPattern(value)}(;|$)`).test(style);

describe("the height pill", () => {
  test("puts the whole dark palette and the dark accent in scope on its root", () => {
    const root = /<div aria-hidden="true" data-rvtt-height-pill="" style="([^"]*)"/.exec(draw())?.[1] ?? "";
    for (const [name, value] of Object.entries(BOARD_SCOPE)) {
      const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      assert.ok(declares(root, property, value), property);
    }
  });

  test("fills its shape from a style, which reads the variable, never from the fill attribute, which cannot", () => {
    const path = /<path [^>]*>/.exec(draw())?.[0] ?? "";
    assert.doesNotMatch(path, / fill="/);
    assert.ok(declares(/style="([^"]*)"/.exec(path)?.[1] ?? "", "fill", theme.color.overlay), path);
  });
});
