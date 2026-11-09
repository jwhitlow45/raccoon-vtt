import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { room, token } from "#shared/testutil.ts";
import { ATTIC, CAVE, playerCopy, TOWER, tower, UPPER } from "./testing.ts";
import { backLabel, floorButtonLabel, floorMarks, floorRowDetail, floorStatus, floorTip, followedLine, noFloorAbove, noFloorBelow, placeKind, placeName, playersPlace, showingLine, viewingLine } from "./words.ts";

/*
 * The floors' words (docs/design/design-v1-floors.md 7.2, 7.3, 18.6): one
 * helper names the players' place everywhere (FLR32-OPUS-06), and the
 * Floor button, the Floors menu, the Viewing notice and the polite status
 * say the floor alike.
 */

describe("the players' place", () => {
  test("a floor names its scene and itself, a scene of one floor its own name, and a gone scene nothing", () => {
    const state = tower();
    assert.equal(placeName(state, UPPER), "Tower · Upper floor");
    assert.equal(placeName(state, CAVE), "Cave");
    assert.equal(placeName(state, "gone"), "");
    assert.equal(placeName(room(), "s1"), "s1");
  });

  test("another floor of the scene in view is \"another floor\", a place elsewhere its whole name", () => {
    const state = tower();
    assert.equal(playersPlace(state, TOWER, UPPER), "another floor");
    assert.equal(playersPlace(state, TOWER, CAVE), "Tower · Ground floor");
    assert.equal(playersPlace(state, TOWER, TOWER), "Tower · Ground floor");
    assert.equal(playersPlace(state, TOWER, null), "Tower · Ground floor");
    assert.equal(placeKind(state, TOWER, ATTIC), "floor");
    assert.equal(placeKind(state, TOWER, CAVE), "scene");
  });
});

describe("the floors' own words", () => {
  test("the bar, its tooltip, the Menu panel's row, the notice and the status", () => {
    assert.equal(floorButtonLabel("Upper floor"), "Floor: Upper floor. Show another floor");
    assert.equal(floorTip({ below: "[", above: "]" }), "Show another floor ([ and ])");
    assert.equal(floorTip(null), "Show another floor", "a touch screen names no keys");
    assert.equal(floorRowDetail("Upper floor", "Tower"), "Showing Upper floor. Show another floor of Tower.");
    assert.equal(viewingLine("Upper floor"), "Viewing Upper floor.");
    assert.equal(backLabel("Thorn"), "Back to Thorn");
    assert.equal(showingLine("Upper floor"), "Showing Upper floor.");
    assert.equal(followedLine("Thorn", "Upper floor"), "Thorn is on Upper floor. Showing Upper floor.");
    assert.equal(noFloorAbove("Attic"), "No floor above Attic.");
    assert.equal(noFloorBelow("Ground floor"), "No floor below Ground floor.");
  });

  test("a DM's row: Players here on the start floor and under an unhidden party member, Reached with a mark, else Not reached yet, with the party by initials", () => {
    const state = tower({ openFloors: { [ATTIC]: { sceneId: ATTIC, rev: 0 } } });
    assert.equal(floorStatus(state, TOWER), "Players here");
    assert.equal(floorStatus(state, ATTIC), "Reached");
    assert.equal(floorStatus(state, UPPER), "Not reached yet");
    const up = tower({ tokens: { ...tower().tokens, bree: { ...tower().tokens.bree!, sceneId: UPPER } } });
    assert.equal(floorStatus(up, UPPER), "Players here");
    const hidden = tower({ tokens: { ...tower().tokens, bree: { ...tower().tokens.bree!, sceneId: UPPER, visibility: "dm" } } });
    assert.equal(floorStatus(hidden, UPPER), "Not reached yet", "a party member the DM hid opens nothing");
    const elsewhere = tower({ meta: { ...tower().meta, playerSceneId: CAVE }, tokens: { ...tower().tokens, bree: { ...tower().tokens.bree!, sceneId: UPPER } } });
    assert.equal(floorStatus(elsewhere, UPPER), "Not reached yet", "on a scene the players are not on, a party member there is no player there");
    assert.equal(floorStatus(elsewhere, TOWER), "Not reached yet");
    const dm = { memberId: "dm1", role: "dm" as const };
    assert.deepEqual(floorMarks(state, state.scenes[TOWER]!, dm, null), ["Players here", "Br Th"]);
    assert.deepEqual(floorMarks(state, state.scenes[UPPER]!, dm, null), ["Not reached yet"]);
  });

  test("a player's row: You are here on their creature's floor, and the party's creatures there they see", () => {
    const state = tower({ openFloors: { [UPPER]: { sceneId: UPPER, rev: 0 } } });
    const copy = playerCopy(state, [TOWER, UPPER]);
    const p1 = { memberId: "p1", role: "player" as const };
    assert.deepEqual(floorMarks(copy, copy.scenes[TOWER]!, p1, TOWER), ["You are here", "Bree, Thorn"]);
    assert.deepEqual(floorMarks(copy, copy.scenes[UPPER]!, p1, TOWER), []);
  });

  test("a player's row names another player's companion by the projected party mark", () => {
    const state = tower();
    const copy = playerCopy(state, [TOWER]);
    // On a player's copy another player's token carries no owners, only the mark.
    copy.tokens["wolf"] = token("wolf", { sceneId: TOWER, kind: "npc", name: "Wolf companion", disposition: "ally", party: true } as never);
    copy.tokens["goblin"] = token("goblin", { sceneId: TOWER, kind: "npc", name: "Goblin", disposition: "hostile" });
    const p1 = { memberId: "p1", role: "player" as const };
    assert.deepEqual(floorMarks(copy, copy.scenes[TOWER]!, p1, TOWER), ["You are here", "Bree, Thorn, Wolf companion"]);
  });
});
