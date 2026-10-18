import type { Scene } from "#shared/model.ts";

/**
 * The scene the DM's view goes to once one is deleted: the first of the rest
 * in list order. Scene settings and the scene menu both delete, and both must
 * land the DM on the same scene. Takes the list in display order.
 */
export function sceneAfterDelete(scenes: readonly Scene[], deletedId: string): Scene | undefined {
  return scenes.find((s) => s.id !== deletedId);
}
