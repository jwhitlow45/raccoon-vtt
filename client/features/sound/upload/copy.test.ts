import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withTagFrame } from "#shared/audio/mp3Testutil.ts";
import { bytesSource } from "./bytes.ts";
import { copiedFile, copyable } from "./copy.ts";
import { mpegFrameAt, planRead, probeFile } from "./guard.ts";
import { mp3Pieces } from "./pieces.ts";
import { concat, id3v1, id3v2, mp3AtKbps, mp3Of, toneSamples } from "./sounds.testutil.ts";

/** Every frame header of a stream changed by `change`, as an encoder writing CRCs or an emphasis flag would. */
function everyHeader(stream: Uint8Array, change: (bytes: Uint8Array, at: number) => void): Uint8Array {
  const out = stream.slice();
  for (let at = 0; at < out.length; ) {
    const frame = mpegFrameAt(out, at);
    if (!frame) break;
    change(out, at);
    at += frame.bytes;
  }
  return out;
}

const tone = (rateHz: number, channels: number, seconds = 2) => toneSamples({ seconds, rateHz, channels, tone: { hz: 440, dbfs: -12 } });

describe("which MP3s are copied as they are", () => {
  test("a tagged 128 kbps MP3: its tags stripped, its frames copied byte for byte", async () => {
    const frames = mp3Of(tone(44_100, 2), 44_100);
    const tagged = concat([id3v2("Rain by Someone", 4096), frames, id3v1("Rain")]);
    const check = copyable(tagged);
    assert.ok(check.ok, check.ok ? "" : check.why);
    assert.equal(check.stripped, 4096 + 128);
    assert.deepEqual(check.bytes, frames);
    assert.equal(check.facts.kbps, 128);
    const blob = copiedFile(check.bytes);
    assert.equal(blob.type, "audio/mpeg");
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), frames);
  });

  test("a 64 kbps mono MP3 at 48 kHz is copied", () => {
    const check = copyable(mp3Of(tone(48_000, 1), 48_000));
    assert.ok(check.ok);
    assert.deepEqual([check.facts.rateHz, check.facts.channels, check.facts.kbps], [48_000, 1, 64]);
  });

  test("320 kbps, 32 kHz and a bitrate that changes are converted instead", () => {
    assert.equal(copyable(mp3AtKbps(tone(44_100, 2), 44_100, 320)).ok, false);
    assert.equal(copyable(mp3AtKbps(tone(32_000, 2), 32_000, 128)).ok, false);
    // Two whole streams at two bitrates, back to back: a variable bitrate file every decoder plays.
    const vbr = concat([mp3AtKbps(tone(44_100, 2, 1), 44_100, 128), mp3AtKbps(tone(44_100, 2, 1), 44_100, 160)]);
    assert.equal(copyable(vbr).ok, false);
  });

  test("a leading Info and LAME frame goes with the tags, and the offsets count from the first audio frame", () => {
    const frames = mp3Of(tone(44_100, 2, 3), 44_100);
    const withInfo = withTagFrame(frames);
    assert.ok(withInfo.length > frames.length, "the tag frame is in front");
    const file = concat([id3v2("Rain", 2048), withInfo, id3v1("Rain")]);
    const check = copyable(file);
    assert.ok(check.ok, check.ok ? "" : check.why);
    assert.deepEqual(check.bytes, frames, "the copy is the audio frames alone");
    assert.equal(check.stripped, file.length - frames.length);
    assert.equal(check.facts.offsets[0], 0);
    // The pieces read.ts measures are cut from those same bytes.
    const pieces = mp3Pieces(check.facts, check.bytes.length);
    assert.equal(pieces[0]!.start, 0);
    assert.equal(pieces.at(-1)!.end, frames.length);
    // What is copied passes the walk again with nothing more to strip.
    const again = copyable(check.bytes);
    assert.ok(again.ok && again.stripped === 0);
  });

  test("CRC and emphasis frames go to the encoder, planned so before the file is read whole", async () => {
    const frames = mp3Of(tone(44_100, 2, 2), 44_100);
    const crc = everyHeader(frames, (b, at) => (b[at + 1]! &= 0xfe));
    const emphasis = everyHeader(frames, (b, at) => (b[at + 3]! |= 1));
    for (const [name, file] of [["CRC", crc], ["emphasis", emphasis]] as const) {
      assert.equal(copyable(file).ok, false, `${name}: the walk refuses it`);
      const probe = await probeFile(bytesSource(file));
      assert.equal(probe.copyCandidate, false, name);
      const plan = planRead({ probe, ms: probe.ms, fileBytes: file.length, use: "effect", budget: 800 * 1024 * 1024 });
      assert.deepEqual(plan.ok && plan.path, "whole", name);
    }
    const plain = await probeFile(bytesSource(frames));
    assert.equal(plain.copyCandidate, true);
  });
});
