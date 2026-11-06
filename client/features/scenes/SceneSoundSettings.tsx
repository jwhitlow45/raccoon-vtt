import { useId } from "react";
import type { Scene } from "#shared/model.ts";
import type { SceneSound } from "#shared/sound.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { SceneSoundLine } from "../sound/panel/NowPlaying.tsx";
import { send } from "../sound/panel/ops.ts";
import { playlistsOf, sceneOrder, sceneSoundFrom, sceneSoundNames, somethingPlays, soundsOf } from "../sound/panel/state.ts";

const SILENCE: SceneSound = { music: null, loops: [] };

/**
 * The names of what a scene's own sound plays, from the room's library, or
 * null for a scene with none of its own. An empty list is a scene kept
 * silent. For the Scene sound group's line and its folded summary alike.
 */
export function useSceneSoundNames(scene: Scene): string[] | null {
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  return scene.sound ? sceneSoundNames(scene.sound, playlists, sounds) : null;
}

/**
 * Scene sound, the scene's own preset (docs/design/design-v1-scenes-reorg.md 5,
 * docs/design/design-v1-music.md 4.6): what Move players starts when the
 * players arrive here. It lives with the scene's other settings, for the
 * scene in view, while what plays now stays the room's, in Ambiance. Every
 * button sends the op the Sound panel's line always sent: Play it plays the
 * preset now, Use what's playing saves what plays as it, Use silence keeps
 * the scene silent, and Clear leaves it with no sound of its own.
 */
export function SceneSoundSettings(props: { scene: Scene }) {
  const { scene } = props;
  const actions = useRoomActions();
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const names = useSceneSoundNames(scene);
  // Its own ids, so Ambiance's line for the same scene, open beside it on a computer, never shares one.
  const helpId = useId();
  const sound = scene.sound ?? null;
  const setSound = (next: SceneSound | null) => send(actions, { t: "scene.update", sceneId: scene.id, patch: { sound: next } });
  return (
    <SceneSoundLine
      sceneName={scene.name}
      sound={names === null ? null : { names }}
      canUsePlaying={somethingPlays(playing)}
      helpId={helpId}
      onPlay={() => {
        if (sound) send(actions, { t: "sound.scene", sceneId: scene.id, run: actions.newId(), order: sceneOrder(sound, playlists, sounds) });
      }}
      onUsePlaying={() => setSound(sceneSoundFrom(playing, playlists))}
      onUseSilence={() => setSound(SILENCE)}
      onClear={() => setSound(null)}
    />
  );
}
