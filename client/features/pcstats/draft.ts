import { parseFormula } from "#shared/dice/formula.ts";
import { BLOCK_SAVES_TOO_FAST, LIMITS, serializedBytes } from "#shared/limits.ts";
import type { AbilityKey, Character, PcDice, PcRoll, PcStats, SkillKey } from "#shared/model.ts";
import { stableStringify } from "#shared/project.ts";
import { MAX_PC_ROLLS, type CharacterPatch, type PcStatsPatch } from "#shared/protocol.ts";
import { EMPTY_PC_STATS, pcDerived, pcRollFits, type PcNumber } from "#shared/rules/pcStats.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";

/**
 * The stat block editor's draft (docs/design-v1-pc-stats.md 7.2), as plain
 * functions for node --test: the totals a player types, the one patch a
 * Save sends, and the problems that keep Save off. A typed total keeps its
 * difference from what the rules give as that number's adjustment
 * (section 3.3), so the editor never asks where a bonus came from.
 */

export type PcDraft = { stats: PcStats; level: number | undefined };

/** What the editor opens with: the character's block, or the empty one for "Add a stat block", and whether it had one. */
export function openDraft(character: Pick<Character, "stats" | "level">): { draft: PcDraft; had: boolean } {
  const stats = character.stats ?? (structuredClone(EMPTY_PC_STATS) as PcStats);
  return { draft: { stats, level: character.level }, had: character.stats !== undefined };
}

/** A number the editor shows as one field holding its total. */
export type TotalKey =
  | { kind: "save"; ability: AbilityKey }
  | { kind: "skill"; skill: SkillKey }
  | { kind: "init" }
  | { kind: "passive" }
  | { kind: "spellDc" }
  | { kind: "spellAttack" };

/** The number behind a field, or undefined for a spell number without a spellcasting ability. */
export function numberOf(stats: PcStats, level: number | undefined, key: TotalKey): PcNumber | undefined {
  const d = pcDerived(stats, level);
  switch (key.kind) {
    case "save":
      return d.saves[key.ability];
    case "skill":
      return d.skills[key.skill];
    case "init":
      return d.initiative;
    case "passive":
      return d.passive;
    case "spellDc":
      return d.spell?.dc;
    case "spellAttack":
      return d.spell?.attack;
  }
}

const ADJUST_MIN = -20;
const ADJUST_MAX = 20;

function clampAdjust(n: number): number {
  return Math.min(ADJUST_MAX, Math.max(ADJUST_MIN, Math.round(n)));
}

/**
 * A typed total stored as its difference from the rules, clamped to the
 * adjustments' bounds, so the field then shows the total that holds.
 * Clearing the field, null, sets the difference to 0. An adjustment of 0
 * is left out, as absent reads as 0.
 */
export function withTotal(stats: PcStats, level: number | undefined, key: TotalKey, total: number | null): PcStats {
  const number = numberOf(stats, level, key);
  if (!number) return stats;
  const value = total === null ? 0 : clampAdjust(total - number.base);
  const adjust = { ...stats.adjust };
  if (key.kind === "save" || key.kind === "skill") {
    const field = key.kind === "save" ? "saves" : "skills";
    const name = key.kind === "save" ? key.ability : key.skill;
    const map: Record<string, number> = { ...(adjust[field] ?? {}) };
    if (value === 0) delete map[name];
    else map[name] = value;
    if (Object.keys(map).length === 0) delete adjust[field];
    else (adjust as Record<string, unknown>)[field] = map;
  } else {
    const field = key.kind;
    if (value === 0) delete adjust[field];
    else adjust[field] = value;
  }
  return { ...stats, adjust };
}

/** "All saves" and "All checks", which are bonuses of their own with nothing derived under them. */
export function withAllBonus(stats: PcStats, field: "allSaves" | "allChecks", value: number | null): PcStats {
  const adjust = { ...stats.adjust };
  const n = value === null ? 0 : clampAdjust(value);
  if (n === 0) delete adjust[field];
  else adjust[field] = n;
  return { ...stats, adjust };
}

const PARTS = ["abilities", "saves", "skills", "adjust", "defenses", "rolls", "jack", "alert", "spellAbility", "critOn", "evasion"] as const satisfies readonly (keyof PcStats)[];

/** The parts of `draft` that differ from `base`, each whole, and null for an optional one the draft took away. */
export function statsPatch(base: PcStats, draft: PcStats): PcStatsPatch {
  const patch: Record<string, unknown> = {};
  for (const part of PARTS) {
    if (stableStringify(base[part]) === stableStringify(draft[part])) continue;
    patch[part] = draft[part] ?? null;
  }
  return patch as PcStatsPatch;
}

/**
 * The one `character.update` a Save sends (7.2): the parts that differ from
 * the block the editor opened with, so a part another device changed
 * meanwhile is kept unless this draft changed it too, and the level when it
 * changed. A character without a block always gets one, the empty block
 * if nothing was typed. Null when there is nothing to send.
 */
export function savePatch(opened: PcDraft, had: boolean, draft: PcDraft): CharacterPatch | null {
  const patch: CharacterPatch = {};
  const stats = statsPatch(opened.stats, draft.stats);
  if (!had || Object.keys(stats).length > 0) patch.stats = stats;
  if (opened.level !== draft.level) patch.level = draft.level ?? null;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Whether the draft holds anything not yet saved, for the question on close. An untouched empty block is nothing to lose. */
export function draftDirty(opened: PcDraft, draft: PcDraft): boolean {
  return Object.keys(statsPatch(opened.stats, draft.stats)).length > 0 || opened.level !== draft.level;
}

function formulaProblem(roll: PcRoll, text: string, what: string): string | null {
  if (text.trim() === "") return `${rollName(roll)}: type the ${what}, as 1d8 or 2d6+1.`;
  const parsed = parseFormula(text);
  return parsed.ok ? null : `${rollName(roll)}, ${what}: ${parsed.error}`;
}

function rollName(roll: Pick<PcRoll, "name" | "kind">): string {
  const name = roll.name.trim();
  if (name) return name;
  return roll.kind === "weapon" ? "A weapon" : roll.kind === "spell" ? "A spell" : "A roll";
}

/** Up to three quarters of the bound a block holds without a word, then its size shows, and past the bound it is a problem. */
export function sizeOf(stats: PcStats): { bytes: number; near: boolean; over: boolean } {
  const bytes = serializedBytes(stats);
  return { bytes, near: bytes > LIMITS.pcStatsBytes * 0.75, over: bytes > LIMITS.pcStatsBytes };
}

export function sizeText(bytes: number): string {
  return `This stat block is ${(bytes / 1024).toFixed(1)} KiB of the ${LIMITS.pcStatsBytes / 1024} KiB it may hold.`;
}

/**
 * The problems that keep Save off (7.2): a roll with no name, a formula in
 * FORMULA_ERRORS' words, a roll with nothing to roll, a roll whose dice at
 * level 20 and a 9th-level slot go past one roll, and a block past its size.
 */
export function draftProblems(draft: PcDraft): string[] {
  const out: string[] = [];
  for (const roll of draft.stats.rolls) {
    if (roll.name.trim() === "") out.push(`${rollName(roll)} needs a name.`);
    const before = out.length;
    roll.dice.forEach((part, i) => {
      const which = roll.dice.length > 1 ? `dice ${i + 1}` : "dice";
      const problem = formulaProblem(roll, part.formula, which);
      if (problem) out.push(problem);
      if (part.upcast !== undefined) {
        const upcast = formulaProblem(roll, part.upcast, `${which} at higher levels`);
        if (upcast) out.push(upcast);
      }
      if (part.optional && part.name !== undefined && part.name.trim() === "") out.push(`${rollName(roll)}: name the part that applies only sometimes, as Sneak Attack, or untick it.`);
    });
    if (roll.attack === undefined && roll.save === undefined && roll.dice.length === 0) out.push(`${rollName(roll)} has nothing to roll. Give it an attack, a save or dice.`);
    else if (out.length === before && !pcRollFits(draft.stats, roll)) out.push(`${rollName(roll)} would roll more dice at level 20 or a 9th-level slot than one roll holds. Use fewer dice.`);
  }
  if (draft.stats.rolls.length > MAX_PC_ROLLS) out.push(`At most ${MAX_PC_ROLLS} rolls.`);
  const size = sizeOf(draft.stats);
  if (size.over) out.push(`${sizeText(size.bytes)} Remove a few rolls.`);
  return out;
}

/** A new roll from "Add a weapon", "Add a spell" or "Add a roll". A new spell reads the spellcasting ability and, as a cantrip, grows with level. */
export function newRoll(kind: PcRoll["kind"], id: string): PcRoll {
  if (kind === "weapon") return { id, name: "", kind, ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "", mod: true, type: "slashing" }] };
  if (kind === "spell") return { id, name: "", kind, ability: "spell", level: 0, dice: [{ formula: "", grows: true }] };
  return { id, name: "", kind, dice: [{ formula: "" }] };
}

/**
 * A roll as edited here, which is the player's own from now on even if an
 * import made it (section 6.1). Only a cantrip's dice grow with level, and
 * a new spell starts as one, so a roll that stops being a cantrip, as when
 * its level is picked, drops the mark: its checkbox no longer shows, and a
 * level 2 spell would otherwise roll its dice twice over from level 5.
 */
export function editedRoll(roll: PcRoll, next: PcRoll): PcRoll {
  const { ddb: _ddb, ...own } = next;
  const out = roll.ddb ? own : next;
  const cantrip = out.kind === "spell" && (out.level ?? 0) === 0;
  if (cantrip || !out.dice.some((p) => p.grows)) return out;
  return { ...out, dice: out.dice.map(({ grows: _grows, ...part }) => part) };
}

/** A part made to say one thing: `upcast` only on damage or healing, a rider only on damage, its name only on a rider. */
export function tidyPart(part: PcDice): PcDice {
  const out: PcDice = { ...part };
  if (out.type === undefined || out.type === "healing") {
    delete out.optional;
    delete out.name;
  }
  if (out.type === undefined) delete out.upcast;
  if (!out.optional) delete out.name;
  return out;
}

export type SaveOutcome = { kind: "saved" } | { kind: "problem"; text: string; retryInMs?: number };

/** A Save's answer in the editor's words (7.2). The budget's refusal keeps Save off for a few seconds. */
export function saveOutcome(answer: OpAnswer, refusal: Pick<OpRefusal, "message"> | undefined, name: string): SaveOutcome {
  if (answer === "taken") return { kind: "saved" };
  if (answer === "unknown") return { kind: "problem", text: `The connection dropped before the server answered. Check ${name}'s stat block before saving again.` };
  const message = refusal?.message.trim() ?? "";
  if (message === BLOCK_SAVES_TOO_FAST) return { kind: "problem", text: message, retryInMs: LIMITS.companionBlockWriteRefillMs };
  return { kind: "problem", text: message ? sentence(message) : "The server refused it." };
}

/** The toast for a Save answered after the editor closed: nothing once saved, since the block shows where it was opened. */
export function lateSaveText(name: string, answer: OpAnswer, refusal?: Pick<OpRefusal, "message">): string | null {
  if (answer === "taken") return null;
  if (answer === "unknown") return `The connection dropped before the server answered, so ${name}'s stat block may not have been saved. Check it.`;
  const why = refusal?.message.trim().replace(/\.$/, "");
  return why ? `${name}'s stat block was not saved. ${why[0]!.toUpperCase()}${why.slice(1)}.` : `${name}'s stat block was not saved.`;
}

function sentence(text: string): string {
  const capital = `${text[0]!.toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
