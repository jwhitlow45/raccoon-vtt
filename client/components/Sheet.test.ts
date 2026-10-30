import "./testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { theme } from "../lib/theme.ts";

const { stickyPaneFoot } = await import("./Sheet.tsx");

test("fl12: a sticky foot's fill covers the pane's side padding beside it too, and its sides take no room (FL12-OPUS-1)", () => {
  // A proficiency frame runs 1 px past its words, so a roll starting a line would show beside a foot that left the pane's side padding open as it scrolls under.
  const foot = stickyPaneFoot(theme.space(2), theme.color.surface);
  assert.equal(foot.background, theme.color.surface);
  assert.equal(foot.boxShadow, theme.shadow.paneSides(theme.color.surface));
  for (const side of ["margin", "marginInline", "marginLeft", "marginRight", "paddingInline", "paddingLeft", "paddingRight", "width"]) assert.ok(!(side in foot), `no ${side}`);
});
