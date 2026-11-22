import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { drawHint } = await import("./DrawTool.tsx");

test("only touch is told to draw with one finger, and a player erasing is told whose drawings", () => {
  assert.equal(drawHint("free", "dm", true), "Draw with one finger.");
  assert.equal(drawHint("free", "dm", false), "Drag to draw.");
  assert.equal(drawHint("line", "dm", true), "Drag from one end to the other.");
  assert.equal(drawHint("erase", "player", false), "Tap or drag over one of your own drawings to erase it.");
  assert.equal(drawHint("erase", "dm", false), "Tap or drag over a drawing to erase it.");
});
