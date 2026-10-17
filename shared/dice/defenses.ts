import { CONDITION_KEYS, type ConditionKey, type Effect } from "../model.ts";
import { DAMAGE_TYPES, type DamageType } from "../rules/damage.ts";
import { incapacitated } from "../rules/rollReminders.ts";
import type { StatBlockMonster } from "../srd/monsters.ts";

/**
 * A creature's damage and condition defenses for the rules
 * (docs/design-v1-roll-options.md 3.3), with their qualifiers kept: a
 * resistance "from nonmagical attacks" or an immunity "except from its
 * vampire master" is not one the app can apply alone. The monster filters
 * (client/features/tokens/monsterFilters.ts monsterFacts) drop qualifiers on
 * purpose, since a filter only asks whether the block names the type, so
 * this reader is its own.
 */
export type Defense = {
  kind: "immune" | "resist" | "vulnerable";
  of: DamageType | "all" | ConditionKey;
  /** The words the clause goes on with past its types, as printed: "from nonmagical attacks". */
  qualifier?: string;
  /** Where it comes from, as the row names it: "Stat block", "Petrified", "Raging". */
  source: string;
};

const LINES: readonly { label: string; kind: Defense["kind"] }[] = [
  { label: "Immunities", kind: "immune" },
  { label: "Resistances", kind: "resist" },
  { label: "Vulnerabilities", kind: "vulnerable" },
];

const DAMAGE_WORDS = new Set<string>(DAMAGE_TYPES);
const CONDITION_WORDS = new Set<string>(CONDITION_KEYS);

/** A labeled line of the Markdown block without its label and escapes, or "". */
function statLine(statBlock: string, label: string): string {
  const line = new RegExp(`^\\*\\*${label}\\*\\* (.*)$`, "m").exec(statBlock)?.[1] ?? "";
  return line.replace(/\\([*_`\\])/g, "$1");
}

/**
 * One clause's defenses: the types it lists from its start, joined by ","
 * "and" or "or", then whatever it goes on with as the qualifier of every
 * type in it. So 2014's "Bludgeoning, Piercing, and Slashing from
 * Nonmagical Attacks" is three qualified resistances. A clause that starts
 * with no type, "Damage type chosen for the Draconic Origin trait", names
 * none the app knows.
 */
function clauseDefenses(clause: string, kind: Defense["kind"]): Defense[] {
  const types: (DamageType | ConditionKey)[] = [];
  let rest = clause.trim();
  for (;;) {
    const m = /^(?:(?:,\s*)?(?:and|or)\s+|,\s*)?([A-Za-z]+)\b/.exec(rest);
    const word = m?.[1]?.toLowerCase();
    if (!m || !word) break;
    const type = DAMAGE_WORDS.has(word) ? (word as DamageType) : kind === "immune" && CONDITION_WORDS.has(word) ? (word as ConditionKey) : null;
    if (type === null) break;
    types.push(type);
    rest = rest.slice(m[0].length);
  }
  // "Piercing damage from weapons..." keeps its qualifier without the word damage.
  const qualifier = rest
    .replace(/^\s*damage\b/i, "")
    .replace(/^[\s,]+/, "")
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .trim();
  return types.map((of) => (qualifier ? { kind, of, qualifier, source: "Stat block" } : { kind, of, source: "Stat block" }));
}

const read = new WeakMap<StatBlockMonster, Defense[]>();

/** The block's Immunities, Resistances and Vulnerabilities, each line split at ";" into clauses, read once per view object. */
export function blockDefenses(view: StatBlockMonster): Defense[] {
  const cached = read.get(view);
  if (cached) return cached;
  const out: Defense[] = [];
  for (const { label, kind } of LINES) {
    for (const clause of statLine(view.statBlock, label).split(";")) out.push(...clauseDefenses(clause, kind));
  }
  read.set(view, out);
  return out;
}

/**
 * The defenses a condition or status gives, each on the SRD 5.2.1 words in
 * shared/srd/rules-text.json it rests on (the test checks each quote is
 * there, as the roll reminders do).
 */
export const EFFECT_DEFENSES: readonly {
  key: "petrified" | "raging";
  source: "conditions" | "statuses";
  name: string;
  quote: string;
  gives: readonly Pick<Defense, "kind" | "of">[];
}[] = [
  { key: "petrified", source: "conditions", name: "Petrified", quote: "You have Resistance to all damage.", gives: [{ kind: "resist", of: "all" }] },
  { key: "petrified", source: "conditions", name: "Petrified", quote: "You have Immunity to the Poisoned condition.", gives: [{ kind: "immune", of: "poisoned" }] },
  {
    key: "raging",
    source: "statuses",
    name: "Raging",
    quote: "You have Resistance to Bludgeoning, Piercing, and Slashing damage.",
    gives: [
      { kind: "resist", of: "bludgeoning" },
      { kind: "resist", of: "piercing" },
      { kind: "resist", of: "slashing" },
    ],
  },
];

/**
 * What the creature's effects give: Petrified resists all damage and is
 * immune to Poisoned, and Raging resists Bludgeoning, Piercing and Slashing
 * while the creature is not incapacitated, since the SRD ends Rage early on
 * the Incapacitated condition and the app keeps the status until someone
 * removes it.
 */
export function effectDefenses(effects: readonly Pick<Effect, "key">[]): Defense[] {
  const out: Defense[] = [];
  const raging = !incapacitated(effects);
  for (const rule of EFFECT_DEFENSES) {
    if (!effects.some((e) => e.key === rule.key)) continue;
    if (rule.key === "raging" && !raging) continue;
    for (const give of rule.gives) out.push({ ...give, source: rule.name });
  }
  return out;
}
