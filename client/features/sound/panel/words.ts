import { SOUND_WORDS } from "#shared/reducer/sound.ts";
import type { BuiltinSound, Repeat, SoundUse } from "#shared/sound.ts";

/**
 * Every word the Sound panel shows (docs/design/design-v1-music.md 4.1,
 * 4.3 and 10), and its views', the Now playing chip's and its player's,
 * and Table sound's (docs/design/design-v1-sound-layout.md 9), in one place
 * so the render tests, the e2e steps and the DM guide read the same text.
 * The player's own, Up next's, Library's and the playlist maker's are in
 * music/words.ts.
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
/**
 * Who hears what the DM sets or fires. "everyone" is the usual room. "dm" is
 * Only DM devices play, or a blackout, when only the DM's devices sound it,
 * so a name saying "for everyone" would be false.
 */
export type Hearers = "everyone" | "dm";
const FOR_EVERYONE = " for everyone";
function hearersTail(h: Hearers): string {
  return h === "everyone" ? FOR_EVERYONE : "";
}
export const MUSIC_VOLUME = "Music volume for everyone";
export const EFFECTS_VOLUME = "Effects volume for everyone";
export function musicVolume(h: Hearers = "everyone"): string {
  return `Music volume${hearersTail(h)}`;
}
export function effectsVolume(h: Hearers = "everyone"): string {
  return `Effects volume${hearersTail(h)}`;
}
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

/* The Sound panel (docs/design/design-v1-sound-layout.md 4). Its subpages' "Back to Sound" is the panel header's, from this title. */
export const SOUND_TITLE = "Sound";
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
export const TABLE_SOUND_HELP = "What everyone at the table hears, set here for every device. Each device sets its own volume from the speaker on its top bar.";
export const MUSIC_LABEL = "Music";
export const EFFECTS_LABEL = "Effects";
/** How Room sound's help begins under On this device, so it reads apart from Table sound's (7). */
export const THIS_DEVICE_ONLY = "This device only:";
/** Only DM devices play (docs/design/design-v1-sound-dm-only.md 4), the last switch in Table sound. */
export const DM_ONLY_SWITCH = "Only DM devices play";
export const DM_ONLY_HELP = "For a table that hears the sound from one speaker. Players' devices and the table display play nothing and don't ask. Each DM device still plays unless it is muted.";
/** The DM's reminder while it is on, in Now playing and the chip's player, so a game played apart never starts silent unnoticed. */
export const DM_ONLY_ON = "Only DM devices play the sound.";
/** A player's line while it is on (5), in the Sound panel and This device, the same whether or not anything plays. */
export const DM_PLAYS_IT = "The DM plays the sound on their own device.";

/*
 * This device's volume (docs/design/design-v1-volume.md 4 and 9): the top
 * bar's speaker and its popover, card or sheet, This device's Sounds and
 * the Sound panel's On this device, one set of controls with one set of
 * words.
 */
export const VOLUME = "Volume";
export const MUTE = "Mute";
export const UNMUTE = "Unmute";
export const MUTED = "Muted";
/** The level as a menu row's note, a summary or the master slider's value: "80%", or "Muted" whatever level it keeps. */
export function volumeNote(v: { muted: boolean; volume: number }): string {
  return v.muted ? MUTED : `${v.volume}%`;
}
/** The speaker's name, which carries its value for a screen reader. */
export function speakerName(v: { muted: boolean; volume: number }): string {
  return v.muted ? "Volume on this device: muted" : `Volume on this device: ${v.volume}%`;
}
/** The controls' help on a player's device, which keeps the pointer to Only DM devices play for a table that plays together (D-261108-384). */
export const DEVICE_HELP_PLAYER = "This device only. At one table, the DM can turn on Only DM devices play in Sound. Music uses about 60 MB of data an hour, none while muted. On an iPhone it pauses other apps' music and plays even with the ringer off.";
/** On a DM device the pointer is to Table sound, the volumes for everyone. */
export const DEVICE_HELP_DM = "This device only. Table sound, in Sound, sets the volumes for everyone. Music uses about 60 MB of data an hour, none while muted. On an iPhone it pauses other apps' music and plays even with the ringer off.";
export const TURN_SOUND = "Turn sound";
/** Turn sound's help, here and in the Initiative panel's copy. It gates a trap's sound too, and neither waits on the mute (D-261108-364, 381). */
export const TURN_SOUND_HELP = "A short chime on your turn and a trap's sound, even while muted. Android phones also vibrate.";
export const PING_SOUND = "Ping sound";
export const PING_SOUND_HELP = "A short tone when someone pings the map, even while muted.";
/** A browser without what the mixer needs, in the controls' line and the DM's Now playing. */
export const CANNOT_PLAY = "This browser can't play the room's sound.";
/** The DM's Now playing on a muted device, beside its Unmute (6). */
export const DEVICE_MUTED = "This device is muted.";

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

export function loopVolumeName(name: string, h: Hearers = "everyone"): string {
  return `${name} volume${hearersTail(h)}`;
}

export function fireName(name: string, h: Hearers = "everyone"): string {
  return `Play ${name}${hearersTail(h)}`;
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
