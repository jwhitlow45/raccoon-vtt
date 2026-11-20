import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, OPENING_RECT, UPPER, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { CHUNK_CELLS } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
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

/** The tower with Upper floor's ground raised 10 ft everywhere, the hole's rim and squares too, before the opening is cut there. */
function raisedRoom(...made: Token[]): RoomState {
  const base = tower();
  const heights = encodeHeights(new Int16Array(CHUNK_CELLS * CHUNK_CELLS).fill(10));
  const s = withOpening({ ...base, buildChunks: { ...base.buildChunks, "up:0,0": { sceneId: UPPER, cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights } } });
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

  test("a flier whose height is the far floor's ground there lands on it, so the hole is off (FLR4INT-ASTRA-03)", () => {
    const bat = token("bat", { sceneId: GROUND, ...ON, elevation: 10 });
    assert.equal(raisedRoom(bat).floorLinks!.o1!.ground, 10, "the hole lies on Upper floor's raised ground");
    assert.equal(offs(raisedRoom(bat), [bat])["Upper floor"], "Over an opening on Upper floor", "it would land at 10 ft on 10 ft of ground over the hole");
    const higher = { ...bat, elevation: 15 };
    assert.equal(offs(raisedRoom(higher), [higher])["Upper floor"], null, "5 ft over that ground it keeps flying");
    const walker = thornToken({ ...ON });
    assert.equal(offs(raisedRoom(walker), [walker])["Upper floor"], "Over an opening on Upper floor", "one on the ground lands on the raised ground");
  });

  test("a creature a flier drags lands as the reducer lands it, so one carried in the air onto the hole's ground makes the floor off (FLR4INT-ASTRA-03)", () => {
    const bat = token("bat", { sceneId: GROUND, x: 10, y: 6, elevation: 10 });
    const goblin = token("goblin", { sceneId: GROUND, ...ON, elevation: 10, attached: { kind: "drag", to: "bat" } });
    assert.equal(offs(raisedRoom(bat, goblin), [bat])["Upper floor"], "Over an opening on Upper floor", "the bat flies on beside the hole and the goblin it drags lands over it");
    const riding = { ...goblin, attached: { kind: "ride" as const, to: "bat" } };
    const over = { ...bat, ...ON };
    assert.equal(offs(raisedRoom(over, riding), [over])["Upper floor"], "Over an opening on Upper floor", "a mount that lands on the hole's ground is off");
    assert.equal(offs(raisedRoom(bat, { ...riding, x: 10 }), [bat])["Upper floor"], null, "a rider on a mount that lands beside it stays on its back");
  });

  test("the opening's lower end is ground like any other: a goblin from Attic lands on Ground floor under the hole", () => {
    const goblin = token("goblin", { sceneId: ATTIC, ...ON });
    assert.equal(offs(room(goblin), [goblin])["Ground floor"], null);
  });
});
