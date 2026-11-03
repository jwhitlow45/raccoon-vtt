import type { RoomState, Scene } from "#shared/model.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { occurrencesAt, playingAt, type MusicRun, type Playing, type Playlist, type SceneMusic, type SceneSound, type Sound, type SoundId, type SoundUse } from "#shared/sound.ts";
import type { RoomView } from "../../../state/types.ts";
import { realClock, type Clock } from "../../../state/timing.ts";
import { builtinMs } from "../engine/builtins.ts";
import { STOP_IT_FIRST, STOP_MUSIC_FIRST } from "./words.ts";

/**
 * What the Sound panel reads of the room's sound (docs/design/design-v1-music.md
 * 4.1 and 6), as pure functions of the projected state and the server's
 * time, so the panel's components and their tests share one reading.
 */

export type Sounds = Readonly<Record<SoundId, Sound>>;
export type Playlists = Readonly<Record<string, Playlist>>;

const NO_SOUNDS: Sounds = {};
const NO_PLAYLISTS: Playlists = {};

export function soundsOf(state: Pick<RoomState, "sounds"> | null | undefined): Sounds {
  return state?.sounds ?? NO_SOUNDS;
}

export function playlistsOf(state: Pick<RoomState, "playlists"> | null | undefined): Playlists {
  return state?.playlists ?? NO_PLAYLISTS;
}

/**
 * The server's time as this page reckons it, from the offset the store
 * learned, so the panel's clock reads what every device plays. The engine's
 * own measured offset is finer, but a second's display needs no better.
 */
export function serverNow(room: Pick<RoomView, "serverOffset">, clock: Pick<Clock, "now" | "elapsed"> = realClock): number {
  return room.serverOffset === undefined ? clock.now() : clock.elapsed() + room.serverOffset;
}

/** A sound's name, or a stand-in where the projection leaves it out. */
export function nameOf(sound: Pick<Sound, "name"> | undefined): string {
  return sound?.name ?? "Untitled";
}

/** The room's sounds of one use, by name, as the panel lists them. */
export function soundsByUse(sounds: Sounds, use: SoundUse): Sound[] {
  return Object.values(sounds)
    .filter((s) => s.use === use)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

export function playlistsByName(playlists: Playlists): Playlist[] {
  return Object.values(playlists).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** A playlist's tracks that are still music sounds, in its order: what a play of it sends. */
export function playlistTracks(playlist: Pick<Playlist, "sounds">, sounds: Sounds): Sound[] {
  return playlist.sounds.flatMap((id) => {
    const s = sounds[id];
    return s && s.use === "music" ? [s] : [];
  });
}

export function totalMs(tracks: readonly Pick<Sound, "ms">[]): number {
  return tracks.reduce((sum, t) => sum + t.ms, 0);
}

/** Fisher and Yates, from `random` so a test can fix it. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The order a play of this music sends (6.2): a playlist's music tracks,
 * shuffled when it says so, or the one track. Empty when nothing of it is
 * left to play, so the caller sends nothing.
 */
export function orderFor(music: Pick<SceneMusic, "playlistId" | "soundId" | "shuffle">, playlists: Playlists, sounds: Sounds, random: () => number = Math.random): SoundId[] {
  if (music.playlistId !== undefined) {
    const playlist = playlists[music.playlistId];
    if (!playlist) return [];
    const ids = playlistTracks(playlist, sounds).map((s) => s.id);
    return music.shuffle ? shuffled(ids, random) : ids;
  }
  if (music.soundId !== undefined && sounds[music.soundId]?.use === "music") return [music.soundId];
  return [];
}

/** What Now playing shows of the music at `t` (4.1). */
export type MusicShown = {
  soundId: SoundId;
  name: string;
  lengthMs: number;
  positionMs: number;
  paused: boolean;
  /** The line under the name. */
  playlistName: string | null;
  place: number;
  count: number;
  single: boolean;
  /** The incoming track's name while a crossfade runs, which Skip goes past (6.3). */
  crossingInto: string | null;
};

/** Where the music is at `t`, from the run alone, shared/sound.ts's timeline helpers placing Repeat one's passes. */
export function musicShown(music: MusicRun, sounds: Sounds, playlists: Playlists, t: number): MusicShown | null {
  const paused = music.paused !== undefined;
  const track = paused ? music.now : playingAt(music, t);
  const sound = sounds[track.soundId];
  if (!sound) return null;
  let positionMs: number;
  if (paused) positionMs = music.paused ?? 0;
  else if (music.repeat === "one") {
    const passes = occurrencesAt(track.at, sound.ms, music.fade * 1000, t);
    positionMs = passes[passes.length - 1]?.positionMs ?? 0;
  } else positionMs = t - track.at;
  const order = music.order ?? [track.soundId];
  const at = order.indexOf(track.soundId);
  const crossing = !paused && music.next !== undefined && t >= music.next.at;
  return {
    soundId: sound.id,
    name: nameOf(sound),
    lengthMs: sound.ms,
    positionMs: Math.max(0, Math.min(positionMs, sound.ms)),
    paused,
    playlistName: music.playlistId === undefined ? null : (playlists[music.playlistId]?.name ?? null),
    place: at < 0 ? 1 : at + 1,
    count: Math.max(order.length, 1),
    single: music.playlistId === undefined && order.length <= 1,
    crossingInto: crossing ? nameOf(sounds[music.next!.soundId]) : null,
  };
}

/** Whether anything sounds that the panel can stop or save into a scene. */
export function somethingPlays(playing: Playing | null | undefined): boolean {
  if (!playing) return false;
  return playing.music !== null || Object.keys(playing.loops).length > 0;
}

/**
 * Whether Stop all sound and the X-card's Stop the sound show at `t` (4.1,
 * 4.6): music, paused too, a background sound, or an effect not yet over
 * from either list, so one the DM fired behind a blackout counts. An effect
 * over stays in its list as history and never counts, or the buttons would
 * stay for good (D-261102-704). `until` is when the answer turns false by
 * time alone, the last effect's end, for one render then.
 */
export function soundToStop(playing: Playing | null | undefined, sounds: Sounds, t: number): { now: boolean; until: number | null } {
  if (somethingPlays(playing)) return { now: true, until: null };
  let until: number | null = null;
  for (const e of playing ? [...playing.effects, ...(playing.dmEffects ?? [])] : []) {
    const sound = e.soundId === undefined ? undefined : sounds[e.soundId];
    const ms = e.builtin !== undefined ? builtinMs(e.builtin) : sound?.use === "effect" ? sound.ms : null;
    if (ms !== null && e.at + ms > t) until = Math.max(until ?? 0, e.at + ms);
  }
  return { now: until !== null, until };
}

/** The loop entry that plays this sound, if one does. */
export function loopOf(playing: Playing | null | undefined, soundId: SoundId): string | null {
  if (!playing) return null;
  for (const [id, loop] of Object.entries(playing.loops)) if (loop.soundId === soundId) return id;
  return null;
}

export function loopsFull(playing: Playing | null | undefined): boolean {
  return playing ? Object.keys(playing.loops).length >= SOUND_LIMITS.loops : false;
}

/**
 * The effects sounding at `t`, as keys "sound:<id>" and "builtin:<name>",
 * for the board's pressed buttons, and when the next of them ends, so the
 * board renders once then and not every second. Both lists count: the
 * DM's own fires behind a blackout sound on the DM's devices.
 */
export function effectsSounding(playing: Playing | null | undefined, sounds: Sounds, t: number): { keys: Set<string>; nextEnd: number | null } {
  const keys = new Set<string>();
  let nextEnd: number | null = null;
  if (!playing) return { keys, nextEnd };
  for (const e of [...playing.effects, ...(playing.dmEffects ?? [])]) {
    let key: string;
    let ms: number;
    if (e.builtin !== undefined) {
      key = `builtin:${e.builtin}`;
      ms = builtinMs(e.builtin);
    } else {
      const sound = e.soundId === undefined ? undefined : sounds[e.soundId];
      // History of a sound that is gone or now has another use: playback skips it, so the board does too (6.3).
      if (!sound || sound.use !== "effect") continue;
      key = `sound:${sound.id}`;
      ms = sound.ms;
    }
    const end = e.at + ms;
    if (t < e.at || t >= end) {
      if (t < e.at) nextEnd = nextEnd === null ? e.at : Math.min(nextEnd, e.at);
      continue;
    }
    keys.add(key);
    nextEnd = nextEnd === null ? end : Math.min(nextEnd, end);
  }
  return { keys, nextEnd };
}

/**
 * Why a sound cannot be deleted or given another use now (4.1, 6.3): a
 * track in the live run's order, or a loop that plays. An effect deletes at
 * once and stops, so it is never refused.
 */
export function busyRefusal(playing: Playing | null | undefined, soundId: SoundId): string | null {
  if (!playing) return null;
  const music = playing.music;
  if (music && ((music.order ?? []).includes(soundId) || music.now.soundId === soundId || music.next?.soundId === soundId)) return STOP_MUSIC_FIRST;
  if (loopOf(playing, soundId) !== null) return STOP_IT_FIRST;
  return null;
}

/** Whether a scene's sound names this sound in this use's place: its music track, or a loop. */
function sceneNames(sound: SceneSound, soundId: SoundId, use: SoundUse): boolean {
  if (use === "music") return sound.music?.soundId === soundId;
  if (use === "loop") return sound.loops.some((l) => l.soundId === soundId);
  return false;
}

/**
 * How many playlists and scene sounds a sound leaves when it takes another
 * use (4.1, 6.3), which the reducer does in the same op. A sound leaves
 * only the places its old use held.
 */
export function useLeaves(sound: Pick<Sound, "id" | "use">, next: SoundUse, playlists: Playlists, scenes: Readonly<Record<string, Pick<Scene, "sound">>>): { playlists: number; scenes: number } {
  if (next === sound.use) return { playlists: 0, scenes: 0 };
  const inPlaylists = sound.use === "music" ? Object.values(playlists).filter((p) => p.sounds.includes(sound.id)).length : 0;
  const inScenes = Object.values(scenes).filter((s) => s.sound !== undefined && sceneNames(s.sound, sound.id, sound.use)).length;
  return { playlists: inPlaylists, scenes: inScenes };
}

/** The scenes whose sound names this playlist, which its delete clears (6.3). */
export function scenesNamingPlaylist(playlistId: string, scenes: Readonly<Record<string, Pick<Scene, "sound">>>): number {
  return Object.values(scenes).filter((s) => s.sound?.music?.playlistId === playlistId).length;
}

/**
 * A scene's sound saved from what plays (4.6): the music's playlist with
 * its settings, or its one track, and the loops at their volumes. A run
 * whose playlist was deleted keeps only a label, so the track playing is
 * what a scene can save of it.
 */
export function sceneSoundFrom(playing: Playing | null | undefined, playlists: Playlists): SceneSound {
  const loops = playing ? Object.values(playing.loops).map((l) => ({ soundId: l.soundId, volume: l.volume })) : [];
  const music = playing?.music ?? null;
  if (!music) return { music: null, loops };
  const playlist = music.playlistId === undefined ? undefined : playlists[music.playlistId];
  if (playlist) return { music: { playlistId: playlist.id, repeat: music.repeat, fade: music.fade, ...(playlist.shuffle ? { shuffle: true as const } : null) }, loops };
  return { music: { soundId: music.now.soundId, repeat: music.repeat, fade: music.fade }, loops };
}

/** The names a scene's sound line lists: its playlist or track, then its loops. Empty is silence. */
export function sceneSoundNames(sound: SceneSound, playlists: Playlists, sounds: Sounds): string[] {
  const names: string[] = [];
  const music = sound.music;
  if (music?.playlistId !== undefined) {
    const p = playlists[music.playlistId];
    if (p) names.push(p.name);
  } else if (music?.soundId !== undefined && sounds[music.soundId]) names.push(nameOf(sounds[music.soundId]));
  for (const l of sound.loops) if (sounds[l.soundId]) names.push(nameOf(sounds[l.soundId]));
  return names;
}

/** The order `sound.scene` carries for a scene's sound, worked out on the DM's device as a play's is (6.2). */
export function sceneOrder(sound: SceneSound, playlists: Playlists, sounds: Sounds, random: () => number = Math.random): SoundId[] {
  return sound.music === null ? [] : orderFor(sound.music, playlists, sounds, random);
}
