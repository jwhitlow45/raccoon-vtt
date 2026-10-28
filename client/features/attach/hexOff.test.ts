import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HEX_LIMITS } from "../grid/words.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { AttachOff, attachOff } = await import("./AttachButton.tsx");

describe("Attach on a hex scene (H1)", () => {
  test("it is off on either hex shape and on for squares", () => {
    assert.equal(attachOff({ gridShape: "hexRows" }), HEX_LIMITS.attach);
    assert.equal(attachOff({ gridShape: "hexColumns" }), HEX_LIMITS.attach);
    assert.equal(attachOff({}), null);
    assert.equal(attachOff(undefined), null);
  });
  test("the off button still says Attach, is disabled, and points a screen reader at its reason", () => {
    const html = renderToStaticMarkup(createElement(AttachOff, { reason: HEX_LIMITS.attach }));
    assert.match(html, /<button[^>]*disabled=""[^>]*>Attach<\/button>/);
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    assert.ok(id, "no aria-describedby");
    assert.ok(html.includes(`<span id="${id}"`) && html.includes(`${HEX_LIMITS.attach}</span>`), "the reason is not on the page");
  });
});
