import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pageBackTo, shownPage } from "./characterPage.ts";

const BREE = { id: "bree" };
const CYRA = { id: "cyra" };
const ZED = { id: "zed" };

describe("which character's page shows (docs/design-v1-look-pass.md 3.1)", () => {
  test("a player with one character lands on its page until they pick, and the DM on the list", () => {
    assert.equal(shownPage(undefined, [BREE], false), "bree");
    assert.equal(shownPage(undefined, [BREE, CYRA], false), null, "with two, the list");
    assert.equal(shownPage(undefined, [], false), null);
    assert.equal(shownPage(undefined, [BREE], true), null, "the DM starts on the list");
  });

  test("Back's list stays the list, even for a player with one character", () => {
    assert.equal(shownPage(null, [BREE], false), null);
  });

  test("a page picked shows while its character is one of the viewer's", () => {
    assert.equal(shownPage("cyra", [BREE, CYRA], false), "cyra");
    assert.equal(shownPage("cyra", [BREE], false), null, "deleted, or no longer theirs: the list");
    assert.equal(shownPage("cyra", [BREE, CYRA], true), "cyra");
  });
});

describe("where Back's focus goes from a page", () => {
  test("its own row, then the rows after it, then those before it, nearest first, then New character, else the empty list's line", () => {
    assert.deepEqual(pageBackTo("cyra", [BREE, CYRA, ZED]), ["character:cyra", "character:zed", "character:bree", "new-character", "characters-empty"]);
    assert.deepEqual(pageBackTo("zed", [BREE, CYRA, ZED]), ["character:zed", "character:cyra", "character:bree", "new-character", "characters-empty"]);
    assert.deepEqual(pageBackTo("bree", [BREE]), ["character:bree", "new-character", "characters-empty"]);
  });

  test("a character not in the list names its own row alone", () => {
    assert.deepEqual(pageBackTo("gone", [BREE]), ["character:gone", "new-character", "characters-empty"]);
  });
});
