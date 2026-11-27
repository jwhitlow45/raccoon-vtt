/**
 * Whether a token a drag moves has left the board under it: gone from
 * the room this copy holds, or standing on another scene or floor than
 * the board's. Another device's undo of a climb, the DM moving it to
 * another floor, or a delete does that while the drag goes on, and a
 * drop then would land it at the drag's spot on its new floor, through
 * whatever walls stand there (LP54-DRAG-1).
 */
export function dragLeftBoard(tokens: Readonly<Record<string, { sceneId: string } | undefined>> | undefined, boardSceneId: string, ids: Iterable<string>): boolean {
  for (const id of ids) {
    const now = tokens && Object.hasOwn(tokens, id) ? tokens[id] : undefined;
    if (!now || now.sceneId !== boardSceneId) return true;
  }
  return false;
}
