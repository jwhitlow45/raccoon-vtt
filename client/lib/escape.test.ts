import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dismissal, setMultiSelect, showActions, tapToken } from "../state/selection.ts";
import { INITIAL_LOCAL } from "../state/types.ts";
import { escapeTarget } from "./escape.ts";

const none = { dialogOpen: false, editing: false, sheetOpen: false, actionBar: false, group: false };

describe("Escape in the room", () => {
  test("closes the token action bar", () => {
    assert.equal(escapeTarget({ ...none, actionBar: true }), "actionBar");
  });

  test("closes a sheet before the action bar under it", () => {
    assert.equal(escapeTarget({ ...none, sheetOpen: true, actionBar: true }), "sheet");
  });

  test("leaves dialogs and text fields to handle their own Escape", () => {
    assert.equal(escapeTarget({ ...none, actionBar: true, dialogOpen: true }), null);
    assert.equal(escapeTarget({ ...none, sheetOpen: true, editing: true }), null);
    assert.equal(escapeTarget(none), null);
  });

  test("lets go of a held group with its bar hidden, after a sheet, a dialog and a text field, and not while the token panel shows it", () => {
    const local = tapToken(tapToken(setMultiSelect(tapToken(INITIAL_LOCAL, "a"), true), "b"), null);
    const keys = (tokenPanelShown: boolean) => {
      const what = dismissal(local, tokenPanelShown);
      return { actionBar: what === "bar", group: what === "group" };
    };
    assert.equal(escapeTarget({ ...none, ...keys(false) }), "group");
    assert.equal(escapeTarget({ ...none, ...keys(false), sheetOpen: true }), "sheet");
    assert.equal(escapeTarget({ ...none, ...keys(false), dialogOpen: true }), null);
    assert.equal(escapeTarget({ ...none, ...keys(false), editing: true }), null);
    assert.equal(escapeTarget({ ...none, ...keys(true) }), null);
    assert.equal(escapeTarget({ ...none, ...keys(false), actionBar: dismissal(showActions(local, true), false) === "bar" }), "actionBar");
  });
});
