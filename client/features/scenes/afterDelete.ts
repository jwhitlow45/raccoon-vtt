import type { Scene } from "#shared/model.ts";
import { MOVE_PLAYERS_FIRST } from "#shared/permissions.ts";

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
 * show, or null when it can. The last scene never can. The players' scene
 * can once they are moved, since deleting it would send them to whichever
 * scene comes first, and the server refuses it with the same words.
 */
export function deleteBlocked(scenes: readonly Scene[], sceneId: string, playerSceneId: string | null): string | null {
  if (!sceneAfterDelete(scenes, sceneId)) return LAST_SCENE;
  return sceneId === playerSceneId ? MOVE_PLAYERS_FIRST : null;
}
