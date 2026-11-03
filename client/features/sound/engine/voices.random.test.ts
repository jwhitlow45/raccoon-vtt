import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { FADES, loopCrossingMs, type Playing, type Sound } from "#shared/sound.ts";
import { int, pick, rng } from "#shared/testutil.ts";
import { LOOKAHEAD_MS, planVoices, type VoicePlan } from "./voices.ts";

/*
 * The passes a page plans for a sound that repeats (docs/design/design-v1-music.md
 * 5.2 and 5.3): a background sound of any length a loop may have, down to
 * the shortest, and music under Repeat one, read at random successive
 * engine ticks the way the engine reads its plan.
 *
 * Invariants:
 * - A pass once planned stays planned at every later tick until it ends,
 *   so Voices never cancels a pass loaded ahead and starts it late.
 * - While one pass sounds, the next is planned once it starts within the
 *   lookahead, so it is loaded ahead, and never sooner.
 * - Two passes of one sound at most, its two elements.
 */

const AT = 1_000_000;
const quiet: Playing = { rev: 1, music: null, loops: {}, effects: [], volume: { music: 100, effects: 100 } };

type Repeating = { playing: Playing; sounds: Record<string, Pick<Sound, "ms" | "use" | "assetId">>; lengthMs: number; crossingMs: number };

function loop(lengthMs: number): Repeating {
  return {
    playing: { ...quiet, loops: { a: { soundId: "s", at: AT, volume: 70 } } },
    sounds: { s: { ms: lengthMs, use: "loop", assetId: "a-s" } },
    lengthMs,
    crossingMs: loopCrossingMs(lengthMs),
  };
}

function repeatOne(lengthMs: number, fade: (typeof FADES)[number]): Repeating {
  return {
    playing: { ...quiet, music: { run: "r", repeat: "one", fade, now: { soundId: "s", at: AT } } },
    sounds: { s: { ms: lengthMs, use: "music", assetId: "a-s" } },
    lengthMs,
    crossingMs: Math.min(fade * 1_000, Math.floor(lengthMs / 2)),
  };
}

/** Each tick's failures, empty when every invariant holds. */
function walk(sound: Repeating, ticks: readonly number[]): string[] {
  const failures: string[] = [];
  const period = sound.lengthMs - sound.crossingMs;
  let held = new Map<string, VoicePlan>();
  for (const t of ticks) {
    const plan = planVoices(sound.playing, sound.sounds, t);
    const keys = new Set(plan.map((v) => v.key));
    for (const [key, v] of held) if (!keys.has(key) && t < v.startAt + v.lengthMs) failures.push(`${t - AT}: the pass at ${v.startAt - AT} left before its end`);
    if (plan.length > 2) failures.push(`${t - AT}: ${plan.length} passes`);
    for (const v of plan) if (v.startAt - t > LOOKAHEAD_MS) failures.push(`${t - AT}: the pass at ${v.startAt - AT} planned before the lookahead`);
    const sounding = plan.filter((v) => v.startAt <= t);
    const newest = sounding.reduce<VoicePlan | null>((a, v) => (a === null || v.startAt > a.startAt ? v : a), null);
    if (sounding.length === 1 && newest) {
      const nextAt = newest.startAt + period;
      if (nextAt - t <= LOOKAHEAD_MS && !plan.some((v) => v.startAt === nextAt)) failures.push(`${t - AT}: the pass at ${nextAt - AT} is not loaded ahead`);
    }
    held = new Map(plan.map((v) => [v.key, v]));
  }
  return failures;
}

/** Ticks from before the first pass, at random gaps up to `maxGap`, as the engine's checks and state changes read the plan. */
function ticks(r: () => number, count: number, maxGap: number): number[] {
  const out: number[] = [];
  let t = AT - int(r, 0, 5_000);
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += int(r, 1, maxGap);
  }
  return out;
}

describe("the passes planned for a sound that repeats", () => {
  test("a 2,016 ms loop keeps its next pass from 0 ms to its start at 1,512 ms", () => {
    const sound = loop(2_016);
    assert.deepEqual(walk(sound, [AT, AT + 1_000, AT + 1_512, AT + 2_016, AT + 3_000]), []);
    assert.deepEqual(planVoices(sound.playing, sound.sounds, AT + 1_000).map((v) => v.startAt - AT), [0, 1_512]);
  });

  test("random loop lengths from the shortest allowed, and Repeat one, at random successive ticks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const r = rng(seed);
        const shortest = SOUND_LIMITS.use.loop.minMs;
        const sound =
          r() < 0.75
            ? loop(r() < 0.3 ? shortest + int(r, 0, 50) : int(r, shortest, 40_000))
            : repeatOne(int(r, SOUND_LIMITS.use.music.minMs, 120_000), pick(r, FADES));
        const failures = walk(sound, ticks(r, 120, pick(r, [300, 1_000, 1_500, 4_000])));
        assert.deepEqual(failures, [], `seed ${seed}, ${sound.lengthMs} ms`);
      }),
      { numRuns: 2_000 },
    );
  });
});
