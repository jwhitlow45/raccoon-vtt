import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpError } from "../auth/http.ts";
import { FAR, LIMITS, serializedBytes } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { castAsk, character, companionBlock, drawing, entry, member, room, scene, token } from "#shared/testutil.ts";
import { assertWithinLimits } from "./importRoom.ts";
import { fullRoom, roomMeasure } from "./limitsTesting.ts";

/*
 * An import takes a file that passes today's checks unchanged, or the same
 * checks with the far lines in place of the caps they raise
 * (docs/design/design-v1-player-limits.md 5.3, 8): players' seats sit above
 * the room caps, so a room this build holds can be past them, and its
 * backup must come back. Every other cap answers as today.
 */

const refusedWith = (state: RoomState, reason: string | RegExp) =>
  assert.throws(
    () => assertWithinLimits(state),
    (err: unknown) => err instanceof HttpError && err.status === 413 && (typeof reason === "string" ? err.extra?.reason === reason : reason.test(String(err.extra?.reason))),
  );

function rows(count: number): RoomState {
  return room({ encounter: { rev: 0, round: 1, activeEntryId: null, entries: Array.from({ length: count }, (_, i) => entry(`r${i}`, { label: "Lair" })) } });
}

function tokens(count: number, floors = false): RoomState {
  const state = room();
  if (floors) state.scenes.f2 = scene("f2", { order: 2, floor: { of: "s1", level: 1, name: "Upper", height: 10 } });
  for (let i = 0; i < count; i++) state.tokens[`t${i}`] = token(`t${i}`, { sceneId: floors && i % 2 === 1 ? "f2" : "s1", x: i % 40, y: Math.floor(i / 40) % 30 });
  return state;
}

describe("an import by today's checks or the far lines", () => {
  test("takes a fight past today's rows up to the far rows, and refuses one more with the far line's words", () => {
    assert.doesNotThrow(() => assertWithinLimits(rows(LIMITS.encounterRows)));
    assert.doesNotThrow(() => assertWithinLimits(rows(LIMITS.encounterRows + 1)));
    assert.doesNotThrow(() => assertWithinLimits(rows(FAR.rows)));
    refusedWith(rows(FAR.rows + 1), "The room is full: at most 4,000 initiative rows.");
  });

  test("takes a scene's tokens up to the far tokens, its floors counted together", () => {
    assert.doesNotThrow(() => assertWithinLimits(tokens(FAR.tokens)));
    refusedWith(tokens(FAR.tokens + 1), "A scene is full: at most 2,150 tokens.");
    assert.doesNotThrow(() => assertWithinLimits(tokens(FAR.tokens, true)));
    refusedWith(tokens(FAR.tokens + 1, true), "A scene is full: at most 2,150 tokens.");
  });

  test("takes asks, areas and drawings up to their far lines", () => {
    const asks = room({ casts: Object.fromEntries(Array.from({ length: FAR.asks }, (_, i) => [`a${i}`, castAsk(`a${i}`)])) });
    assert.doesNotThrow(() => assertWithinLimits(asks));
    asks.casts.extra = castAsk("extra");
    refusedWith(asks, "at most 1,220 asks for saves can wait at once");
    const drawn = room();
    for (let i = 0; i < LIMITS.drawingsPerScene + 1; i++) drawn.drawings[`d${i}`] = drawing(`d${i}`);
    assert.doesNotThrow(() => assertWithinLimits(drawn));
  });

  test("keeps every cap the far lines do not raise: characters, members, a character's own stat blocks and a drawing's point values", () => {
    const characters = rows(LIMITS.encounterRows + 1);
    for (let i = 0; i <= LIMITS.charactersPerRoom; i++) characters.characters[`c${i}`] = character(`c${i}`);
    refusedWith(characters, /at most 50 characters/);
    const members = rows(LIMITS.encounterRows + 1);
    for (let i = 0; i < LIMITS.membersPerRoom; i++) members.members[`m${i}`] = member(`m${i}`);
    refusedWith(members, /at most 50 members/);
    const blocks = rows(LIMITS.encounterRows + 1);
    blocks.characters.c1 = character("c1", { name: "Thorn" });
    for (let i = 0; i <= LIMITS.companionBlocksPerCharacter; i++) blocks.companionBlocks[`b${i}`] = companionBlock(`b${i}`, "c1");
    refusedWith(blocks, /Thorn can keep at most 100 stat blocks/);
    const long = rows(LIMITS.encounterRows + 1);
    long.drawings.d1 = drawing("d1", { points: Array.from({ length: LIMITS.drawingPointValues + 2 }, () => 1) });
    refusedWith(long, /a drawing has at most 2,000 point values/);
  });

  test("takes a room past today's 8 MiB up to the far line's 11 MiB, and refuses one past it", () => {
    const at = (bytes: number) => {
      const state = rows(LIMITS.encounterRows + 1);
      for (const i of [2, 3, 4, 5]) state.scenes[`s${i}`] = scene(`s${i}`, { order: i });
      // Notes on hidden creatures spread over scenes, so no one scene passes its own line. Each adds its entry, a comma and its letters.
      let measured = roomMeasure(state);
      for (let i = 0; measured < bytes; i++) {
        const pad = token(`pad${i}`, { sceneId: `s${2 + (i % 4)}`, visibility: "dm", notes: "x".repeat(4_000) });
        state.tokens[pad.id] = pad;
        measured += serializedBytes({ [pad.id]: pad }) - 1;
      }
      assert.ok(Math.abs(roomMeasure(state) - measured) <= 1, `${roomMeasure(state)} against ${measured}`);
      return state;
    };
    assert.doesNotThrow(() => assertWithinLimits(at(9 * 1024 * 1024)));
    refusedWith(at(FAR.roomBytes + 4_096), "the room state is over 11 MiB");
  });

  test("takes the full fixture's room with one member fewer, so its importer fits the roster", () => {
    const full = fullRoom({ members: LIMITS.membersPerRoom - 1 });
    assert.doesNotThrow(() => assertWithinLimits(full.state));
  });
});
