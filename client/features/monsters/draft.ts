import type { AbilityKey, CompanionBlock, ImageRef, StatBlock, StatBlockEntry } from "#shared/model.ts";
import { BLOCK_SAVES_TOO_FAST, LIMITS } from "#shared/limits.ts";
import { ABILITY_ABBR } from "#shared/rules/skills.ts";
import type { MonsterPatch } from "#shared/protocol.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { stableStringify } from "#shared/project.ts";
import { abilityMod, monsterView, SECTIONS, XP_BY_CR } from "#shared/statBlock.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";

/**
 * The editor's draft of a stat block, kept free of React so its rules run
 * under plain Node: tidying before a save, the patch an edit sends, the
 * fields that follow each other, and plain words for what the protocol
 * refuses.
 */

/** Spaces trimmed, blank lines and empty entries dropped, and an ASCII minus in the hit dice. */
export function tidy(block: StatBlock): StatBlock {
  const entries = (list: StatBlockEntry[]) =>
    list
      .map((e) => ({
        name: e.name.trim().replace(/\.$/, ""),
        text: e.text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n"),
      }))
      .filter((e) => e.name !== "" || e.text !== "");
  const out: StatBlock = {
    ...block,
    name: block.name.trim(),
    type: block.type.trim(),
    alignment: block.alignment.trim(),
    hp: { average: block.hp.average, formula: block.hp.formula.trim().replace(/[−–]/g, "-") },
    speed: block.speed.trim(),
    skills: block.skills.trim(),
    vulnerabilities: block.vulnerabilities.trim(),
    resistances: block.resistances.trim(),
    immunities: block.immunities.trim(),
    gear: block.gear.trim(),
    senses: block.senses.trim(),
    languages: block.languages.trim(),
  };
  for (const { key } of SECTIONS) out[key] = entries(block[key]);
  return out;
}

/**
 * The lines an edit changed, for `monster.update` or `companionBlock.update`.
 * `before` is the block as the editor opened it, never as it is now: a line
 * another DM or a co-owner changed meanwhile is then kept unless this draft
 * changed the same line, where the later save wins
 * (docs/design-v1-companion-stat-blocks.md 6.2). An edit that changed
 * nothing sends nothing.
 */
export function monsterPatch(before: StatBlock, after: StatBlock): MonsterPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof StatBlock)[]) {
    if (stableStringify(after[key]) !== stableStringify(before[key])) patch[key] = after[key];
  }
  if (before.sizeAlt !== undefined && after.sizeAlt === undefined) patch.sizeAlt = null;
  if (before.xpInLair !== undefined && after.xpInLair === undefined) patch.xpInLair = null;
  if (before.defaultImage !== undefined && after.defaultImage === undefined) patch.defaultImage = null;
  return patch as MonsterPatch;
}

/**
 * Whether the editor holds anything to lose: text in the paste box, or a
 * draft that differs from the block as the editor opened it. Never against
 * the block as it is now, so a co-owner's edit arriving meanwhile leaves
 * an untouched draft clean (docs/design-v1-companion-stat-blocks.md 6.2).
 */
export function isDirty(opened: StatBlock, draft: StatBlock, pasted: string): boolean {
  return pasted.trim() !== "" || stableStringify(tidy(draft)) !== stableStringify(tidy(opened));
}

/** A companion's stored block as the editor's draft holds it: its lines, without what only the room keeps about it. */
export function blockLines(block: CompanionBlock): StatBlock {
  const { id: _id, rev: _rev, characterId: _of, fromSrd: _from, ...lines } = block;
  return lines;
}

/** The draft with a new default image, or without one for null. */
export function withImage(block: StatBlock, image: ImageRef | null): StatBlock {
  const { defaultImage: _old, ...rest } = block;
  return image ? { ...rest, defaultImage: image } : rest;
}

/** A new score. A save that was the plain modifier follows it, and a proficient save keeps its number. */
export function withScore(block: StatBlock, key: AbilityKey, score: number): StatBlock {
  const row = block.abilities[key];
  const save = row.save === abilityMod(row.score) ? abilityMod(score) : row.save;
  return { ...block, abilities: { ...block.abilities, [key]: { score, save } } };
}

/** A new challenge rating. XP that was the table's number for the old one follows it. */
export function withCr(block: StatBlock, cr: string): StatBlock {
  const xp = block.xp === XP_BY_CR[block.cr] ? (XP_BY_CR[cr] ?? block.xp) : block.xp;
  return { ...block, cr, xp };
}

const FIELD_NAMES: Record<string, string> = {
  name: "Name",
  size: "Size",
  sizeAlt: "Second size",
  type: "Type",
  alignment: "Alignment",
  ac: "AC",
  initiative: "Initiative",
  hp: "HP",
  speed: "Speed",
  abilities: "Ability scores",
  skills: "Skills",
  vulnerabilities: "Vulnerabilities",
  resistances: "Resistances",
  immunities: "Immunities",
  gear: "Gear",
  senses: "Senses",
  passivePerception: "Passive Perception",
  languages: "Languages",
  cr: "CR",
  xp: "XP",
  xpInLair: "XP in lair",
  traits: "Traits",
  actions: "Actions",
  bonusActions: "Bonus Actions",
  reactions: "Reactions",
  legendaryActions: "Legendary Actions",
  defaultImage: "Token image",
};

type Issue = { code: string; path: PropertyKey[]; message: string; origin?: string; maximum?: unknown; minimum?: unknown };

/** Where a refusal points, in the editor's words: "Actions, entry 2, name". */
function placeOf(path: PropertyKey[]): string {
  const [field, ...rest] = path;
  const parts = [FIELD_NAMES[String(field)] ?? "The stat block"];
  for (const part of rest) {
    if (typeof part === "number") parts.push(`entry ${part + 1}`);
    else if (part === "formula") parts.push("Hit Point Dice");
    else if (part === "text" || part === "name" || part === "score" || part === "save") parts.push(part);
    else if (typeof part === "string") parts.push(Object.hasOwn(ABILITY_ABBR, part) ? ABILITY_ABBR[part as AbilityKey] : part);
  }
  return parts.join(", ");
}

/** The protocol's refusals as sentences a DM can act on. */
export function issueText(issues: readonly Issue[]): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const where = placeOf(issue.path);
    let text: string;
    if (issue.path.length === 0) text = `This stat block is too long. ${issue.message.charAt(0).toUpperCase()}${issue.message.slice(1)}.`;
    else if (issue.code === "too_big") text = issue.origin === "string" ? `${where} is too long (at most ${String(issue.maximum)} characters).` : issue.origin === "array" ? `${where} has too many entries (at most ${String(issue.maximum)}).` : `${where} is too high (at most ${String(issue.maximum)}).`;
    else if (issue.code === "too_small") text = issue.origin === "string" ? `${where} is needed.` : `${where} is too low (at least ${String(issue.minimum)}).`;
    else if (issue.code === "invalid_format") text = `${where} has a line break or a hidden character it cannot hold.`;
    else if (issue.code === "custom" && /challenge rating/.test(issue.message)) text = `${where} is not a challenge rating.`;
    else text = `${where}: ${issue.message}.`;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

const views = new WeakMap<StatBlock, StatBlockMonster>();

/**
 * A room monster or a companion's stat block in the SRD shape, worked out
 * once per version: entities are replaced, never changed, so the object is
 * the key.
 */
export function viewOf(m: StatBlock): StatBlockMonster {
  let view = views.get(m);
  if (!view) {
    view = monsterView(m);
    views.set(m, view);
  }
  return view;
}

/** What a companion block's answered save comes to while its editor is open (docs/design-v1-companion-stat-blocks.md 6.2). */
export type BlockSaveOutcome =
  | { kind: "saved" }
  /** The draft stays, with the problem above the fields. `retryInMs` keeps Save off that long, past the saves budget. */
  | { kind: "problem"; text: string; retryInMs?: number };

/**
 * A save's answer, for the editor that sent it: closes on `taken`, and
 * otherwise keeps the draft with the server's words, which for a guard's
 * refusal are already the blocks' own (server/rooms/actor.ts). Past the
 * player's save budget, Save waits out one refill before it is offered again.
 */
export function blockSaveOutcome(answer: OpAnswer, refusal: Pick<OpRefusal, "message"> | undefined, characterName: string): BlockSaveOutcome {
  if (answer === "taken") return { kind: "saved" };
  if (answer === "unknown") return { kind: "problem", text: `The connection dropped before the server answered. Check ${characterName}’s stat blocks before saving again.` };
  const message = refusal?.message.trim() ?? "";
  if (message === BLOCK_SAVES_TOO_FAST) return { kind: "problem", text: message, retryInMs: LIMITS.companionBlockWriteRefillMs };
  return { kind: "problem", text: message ? sentence(message) : "The server refused it." };
}

/** The toast for a save answered after its editor closed: nothing once saved, since the block shows in the list. */
export function lateBlockSaveText(name: string, characterName: string, answer: OpAnswer, refusal?: Pick<OpRefusal, "message">): string | null {
  if (answer === "taken") return null;
  if (answer === "unknown") return `The connection dropped before the server answered, so ${name} may not have been saved. Check ${characterName}’s stat blocks.`;
  const why = refusal?.message.trim().replace(/\.$/, "");
  return why ? `${name} was not saved. ${why[0]!.toUpperCase()}${why.slice(1)}.` : `${name} was not saved.`;
}

/** A refusal's words as a sentence of the editor's problem list. */
function sentence(text: string): string {
  const capital = `${text[0]!.toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
