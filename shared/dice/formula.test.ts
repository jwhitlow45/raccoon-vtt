import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addDie,
  advantageFields,
  applyMode,
  d20Formula,
  diceCount,
  doubleDice,
  FORMULA_ERRORS,
  formatFormula,
  formulaRange,
  parseExtra,
  parseFormula,
  parseRollText,
  resolveAdvantage,
  type AdvantageSource,
  type Formula,
} from "./formula.ts";

function formula(text: string): Formula {
  const parsed = parseFormula(text);
  assert.ok(parsed.ok, `${text} parses`);
  return parsed.formula;
}

function canonical(text: string): string {
  return formatFormula(formula(text));
}

function refusal(text: string): string | undefined {
  const parsed = parseRollText(text);
  return parsed.ok ? undefined : parsed.error;
}

describe("the dice grammar (docs/design-v1-dice.md 3.1)", () => {
  test("section 11's formulas: 10d4+1d8, 4d6dl1 and d%", () => {
    const mixed = formula("10d4+1d8");
    assert.equal(diceCount(mixed), 11);
    assert.deepEqual(formulaRange(mixed), { min: 11, max: 48 });
    assert.equal(canonical("4d6dl1"), "4d6kh3");
    assert.equal(canonical("d%"), "1d100");
  });

  test("canonical text is lowercase, has no spaces and writes every count and n", () => {
    assert.equal(canonical("D20 + 5"), "1d20+5");
    assert.equal(canonical("2D6KH"), "2d6kh1");
    assert.equal(canonical("4d6DH1"), "4d6kl3");
    assert.equal(canonical("  -1d4\t+ 3 - 2"), "-1d4+3-2");
    assert.equal(canonical("+2d6"), "2d6");
    assert.equal(canonical("1d20+0"), "1d20+0");
  });

  test("U+2212, the SRD's minus, reads as a minus", () => {
    assert.equal(canonical("1d20−1"), "1d20-1");
    assert.equal(canonical("−1d4"), "-1d4");
  });

  test("ranges sum each term's kept dice, with signs", () => {
    assert.deepEqual(formulaRange(formula("2d6+3")), { min: 5, max: 15 });
    assert.deepEqual(formulaRange(formula("4d6kh3")), { min: 3, max: 18 });
    assert.deepEqual(formulaRange(formula("1d20-1d4")), { min: -3, max: 19 });
    assert.deepEqual(formulaRange(formula("100d1000+20")), { min: 120, max: 100_020 });
  });

  test("every bound refuses in its own words (Appendix A)", () => {
    const rows: [string, string][] = [
      ["0d6", FORMULA_ERRORS.dice],
      ["101d6", FORMULA_ERRORS.dice],
      ["60d6+41d4", FORMULA_ERRORS.dice],
      ["5", FORMULA_ERRORS.dice],
      ["1d1", FORMULA_ERRORS.sides],
      ["1d1001", FORMULA_ERRORS.sides],
      ["1d20+1001", FORMULA_ERRORS.number],
      ["4d6kh0", FORMULA_ERRORS.keep],
      ["4d6kh5", FORMULA_ERRORS.keep],
      ["4d6dl4", FORMULA_ERRORS.keep],
      ["4d6dl0", FORMULA_ERRORS.keep],
      ["1d4+".repeat(20) + "1d4", FORMULA_ERRORS.terms],
      ["1d20+", FORMULA_ERRORS.sign],
      ["1d20 + fire", FORMULA_ERRORS.sign],
      ["1d1000+".repeat(19) + "1d1000", FORMULA_ERRORS.long],
      ["fire 2d6", FORMULA_ERRORS.other],
      ["4d6k3", FORMULA_ERRORS.other],
      ["2d6+3fire", FORMULA_ERRORS.other],
      ["", FORMULA_ERRORS.other],
      ["1d20 Stea\u0007lth", FORMULA_ERRORS.other],
      [`1d20 ${"x".repeat(61)}`, FORMULA_ERRORS.label],
    ];
    for (const [text, error] of rows) assert.equal(refusal(text), error, JSON.stringify(text));
    assert.equal(parseRollText(`1d20 ${"x".repeat(60)}`).ok, true, "a label of exactly 60 characters");
    assert.equal(parseRollText("100d6").ok, true, "exactly 100 dice");
    assert.equal(parseRollText("1d4+".repeat(19) + "1d4").ok, true, "exactly 20 terms");
    assert.equal(parseRollText("4d6kh4").ok, true, "keep all");
    assert.equal(parseRollText("4d6dl3").ok, true, "drop all but one");
  });

  test("a formula's words are refused where only dice and numbers go", () => {
    assert.deepEqual(parseFormula("2d6+3 fire"), { ok: false, error: FORMULA_ERRORS.other });
    assert.equal(parseFormula("2d6+3").ok, true);
  });

  test("the words are the label, with adv and dis taken out as typed sources wherever they stand", () => {
    assert.deepEqual(parseRollText("1d20+5 Stealth adv"), { ok: true, formula: formula("1d20+5"), sources: [{ kind: "adv", from: "typed" }], label: "Stealth" });
    assert.deepEqual(parseRollText("2d6+3  fire\tdamage"), { ok: true, formula: formula("2d6+3"), sources: [], label: "fire damage" });
    const both = parseRollText("1d20 Advantage Dex DIS save");
    assert.ok(both.ok);
    assert.deepEqual(both.sources, [
      { kind: "adv", from: "typed" },
      { kind: "dis", from: "typed" },
    ]);
    assert.equal(both.label, "Dex save");
    const bare = parseRollText("d20");
    assert.ok(bare.ok);
    assert.equal(bare.label, undefined);
  });

  test("an extra needs no die, and a bare first term adds", () => {
    const plus = parseExtra("1d4");
    assert.ok(plus.ok);
    assert.equal(formatFormula(plus.formula), "1d4");
    const minus = parseExtra("-4");
    assert.ok(minus.ok);
    assert.deepEqual(minus.formula, [{ kind: "number", sign: -1, value: 4 }]);
    assert.equal(parseExtra("+1d4-1").ok, true);
    assert.deepEqual(parseExtra("1d4 bless"), { ok: false, error: FORMULA_ERRORS.other });
    assert.deepEqual(parseExtra(""), { ok: false, error: FORMULA_ERRORS.other });
    assert.deepEqual(parseExtra("+1".repeat(21)), { ok: false, error: FORMULA_ERRORS.long });
  });
});

describe("advantage on the dice (3.4)", () => {
  test("a mode turns the formula's one positive 1d20 into two, keeping the higher or the lower", () => {
    const adv = applyMode(formula("1d20+5"), "adv");
    assert.ok(adv.ok);
    assert.equal(formatFormula(adv.formula), "2d20kh1+5");
    assert.equal(formatFormula(adv.formula, "adv"), "1d20+5 with advantage");
    const dis = applyMode(formula("1d20+5+1d4"), "dis");
    assert.ok(dis.ok);
    assert.equal(formatFormula(dis.formula), "2d20kl1+5+1d4");
    assert.equal(formatFormula(dis.formula, "dis"), "1d20+5+1d4 with disadvantage");
  });

  test("a roll without exactly one such d20 is refused", () => {
    for (const text of ["2d6+3", "2d20", "1d20kh1", "-1d20", "1d20+1d20"]) {
      assert.deepEqual(applyMode(formula(text), "adv"), { ok: false, error: FORMULA_ERRORS.mode }, text);
    }
  });

  test("advantage's second d20 counts against the 100 dice", () => {
    assert.deepEqual(applyMode(formula("1d20+99d4"), "adv"), { ok: false, error: FORMULA_ERRORS.dice });
    assert.equal(applyMode(formula("1d20+98d4"), "adv").ok, true);
  });

  test("d20Formula writes a bonus, and a mode as rolled", () => {
    assert.equal(d20Formula(5), "1d20+5");
    assert.equal(d20Formula(-1), "1d20-1");
    assert.equal(d20Formula(0), "1d20");
    assert.equal(d20Formula(3, "adv"), "2d20kh1+3");
    assert.equal(d20Formula(0, "dis"), "2d20kl1");
  });
});

describe("the cancel rule (3.3)", () => {
  const SOURCES: AdvantageSource[] = [
    { kind: "adv", from: "pressed" },
    { kind: "adv", from: "typed" },
    { kind: "dis", from: "restrained" },
    { kind: "dis", from: "typed" },
  ];

  /** Every ordered pick of up to three sources from SOURCES, repeats of a source included. */
  function mixes(): AdvantageSource[][] {
    const out: AdvantageSource[][] = [[]];
    for (const a of SOURCES) {
      out.push([a]);
      for (const b of SOURCES) {
        out.push([a, b]);
        for (const c of SOURCES) out.push([a, b, c]);
      }
    }
    return out;
  }

  test("any advantage with any disadvantage rolls normally, in every order, however many of each", () => {
    for (const mix of mixes()) {
      const adv = mix.some((s) => s.kind === "adv");
      const dis = mix.some((s) => s.kind === "dis");
      const expected = adv && !dis ? "adv" : dis && !adv ? "dis" : undefined;
      assert.equal(resolveAdvantage(mix), expected, JSON.stringify(mix));
      assert.equal(resolveAdvantage([...mix].reverse()), expected, "order never matters");
      assert.deepEqual(advantageFields(mix), expected ? { mode: expected } : adv && dis ? { cancelled: true } : {});
    }
  });

  test("typed words combine with the other sources: Hasted and Restrained, then Advantage pressed", () => {
    const typed = parseRollText("1d20+5 adv dis");
    assert.ok(typed.ok);
    assert.equal(resolveAdvantage(typed.sources), undefined);
    assert.equal(resolveAdvantage([{ kind: "adv", from: "hasted" }, { kind: "dis", from: "restrained" }, { kind: "adv", from: "pressed" }]), undefined);
  });
});

describe("helpers for docs 3 and 4", () => {
  test("doubleDice doubles every dice term's count, and a keep's n", () => {
    assert.equal(formatFormula(doubleDice(formula("2d6+1d8+3"))), "4d6+2d8+3");
    assert.equal(formatFormula(doubleDice(formula("4d6kh3"))), "8d6kh6");
  });

  test("a quick die adds to its kind or joins the formula, and keeps the words", () => {
    assert.equal(addDie("", 20), "1d20");
    assert.equal(addDie("d6", 6), "2d6");
    assert.equal(addDie("2d6", 8), "2d6+1d8");
    assert.equal(addDie("2d6+3 fire", 6), "3d6+3 fire");
    assert.equal(addDie("1d20+5 Stealth adv", 4), "1d20+5+1d4 Stealth adv");
    assert.equal(addDie("4d6kh3", 6), "4d6kh3+1d6", "a keep is its own roll");
    assert.equal(addDie("fire", 6), "1d6 fire");
    assert.equal(addDie("2d6+", 8), "2d6+1d8");
    assert.equal(addDie("4d6k3", 6), "4d6k3+1d6", "a typo is left for the reading to name");
  });
});
