import type { Character } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { pcShape } from "#shared/rules/pcStats.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";

/**
 * A shape on a character's own token (docs/design-v1-pc-stats.md 3.6 and
 * 7.3), as plain functions for node --test: the patch that takes or ends
 * one, and the words the section says while it lasts.
 */

export type ShapeKind = "wild" | "other";

/**
 * The temporary HP a shape gives by the 2024 rules (W7B-P-9): the Druid
 * level for Wild Shape, read as the character's level, and the creature's
 * HP for Polymorph.
 */
export function shapeTempHp(kind: ShapeKind, character: Pick<Character, "level">, creature: Pick<SrdMonster, "hp">): number {
  return kind === "wild" ? (character.level ?? 1) : creature.hp.average;
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

/** What the section says while the character is in a shape. */
export function shapeNote(character: Pick<Character, "actor">, creature: string): string | null {
  const shape = pcShape(character);
  if (shape === "wild") return `In Wild Shape as ${creature}. Rolls use its Strength, Dexterity and Constitution, and each save and skill takes the higher.`;
  if (shape === "other") return `In the shape of ${creature}. Rolls use all of its numbers.`;
  return null;
}
