import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addToSelection, dismissal, doneSelecting, keepSelected, selectToken, setMultiSelect, showActions, tapToken } from "./selection.ts";
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

  test("while selecting several, taps add and remove, and a tap on empty map hides the bar and keeps the group", () => {
    let local = setMultiSelect(tapToken(INITIAL_LOCAL, "a"), true);
    local = tapToken(tapToken(local, "b"), "c");
    assert.deepEqual(local.selectedIds, ["a", "b", "c"]);
    const off = tapToken(local, null);
    assert.deepEqual(off.selectedIds, ["a", "b", "c"]);
    assert.equal(off.actionBar, false);
    assert.equal(off.multi, true);
    assert.equal(tapToken(off, null), off, "a second tap off changes nothing");
    // A removal leaves a hidden bar hidden, and an addition shows it.
    const out = tapToken(off, "a");
    assert.deepEqual(out.selectedIds, ["b", "c"]);
    assert.equal(out.actionBar, false);
    assert.equal(tapToken(local, "a").actionBar, true, "a removal leaves a shown bar shown");
    const back = tapToken(out, "d");
    assert.deepEqual(back.selectedIds, ["b", "c", "d"]);
    assert.equal(back.actionBar, true);
    // Turning the mode off with the bar's own toggle keeps the group, ready to move.
    const kept = setMultiSelect(back, false);
    assert.deepEqual(kept.selectedIds, ["b", "c", "d"]);
    assert.equal(kept.actionBar, true);
    assert.equal(tapToken(kept, null).selectedIds.length, 0);
    // Taking out the last one empties the selection and closes the bar, and the mode stays on.
    const none = tapToken(tapToken(out, "b"), "c");
    assert.deepEqual(none.selectedIds, []);
    assert.equal(none.actionBar, false);
    assert.equal(none.selectedId, null);
    assert.equal(none.multi, true);
  });

  test("Done ends the mode and lets go of the group", () => {
    const group = tapToken(tapToken(setMultiSelect(tapToken(INITIAL_LOCAL, "a"), true), "b"), null);
    const done = doneSelecting(group);
    assert.equal(done.multi, false);
    assert.deepEqual(done.selectedIds, []);
    assert.equal(done.selectedId, null);
    assert.equal(done.actionBar, false);
    assert.deepEqual(setMultiSelect(group, false).selectedIds, ["a", "b"], "setMultiSelect itself still keeps the group");
  });

  test("Escape and Back put away the bar, else a held group whose bar is hidden, but not while the token panel shows it", () => {
    const one = tapToken(INITIAL_LOCAL, "a");
    assert.equal(dismissal(one, false), "bar");
    assert.equal(dismissal(one, true), "bar");
    const group = tapToken(setMultiSelect(tapToken(one, "b", true), true), null);
    assert.equal(dismissal(group, false), "group", "after a tap off");
    assert.equal(dismissal(showActions(tapToken(setMultiSelect(one, true), "b"), false), false), "group", "after the alerts summary hid it");
    // Details hides the bar, and the token panel shows the selection.
    assert.equal(dismissal(showActions(setMultiSelect(one, true), false), true), null);
    assert.equal(dismissal(showActions(one, false), false), null, "one token's hidden bar, with the mode off");
    assert.equal(dismissal(setMultiSelect(INITIAL_LOCAL, true), false), null, "the mode on with nothing held");
    assert.equal(dismissal(INITIAL_LOCAL, false), null);
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
