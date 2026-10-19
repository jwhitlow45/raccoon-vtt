import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AttachSends, type AttachAnswer } from "./list.ts";

/** A small seeded generator, so a failing run can be replayed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("the Attach list's sends", () => {
  test("a refused controlled ride leaves the list open, a taken one closes it, and a second tap while waiting sends nothing", () => {
    const sends = new AttachSends();
    assert.equal(sends.tap("ride", true), true);
    assert.equal(sends.pending, "ride");
    assert.equal(sends.tap("carry", false), false);
    assert.equal(sends.answer("ride", "refused"), "stay");
    assert.equal(sends.tap("ride", true), true);
    assert.equal(sends.answer("carry", "taken"), null, "an answer for a row not waiting");
    assert.equal(sends.answer("ride", "taken"), "close");
    assert.equal(sends.tap("carry", false), true, "a predicted attach goes at once and waits for nothing");
    assert.equal(sends.pending, null);
  });

  test("random taps, answers, late answers, unsent ops and closes never send twice at once or act once the list is gone", () => {
    const keys = ["a", "b", "c"];
    const answers: AttachAnswer[] = ["taken", "refused", "unknown"];
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
      const sends = new AttachSends();
      /** What the server still owes an answer for: a waiting row's sends, late ones included. */
      const owed: string[] = [];
      let gone = false;
      let waiting: string | null = null;
      for (let step = 0; step < 40; step++) {
        const roll = next();
        if (roll < 0.4) {
          const key = pick(keys);
          const waits = next() < 0.6;
          const sent = sends.tap(key, waits);
          // Invariant: nothing is sent while a row waits, or once the list is gone.
          assert.equal(sent, !gone && waiting === null, `seed ${seed}: tap`);
          if (sent && waits) {
            waiting = key;
            if (next() < 0.1) {
              sends.unsent(key);
              waiting = null;
            } else owed.push(key);
          }
        } else if (roll < 0.85 && owed.length > 0) {
          const key = owed.splice(Math.floor(next() * owed.length), 1)[0]!;
          const answer = pick(answers);
          const result = sends.answer(key, answer);
          // Invariant: only the waiting row's answer acts, never after the list is gone, and a refusal keeps it open.
          if (gone || waiting !== key) assert.equal(result, null, `seed ${seed}: late answer`);
          else {
            assert.equal(result, answer === "refused" ? "stay" : "close", `seed ${seed}: answer`);
            waiting = null;
          }
        } else if (roll >= 0.97) {
          sends.gone();
          gone = true;
          waiting = null;
        }
        // Invariant: at most one row waits, and it is the one the test saw sent.
        assert.equal(sends.pending, waiting, `seed ${seed}: pending`);
      }
    }
  });
});
