import type { ConditionKey, Effect } from "#shared/model.ts";
import type { ActorTarget, DurationInput, OpOf } from "#shared/protocol.ts";
import type { DamageType } from "#shared/rules/damage.ts";
import { creatureRolls, type DiceView } from "../creature.ts";
import type { Page } from "./chain.ts";
import { stateOf } from "./chain.ts";
import { conditionSkip, damageWords, parseParts, partAmounts, planTargets, rowDamage, worstCase, type OutcomeCondition, type PartAmount, type PlanRow } from "./outcome.ts";
import { rowResult, type Mark, type RowBase } from "./rows.ts";

/**
 * What the outcome does to each row (docs/design-v1-roll-options.md 5.4)
 * and the plan Apply freezes from them (5.5), read from the page and the
 * DM's view at the moment of reading.
 */

export type RowOutcome = {
  result: Mark | null;
  /** A failed save turned to a pass by Legendary Resistance. */
  resisted: boolean;
  /** What the row takes: the DM's own amount where typed, else the worked-out one. */
  amount: number;
  /** The worked-out amount, from the parts, the save and the row's defenses, whatever the DM typed over it. */
  computed: number;
  /** "Immune to fire: 9 radiant", "17", or "" before the damage is known. */
  words: string;
  conditions: OutcomeCondition[];
  /** Why a condition does not go on: "Immune to Frightened". */
  skips: string[];
  /** Offered on a failed save of a creature with uses left. */
  legendaryLeft: number;
  /** The row's qualified defenses, for its switches. */
  qualified: { key: string; words: string }[];
  /** Evasion reaches this save: a Dexterity save that halves. */
  evasionApplies: boolean;
  /** Whether the row counts Evasion: the DM's switch, else what the creature's block or stat block says. */
  evasion: boolean;
};

function hpOf(dice: DiceView, target: ActorTarget): { cur: number; temp: number } | null {
  const token = "tokenId" in target ? dice.view.tokens[target.tokenId] : undefined;
  const actor = token ? ("inline" in token.actor ? token.actor.inline : dice.view.characters[token.actor.ref]?.actor) : "characterId" in target ? dice.view.characters[target.characterId]?.actor : undefined;
  return actor?.hp ? { cur: actor.hp.cur, temp: actor.hp.temp } : null;
}

function effectsOf(dice: DiceView, target: ActorTarget): Effect[] {
  const token = "tokenId" in target ? dice.view.tokens[target.tokenId] : undefined;
  const actor = token ? ("inline" in token.actor ? token.actor.inline : dice.view.characters[token.actor.ref]?.actor) : "characterId" in target ? dice.view.characters[target.characterId]?.actor : undefined;
  return actor?.effects ?? [];
}

/** The outcome's damage parts with their amounts, once typed or rolled, or null while a roll waits. */
export function amountsOf(page: Page, fillType?: DamageType): PartAmount[] | null {
  if (page.outcome.damage.trim() === "") return [];
  const parsed = parseParts(page.outcome.damage, fillType);
  if (!parsed.ok) return null;
  return partAmounts(parsed.parts, page.damage?.state === "committed" ? (page.damage.amounts ?? []) : []);
}

/** The DC of the save that ends the conditions: the DM's own, else the page's, null while neither is set. */
export function saveEndsDc(page: Page): number | null {
  return page.outcome.saveEnds ? (page.outcome.saveEnds.dc ?? page.dc) : null;
}

/** The save a failed row's conditions carry, or undefined for none. */
function saveOf(page: Page): NonNullable<Effect["save"]> | undefined {
  const dc = saveEndsDc(page);
  if (!page.outcome.saveEnds || dc === null) return undefined;
  return { ability: page.outcome.saveEnds.ability, dc, ...(page.spell ? { spell: true as const } : {}) };
}

/** The conditions' end as a duration input on one creature (5.4): its own turn, or a row of the fight. */
export function durationFor(page: Page, target: ActorTarget): DurationInput | undefined {
  const { lasts } = page.outcome;
  if (lasts.mode === "none") return undefined;
  const of = lasts.anchor === "own" ? target : { entryId: lasts.anchor };
  return lasts.mode === "rounds" ? { mode: "rounds", rounds: lasts.rounds, of } : { mode: lasts.mode, of };
}

export function rowOutcome(page: Page, row: RowBase, dice: DiceView, amounts: PartAmount[] | null): RowOutcome {
  const state = stateOf(page, row);
  const rolls = creatureRolls(dice, row.target);
  const base = rowResult(row, state, page.test, page.dc);
  const legendaryLeft = base === "fail" && page.test.kind === "save" ? (rolls?.legendaryLeft ?? 0) : 0;
  const resisted = legendaryLeft > 0 && state.legendary === true;
  const result: Mark | null = resisted ? "pass" : base;
  const defenses = rolls?.defenses ?? [];
  const qualifiedOn = new Set(state.qualifiedOn ?? []);
  const effects = effectsOf(dice, row.target);
  const qualified = defenses
    .filter((d) => d.qualifier !== undefined)
    .map((d) => ({ key: `${d.kind}:${d.of}:${d.qualifier ?? ""}:${d.source}`, words: `${d.kind === "immune" ? "Immune to" : d.kind === "resist" ? "Resists" : "Vulnerable to"} ${d.of} ${d.qualifier}` }));
  const evasionApplies = page.test.kind === "save" && page.test.ability === "dex" && page.outcome.onPass === "half";
  const evasion = state.evasion ?? rolls?.evasion ?? false;
  const out: RowOutcome = { result, resisted, amount: 0, computed: 0, words: "", conditions: [], skips: [], legendaryLeft, qualified, evasionApplies, evasion };
  if (result === null || result === "skip" || state.gone) return out;
  if (amounts) {
    const dealt = rowDamage(amounts, result, { onPass: page.test.kind === "none" ? "none" : page.outcome.onPass, dexSave: evasionApplies, row: { defenses, qualifiedOn, evasion, effects } });
    out.amount = dealt.amount;
    out.computed = dealt.amount;
    out.words = amounts.length > 0 ? damageWords(amounts, dealt) : "";
  }
  if (state.amount !== undefined) {
    out.amount = state.amount;
    out.words = `${state.amount}, typed`;
  }
  if (result === "fail" && state.conditions !== "off") {
    for (const key of page.outcome.conditions as ConditionKey[]) {
      const skip = state.conditions === "on" ? null : conditionSkip(key, { defenses, qualifiedOn, effects, hp: hpOf(dice, row.target) }, out.amount);
      if (skip) {
        out.skips.push(skip);
        continue;
      }
      const duration = durationFor(page, row.target);
      const save = saveOf(page);
      out.conditions.push({ key, ...(duration ? { duration } : {}), ...(save ? { save } : {}) });
    }
  }
  return out;
}

/**
 * Whether the page's whole outcome fits one `actor.outcome` (5.5), sized
 * as Apply would send it: each row's conditions with their end and the
 * save that ends them, at the widest DC, so a plan that passes here never
 * meets the op's bound after the rolls and requests went. Null when it fits.
 */
export function pageBound(page: Page, rows: readonly RowBase[]): string | null {
  const ends = page.outcome.saveEnds;
  const save = ends ? { ability: ends.ability, dc: 50, ...(page.spell ? { spell: true as const } : {}) } : undefined;
  const conditions = page.outcome.conditions as ConditionKey[];
  return worstCase(
    rows.map((r) => r.target),
    (target) => {
      const duration = durationFor(page, target);
      return conditions.map((key) => ({ key, ...(duration ? { duration } : {}), ...(save ? { save } : {}) }));
    },
    page.fill?.name,
  );
}

/** Why Apply waits, in its words, or null when it may go (5.5). */
export function applyWaits(page: Page, dice: DiceView, amounts: PartAmount[] | null): string | null {
  if (page.apply === "sending") return "Applying…";
  // A DM's tap whose row has its answer, the player's or its own landed meanwhile, holds nothing up.
  const tapWaits = page.dmRolls.some((r) => r.state === "sending" && !page.states[r.holder]?.answer);
  if (page.rolls.some((r) => r.state === "sending") || tapWaits) return "Rolling…";
  if (page.damage?.state === "sending") return "Rolling…";
  if (amounts === null) return "Type the damage, or roll it";
  if (page.outcome.saveEnds && page.outcome.conditions.length > 0 && saveEndsDc(page) === null) return "Give the save that ends it a DC";
  const live = page.rows.filter((r) => !stateOf(page, r).gone);
  const waiting = live.filter((r) => rowOutcome(page, r, dice, amounts).result === null).length;
  if (waiting > 0) return `${waiting} still waiting: mark them or wait`;
  return null;
}

/** "Apply: 5 take damage, 3 Frightened". */
export function applyWords(outcomes: readonly RowOutcome[], conditions: readonly string[]): string {
  const hurt = outcomes.filter((o) => o.amount > 0).length;
  const parts: string[] = [];
  if (hurt > 0) parts.push(`${hurt} take${hurt === 1 ? "s" : ""} damage`);
  for (const key of conditions) {
    const n = outcomes.filter((o) => o.conditions.some((c) => c.key === key)).length;
    if (n > 0) parts.push(`${n} ${key.charAt(0).toUpperCase()}${key.slice(1)}`);
  }
  const resisted = outcomes.filter((o) => o.resisted).length;
  if (resisted > 0) parts.push(`${resisted} use Legendary Resistance`);
  return parts.length > 0 ? `Apply: ${parts.join(", ")}` : "Nothing to apply";
}

/**
 * The plan (5.5): each creature once, only those still present, never a
 * skipped row, with its amount, its conditions with ids from `newId`, and
 * each Legendary Resistance used. Null when nothing would change.
 */
export function buildPlan(page: Page, dice: DiceView, amounts: PartAmount[] | null, ids: { plan: string; newId: () => string }): OpOf<"actor.outcome"> | null {
  const rows: PlanRow[] = [];
  const seen = new Set<string>();
  for (const row of page.rows) {
    if (seen.has(row.holder)) continue;
    seen.add(row.holder);
    const state = stateOf(page, row);
    if (state.gone || state.mark === "skip") continue;
    const outcome = rowOutcome(page, row, dice, amounts);
    if (outcome.result === null || outcome.result === "skip") continue;
    rows.push({ target: row.target, amount: outcome.amount, conditions: outcome.conditions, resist: outcome.resisted });
  }
  const targets = planTargets(rows, ids.newId);
  if (targets.length === 0) return null;
  return { t: "actor.outcome", plan: ids.plan, ...(page.fill ? { label: page.fill.name } : {}), targets };
}
