import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { loopCrossingMs, occurrencesAt } from "./sound.ts";

/**
 * The one timeline every sound reads (docs/design/design-v1-music.md 5.2,
 * section 12): random placements, lengths, crossings and moments. Nothing
 * before `at`, k never negative, at most two occurrences, positions in
 * [0, L), each occurrence's start plus its position the moment asked, and
 * continuous: a millisecond later every occurrence still sounding is a
 * millisecond further on, so a device never seeks back.
 */
const at = fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 });
const length = fc.oneof(fc.integer({ min: 200, max: 30_000 }), fc.integer({ min: 2_000, max: 15 * 60_000 + 100 }));
const crossing = fc.oneof(fc.constant(null), fc.constantFrom(0, 2_000, 5_000, 10_000), fc.integer({ min: 0, max: 20_000 }));

test("occurrencesAt: nothing before at, at most two, positions in range, continuous", () => {
  fc.assert(
    fc.property(at, length, crossing, fc.integer({ min: -60_000, max: 4 * 60 * 60_000 }), (placed, ms, cross, offset) => {
      const t = placed + offset;
      const now = occurrencesAt(placed, ms, cross, t);
      if (t < placed) assert.deepEqual(now, []);
      assert.ok(now.length <= 2);
      for (const o of now) {
        assert.ok(o.k >= 0, "k is never negative");
        assert.ok(o.positionMs >= 0 && o.positionMs < ms, "a position lies in the file");
        assert.equal(o.startAt + o.positionMs, t);
        assert.ok(o.startAt >= placed, "no occurrence starts before the sound's own 0");
      }
      if (now.length === 2) {
        assert.equal(now[1]!.k, now[0]!.k + 1, "two at once are neighbors, the older first");
        assert.ok(now[1]!.k > 0);
      }
      if (cross === null) assert.ok(now.every((o) => o.k === 0), "a sound that plays once has one occurrence");
      const later = occurrencesAt(placed, ms, cross, t + 1);
      for (const o of later) {
        const before = now.find((p) => p.k === o.k);
        if (before) assert.equal(o.positionMs, before.positionMs + 1, "a millisecond on, never a seek back");
        else assert.equal(o.positionMs, 0, "an occurrence the moment before lacked has just begun");
      }
    }),
    { numRuns: 4_000 },
  );
});

test("occurrencesAt: just before, at and after the first start", () => {
  fc.assert(
    fc.property(at, length, crossing, (placed, ms, cross) => {
      assert.deepEqual(occurrencesAt(placed, ms, cross, placed - 1), []);
      assert.deepEqual(occurrencesAt(placed, ms, cross, placed), [{ k: 0, startAt: placed, positionMs: 0 }]);
      assert.deepEqual(occurrencesAt(placed, ms, cross, placed + 1), [{ k: 0, startAt: placed, positionMs: 1 }]);
    }),
    { numRuns: 1_000 },
  );
});

test("a 10 s loop: 0.4 s before, at its start, 1 s after, and a late join at 9 s (section 11)", () => {
  const ms = 10_000;
  const cross = loopCrossingMs(ms);
  assert.equal(cross, 2_000);
  assert.deepEqual(occurrencesAt(1_000_000, ms, cross, 1_000_000 - 400), []);
  assert.deepEqual(occurrencesAt(1_000_000, ms, cross, 1_000_000), [{ k: 0, startAt: 1_000_000, positionMs: 0 }]);
  assert.deepEqual(occurrencesAt(1_000_000, ms, cross, 1_001_000), [{ k: 0, startAt: 1_000_000, positionMs: 1_000 }]);
  assert.deepEqual(occurrencesAt(1_000_000, ms, cross, 1_009_000), [
    { k: 0, startAt: 1_000_000, positionMs: 9_000 },
    { k: 1, startAt: 1_008_000, positionMs: 1_000 },
  ]);
});

test("a loop's crossing is 2 s, or a quarter of a loop under 8 s, and a sound that plays once ends at its length", () => {
  assert.equal(loopCrossingMs(8_000), 2_000);
  assert.equal(loopCrossingMs(7_999), 1_999);
  assert.equal(loopCrossingMs(2_000), 500);
  assert.deepEqual(occurrencesAt(0, 30_000, null, 29_999), [{ k: 0, startAt: 0, positionMs: 29_999 }]);
  assert.deepEqual(occurrencesAt(0, 30_000, null, 30_000), []);
  // Repeat one with no crossfade repeats end to end.
  assert.deepEqual(occurrencesAt(0, 30_000, 0, 30_000), [{ k: 1, startAt: 30_000, positionMs: 0 }]);
});
