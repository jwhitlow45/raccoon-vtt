import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, OPENING_RECT, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { floorChoices } from "./moveToFloor.ts";

/*
 * Move to floor beside an opening (docs/design/design-v1-floors.md phase 4,
 * 11, D-261119-061): a floor is off where a creature on the ground would
 * land wholly over a hole there, since a placement drops no one. The
 * tower's opening is a hole in Upper floor, 2 by 2 at 6, 6, down to Ground
 * floor.
 */

const ON = { x: OPENING_RECT.x, y: OPENING_RECT.y };

function room(...made: Token[]): RoomState {
  const s = withOpening(tower());
  return { ...s, tokens: { ...s.tokens, ...Object.fromEntries(made.map((t) => [t.id, t])) } };
}

const offs = (s: RoomState, named: readonly Token[]) => Object.fromEntries(floorChoices(s, named, new Map()).map((c) => [c.name, c.off]));

describe("Move to floor over an opening (phase 4, 11)", () => {
  test("Thorn under the hole on Ground floor can't go up onto it, and goes to Attic", () => {
    const thorn = thornToken({ ...ON });
    assert.deepEqual(offs(room(thorn), [thorn]), { Attic: null, "Upper floor": "Over an opening on Upper floor" });
  });

  test("off the hole, flying, or half over it, the floor is on, and a Large ogre wholly over it is off", () => {
    const beside = thornToken({ x: 9, y: 6 });
    assert.equal(offs(room(beside), [beside])["Upper floor"], null, "beside it");
    const bat = token("bat", { sceneId: GROUND, ...ON, elevation: 10 });
    assert.equal(offs(room(bat), [bat])["Upper floor"], null, "a flier keeps its height over the hole");
    const half = token("ogre", { sceneId: GROUND, size: "large", x: 5, y: 6 });
    assert.equal(offs(room(half), [half])["Upper floor"], null, "half over it");
    const whole = token("ogre", { sceneId: GROUND, size: "large", ...ON });
    assert.equal(offs(room(whole), [whole])["Upper floor"], "Over an opening on Upper floor");
  });

  test("a rider moved with its mount stays on its back, and the move is off only where the mount would stand over the hole", () => {
    const horse = token("horse", { sceneId: GROUND, size: "large", x: 5, y: 6 });
    const thorn = thornToken({ ...ON, attached: { kind: "ride", to: "horse" } });
    assert.equal(offs(room(horse, thorn), [horse])["Upper floor"], null, "the rider over the hole rides the mount that straddles its rim");
    const over = { ...horse, ...ON };
    assert.equal(offs(room(over, thorn), [over])["Upper floor"], "Over an opening on Upper floor");
  });

  test("the opening's lower end is ground like any other: a goblin from Attic lands on Ground floor under the hole", () => {
    const goblin = token("goblin", { sceneId: ATTIC, ...ON });
    assert.equal(offs(room(goblin), [goblin])["Ground floor"], null);
  });
});
