import type { TrapSound } from "./model.ts";

/**
 * The room's music and sound (docs/design/design-v1-sound.md 6.1): the DM's
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
  /** New at each play, skip, resume and scene start, so a device knows a new run from a change of the same one. */
  run: string;
  /** DM only. A label: it may name a deleted playlist, and its order is never compared with the run's. */
  playlistId?: PlaylistId;
  /** DM only, always stored: this run's order, fixed at its start. */
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
  /** DM only, always stored: the same, fired behind a blackout, which stay the DM's for good. */
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
 * sounding at time `t` (5.2). `crossingMs` is the overlap of a sound that
 * repeats (a loop's crossing, or Repeat one's crossfade, which may be 0),
 * and null for one that plays once. Nothing before `at`, k never negative,
 * at most two, positions in [0, lengthMs).
 */
export function occurrencesAt(at: number, lengthMs: number, crossingMs: number | null, t: number): Occurrence[] {
  throw new Error("not built");
}

/** A loop's crossing for its length: LOOP_CROSSING_MS, or a quarter of the length under 8 s. */
export function loopCrossingMs(lengthMs: number): number {
  throw new Error("not built");
}

/** The track sounding at `t`: `now`, or `next` once its time passed. */
export function playingAt(music: MusicRun, t: number): SoundAt {
  throw new Error("not built");
}

/** The place in `order` of the track after `now` under the run's repeat, or null when the run ends there. Needs the DM's whole run. */
export function following(run: MusicRun): number | null {
  throw new Error("not built");
}

/** What a sound's length and use mean to the timeline, as a projected state carries it. */
export type SoundLengths = Readonly<Record<SoundId, Pick<Sound, "ms" | "use">>>;

/**
 * The run with `now.at` moved to the start of the occurrence sounding at
 * `t` under the period before a `music.set`, so the place heard goes on
 * (6.3). `before` holds the repeat and fade the run had.
 */
export function reanchor(music: MusicRun, before: Pick<MusicRun, "repeat" | "fade">, sounds: SoundLengths, t: number): MusicRun {
  throw new Error("not built");
}

/** When the server's next `soundTick` is due (6.4), in server ms, or null for never: Repeat one, a pause, or no run. */
export function soundDue(playing: Playing | null, sounds: SoundLengths): number | null {
  throw new Error("not built");
}

/**
 * The music the server's tick stores at `t` (6.4), whole passes of the
 * order skipped arithmetically, or `{ changed: false }` when nothing is due.
 * `music: null` ends the run.
 */
export type SoundStep = { changed: false } | { changed: true; music: MusicRun | null };

export function soundStep(playing: Playing, sounds: SoundLengths, t: number): SoundStep {
  throw new Error("not built");
}
