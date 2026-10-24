import { LIMITS } from "../limits.ts";
import type { UseKey } from "../model.ts";
import { DAMAGE_TYPES, type DamageType } from "../rules/damage.ts";
import { tokenUses, type StatBlockMonster } from "../srd/monsters.ts";
import { blockEntries, entryKeys, nameParts, type SectionKey } from "./named.ts";

/**
 * A stat block's limited uses (docs/design-v1-combat-controls.md 2.1):
 * its legendary actions with their cost and once-a-turn limit, its
 * recharge abilities, its abilities that come back on a rest, its X/Day
 * abilities and its Regeneration. Read from the block's entries, not its
 * rolls, so an X/Day ability or a legendary action with no dice is listed
 * too, under the same key its roll has (named.ts entryKeys). The reducer
 * never reads a block (3.2), so the sending device reads it here and the
 * op carries the facts.
 *
 * Spells stay out: an X/Day spell inside a Spellcasting entry is a spell,
 * while a block's own named X/Day entry is one of its actions, even one
 * that casts a spell, as the archmage's Misty Step (3/Day).
 */

type Base = { key: UseKey; name: string; section: SectionKey };

/** A legendary action: its cost in actions, 1 to 3, and whether it waits until the creature's next turn once taken. */
export type LegendaryUse = Base & { kind: "legendary"; cost: number; once: boolean };
/** "Fire Breath (Recharge 5–6)": the low end of its range, 2 to 6. */
export type RechargeUse = Base & { kind: "recharge"; min: number };
/** "Phantasms (Recharge after a Short or Long Rest)". */
export type RestUse = Base & { kind: "rest" };
/** "Dominate Mind (2/Day)": X, 1 to 9, and whether a Short Rest brings it back too. */
export type DayUse = Base & { kind: "day"; max: number; short: boolean };
/** Regeneration: its heal, the damage types that stop it for a turn, and the HP it needs at the start. */
export type RegenerationUse = Base & { kind: "regeneration"; amount: number; stops: DamageType[]; minHp?: number };

export type LimitedUse = LegendaryUse | RechargeUse | RestUse | DayUse | RegenerationUse;

/** "can't take this action again until the start of its next turn", with either apostrophe. */
const ONCE = /\bcan[’']t take this action again until the start of its next turn\b/i;
/** An X/Day ability whose text gives its uses back on a Short Rest too. */
const SHORT_BACK = /\bregains?\b[^.]*\bshort or long rest\b/i;
const HEALS = /\bregains?\s+(\d+)\s+hit points?\b/i;
const STOPS = /\btakes\s+([a-z]+(?:(?:\s*,\s*(?:or\s+|and\s+)?|\s+or\s+|\s+and\s+)[a-z]+)*)\s+damage\b[^.]*?\bthis trait doesn[’']t function\b/i;
const AT_LEAST_ONE = /\bat least 1 hit point\b/i;
const DAMAGE_WORDS = new Set<string>(DAMAGE_TYPES);

/** The ability's name as an op carries it: without its brackets, one line, at most `LIMITS.useNameChars`. */
function useName(printed: string, cleaned: string): string {
  const name = (cleaned || printed).replace(/\s+/g, " ").trim();
  return name.length <= LIMITS.useNameChars ? name : `${name.slice(0, LIMITS.useNameChars - 1).trimEnd()}…`;
}

function regeneration(base: Base, text: string): RegenerationUse | null {
  const heals = HEALS.exec(text);
  const amount = heals ? Number(heals[1]) : 0;
  if (amount < 1 || amount > LIMITS.regenerateMax) return null;
  const stops: DamageType[] = [];
  const stop = STOPS.exec(text);
  if (stop) {
    const named = new Set(stop[1]!.toLowerCase().split(/\s*,\s*|\s+or\s+|\s+and\s+/).map((w) => w.replace(/^(?:or|and)\s+/, "").trim()));
    for (const type of DAMAGE_TYPES) if (named.has(type) && DAMAGE_WORDS.has(type)) stops.push(type);
  }
  return { ...base, kind: "regeneration", amount, stops, ...(AT_LEAST_ONE.test(text) ? { minHp: 1 } : {}) };
}

const read = new WeakMap<StatBlockMonster, readonly LimitedUse[]>();

/** Every limited use of a block, in the block's order, read once per view object. */
export function limitedUses(view: StatBlockMonster): readonly LimitedUse[] {
  const cached = read.get(view);
  if (cached) return cached;
  const keys = entryKeys(view);
  const out: LimitedUse[] = [];
  blockEntries(view).forEach((entry, i) => {
    // A Spellcasting entry's X/Day items are spells, whatever its brackets say. A named action that casts, such as the pit fiend's Hellfire Spellcasting (Recharge 4–6), is the block's own.
    if (/^(?:innate )?spellcasting\b/i.test(entry.name)) return;
    const parts = nameParts(entry.name);
    const base: Base = { key: keys[i]!, name: useName(entry.name, parts.name), section: entry.section };
    if (entry.section === "legendaryActions") {
      // "Legendary Action Uses: 3 (4 in Lair)" opens the section with the counts, which the actor holds.
      if (/^legendary action uses\b/i.test(entry.name)) return;
      out.push({ ...base, kind: "legendary", cost: Math.min(3, Math.max(1, parts.cost ?? 1)), once: ONCE.test(entry.text) });
      return;
    }
    if (entry.section === "traits" && /^regeneration\b/i.test(parts.name)) {
      const regen = regeneration(base, entry.text);
      if (regen) out.push(regen);
      return;
    }
    if (parts.recharge !== undefined) {
      out.push({ ...base, kind: "recharge", min: parts.recharge });
      return;
    }
    if (parts.rest) {
      out.push({ ...base, kind: "rest" });
      return;
    }
    // Legendary Resistance's "(3/Day, or 4/Day in Lair)" is the actor's own count, spent through its own kind of use.
    if (parts.perDay !== undefined && parts.perDay >= 1 && parts.perDay <= LIMITS.usesPerDay && !/^legendary resistance\b/i.test(parts.name)) {
      out.push({ ...base, kind: "day", max: parts.perDay, short: SHORT_BACK.test(entry.text) });
    }
  });
  read.set(view, out);
  return out;
}

/** The block's Regeneration, or null. */
export function regenerationOf(view: StatBlockMonster): RegenerationUse | null {
  return limitedUses(view).find((u): u is RegenerationUse => u.kind === "regeneration") ?? null;
}

/**
 * A creature's legendary counts and XP, in its lair or not, as placement
 * reads them (srd/monsters.ts monsterActor), for In lair's `counts`
 * (docs/design-v1-combat-controls.md 3.1). A count past what an actor holds
 * is capped, as placement caps it.
 */
export function lairCounts(view: StatBlockMonster, inLair: boolean): { actionsMax: number; resistMax: number; xp: number } {
  const pick = (uses: { uses: number; usesInLair?: number } | undefined) => (uses ? tokenUses(inLair ? (uses.usesInLair ?? uses.uses) : uses.uses) : 0);
  return { actionsMax: pick(view.legendaryActions), resistMax: pick(view.legendaryResistance), xp: inLair ? (view.xpInLair ?? view.xp) : view.xp };
}

/** Whether a block's counts change in its lair: its legendary uses or its XP. */
export function hasLair(view: StatBlockMonster): boolean {
  const base = lairCounts(view, false);
  const lair = lairCounts(view, true);
  return base.actionsMax !== lair.actionsMax || base.resistMax !== lair.resistMax || base.xp !== lair.xp;
}
