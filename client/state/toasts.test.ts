import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACTION_TOAST_MS, drawnToasts, heldToasts, TOAST_MS, toastsLeft, withToast } from "./store.ts";
import type { Toast } from "./types.ts";

const note = (id: number, shownAt: number): Toast => ({ id, text: `Pat whispers: ${id}`, tone: "info", shownAt });
const withButton = (id: number, shownAt: number): Toast => ({ id, text: `Plate went off: Thorn. ${id}`, tone: "info", action: { label: "Save and damage", run() {} }, shownAt });

describe("toastsLeft (review LP16-PT-1)", () => {
  test("a toast keeps its own time when others come and go, so a whisper every few seconds never keeps the first one up", () => {
    assert.deepEqual(toastsLeft([note(1, 0)], 0), [{ id: 1, ms: TOAST_MS, runs: true }]);
    // Three seconds on a second whisper comes: the first has two left, not five again.
    assert.deepEqual(toastsLeft([note(1, 0), note(2, 3_000)], 3_000), [
      { id: 1, ms: 2_000, runs: true },
      { id: 2, ms: TOAST_MS, runs: true },
    ]);
    // A third comes as the first goes: the second keeps its own count.
    assert.deepEqual(toastsLeft([note(2, 3_000), note(3, 6_000)], 6_000), [
      { id: 2, ms: 2_000, runs: true },
      { id: 3, ms: TOAST_MS, runs: true },
    ]);
  });

  test("a toast with a button keeps its longer time from when it showed, and a late reading never goes below nothing", () => {
    assert.deepEqual(toastsLeft([withButton(4, 1_000), note(5, 5_000)], 5_000), [
      { id: 4, ms: ACTION_TOAST_MS - 4_000, runs: true },
      { id: 5, ms: TOAST_MS, runs: true },
    ]);
    assert.deepEqual(toastsLeft([withButton(4, 1_000), note(5, 5_000)], 20_000), [
      { id: 4, ms: 0, runs: true },
      { id: 5, ms: 0, runs: true },
    ]);
  });

  test("the same words shown again under a new id start afresh, as a repeated refusal does", () => {
    assert.deepEqual(toastsLeft([{ ...note(6, 0), id: 7, shownAt: 4_000 }], 4_000), [{ id: 7, ms: TOAST_MS, runs: true }]);
  });

  test("its time counts from when it showed, not from when it was drawn again, so a blackout that takes the toasts off screen never restarts it (review LP16-R1-1)", () => {
    // Shown at 0, off screen from 1 s for a pause, back at 4 s: one second left, not five.
    assert.deepEqual(toastsLeft([note(8, 0)], 4_000), [{ id: 8, ms: 1_000, runs: true }]);
  });
});

describe("withToast: past three toasts, only whispers and rolls give way (reviews LP18-TO-1 and LP18-ASTRA-01)", () => {
  const logged = (id: number): Toast => ({ ...note(id, id), logged: true });
  const refusal = (id: number): Toast => ({ id, text: `Could not undo moving Thorn ${id}.`, tone: "error", shownAt: id });
  const ids = (list: readonly Toast[]) => list.map((t) => t.id);

  test("a fourth toast pushes off the oldest whisper or roll first, so a refusal and a trap's Save and damage stay", () => {
    // The DM's phone: the trap's toast, a refusal, then a roll and a whisper.
    let list = withToast([], { ...withButton(1, 1), logged: true });
    list = withToast(list, refusal(2));
    list = withToast(list, logged(3));
    list = withToast(list, logged(4));
    assert.deepEqual(ids(list), [1, 2, 4]);
    list = withToast(list, logged(5));
    assert.deepEqual(ids(list), [1, 2, 5]);
  });

  test("with no older whisper or roll to give way, nothing goes: refusals and buttons stay past three, and the newest always stays (review LP18-ASTRA-01)", () => {
    let list = withToast([], refusal(1));
    list = withToast(list, refusal(2));
    list = withToast(list, withButton(3, 3));
    list = withToast(list, logged(4));
    assert.deepEqual(ids(list), [1, 2, 3, 4]);
    // The next whisper pushes off the one before it, never a refusal.
    list = withToast(list, logged(5));
    assert.deepEqual(ids(list), [1, 2, 3, 5]);
    list = withToast(list, refusal(6));
    assert.deepEqual(ids(list), [1, 2, 3, 6]);
    list = withToast(list, refusal(7));
    assert.deepEqual(ids(list), [1, 2, 3, 6, 7]);
    assert.deepEqual(ids(withToast([logged(8), logged(9), logged(10)], logged(11))), [9, 10, 11]);
  });

  test("a trap's toast with Save and damage, two refusals and then a roll: all four stay (review LP18-OPUS-1)", () => {
    let list = withToast([], { ...withButton(1, 1), logged: true });
    list = withToast(list, refusal(2));
    list = withToast(list, refusal(3));
    list = withToast(list, { ...logged(4), die: { face: 17, ring: false, fumble: false, verdict: null } });
    assert.deepEqual(ids(list), [1, 2, 3, 4]);
  });
});

describe("a toast's time starts as it first draws, and stops while it shows whole (docs/design-v1-bar-compact.md 3.5, review BC-OPUS-35)", () => {
  const waiting = (id: number): Toast => ({ id, text: `A group save with rolls is already open. ${id}`, tone: "error" });
  const left = (list: readonly Toast[], now: number) => toastsLeft(list, now).map((t) => [t.id, t.ms, t.runs]);

  test("an error waiting behind an action toast in the one row has its whole time and no timer until it draws, then its whole time from then", () => {
    let list: readonly Toast[] = [withButton(1, 0), waiting(2)];
    assert.deepEqual(left(list, 10_000), [
      [1, ACTION_TOAST_MS - 10_000, true],
      [2, TOAST_MS, false],
    ]);
    // The action toast goes at 12 s, and the error takes the row then.
    list = drawnToasts(list.slice(1), [2], 12_000);
    assert.deepEqual(left(list, 12_000), [[2, TOAST_MS, true]]);
    assert.deepEqual(left(list, 15_000), [[2, TOAST_MS - 3_000, true]]);
  });

  test("a second draw and later reads never move a stamp, and drawing nothing new gives the same array back", () => {
    const once = drawnToasts([waiting(3)], [3], 1_000);
    assert.equal(drawnToasts(once, [3], 4_000), once);
    assert.equal(once[0]?.shownAt, 1_000);
    assert.equal(drawnToasts(once, [99], 4_000), once, "an id that is not there");
    const both = drawnToasts([...once, waiting(9)], [3, 9], 5_000);
    assert.deepEqual(both.map((t) => t.shownAt), [1_000, 5_000], "drawn with a new one, the old keeps its stamp");
    assert.deepEqual(left(once, 2_000), [[3, TOAST_MS - 1_000, true]]);
  });

  test("shown whole, a toast's time stops, and shrunk back it runs on from what it had left", () => {
    let list: readonly Toast[] = [withButton(4, 0)];
    list = heldToasts(list, 4, true, 3_000);
    assert.deepEqual(left(list, 60_000), [[4, ACTION_TOAST_MS - 3_000, false]], "held for a minute, it has 9 s left, and no timer");
    assert.equal(heldToasts(list, 4, true, 70_000), list, "held twice changes nothing");
    list = heldToasts(list, 4, false, 60_000);
    assert.equal(list[0]?.shownAt, 57_000);
    assert.equal(list[0]?.pausedAt, undefined);
    assert.deepEqual(left(list, 60_000), [[4, ACTION_TOAST_MS - 3_000, true]]);
    assert.equal(heldToasts(list, 4, false, 61_000), list, "let go twice changes nothing");
    assert.equal(heldToasts([waiting(5)], 5, true, 0)[0]?.pausedAt, undefined, "one not drawn yet has no time to stop");
  });

  test("a toast that arrives while another shows whole waits with its whole time", () => {
    const list: readonly Toast[] = [...heldToasts([withButton(6, 0)], 6, true, 2_000), waiting(7)];
    assert.deepEqual(left(list, 30_000), [
      [6, ACTION_TOAST_MS - 2_000, false],
      [7, TOAST_MS, false],
    ]);
  });

  test("many orders of arrivals, draws, holds, releases, rerenders and time: no toast runs out before it has shown for its whole time (randomized)", () => {
    // A small seeded generator, so a failure names its seed and repeats.
    for (let seed = 1; seed <= 200; seed++) {
      let state = seed;
      const rand = (n: number) => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state % n;
      };
      let now = 0;
      let list: readonly Toast[] = [];
      let next = 1;
      /** For each toast, how long it has shown with its time running, counted outside the store. */
      const ran = new Map<number, number>();
      const stamps = new Map<number, number>();
      for (let step = 0; step < 60; step++) {
        const event = rand(6);
        if (event === 0) {
          const id = next++;
          list = withToast(list, rand(2) === 0 ? waiting(id) : { ...withButton(id, 0), shownAt: undefined });
          ran.set(id, 0);
        } else if (event === 1 && list.length > 0) {
          list = drawnToasts(list, [list[rand(list.length)]!.id], now);
        } else if (event === 2 && list.length > 0) {
          list = heldToasts(list, list[rand(list.length)]!.id, rand(2) === 0, now);
        } else if (event === 3) {
          // A rerender reads again and draws what already drew.
          list = drawnToasts(list, list.filter((t) => t.shownAt !== undefined).map((t) => t.id), now);
        } else {
          const dt = 500 + rand(4_000);
          // Time passes: each running toast's timer fires at its end, never before.
          for (const t of toastsLeft(list, now)) if (t.runs) ran.set(t.id, (ran.get(t.id) ?? 0) + Math.min(dt, t.ms));
          now += dt;
          const ended = new Set(toastsLeft(list, now).filter((t) => t.runs && t.ms === 0).map((t) => t.id));
          for (const t of list) {
            if (!ended.has(t.id)) continue;
            const whole = t.action ? ACTION_TOAST_MS : TOAST_MS;
            // Invariant: a toast goes only once its time has run whole while drawn and not held.
            assert.ok(Math.abs((ran.get(t.id) ?? 0) - whole) < 1e-6, `seed ${seed}: toast ${t.id} went after ${ran.get(t.id)} ms of its ${whole}`);
          }
          list = list.filter((t) => !ended.has(t.id));
        }
        for (const t of list) {
          // Invariant: a toast not drawn yet never runs.
          if (t.shownAt === undefined) assert.equal(toastsLeft([t], now)[0]?.runs, false, `seed ${seed}: toast ${t.id} runs undrawn`);
          // Invariant: a stamp moves only forward, as a release moves it on by the time held, never back.
          const was = stamps.get(t.id);
          if (t.shownAt !== undefined) {
            assert.ok(was === undefined || t.shownAt >= was, `seed ${seed}: toast ${t.id}'s stamp went back`);
            stamps.set(t.id, t.shownAt);
          }
          // Invariant: no toast ever has more than its whole time left.
          const whole = t.action ? ACTION_TOAST_MS : TOAST_MS;
          assert.ok((toastsLeft([t], now)[0]?.ms ?? 0) <= whole, `seed ${seed}: toast ${t.id} has more than its time`);
        }
      }
    }
  });
});
