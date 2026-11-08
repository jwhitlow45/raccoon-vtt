import { LIMITS } from "#shared/limits.ts";
import type { Character, RoomState, Scene } from "#shared/model.ts";
import { floorsOf, onPlayersScene } from "#shared/rules/floors.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import type { TokenInput } from "#shared/protocol.ts";
import { ownsCharacter } from "./access.ts";
import { characterToken, occupiedBoxes, sizeFootprint, spreadPositions, type Point } from "./factory.ts";

/**
 * A player's own characters, when the room lets players create them
 * (`playersCreateCharacters`, features 15). The server decides for real
 * (shared/permissions.ts). These only keep the buttons honest about it.
 */

type View = Pick<RoomState, "meta" | "characters" | "tokens" | "scenes">;

/** Whether this player may make another character now, and why not when they may not. */
export function newCharacterState(view: View, memberId: string): { allowed: true } | { allowed: false; reason: "off" | "full" } {
  if (view.meta.settings.playersCreateCharacters !== true) return { allowed: false, reason: "off" };
  const owned = Object.values(view.characters).filter((c) => !!c && ownsCharacter(memberId, c)).length;
  return owned >= LIMITS.charactersPerPlayer ? { allowed: false, reason: "full" } : { allowed: true };
}

/** Whether the character already has a token on the scene. */
export function onScene(view: Pick<RoomState, "tokens">, characterId: string, sceneId: string): boolean {
  return Object.values(view.tokens).some((t) => !!t && t.sceneId === sceneId && "ref" in t.actor && t.actor.ref === characterId);
}

/** Whether the character has a token on any floor of the scene, the one a player's copy holds. */
export function onSceneFloors(view: Pick<RoomState, "tokens" | "scenes">, characterId: string, sceneId: string): boolean {
  return floorsOf(view, sceneId).some((floor) => onScene(view, characterId, floor.id));
}

/**
 * The floor a player's new token goes on (docs/design/design-v1-floors.md
 * 8.3): the floor they show while it is a floor of the players' scene they
 * hold, else the start floor (always, for a DM). A player's copy holds exactly their floors.
 */
export function placementScene(view: Pick<RoomState, "meta" | "scenes">, shownId: string | null, dm = false): Scene | undefined {
  const start = view.meta.playerSceneId;
  if (!start) return undefined;
  // A DM placing a token for a player puts it where the players start, not on a floor they may be looking at in private.
  const shown = !dm && shownId ? view.scenes[shownId] : undefined;
  return shown && onPlayersScene(view, shown.id) ? shown : view.scenes[start];
}

/**
 * The token a player puts on the map for their own character: at the middle
 * of what they are looking at, moved aside from other tokens and kept inside
 * the scene, as the server requires. Null when the room does not allow it or
 * the character is there already.
 */
export function playerToken(input: {
  view: View;
  scene: Pick<Scene, "id" | "bounds" | "gridShape">;
  character: Pick<Character, "id" | "name" | "size" | "defaultImage" | "ownerIds">;
  memberId: string;
  center: Point;
  id: string;
}): TokenInput | null {
  const { view, scene, character } = input;
  if (view.meta.settings.playersCreateCharacters !== true || !onPlayersScene(view, scene.id)) return null;
  if (!ownsCharacter(input.memberId, character) || onSceneFloors(view, character.id, scene.id)) return null;
  const fp = sizeFootprint(character.size);
  const [at] = spreadPositions({ grid: sceneGrid(scene), center: input.center, footprint: fp, count: 1, bounds: scene.bounds, occupied: occupiedBoxes(Object.values(view.tokens), scene.id) });
  return at ? characterToken(character, { id: input.id, sceneId: scene.id, at }) : null;
}
