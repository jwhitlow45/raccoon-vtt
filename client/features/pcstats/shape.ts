import type { Character } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { pcShape } from "#shared/rules/pcStats.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { whose } from "../tokens/companionBlocks.ts";

/**
 * A shape on a character's own token (docs/design-v1-pc-stats.md 3.6 and
 * 7.3), as plain functions for node --test: the patch that takes or ends
 * one, and the words the section says while it lasts.
 */

export type ShapeKind = "wild" | "other";

/**
 * The kind a picked creature is taken as: always Wild Shape while the character is in it, whatever was chosen
 * before another device put her there, since the choice is hidden then and Polymorph waits for End the shape.
 */
export function effectiveShapeKind(character: Pick<Character, "actor">, chosen: ShapeKind): ShapeKind {
  return pcShape(character) === "wild" ? "wild" : chosen;
}

/**
 * The temporary HP a shape gives by the 2024 rules (W7B-P-9): the Druid
 * level for Wild Shape, and the creature's HP for Polymorph. The Druid level
 * is the one this device remembers picking in Take a shape when there is
 * one, since a multiclassed Druid's differs from the character's, and else
 * the character's level (docs/design-v1-known-forms.md 5.5).
 */
export function shapeTempHp(kind: ShapeKind, character: Pick<Character, "level">, creature: Pick<SrdMonster, "hp">, druidLevel?: number): number {
  return kind === "wild" ? (druidLevel ?? character.level ?? 1) : creature.hp.average;
}

/**
 * Takes a shape in one patch: the creature, the mark for Wild Shape, whose
 * absence is another shape, and the creature's AC and speeds, which the
 * reducer swaps back for the character's own when the shape ends
 * (W7B-P-9). `temp` goes only where it is more than the character holds,
 * since temporary HP never add up.
 */
export function shapePatch(creature: Pick<SrdMonster, "srdId" | "ac" | "speeds">, kind: ShapeKind, character: Pick<Character, "actor">, temp?: number): ActorPatch {
  const patch: ActorPatch = { srdId: creature.srdId, ...(kind === "wild" ? { wildShape: true as const } : {}), ac: creature.ac, speeds: { ...creature.speeds } };
  if (temp !== undefined && temp > character.actor.hp.temp) patch.hp = { temp };
  return patch;
}

/** Ends either shape: clearing the creature takes the mark with it, and the reducer puts the character's AC and speeds back. */
export const END_SHAPE: ActorPatch = { srdId: null };

/**
 * What a character keeps in Wild Shape. Its Intelligence, Wisdom, Charisma
 * and proficiencies are its stat block's, so a character with none takes all
 * of the creature's numbers (docs/design-v1-pc-stats.md 3.6), and the words
 * say so, pointing at the stat block where the viewer may add one.
 */
function noBlockWords(name: string, creature: string, canAdd: boolean): string {
  return `${name} has no stat block, so rolls use all of ${whose(creature)} numbers.${canAdd ? ` Add a stat block to keep ${whose(name)} Intelligence, Wisdom, Charisma and proficiencies.` : ""}`;
}

/** The Wild Shape choice's words, as Take a shape offers it. */
export function wildShapeDetail(character: Pick<Character, "name" | "stats">, creature: string, canAdd: boolean): string {
  if (!character.stats) return noBlockWords(character.name, creature, canAdd);
  return `${character.name} keeps Intelligence, Wisdom, Charisma and proficiencies, and each save and skill takes the higher of the two.`;
}

/** What the section says while the character is in a shape. */
export function shapeNote(character: Pick<Character, "actor" | "name" | "stats">, creature: string, canAdd: boolean): string | null {
  const shape = pcShape(character);
  if (shape === "wild" && !character.stats) return `In Wild Shape as ${creature}. ${noBlockWords(character.name, creature, canAdd)}`;
  if (shape === "wild") return `In Wild Shape as ${creature}. Rolls use its Strength, Dexterity and Constitution, and each save and skill takes the higher.`;
  if (shape === "other") return `In the shape of ${creature}. Rolls use all of its numbers.`;
  return null;
}
