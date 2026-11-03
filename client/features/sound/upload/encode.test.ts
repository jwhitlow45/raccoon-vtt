import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Mp3Encoder } from "@breezystack/lamejs";
import { walkMp3 } from "#shared/audio/mp3.ts";
import { soundUseFits } from "#shared/limits.ts";
import { PieceSink, toInt16, type Mp3EncoderClass } from "./encode.ts";
import { concat as join, toneSamples, wavData, type WavSpec } from "./sounds.testutil.ts";

const Encoder = Mp3Encoder as unknown as Mp3EncoderClass;

/** One file through the worker's sink in 10-second pieces, as read.ts sends them. */
function encode(channels: Float32Array[], rateHz: number): { mp3: Uint8Array; lufs: number } {
  const sink = new PieceSink({ t: "start", rateHz, channels: channels.length, encode: true, wav: null }, Encoder);
  const piece = rateHz * 10;
  for (let at = 0; at < channels[0]!.length; at += piece) sink.pcm(channels.map((c) => c.subarray(at, at + piece)));
  const out = sink.end();
  return { mp3: join(out.mp3!), lufs: out.lufs };
}

describe("the encoder's output", () => {
  test("a stereo 44.1 kHz file becomes a 128 kbps stereo MP3 the server's walk takes, a little longer than its source", () => {
    const { mp3, lufs } = encode(toneSamples({ seconds: 3, rateHz: 44_100, channels: 2, tone: { hz: 1000, dbfs: -20 } }), 44_100);
    const walk = walkMp3(mp3);
    assert.ok(walk.ok, walk.ok ? "" : walk.why);
    assert.deepEqual([walk.facts.rateHz, walk.facts.kbps, walk.facts.channels], [44_100, 128, 2]);
    assert.ok(walk.facts.ms >= 3000 && walk.facts.ms <= 3100, `${walk.facts.ms}`);
    assert.ok(Math.abs(lufs - -20) < 0.5);
  });

  test("mono stays mono at 64 kbps, a 48 kHz file stays at 48 kHz", () => {
    const walk = walkMp3(encode(toneSamples({ seconds: 2, rateHz: 48_000, channels: 1, tone: { hz: 440, dbfs: -10 } }), 48_000).mp3);
    assert.ok(walk.ok);
    assert.deepEqual([walk.facts.rateHz, walk.facts.kbps, walk.facts.channels], [48_000, 64, 1]);
  });

  test("six channels are mixed to stereo before encoding", () => {
    const walk = walkMp3(encode(toneSamples({ seconds: 2, rateHz: 44_100, channels: 6, tone: { hz: 440, dbfs: -20 } }), 44_100).mp3);
    assert.ok(walk.ok);
    assert.equal(walk.facts.channels, 2);
  });

  test("an effect of exactly 30.000 s encodes within the 100 ms allowance, at both rates", () => {
    for (const rateHz of [44_100, 48_000]) {
      const walk = walkMp3(encode(toneSamples({ seconds: 30, rateHz, channels: 2, tone: { hz: 200, dbfs: -30 } }), rateHz).mp3);
      assert.ok(walk.ok);
      assert.ok(walk.facts.ms > 30_000, `${walk.facts.ms}`);
      assert.equal(soundUseFits("effect", walk.facts.ms), true, `${walk.facts.ms} at ${rateHz}`);
    }
  });

  test("a WAV's bytes through the sink read the same as its samples", () => {
    const spec: WavSpec = { channels: 2, rateHz: 44_100, bits: 16, sample: "int" };
    const tone = toneSamples({ seconds: 1, rateHz: 44_100, channels: 2, tone: { hz: 1000, dbfs: -20 } });
    const sink = new PieceSink({ t: "start", rateHz: 44_100, channels: 2, encode: false, wav: { sample: "int", bits: 16, channels: 2, blockAlign: 4 } }, null);
    const data = wavData(spec, tone);
    sink.wav(data.slice(0, data.length / 2).buffer);
    sink.wav(data.slice(data.length / 2).buffer);
    const out = sink.end();
    assert.equal(out.mp3, null);
    assert.ok(Math.abs(out.lufs - -20) < 0.5);
  });

  test("16-bit conversion clips past full scale rather than wrapping", () => {
    assert.deepEqual([...toInt16(Float32Array.from([1.5, -1.5, 0.5, 0]))], [32_767, -32_768, 16_384, 0]);
  });

  test("a piece with another channel count is refused", () => {
    const sink = new PieceSink({ t: "start", rateHz: 44_100, channels: 2, encode: false, wav: null }, null);
    assert.throws(() => sink.pcm([new Float32Array(4)]));
    assert.throws(() => new PieceSink({ t: "start", rateHz: 44_100, channels: 3, encode: false, wav: null }, null));
  });
});
