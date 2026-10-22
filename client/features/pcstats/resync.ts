import type { Character, PcRoll, PcStats } from "#shared/model.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { damageTypeName } from "#shared/rules/damage.ts";
import { LIMITS } from "#shared/limits.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { sensesWords, type AlsoItem, type FieldItem, type FieldKey, type FieldValue, type RollItem, type SyncItem, type SyncPlan, type SyncResult } from "#shared/rules/pcSync.ts";
import { signed } from "#shared/statBlock.ts";
import { speedText, whose } from "../tokens/companionBlocks.ts";
import { readLine } from "./fill.ts";
import { rollReading, rollTitle } from "./reading.ts";

/**
 * A re-sync's words (docs/design-v1-resync.md 3), as plain functions for
 * node --test: each item's line in the review, the read line, Check these,
 * the losses warning, the done line and every refusal. The merge's items
 * hold values (shared/rules/pcSync.ts), and these say them in the stat
 * block's words, the new value first, then "now" and the current one.
 */

function capital(text: string): string {
  return text === "" ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** "a, b and c" */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const ADJUST_LABELS: Record<string, string> = {
  allSaves: "All saves bonus",
  allChecks: "All checks bonus",
  init: "Initiative bonus",
  passive: "Passive Perception bonus",
  spellDc: "Spell save DC bonus",
  spellAttack: "Spell attack bonus",
};

const FLAG_LABELS: Record<string, string> = { jack: "Jack of All Trades", alert: "Alert", evasion: "Evasion" };

const DEFENSE_WORDS: Record<string, string> = { resistant: "Resistant", immune: "Immune", vulnerable: "Vulnerable" };

/** A value alone, as it reads after "now" or "D&D Beyond says": "16", "not proficient", "+2", "Charisma", "19 and 20". */
export function bareValue(key: FieldKey, value: FieldValue): string {
  const [part] = key.split(".");
  switch (part) {
    case "abilities":
    case "ac":
    case "hpMax":
      return String(value);
    case "level":
      return value === undefined ? "not set" : String(value);
    case "saves":
      return value === true ? "Proficient" : "not proficient";
    case "skills":
      return value === "expert" ? "Expertise" : value === "prof" ? "Proficient" : "not proficient";
    case "adjust":
      return signed(typeof value === "number" ? value : 0);
    case "defenses":
      return typeof value === "string" ? (DEFENSE_WORDS[value] ?? value) : "none";
    case "spellAbility":
      return typeof value === "string" ? ABILITY_NAMES[value as keyof typeof ABILITY_NAMES] : "none";
    case "critOn":
      return value === 18 ? "18 to 20" : value === 19 ? "19 and 20" : "20";
    case "speeds":
      return value && typeof value === "object" ? speedText(value) : "none";
    case "senses":
      return (typeof value === "string" ? sensesWords(value) : "") || "none";
    default:
      return value === true ? "yes" : "no";
  }
}

/** A field with its value: "Wisdom 16", "Dexterity save: Proficient", "Stealth bonus +3", "Spellcasting ability: Charisma". */
export function sayValue(key: FieldKey, value: FieldValue): string {
  const parts = key.split(".");
  const bare = bareValue(key, value);
  switch (parts[0]) {
    case "abilities":
      return `${ABILITY_NAMES[parts[1] as keyof typeof ABILITY_NAMES]} ${bare}`;
    case "saves":
      return `${ABILITY_NAMES[parts[1] as keyof typeof ABILITY_NAMES]} save: ${capital(bare)}`;
    case "skills":
      return `${SKILLS[parts[1] as keyof typeof SKILLS].name}: ${capital(bare)}`;
    case "adjust": {
      const label = parts[1] === "saves" ? `${ABILITY_NAMES[parts[2] as keyof typeof ABILITY_NAMES]} save bonus` : parts[1] === "skills" ? `${SKILLS[parts[2] as keyof typeof SKILLS].name} bonus` : ADJUST_LABELS[parts[1]!]!;
      return `${label} ${bare}`;
    }
    case "defenses":
      return `${damageTypeName(parts[1]!)}: ${capital(bare)}`;
    case "spellAbility":
      return `Spellcasting ability: ${capital(bare)}`;
    case "critOn":
      return `Critical hits on ${bare}`;
    case "level":
      return `Level ${bare}`;
    case "ac":
      return `AC ${bare}`;
    case "hpMax":
      return `Max HP ${bare}`;
    case "speeds":
      return `Speed ${bare}`;
    case "senses":
      return `Senses ${bare}`;
    default:
      return `${FLAG_LABELS[key] ?? key}: ${capital(bare)}`;
  }
}

/**
 * What Overwrite takes (3.3): D&D Beyond's value, named with its field where
 * the value alone would be a bare number, as "Overwrite with level 6". A
 * flag, and a value D&D Beyond does not have, say whose instead, so a box
 * never reads "Overwrite with none" or "Overwrite with not proficient".
 */
export function overwriteWords(item: Pick<FieldItem, "key" | "theirs">): string {
  const { key, theirs } = item;
  if (key in FLAG_LABELS || theirs === undefined || theirs === null || theirs === false || theirs === "") return "Overwrite with D&D Beyond’s";
  const [part, sub] = key.split(".");
  const bare = bareValue(key, theirs);
  switch (part) {
    case "abilities":
    case "ac":
      return `Overwrite with ${sayValue(key, theirs)}`;
    case "level":
      return `Overwrite with level ${bare}`;
    case "hpMax":
      return `Overwrite with max HP ${bare}`;
    case "speeds":
      return `Overwrite with speed ${bare}`;
    case "critOn":
      return `Overwrite with critical hits on ${bare}`;
    case "adjust": {
      // A save's or skill's bonus starts with its name. The others start with a plain word.
      const said = sayValue(key, theirs);
      return `Overwrite with ${sub! in ADJUST_LABELS ? `${said[0]!.toLowerCase()}${said.slice(1)}` : said}`;
    }
    default:
      return `Overwrite with ${bare}`;
  }
}

/** The blocks rolls read against: the character's now, and the block as the review would leave it. */
export type ReadingBlocks = { now: { stats: PcStats; level: number | undefined }; after: { stats: PcStats; level: number | undefined } };

function reading(blocks: ReadingBlocks["now"], roll: PcRoll): string {
  return rollReading(blocks.stats, blocks.level, roll);
}

/** A line under Changes from D&D Beyond: "Wisdom 18, now 16", "Adds Moonbeam (level 2): …", "Removes Shortbow". A first sync leaves out "now". */
export function changeLine(item: SyncItem, blocks: ReadingBlocks, first: boolean): string {
  if (item.type === "field") return first ? sayValue(item.key, item.theirs) : `${sayValue(item.key, item.theirs)}, now ${bareValue(item.key, item.now)}`;
  const theirs = item.theirs?.roll;
  switch (item.case) {
    case "add":
      return `Adds ${rollTitle(theirs!)}: ${reading(blocks.after, theirs!)}`;
    case "update":
      return `Updates ${rollTitle(item.mine!)}: ${reading(blocks.after, theirs!)}, now ${reading(blocks.now, item.mine!)}`;
    case "remove":
      return `Removes ${rollTitle(item.mine!)}`;
    default:
      return `Updates ${rollTitle(item.mine!)}: ${reading(blocks.after, theirs!)}`;
  }
}

/** A kept or different row (3.3): its value now, its tag when D&D Beyond changed it too, D&D Beyond's value, and its checkbox. */
export type KeptRow = { first: string; tag?: string; theirs: string; tick: string };

export function keptRow(item: SyncItem, blocks: ReadingBlocks): KeptRow {
  const tag = item.conflict ? "Also changed in D&D Beyond" : undefined;
  if (item.type === "field") {
    const theirs = item.conflict && item.base !== undefined ? `D&D Beyond now says ${bareValue(item.key, item.theirs)}. At the last sync it said ${bareValue(item.key, item.base)}.` : `D&D Beyond says ${bareValue(item.key, item.theirs)}.`;
    return { first: sayValue(item.key, item.now), ...(tag ? { tag } : {}), theirs, tick: overwriteWords(item) };
  }
  const mine = item.mine;
  const theirs = item.theirs?.roll;
  switch (item.case) {
    case "goneThere":
      return { first: `${rollTitle(mine!)}, as you changed it: ${reading(blocks.now, mine!)}`, theirs: "D&D Beyond no longer has it.", tick: "Remove it" };
    case "deleted":
      return { first: `${rollTitle(theirs!)}: you removed it.`, theirs: `D&D Beyond says ${reading(blocks.after, theirs!)}.`, tick: "Add it back" };
    case "sameName":
      return { first: `${rollTitle(mine!)}, your own: ${reading(blocks.now, mine!)}`, theirs: `D&D Beyond says ${reading(blocks.after, theirs!)}.`, tick: "Overwrite with D&D Beyond’s" };
    default: {
      // A roll renamed here can read just as D&D Beyond's does, so D&D Beyond's line names it whenever the names differ.
      const named = rollTitle(theirs!) === rollTitle(mine!) ? "" : `${rollTitle(theirs!)}: `;
      return { first: `${rollTitle(mine!)}, as you changed it: ${reading(blocks.now, mine!)}`, ...(tag ? { tag } : {}), theirs: `D&D Beyond says ${named}${reading(blocks.after, theirs!)}.`, tick: "Overwrite with D&D Beyond’s" };
    }
  }
}

/** A line under Replaces your changes, the editor's: "Spellcasting ability: Charisma, becomes Wisdom". */
export function replacesLine(item: SyncItem, blocks: ReadingBlocks): string {
  if (item.type === "field") return `${sayValue(item.key, item.now)}, becomes ${bareValue(item.key, item.theirs)}`;
  return `${rollTitle(item.mine!)}: ${reading(blocks.now, item.mine!)}, becomes ${reading(blocks.after, item.theirs!.roll)}`;
}

/** An item's line cut short, for a group's summary. */
function shortLine(item: SyncItem, blocks: ReadingBlocks, first: boolean): string {
  if (item.section === "changes") {
    if (item.type === "field") return changeLine(item, blocks, first);
    const roll = (item.mine ?? item.theirs!.roll) as PcRoll;
    return `${item.case === "add" ? "Adds" : item.case === "remove" ? "Removes" : "Updates"} ${rollTitle(item.case === "add" ? item.theirs!.roll : roll)}`;
  }
  if (item.section === "replaces") return item.type === "field" ? replacesLine(item, blocks) : `${rollTitle(item.mine!)}: yours, becomes D&D Beyond’s`;
  if (item.type === "field") return `${sayValue(item.key, item.now)}, D&D Beyond says ${bareValue(item.key, item.theirs)}`;
  return `${rollTitle((item.mine ?? item.theirs!.roll) as PcRoll)}, your own, differs from D&D Beyond’s`;
}

/** A group's summary, "3: Wisdom 16, D&D Beyond says 18, and 2 more", which wraps and is never cut. */
export function groupSummary(items: readonly SyncItem[], blocks: ReadingBlocks, first = false): string {
  const head = items[0];
  if (!head) return "0";
  return `${items.length}: ${shortLine(head, blocks, first)}${items.length > 1 ? `, and ${items.length - 1} more` : ""}`;
}

/** An Also set line with its help, in today's words (docs/design-v1-pc-stats.md 6.1) and the help 3.3 adds. */
export function alsoLine(item: AlsoItem, character: Pick<Character, "name" | "actor">, source: PcFill["source"]): { text: string; help?: string } {
  switch (item.key) {
    case "name":
      return { text: `Name ${item.theirs as string}, now ${item.now as string}` };
    case "sheetUrl":
      return item.now === undefined ? { text: `Sheet link ${item.theirs as string}` } : { text: `Sheet link ${item.theirs as string}, now ${item.now as string}`, help: "So the next re-sync gets this character." };
    case "hpMax": {
      const max = item.theirs as number;
      const hp = character.actor.hp;
      const full = character.actor.life === "alive" && hp.cur === hp.max;
      const help = full ? `${character.name} is unhurt and stays at full HP: ${max} of ${max}.` : `${character.name} keeps ${Math.min(hp.cur, max)} HP, now out of ${max}.`;
      return { text: `${sayValue("hpMax", max)}, now ${bareValue("hpMax", item.now)}`, help };
    }
    case "ac":
      return { text: `${sayValue("ac", item.theirs)}, now ${bareValue("ac", item.now)}`, ...(source === "ddb" ? { help: "Worked out from the armor. Check it." } : {}) };
    default:
      return { text: `${sayValue(item.key, item.theirs)}, now ${bareValue(item.key, item.now)}` };
  }
}

const MONTH = { month: "short", day: "numeric" } as const;

/** "Oct 20", with the year when it is not this year, by the log's rule (features/log/exportLog.ts sessionLabel). */
export function syncedOn(at: string, opts: { now?: Date; locale?: string; timeZone?: string } = {}): string {
  const when = new Date(at);
  const now = opts.now ?? new Date();
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, year: "numeric" }).format(d);
  return when.toLocaleDateString(opts.locale ?? "en-US", { ...MONTH, timeZone: opts.timeZone, ...(year(when) !== year(now) ? { year: "numeric" } : {}) });
}

/** Under the Stat block group's buttons (3.1). */
export function lastSyncedLine(at: string, opts?: { now?: Date; locale?: string; timeZone?: string }): string {
  return `Last synced from D&D Beyond on ${syncedOn(at, opts)}.`;
}

/** The review's first line: what was read, then when it last synced, or that it is a different character. */
export function syncReadLine(plan: SyncPlan, opts?: { now?: Date; locale?: string; timeZone?: string }): string {
  const read = readLine(plan.input.fill);
  if (plan.source === "relinked") return `${read} This is a different character from the last sync, so nothing is compared with it.`;
  const at = plan.input.character.ddbSync?.at;
  return plan.source === "same" && at ? `${read} Last synced on ${syncedOn(at, opts)}.` : read;
}

/** The first line of Different from D&D Beyond, for its case (3.3). */
export function differentIntro(plan: SyncPlan, name: string): string {
  if (plan.source === "relinked") return "This is a different D&D Beyond character from the last sync, so a change of yours cannot be told from one there. What differs stays as it is unless you overwrite it.";
  if (plan.source === "none") return `${name} has no record of a past sync, so a change of yours cannot be told from one in D&D Beyond. What differs stays as it is unless you overwrite it.`;
  return "D&D Beyond did not give these at the last sync, so a change of yours cannot be told from one there. They stay as they are unless you overwrite them.";
}

/** "Keeps your 2 own rolls." */
export function ownRollsLine(n: number): string {
  return `Keeps your ${n} own ${n === 1 ? "roll" : "rolls"}.`;
}

/** The removed markers the 40 cap drops (2.1): names up to three, then a count (RS-UX-25). */
export function goneDroppedLine(dropped: SyncResult["goneDropped"]): string | null {
  if (dropped.length === 0) return null;
  const tail = "may come back on a later re-sync. Only 40 deleted rolls are remembered.";
  const names = dropped.map((d) => d.name);
  if (names.every((n): n is string => n !== undefined) && names.length <= 3) return `Your deleted ${listWords(names)} ${tail}`;
  return dropped.length === 1 ? `A roll you deleted ${tail}` : `${dropped.length} rolls you deleted ${tail}`;
}

/** The player's own rolls D&D Beyond has too that the record had no room to link (2.4): names up to three, then a count. */
export function unlinkedLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const tail = "a sync remembers at most 40 rolls, so";
  if (names.length === 1) return `${names[0]} is in D&D Beyond too, but ${tail} it stays your own until there is room.`;
  const who = names.length <= 3 ? listWords(names) : `${names.length} of your own rolls`;
  return `${who} are in D&D Beyond too, but ${tail} they stay your own until there is room.`;
}

/** Check these (3.3): the reader's warnings, then the review's own. */
export function checkLines(plan: SyncPlan, result: SyncResult, name: string): string[] {
  const out = [...plan.input.fill.warnings];
  if (result.notFit > 0) {
    out.push(
      result.notFit === 1
        ? `1 roll from D&D Beyond did not fit, since a block holds 40. It comes in once there is room.`
        : `${result.notFit} rolls from D&D Beyond did not fit, since a block holds 40. They come in once there is room.`,
    );
  }
  const gone = goneDroppedLine(result.goneDropped);
  if (gone) out.push(gone);
  const unlinked = unlinkedLine(plan.rolls.unlinked.map((r) => r.name));
  if (unlinked) out.push(unlinked);
  if (plan.shaped) out.push(`AC and Speed are not compared while ${name} is in ${plan.shaped === "wild" ? "Wild Shape" : "a shape"}. Re-sync after the shape ends to update them.`);
  for (const b of result.besideBonus) {
    const what = "save" in b.on ? `${ABILITY_NAMES[b.on.save]} save` : SKILLS[b.on.skill].name;
    out.push(`${what} gets proficiency from D&D Beyond and keeps your ${signed(b.bonus)} bonus, so it rolls ${signed(b.total)}. Overwrite the bonus if it stood for the proficiency.`);
  }
  return out;
}

/** The losses warning (3.3), or null. */
export function lossesText(plan: SyncPlan, name: string): string | null {
  const l = plan.losses;
  if (!l) return null;
  const takes: string[] = [];
  if (l.spellAbility) takes.push("the Spellcasting ability");
  if (l.proficiencies) takes.push(`${l.proficiencies} proficiencies`);
  if (l.defenses) takes.push(`${l.defenses} defenses`);
  if (l.rolls) takes.push(`${l.rolls} rolls`);
  const parts = [l.level ? `lowers ${whose(name)} level from ${l.level.from} to ${l.level.to}` : null, takes.length > 0 ? `takes away ${listWords(takes)}` : null].filter((p): p is string => p !== null);
  return `This ${parts.join(" and ")}. If that is not what changed in D&D Beyond, its format may have changed. Cancel, and check the character there.`;
}

/** The done line (3.4): "6 changes came in, 1 roll was removed, 1 came back, and 2 of your changes stayed." A part that is 0 is left out. */
export function doneLine(counts: SyncResult["counts"]): string {
  const parts: string[] = [];
  if (counts.cameIn > 0) parts.push(`${counts.cameIn} ${counts.cameIn === 1 ? "change" : "changes"} came in`);
  if (counts.removed > 0) parts.push(`${counts.removed} ${counts.removed === 1 ? "roll was" : "rolls were"} removed`);
  if (counts.cameBack > 0) parts.push(counts.removed > 0 ? `${counts.cameBack} came back` : `${counts.cameBack} ${counts.cameBack === 1 ? "roll came" : "rolls came"} back`);
  if (counts.stayed > 0) parts.push(`${counts.stayed} of your changes stayed`);
  if (parts.length === 0) return "Nothing changed.";
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.`;
}

/** Why Apply is off for size (3.3). */
export function blockTooBigText(name: string, bytes: number): string {
  return `This would make ${whose(name)} stat block ${(bytes / 1024).toFixed(1)} KiB of the ${LIMITS.pcStatsBytes / 1024} KiB it may hold. Remove a few of your own rolls first.`;
}

export function recordTooBigText(name: string): string {
  return `${whose(name)} sync record would be too large to save. Remove a few rolls first.`;
}

export const NOTHING_NEW = "Nothing new from D&D Beyond.";

/** The dialog's other words (3.2 to 3.5). */
export const RESYNC_WORDS = {
  getting: (name: string) => `Getting ${name} from D&D Beyond…`,
  liveChange: (name: string, dropped: boolean) => `${name} changed on another device. The lists show the latest.${dropped ? " Choices on lines that went away were dropped." : ""}`,
  stale: (name: string) => `${name} changed on another device before this applied, so nothing changed. Check the review again.`,
  unknown: (name: string) => `The connection dropped before the server answered. Check ${whose(name)} stat block before re-syncing again.`,
  unknownUndo: (name: string) => `The connection dropped before the server answered. Check ${whose(name)} stat block before undoing again.`,
  gone: "This character was deleted or is no longer yours, so it cannot be re-synced.",
  undoStale: (name: string) => `${name} changed after the re-sync, so it cannot be undone here.`,
  undone: (name: string) => `${name} is as before the re-sync.`,
  retry: "You can apply again in a few seconds.",
} as const;

/** "Not re-synced: " or "Not undone: " and the server's words as a sentence. */
export function refusalText(prefix: "Not re-synced" | "Not undone", message: string | undefined): string {
  const words = message?.trim() ?? "";
  if (!words) return `${prefix}. The server refused it.`;
  const sentence = /[.!?]$/.test(words) ? capital(words) : `${capital(words)}.`;
  return `${prefix}: ${sentence}`;
}

/** The toast for an Apply answered after the dialog closed (3.5): nothing once taken. */
export function lateApplyText(name: string, answer: "taken" | "refused" | "unknown", message?: string): string | null {
  if (answer === "taken") return null;
  if (answer === "unknown") return `The connection dropped before the server answered, so ${name} may not have been re-synced. Check the stat block.`;
  const why = message?.trim().replace(/\.$/, "");
  return why ? `${name} was not re-synced. ${capital(why)}.` : `${name} was not re-synced.`;
}

/** The toast for an Undo answered after the dialog closed: nothing once taken. */
export function lateUndoText(name: string, answer: "taken" | "refused" | "unknown", message?: string): string | null {
  if (answer === "taken") return null;
  if (answer === "unknown") return `The connection dropped before the server answered, so ${whose(name)} re-sync may not have been undone. Check the stat block.`;
  const why = message?.trim().replace(/\.$/, "");
  return why ? `${whose(name)} re-sync was not undone. ${capital(why)}.` : `${whose(name)} re-sync was not undone.`;
}

/** The D&D Beyond number a re-sync fetches (decision 6): the sheet link's when it is a D&D Beyond link, else the record's. */
export function resyncNumber(character: Pick<Character, "actor" | "ddbSync">, idOf: (link: string) => string | null): string | null {
  const link = character.actor.sheetUrl;
  const fromLink = link ? idOf(link) : null;
  return fromLink ?? character.ddbSync?.from ?? null;
}
