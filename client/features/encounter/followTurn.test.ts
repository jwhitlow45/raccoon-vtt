import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InitEntry } from "#shared/model.ts";
import { token as tok } from "#shared/testutil.ts";
import { turnFocus } from "./followTurn.ts";

const entry = (id: string, over: Partial<InitEntry> = {}): InitEntry => ({ id, value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false, ...over });

describe("the DM's camera follows the turn", () => {
  const tokens = {
    gob: tok("gob", { x: 4, y: 6 }),
    ogre: tok("ogre", { x: 10, y: 2, size: "large" }),
    far: tok("far", { sceneId: "s2", x: 4, y: 6 }),
    thorn: tok("thorn", { x: 1, y: 1, actor: { ref: "c-thorn" } }),
  };

  test("to the middle of the active token on this scene", () => {
    const encounter = { activeEntryId: "e2", entries: [entry("e1", { tokenId: "gob" }), entry("e2", { tokenId: "ogre" })] };
    assert.deepEqual(turnFocus(encounter, tokens, "s1"), { x: 11, y: 3 });
  });

  test("a row for a character finds that character's token", () => {
    const encounter = { activeEntryId: "e1", entries: [entry("e1", { characterId: "c-thorn" })] };
    assert.deepEqual(turnFocus(encounter, tokens, "s1"), { x: 1.5, y: 1.5 });
  });

  test("nowhere to go: no fight, nobody acting, or a token on another scene", () => {
    assert.equal(turnFocus(null, tokens, "s1"), null);
    assert.equal(turnFocus({ activeEntryId: null, entries: [entry("e1", { tokenId: "gob" })] }, tokens, "s1"), null);
    assert.equal(turnFocus({ activeEntryId: "e1", entries: [entry("e1", { tokenId: "far" })] }, tokens, "s1"), null);
    assert.equal(turnFocus({ activeEntryId: "e1", entries: [entry("e1", { tokenId: "gone" })] }, tokens, "s1"), null);
  });
});
