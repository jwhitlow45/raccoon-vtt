import { useStore } from "zustand";
import type { RoomState, Scene } from "#shared/model.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { withExplored } from "./exploredFog.ts";
import { partySightSlot, sightMode, visionOn, type SightMode } from "./sightMode.ts";

/**
 * What the map canvas (client/canvas/Stage.tsx) asks of party vision. Kept
 * here so the canvas needs one line for each.
 */

/** How this Room page draws the party's sight on a scene, or null when it does not (sightMode.ts). */
export function useSightMode(scene: Pick<Scene, "vision">, role: "dm" | "player"): SightMode | null {
  const partySight = useStore(useScoped(partySightSlot), (s) => s.on);
  return sightMode({ role, visionOn: visionOn(scene), partySight });
}

/**
 * The fog tiles the fog image draws. A DM's view holds the party's
 * explored layer apart from the DM's fog, and the DM sees explored ground
 * revealed (exploredFog.ts). A player's tiles are already both layers,
 * merged by the server.
 */
export function useDrawnFogTiles(fogTiles: RoomState["fogTiles"], role: "dm" | "player"): RoomState["fogTiles"] {
  const explored = useRoomView((s) => (role === "dm" ? s.view?.exploredTiles : undefined));
  return withExplored(fogTiles, explored) as RoomState["fogTiles"];
}
