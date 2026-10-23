import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACTION_TOAST_MS, TOAST_MS, toastsLeft } from "./store.ts";
import type { Toast } from "./types.ts";

const note = (id: number): Toast => ({ id, text: `Pat whispers: ${id}`, tone: "info" });
const withButton = (id: number): Toast => ({ id, text: `Plate went off: Thorn. ${id}`, tone: "info", action: { label: "Save and damage", run() {} } });

describe("toastsLeft (review LP16-PT-1)", () => {
  test("a toast keeps its own time when others come and go, so a whisper every few seconds never keeps the first one up", () => {
    const shown = new Map<number, number>();
    assert.deepEqual(toastsLeft([note(1)], shown, 0), [{ id: 1, ms: TOAST_MS }]);
    // Three seconds on a second whisper comes: the first has two left, not five again.
    assert.deepEqual(toastsLeft([note(1), note(2)], shown, 3_000), [
      { id: 1, ms: 2_000 },
      { id: 2, ms: TOAST_MS },
    ]);
    // A third comes as the first goes: the second keeps its own count.
    assert.deepEqual(toastsLeft([note(2), note(3)], shown, 6_000), [
      { id: 2, ms: 2_000 },
      { id: 3, ms: TOAST_MS },
    ]);
    assert.deepEqual([...shown.keys()], [2, 3], "the first is forgotten once it is gone");
  });

  test("a toast with a button keeps its longer time from when it showed, and a late reading never goes below nothing", () => {
    const shown = new Map<number, number>();
    toastsLeft([withButton(4)], shown, 1_000);
    assert.deepEqual(toastsLeft([withButton(4), note(5)], shown, 5_000), [
      { id: 4, ms: ACTION_TOAST_MS - 4_000 },
      { id: 5, ms: TOAST_MS },
    ]);
    assert.deepEqual(toastsLeft([withButton(4), note(5)], shown, 20_000), [
      { id: 4, ms: 0 },
      { id: 5, ms: 0 },
    ]);
  });

  test("the same words shown again under a new id start afresh, as a repeated refusal does", () => {
    const shown = new Map<number, number>();
    toastsLeft([note(6)], shown, 0);
    assert.deepEqual(toastsLeft([{ ...note(6), id: 7 }], shown, 4_000), [{ id: 7, ms: TOAST_MS }]);
  });
});
