import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { escapeClosesNote } from "./noteEscape.ts";

const plain = { busy: false, defaultPrevented: false, roomLetGo: false, editing: false, dialogOpen: false };

describe("Escape and the stopped walk's note", () => {
  test("an unused Escape closes it", () => {
    assert.equal(escapeClosesNote(plain), true);
  });

  test("an Escape another layer used leaves it open", () => {
    assert.equal(escapeClosesNote({ ...plain, defaultPrevented: true }), false);
  });

  test("an Escape Room used to let go of the bar or the selection closes it too", () => {
    assert.equal(escapeClosesNote({ ...plain, defaultPrevented: true, roomLetGo: true }), true);
  });

  test("a teleport on its way, a field and a dialog keep it", () => {
    assert.equal(escapeClosesNote({ ...plain, busy: true }), false);
    assert.equal(escapeClosesNote({ ...plain, editing: true }), false);
    assert.equal(escapeClosesNote({ ...plain, dialogOpen: true }), false);
  });
});
