import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR, farLimits, HARD, LIMITS, serializedBytes } from "#shared/limits.ts";
import { apply, castAsk } from "#shared/testutil.ts";
import { DEFAULT_BUFFERED_LIMIT } from "./ws.ts";
import { fullRoom, markedRoom, measureBounds, roomMeasure } from "./limitsTesting.ts";

const MIB = 1024 * 1024;

/*
 * The derived bounds of design section 8, measured on the full fixture:
 * a room at the far lines with every ring outside the measures full and a
 * full roster. Each part outside the measures must come within a few
 * percent of its own bound, so the stored size is the most a room at the
 * line holds and not an accident of a small fixture.
 */
describe("a room at the far lines", () => {
  const full = fullRoom();
  const bounds = measureBounds(full);
  const { state } = full;

  test("holds the far counts on one scene, and its measures are at the room and scene lines", () => {
    assert.equal(Object.keys(state.tokens).length, FAR.tokens);
    assert.equal(state.encounter?.entries.length, FAR.rows);
    // Asks stop where the far line's count does: the DM's part in steps of 50 beside the players' held ones.
    assert.deepEqual([farLimits(state, null).ok, farLimits(state, full.sceneId).ok], [true, true]);
    assert.ok(Object.keys(state.casts).length > FAR.asks - FAR.countStep, `${Object.keys(state.casts).length} asks`);
    state.casts.more = castAsk("more", { by: full.dms[0]!, caster: Object.keys(state.tokens)[0]!, sceneId: full.sceneId, area: undefined, targets: [Object.keys(state.tokens)[0]!] });
    assert.equal(farLimits(state, null).ok, false, "one more ask passes the line");
    delete state.casts.more;
    assert.equal(Object.keys(state.rolls).length, LIMITS.openRollsPerRoom);
    assert.equal(Object.keys(state.members).length, LIMITS.membersPerRoom);
    // One more block or drawing would pass the line, so each measure is within one of them, the room's far reading
    // within one of its steps too.
    assert.ok(bounds.room <= FAR.roomBytes && bounds.room > FAR.roomBytes - FAR.byteStep - 16 * 1024, `room ${bounds.room}`);
    assert.ok(bounds.scene <= FAR.sceneBytes && bounds.scene > FAR.sceneBytes - 16 * 1024, `scene ${bounds.scene}`);
  });

  test("fills every part outside the measures to within 5 percent of its own bound", () => {
    const ring = LIMITS.dmLogLines * LIMITS.apartLineBytes + LIMITS.whisperBytesPerRoom + LIMITS.partyLineBytesPerRoom;
    const reminders = LIMITS.remindedSharedBytes + LIMITS.remindedDmBytes + full.players.length * LIMITS.remindedPerPlayerBytes;
    for (const [part, measured, bound] of [
      ["private lines", bounds.privateLines, ring],
      ["reminders", bounds.reminded, reminders],
      ["save outcomes", bounds.saveOutcomes, 100 * 1024],
    ] as const) {
      assert.ok(measured > 0.95 * bound && measured < 1.02 * bound, `${part}: ${measured} of ${bound}`);
    }
  });

  test("stores within HARD.storedBytes, and its export within the import's room file cap", () => {
    assert.ok(bounds.stored <= HARD.storedBytes, `stored ${bounds.stored}`);
    assert.ok(bounds.exportJson <= HARD.roomJsonBytes, `room.json ${bounds.exportJson}`);
    assert.ok(bounds.remapped <= bounds.stored, `remapped ${bounds.remapped}`);
  });

  test("sends a DM a snapshot that a socket's send buffer holds with 1 MiB to spare", () => {
    assert.ok(bounds.snapshot + MIB <= HARD.sendBufferBytes, `snapshot ${bounds.snapshot}`);
    assert.ok(bounds.snapshot + MIB <= DEFAULT_BUFFERED_LIMIT || DEFAULT_BUFFERED_LIMIT < HARD.sendBufferBytes, `buffer ${DEFAULT_BUFFERED_LIMIT}`);
  });

  test("stays within HARD.storedBytes after a group delete of 100 creatures in the fight and a character's delete", () => {
    const tokens = Object.keys(state.tokens);
    let after = apply(state, { t: "token.deleteMany", tokenIds: tokens.slice(LIMITS.charactersPerRoom, LIMITS.charactersPerRoom + 100) });
    after = apply(after, { t: "character.delete", characterId: Object.keys(state.characters)[0]! });
    const stored = serializedBytes(after);
    assert.ok(stored <= HARD.storedBytes, `stored ${stored}`);
    assert.ok(roomMeasure(after) <= roomMeasure(state), "a deletion's bookkeeping grows no measure past what it freed");
  });
});

/*
 * Astra's marked room of design 6.4: 20 marked per-player scenes with two
 * players, measured at 7,832,678 bytes. A player's far check reads the
 * pool whole and every per-player reserve at six players, so whether the
 * room is under the line turns on its scenes' size.
 */
describe("the marked room of 20 per-player scenes", () => {
  test("is under the far line with scenes of 80 squares a side, and past it from 96", () => {
    const small = markedRoom(80);
    assert.ok(Math.abs(small.measured - 7_832_678) < 1024, `80 squares: ${small.measured}`);
    assert.ok(small.under, `80 squares: ${small.far}`);
    const large = markedRoom(96);
    assert.ok(Math.abs(large.measured - 7_832_678) < 1024, `96 squares: ${large.measured}`);
    assert.ok(!large.under, `96 squares: ${large.far}`);
  });
});
