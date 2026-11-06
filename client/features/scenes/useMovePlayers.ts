import { useCallback, useMemo } from "react";
import type { Scene } from "#shared/model.ts";
import { sightOf } from "#shared/keys.ts";
import { useDelayed } from "../../components/Loading.tsx";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { useServerRoomSoundState } from "../sound/engine/store.ts";
import { playlistsOf, soundsOf } from "../sound/panel/state.ts";
import { moveQuestion, movePlayers, movingPlayersTo, type MoveOptions, type MoveRoom, type MoveStep } from "./movePlayers.ts";

/**
 * The move helper (movePlayers.ts) over this Room's view, for every control
 * that moves the players: what a move asks first, the press itself, and
 * the scene a move is going to. `movingTo` is set at once, for refusing a
 * second press, and `shownMovingTo` after the shared indicator's delay,
 * for "Moving players…".
 */
export function useMovePlayers(): {
  room: MoveRoom;
  question(scene: Scene): string | null;
  move(scene: Scene, opts?: MoveOptions): MoveStep;
  movingTo: string | null;
  shownMovingTo: string | null;
} {
  const actions = useRoomActions();
  const viewingId = useRoomView((s) => s.sceneId);
  const sight = useRoomView((s) => (s.view ? sightOf(s.view) : undefined));
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const serverSound = useServerRoomSoundState();
  const movingTo = useRoomView((s) => movingPlayersTo(s.pending));
  const shownMovingTo = useDelayed(movingTo !== null) ? movingTo : null;
  const room = useMemo<MoveRoom>(() => ({ viewingId, sight, serverSound, playlists, sounds }), [viewingId, sight, serverSound, playlists, sounds]);
  const question = useCallback((scene: Scene) => moveQuestion(scene, room), [room]);
  const move = useCallback((scene: Scene, opts?: MoveOptions) => movePlayers(actions, scene, room, opts), [actions, room]);
  return { room, question, move, movingTo, shownMovingTo };
}
