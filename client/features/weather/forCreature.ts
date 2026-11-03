import type { RoomState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { SceneWeather } from "#shared/weather.ts";

/**
 * The weather a creature is in (docs/design/design-v1-weather.md 2, "Which
 * creatures"), for the roll presets and notes. A creature is in a scene's
 * weather when its token stands on that scene. A token target is on its own
 * token's scene. A character has no scene of its own, so it is on the scene
 * of its token on the players' scene, else of its token on the viewer's
 * scene. A creature with no token there gets nothing.
 */
export function weatherFor(dice: { view: Pick<RoomState, "scenes" | "tokens" | "meta"> }, creature: ActorTarget, viewerSceneId: string | null | undefined): SceneWeather | undefined {
  const { scenes, tokens, meta } = dice.view;
  // Most rooms have no weather anywhere, and a preset is built on every render of a roll button: skip the token search then.
  if (!Object.values(scenes).some((scene) => scene.weather !== undefined)) return undefined;
  if ("tokenId" in creature) {
    const token = tokens[creature.tokenId];
    return token ? scenes[token.sceneId]?.weather : undefined;
  }
  const onScene = (sceneId: string | null | undefined) =>
    sceneId != null && Object.values(tokens).some((token) => token.sceneId === sceneId && "ref" in token.actor && token.actor.ref === creature.characterId);
  for (const sceneId of [meta.playerSceneId, viewerSceneId]) {
    if (onScene(sceneId)) return scenes[sceneId!]?.weather;
  }
  return undefined;
}
