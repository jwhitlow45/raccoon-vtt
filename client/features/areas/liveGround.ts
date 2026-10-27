import { useMemo } from "react";
import { sightOf } from "#shared/keys.ts";
import type { FogTile, RoomState, Scene, SightTile } from "#shared/model.ts";
import { deviceGround, type Ground } from "#shared/rules/held.ts";
import { useTreeShownView } from "../../canvas/relief/context.ts";

const NO_FOG: Readonly<Record<string, FogTile>> = {};
const NO_SIGHT: Readonly<Record<string, SightTile>> = {};

/**
 * A player's device's live ground on a scene, for its caught lists and
 * target rings (coverage.ts raysLive, docs/design-v1-map-discovery.md
 * decision 13): its sight with fog and party vision on, its revealed fog
 * with vision off (rules/held.ts deviceGround). Null for the DM, who reads
 * every area whole, and with fog off, where all ground is live.
 */
export function liveGroundOf(input: { scene: Scene | undefined; role: "dm" | "player"; fogTiles: Readonly<Record<string, FogTile>>; sight: Readonly<Record<string, SightTile>> }): Ground | null {
  const { scene } = input;
  if (input.role !== "player" || !scene || scene.fogEnabled !== true) return null;
  return deviceGround({ scenes: { [scene.id]: scene }, fogTiles: input.fogTiles, sight: input.sight } as unknown as RoomState & { sight: Record<string, SightTile> }, scene.id);
}

/** `liveGroundOf` from the room as this part of the page shows it, made again only when the scene, the fog or the sight changes. */
export function useLiveGround(scene: Scene | undefined, role: "dm" | "player"): Ground | null {
  const fogTiles = useTreeShownView((s) => s.view?.fogTiles ?? NO_FOG);
  const sight = useTreeShownView((s) => (s.view ? sightOf(s.view) : undefined) ?? NO_SIGHT);
  return useMemo(() => liveGroundOf({ scene, role, fogTiles, sight }), [scene, role, fogTiles, sight]);
}
