import type { Actor, Character } from "#shared/model.ts";
import type { ActorPatch, CharacterPatch } from "#shared/protocol.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { speedText } from "../tokens/companionBlocks.ts";

/**
 * The review of a fill (docs/design-v1-pc-stats.md 6.1), as plain
 * functions for node --test: what it read, and one line for each other
 * field of the character it would change, new value then current, each
 * with a tick the player may take off. The name starts off. The size is
 * never set, since a player may not change it.
 */

export type AlsoKey = "level" | "ac" | "hpMax" | "speeds" | "senses" | "sheetUrl" | "name";

export type AlsoLine = { key: AlsoKey; text: string; on: boolean };

/** The fields a fill sets beside the block, as the review left them ticked. */
export type AlsoSet = { level?: number; name?: string; ac?: number; hpMax?: number; speeds?: Actor["speeds"]; senses?: string; sheetUrl?: string };

/** "Read from D&D Beyond: Bree Tallow, level 5." or "Read from the pasted text." */
export function readLine(fill: PcFill): string {
  if (fill.source === "paste") return "Read from the pasted text.";
  const who = [fill.name, fill.level !== undefined ? `level ${fill.level}` : null].filter((x): x is string => !!x).join(", ");
  return who ? `Read from D&D Beyond: ${who}.` : "Read from D&D Beyond.";
}

function sameSpeeds(a: Actor["speeds"], b: Actor["speeds"]): boolean {
  return a.walk === b.walk && a.fly === b.fly && a.swim === b.swim && a.climb === b.climb && a.burrow === b.burrow && (a.hover ?? false) === (b.hover ?? false);
}

function sensesWords(senses: string): string {
  return senses.trim().replace(/\.$/, "");
}

/** One line per field the fill would change, in the review's order. */
export function alsoLines(fill: PcFill, character: Pick<Character, "name" | "level" | "actor">): AlsoLine[] {
  const actor = character.actor;
  const lines: AlsoLine[] = [];
  if (fill.level !== undefined && fill.level !== character.level) {
    lines.push({ key: "level", text: `Level ${fill.level}, now ${character.level ?? "not set"}`, on: true });
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
  return out;
}

/**
 * The fields a Save sends beside the block (6.1), against the character as
 * it is at Save. Max HP by the companion design's rule (its 5.2): a living
 * character at its maximum stays at its new maximum, and any other keeps
 * its HP, cut to the maximum if higher, so a fill never brings a character
 * back or puts one down and never sets current or temporary HP itself.
 */
export function alsoPatch(also: AlsoSet, character: Pick<Character, "actor">): Pick<CharacterPatch, "name" | "level" | "actor"> {
  const out: Pick<CharacterPatch, "name" | "level" | "actor"> = {};
  if (also.name !== undefined) out.name = also.name;
  if (also.level !== undefined) out.level = also.level;
  const actor: ActorPatch = {};
  if (also.ac !== undefined) actor.ac = also.ac;
  if (also.speeds !== undefined) actor.speeds = also.speeds;
  if (also.senses !== undefined) actor.senses = also.senses;
  if (also.sheetUrl !== undefined) actor.sheetUrl = also.sheetUrl;
  if (also.hpMax !== undefined && also.hpMax !== character.actor.hp.max) {
    const full = character.actor.life === "alive" && character.actor.hp.cur === character.actor.hp.max;
    actor.hp = full ? { max: also.hpMax, cur: also.hpMax } : { max: also.hpMax };
  }
  if (Object.keys(actor).length > 0) out.actor = actor;
  return out;
}

/** Whether a fill set anything beside the block. */
export function alsoAny(also: AlsoSet): boolean {
  return Object.keys(also).length > 0;
}
