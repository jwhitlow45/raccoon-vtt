import type { MemberId, RoomSettings, RoomState } from "#shared/model.ts";
import { movesAnyToken } from "#shared/permissions.ts";
import { ownsToken } from "../features/tokens/access.ts";
import type { ViewToken } from "../lib/scene.ts";

/**
 * Which tokens this device lets its member drag (Stage.tsx): the server's
 * movement rule (shared/permissions.ts moveCheck) read from the member's
 * projection, so the map never offers a drag the server refuses or refuses
 * one it would take. dragRights.test.ts checks the two against each other.
 *
 * A player's projection of a token they do not own has no `ownerIds` or
 * `visibility`, and holds only tokens they can see, so a missing list means
 * "not theirs" (ownsToken reads it so) and a missing visibility means
 * "visible".
 */

/** The room's leave to move tokens one does not own (RoomSettings.playersMoveAny), on a token players can see. */
export function movesOthers(token: Pick<ViewToken, "visibility">, settings: Partial<Pick<RoomSettings, "playersMoveAny">> | undefined, memberId: MemberId | null): boolean {
  return memberId !== null && movesAnyToken(settings ?? {}, memberId) && (token.visibility ?? "all") === "all";
}

export function canDragToken(input: {
  token: ViewToken;
  role: "dm" | "player";
  memberId: MemberId | null;
  characters: RoomState["characters"] | undefined;
  settings: Partial<Pick<RoomSettings, "playersMoveAny">> | undefined;
}): boolean {
  const { token, role, memberId, characters } = input;
  if (token.locked) return false;
  return role === "dm" || ownsToken(characters && { characters }, memberId, token) || movesOthers(token, input.settings, memberId);
}
