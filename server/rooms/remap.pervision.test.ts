import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey } from "#shared/keys.ts";
import type { Encounter, RoomState } from "#shared/model.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { entry, member, room, scene, token } from "#shared/testutil.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * A room import on per-player vision (docs/design-v1-per-player-vision.md
 * 6.3 and 6.8, lane PV3): holder lists and each holder's layer follow
 * their scene and their player, and every list of who saw names only
 * players of the new roster (review SEC-PV1-5).
 */

const BITS = encodeTile(fullTileBits());

function perPlayerRoom(): RoomState {
  const state = room();
  state.members.p3 = member("p3");
  state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  state.holders = {
    s1: {
      sceneId: "s1",
      rev: 2,
      entries: [
        { memberId: "p1", on: true },
        { memberId: "p2", on: false },
        { memberId: "gone", on: true },
        { memberId: "p3", on: true },
      ],
    },
  };
  const layer = (memberId: string, tx: number) => ({ [holderTileKey("s1", memberId, tx, 0)]: { sceneId: "s1", memberId, tx, ty: 0, rev: 1, bits: BITS } });
  state.exploredBy = { ...layer("p1", 0), ...layer("p1", 1), ...layer("p2", 0), ...layer("gone", 0), ...layer("p3", 2) };
  state.tokens.gob = token("gob", { sceneId: "s1" });
  const fight = (seenBy: string[]): Encounter => ({ rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "gob" })], turnStart: { entryId: "e1", tokenId: "gob", sceneId: "s1", x: 3, y: 3, elevation: 0, seenBy } });
  state.encounter = fight(["gone", "p1", "p3"]);
  state.encounterHistory = [{ encounter: fight(["p1", "gone"]), effects: {}, revealed: [], at: "2026-10-25T00:00:00.000Z" }, { encounter: fight([]), effects: {}, revealed: [], at: "2026-10-25T00:01:00.000Z" }];
  return state;
}

/** Remaps with member ids that do not sort as the old ones do, so a list kept in the old order would show it. */
function imported(state: RoomState): { out: RoomState; id: (old: string) => string } {
  const memberIds = new Map([
    ["dm1", "m-dm"],
    ["p1", "m-z"],
    ["p2", "m-y"],
    ["p3", "m-a"],
  ]);
  let n = 0;
  return { out: remapState(state, { assets: new Map(), memberIds, newId: () => `n${n++}` }), id: (old) => memberIds.get(old)! };
}

describe("an import of a per-player room", () => {
  test("keeps each holder list under its new scene with its players' new ids, and drops a member who did not come through", () => {
    const state = perPlayerRoom();
    const { out, id } = imported(state);
    const sceneId = Object.values(out.scenes).find((s) => s.vision?.perPlayer === true)!.id;
    assert.deepEqual(Object.keys(out.holders), [sceneId]);
    assert.deepEqual(out.holders[sceneId], {
      sceneId,
      rev: 2,
      entries: [
        { memberId: id("p1"), on: true },
        { memberId: id("p2"), on: false },
        { memberId: id("p3"), on: true },
      ],
    });
  });

  test("keeps the layers of holders whose entry is on, under their new keys, and no other", () => {
    const { out, id } = imported(perPlayerRoom());
    const sceneId = Object.keys(out.holders)[0]!;
    assert.deepEqual(Object.keys(out.exploredBy).sort(), [holderTileKey(sceneId, id("p1"), 0, 0), holderTileKey(sceneId, id("p1"), 1, 0), holderTileKey(sceneId, id("p3"), 2, 0)].sort());
    for (const [key, tile] of Object.entries(out.exploredBy)) assert.equal(key, holderTileKey(tile.sceneId, tile.memberId, tile.tx, tile.ty));
  });

  test("maps every turn start's list of who saw, in the fight and every saved step, and drops ids it cannot map", () => {
    const { out, id } = imported(perPlayerRoom());
    assert.deepEqual(out.encounter?.turnStart?.seenBy, [id("p3"), id("p1")].sort());
    assert.deepEqual(
      out.encounterHistory.map((snap) => snap.encounter.turnStart?.seenBy),
      [[id("p1")], []],
    );
    const ids = new Set(Object.keys(out.members));
    for (const list of [out.encounter?.turnStart?.seenBy ?? [], ...out.encounterHistory.map((snap) => snap.encounter.turnStart?.seenBy ?? [])]) for (const m of list) assert.ok(ids.has(m), `${m} is on the roster`);
  });

  test("a list and layers on a scene that is not per player do not come through, and the imported room parses", () => {
    const state = perPlayerRoom();
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: true, light: "dark" } };
    const { out } = imported(state);
    assert.deepEqual(out.holders, {});
    assert.deepEqual(out.exploredBy, {});
    assert.ok(parseRoomState(imported(perPlayerRoom()).out).ok);
  });
});
