import { LIMITS } from "../limits.ts";
import type { CritRule, DiceResult, RoomSettings } from "../model.ts";
import { diceCount, doubleDice, FORMULA_ERRORS, formatFormula, parseFormula, type DiceTerm, type Formula, type FormulaError, type Term } from "./formula.ts";
import { rolledTerms, totalOf, type Draw, type Rolled } from "./roll.ts";

/**
 * A critical hit's damage under the room's rule (docs/design-v1-dice.md,
 * the critical hit rules addendum). The server applies the rule when it
 * rolls, from the `critical` flag on a roll, so no client computes a
 * crit's formula or total. Each rule takes every damage die of the hit,
 * riders included, and counts a flat modifier once unless it doubles the
 * total:
 *
 *   rollTwice    2d6+3 as 4d6+3, the 2024 rule
 *   maxPlusRoll  12 + 2d6 + 3
 *   doubleDice   (2d6 × 2) + 3
 *   doubleTotal  (2d6 + 3) × 2
 *
 * `rollTwice` stores the doubled formula and all its faces. The others
 * store the formula as asked and its faces, with the total by the rule,
 * so a reader rebuilds the arithmetic from the result alone (critParts).
 */

/** The room's rule. Absent, in rooms from before the setting, is the 2024 rule they always rolled by. */
export function critRuleOf(settings: Pick<RoomSettings, "critRule">): CritRule {
  return settings.critRule ?? "rollTwice";
}

function diceOnly(formula: Formula): DiceTerm[] {
  return formula.filter((t): t is DiceTerm => t.kind === "dice");
}

function numbersOnly(formula: Formula): Term[] {
  return formula.filter((t) => t.kind === "number");
}

/** Every die at its highest face: each dice term's kept count times its sides, with its sign. 4d6kh3 maxes to 18. */
export function maxOfDice(formula: Formula): number {
  let max = 0;
  for (const t of diceOnly(formula)) max += t.sign * (t.keep ? t.keep.n : t.count) * t.sides;
  return max;
}

/** The total of a critical's faces under its rule, the formula as the rule rolled it. */
export function critTotal(formula: Formula, faces: readonly number[], rule: CritRule): number {
  switch (rule) {
    case "rollTwice":
      return totalOf(formula, faces);
    case "maxPlusRoll":
      return maxOfDice(formula) + totalOf(formula, faces);
    case "doubleDice":
      // Number terms draw no faces, so the dice alone read the same faces in the same order.
      return 2 * totalOf(diceOnly(formula), faces) + totalOf(numbersOnly(formula), []);
    case "doubleTotal":
      return 2 * totalOf(formula, faces);
  }
}

/**
 * The bounds a critical roll keeps whatever the room's rule: its formula
 * with every count doubled, the rule that draws the most, within an op's
 * 100 dice and 100 characters. The client op's schema and the splitter
 * check it with no state, so a crit that fits there fits under any rule.
 */
export function critBound(formula: Formula): FormulaError | null {
  const doubled = doubleDice(formula);
  if (diceCount(doubled) > LIMITS.dicePerOp) return FORMULA_ERRORS.dice;
  if (formatFormula(doubled).length > LIMITS.diceFormulaChars) return FORMULA_ERRORS.long;
  return null;
}

/** The resolve's roll of a critical hit's damage: the formula as asked, rolled by the rule, the rule kept as `crit`. */
export function rollCritical(formula: Formula, draw: Draw, rule: CritRule): Rolled {
  const bound = critBound(formula);
  if (bound) return { ok: false, error: bound };
  const terms = rule === "rollTwice" ? doubleDice(formula) : formula;
  const faces: number[] = [];
  for (const t of terms) {
    if (t.kind === "dice") for (let i = 0; i < t.count; i++) faces.push(draw(t.sides));
  }
  return { ok: true, result: { formula: formatFormula(terms), faces, total: critTotal(terms, faces, rule), crit: rule } };
}

/**
 * What a reader shows of a critical's result: the dice as rolled, `max`
 * the dice at their highest, `dice` the kept faces' signed sum, `numbers`
 * the flat terms' sum and `base` the plain total of the faces. Null
 * without `crit`, or when its stored text no longer reads.
 */
export type CritParts = { rule: CritRule; formula: Formula; max: number; dice: number; numbers: number; base: number };

export function critParts(result: Pick<DiceResult, "formula" | "faces" | "crit">): CritParts | null {
  if (!result.crit) return null;
  const parsed = parseFormula(result.formula);
  if (!parsed.ok || !rolledTerms(result)) return null;
  const formula = parsed.formula;
  return {
    rule: result.crit,
    formula,
    max: maxOfDice(formula),
    dice: totalOf(diceOnly(formula), result.faces),
    numbers: totalOf(numbersOnly(formula), []),
    base: totalOf(formula, result.faces),
  };
}

/**
 * A critical's formula as it was asked, which Again sends with `critical`
 * once more: the stored formula, or under `rollTwice` its counts halved.
 * Null for a result that is no critical's, or one whose counts the server
 * could not have doubled.
 */
export function askedCritical(result: Pick<DiceResult, "formula" | "crit">): Formula | null {
  if (!result.crit) return null;
  const parsed = parseFormula(result.formula);
  if (!parsed.ok) return null;
  if (result.crit !== "rollTwice") return parsed.formula;
  const halved: Term[] = [];
  for (const t of parsed.formula) {
    if (t.kind === "number") {
      halved.push(t);
      continue;
    }
    if (t.count % 2 !== 0 || (t.keep && t.keep.n % 2 !== 0)) return null;
    halved.push({ ...t, count: t.count / 2, ...(t.keep ? { keep: { high: t.keep.high, n: t.keep.n / 2 } } : {}) });
  }
  return halved;
}
