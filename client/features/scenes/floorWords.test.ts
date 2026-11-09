import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LIMITS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { FLOOR_HEIGHT } from "#shared/protocol.ts";
import { room, scene, token } from "#shared/testutil.ts";
import { FLOOR_SEARCH } from "../floors/ids.ts";
import { addRefusal, FLOOR_MARKS, floorRowLabel, floorSettingsLine, floorsSummary, floorsTopFirst, GO_TO_FLOOR, heightOf, hideRefusal, ON_SCREEN, orderAfterMove, playersAt, removeRefusal, stepHeight } from "./floorWords.ts";

/*
 * The Floors group's and a floor's page's words and rules
 * (docs/design/design-v1-floors.md 7.1): where the players stand with a
 * floor, what is off and why, the stack's order and the height stepper.
 */

/** Tower with Ground (main), Upper and Roof, the players starting on Ground. */
function tower(over: (s: RoomState) => void = () => {}): RoomState {
  const state = room({
    scenes: {
      g: scene("g", { name: "Tower", floor: { of: "g", level: 0, name: "Ground floor" } }),
      u: scene("u", { name: "Tower", floor: { of: "g", level: 1, name: "Upper floor", height: 10 } }),
      r: scene("r", { name: "Tower", floor: { of: "g", level: 2, name: "Roof", height: 15 } }),
    },
  });
  state.meta = { ...state.meta, playerSceneId: "g" };
  over(state);
  return state;
}

const party = (id: string, sceneId: string, extra: Partial<RoomState["tokens"][string] & object> = {}) => token(id, { sceneId, kind: "pc", partyVision: true, ...extra });

describe("where the players stand with a floor", () => {
  test("here on the start floor, and where an unhidden party member stands", () => {
    const state = tower((s) => void (s.tokens.t1 = party("t1", "u")));
    assert.equal(playersAt(state, state.scenes.g!), "here");
    assert.equal(playersAt(state, state.scenes.u!), "here");
    assert.equal(playersAt(state, state.scenes.r!), "not");
  });

  test("a hidden party member opens nothing and stands for nobody", () => {
    const state = tower((s) => void (s.tokens.t1 = party("t1", "u", { visibility: "dm" })));
    assert.equal(playersAt(state, state.scenes.u!), "not");
  });

  test("a floor with an opened mark is reached", () => {
    const state = tower((s) => void (s.openFloors = { r: { sceneId: "r", rev: 0 } }));
    assert.equal(playersAt(state, state.scenes.r!), "reached");
    assert.deepEqual(FLOOR_MARKS, { here: "Players here", reached: "Reached", not: "Not reached yet" });
  });

  test("a floor of another scene than the players' is not reached", () => {
    const state = tower((s) => {
      s.scenes.cave = scene("cave", { name: "Cave", floor: { of: "cave", level: 0, name: "Ground floor" } });
      s.scenes.cave2 = scene("cave2", { name: "Cave", floor: { of: "cave", level: 1, name: "Deep", height: 10 } });
    });
    assert.equal(playersAt(state, state.scenes.cave2!), "not");
  });

  test("a party member on a floor of a scene the DM prepares in private is no player there: Hide goes, and Remove still waits for them, as the server does", () => {
    const state = tower((s) => {
      s.scenes.cave = scene("cave", { name: "Cave", floor: { of: "cave", level: 0, name: "Ground floor" } });
      s.scenes.cave2 = scene("cave2", { name: "Cave", floor: { of: "cave", level: 1, name: "Deep", height: 10 } });
      s.tokens.t1 = party("t1", "cave2");
    });
    assert.equal(playersAt(state, state.scenes.cave2!), "not");
    assert.equal(hideRefusal(state, state.scenes.cave2!), null, "nothing opens there, so Hide guards nothing");
    assert.equal(removeRefusal(state, state.scenes.cave2!), "Move the party off Deep first.", "a removal would delete them");
  });

  test("a floor reached before stays reached while the players are on another scene", () => {
    const state = tower((s) => {
      s.scenes.cave = scene("cave", { name: "Cave", floor: { of: "cave", level: 0, name: "Ground floor" } });
      s.scenes.cave2 = scene("cave2", { name: "Cave", floor: { of: "cave", level: 1, name: "Deep", height: 10 } });
      s.openFloors = { cave2: { sceneId: "cave2", rev: 0 } };
    });
    assert.equal(playersAt(state, state.scenes.cave2!), "reached");
  });
});

describe("the group's lines", () => {
  test("floors list top first, and the summary names the floor on screen", () => {
    const state = tower();
    assert.deepEqual(floorsTopFirst(state, "u").map((f) => f.id), ["r", "u", "g"]);
    const floors = floorsTopFirst(state, "u").reverse();
    assert.equal(floorsSummary(floors, "u"), "3 floors · Upper floor on screen");
    assert.equal(floorsSummary([scene("x")], "x"), "One floor");
    assert.equal(floorSettingsLine("Upper floor"), "The groups below set Upper floor. Each floor keeps its own.");
  });

  test("the floor on screen reads On screen, never Shown beside Show to players, and its page goes to it", () => {
    assert.equal(ON_SCREEN, "On screen");
    assert.equal(floorRowLabel("Upper floor", "Not reached yet", true), "Upper floor, Not reached yet, on screen. Open its page");
    assert.equal(floorRowLabel("Attic", "Reached", false), "Attic, Reached. Open its page");
    assert.equal(GO_TO_FLOOR, "Go to this floor");
  });

  test("a ninth floor is refused in the server's words", () => {
    assert.equal(addRefusal(LIMITS.floorsPerScene - 1, "Tower"), null);
    assert.equal(addRefusal(LIMITS.floorsPerScene, "Tower"), "Tower already has 8 floors, the most a scene can have.");
  });
});

describe("what Hide and Remove refuse, in the words of 7.1", () => {
  test("Hide is off on the start floor and while an unhidden party member stands there", () => {
    const state = tower((s) => void (s.tokens.t1 = party("t1", "u")));
    assert.equal(hideRefusal(state, state.scenes.g!), "The players start here.");
    assert.equal(hideRefusal(state, state.scenes.u!), "Players are on Upper floor.");
    assert.equal(hideRefusal(state, state.scenes.r!), null);
  });

  test("Remove is off on the main floor, the start floor and with the party there", () => {
    const state = tower((s) => void (s.tokens.t1 = party("t1", "u")));
    assert.equal(removeRefusal(state, state.scenes.g!), "Tower was made with this floor. Delete Tower from its menu to remove every floor.");
    assert.equal(removeRefusal(state, state.scenes.u!), "Move the party off Upper floor first.");
    assert.equal(removeRefusal(state, state.scenes.r!), null);
    const start = tower((s) => void (s.meta = { ...s.meta, playerSceneId: "u" }));
    assert.equal(removeRefusal(start, start.scenes.u!), "The players start here. Move the players to another floor first.");
  });
});

describe("the stack's order and the height stepper", () => {
  test("Move up and Move down swap neighbors, bottom first, and stop at the ends", () => {
    const floors = [{ id: "g" }, { id: "u" }, { id: "r" }];
    assert.deepEqual(orderAfterMove(floors, "u", true), ["g", "r", "u"]);
    assert.deepEqual(orderAfterMove(floors, "u", false), ["u", "g", "r"]);
    assert.equal(orderAfterMove(floors, "r", true), null);
    assert.equal(orderAfterMove(floors, "g", false), null);
    assert.equal(orderAfterMove(floors, "nope", true), null);
  });

  test("height steps by 5 ft between 5 and 50, and reads 10 when none is stored", () => {
    assert.equal(stepHeight(10, 1), 15);
    assert.equal(stepHeight(10, -1), 5);
    assert.equal(stepHeight(FLOOR_HEIGHT.min, -1), null);
    assert.equal(stepHeight(FLOOR_HEIGHT.max, 1), null);
    assert.equal(heightOf({ floor: { of: "g", level: 1, name: "Upper" } }), 10);
    assert.equal(heightOf({ floor: { of: "g", level: 1, name: "Upper", height: 25 } }), 25);
  });
});

describe("the search anchors", () => {
  test("every control of the Floors group carries its anchor from the contract as a literal, which the catalog test finds", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = ["FloorsGroup.tsx", "FloorPage.tsx"].map((f) => readFileSync(resolve(here, f), "utf8")).join("\n");
    for (const [name, id] of Object.entries(FLOOR_SEARCH)) {
      assert.equal((source.match(new RegExp(`search="${id.replaceAll(".", "\\.")}"`, "g")) ?? []).length, 1, `${name}: ${id}`);
    }
  });
});
