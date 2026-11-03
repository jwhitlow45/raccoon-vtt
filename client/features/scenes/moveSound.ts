import type { Scene } from "#shared/model.ts";
import type { OpOf } from "#shared/protocol.ts";
import type { ServerSound } from "../sound/engine/store.ts";
import { sceneOrder, type Playlists, type Sounds } from "../sound/panel/state.ts";

/**
 * The scene's own sound, sent right behind a Move players. It plays only
 * while the players are still there, so a refused move or another DM's
 * later move leaves the room's sound alone (docs/design/design-v1-music.md
 * 4.6). None for a scene with no sound, and none once the server said its
 * sound switch is off: the server refuses a scene's sound that starts a
 * file then, and with nothing playing a silent one has nothing to stop
 * (MUS-R1-06). While the switch is not known yet, or its read failed, the
 * sound goes and the server decides, so a move made before /api/config
 * answers still plays the scene's sound.
 */
export function moveSoundOp(scene: Scene, input: { serverSound: ServerSound; playlists: Playlists; sounds: Sounds; newId: () => string; random?: () => number }): OpOf<"sound.scene"> | null {
  if (!scene.sound || input.serverSound === "off") return null;
  return { t: "sound.scene", sceneId: scene.id, run: input.newId(), order: sceneOrder(scene.sound, input.playlists, input.sounds, input.random), onMove: true };
}
