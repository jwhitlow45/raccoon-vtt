import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EMPTY_DRAFT, withPick, withTypedTitle } from "./draft.ts";

const open = { ...EMPTY_DRAFT, open: true };

describe("Show a handout's title (the project owner, 2026-10-16: keeping any title you typed)", () => {
  test("a title the form filled in from a pick gives way to the next pick's own", () => {
    const first = withPick(open, { kind: "doc", docId: "d1" }, "Field notes");
    assert.equal(first.title, "Field notes");
    assert.equal(withPick({ ...first, pick: null }, { kind: "doc", docId: "d2" }, "Long book").title, "Long book");
    assert.equal(withPick(first, { kind: "image", asset: { id: "a1" } as never }, "").title, "", "a picked image with no name of its own clears it");
  });

  test("a title the DM typed or edited stays through every pick, until the field is emptied", () => {
    const typed = withTypedTitle(withPick(open, { kind: "doc", docId: "d1" }, "Field notes"), "The old map");
    assert.equal(withPick(typed, { kind: "doc", docId: "d2" }, "Long book").title, "The old map");
    const edited = withTypedTitle(withPick(open, { kind: "doc", docId: "d1" }, "Field notes"), "Field notes, part 2");
    assert.equal(withPick(edited, { kind: "doc", docId: "d2" }, "Long book").title, "Field notes, part 2");
    const emptied = withTypedTitle(typed, "");
    assert.equal(withPick(emptied, { kind: "doc", docId: "d2" }, "Long book").title, "Long book");
  });
});
