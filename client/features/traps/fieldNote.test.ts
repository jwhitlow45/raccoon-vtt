import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diceLeft, diceRead, diceRested, diceTyped, lineLeft, lineRested, lineTyped, type DiceState, type LineState } from "./fieldNote.ts";

/*
 * A note under a pane field must never come or go on the blur that leaves
 * the field, since that blur comes from a press elsewhere in the pane and a
 * note that moves would move what the press is on (LP17-TR-1, LP17-TR-2).
 * It comes while the field is focused, once typing rests or on Enter.
 */
describe("a trap pane field's note", () => {
  test("a cleared required line says why once typing rests, goes back to its saved words when left, and keeps saying so when left again", () => {
    const rested = lineRested(lineTyped(""), 64, true);
    assert.deepEqual(rested, { text: "", refused: true });
    const left = lineLeft(rested, "Rubble pit", 64, true);
    assert.deepEqual(left, { state: { text: "Rubble pit", refused: true } });
    // The press below that blurs the field: nothing typed since, so the note stays and nothing under it moves.
    assert.deepEqual(lineLeft(left.state, "Rubble pit", 64, true), { state: { text: "Rubble pit", refused: true } });
    // Typing takes the note away with the empty line it explained.
    assert.deepEqual(lineTyped("Rubble p"), { text: "Rubble p", refused: false });
    assert.deepEqual(lineRested(lineTyped("Rubble p"), 64, true), { text: "Rubble p", refused: false });
  });

  test("a cleared required line left before typing rests goes back to its saved words in silence", () => {
    assert.deepEqual(lineLeft(lineTyped(""), "Rubble pit", 64, true), { state: { text: "Rubble pit", refused: false } });
    // A line that is not required never says anything, rested or not.
    assert.deepEqual(lineRested(lineTyped(""), 200, false), { text: "", refused: false });
  });

  test("a line that changed is sent, and an empty line that is not required sends null", () => {
    assert.deepEqual(lineLeft(lineTyped("  Pit of doom "), "Rubble pit", 64, true), { state: { text: "  Pit of doom ", refused: false }, send: "Pit of doom" });
    assert.deepEqual(lineLeft(lineTyped(""), "The floor gives way!", 200, false), { state: { text: "", refused: false }, send: null });
    assert.deepEqual(lineLeft(lineTyped(" Rubble pit "), "Rubble pit", 64, true), { state: { text: "Rubble pit", refused: false } });
  });

  test("dice that do not read say why once typing rests, keep saying so when left, and their error goes as soon as the typed dice read", () => {
    const bad = diceRested(diceTyped({ text: "1d6", bad: false }, "2dx"));
    assert.deepEqual(bad, { text: "2dx", bad: true });
    assert.deepEqual(diceLeft(bad, "1d6"), { state: { text: "2dx", bad: true } });
    // Still not dice while typing: the error stays.
    assert.deepEqual(diceTyped(bad, "2d"), { text: "2d", bad: true });
    // Dice again: the error goes now, so the blur that sends them moves nothing under the row.
    const good = diceTyped(bad, "2d6");
    assert.deepEqual(good, { text: "2d6", bad: false });
    assert.deepEqual(diceRested(good), { text: "2d6", bad: false });
    assert.deepEqual(diceLeft(good, "1d6"), { state: { text: "2d6", bad: false }, send: "2d6" });
    assert.deepEqual(diceLeft({ text: " 1d6 ", bad: false }, "1d6"), { state: { text: " 1d6 ", bad: false } });
  });

  test("dice that do not read, left before typing rests, go back to the last good ones in silence", () => {
    assert.deepEqual(diceLeft(diceTyped({ text: "1d6", bad: false }, "2dx"), "1d6"), { state: { text: "1d6", bad: false } });
  });

  test("random typing, rests, Enters and leaves: a leave never shows or hides a note, typing never shows one, and only good words are sent", () => {
    let seed = 5;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const lines = ["", " ", "Rubble pit", "  Pit of doom ", "Snare"];
    const dice = ["", "2d", "2dx", "1d6", " 2d10 ", "1d6+2", "d"];
    for (let run = 0; run < 400; run++) {
      const required = random() < 0.7;
      let lineSaved = "Rubble pit";
      let line: LineState = { text: lineSaved, refused: false };
      let diceSaved = "1d6";
      let die: DiceState = { text: diceSaved, bad: false };
      for (let step = 0; step < 12; step++) {
        const op = pick(["type", "rest", "enter", "leave"] as const);
        const was = { line: line.refused, die: die.bad };
        if (op === "type") {
          line = lineTyped(pick(lines));
          die = diceTyped(die, pick(dice));
          assert.ok(!line.refused || was.line, "typing showed the line's note");
          assert.ok(!die.bad || was.die, "typing showed the dice's error");
          continue;
        }
        if (op === "rest") {
          line = lineRested(line, 64, required);
          die = diceRested(die);
          assert.equal(line.refused, required && line.text.trim() === "");
          assert.equal(die.bad, diceRead(die.text) === null);
          continue;
        }
        const enter = op === "enter";
        const lineNext = lineLeft(enter ? lineRested(line, 64, required) : line, lineSaved, 64, required);
        const dieNext = diceLeft(enter ? diceRested(die) : die, diceSaved);
        if (!enter) {
          assert.equal(lineNext.state.refused, was.line, "a leave showed or hid the line's note");
          assert.equal(dieNext.state.bad, was.die, "a leave showed or hid the dice's error");
        }
        if (lineNext.send !== undefined) {
          assert.ok(lineNext.send !== null || !required, "a required line sent nothing");
          if (lineNext.send !== null) lineSaved = lineNext.send;
          else lineSaved = "";
        }
        if (dieNext.send !== undefined) {
          assert.notEqual(diceRead(dieNext.send), null, "dice that do not read were sent");
          diceSaved = dieNext.send;
        }
        line = lineNext.state;
        die = dieNext.state;
      }
    }
  });
});
