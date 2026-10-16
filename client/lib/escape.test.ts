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

  test("lets go of a token whose bar is hidden, last, and not while a map pane is open", () => {
    const hidden = showActions(tapToken(INITIAL_LOCAL, "a"), false);
    const keys = (tokenPanelShown: boolean, pane = false) => {
      const what = dismissal(hidden, tokenPanelShown, pane);
      return { actionBar: what === "bar", group: what === "group", token: what === "token" };
    };
    // After Details, or with the token panel open beside the hidden bar.
    assert.equal(escapeTarget({ ...none, ...keys(true) }), "token");
    assert.equal(escapeTarget({ ...none, ...keys(false) }), "token");
    assert.equal(escapeTarget({ ...none, ...keys(false), sheetOpen: true }), "sheet");
    assert.equal(escapeTarget({ ...none, ...keys(false), dialogOpen: true }), null);
    assert.equal(escapeTarget({ ...none, ...keys(false), editing: true }), null);
    // A label, pin or light pane closes on Escape itself, and the token stays selected.
    assert.equal(escapeTarget({ ...none, ...keys(false, true) }), null);
    assert.equal(escapeTarget({ ...none, actionBar: true, token: true }), "actionBar");
    assert.equal(escapeTarget({ ...none, group: true, token: true }), "group");
  });

  test("Back's rule does not change with it: it puts away only a group, or a phone's bar", () => {
    // Room.tsx closes on Back for "group", and for "bar" under 900 px, never for "token".
    const backCloses = (what: ReturnType<typeof dismissal>, wide: boolean) => what === "group" || (!wide && what === "bar");
    const hidden = showActions(tapToken(INITIAL_LOCAL, "a"), false);
    assert.equal(dismissal(hidden, false), "token");
    assert.equal(backCloses(dismissal(hidden, false), false), false);
    assert.equal(backCloses(dismissal(tapToken(INITIAL_LOCAL, "a"), false), false), true);
  });
});
