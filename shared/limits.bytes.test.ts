import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOOKKEEPING_RESERVE, EXACT_WIDTH, FAR, HARD, KEPT_FOR_PLAYERS_FULL, KEPT_SHARED_LINES, keptForPlayers, LIMITS, rosterListBytes, SEAT, farByteLine, farBytesOver } from "./limits.ts";
import { MAX_LOG } from "./logRings.ts";
import { SAVE_OUTCOME_LEDGER_BYTES } from "./saveOutcomeContract.ts";

const MiB = 1024 * 1024;

/** A room's public facts as the kept bytes read them: its two settings and a roster of `members` UUID-long ids. */
const kept = (moveAny: boolean, applyDamage: boolean, members: number): number =>
  keptForPlayers({
    meta: { settings: { playersMoveAny: moveAny ? "all" : "none", playersApplyDamage: applyDamage } },
    members: Object.fromEntries(Array.from({ length: members }, (_, i) => [`0190f000-0000-7000-8000-${String(i).padStart(12, "0")}`, {}])),
  });

describe("the far line's bytes", () => {
  test("creates stop short of the line, bookkeeping goes on to it, and past it every growing op is refused", () => {
    const dmKept = kept(false, false, 6);
    for (const scope of ["room", "scene"] as const) {
      const line = scope === "room" ? FAR.roomBytes : FAR.sceneBytes;
      const atCreates = line - BOOKKEEPING_RESERVE[scope];
      for (const whose of [{ dmKept }, "players"] as const) {
        // The DM's creates stop sooner on the room's line (the next test), never on a scene's.
        const creates = atCreates - (whose !== "players" && scope === "room" ? dmKept : 0);
        const who = whose === "players" ? "players" : "dm";
        assert.equal(farBytesOver(scope, "meets", whose, creates - FAR.byteStep, FAR.byteStep, true), false, `${scope}, ${who}: a create up to its line`);
        assert.equal(farBytesOver(scope, "meets", whose, creates, 1, true), true, `${scope}, ${who}: a create past it`);
        assert.equal(farBytesOver(scope, "exempt", whose, atCreates, 1, true), false, `${scope}, ${who}: a move where creates stop`);
        assert.equal(farBytesOver(scope, "exempt", whose, line, 1, true), true, `${scope}, ${who}: a growing move past the line`);
        assert.equal(farBytesOver(scope, "exempt", whose, line, 1, false), false, `${scope}, ${who}: a move that adds nothing`);
        assert.equal(farBytesOver(scope, "deletion", whose, 2 * line, 0, true), false, `${scope}, ${who}: a deletion`);
        assert.equal(farByteLine("deletion", scope, whose), null);
      }
    }
  });

  test("LP43-LIMITS-2: the DM's adds stop the kept bytes before a player's on the room's line, and the DM's bookkeeping goes on to the line itself", () => {
    const players = farByteLine("meets", "room", "players")!;
    const dmKept = kept(true, true, 50);
    const dm = { dmKept };
    assert.equal(farByteLine("meets", "room", dm), players - dmKept);
    // A reading that leaves a player one step of room refuses the DM's add, and one all of the kept bytes under the player's line takes it.
    assert.equal(farBytesOver("room", "meets", "players", players - 2 * FAR.byteStep, FAR.byteStep, true), false, "a player's add with one step left");
    assert.equal(farBytesOver("room", "meets", dm, players - 2 * FAR.byteStep, FAR.byteStep, true), true, "the DM's add there");
    assert.equal(farBytesOver("room", "meets", dm, players - dmKept - FAR.byteStep, FAR.byteStep, true), false, "the DM's add with the players' kept room still free");
    assert.equal(farBytesOver("room", "meets", dm, players - dmKept - FAR.byteStep, FAR.byteStep + 1, true), true, "and one byte past it");
    assert.equal(farBytesOver("room", "exempt", dm, FAR.roomBytes - FAR.byteStep, FAR.byteStep, true), false, "the DM's bookkeeping to the line itself");
    assert.equal(farBytesOver("room", "deletion", dm, 2 * FAR.roomBytes, 0, true), false, "a deletion past everything");
  });

  test("D-261121-021: the room keeps 1 MiB for the players, and beside it the widest that the DM's choices put in a player's exact part, from the room's settings and roster, in whole steps", () => {
    assert.equal(KEPT_SHARED_LINES, MAX_LOG);
    for (const members of [1, 6, 50]) {
      const ids = Array.from({ length: members }, (_, i) => `0190f000-0000-7000-8000-${String(i).padStart(12, "0")}`);
      const lines = KEPT_SHARED_LINES * (EXACT_WIDTH.line + EXACT_WIDTH.lineReaderLists * rosterListBytes(ids));
      const rolls = LIMITS.openRollsPerRoom * (EXACT_WIDTH.rollRequest + LIMITS.rollTargets * (EXACT_WIDTH.rollTarget + 38));
      const rest = LIMITS.charactersPerRoom * EXACT_WIDTH.character + SEAT.ridingAreas * EXACT_WIDTH.unseenArea + LIMITS.floorsPerScene * SEAT.freeAreas * EXACT_WIDTH.area + lines + rolls;
      for (const [moveAny, applyDamage] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        const creatures = (moveAny || applyDamage ? FAR.tokens : SEAT.tokens + LIMITS.tokensPerScene) * EXACT_WIDTH.creature;
        const at = kept(moveAny, applyDamage, members);
        assert.equal(at % FAR.byteStep, 0);
        assert.ok(at >= MiB + creatures + rest && at - FAR.byteStep < MiB + creatures + rest, `${members} members, move any ${moveAny}, apply damage ${applyDamage}: ${at} bytes`);
      }
      assert.ok(kept(true, false, members) > kept(false, false, members), "either setting keeps more");
    }
    assert.ok(kept(false, false, 50) > kept(false, false, 6), "and a larger roster");
    assert.doesNotMatch(KEPT_FOR_PLAYERS_FULL, /\d/, "the words name no size");
  });

  test("the DM's part reads in steps, the players' exactly", () => {
    const line = farByteLine("meets", "room", "players")!;
    const step = FAR.byteStep;
    const answers = (dm: number) => [0, 1, step - 1, step, step + 1, 2 * step - 1].map((held) => farBytesOver("room", "meets", "players", dm, held, true));
    assert.deepEqual(answers(line - 2 * step + 1), answers(line - step), "within one step of the DM's part");
    assert.notDeepEqual(answers(line - step + 1), answers(line - step), "the next step");
  });

  test("everything a room can store stays within HARD: the far line and what lies outside the measure", () => {
    const privateRings = LIMITS.dmLogLines * LIMITS.apartLineBytes + LIMITS.whisperBytesPerRoom + LIMITS.partyLineBytesPerRoom;
    const reminders = LIMITS.remindedSharedBytes + LIMITS.remindedDmBytes + (LIMITS.membersPerRoom - 1) * LIMITS.remindedPerPlayerBytes;
    const stored = FAR.roomBytes + privateRings + reminders + SAVE_OUTCOME_LEDGER_BYTES;
    assert.equal(privateRings, 2_949_120);
    assert.ok(stored <= HARD.storedBytes, `${stored} within ${HARD.storedBytes}`);
    assert.ok(HARD.storedBytes <= HARD.roomJsonBytes);
  });
});
