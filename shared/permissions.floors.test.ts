import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Scene, Viewer } from "./model.ts";
import { FLOOR_REFUSALS, MOVE_PLAYERS_FIRST, canApply } from "./permissions.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, character, env, room, scene, template, token } from "./testutil.ts";

/*
 * Who may change floors and what each refusal says (docs/design/design-v1-floors.md
 * 7.1, 9), and a player's access by the floors they hold (8.3): their own
 * creature's floor is theirs, another player's is not.
 */

const deps = { canUseAsset: () => true };
const decide = (state: RoomState, op: Op, who: Viewer = DM) => {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
};
const GONE = "gone: that is not here";
const floor = (id: string, level: number, name: string, over: Partial<Scene> = {}): Scene =>
  scene(id, { name: "Tower", floor: { of: "g", level, name, height: 10 }, ...over });

/** Tower: Ground (g, the start floor), Upper (u) and Attic (a), and a plain scene; Ana (p1) plays Thorn. */
function tower(over: Partial<RoomState> = {}): RoomState {
  return room({
    meta: { ...room().meta, playerSceneId: "g" },
    scenes: { g: floor("g", 0, "Ground floor"), u: floor("u", 1, "Upper floor"), a: floor("a", 2, "Attic"), s2: scene("s2", { order: 1 }) },
    characters: { thorn: character("thorn", { ownerIds: ["p1"] }) },
    ...over,
  });
}
const thornOn = (sceneId: string, over = {}) => token("thorn", { sceneId, kind: "pc", name: "Thorn", actor: { ref: "thorn" }, ...over });

describe("floor ops are the DM's (9)", () => {
  test("a player may not add, order, show or hide a floor", () => {
    const state = tower();
    const add: Op = { t: "scene.create", scene: { id: "n", name: "Tower", bounds: { w: 10, h: 10 } }, floor: { beside: "g", side: "above" } };
    for (const op of [add, { t: "floor.order", sceneId: "g", floors: ["u", "g", "a"] }, { t: "floor.open", sceneId: "u", open: true }] as Op[]) {
      assert.match(decide(state, op, P1), /^forbidden/, op.t);
      assert.equal(decide(state, op), "ok", op.t);
    }
  });
});

describe("removing, deleting and hiding floors in 7.1's words", () => {
  test("the start floor stays, and a floor the party stands on stays until they move off", () => {
    const state = tower({ tokens: { thorn: thornOn("u") } });
    assert.equal(decide(state, { t: "scene.delete", sceneId: "u" }), `invalid: ${FLOOR_REFUSALS.removeParty("Upper floor")}`);
    assert.equal(decide({ ...state, meta: { ...state.meta, playerSceneId: "a" } }, { t: "scene.delete", sceneId: "a" }), `invalid: ${FLOOR_REFUSALS.removeStart}`);
    assert.equal(decide(state, { t: "scene.delete", sceneId: "a" }), "ok", "an empty floor goes");
    const hidden = tower({ tokens: { thorn: thornOn("u", { visibility: "dm" }) } });
    assert.equal(decide(hidden, { t: "scene.delete", sceneId: "u" }), "ok", "a party member the DM hid holds nothing");
  });

  test("Delete of a scene with floors is refused while the players start on any of them", () => {
    const upper = tower({ meta: { ...room().meta, playerSceneId: "u" } });
    assert.equal(decide(upper, { t: "scene.delete", sceneId: "g" }), `invalid: ${MOVE_PLAYERS_FIRST}`);
    assert.equal(decide(tower({ meta: { ...room().meta, playerSceneId: "s2" } }), { t: "scene.delete", sceneId: "g" }), "ok");
    assert.equal(decide(room(), { t: "scene.delete", sceneId: "s1" }), `invalid: ${MOVE_PLAYERS_FIRST}`, "a plain players' scene as before");
  });

  test("Hide is off on the start floor and while an unhidden party member stands there", () => {
    const state = tower({ tokens: { thorn: thornOn("u") } });
    assert.equal(decide(state, { t: "floor.open", sceneId: "g", open: false }), `invalid: ${FLOOR_REFUSALS.hideStart}`);
    assert.equal(decide(state, { t: "floor.open", sceneId: "u", open: false }), `invalid: ${FLOOR_REFUSALS.hideParty("Upper floor")}`);
    assert.equal(decide(state, { t: "floor.open", sceneId: "a", open: false }), "ok");
    assert.equal(decide(state, { t: "floor.open", sceneId: "u", open: true }), "ok", "Show is never refused");
  });
});

describe("a player's access follows the floors they hold (8.3)", () => {
  const area = (sceneId: string, ownerId: string): Op => ({ t: "template.create", template: { ...template("t9", { sceneId, ownerId, visibility: "all" }) } }) as Op;

  test("Ana's hidden creature upstairs gives her Upper, and Bree nothing of it", () => {
    const state = tower({ tokens: { thorn: thornOn("u", { visibility: "dm" }) } });
    assert.equal(decide(state, area("u", "p1"), P1), "ok");
    assert.equal(decide(state, area("u", "p2"), P2), GONE);
    assert.equal(decide(state, area("a", "p1"), P1), GONE, "a floor nobody reached");
    assert.equal(decide(state, { t: "drawing.clear", sceneId: "u", scope: "own" }, P1), "ok");
    assert.equal(decide(state, { t: "drawing.clear", sceneId: "u", scope: "own" }, P2), GONE);
  });

  test("an open floor is every player's, and a blackout holds none", () => {
    const state = tower({ openFloors: { a: { sceneId: "a", rev: 0 } } });
    assert.equal(decide(state, area("a", "p2"), P2), "ok");
    const dark = { ...state, meta: { ...state.meta, view: { follow: false, blackout: true } } };
    assert.equal(decide(dark, area("g", "p2"), P2), GONE);
  });

  test("a cast names its caster's floor, and an area what it follows on its own floor", () => {
    const state = tower({ tokens: { thorn: thornOn("g"), gob: token("gob", { sceneId: "g" }) }, openFloors: { u: { sceneId: "u", rev: 0 } } });
    const cast = (sceneId: string): Op => ({ t: "cast.ask", cast: { id: "k1", caster: "thorn", sceneId, spell: "Fireball", targets: ["gob"] } });
    assert.equal(decide(state, cast("g"), P1), "ok");
    assert.equal(decide(state, cast("u"), P1), GONE, "a cast from Ground named on Upper");
    const follows: Op = { t: "template.create", template: { ...template("t9", { sceneId: "u", ownerId: "p1", visibility: "all", attachedTo: "thorn" }) } } as Op;
    assert.equal(decide(state, follows, P1), GONE, "an aura on Upper following Thorn on Ground");
  });

  test("a roll asked of a hidden creature on a floor nobody reached is allowed, as on any floor of the players' scene", () => {
    const state = tower({ tokens: { thorn: thornOn("a", { visibility: "dm" }) } });
    const ask: Op = { t: "roll.ask", request: { id: "r1", test: { kind: "check", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: false, targets: [{ tokenId: "thorn" }] } } as Op;
    assert.equal(decide(state, ask), "ok");
    const r = applyOp(state, ask, DM, env(1));
    assert.ok(r.ok, r.ok ? "" : r.message);
    const prep: RoomState = { ...state, tokens: { thorn: thornOn("s2") } };
    const off = applyOp(prep, ask, DM, env(2));
    assert.ok(!off.ok && off.message === "a token asked to roll must be on the players' scene");
  });

  test("a player places their character's token on a floor they hold, and nowhere else", () => {
    const state = tower({ meta: { ...room().meta, playerSceneId: "g", settings: { ...room().meta.settings, playersCreateCharacters: true } } as RoomState["meta"], openFloors: { u: { sceneId: "u", rev: 0 } } });
    const place = (sceneId: string): Op => ({ t: "token.create", token: { id: "t-thorn", sceneId, kind: "pc", name: "Thorn", size: "medium", x: 1, y: 1, actor: { ref: "thorn" }, ownerIds: ["p1"] } });
    assert.equal(decide(state, place("u"), P1), "ok");
    assert.equal(decide(state, place("a"), P1), GONE);
  });
});
