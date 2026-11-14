import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOOKKEEPING_RESERVE, FAR, HARD, LIMITS, farByteLine, farBytesOver } from "./limits.ts";
import { SAVE_OUTCOME_LEDGER_BYTES } from "./saveOutcomeContract.ts";

describe("the far line's bytes", () => {
  test("creates stop short of the line, bookkeeping goes on to it, and past it every growing op is refused", () => {
    for (const scope of ["room", "scene"] as const) {
      const line = scope === "room" ? FAR.roomBytes : FAR.sceneBytes;
      const atCreates = line - BOOKKEEPING_RESERVE[scope];
      assert.equal(farBytesOver(scope, "meets", atCreates - FAR.byteStep, FAR.byteStep, true), false, `${scope}: a create up to its line`);
      assert.equal(farBytesOver(scope, "meets", atCreates, 1, true), true, `${scope}: a create past it`);
      assert.equal(farBytesOver(scope, "exempt", atCreates, 1, true), false, `${scope}: a move where creates stop`);
      assert.equal(farBytesOver(scope, "exempt", line, 1, true), true, `${scope}: a growing move past the line`);
      assert.equal(farBytesOver(scope, "exempt", line, 1, false), false, `${scope}: a move that adds nothing`);
      assert.equal(farBytesOver(scope, "deletion", 2 * line, 0, true), false, `${scope}: a deletion`);
      assert.equal(farByteLine("deletion", scope), null);
    }
  });

  test("the DM's part reads in steps, the players' exactly", () => {
    const line = farByteLine("meets", "room")!;
    const step = FAR.byteStep;
    const answers = (dm: number) => [0, 1, step - 1, step, step + 1, 2 * step - 1].map((held) => farBytesOver("room", "meets", dm, held, true));
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
