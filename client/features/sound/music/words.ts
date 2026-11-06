import { SOUND_WORDS } from "#shared/reducer/sound.ts";
import type { Fade } from "#shared/sound.ts";
import { clockText } from "../panel/words.ts";

/**
 * Every word the Music window and the Sound group's music block show
 * (docs/design/design-v1-music-player.md 8), in one place so the render
 * tests, the e2e steps and the DM guide read the same text. "Player" is in
 * none of them: in this app a player is a person at the table (D-261102-962).
 */

export const OPEN_MUSIC = "Open music";
export const MUSIC_TITLE = "Music";
/** A step's back button, back "Music" (8). */
export const BACK_TO_MUSIC = "Back to Music";
export const NOW_TAB = "Now playing";
export const LIBRARY_TAB = "Library";
export const MUSIC_TABS = "Music";
/** The DM guide's section the Guide link at Library's foot opens (4.4). */
export const MUSIC_GUIDE = "the-music-window";
export const OPEN_FAILED = "Couldn't open music.";
export const OPENING = "Opening music…";

/** The Sound group's line under the run line (3.1). */
export const NEXT_AGAIN = "Next: this track again";
export const LAST_TRACK = "Last track";
export function nextLine(name: string): string {
  return `Next: ${name}`;
}

export const SHUFFLE = "Shuffle";
export const REPEAT = "Repeat";
export const PLAY = "Play";
export const PREVIOUS = "Previous";
export const SEEK = "Seek";
export const CROSSFADE = "Crossfade";
export const FADE_WORDS: Record<Fade, string> = { 0: "Off", 2: "2 s", 5: "5 s", 10: "10 s" };
export function crossfadeName(fade: Fade): string {
  return `Crossfade: ${FADE_WORDS[fade]}`;
}
/** The seek slider's value for a screen reader, "1:24 of 3:10". */
export function seekText(positionMs: number, lengthMs: number): string {
  return `${clockText(positionMs)} of ${clockText(lengthMs)}`;
}

export const UP_NEXT = "Up next";
export const PLAYED = "Played";
export const PLAY_NOW = "Play now";
export const PLAY_NEXT = "Play next";
export const ADD_TO_QUEUE = "Add to queue";
export const REMOVE_FROM_QUEUE = "Remove from queue";
export const IN_THE_QUEUE = "In the queue";
export const PLAYING_NOTE = "Playing";
export const NOTHING_AFTER = "Nothing after this track in this pass.";
export const MUSIC_ENDS = "Then the music ends.";
export const REPEAT_ONE_LINE = "Repeat one plays this track again. Skip goes on to the next.";
export const HANDLE_HELP = "Drag, or press Up or Down.";
/** "Then Tavern night plays again from the top:", or the queue's once its playlist is gone. */
export function againLine(playlistName: string | null): string {
  return playlistName === null ? "Then the queue plays again from the top:" : `Then ${playlistName} plays again from the top:`;
}
/** Up next's heading detail, "9 tracks · 26 min". */
export function tracksDetail(tracks: number, totalMs: number): string {
  const minutes = Math.max(1, Math.round(totalMs / 60_000));
  return `${tracks} ${tracks === 1 ? "track" : "tracks"} · ${minutes} min`;
}
export function handleName(name: string, place: number, of: number): string {
  return `Move ${name}, ${place} of ${of}`;
}
export function movedLine(name: string, place: number, of: number): string {
  return `${name} is now ${place} of ${of}.`;
}
export function moreName(name: string): string {
  return `More for ${name}`;
}

export const SEARCH_MUSIC = "Search music";
export const SORT_TRACKS = "Sort tracks";
export const PLAYLISTS = "Playlists";
export const TRACKS = "Tracks";
export const NEW_PLAYLIST = "New playlist";
export const NO_PLAYLISTS = "No playlists yet.";
export const ADD_TO_PLAYLIST = "Add to playlist…";
export const ALREADY_IN_IT = "Already in it";
export const NEW_PLAYLIST_WITH = "New playlist with this track";
export const RENAME_OR_DELETE = "Rename or delete…";
export const EDIT_PLAYLIST = "Edit playlist";
export type Sort = "name" | "long" | "short";
export const SORT_WORDS: Record<Sort, string> = { name: "Name", long: "Longest first", short: "Shortest first" };
export function sortName(sort: Sort): string {
  return `Sort: ${SORT_WORDS[sort]}`;
}
export function noPlaylistMatches(query: string): string {
  return `No playlist matches "${query}".`;
}
export function noTrackMatches(query: string): string {
  return `No track matches "${query}".`;
}
/** Tracks' count beside its heading: "100", or "3 of 100" while a search narrows it. */
export function trackCount(shown: number, all: number, searching: boolean): string {
  return searching ? `${shown} of ${all}` : String(all);
}
export function fullPlaylist(count: number): string {
  return `${count} tracks`;
}
export function addedTo(track: string, playlist: string): string {
  return `Added ${track} to ${playlist}.`;
}

export const NAME = "Name";
export const NAME_PLACEHOLDER = "Tavern night";
export const ADD_TRACKS = "Add tracks";
export const TRACKS_IN_ORDER = "Tracks in order";
export const MUSIC_TO_ADD = "Music to add";
export const CREATE_PLAYLIST = "Create playlist";
export const SAVE = "Save";
export const CANCEL = "Cancel";
export const DELETE_PLAYLIST = "Delete playlist";
export const DELETE_AGAIN = "Tap again to delete";
export const PLAYLIST_TABS = "Playlist";
export const MAKER_EMPTY_WIDE = "No tracks yet. Add them from the list beside this one.";
export const MAKER_EMPTY_NARROW = "No tracks yet. Add them under Add tracks.";
export const ALL_IN = "Every music track is in this playlist.";
/** The server's own words for the 100-track cap, said before anything is sent. */
export const PLAYLIST_FULL = SOUND_WORDS.playlistFull;
export const TRACKS_CHANGED = "Another DM changed this playlist's tracks. Saving keeps your list.";
export const DELETED_ELSEWHERE = "This playlist was deleted on another device. Create playlist makes it again.";
export function tracksTab(count: number): string {
  return `Tracks (${count})`;
}
export function addName(name: string): string {
  return `Add ${name}`;
}
export function removeName(name: string): string {
  return `Remove ${name}`;
}
