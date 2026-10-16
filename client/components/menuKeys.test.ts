import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { menuAction, openingIndex, TYPEAHEAD_MS, typeahead, type MenuKey } from "./menuKeys.ts";

/*
 * The menu's keys (docs/design-v1-panel-tabs.md 5.2), for the side
 * panel's More and for Setup and Tools, which draw it as tiles
 * (docs/design-v1-tool-options.md 5.1).
 */

const key = (k: string, over: Partial<MenuKey> = {}): MenuKey => ({ key: k, letter: /^[a-z]$/i.test(k) ? k.toLowerCase() : null, ctrlKey: false, metaKey: false, altKey: false, ...over });

/** A DM's More at 1280 x 800: what the row does not hold, in the registry's order. */
const MORE = ["Journal", "Areas", "DM", "Scenes", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"];

describe("moving in a menu", () => {
  test("Down and Up go to the next and the previous item, wrapping", () => {
    assert.deepEqual(menuAction(key("ArrowDown"), 0, 10, false), { type: "focus", index: 1 });
    assert.deepEqual(menuAction(key("ArrowDown"), 9, 10, false), { type: "focus", index: 0 });
    assert.deepEqual(menuAction(key("ArrowUp"), 0, 10, false), { type: "focus", index: 9 });
    assert.deepEqual(menuAction(key("ArrowUp"), 4, 10, false), { type: "focus", index: 3 });
    assert.deepEqual(menuAction(key("ArrowDown"), -1, 10, false), { type: "focus", index: 0 }, "from the box, the first");
    assert.deepEqual(menuAction(key("ArrowUp"), -1, 10, false), { type: "focus", index: 9 }, "from the box, the last");
  });

  test("Home and End go to the first and the last", () => {
    assert.deepEqual(menuAction(key("Home"), 5, 10, false), { type: "focus", index: 0 });
    assert.deepEqual(menuAction(key("End"), 5, 10, false), { type: "focus", index: 9 });
  });

  test("in a list Left and Right do nothing, and in tiles they move as Up and Down, wrapping", () => {
    assert.deepEqual(menuAction(key("ArrowLeft"), 3, 10, false), { type: "none" });
    assert.deepEqual(menuAction(key("ArrowRight"), 3, 10, false), { type: "none" });
    assert.deepEqual(menuAction(key("ArrowRight"), 3, 4, true), { type: "focus", index: 0 });
    assert.deepEqual(menuAction(key("ArrowLeft"), 0, 4, true), { type: "focus", index: 3 });
    assert.deepEqual(menuAction(key("ArrowDown"), 1, 4, true), { type: "focus", index: 2 });
    assert.deepEqual(menuAction(key("ArrowUp"), 1, 4, true), { type: "focus", index: 0 });
  });

  test("Enter and Space pick the focused item", () => {
    assert.deepEqual(menuAction(key("Enter"), 6, 10, false), { type: "pick", index: 6 });
    assert.deepEqual(menuAction(key(" "), 6, 10, true), { type: "pick", index: 6 });
    assert.deepEqual(menuAction(key("Enter"), -1, 10, false), { type: "none" }, "nothing focused, nothing picked");
  });

  test("a letter types ahead, and keys it leaves alone act as anywhere", () => {
    assert.deepEqual(menuAction(key("m"), 0, 10, false), { type: "type", letter: "m" });
    assert.deepEqual(menuAction(key("z", { ctrlKey: true }), 0, 10, false), { type: "none" }, "Ctrl+Z undoes as anywhere");
    assert.deepEqual(menuAction(key("ArrowDown", { altKey: true }), 0, 10, false), { type: "none" });
    assert.deepEqual(menuAction(key("ArrowDown", { metaKey: true }), 0, 10, false), { type: "none" });
    for (const k of ["Escape", "Tab", "PageDown", "F5", "1"]) assert.deepEqual(menuAction(key(k), 0, 10, false), { type: "none" }, `${k} is the base's or nobody's`);
    assert.deepEqual(menuAction(key("ArrowDown"), -1, 0, false), { type: "none" }, "an empty menu");
  });

  // What the Menu marks used (preventDefault), so no room shortcut runs: a letter picks no tool, S does not hide the side panel.
  test("every key it handles is marked used, and only those", () => {
    const used = (k: MenuKey, tiles = false) => menuAction(k, 2, 10, tiles).type !== "none";
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "r", "s", "v"]) assert.equal(used(key(k)), true, k);
    for (const k of ["ArrowLeft", "ArrowRight", "Escape", "Tab"]) assert.equal(used(key(k)), false, k);
    assert.equal(used(key("ArrowLeft"), true), true, "tiles use Left");
    assert.equal(used(key("z", { ctrlKey: true })), false);
  });
});

describe("the item a key open focuses", () => {
  test("the checked one, else the first, or with Up the last", () => {
    assert.equal(openingIndex(5, 10, "first"), 5);
    assert.equal(openingIndex(5, 10, "last"), 5, "Up on More with Monsters open: Monsters");
    assert.equal(openingIndex(-1, 10, "first"), 0);
    assert.equal(openingIndex(-1, 10, "last"), 9);
    assert.equal(openingIndex(-1, 0, "first"), -1, "an empty menu");
  });
});

describe("typeahead", () => {
  test("the next item after the focused one whose title starts with the letter, wrapping", () => {
    assert.equal(typeahead(null, "c", 0, MORE, 0).index, 6, "Characters from Journal");
    assert.equal(typeahead(null, "j", 0, MORE, 8).index, 0, "wrapping to Journal");
    assert.equal(typeahead(null, "J", 0, MORE, 3).index, 0, "either case");
  });

  test("the same letter again steps through the items that start with it", () => {
    const m1 = typeahead(null, "m", 0, MORE, 0);
    assert.equal(m1.index, 4, "Monsters");
    const m2 = typeahead(m1.typed, "m", 100, MORE, 4);
    assert.equal(m2.index, 9, "then Menu");
    assert.equal(typeahead(m2.typed, "m", 200, MORE, 9).index, 4, "then Monsters again");
  });

  test("two letters within 500 ms are one prefix, and after 500 ms a new one", () => {
    const m = typeahead(null, "m", 0, MORE, 0);
    assert.equal(typeahead(m.typed, "e", TYPEAHEAD_MS, MORE, 4).index, 9, "'me': Menu");
    assert.equal(typeahead(m.typed, "o", 200, MORE, 4).index, 4, "'mo' stays on Monsters");
    const late = typeahead(m.typed, "e", TYPEAHEAD_MS + 1, MORE, 4);
    assert.equal(late.typed.text, "e");
    assert.equal(late.index, 5, "'e' alone: Encounters");
  });

  test("no match leaves focus where it is", () => {
    assert.equal(typeahead(null, "x", 0, MORE, 3).index, null);
    const m = typeahead(null, "m", 0, MORE, 0);
    assert.equal(typeahead(m.typed, "x", 100, MORE, 4).index, null, "'mx' matches nothing");
  });

  test("tiles type ahead by the tool's full label", () => {
    const setup = ["Add token", "Pin", "Map builder", "Line up grid"];
    assert.equal(typeahead(null, "m", 0, setup, 0).index, 2);
    assert.equal(typeahead(null, "l", 0, setup, 2).index, 3);
  });
});
