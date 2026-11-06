import { SHORT_FADE_MS, type BuiltinSound, type FiredEffect, type Playing, type Sound, type SoundId } from "#shared/sound.ts";
import type { SoundTimeLink } from "../../../state/socket.ts";
import { soundMix, subscribeSoundMix, type SoundMix } from "../../device/settings.ts";
import { playShape, TRAP_SOUND_SHAPES } from "./builtins.ts";
import { ServerClock } from "./clock.ts";
import { mixerSupported, soundContext, soundUnlock, watchAudio, type AudioSessionLike } from "./context.ts";
import { CHECK_MS } from "./settle.ts";
import { EffectPlayer, type EffectSound, type EffectVoice } from "./effects.ts";
import { browserLocks, channelName, Handoff, type HandoffAudio, type HandoffPost, type PageKind } from "./handoff.ts";
import { SoundMediaSession } from "./mediaSession.ts";
import { setMusicRetry, setSoundHere, somethingToHear, type MusicHere, type SoundHere } from "./store.ts";
import { exposeSoundTest, type SoundTestView } from "./testHook.ts";
import { BLOB_LOOP_BYTES, leaveMs, planVoices, Voices, type Channel } from "./voices.ts";

/**
 * The room's sound on this page (docs/design/design-v1-music.md 5), the
 * lazy chunk SoundHost loads the first time the room plays something. It
 * joins the parts: the server's time (clock.ts), one page per browser
 * (handoff.ts), music and loops on the pool's elements (voices.ts),
 * effects as buffers (effects.ts), the media session, and the mixer:
 *
 *   element → its gains → music or background → master, 3 dB down
 *   effect  → its level → effects ────────────↗ → compressor → lease → speaker
 *
 * Gains are the device's slider squared, times the room's volume squared,
 * times the sound's level, times the timeline's envelope, ramped over
 * 0.3 s on any change. Devices play from the confirmed state only, so a
 * device's own clock never places a sound.
 */

export type EngineInput = {
  /** The confirmed projection's `playing`: null for nothing (a blackout included), undefined while the store is cleared for a reconnect. */
  playing: Playing | null | undefined;
  sounds: Readonly<Record<SoundId, Sound>>;
  /** Room sound on, or a display's Sound on and no blackout. */
  enabled: boolean;
  /** The socket is open: a reconnect starts a new measurement epoch. */
  connected: boolean;
};

export type EngineDeps = {
  room: string;
  kind: PageKind;
  roomName(): string;
  url(assetId: string): string;
  time: SoundTimeLink | null;
  /** The store's server offset, the clock's fallback. */
  fallbackOffset(): number | undefined;
  /** The media session's play and pause. */
  setOn(on: boolean): void;
  /** When the page first held the room's confirmed state, in server ms, before this lazy engine loaded, or null. */
  loadAt(): number | null;
};

/** A display plays at full volume: the TV's remote sets it (4.5). */
const FULL_MIX: SoundMix = { music: 100, loops: 100, effects: 100 };
/** The master is 3 dB down, so the loudest mix the caps allow stays under 0 dBFS with the compressor (D-261102-465). */
const MASTER_GAIN = 10 ** (-3 / 20);
/** The audio clock advancing this much less than the page's over a check means the context stood still. */
const CLOCK_STALL_MS = 500;

export class SoundEngine {
  readonly #deps: EngineDeps;
  readonly #ctx: AudioContext | null;
  readonly #cannot: boolean;
  #input: EngineInput = { playing: undefined, sounds: {}, enabled: false, connected: false };
  #clock: ServerClock;
  #handoff: Handoff | null = null;
  #channel: BroadcastChannel | null = null;
  #hear: BroadcastChannel | null = null;
  #voices: Voices | null = null;
  #effects: EffectPlayer | null = null;
  #media: SoundMediaSession;
  #gains: { music: GainNode; loop: GainNode; effects: GainNode; master: GainNode; lease: GainNode } | null = null;
  #active = false;
  #music: MusicHere = "none";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastCheck = { perf: 0, ctx: 0 };
  #wasConnected = false;
  readonly #blobs = new Map<string, string | Promise<void>>();
  readonly #started: { id: string; at: number; offsetMs: number }[] = [];
  readonly #cleanups: (() => void)[] = [];
  #disposed = false;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.#cannot = !mixerSupported();
    this.#ctx = this.#cannot ? null : soundContext();
    this.#media = new SoundMediaSession({ roomName: deps.roomName, setOn: deps.setOn });
    this.#clock = new ServerClock({
      now: () => performance.now(),
      send: (k) => deps.time?.send(k) ?? false,
      setTimer: (ms, fn) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      fallback: deps.fallbackOffset,
    });
    if (deps.time) this.#cleanups.push(deps.time.listen((k, at) => this.#clock.answer(k, at)));
    if (this.#ctx) this.#build(this.#ctx);
    this.#cleanups.push(subscribeSoundMix(() => this.#mix()));
    this.#cleanups.push(exposeSoundTest(() => this.#testView()));
    this.#tick();
  }

  update(input: EngineInput): void {
    if (this.#disposed) return;
    const reconnected = input.connected && !this.#wasConnected;
    this.#wasConnected = input.connected;
    this.#input = input;
    if (reconnected) this.#clock.restart();
    if (input.playing !== undefined && this.#effects) this.#effects.see(effectList(input.playing), effectSounds(input.sounds));
    this.#refresh();
    // A file cut off while the server was away, as by a restart, loads again once it is back, as Try again would. Every failed
    // voice, since an element's error can come just before the socket's close does. A file that cannot load fails again.
    if (reconnected) this.#voices?.retry();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#handoff?.close();
    this.#channel?.close();
    this.#hear?.close();
    this.#voices?.dispose();
    this.#effects?.dispose();
    this.#clock.stop();
    this.#media.dispose();
    setMusicRetry(null);
    for (const c of this.#cleanups.splice(0)) c();
    for (const url of this.#blobs.values()) if (typeof url === "string") URL.revokeObjectURL(url);
    this.#gains?.lease.disconnect();
    this.#setAudioSession(false);
    setSoundHere({ here: "off", music: "none" });
    if (typeof document !== "undefined") delete document.documentElement.dataset.sound;
  }

  // ---------------------------------------------------------------- the graph

  #build(ctx: AudioContext): void {
    const music = ctx.createGain();
    const loop = ctx.createGain();
    const effects = ctx.createGain();
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -3;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const lease = ctx.createGain();
    lease.gain.value = 0;
    music.connect(master);
    loop.connect(master);
    effects.connect(master);
    master.connect(compressor).connect(lease).connect(ctx.destination);
    this.#gains = { music, loop, effects, master, lease };
    this.#mix();

    this.#voices = new Voices({
      ctx,
      unlock: soundUnlock(),
      output: { music, loop },
      serverNow: () => this.#serverNow(),
      latencyMs: () => this.#latencyMs(),
      url: (assetId, channel) => this.#url(assetId, channel),
      onMusic: (state) => {
        this.#music = state;
        this.#report();
      },
      gestures: window,
    });
    setMusicRetry(() => this.#voices?.retry());
    const loadAt = this.#deps.loadAt();
    this.#effects = new EffectPlayer(
      {
        serverNow: () => this.#serverNow(),
        decode: async (assetId, signal) => {
          const res = await fetch(this.#deps.url(assetId), { signal, credentials: "same-origin" });
          if (!res.ok) throw new Error(`effect ${res.status}`);
          const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
          return { buffer, bytes: buffer.length * buffer.numberOfChannels * 4 };
        },
        play: (what, at, offsetMs, level, id) => this.#playEffect(ctx, what, at, offsetMs, level, id),
      },
      loadAt === null ? {} : { loadAt },
    );

    const page = randomId();
    let channel: BroadcastChannel | null = null;
    // A second object on the channel hears every post, the page's own too, in one queue, so the handoff learns that the posts that reached the page before its own have run (HandoffEnv.echo).
    let hear: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel === "function") {
        channel = new BroadcastChannel(channelName(this.#deps.room));
        hear = new BroadcastChannel(channelName(this.#deps.room));
      }
    } catch {
      channel?.close();
      channel = null;
      hear = null;
    }
    this.#channel = channel;
    this.#hear = hear;
    this.#handoff = new Handoff({
      room: this.#deps.room,
      page,
      kind: this.#deps.kind,
      now: () => Date.now(),
      setTimer: (ms, fn) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      post: (msg) => {
        try {
          channel?.postMessage(msg);
        } catch {
          // A closed channel: the page is going.
        }
      },
      echo: hear !== null,
      locks: browserLocks(),
      audio: this.#leaseAudio(ctx, lease),
      onChange: () => this.#refresh(),
    });
    if (hear) hear.onmessage = (e: MessageEvent) => this.#handoff?.receive(e.data as HandoffPost);

    const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
    this.#cleanups.push(
      watchAudio(
        ctx,
        session,
        () => {
          this.#handoff?.contextLeft();
          soundUnlock().rearm();
          this.#voices?.check();
        },
        () => this.#refresh(),
      ),
    );
    const onVisible = () => {
      const shown = document.visibilityState === "visible";
      this.#handoff?.setShown(shown);
      if (shown) this.#woke();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) this.#handoff?.resume();
      this.#woke();
    };
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) this.#handoff?.freeze();
      else this.#handoff?.close();
    };
    const onFreeze = () => this.#handoff?.freeze();
    const onResume = () => {
      this.#handoff?.resume();
      this.#woke();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    this.#cleanups.push(() => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
    });
    this.#handoff.start(document.visibilityState === "visible");
  }

  /** The output gate's controls on the lease gain, all on the audio clock (handoff.ts HandoffAudio). */
  #leaseAudio(ctx: AudioContext, lease: GainNode): HandoffAudio {
    const p = lease.gain;
    const from = () => {
      const now = ctx.currentTime;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      return now;
    };
    return {
      play: () => {
        const now = from();
        p.linearRampToValueAtTime(1, now + 0.05);
      },
      fadeOut: (ms) => {
        const now = from();
        p.linearRampToValueAtTime(0, now + ms / 1000);
      },
      hold: () => {
        const now = ctx.currentTime;
        p.cancelScheduledValues(now);
        p.setValueAtTime(0, now);
      },
      lease: (ms) => {
        const now = ctx.currentTime;
        p.cancelScheduledValues(now);
        p.setValueAtTime(1, now);
        if (ms === null) return;
        const end = now + ms / 1000;
        p.setValueAtTime(1, end - 0.2);
        p.linearRampToValueAtTime(0, end);
      },
    };
  }

  // ---------------------------------------------------------------- what plays

  #serverNow(): number {
    return this.#clock.serverNow() ?? Date.now();
  }

  #latencyMs(): number {
    const ctx = this.#ctx;
    if (!ctx) return 0;
    const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    return ((Number.isFinite(out) ? out! : 0) + (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0)) * 1000;
  }

  /** A loop of 5 MB or less plays from a blob of its whole file, fetched once, since Safari may not keep range answers (5.3). */
  #url(assetId: string, channel: Channel): string {
    const direct = this.#deps.url(assetId);
    if (channel !== "loop") return direct;
    const known = this.#blobs.get(assetId);
    if (typeof known === "string") return known;
    if (!known) {
      const load = (async () => {
        const abort = new AbortController();
        try {
          const res = await fetch(direct, { credentials: "same-origin", signal: abort.signal });
          const size = Number(res.headers.get("content-length") ?? Infinity);
          if (!res.ok || !(size <= BLOB_LOOP_BYTES)) {
            abort.abort();
            this.#blobs.set(assetId, direct);
            return;
          }
          const blob = await res.blob();
          if (this.#disposed) return;
          this.#blobs.set(assetId, URL.createObjectURL(blob));
        } catch {
          this.#blobs.set(assetId, direct);
        }
      })();
      this.#blobs.set(assetId, load);
    }
    // Until the blob is in, the file streams by Range. The next pass takes the blob.
    return direct;
  }

  #mix(): void {
    const g = this.#gains;
    const ctx = this.#ctx;
    if (!g || !ctx) return;
    const device = this.#deps.kind === "display" ? FULL_MIX : soundMix();
    const room = this.#input.playing?.volume ?? { music: 100, effects: 100 };
    const sq = (n: number) => (n / 100) ** 2;
    const set = (p: AudioParam, v: number) => {
      const now = ctx.currentTime;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(v, now + SHORT_FADE_MS / 1000);
    };
    set(g.music.gain, sq(device.music) * sq(room.music));
    set(g.loop.gain, sq(device.loops));
    set(g.effects.gain, sq(device.effects) * sq(room.effects));
  }

  #refreshing = false;
  #again = false;

  /** Brings everything in line with the input, the handoff and the context. A change it causes (the handoff's onChange) runs it again after, never inside. */
  #refresh(): void {
    if (this.#disposed) return;
    if (this.#refreshing) {
      this.#again = true;
      return;
    }
    this.#refreshing = true;
    try {
      do {
        this.#again = false;
        this.#refreshOnce();
      } while (this.#again && !this.#disposed);
    } finally {
      this.#refreshing = false;
    }
  }

  #refreshOnce(): void {
    const ctx = this.#ctx;
    const { enabled } = this.#input;
    const running = ctx?.state === "running";
    this.#handoff?.setEligible(!this.#cannot && enabled && running);
    const active = !this.#cannot && enabled && running && (this.#handoff?.owns ?? false);
    const playing = this.#input.playing;
    if (active !== this.#active) {
      this.#active = active;
      this.#effects?.setActive(active);
      if (!active) this.#voices?.stopAll(SHORT_FADE_MS);
    }
    const hear = somethingToHear(playing ?? null, this.#input.sounds, this.#serverNow());
    if (active && hear) this.#clock.start();
    else this.#clock.stop();
    if (active && playing !== undefined) this.#voices?.update(planVoices(playing, this.#input.sounds, this.#serverNow()), (plan) => leaveMs(this.#input.playing, plan.channel));
    this.#mix();
    this.#media.set(active && hear);
    this.#setAudioSession(active && hear);
    this.#report();
  }

  #playEffect(ctx: AudioContext, what: { buffer: unknown } | { builtin: BuiltinSound }, at: number, offsetMs: number, level: number, id: string): EffectVoice {
    const g = this.#gains!;
    const ctxAt = Math.max(ctx.currentTime, ctx.currentTime + (at - this.#serverNow() - this.#latencyMs()) / 1000);
    const gain = ctx.createGain();
    gain.gain.value = 10 ** (level / 200);
    gain.connect(g.effects);
    let ended: (() => void) | null = null;
    let source: AudioBufferSourceNode | null = null;
    if ("buffer" in what) {
      source = ctx.createBufferSource();
      source.buffer = what.buffer as AudioBuffer;
      source.connect(gain);
      source.start(ctxAt, offsetMs / 1000);
    } else {
      source = playShape(ctx, TRAP_SOUND_SHAPES[what.builtin], ctxAt, gain, offsetMs / 1000);
    }
    this.#started.push({ id, at, offsetMs });
    if (this.#started.length > 32) this.#started.shift();
    const done = () => {
      gain.disconnect();
      ended?.();
    };
    if (source) source.onended = done;
    else queueMicrotask(done);
    return {
      stop: () => {
        try {
          source?.stop();
        } catch {
          // Already stopped.
        }
      },
      onEnded: (fn) => {
        ended = fn;
      },
    };
  }

  // ---------------------------------------------------------------- once a second

  #tick(): void {
    if (this.#disposed) return;
    const perf = performance.now();
    const ctx = this.#ctx;
    if (ctx && this.#active && this.#lastCheck.perf > 0) {
      const audio = (ctx.currentTime - this.#lastCheck.ctx) * 1000;
      // The audio clock stood still while the page's ran: an interruption the context may not have told of yet (4.4). The
      // page gives the sound up, but the pool is unlocked still: the context says running, and a real interruption's own
      // statechange rearms it (watchAudio).
      if (ctx.state === "running" && perf - this.#lastCheck.perf - audio > CLOCK_STALL_MS) this.#handoff?.contextLeft();
    }
    this.#lastCheck = { perf, ctx: ctx?.currentTime ?? 0 };
    // The plan moves with time (a loop's next pass, the next track's start), so it is read again before the check.
    this.#refresh();
    if (this.#active) this.#voices?.check();
    this.#timer = setTimeout(() => this.#tick(), CHECK_MS);
  }

  /** A wake: what the clock measured may no longer hold. A voice still playing plays on, and the check puts back one the wake stopped. */
  #woke(): void {
    this.#clock.restart();
    this.#voices?.check();
    this.#refresh();
  }

  #setAudioSession(playing: boolean): void {
    const session = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
    if (!session) return;
    const type = playing ? "playback" : "auto";
    try {
      if (session.type !== type) session.type = type;
    } catch {
      // A type this browser refuses: the default stands.
    }
  }

  #report(): void {
    // A voice's late look at its music can come after the engine went: it says nothing then.
    if (this.#disposed) return;
    const handoff = this.#handoff;
    const ctx = this.#ctx;
    let here: SoundHere;
    if (this.#cannot) here = "cannot";
    else if (!this.#input.enabled) here = "off";
    else if (ctx?.state !== "running") here = "tap";
    else if (handoff?.owns) here = "plays";
    else if (handoff?.otherPlays) here = "other";
    else here = "plays";
    const music: MusicHere = this.#active ? this.#music : "none";
    setSoundHere({ here, music });
    const counts = this.#active ? (this.#voices?.counts ?? { music: false, loops: 0 }) : { music: false, loops: 0 };
    const words = [here === "plays" ? "playing" : here];
    if (counts.music) words.push(music === "playing" ? "music" : `music:${music}`);
    if (counts.loops > 0) words.push(`loops:${counts.loops}`);
    const text = words.join(" ");
    const root = document.documentElement;
    if (root.dataset.sound !== text) root.dataset.sound = text;
  }

  #testView(): SoundTestView {
    return {
      voices: this.#voices?.snapshot() ?? [],
      effects: this.#effects?.voices ?? 0,
      started: [...this.#started],
      owns: this.#handoff?.owns ?? false,
      offset: this.#clock.offset() ?? null,
      lease: this.#gains?.lease.gain.value ?? 0,
      context: this.#ctx?.state ?? "none",
    };
  }
}

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The effect lists this viewer holds: a DM's take both, since an effect fired behind a blackout stays the DM's (4.6). */
function effectList(playing: Playing | null): FiredEffect[] | null {
  if (!playing) return null;
  return playing.dmEffects ? [...playing.effects, ...playing.dmEffects] : playing.effects;
}

/** The projection's effects, as the player needs them. Sounds no longer Effects are left out, so their entries are skipped. */
function effectSounds(sounds: Readonly<Record<SoundId, Sound>>): Record<SoundId, EffectSound> {
  const out: Record<SoundId, EffectSound> = {};
  for (const [id, s] of Object.entries(sounds)) if (s.use === "effect") out[id] = { assetId: s.assetId, ms: s.ms, ...(s.level !== undefined ? { level: s.level } : {}) };
  return out;
}
