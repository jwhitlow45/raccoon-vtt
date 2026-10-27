import type { Scene, ScenePreset } from "./model.ts";

/**
 * "Players see", one choice of what players get of a scene
 * (docs/design-v1-map-discovery.md 8.1), as the client's settings and the
 * server's undo names both read it, so the two never word it apart. Each
 * preset is a pair of the scene's switches, so any scene reads as one, or as
 * Custom for the one pair no preset names: fog off with party vision on.
 */

export type PlayersSee = ScenePreset | "custom";

/** Each choice's name, as the settings show it and the undo toast names it. */
export const PLAYERS_SEE_WORDS: Record<PlayersSee, string> = { explore: "Explore", reveal: "Reveal by hand", all: "Everything", custom: "Custom" };

export function playersSeeOf(scene: Pick<Scene, "fogEnabled" | "vision">): PlayersSee {
  const vision = scene.vision?.on === true;
  if (scene.fogEnabled) return vision ? "explore" : "reveal";
  return vision ? "custom" : "all";
}
