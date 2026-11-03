import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { kWeighting, levelOf, LoudnessMeter } from "./loudness.ts";
import { toneSamples } from "./sounds.testutil.ts";

function measure(channels: Float32Array[], rateHz: number, pieceSamples = 4410): { lufs: number; peak: number } {
  const meter = new LoudnessMeter(rateHz, channels.length as 1 | 2);
  for (let at = 0; at < channels[0]!.length; at += pieceSamples) meter.push(channels.map((c) => c.subarray(at, at + pieceSamples)));
  return meter.result();
}

describe("BS.1770 loudness", () => {
  for (const rateHz of [44_100, 48_000]) {
    test(`a 1 kHz sine at -20 dBFS on both channels reads -20 LUFS at ${rateHz} Hz`, () => {
      const r = measure(toneSamples({ seconds: 5, rateHz, channels: 2, tone: { hz: 1000, dbfs: -20 } }), rateHz);
      assert.ok(Math.abs(r.lufs - -20) < 0.5, `${r.lufs}`);
      assert.ok(Math.abs(r.peak - 0.1) < 1e-3);
    });
  }

  test("the filters at 48 kHz are the standard's tabulated ones", () => {
    const [shelf, highPass] = kWeighting(48_000);
    assert.ok(Math.abs(shelf.b0 - 1.53512485958697) < 1e-9);
    assert.ok(Math.abs(shelf.a1 - -1.69065929318241) < 1e-9);
    assert.ok(Math.abs(highPass.a1 - -1.99004745483398) < 1e-9);
    assert.ok(Math.abs(highPass.a2 - 0.99007225036621) < 1e-9);
  });

  test("a mono file plays from both speakers, so it reads as the same tone on both", () => {
    const mono = measure(toneSamples({ seconds: 5, rateHz: 44_100, channels: 1, tone: { hz: 1000, dbfs: -20 } }), 44_100);
    assert.ok(Math.abs(mono.lufs - -20) < 0.5, `${mono.lufs}`);
  });

  test("the piece size changes nothing", () => {
    const tone = toneSamples({ seconds: 3, rateHz: 44_100, channels: 2, tone: { hz: 440, dbfs: -14 } });
    const a = measure(tone, 44_100, 777);
    const b = measure(tone, 44_100, 100_000);
    assert.ok(Math.abs(a.lufs - b.lufs) < 1e-9);
  });

  test("gating: silence around a tone does not lower its loudness, and silence alone reads -Infinity", () => {
    const rateHz = 44_100;
    const tone = toneSamples({ seconds: 4, rateHz, channels: 2, tone: { hz: 1000, dbfs: -20 } });
    const silence = toneSamples({ seconds: 20, rateHz, channels: 2, tone: null });
    const joined = [0, 1].map((c) => {
      const out = new Float32Array(silence[c]!.length + tone[c]!.length);
      out.set(tone[c]!, 0);
      out.set(silence[c]!, tone[c]!.length);
      return out;
    });
    assert.ok(Math.abs(measure(joined, rateHz).lufs - -20) < 0.5);
    assert.equal(measure(silence, rateHz).lufs, -Infinity);
    // A quiet stretch 30 dB down is under the relative gate and is left out too.
    const quiet = toneSamples({ seconds: 20, rateHz, channels: 2, tone: { hz: 1000, dbfs: -50 } });
    const withQuiet = [0, 1].map((c) => {
      const out = new Float32Array(quiet[c]!.length + tone[c]!.length);
      out.set(tone[c]!, 0);
      out.set(quiet[c]!, tone[c]!.length);
      return out;
    });
    assert.ok(Math.abs(measure(withQuiet, rateHz).lufs - -20) < 0.5);
  });

  test("a sound shorter than one gating block is measured as what it is", () => {
    const short = measure(toneSamples({ seconds: 0.2, rateHz: 44_100, channels: 2, tone: { hz: 1000, dbfs: -20 } }), 44_100);
    assert.ok(Math.abs(short.lufs - -20) < 1, `${short.lufs}`);
  });
});

describe("the level", () => {
  test("brings a sound to -18 LUFS in tenths of a dB, rounded down", () => {
    assert.equal(levelOf({ lufs: -20, peak: 0.1 }), 20);
    assert.equal(levelOf({ lufs: -18, peak: 0.5 }), 0);
    assert.equal(levelOf({ lufs: -10.04, peak: 0.9 }), -80);
    assert.equal(levelOf({ lufs: -18.06, peak: 0.1 }), 0);
  });

  test("stays within -24 and +12 dB", () => {
    assert.equal(levelOf({ lufs: -60, peak: 0.001 }), 120);
    assert.equal(levelOf({ lufs: 10, peak: 1 }), -240);
  });

  test("never lifts the peak past -1 dBFS", () => {
    // -30 LUFS asks for +12 dB, but a peak of -6 dBFS has 5 dB of room.
    const level = levelOf({ lufs: -30, peak: 10 ** (-6 / 20) });
    assert.equal(level, 50);
    const peakAfter = -6 + level / 10;
    assert.ok(peakAfter <= -1 + 1e-9);
  });

  test("a silent sound keeps 0, never -0", () => {
    assert.ok(Object.is(levelOf({ lufs: -Infinity, peak: 0 }), 0));
    assert.ok(Object.is(levelOf({ lufs: -18, peak: 0.3 }), 0));
  });
});
