import { blockRollNumbers, type RollNumbers } from "#shared/dice/bonus.ts";
import type { Character, StatBlock } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { pcShape, shapedNumbers } from "#shared/rules/pcStats.ts";

/**
 * A shape on a character's own token (docs/design-v1-pc-stats.md 3.6 and
 * 7.3), as plain functions for node --test: the patch that takes or ends
 * one, the words the section says while it lasts, and the saves the bar
 * shows from the creature's block until doc 3's SRD table reaches the
 * client.
 */

export type ShapeKind = "wild" | "other";

/** Takes a shape in one patch: the creature, and the mark for Wild Shape, whose absence is another shape. */
export function shapePatch(srdId: string, kind: ShapeKind): ActorPatch {
  return kind === "wild" ? { srdId, wildShape: true } : { srdId };
}

/** Ends either shape: clearing the creature takes the mark with it. */
export const END_SHAPE: ActorPatch = { srdId: null };

/** What the section says while the character is in a shape. */
export function shapeNote(character: Pick<Character, "actor">, creature: string): string | null {
  const shape = pcShape(character);
  if (shape === "wild") return `In Wild Shape as ${creature}. Rolls use its Strength, Dexterity and Constitution, and each save and skill takes the higher.`;
  if (shape === "other") return `In the shape of ${creature}. Rolls use all of its numbers.`;
  return null;
}

/**
 * The numbers a shaped character rolls with, from the creature's block:
 * mixed with the character's in Wild Shape with a stat block, else the
 * creature's own (doc 1's dispatch, shared/dice/bonus.ts creatureNumbers).
 */
export function shapedRollNumbers(character: Pick<Character, "actor" | "stats" | "level">, creature: StatBlock): RollNumbers {
  const beast = blockRollNumbers(creature);
  if (pcShape(character) === "wild" && character.stats) return shapedNumbers(character, beast) ?? beast;
  return beast;
}
