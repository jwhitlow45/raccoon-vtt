import type { CustomMonster, ImageRef, StatBlock, StatBlockEntry, AbilityKey } from "#shared/model.ts";
import type { MonsterPatch } from "#shared/protocol.ts";
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
 * The lines an edit changed, for `monster.update`. Two DMs editing different
 * lines of one monster both keep their work, and an edit that changed
 * nothing sends nothing.
 */
export function monsterPatch(before: CustomMonster, after: StatBlock): MonsterPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof StatBlock)[]) {
    if (stableStringify(after[key]) !== stableStringify(before[key])) patch[key] = after[key];
  }
  if (before.sizeAlt !== undefined && after.sizeAlt === undefined) patch.sizeAlt = null;
  if (before.xpInLair !== undefined && after.xpInLair === undefined) patch.xpInLair = null;
  if (before.defaultImage !== undefined && after.defaultImage === undefined) patch.defaultImage = null;
  return patch as MonsterPatch;
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
    else if (part === "formula") parts.push("hit dice");
    else if (part === "text" || part === "name" || part === "score" || part === "save") parts.push(part);
    else if (typeof part === "string") parts.push(part.length === 3 ? part.charAt(0).toUpperCase() + part.slice(1) : part);
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

const views = new WeakMap<CustomMonster, StatBlockMonster>();

/** A room monster in the SRD shape, worked out once per version: entities are replaced, never changed, so the object is the key. */
export function viewOf(m: CustomMonster): StatBlockMonster {
  let view = views.get(m);
  if (!view) {
    view = monsterView(m);
    views.set(m, view);
  }
  return view;
}
