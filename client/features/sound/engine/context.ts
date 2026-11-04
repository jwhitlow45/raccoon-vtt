import { armAudioUnlock, onActivation, type Activation, type UnlockableContext } from "../../../lib/activation.ts";

/**
 * The room sound's audio context and element pool (docs/design/design-v1-music.md
 * 5.3 and 5.5), in the main bundle rather than the lazy engine chunk: both
 * must be made or resumed inside the first gesture the browser counts as an
 * activation, which can come before the engine has loaded.
 *
 * The context is armed by lib/activation.ts's `armAudioUnlock`, which creates
 * or resumes it inside the gesture and listens again whenever it leaves
 * `running`. The element pool is armed by `onActivation(blessPool)`: while
 * this page wants no sound the attempt answers false and touches nothing,
 * since an element's play takes an iPhone's audio session from other apps.
 * Otherwise it plays a tenth of a second of silence on each pooled element,
 * synchronously inside the gesture, so the browser lets each play later by
 * itself, and answers true once every play resolved, so a refusal keeps it
 * listening. Both listen for the same events, so one gesture does both.
 *
 * A bless swaps an element's source for silence. So an unlocked pool is
 * never blessed again until `rearm` says the context was lost, as a
 * remounted SoundHost's new listener or a `pageshow` would otherwise do at
 * the next gesture, and a bless leaves the source of every element a sound
 * holds (`holdWith`) alone: one playing was let play already, and one
 * loaded ahead would start on silence. Voices' check puts back a voice
 * whose element lost its source anyway.
 */

/** 2 for music, 8 for loops crossing their loop points, 1 for Listen here. */
export const POOL_SIZE = 11;
export const LISTEN_ELEMENT = POOL_SIZE - 1;
/** A tenth of a second of silence, made by scripts/silence.ts. */
export const SILENCE_URL = "/sounds/silence.mp3";

/** The members of an audio element the pool uses, so a test can stand in. */
export interface PoolElement {
  src: string;
  muted: boolean;
  readonly paused: boolean;
  play(): Promise<void> | undefined;
  pause(): void;
}

export interface SoundUnlockDeps {
  /** The context, made on first use. */
  makeContext(): UnlockableContext | null;
  makeElement(): PoolElement;
  /** Where gestures arrive, the window by default. */
  target?: EventTarget;
}

export interface SoundUnlock {
  context(): UnlockableContext | null;
  /** The context if made already, without making one. */
  existing(): UnlockableContext | null;
  pool(): readonly PoolElement[];
  /** Whether every pooled element has played once inside a gesture. */
  blessed(): boolean;
  /**
   * Plays silence on every pooled element no sound holds, synchronously,
   * answering a promise of true once every play resolved or was cut short
   * by a new source. A held element that is not sounding plays and pauses
   * at once, on its own source. A blessed pool answers true and plays
   * nothing, and a call while one is in flight returns that one and plays
   * nothing again. Call it from a gesture.
   */
  blessPool(): Promise<boolean>;
  /** Names the elements a sound holds (a voice, Listen here), which a bless leaves alone. Returns the cleanup. */
  holdWith(holds: (el: PoolElement) => boolean): () => void;
  /** Arms both unlocks, `wanted` read at each gesture. Returns the cleanup. */
  arm(wanted: () => boolean): () => void;
  /** Listens again for the pool, as after the context or the audio session left `running` or `active`. */
  rearm(): void;
}

/**
 * A play() a new source or a pause cut short still ran inside the gesture,
 * which is what lets the element play later, so it counts as blessed. Only
 * a refusal, NotAllowedError, keeps the pool listening.
 */
function superseded(err: unknown): void {
  if ((err as { name?: unknown } | null)?.name !== "AbortError") throw err;
}

export function createSoundUnlock(deps: SoundUnlockDeps): SoundUnlock {
  let context: UnlockableContext | null = null;
  let elements: PoolElement[] | null = null;
  let blessing: Promise<boolean> | null = null;
  let isBlessed = false;
  let poolActivation: Activation | null = null;
  const holders = new Set<(el: PoolElement) => boolean>();
  const held = (el: PoolElement) => [...holders].some((holds) => holds(el));
  const makeContext = () => {
    context ??= deps.makeContext();
    return context;
  };
  const pool = () => {
    elements ??= Array.from({ length: POOL_SIZE }, () => deps.makeElement());
    return elements;
  };
  const blessPool = (): Promise<boolean> => {
    if (isBlessed) return Promise.resolve(true);
    if (blessing) return blessing;
    const plays: Promise<unknown>[] = [];
    // Each play starts here, inside the gesture: a later one would not count.
    const play = (el: PoolElement) => {
      try {
        plays.push(Promise.resolve(el.play()).catch(superseded));
      } catch (err) {
        plays.push(Promise.reject(err));
      }
    };
    for (const el of pool()) {
      if (held(el)) {
        // Its source stays. One not sounding (loaded ahead, or refused before) is let play all the same, its voice's own play coming later.
        if (el.paused) {
          play(el);
          el.pause();
        }
        continue;
      }
      el.muted = false;
      el.src = SILENCE_URL;
      play(el);
    }
    const done = Promise.all(plays).then(
      () => {
        isBlessed = true;
        return true;
      },
      () => false,
    );
    blessing = done;
    void done.then(() => {
      if (blessing === done) blessing = null;
    });
    return done;
  };
  return {
    context: makeContext,
    existing: () => context,
    pool,
    blessed: () => isBlessed,
    blessPool,
    holdWith(holds) {
      holders.add(holds);
      return () => {
        holders.delete(holds);
      };
    },
    arm(wanted) {
      const stopContext = armAudioUnlock({ context: makeContext, wanted, target: deps.target });
      poolActivation?.stop();
      const activation = onActivation(() => (wanted() ? blessPool() : false), deps.target);
      poolActivation = activation;
      return () => {
        stopContext();
        activation.stop();
        if (poolActivation === activation) poolActivation = null;
      };
    },
    rearm() {
      isBlessed = false;
      poolActivation?.rearm();
    },
  };
}

/** The members of Safari's audio session the engine reads (`navigator.audioSession`). */
export interface AudioSessionLike {
  type: string;
  readonly state?: string;
  addEventListener?(type: "statechange", fn: () => void): void;
  removeEventListener?(type: "statechange", fn: () => void): void;
}

/**
 * Calls `left` whenever the context leaves `running` or the audio session
 * is interrupted (a call, a lock, another app's audio), and `changed` on
 * every change of either, so the engine can give up the sound, listen
 * again for a gesture and seek back in place once it can play (5.5).
 * Returns the cleanup.
 */
export function watchAudio(ctx: UnlockableContext, session: AudioSessionLike | undefined, left: () => void, changed: () => void): () => void {
  const onContext = () => {
    if (ctx.state !== "running") left();
    changed();
  };
  const onSession = () => {
    // "inactive" is only the session at rest, before sound or after it: an interruption is what takes it away.
    if (session?.state === "interrupted") left();
    changed();
  };
  ctx.addEventListener?.("statechange", onContext);
  session?.addEventListener?.("statechange", onSession);
  return () => {
    ctx.removeEventListener?.("statechange", onContext);
    session?.removeEventListener?.("statechange", onSession);
  };
}

/** The browser's AudioContext, or null where it has none. */
function browserContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    // "playback" asks for the steadiest output where the browser knows the hint.
    return new Ctor({ latencyHint: "playback" });
  } catch {
    return null;
  }
}

/**
 * Readies a pooled element. The drift check plays it 1.5% or 3% off now and
 * then (drift.ts). With the pitch kept the browser time-stretches to do it,
 * and in Chrome every change of rate then steps the waveform, a click, and
 * the stretch warbles between: players heard it as a bad network. With the
 * pitch let go the element is resampled, so a nudge is 26 or 51 cents of
 * pitch for a second or two and no click (D-261102-870).
 */
export function poolElement<T extends { preload: string; preservesPitch: boolean }>(el: T): T {
  el.preload = "auto";
  el.preservesPitch = false;
  return el;
}

function browserElement(): PoolElement {
  return poolElement(new Audio() as HTMLAudioElement & { preservesPitch: boolean });
}

let shared: SoundUnlock | null = null;

/** The page's one unlock, context and pool. */
export function soundUnlock(): SoundUnlock {
  shared ??= createSoundUnlock({ makeContext: browserContext, makeElement: browserElement });
  return shared;
}

/** The page's audio context for room sound, made on first use. */
export function soundContext(): AudioContext | null {
  return soundUnlock().context() as AudioContext | null;
}

/**
 * Whether this browser has what the mixer needs (5.5): Web Audio and
 * `createMediaElementSource`. A TV browser without them shows the
 * display's can't-play line and plays nothing.
 */
export function mixerSupported(): boolean {
  if (typeof window === "undefined") return false;
  const Ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return typeof Ctor === "function" && typeof Ctor.prototype?.createMediaElementSource === "function" && typeof Audio === "function";
}
