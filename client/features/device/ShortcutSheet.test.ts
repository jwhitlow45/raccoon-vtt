import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * What the shortcut sheet asks once the key pressed for a row is taken.
 * From a row with a key, Swap gives the other row that key. From a row
 * with no key, the other row is left with none, or with its own default
 * back where the change that took this row's key goes with the swap, and
 * "Swap the two keys" told neither (ISO5P2-OPUS-5).
 */

const { takenWords } = await import("./ShortcutSheet.tsx");

const names: Record<string, string> = { "tool:fog": "Fog", "tool:ruler": "Ruler", turnLeft: "Turn left" };
const nameOf = (id: string) => names[id] ?? id;

describe("the sheet's question for a taken key", () => {
  test("from a row with a key, the two swap", () => {
    assert.deepEqual(takenWords({}, { id: "tool:fog", key: "r", by: "tool:ruler" }, nameOf), {
      line: "Already Ruler.",
      say: "R is already used by Ruler. Swap the two keys, or cancel.",
      button: "Swap",
    });
  });

  test("from a row with no key, a key another row has by default leaves that row with no key", () => {
    // Fog moved onto Q, Turn left's default, so Turn left has no key, and R is Ruler's own.
    assert.deepEqual(takenWords({ "tool:fog": "q" }, { id: "turnLeft", key: "r", by: "tool:ruler" }, nameOf), {
      line: "Already Ruler. Ruler will have no key.",
      say: "R is already used by Ruler. Ruler will have no key. Take it, or cancel.",
      button: "Take",
    });
  });

  test("from a row with no key, taking back its own default gives the other row its default again", () => {
    assert.deepEqual(takenWords({ "tool:fog": "q" }, { id: "turnLeft", key: "q", by: "tool:fog" }, nameOf), {
      line: "Already Fog. Fog goes back to F.",
      say: "Q is already used by Fog. Fog goes back to F. Take it, or cancel.",
      button: "Take",
    });
  });
});
