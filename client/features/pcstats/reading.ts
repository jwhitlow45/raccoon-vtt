import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { PcRoll, PcStats } from "#shared/model.ts";
import { DAMAGE_TYPES, type DamageType } from "#shared/rules/damage.ts";
import { namedRollOf, partFormula, pcDefenses, pcDerived, rollMod, type PcNumber, type PcPart } from "#shared/rules/pcStats.ts";
import type { Defense } from "#shared/dice/defenses.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";
import { signed } from "#shared/statBlock.ts";
import type { DefenseLine } from "../tokens/statSummary.ts";

/**
 * A character's stat block in words (docs/design-v1-pc-stats.md 7.3), for
 * its view, the editor's rows and the bar's defense lines. Plain strings,
 * which the view renders as React text, so a later tap to roll can turn a
 * number into a button.
 */

/** A part as the editor's hint lists it: "DEX +2", "PB +3", and a fixed part as its value: "8". */
export function partText(part: PcPart): string {
  return part.fixed ? String(part.value) : `${part.label} ${signed(part.value)}`;
}

/** A number's parts: "DEX +2, PB +3, other +1". */
export function partsText(number: PcNumber): string {
  return number.parts.map(partText).join(", ");
}

/** The roll's dice in words: each part with its type, a rider by its name, healing, and what a higher slot adds. */
function diceText(named: NamedRoll): string[] {
  const out: string[] = [];
  const above = named.section === "spells" && named.level !== undefined && named.level >= 1 ? ` for each slot level above ${named.level}` : null;
  for (const part of named.damage) {
    const words = part.optional ? `+${part.formula} ${part.type ?? ""}${part.name ? ` ${part.name}` : ""}`.replace(/\s+/g, " ").trim() : `${part.formula}${part.type ? ` ${part.type}` : ""}`;
    out.push(words);
    if (part.upcast && above) out.push(`+${part.upcast}${above}`);
  }
  if (named.heal) {
    out.push(`${named.heal.formula} healing`);
    if (named.heal.upcast && above) out.push(`+${named.heal.upcast} healing${above}`);
  }
  if (named.dice) out.push(named.dice);
  return out;
}

/** What a roll does: "+6 to hit, 1d8+3 slashing", "DC 13 Dexterity save, 8d6 fire, +1d6 for each slot level above 3". */
export function rollReading(stats: PcStats, level: number | undefined, roll: PcRoll): string {
  const named = namedRollOf(stats, level, roll);
  const out: string[] = [];
  if (named.attack !== undefined) out.push(`${signed(named.attack)} to hit`);
  if (named.save) out.push(`DC ${named.save.dc} ${ABILITY_NAMES[named.save.ability]} save`);
  out.push(...diceText(named));
  // A formula that stopped reading, under a later grammar, shows as typed and offers no roll.
  const mod = rollMod(stats, pcDerived(stats, level), roll);
  for (const part of roll.dice) if (partFormula(part, mod, level) === null) out.push(part.formula);
  return out.join(", ");
}

/** A roll's name as the view lists it: "Fireball (level 3)", "Fire Bolt (cantrip)", a weapon or other roll by its name. */
export function rollTitle(roll: Pick<PcRoll, "name" | "kind" | "level">): string {
  if (roll.kind !== "spell" || roll.level === undefined) return roll.name;
  return roll.level === 0 ? `${roll.name} (cantrip)` : `${roll.name} (level ${roll.level})`;
}

const KIND_LABEL: Record<Defense["kind"], DefenseLine["label"]> = { vulnerable: "Vulnerabilities", resist: "Resistances", immune: "Immunities" };

function capital(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** Damage defenses in the 2024 block's words and order, as the bar's defense lines read a block's. */
export function defenseLinesOf(defenses: readonly Defense[]): DefenseLine[] {
  const lines: DefenseLine[] = [];
  for (const kind of ["vulnerable", "resist", "immune"] as const) {
    const types = defenses.filter((d): d is Defense & { of: DamageType } => d.kind === kind && (DAMAGE_TYPES as readonly string[]).includes(d.of)).map((d) => d.of);
    types.sort((a, b) => DAMAGE_TYPES.indexOf(a) - DAMAGE_TYPES.indexOf(b));
    if (types.length > 0) lines.push({ label: KIND_LABEL[kind], text: types.map(capital).join(", ") });
  }
  return lines;
}

/** A character's damage defenses as its rolls take them: none while it is in a shape, whose block gives its own. */
export function pcDefenseLines(character: Parameters<typeof pcDefenses>[0]): DefenseLine[] {
  return defenseLinesOf(pcDefenses(character).defenses);
}

