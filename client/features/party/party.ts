import type { Character, Effect, LifeState, RoomState } from "#shared/model.ts";
import { shownLife } from "#shared/rules/hp.ts";
import { hpLabel, type HpLabel } from "../../lib/tokenView.ts";
import { characterToken, partyCharacters } from "../rolls/logic.ts";

/**
 * The party bar (docs/design-v1-dm-tools.md 3.4), the DM's: AC, Passive
 * Perception and HP of every party member at a glance, as plain functions
 * for node --test. The party is the one request a roll asks (rolls/logic.ts
 * partyCharacters): every character a member of kind player owns, in
 * roster order. It reads the DM's view, which holds every character.
 */

/** How many condition chips an entry shows before "+N". */
export const PARTY_CHIPS = 3;

export type PartyEntry = {
  character: Character;
  hp: { cur: number; max: number; temp: number };
  label: HpLabel;
  life: LifeState;
  /** Current over maximum, 0 to 1, for the thin bar. */
  fraction: number;
  ac: number;
  passivePerception: number;
  chips: Effect[];
  /** Effects past the chips, shown as "+N". */
  more: number;
  /** Its token on the scene in view, which a tap frames. Null when it has none there. */
  tokenId: string | null;
};

export function partyEntries(view: Pick<RoomState, "members" | "characters" | "tokens">, sceneId: string | null): PartyEntry[] {
  return partyCharacters(view).map((character) => {
    const actor = character.actor;
    return {
      character,
      hp: actor.hp,
      label: hpLabel(actor),
      // A character with no HP to show is never drawn dying or dead (docs/design-v1-combat-flow.md 3.6.6).
      life: shownLife(actor) ?? "alive",
      fraction: actor.hp.max > 0 ? Math.max(0, Math.min(1, actor.hp.cur / actor.hp.max)) : 0,
      ac: actor.ac,
      passivePerception: actor.passivePerception,
      chips: actor.effects.slice(0, PARTY_CHIPS),
      more: Math.max(0, actor.effects.length - PARTY_CHIPS),
      tokenId: characterToken(view.tokens, character.id, sceneId)?.id ?? null,
    };
  });
}

/** "18/24", with temporary HP as "+5": "18/24 +5". */
export function hpLine(hp: PartyEntry["hp"]): string {
  return `${hp.cur}/${hp.max}${hp.temp > 0 ? ` +${hp.temp}` : ""}`;
}

/** Dying, Stable or Dead take the bar's place. */
export function lifeWord(life: LifeState): string | null {
  return life === "dying" ? "Dying" : life === "stable" ? "Stable" : life === "dead" ? "Dead" : null;
}
