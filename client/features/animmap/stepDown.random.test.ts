import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { pick, rng } from "#shared/testutil.ts";
import { CAP_DRAWS, CAP_MS, DrawGate, MIN_GAP_MS } from "./pacing.ts";
import { StepDown, WARMUP_MS, WINDOW_MS } from "./stepDown.ts";
import { Compositor, HEALTHY, mostInWindow, renderTimes, type Content, type Display, type Struggle } from "./videoSim.testutil.ts";

/*
 * The draw gate and the step-down (docs/design/design-v1-animated-maps.md
 * 5.2, 5.4 and 12) over a compositor that plays real frame rates on real
 * refresh rates. The clocks are named apart (AMT-2): with frame callbacks
 * the spacing invariant is in media time, in the fallback in wall time.
 *
 * Invariants:
 * - Spacing: no two video draws less than MIN_GAP_MS apart, in the path's
 *   own clock, outside a loop's wrap.
 * - At most 32 video draws in any second of wall time.
 * - A healthy run never steps down, at any rate or refresh rate, variable
 *   rate and a 30 Hz render cap included. A struggling one does, one way.
 */

const RATES: readonly Content[] = [
  [{ fps: 24, ms: 4000 }],
  [{ fps: 25, ms: 4000 }],
  [{ fps: 29.97, ms: 4000 }],
  [{ fps: 30, ms: 2000 }],
  [{ fps: 31, ms: 3000 }],
  [{ fps: 50, ms: 4000 }],
  [{ fps: 59.94, ms: 4000 }],
  [{ fps: 60, ms: 2000 }],
  // A DefaultDuration of 33,333,333 ns.
  [{ fps: 1e9 / 33_333_333, ms: 4000 }],
  // A variable-rate file: a fast stretch then a slow one.
  [
    { fps: 60, ms: 12_000 },
    { fps: 10, ms: 18_000 },
  ],
];
const DISPLAYS: readonly Display[] = [{ hz: 59.95 }, { hz: 60 }, { hz: 60.05 }, { hz: 90 }, { hz: 120 }, { hz: 144 }, { hz: 60, capped: true }, { hz: 120, capped: true }];

type Run = { draws: number[]; drawnMedia: number[]; wraps: Set<number>; steppedAt: number | null; result: string | null; mediaOnlyMisses: number; framesSeen: number; shownMedia: number[] };

/** Plays `content` on `display` for `ms`, through the gate and the step-down as the board does on each frame callback. */
function play(content: Content, display: Display, ms: number, seed: number, struggle: Struggle = HEALTHY, pauses = false): Run {
  const r = rng(seed);
  const video = new Compositor(content, display, r, struggle);
  const gate = new DrawGate();
  const step = new StepDown(0);
  const run: Run = { draws: [], drawnMedia: [], wraps: new Set(), steppedAt: null, result: null, mediaOnlyMisses: 0, framesSeen: 0, shownMedia: [] };
  let lastMedia: number | null = null;
  let pausedUntil = -1;
  for (const now of renderTimes(display, 0, ms)) {
    if (now < pausedUntil) continue;
    if (pauses && r() < 0.0005) {
      // A pause: the window is dropped, and play resumes where it stood.
      const played = video.playedAt(now);
      pausedUntil = now + 200 + r() * 3000;
      video.resumeAt(pausedUntil, played);
      step.restart(pausedUntil);
      continue;
    }
    const cb = video.render(now);
    if (!cb) continue;
    run.framesSeen++;
    if (cb.wrapped) {
      step.wrap(now);
      run.wraps.add(run.draws.length);
      lastMedia = null;
    }
    step.sample({ now, presentedFrames: cb.presentedFrames, totalFrames: cb.totalFrames, droppedFrames: cb.droppedFrames });
    if (step.result && run.steppedAt === null) {
      run.steppedAt = now;
      run.result = step.result;
    }
    // The media-time gate alone, to show the cap never refuses what it admits on a healthy run.
    const mediaAdmits = lastMedia === null || cb.mediaMs - lastMedia >= MIN_GAP_MS;
    const admitted = gate.frame(cb.mediaMs, now);
    if (mediaAdmits && !admitted) run.mediaOnlyMisses++;
    if (admitted) {
      gate.drew(now, cb.mediaMs);
      run.draws.push(now);
      run.drawnMedia.push(cb.mediaMs);
      lastMedia = cb.mediaMs;
    }
    run.shownMedia.push(cb.mediaMs);
  }
  return run;
}

function spacingHolds(run: Run): void {
  for (let i = 1; i < run.drawnMedia.length; i++) {
    if (run.wraps.has(i)) continue;
    const gap = run.drawnMedia[i]! - run.drawnMedia[i - 1]!;
    assert.ok(gap >= MIN_GAP_MS - 1e-9, `media gap ${gap.toFixed(2)} ms at draw ${i}`);
  }
  assert.ok(mostInWindow(run.draws) <= 32, `${mostInWindow(run.draws)} draws in a second`);
}

describe("the draw gate on frame callbacks", () => {
  test("24, 25, 30 and 31 fps draw every frame, 50 to 60 fps every second frame, on any display", () => {
    for (const display of [{ hz: 60 }, { hz: 120 }, { hz: 144 }]) {
      for (const fps of [24, 25, 30, 31]) {
        const run = play([{ fps, ms: 4000 }], display, 8000, 1);
        assert.equal(run.draws.length, run.framesSeen, `${fps} fps at ${display.hz} Hz draws every frame`);
      }
      for (const fps of [50, 60]) {
        const run = play([{ fps, ms: 4000 }], display, 8000, 1);
        const share = run.draws.length / run.framesSeen;
        assert.ok(share > 0.45 && share <= 0.55, `${fps} fps at ${display.hz} Hz draws half its frames: ${share.toFixed(3)}`);
      }
    }
  });

  test("a variable-rate file draws its slow stretch whole and its fast one at 30", () => {
    const run = play(RATES[RATES.length - 1]!, { hz: 60 }, 30_000, 2);
    const fast = run.draws.filter((t) => t >= 1000 && t < 11_000).length / 10;
    const slow = run.draws.filter((t) => t >= 13_000 && t < 29_000).length / 16;
    assert.ok(fast >= 29 && fast <= 31, `fast stretch ${fast} a second`);
    assert.ok(slow >= 9.5 && slow <= 10.5, `slow stretch ${slow} a second`);
  });

  test("30, 29.97 and 60 fps on 59.95, 60.00 and 60.05 Hz: the cap never skips a frame the media-time gate admits", () => {
    for (const hz of [59.95, 60, 60.05])
      for (const fps of [30, 29.97, 60]) {
        const run = play([{ fps, ms: 4000 }], { hz }, 60_000, 3);
        assert.equal(run.mediaOnlyMisses, 0, `${fps} fps at ${hz} Hz`);
        spacingHolds(run);
      }
  });

  test("random rates, refresh rates, render caps and pauses keep the spacing and the count", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const r = rng(seed);
        spacingHolds(play(pick(r, RATES), pick(r, DISPLAYS), 12_000, seed, HEALTHY, true));
      }),
      { numRuns: 300 },
    );
  });

  test("the wall-clock cap holds a burst to 30 draws in 950 ms whatever the media times say", () => {
    const gate = new DrawGate();
    const draws: number[] = [];
    // Frames that each claim to be a second apart in media time, delivered 5 ms apart.
    for (let i = 0; i < 400; i++) {
      const now = i * 5;
      if (gate.frame(i * 1000, now)) {
        gate.drew(now, i * 1000);
        draws.push(now);
      }
    }
    for (let i = CAP_DRAWS; i < draws.length; i++) assert.ok(draws[i]! - draws[i - CAP_DRAWS]! >= CAP_MS);
  });
});

describe("the draw gate in the requestAnimationFrame fallback", () => {
  test("at 60, 120 and 144 Hz: no gap over 50 ms while playing, and at most 32 draws in any second", () => {
    for (const hz of [60, 120, 144, 59.95, 60.05, 90]) {
      const gate = new DrawGate();
      const draws: number[] = [];
      for (const now of renderTimes({ hz }, 0, 10_000)) {
        if (gate.tick(now)) {
          gate.drew(now, null);
          draws.push(now);
        }
      }
      for (let i = 1; i < draws.length; i++) {
        const gap = draws[i]! - draws[i - 1]!;
        assert.ok(gap >= MIN_GAP_MS && gap <= 50, `${hz} Hz gap ${gap.toFixed(2)}`);
      }
      assert.ok(mostInWindow(draws) <= 32, `${hz} Hz: ${mostInWindow(draws)} in a second`);
    }
  });
});

describe("the step-down", () => {
  test("a healthy run never steps down, at any rate or refresh rate, variable rate, Energy Saver and pauses included", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const r = rng(seed);
        const content = pick(r, RATES);
        const display = pick(r, DISPLAYS);
        const run = play(content, display, 45_000, seed, HEALTHY, true);
        assert.equal(run.result, null, `${JSON.stringify(content)} at ${JSON.stringify(display)}`);
      }),
      { numRuns: 120 },
    );
  });

  test("60 fps under a 30 Hz render cap is not late and never steps down", () => {
    for (const hz of [60, 120, 144]) assert.equal(play([{ fps: 60, ms: 2000 }], { hz, capped: true }, 60_000, 4).result, null, `${hz} Hz`);
  });

  test("a quarter of frames dropped for a window steps down, and stays down", () => {
    const run = play([{ fps: 30, ms: 2000 }], { hz: 60 }, 40_000, 5, { dropShare: 0.4, blockChance: 0 });
    assert.equal(run.result, "slowing");
    assert.ok(run.steppedAt! <= WARMUP_MS + 2 * WINDOW_MS + 100, `stepped down at ${run.steppedAt}`);
  });

  test("a struggling device under the render cap still steps down, with the line that says the browser may be saving power", () => {
    const run = play([{ fps: 60, ms: 2000 }], { hz: 60, capped: true }, 40_000, 6, { dropShare: 0.45, blockChance: 0 });
    assert.equal(run.result, "slowingOrSaving");
  });

  test("callbacks that miss shown frames step down", () => {
    const run = play([{ fps: 30, ms: 4000 }], { hz: 60 }, 40_000, 7, { dropShare: 0, blockChance: 0.4 });
    assert.equal(run.result, "slowing");
  });

  test("random struggles step down only one way: once down, every later sample leaves it down", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.double({ min: 0.3, max: 0.9, noNaN: true }), (seed, drop) => {
        const step = new StepDown(0);
        const video = new Compositor([{ fps: 30, ms: 2000 }], { hz: 60 }, rng(seed), { dropShare: drop, blockChance: 0 });
        let down: string | null = null;
        for (const now of renderTimes({ hz: 60 }, 0, 40_000)) {
          const cb = video.render(now);
          if (!cb) continue;
          if (cb.wrapped) step.wrap(now);
          step.sample({ now, presentedFrames: cb.presentedFrames, totalFrames: cb.totalFrames, droppedFrames: cb.droppedFrames });
          if (down) assert.equal(step.result, down);
          down = step.result;
          if (now > 20_000 && now < 20_020) step.restart(now);
        }
        assert.notEqual(down, null);
      }),
      { numRuns: 60 },
    );
  });

  test("a window holding a restart is dropped, and the warm-up comes first", () => {
    const step = new StepDown(0);
    // Every frame dropped during the warm-up, then a restart before a window can close.
    for (let t = 0; t < 1900; t += 33) step.sample({ now: t, presentedFrames: t, totalFrames: t * 2, droppedFrames: t });
    assert.equal(step.judged, 0);
    for (let t = 2000; t < 11_000; t += 33) step.sample({ now: t, presentedFrames: t, totalFrames: t * 2, droppedFrames: t });
    step.restart(11_000);
    for (let t = 11_000; t < 12_500; t += 33) step.sample({ now: t, presentedFrames: t, totalFrames: t * 2, droppedFrames: t });
    assert.equal(step.result, null);
    assert.equal(step.judged, 0);
  });
});
