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
import type { SoundUnlock } from "./context.ts";
import { Drift, SEEK_FADE_MS } from "./drift.ts";

/**
 * Music and background sounds on this page (docs/design/design-v1-music.md
 * 5.2 and 5.3). `planVoices` reads the timeline: which occurrence of which
 * sound should sound at a server time, where in its file, and its envelope.
 * `Voices` keeps the pool's elements on that plan: each element runs
 * through its own gains to the music or background channel, is aimed at
 * its place plus the output's latency, and the drift check keeps it there.
 */

/** A voice due to start within this is loaded ahead, paused at its start, so it can start on time. */
export const LOOKAHEAD_MS = 3_000;
/** A join or a resume fades in over this. */
export const JOIN_FADE_MS = SHORT_FADE_MS;
/** Players and displays fade out over this behind a blackout. */
export const BLACKOUT_FADE_MS = 1_000;
/** How far ahead each envelope is scheduled on the audio clock, renewed with every check. */
const HORIZON_MS = 2_500;

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
      // A track starts at full volume. Repeat one's later passes fade in and out over its crossing.
      if (repeats && o.k > 0 && crossing! > 0) envelope.push([o.startAt, 0], [o.startAt + crossing!, 1]);
      else envelope.push([o.startAt, 1]);
      if (repeats && crossing! > 0) envelope.push([o.startAt + now.ms - crossing!, 1], [o.startAt + now.ms, 0]);
      if (music.next && next) {
        const end = crossEndAt(music.now, now.ms, music.next, fade);
        envelope.push([music.next.at, 1], [end, 0]);
      }
      out.push(voice("music", `m:${music.now.soundId}:${music.now.at}:${o.k}`, music.now.soundId, now, o.startAt, envelope, 100));
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
  /** Told when the music's state changes, for the Sound panel's lines. */
  onMusic?(state: MusicState): void;
}

export type MusicState = "none" | "loading" | "failed" | "playing";

type Live = {
  plan: VoicePlan;
  index: number;
  el: HTMLAudioElement;
  fade: GainNode;
  env: GainNode;
  mix: GainNode;
  drift: Drift;
  /** Set once the element plays, null while it waits for its start. */
  playing: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
  leaving: boolean;
  failed: boolean;
  dueSince: number | null;
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
  #music: MusicState = "none";
  #disposed = false;

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
    const wanted = new Map(plans.map((p) => [p.key, p]));
    const t = this.#env.serverNow();
    for (const [key, v] of this.#live) {
      if (v.leaving) continue;
      const plan = wanted.get(key);
      if (plan) {
        const volumeChanged = plan.volume !== v.plan.volume || plan.level !== v.plan.level;
        v.plan = plan;
        if (volumeChanged) this.#ramp(v.mix.gain, mixGain(plan), SHORT_FADE_MS);
        this.#envelope(v);
      } else if (t >= v.plan.startAt + v.plan.lengthMs) {
        // A pass that ended by itself is silent already, and its element is free for the next.
        this.#release(v);
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

  /** Once a second: the drift check, the envelopes renewed, starts that waited for an element, ends released. */
  check(forced: boolean): void {
    const t = this.#env.serverNow();
    for (const v of this.#live.values()) {
      if (v.leaving) continue;
      if (t > v.plan.startAt + v.plan.lengthMs + 500) {
        this.#release(v);
        continue;
      }
      this.#envelope(v);
      if (!v.playing || v.el.paused || v.el.readyState < 2) continue;
      if (forced) v.drift.force();
      const action = v.drift.check(performance.now(), v.el.currentTime * 1000, this.#aim(v.plan, t));
      if (action.kind === "rate") {
        if (v.el.playbackRate !== action.rate) v.el.playbackRate = action.rate;
      } else {
        this.#seek(v);
      }
    }
    this.#reportMusic();
  }

  /** Every voice at once, as for Room sound off, a handoff or the engine going: each fades over `ms`. */
  stopAll(ms: number): void {
    for (const v of this.#live.values()) if (!v.leaving) this.#leave(v, ms);
    this.#reportMusic();
  }

  /** Try again for music that did not load. */
  retry(): void {
    for (const v of this.#live.values()) {
      if (!v.failed || v.leaving) continue;
      v.failed = false;
      v.el.src = this.#env.url(v.plan.assetId, v.plan.channel);
      this.#place(v);
    }
    this.#reportMusic();
  }

  dispose(): void {
    this.#disposed = true;
    this.#unhold();
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
    // Every element of the channel is busy, as while two loops cross with a third waiting: the next check tries again.
    if (index === null) return;
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
    const v: Live = { plan, index, el, fade, env, mix, drift: new Drift(), playing: false, startTimer: null, leaving: false, failed: false, dueSince: null };
    this.#live.set(plan.key, v);
    el.onerror = () => {
      v.failed = true;
      this.#reportMusic();
    };
    el.onplaying = () => this.#reportMusic();
    el.onwaiting = () => this.#reportMusic();
    const url = this.#env.url(plan.assetId, plan.channel);
    if (!el.src.endsWith(url)) el.src = url;
    el.loop = false;
    el.playbackRate = 1;
    this.#envelope(v);
    this.#place(v);
  }

  /** Puts the element at its place: now with a short fade in, or paused at 0 until its start. */
  #place(v: Live): void {
    const t = this.#env.serverNow();
    const aim = this.#aim(v.plan, t);
    if (v.startTimer) clearTimeout(v.startTimer);
    v.startTimer = null;
    const ctxNow = this.#env.ctx.currentTime;
    if (aim < 0) {
      // Loaded ahead at position 0 and paused. A timer starts it, and the drift check corrects any lateness.
      v.el.pause();
      try {
        v.el.currentTime = 0;
      } catch {
        // Not seekable yet: it starts from 0 anyway.
      }
      v.fade.gain.cancelScheduledValues(ctxNow);
      v.fade.gain.setValueAtTime(1, ctxNow);
      v.playing = false;
      v.startTimer = setTimeout(() => {
        v.startTimer = null;
        if (v.leaving) return;
        v.playing = true;
        v.dueSince = performance.now();
        void v.el.play().catch(() => {});
        v.drift.sought(performance.now());
        this.#reportSoon();
      }, -aim);
      return;
    }
    try {
      v.el.currentTime = aim / 1000;
    } catch {
      // Not seekable yet: the drift check seeks once it is.
    }
    v.fade.gain.cancelScheduledValues(ctxNow);
    v.fade.gain.setValueAtTime(0, ctxNow);
    v.fade.gain.linearRampToValueAtTime(1, ctxNow + JOIN_FADE_MS / 1000);
    v.playing = true;
    v.dueSince = performance.now();
    v.drift.sought(performance.now());
    void v.el.play().catch(() => {});
    this.#reportSoon();
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
    setTimeout(() => {
      if (v.leaving) return;
      try {
        v.el.currentTime = this.#aim(v.plan, this.#env.serverNow()) / 1000;
      } catch {
        // Not seekable now: the next check tries again.
      }
      v.el.playbackRate = 1;
      const at = this.#env.ctx.currentTime;
      p.cancelScheduledValues(at);
      p.setValueAtTime(0, at);
      p.linearRampToValueAtTime(1, at + SEEK_FADE_MS / 1000);
    }, SEEK_FADE_MS);
  }

  /** The envelope from now to the horizon, on the audio clock, mapped from server time afresh. */
  #envelope(v: Live): void {
    const t = this.#env.serverNow();
    const p = v.env.gain;
    const ctxNow = this.#env.ctx.currentTime;
    p.cancelScheduledValues(ctxNow);
    p.setValueAtTime(gainAt(v.plan.envelope, t), ctxNow);
    const end = t + HORIZON_MS;
    for (const [at] of v.plan.envelope) if (at > t && at < end) p.linearRampToValueAtTime(gainAt(v.plan.envelope, at), this.#ctxAt(at));
    p.linearRampToValueAtTime(gainAt(v.plan.envelope, end), this.#ctxAt(end));
  }

  #ramp(p: AudioParam, value: number, ms: number): void {
    const ctxNow = this.#env.ctx.currentTime;
    p.cancelScheduledValues(ctxNow);
    p.setValueAtTime(p.value, ctxNow);
    p.linearRampToValueAtTime(value, ctxNow + ms / 1000);
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
