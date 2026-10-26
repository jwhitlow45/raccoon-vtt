import { api, type LogPage } from "../lib/api.ts";

/** What a page that could not be taken says, as any page that failed to load does. */
export const OLDER_LOG_FAILED = "Could not load older messages.";

/**
 * One older page of the Log panel's log. A DM's pages follow the scene on
 * screen (`sceneId`). In "view as a player" (`previewOf`,
 * docs/design-v1-per-player-vision.md 7.4, D-261026-10) the page is asked
 * for as that player and taken only when the server says it answered as
 * that player, as the preview's socket takes only that player's snapshot:
 * a page without the answer, or answered as anyone else, is refused, so a
 * server that ignores `as` never shows the DM's own lines, whispers and
 * hidden rolls as the player's.
 */
export async function olderLogPage(roomId: string, before: string, viewer: { sceneId: string | null; previewOf: string | null }): Promise<LogPage> {
  const page = await api.getLog(roomId, { before, sceneId: viewer.sceneId, ...(viewer.previewOf !== null ? { as: viewer.previewOf } : {}) });
  if (viewer.previewOf !== null && page.as !== viewer.previewOf) throw new Error(OLDER_LOG_FAILED);
  return page;
}
