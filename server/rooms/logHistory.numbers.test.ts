import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { creatureName } from "#shared/logText.ts";
import { DM, P1, room, scene, token } from "#shared/testutil.ts";
import { captureView, viewNames } from "./logHistory.ts";

/*
 * The names a session's file reads creatures by (viewNames): the DM's from
 * the whole room with the table's numbers (shared/numbering.ts), and a
 * player's from their copy, which carries them already.
 */

function numberedRoom() {
  return room({
    scenes: { s1: scene("s1", { numbers: { names: { Goblin: [1, 2] } } }), s2: scene("s2", { order: 1 }) },
    tokens: {
      orc: token("orc", { name: "Orc", nameHidden: true, publicName: "Goblin", met: 1, number: 2 }),
      old: token("old", { name: "Kobold", number: 7 }),
    },
  });
}

describe("the names a session's file reads with", () => {
  test("the DM reads the table's numbers, a disguise after its name, and no number the table did not give", () => {
    const names = viewNames(captureView({ state: numberedRoom(), through: 1 }, "R", DM));
    assert.equal(creatureName(names, { tokenId: "orc" }), "Orc (as Goblin 2)");
    assert.equal(creatureName(names, { tokenId: "old" }), "Kobold");
  });

  test("a player reads the name players read with its number", () => {
    const names = viewNames(captureView({ state: numberedRoom(), through: 1 }, "R", P1));
    assert.equal(creatureName(names, { tokenId: "orc" }), "Goblin 2");
    assert.equal(creatureName(names, { tokenId: "old" }), "Kobold");
  });
});
