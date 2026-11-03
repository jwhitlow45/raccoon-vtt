import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { int, pick, rng } from "#shared/testutil.ts";
import { CHECK_MS, Drift, IN_STEP_MS, RATES, SEEK_GAP_MS, SEEK_PAST_MS, STALLED_MS } from "./drift.ts";

/*
 * The drift check (docs/design/design-v1-music.md 5.3 and 12): 2,000
 * sequences of ticks, clock offsets, output latencies, stalls, seeks,
 * hides, shows, interruptions and run changes, on a fake element that
 * moves at its rate while it plays, the way voices.ts drives the check.
 *
 * Invariants:
 * - Only the five rates.
 * - A seek only past 150 ms, or after a stall, a show, a resume or an
 *   interruption.
 * - Never two seeks within a second.
 * - From 150 ms with steady input, under 25 ms within 6 seconds, and it
 *   stays there.
 */

type Element = { pos: number; rate: number; playing: boolean };

describe("the drift check", () => {
  test("random sequences keep the rates, the seek rules and the gap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const r = rng(seed);
        let now = 0;
        // The aim: where the timeline says the element should be, which moves with the clock's offset and the output latency.
        let anchor = 0;
        let offset = 0;
        let latency = int(r, 0, 300);
        const aim = (t: number) => t - anchor + offset + latency;
        const el: Element = { pos: aim(0), rate: 1, playing: true };
        const drift = new Drift();
        drift.sought(0);
        let forced = false;
        let lastSeek = 0;
        let lastCheck = 0;
        const advance = (ms: number) => {
          if (el.playing) el.pos += ms * el.rate;
          now += ms;
        };
        const steps = int(r, 20, 120);
        for (let i = 0; i < steps; i++) {
          switch (pick(r, ["tick", "tick", "tick", "tick", "offset", "latency", "stall", "hide", "interrupt", "run", "late"] as const)) {
            case "tick":
              advance(CHECK_MS + int(r, -40, 40));
              break;
            case "late":
              // The page's main thread stood still: the check comes late, and the engine counts that as a stall.
              advance(int(r, STALLED_MS + 1, 9_000));
              break;
            case "offset":
              offset += int(r, -45, 45);
              advance(int(r, 0, 900));
              break;
            case "latency":
              latency = Math.max(0, latency + int(r, -150, 250));
              advance(int(r, 0, 900));
              break;
            case "stall": {
              // The element waits for data while the timeline goes on.
              el.playing = false;
              advance(int(r, 200, 3_000));
              el.playing = true;
              drift.force();
              forced = true;
              break;
            }
            case "hide":
              advance(int(r, 500, 20_000));
              drift.force();
              forced = true;
              break;
            case "interrupt":
              el.playing = false;
              advance(int(r, 100, 15_000));
              el.playing = true;
              drift.force();
              forced = true;
              break;
            case "run":
              // A new run or a reanchor: the voice is placed afresh, which counts as a seek.
              anchor = now - int(r, 0, 600_000);
              el.pos = aim(now);
              el.rate = 1;
              drift.sought(now);
              forced = false;
              lastSeek = now;
              break;
          }
          if (now - lastCheck > STALLED_MS) {
            drift.force();
            forced = true;
          }
          const error = el.pos - aim(now);
          const action = drift.check(now, el.pos, aim(now));
          lastCheck = now;
          if (action.kind === "seek") {
            assert.ok(Math.abs(error) > SEEK_PAST_MS || forced, `seed ${seed}: a seek at ${error.toFixed(1)} ms with nothing forcing it`);
            assert.ok(now - lastSeek >= SEEK_GAP_MS, `seed ${seed}: two seeks ${now - lastSeek} ms apart`);
            lastSeek = now;
            el.pos = aim(now);
            el.rate = 1;
            forced = false;
          } else {
            assert.ok((RATES as readonly number[]).includes(action.rate), `seed ${seed}: rate ${action.rate}`);
            el.rate = action.rate;
            if (Math.abs(error) <= IN_STEP_MS) forced = false;
          }
        }
      }),
      { numRuns: 2_000 },
    );
  });

  test("from up to 150 ms with steady input the error is under 25 ms within 6 seconds, and stays there", () => {
    fc.assert(
      fc.property(fc.double({ min: -SEEK_PAST_MS, max: SEEK_PAST_MS, noNaN: true }), fc.integer({ min: 0, max: 400 }), (start, latency) => {
        const drift = new Drift();
        drift.sought(-SEEK_GAP_MS);
        let now = 0;
        let pos = 10_000 + latency + start;
        let rate = 1;
        let worstAfter6 = 0;
        for (let check = 0; check <= 20; check++) {
          const aimAt = (t: number) => 10_000 + t + latency;
          const action = drift.check(now, pos, aimAt(now));
          assert.equal(action.kind, "rate", `no seek from ${start.toFixed(1)} ms`);
          if (action.kind === "rate") rate = action.rate;
          // Sample between checks too.
          for (let ms = 0; ms < CHECK_MS; ms += 100) {
            const t = now + ms;
            const err = Math.abs(pos + ms * rate - aimAt(t));
            if (t >= 6_000) worstAfter6 = Math.max(worstAfter6, err);
          }
          pos += CHECK_MS * rate;
          now += CHECK_MS;
        }
        assert.ok(worstAfter6 < IN_STEP_MS, `from ${start.toFixed(1)} ms: ${worstAfter6.toFixed(1)} ms after 6 s`);
      }),
      { numRuns: 2_000 },
    );
  });

  test("past 150 ms it seeks, and a forced check seeks only when out of step", () => {
    const drift = new Drift();
    assert.deepEqual(drift.check(5_000, 1_151, 1_000), { kind: "seek" });
    assert.deepEqual(drift.check(5_500, 1_151, 1_000), { kind: "rate", rate: 0.97 }, "not twice within a second");
    const quiet = new Drift();
    quiet.force();
    assert.deepEqual(quiet.check(0, 1_010, 1_000), { kind: "rate", rate: 1 });
    assert.deepEqual(quiet.check(1_000, 1_040, 1_000), { kind: "rate", rate: 0.985 }, "in step once, the force is spent");
    const shown = new Drift();
    shown.force();
    assert.deepEqual(shown.check(0, 1_040, 1_000), { kind: "seek" });
  });
});
