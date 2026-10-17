import type { DiceResult, RollChange } from "../model.ts";
import { randomIndex } from "../passphrase.ts";
import { applyMode, FORMULA_ERRORS, formatFormula, parseFormula, type AdvantageMode, type DiceTerm, type Formula, type FormulaError, type NumberTerm, type Term } from "./formula.ts";

/**
 * Rolling a parsed formula, and reading a stored result back
 * (docs/design-v1-dice.md 4.2 and 5.1). Only the server's resolve draws: a
 * result stores every face, so replay and every reader work from the faces
 * and never roll again.
 */

/** One die of `sides` sides, 1 to `sides`. */
export type Draw = (sides: number) => number;

/**
 * The server's draw: the passphrase generator's rejection sampling over Web
 * Crypto's getRandomValues, which Node 24 has globally, from the system's
 * secure random source. Unbiased for every side count up to 2^32.
 */
export const serverDraw: Draw = (sides) => randomIndex(sides) + 1;

/** Why a player asks the DM to change a rolled answer (docs/design-v1-roll-request.md 1.1). */
export type ChangeReason = RollChange["reason"];

export type Rolled = { ok: true; result: DiceResult } | { ok: false; error: FormulaError };

/**
 * Which faces of a dice term count: all of them without a keep, else the n
 * highest or lowest, and of equal faces the earlier, so a reader and the
 * total always agree on which die was dropped.
 */
export function keptFaces(term: Pick<DiceTerm, "keep">, faces: readonly number[]): boolean[] {
  const keep = term.keep;
  if (!keep) return faces.map(() => true);
  const order = faces.map((_, i) => i).sort((a, b) => (keep.high ? faces[b]! - faces[a]! : faces[a]! - faces[b]!) || a - b);
  const kept = faces.map(() => false);
  for (const i of order.slice(0, keep.n)) kept[i] = true;
  return kept;
}

/** The total of a formula's terms over their faces, drawn term by term, die by die. */
export function totalOf(formula: Formula, faces: readonly number[]): number {
  let total = 0;
  let at = 0;
  for (const t of formula) {
    if (t.kind === "number") {
      total += t.sign * t.value;
      continue;
    }
    const own = faces.slice(at, at + t.count);
    at += t.count;
    const kept = keptFaces(t, own);
    let sum = 0;
    own.forEach((face, i) => {
      if (kept[i]) sum += face;
    });
    total += t.sign * sum;
  }
  return total;
}

/**
 * Rolls a formula, with a resolved mode applied to its one d20 first (3.4).
 * The result's formula is the canonical text as rolled, so "1d20+5" with
 * advantage stores "2d20kh1+5" and its two faces.
 */
export function rollFormula(formula: Formula, draw: Draw, mode?: AdvantageMode): Rolled {
  let terms = formula;
  if (mode) {
    const applied = applyMode(formula, mode);
    if (!applied.ok) return applied;
    terms = applied.formula;
  }
  const faces: number[] = [];
  for (const t of terms) {
    if (t.kind === "dice") for (let i = 0; i < t.count; i++) faces.push(draw(t.sides));
  }
  const result: DiceResult = { formula: formatFormula(terms), faces, total: totalOf(terms, faces) };
  if (mode) result.mode = mode;
  return { ok: true, result };
}

export type RolledTerm =
  | {
      term: DiceTerm;
      faces: number[];
      kept: boolean[];
      /** The index of the term's first face in the result's `faces`. */
      first: number;
    }
  | { term: NumberTerm };

/**
 * A result's terms, each dice term with its faces and which it kept. Null
 * when its stored text no longer parses, as a later grammar might refuse it,
 * or its faces do not match: such a result shows as its text and total.
 */
export function rolledTerms(result: Pick<DiceResult, "formula" | "faces">): RolledTerm[] | null {
  const parsed = parseFormula(result.formula);
  if (!parsed.ok) return null;
  const out: RolledTerm[] = [];
  let at = 0;
  for (const term of parsed.formula) {
    if (term.kind === "number") {
      out.push({ term });
      continue;
    }
    const faces = result.faces.slice(at, at + term.count);
    if (faces.length !== term.count) return null;
    out.push({ term, faces, kept: keptFaces(term, faces), first: at });
    at += term.count;
  }
  return at === result.faces.length ? out : null;
}

function d20Terms(terms: readonly RolledTerm[]): Extract<RolledTerm, { kept: boolean[] }>[] {
  return terms.filter((t): t is Extract<RolledTerm, { kept: boolean[] }> => "kept" in t && t.term.sides === 20);
}

/**
 * The d20 that decides a D20 Test: the result's one d20 term, when it keeps
 * one face. A roll of two d20 terms, or one keeping two, has none, so it
 * never reads a natural 20.
 */
export function keptD20(result: Pick<DiceResult, "formula" | "faces">): { index: number; face: number } | null {
  const terms = rolledTerms(result);
  if (!terms) return null;
  const d20s = d20Terms(terms);
  const only = d20s[0];
  if (d20s.length !== 1 || !only || only.kept.filter(Boolean).length !== 1) return null;
  const i = only.kept.indexOf(true);
  return { index: only.first + i, face: only.faces[i]! };
}

/** 20 or 1 when the result's deciding d20 shows it, else null. */
export function naturalOf(result: Pick<DiceResult, "formula" | "faces">): 20 | 1 | null {
  const d20 = keptD20(result);
  if (d20?.face === 20) return 20;
  if (d20?.face === 1) return 1;
  return null;
}

/**
 * An attack roll against an AC (5.6, SRD 5.2.1 attack rolls): a kept d20
 * at or above the critical range hits critically and a 1 misses, whatever
 * the total. Otherwise it hits when the total meets the AC.
 */
export function hitOf(roll: Pick<DiceResult, "formula" | "faces" | "total"> & { critOn?: 18 | 19 | 20 }, ac: number): "critical" | "hit" | "miss" {
  const d20 = keptD20(roll);
  if (d20 && d20.face >= (roll.critOn ?? 20)) return "critical";
  if (d20 && d20.face === 1) return "miss";
  return roll.total >= ac ? "hit" : "miss";
}

/**
 * The face a reroll changes by default (5.4): for Heroic Inspiration the
 * kept d20 on a normal or disadvantage roll and the dropped one on an
 * advantage roll, and for Halfling Luck the d20 showing 1, the kept one
 * first. Null when the reason redraws no face or the roll has no such die.
 */
export function rerollFace(result: Pick<DiceResult, "formula" | "faces">, reason: ChangeReason): number | null {
  const terms = rolledTerms(result);
  if (!terms) return null;
  const d20 = d20Terms(terms)[0];
  if (!d20) return null;
  if (reason === "heroic-inspiration") {
    const advantage = d20.term.keep?.high === true && d20.term.count > d20.term.keep.n;
    const i = advantage ? d20.kept.indexOf(false) : d20.kept.indexOf(true);
    return i < 0 ? null : d20.first + i;
  }
  if (reason === "halfling-luck") {
    const ones = d20Terms(terms).flatMap((t) => t.faces.map((face, i) => ({ index: t.first + i, kept: t.kept[i]!, face }))).filter((f) => f.face === 1);
    return (ones.find((f) => f.kept) ?? ones[0])?.index ?? null;
  }
  return null;
}

/**
 * Which faces an ask may name, the one rule the card, the ask and the
 * resolve all call (5.4): for Heroic Inspiration any one die of the roll,
 * kept or dropped, a d20 or another such as Bless's d4, and for Halfling
 * Luck a d20 showing 1. No other reason redraws a face.
 */
export function rerollable(result: Pick<DiceResult, "formula" | "faces">, reason: ChangeReason, face: number): boolean {
  if (!Number.isInteger(face) || face < 0 || face >= result.faces.length) return false;
  const terms = rolledTerms(result);
  if (!terms) return false;
  if (reason === "heroic-inspiration") return true;
  if (reason !== "halfling-luck") return false;
  return d20Terms(terms).some((t) => face >= t.first && face < t.first + t.faces.length) && result.faces[face] === 1;
}

/*
 * The DM's Allow of a player's ask (5.4), applied to the stored result. Each
 * keeps every face it does not name, applies the kept rule again and sums
 * the total again, so the changed answer reads as one roll.
 */

export const CANNOT_REROLL = "That die cannot be rerolled this way.";
export const LUCKY_CHANGES_NOTHING = "Lucky changes nothing on this roll.";

export type Changed = { ok: true; result: DiceResult } | { ok: false; error: string };

function withFaces(result: DiceResult, formula: Formula, faces: number[], mode: AdvantageMode | undefined, cancelled: boolean): DiceResult {
  const out: DiceResult = { formula: formatFormula(formula), faces, total: totalOf(formula, faces) };
  if (mode) out.mode = mode;
  if (cancelled) out.cancelled = true;
  if (result.fails) out.fails = result.fails;
  return out;
}

/** A reroll (Heroic Inspiration, Halfling Luck): the one named face drawn again, by `rerollable`'s rule. */
export function rerolled(result: DiceResult, reason: ChangeReason, face: number, draw: Draw): Changed {
  const terms = rolledTerms(result);
  const parsed = parseFormula(result.formula);
  if (!terms || !parsed.ok || !rerollable(result, reason, face)) return { ok: false, error: CANNOT_REROLL };
  const owner = terms.find((t): t is Extract<RolledTerm, { kept: boolean[] }> => "kept" in t && face >= t.first && face < t.first + t.faces.length);
  if (!owner) return { ok: false, error: CANNOT_REROLL };
  const faces = [...result.faces];
  faces[face] = draw(owner.term.sides);
  return { ok: true, result: withFaces(result, parsed.formula, faces, result.mode, result.cancelled === true) };
}

/**
 * Lucky (2024): one more advantage source on the roll, resolved by the
 * cancel rule with what it had (3.3). A normal roll draws one more d20 and
 * keeps the higher. On a disadvantage roll the two cancel to a normal roll,
 * so it keeps its first d20 and draws nothing. A roll with advantage
 * already, or whose sources cancelled, changes nothing.
 */
export function withLucky(result: DiceResult, draw: Draw): Changed {
  if (result.mode === "adv" || result.cancelled) return { ok: false, error: LUCKY_CHANGES_NOTHING };
  const terms = rolledTerms(result);
  const parsed = parseFormula(result.formula);
  if (!terms || !parsed.ok) return { ok: false, error: LUCKY_CHANGES_NOTHING };
  const at = terms.findIndex((t) => "kept" in t && t.term.sides === 20 && t.term.sign === 1 && (result.mode === "dis" ? t.term.count === 2 && t.term.keep?.high === false : t.term.count === 1 && !t.term.keep));
  const d20 = terms[at];
  if (!d20 || !("kept" in d20)) return { ok: false, error: LUCKY_CHANGES_NOTHING };
  const faces = [...result.faces];
  const formula: Term[] = [...parsed.formula];
  if (result.mode === "dis") {
    faces.splice(d20.first + 1, 1);
    formula[at] = { kind: "dice", sign: 1, count: 1, sides: 20 };
    return { ok: true, result: withFaces(result, formula, faces, undefined, true) };
  }
  faces.splice(d20.first + 1, 0, draw(20));
  formula[at] = { kind: "dice", sign: 1, count: 2, sides: 20, keep: { high: true, n: 1 } };
  return { ok: true, result: withFaces(result, formula, faces, "adv", false) };
}

/** An added die, Bardic Inspiration's: `+1dN` after the roll, with its new face. */
export function withDie(result: DiceResult, sides: number, draw: Draw): Changed {
  const parsed = parseFormula(result.formula);
  if (!parsed.ok) return { ok: false, error: FORMULA_ERRORS.other };
  const formula: Formula = [...parsed.formula, { kind: "dice", sign: 1, count: 1, sides }];
  if (formula.length > 20) return { ok: false, error: FORMULA_ERRORS.terms };
  return { ok: true, result: withFaces(result, formula, [...result.faces, draw(sides)], result.mode, result.cancelled === true) };
}
