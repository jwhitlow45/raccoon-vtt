import type { Character, CharacterId } from "#shared/model.ts";
import { slotsOf } from "#shared/rules/spellSlots.ts";

/**
 * Where a character's slot rows stand (docs/design/design-v1-slots.md 3.2):
 * `full` is one class resource row per slot level, `folded` the turn card's
 * and the phone's drawer's one "Spell slots" row, and `drawer` the folded
 * row with Restore a slot… too.
 */
export type SlotForm = "full" | "folded" | "drawer";

/** The contract for lane B: the rows come in its build. Until then a character's slots draw nothing. */
export function SlotRows(_props: { characterId: CharacterId; form: SlotForm; label: string }) {
  return null;
}

/**
 * How many rows a character's slots count toward `usesCount`, which admits
 * the turn card (D-261127-266, 360): the slot group as 1 and Pact Magic as 1.
 */
export function slotRowCount(character: Pick<Character, "classes"> | undefined): number {
  if (!character?.classes) return 0;
  const { slots, pact } = slotsOf(character.classes);
  return (slots.some((count) => count > 0) ? 1 : 0) + (pact ? 1 : 0);
}
