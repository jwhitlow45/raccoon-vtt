import { LIMITS, serializedBytes } from "../limits.ts";
import { applyMode, diceCount, FORMULA_ERRORS, parseFormula, type AdvantageMode, type FormulaError } from "./formula.ts";

/**
 * The splitter (docs/design-v1-dice.md 8.4): a group of rolls into
 * `dice.roll` ops that each keep within the three op bounds, 20 rolls, 3 KiB
 * serialized and 100 dice counted after each mode (advantage's d20 counts
 * two). Every batch goes under one tag, numbered by `part`, so the server's
 * receipts settle each on its own and every viewer groups them by `batch`
 * as one roll.
 *
 * Every roll is checked first, so one bad formula sends nothing. A single
 * roll past a bound on its own is refused in that bound's words.
 */
export type BatchRoll = { formula: string; mode?: AdvantageMode };

export type BatchOp<R, E> = E & { t: "dice.roll"; part?: number; rolls: R[] };

export type Batched<R, E> = { ok: true; ops: BatchOp<R, E>[] } | { ok: false; error: FormulaError; index: number };

export function batchRolls<R extends BatchRoll, E extends object>(rolls: readonly R[], envelope: E): Batched<R, E> {
  if (rolls.length === 0) return { ok: false, error: FORMULA_ERRORS.other, index: 0 };
  // Measured with the largest part number, so a batch that fits here fits under any part.
  const bytesOf = (batch: readonly R[]) => serializedBytes({ t: "dice.roll", ...envelope, part: LIMITS.diceBatchesPerTag - 1, rolls: batch });
  const dice: number[] = [];
  for (const [index, roll] of rolls.entries()) {
    const parsed = parseFormula(roll.formula);
    if (!parsed.ok) return { ok: false, error: parsed.error, index };
    let formula = parsed.formula;
    if (roll.mode) {
      const applied = applyMode(formula, roll.mode);
      if (!applied.ok) return { ok: false, error: applied.error, index };
      formula = applied.formula;
    }
    if (bytesOf([roll]) > LIMITS.diceOpBytes) return { ok: false, error: FORMULA_ERRORS.tooMuch, index };
    dice.push(diceCount(formula));
  }
  const batches: R[][] = [];
  let current: R[] = [];
  let currentDice = 0;
  for (const [index, roll] of rolls.entries()) {
    const more = dice[index]!;
    const fits = current.length < LIMITS.diceRollsPerOp && currentDice + more <= LIMITS.dicePerOp && bytesOf([...current, roll]) <= LIMITS.diceOpBytes;
    if (!fits && current.length > 0) {
      batches.push(current);
      current = [];
      currentDice = 0;
    }
    current.push(roll);
    currentDice += more;
  }
  batches.push(current);
  if (batches.length > LIMITS.diceBatchesPerTag) return { ok: false, error: FORMULA_ERRORS.tooMuch, index: 0 };
  const ops = batches.map((batch, part): BatchOp<R, E> => (batches.length === 1 ? { t: "dice.roll", ...envelope, rolls: batch } : { t: "dice.roll", ...envelope, part, rolls: batch }));
  return { ok: true, ops };
}
