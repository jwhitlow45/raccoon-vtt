import type { Scene, SightTile } from "#shared/model.ts";
import { WALLLESS_ELSEWHERE } from "./playersSeeRules.ts";
import { visionOn } from "./sightMode.ts";

/**
 * What "Move players" asks the DM to confirm first, or null when it moves
 * them at once (design 13.2, docs/design-v1-maps-vision.md section 4.3.1).
 *
 * - Fog off: players will see the whole scene.
 * - Party vision on, where no party creature can see: players will see only
 *   what they explored before. Only the server works out what the party
 *   sees, and the DM's view holds the sight of the scene the DM is looking
 *   at, so that scene is answered exactly. For another scene the DM's view
 *   holds neither its creatures nor its sight, so the warning says what to
 *   check rather than guess. Nor does it hold that scene's walls, so on a
 *   map image it adds that a map with no walls yet shows players all of it
 *   (docs/design-v1-map-discovery.md 8.1, MD-O-28). The scene on screen
 *   says that in its own settings, where its walls are counted.
 */
export function moveWarning(input: {
  scene: Pick<Scene, "id" | "vision" | "fogEnabled" | "map">;
  /** Whether the DM is looking at this scene, so the view holds its sight. */
  viewing: boolean;
  sight: Readonly<Record<string, SightTile | undefined>> | undefined;
}): string | null {
  const { scene } = input;
  if (!visionOn(scene)) return scene.fogEnabled ? null : "Fog is off here, so players will see the whole scene.";
  if (!input.viewing) {
    return scene.fogEnabled
      ? `Players will see only what their characters on this scene see. If none of them can see, players see only what they explored before.${scene.map ? ` ${WALLLESS_ELSEWHERE}` : ""}`
      : "Players will see only what their characters on this scene see, and the rest of the map dimmed, since fog is off.";
  }
  const prefix = `${scene.id}:`;
  const seen = Object.entries(input.sight ?? {}).some(([key, tile]) => tile !== undefined && key.startsWith(prefix));
  if (seen) return scene.fogEnabled ? null : "Fog is off here, so players will see the whole map, dimmed outside the party's sight.";
  return scene.fogEnabled
    ? "No party creature on this scene can see. Players will see only what they explored before."
    : "No party creature on this scene can see. Fog is off, so players will see the whole map dimmed.";
}
