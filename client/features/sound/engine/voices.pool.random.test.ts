import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import fc from "fast-check";
import { SHORT_FADE_MS, STOP_FADE_MS, type Playing } from "#shared/sound.ts";
import { int, pick, rng } from "#shared/testutil.ts";
import { leaveMs, planVoices, Voices, type MusicState } from "./voices.ts";

/*
 * The pool's elements under random sequences of what the engine and the
 * browser do (docs/design/design-v1-music.md 5.3 and 5.5): plans that
 * change, the engine's ticks, stops and starts as Room sound goes off and
 * on or another page takes the sound, a Skip during a crossfade that
 * leaves a track waiting for an element, plays the browser refuses until
 * a gesture, gestures, and an element the browser stops short. Timers and
 * the page's clock are mocked, so a run takes no real time.
 *
 * Invariants:
 * - A page that stopped plays and seeks nothing until it plays again, a
 *   start that waited for an element included.
 * - After a play the browser refused for want of a gesture, that voice's
 *   element is neither played nor sought again until the next gesture.
 * - While plays are refused and nothing else changes, the music line never
 *   goes from loading back to playing unless a music element sounds or a
 *   track starts that was not there when it said loading.
 * - A stopped page's elements are all paused once their fades are over,
 *   the longest a stop's 2 s for a voice that was leaving already.
 * - Every voice's element keeps its handlers, its error's and its start's,
 *   though the voice it took the element from is released after it.
 */

const T = 1_000_000;
const SOUNDS = {
  tavern: { ms: 60_000, use: "music" as const, assetId: "a-tavern" },
  road: { ms: 40_000, use: "music" as const, assetId: "a-road" },
  rain: { ms: 10_000, use: "loop" as const, assetId: "a-rain" },
};
const quiet: Playing = { rev: 1, music: null, loops: {}, effects: [], volume: { music: 100, effects: 100 } };

/** What plays, placed from `now`: a crossfade with 3 s left, a track just skipped to, a track and a loop, or nothing. */
const STATES: ((now: number) => Playing)[] = [
  (now) => ({ ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: now - 57_000 }, next: { soundId: "road", at: now - 2_000 } } }),
  (now) => ({ ...quiet, music: { run: "r2", repeat: "all", fade: 5, now: { soundId: "road", at: now } } }),
  (now) => ({ ...quiet, music: { run: "r3", repeat: "all", fade: 5, now: { soundId: "tavern", at: now - 10_000 } }, loops: { l1: { soundId: "rain", at: now - 3_000, volume: 80 } } }),
  () => quiet,
];

type World = { clock: number; active: boolean; allowed: boolean; gestures: number; failures: string[]; step: string };

/** The run under way, whose clock the mocked performance.now reads. */
let current: World | null = null;

function element(world: World, index: number) {
  let at = 0;
  let onplaying: (() => void) | null = null;
  const el = {
    src: "",
    muted: false,
    paused: true,
    loop: false,
    playbackRate: 1,
    readyState: 4,
    onerror: null as (() => void) | null,
    onwaiting: null as (() => void) | null,
    /** Each voice that takes the element sets its handler: a new one is a new voice. */
    epoch: 0,
    refused: null as { epoch: number; gestures: number } | null,
    get onplaying() {
      return onplaying;
    },
    set onplaying(fn: (() => void) | null) {
      if (fn) el.epoch++;
      onplaying = fn;
    },
    get currentTime() {
      return at;
    },
    set currentTime(value: number) {
      if (!world.active) world.failures.push(`${world.step}: element ${index} sought while the page is stopped`);
      if (waitsForGesture()) world.failures.push(`${world.step}: element ${index} sought after its refusal, before a gesture`);
      at = value;
    },
    play(): Promise<void> {
      if (!world.active) world.failures.push(`${world.step}: element ${index} played while the page is stopped`);
      if (waitsForGesture()) world.failures.push(`${world.step}: element ${index} played again after its refusal, before a gesture`);
      // A browser refuses a play only to an element not playing already.
      if (!world.allowed && el.paused) {
        el.refused = { epoch: el.epoch, gestures: world.gestures };
        return Promise.reject(new DOMException("needs a gesture", "NotAllowedError"));
      }
      el.paused = false;
      queueMicrotask(() => onplaying?.());
      return Promise.resolve();
    },
    pause() {
      el.paused = true;
    },
  };
  const waitsForGesture = () => el.refused !== null && el.refused.epoch === el.epoch && el.refused.gestures === world.gestures;
  return el;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** One run's failures, empty when every invariant holds. */
async function walk(seed: number): Promise<string[]> {
  const r = rng(seed);
  const world: World = { clock: 0, active: true, allowed: r() < 0.5, gestures: 0, failures: [], step: "start" };
  current = world;
  const now = () => T + world.clock;
  const node = () => ({ gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: (to: unknown) => to, disconnect() {} });
  const ctx = {
    get currentTime() {
      return world.clock / 1000;
    },
    createGain: node,
    createMediaElementSource: () => ({ connect: (to: unknown) => to, disconnect() {} }),
  } as unknown as AudioContext;
  const pool = Array.from({ length: 11 }, (_, i) => element(world, i));
  const musicSounds = () => pool.slice(0, 2).some((el) => !el.paused);
  const gestures = new EventTarget();
  // A stretch with plays refused and nothing else changing, in which loading may not turn back to playing with nothing sounding.
  let still = !world.allowed;
  let state: MusicState = "none";
  // The music voices when the line said loading: one that starts after, a track that waited for an element, may take its own 200 ms.
  let loadingKeys = new Set<string>();
  const onMusic = (next: MusicState) => {
    const keys = new Set(voices.snapshot().filter((v) => v.channel === "music").map((v) => v.key));
    const fresh = [...keys].some((k) => !loadingKeys.has(k));
    if (still && state === "loading" && next === "playing" && !musicSounds() && !fresh) world.failures.push(`${world.step}: loading went back to playing with nothing sounding`);
    if (next === "loading") loadingKeys = keys;
    state = next;
  };
  const voices = new Voices({ ctx, unlock: { pool: () => pool, holdWith: () => () => {} }, output: { music: node(), loop: node() } as unknown as Record<"music" | "loop", AudioNode>, serverNow: now, latencyMs: () => 0, url: (assetId) => `/api/assets/${assetId}`, gestures, onMusic });
  let playing = pick(r, STATES)(now());
  const update = () => voices.update(planVoices(playing, SOUNDS, now()), (plan) => leaveMs(playing, plan.channel));
  update();
  // A play's refusal is a promise's, answered before the next task: no check comes between.
  await flush();
  let stoppedAt: number | null = null;
  for (let i = 0; i < 40; i++) {
    const roll = r();
    if (roll < 0.15) {
      world.step = `${i} plays another state`;
      playing = pick(r, STATES)(now());
      still = false;
      if (world.active) update();
    } else if (roll < 0.5) {
      const ms = pick(r, [int(r, 1, 400), int(r, 200, 1_200)]);
      world.step = `${i} ${ms} ms pass`;
      world.clock += ms;
      mock.timers.tick(ms);
      await flush();
      // The engine's tick: the plan read again, then the check.
      if (world.active) {
        update();
        voices.check();
      }
    } else if (roll < 0.6) {
      world.step = `${i} stop`;
      world.active = false;
      stoppedAt = world.clock;
      voices.stopAll(SHORT_FADE_MS);
    } else if (roll < 0.7) {
      world.step = `${i} start`;
      world.active = true;
      stoppedAt = null;
      still = false;
      update();
    } else if (roll < 0.8) {
      world.step = `${i} gesture`;
      world.gestures++;
      still = false;
      gestures.dispatchEvent(new Event("click"));
    } else if (roll < 0.88) {
      world.allowed = !world.allowed;
      world.step = `${i} plays ${world.allowed ? "allowed" : "refused"}`;
      still = !world.allowed;
    } else if (roll < 0.95) {
      const el = pick(r, pool.filter((e) => !e.paused));
      world.step = `${i} the browser stops an element`;
      if (el) {
        el.paused = true;
        still = false;
      }
    } else {
      // A wake, as the page coming back into view does: the check, whether or not the page plays.
      world.step = `${i} wake`;
      voices.check();
    }
    await flush();
    const live = voices.snapshot();
    for (const sound of new Set(live.map((v) => v.sound))) {
      const handled = pool.filter((e) => e.onerror && e.onplaying && e.src === `/api/assets/a-${sound}`).length;
      if (handled < live.filter((v) => v.sound === sound).length) world.failures.push(`${world.step}: a ${sound} voice's element lost its handlers`);
    }
    if (!world.active && voices.snapshot().length > 0) world.failures.push(`${world.step}: a voice sounds on a stopped page`);
    if (stoppedAt !== null && world.clock - stoppedAt > STOP_FADE_MS + 100 && pool.some((el) => !el.paused)) world.failures.push(`${world.step}: an element plays after the stop's fade`);
  }
  voices.dispose();
  return world.failures;
}

describe("the pool's elements under random plans, stops, refusals and gestures", () => {
  test("every invariant holds over random runs", async () => {
    const now = mock.method(performance, "now", () => current?.clock ?? 0);
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
          // Each run's timers alone, none left from the run before.
          mock.timers.reset();
          mock.timers.enable({ apis: ["setTimeout"] });
          const failures = await walk(seed);
          assert.deepEqual(failures, [], `seed ${seed}`);
        }),
        { numRuns: 1000 },
      );
    } finally {
      now.mock.restore();
      mock.timers.reset();
    }
  });
});
