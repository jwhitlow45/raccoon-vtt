import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import type { RoomState, Scene, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { room, scene, token } from "#shared/testutil.ts";
import { checkWholeScenes, growthBound, memoryReserved, projectedSceneBytes, sceneFullWords, sceneGroups, SizeGuard } from "./sizeGuard.ts";

/**
 * A scene's floors share one scene's budget (docs/design/design-v1-floors.md 9,
 * D-261102-485): the room-level part once, every floor's own part and every
 * floor's reserves, whichever floors players have reached.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };
const MIB = 1024 * 1024;

/** Tower: `n` floors of `size` by `size` squares, `s1` the main floor and the start floor, and the ordinary scene s2 beside it. */
function tower(n: number, size: number, look: Partial<Scene> = {}): RoomState {
  const scenes: Record<string, Scene> = {};
  for (let i = 0; i < n; i++) {
    const id = i === 0 ? "s1" : `f${i}`;
    scenes[id] = scene(id, { name: "Tower", bounds: { w: size, h: size }, ...look, ...(n > 1 ? { floor: { of: "s1", level: i, name: i === 0 ? "Ground floor" : `Floor ${i}`, height: 10 } } : {}) });
  }
  return room({ scenes: { ...scenes, s2: scene("s2", { order: 1, bounds: { w: size, h: size }, ...look }) } });
}

/** The state with a token of a long name on the floor, which grows that floor's own part by about `chars` bytes. */
function withBulk(state: RoomState, tokenId: string, sceneId: string, chars: number): RoomState {
  return { ...state, tokens: { ...state.tokens, [tokenId]: token(tokenId, { sceneId, name: "x".repeat(chars) }) } };
}

describe("the size guard on a scene with floors", () => {
  test("every floor's measure is the whole scene's, and holds the DM's projection of it", () => {
    const state = withBulk(withBulk(tower(3, 40), "a", "s1", 400), "b", "f2", 400);
    const whole = projectedSceneBytes(state, "s1");
    assert.equal(projectedSceneBytes(state, "f1"), whole, "a floor's measure is its scene's");
    assert.equal(projectedSceneBytes(state, "f2"), whole);
    const alone = projectedSceneBytes(withBulk(tower(1, 40), "a", "s1", 400), "s1");
    assert.ok(whole > alone + 800, `three floors measure more than one: ${whole} against ${alone}`);
    // A DM viewing any floor holds every floor of the scene, so the measure bounds that projection.
    for (const sceneId of ["s1", "f1", "f2"]) assert.ok(serializedBytes(projectState(state, DM, { sceneId })) <= whole, `the DM's projection from ${sceneId}`);
    // Another scene measures apart.
    assert.ok(projectedSceneBytes(state, "s2") < whole);
  });

  test("an op on one floor is refused when the floors together pass the budget, though the floor alone fits", () => {
    const before = withBulk(tower(2, 40), "a", "s1", 3_000);
    const after = withBulk(before, "b", "f1", 3_000);
    // Room for one bulky floor and not two.
    const sceneLimit = projectedSceneBytes(after, "s1") - 1_000;
    assert.ok(projectedSceneBytes(withBulk(tower(1, 40), "b", "s1", 3_000), "s1") < sceneLimit, "one floor of it alone fits");
    const guard = new SizeGuard({ stateLimit: 8 * MIB, sceneLimit });
    assert.equal(guard.check(before, ["s1"], 0, before).ok, true);
    const refused = guard.check(after, ["f1"], growthBound(before, after, ["token:b"]), before);
    assert.deepEqual(refused, { ok: false, code: "quota", message: sceneFullWords(sceneLimit) });
    // The same bulk on another scene goes in: only a scene's own floors share its budget.
    assert.equal(guard.refusedScene, "s1");
    const elsewhere = withBulk(before, "b", "s2", 3_000);
    assert.equal(guard.check(elsewhere, ["s2"], growthBound(before, elsewhere, ["token:b"]), before).ok, true);
  });

  test("an op on two floors of one scene is bounded once, and the bound holds for the next op on either", () => {
    const before = tower(2, 40);
    const grown = withBulk(withBulk(before, "a", "s1", 1_000), "b", "f1", 1_000);
    const guard = new SizeGuard({ stateLimit: 8 * MIB, sceneLimit: projectedSceneBytes(grown, "s1") + 200 });
    assert.equal(guard.check(before, [], 0, before).ok, true);
    assert.equal(guard.check(grown, ["s1", "f1"], growthBound(before, grown, ["token:a", "token:b"]), before).ok, true);
    // 1,000 more on either floor passes the scene's budget, whichever floor took the growth before.
    for (const sceneId of ["s1", "f1"]) {
      const more = withBulk(grown, "c", sceneId, 1_000);
      assert.equal(guard.check(more, [sceneId], growthBound(grown, more, ["token:c"]), grown).ok, false, sceneId);
    }
  });

  test("a room import refuses a scene whose floors together pass the budget, though each floor alone fits", () => {
    let state = tower(4, 40);
    for (const id of ["s1", "f1", "f2", "f3"]) state = withBulk(state, `t-${id}`, id, 9_000);
    const sceneLimit = projectedSceneBytes(state, "s1") - 1_000;
    assert.equal(checkWholeScenes(state, sceneLimit).ok, false);
    assert.equal(checkWholeScenes(withBulk(tower(1, 40), "t", "s1", 9_000), sceneLimit).ok, true, "one such floor fits");
  });

  test("the reviewers' estimate holds: a played 100 by 100 floor reserves about 195 KB, so 8 of them fit, and of 200 by 200 floors 6 fit and 7 do not", () => {
    const look: Partial<Scene> = { fogEnabled: true, vision: { on: true, light: "dark" } };
    const hundred = projectedSceneBytes(tower(1, 100, look), "s1");
    assert.ok(hundred > 150_000 && hundred < 250_000, `a 100 by 100 floor measures ${hundred}`);
    assert.ok(projectedSceneBytes(tower(8, 100, look), "s1") < LIMITS.projectedSceneBytes, "8 such floors fit");
    assert.ok(projectedSceneBytes(tower(8, 40, look), "s1") < LIMITS.projectedSceneBytes / 2, "towers of 40 by 40 a floor fit with room to spare");
    // Each floor of the players' scene reserves its explored layer whether players reached it or not (limits.ts reservedExploreFloors).
    assert.ok(projectedSceneBytes(tower(2, 100, look), "s1") - hundred > 150_000, "and so does each more floor of it");
    assert.ok(projectedSceneBytes(tower(7, 200, look), "s1") > LIMITS.projectedSceneBytes, "7 floors of 200 by 200 do not");
    assert.ok(projectedSceneBytes(tower(6, 200, look), "s1") < LIMITS.projectedSceneBytes, "6 do");
  });

  test("moving the players onto a tower of 7 floors of 200 by 200 is refused, since every floor's memory and exploring are then reserved", () => {
    const look: Partial<Scene> = { fogEnabled: true, vision: { on: true, light: "dark" } };
    const elsewhere = tower(7, 200, look);
    const before: RoomState = { ...elsewhere, meta: { ...elsewhere.meta, playerSceneId: "s2" } };
    const guard = new SizeGuard();
    assert.equal(guard.check(before, [], 0, before).ok, true, "the tower fits while players are elsewhere");
    const refused = guard.check(elsewhere, ["s1"], 0, before);
    assert.equal(refused.ok, false);
  });

  test("a seventh floor of 200 by 200 is refused when it is added, naming the scene as what refused", () => {
    const look: Partial<Scene> = { fogEnabled: true, vision: { on: true, light: "dark" } };
    const before = tower(6, 200, look);
    const after = tower(7, 200, look);
    const guard = new SizeGuard();
    assert.equal(guard.check(before, [], 0, before).ok, true);
    assert.equal(guard.refusedScene, null);
    const refused = guard.check(after, ["f6"], growthBound(before, after, ["scene:f6"]), before);
    assert.equal(guard.refusedScene, "s1", "the scene's own budget refused it, by its main floor");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.ok(refused.message === sceneFullWords(LIMITS.projectedSceneBytes) || refused.message.includes("players' maps") || refused.message.includes("explore"), refused.message);
  });

  test("players' memory is reserved on every floor of the players' scene, reached or not, and on no floor of another scene unplayed", () => {
    const look: Partial<Scene> = { fogEnabled: true, vision: { on: true, light: "dark" } };
    const state = tower(3, 40, look);
    for (const id of ["s1", "f1", "f2"]) assert.equal(memoryReserved(state, state.scenes[id]!), true, id);
    // Moved to s2, the tower's floors keep it only by their played marks.
    const moved: RoomState = { ...state, meta: { ...state.meta, playerSceneId: "s2" }, playedScenes: { s1: { sceneId: "s1", rev: 0 } } };
    assert.equal(memoryReserved(moved, moved.scenes.s1!), true);
    assert.equal(memoryReserved(moved, moved.scenes.f1!), false);
    // On a scene with one floor, the rule is as before: the players' scene or a played one.
    const plain = tower(1, 40, look);
    assert.equal(memoryReserved(plain, plain.scenes.s1!), true);
    assert.equal(memoryReserved(plain, plain.scenes.s2!), false);
  });

  test("scene groups list each scene once, its floors bottom first", () => {
    const state = tower(3, 40);
    const groups = sceneGroups(state).map((g) => g.map((s) => s.id));
    assert.deepEqual(groups.sort((a, b) => b.length - a.length), [["s1", "f1", "f2"], ["s2"]]);
  });
});
