import type { Defense } from "../dice/defenses.ts";
import { formatFormula, parseFormula } from "../dice/formula.ts";
import type { Effect } from "../model.ts";
import { DAMAGE_TYPES, damageTypeName, type DamageType } from "./damage.ts";
import { incapacitated } from "./rollReminders.ts";

/** The damage parser and defense calculation shared by saves, HP previews and authoritative HP changes. */

/** One damage part of the outcome: rolled dice with their type, or a number typed. */
export type OutcomePart = { formula: string; type?: DamageType } | { amount: number; type?: DamageType };

/** Negative rolled parts count as zero damage, never as a subtraction from another part. Formulas stay unrolled. */
export function nonnegativeDamageParts<T extends OutcomePart>(parts: readonly T[]): T[] {
  return parts.map((part) => "amount" in part ? { ...part, amount: Math.max(0, part.amount) } : part);
}

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

export function defenseApplies(d: Defense, on: ReadonlySet<string>): boolean {
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
    const active = opts.row.defenses.filter((d) => of(d) && defenseApplies(d, opts.row.qualifiedOn) && TYPE_OR_ALL(d.of));
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

