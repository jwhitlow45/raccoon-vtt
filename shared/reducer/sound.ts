import { keys } from "../keys.ts";
import { SOUND_LIMITS, soundUseFits } from "../limits.ts";
import { musicQueues, musicSetReveals } from "../migrate.ts";
import type { RoomState, Scene } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { namesPrototypeMember, ownEntry } from "../records.ts";
import {
  LEAD_MS,
  MusicRefusal,
  effectLengthMs,
  jumpedAt,
  lengthAs,
  musicAt,
  musicChanged,
  queueEdited,
  seekBoundMs,
  type FiredEffect,
  type LoopPlaying,
  type MusicChange,
  type MusicRefusalKey,
  type MusicRun,
  type Playing,
  type Playlist,
  type SceneSound,
  type Sound,
  type SoundId,
  type SoundUse,
} from "../sound.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * Synced music and sound (docs/design/design-v1-music.md 6.3): the DM's
 * library, playlists, a scene's sound, and what plays now.
 *
 * Every start is the op's server time plus LEAD_MS, so replay lands on the
 * same times and every device has time to begin together. Devices play
 * from the confirmed state only. No Setup op (a sound's update, the
 * playlist ops, a scene's sound, the names switch) writes `playing`
 * (D-261102-471): an undo guards what it wrote, and the next tick or volume
 * change would refuse it. What such an op leaves stale there, a deleted
 * playlist's id as a run's label or an effect given another use, is read
 * through at playback.
 */

/** The refusals the DM's panel shows (4.1), in its words. */
export const SOUND_WORDS = {
  loopPlaying: "Stop it first. It is playing now.",
  fifthLoop: "Up to four background sounds can play at once. Stop one first.",
  loopTwice: "That background sound is already playing.",
  libraryFull: `The room keeps ${SOUND_LIMITS.soundsPerRoom} sounds at most. Delete one first.`,
  playlistsFull: `The room keeps ${SOUND_LIMITS.playlistsPerRoom} playlists at most. Delete one first.`,
  orderChanged: "The playlist changed. Try again.",
  notMusic: "That track isn't in the music any more.",
  notLoop: "That background sound isn't in the room any more.",
  notEffect: "That effect isn't in the room any more.",
  nothingPlaying: "Nothing is playing.",
  firedTwice: "That effect was already played.",
  // The queue, Up next and the playlist maker (docs/design/design-v1-music-player.md 6.4 and 8). The last three are a
  // delete's and a change of use's refusals for a track the music holds, by where the queue holds it.
  musicChanged: "The music changed. Try again.",
  musicMovedOn: "The music moved on. Try again.",
  queueFull: `The queue holds ${SOUND_LIMITS.playlistTracks} tracks at most.`,
  leftQueue: "That track left the queue.",
  playingStays: "The playing track stays in the queue. Skip it or stop the music.",
  playlistFull: `A playlist holds ${SOUND_LIMITS.playlistTracks} tracks at most.`,
  trackPlays: "This track is playing. Skip it or stop the music first.",
  trackPlaysNext: "This track plays next. Take it out of Up next first.",
  trackQueued: "This track is in the queue. Take it out under Up next first.",
} as const;

/** The words of each refusal the queue's helpers throw (shared/sound.ts MusicRefusal), which must all be SOUND_WORDS'. */
export const MUSIC_REFUSAL_WORDS: Readonly<Record<MusicRefusalKey, string>> = SOUND_WORDS;

/** Why a length does not fit a use, in the sound page's words (4.1). */
export function useLengthRefusal(use: SoundUse, ms: number): string | null {
  if (soundUseFits(use, ms)) return null;
  const short = ms < SOUND_LIMITS.use[use].minMs;
  switch (use) {
    case "music":
      return short ? "Music is 30 seconds at least." : "Music is 15 minutes at most.";
    case "loop":
      return short ? "Background sounds are 2 seconds at least." : "Background sounds are 15 minutes at most.";
    case "effect":
      return short ? "Effects are a fifth of a second at least." : "Effects are 30 seconds at most.";
  }
}

/** The reverse reference refusal of an undo that would change a sound's use while it plays (6.6). */
export function playingAsRefusal(name: string, use: SoundUse): string {
  return `Stop ${name} first. It is playing as ${use === "loop" ? "background" : use === "music" ? "music" : "an effect"}.`;
}

/** Whether a refusal is playingAsRefusal's, which the undo stack answers by keeping the step for after the stop. */
export function isPlayingRefusal(reason: string): boolean {
  return reason.startsWith("Stop ") && /first\. It is playing as (background|music|an effect)\.$/.test(reason);
}

/** Room volumes start at full: each device's own sliders, 80% at first, set what it hears (4.4). */
const SILENCE: Playing = { rev: 0, music: null, loops: {}, effects: [], volume: { music: 100, effects: 100 } };

export function soundsOf(state: Pick<RoomState, "sounds">): Record<SoundId, Sound> {
  return state.sounds ?? {};
}

export function playingOf(state: Pick<RoomState, "playing">): Playing {
  return state.playing ?? SILENCE;
}

/** The server time an op's sound starts at: its envelope's time and the lead. */
function startOf(tx: Tx): number {
  return Date.parse(tx.env.at) + LEAD_MS;
}

/**
 * The refusal of a delete or a change of use of a sound a run names
 * (docs/design/design-v1-music-player.md 6.4), in the words that point at
 * what to do: the playing track, the revealed next, or a track only
 * queued, which Up next always shows a row for. Null when the run names
 * none of it.
 */
function queuedRefusal(music: MusicRun | null, soundId: SoundId): string | null {
  if (music === null) return null;
  if (music.now.soundId === soundId) return SOUND_WORDS.trackPlays;
  if (music.next?.soundId === soundId) return SOUND_WORDS.trackPlaysNext;
  return (music.order ?? []).includes(soundId) ? SOUND_WORDS.trackQueued : null;
}

/** Whether the live run's order or a playing loop names a sound, and which. Effect entries are history and never count (D-261102-471). */
export function soundPlays(playing: Playing, soundId: SoundId): "music" | "loop" | null {
  if (playing.music?.order?.includes(soundId) || playing.music?.now.soundId === soundId) return "music";
  return Object.values(playing.loops).some((loop) => loop.soundId === soundId) ? "loop" : null;
}

function soundOf(tx: Tx, id: SoundId): Sound {
  const sound = ownEntry(tx.state.sounds, id);
  if (!sound) throw gone("sound");
  return sound;
}

function playlistOf(tx: Tx, id: string): Playlist {
  const playlist = ownEntry(tx.state.playlists, id);
  if (!playlist) throw gone("playlist");
  return playlist;
}

/** Ids of a record in a fixed order, so a scan writes the same entities in the same order on replay whatever a jsonb round trip did to the keys. */
function sortedIds(record: Readonly<Record<string, unknown>> | undefined): string[] {
  return Object.keys(record ?? {}).sort();
}

/** Every track a playlist names is a music sound of the library. */
function checkTracks(state: RoomState, ids: readonly SoundId[]): void {
  for (const id of ids) if (lengthAs(soundsOf(state), id, "music") === undefined) throw invalid(SOUND_WORDS.notMusic);
}

/**
 * A scene's sound as a `scene.update` stores it, refused where it names a
 * playlist that is gone, or a sound that is gone or of another use, so a
 * scene sound always plays what it says (6.6's forward references). Called
 * by the scene's update in room.ts.
 */
export function checkedSceneSound(state: RoomState, sound: SceneSound): SceneSound {
  const music = sound.music;
  if (music?.playlistId !== undefined && !ownEntry(state.playlists, music.playlistId)) throw gone("playlist");
  if (music?.soundId !== undefined && lengthAs(soundsOf(state), music.soundId, "music") === undefined) throw invalid(SOUND_WORDS.notMusic);
  for (const loop of sound.loops) if (lengthAs(soundsOf(state), loop.soundId, "loop") === undefined) throw invalid(SOUND_WORDS.notLoop);
  return sound;
}

// The library (6.3).

export function soundCreate(tx: Tx, op: OpOf<"sound.create">): void {
  if (ownEntry(tx.state.sounds, op.id)) throw invalid("sound already exists");
  if (Object.keys(soundsOf(tx.state)).length >= SOUND_LIMITS.soundsPerRoom) throw invalid(SOUND_WORDS.libraryFull);
  const refusal = useLengthRefusal(op.use, op.ms);
  if (refusal) throw invalid(refusal);
  const sound: Sound = { id: op.id, rev: 0, name: op.name, assetId: op.assetId, ms: op.ms, use: op.use };
  if (op.level !== undefined && op.level !== 0) sound.level = op.level;
  tx.write(keys.sound(op.id), sound);
}

/**
 * A rename or a change of use (Setup). A change of use is refused while
 * the live run's order or a loop names the sound, and takes it out of
 * every playlist and scene sound it no longer fits, in the same op. It
 * never writes `playing`, so a queued track stays in the order and the
 * refusal points at its row in Up next
 * (docs/design/design-v1-music-player.md 6.4). An entry for it in either
 * effect list stays as history, which playback, the projection and the
 * visible set skip.
 */
export function soundUpdate(tx: Tx, op: OpOf<"sound.update">): void {
  const before = soundOf(tx, op.id);
  const next: Sound = { ...before };
  if (op.name !== undefined) next.name = op.name;
  if (op.use !== undefined && op.use !== before.use) {
    const refusal = useLengthRefusal(op.use, before.ms);
    if (refusal) throw invalid(refusal);
    const playing = playingOf(tx.state);
    const plays = soundPlays(playing, op.id);
    // The stored run decides, since no Setup op writes it and a run naming a track of another use could not play.
    // The words read the run as the panel shows it, during a crossfade the incoming track's.
    if (plays === "music") throw invalid(queuedRefusal(musicAt(playing.music, soundsOf(tx.state), startOf(tx)), op.id) ?? queuedRefusal(playing.music, op.id)!);
    if (plays === "loop") throw invalid(SOUND_WORDS.loopPlaying);
    next.use = op.use;
  }
  tx.write(keys.sound(op.id), next);
  if (next.use !== before.use) leaveWhatNoLongerFits(tx, op.id, next.use);
}

/** Takes a sound out of every playlist and scene sound that names it under a use it no longer has, or under any use once it is gone. */
function leaveWhatNoLongerFits(tx: Tx, soundId: SoundId, use: SoundUse | null): void {
  if (use !== "music") {
    for (const id of sortedIds(tx.state.playlists)) {
      const playlist = ownEntry(tx.state.playlists, id)!;
      if (playlist.sounds.includes(soundId)) tx.write(keys.playlist(id), { ...playlist, sounds: playlist.sounds.filter((s) => s !== soundId) });
    }
  }
  for (const id of sortedIds(tx.state.scenes)) {
    const scene = ownEntry(tx.state.scenes, id)!;
    const sound = scene.sound;
    if (!sound) continue;
    const music = sound.music?.soundId === soundId && use !== "music" ? null : sound.music;
    const loops = use === "loop" ? sound.loops : sound.loops.filter((l) => l.soundId !== soundId);
    if (music !== sound.music || loops.length !== sound.loops.length) tx.write(keys.scene(id), { ...scene, sound: { music, loops } } satisfies Scene);
  }
}

/**
 * Deletes a sound (no step). Refused for a loop that plays, the playing
 * track and the revealed next (4.1). A track the run only queues leaves
 * its order in the same op and the music plays on, read and written
 * through musicAt like every music rule, so during a crossfade the
 * incoming track is the playing one (docs/design/design-v1-music-player.md
 * 6.4). Ops stored before version 48 met the older rule, which refused
 * every track of the order, so they replay by it. Its entries leave both
 * effect lists, so a sounding effect stops on every device, and it leaves
 * every playlist and scene sound in the same op. Its file goes when
 * nothing names its row.
 */
export function soundDelete(tx: Tx, op: OpOf<"sound.delete">): void {
  soundOf(tx, op.id);
  const before = playingOf(tx.state);
  let playing = before;
  if (soundPlays({ ...before, music: null }, op.id) === "loop") throw invalid(SOUND_WORDS.loopPlaying);
  if (musicQueues(tx.env.opVersion)) {
    playing = { ...before, music: withoutQueued(before.music, soundsOf(tx.state), op.id, startOf(tx)) };
  } else {
    const refusal = queuedRefusal(before.music, op.id);
    if (refusal) throw invalid(refusal);
  }
  const named = (e: FiredEffect) => e.soundId === op.id;
  if (playing.effects.some(named) || (playing.dmEffects ?? []).some(named)) {
    playing = withLists(playing, playing.effects.filter((e) => !named(e)), (playing.dmEffects ?? []).filter((e) => !named(e)));
  }
  if (playing.music !== before.music || playing.effects !== before.effects || playing.dmEffects !== before.dmEffects) tx.write(keys.playing, playing);
  tx.remove(keys.sound(op.id));
  leaveWhatNoLongerFits(tx, op.id, null);
}

/**
 * The run a delete leaves at `t`: the stored run itself when it names no
 * part of the sound, else the run musicAt gives with the track out of its
 * order and `index` kept on the playing track, or null when the schedule
 * ended the run by `t`. Refused for the playing track and the revealed
 * next, which sound now or within 20 s on players' devices.
 */
function withoutQueued(music: MusicRun | null, sounds: Record<SoundId, Sound>, soundId: SoundId, t: number): MusicRun | null {
  if (music === null || queuedRefusal(music, soundId) === null) return music;
  const current = musicAt(music, sounds, t);
  if (current === null) return null;
  const refusal = queuedRefusal(current, soundId);
  if (refusal !== null && refusal !== SOUND_WORDS.trackQueued) throw invalid(refusal);
  const order = (current.order ?? []).filter((id) => id !== soundId);
  return { ...current, order, index: order.indexOf(current.now.soundId) };
}

/** `playing` with its effect lists, the DM's kept only while it holds an entry. */
function withLists(playing: Playing, effects: FiredEffect[], dmEffects: FiredEffect[]): Playing {
  const { dmEffects: _was, ...rest } = playing;
  return dmEffects.length > 0 ? { ...rest, effects, dmEffects } : { ...rest, effects };
}

// Playlists (Setup).

export function playlistCreate(tx: Tx, op: OpOf<"playlist.create">): void {
  if (ownEntry(tx.state.playlists, op.id)) throw invalid("playlist already exists");
  if (Object.keys(tx.state.playlists ?? {}).length >= SOUND_LIMITS.playlistsPerRoom) throw invalid(SOUND_WORDS.playlistsFull);
  checkTracks(tx.state, op.sounds);
  const playlist: Playlist = { id: op.id, rev: 0, name: op.name, sounds: op.sounds, repeat: op.repeat, fade: op.fade };
  if (op.shuffle) playlist.shuffle = true;
  tx.write(keys.playlist(op.id), playlist);
}

/** Changes play from the playlist's next start: a run keeps its own order, which only the queue's edits change (docs/design/design-v1-music-player.md 6.1). */
export function playlistUpdate(tx: Tx, op: OpOf<"playlist.update">): void {
  const before = playlistOf(tx, op.id);
  const next: Playlist = { ...before };
  if (op.name !== undefined) next.name = op.name;
  if (op.sounds !== undefined) {
    checkTracks(tx.state, op.sounds.filter((id) => !before.sounds.includes(id)));
    next.sounds = op.sounds;
  }
  if (op.shuffle === true) next.shuffle = true;
  else if (op.shuffle === false) delete next.shuffle;
  if (op.repeat !== undefined) next.repeat = op.repeat;
  if (op.fade !== undefined) next.fade = op.fade;
  tx.write(keys.playlist(op.id), next);
}

/** Clears the music of every scene sound that names the playlist. A live run keeps its id as a label, and its Shuffle off then changes only the flag (6.3, docs/design/design-v1-music-player.md 6.4). */
export function playlistDelete(tx: Tx, op: OpOf<"playlist.delete">): void {
  playlistOf(tx, op.id);
  for (const id of sortedIds(tx.state.scenes)) {
    const scene = ownEntry(tx.state.scenes, id)!;
    if (scene.sound?.music?.playlistId === op.id) tx.write(keys.scene(id), { ...scene, sound: { ...scene.sound, music: null } } satisfies Scene);
  }
  tx.remove(keys.playlist(op.id));
}

// What plays (no step).

/** `playing` written, if anything in it changed. */
function play(tx: Tx, before: Playing, next: Playing): void {
  if (next === before) return;
  tx.write(keys.playing, next);
}

/**
 * The run a play or a scene starts: the order the DM's device fixed must
 * hold the playlist's tracks, each once, or the one track, each a music
 * sound now (6.3). Only here must an order match a playlist: from its
 * start the run's order is the queue, which the queue's edits change
 * (docs/design/design-v1-music-player.md 6.1). `shuffle` says the DM's
 * device mixed the order, which Shuffle's button shows.
 */
function startedRun(tx: Tx, from: { playlistId?: string; soundId?: SoundId }, order: readonly SoundId[], run: string, index: number, settings: Pick<MusicRun, "repeat" | "fade" | "shuffle">, t: number): MusicRun {
  if (from.playlistId !== undefined) {
    const playlist = playlistOf(tx, from.playlistId);
    const listed = new Set(playlist.sounds);
    if (order.length !== playlist.sounds.length || new Set(order).size !== order.length || !order.every((id) => listed.has(id))) throw invalid(SOUND_WORDS.orderChanged);
  } else if (order.length !== 1 || order[0] !== from.soundId) {
    throw invalid("one track plays alone");
  }
  checkTracks(tx.state, order);
  if (index >= order.length) throw invalid("the first track lies in the order");
  return {
    run,
    ...(from.playlistId !== undefined ? { playlistId: from.playlistId } : {}),
    order: [...order],
    index,
    repeat: settings.repeat,
    fade: settings.fade,
    now: { soundId: order[index]!, at: t },
    ...(settings.shuffle === true ? { shuffle: true as const } : {}),
  };
}

export function musicPlay(tx: Tx, op: OpOf<"music.play">): void {
  const playing = playingOf(tx.state);
  const from = op.playlistId !== undefined ? { playlistId: op.playlistId } : { soundId: op.soundId! };
  const music = startedRun(tx, from, op.order, op.run, op.index ?? 0, op, startOf(tx));
  play(tx, playing, { ...playing, music });
}

/** Pause, resume, skip, stop and a change of repeat or crossfade, each on the track sounding at the op's time (musicChanged). */
export function musicChange(tx: Tx, change: MusicChange): void {
  const playing = playingOf(tx.state);
  const t = startOf(tx);
  const sounds = soundsOf(tx.state);
  if (change.t === "stop") {
    if (playing.music !== null) play(tx, playing, { ...playing, music: null });
    return;
  }
  if (musicAt(playing.music, sounds, t) === null) throw invalid(SOUND_WORDS.nothingPlaying);
  const music = musicChanged(playing.music, change, sounds, t, musicSetReveals(tx.env.opVersion));
  if (music !== playing.music) play(tx, playing, { ...playing, music });
}

// The queue (docs/design/design-v1-music-player.md 6.3 and 6.4): no step for the music ops, a Setup step for Add to playlist.

/**
 * The run a queue edit or a jump acts on: the one musicAt gives at `t`, so
 * during a crossfade the incoming track that Now playing names. Refused
 * with nothing playing, and when `from` is not its run, since another DM
 * played, skipped, resumed, jumped or started a scene since the edit was
 * made. A tick never changes `run`, so an edit made before a promotion
 * still applies, to the track playing at `t`.
 */
function runMadeOn(playing: Playing, sounds: Record<SoundId, Sound>, from: string, t: number): MusicRun {
  const current = musicAt(playing.music, sounds, t);
  if (current === null) throw invalid(SOUND_WORDS.nothingPlaying);
  if (current.run !== from) throw invalid(SOUND_WORDS.musicChanged);
  return current;
}

/** A queue helper's result, its MusicRefusal sent on in the panel's words. */
function inWords(rule: () => MusicRun): MusicRun {
  try {
    return rule();
  } catch (e) {
    if (e instanceof MusicRefusal) throw invalid(MUSIC_REFUSAL_WORDS[e.key]);
    throw e;
  }
}

/**
 * A queue edit at the op's time (6.4): the guards (no run, `from`), then
 * queueEdited on the track playing then, its `next` placed again. An edit
 * that changes nothing writes nothing, as a stop of a stopped loop, so a
 * second DM's stale press undoes nothing.
 */
export function musicQueue(tx: Tx, op: OpOf<"music.queue">): void {
  const playing = playingOf(tx.state);
  const sounds = soundsOf(tx.state);
  const t = startOf(tx);
  const current = runMadeOn(playing, sounds, op.from, t);
  const playlist = current.playlistId === undefined ? null : (ownEntry(tx.state.playlists, current.playlistId) ?? null);
  const music = inWords(() => queueEdited(current, op.edit, { sounds, playlist }, t));
  if (music !== current) play(tx, playing, { ...playing, music });
}

/**
 * Play now, Previous or a seek (6.4): the guards (no run, `from`, `on`),
 * `ms` held to seekBoundMs less 1 s, then jumpedAt. `on` names the track
 * the seek or Previous was made on, its id alone: the store predicts with
 * the device's clock, so a predicted `now.at` never equals the server's.
 */
export function musicJump(tx: Tx, op: OpOf<"music.jump">): void {
  const playing = playingOf(tx.state);
  const sounds = soundsOf(tx.state);
  const t = startOf(tx);
  const current = runMadeOn(playing, sounds, op.from, t);
  if (op.on !== undefined && op.on !== current.now.soundId) throw invalid(SOUND_WORDS.musicMovedOn);
  // The last second stays out of reach, so a seek never lands where the track ends before any device places it.
  const bound = seekBoundMs(current, lengthAs(sounds, op.soundId, "music") ?? 0) - 1_000;
  const ms = Math.max(0, Math.min(op.ms ?? 0, bound));
  play(tx, playing, { ...playing, music: inWords(() => jumpedAt(current, op.run, op.soundId, ms, sounds, t)) });
}

/**
 * Add to playlist (6.4, Setup): an append of a music sound the playlist
 * does not hold, at most SOUND_LIMITS.playlistTracks. It replaces no list,
 * so two DMs adding at once both land, and one the playlist already holds
 * writes nothing and so records no Setup step.
 */
export function playlistAdd(tx: Tx, op: OpOf<"playlist.add">): void {
  const playlist = playlistOf(tx, op.id);
  if (playlist.sounds.includes(op.soundId)) return;
  checkTracks(tx.state, [op.soundId]);
  if (playlist.sounds.length >= SOUND_LIMITS.playlistTracks) throw invalid(SOUND_WORDS.playlistFull);
  tx.write(keys.playlist(op.id), { ...playlist, sounds: [...playlist.sounds, op.soundId] });
}

/** A loop's id keys the playing record, so it must never name a member of Object.prototype. */
function checkLoopId(id: string): void {
  if (namesPrototypeMember(id)) throw invalid("that id is reserved");
}

export function loopStart(tx: Tx, op: OpOf<"loop.start">): void {
  checkLoopId(op.id);
  const playing = playingOf(tx.state);
  if (lengthAs(soundsOf(tx.state), op.soundId, "loop") === undefined) throw invalid(SOUND_WORDS.notLoop);
  if (Object.hasOwn(playing.loops, op.id) || Object.values(playing.loops).some((l) => l.soundId === op.soundId)) throw invalid(SOUND_WORDS.loopTwice);
  if (Object.keys(playing.loops).length >= SOUND_LIMITS.loops) throw invalid(SOUND_WORDS.fifthLoop);
  play(tx, playing, { ...playing, loops: { ...playing.loops, [op.id]: { soundId: op.soundId, at: startOf(tx), volume: op.volume } } });
}

export function loopSet(tx: Tx, op: OpOf<"loop.set">): void {
  const playing = playingOf(tx.state);
  const loop = ownEntry(playing.loops, op.id);
  if (!loop) throw gone("that background sound");
  if (loop.volume === op.volume) return;
  play(tx, playing, { ...playing, loops: { ...playing.loops, [op.id]: { ...loop, volume: op.volume } } });
}

/** A loop already stopped, by another DM device say, stays stopped with nothing written. */
export function loopStop(tx: Tx, op: OpOf<"loop.stop">): void {
  const playing = playingOf(tx.state);
  if (!Object.hasOwn(playing.loops, op.id)) return;
  const { [op.id]: _stopped, ...loops } = playing.loops;
  play(tx, playing, { ...playing, loops });
}

/**
 * A list after a fire: its newest SOUND_LIMITS.effectsKept, and past those
 * the entries still sounding at `t`, SOUND_LIMITS.effectsListed at most, so
 * firing more never cuts a long effect (MUS-OPUS-41).
 */
export function keptEffects(list: readonly FiredEffect[], sounds: Record<SoundId, Sound>, t: number): FiredEffect[] {
  const newest = list.length - SOUND_LIMITS.effectsKept;
  return list.filter((e, i) => i >= newest || e.at + effectLengthMs(e, sounds) > t).slice(-SOUND_LIMITS.effectsListed);
}

/**
 * A room effect or a built-in for everyone, or for the DM alone, for good,
 * behind a blackout (4.6) and while Only DM devices play
 * (docs/design/design-v1-sound-dm-only.md 8), so turning either off never
 * shows players an effect fired meanwhile.
 */
export function effectFire(tx: Tx, op: OpOf<"effect.fire">): void {
  const playing = playingOf(tx.state);
  const sounds = soundsOf(tx.state);
  if (op.soundId !== undefined && lengthAs(sounds, op.soundId, "effect") === undefined) throw invalid(SOUND_WORDS.notEffect);
  const dmEffects = playing.dmEffects ?? [];
  if (playing.effects.some((e) => e.id === op.id) || dmEffects.some((e) => e.id === op.id)) throw invalid(SOUND_WORDS.firedTwice);
  const t = startOf(tx);
  const entry: FiredEffect = { id: op.id, ...(op.soundId !== undefined ? { soundId: op.soundId } : { builtin: op.builtin! }), at: t };
  if (tx.state.meta.view?.blackout === true || tx.state.meta.settings.soundDmOnly === true) play(tx, playing, withLists(playing, playing.effects, keptEffects([...dmEffects, entry], sounds, t)));
  else play(tx, playing, withLists(playing, keptEffects([...playing.effects, entry], sounds, t), dmEffects));
}

export function soundMix(tx: Tx, op: OpOf<"sound.mix">): void {
  const playing = playingOf(tx.state);
  const volume = { music: op.music ?? playing.volume.music, effects: op.effects ?? playing.volume.effects };
  if (volume.music === playing.volume.music && volume.effects === playing.volume.effects) return;
  play(tx, playing, { ...playing, volume });
}

/**
 * A scene's sound (4.6): with `onMove` only while the players are still on
 * that scene, so a refused move or another DM's later move leaves it
 * alone (D-261102-472), and nothing for a scene with no sound of its own.
 * It replaces what plays: a run of the same playlist, or the same one
 * track, plays on, and loops of the same sounds keep playing at the
 * scene's volumes. The rest stop, and the scene's other loops start.
 */
export function soundScene(tx: Tx, op: OpOf<"sound.scene">): void {
  const scene = tx.scene(op.sceneId);
  if (op.onMove === true && tx.state.meta.playerSceneId !== op.sceneId) return;
  const wanted = scene.sound;
  if (!wanted) return;
  const playing = playingOf(tx.state);
  const sounds = soundsOf(tx.state);
  const t = startOf(tx);
  const current = musicAt(playing.music, sounds, t);
  let music: MusicRun | null = current;
  if (wanted.music === null) music = null;
  else if (!sameMusic(current, wanted.music)) {
    const from = wanted.music.playlistId !== undefined ? { playlistId: wanted.music.playlistId } : { soundId: wanted.music.soundId! };
    // The scene's Shuffle marks the run only from version 48: a stored op from before started its run with no flag.
    const settings = { repeat: wanted.music.repeat, fade: wanted.music.fade, ...(wanted.music.shuffle === true && musicQueues(tx.env.opVersion) ? { shuffle: true as const } : {}) };
    // A playlist left with no tracks is silence.
    music = op.order.length === 0 && from.playlistId !== undefined && playlistOf(tx, from.playlistId).sounds.length === 0 ? null : startedRun(tx, from, op.order, op.run, 0, settings, t);
  }
  const loops: Record<string, LoopPlaying> = {};
  for (const id of Object.keys(playing.loops).sort()) {
    const loop = playing.loops[id]!;
    const keep = wanted.loops.find((l) => l.soundId === loop.soundId);
    if (keep) loops[id] = { ...loop, volume: keep.volume };
  }
  let n = 0;
  for (const want of wanted.loops) {
    if (Object.values(loops).some((l) => l.soundId === want.soundId)) continue;
    if (lengthAs(sounds, want.soundId, "loop") === undefined) continue;
    let id = `${op.run}-${n++}`;
    while (Object.hasOwn(loops, id)) id = `${op.run}-${n++}`;
    loops[id] = { soundId: want.soundId, at: t, volume: want.volume };
  }
  play(tx, playing, { ...playing, music, loops });
}

/** Whether a run plays what a scene's music names: the same playlist, or the same one track alone. */
function sameMusic(run: MusicRun | null, wanted: NonNullable<SceneSound["music"]>): boolean {
  if (run === null) return false;
  if (wanted.playlistId !== undefined) return run.playlistId === wanted.playlistId;
  return run.playlistId === undefined && run.order?.length === 1 && run.order[0] === wanted.soundId;
}

/** Stop all sound (4.1, and the X-card's Stop the sound): music, loops and both effect lists. */
export function soundStopAll(tx: Tx): void {
  const playing = playingOf(tx.state);
  if (playing.music === null && Object.keys(playing.loops).length === 0 && playing.effects.length === 0 && (playing.dmEffects ?? []).length === 0) return;
  const { dmEffects: _dm, ...rest } = playing;
  play(tx, playing, { ...rest, music: null, loops: {}, effects: [] });
}

/**
 * The server's tick (6.4): refused unless `from` is the rev it was computed
 * from, so a Play, Skip or Stop queued before it always wins, then the
 * music it carries, held to the run's shape against the library. Empty
 * loops and effects stop them as well.
 */
export function sysSound(tx: Tx, op: OpOf<"sys.sound">): void {
  const playing = playingOf(tx.state);
  if (op.from !== playing.rev) throw invalid("the sound changed since this step was worked out");
  if (op.music !== null) {
    checkTracks(tx.state, op.music.order);
    if (op.music.next !== undefined && !op.music.order.includes(op.music.next.soundId)) throw invalid("the next track lies in the order");
  }
  let next: Playing = { ...playing, music: op.music };
  if (op.loops !== undefined) next = { ...next, loops: {} };
  if (op.effects !== undefined) next = withLists(next, [], []);
  tx.write(keys.playing, next);
}
