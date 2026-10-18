import { LIMITS } from "../limits.ts";

/**
 * The dice grammar (docs/design-v1-dice.md 3), one module for the client and
 * the server, so a formula the Dice field reads as valid is one the server
 * rolls, and every refusal reads the same on both sides (FORMULA_ERRORS).
 *
 *   roll text = formula { word }
 *   formula   = [ sign ] term { sign term }
 *   term      = dice | number
 *   dice      = [ count ] "d" ( sides | "%" ) [ keep ]
 *   keep      = ( "kh" | "kl" | "dh" | "dl" ) [ n ]
 *   sign      = "+" | "-" | "−"
 *
 * Letters match in any case, `d%` is a d100, and U+2212, the SRD's minus,
 * reads as `-`. Spaces and tabs may stand between terms and signs, never
 * inside a term. The formula ends at the first token that is not a sign or,
 * after a sign, a term, and only at a space: "4d6k3" is refused rather than
 * read as 4d6 with a label "k3", which would roll something else than asked.
 */

export type AdvantageMode = "adv" | "dis";

/**
 * One reason a roll has advantage or disadvantage, by a key the surface
 * words: "restrained", "magic-resistance", "pressed", "typed". Sources are
 * gathered unresolved and resolved once, by whoever builds the op (3.3).
 */
export type AdvantageSource = { kind: "adv" | "dis"; from: string };

export type DiceTerm = { kind: "dice"; sign: 1 | -1; count: number; sides: number; keep?: { high: boolean; n: number } };
export type NumberTerm = { kind: "number"; sign: 1 | -1; value: number };
export type Term = DiceTerm | NumberTerm;
/** 1 to 20 terms. A formula from parseFormula or parseRollText holds at least one die. */
export type Formula = Term[];

/** Appendix A: every refusal of a formula, the same words on the client and the server. */
export const FORMULA_ERRORS = {
  dice: "Roll 1 to 100 dice, as 1d20+5.",
  sides: "Dice have 2 to 1,000 sides.",
  number: "Numbers go up to 1,000.",
  keep: "Keep 1 to all of the dice.",
  terms: "At most 20 parts in one roll.",
  sign: "End with dice or a number.",
  long: "That roll is too long.",
  tooMuch: "That is too much to roll at once. Roll fewer at a time.",
  label: "Label: 60 characters at most.",
  mode: "Advantage and Disadvantage need one d20 in the roll.",
  other: "Try 1d20+5 or 2d6+3 fire.",
} as const;

export type FormulaError = (typeof FORMULA_ERRORS)[keyof typeof FORMULA_ERRORS];

export type Parsed = { ok: true; formula: Formula } | { ok: false; error: FormulaError };
export type ParsedRollText = { ok: true; formula: Formula; sources: AdvantageSource[]; label?: string } | { ok: false; error: FormulaError };

const SPACE = /[ \t]/;
const SIGN = /[+\-\u2212]/;
const DICE_TERM = /^(\d*)d(\d+|%)(?:(kh|kl|dh|dl)(\d*))?/i;
const NUMBER_TERM = /^\d+/;
/** Control characters but the tab, which may stand between terms. */
const CONTROL = /[\x00-\x08\x0A-\x1F\x7F-\x9F\u2028\u2029]/;
const ADVANTAGE_WORDS: Record<string, AdvantageSource["kind"]> = { adv: "adv", advantage: "adv", dis: "dis", disadvantage: "dis" };

type Scan = {
  terms: Term[];
  /** What follows the formula, untrimmed: the words of a roll text. */
  rest: string;
  error?: FormulaError;
};

/**
 * Reads the formula at the start of `text` and stops where its words begin.
 * A refusal of a bound comes with the terms read so far, so a quick die can
 * still be added to a formula that is past one (addDie).
 */
function scan(text: string): Scan {
  const terms: Term[] = [];
  let i = 0;
  const skip = () => {
    const from = i;
    while (i < text.length && SPACE.test(text[i]!)) i++;
    return i > from;
  };
  const fail = (error: FormulaError, end = i): Scan => ({ terms, rest: text.slice(end), error });
  skip();
  let sign: 1 | -1 = 1;
  let signed = false;
  if (i < text.length && SIGN.test(text[i]!)) {
    sign = text[i] === "+" ? 1 : -1;
    signed = true;
    i++;
    skip();
  }
  for (;;) {
    const at = text.slice(i);
    const dice = DICE_TERM.exec(at);
    const number = dice ? null : NUMBER_TERM.exec(at);
    if (!dice && !number) return fail(signed ? FORMULA_ERRORS.sign : FORMULA_ERRORS.other);
    if (dice) {
      const count = dice[1] === "" ? 1 : Number(dice[1]);
      const sides = dice[2] === "%" ? 100 : Number(dice[2]);
      if (count < 1 || count > LIMITS.dicePerOp) return fail(FORMULA_ERRORS.dice);
      if (sides < 2 || sides > LIMITS.diceSidesMax) return fail(FORMULA_ERRORS.sides);
      const term: DiceTerm = { kind: "dice", sign, count, sides };
      if (dice[3] !== undefined) {
        const how = dice[3].toLowerCase();
        const n = dice[4] === "" ? 1 : Number(dice[4]);
        const drop = how === "dh" || how === "dl";
        if (n < 1 || n > (drop ? count - 1 : count)) return fail(FORMULA_ERRORS.keep);
        // A drop reads as the matching keep: 4d6dl1 keeps the three highest.
        term.keep = drop ? { high: how === "dl", n: count - n } : { high: how === "kh", n };
      }
      terms.push(term);
      i += dice[0].length;
    } else {
      const value = Number(number![0]);
      if (value > LIMITS.diceNumberMax) return fail(FORMULA_ERRORS.number);
      terms.push({ kind: "number", sign, value });
      i += number![0].length;
    }
    if (terms.length > LIMITS.diceTermsPerFormula) return fail(FORMULA_ERRORS.terms);
    const end = i;
    const spaced = skip();
    if (i >= text.length) return { terms, rest: "" };
    if (SIGN.test(text[i]!)) {
      sign = text[i] === "+" ? 1 : -1;
      signed = true;
      i++;
      skip();
      continue;
    }
    // Words begin only after a space. Anything glued to a term is a typo, not a label.
    if (!spaced) return fail(FORMULA_ERRORS.other, end);
    return { terms, rest: text.slice(end) };
  }
}

/**
 * The checks every whole formula passes: its dice, and its canonical text
 * within an op's 100 characters. The canonical text is what an op carries,
 * so the spaces a person typed never count.
 */
function checkWhole(terms: Formula, needsDie: boolean): Parsed {
  const dice = diceCount(terms);
  if ((needsDie && dice === 0) || dice > LIMITS.dicePerOp) return { ok: false, error: FORMULA_ERRORS.dice };
  if (formatFormula(terms).length > LIMITS.diceFormulaChars) return { ok: false, error: FORMULA_ERRORS.long };
  return { ok: true, formula: terms };
}

/** Dice and numbers alone, at least one die, words refused: a formula as an op carries it. */
export function parseFormula(text: string): Parsed {
  if (CONTROL.test(text)) return { ok: false, error: FORMULA_ERRORS.other };
  const s = scan(text);
  if (s.error) return { ok: false, error: s.error };
  if (s.rest.trim() !== "") return { ok: false, error: FORMULA_ERRORS.other };
  return checkWhole(s.terms, true);
}

/**
 * The Dice field's text: a formula, then words. `adv`, `advantage`, `dis`
 * and `disadvantage`, whole words in any case wherever they stand among the
 * words, are advantage sources ("typed"). Typing both gives both, which the
 * cancel rule resolves with every other source (3.3). The other words,
 * joined by single spaces, are the label.
 */
export function parseRollText(text: string): ParsedRollText {
  if (CONTROL.test(text)) return { ok: false, error: FORMULA_ERRORS.other };
  const s = scan(text);
  if (s.error) return { ok: false, error: s.error };
  const whole = checkWhole(s.terms, true);
  if (!whole.ok) return whole;
  const sources: AdvantageSource[] = [];
  const words: string[] = [];
  for (const word of s.rest.split(/[ \t]+/)) {
    if (word === "") continue;
    const kind = ADVANTAGE_WORDS[word.toLowerCase()];
    if (kind) sources.push({ kind, from: "typed" });
    else words.push(word);
  }
  const label = words.join(" ");
  if (label.length > LIMITS.diceLabelChars) return { ok: false, error: FORMULA_ERRORS.label };
  return label === "" ? { ok: true, formula: whole.formula, sources } : { ok: true, formula: whole.formula, sources, label };
}

/**
 * `roll.dice`'s extra (4.1): dice and numbers added after the d20 and the
 * bonus, "+1d4" or "-4". No die is needed, and a bare first term adds.
 */
export function parseExtra(text: string): Parsed {
  if (CONTROL.test(text) || text.trim() === "") return { ok: false, error: FORMULA_ERRORS.other };
  if (text.trim().length > LIMITS.diceExtraChars) return { ok: false, error: FORMULA_ERRORS.long };
  const s = scan(text);
  if (s.error) return { ok: false, error: s.error };
  if (s.rest.trim() !== "") return { ok: false, error: FORMULA_ERRORS.other };
  return checkWhole(s.terms, false);
}

/**
 * One resolved mode on the formula's one d20 (3.4): exactly one term that is
 * `1d20`, positive, with no keep, becomes `2d20kh1` or `2d20kl1`. A roll
 * without one d20 is refused, so a source on damage never adds a die.
 */
export function applyMode(formula: Formula, mode: AdvantageMode): Parsed {
  const at: number[] = [];
  formula.forEach((t, i) => {
    if (t.kind === "dice" && t.sign === 1 && t.count === 1 && t.sides === 20 && !t.keep) at.push(i);
  });
  if (at.length !== 1) return { ok: false, error: FORMULA_ERRORS.mode };
  const out = formula.map((t, i): Term => (i === at[0] ? { kind: "dice", sign: 1, count: 2, sides: 20, keep: { high: mode === "adv", n: 1 } } : t));
  if (diceCount(out) > LIMITS.dicePerOp) return { ok: false, error: FORMULA_ERRORS.dice };
  return { ok: true, formula: out };
}

function termText(t: Term): string {
  if (t.kind === "number") return String(t.value);
  return `${t.count}d${t.sides}${t.keep ? `${t.keep.high ? "kh" : "kl"}${t.keep.n}` : ""}`;
}

/**
 * The canonical text, "1d20+5": lowercase, no spaces, every count and n
 * written. With a mode it writes the mode's d20 back as `1d20` and says the
 * mode in the SRD's capitals, so the text says what was asked: "1d20+5 with
 * Advantage".
 */
export function formatFormula(formula: Formula, mode?: AdvantageMode): string {
  let modeAt = -1;
  if (mode) modeAt = formula.findIndex((t) => t.kind === "dice" && t.sign === 1 && t.count === 2 && t.sides === 20 && t.keep?.n === 1 && t.keep.high === (mode === "adv"));
  const text = formula
    .map((t, i) => {
      const body = i === modeAt ? "1d20" : termText(t);
      if (i === 0) return t.sign === -1 ? `-${body}` : body;
      return `${t.sign === -1 ? "-" : "+"}${body}`;
    })
    .join("");
  return mode ? `${text} with ${mode === "adv" ? "Advantage" : "Disadvantage"}` : text;
}

/** The dice a formula rolls, every die of a term counted, kept or not. */
export function diceCount(formula: Formula): number {
  let n = 0;
  for (const t of formula) if (t.kind === "dice") n += t.count;
  return n;
}

/** The lowest and highest totals a formula can roll. */
export function formulaRange(formula: Formula): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const t of formula) {
    const lo = t.kind === "number" ? t.value : t.keep ? t.keep.n : t.count;
    const hi = t.kind === "number" ? t.value : lo * t.sides;
    if (t.sign === 1) {
      min += lo;
      max += hi;
    } else {
      min -= hi;
      max -= lo;
    }
  }
  return { min, max };
}

/** A critical hit's damage (doc 3): every dice term's count doubled, a keep's n with it. */
export function doubleDice(formula: Formula): Formula {
  return formula.map((t): Term => (t.kind === "dice" ? { ...t, count: t.count * 2, ...(t.keep ? { keep: { high: t.keep.high, n: t.keep.n * 2 } } : {}) } : t));
}

/**
 * A quick die added to the Dice field's text (8.2): "d6" becomes "2d6" and
 * "2d6" gains "+1d8", the words after the formula kept. A text with no
 * formula gets the die in front of its words, and a formula with something
 * glued to it gets the die at its end, so a tap never rewrites a typo.
 */
export function addDie(text: string, sides: number): string {
  const trimmed = text.trim();
  if (trimmed === "") return `1d${sides}`;
  const s = scan(trimmed);
  if (s.terms.length === 0) return `1d${sides} ${trimmed}`;
  if (s.error === FORMULA_ERRORS.other) return `${trimmed}+1d${sides}`;
  const terms = [...s.terms];
  let at = -1;
  terms.forEach((t, i) => {
    if (t.kind === "dice" && t.sign === 1 && t.sides === sides && !t.keep) at = i;
  });
  const found = terms[at];
  if (found && found.kind === "dice") terms[at] = { ...found, count: found.count + 1 };
  else terms.push({ kind: "dice", sign: 1, count: 1, sides });
  const rest = s.error ? "" : s.rest.trim();
  return rest === "" ? formatFormula(terms) : `${formatFormula(terms)} ${rest}`;
}

/**
 * A d20 roll with a bonus, as rolled: "1d20+5", "1d20-1", "1d20" for 0, and
 * with a mode its d20 already doubled ("2d20kh1+5"), so its text and range
 * match the result's. An op sends d20Formula(bonus) and the mode beside it.
 */
export function d20Formula(bonus: number, mode?: AdvantageMode): string {
  const terms: Formula = [{ kind: "dice", sign: 1, count: 1, sides: 20 }];
  if (bonus !== 0) terms.push({ kind: "number", sign: bonus < 0 ? -1 : 1, value: Math.abs(bonus) });
  if (!mode) return formatFormula(terms);
  const applied = applyMode(terms, mode);
  return formatFormula(applied.ok ? applied.formula : terms);
}

/**
 * The cancel rule (3.3, SRD 5.2.1): advantage when the sources hold only
 * advantage, disadvantage when only disadvantage, and none when they hold
 * none or both, however many of each. Only the builder of an op calls it,
 * once, so no cancellation is lost to an early resolve.
 */
export function resolveAdvantage(sources: readonly AdvantageSource[]): AdvantageMode | undefined {
  const adv = sources.some((s) => s.kind === "adv");
  const dis = sources.some((s) => s.kind === "dis");
  if (adv && !dis) return "adv";
  if (dis && !adv) return "dis";
  return undefined;
}

/** What an op carries of its sources: the resolved mode, and `cancelled` when both kinds were there, which a later Lucky must know (5.4). */
export function advantageFields(sources: readonly AdvantageSource[]): { mode?: AdvantageMode; cancelled?: true } {
  const mode = resolveAdvantage(sources);
  if (mode) return { mode };
  return sources.some((s) => s.kind === "adv") && sources.some((s) => s.kind === "dis") ? { cancelled: true } : {};
}
