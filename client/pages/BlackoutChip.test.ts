import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { BlackoutChip } = await import("./BlackoutChip.tsx");

test("FU39-B: a compact blackout reminder fits the DM chip's place and keeps its full accessible meaning", () => {
  const html = renderToStaticMarkup(createElement(BlackoutChip, { compact: true }));
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="You are the DM\. Players see black"/);
  assert.match(html, /title="You are the DM\. Players see black"/);
  assert.match(html, /width:28px/);
  assert.match(html, /height:28px/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, />Players see black</);
});

test("FU39-B: the full blackout notice still says what players see", () => {
  const html = renderToStaticMarkup(createElement(BlackoutChip, { compact: false }));
  assert.match(html, />Players see black<\/span>/);
});
