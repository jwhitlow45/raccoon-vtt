import { SOUND_WORDS } from "#shared/reducer/sound.ts";
import type { BuiltinSound, Repeat, SoundUse } from "#shared/sound.ts";

/**
 * Every word the Sound panel shows (docs/design/design-v1-music.md 4.1,
 * 4.3 and 10), and the Sound and Time panels' own, the Now playing chip's
 * and Table sound's (docs/design/design-v1-sound-layout.md 9), in one place
 * so the render tests, the e2e steps and the DM guide read the same text.
 * The words the Music window had, which the Sound panel and the maker keep (the player, Up next,
 * Library and the maker) are in music/words.ts.
 */

export const NOTHING_PLAYING = SOUND_WORDS.nothingPlaying;
export const NAMES_SWITCH = "Players see what is playing";
export const NAMES_HELP = "Players see the names of the music and background sounds playing now. Off, they only hear them.";
export const DEVICE_SILENT = "This device plays no sound. Turn on Room sound under On this device.";
export const ANOTHER_WINDOW = "Another window on this device plays the sound.";
export const SERVER_OFF = "This server doesn't offer sound files. Its owner can turn them on. The built-in effects still work.";
export const SERVER_CHECKING = "Checking for sound files…";
export const SERVER_FAILED = "Couldn't check whether this server offers sound files. The built-in effects still work.";
export const STOP_ALL = "Stop all sound";
export const SKIP_NEXT = "Skip to the next track";
export const STOP_MUSIC = "Stop the music";
export const MUSIC_VOLUME = "Music volume for everyone";
export const EFFECTS_VOLUME = "Effects volume for everyone";
export const SCENE_HELP = "It plays when you move the players to this scene.";
export const PLAY_FIRST = "Play something first.";
export const USE_PLAYING = "Use what's playing";
export const USE_SILENCE = "Use silence";
export const PLAY_IT = "Play it";
export const CLEAR = "Clear";
export const NEW_PLAYLIST_NAME = "New playlist";
export const PLAYING_CHANGES = "Changes apply the next time it starts.";
export const NO_MUSIC = "No music yet.";
export const NO_LOOPS = "No background sounds yet.";
export const NO_EFFECTS = "No effects added yet.";
export const BUILT_IN = "Built in";
export const LOADING_MUSIC = "Loading the music…";
export const MUSIC_FAILED = "The music didn't load on this device.";
export const TAP_TO_START = "Tap anywhere to start the sound.";
export const STORAGE_CHECKING = "Checking storage…";
export const STORAGE_FAILED = "Couldn't check storage.";
export const STOP_THE_SOUND = "Stop the sound";
export const LISTEN_HELP = "Listen here plays it on this device alone.";

/* The Sound and Time panels (docs/design/design-v1-sound-layout.md 3 and 4). */
export const SOUND_TITLE = "Sound";
export const TIME_TITLE = "Time";
/** A Sound subpage's back button, a track's or a background sound's page (4.5). */
export const BACK_TO_SOUND = "Back to Sound";
/** The view row's name, a radio group of Now playing and Library (4.1). */
export const SOUND_VIEWS = "Sound";
export const NOW_VIEW = "Now playing";
export const LIBRARY_VIEW = "Library";
/**
 * The panel's player with no music (4.2): "Library" is a link button that
 * moves the view and focus to Library's search, so the line comes in parts.
 */
export const NO_MUSIC_PICK = Object.freeze({ before: "No music is playing. Pick a playlist or a track in ", link: "Library", after: "." });
/** The chip's player with no music (5.3), where there is no Library to pick from. */
export const NO_MUSIC_PLAYING = "No music is playing.";

/*
 * Table sound, once What players hear (7): visible labels without "for
 * everyone", since the help says so once. The accessible names keep it
 * (MUSIC_VOLUME, EFFECTS_VOLUME, loopVolumeName), so a reader still hears
 * whose volume it is.
 */
export const TABLE_SOUND = "Table sound";
export const TABLE_SOUND_HELP = "What everyone at the table hears, set here for every device. Each device can turn itself down under On this device.";
export const MUSIC_LABEL = "Music";
export const EFFECTS_LABEL = "Effects";
/** How Room sound's help begins under On this device, so it reads apart from Table sound's (7). */
export const THIS_DEVICE_ONLY = "This device only:";

/* The Now playing chip and its player (5). */
export const CHIP_PAUSE = "Pause";
export const CHIP_PLAY = "Play";
/** The chip's player, a popover, a card or a sheet, all named so (5.3). */
export const PLAYER_TITLE = "Now playing";
export const BACKGROUND = "Background";
export const OPEN_SOUND = "Open Sound";
export const OPENING_PLAYER = "Opening the player…";
export const PLAYER_FAILED = "Couldn't open the player.";
/** The maker's pop-up while its code loads, and when it fails to (9). */
export const OPENING_PLAYLIST = "Opening the playlist…";
export const PLAYLIST_FAILED = "Couldn't open the playlist.";
/** A player's Now playing card while the DM keeps the names (7). */
export const MUSIC_IS_PLAYING = "Music is playing";

/** "1 background sound", "3 background sounds": the chip with only background sounds, and Now playing's line with no music. */
export function backgroundCount(n: number): string {
  return n === 1 ? "1 background sound" : `${n} background sounds`;
}

/**
 * What the chip shows (5.1 and 5.2): the music by the name Now playing
 * gives it and its run line (runLine), paused or not, background sounds
 * alone, or, once playback ended while its player stays open, its stopped
 * state.
 */
export type ChipShows = { t: "music"; name: string; run: string; paused: boolean } | { t: "background"; count: number } | { t: "stopped" };

/** The chip's visible text, beside Pause or Play: the track's name, "Paused · " before it while paused, the background count, or "Now playing" once stopped. */
export function chipText(shows: ChipShows): string {
  if (shows.t === "music") return shows.paused ? `Paused · ${shows.name}` : shows.name;
  if (shows.t === "background") return backgroundCount(shows.count);
  return PLAYER_TITLE;
}

/** The name of the chip's button that opens its player, not a live region: a reader hears it on reaching the chip. */
export function chipName(shows: ChipShows): string {
  if (shows.t === "music") return `${shows.paused ? "Now playing, paused" : "Now playing"}: ${shows.name}, ${shows.run}`;
  if (shows.t === "background") return `Now playing: ${backgroundCount(shows.count)}`;
  return "Now playing, stopped";
}

/** The built-in effects in the board's order, the trap sounds every device makes (D-261102-461). */
export const BUILTINS: readonly { id: BuiltinSound; name: string }[] = [
  { id: "click", name: "Click" },
  { id: "rumble", name: "Rumble" },
  { id: "crash", name: "Crash" },
  { id: "whoosh", name: "Whoosh" },
  { id: "hiss", name: "Hiss" },
];

export const USE_NAMES: Record<SoundUse, string> = { music: "Music", loop: "Background", effect: "Effect" };


export const ADD_WORDS: Record<SoundUse, string> = { music: "Add music…", loop: "Add background sounds…", effect: "Add effects…" };

/** The state the Repeat button names (4.1), and the next one a press steps to. */
export const REPEAT_NAMES: Record<Repeat, string> = { all: "Repeat all", one: "Repeat one", off: "Repeat off" };
export const REPEAT_NEXT: Record<Repeat, Repeat> = { all: "one", one: "off", off: "all" };
export const REPEAT_CHOICES: Record<Repeat, string> = { all: "All", one: "One", off: "Off" };

/** A position or a length as a clock reads it: "1:24", or "1:02:05" past an hour. */
export function clockText(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "1:24 / 3:10" on screen, "1:24 of 3:10" for a screen reader (10). */
export function timeShown(positionMs: number, lengthMs: number): { text: string; spoken: string } {
  const at = clockText(Math.min(positionMs, lengthMs));
  const of = clockText(lengthMs);
  return { text: `${at} / ${of}`, spoken: `${at} of ${of}` };
}

/** A playlist's row detail: "12 tracks · 41 min". */
export function playlistDetail(tracks: number, totalMs: number): string {
  if (tracks === 0) return "No tracks";
  const minutes = Math.max(1, Math.round(totalMs / 60_000));
  return `${tracks} ${tracks === 1 ? "track" : "tracks"} · ${minutes} min`;
}

/**
 * The line under the music's name (4.1): "Tavern night · 3 of 12", "3 of
 * 12" once the playlist is gone, since the run keeps its old id only as a
 * label, and "One track" for a single track.
 */
export function runLine(run: { playlistName: string | null; place: number; count: number; single: boolean }): string {
  if (run.single) return "One track";
  const where = `${run.place} of ${run.count}`;
  return run.playlistName === null ? where : `${run.playlistName} · ${where}`;
}

/** Skip's name: past the incoming track while a crossfade runs, since Now playing already names it (6.3). */
export function skipName(crossingInto: string | null): string {
  return crossingInto === null ? SKIP_NEXT : `Skip past ${crossingInto}`;
}

export function playName(name: string): string {
  return `Play ${name}`;
}

/** The playing row's Pause, Now playing's word with the row's name. */
export function pauseName(name: string): string {
  return `Pause ${name}`;
}

export function stopName(name: string): string {
  return `Stop ${name}`;
}

export function loopVolumeName(name: string): string {
  return `${name} volume for everyone`;
}

export function fireName(name: string): string {
  return `Play ${name} for everyone`;
}

/** The scene's sound line (4.1), for the scene on the DM's screen. */
export function sceneLine(sceneName: string, sound: { names: string[] } | null): string {
  if (sound === null) return `${sceneName} has no sound of its own.`;
  if (sound.names.length === 0) return `${sceneName} is silent.`;
  return `${sceneName}'s sound: ${sound.names.join(", ")}.`;
}

export function playerLoopsLine(names: (string | null)[]): string | null {
  if (names.length === 0) return null;
  const known = names.filter((n): n is string => n !== null);
  if (known.length === names.length) return `Background: ${known.join(", ")}`;
  return names.length === 1 ? "1 background sound is playing." : `${names.length} background sounds are playing.`;
}

/** A sound's length beside its name, "0:42", on Background's toggles and a sound's page. */
export function lengthText(ms: number): string {
  return clockText(ms);
}

/** Delete's second tap on a sound's page (4.1). */
export function deleteSoundAsk(name: string): string {
  return `Delete ${name}? Its file goes too, and it leaves every playlist and scene.`;
}

/** The reducer's own refusals, so a refusal the panel says first reads as the server's would (docs/design/design-v1-music-player.md 6.4). */
export const TRACK_PLAYS = SOUND_WORDS.trackPlays;
export const TRACK_PLAYS_NEXT = SOUND_WORDS.trackPlaysNext;
export const TRACK_QUEUED = SOUND_WORDS.trackQueued;
export const STOP_IT_FIRST = SOUND_WORDS.loopPlaying;
export const FIFTH_LOOP = SOUND_WORDS.fifthLoop;

/** What a change of use takes the sound out of (4.1), or null when nothing names it. */
export function useLeavesLine(name: string, playlists: number, scenes: number): string | null {
  const parts: string[] = [];
  if (playlists > 0) parts.push(`${playlists} ${playlists === 1 ? "playlist" : "playlists"}`);
  if (scenes > 0) parts.push(`${scenes} ${scenes === 1 ? "scene" : "scenes"}`);
  if (parts.length === 0) return null;
  return `${name} leaves ${parts.join(" and ")}.`;
}

/** The second tap of Delete playlist, when scenes name it (4.1). */
export function playlistLeavesScenes(scenes: number): string | null {
  if (scenes === 0) return null;
  return scenes === 1 ? "It leaves 1 scene's sound." : `It leaves ${scenes} scenes' sound.`;
}

/** Sizes as the storage line says them, in the binary units the room's quota is set in. */
export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(Math.round(gb * 10) / 10) ? Math.round(gb) : (Math.round(gb * 10) / 10).toFixed(1)} GB`;
  }
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return bytes === 0 ? "0 MB" : "under 1 MB";
}

/** The storage line (4.1 item 6, 7.2): "Sounds use 212 MB. Images and sounds share the room's 1 GB, and 640 MB is free." */
export function storageLine(storage: { used: number; quota: number; sounds: number }): string {
  const free = Math.max(0, storage.quota - storage.used);
  return `Sounds use ${sizeText(storage.sounds)}. Images and sounds share the room's ${sizeText(storage.quota)}, and ${sizeText(free)} is free.`;
}
