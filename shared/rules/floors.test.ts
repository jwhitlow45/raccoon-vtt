import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Scene, Viewer } from "../model.ts";
import { isPartyMember, ownsToken, projectState, viewerSceneId } from "../project.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, P2, character, env, randomState, rng, room, scene, token } from "../testutil.ts";
import { floorsOf, heldFloors, mainFloorId, onPlayersScene, openFloor, ownedBy, playersSee, sameScene, startFloor, unhiddenPartyMember } from "./floors.ts";

/*
 * The questions that replace "the players' scene" (docs/design/design-v1-floors.md
 * 8, 8.3): on the server's state, on a DM's copy and on a player's copy, and
 * on rooms without floors, where each gives the answer it gave before.
 */

const DISPLAY: Viewer = { memberId: "tv", role: "player" };
const floor = (id: string, level: number, name: string, over: Partial<Scene> = {}): Scene =>
  scene(id, { name: "Tower", floor: { of: "g", level, name, height: 10 }, ...over });

/** Tower: Ground (g, the start floor), Upper (u), Attic (a), and a prep scene with its own floors (p, p2). */
function tower(over: Partial<RoomState> = {}): RoomState {
  return room({
    meta: { ...room().meta, playerSceneId: "g" },
    scenes: {
      a: floor("a", 2, "Attic"),
      g: floor("g", 0, "Ground floor"),
      u: floor("u", 1, "Upper floor"),
      p: scene("p", { order: 1, floor: { of: "p", level: 0, name: "Cellar", height: 10 } }),
      p2: scene("p2", { order: 1, floor: { of: "p", level: 1, name: "Roof", height: 10 } }),
    },
    characters: { thorn: character("thorn", { ownerIds: ["p1"] }) },
    ...over,
  });
}
const thornOn = (sceneId: string, over = {}) => token("thorn", { sceneId, kind: "pc", actor: { ref: "thorn" }, ...over });
const held = (state: RoomState, viewer: Viewer, sceneId: string | null = null) => [...heldFloors(state, viewer, { sceneId })].sort();

describe("a scene's floors", () => {
  test("bottom first, the scene alone without floors, none when gone", () => {
    const state = tower();
    assert.deepEqual(
      floorsOf(state, "u").map((s) => s.id),
      ["g", "u", "a"],
    );
    assert.deepEqual(
      floorsOf(state, "p2").map((s) => s.id),
      ["p", "p2"],
    );
    assert.deepEqual(
      floorsOf(room(), "s1").map((s) => s.id),
      ["s1"],
    );
    assert.deepEqual(floorsOf(room(), "gone"), []);
    assert.equal(mainFloorId(state, "a"), "g");
    assert.equal(mainFloorId(room(), "s1"), "s1");
    assert.ok(sameScene(state, "g", "a"));
    assert.ok(!sameScene(state, "g", "p"));
    assert.ok(!sameScene(room(), "s1", "s2"));
  });
});

describe("the six questions (8.3)", () => {
  test("the start floor and the players' scene", () => {
    const state = tower();
    assert.equal(startFloor(state), "g");
    assert.deepEqual(
      ["g", "u", "a", "p", "p2"].map((id) => onPlayersScene(state, id)),
      [true, true, true, false, false],
    );
  });

  test("open floors: the start floor, a mark, an unhidden party member, never a prep scene", () => {
    const plain = tower();
    assert.deepEqual(
      ["g", "u", "a", "p"].map((id) => openFloor(plain, id)),
      [true, false, false, false],
    );
    const marked = tower({ openFloors: { a: { sceneId: "a", rev: 0 }, p: { sceneId: "p", rev: 0 } } });
    assert.deepEqual(
      ["u", "a", "p"].map((id) => openFloor(marked, id)),
      [false, true, false],
    );
    const party = tower({ tokens: { thorn: thornOn("u") } });
    assert.ok(openFloor(party, "u"));
    const hidden = tower({ tokens: { thorn: thornOn("u", { visibility: "dm" }) } });
    assert.ok(!openFloor(hidden, "u"), "a party member the DM hid opens nothing");
    const ally = tower({ tokens: { wolf: token("wolf", { sceneId: "u", partyVision: true }) } });
    assert.ok(openFloor(ally, "u"), "an ally lending sight is a party member");
    assert.ok(unhiddenPartyMember(ally, ally.tokens.wolf!));
  });

  test("open floors are blackout-blind, and players see none behind a blackout", () => {
    const state = tower();
    const dark = { ...state, meta: { ...state.meta, view: { follow: false, blackout: true } } };
    assert.ok(openFloor(dark, "g"));
    assert.ok(playersSee(state, "g"));
    assert.ok(!playersSee(dark, "g"));
    assert.ok(!playersSee(state, "u"));
  });
});

describe("held floors (8, 8.1)", () => {
  test("a DM holds every floor of the scene they view, a player the open floors and their own creatures' floors", () => {
    const state = tower({ tokens: { thorn: thornOn("a", { visibility: "dm" }) } });
    assert.deepEqual(held(state, DM, "u"), ["a", "g", "u"]);
    assert.deepEqual(held(state, DM, "p"), ["p", "p2"]);
    assert.deepEqual(held(state, DM, null), []);
    assert.deepEqual(held(state, P1), ["a", "g"], "Ana holds Attic, where her hidden Thorn stands");
    assert.deepEqual(held(state, P2), ["g"], "Bree gets nothing of it");
    assert.deepEqual(held(state, DISPLAY), ["g"], "nor does the table display");
  });

  test("a creature a player owns on a prep scene pulls nothing in, and a blackout holds nothing", () => {
    const state = tower({ tokens: { thorn: thornOn("p2") } });
    assert.deepEqual(held(state, P1), ["g"]);
    const dark = { ...state, meta: { ...state.meta, view: { follow: false, blackout: true } } };
    assert.deepEqual(held(dark, P1), []);
    assert.deepEqual(held(dark, DM, "g"), ["a", "g", "u"]);
  });

  test("on a projected copy: a player's delivered floors, a DM's the floors of the projected scene", () => {
    const state = tower({ tokens: { thorn: thornOn("a", { visibility: "dm" }) } });
    const copy = projectState(state, P1, { sceneId: null }) as unknown as RoomState;
    assert.deepEqual(held(copy, P1), Object.keys(copy.scenes).sort());
    const dmCopy = projectState(state, DM, { sceneId: "g" }) as unknown as RoomState;
    assert.deepEqual(held(dmCopy, DM, "g"), ["a", "g", "u"]);
  });

  test("a finished state's answer is kept, a state a transaction still writes is asked again", () => {
    const state = tower();
    assert.equal(heldFloors(state, P1, { sceneId: null }), heldFloors(state, P1, { sceneId: null }));
    const moved = applyOp(state, { t: "token.create", token: { id: "thorn", sceneId: "u", kind: "pc", name: "Thorn", size: "medium", x: 1, y: 1, actor: { ref: "thorn" } } }, DM, env(1));
    assert.ok(moved.ok);
    assert.deepEqual(held(moved.state, P2), ["g", "u"], "Thorn opens Upper for everyone");
  });
});

describe("the ownership rules restated for the limits", () => {
  test("match project.ts's party members and owners over random rooms", () => {
    for (let seed = 0; seed < 40; seed++) {
      const state = randomState(rng(seed));
      for (const t of Object.values(state.tokens)) {
        assert.equal(unhiddenPartyMember(state, t), t.visibility !== "dm" && isPartyMember(state, t), `seed ${seed}, ${t.id}`);
        for (const viewer of [P1, P2, DM]) assert.equal(ownedBy(state, viewer.memberId, t), ownsToken(state, viewer, t), `seed ${seed}, ${t.id}, ${viewer.memberId}`);
      }
    }
  });
});

describe("rooms without floors give today's answers (8.3)", () => {
  test("held floors are the scene each viewer covers, and the questions are the players' scene", () => {
    for (let seed = 0; seed < 40; seed++) {
      const state = randomState(rng(seed));
      for (const viewer of [DM, P1, P2, DISPLAY]) {
        for (const sceneId of [null, ...Object.keys(state.scenes)]) {
          const today = viewerSceneId(state, viewer, { sceneId });
          const expected = today === null || !state.scenes[today] ? [] : [today];
          assert.deepEqual(held(state, viewer, sceneId), expected, `seed ${seed}, ${viewer.memberId} on ${sceneId}`);
        }
      }
      for (const id of Object.keys(state.scenes)) {
        const players = state.meta.playerSceneId === id;
        assert.equal(onPlayersScene(state, id), players);
        assert.equal(openFloor(state, id), players);
        assert.equal(playersSee(state, id), players && state.meta.view.blackout !== true);
      }
    }
  });
});
