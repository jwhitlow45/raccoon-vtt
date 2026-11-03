import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { concat, id3v1, id3v2, mp3AtKbps, mp3Of, toneSamples, wavFile, wavHeader, type WavSpec } from "../../client/features/sound/upload/sounds.testutil.ts";

/**
 * The sound fixtures for e2e/soundupload.e2e.ts (docs/design/design-v1-sound.md
 * 12, this folder's README): tones and silence written from scratch, never
 * a recording, and MP3s from the same encoder the app ships. The small ones
 * are committed, so their bytes stay put:
 *
 *   node e2e/fixtures/sounds.ts
 *
 * The long ones, a 30-second effect, a 15-minute track and a 10-minute WAV
 * for the timing, would be hundreds of megabytes, so the e2e file writes
 * them to a temporary folder with the functions below each time it runs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STEREO_16: WavSpec = { channels: 2, rateHz: 44_100, bits: 16, sample: "int" };

/** A plain WAV of a tone: 16-bit stereo at 44.1 kHz unless told otherwise. */
export function toneWav(seconds: number, spec: WavSpec = STEREO_16, dbfs = -20): Uint8Array {
  return wavFile(spec, toneSamples({ seconds, rateHz: spec.rateHz, channels: spec.channels, tone: { hz: 1000, dbfs } }));
}

/** A WAV header and a little data claiming `channels` channels, for the refusal before decoding. */
export function wavOfChannels(channels: number): Uint8Array {
  const spec: WavSpec = { channels, rateHz: 44_100, bits: 16, sample: "int" };
  const frames = 4410;
  return concat([wavHeader(spec, frames), new Uint8Array(frames * channels * 2)]);
}

/** A constant bitrate MP3 at 48 kHz, mono at 64 kbps, long enough for several 60-second pieces. */
export function longMp3At48(seconds: number): Uint8Array {
  return mp3Of(toneSamples({ seconds, rateHz: 48_000, channels: 1, tone: { hz: 440, dbfs: -16 } }), 48_000);
}

/** The committed fixtures, by file name. */
export function committed(): Record<string, Uint8Array> {
  const second = toneSamples({ seconds: 1, rateHz: 44_100, channels: 2, tone: { hz: 440, dbfs: -14 } });
  const higher = toneSamples({ seconds: 1, rateHz: 44_100, channels: 2, tone: { hz: 660, dbfs: -14 } });
  const tags = (frames: Uint8Array) => concat([id3v2("Fixture tone by the tests", 4096), frames, id3v1("Fixture tone")]);
  return {
    // 1 s of a 1 kHz tone at -20 dBFS: plain 16-bit stereo, converted.
    "sound-tone.wav": toneWav(1),
    // 0.3 s of 5.1 at 48 kHz in 24 bits: mixed to stereo, then converted.
    "sound-surround.wav": toneWav(0.3, { channels: 6, rateHz: 48_000, bits: 24, sample: "int" }),
    // Two whole streams at 128 and 160 kbps back to back: a variable bitrate file, converted.
    "sound-vbr.mp3": concat([mp3AtKbps(second, 44_100, 128), mp3AtKbps(higher, 44_100, 160)]),
    // 2 s at 128 kbps between an ID3v2 and an ID3v1 tag: copied without its tags.
    "sound-tagged.mp3": tags(mp3Of(toneSamples({ seconds: 2, rateHz: 44_100, channels: 2, tone: { hz: 440, dbfs: -14 } }), 44_100)),
    // 1 s at 320 kbps with the same tags: past the bitrates kept, so converted.
    "sound-tagged-320.mp3": tags(mp3AtKbps(second, 44_100, 320)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, bytes] of Object.entries(committed())) {
    writeFileSync(path.join(HERE, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
}
