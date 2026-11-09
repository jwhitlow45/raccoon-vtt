import type { Character, Effect, LifeState, RoomState } from "#shared/model.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { hpLess, shownLife } from "#shared/rules/hp.ts";
import { hpLabel, type HpLabel } from "../../lib/tokenView.ts";
import { characterToken, partyCharacters } from "../rolls/logic.ts";

/**
 * The party bar (docs/design/design-v1-dm-tools.md 3.4), the DM's: AC, Passive
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
  /**
   * The AC its shield shows, or null: none for the dead, whose AC answers
   * nothing, or for a character with no HP to show (hpLess), as on its
   * token and in the tracker (docs/design/design-v1-token-panel.md 3.9).
   */
  shield: number | null;
  passivePerception: number;
  chips: Effect[];
  /** Effects past the chips, shown as "+N". */
  more: number;
  /** Its token on the floor in view, which a tap frames. Null when it has none there. */
  tokenId: string | null;
  /**
   * Where it stands instead, on a scene of several floors: its token on
   * another floor of the scene in view, the lowest where it has more, which
   * a tap shows and frames (docs/design/design-v1-floors.md 7.6). Null on
   * the floor in view and off the scene.
   */
  floor: { tokenId: string; sceneId: string; name: string } | null;
};

export function partyEntries(view: Pick<RoomState, "members" | "characters" | "tokens" | "scenes">, sceneId: string | null): PartyEntry[] {
  return partyCharacters(view).map((character) => {
    const actor = character.actor;
    const tokenId = characterToken(view.tokens, character.id, sceneId)?.id ?? null;
    return {
      character,
      hp: actor.hp,
      label: hpLabel(actor),
      // A character with no HP to show is never drawn dying or dead (docs/design/design-v1-combat-flow.md 3.6.6).
      life: shownLife(actor) ?? "alive",
      fraction: actor.hp.max > 0 ? Math.max(0, Math.min(1, actor.hp.cur / actor.hp.max)) : 0,
      ac: actor.ac,
      shield: actor.life === "dead" || hpLess(actor) || !(actor.ac > 0) ? null : actor.ac,
      passivePerception: actor.passivePerception,
      chips: actor.effects.slice(0, PARTY_CHIPS),
      more: Math.max(0, actor.effects.length - PARTY_CHIPS),
      tokenId,
      floor: tokenId === null && sceneId !== null ? otherFloor(view, character.id, sceneId) : null,
    };
  });
}

function otherFloor(view: Pick<RoomState, "tokens" | "scenes">, characterId: string, sceneId: string): PartyEntry["floor"] {
  for (const floor of floorsOf(view, sceneId)) {
    if (floor.id === sceneId || floor.floor === undefined) continue;
    const token = characterToken(view.tokens, characterId, floor.id);
    if (token) return { tokenId: token.id, sceneId: floor.id, name: floor.floor.name };
  }
  return null;
}

/** "18/24", with temporary HP as "+5": "18/24 +5". */
export function hpLine(hp: PartyEntry["hp"]): string {
  return `${hp.cur}/${hp.max}${hp.temp > 0 ? ` +${hp.temp}` : ""}`;
}

/** Dying, Stable or Dead take the bar's place. */
export function lifeWord(life: LifeState): string | null {
  return life === "dying" ? "Dying" : life === "stable" ? "Stable" : life === "dead" ? "Dead" : null;
}
