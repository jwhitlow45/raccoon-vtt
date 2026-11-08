import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS, checkLimits, exploredReserve, exploringFloors, exploringSceneId, reservedExploreFloors } from "./limits.ts";
import type { RoomState, Scene, Token, Trap, TrapRig } from "./model.ts";
import { projectState, type ProjectedState } from "./project.ts";
import { reads, satisfies } from "./reads.ts";
import { classSight } from "./rules/held.ts";
import { planTrapMove, planTurn, trapsLiveOn, type TrapRoom } from "./rules/traps.ts";
import { DM, P1, character, room, scene, token } from "./testutil.ts";

/*
 * The shared sites of docs/design/design-v1-floors.md 8.3 that read a floor
 * question: traps go off on floors players see (7.7), sight makes ground
 * live there, the token and area caps count the scene's floors and the
 * explored reserve every floor of the players' scene (9), and a DM's
 * prediction holds on any floor of the scene it projects.
 */

const floor = (id: string, level: number, name: string, over: Partial<Scene> = {}): Scene =>
  scene(id, { name: "Tower", floor: { of: "g", level, name, height: 10 }, ...over });
const vision = { fogEnabled: true, vision: { on: true, light: "bright" as const } };

/** Tower: Ground (g, the start floor), Upper (u) and Attic (a). Thorn is Ana's. */
function tower(over: Partial<RoomState> = {}, floors: Partial<Scene> = {}): RoomState {
  return room({
    meta: { ...room().meta, playerSceneId: "g" },
    scenes: { g: floor("g", 0, "Ground floor", floors), u: floor("u", 1, "Upper floor", floors), a: floor("a", 2, "Attic", floors), s2: scene("s2", { order: 1 }) },
    characters: { c: character("c", { ownerIds: ["p1"] }) },
    ...over,
  });
}
const thorn = (sceneId: string, over: Partial<Token> = {}) => token("thorn", { sceneId, name: "Thorn", kind: "pc", disposition: "ally", actor: { ref: "c" }, x: 0, y: 5, ...over });

const rig = (over: Partial<TrapRig> = {}): TrapRig => ({ on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, ...over });
const plate = (id: string, sceneId: string, over: Partial<TrapRig> = {}): Trap => ({ id, rev: 0, sceneId, name: id, zone: { cells: [{ x: 3, y: 5, w: 1, h: 1 }] }, state: "armed", found: false, rig: rig(over) });
const withTraps = (state: RoomState, traps: Trap[]): TrapRoom => ({ ...state, traps: Object.fromEntries(traps.map((t) => [t.id, t])) });
const walk = (state: TrapRoom) => planTrapMove({ t: "token.move", tokenId: "thorn", x: 6, y: 5 }, state, DM, {}).springings.map((s) => s.trap.id);

describe("traps on floors (7.7, D-261102-490)", () => {
  test("a walk sets off a trap on an open floor, never on one players have not reached", () => {
    const opened = tower({ tokens: { thorn: thorn("u") } });
    assert.ok(trapsLiveOn(opened, "u"), "Thorn standing there opens Upper");
    assert.deepEqual(walk(withTraps(opened, [plate("plate", "u")])), ["plate"]);
    const prep = tower({ tokens: { thorn: thorn("a", { visibility: "dm" }) } });
    assert.ok(!trapsLiveOn(prep, "a"));
    assert.deepEqual(walk(withTraps(prep, [plate("plate", "a")])), [], "a hidden party member opens nothing");
    const dark = tower({ tokens: { thorn: thorn("u") } });
    dark.meta.view.blackout = true;
    assert.deepEqual(walk(withTraps(dark, [plate("plate", "u")])), [], "behind a blackout");
  });

  test("a turn's start on a trap goes off on an open floor only", () => {
    const opened = withTraps(tower({ tokens: { thorn: thorn("u", { x: 3 }) } }), [plate("p", "u", { on: ["turnStart"] })]);
    assert.equal(planTurn(opened, "thorn", "turnStart", {}).length, 1);
    const shut = withTraps(tower({ tokens: { thorn: thorn("a", { x: 3, visibility: "dm" }) } }), [plate("p", "a", { on: ["turnStart"] })]);
    assert.equal(planTurn(shut, "thorn", "turnStart", {}).length, 0);
  });
});

describe("sight on floors (8.3)", () => {
  test("ground is live by sight on a floor players see, and not on one they have not reached", () => {
    const state = tower({ tokens: { thorn: thorn("u") } }, vision);
    assert.ok(classSight(state, state.scenes.u!, null));
    assert.equal(classSight(state, state.scenes.a!, null), null);
    assert.ok(classSight(state, state.scenes.g!, null), "the start floor");
  });
});

describe("caps and reserves count the scene's floors (9, D-261102-485)", () => {
  test("the token cap counts every floor of the scene, so a move between floors never meets it", () => {
    const tokens: Record<string, Token> = {};
    for (let i = 0; i < LIMITS.tokensPerScene; i++) tokens[`t${i}`] = token(`t${i}`, { sceneId: i % 2 === 0 ? "g" : "u" });
    assert.ok(checkLimits(tower({ tokens }), "a").ok);
    tokens.extra = token("extra", { sceneId: "a" });
    assert.ok(!checkLimits(tower({ tokens }), "a").ok, `${LIMITS.tokensPerScene + 1} tokens across the floors`);
    assert.ok(checkLimits(room({ tokens: { ...tokens, extra: token("extra", { sceneId: "s2" }) } }), "s2").ok, "a plain scene counts its own");
  });

  test("every floor of the players' scene with fog and vision has an explored reserve, and each open one explores", () => {
    const state = tower({ tokens: { thorn: thorn("u") } }, vision);
    assert.deepEqual(reservedExploreFloors(state), ["g", "u", "a"]);
    assert.deepEqual(exploringFloors(state), ["g", "u"]);
    assert.equal(exploredReserve(state), exploredReserve(state, "g") + exploredReserve(state, "u") + exploredReserve(state, "a"));
    assert.ok(exploredReserve(state, "a") > 0);
    assert.equal(exploredReserve(state, "s2"), 0);
    const plain = room({ scenes: { s1: scene("s1", vision) } });
    assert.deepEqual(exploringFloors(plain), [exploringSceneId(plain)]);
    assert.equal(exploredReserve(plain, "s1"), exploredReserve(plain));
  });
});

describe("a DM's prediction on another floor (8.3, FLR32-OPUS-04)", () => {
  test("an op that reads a floor's scene is predicted on any floor of the projected scene", () => {
    const state = tower();
    const view = projectState(state, DM, { sceneId: "g" }) as unknown as ProjectedState;
    const read = reads({ t: "scene.update", sceneId: "u", patch: { name: "Spire" } }, state);
    assert.ok(satisfies(read, view, DM, { sceneId: "g" }));
    const deleting = reads({ t: "scene.delete", sceneId: "u" }, state);
    assert.ok(satisfies(deleting, view, DM, { sceneId: "g" }), "a floor's own records are the projected scene's");
    assert.ok(!satisfies(reads({ t: "scene.delete", sceneId: "s2" }, state), view, DM, { sceneId: "g" }), "another scene is not");
    assert.ok(!satisfies(deleting, projectState(state, P1, { sceneId: null }) as unknown as ProjectedState, P1, { sceneId: null }), "a player never holds a whole collection");
  });
});
