import { useMemo } from "react";
import { creatureNumbers, type RollNumbers } from "#shared/dice/bonus.ts";
import { useDiceView } from "../dice/useDiceView.ts";

const NONE: readonly never[] = [];

/**
 * The numbers a character rolls with as the server works them out (doc 1's
 * creatureNumbers over doc 3's SRD table), so a shape's saves on the bar
 * and in its section are the bonuses its rolls get
 * (docs/design-v1-pc-stats.md 3.6 and 7.4). The table loads only for a
 * character in a shape. `loading` while it does, `failed` when it did not.
 */
export function useCharacterRollNumbers(characterId: string | null): { numbers: RollNumbers | null; loading: boolean; failed: boolean } {
  const creatures = useMemo(() => (characterId === null ? NONE : [{ characterId }]), [characterId]);
  const { dice, failed } = useDiceView(creatures);
  return useMemo(() => {
    if (characterId === null || !dice) return { numbers: null, loading: false, failed: false };
    const character = dice.view.characters[characterId];
    if (!character) return { numbers: null, loading: false, failed: false };
    const shaped = character.actor.srdId !== undefined;
    if (shaped && dice.srd.rolls === null) return { numbers: null, loading: !failed, failed };
    const { view } = dice;
    const numbers = creatureNumbers({ tokens: view.tokens, characters: view.characters, companionBlocks: view.companionBlocks, monsters: view.monsters, srd: dice.srd.rolls }, { characterId });
    return { numbers, loading: false, failed: false };
  }, [characterId, dice, failed]);
}
