import { useId } from "react";
import { Button } from "../../../components/Button.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { Row, RowList } from "../../../components/Row.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import type { Playlist, Sound } from "#shared/sound.ts";
import { AddSounds } from "../upload/AddSounds.tsx";
import { RowWithAction, Subhead } from "./controls.tsx";
import { PLAYLIST_DEFAULTS, send, TRACK_DEFAULTS } from "./ops.ts";
import { nameOf, orderFor, playlistsByName, playlistsOf, playlistTracks, soundsByUse, soundsOf, totalMs, type Sounds } from "./state.ts";
import { lengthText, NEW_PLAYLIST, NEW_PLAYLIST_NAME, NO_MUSIC, playlistDetail, playName } from "./words.ts";

/** Plays a playlist from its first track, or a shuffled order, as a new run (6.2). */
export function playPlaylist(actions: { dispatch: Parameters<typeof send>[0]["dispatch"]; newId(): string }, playlist: Playlist, sounds: Sounds): void {
  const order = orderFor({ playlistId: playlist.id, ...(playlist.shuffle ? { shuffle: true } : null) }, { [playlist.id]: playlist }, sounds);
  if (order.length === 0) return;
  send(actions, { t: "music.play", run: actions.newId(), playlistId: playlist.id, order, index: 0, repeat: playlist.repeat, fade: playlist.fade });
}

export function playTrack(actions: { dispatch: Parameters<typeof send>[0]["dispatch"]; newId(): string }, sound: Sound): void {
  send(actions, { t: "music.play", run: actions.newId(), soundId: sound.id, order: [sound.id], index: 0, ...TRACK_DEFAULTS });
}

/** A playlist's row: its name, "12 tracks · 41 min", and Play beside it. Pure. */
export function PlaylistRow(props: { playlist: Playlist; sounds: Sounds; onOpen(): void; onPlay(): void }) {
  const tracks = playlistTracks(props.playlist, props.sounds);
  return (
    <RowWithAction
      row={<Row title={props.playlist.name} detail={playlistDetail(tracks.length, totalMs(tracks))} opener={`playlist-${props.playlist.id}`} onClick={props.onOpen} />}
      action={<IconButton icon="play" label={playName(props.playlist.name)} disabled={tracks.length === 0} onClick={props.onPlay} />}
    />
  );
}

/** A track's row: its name and length, and Play beside it. Pure. */
export function TrackRow(props: { sound: Sound; onOpen(): void; onPlay(): void }) {
  const name = nameOf(props.sound);
  return (
    <RowWithAction
      row={<Row title={name} detail={lengthText(props.sound.ms)} opener={`sound-${props.sound.id}`} onClick={props.onOpen} />}
      action={<IconButton icon="play" label={playName(name)} onClick={props.onPlay} />}
    />
  );
}

/**
 * Music (4.1 item 2): the playlists, New playlist, every music track, and
 * Add music last. A row opens its page, and Play beside it starts it.
 */
export function MusicSection(props: { onOpenPlaylist(id: string): void; onOpenSound(id: string): void; onStorageChanged(): void }) {
  const actions = useRoomActions();
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const tracks = soundsByUse(sounds, "music");
  const lists = playlistsByName(playlists);
  const playlistsId = useId();
  const tracksId = useId();

  const newPlaylist = () => {
    const id = actions.newId();
    send(actions, { t: "playlist.create", id, name: NEW_PLAYLIST_NAME, sounds: [], ...PLAYLIST_DEFAULTS });
    props.onOpenPlaylist(id);
  };

  return (
    <Section label="Music">
      <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
        <Subhead id={playlistsId}>Playlists</Subhead>
        {lists.length > 0 ? (
          <RowList label="Playlists">
            {lists.map((p) => (
              <PlaylistRow key={p.id} playlist={p} sounds={sounds} onOpen={() => props.onOpenPlaylist(p.id)} onPlay={() => playPlaylist(actions, p, sounds)} />
            ))}
          </RowList>
        ) : null}
        <div style={{ display: "flex" }}>
          <Button size="sm" icon="plus" onClick={newPlaylist}>
            {NEW_PLAYLIST}
          </Button>
        </div>
      </div>
      <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
        <Subhead id={tracksId}>Tracks</Subhead>
        {tracks.length > 0 ? (
          <RowList label="Tracks">
            {tracks.map((s) => (
              <TrackRow key={s.id} sound={s} onOpen={() => props.onOpenSound(s.id)} onPlay={() => playTrack(actions, s)} />
            ))}
          </RowList>
        ) : (
          <Help>{NO_MUSIC}</Help>
        )}
      </div>
      <AddSounds use="music" onStorageChanged={props.onStorageChanged} />
    </Section>
  );
}
