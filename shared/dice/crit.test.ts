import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { migrateSnapshot, SNAPSHOT_VERSION } from "../migrate.ts";
import { canApply } from "../permissions.ts";
import { clientOpSchema, type Op } from "../protocol.ts";
import { apply, DM, P1, room } from "../testutil.ts";
import type { CritRule } from "../model.ts";
import { askedCritical, critBound, critParts, critRuleOf, rollCritical } from "./crit.ts";
import { FORMULA_ERRORS, formatFormula, parseFormula } from "./formula.ts";

describe("the room's critical hit rule (docs/design-v1-dice.md, critical hit rules)", () => {
  test("a room or a snapshot from before the setting rolls crits by the 2024 rule", () => {
    const state = room();
    delete state.meta.settings.critRule;
    assert.equal(critRuleOf(state.meta.settings), "rollTwice");
    const loaded = migrateSnapshot(JSON.parse(JSON.stringify(state)), SNAPSHOT_VERSION);
    assert.equal(loaded.meta.settings.critRule, undefined, "a live room loads its snapshot as it was stored");
    assert.equal(critRuleOf(loaded.meta.settings), "rollTwice");
    assert.equal(critRuleOf({ critRule: "doubleTotal" }), "doubleTotal");
  });

  test("the DM picks any of the four rules, a player picks none, and no other value passes", () => {
    for (const critRule of ["rollTwice", "maxPlusRoll", "doubleDice", "doubleTotal"]) {
      const op = { t: "room.update", settings: { critRule } };
      assert.ok(clientOpSchema.safeParse(op).success, critRule);
      assert.equal(critRuleOf(apply(room(), op as Op).meta.settings), critRule);
    }
    assert.equal(clientOpSchema.safeParse({ t: "room.update", settings: { critRule: "tripleDice" } }).success, false);
    const op = { t: "room.update", settings: { critRule: "maxPlusRoll" } } as Op;
    assert.equal(canApply(op, DM, room(), { canUseAsset: () => true }).ok, true);
    assert.equal(canApply(op, P1, room(), { canUseAsset: () => true }).ok, false);
  });
});

/** A draw that hands out these faces in order, and fails the test past them. */
function scripted(faces: number[]): (sides: number) => number {
  const left = [...faces];
  return (sides) => {
    const face = left.shift();
    assert.ok(face !== undefined && face >= 1 && face <= sides, `a face for a d${sides}`);
    return face;
  };
}

function rolled(text: string, faces: number[], rule: CritRule) {
  const parsed = parseFormula(text);
  assert.ok(parsed.ok);
  const out = rollCritical(parsed.formula, scripted(faces), rule);
  assert.ok(out.ok, out.ok ? "" : out.error);
  return out.result;
}

describe("a critical hit's damage by each rule", () => {
  test("2d6+3 on 4 and 6: twice draws four dice, max plus a roll is 25, doubled dice 23, doubled total 26", () => {
    assert.deepEqual(rolled("2d6+3", [1, 2, 5, 6], "rollTwice"), { formula: "4d6+3", faces: [1, 2, 5, 6], total: 17, crit: "rollTwice" });
    assert.deepEqual(rolled("2d6+3", [4, 6], "maxPlusRoll"), { formula: "2d6+3", faces: [4, 6], total: 25, crit: "maxPlusRoll" });
    assert.deepEqual(rolled("2d6+3", [4, 6], "doubleDice"), { formula: "2d6+3", faces: [4, 6], total: 23, crit: "doubleDice" });
    assert.deepEqual(rolled("2d6+3", [4, 6], "doubleTotal"), { formula: "2d6+3", faces: [4, 6], total: 26, crit: "doubleTotal" });
  });

  test("a rider merged into the damage's one formula takes the rule with the weapon's dice, the modifier once", () => {
    // Rapier 1d8+4 and Sneak Attack 3d6, piercing, as damageRolls joins them.
    const faces = [5, 2, 3, 6];
    assert.equal(rolled("1d8+4+3d6", faces, "maxPlusRoll").total, 8 + 18 + 5 + 4 + 2 + 3 + 6);
    assert.equal(rolled("1d8+4+3d6", faces, "doubleDice").total, (5 + 2 + 3 + 6) * 2 + 4);
    assert.equal(rolled("1d8+4+3d6", faces, "doubleTotal").total, (5 + 4 + 2 + 3 + 6) * 2);
    const twice = rolled("1d8+4+3d6", [5, 1, 2, 3, 6, 4, 4, 1], "rollTwice");
    assert.equal(twice.formula, "2d8+4+6d6");
    assert.equal(twice.total, 5 + 1 + 4 + 2 + 3 + 6 + 4 + 4 + 1);
  });

  test("a keep term maxes and doubles only what it keeps, and twice doubles its n", () => {
    // 3, 5, 1, 5: the 1 is dropped, so the kept sum is 13.
    assert.equal(rolled("4d6kh3", [3, 5, 1, 5], "maxPlusRoll").total, 18 + 13);
    assert.equal(rolled("4d6kh3", [3, 5, 1, 5], "doubleDice").total, 26);
    assert.equal(rolled("4d6kh3+2", [3, 5, 1, 5], "doubleTotal").total, 30);
    assert.equal(rolled("4d6kh3", [3, 5, 1, 5, 6, 6, 6, 1], "rollTwice").formula, "8d6kh6");
  });

  test("a die or a number taken away keeps its sign under every rule", () => {
    // 2d6-1d4-1 on 4, 6 and 3 is 6 plain.
    assert.equal(rolled("2d6-1d4-1", [4, 6, 3], "maxPlusRoll").total, 12 - 4 + 6);
    assert.equal(rolled("2d6-1d4-1", [4, 6, 3], "doubleDice").total, (4 + 6 - 3) * 2 - 1);
    assert.equal(rolled("2d6-1d4-1", [4, 6, 3], "doubleTotal").total, 12);
  });

  test("the bounds hold under the rule that draws the most: 50 dice and a doubled text of 100 characters", () => {
    const formula = (text: string) => {
      const parsed = parseFormula(text);
      assert.ok(parsed.ok, text);
      return parsed.formula;
    };
    assert.equal(critBound(formula("50d6")), null);
    assert.equal(critBound(formula("51d6")), FORMULA_ERRORS.dice);
    assert.equal(critBound(formula("25d6+26d8")), FORMULA_ERRORS.dice);
    // Ten 5d1000 doubled are ten 10d1000: a 94-character formula of 50 dice grows past 100 characters.
    const long = `${Array.from({ length: 10 }, () => "5d1000").join("+")}${"+1000".repeat(5)}`;
    assert.equal(formatFormula(formula(long)).length, 94);
    assert.equal(critBound(formula(long)), FORMULA_ERRORS.long);
    assert.equal(critBound(formula(`${Array.from({ length: 10 }, () => "5d1000").join("+")}${"+1000".repeat(3)}`)), null, "84 characters grow to 94");
    const tooMany = rollCritical(formula("51d6"), () => 1, "maxPlusRoll");
    assert.deepEqual(tooMany, { ok: false, error: FORMULA_ERRORS.dice }, "refused before any draw, whatever the rule");
  });

  test("a reader's parts rebuild the sum, and Again gets the formula as asked", () => {
    const max = rolled("1d8+4+3d6", [5, 2, 3, 6], "maxPlusRoll");
    assert.deepEqual(critParts(max) && { ...critParts(max)!, formula: undefined }, { rule: "maxPlusRoll", formula: undefined, max: 26, dice: 16, numbers: 4, base: 20 });
    assert.equal(critParts({ formula: "2d6+3", faces: [4, 6] }), null, "no crit");
    assert.equal(critParts({ formula: "2d6+3", faces: [4], crit: "doubleDice" }), null, "faces that do not match");
    const asked = (result: Parameters<typeof askedCritical>[0]) => {
      const f = askedCritical(result);
      return f ? formatFormula(f) : null;
    };
    assert.equal(asked({ formula: "4d6+3", crit: "rollTwice" }), "2d6+3");
    assert.equal(asked({ formula: "8d6kh6+2d8", crit: "rollTwice" }), "4d6kh3+1d8");
    assert.equal(asked({ formula: "3d6+3", crit: "rollTwice" }), null, "no doubled count is odd");
    assert.equal(asked({ formula: "2d6+3", crit: "maxPlusRoll" }), "2d6+3");
    assert.equal(asked({ formula: "2d6+3" }), null);
  });
});
