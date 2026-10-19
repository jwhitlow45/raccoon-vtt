import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The one look of a load that failed beside what still works
 * (docs/design-v1-look-pass.md 2.9): an alert that says what failed, with
 * Try again and its icon where a second request can succeed, or the reload
 * it is handed where only a reload can.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { LoadFailed } = await import("./LoadFailed.tsx");
const { Icon } = await import("./Icon.tsx");

const WORDS = "The library did not load. Images already on the map are below.";

describe("LoadFailed", () => {
  test("is an alert with its words and Try again wearing the retry icon", () => {
    const html = renderToStaticMarkup(createElement(LoadFailed, { retry: () => undefined, children: WORDS }));
    assert.match(html, /^<div role="alert"/);
    assert.ok(html.includes(WORDS), "the words show");
    const button = /<button[^>]*>(.*?)<\/button>/.exec(html);
    assert.ok(button, "Try again is a button");
    assert.match(button[1]!, /Try again/);
    const icon = renderToStaticMarkup(createElement(Icon, { name: "retry", size: "sm" }));
    assert.ok(button[1]!.includes(icon), "the button wears the retry icon");
  });

  test("with a reload in its place, draws that reload and no Try again", () => {
    const html = renderToStaticMarkup(createElement(LoadFailed, { reload: createElement("button", { type: "button" }, "Reload"), children: "The stat block did not load. Reload to try again." }));
    assert.match(html, /^<div role="alert"/);
    assert.match(html, /<button type="button">Reload<\/button>/);
    assert.doesNotMatch(html, /Try again/);
  });
});
