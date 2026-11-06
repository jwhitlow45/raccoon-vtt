import { useRef, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { Input } from "../../../components/Field.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Menu, type MenuItem, type MenuPickBy } from "../../../components/Menu.tsx";
import { Help } from "../../../components/Panel.tsx";
import { Popover, usePopover } from "../../../components/Popover.tsx";
import { Row, RowList } from "../../../components/Row.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../../state/view.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { playingAt, type MusicRun, type Playlist, type PlaylistId, type Sound, type SoundId } from "#shared/sound.ts";
import { AddSounds } from "../upload/AddSounds.tsx";
import { useWakeAt } from "../panel/controls.tsx";
import { send, TRACK_DEFAULTS } from "../panel/ops.ts";
import { nameOf, orderFor, playlistsByName, playlistsOf, playlistTracks, serverNow, soundsByUse, soundsOf, totalMs, type Playlists, type Sounds } from "../panel/state.ts";
import { StorageLine } from "../panel/StorageLine.tsx";
import { lengthText, NO_MUSIC, pauseName, playlistDetail, playName } from "../panel/words.ts";
import { queueLists, type QueueLists } from "./dragOrder.ts";
import { ListHead, MoreMenu, SortMenu, useWidth, viewportBound } from "./parts.tsx";
import { Tile, TILE } from "./tile.ts";
import {
  ADD_TO_PLAYLIST,
  ADD_TO_QUEUE,
  addedTo,
  ALREADY_IN_IT,
  EDIT_PLAYLIST,
  fullPlaylist,
  IN_THE_QUEUE,
  NEW_PLAYLIST,
  NEW_PLAYLIST_WITH,
  NO_PLAYLISTS,
  noPlaylistMatches,
  noTrackMatches,
  PLAY_NEXT,
  PLAYING_NOTE,
  PLAYLISTS,
  RENAME_OR_DELETE,
  SEARCH_MUSIC,
  trackCount,
  TRACKS,
  type Sort,
} from "./words.ts";

type Actions = { dispatch: Parameters<typeof send>[0]["dispatch"]; newId(): string };

/** Plays a playlist from its first track, or a shuffled order with the run's Shuffle on, as a new run (6.2). */
export function playPlaylist(actions: Actions, playlist: Playlist, sounds: Sounds, onAnswer?: Parameters<typeof send>[2]): void {
  const order = orderFor({ playlistId: playlist.id, ...(playlist.shuffle ? { shuffle: true } : null) }, { [playlist.id]: playlist }, sounds);
  if (order.length === 0) return;
  send(actions, { t: "music.play", run: actions.newId(), playlistId: playlist.id, order, index: 0, repeat: playlist.repeat, fade: playlist.fade, ...(playlist.shuffle ? { shuffle: true as const } : null) }, onAnswer);
}

/** Plays one track alone, as Tracks' Play always has (D-261102-966). */
export function playTrack(actions: Actions, sound: Sound): void {
  send(actions, { t: "music.play", run: actions.newId(), soundId: sound.id, order: [sound.id], index: 0, ...TRACK_DEFAULTS });
}

/** What a row's button does: start the row's music, or pause or resume the music playing, as Now playing's Pause and Play do. */
export type RowPlay = "play" | "pause" | "resume";

/**
 * The button of a track's row or a playlist's row while `music` plays at
 * `t` (D-261102-951): Pause on the track Now playing names, in any run,
 * and on the playlist the run plays, Play to resume them while paused,
 * and Play to start anything else. Pure.
 */
export function rowPlay(music: MusicRun | null, row: { soundId: SoundId } | { playlistId: PlaylistId }, t: number): RowPlay {
  if (!music) return "play";
  const paused = music.paused !== undefined;
  const mine = "soundId" in row ? (paused ? music.now : playingAt(music, t)).soundId === row.soundId : music.playlistId === row.playlistId;
  if (!mine) return "play";
  return paused ? "resume" : "pause";
}

/** One button that stays one element as it turns from Play to Pause and back, so focus stays on it. */
function RowPlayButton(props: { play: RowPlay; name: string; disabled?: boolean; onPlay(): void; onPause(): void; onResume(): void }) {
  if (props.play === "pause") return <IconButton icon="pause" label={pauseName(props.name)} onClick={props.onPause} />;
  return <IconButton icon="play" label={playName(props.name)} disabled={props.play === "play" && props.disabled} onClick={props.play === "resume" ? props.onResume : props.onPlay} />;
}

/** Search's match: by name, ignoring case and accents (4.4). */
export function matches(name: string, query: string): boolean {
  const q = fold(query.trim());
  return q === "" || fold(name).includes(q);
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Tracks as Library lists them: those the search matches, by name or by length. */
export function libraryTracks(sounds: Sounds, query: string, sort: Sort): Sound[] {
  const tracks = soundsByUse(sounds, "music").filter((s) => matches(nameOf(s), query));
  if (sort === "long") tracks.sort((a, b) => b.ms - a.ms);
  if (sort === "short") tracks.sort((a, b) => a.ms - b.ms);
  return tracks;
}

export function libraryPlaylists(playlists: Playlists, query: string): Playlist[] {
  return playlistsByName(playlists).filter((p) => matches(p.name, query));
}

const SORT_KEY = "rvtt.musicSort";
const SORTS: readonly Sort[] = ["name", "long", "short"];

/** The sort this device keeps (4.4). Storage may be off, as in a private window: Name then, every time. */
export function readSort(): Sort {
  try {
    const kept = localStorage.getItem(SORT_KEY);
    return SORTS.includes(kept as Sort) ? (kept as Sort) : "name";
  } catch {
    return "name";
  }
}

function keepSort(sort: Sort): void {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // Kept for this visit only.
  }
}

/** Whether Add to queue has nothing to do for a track: it plays now, or it is still to come in this run (6.4). */
export function queueNote(lists: QueueLists, soundId: SoundId): string | null {
  if (soundId === lists.playing) return PLAYING_NOTE;
  const at = lists.order.indexOf(soundId);
  if (at < 0) return null;
  // Under Repeat off a track heard already plays again from the end; under Repeat all and one every queued track is still to come.
  return lists.repeat === "off" && at < lists.index ? null : IN_THE_QUEUE;
}

/** Add to playlist's choices (4.4): the playlists by name, each one it cannot join disabled with why, then a new one with it. */
export function playlistChoices(playlists: Playlists, soundId: SoundId): MenuItem[] {
  const items: MenuItem[] = playlistsByName(playlists).map((p) => {
    const holds = p.sounds.includes(soundId);
    const full = p.sounds.length >= SOUND_LIMITS.playlistTracks;
    const note = holds ? ALREADY_IN_IT : full ? fullPlaylist(p.sounds.length) : undefined;
    return { id: p.id, title: p.name, kind: "action" as const, ...(note ? { disabled: true, note } : null) };
  });
  return [...items, { id: NEW_WITH_ID, title: NEW_PLAYLIST_WITH, kind: "action" }];
}

const NEW_WITH_ID = "\u0000new";

/**
 * Library (docs/design/design-v1-music-player.md 4.4): search, sort, the
 * playlists with New playlist, the tracks, each row with Play or Pause
 * and its More menu, then Add music… and the storage line.
 */
export function Library(props: { onOpenMaker(playlistId: PlaylistId | null, seed?: SoundId): void; onOpenTrack(soundId: SoundId): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const serverOffset = useRoomView((s) => s.serverOffset);
  const roomId = useRoomView((s) => s.roomId);
  const t = serverNow({ serverOffset });
  // Pause moves to the incoming track's row as its crossfade starts, as Now playing's name does: one render then.
  useWakeAt(music?.next !== undefined && music.paused === undefined && t < music.next.at ? music.next.at : null, t);
  const lists = queueLists(music, sounds, t);
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<Sort>(readSort);
  const [storage, setStorage] = useState(0);
  const [box, width] = useWidth<HTMLDivElement>();
  // A row keeps its tile only where its name still has room beside it (4.4).
  const tiles = width === 0 || width >= 300;
  const shownLists = libraryPlaylists(playlists, query);
  const all = soundsByUse(sounds, "music");
  const tracks = libraryTracks(sounds, query, sort);
  const searching = query.trim() !== "";
  const pause = () => send(actions, { t: "music.pause" });
  const resume = () => send(actions, { t: "music.resume", run: actions.newId() });
  const queue = (from: QueueLists, edit: Parameters<typeof queueOp>[1]) => send(actions, queueOp(from, edit));
  const setSort = (next: Sort) => {
    setSortState(next);
    keepSort(next);
  };

  const playlistItems = (p: Playlist): MenuItem[] => {
    const ids = playlistTracks(p, sounds).map((s) => s.id);
    const empty = ids.length === 0;
    return [
      ...(lists ? [{ id: "next", title: PLAY_NEXT, kind: "action" as const, disabled: empty }, { id: "queue", title: ADD_TO_QUEUE, kind: "action" as const, disabled: empty }] : []),
      { id: "edit", title: EDIT_PLAYLIST, kind: "action" },
    ];
  };
  const trackItems = (s: Sound): MenuItem[] => {
    const playing = lists?.playing === s.id;
    const note = lists ? queueNote(lists, s.id) : null;
    return [
      ...(lists
        ? [
            { id: "next", title: PLAY_NEXT, kind: "action" as const, ...(playing ? { disabled: true, note: PLAYING_NOTE } : null) },
            { id: "queue", title: ADD_TO_QUEUE, kind: "action" as const, ...(note ? { disabled: true, note } : null) },
          ]
        : []),
      { id: "playlist", title: ADD_TO_PLAYLIST, kind: "action" },
      { id: "page", title: RENAME_OR_DELETE, kind: "action" },
    ];
  };

  return (
    <div ref={box} data-music-library="" style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
        <div style={{ flex: "1 1 180px", minWidth: 0 }}>
          <Input type="search" aria-label={SEARCH_MUSIC} placeholder={SEARCH_MUSIC} enterKeyHint="search" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: "100%" }} />
        </div>
        <SortMenu sort={sort} onPick={setSort} />
      </div>

      <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
        <ListHead
          detail={searching ? trackCount(shownLists.length, Object.keys(playlists).length, true) : String(Object.keys(playlists).length)}
          action={
            <Button size="sm" icon="plus" onClick={() => props.onOpenMaker(null)}>
              {NEW_PLAYLIST}
            </Button>
          }
        >
          {PLAYLISTS}
        </ListHead>
        {shownLists.length > 0 ? (
          <RowList label={PLAYLISTS}>
            {shownLists.map((p) => {
              const inIt = playlistTracks(p, sounds);
              return (
                <div key={p.id} data-music-row="" style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Row
                      {...(tiles ? { leading: <Tile name={p.name} size={TILE.row} icon="queue" /> } : null)}
                      wrapTitle={!tiles}
                      fullDetail={!tiles}
                      title={p.name}
                      detail={playlistDetail(inIt.length, totalMs(inIt))}
                      chosen={music?.playlistId === p.id}
                      opener={`playlist-${p.id}`}
                      onClick={() => props.onOpenMaker(p.id)}
                    />
                  </div>
                  <RowPlayButton play={rowPlay(music, { playlistId: p.id }, t)} name={p.name} disabled={inIt.length === 0} onPlay={() => playPlaylist(actions, p, sounds)} onPause={pause} onResume={resume} />
                  <MoreMenu
                    name={p.name}
                    items={playlistItems(p)}
                    onPick={(id) => {
                      const ids = inIt.map((s) => s.id);
                      if (id === "edit") props.onOpenMaker(p.id);
                      else if (lists && id === "next") queue(lists, { t: "next", soundIds: ids });
                      else if (lists && id === "queue") queue(lists, { t: "add", soundIds: ids });
                    }}
                  />
                </div>
              );
            })}
          </RowList>
        ) : (
          <Help>{searching ? noPlaylistMatches(query.trim()) : NO_PLAYLISTS}</Help>
        )}
      </div>

      <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
        <ListHead detail={trackCount(tracks.length, all.length, searching)}>{TRACKS}</ListHead>
        {tracks.length > 0 ? (
          <RowList label={TRACKS}>
            {tracks.map((s) => {
              const name = nameOf(s);
              const current = lists?.playing === s.id;
              return (
                <div key={s.id} data-music-row="" aria-current={current ? true : undefined} style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Row {...(tiles ? { leading: <Tile name={name} size={TILE.row} /> } : null)} wrapTitle={!tiles} fullDetail={!tiles} title={name} detail={lengthText(s.ms)} chosen={current} />
                  </div>
                  <RowPlayButton play={rowPlay(music, { soundId: s.id }, t)} name={name} onPlay={() => playTrack(actions, s)} onPause={pause} onResume={resume} />
                  <TrackMore
                    sound={s}
                    items={trackItems(s)}
                    playlists={playlists}
                    onPick={(id) => {
                      if (id === "page") props.onOpenTrack(s.id);
                      else if (lists && id === "next") queue(lists, { t: "next", soundIds: [s.id] });
                      else if (lists && id === "queue") queue(lists, { t: "add", soundIds: [s.id] });
                    }}
                    onAddTo={(playlistId) => {
                      if (playlistId === null) {
                        props.onOpenMaker(null, s.id);
                        return;
                      }
                      const target = playlists[playlistId];
                      if (!target) return;
                      send(actions, { t: "playlist.add", id: playlistId, soundId: s.id }, (answer) => {
                        if (answer === "taken") ui.notify(addedTo(name, target.name), "info");
                      });
                    }}
                  />
                </div>
              );
            })}
          </RowList>
        ) : (
          <Help>{searching ? noTrackMatches(query.trim()) : NO_MUSIC}</Help>
        )}
        <AddSounds use="music" onStorageChanged={() => setStorage((n) => n + 1)} />
      </div>
      <StorageLine roomId={roomId} version={`${storage} ${Object.keys(sounds).length}`} />
    </div>
  );
}

function queueOp(from: QueueLists, edit: { t: "next" | "add"; soundIds: SoundId[] }) {
  return { t: "music.queue" as const, from: from.run, edit };
}

/**
 * A track's More, whose Add to playlist… opens a second menu of the
 * playlists from the same button, the way it was opened, so a keyboard
 * lands on its first playlist.
 */
function TrackMore(props: { sound: Sound; items: readonly MenuItem[]; playlists: Playlists; onPick(id: string): void; onAddTo(playlistId: PlaylistId | null): void }) {
  const lists = usePopover({ kind: "menu" });
  const anchor = useRef<HTMLElement | null>(null);
  const name = nameOf(props.sound);
  const openLists = (by: MenuPickBy) => {
    // The More menu closes on its pick and gives focus back to its button first, then this one opens from it.
    setTimeout(() => lists.show({ by, from: "first" }), 0);
  };
  return (
    <>
      <MoreMenu
        name={name}
        items={props.items}
        anchorRef={(el) => {
          anchor.current = el;
          lists.anchorProps.ref(el);
        }}
        onPick={(id, by) => {
          if (id === "playlist") openLists(by);
          else props.onPick(id);
        }}
      />
      <Popover handle={lists} side="below" flip bound={viewportBound}>
        <div style={{ maxWidth: theme.layout.listCap }}>
          <Menu label={ADD_TO_PLAYLIST} sections={[{ key: "playlists", items: playlistChoices(props.playlists, props.sound.id) }]} onPick={(id) => props.onAddTo(id === NEW_WITH_ID ? null : id)} />
        </div>
      </Popover>
    </>
  );
}
