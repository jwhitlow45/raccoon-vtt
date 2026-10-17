import type { RoomState } from "../model.ts";
import { playerPlays, playersToken } from "../project.ts";
import type { ActorTarget } from "../protocol.ts";

/**
 * Whether a player plays the creature a roll is for: a character a player
 * owns, or one of its tokens a player owns, or a token a player owns or
 * whose character a player owns. A creature that is gone counts as no
 * player's, so a roll for it never starts in the open.
 */
export function playedCreature(state: Pick<RoomState, "members" | "characters" | "tokens">, target: ActorTarget): boolean {
  if ("characterId" in target) {
    const character = state.characters[target.characterId];
    return character !== undefined && playerPlays(state, { character });
  }
  const token = state.tokens[target.tokenId];
  return token !== undefined && playersToken(state, token);
}

/**
 * Whether a roll starts hidden from players (docs/design-v1-dice.md 17,
 * the project owner, 2026-10-17): only a DM's roll for a monster, a
 * creature no player plays, so the table never learns its numbers by
 * default. A free formula and a roll for a creature a player plays start
 * in the open, and the roll's own Secret hides one. A player's roll always
 * starts in the open. A roll for several creatures starts hidden when any
 * of them is a monster.
 */
export function startsSecret(state: Pick<RoomState, "members" | "characters" | "tokens">, dm: boolean, creatures: readonly ActorTarget[]): boolean {
  return dm && creatures.some((c) => !playedCreature(state, c));
}

/**
 * The DC a dice line may carry (W7-SOL-01). A line open to everyone gives
 * its DC to every player, so a DC they may not see stays off it: a
 * save-ends effect's, which only the DM's view holds, a concentration
 * check's, which tells the damage to whoever lacks the creature's exact HP,
 * or a group save's the DM keeps from players. The device that rolled
 * compares the total with the DC itself. A secret line reaches only the
 * DMs and its roller, who had the DC to send.
 */
export function dcOnLine(to: "all" | "dm", dc: number | undefined, playersSee: boolean): number | undefined {
  return dc !== undefined && (to === "dm" || playersSee) ? dc : undefined;
}
