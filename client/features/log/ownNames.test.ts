import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { describeEvent } from "#shared/logText.ts";
import { projectState } from "#shared/project.ts";
import { character, room, scene, token } from "#shared/testutil.ts";
import { keptOwnNames, type OwnNames } from "./ownNames.ts";

/*
 * A player's ask for saves names its caster by the token alone, and the
 * player's copy holds only the scene shown. Once the party has moved on, the
 * log names the player's own creature by the name the device read off it.
 */

const P1 = { memberId: "p1", role: "player" as const };

function party(on: "s1" | "s2"): RoomState {
  const s = room({ scenes: { s1: scene("s1"), s2: scene("s2") }, characters: { quinn: character("quinn", { name: "Quinn", ownerIds: ["p1"] }) } });
  s.meta.playerSceneId = on;
  s.tokens = {
    q1: token("q1", { sceneId: "s1", kind: "pc", name: "Quinn", actor: { ref: "quinn" } }),
    owl: token("owl", { sceneId: "s1", kind: "monster", name: "Owl", ownerIds: ["p1"] }),
    imp: token("imp", { sceneId: "s1", kind: "monster", name: "Imp" }),
    q2: token("q2", { sceneId: "s2", kind: "pc", name: "Quinn", actor: { ref: "quinn" } }),
  };
  return s;
}

const view = (on: "s1" | "s2") => projectState(party(on), P1, { sceneId: null }) as unknown as RoomState;
const ask = { type: "cast" as const, castId: "k1", tokenId: "q1", spell: "20 ft Sphere" };

test("a player's own ask names its creature on another scene by the name the device read, and no other creature is kept", () => {
  let known: OwnNames = new Map();
  known = keptOwnNames(known, view("s1"), P1);
  assert.deepEqual(Object.fromEntries(known), { q1: "Quinn", owl: "Owl" }, "the player's character and the creature they own, not the imp");
  const there = view("s2");
  assert.equal(there.tokens.q1, undefined, "the copy on the next scene holds the token no more");
  assert.equal(describeEvent(ask, there), "A creature asks for saves: 20 ft Sphere.", "without the kept names");
  known = keptOwnNames(known, there, P1);
  assert.equal(describeEvent(ask, { ...there, known }), "Quinn asks for saves: 20 ft Sphere.");
  assert.equal(describeEvent({ ...ask, tokenId: "imp" }, { ...there, known }), "A creature asks for saves: 20 ft Sphere.");
});

test("the DM's device keeps nothing, and a view with no new name gives back the same map", () => {
  const known = keptOwnNames(new Map(), party("s1"), { memberId: "dm1", role: "dm" });
  assert.equal(known.size, 0);
  const once = keptOwnNames(new Map(), view("s1"), P1);
  assert.equal(keptOwnNames(once, view("s1"), P1), once);
});
