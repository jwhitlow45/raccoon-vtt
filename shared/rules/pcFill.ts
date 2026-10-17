import type { AbilityKey, Actor, PcRoll, PcStats } from "../model.ts";
import { MAX_PC_ROLLS } from "../protocol.ts";

/**
 * What a fill read (docs/design-v1-pc-stats.md 6.1): pasted text through
 * the stat block reader, or a D&D Beyond character. One shape for both, so
 * one review step says what it read, what it replaces and what else it
 * sets, and nothing is saved until the player's Save.
 *
 * A part of `stats` left out is one the source did not give, and the
 * draft keeps it. For the flags, `false` or `null` is a part read as off.
 */
export type PcFillStats = {
  abilities?: PcStats["abilities"];
  saves?: PcStats["saves"];
  skills?: PcStats["skills"];
  adjust?: PcStats["adjust"];
  defenses?: PcStats["defenses"];
  spellAbility?: AbilityKey | null;
  jack?: boolean;
  alert?: boolean;
  evasion?: boolean;
  critOn?: 19 | 18 | null;
  rolls: PcRoll[];
};

export type PcFill = {
  source: "paste" | "ddb";
  stats: PcFillStats;
  level?: number;
  name?: string;
  actor: { ac?: number; hpMax?: number; speeds?: Actor["speeds"]; senses?: string; sheetUrl?: string };
  /** One line each, for "Check these". */
  warnings: string[];
};

/** What a fill does to the block, for the review's line: the parts it replaces and what becomes of the rolls. */
export type FillMerge = {
  stats: PcStats;
  /** Rolls a D&D Beyond fill put in place of the last import's, or pasted rolls added. */
  added: number;
  /** The last import's rolls a D&D Beyond fill takes away. */
  replaced: number;
  /** The player's own rolls, which a fill always keeps. */
  kept: number;
  /** Rolls past the 40 a block holds, left out. */
  dropped: number;
};

function flag(next: PcStats, key: "jack" | "alert" | "evasion", value: boolean | undefined): void {
  if (value === undefined) return;
  if (value) next[key] = true;
  else delete next[key];
}

/**
 * The block with a fill's parts in place (6.1): every part it read
 * replaced whole. Pasted text adds its rolls beside the ones there. A D&D
 * Beyond import replaces the rolls the last import made and keeps the
 * player's own, which a roll edited after an import has become. Either way
 * the player's rolls come first, and a block holds at most 40.
 */
export function mergeFill(stats: PcStats, fill: PcFill): FillMerge {
  const next: PcStats = { ...stats };
  const f = fill.stats;
  if (f.abilities) next.abilities = f.abilities;
  if (f.saves) next.saves = f.saves;
  if (f.skills) next.skills = f.skills;
  if (f.adjust) next.adjust = f.adjust;
  if (f.defenses) next.defenses = f.defenses;
  flag(next, "jack", f.jack);
  flag(next, "alert", f.alert);
  flag(next, "evasion", f.evasion);
  if (f.spellAbility === null) delete next.spellAbility;
  else if (f.spellAbility !== undefined) next.spellAbility = f.spellAbility;
  if (f.critOn === null) delete next.critOn;
  else if (f.critOn !== undefined) next.critOn = f.critOn;
  const own = fill.source === "ddb" ? stats.rolls.filter((r) => !r.ddb) : stats.rolls;
  const room = Math.max(0, MAX_PC_ROLLS - own.length);
  const incoming = fill.source === "ddb" ? fill.stats.rolls.map((r) => ({ ...r, ddb: true as const })) : fill.stats.rolls.map(({ ddb: _ddb, ...r }) => r);
  const added = incoming.slice(0, room);
  next.rolls = [...own, ...added];
  return {
    stats: next,
    added: added.length,
    replaced: stats.rolls.length - own.length,
    kept: fill.source === "ddb" ? own.length : stats.rolls.length,
    dropped: incoming.length - added.length,
  };
}

const PART_WORDS: { key: keyof PcFillStats; words: string }[] = [
  { key: "abilities", words: "the scores" },
  { key: "saves", words: "the saving throws" },
  { key: "skills", words: "the skills" },
  { key: "adjust", words: "the bonuses" },
  { key: "spellAbility", words: "spellcasting" },
  { key: "defenses", words: "the defenses" },
];

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function rolls(n: number): string {
  return n === 1 ? "1 roll" : `${n} rolls`;
}

/**
 * "Replaces the scores, the saving throws and the 14 rolls from the last
 * import. Keeps your 2 own rolls." or, for pasted text, "Replaces the
 * scores and the skills. Adds 3 rolls."
 */
export function fillSummary(fill: PcFill, merge: FillMerge): string {
  const parts = PART_WORDS.filter((p) => fill.stats[p.key] !== undefined).map((p) => p.words);
  const sentences: string[] = [];
  if (fill.source === "ddb") {
    if (merge.replaced > 0) parts.push(`the ${rolls(merge.replaced)} from the last import`);
    if (parts.length > 0) sentences.push(`Replaces ${list(parts)}.`);
    if (merge.added > 0) sentences.push(`Adds ${rolls(merge.added)}.`);
    if (merge.kept > 0) sentences.push(`Keeps your ${merge.kept} own ${merge.kept === 1 ? "roll" : "rolls"}.`);
  } else {
    if (parts.length > 0) sentences.push(`Replaces ${list(parts)}.`);
    if (merge.added > 0) sentences.push(`Adds ${rolls(merge.added)}.`);
  }
  if (merge.dropped > 0) sentences.push(`${merge.dropped} more ${merge.dropped === 1 ? "roll was" : "rolls were"} left out. At most ${MAX_PC_ROLLS} rolls fit.`);
  return sentences.length > 0 ? sentences.join(" ") : "Changes nothing in the stat block.";
}
