import type { RoomState, Token } from "./model.ts";
import { ownEntry } from "./records.ts";

/*
 * Who plays a creature, apart from shared/project.ts so the modules
 * project.ts imports can ask it too (shared/numbering.ts).
 */

/**
 * Whether a player, not a DM, is among these owners. A DM may own a
 * creature, and a player made DM keeps the ids of what they owned, so an
 * owner id alone does not make a creature a player's.
 */
export function anyPlayer(state: Pick<RoomState, "members">, ids: readonly string[] | undefined): boolean {
  return ids?.some((id) => ownEntry(state.members, id)?.kind === "player") ?? false;
}

/**
 * The derived `party` flag (docs/design/design-v1-dm-tools.md 3.1): a member of
 * kind player owns the token or its character. Not `playerOwned`, which
 * counts a DM owner too, and not `partyVision`, which lends sight without a
 * player. Who plays which character is no secret at the table.
 */
export function playersToken(state: Pick<RoomState, "members" | "characters">, token: Pick<Token, "ownerIds" | "actor">): boolean {
  if (anyPlayer(state, token.ownerIds)) return true;
  const character = "ref" in token.actor ? ownEntry(state.characters, token.actor.ref) : undefined;
  return character !== undefined && anyPlayer(state, character.ownerIds);
}
