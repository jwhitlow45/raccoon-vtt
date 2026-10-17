import type { Character } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { pcShape } from "#shared/rules/pcStats.ts";

/**
 * A shape on a character's own token (docs/design-v1-pc-stats.md 3.6 and
 * 7.3), as plain functions for node --test: the patch that takes or ends
 * one, and the words the section says while it lasts.
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
