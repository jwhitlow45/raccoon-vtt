import type { Scene } from "#shared/model.ts";

/**
 * The scene the DM's view goes to once one is deleted: the first of the rest
 * in list order. Scene settings and the scene menu both delete, and both must
 * land the DM on the same scene. Takes the list in display order.
 */
export function sceneAfterDelete(scenes: readonly Scene[], deletedId: string): Scene | undefined {
  return scenes.find((s) => s.id !== deletedId);
}

export const LAST_SCENE = "The last scene cannot be deleted.";

/**
 * Why a scene cannot be deleted now, in the words both delete controls
 * show, or null when it can. Only the last scene never can. The players'
 * scene can, once the DM says yes to leaving them with no map
 * (leavesPlayers).
 */
export function deleteBlocked(scenes: readonly Scene[], sceneId: string): string | null {
  return sceneAfterDelete(scenes, sceneId) ? null : LAST_SCENE;
}

/**
 * Whether deleting a scene leaves the players with no map: they start on it
 * or on one of its floors (`floorIds`), since a delete removes every floor
 * (docs/design/design-v1-floors.md 7.1). Such a delete asks first
 * (shared/limits.ts LEAVE_PLAYERS_ASK) and goes with `leavePlayers`, which
 * the server needs before it deletes the players' map. It never sends them
 * to whichever scene comes first, which could be one the DM prepares in
 * private (LP9-PLAY-2).
 */
export function leavesPlayers(sceneId: string, playerSceneId: string | null, floorIds: readonly string[] = [sceneId]): boolean {
  return playerSceneId !== null && (sceneId === playerSceneId || floorIds.includes(playerSceneId));
}
