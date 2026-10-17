import type { Actor, DiceResult, RoomState } from "../model.ts";
import type { ActorTarget, OpOf, RefusalCode } from "../protocol.ts";
import { failingCondition } from "../rules/rollReminders.ts";
import { creatureBonus, isSave, testOf, type D20Test, type SrdRolls } from "./bonus.ts";
import { formulaRange, parseExtra, parseFormula, type Formula } from "./formula.ts";
import { CANNOT_REROLL, rerolled, rerollFace, rollFormula, withDie, withLucky, type Changed, type Draw } from "./roll.ts";

/**
 * The resolve (docs/design-v1-dice.md 4.2 step 4): a dice op the actor has
 * admitted and permitted, turned into the `sys.dice` it stores in its place,
 * holding every die drawn. It runs once, on the server, before the reducer,
 * as an undo is built into `sys.restore`, so replay never rolls. It is
 * pure apart from `draw`, so the dev fixture's local server resolves with it
 * too. The server's entry, with its secure draw and the batch id, is
 * server/rooms/dice.ts.
 */
export type DiceOp = OpOf<"dice.roll" | "roll.dice" | "actor.deathRoll">;

export type Resolved = { ok: true; op: OpOf<"sys.dice"> } | { ok: false; code: RefusalCode; message: string };

/** Whether an op is one the resolve rolls, which the server stores as `sys.dice` in its place. */
export function isDiceOp(op: { t: string }): op is DiceOp {
  return op.t === "dice.roll" || op.t === "roll.dice" || op.t === "actor.deathRoll";
}

export type ResolveDeps = {
  draw: Draw;
  /** The op's batch id, the same for every batch of its tag (5.1). */
  batch: string;
  /** The SRD creatures' numbers, where they are loaded (docs/design-v1-roll-options.md). */
  srd?: SrdRolls | null;
};

export const NO_BONUS = "No bonus is known for that roll. Type your bonus or the total.";
export const OUT_OF_RANGE = "That roll could total outside -50 to 100. Type the total instead.";

function refuse(message: string, code: RefusalCode = "invalid"): Resolved {
  return { ok: false, code, message };
}

export function resolveDiceOp(op: DiceOp, state: RoomState, deps: ResolveDeps): Resolved {
  switch (op.t) {
    case "dice.roll":
      return freeRolls(op, deps);
    case "roll.dice":
      return op.change !== undefined ? changedAnswer(op, op.change, state, deps) : rolledAnswer(op, state, deps);
    case "actor.deathRoll":
      return deathRoll(op, state, deps);
  }
}

function freeRolls(op: OpOf<"dice.roll">, deps: ResolveDeps): Resolved {
  const results: DiceResult[] = [];
  for (const roll of op.rolls) {
    const parsed = parseFormula(roll.formula);
    if (!parsed.ok) return refuse(parsed.error);
    const rolled = rollFormula(parsed.formula, deps.draw, roll.mode);
    if (!rolled.ok) return refuse(rolled.error);
    results.push(roll.cancelled ? { ...rolled.result, cancelled: true } : rolled.result);
  }
  return { ok: true, op: { t: "sys.dice", asked: op, batch: deps.batch, results } };
}

/** `1d20`, the bonus and the extra, as one formula, the mode for its first d20 alone. */
function d20Roll(bonus: number, extra: string | undefined): { ok: true; formula: Formula } | { ok: false; error: string } {
  const formula: Formula = [{ kind: "dice", sign: 1, count: 1, sides: 20 }];
  if (bonus !== 0) formula.push({ kind: "number", sign: bonus < 0 ? -1 : 1, value: Math.abs(bonus) });
  if (extra === undefined) return { ok: true, formula };
  const more = parseExtra(extra);
  if (!more.ok) return { ok: false, error: more.error };
  return { ok: true, formula: [...formula, ...more.formula] };
}

function actorOf(state: RoomState, target: ActorTarget): Actor | undefined {
  if ("characterId" in target) return state.characters[target.characterId]?.actor;
  const token = state.tokens[target.tokenId];
  if (!token) return undefined;
  return "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
}

/** A rolled save that a condition its players can see fails whatever the total (4.2), judged again on every roll. */
function withFails(result: DiceResult, state: RoomState, target: ActorTarget, test: D20Test): DiceResult {
  const { fails: _old, ...rest } = result;
  const fails = isSave(test) ? failingCondition(actorOf(state, target)?.effects ?? [], test) : undefined;
  return fails ? { ...rest, fails } : rest;
}

/** Whether every total the result's formula can roll fits an answer, -50 to 100. */
function inRange(result: DiceResult): boolean {
  const parsed = parseFormula(result.formula);
  if (!parsed.ok) return false;
  const { min, max } = formulaRange(parsed.formula);
  return min >= -50 && max <= 100;
}

/**
 * A request's answer (4.1): 1d20, the creature's bonus for the test (the
 * player's typed one only where the server knows none), and the extra, with
 * the mode on the d20. Its range must fit an answer's totals, so no roll
 * writes a total an answer could not hold.
 */
function rolledAnswer(op: OpOf<"roll.dice">, state: RoomState, deps: ResolveDeps): Resolved {
  const request = state.rolls[op.rollId];
  if (!request) return refuse("roll request is not here", "gone");
  const choice = op.choice ?? 0;
  if (choice >= request.test.choices.length) return refuse("a choice names one the test offers");
  const test = testOf(request, choice);
  const known = creatureBonus({ ...state, srd: deps.srd ?? null }, op.target, test);
  const bonus = known ?? op.bonus;
  if (bonus === undefined) return refuse(NO_BONUS);
  const formula = d20Roll(bonus, op.extra);
  if (!formula.ok) return refuse(formula.error);
  // The range is the formula's, so it is refused before anything is drawn.
  const { min, max } = formulaRange(formula.formula);
  if (min < -50 || max > 100) return refuse(OUT_OF_RANGE);
  const rolled = rollFormula(formula.formula, deps.draw, op.mode);
  if (!rolled.ok) return refuse(rolled.error);
  const result = withFails(op.cancelled ? { ...rolled.result, cancelled: true } : rolled.result, state, op.target, test);
  return { ok: true, op: { t: "sys.dice", asked: op, batch: deps.batch, results: [result], ...(known === null ? { typedBonus: true as const } : {}) } };
}

/**
 * The DM's Allow of the target's pending ask (5.4), applied to the stored
 * result: a reroll of the one face it names (or its default), Lucky's
 * advantage source, or Bardic Inspiration's die. Permissions already found
 * the ask pending on this answer.
 */
function changedAnswer(op: OpOf<"roll.dice">, change: string, state: RoomState, deps: ResolveDeps): Resolved {
  const request = state.rolls[op.rollId];
  const target = request?.targets.find((t) => ("tokenId" in op.target ? t.tokenId === op.target.tokenId : t.characterId === op.target.characterId));
  const ask = target?.change;
  const dice = target?.dice;
  if (!request || !target || !ask || ask.id !== change || !dice) return refuse("It was settled meanwhile.");
  let changed: Changed;
  switch (ask.reason) {
    case "heroic-inspiration":
    case "halfling-luck": {
      const face = ask.face ?? rerollFace(dice, ask.reason);
      changed = face === null ? { ok: false, error: CANNOT_REROLL } : rerolled(dice, ask.reason, face, deps.draw);
      break;
    }
    case "lucky":
      changed = withLucky(dice, deps.draw);
      break;
    case "bardic-inspiration":
      changed = ask.die === undefined ? { ok: false, error: "Bardic Inspiration names its die." } : withDie(dice, ask.die, deps.draw);
      break;
    case "fix-total":
      // A typed total is fixed by typing it again, which the DM allows by reopening it (docs/design-v1-roll-request.md 7.5).
      return refuse("Only a rolled answer can be changed this way.");
  }
  if (!changed.ok) return refuse(changed.error);
  if (!inRange(changed.result)) return refuse(OUT_OF_RANGE);
  const result = withFails(changed.result, state, op.target, testOf(request, target.choice ?? 0));
  return { ok: true, op: { t: "sys.dice", asked: op, batch: deps.batch, results: [result], ...(target.typedBonus ? { typedBonus: true as const } : {}) } };
}

/**
 * A death save (docs/design-v1-roll-options.md 4.3): 1d20 with the
 * creature's death save bonus, 0 where none is known, and the extra. The
 * reducer counts it from the state then.
 */
function deathRoll(op: OpOf<"actor.deathRoll">, state: RoomState, deps: ResolveDeps): Resolved {
  const bonus = creatureBonus({ ...state, srd: deps.srd ?? null }, op.target, { kind: "deathSave" }) ?? 0;
  const formula = d20Roll(bonus, op.extra);
  if (!formula.ok) return refuse(formula.error);
  const rolled = rollFormula(formula.formula, deps.draw, op.mode);
  if (!rolled.ok) return refuse(rolled.error);
  return { ok: true, op: { t: "sys.dice", asked: op, batch: deps.batch, results: [op.cancelled ? { ...rolled.result, cancelled: true } : rolled.result] } };
}
