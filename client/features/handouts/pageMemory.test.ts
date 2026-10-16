import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pageMemorySlot, rememberedPage, rememberPage } from "./pageMemory.ts";

describe("the page remembered per showing (docs/design-v1-pdf-handouts.md 5.1)", () => {
  test("a showing never seen starts at page 1, and each showing keeps its own page", () => {
    const memory = pageMemorySlot.create();
    assert.equal(rememberedPage(memory, "h1@2026-10-16T19:00:00.000Z"), 0);
    rememberPage(memory, "h1@2026-10-16T19:00:00.000Z", 13);
    rememberPage(memory, "doc:d1", 2);
    assert.equal(rememberedPage(memory, "h1@2026-10-16T19:00:00.000Z"), 13);
    assert.equal(rememberedPage(memory, "doc:d1"), 2);
    // The same handout shown anew is another showing, which starts again.
    assert.equal(rememberedPage(memory, "h1@2026-10-16T19:30:00.000Z"), 0);
  });

  test("past 200 showings the one written longest ago is forgotten", () => {
    const memory = pageMemorySlot.create();
    for (let i = 0; i < 200; i++) rememberPage(memory, `s${i}`, 1);
    // Written again, s0 is the newest, so s1 goes first.
    rememberPage(memory, "s0", 4);
    rememberPage(memory, "s200", 1);
    assert.equal(memory.size, 200);
    assert.equal(rememberedPage(memory, "s1"), 0);
    assert.equal(rememberedPage(memory, "s0"), 4);
  });
});
