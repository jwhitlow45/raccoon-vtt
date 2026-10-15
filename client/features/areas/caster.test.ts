import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { character, token } from "#shared/testutil.ts";
import { defaultCaster, idleTapPicks, pickedPress } from "./caster.ts";

describe("the area tool's caster", () => {
  const characters = { c1: character("c1", { ownerIds: ["p1"] }) };
  const player = { memberId: "p1", role: "player" as const };

  test("a player's own selected creature, directly or through its character", () => {
    assert.equal(defaultCaster({ selected: token("t", { ownerIds: ["p1"] }), sceneId: "s1", you: player, characters }), "t");
    assert.equal(defaultCaster({ selected: token("pc", { kind: "pc", actor: { ref: "c1" } }), sceneId: "s1", you: player, characters }), "pc");
  });

  test("never an old selection of someone else's token, one on another scene, or anything for the DM", () => {
    assert.equal(defaultCaster({ selected: token("gob"), sceneId: "s1", you: player, characters }), null);
    assert.equal(defaultCaster({ selected: token("t", { ownerIds: ["p1"], sceneId: "s2" }), sceneId: "s1", you: player, characters }), null);
    assert.equal(defaultCaster({ selected: token("gob"), sceneId: "s1", you: { memberId: "dm1", role: "dm" }, characters }), null);
    assert.equal(defaultCaster({ selected: undefined, sceneId: "s1", you: player, characters }), null);
  });
});

describe("a tap with nothing in progress", () => {
  test("a token inside a placed area casts from the token", () => {
    assert.equal(idleTapPicks({ token: true, template: true }), "token");
    assert.equal(idleTapPicks({ token: false, template: true }), "template");
    assert.equal(idleTapPicks({ token: false, template: false }), "map");
  });
});

describe("a press on the picked placed area", () => {
  const nowhere = { directional: true, onCaster: false, handle: false, casterToken: false, inside: false, nearOrigin: false, attached: false, otherArea: false };

  test("a cone cast from a creature turns around it from the creature or inside, never moving off it", () => {
    const cast = { ...nowhere, onCaster: true };
    assert.equal(pickedPress({ ...cast, casterToken: true }), "turn", "a press on the creature's middle, far from the cone's edge origin");
    assert.equal(pickedPress({ ...cast, nearOrigin: true }), "turn");
    assert.equal(pickedPress({ ...cast, inside: true }), "turn");
    assert.equal(pickedPress({ ...cast, handle: true }), "turn");
    assert.equal(pickedPress({ ...cast, inside: true, otherArea: true }), "turn", "an area overlapping it never takes a press inside it");
  });

  test("a free cone moves from inside and turns from its handle", () => {
    assert.equal(pickedPress({ ...nowhere, inside: true }), "move");
    assert.equal(pickedPress({ ...nowhere, nearOrigin: true }), "move");
    assert.equal(pickedPress({ ...nowhere, handle: true }), "turn");
  });

  test("anywhere else a cone turns on a drag and lets go on a tap, unless another area is there to pick", () => {
    assert.equal(pickedPress(nowhere), "turnOrLetGo");
    assert.equal(pickedPress({ ...nowhere, onCaster: true }), "turnOrLetGo");
    assert.equal(pickedPress({ ...nowhere, otherArea: true }), null);
  });

  test("a sphere moves from inside, and anywhere else is left to the tap rules", () => {
    const sphere = { ...nowhere, directional: false };
    assert.equal(pickedPress({ ...sphere, inside: true }), "move");
    assert.equal(pickedPress({ ...sphere, handle: true }), null);
    assert.equal(pickedPress(sphere), null);
    assert.equal(pickedPress({ ...sphere, inside: true, attached: true }), null, "an aura on a token moves with the token");
  });
});
