import { SOUND_LIMITS } from "./limits.ts";
import type { TrapSound } from "./model.ts";

/**
 * The room's music and sound (docs/design/design-v1-music.md 6.1): the DM's
 * library of sound files, playlists, and what plays now. Times are server
 * times in ms since 1970, from the op's `env.at`, so every device places a
 * sound by the same clock and replay lands on the same times.
 *
 * Every field marked "DM only" is always stored, and a player's or a
 * display's projection leaves it out (6.5), so a reader of a projected
 * state takes it as absent.
 */

export type SoundId = string;
export type PlaylistId = string;

export const SOUND_USES = ["music", "loop", "effect"] as const;
/** Music (a playlist's track), Background (a loop) or an Effect fired with a tap. */
export type SoundUse = (typeof SOUND_USES)[number];

export const REPEATS = ["all", "one", "off"] as const;
export type Repeat = (typeof REPEATS)[number];

/** A run's crossfade, in seconds. */
export const FADES = [0, 2, 5, 10] as const;
export type Fade = (typeof FADES)[number];

/** The built-in effects: the trap sounds every device synthesizes, with nothing to download, so they play while the server's switch is off. */
export type BuiltinSound = TrapSound;

/** Every start is this long after the op's server time, so a device has time to receive it and begin together with the others (D-261102-479). */
export const LEAD_MS = 400;

/** A loop's crossing at its loop point: 2 s, or a quarter of its length under 8 s. */
export const LOOP_CROSSING_MS = 2_000;
/** A loop's first occurrence fades in over this from its `at`, and every stop fades out over it. */
export const LOOP_FADE_IN_MS = 2_000;
export const STOP_FADE_MS = 2_000;
/** A join, a resume and a promoted crossfade's outgoing track fade over this. */
export const SHORT_FADE_MS = 300;

/** A loop's volume when the DM starts it with no scene's volume (D-261102-470). */
export const LOOP_START_VOLUME = 70;

/** The level evens a sound's loudness (D-261102-465), in tenths of a dB. */
export const LEVEL_MIN = -240;
export const LEVEL_MAX = 120;

/**
 * DM only, all of it, but a player's projection keeps `id`, `assetId`,
 * `ms`, `level` and `use` of the sounds that sound now (6.5).
 */
export type Sound = {
  id: SoundId;
  rev: number;
  /** DM only, but for `now` and the loops while the room's `soundNames` is on. 1 to MAX_NAME characters by the name rules. */
  name?: string;
  /** Its `sound` asset, the one MP3 the server checked. Two sounds may name one file. */
  assetId: string;
  /** The encoded length, frames times 1152 over the rate, filled from the asset row and never sent by the client (4.2). */
  ms: number;
  use: SoundUse;
  /** Tenths of a dB, LEVEL_MIN to LEVEL_MAX. Absent is 0. */
  level?: number;
};

/** DM only. Music sounds, at most SOUND_LIMITS.playlistTracks, no id twice. */
export type Playlist = {
  id: PlaylistId;
  rev: number;
  name: string;
  sounds: SoundId[];
  shuffle?: true;
  repeat: Repeat;
  fade: Fade;
};

/** `at`: the server time, in ms since 1970, of the sound's own 0, its first occurrence. */
export type SoundAt = { soundId: SoundId; at: number };

export type MusicRun = {
  /** New at each play, skip, resume, jump and scene start, so a device knows a new run from a change of the same one. */
  run: string;
  /**
   * DM only. A label, and the order Shuffle off puts back while the
   * playlist exists (docs/design/design-v1-music-player.md 6.4): it may name
   * a deleted playlist, and the run's order may differ from the playlist's.
   */
  playlistId?: PlaylistId;
  /** DM only, always stored: this run's order, the queue, which only the DM's queue edits and Shuffle change once it starts (docs/design/design-v1-music-player.md 6.1). */
  order?: SoundId[];
  /** DM only, always stored: the place of `now` in `order`. */
  index?: number;
  repeat: Repeat;
  fade: Fade;
  now: SoundAt;
  /** From 10 to 20 s before it starts, never earlier, so a player holds no later track. */
  next?: SoundAt;
  /** DM only: the position in ms where it paused. A player's projection has no music while it is paused. */
  paused?: number;
  /**
   * DM only: Shuffle is on (docs/design/design-v1-music-player.md 6.2). The
   * order was mixed when it was turned on, or when the run started
   * shuffled. Absent is off.
   */
  shuffle?: true;
};

/** A background sound looping, at the DM's volume for everyone, 0 to 100. */
export type LoopPlaying = SoundAt & { volume: number };

/** One effect fired: a room effect by its sound, or a built-in. An entry may name a sound that is gone or now has another use, as history, and playback skips it. */
export type FiredEffect = { id: string; soundId?: SoundId; builtin?: BuiltinSound; at: number };

/** The singleton `keys.playing`. No Setup op writes it (D-261102-471). */
export type Playing = {
  rev: number;
  music: MusicRun | null;
  /** By loop id, at most SOUND_LIMITS.loops. */
  loops: Record<string, LoopPlaying>;
  /** The newest SOUND_LIMITS.effectsKept, and older ones still sounding, SOUND_LIMITS.effectsListed at most. */
  effects: FiredEffect[];
  /** DM only, always stored: the same, fired behind a blackout or while Only DM devices play, which stay the DM's for good. */
  dmEffects?: FiredEffect[];
  /** 0 to 100, for everyone. */
  volume: { music: number; effects: number };
};

/** A scene's music: a playlist or one music sound, with the run's settings. */
export type SceneMusic = { playlistId?: PlaylistId; soundId?: SoundId; repeat: Repeat; fade: Fade; shuffle?: true };

/** DM only (Scene.sound). Null music and no loops is silence, which a scene can keep too. */
export type SceneSound = { music: SceneMusic | null; loops: { soundId: SoundId; volume: number }[] };

/**
 * One pass of a sound on the timeline (5.2): occurrence `k` began at
 * `startAt` and is at `positionMs` into the file. A crossing loop has two
 * at once while the later one fades in.
 */
export type Occurrence = { k: number; startAt: number; positionMs: number };

/**
 * The occurrences of a sound placed at `at` with length `lengthMs`
 * sounding at time `t` (5.2), the older first. `crossingMs` is the overlap
 * of a sound that repeats (a loop's crossing, or Repeat one's crossfade,
 * which may be 0), and null for one that plays once. Nothing before `at`,
 * k never negative, at most two, positions in [0, lengthMs). A crossing
 * longer than half the sound is held to half, so the period stays positive.
 */
export function occurrencesAt(at: number, lengthMs: number, crossingMs: number | null, t: number): Occurrence[] {
  // NaN fails both comparisons, so a broken length or time sounds nothing.
  if (!(t >= at) || !(lengthMs > 0)) return [];
  const since = t - at;
  if (crossingMs === null) return since < lengthMs ? [{ k: 0, startAt: at, positionMs: since }] : [];
  const crossing = Math.min(Math.max(0, crossingMs), Math.floor(lengthMs / 2));
  const period = lengthMs - crossing;
  const k = Math.floor(since / period);
  const positionMs = since - k * period;
  const current: Occurrence = { k, startAt: at + k * period, positionMs };
  // The occurrence before still fades out over the crossing, which the first one has none before it to do.
  if (k > 0 && positionMs < crossing) return [{ k: k - 1, startAt: at + (k - 1) * period, positionMs: positionMs + period }, current];
  return [current];
}

/** A loop's crossing for its length: LOOP_CROSSING_MS, or a quarter of the length under 8 s, in whole ms. */
export function loopCrossingMs(lengthMs: number): number {
  return lengthMs < 8_000 ? Math.floor(lengthMs / 4) : LOOP_CROSSING_MS;
}

/** The track sounding at `t`: `now`, or `next` once its time passed. */
export function playingAt(music: MusicRun, t: number): SoundAt {
  return music.next !== undefined && t >= music.next.at ? music.next : music.now;
}

/** The place in `order` of the track after `now` under the run's repeat, or null when the run ends there. Needs the DM's whole run. */
export function following(run: MusicRun): number | null {
  const order = run.order ?? [];
  const index = run.index ?? 0;
  if (order.length === 0) return null;
  if (run.repeat === "one") return index;
  if (index + 1 < order.length) return index + 1;
  return run.repeat === "all" ? 0 : null;
}

/** What a sound's length and use mean to the timeline, as a projected state carries it. */
export type SoundLengths = Readonly<Record<SoundId, Pick<Sound, "ms" | "use">>>;

/** A built-in effect sounds no longer than this (the longest trap shape is 1.4 s), so the effect lists keep it while it may still sound. */
export const BUILTIN_EFFECT_MS = 2_000;

/** The length of a sound as `use` plays it, or undefined when it is gone or now has another use. */
export function lengthAs(sounds: SoundLengths | undefined, soundId: SoundId, use: SoundUse): number | undefined {
  const sound = sounds !== undefined && Object.hasOwn(sounds, soundId) ? sounds[soundId] : undefined;
  return sound !== undefined && sound.use === use && Number.isFinite(sound.ms) && sound.ms > 0 ? sound.ms : undefined;
}

/** How long a fired effect sounds: a built-in's bound, a room effect's length, or 0 for one whose sound is gone or no longer an Effect (history, skipped). */
export function effectLengthMs(effect: FiredEffect, sounds: SoundLengths | undefined): number {
  if (effect.builtin !== undefined) return BUILTIN_EFFECT_MS;
  return effect.soundId === undefined ? 0 : (lengthAs(sounds, effect.soundId, "effect") ?? 0);
}

/** The run's crossfade in ms. */
export function fadeMs(run: Pick<MusicRun, "fade">): number {
  return run.fade * 1_000;
}

/**
 * When a revealed crossfade ends and `next` becomes `now`: `next.at` plus
 * the fade, or the outgoing track's end when `next.at` was placed late
 * (a reanchor, a resume near the end), so the crossfade shortens to what
 * remains of the outgoing track, and at once when nothing remains.
 */
export function crossEndAt(now: SoundAt, nowMs: number, next: SoundAt, fade: number): number {
  return Math.min(next.at + fade, Math.max(next.at, now.at + nowMs));
}

/** The next change the schedule makes to a run, and when: a reveal, a promotion or the end. Null for never: a pause or Repeat one. */
function nextChange(music: MusicRun, sounds: SoundLengths): { at: number; music: MusicRun | null } | null {
  if (music.paused !== undefined) return null;
  const nowMs = lengthAs(sounds, music.now.soundId, "music");
  // A run whose track is gone or no longer music cannot go on: it ends at once. The reducer and the stored-state schema
  // keep that from happening, so this only holds a hand-made state to a rule.
  if (nowMs === undefined) return { at: music.now.at, music: null };
  const fade = fadeMs(music);
  if (music.next !== undefined) {
    const at = crossEndAt(music.now, nowMs, music.next, fade);
    // `next` is the track `following` names, as the reveal placed it and a reanchor, resume or queue edit placed it again.
    const order = music.order ?? [];
    const j = following(music);
    const index = j !== null && order[j] === music.next.soundId ? j : order.indexOf(music.next.soundId);
    const { next, ...rest } = music;
    return { at, music: { ...rest, now: next, ...(index >= 0 ? { index } : {}) } };
  }
  if (music.repeat === "one") return null;
  const j = following(music);
  if (j === null) return { at: music.now.at + nowMs, music: null };
  const nextAt = music.now.at + nowMs - fade;
  return { at: revealAt(music.now.at, nextAt, fade), music: { ...music, next: { soundId: music.order![j]!, at: nextAt } } };
}

/**
 * When the following track is revealed to players: 20 s before it starts,
 * but never before the crossfade into `now` has ended, so with tracks of
 * 30 s or more and a crossfade of 10 s at most every reveal comes 10 to
 * 20 s before its start (6.4).
 */
function revealAt(nowAt: number, nextAt: number, fade: number): number {
  return Math.max(nextAt - SOUND_LIMITS.revealMaxMs, nowAt + fade);
}


/**
 * The run with `now.at` moved to the start of the occurrence sounding at
 * `t` under the period before a `music.set`, so the place heard goes on
 * (6.3). `before` holds the repeat and fade the run had, `music` the new
 * ones. The next track follows this pass, placed at the new crossfade's
 * start, never before `t`. Repeat one has none. A paused run keeps its
 * place.
 *
 * A `next` already revealed stays revealed while its new start is within
 * SOUND_LIMITS.revealMaxMs of `t`, and one whose reveal is due at `t` is
 * revealed (docs/design/design-v1-sound-dm-only.md 9). So a crossfade made
 * shorter withdraws a revealed `next` that would now start further ahead,
 * which the tick reveals again 20 s before its start, and players never
 * hold a next track more than 20 s early. A crossfade made longer keeps a
 * revealed `next`, now nearer, even where `revealAt`'s clamp would reveal
 * it later under the new fade. `windowed` is false only for a `music.set`
 * stored before op version 50 (musicSetReveals), which kept every revealed
 * `next` as it played.
 */
export function reanchor(music: MusicRun, before: Pick<MusicRun, "repeat" | "fade">, sounds: SoundLengths, t: number, windowed = true): MusicRun {
  const nowMs = lengthAs(sounds, music.now.soundId, "music");
  if (nowMs === undefined || music.paused !== undefined) return music;
  let at = music.now.at;
  if (before.repeat === "one") {
    // The newest occurrence: during a crossing it is the one fading in, and the older one fades out as no longer named.
    const sounding = occurrencesAt(at, nowMs, fadeMs(before), t).at(-1);
    if (sounding) at = sounding.startAt;
  }
  const { next: revealed, ...rest } = music;
  const out: MusicRun = { ...rest, now: { ...music.now, at } };
  const kept = revealed !== undefined && (!windowed || out.now.at + nowMs - fadeMs(out) - t <= SOUND_LIMITS.revealMaxMs);
  return withNextAt(out, nowMs, t, kept);
}

/**
 * A run placed at `t` (a resume, a reanchor, a queue edit or a jump) with
 * its `next` revealed if it was before or its reveal is due by `t`, at its
 * crossfade's start but never before `t` (MUS-OPUS-52). A queue edit keeps
 * a revealed `next` revealed, so one inside the reveal window swaps the
 * revealed track at once, and one before it reveals nothing early
 * (docs/design/design-v1-music-player.md 6.4).
 */
export function withNextAt(music: MusicRun, nowMs: number, t: number, wasRevealed: boolean): MusicRun {
  if (music.repeat === "one") return music;
  const j = following(music);
  if (j === null) return music;
  const fade = fadeMs(music);
  const nextAt = music.now.at + nowMs - fade;
  if (!wasRevealed && t < revealAt(music.now.at, nextAt, fade)) return music;
  return { ...music, next: { soundId: music.order![j]!, at: Math.max(nextAt, t) } };
}

/** When the server's next `soundTick` is due (6.4), in server ms, or null for never: Repeat one, a pause, or no run. */
export function soundDue(playing: Playing | null, sounds: SoundLengths): number | null {
  const music = playing?.music;
  if (!music) return null;
  return nextChange(music, sounds)?.at ?? null;
}

/**
 * The music the server's tick stores at `t` (6.4), whole passes of the
 * order skipped arithmetically, or `{ changed: false }` when nothing is due.
 * `music: null` ends the run.
 */
export type SoundStep = { changed: false } | { changed: true; music: MusicRun | null };

/**
 * Every change the schedule makes by `t`, in order, so many steps come to
 * the same as one step at the last (D-261102-685): each change depends on
 * the run alone, never on when the step ran. A step that runs late, after
 * a gap with no socket, keeps the schedule, so a reveal it makes may name a
 * track that already started, which every device joins in place. Only the
 * ops place a `next` at `t` or later.
 */
export function soundStep(playing: Playing, sounds: SoundLengths, t: number): SoundStep {
  let music = playing.music;
  let changed = false;
  // Each pass of the order makes two changes a track, at most 200, and whole passes are skipped below, so this bound is
  // only for a hand-made state whose lengths make no progress.
  for (let guard = 0; music !== null && guard < 10_000; guard++) {
    music = skipPasses(music, sounds, t);
    const change = nextChange(music, sounds);
    if (change === null || change.at > t) break;
    music = change.music;
    changed = true;
  }
  if (!changed) return music === playing.music ? { changed: false } : { changed: true, music };
  return { changed: true, music };
}

/**
 * The run as whole passes of its order under Repeat all leave it by `t`:
 * from a run with no `next`, the same track `k` passes later, each pass
 * the order's lengths less a crossfade each. Every change in a pass is
 * on the schedule, so this is what stepping through each would give.
 */
function skipPasses(music: MusicRun, sounds: SoundLengths, t: number): MusicRun {
  if (music.repeat !== "all" || music.next !== undefined || music.paused !== undefined) return music;
  const fade = fadeMs(music);
  let pass = 0;
  for (const id of music.order ?? []) {
    const ms = lengthAs(sounds, id, "music");
    if (ms === undefined) return music;
    pass += ms - fade;
  }
  if (!(pass > 0)) return music;
  // The run is back on its track `k` passes on once the crossfade into it has ended there.
  const k = Math.floor((t - music.now.at - fade) / pass);
  if (k < 1) return music;
  return { ...music, now: { ...music.now, at: music.now.at + k * pass } };
}

/**
 * The run as the schedule leaves it at `t`, then promoted if `t` falls in
 * a crossfade (6.3): `next` becomes `now` with its own `at` and the index
 * moves on, and the outgoing track, no longer named, fades out over
 * SHORT_FADE_MS on every device. Every music op starts from this, so it
 * acts on the track sounding at `t`, never the outgoing one.
 */
export function musicAt(music: MusicRun | null, sounds: SoundLengths, t: number): MusicRun | null {
  if (music === null) return null;
  const step = soundStep({ rev: 0, music, loops: {}, effects: [], volume: { music: 0, effects: 0 } }, sounds, t);
  const caught = step.changed ? step.music : music;
  if (caught === null || caught.next === undefined || t < caught.next.at || caught.paused !== undefined) return caught;
  const promoted = nextChange(caught, sounds);
  return promoted?.music ?? caught;
}

/** The position heard at `t` within the occurrence of `now` sounding then: the newest one under Repeat one. Null past its end. */
export function positionAt(music: MusicRun, sounds: SoundLengths, t: number): number | null {
  const nowMs = lengthAs(sounds, music.now.soundId, "music");
  if (nowMs === undefined) return null;
  return occurrencesAt(music.now.at, nowMs, music.repeat === "one" ? fadeMs(music) : null, t).at(-1)?.positionMs ?? null;
}

/** A pause at `t` of a run `musicAt` gave: the position kept, `next` dropped (6.3). A run already paused stays as it is. */
export function pausedAt(music: MusicRun, sounds: SoundLengths, t: number): MusicRun {
  if (music.paused !== undefined) return music;
  const { next: _next, ...rest } = music;
  return { ...rest, paused: Math.max(0, Math.floor(positionAt(music, sounds, t) ?? 0)) };
}

/** A resume at `t` under a new run: the paused occurrence placed at `t - paused`, its `next` revealed if due, never before `t`. */
export function resumedAt(music: MusicRun, run: string, sounds: SoundLengths, t: number): MusicRun {
  if (music.paused === undefined) return music;
  const { paused, ...rest } = music;
  const placed: MusicRun = { ...rest, run, now: { ...music.now, at: t - paused } };
  const nowMs = lengthAs(sounds, music.now.soundId, "music");
  return nowMs === undefined ? placed : withNextAt(placed, nowMs, t, false);
}

/**
 * A skip at `t` of a run `musicAt` gave, under a new run: the track after
 * `now` in the order starts at `t`, unpaused, or with Repeat off on the
 * last track the run ends. Repeat one skips to the next track too. So a
 * Skip during a crossing goes past the incoming track, which Now playing
 * already names (MUS-OPUS-64).
 */
export function skippedAt(music: MusicRun, run: string, t: number): MusicRun | null {
  const order = music.order ?? [];
  const index = music.index ?? 0;
  if (order.length === 0) return null;
  const j = index + 1 < order.length ? index + 1 : music.repeat === "off" ? null : 0;
  if (j === null) return null;
  const { next: _next, paused: _paused, ...rest } = music;
  return { ...rest, run, index: j, now: { soundId: order[j]!, at: t } };
}

/** A change the DM makes to the running music, as its op names it (6.2). */
export type MusicChange = { t: "pause" } | { t: "resume"; run: string } | { t: "skip"; run: string } | { t: "set"; repeat?: Repeat; fade?: Fade } | { t: "stop" };

/**
 * The music after a DM's change at `t` (6.3): from the run as the schedule
 * leaves it then, promoted during a crossfade (musicAt), so each acts on
 * the track sounding at `t`. A pause keeps the position, a resume places
 * it again under a new run, a skip starts the next track, and a change of
 * repeat or crossfade keeps the place heard (reanchor). Null is silence.
 * A change that does not apply, a pause of a paused run or a resume of a
 * playing one, leaves the run as the schedule has it. `windowed` goes to
 * reanchor: false only for a `music.set` stored before op version 50.
 */
export function musicChanged(music: MusicRun | null, change: MusicChange, sounds: SoundLengths, t: number, windowed = true): MusicRun | null {
  const current = musicAt(music, sounds, t);
  if (current === null || change.t === "stop") return null;
  switch (change.t) {
    case "pause":
      return pausedAt(current, sounds, t);
    case "resume":
      return resumedAt(current, change.run, sounds, t);
    case "skip":
      return skippedAt(current, change.run, t);
    case "set": {
      const set: MusicRun = { ...current, repeat: change.repeat ?? current.repeat, fade: change.fade ?? current.fade };
      if (set.repeat === current.repeat && set.fade === current.fade) return current;
      return set.paused !== undefined ? set : reanchor(set, current, sounds, t, windowed);
    }
  }
}

// The queue (docs/design/design-v1-music-player.md 6): the live run's order, edited while it plays.

/**
 * One edit of the queue, as `music.queue` carries it (6.2). Each is a
 * command applied at the op's time to the track playing then, never a
 * whole new order, so a tick between the DM's view and the op cannot make
 * it act on the wrong track. `move`'s named places are resolved then too.
 */
export type QueueEdit =
  /** Play next: right after the playing track, in this order, the playing track skipped. */
  | { t: "next"; soundIds: SoundId[] }
  /** Add to queue: at the end, the playing track skipped. */
  | { t: "add"; soundIds: SoundId[] }
  /**
   * `first` is right after the playing track. `passEnd` is the order's end,
   * the seam of Up next's two lists. `last` is the end of the cycle: just
   * before the playing track under Repeat all and one, the order's end
   * under Repeat off. `before` names the track it goes in front of.
   */
  | { t: "move"; soundId: SoundId; to: QueueMoveTo }
  | { t: "remove"; soundId: SoundId }
  /** Shuffle on, mixed by seededShuffle from this seed, so replay and the store's prediction mix alike. A run id's shape. */
  | { t: "shuffle"; seed: string }
  /** Shuffle off: the playlist's order back. */
  | { t: "unshuffle" };

/** Where `move` puts a track (QueueEdit). */
export type QueueMoveTo = "first" | "passEnd" | "last" | { before: SoundId };

/**
 * What a queue edit reads besides the run: each sound's length and use,
 * and the run's playlist while it exists, whose order `unshuffle` puts
 * back. Null when the run has none or it was deleted.
 */
export type QueueContext = { sounds: SoundLengths; playlist: Pick<Playlist, "sounds"> | null };

/**
 * The refusals queueEdited and jumpedAt throw, by their key in
 * shared/reducer/sound.ts SOUND_WORDS. The guards on the op itself (no
 * run, `from`, `on`) are the reducer's, which throws them directly.
 */
export type MusicRefusalKey = "playingStays" | "leftQueue" | "queueFull" | "notMusic";

/**
 * Thrown by the queue's helpers for an edit the rules refuse. The reducer
 * sends it on as `invalid(MUSIC_REFUSAL_WORDS[key])`, so the helpers stay
 * pure and free of the reducer's error type, and a test can name the key.
 */
export class MusicRefusal extends Error {
  readonly key: MusicRefusalKey;
  constructor(key: MusicRefusalKey) {
    super(key);
    this.key = key;
  }
}

/**
 * The run after a queue edit at `t` (6.4), from the run musicAt gave at
 * `t`, so an edit during a crossfade acts on the incoming track. `index`
 * stays on the playing track, and a playing run's `next` is placed again
 * by withNextAt, revealed at once if one was. An edit that changes
 * nothing returns `music` itself, so the reducer writes nothing. Throws
 * MusicRefusal for an edit the rules refuse.
 */
export function queueEdited(music: MusicRun, edit: QueueEdit, ctx: QueueContext, t: number): MusicRun {
  const order = music.order ?? [];
  const wasShuffled = music.shuffle === true;
  let shuffle = wasShuffled;
  let edited: SoundId[];
  switch (edit.t) {
    case "next":
    case "add":
      for (const id of edit.soundIds) if (lengthAs(ctx.sounds, id, "music") === undefined) throw new MusicRefusal("notMusic");
      edited = edit.t === "next" ? playedNext(music, edit.soundIds) : addedToQueue(music, edit.soundIds);
      break;
    case "move":
      edited = movedInQueue(music, edit.soundId, edit.to);
      break;
    case "remove":
      if (edit.soundId === music.now.soundId) throw new MusicRefusal("playingStays");
      edited = order.filter((id) => id !== edit.soundId);
      break;
    case "shuffle":
      // A second press on another DM's device writes nothing, so it never mixes again what the first mixed.
      if (wasShuffled) return music;
      edited = shuffledQueue(music, edit.seed);
      shuffle = true;
      break;
    case "unshuffle":
      if (!wasShuffled) return music;
      edited = ctx.playlist === null ? order : unshuffledQueue(music, ctx.playlist.sounds);
      shuffle = false;
      break;
  }
  if (shuffle === wasShuffled && sameOrder(edited, order)) return music;
  if (edited.length > SOUND_LIMITS.playlistTracks) throw new MusicRefusal("queueFull");
  const { next: revealed, shuffle: _was, ...rest } = music;
  const out: MusicRun = { ...rest, order: edited, index: edited.indexOf(music.now.soundId), ...(shuffle ? { shuffle: true as const } : {}) };
  // A paused run reveals nothing: its `now.at` is where it stood when paused, and a resume places `next` again.
  if (music.paused !== undefined) return out;
  const nowMs = lengthAs(ctx.sounds, music.now.soundId, "music");
  return nowMs === undefined ? out : withNextAt(out, nowMs, t, revealed !== undefined);
}

function sameOrder(a: readonly SoundId[], b: readonly SoundId[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}

/** Play next: the ids right after the playing track in the order given, moved there if the run holds them, the playing track skipped. */
function playedNext(music: MusicRun, soundIds: readonly SoundId[]): SoundId[] {
  const order = music.order ?? [];
  const ids = soundIds.filter((id) => id !== music.now.soundId);
  if (ids.length === 0) return order;
  const moving = new Set(ids);
  const rest = order.filter((id) => !moving.has(id));
  const at = rest.indexOf(music.now.soundId) + 1;
  return [...rest.slice(0, at), ...ids, ...rest.slice(at)];
}

/**
 * Add to queue: the ids the run lacks at the end, in the order given, the
 * playing track skipped. One still to come stays where it is. Under Repeat
 * off one already heard moves to the end too, since it would never come
 * round again, while under Repeat all and one every track is still to come.
 */
function addedToQueue(music: MusicRun, soundIds: readonly SoundId[]): SoundId[] {
  const order = music.order ?? [];
  const heard = new Set(music.repeat === "off" ? order.slice(0, music.index ?? 0) : []);
  const ids = soundIds.filter((id) => id !== music.now.soundId && (heard.has(id) || !order.includes(id)));
  if (ids.length === 0) return order;
  const moving = new Set(ids);
  return [...order.filter((id) => !moving.has(id)), ...ids];
}

/**
 * A move, its named places resolved at the op's time: `first` right after
 * the track playing then, so Home on a later row while the first row
 * promotes still lands first, `passEnd` the order's end, and `last` the
 * cycle's end (just before the playing track under Repeat all and one).
 */
function movedInQueue(music: MusicRun, soundId: SoundId, to: QueueMoveTo): SoundId[] {
  const order = music.order ?? [];
  const playingId = music.now.soundId;
  if (soundId === playingId) throw new MusicRefusal("playingStays");
  if (!order.includes(soundId)) throw new MusicRefusal("leftQueue");
  const rest = order.filter((id) => id !== soundId);
  let at: number;
  if (to === "first") at = rest.indexOf(playingId) + 1;
  else if (to === "passEnd" || (to === "last" && music.repeat === "off")) at = rest.length;
  else if (to === "last") at = rest.indexOf(playingId);
  else {
    at = rest.indexOf(to.before);
    if (at < 0) throw new MusicRefusal("leftQueue");
  }
  return [...rest.slice(0, at), soundId, ...rest.slice(at)];
}

/**
 * Shuffle on (6.4): under Repeat all and one every track but the playing
 * one is mixed and it keeps its place, so "3 of 12" stays. Under Repeat
 * off only the tracks after it, so nothing heard comes back.
 */
function shuffledQueue(music: MusicRun, seed: string): SoundId[] {
  const order = music.order ?? [];
  const index = music.index ?? 0;
  if (music.repeat === "off") return [...order.slice(0, index + 1), ...seededShuffle(order.slice(index + 1), seed)];
  const mixed = seededShuffle(order.filter((_, i) => i !== index), seed);
  return [...mixed.slice(0, index), order[index]!, ...mixed.slice(index)];
}

/**
 * Shuffle off with the run's playlist (6.4): the tracks in the playlist's
 * order, then those it lacks in their present order. Under Repeat off only
 * the tracks after the playing one, so nothing heard comes back.
 */
function unshuffledQueue(music: MusicRun, listed: readonly SoundId[]): SoundId[] {
  const order = music.order ?? [];
  const index = music.index ?? 0;
  const inPlaylist = new Set(listed);
  const back = (ids: readonly SoundId[]): SoundId[] => {
    const held = new Set(ids);
    return [...listed.filter((id) => held.has(id)), ...ids.filter((id) => !inPlaylist.has(id))];
  };
  return music.repeat === "off" ? [...order.slice(0, index + 1), ...back(order.slice(index + 1))] : back(order);
}

/**
 * The run after a jump at `t` to `soundId` at `ms` into it (6.4), from the
 * run musicAt gave at `t`: Play now, Previous and a seek. Under the new
 * `run` the track plays from `t - ms`, with `next` placed again if due. A
 * paused run's seek of its own track stays paused at `ms`. The reducer
 * holds `ms` to seekBoundMs less 1 s first. Throws MusicRefusal
 * (`leftQueue`) for a track not in the order.
 */
export function jumpedAt(music: MusicRun, run: string, soundId: SoundId, ms: number, sounds: SoundLengths, t: number): MusicRun {
  const index = (music.order ?? []).indexOf(soundId);
  if (index < 0) throw new MusicRefusal("leftQueue");
  // A seek while paused moves the paused place, and the later resume places the track from there.
  if (music.paused !== undefined && soundId === music.now.soundId) return { ...music, run, index, paused: ms };
  const nowMs = lengthAs(sounds, soundId, "music");
  if (nowMs === undefined) throw new MusicRefusal("notMusic");
  const { next: _next, paused: _paused, ...rest } = music;
  // A jump is a new run placed as a resume is, so nothing revealed carries over and players join at its place.
  return withNextAt({ ...rest, run, index, now: { soundId, at: t - ms } }, nowMs, t, false);
}

/**
 * The end of what a seek can reach in a track (4.2, 6.4): its length, or
 * under Repeat one with a crossfade one pass, the length less the
 * crossfade (occurrencesAt's period), so a seek always places a single
 * first occurrence. The seek slider spans 0 to this.
 */
export function seekBoundMs(music: Pick<MusicRun, "repeat" | "fade">, lengthMs: number): number {
  if (music.repeat !== "one") return lengthMs;
  return lengthMs - Math.min(Math.max(0, fadeMs(music)), Math.floor(lengthMs / 2));
}

/** FNV-1a over the seed's UTF-16 units: the generator's 32-bit start, the same for a seed on every device. */
function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: numbers in [0, 1) from 32-bit integer steps, which every engine computes alike. */
function generator(start: number): () => number {
  let a = start >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), a | 1);
    x = (x + Math.imul(x ^ (x >>> 7), x | 61)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The items in an order mixed by `seed` (6.5): a small hash of the seed
 * and a 32-bit generator, never Math.random, so replay and the store's
 * prediction mix alike. A golden test pins its output.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const next = generator(seedHash(seed));
  // Fisher and Yates, from the end.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = out[i]!;
    out[i] = out[j]!;
    out[j] = swap;
  }
  return out;
}
