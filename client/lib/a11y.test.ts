import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accessibleName } from "./a11y.ts";

describe("button names", () => {
  test("a button with words on it is named by them, not by its title", () => {
    assert.equal(accessibleName("Undo", "Take back the last draft edit"), undefined);
    assert.equal(accessibleName("Share", "Only you see this preview"), undefined);
  });

  test("a title that repeats the words and adds to them is the better name", () => {
    assert.equal(accessibleName("Move players", "Move players to the Cave"), "Move players to the Cave");
  });

  test("a symbol or a number takes its title as the name", () => {
    assert.equal(accessibleName("←", "Nudge the box left"), "Nudge the box left");
    assert.equal(accessibleName("2", "Two squares wide"), "Two squares wide");
    assert.equal(accessibleName(undefined, "Close"), "Close");
    assert.equal(accessibleName("Undo", undefined), undefined);
  });
});
