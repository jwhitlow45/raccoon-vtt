/**
 * What the e2e steps read of the engine (docs/design/design-v1-music.md 12):
 * with the test flag set before the page loads (Playwright's
 * addInitScript), as the iso hook's is (canvas/relief/isoTest.ts), the
 * page's root element gains `soundVoices`, `soundEffects` and `soundState`
 * getters, the last with the channels' gains (`mix`). Nothing a user can do sets it, and it reads only. The page's
 * `data-sound` ("playing music loops:2", set on change) needs no flag.
 */
export const SOUND_TEST_FLAG = "__rvttSoundTest";

export type SoundTestVoice = { key: string; sound: string; channel: "music" | "loop"; aimMs: number; currentMs: number; rate: number; playing: boolean };

export type SoundTestView = {
  voices: SoundTestVoice[];
  /** Effect voices sounding now. */
  effects: number;
  /** The effects started on this page, newest last: their entry, server time and how far in. */
  started: { id: string; at: number; offsetMs: number }[];
  owns: boolean;
  /** Server time less `performance.now()`, as the clock reads it. */
  offset: number | null;
  /** The lease gain's value now. */
  lease: number;
  context: string;
  /** The gains the channels ramp to: music, background and effects, each this device's levels times the room's. */
  mix: { music: number; loop: number; effects: number };
};

export function soundTestOn(): boolean {
  return (globalThis as Record<string, unknown>)[SOUND_TEST_FLAG] === true;
}

/** Exposes the engine's view while the flag is set. Returns the cleanup. */
export function exposeSoundTest(read: () => SoundTestView): () => void {
  if (!soundTestOn() || typeof document === "undefined") return () => {};
  const root = document.documentElement as HTMLElement & Record<string, unknown>;
  const props = {
    soundVoices: { configurable: true, get: () => read().voices },
    soundEffects: { configurable: true, get: () => ({ playing: read().effects, started: read().started }) },
    soundState: { configurable: true, get: () => { const v = read(); return { owns: v.owns, offset: v.offset, lease: v.lease, context: v.context, mix: v.mix, now: v.offset === null ? null : performance.now() + v.offset }; } },
  };
  Object.defineProperties(root, props);
  return () => {
    for (const name of Object.keys(props)) delete root[name];
  };
}
