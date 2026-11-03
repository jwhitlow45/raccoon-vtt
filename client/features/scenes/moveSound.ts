import type { Scene } from "#shared/model.ts";
import type { OpOf } from "#shared/protocol.ts";
import { sceneOrder, type Playlists, type Sounds } from "../sound/panel/state.ts";

/**
 * The scene's own sound, sent right behind a Move players. It plays only
 * while the players are still there, so a refused move or another DM's
 * later move leaves the room's sound alone (docs/design/design-v1-music.md
 * 4.6). None for a scene with no sound, and none while the server's sound
 * switch is off or not known yet: the server refuses a scene's sound that
 * starts a file then, and with nothing playing a silent one has nothing to
 * stop (MUS-R1-06).
 */
export function moveSoundOp(scene: Scene, input: { serverSound: boolean; playlists: Playlists; sounds: Sounds; newId: () => string; random?: () => number }): OpOf<"sound.scene"> | null {
  if (!scene.sound || !input.serverSound) return null;
  return { t: "sound.scene", sceneId: scene.id, run: input.newId(), order: sceneOrder(scene.sound, input.playlists, input.sounds, input.random), onMove: true };
}
