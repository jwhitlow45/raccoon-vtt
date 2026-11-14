import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Effect, RoomState } from "#shared/model.ts";
import { convertedEffectId } from "#shared/rules/effects.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { FAR } from "#shared/limits.ts";
import { actor, character, effect, entry, room } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

function withEffects(effects: Effect[]): RoomState {
  return JSON.parse(JSON.stringify(room({ characters: { c1: character("c1", { actor: actor({ effects }) }) } }))) as RoomState;
}

describe("stored player limits", () => {
  test("a creature stores both classes full and the automatic Unconscious, and no more", () => {
    const full = [
      ...Array.from({ length: 32 }, (_, i) => effect(`s${i}`)),
      ...Array.from({ length: 32 }, (_, i) => effect(`h${i}`, { hiddenFromPlayers: true })),
      { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" as const },
    ];
    assert.ok(parseRoomState(withEffects(full)).ok);
    assert.equal(parseRoomState(withEffects([...full, effect("x")])).ok, false);
  });

  test("a converted id is taken wherever an effect is stored, and nothing longer", () => {
    const id = convertedEffectId("character:c1", ZERO_HP_UNCONSCIOUS_ID);
    assert.ok(parseRoomState(withEffects([{ id, key: "unconscious", hiddenFromPlayers: true }])).ok);
    assert.equal(parseRoomState(withEffects([{ id: `${id}0`, key: "unconscious" }])).ok, false);
    assert.equal(parseRoomState(withEffects([{ id: "x".repeat(65), key: "unconscious" }])).ok, false);
  });

  test("a fight stores rows to the far line", () => {
    const fight = (n: number) => JSON.parse(JSON.stringify(room({ encounter: { rev: 0, round: 1, activeEntryId: null, entries: Array.from({ length: n }, (_, i) => entry(`e${i}`, { label: "x", tieOrder: i })) } }))) as RoomState;
    assert.ok(parseRoomState(fight(FAR.rows)).ok);
    assert.equal(parseRoomState(fight(FAR.rows + 1)).ok, false);
  });

  test("a share mark's share is read, and absent is not written yet", () => {
    const state = JSON.parse(JSON.stringify(room({ memoryShared: { s1: { sceneId: "s1", rev: 0, share: 78_643 }, s2: { sceneId: "s2", rev: 0 } } }))) as RoomState;
    const parsed = parseRoomState(state);
    assert.ok(parsed.ok);
    assert.equal(parsed.ok && parsed.state.memoryShared?.s1?.share, 78_643);
    assert.equal(parsed.ok && parsed.state.memoryShared?.s2?.share, undefined);
    const over = JSON.parse(JSON.stringify(room({ memoryShared: { s1: { sceneId: "s1", rev: 0, share: 192 * 1024 + 1 } } }))) as RoomState;
    assert.equal(parseRoomState(over).ok, false);
  });
});
