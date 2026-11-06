import type { OpOf } from "#shared/protocol.ts";
import type { Fade, Playlist, Repeat, SceneSound } from "#shared/sound.ts";
import type { OnAnswer, RoomActions } from "../../../state/types.ts";

/**
 * The sound ops the panel and the Music window send
 * (docs/design/design-v1-music.md 6.2, docs/design/design-v1-music-player.md
 * 6.3), each the DM's. Playback ops record no step and Setup ops one each
 * (6.6), which the server decides by the op's type.
 */
export type SoundOp =
  | OpOf<"music.play" | "music.pause" | "music.resume" | "music.skip" | "music.stop" | "music.set" | "music.queue" | "music.jump">
  | OpOf<"loop.start" | "loop.set" | "loop.stop" | "effect.fire" | "sound.mix" | "sound.scene" | "sound.stopAll">
  | OpOf<"sound.update" | "sound.delete" | "playlist.create" | "playlist.update" | "playlist.delete" | "playlist.add">
  | { t: "scene.update"; sceneId: string; patch: { sound: SceneSound | null } }
  | { t: "room.update"; settings: { soundNames: boolean } };

/** Sends a sound op through the room's one dispatch, as every panel sends its ops, and hears its answer when asked to. */
export function send(actions: Pick<RoomActions, "dispatch">, op: SoundOp, onAnswer?: OnAnswer): void {
  actions.dispatch(op, onAnswer ? { onAnswer } : undefined);
}

/** A new playlist's settings (4.1): Repeat all, a 5 second crossfade, in order. */
export const PLAYLIST_DEFAULTS: Pick<Playlist, "repeat" | "fade"> = { repeat: "all", fade: 5 };

/** One track played from Tracks: it repeats, so the music goes on until the DM stops it, with a playlist's crossfade. */
export const TRACK_DEFAULTS: { repeat: Repeat; fade: Fade } = { repeat: "all", fade: 5 };
