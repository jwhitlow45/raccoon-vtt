import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceRoll, LogEntry, LogEvent } from "#shared/model.ts";
import { parseRollToasts } from "../device/settings.ts";
import { BATCH_REMEMBERED_MS, othersRolls, ownResultText, toastDie, unseenGroups } from "./useRollToasts.ts";

/** Rolls as toasts (docs/design-v1-dice.md 8.5 and 8.7). */
let seq = 0;
const ROLL: DiceRoll = { formula: "1d20+5", faces: [14], total: 19, label: "Stealth" };
function line(data: Partial<Extract<LogEvent, { type: "dice" }>>): LogEntry {
  return { id: `${++seq}:0`, at: "2026-10-17T20:00:00.000Z", kind: "event", data: { type: "dice", by: "p2", to: "all", rolls: [ROLL], ...data } };
}

describe("others' rolls as toasts", () => {
  test("one toast a batch, none for this member's own, a bare line or another kind of line", () => {
    const groups = othersRolls(
      [
        line({ batch: "B" }),
        line({ by: "p1" }),
        line({ by: "dm1", to: "dm", rolls: [] }),
        { id: "x:0", at: "", kind: "event", data: { type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "c", total: 3 } },
        line({ batch: "B" }),
        line({}),
      ],
      "p1",
    );
    assert.deepEqual(
      groups.map((g) => g.length),
      [2, 1],
    );
  });

  test("a group's later part landing in a later frame makes no second toast, until the batch is long past (LP7-DICE-9)", () => {
    const seen = new Map<string, number>();
    const first = othersRolls([line({ batch: "G" }), line({ batch: "H", by: "dm1" })], "p1");
    assert.equal(unseenGroups(first, seen, 1_000).length, 2);
    const later = othersRolls([line({ batch: "G" }), line({})], "p1");
    assert.deepEqual(
      unseenGroups(later, seen, 3_000).map((g) => g[0]?.batch),
      [undefined],
      "the second part of G is quiet, a line with no batch still toasts",
    );
    assert.equal(unseenGroups(othersRolls([line({ batch: "G", by: "p3" })], "p1"), seen, 3_000).length, 1, "another roller's batch of the same name is its own");
    assert.equal(unseenGroups(othersRolls([line({ batch: "G" })], "p1"), seen, 3_000 + BATCH_REMEMBERED_MS + 1).length, 1, "long past, the batch is forgotten");
  });

  test("this device's own roll nobody saw lands as its total, its refusal, or a word to check", () => {
    assert.equal(ownResultText({ state: "committed", lines: [line({ by: "p1" })] }), "Rolled 19: Stealth.");
    assert.equal(ownResultText({ state: "committed", lines: [line({ by: "p1", rolls: [ROLL, ROLL] })] }), "Rolled 2 times.");
    const crit: DiceRoll = { formula: "2d6+3", faces: [4, 6], total: 25, crit: "maxPlusRoll", label: "Scimitar critical damage, slashing" };
    assert.equal(ownResultText({ state: "committed", lines: [line({ by: "p1", rolls: [crit] })] }), "Rolled 25 (12 max + 13): Scimitar critical damage, slashing.");
    assert.equal(ownResultText({ state: "committed", lines: [] }), "Rolled. Its result is no longer in the log.");
    assert.equal(ownResultText({ state: "refused", code: "quota", message: "x", text: "Not saved. You are going too fast. Wait a few seconds." }), "Not saved. You are going too fast. Wait a few seconds.");
    assert.equal(ownResultText({ state: "unknown" }), "A roll may have happened. Check the log.");
  });

  test("the switch is on by default and off only when turned off", () => {
    assert.equal(parseRollToasts(null), true);
    assert.equal(parseRollToasts("on"), true);
    assert.equal(parseRollToasts("off"), false);
  });
});

/** Others' D20 Tests lead their toast with the die (docs/design-v1-roll-animation.md 4). */
describe("the toast's d20", () => {
  type Dice = Extract<LogEvent, { type: "dice" }>;
  const dice = (rolls: DiceRoll[], extra: Partial<Dice> = {}): Dice => ({ type: "dice", by: "p2", to: "all", rolls, ...extra });
  const attack = (face: number, critOn?: DiceRoll["critOn"]): DiceRoll => ({ formula: "1d20+5", faces: [face], total: face + 5, label: "Longsword", ...(critOn ? { critOn } : {}) });

  test("one D20 Test shows its kept face, and nothing else shows a die", () => {
    assert.deepEqual(toastDie([dice([ROLL])]), { face: 14, ring: false, fumble: false, verdict: null });
    assert.equal(toastDie([dice([{ formula: "2d20kh1+3", faces: [6, 17], total: 20, label: "Perception" }])])?.face, 17, "the kept d20 of an advantage roll");
    assert.equal(toastDie([dice([{ formula: "2d6+3", faces: [4, 6], total: 13, label: "Scimitar damage" }])]), null, "damage");
    assert.equal(toastDie([dice([ROLL, ROLL])]), null, "two rolls in one line");
    assert.equal(toastDie([dice([ROLL]), dice([ROLL])]), null, "two lines of one batch");
    assert.equal(toastDie([dice([{ formula: "1d20+1d20", faces: [3, 9], total: 12, label: "Odd" }])]), null, "no one deciding d20");
  });

  test("a kept 20 with no AC rings and reads Natural 20, and a 1 is outlined and reads Natural 1", () => {
    assert.deepEqual(toastDie([dice([{ ...ROLL, faces: [20], total: 25 }])]), { face: 20, ring: true, fumble: false, verdict: "Natural 20" });
    assert.deepEqual(toastDie([dice([{ ...ROLL, faces: [1], total: 6 }], { dc: 12 })]), { face: 1, ring: false, fumble: true, verdict: "Natural 1, Fail" });
  });

  test("against an AC, a critical hit rings on 20 and on 18 or 19 in a wider range, and reads Critical Hit", () => {
    for (const [face, critOn] of [[20, undefined], [19, 19], [18, 18], [19, 18]] as const) {
      const die = toastDie([dice([attack(face, critOn)], { ac: 30 })]);
      assert.deepEqual(die, { face, ring: true, fumble: false, verdict: "Critical Hit" }, `${face} critical on ${critOn ?? 20}`);
    }
    assert.deepEqual(toastDie([dice([attack(19)], { ac: 15 })]), { face: 19, ring: false, fumble: false, verdict: "Hit" }, "a 19 outside the range only hits");
    assert.deepEqual(toastDie([dice([attack(19, 19)])]), { face: 19, ring: false, fumble: false, verdict: null }, "with no AC, a 19 is no critical hit to name");
    assert.deepEqual(toastDie([dice([attack(1)], { ac: 5 })]), { face: 1, ring: false, fumble: true, verdict: "Miss" });
  });
});
