import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACTION_TOAST_MS, TOAST_MS, toastsLeft } from "./store.ts";
import type { Toast } from "./types.ts";

const note = (id: number, shownAt: number): Toast => ({ id, text: `Pat whispers: ${id}`, tone: "info", shownAt });
const withButton = (id: number, shownAt: number): Toast => ({ id, text: `Plate went off: Thorn. ${id}`, tone: "info", action: { label: "Save and damage", run() {} }, shownAt });

describe("toastsLeft (review LP16-PT-1)", () => {
  test("a toast keeps its own time when others come and go, so a whisper every few seconds never keeps the first one up", () => {
    assert.deepEqual(toastsLeft([note(1, 0)], 0), [{ id: 1, ms: TOAST_MS }]);
    // Three seconds on a second whisper comes: the first has two left, not five again.
    assert.deepEqual(toastsLeft([note(1, 0), note(2, 3_000)], 3_000), [
      { id: 1, ms: 2_000 },
      { id: 2, ms: TOAST_MS },
    ]);
    // A third comes as the first goes: the second keeps its own count.
    assert.deepEqual(toastsLeft([note(2, 3_000), note(3, 6_000)], 6_000), [
      { id: 2, ms: 2_000 },
      { id: 3, ms: TOAST_MS },
    ]);
  });

  test("a toast with a button keeps its longer time from when it showed, and a late reading never goes below nothing", () => {
    assert.deepEqual(toastsLeft([withButton(4, 1_000), note(5, 5_000)], 5_000), [
      { id: 4, ms: ACTION_TOAST_MS - 4_000 },
      { id: 5, ms: TOAST_MS },
    ]);
    assert.deepEqual(toastsLeft([withButton(4, 1_000), note(5, 5_000)], 20_000), [
      { id: 4, ms: 0 },
      { id: 5, ms: 0 },
    ]);
  });

  test("the same words shown again under a new id start afresh, as a repeated refusal does", () => {
    assert.deepEqual(toastsLeft([{ ...note(6, 0), id: 7, shownAt: 4_000 }], 4_000), [{ id: 7, ms: TOAST_MS }]);
  });

  test("its time counts from when it showed, not from when it was drawn again, so a blackout that takes the toasts off screen never restarts it (review LP16-R1-1)", () => {
    // Shown at 0, off screen from 1 s for a pause, back at 4 s: one second left, not five.
    assert.deepEqual(toastsLeft([note(8, 0)], 4_000), [{ id: 8, ms: 1_000 }]);
  });
});
