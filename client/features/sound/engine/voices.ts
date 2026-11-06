import { SOUND_LIMITS } from "#shared/limits.ts";
import {
  crossEndAt,
  LOOP_FADE_IN_MS,
  loopCrossingMs,
  occurrencesAt,
  SHORT_FADE_MS,
  STOP_FADE_MS,
  type MusicRun,
  type Playing,
  type Sound,
  type SoundId,
} from "#shared/sound.ts";
import { onActivation, type Activation } from "../../../lib/activation.ts";
import type { SoundUnlock } from "./context.ts";
import { SEEK_FADE_MS, Settle } from "./settle.ts";

/**
 * Music and background sounds on this page (docs/design/design-v1-music.md
 * 5.2 and 5.3). `planVoices` reads the timeline: which occurrence of which
 * sound should sound at a server time, where in its file, and its envelope.
 * `Voices` keeps the pool's elements on that plan: each element runs
 * through its own gains to the music or background channel, is aimed at
 * its place plus the output's latency when it starts, and then plays on by
 * itself (settle.ts).
 */

/** A music track that first sounds this long after its fade began fades in afresh: a timely start keeps the shared ramp. */
const LATE_SOUND_MS = 250;
/** A voice due to start within this is loaded ahead, paused at its start, so it can start on time. */
export const LOOKAHEAD_MS = 3_000;
/** A background sound, or music other than a run's own track, that joins mid-pass fades in over this. */
export const JOIN_FADE_MS = SHORT_FADE_MS;
/** Music fades in over this when its track starts or resumes, and out over this when it ends with nothing after it, as a stop does. */
export const MUSIC_FADE_MS = STOP_FADE_MS;
/** Players and displays fade out over this behind a blackout. */
export const BLACKOUT_FADE_MS = 1_000;
/** How far ahead each envelope is scheduled on the audio clock, renewed with every check. */
const HORIZON_MS = 2_500;
/** An element that stops this close to its voice's end is ending, not stopped short. */
const HEAL_END_MS = 500;

export type Channel = "music" | "loop";

/** A point of a voice's envelope: its gain at a server time. Between points the gain moves in a line. */
export type EnvelopePoint = readonly [at: number, gain: number];

export type VoicePlan = {
  /** The same voice across updates, so a promotion or a volume change keeps its element playing. */
  key: string;
  channel: Channel;
  soundId: SoundId;
  assetId: string;
  /** The server time of this occurrence's position 0. */
  startAt: number;
  lengthMs: number;
  /** Tenths of a dB. */
  level: number;
  /** A loop's volume for everyone, 0 to 100. Music's is the channel's. */
  volume: number;
  envelope: readonly EnvelopePoint[];
  /**
   * Music's `now` as a play, a skip or a resume placed it: it fades in over
   * MUSIC_FADE_MS when its element first sounds (#place). Never in the
   * envelope: a track promoted from `next` is `now` too, already sounding
   * on its own element, and under Crossfade Off it must not dip.
   */
  fadeIn?: true;
};

/** The gain of an envelope at `t`. */
export function gainAt(envelope: readonly EnvelopePoint[], t: number): number {
  if (envelope.length === 0) return 1;
  const first = envelope[0]!;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < envelope.length; i++) {
    const a = envelope[i - 1]!;
    const b = envelope[i]!;
    if (t <= b[0]) return b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
  }
  return envelope[envelope.length - 1]![1];
}

type Lengths = Readonly<Record<SoundId, Pick<Sound, "ms" | "use" | "assetId" | "level">>>;

function soundAs(sounds: Lengths, soundId: SoundId, use: Sound["use"]) {
  const s = Object.hasOwn(sounds, soundId) ? sounds[soundId] : undefined;
  return s && s.use === use && s.ms > 0 ? s : undefined;
}

/**
 * The voices that sound at `t`, or start within the lookahead. A DM's
 * state keeps a paused run whole, with its old `at`, so a pause is read
 * here: a player's projection drops it, and every device falls silent alike.
 */
export function planVoices(playing: Playing | null | undefined, sounds: Lengths, t: number): VoicePlan[] {
  if (!playing) return [];
  const out: VoicePlan[] = [];
  if (playing.music && playing.music.paused === undefined) out.push(...musicVoices(playing.music, sounds, t));
  for (const [loopId, loop] of Object.entries(playing.loops)) {
    const sound = soundAs(sounds, loop.soundId, "loop");
    if (!sound) continue;
    const crossing = loopCrossingMs(sound.ms);
    for (const o of withNext(loop.at, sound.ms, crossing, t)) {
      const fadeIn: EnvelopePoint[] = o.k === 0 ? [[o.startAt, 0], [o.startAt + Math.min(LOOP_FADE_IN_MS, sound.ms / 2), 1]] : [[o.startAt, 0], [o.startAt + crossing, 1]];
      out.push({
        key: `l:${loopId}:${loop.soundId}:${loop.at}:${o.k}`,
        channel: "loop",
        soundId: loop.soundId,
        assetId: sound.assetId,
        startAt: o.startAt,
        lengthMs: sound.ms,
        level: sound.level ?? 0,
        volume: loop.volume,
        envelope: [...fadeIn, [o.startAt + sound.ms - crossing, 1], [o.startAt + sound.ms, 0]],
      });
    }
  }
  return out;
}

/** The occurrences sounding at `t`, and the next one when it starts within the lookahead. */
function withNext(at: number, lengthMs: number, crossingMs: number | null, t: number): { k: number; startAt: number }[] {
  const now = occurrencesAt(at, lengthMs, crossingMs, t);
  const out: { k: number; startAt: number }[] = now.map((o) => ({ k: o.k, startAt: o.startAt }));
  if (t < at) {
    if (at - t <= LOOKAHEAD_MS) out.push({ k: 0, startAt: at });
    return out;
  }
  // Two passes sounding is a crossing: the next one loads once the older is done, so a sound never needs more than its two elements.
  if (crossingMs === null || out.length !== 1) return out;
  // The pass right after the one sounding, never a later one: a loop shorter than the lookahead would skip a pass already
  // loaded ahead, and Voices would cancel it and start it late. The period is occurrencesAt's, the crossing held to half.
  const current = out[0]!;
  const nextAt = current.startAt + lengthMs - Math.min(Math.max(0, crossingMs), Math.floor(lengthMs / 2));
  if (nextAt - t <= LOOKAHEAD_MS) out.push({ k: current.k + 1, startAt: nextAt });
  return out;
}

function musicVoices(music: MusicRun, sounds: Lengths, t: number): VoicePlan[] {
  const out: VoicePlan[] = [];
  const now = soundAs(sounds, music.now.soundId, "music");
  const fade = music.fade * 1_000;
  const next = music.next ? soundAs(sounds, music.next.soundId, "music") : undefined;
  if (now) {
    const repeats = music.repeat === "one";
    const crossing = repeats ? Math.min(fade, Math.floor(now.ms / 2)) : null;
    for (const o of withNext(music.now.at, now.ms, crossing, t)) {
      const envelope: EnvelopePoint[] = [];
      // The envelope starts a track at full volume, its fade-in being the element's (fadeIn). Repeat one's later passes
      // fade in and out over its crossing.
      if (repeats && o.k > 0 && crossing! > 0) envelope.push([o.startAt, 0], [o.startAt + crossing!, 1]);
      else envelope.push([o.startAt, 1]);
      if (repeats && crossing! > 0) envelope.push([o.startAt + now.ms - crossing!, 1], [o.startAt + now.ms, 0]);
      if (music.next && next) {
        const end = crossEndAt(music.now, now.ms, music.next, fade);
        envelope.push([music.next.at, 1], [end, 0]);
      } else if (!repeats) {
        // Nothing follows: Repeat off's last track, or a next track that is no longer music, which ends the run there. Any
        // other run reveals its next 10 to 20 s before it starts, long before this fade reaches the horizon, so the fade
        // sounds only at the music's own end.
        const tail = Math.min(MUSIC_FADE_MS, Math.floor(now.ms / 2));
        envelope.push([o.startAt + now.ms - tail, 1], [o.startAt + now.ms, 0]);
      }
      const plan = voice("music", `m:${music.now.soundId}:${music.now.at}:${o.k}`, music.now.soundId, now, o.startAt, envelope, 100);
      out.push(o.k === 0 ? { ...plan, fadeIn: true } : plan);
    }
  }
  if (music.next && next) {
    const end = now ? crossEndAt(music.now, now.ms, music.next, fade) : music.next.at;
    const sounding = occurrencesAt(music.next.at, next.ms, null, t).length > 0 || music.next.at > t;
    if (sounding) {
      const envelope: EnvelopePoint[] = end > music.next.at ? [[music.next.at, 0], [end, 1]] : [[music.next.at, 1]];
      out.push(voice("music", `m:${music.next.soundId}:${music.next.at}:0`, music.next.soundId, next, music.next.at, envelope, 100));
    }
  }
  return out;
}

function voice(channel: Channel, key: string, soundId: SoundId, sound: Pick<Sound, "ms" | "assetId" | "level">, startAt: number, envelope: EnvelopePoint[], volume: number): VoicePlan {
  return { key, channel, soundId, assetId: sound.assetId, startAt, lengthMs: sound.ms, level: sound.level ?? 0, volume, envelope };
}

/**
 * How long a voice that left the plan fades: a second behind a blackout,
 * 0.3 s for a track another replaced, 2 s for a stop. A pause is a stop,
 * since a player's projection has no music then and fades it so.
 */
export function leaveMs(playing: Playing | null | undefined, channel: Channel): number {
  if (!playing) return BLACKOUT_FADE_MS;
  if (channel === "music" && playing.music && playing.music.paused === undefined) return SHORT_FADE_MS;
  return STOP_FADE_MS;
}

// ---------------------------------------------------------------- the elements

/** What the voices need of the page: the server's time, the latency to the speaker, and where a file is. */
export interface VoicesEnv {
  ctx: AudioContext;
  /** The page's pool: its elements, and the bless told which of them a voice holds. */
  unlock: Pick<SoundUnlock, "pool" | "holdWith">;
  /** Each channel's gain, which the engine sets from the device's and the room's volumes. */
  output: Record<Channel, AudioNode>;
  serverNow(): number;
  /** The output's latency, `outputLatency` and `baseLatency`, in ms. */
  latencyMs(): number;
  url(assetId: string, channel: Channel): string;
  /** Told when the music's state changes, for the lines in Ambiance's Sound. */
  onMusic?(state: MusicState): void;
  /** Where gestures arrive (the window), for a voice whose play the browser refused until one. */
  gestures?: EventTarget;
}

export type MusicState = "none" | "loading" | "failed" | "playing";

type Live = {
  plan: VoicePlan;
  index: number;
  el: HTMLAudioElement;
  fade: GainNode;
  env: GainNode;
  mix: GainNode;
  settle: Settle;
  /** Set once the element plays, null while it waits for its start. */
  playing: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
  leaving: boolean;
  failed: boolean;
  /** Since when it has been due to sound, the shared indicator's 200 ms counted from it. */
  dueSince: number | null;
  /** Its last play was refused for want of a gesture, so it waits for the next one. */
  refused: boolean;
  /** Its plays so far, so a late answer to an older one is not taken for the newest. */
  plays: number;
  /** Its newest play was asked in this task. A refusal, answered before the task ends, leaves the element paused till then, which is no stop. */
  asking: boolean;
  /** Its placements so far, so a seek one overtook does nothing. */
  places: number;
  /** Until this server time the envelope ramps from where it was to the plan, after a new plan moved its gain. */
  smoothUntil: number;
  /** The source it plays, which a loop's blob replaces only at its next pass. */
  url: string;
  /** For a `fadeIn` placement: the audio clock time its fade starts, until the element first sounds, then null. */
  fadeFrom: number | null;
};

/** One `MediaElementAudioSourceNode` per element, made once: an element can have only one. */
const sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

export class Voices {
  readonly #env: VoicesEnv;
  readonly #elements: readonly HTMLAudioElement[];
  readonly #unhold: () => void;
  readonly #live = new Map<string, Live>();
  /** Elements leaving, with the time they are free again. */
  readonly #busyUntil = new Map<number, number>();
  /** The last plan, and the timer that starts what of it waited for an element. */
  #plans: readonly VoicePlan[] = [];
  #whenFree: ReturnType<typeof setTimeout> | null = null;
  #music: MusicState = "none";
  #disposed = false;
  #gesture: Activation | null = null;

  constructor(env: VoicesEnv) {
    this.#env = env;
    this.#elements = env.unlock.pool() as readonly HTMLAudioElement[];
    // A voice, sounding, fading out or loaded ahead, keeps its element's source through a bless, which would set silence.
    this.#unhold = env.unlock.holdWith((el) => [...this.#live.values()].some((v) => v.el === el));
  }

  /** What each sounding voice is doing, for the test hook. */
  snapshot(): { key: string; sound: SoundId; channel: Channel; aimMs: number; currentMs: number; rate: number; playing: boolean }[] {
    const t = this.#env.serverNow();
    return [...this.#live.values()]
      .filter((v) => !v.leaving)
      .map((v) => ({ key: v.plan.key, sound: v.plan.soundId, channel: v.plan.channel, aimMs: this.#aim(v.plan, t), currentMs: v.el.currentTime * 1000, rate: v.el.playbackRate, playing: v.playing }));
  }

  get counts(): { music: boolean; loops: number } {
    const t = this.#env.serverNow();
    let music = false;
    const loops = new Set<string>();
    for (const v of this.#live.values()) {
      if (v.leaving || t < v.plan.startAt) continue;
      if (v.plan.channel === "music") music = true;
      else loops.add(v.plan.key.split(":")[1]!);
    }
    return { music, loops: loops.size };
  }

  /** Takes a new plan: voices that stay keep their elements, new ones start, and the rest fade out. */
  update(plans: readonly VoicePlan[], leaveMs: (plan: VoicePlan) => number): void {
    this.#plans = plans;
    const wanted = new Map(plans.map((p) => [p.key, p]));
    // Music the plan names under another key but at the same place: a change of Repeat or Crossfade during Repeat one's
    // later passes moves `now.at` to the pass sounding, which renames its voice. The voice plays on as it is.
    const heirs = new Map(plans.filter((p) => p.channel === "music" && !this.#live.has(p.key)).map((p) => [`${p.soundId}:${p.startAt}`, p]));
    const t = this.#env.serverNow();
    for (const [key, v] of [...this.#live]) {
      if (v.leaving) continue;
      const plan = wanted.get(key);
      const heir = plan || v.plan.channel !== "music" ? undefined : heirs.get(`${v.plan.soundId}:${v.plan.startAt}`);
      if (plan) {
        this.#keep(v, plan, t);
      } else if (heir) {
        heirs.delete(`${heir.soundId}:${heir.startAt}`);
        this.#live.delete(key);
        this.#live.set(heir.key, v);
        this.#keep(v, heir, t);
      } else if (t >= v.plan.startAt + v.plan.lengthMs) {
        this.#ended(v);
      } else {
        this.#leave(v, leaveMs(v.plan));
      }
    }
    for (const plan of plans) {
      const live = this.#live.get(plan.key);
      // A voice wanted again while it fades out, as when this page plays again at once, starts afresh in its place.
      if (live?.leaving) this.#release(live);
      if (!this.#live.has(plan.key)) this.#start(plan);
    }
    this.#reportMusic();
  }

  /** A voice that stays takes its new plan: its envelope and mix move to it, and its element and fade go on untouched. */
  #keep(v: Live, plan: VoicePlan, t: number): void {
    const volumeChanged = plan.volume !== v.plan.volume || plan.level !== v.plan.level;
    // A promotion during a crossfade, or a pause or a change of repeat in one, gives the voice another gain now.
    if (gainAt(plan.envelope, t) !== gainAt(v.plan.envelope, t)) v.smoothUntil = t + SHORT_FADE_MS;
    v.plan = plan;
    if (volumeChanged) this.#ramp(v.mix.gain, mixGain(plan), SHORT_FADE_MS);
    this.#envelope(v);
  }

  /** Once a second: a dropped seek put right, the envelopes renewed, starts that waited for an element, ends released. */
  check(): void {
    const t = this.#env.serverNow();
    for (const v of this.#live.values()) {
      if (v.leaving) continue;
      if (t > v.plan.startAt + v.plan.lengthMs + 500) {
        this.#ended(v);
        continue;
      }
      this.#envelope(v);
      if (this.#heal(v, t)) continue;
      if (!v.playing || v.el.paused || v.el.readyState < 2) continue;
      if (v.settle.check(v.el.currentTime * 1000)) this.#seek(v);
    }
    this.#reportMusic();
  }

  /**
   * Every voice at once, as for Room sound off, a handoff or the engine
   * going: each fades over `ms`. The plan goes too, with the start that
   * waited for an element (a Skip in a crossfade): it would otherwise start
   * on a page that stopped, fetching and decoding under the lease's
   * silence. The engine gives a plan again once this page plays.
   */
  stopAll(ms: number): void {
    this.#plans = [];
    this.#cancelWhenFree();
    for (const v of this.#live.values()) if (!v.leaving) this.#leave(v, ms);
    this.#reportMusic();
  }

  /** Try again for music that did not load, from the panel or once the room reconnects. */
  retry(): void {
    for (const v of this.#live.values()) {
      if (!v.failed || v.leaving) continue;
      v.failed = false;
      v.url = this.#env.url(v.plan.assetId, v.plan.channel);
      v.el.src = v.url;
      this.#place(v);
    }
    this.#reportMusic();
  }

  dispose(): void {
    this.#disposed = true;
    this.#unhold();
    this.#gesture?.stop();
    this.#gesture = null;
    this.#cancelWhenFree();
    for (const v of this.#live.values()) this.#release(v);
    this.#live.clear();
  }

  // ---------------------------------------------------------------- one voice

  /** Where the element should be now: the timeline's place plus what the output has yet to play. */
  #aim(plan: VoicePlan, t: number): number {
    return t + this.#env.latencyMs() - plan.startAt;
  }

  #ctxAt(serverMs: number): number {
    return this.#env.ctx.currentTime + (serverMs - this.#env.serverNow()) / 1000;
  }

  #freeElement(channel: Channel): number | null {
    const range = channel === "music" ? [0, 1] : [2, 3, 4, 5, 6, 7, 8, 9];
    const used = new Set([...this.#live.values()].filter((v) => !v.leaving).map((v) => v.index));
    const now = performance.now();
    for (const i of range) if (!used.has(i) && (this.#busyUntil.get(i) ?? 0) <= now) return i;
    return null;
  }

  #start(plan: VoicePlan): void {
    const index = this.#freeElement(plan.channel);
    if (index === null) return this.#startWhenFree();
    const { ctx } = this.#env;
    const el = this.#elements[index]!;
    let source = sources.get(el);
    if (!source) {
      source = ctx.createMediaElementSource(el);
      sources.set(el, source);
    }
    source.disconnect();
    const fade = ctx.createGain();
    const env = ctx.createGain();
    const mix = ctx.createGain();
    fade.gain.value = 0;
    mix.gain.value = mixGain(plan);
    source.connect(fade).connect(env).connect(mix).connect(this.#env.output[plan.channel]);
    const url = this.#env.url(plan.assetId, plan.channel);
    const v: Live = { plan, index, el, fade, env, mix, settle: new Settle(), playing: false, startTimer: null, leaving: false, failed: false, dueSince: null, refused: false, plays: 0, asking: false, places: 0, url, smoothUntil: 0, fadeFrom: null };
    this.#live.set(plan.key, v);
    el.onerror = () => {
      // Only a failure of the voice's own file fails it. One of a source swapped in, as a bless's silence, is the check's to put back.
      if (!el.src.endsWith(v.url)) return;
      v.failed = true;
      this.#reportMusic();
    };
    el.onplaying = () => {
      this.#sounded(v);
      this.#reportMusic();
    };
    el.onwaiting = () => this.#reportMusic();
    // An element whose last load of this file failed, as one cut off by a server restart, loads it again: only setting the source does.
    if (!el.src.endsWith(url) || el.error) el.src = url;
    el.loop = false;
    el.playbackRate = 1;
    this.#envelope(v);
    this.#place(v);
  }

  /**
   * Puts back a voice whose element lost it: its source swapped (silence
   * from a bless, say), or stopped while the voice plays and short of its
   * end (that silence ended, or a play the browser refused). True when it
   * placed the voice again.
   */
  #heal(v: Live, t: number): boolean {
    if (v.failed || v.refused) return false;
    const swapped = !v.el.src.endsWith(v.url);
    const aim = this.#aim(v.plan, t);
    const stopped = v.playing && !v.asking && v.el.paused && aim >= 0 && aim < v.plan.lengthMs - HEAL_END_MS;
    if (!swapped && !stopped) return false;
    if (swapped) v.el.src = v.url;
    this.#place(v, v.dueSince ?? performance.now());
    return true;
  }

  /**
   * Every element of a channel is busy. One fading out, as both music
   * elements after a Skip during a crossfade, is free in a moment: the plan
   * waiting for it starts then, not at the next check a second later. Two
   * loops crossing with a third waiting leave none fading, and the next
   * check tries again.
   */
  #startWhenFree(): void {
    if (this.#whenFree || this.#disposed || this.#busyUntil.size === 0) return;
    const free = Math.min(...this.#busyUntil.values());
    this.#whenFree = setTimeout(
      () => {
        this.#whenFree = null;
        if (this.#disposed) return;
        const t = this.#env.serverNow();
        for (const plan of this.#plans) if (!this.#live.has(plan.key) && t < plan.startAt + plan.lengthMs) this.#start(plan);
        this.#reportMusic();
      },
      Math.max(0, free - performance.now()) + 1,
    );
  }

  #cancelWhenFree(): void {
    if (this.#whenFree) clearTimeout(this.#whenFree);
    this.#whenFree = null;
  }

  /**
   * Puts the element at its place: now with a fade in, 2 s for music's own
   * track and 0.3 s for any other voice, or paused at 0 until its start.
   * `due` is when it became due to sound: a voice placed again keeps its
   * own, so one that keeps failing to start stays loading, never back to
   * playing for the indicator's 200 ms at each check, and one that stopped
   * short, which the line may already call loading, does too.
   */
  #place(v: Live, due = performance.now()): void {
    const t = this.#env.serverNow();
    const aim = this.#aim(v.plan, t);
    if (v.startTimer) clearTimeout(v.startTimer);
    v.startTimer = null;
    v.refused = false;
    v.places++;
    const ctxNow = this.#env.ctx.currentTime;
    if (aim < 0) {
      // Loaded ahead at position 0 and paused. A timer starts it.
      v.el.pause();
      try {
        v.el.currentTime = 0;
      } catch {
        // Not seekable yet: it starts from 0 anyway.
      }
      v.fade.gain.cancelScheduledValues(ctxNow);
      if (v.plan.fadeIn) {
        // From the element's start on the audio clock, as every device schedules it from the same server time.
        const startCtx = ctxNow - aim / 1000;
        v.fade.gain.setValueAtTime(0, ctxNow);
        v.fade.gain.setValueAtTime(0, startCtx);
        v.fade.gain.linearRampToValueAtTime(1, startCtx + MUSIC_FADE_MS / 1000);
        v.fadeFrom = startCtx;
      } else {
        v.fade.gain.setValueAtTime(1, ctxNow);
        v.fadeFrom = null;
      }
      v.playing = false;
      v.startTimer = setTimeout(() => {
        v.startTimer = null;
        if (v.leaving) return;
        v.playing = true;
        v.dueSince = performance.now();
        this.#play(v);
        // A timer a throttled phone ran late leaves the element at 0 behind its place: the first check seeks it once
        // if it is more than 2 s late, and an on time start is left alone.
        v.settle.placed(Math.max(0, this.#aim(v.plan, this.#env.serverNow())));
        this.#reportSoon();
      }, -aim);
      return;
    }
    try {
      v.el.currentTime = aim / 1000;
    } catch {
      // Not seekable yet: the first check that finds it playing seeks it if it is still short.
    }
    v.fade.gain.cancelScheduledValues(ctxNow);
    v.fade.gain.setValueAtTime(0, ctxNow);
    // A resume's moment, a join's, or a heal's, a retry's or a refused play's placement again, is this page's alone: the
    // run says only where the track is, so the fade-in starts here, over 2 s for any `fadeIn` plan.
    v.fade.gain.linearRampToValueAtTime(1, ctxNow + (v.plan.fadeIn ? MUSIC_FADE_MS : JOIN_FADE_MS) / 1000);
    v.fadeFrom = v.plan.fadeIn ? ctxNow : null;
    v.playing = true;
    v.dueSince = due;
    v.settle.placed(aim);
    this.#play(v);
    this.#reportSoon();
  }

  /**
   * The element's first sound since a `fadeIn` placement. One that comes
   * late, as a first load over a weak signal does, would find its fade
   * already over and start at full, so it fades in afresh from now. Only
   * the first counts: a later stall's `playing` leaves the fade alone. A
   * bless's play of an element loaded ahead is no start (`playing` unset).
   */
  #sounded(v: Live): void {
    if (v.fadeFrom === null || v.leaving || !v.playing) return;
    const from = v.fadeFrom;
    v.fadeFrom = null;
    const ctxNow = this.#env.ctx.currentTime;
    if (ctxNow - from <= LATE_SOUND_MS / 1000) return;
    const p = v.fade.gain;
    p.cancelScheduledValues(ctxNow);
    p.setValueAtTime(0, ctxNow);
    p.linearRampToValueAtTime(1, ctxNow + MUSIC_FADE_MS / 1000);
  }

  /**
   * A play the browser refuses for want of a gesture (NotAllowedError) is
   * not tried again at each check, which would seek, fetch a range again
   * and never start. The voice waits for the next gesture, and is placed
   * again inside it, so the browser counts the play as the user's.
   */
  #play(v: Live): void {
    const n = ++v.plays;
    v.asking = true;
    void v.el.play().catch((err: unknown) => {
      if ((err as { name?: unknown } | null)?.name !== "NotAllowedError" || n !== v.plays) return;
      v.refused = true;
      this.#awaitGesture();
    });
    // Queued after a refusal's answer, which a play the browser turns down already holds. A play it takes may start late, and a
    // check meanwhile may still find it stopped and put it back.
    queueMicrotask(() => {
      v.asking = false;
    });
  }

  #awaitGesture(): void {
    const target = this.#env.gestures;
    if (!target || this.#disposed) return;
    if (this.#gesture) this.#gesture.rearm();
    else this.#gesture = onActivation(() => this.#placeRefused(), target);
  }

  #placeRefused(): boolean {
    for (const v of this.#live.values()) if (v.refused && !v.leaving) this.#place(v, v.dueSince ?? performance.now());
    this.#reportMusic();
    return true;
  }

  /** Music that has not started within 200 ms says it is loading: one look then, as well as at each check. */
  #reportSoon(): void {
    setTimeout(() => this.#reportMusic(), 220);
  }

  #seek(v: Live): void {
    const ctxNow = this.#env.ctx.currentTime;
    const p = v.fade.gain;
    p.cancelScheduledValues(ctxNow);
    p.setValueAtTime(p.value, ctxNow);
    p.linearRampToValueAtTime(0, ctxNow + SEEK_FADE_MS / 1000);
    const places = v.places;
    setTimeout(() => {
      // A placement since put the element where it belongs and faded it in: seeking it again would dip it, or seek a refused one.
      if (v.leaving || v.places !== places) return;
      try {
        v.el.currentTime = this.#aim(v.plan, this.#env.serverNow()) / 1000;
      } catch {
        // Not seekable now: it plays on from where it is.
      }
      const at = this.#env.ctx.currentTime;
      p.cancelScheduledValues(at);
      p.setValueAtTime(0, at);
      p.linearRampToValueAtTime(1, at + SEEK_FADE_MS / 1000);
    }, SEEK_FADE_MS);
  }

  /**
   * The envelope from now to the horizon, on the audio clock, mapped from
   * server time afresh. While a new plan's gain is still coming in it ramps
   * from where the gain is, so it never steps.
   */
  #envelope(v: Live): void {
    const t = this.#env.serverNow();
    const p = v.env.gain;
    const ctxNow = this.#env.ctx.currentTime;
    const current = p.value;
    p.cancelScheduledValues(ctxNow);
    const from = Math.max(t, v.smoothUntil);
    if (from > t) {
      p.setValueAtTime(current, ctxNow);
      p.linearRampToValueAtTime(gainAt(v.plan.envelope, from), this.#ctxAt(from));
    } else {
      p.setValueAtTime(gainAt(v.plan.envelope, t), ctxNow);
    }
    const end = t + HORIZON_MS;
    for (const [at] of v.plan.envelope) if (at > from && at < end) p.linearRampToValueAtTime(gainAt(v.plan.envelope, at), this.#ctxAt(at));
    p.linearRampToValueAtTime(gainAt(v.plan.envelope, end), this.#ctxAt(end));
  }

  #ramp(p: AudioParam, value: number, ms: number): void {
    const ctxNow = this.#env.ctx.currentTime;
    p.cancelScheduledValues(ctxNow);
    p.setValueAtTime(p.value, ctxNow);
    p.linearRampToValueAtTime(value, ctxNow + ms / 1000);
  }

  /**
   * A pass the timeline says has ended. An element that played to its end
   * has stopped and is free for the next. One still playing fell behind on a
   * slow connection, so its last part fades out quickly instead of stopping
   * with a click.
   */
  #ended(v: Live): void {
    if (v.el.paused) this.#release(v);
    else this.#leave(v, SHORT_FADE_MS);
  }

  #leave(v: Live, ms: number): void {
    v.leaving = true;
    if (v.startTimer) clearTimeout(v.startTimer);
    v.startTimer = null;
    if (!v.playing) return this.#release(v);
    this.#ramp(v.fade.gain, 0, ms);
    this.#busyUntil.set(v.index, performance.now() + ms + 50);
    setTimeout(() => this.#release(v), ms + 50);
  }

  #release(v: Live): void {
    if (this.#live.get(v.plan.key) === v) this.#live.delete(v.plan.key);
    if (v.startTimer) clearTimeout(v.startTimer);
    v.startTimer = null;
    v.el.onerror = null;
    v.el.onplaying = null;
    v.el.onwaiting = null;
    // Only once no newer voice took the element.
    if (![...this.#live.values()].some((o) => o.index === v.index)) v.el.pause();
    v.fade.disconnect();
    v.env.disconnect();
    v.mix.disconnect();
    this.#busyUntil.delete(v.index);
  }

  #reportMusic(): void {
    if (this.#disposed) return;
    const t = this.#env.serverNow();
    let state: MusicState = "none";
    for (const v of this.#live.values()) {
      if (v.plan.channel !== "music" || v.leaving || t < v.plan.startAt) continue;
      if (v.failed) {
        state = "failed";
        break;
      }
      const ready = v.playing && !v.el.paused && v.el.readyState >= 3;
      // The shared indicator's 200 ms: a track that starts at once never shows loading.
      const waited = v.dueSince !== null && performance.now() - v.dueSince >= 200;
      // Under 200 ms a track not yet sounding still counts as playing, so a quick start never flashes the loading line.
      state = ready || !waited ? "playing" : "loading";
    }
    if (state === this.#music) return;
    this.#music = state;
    this.#env.onMusic?.(state);
  }
}

/** A voice's own gain: its level evening its loudness, and a loop's volume for everyone, squared. */
export function mixGain(plan: Pick<VoicePlan, "level" | "volume" | "channel">): number {
  const level = 10 ** (plan.level / 200);
  const volume = plan.channel === "loop" ? (plan.volume / 100) ** 2 : 1;
  return level * volume;
}

/** A loop of this many bytes or fewer plays from a blob of its whole file, fetched once (5.3). */
export const BLOB_LOOP_BYTES = SOUND_LIMITS.blobLoopBytes;
