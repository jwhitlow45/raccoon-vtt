import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { copiedFile, copyable } from "./copy.ts";
import { concat, id3v1, id3v2, mp3AtKbps, mp3Of, toneSamples } from "./sounds.testutil.ts";

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
});
