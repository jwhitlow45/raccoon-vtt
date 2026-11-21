import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOOKKEEPING_RESERVE, EXACT_WIDTH, FAR, HARD, KEPT_FOR_PLAYERS, KEPT_FOR_PLAYERS_FULL, LIMITS, SEAT, farByteLine, farBytesOver } from "./limits.ts";
import { SAVE_OUTCOME_LEDGER_BYTES } from "./saveOutcomeContract.ts";

const MiB = 1024 * 1024;

describe("the far line's bytes", () => {
  test("creates stop short of the line, bookkeeping goes on to it, and past it every growing op is refused", () => {
    for (const scope of ["room", "scene"] as const) {
      const line = scope === "room" ? FAR.roomBytes : FAR.sceneBytes;
      const atCreates = line - BOOKKEEPING_RESERVE[scope];
      for (const whose of ["dm", "players"] as const) {
        // The DM's creates stop sooner on the room's line (the next test), never on a scene's.
        const creates = atCreates - (whose === "dm" && scope === "room" ? KEPT_FOR_PLAYERS : 0);
        assert.equal(farBytesOver(scope, "meets", whose, creates - FAR.byteStep, FAR.byteStep, true), false, `${scope}, ${whose}: a create up to its line`);
        assert.equal(farBytesOver(scope, "meets", whose, creates, 1, true), true, `${scope}, ${whose}: a create past it`);
        assert.equal(farBytesOver(scope, "exempt", whose, atCreates, 1, true), false, `${scope}, ${whose}: a move where creates stop`);
        assert.equal(farBytesOver(scope, "exempt", whose, line, 1, true), true, `${scope}, ${whose}: a growing move past the line`);
        assert.equal(farBytesOver(scope, "exempt", whose, line, 1, false), false, `${scope}, ${whose}: a move that adds nothing`);
        assert.equal(farBytesOver(scope, "deletion", whose, 2 * line, 0, true), false, `${scope}, ${whose}: a deletion`);
        assert.equal(farByteLine("deletion", scope, whose), null);
      }
    }
  });

  test("LP43-LIMITS-2: the DM's adds stop KEPT_FOR_PLAYERS before a player's on the room's line, and the DM's bookkeeping goes on to the line itself", () => {
    const players = farByteLine("meets", "room", "players")!;
    assert.equal(farByteLine("meets", "room", "dm"), players - KEPT_FOR_PLAYERS);
    // A reading that leaves a player one step of room refuses the DM's add, and one all of KEPT_FOR_PLAYERS under the player's line takes it.
    assert.equal(farBytesOver("room", "meets", "players", players - 2 * FAR.byteStep, FAR.byteStep, true), false, "a player's add with one step left");
    assert.equal(farBytesOver("room", "meets", "dm", players - 2 * FAR.byteStep, FAR.byteStep, true), true, "the DM's add there");
    assert.equal(farBytesOver("room", "meets", "dm", players - KEPT_FOR_PLAYERS - FAR.byteStep, FAR.byteStep, true), false, "the DM's add with the players' kept room still free");
    assert.equal(farBytesOver("room", "meets", "dm", players - KEPT_FOR_PLAYERS - FAR.byteStep, FAR.byteStep + 1, true), true, "and one byte past it");
    assert.equal(farBytesOver("room", "exempt", "dm", FAR.roomBytes - FAR.byteStep, FAR.byteStep, true), false, "the DM's bookkeeping to the line itself");
    assert.equal(farBytesOver("room", "deletion", "dm", 2 * FAR.roomBytes, 0, true), false, "a deletion past everything");
  });

  test("D-261121-019: the room keeps 1 MiB for the players, and beside it the widest that every creature of a scene, every character and one seat's areas take in a player's exact part, in whole steps", () => {
    const widths = FAR.tokens * EXACT_WIDTH.creature + LIMITS.charactersPerRoom * EXACT_WIDTH.character + SEAT.ridingAreas * EXACT_WIDTH.unseenArea + LIMITS.floorsPerScene * SEAT.freeAreas * EXACT_WIDTH.area;
    assert.equal(KEPT_FOR_PLAYERS % FAR.byteStep, 0);
    assert.ok(KEPT_FOR_PLAYERS >= MiB + widths && KEPT_FOR_PLAYERS - FAR.byteStep < MiB + widths, `${KEPT_FOR_PLAYERS} bytes`);
    assert.equal(KEPT_FOR_PLAYERS_FULL, `the room is full: it keeps its last ${KEPT_FOR_PLAYERS / MiB} MiB for what the players add`);
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
