import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeEvent, rollText, type LogNames } from "./logText.ts";
import type { LogEvent, RollTest } from "./model.ts";
import { character, room, token } from "./testutil.ts";

const DEX: RollTest = { kind: "save", choices: [{ ability: "dex" }] };
const GRAPPLE: RollTest = { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] };

describe("roll lines (docs/design-v1-dm-tools.md 3.3)", () => {
  test("read the total, the test and what the viewer's line kept of the DC and the result", () => {
    assert.equal(rollText({ type: "roll", test: DEX, total: 17, dc: 15, dcShown: true, resultShown: true, result: "pass" }, "Thorn"), "Thorn rolled 17 on a Dexterity saving throw against DC 15: pass.");
    assert.equal(rollText({ type: "roll", test: DEX, total: 17 }, "Thorn"), "Thorn rolled 17 on a Dexterity saving throw.");
    assert.equal(rollText({ type: "roll", test: GRAPPLE, choice: 1, total: 12, result: "fail" }, "Thorn"), "Thorn rolled 12 on a Dexterity (Acrobatics) check: fail.");
    assert.equal(rollText({ type: "roll", test: DEX, result: "fail" }, "Thorn"), "Thorn failed a Dexterity saving throw.");
    assert.equal(rollText({ type: "roll", test: DEX, noRoll: true }, "Thorn"), "Thorn failed a Dexterity saving throw without rolling.");
    assert.equal(rollText({ type: "roll", test: DEX, noRoll: true, result: "fail", dc: 12 }, "Thorn"), "Thorn failed a Dexterity saving throw against DC 12 without rolling.");
    assert.equal(rollText({ type: "roll", test: DEX, noRoll: true, result: "pass" }, "Thorn"), "Thorn passed a Dexterity saving throw.");
    assert.equal(rollText({ type: "roll", test: GRAPPLE, result: "pass", dc: 12 }, "Vex"), "Vex passed a Strength (Athletics) or Dexterity (Acrobatics) check against DC 12.");
  });

  test("the panel and the export render a roll line through describeEvent with the viewer's names", () => {
    const state = room({ characters: { c1: character("c1", { name: "Thorn" }) }, tokens: { t1: token("t1", { name: "Owl" }) } });
    const names: LogNames = state;
    const line: LogEvent = { type: "roll", test: DEX, characterId: "c1", total: 9 };
    assert.equal(describeEvent(line, names), "Thorn rolled 9 on a Dexterity saving throw.");
    assert.equal(describeEvent({ ...line, characterId: "gone" }, names), "A creature rolled 9 on a Dexterity saving throw.");
  });
});
