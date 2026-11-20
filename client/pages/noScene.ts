import type { RoomState } from "#shared/model.ts";

/**
 * What the map says while a device shows no scene. A DM's room can have
 * scenes and still show none here: the scene this device showed was
 * deleted with the players on it, so the server had no players' scene to
 * land it on (live play 44). "Create a scene" is right only for a room
 * with none.
 */
export function noSceneText(role: "dm" | "player", anyScene: boolean): string {
  if (role !== "dm") return "Waiting for the DM to pick a scene.";
  return anyScene ? "Pick a scene in the Scenes panel." : "Create a scene to get started.";
}

/**
 * The scene a DM device showing none opens: the players' scene once there
 * is one, as Undo setup of the delete or Move players makes it, where a
 * fresh connection would land too. Null while it shows a scene, or has no
 * room yet.
 */
export function sceneToOpen(view: Pick<RoomState, "meta" | "scenes"> | null, role: "dm" | "player", shownSceneId: string | null): string | null {
  if (role !== "dm" || !view || shownSceneId !== null) return null;
  const players = view.meta.playerSceneId;
  return players !== null && view.scenes[players] ? players : null;
}
