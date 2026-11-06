import { SOUND_WORDS } from "#shared/reducer/sound.ts";
import type { BuiltinSound, Repeat, SoundUse } from "#shared/sound.ts";

/**
 * Every word Ambiance's Sound shows (docs/design/design-v1-music.md 4.1,
 * 4.3 and 10), in one place so the render tests, the e2e steps and the
 * DM guide read the same text.
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
export const NEW_PLAYLIST = "New playlist";
export const NEW_PLAYLIST_NAME = "New playlist";
export const PLAYING_CHANGES = "Changes apply the next time it starts.";
export const NO_TRACKS = "No tracks yet. Add tracks from the room's music.";
export const NO_MUSIC = "No music yet.";
export const NO_LOOPS = "No background sounds yet.";
export const NO_EFFECTS = "No effects added yet.";
export const ALL_TRACKS_IN = "Every music track is in this playlist.";
export const BUILT_IN = "Built in";
export const LOADING_MUSIC = "Loading the music…";
export const MUSIC_FAILED = "The music didn't load on this device.";
export const TAP_TO_START = "Tap anywhere to start the sound.";
export const STORAGE_CHECKING = "Checking storage…";
export const STORAGE_FAILED = "Couldn't check storage.";
export const STOP_THE_SOUND = "Stop the sound";
export const LISTEN_HELP = "Listen here plays it on this device alone.";

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

/** The player's Now playing (4.3): names when the DM shares them, else a count. */
export function playerMusicLine(name: string | null): string {
  return name === null ? "Music is playing." : `Music: ${name}`;
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

/** The reducer's own refusals, so a refusal the panel says first reads as the server's would. */
export const STOP_MUSIC_FIRST = SOUND_WORDS.trackPlaying;
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
