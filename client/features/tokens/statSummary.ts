import type { AbilityKey, Actor, CompanionBlock, CustomMonster, HpVisibility, LifeState, StatBlock, TokenKind } from "#shared/model.ts";
import { ABILITY_KEYS } from "#shared/model.ts";
import { hpLess } from "#shared/rules/hp.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { ABILITY_ABBR } from "#shared/rules/skills.ts";
import { signed, SPEED_WORDS, statBlockFromSrd, statBlockOf } from "#shared/statBlock.ts";
import { shieldAc } from "../../canvas/tokenMarks.ts";
import { hpDisplay, type HpView } from "../../lib/tokenView.ts";
import { tokenStatBlock } from "../monsters/statBlockLink.ts";

/*
 * The stat summary's rules (docs/design-v1-token-panel.md 3.2), as plain
 * functions for node --test: what a tap on a token tells its viewer before
 * anything else. AC, HP, speeds and Passive Perception come from the
 * viewer's own copy of the actor, so the summary can never show what the
 * projection held back. Saves and defenses come from the token's linked
 * stat block, where this viewer may read it.
 */

/** https only and at most 500 characters, as the protocol and design 10.7 require. */
export function validSheetUrl(raw: string): string | null {
  const text = raw.trim();
  if (text.length > 500) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * One piece of the vitals line that never breaks inside. A line breaks
 * only between units, and no unit is wider than about 140 px at 14 px
 * text, so the line fits the narrowest box it shows in (3.12).
 */
export type VitalUnit =
  /** The AC shield holding the number. */
  | { kind: "ac"; ac: number }
  /** A muted label and a value at weight 600, such as "Speed" "30 ft", with the comma that joins it to the next mode. */
  | { kind: "text"; label?: string; value: string; comma?: boolean; tone?: "temp" | "muted" }
  /** The life tag after the HP: Dying, Stable or Dead. */
  | { kind: "tag"; text: string; tone: "danger" | "warning" }
  /** "Sheet" and the new tab icon, a link as tall as the line's text with a 44 px touch target (SheetLink.tsx). */
  | { kind: "sheet"; url: string };

export type VitalKey = "ac" | "hp" | "speed" | "passivePerception" | "sheet";

export type VitalItem = { key: VitalKey; units: VitalUnit[] };

/** A unit's words as a screen shows them, for measuring and for tests. */
export function unitText(unit: VitalUnit): string {
  switch (unit.kind) {
    case "ac":
      return String(unit.ac);
    case "text":
      return `${unit.label ? `${unit.label} ` : ""}${unit.value}${unit.comma ? "," : ""}`;
    case "tag":
      return unit.text;
    case "sheet":
      return "Sheet ↗";
  }
}

const LIFE_WORD: Record<LifeState, string> = { alive: "", dying: "Dying", stable: "Stable", dead: "Dead" };

const SPEED_MODES = ["fly", "swim", "climb", "burrow"] as const;

/**
 * A creature's speeds, walk first, one unit per mode: "Speed 30 ft," then
 * "Fly 60 ft (hover)," then "Swim 30 ft". A line may start at any mode,
 * so four or five modes wrap between them and never run out of the box.
 */
export function speedUnits(speeds: Partial<Actor["speeds"]> | undefined): VitalUnit[] {
  if (!speeds || typeof speeds.walk !== "number") return [];
  const parts: { label: string; value: string }[] = [{ label: "Speed", value: `${speeds.walk} ft` }];
  for (const mode of SPEED_MODES) {
    const ft = speeds[mode];
    if (typeof ft !== "number" || ft <= 0) continue;
    parts.push({ label: SPEED_WORDS[mode], value: `${ft} ft${mode === "fly" && speeds.hover ? " (hover)" : ""}` });
  }
  return parts.map((p, i) => ({ kind: "text", label: p.label, value: p.value, comma: i < parts.length - 1 }));
}

/**
 * The HP item, the same words and life tag the bar's HP line has always
 * shown: "HP 22/30", the temporary HP "+5" and the tag as separate units
 * for a viewer with the numbers, "HP about 25%" for a bar, or the label
 * alone ("Bloodied", "Dying") for a viewer who sees labels.
 */
export function hpUnits(input: { actor: HpView | undefined; hpVisibility: HpVisibility | undefined; fullAccess: boolean }): VitalUnit[] {
  const display = hpDisplay(input);
  const life = input.actor?.life ?? "alive";
  if (display.kind === "none") return [];
  // A label already says Dying or Dead, so the life state stands in for it rather than beside it.
  if (display.kind === "label") return [{ kind: "text", value: LIFE_WORD[life] || display.label, tone: "muted" }];
  const units: VitalUnit[] = [];
  const hp = input.actor?.hp;
  if (display.text !== undefined && hp) {
    units.push({ kind: "text", label: "HP", value: `${hp.cur}/${hp.max}` });
    if (hp.temp > 0) units.push({ kind: "text", value: `+${hp.temp}`, tone: "temp" });
  } else {
    units.push({ kind: "text", label: "HP", value: `about ${Math.round(display.fraction * 100)}%` });
  }
  const word = LIFE_WORD[life];
  if (word) units.push({ kind: "tag", text: word, tone: life === "stable" ? "warning" : "danger" });
  return units;
}

/**
 * The vitals, in order: AC, HP (the bar only, since the panel has its own
 * section), speed, Passive Perception, and the sheet link last.
 * Each item shows only when the viewer's copy holds it, and AC, speed and
 * Passive Perception only on a creature. An object's summary is its HP
 * alone, and nothing shows HP or AC while `hpLess` holds.
 */
export function vitals(input: {
  actor: (Partial<Actor> & HpView) | undefined;
  token: { kind: TokenKind; companion?: unknown; hpVisibility?: HpVisibility };
  fullAccess: boolean;
  place: "bar" | "panel";
}): VitalItem[] {
  const { actor, token, place } = input;
  const items: VitalItem[] = [];
  const creature = token.kind !== "object";
  const noHp = hpLess(actor, token);
  const ac = shieldAc(token, actor);
  if (ac !== null) items.push({ key: "ac", units: [{ kind: "ac", ac }] });
  if (place === "bar" && !noHp) {
    const hp = hpUnits({ actor, hpVisibility: token.hpVisibility, fullAccess: input.fullAccess });
    if (hp.length > 0) items.push({ key: "hp", units: hp });
  }
  if (creature) {
    const speed = speedUnits(actor?.speeds);
    if (speed.length > 0) items.push({ key: "speed", units: speed });
    if (typeof actor?.passivePerception === "number") {
      items.push({ key: "passivePerception", units: [{ kind: "text", label: "Passive Perception", value: String(actor.passivePerception) }] });
    }
  }
  const url = actor?.sheetUrl ? validSheetUrl(actor.sheetUrl) : null;
  if (url) items.push({ key: "sheet", units: [{ kind: "sheet", url }] });
  return items;
}

/**
 * A short bar's split (3.3): AC and HP stay on the vitals line, so it
 * keeps to one line for any ordinary number, and speed and Passive
 * Perception join the saves and defenses in "More stats".
 */
export function shortSplit(items: readonly VitalItem[]): { line: VitalItem[]; more: VitalItem[] } {
  return {
    line: items.filter((i) => i.key === "ac" || i.key === "hp" || i.key === "sheet"),
    more: items.filter((i) => i.key === "speed" || i.key === "passivePerception"),
  };
}

/** The six saves in the block's own numbers and minus sign: "STR +5", "DEX −1". All six, since any of them can be called for. */
export function saveUnits(block: Pick<StatBlock, "abilities">): string[] {
  return ABILITY_KEYS.map((k) => `${ABILITY_ABBR[k]} ${signed(block.abilities[k].save)}`);
}

/** The same from the numbers a creature rolls with, such as a player character's stat block's (docs/design-v1-pc-stats.md 7.4). */
export function saveUnitsOf(saves: Readonly<Record<AbilityKey, number>>): string[] {
  return ABILITY_KEYS.map((k) => `${ABILITY_ABBR[k]} ${signed(saves[k])}`);
}

export type DefenseLine = { label: "Vulnerabilities" | "Resistances" | "Immunities"; text: string };

/** The block's defenses in the 2024 block's words and order, each only when it says something. */
export function defenseLines(block: Pick<StatBlock, "vulnerabilities" | "resistances" | "immunities">): DefenseLine[] {
  const lines: DefenseLine[] = [];
  if (block.vulnerabilities.trim()) lines.push({ label: "Vulnerabilities", text: block.vulnerabilities.trim() });
  if (block.resistances.trim()) lines.push({ label: "Resistances", text: block.resistances.trim() });
  if (block.immunities.trim()) lines.push({ label: "Immunities", text: block.immunities.trim() });
  return lines;
}

/**
 * Where the saves and defenses stand: no block to read, the SRD chunk on
 * its way, its load failed, or the block. A player character's own stat
 * block gives its numbers and defense lines instead (docs/design-v1-pc-stats.md 7.4).
 */
export type LinkedBlock =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; block: StatBlock }
  | { kind: "numbers"; saves: Readonly<Record<AbilityKey, number>>; defenses: readonly DefenseLine[] };

// The SRD's blocks are fixed once the chunk loads, so each is read once a page.
const srdBlocks = new WeakMap<SrdMonster, StatBlock | null>();

function srdBlock(monster: SrdMonster): StatBlock | null {
  if (srdBlocks.has(monster)) return srdBlocks.get(monster) ?? null;
  let block: StatBlock | null;
  try {
    block = statBlockFromSrd(monster);
  } catch {
    // The shipped SRD never throws here (its tests read all 330), but a block that cannot be read has no saves to show.
    block = null;
  }
  srdBlocks.set(monster, block);
  return block;
}

/** A companion's stored block without its entity fields, once per version, so a bar that draws it again gets the same object. */
const storedBlocks = new WeakMap<CompanionBlock, StatBlock>();

function storedBlock(stored: CompanionBlock): StatBlock {
  let block = storedBlocks.get(stored);
  if (!block) {
    const { id: _id, rev: _rev, characterId: _of, fromSrd: _from, ...lines } = stored;
    block = lines;
    storedBlocks.set(stored, block);
  }
  return block;
}

/**
 * The block behind a token's link (statBlockLink.ts tokenStatBlock): a
 * room monster's or a companion's stored block at once, from the view, an
 * SRD monster's once its chunk has loaded. A link to a deleted block, an
 * SRD id the chunk lacks and a block that does not read all count as none.
 */
export function linkedBlockState(
  link: Pick<Actor, "srdId" | "monsterId" | "blockId"> | undefined,
  monsters: Readonly<Record<string, CustomMonster | undefined>> | undefined,
  srd: { list: readonly SrdMonster[] | null; failed: boolean },
  blocks?: Readonly<Record<string, CompanionBlock | undefined>>,
): LinkedBlock {
  const target = tokenStatBlock(link, monsters, blocks);
  if (target.kind === "room") return { kind: "ready", block: statBlockOf(target.monster) };
  if (target.kind === "block") return { kind: "ready", block: storedBlock(target.block) };
  if (target.kind !== "srd") return { kind: "none" };
  if (srd.list === null) return srd.failed ? { kind: "failed" } : { kind: "loading" };
  const monster = srd.list.find((m) => m.srdId === target.srdId);
  const block = monster ? srdBlock(monster) : null;
  return block ? { kind: "ready", block } : { kind: "none" };
}

/**
 * Whether a short bar's "More stats" has anything to hold: speed, Passive
 * Perception, or a block's saves and defenses, loading or loaded. A
 * creature with none of them has no disclosure.
 */
export function moreStatsShown(more: readonly VitalItem[], block: LinkedBlock): boolean {
  return more.length > 0 || block.kind !== "none";
}
