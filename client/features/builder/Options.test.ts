import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The builder's options line while a gesture waits on the server's
 * answer to its asks (docs/design-v1-design-pass.md 2.4 rules 5 and 6,
 * 4.4): a muted wait in the small loading line, phrasing inside the
 * line's words, and a reading's place kept, so the map's controls hold
 * still through the wait.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { OptionsStrip } = await import("../measure/controls.tsx");
const { ASKING_LINE } = await import("./Options.tsx");
const { BUILD_ASKING } = await import("./ask.ts");
const { theme } = await import("../../lib/theme.ts");

function line(strip: Parameters<typeof OptionsStrip>[0]["line"]): { attrs: string; inner: string } {
  const html = renderToStaticMarkup(createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(OptionsStrip, { tool: "Map builder", line: strip, slots: [] }) }));
  const found = /<div([^>]*data-options-line="shown"[^>]*)>(.*?)<\/div>/.exec(html);
  assert.ok(found, "the line is drawn");
  return { attrs: found[1]!, inner: found[2]! };
}

describe("the builder's asking line", () => {
  test("is a muted wait inside the line's words, a span with the small spinner and no div", () => {
    const { attrs, inner } = line(ASKING_LINE);
    assert.match(inner, /^<span[^>]*>/, "the line's words are a span");
    assert.doesNotMatch(inner, /<div/);
    assert.ok(inner.includes(`${BUILD_ASKING}`.replace(/'/g, "&#x27;")), "it says what it waits on");
    assert.match(inner, /<svg[^>]*width="16"/, "the small spinner");
    assert.match(inner, new RegExp(`color:${theme.color.textMuted.replace(/[()]/g, "\\$&")}`), "muted");
    assert.doesNotMatch(inner, /role="status"/, "no live region inside the line, which is the live region");
    assert.doesNotMatch(attrs, new RegExp(`color:${theme.color.success.replace(/[()]/g, "\\$&")}`), "not the success green");
  });

  test("keeps the line's place as a reading while it waits", () => {
    const { attrs } = line(ASKING_LINE);
    assert.match(attrs, /data-options-reading=""/);
    assert.match(attrs, /data-finding=""/);
  });

  test("a hint that is not waiting leaves the map's controls where a hint puts them", () => {
    assert.doesNotMatch(line({ tone: "hint", content: "Drag to paint." }).attrs, /data-options-reading/);
  });
});
