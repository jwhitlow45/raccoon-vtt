import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diceLeft, diceTyped, lineLeft, lineTyped } from "./fieldNote.ts";

/*
 * A note under a pane field must not go on the blur that leaves the field
 * with the words it explains, since that blur comes from a press elsewhere
 * in the pane and the note going would move what the press is on (LP17-TR-1).
 */
describe("a trap pane field's note", () => {
  test("a cleared required line goes back to its saved words and says why, and keeps saying so when left again before anything is typed", () => {
    const refused = lineLeft(lineTyped(""), "Rubble pit", 64, true);
    assert.deepEqual(refused, { state: { text: "Rubble pit", refused: true } });
    // The press below that blurs the field: nothing typed since, so the note stays and nothing under it moves.
    assert.deepEqual(lineLeft(refused.state, "Rubble pit", 64, true), { state: { text: "Rubble pit", refused: true } });
    // Typing takes the note away with the empty line it explained.
    assert.deepEqual(lineTyped("Rubble p"), { text: "Rubble p", refused: false });
  });

  test("a line that changed is sent, and an empty line that is not required sends null", () => {
    assert.deepEqual(lineLeft(lineTyped("  Pit of doom "), "Rubble pit", 64, true), { state: { text: "  Pit of doom ", refused: false }, send: "Pit of doom" });
    assert.deepEqual(lineLeft(lineTyped(""), "The floor gives way!", 200, false), { state: { text: "", refused: false }, send: null });
    assert.deepEqual(lineLeft(lineTyped(" Rubble pit "), "Rubble pit", 64, true), { state: { text: "Rubble pit", refused: false } });
  });

  test("dice that do not read say why when left, and their error goes as soon as the typed dice read, before the field is left", () => {
    const bad = diceLeft({ text: "2dx", bad: false }, "1d6");
    assert.deepEqual(bad, { state: { text: "2dx", bad: true } });
    // Still not dice while typing: the error stays.
    assert.deepEqual(diceTyped(bad.state, "2d"), { text: "2d", bad: true });
    // Dice again: the error goes now, so the blur that sends them moves nothing under the row.
    const good = diceTyped(bad.state, "2d6");
    assert.deepEqual(good, { text: "2d6", bad: false });
    assert.deepEqual(diceLeft(good, "1d6"), { state: { text: "2d6", bad: false }, send: "2d6" });
    assert.deepEqual(diceLeft({ text: " 1d6 ", bad: false }, "1d6"), { state: { text: " 1d6 ", bad: false } });
  });
});
