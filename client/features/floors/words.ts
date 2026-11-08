import type { RoomState } from "#shared/model.ts";
import { sameScene } from "#shared/rules/floors.ts";
import { ownEntry } from "#shared/records.ts";

/*
 * The one helper every site that names the players' place uses
 * (docs/design/design-v1-floors.md 18.6, FLR32-OPUS-06): a lost move,
 * Follow me's note, Move players here and Show players, the guarded
 * reveal's refusal, the DM panel's Players' screens, a pin's help.
 */

type Scenes = Pick<RoomState, "scenes">;

/** A floor's place: "Tower · Upper floor" on a scene with floors, the scene's name on one without, "" when it is gone. */
export function placeName(state: Scenes, sceneId: string): string {
  const scene = ownEntry(state.scenes, sceneId);
  if (scene === undefined) return "";
  return scene.floor ? `${scene.name} · ${scene.floor.name}` : scene.name;
}

/**
 * The players' place seen from the floor in view: "another floor" when the
 * two are floors of one scene, else `placeName` of the players' floor.
 */
export function playersPlace(state: Scenes, playersId: string, viewingId: string | null): string {
  if (viewingId !== null && viewingId !== playersId && sameScene(state, playersId, viewingId)) return "another floor";
  return placeName(state, playersId);
}

/** "floor" when the two ids name floors of one scene, else "scene", for words such as "the players are on another scene now". */
export function placeKind(state: Scenes, a: string, b: string): "floor" | "scene" {
  return a !== b && sameScene(state, a, b) ? "floor" : "scene";
}
