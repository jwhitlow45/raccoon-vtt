import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * View as a player's wait as it is drawn (docs/design-v1-per-player-vision.md
 * 7.4 and 11, review PV4-ASTRA-2 and PV4-OP-5): its words at the
 * interface size, and one status mounted before they come.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PreviewWait } = await import("./PreviewWait.tsx");

describe("the preview's wait", () => {
  test("a status is mounted before the loading line's delay ends, with no words yet", () => {
    const html = renderToStaticMarkup(createElement(PreviewWait, { name: "Ana", failed: false, zoom: 1 }));
    assert.match(html, /<div role="status"[^>]*><\/div>/);
  });

  test("the error speaks through that status, at the interface size, while the stage around it keeps the window's", () => {
    const html = renderToStaticMarkup(createElement(PreviewWait, { name: "Ana", failed: true, zoom: 1.3 }));
    assert.match(html, /<div role="status" style="[^"]*zoom:1\.3[^"]*">Could not load what Ana sees\. Close and try again\.<\/div>/);
    assert.doesNotMatch(/<div data-preview-wait="failed" style="([^"]*)"/.exec(html)?.[1] ?? "", /zoom/);
    assert.doesNotMatch(renderToStaticMarkup(createElement(PreviewWait, { name: "Ana", failed: true, zoom: 1 })), /zoom/, "nothing at 100%");
  });
});
