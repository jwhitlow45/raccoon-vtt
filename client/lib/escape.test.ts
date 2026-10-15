import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeTarget } from "./escape.ts";

const none = { dialogOpen: false, editing: false, sheetOpen: false, actionBar: false };

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
});
