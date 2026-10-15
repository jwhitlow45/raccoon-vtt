import type { Character, PartyGroup } from "#shared/model.ts";
import { DIFFICULTIES, MAX_LEVEL, MIN_LEVEL, XP_BUDGET, type Difficulty } from "#shared/srd/xp-budget.ts";

/**
 * The 2024 encounter budget (features section 10), from SRD 5.2.1's
 * "Combat Encounter Difficulty": each character adds its level's row of the
 * XP Budget per Character table, and the encounter spends its monsters' XP
 * against that. Plain functions, so the numbers are tested without a DOM.
 *
 * The SRD multiplies one level's number by the party's size. A party of
 * mixed levels adds each character's own number, which is the same sum when
 * they share a level and needs no "party level" the SRD does not define.
 */

export type Party = {
  groups: PartyGroup[];
  /** Characters without a level, which the budget cannot count until one is set. */
  unleveled: string[];
};

/**
 * The party the budget is for by default: the room's player characters,
 * one group per level, lowest first. A character without a level is named
 * rather than guessed at, so the DM sets it or edits the party.
 */
export function partyFromCharacters(characters: Iterable<Pick<Character, "name" | "level">>): Party {
  const counts = new Map<number, number>();
  const unleveled: string[] = [];
  for (const c of characters) {
    if (c.level === undefined) unleveled.push(c.name);
    else counts.set(c.level, (counts.get(c.level) ?? 0) + 1);
  }
  const groups = [...counts].sort(([a], [b]) => a - b).map(([level, count]) => ({ count, level }));
  return { groups, unleveled: unleveled.sort((a, b) => a.localeCompare(b)) };
}

export function partySize(groups: readonly PartyGroup[]): number {
  return groups.reduce((n, g) => n + g.count, 0);
}

export type Budgets = Record<Difficulty, number>;

/** Each difficulty's budget for the whole party. */
export function partyBudgets(groups: readonly PartyGroup[]): Budgets {
  const out: Budgets = { low: 0, moderate: 0, high: 0 };
  for (const g of groups) {
    const row = XP_BUDGET[g.level - 1];
    if (!row || g.level < MIN_LEVEL || g.level > MAX_LEVEL) continue;
    for (const d of DIFFICULTIES) out[d] += row[d] * g.count;
  }
  return out;
}

/** One kind of monster in an encounter: how many, and the XP its stat block gives each, or null while unknown. */
export type MonsterXp = { count: number; xp: number | null };

/**
 * The monsters' XP, as the SRD spends it: every creature's XP from its stat
 * block, added up. `unknown` counts the creatures whose stat block is not at
 * hand (the SRD list still loading, or a room monster deleted since), so the
 * total never quietly leaves them out.
 */
export function encounterXp(monsters: readonly MonsterXp[]): { total: number; unknown: number } {
  let total = 0;
  let unknown = 0;
  for (const m of monsters) {
    if (m.xp === null) unknown += m.count;
    else total += m.xp * m.count;
  }
  return { total, unknown };
}

/**
 * The lowest difficulty whose budget the encounter's XP stays within, which
 * is what the SRD's "spend as much of your budget as you can without going
 * over" builds. Over the High budget the SRD gives no name, so neither does
 * this. Null while there is no party to budget for.
 */
export function difficultyOf(total: number, budgets: Budgets): Difficulty | "over" | null {
  if (budgets.high <= 0) return null;
  for (const d of DIFFICULTIES) if (total <= budgets[d]) return d;
  return "over";
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { low: "Low", moderate: "Moderate", high: "High" };

/** "1,250 XP": the SRD prints thousands with a comma. */
export function xpText(xp: number): string {
  return `${xp.toLocaleString("en-US")} XP`;
}
