import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * View as a player's wait as it is drawn (docs/design-v1-per-player-vision.md
 * 7.4 and 11, review PV4-ASTRA-2 and PV4-OP-5, and
 * docs/design-v1-design-pass.md 4.4): its words at the interface size, one
 * status mounted before they come and after a failure, which takes focus
 * from Try again, and the failure as an alert outside it.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PreviewWait } = await import("./PreviewWait.tsx");

const draw = (failed: boolean, zoom = 1) => renderToStaticMarkup(createElement(PreviewWait, { name: "Ana", failed, zoom, onRetry: () => undefined }));
/** The status, its attributes and what it holds: it holds no element of its own, so its end is the first close after its start. */
const statusOf = (html: string) => /<div role="status" tabindex="-1"[^>]*>(.*?)<\/div>/.exec(html);

describe("the preview's wait", () => {
  test("a status that takes focus from code is mounted before the loading line's delay ends, with no words yet", () => {
    const html = draw(false);
    assert.equal(statusOf(html)?.[1], "");
    assert.doesNotMatch(html, /role="alert"/);
  });

  test("a failure keeps that status mounted, and says so in an alert outside it, with Try again", () => {
    const html = draw(true);
    assert.equal(statusOf(html)?.[1], "", "the status is mounted and holds nothing");
    const alert = /<div role="alert"[^>]*>(.*)$/.exec(html)?.[1] ?? "";
    assert.match(alert, /Could not load what Ana sees\./);
    assert.doesNotMatch(alert, /Close and try again/);
    assert.match(alert, /<button[^>]*>.*Try again.*<\/button>/);
    assert.ok(html.indexOf('role="status"') < html.indexOf('role="alert"'), "the alert comes after the status, as its sibling");
  });

  test("the words take the interface size, while the stage around them keeps the window's", () => {
    const html = draw(true, 1.3);
    assert.match(html, /<div style="[^"]*zoom:1\.3[^"]*"><div role="status"/);
    assert.doesNotMatch(/<div data-preview-wait="failed" style="([^"]*)"/.exec(html)?.[1] ?? "", /zoom/);
    assert.doesNotMatch(draw(true), /zoom/, "nothing at 100%");
  });
});
