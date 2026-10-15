import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addToSelection, keepSelected, selectToken, setMultiSelect, showActions, tapToken } from "./selection.ts";
import { INITIAL_LOCAL } from "./types.ts";

describe("taps, the selection and the action bar", () => {
  test("a tap on a token, on the map or its initiative row, selects it and opens its action bar", () => {
    const tapped = tapToken(INITIAL_LOCAL, "gob1");
    assert.equal(tapped.selectedId, "gob1");
    assert.equal(tapped.actionBar, true);
    assert.equal(tapToken(tapped, "gob1"), tapped, "nothing changes, nothing re-renders");
    const away = tapToken(tapped, null);
    assert.equal(away.selectedId, null);
    assert.equal(away.actionBar, false);
  });

  test("opening the token's panel puts the bar away, and selecting another keeps it as it was", () => {
    const tapped = tapToken(INITIAL_LOCAL, "gob1");
    const details = showActions(tapped, false);
    assert.equal(details.actionBar, false);
    assert.equal(details.selectedId, "gob1");
    assert.equal(selectToken(details, "gob2").actionBar, false);
    assert.equal(selectToken(tapped, "gob2").actionBar, true);
    assert.equal(selectToken(tapped, null).actionBar, false);
    assert.equal(showActions(INITIAL_LOCAL, true).actionBar, false, "no bar with nothing selected");
  });

  test("Shift adds a token or takes it out, and a plain tap picks only one again", () => {
    let local = tapToken(INITIAL_LOCAL, "a");
    local = tapToken(local, "b", true);
    assert.deepEqual(local.selectedIds, ["a", "b"]);
    assert.equal(local.selectedId, "b", "the last one picked is the one shown");
    local = tapToken(local, "b", true);
    assert.deepEqual(local.selectedIds, ["a"]);
    assert.equal(local.selectedId, "a");
    local = tapToken(tapToken(local, "c", true), "d");
    assert.deepEqual(local.selectedIds, ["d"]);
  });

  test("while selecting several, taps add and remove, and a tap on empty map keeps the group", () => {
    let local = setMultiSelect(tapToken(INITIAL_LOCAL, "a"), true);
    local = tapToken(tapToken(local, "b"), "c");
    assert.deepEqual(local.selectedIds, ["a", "b", "c"]);
    assert.equal(tapToken(local, null), local);
    local = tapToken(local, "a");
    assert.deepEqual(local.selectedIds, ["b", "c"]);
    // Turning the mode off keeps the group, ready to move.
    const done = setMultiSelect(local, false);
    assert.deepEqual(done.selectedIds, ["b", "c"]);
    assert.equal(tapToken(done, null).selectedIds.length, 0);
    // Taking out the last one closes the bar.
    const none = tapToken(tapToken(local, "b"), "c");
    assert.deepEqual(none.selectedIds, []);
    assert.equal(none.actionBar, false);
    assert.equal(none.selectedId, null);
  });

  test("a box adds what it covers, and gone tokens drop out", () => {
    let local = tapToken(INITIAL_LOCAL, "a");
    local = addToSelection(local, ["a", "b", "c"]);
    assert.deepEqual(local.selectedIds, ["a", "b", "c"]);
    assert.equal(local.selectedId, "c");
    assert.equal(addToSelection(local, ["b"]), local);
    local = keepSelected(local, (id) => id !== "c");
    assert.deepEqual(local.selectedIds, ["a", "b"]);
    assert.equal(local.selectedId, "b");
    assert.equal(keepSelected(local, () => true), local);
    assert.equal(selectToken(local, null).selectedIds.length, 0);
  });
});
