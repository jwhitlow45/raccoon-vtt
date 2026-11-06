import { useId } from "react";
import { Button } from "../../../components/Button.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { Row, RowList } from "../../../components/Row.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { playingAt, type MusicRun, type Playlist, type PlaylistId, type Sound, type SoundId } from "#shared/sound.ts";
import { AddSounds } from "../upload/AddSounds.tsx";
import { RowWithAction, Subhead, useWakeAt } from "./controls.tsx";
import { PLAYLIST_DEFAULTS, send, TRACK_DEFAULTS } from "./ops.ts";
import { nameOf, orderFor, playlistsByName, playlistsOf, playlistTracks, serverNow, soundsByUse, soundsOf, totalMs, type Sounds } from "./state.ts";
import { lengthText, NEW_PLAYLIST, NEW_PLAYLIST_NAME, NO_MUSIC, pauseName, playlistDetail, playName } from "./words.ts";

/** Plays a playlist from its first track, or a shuffled order, as a new run (6.2). */
export function playPlaylist(actions: { dispatch: Parameters<typeof send>[0]["dispatch"]; newId(): string }, playlist: Playlist, sounds: Sounds): void {
  const order = orderFor({ playlistId: playlist.id, ...(playlist.shuffle ? { shuffle: true } : null) }, { [playlist.id]: playlist }, sounds);
  if (order.length === 0) return;
  send(actions, { t: "music.play", run: actions.newId(), playlistId: playlist.id, order, index: 0, repeat: playlist.repeat, fade: playlist.fade });
}

export function playTrack(actions: { dispatch: Parameters<typeof send>[0]["dispatch"]; newId(): string }, sound: Sound): void {
  send(actions, { t: "music.play", run: actions.newId(), soundId: sound.id, order: [sound.id], index: 0, ...TRACK_DEFAULTS });
}

/** What a row's button does: start the row's music, or pause or resume the music playing, as Now playing's Pause and Play do. */
export type RowPlay = "play" | "pause" | "resume";

/**
 * The button of a track's row or a playlist's row while `music` plays at
 * `t`: Pause on the track Now playing names, in any run, and on the
 * playlist the run plays, Play to resume them while paused, and Play to
 * start anything else. Pure.
 */
export function rowPlay(music: MusicRun | null, row: { soundId: SoundId } | { playlistId: PlaylistId }, t: number): RowPlay {
  if (!music) return "play";
  const paused = music.paused !== undefined;
  const mine = "soundId" in row ? (paused ? music.now : playingAt(music, t)).soundId === row.soundId : music.playlistId === row.playlistId;
  if (!mine) return "play";
  return paused ? "resume" : "pause";
}

type RowActions = { play: RowPlay; onPlay(): void; onPause(): void; onResume(): void };

/** One button that stays one element as it turns from Play to Pause and back, so focus stays on it. */
function RowPlayButton(props: RowActions & { name: string; disabled?: boolean }) {
  if (props.play === "pause") return <IconButton icon="pause" label={pauseName(props.name)} onClick={props.onPause} />;
  return <IconButton icon="play" label={playName(props.name)} disabled={props.play === "play" && props.disabled} onClick={props.play === "resume" ? props.onResume : props.onPlay} />;
}

/** A playlist's row: its name, "12 tracks · 41 min", and Play or Pause beside it. Pure. */
export function PlaylistRow(props: RowActions & { playlist: Playlist; sounds: Sounds; onOpen(): void }) {
  const tracks = playlistTracks(props.playlist, props.sounds);
  return (
    <RowWithAction
      row={<Row title={props.playlist.name} detail={playlistDetail(tracks.length, totalMs(tracks))} opener={`playlist-${props.playlist.id}`} onClick={props.onOpen} />}
      action={<RowPlayButton {...props} name={props.playlist.name} disabled={tracks.length === 0} />}
    />
  );
}

/** A track's row: its name and length, and Play or Pause beside it. Pure. */
export function TrackRow(props: RowActions & { sound: Sound; onOpen(): void }) {
  const name = nameOf(props.sound);
  return (
    <RowWithAction
      row={<Row title={name} detail={lengthText(props.sound.ms)} opener={`sound-${props.sound.id}`} onClick={props.onOpen} />}
      action={<RowPlayButton {...props} name={name} />}
    />
  );
}

/**
 * Music (4.1 item 2): the playlists, New playlist, every music track, and
 * Add music last. A row opens its page, and Play beside it starts it, or
 * Pause beside the music playing pauses it. The view holds the DM's op at
 * once, so the button turns as it is pressed.
 */
export function MusicSection(props: { onOpenPlaylist(id: string): void; onOpenSound(id: string): void; onStorageChanged(): void }) {
  const actions = useRoomActions();
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const serverOffset = useRoomView((s) => s.serverOffset);
  const t = serverNow({ serverOffset });
  // Pause moves to the incoming track's row as its crossfade starts, as Now playing's name does: one render then.
  useWakeAt(music?.next !== undefined && music.paused === undefined && t < music.next.at ? music.next.at : null, t);
  const pause = () => send(actions, { t: "music.pause" });
  const resume = () => send(actions, { t: "music.resume", run: actions.newId() });
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
              <PlaylistRow
                key={p.id}
                playlist={p}
                sounds={sounds}
                play={rowPlay(music, { playlistId: p.id }, t)}
                onOpen={() => props.onOpenPlaylist(p.id)}
                onPlay={() => playPlaylist(actions, p, sounds)}
                onPause={pause}
                onResume={resume}
              />
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
              <TrackRow
                key={s.id}
                sound={s}
                play={rowPlay(music, { soundId: s.id }, t)}
                onOpen={() => props.onOpenSound(s.id)}
                onPlay={() => playTrack(actions, s)}
                onPause={pause}
                onResume={resume}
              />
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
