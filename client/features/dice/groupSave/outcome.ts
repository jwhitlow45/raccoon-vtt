import type { Defense } from "#shared/dice/defenses.ts";
import { formatFormula, parseFormula } from "#shared/dice/formula.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import type { ConditionKey, DiceRoll, Effect } from "#shared/model.ts";
import { hitOf } from "#shared/dice/roll.ts";
import { OUTCOME_TOO_BIG, type ActorTarget, type DurationInput, type EffectInput, type OpOf } from "#shared/protocol.ts";
import { DAMAGE_TYPES, damageTypeName, type DamageType } from "#shared/rules/damage.ts";
import { incapacitated } from "#shared/rules/rollReminders.ts";
import { effectName } from "#shared/logText.ts";

/**
 * A group save's outcome (docs/design-v1-roll-options.md 5.4 and 5.5), as
 * plain functions for node --test: the damage field's typed parts, what
 * each row takes by its result, its Evasion and its defenses part by part,
 * the conditions a failed row gains, and the one `actor.outcome` plan, with
 * its worst case checked against the op's bounds before any roll.
 */

/** One damage part of the outcome: rolled dice with their type, or a number typed. */
export type OutcomePart = { formula: string; type?: DamageType } | { amount: number; type?: DamageType };

const TYPE_WORDS = new Set<string>(DAMAGE_TYPES);

/**
 * The damage field: "8d6 fire", "5d6 fire + 5d6 radiant", "28 fire + 14
 * radiant", or "28", which takes the fill's type. Null and the words when
 * it does not read. A part is dice and numbers, then its type word.
 */
export function parseParts(text: string, fillType?: DamageType): { ok: true; parts: OutcomePart[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Type the damage, or roll it." };
  // Pieces between "+" join until one ends with its type word, so "8d6+3 fire" is one part and "5d6 fire + 5d6 radiant" two.
  const groups: string[] = [];
  let current: string[] = [];
  for (const piece of trimmed.split(/\s*\+\s*/)) {
    current.push(piece);
    if (/[a-z]$/i.test(piece)) {
      groups.push(current.join("+"));
      current = [];
    }
  }
  if (current.length > 0) groups.push(current.join("+"));
  const parts: OutcomePart[] = [];
  for (const group of groups) {
    const m = /^(.*?)\s*([a-z]{3,})?$/i.exec(group.trim());
    const body = (m?.[1] ?? "").replace(/\s+/g, "");
    const word = m?.[2]?.toLowerCase();
    if (word !== undefined && !TYPE_WORDS.has(word)) return { ok: false, error: `"${word}" is not a damage type. Try 8d6 Fire or 28 Fire.` };
    const type = (word as DamageType | undefined) ?? fillType;
    if (/^\d+$/.test(body)) {
      const amount = Number(body);
      if (amount < 1 || amount > 100_000) return { ok: false, error: "Damage is 1 to 100,000." };
      parts.push(type ? { amount, type } : { amount });
      continue;
    }
    const parsed = parseFormula(body);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const formula = formatFormula(parsed.formula);
    parts.push(type ? { formula, type } : { formula });
  }
  return { ok: true, parts };
}

/** The field's text for parts, as the fill writes it: "8d6 Fire + 5d6 Radiant". */
export function partsText(parts: readonly OutcomePart[]): string {
  return parts.map((p) => `${"formula" in p ? p.formula : p.amount}${p.type ? ` ${damageTypeName(p.type)}` : ""}`).join(" + ");
}

/** Whether every part is a number, so Apply needs no roll. */
export function typedOnly(parts: readonly OutcomePart[]): boolean {
  return parts.every((p) => "amount" in p);
}

/** A part's amount once known: typed, or rolled in the damage line (`rolled`, by the part's index). */
export type PartAmount = { amount: number; type?: DamageType };

export function partAmounts(parts: readonly OutcomePart[], rolled: readonly (number | undefined)[]): PartAmount[] | null {
  const out: PartAmount[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const amount = "amount" in part ? part.amount : rolled[i];
    if (amount === undefined) return null;
    out.push(part.type ? { amount, type: part.type } : { amount });
  }
  return out;
}

export type RowDefenses = {
  defenses: readonly Defense[];
  /** Qualified defenses the DM switched on for this row, by `defenseKey`. */
  qualifiedOn: ReadonlySet<string>;
  evasion: boolean;
  effects: readonly Pick<Effect, "key">[];
};

export function defenseKey(d: Defense): string {
  return `${d.kind}:${d.of}:${d.qualifier ?? ""}:${d.source}`;
}

function applies(d: Defense, on: ReadonlySet<string>): boolean {
  return d.qualifier === undefined || on.has(defenseKey(d));
}

/**
 * What one row takes (5.4): each part halved on a pass or dropped,
 * Evasion in its place where it applies (a Dexterity save that halves, not
 * while incapacitated), then its type's immunity, resistance and
 * vulnerability in the SRD's order, each part rounded down on its own, then
 * the sum. `notes` say what changed it: "Immune to fire", "Evasion".
 */
export function rowDamage(parts: readonly PartAmount[], result: "pass" | "fail", opts: { onPass: "half" | "none"; dexSave: boolean; row: RowDefenses }): { amount: number; notes: string[]; byPart: number[] } {
  const notes: string[] = [];
  const evades = opts.row.evasion && opts.dexSave && opts.onPass === "half" && !incapacitated(opts.row.effects);
  if (evades) notes.push("Evasion");
  const byPart = parts.map((part) => {
    let n = part.amount;
    if (evades) n = result === "pass" ? 0 : Math.floor(n / 2);
    else if (result === "pass") n = opts.onPass === "half" ? Math.floor(n / 2) : 0;
    if (n === 0) return 0;
    const of = (d: Defense) => d.of === "all" || (part.type !== undefined && d.of === part.type);
    const active = opts.row.defenses.filter((d) => of(d) && applies(d, opts.row.qualifiedOn) && TYPE_OR_ALL(d.of));
    if (active.some((d) => d.kind === "immune")) {
      note(notes, `Immune to ${part.type ? damageTypeName(part.type) : "it"}`);
      return 0;
    }
    if (active.some((d) => d.kind === "resist")) {
      n = Math.floor(n / 2);
      note(notes, `Resists ${active.find((d) => d.kind === "resist")!.of === "all" ? "all damage" : damageTypeName(part.type ?? "")}`);
    }
    if (active.some((d) => d.kind === "vulnerable")) {
      n = n * 2;
      note(notes, `Vulnerable to ${damageTypeName(part.type ?? "")}`);
    }
    return n;
  });
  return { amount: byPart.reduce((a, b) => a + b, 0), notes, byPart };
}

function TYPE_OR_ALL(of: Defense["of"]): boolean {
  return of === "all" || TYPE_WORDS.has(of);
}

function note(notes: string[], text: string): void {
  if (!notes.includes(text)) notes.push(text);
}

/**
 * The damage types a row actually takes (docs/design-v1-combat-controls.md
 * 3.4), for the Regeneration note: each type of a part still above 0 once
 * its save, immunity, resistance, vulnerability and rounding are applied,
 * once, in the rules' order. A part that comes to 0 adds nothing, and an
 * untyped part adds no type.
 */
export function dealtTypes(parts: readonly PartAmount[], byPart: readonly number[]): DamageType[] {
  const dealt = new Set(parts.flatMap((p, i) => (p.type !== undefined && (byPart[i] ?? 0) > 0 ? [p.type] : [])));
  return DAMAGE_TYPES.filter((t) => dealt.has(t));
}

/** A row's damage in words: "Immune to Fire: 9 Radiant", "17". */
export function damageWords(parts: readonly PartAmount[], dealt: { amount: number; notes: string[]; byPart: number[] }): string {
  if (dealt.notes.length === 0 || parts.length < 2) return dealt.notes.length > 0 ? `${dealt.notes.join(". ")}: ${dealt.amount}` : `${dealt.amount}`;
  const kept = parts.map((p, i) => (dealt.byPart[i]! > 0 ? `${dealt.byPart[i]} ${p.type ? damageTypeName(p.type) : ""}`.trim() : null)).filter(Boolean);
  return `${dealt.notes.join(". ")}: ${kept.join(" + ") || "0"}`;
}

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
