import type { Defense } from "#shared/dice/defenses.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import type { ConditionKey, DiceRoll, Effect } from "#shared/model.ts";
import { hitOf } from "#shared/dice/roll.ts";
import { OUTCOME_TOO_BIG, type ActorTarget, type DurationInput, type EffectInput, type OpOf } from "#shared/protocol.ts";
import type { DamageType } from "#shared/rules/damage.ts";
import { defenseApplies as applies } from "#shared/rules/typedDamage.ts";
export { parseParts, partsText, typedOnly, partAmounts, defenseKey, rowDamage, dealtTypes, damageWords, type OutcomePart, type PartAmount, type RowDefenses } from "#shared/rules/typedDamage.ts";
import { effectName } from "#shared/logText.ts";

/**
 * A group save's outcome (docs/design-v1-roll-options.md 5.4 and 5.5), as
 * plain functions for node --test: the damage field's typed parts, what
 * each row takes by its result, its Evasion and its defenses part by part,
 * the conditions a failed row gains, and the one `actor.outcome` plan, with
 * its worst case checked against the op's bounds before any roll.
 */

/** Why a failed row gains no condition (5.4), or null when it gains it. */
export function conditionSkip(key: ConditionKey, row: { defenses: readonly Defense[]; qualifiedOn: ReadonlySet<string>; effects: readonly Pick<Effect, "key">[]; hp: { cur: number; temp: number } | null }, amount: number): string | null {
  if (row.defenses.some((d) => d.kind === "immune" && d.of === key && applies(d, row.qualifiedOn))) return `Immune to ${effectName(key)}`;
  if (row.effects.some((e) => e.key === key)) return `Already ${effectName(key)}`;
  if (row.hp && amount >= row.hp.cur + row.hp.temp && row.hp.cur + row.hp.temp > 0) return "Drops to 0 HP";
  return null;
}

export type OutcomeCondition = { key: ConditionKey; duration?: DurationInput; save?: NonNullable<Effect["save"]> };

/** One creature's part of the plan, before it is frozen. `types` go with its damage (dealtTypes), never without it. */
export type PlanRow = { target: ActorTarget; amount: number; conditions: readonly OutcomeCondition[]; remove?: readonly string[]; resist: boolean; types?: readonly DamageType[] };

/**
 * The plan's targets: each creature once, with its amount, its conditions
 * with ids from `newId`, and one Legendary Resistance used. A creature with
 * nothing to change is left out.
 */
export function planTargets(rows: readonly PlanRow[], newId: () => string): OpOf<"actor.outcome">["targets"] {
  const out: OpOf<"actor.outcome">["targets"] = [];
  for (const row of rows) {
    const item: OpOf<"actor.outcome">["targets"][number] = { target: row.target };
    if (row.amount > 0) item.amount = Math.min(100_000, row.amount);
    if (item.amount !== undefined && row.types && row.types.length > 0) item.types = [...row.types];
    if (row.conditions.length > 0) {
      item.effects = row.conditions.map((c): EffectInput => ({ id: newId(), key: c.key, ...(c.duration ? { duration: c.duration } : {}), ...(c.save ? { save: c.save } : {}) }));
    }
    if (row.remove && row.remove.length > 0) item.remove = [...row.remove];
    if (row.resist) item.resist = true;
    if (item.amount !== undefined || item.effects || item.remove || item.resist) out.push(item);
  }
  return out;
}

/**
 * Whether the page's whole contract fits one `actor.outcome` (5.5):
 * every row failing, every condition chosen, the most damage, a
 * resistance each, and every type the damage can carry. Checked whenever
 * the rows or the outcome change, before any roll, so Apply never meets a
 * plan its op refuses. Null when it fits, else the words.
 */
export function worstCase(
  rows: readonly ActorTarget[],
  conditions: readonly OutcomeCondition[] | ((target: ActorTarget) => readonly OutcomeCondition[]),
  label?: string,
  more: { types?: readonly DamageType[]; quiet?: boolean } = {},
): string | null {
  if (rows.length > LIMITS.outcomeTargets) return "At most 100 creatures in one group save.";
  const of = typeof conditions === "function" ? conditions : () => conditions;
  if (rows.some((target) => of(target).length > LIMITS.outcomeEffectsEach)) return OUTCOME_TOO_BIG;
  let n = 0;
  const id = () => `0192f0a8-6c1e-7a4b-9c3d-${String(n++).padStart(12, "0")}`;
  const op: OpOf<"actor.outcome"> = {
    t: "actor.outcome",
    plan: id(),
    ...(label ? { label } : {}),
    targets: planTargets(
      rows.map((target) => ({ target, amount: 100_000, conditions: of(target), resist: true, ...(more.types ? { types: more.types } : {}) })),
      id,
    ),
    ...(more.quiet ? { quiet: true as const } : {}),
  };
  return serializedBytes(op) <= LIMITS.outcomeOpBytes ? null : OUTCOME_TOO_BIG;
}

/**
 * A shared attack's results (4.4), each matched to the attacker that sent
 * it by its creature, never by its place among the results, so a refused
 * batch or a selection changed since never gives one creature's roll to
 * another. An attacker whose roll did not land has none.
 */
export function attackResults<T extends { creature: ActorTarget }>(sent: readonly T[], rolls: readonly DiceRoll[], ac: number | null): { each: T; roll: DiceRoll; verdict: "critical" | "hit" | "miss" | null }[] {
  return sent.flatMap((each) => {
    const c = each.creature;
    const roll = rolls.find((r) => ("tokenId" in c ? r.tokenId === c.tokenId : r.characterId === c.characterId));
    return roll ? [{ each, roll, verdict: ac === null ? null : hitOf(roll, ac) }] : [];
  });
}
