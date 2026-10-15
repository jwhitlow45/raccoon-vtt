import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accessibleName, tabKeyIndex } from "./a11y.ts";

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

describe("keys on a row of tabs", () => {
  test("Left and Right move to the tab beside, wrapping at the ends", () => {
    assert.equal(tabKeyIndex("ArrowRight", 1, 4), 2);
    assert.equal(tabKeyIndex("ArrowLeft", 1, 4), 0);
    assert.equal(tabKeyIndex("ArrowRight", 3, 4), 0);
    assert.equal(tabKeyIndex("ArrowLeft", 0, 4), 3);
  });

  test("Home and End go to the first and the last tab", () => {
    assert.equal(tabKeyIndex("Home", 2, 4), 0);
    assert.equal(tabKeyIndex("End", 0, 4), 3);
  });

  test("other keys are left to the tab", () => {
    for (const key of ["ArrowUp", "ArrowDown", "PageDown", "Enter", " "]) assert.equal(tabKeyIndex(key, 1, 4), null, key);
    assert.equal(tabKeyIndex("ArrowRight", 0, 0), null, "no tabs");
  });
});
