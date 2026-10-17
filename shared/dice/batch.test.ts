import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS, serializedBytes } from "../limits.ts";
import { batchRolls, type BatchRoll } from "./batch.ts";
import { FORMULA_ERRORS } from "./formula.ts";

const ENVELOPE = { tag: "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d", to: "all" as const };

function rolls(n: number, roll: BatchRoll & { label?: string }): (BatchRoll & { label?: string })[] {
  return Array.from({ length: n }, () => ({ ...roll }));
}

describe("the splitter (docs/design-v1-dice.md 8.4)", () => {
  test("20 rolls go in one op with no part, and the 21st starts a second, both under the tag", () => {
    const one = batchRolls(rolls(20, { formula: "1d20+5" }), ENVELOPE);
    assert.ok(one.ok);
    assert.equal(one.ops.length, 1);
    assert.equal(one.ops[0]!.part, undefined);
    assert.equal(one.ops[0]!.rolls.length, 20);
    const two = batchRolls(rolls(21, { formula: "1d20+5" }), ENVELOPE);
    assert.ok(two.ok);
    assert.deepEqual(
      two.ops.map((op) => [op.part, op.rolls.length, op.tag]),
      [
        [0, 20, ENVELOPE.tag],
        [1, 1, ENVELOPE.tag],
      ],
    );
  });

  test("100 dice fit one op, and advantage's second d20 counts", () => {
    const hundred = batchRolls(rolls(20, { formula: "5d6" }), ENVELOPE);
    assert.ok(hundred.ok);
    assert.equal(hundred.ops.length, 1);
    const twenty = batchRolls(rolls(20, { formula: "6d6" }), ENVELOPE);
    assert.ok(twenty.ok);
    assert.deepEqual(
      twenty.ops.map((op) => op.rolls.length),
      [16, 4],
      "twenty 6d6 are 120 dice",
    );
    const advantage = batchRolls(rolls(20, { formula: "1d20+3d6", mode: "adv" }), ENVELOPE);
    assert.ok(advantage.ok);
    assert.deepEqual(
      advantage.ops.map((op) => op.rolls.length),
      [20],
      "20 rolls of 5 dice each",
    );
    const over = batchRolls(rolls(20, { formula: "1d20+4d6", mode: "adv" }), ENVELOPE);
    assert.ok(over.ok);
    assert.deepEqual(
      over.ops.map((op) => op.rolls.length),
      [16, 4],
      "6 dice each with the second d20",
    );
  });

  test("an op never passes 3 KiB serialized, the largest part number counted", () => {
    const label = "x".repeat(LIMITS.diceLabelChars);
    const long = rolls(20, { formula: `1d20+${"1d6+".repeat(9)}1d6`.slice(0, 100), label });
    const batched = batchRolls(long, ENVELOPE);
    assert.ok(batched.ok);
    assert.ok(batched.ops.length > 1);
    for (const op of batched.ops) assert.ok(serializedBytes({ ...op, part: 19 }) <= LIMITS.diceOpBytes, `${serializedBytes(op)} bytes`);
    assert.equal(
      batched.ops.reduce((n, op) => n + op.rolls.length, 0),
      20,
      "every roll goes, in order",
    );
  });

  test("one bad roll sends nothing, and says which", () => {
    const list = [...rolls(5, { formula: "1d20" }), { formula: "2d6", mode: "adv" as const }, ...rolls(5, { formula: "1d20" })];
    assert.deepEqual(batchRolls(list, ENVELOPE), { ok: false, error: FORMULA_ERRORS.mode, index: 5 });
    assert.deepEqual(batchRolls([{ formula: "2d6 fire" }], ENVELOPE), { ok: false, error: FORMULA_ERRORS.other, index: 0 });
    assert.deepEqual(batchRolls([], ENVELOPE), { ok: false, error: FORMULA_ERRORS.other, index: 0 });
  });

  test("a single roll past a bound alone is refused in the bound's words", () => {
    assert.deepEqual(batchRolls([{ formula: "1d20+99d6", mode: "adv" }], ENVELOPE), { ok: false, error: FORMULA_ERRORS.dice, index: 0 });
    const huge = { formula: "1d20", label: "x".repeat(3_100) };
    assert.deepEqual(batchRolls([huge], ENVELOPE), { ok: false, error: FORMULA_ERRORS.tooMuch, index: 0 });
  });

  test("a group needing more than 20 parts is too much at once", () => {
    assert.equal(batchRolls(rolls(400, { formula: "1d20" }), ENVELOPE).ok, true);
    assert.deepEqual(batchRolls(rolls(401, { formula: "1d20" }), ENVELOPE), { ok: false, error: FORMULA_ERRORS.tooMuch, index: 0 });
  });
});
