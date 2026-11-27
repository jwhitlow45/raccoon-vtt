import type { Actor, Character, ClassLevel } from "#shared/model.ts";
import { CLASS_NAMES } from "#shared/rules/classResources.ts";
import type { ActorPatch, CharacterPatch, DdbSyncPatch } from "#shared/protocol.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { hpForMax, sameClasses, sensesWords } from "#shared/rules/pcSync.ts";
import { speedText } from "../tokens/companionBlocks.ts";

/**
 * The review of a fill (docs/design/design-v1-pc-stats.md 6.1), as plain
 * functions for node --test: what it read, and one line for each other
 * field of the character it would change, new value then current, each
 * with a tick the player may take off. The name starts off. The size is
 * never set, since a player may not change it.
 */

export type AlsoKey = "level" | "ac" | "hpMax" | "speeds" | "senses" | "sheetUrl" | "name" | "classes";

export type AlsoLine = { key: AlsoKey; text: string; on: boolean };

/** The fields a fill sets beside the block, as the review left them ticked. */
export type AlsoSet = { level?: number; name?: string; ac?: number; hpMax?: number; speeds?: Actor["speeds"]; senses?: string; sheetUrl?: string; classes?: ClassLevel[] };

/**
 * Classes in words (docs/design/design-v1-slots.md 8): "Fighter 3 (its
 * subclass casts spells), Wizard 2", an Other class by the name D&D Beyond
 * gave it where there is one, "Artificer 3 (Other class, d8)", else "Other
 * class 3 (d8)", and "none" for none.
 */
export function classesWords(classes: readonly ClassLevel[] | undefined, names?: readonly string[]): string {
  if (!classes || classes.length === 0) return "none";
  return classes
    .map((c, i) => {
      if (c.id !== "other") return `${CLASS_NAMES[c.id]} ${c.level}${c.third ? " (its subclass casts spells)" : ""}`;
      const name = names?.[i];
      return name !== undefined ? `${name} ${c.level} (Other class, d${c.die})` : `Other class ${c.level} (d${c.die})`;
    })
    .join(", ");
}

/** "Read from D&D Beyond: Bree Tallow, level 5." or "Read from the pasted text." */
export function readLine(fill: PcFill): string {
  if (fill.source === "paste") return "Read from the pasted text.";
  const who = [fill.name, fill.level !== undefined ? `level ${fill.level}` : null].filter((x): x is string => !!x).join(", ");
  return who ? `Read from D&D Beyond: ${who}.` : "Read from D&D Beyond.";
}

function sameSpeeds(a: Actor["speeds"], b: Actor["speeds"]): boolean {
  return a.walk === b.walk && a.fly === b.fly && a.swim === b.swim && a.climb === b.climb && a.burrow === b.burrow && (a.hover ?? false) === (b.hover ?? false);
}

/** One line per field the fill would change, in the review's order. */
export function alsoLines(fill: PcFill, character: Pick<Character, "name" | "level" | "actor" | "classes">): AlsoLine[] {
  const actor = character.actor;
  const lines: AlsoLine[] = [];
  if (fill.level !== undefined && fill.level !== character.level) {
    lines.push({ key: "level", text: `Level ${fill.level}, now ${character.level ?? "not set"}`, on: true });
  }
  if (fill.classes !== undefined && !sameClasses(fill.classes, character.classes)) {
    lines.push({ key: "classes", text: `Classes: ${classesWords(fill.classes, fill.classNames)}, now ${classesWords(character.classes)}`, on: true });
  }
  const a = fill.actor;
  // In a shape the AC and speeds are the creature's, and End the shape puts the character's from before it back, so a fill leaves both (W7B-P-9).
  const shaped = actor.srdId !== undefined;
  if (!shaped && a.ac !== undefined && a.ac !== actor.ac) lines.push({ key: "ac", text: `AC ${a.ac}, now ${actor.ac}`, on: true });
  if (a.hpMax !== undefined && a.hpMax !== actor.hp.max) lines.push({ key: "hpMax", text: `Max HP ${a.hpMax}, now ${actor.hp.max}`, on: true });
  if (!shaped && a.speeds !== undefined && !sameSpeeds(a.speeds, actor.speeds)) lines.push({ key: "speeds", text: `Speed ${speedText(a.speeds)}, now ${speedText(actor.speeds)}`, on: true });
  if (a.senses !== undefined && sensesWords(a.senses) !== sensesWords(actor.senses)) {
    lines.push({ key: "senses", text: `Senses ${sensesWords(a.senses) || "none"}, now ${sensesWords(actor.senses) || "none"}`, on: true });
  }
  // A sheet link the player already chose stays theirs.
  if (a.sheetUrl !== undefined && actor.sheetUrl === undefined) lines.push({ key: "sheetUrl", text: `Sheet link ${a.sheetUrl}`, on: true });
  if (fill.name !== undefined && fill.name !== character.name) lines.push({ key: "name", text: `Name ${fill.name}, now ${character.name}`, on: false });
  return lines;
}

/** The ticked lines' values. */
export function alsoSet(fill: PcFill, lines: readonly AlsoLine[]): AlsoSet {
  const on = new Set(lines.filter((l) => l.on).map((l) => l.key));
  const out: AlsoSet = {};
  if (on.has("level") && fill.level !== undefined) out.level = fill.level;
  if (on.has("name") && fill.name !== undefined) out.name = fill.name;
  if (on.has("ac") && fill.actor.ac !== undefined) out.ac = fill.actor.ac;
  if (on.has("hpMax") && fill.actor.hpMax !== undefined) out.hpMax = fill.actor.hpMax;
  if (on.has("speeds") && fill.actor.speeds !== undefined) out.speeds = fill.actor.speeds;
  if (on.has("senses") && fill.actor.senses !== undefined) out.senses = fill.actor.senses;
  if (on.has("sheetUrl") && fill.actor.sheetUrl !== undefined) out.sheetUrl = fill.actor.sheetUrl;
  if (on.has("classes") && fill.classes !== undefined) out.classes = fill.classes;
  return out;
}

/**
 * The fields a Save sends beside the block (6.1), against the character as
 * it is at Save. Max HP by the companion design's rule, as a re-sync sets
 * it (shared/rules/pcSync.ts hpForMax).
 */
export function alsoPatch(also: AlsoSet, character: Pick<Character, "actor">): Pick<CharacterPatch, "name" | "level" | "actor" | "classes"> {
  const out: Pick<CharacterPatch, "name" | "level" | "actor" | "classes"> = {};
  if (also.name !== undefined) out.name = also.name;
  if (also.level !== undefined) out.level = also.level;
  // The reducer clamps the counts spent to the new classes, so a fill never sends them (D-261127-094).
  if (also.classes !== undefined) out.classes = also.classes;
  const actor: ActorPatch = {};
  if (also.ac !== undefined) actor.ac = also.ac;
  if (also.speeds !== undefined) actor.speeds = also.speeds;
  if (also.senses !== undefined) actor.senses = also.senses;
  if (also.sheetUrl !== undefined) actor.sheetUrl = also.sheetUrl;
  if (also.hpMax !== undefined && also.hpMax !== character.actor.hp.max) actor.hp = hpForMax(character.actor, also.hpMax);
  if (Object.keys(actor).length > 0) out.actor = actor;
  return out;
}

/**
 * The character as Save would leave it: the fields earlier fills set beside
 * the block, and the record a D&D Beyond "Use it" made, else the saved one.
 * A later fill before Save is reviewed against it, so it compares with what
 * the earlier fill took, not with what was saved (docs/design/design-v1-resync.md 1.1).
 */
export function pendingCharacter(
  character: Pick<Character, "name" | "actor" | "ddbSync" | "classes">,
  also: AlsoSet,
  record: DdbSyncPatch | null,
): Pick<Character, "name" | "actor" | "classes"> & { ddbSync?: DdbSyncPatch } {
  const actor: Actor = { ...character.actor };
  if (also.ac !== undefined) actor.ac = also.ac;
  if (also.speeds !== undefined) actor.speeds = also.speeds;
  if (also.senses !== undefined) actor.senses = also.senses;
  if (also.sheetUrl !== undefined) actor.sheetUrl = also.sheetUrl;
  if (also.hpMax !== undefined) actor.hp = { ...actor.hp, ...hpForMax(character.actor, also.hpMax) };
  const classes = also.classes ?? character.classes;
  return { name: also.name ?? character.name, actor, ...(classes && classes.length > 0 ? { classes } : {}), ...(record ?? character.ddbSync ? { ddbSync: record ?? character.ddbSync } : {}) };
}

/** Whether a fill set anything beside the block. */
export function alsoAny(also: AlsoSet): boolean {
  return Object.keys(also).length > 0;
}
