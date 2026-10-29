import type { ConditionKey, Effect, RoomState } from "#shared/model.ts";
import { playersToken } from "#shared/project.ts";
import { MAX_DAMAGE_PARTS, type ActorTarget, type DurationInput, type OpOf, type OutcomeDamage } from "#shared/protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "#shared/rules/damage.ts";
import { formatFormula, parseFormula } from "#shared/dice/formula.ts";
import { effectName } from "#shared/logText.ts";
import { creatureRolls, type DiceView } from "../creature.ts";
import type { Page } from "./chain.ts";
import { stateOf } from "./chain.ts";
import { conditionSkip, damageWords, dealtTypes, parseParts, partAmounts, planTargets, rowDamage, worstCase, type OutcomeCondition, type PartAmount, type PlanRow } from "./outcome.ts";
import { rowResult, type Mark, type RowBase } from "./rows.ts";
import { parseDamageOverride } from "./damageInput.ts";

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
  /** What the amount alone does not say: "Immune to fire: 9 radiant", "Typed 5, worked out 12", else "". */
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
  /**
   * The damage types its amount carries (outcome.ts dealtTypes), for the
   * Regeneration note (docs/design-v1-combat-controls.md 3.4): none when it
   * takes nothing. A plain override keeps the worked-out parts' types,
   * and a typed override supplies its own.
   */
  types: DamageType[];
  /** Incoming parts and the DM's choices, for authoritative application. */
  damage?: OutcomeDamage;
  error?: string;
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
export function amountsOf(page: Pick<Page, "outcome" | "damage">, fillType?: DamageType): PartAmount[] | null {
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
  const out: RowOutcome = { result, resisted, amount: 0, computed: 0, words: "", conditions: [], skips: [], legendaryLeft, qualified, evasionApplies, evasion, types: [] };
  if (result === null || result === "skip" || state.gone) return out;
  let types: DamageType[] = [];
  if (amounts) {
    const incoming = incomingDamage(page, state, amounts, result, evasion);
    const dealt = rowDamage(incoming.parts, result, { onPass: page.test.kind === "none" ? "none" : page.outcome.onPass, dexSave: evasionApplies, row: { defenses, qualifiedOn, evasion, effects } });
    out.amount = dealt.amount;
    out.computed = dealt.amount;
    types = dealtTypes(amounts, dealt.byPart);
    // The amount shows on the row's first line, so words come only when a defense or Evasion changed it.
    out.words = amounts.length > 0 && dealt.notes.length > 0 ? damageWords(amounts, dealt) : "";
    if (amounts.length > 0) out.damage = incoming;
  }
  if (state.amount !== undefined) {
    delete out.damage;
    const parsed = parseDamageOverride(state.amount);
    if (!parsed.ok) {
      out.error = parsed.error;
      out.amount = 0;
      out.words = parsed.error;
    } else if (parsed.parts) {
      const dealt = rowDamage(parsed.parts, "fail", { onPass: "none", dexSave: false, row: { defenses, qualifiedOn, evasion: false, effects } });
      out.amount = dealt.amount;
      out.words = `Typed ${state.amount}: ${damageWords(parsed.parts, dealt)}`;
      types = dealtTypes(parsed.parts, dealt.byPart);
      out.damage = { parts: parsed.parts, ...(state.qualifiedOn?.length ? { qualifiedOn: state.qualifiedOn } : {}) };
    } else {
      out.amount = parsed.amount;
      out.words = amounts ? `Typed ${parsed.amount}, worked out ${out.computed}` : `Typed ${parsed.amount}`;
    }
  }
  // Only parts that deal damage contribute to the Regeneration note.
  out.types = out.amount > 0 ? types : [];
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

function incomingDamage(page: Page, state: ReturnType<typeof stateOf>, parts: PartAmount[], result: "pass" | "fail", evasion: boolean): OutcomeDamage {
  return {
    parts: parts.map((part) => ({ ...part, amount: Math.max(0, part.amount) })),
    save: { result, onPass: page.test.kind === "none" ? "none" : page.outcome.onPass, dex: page.test.kind === "save" && page.test.ability === "dex", evasion },
    ...(state.qualifiedOn?.length ? { qualifiedOn: state.qualifiedOn } : {}),
  };
}

/** The bound and the sent plan include the same ask or trap that Apply settles. */
function closingOf(page: Page): Pick<OpOf<"actor.outcome">, "cast" | "trap"> {
  if (page.cast) return { cast: page.cast.ask.id };
  return page.source.kind === "trap" ? { trap: { trapId: page.source.trapId, due: page.source.due } } : {};
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
  // Every type the damage field names, which each row's damage may carry.
  const parsed = page.outcome.damage.trim() ? parseParts(page.outcome.damage, page.fill?.damageType) : null;
  if (parsed?.ok && parsed.parts.length > MAX_DAMAGE_PARTS) return `Use at most ${MAX_DAMAGE_PARTS} damage parts.`;
  if (parsed?.ok && parsed.parts.reduce((sum, part) => sum + ("amount" in part ? part.amount : 0), 0) > 100_000) return "That number is too large.";
  for (const row of rows) {
    const state = stateOf(page, row);
    if (state.gone || state.mark === "skip" || state.amount === undefined) continue;
    const override = parseDamageOverride(state.amount);
    if (!override.ok) return `${row.name}: ${override.error}`;
  }
  const named = new Set(parsed?.ok ? parsed.parts.flatMap((p) => (p.type ? [p.type] : [])) : []);
  const types = DAMAGE_TYPES.filter((t) => named.has(t));
  return worstCase(
    rows.map((r) => r.target),
    (target) => {
      const duration = durationFor(page, target);
      return conditions.map((key) => ({ key, ...(duration ? { duration } : {}), ...(save ? { save } : {}) }));
    },
    page.fill?.name,
    {
      ...(types.length > 0 ? { types } : {}), quiet: page.secret,
      ...closingOf(page),
      damage: (target) => {
        const row = rows.find((r) => r.target === target)!;
        const state = stateOf(page, row);
        if (state.amount !== undefined) {
          const override = parseDamageOverride(state.amount);
          return override.ok && override.parts ? { parts: override.parts, ...(state.qualifiedOn?.length ? { qualifiedOn: state.qualifiedOn } : {}) } : undefined;
        }
        if (!parsed?.ok) return undefined;
        // A die total can need six digits. The bound measures bytes, before that total is known.
        return incomingDamage(page, state, parsed.parts.map((p) => ({ amount: "amount" in p ? p.amount : 100_000, ...(p.type ? { type: p.type } : {}) })), "fail", false);
      },
    },
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
  if (amounts.length > MAX_DAMAGE_PARTS) return `Use at most ${MAX_DAMAGE_PARTS} damage parts.`;
  if (amounts.reduce((sum, part) => sum + Math.max(0, part.amount), 0) > 100_000) return "That number is too large.";
  if (page.outcome.saveEnds && page.outcome.conditions.length > 0 && saveEndsDc(page) === null) return "Give the save that ends it a DC";
  const live = page.rows.filter((r) => !stateOf(page, r).gone);
  for (const row of live) {
    const error = rowOutcome(page, row, dice, amounts).error;
    if (error) return `${row.name}: ${error}`;
  }
  const waiting = live.filter((r) => rowOutcome(page, r, dice, amounts).result === null).length;
  if (waiting > 0) return `${waiting} still waiting: mark them or wait`;
  return null;
}

/**
 * The Dice panel's row for the open group save, after its title (5.1):
 * "set up", "2 waiting", "all answered" while its damage is still to be
 * typed or rolled, so it never says ready while Apply waits, "ready to
 * apply", and "applied".
 */
export function openSaveState(page: Pick<Page, "phase" | "outcome" | "damage" | "fill">, waiting: number): string {
  if (page.phase === "applied") return "applied";
  if (page.phase === "setup") return "set up";
  if (waiting > 0) return `${waiting} waiting`;
  return amountsOf(page, page.fill?.damageType) === null ? "all answered" : "ready to apply";
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
  return parts.length > 0 ? `Apply: ${parts.join(", ")}` : NOTHING_TO_APPLY;
}

/** Apply's words when nothing would change, which a page holding a player's ask reads as Close the ask, and a trap's as SETTLE_WORDS. */
export const NOTHING_TO_APPLY = "Nothing to apply";

/** Apply's words on a trap's page where it changes no creature, as when everyone passes against a net: it still settles the springing. */
export const SETTLE_WORDS = "Settle: it changes no one";

/**
 * The plan (5.5): each creature once, only those still present, never a
 * skipped row, with its amount, its conditions with ids from `newId`, and
 * each Legendary Resistance used. Null when nothing would change, but for
 * a trap's springing, which still has to be settled: its plan names no
 * creature (docs/design-v1-traps.md 4.4).
 */
export function buildPlan(page: Page, dice: DiceView, amounts: PartAmount[] | null, ids: { plan: string; newId: () => string }): OpOf<"actor.outcome"> | null {
  if (amounts && (amounts.length > MAX_DAMAGE_PARTS || amounts.reduce((sum, part) => sum + Math.max(0, part.amount), 0) > 100_000)) return null;
  if (pageBound(page, page.rows) !== null) return null;
  const rows: PlanRow[] = [];
  const seen = new Set<string>();
  for (const row of page.rows) {
    if (seen.has(row.holder)) continue;
    seen.add(row.holder);
    const state = stateOf(page, row);
    if (state.gone || state.mark === "skip") continue;
    const outcome = rowOutcome(page, row, dice, amounts);
    if (outcome.error) return null;
    if (outcome.result === null || outcome.result === "skip") continue;
    rows.push({ target: row.target, amount: outcome.amount, conditions: outcome.conditions, resist: outcome.resisted, types: outcome.types, ...(outcome.damage ? { damage: outcome.damage } : {}) });
  }
  const targets = planTargets(rows, ids.newId);
  // The outcome closes the player's ask it answers in the same op (docs/design-v1-player-save-spell.md 3.3).
  // A trap's springing is settled by the outcome that applies it, in the same op (docs/design-v1-traps.md 4.4).
  const closing = closingOf(page);
  if (targets.length === 0 && closing.trap === undefined) return null;
  // Saves rolled in secret keep a Legendary Resistance's use line from players (docs/design-v1-combat-controls.md 8).
  return { t: "actor.outcome", plan: ids.plan, ...(page.fill ? { label: page.fill.name } : {}), ...closing, targets, ...(page.secret ? { quiet: true as const } : {}) };
}

// ------------------------------------------------------------ a row in words (5.8)

export type RowWords = {
  /** How its total came: "Asked: typed 8", "Rolled 14 (1d20+2: 12)", "Fails: Stunned", or null before any. */
  how: string | null;
  /** Its pass or fail where the DM did not mark it, with why: "Fail vs DC 13", "Pass: Legendary Resistance". */
  verdict: string | null;
  /** What the outcome does that the amount does not say. */
  notes: string[];
};

function rolledText(total: number, dice: { formula: string; faces: number[]; mode?: import("#shared/dice/formula.ts").AdvantageMode; cancelled?: true }): string {
  const parsed = parseFormula(dice.formula);
  const formula = parsed.ok ? formatFormula(parsed.formula, dice.mode) : dice.formula;
  return `${total} (${formula}: ${dice.faces.join(", ")})${dice.cancelled ? ", normal: Advantage and Disadvantage cancelled" : ""}`;
}

/**
 * A row's details in words (W7B-P-11, W7B-P-12): how its total came, its
 * computed pass or fail apart from the DM's own mark, which the Fail, Pass
 * and Skip control alone shows, so a later DC change re-judges only what
 * reads as computed, and what the outcome does beyond its amount.
 */
export function rowWords(page: Page, row: RowBase, outcome: RowOutcome): RowWords {
  const s = stateOf(page, row);
  const a = s.answer;
  const against = s.asked?.dc !== undefined && page.dc !== null && s.asked.dc !== page.dc ? `, asked against DC ${s.asked.dc}` : "";
  let how: string | null = null;
  if (s.asked || a) {
    if (!a) how = `Asked, waiting${against}`;
    else if (a.dice) how = `Asked: rolled ${rolledText(a.total ?? a.dice.total, a.dice)}${against}`;
    else if (a.total !== undefined) how = `Asked: typed ${a.total}${against}`;
    else if (a.noRoll) how = "Asked: failed without rolling";
    else if (a.mark) how = "Asked: marked on the request";
    else how = `Asked${against}`;
  } else if (s.way === "fails" && row.fails) how = `Fails: ${effectName(row.fails)}`;
  else if (s.rolled) how = `Rolled ${rolledText(s.rolled.total, s.rolled)}`;
  else if (s.typed !== undefined) how = `Typed ${s.typed}`;

  let verdict: string | null = null;
  const r = outcome.result;
  if (!s.mark && (r === "fail" || r === "pass") && page.test.kind !== "none") {
    const word = r === "fail" ? "Fail" : "Pass";
    const fails = a?.dice?.fails ?? s.rolled?.fails;
    if (outcome.resisted) verdict = "Pass: Legendary Resistance";
    else if (a?.mark) verdict = `${word}: the DM's mark on the request`;
    else if (fails) verdict = `Fail: ${effectName(fails)}`;
    else if (a?.noRoll) verdict = "Fail";
    else if (s.way === "fails" && row.fails && !a) verdict = "Fail";
    else verdict = page.dc !== null ? `${word} vs DC ${page.dc}` : word;
  }

  const notes: string[] = [];
  if (outcome.words) notes.push(outcome.words);
  notes.push(...outcome.skips);
  if (outcome.conditions.length > 0) notes.push(`Gains ${outcome.conditions.map((c) => effectName(c.key)).join(" and ")}`);
  return { how, verdict, notes };
}

/**
 * Who reads the damage line: the switch hides a monster's damage, and a
 * spell or action of a creature a player plays rolls in the open, as that
 * player's own damage roll would (W7B-P-20).
 */
export function damageTo(page: Page, view: Pick<RoomState, "tokens" | "members" | "characters">): "all" | "dm" {
  const caster = page.fill?.caster ? view.tokens[page.fill.caster] : undefined;
  if (caster && playersToken(view, caster)) return "all";
  return page.secret ? "dm" : "all";
}
