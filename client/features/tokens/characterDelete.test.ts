import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectState } from "#shared/project.ts";
import type { RoomState } from "#shared/model.ts";
import { DM, P1, character, entry, member, room, token } from "#shared/testutil.ts";
import { deleteWarning, sharedNote } from "./characterDelete.ts";

/** Bree, p1's alone, on the players' scene with two tokens and a companion, in a fight. */
function table(): RoomState {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
  state.tokens.bt = token("bt", { kind: "pc", name: "Bree", actor: { ref: "bree" }, x: 1, y: 1 });
  state.tokens.bt2 = token("bt2", { kind: "pc", name: "Bree", actor: { ref: "bree" }, x: 3, y: 1 });
  state.tokens.ws = token("ws", { name: "Wisp", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, x: 2, y: 1 });
  state.tokens.gob = token("gob", { name: "Goblin", x: 6, y: 6 });
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-bree", { tokenId: "bt" }), entry("e-gob", { tokenId: "gob" })] };
  return state;
}

/** The warning as the player reads it, from their own projection only. */
const warning = (state: RoomState) => deleteWarning(projectState(state, P1, { sceneId: state.meta.playerSceneId }) as unknown as RoomState, { id: "bree", name: "Bree" }, false);

/** What any warning names, every time, whatever the view holds. */
const EVERY_KIND = /token.*companion.*place in the fight/;

describe("what Remove says before a character's Delete", () => {
  test("names what the player's view holds, every other kind in general words, and that it cannot be undone", () => {
    assert.equal(
      warning(table()),
      "Deleting Bree also removes its 2 tokens here, 1 companion and its place in the fight, and any other token, companion or place in the fight it has. This cannot be undone.",
    );
  });

  test("one token, no companion, no fight: companions and the fight are still named", () => {
    const state = table();
    delete state.tokens.bt2;
    delete state.tokens.ws;
    state.encounter = null;
    assert.equal(warning(state), "Deleting Bree also removes its token here, and any other token, companion or place in the fight it has. This cannot be undone.");
  });

  test("companions alone, or a row by the character's id alone", () => {
    const state = table();
    delete state.tokens.bt;
    delete state.tokens.bt2;
    state.tokens.ws2 = token("ws2", { name: "Spark", ownerIds: ["p1"], companion: { of: "bree", turn: "own" }, x: 4, y: 4 });
    state.encounter = null;
    assert.equal(warning(state), "Deleting Bree also removes its 2 companions, and any other token, companion or place in the fight it has. This cannot be undone.");
    delete state.tokens.ws2;
    assert.match(warning(state), /removes its companion, and any other token/);
    delete state.tokens.ws;
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-c", { characterId: "bree" })] };
    assert.equal(warning(state), "Deleting Bree also removes its place in the fight, and any other token, companion or place in the fight it has. This cannot be undone.");
  });

  test("never counts a token or companion on another scene, or a row the DM hid, yet names them in general words", () => {
    const state = table();
    state.tokens.away = token("away", { kind: "pc", actor: { ref: "bree" }, sceneId: "s2", x: 5, y: 5 });
    state.tokens.far = token("far", { name: "Far Wisp", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, sceneId: "s2" });
    assert.equal(warning(state), warning(table()));
    // An off-scene companion and a hidden row, and nothing in view: the warning still says both go.
    delete state.tokens.bt;
    delete state.tokens.bt2;
    delete state.tokens.ws;
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-c", { characterId: "bree", hidden: true })] };
    assert.equal(warning(state), "Deleting Bree also removes every token, companion and place in the fight it has, on every map. This cannot be undone.");
  });

  test("counts a token of theirs the DM hid from the rest of the table, which their own view holds", () => {
    const state = table();
    state.tokens.veiled = token("veiled", { kind: "pc", actor: { ref: "bree" }, visibility: "dm", x: 5, y: 5 });
    assert.match(warning(state), /removes its 3 tokens here,/);
  });

  test("behind a blackout the view holds no table, so the words stay general", () => {
    const state = table();
    state.meta.view.blackout = true;
    assert.match(warning(state), EVERY_KIND);
    assert.equal(warning(state), "Deleting Bree also removes every token, companion and place in the fight it has, on every map. This cannot be undone.");
  });

  test("the DM's counts what the DM's view holds, and says nothing of undo, which the DM has", () => {
    const state = table();
    const dmView = projectState(state, DM, { sceneId: "s1" }) as unknown as RoomState;
    assert.equal(
      deleteWarning(dmView, { id: "bree", name: "Bree" }, true),
      "Deleting Bree also removes its 2 tokens here, 1 companion and its place in the fight, and any other token, companion or place in the fight it has.",
    );
  });
});

describe("why a shared character's page has no Delete", () => {
  const members = { p1: member("p1"), p2: { ...member("p2"), name: "Quin" }, p3: { ...member("p3"), name: "Ana" } };
  const cyra = (ownerIds: string[]) => character("cyra", { name: "Cyra", ownerIds });

  test("names the others as the roster does", () => {
    assert.equal(sharedNote("p1", cyra(["p1", "p2"]), members), "You and Quin both play Cyra, so only the DM can delete it.");
    assert.equal(sharedNote("p1", cyra(["p2", "p1", "p3"]), members), "You, Quin and Ana all play Cyra, so only the DM can delete it.");
  });

  test("an owner no longer on the roster is someone else", () => {
    assert.equal(sharedNote("p1", cyra(["p1", "gone"]), members), "Someone else plays Cyra too, so only the DM can delete it.");
  });
});
