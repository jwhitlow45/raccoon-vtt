import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { framesFor, silentFrames, withTagFrame } from "#shared/audio/mp3Testutil.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { bytesSource } from "./bytes.ts";
import { copyable } from "./copy.ts";
import { decodeBudget, lengthRefusal, planRead, probeFile, readEsds, wholeDecodeBytes, wholeDecodeFits, type Probe } from "./guard.ts";
import { prepareSound } from "./read.ts";
import { adtsFile, aiffHeader, concat, esdsBox, flacHeader, id3v1, id3v2, m4aFile, mp3AtKbps, mp3Of, oggFile, toneSamples, wavFile, wavHeader, webmFile } from "./sounds.testutil.ts";

const probe = (bytes: Uint8Array) => probeFile(bytesSource(bytes));
const MB = 1024 * 1024;
const PHONE = decodeBudget({ touch: true, finePointer: false });
const COMPUTER = decodeBudget({ touch: false, finePointer: true });
/** A length summed frame by frame, against one worked out whole. */
const near = (ms: number | null, want: number) => assert.ok(ms !== null && Math.abs(ms - want) < 1e-6, `${ms} for ${want}`);

describe("the guard reads each header's channels, rate and length", () => {
  test("WAV, plain and extensible, with an odd chunk before its data", async () => {
    const p = await probe(wavFile({ channels: 2, rateHz: 48_000, bits: 24, sample: "int", extraChunk: true }, toneSamples({ seconds: 0.5, rateHz: 48_000, channels: 2, tone: null })));
    assert.deepEqual([p.container, p.channels, p.rateHz, p.ms], ["wav", 2, 48_000, 500]);
    const ext = await probe(wavHeader({ channels: 6, rateHz: 44_100, bits: 16, sample: "int", extensible: true }, 0));
    assert.deepEqual([ext.channels, ext.rateHz], [6, 44_100]);
  });

  test("a RIFF file in a format it cannot place still has no channels, so it is refused unread", async () => {
    const adpcm = wavHeader({ channels: 2, rateHz: 44_100, bits: 16, sample: "int" }, 10);
    adpcm[20] = 0x11; // IMA ADPCM
    const p = await probe(adpcm);
    assert.equal(p.channels, null);
    assert.deepEqual(planRead({ probe: p, ms: 1000, fileBytes: 100, use: "effect", budget: COMPUTER }), { ok: false, why: { t: "channelsUnknown" } });
  });

  test("AIFF's COMM", async () => {
    const p = await probe(aiffHeader({ channels: 4, frames: 44_100 * 3, rateHz: 44_100 }));
    assert.deepEqual([p.container, p.channels, p.rateHz, Math.round(p.ms!)], ["aiff", 4, 44_100, 3000]);
  });

  test("FLAC's STREAMINFO, behind an ID3v2 tag too", async () => {
    const p = await probe(concat([id3v2("x"), flacHeader({ channels: 6, rateHz: 96_000, totalSamples: 96_000 * 360 })]));
    assert.deepEqual([p.container, p.channels, p.rateHz, p.ms], ["flac", 6, 96_000, 360_000]);
    const unknownTotal = await probe(flacHeader({ channels: 2, rateHz: 44_100, totalSamples: 0 }));
    assert.equal(unknownTotal.ms, null);
  });

  test("Ogg Vorbis and Opus identification headers, the length from the last granule, Opus counted at 48 kHz", async () => {
    const vorbis = await probe(oggFile({ codec: "vorbis", channels: 2, rateHz: 44_100, samples: 44_100 * 10 }));
    assert.deepEqual([vorbis.channels, vorbis.rateHz, vorbis.ms], [2, 44_100, 10_000]);
    const opus = await probe(oggFile({ codec: "opus", channels: 8, rateHz: 16_000, samples: 48_000 * 2 }));
    assert.deepEqual([opus.channels, opus.rateHz, opus.ms], [8, 48_000, 2000]);
  });

  test("M4A's stsd in each version, its moov at the end, the length from mdhd", async () => {
    for (const version of [0, 1, 2] as const) {
      const p = await probe(m4aFile({ channels: 2, rateHz: 44_100, version, type: "alac", duration: 44_100 * 5 }));
      assert.deepEqual([p.container, p.channels, p.rateHz, p.ms], ["m4a", 2, 44_100, 5000], `version ${version}`);
    }
  });

  test("AAC takes the larger of stsd's channels and its esds configuration, and SBR's output rate", async () => {
    // An encoder that writes 2 in stsd for a 5.1 stream: the decoder makes 6.
    const surround = await probe(m4aFile({ channels: 2, rateHz: 48_000, esds: esdsBox({ objectType: 2, rateIndex: 3, channelConfig: 6 }) }));
    assert.equal(surround.channels, 6);
    // HE-AAC v2: a mono core at 24 kHz with parametric stereo decodes to stereo at 48 kHz.
    const he = await probe(m4aFile({ channels: 1, rateHz: 24_000, esds: esdsBox({ objectType: 29, rateIndex: 6, channelConfig: 1, extensionRateIndex: 3 }) }));
    assert.deepEqual([he.channels, he.rateHz], [2, 48_000]);
    assert.deepEqual(readEsds(new Uint8Array(esdsBox({ objectType: 5, rateIndex: 6, channelConfig: 2 }).slice(8))), { channels: 2, rateHz: 48_000 });
    const eight = await probe(m4aFile({ channels: 2, rateHz: 48_000, esds: esdsBox({ objectType: 2, rateIndex: 3, channelConfig: 7 }) }));
    assert.equal(eight.channels, 8);
  });

  test("raw AAC's ADTS channel_configuration, a low core rate counted double", async () => {
    const p = await probe(adtsFile({ rateIndex: 4, channelConfig: 2, frames: 431 }));
    assert.deepEqual([p.container, p.channels, p.rateHz], ["aac", 2, 44_100]);
    assert.equal(Math.round(p.ms!), Math.round(((431 * 1024) / 44_100) * 1000));
    const pce = await probe(adtsFile({ rateIndex: 4, channelConfig: 0, frames: 4 }));
    assert.equal(pce.channels, null);
    const low = await probe(adtsFile({ rateIndex: 6, channelConfig: 1, frames: 4 }));
    assert.equal(low.rateHz, 48_000);
  });

  test("WebM's Tracks Channels, a known and an unknown Segment size, Opus at 48 kHz", async () => {
    const p = await probe(webmFile({ channels: 6, rateHz: 44_100, durationMs: 4000 }));
    assert.deepEqual([p.container, p.channels, p.rateHz, p.ms], ["webm", 6, 44_100, 4000]);
    const recorded = await probe(webmFile({ channels: 2, rateHz: 48_000, codec: "A_OPUS", segmentUnknown: true }));
    assert.deepEqual([recorded.channels, recorded.rateHz, recorded.ms], [2, 48_000, null]);
  });

  test("an MP3's frames: a copy candidate at 64 to 192 kbps, a 320 kbps file not, behind its tags", async () => {
    const tone = toneSamples({ seconds: 3, rateHz: 44_100, channels: 2, tone: { hz: 440, dbfs: -12 } });
    const cbr = await probe(concat([id3v2("Rain", 2048), mp3Of(tone, 44_100), id3v1("Rain")]));
    assert.deepEqual([cbr.container, cbr.channels, cbr.rateHz, cbr.framed, cbr.copyCandidate], ["mp3", 2, 44_100, true, true]);
    assert.ok(Math.abs(cbr.ms! - 3000) < 60, `${cbr.ms}`);
    const fast = await probe(mp3AtKbps(tone, 44_100, 320));
    assert.equal(fast.copyCandidate, false);
    const mono = await probe(mp3Of(toneSamples({ seconds: 1, rateHz: 48_000, channels: 1, tone: null }), 48_000));
    assert.deepEqual([mono.channels, mono.rateHz, mono.copyCandidate], [1, 48_000, true]);
  });

  test("anything else has no channels", async () => {
    const p = await probe(new TextEncoder().encode("caff and other things no header here reads"));
    assert.deepEqual([p.container, p.channels], ["other", null]);
  });
});

describe("the guard's rules before decoding", () => {
  const flac = (channels: number, rateHz: number | null, ms: number): Probe => ({ container: "flac", channels, rateHz, ms, framed: false, copyCandidate: false, wav: null });

  test("channels other than 1, 2, 4 or 6 are refused before any decoding", () => {
    for (const channels of [3, 5, 8, 16]) assert.deepEqual(planRead({ probe: flac(channels, 44_100, 1000), ms: 1000, fileBytes: 10, use: "effect", budget: COMPUTER }), { ok: false, why: { t: "channels", channels } });
    for (const channels of [1, 2, 4, 6]) assert.equal(planRead({ probe: flac(channels, 44_100, 1000), ms: 1000, fileBytes: 10, use: "effect", budget: COMPUTER }).ok, true);
  });

  test("an unread rate counts as 96 kHz", () => {
    const at96 = wholeDecodeBytes({ fileBytes: 0, ms: 1000, channels: 2, rateHz: 96_000 });
    assert.equal(wholeDecodeBytes({ fileBytes: 0, ms: 1000, channels: 2, rateHz: null }), at96);
  });

  test("the bound counts the file, both copies and the mix", () => {
    assert.equal(wholeDecodeBytes({ fileBytes: 7, ms: 1000, channels: 6, rateHz: 48_000 }), 7 + 4 * 6 * 48_000 + 4 * 6 * 44_100 + 4 * 2 * 44_100);
    assert.equal(wholeDecodeBytes({ fileBytes: 0, ms: 1000, channels: 2, rateHz: 44_100 }), 2 * 4 * 2 * 44_100);
  });

  test("a 6-minute 6-channel FLAC is refused on a phone and a computer, before decoding (889 MB before its bytes)", () => {
    assert.equal(Math.round(wholeDecodeBytes({ fileBytes: 0, ms: 360_000, channels: 6, rateHz: 44_100 }) / 1e6), 889);
    for (const budget of [PHONE, COMPUTER]) assert.deepEqual(planRead({ probe: flac(6, 44_100, 360_000), ms: 360_000, fileBytes: 100 * MB, use: "music", budget }), { ok: false, why: { t: "tooBigToRead" } });
  });

  test("a 20-minute FLAC is refused by its length, unread, and a 3-minute stereo one fits a phone but a 4-minute one does not", () => {
    assert.deepEqual(planRead({ probe: flac(2, 44_100, 1_200_000), ms: 1_200_000, fileBytes: 150 * MB, use: "music", budget: PHONE }), { ok: false, why: { t: "tooLong" } });
    assert.equal(planRead({ probe: flac(2, 44_100, 180_000), ms: 180_000, fileBytes: 20 * MB, use: "music", budget: PHONE }).ok, true);
    assert.equal(planRead({ probe: flac(2, 44_100, 240_000), ms: 240_000, fileBytes: 27 * MB, use: "music", budget: PHONE }).ok, false);
    assert.equal(planRead({ probe: flac(2, 44_100, 900_000), ms: 900_000, fileBytes: 100 * MB, use: "music", budget: COMPUTER }).ok, true);
  });

  test("a file over 200 MB is refused, and a plain WAV or a copyable MP3 is read in pieces whatever its length", () => {
    assert.deepEqual(planRead({ probe: flac(2, 44_100, 1000), ms: 1000, fileBytes: SOUND_LIMITS.readFileBytes + 1, use: "effect", budget: COMPUTER }), { ok: false, why: { t: "fileTooLarge" } });
    const wav: Probe = { container: "wav", channels: 6, rateHz: 48_000, ms: 900_000, framed: false, copyCandidate: false, wav: { sample: "int", bits: 24, channels: 6, rateHz: 48_000, blockAlign: 18, dataOffset: 44, dataBytes: 0, frames: 0 } };
    assert.deepEqual(planRead({ probe: wav, ms: 900_000, fileBytes: 190 * MB, use: "music", budget: PHONE }), { ok: true, path: "wavPieces", ms: 900_000 });
    const at22: Probe = { ...wav, rateHz: 22_050, wav: { ...wav.wav!, rateHz: 22_050 } };
    assert.equal(planRead({ probe: at22, ms: 900_000, fileBytes: 190 * MB, use: "music", budget: PHONE }).ok, false);
    const mp3: Probe = { container: "mp3", channels: 2, rateHz: 44_100, ms: 900_050, framed: true, copyCandidate: true, wav: null };
    assert.deepEqual(planRead({ probe: mp3, ms: 900_050, fileBytes: 14 * MB, use: "music", budget: PHONE }), { ok: true, path: "mp3Pieces", ms: 900_050 });
  });

  test("an MP3's length is its frames', never what an Info frame declares, so a 15-minute file declaring 30 s is too big for a phone (MUS-SOL-02)", async () => {
    const frames = silentFrames(framesFor(900_000));
    const lying = withTagFrame(frames, { frames: framesFor(30_000) });
    const p = await probe(lying);
    near(p.ms, (framesFor(900_000) * 1152 * 1000) / 44_100);
    assert.equal(copyable(lying).ok, false, "the copy check refuses the count");
    assert.equal(wholeDecodeFits({ fileBytes: lying.length, ms: p.ms!, channels: 2, rateHz: 44_100, budget: PHONE }), false);
    assert.equal(wholeDecodeFits({ fileBytes: lying.length, ms: p.ms!, channels: 2, rateHz: 44_100, budget: COMPUTER }), true);
    // The fallback after the refused copy budgets by that length, before any decoder sees the file.
    const outcome = await prepareSound({ file: new File([lying as Uint8Array<ArrayBuffer>], "long.mp3"), use: "music", signal: new AbortController().signal, onStep: () => {}, budget: PHONE });
    assert.deepEqual(outcome, { ok: false, why: { t: "tooBigToRead" } });
  });

  test("an MP3's frames past junk or a tag between two streams count, and a stray sync in junk does not (MUS-SOL-02)", async () => {
    const head = silentFrames(framesFor(30_000));
    const rest = silentFrames(framesFor(870_000));
    const whole = ((framesFor(30_000) + framesFor(870_000)) * 1152 * 1000) / 44_100;
    for (const between of [new Uint8Array([0]), new Uint8Array([0xff, 0xfb]), id3v2("Second side", 4096)]) {
      const p = await probe(concat([head, between, rest]));
      near(p.ms, whole);
      assert.equal(wholeDecodeFits({ fileBytes: head.length + rest.length, ms: p.ms!, channels: 2, rateHz: 44_100, budget: PHONE }), false);
    }
    // A megabyte of noise, as cover art in a tag at the end: a lone header that seems to start a frame there is not one.
    let seed = 7;
    const noise = Uint8Array.from({ length: MB }, () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed >>> 24;
    });
    const short = await probe(concat([silentFrames(framesFor(3000)), noise, id3v1("Rain")]));
    near(short.ms, (framesFor(3000) * 1152 * 1000) / 44_100);
    // Two headers in junk, end to end, of two versions: no decoder takes the first for a stream's frame.
    const pair = concat([silentFrames(1), new Uint8Array([0xff, 0xf3, 0x90, 0x44]), new Uint8Array(400)]);
    const paired = await probe(concat([silentFrames(framesFor(3000)), new Uint8Array([0]), pair, new Uint8Array(1000)]));
    near(paired.ms, (framesFor(3000) * 1152 * 1000) / 44_100);
  });

  test("a variable bitrate MP3 that starts at 64 kbps is walked for its length, not refused by its first frame's rate", async () => {
    const vbr = concat([silentFrames(40, { kbps: 64 }), silentFrames(framesFor(780_000), { kbps: 320 })]);
    const p = await probe(vbr);
    assert.ok(Math.abs(p.ms! - 780_000) < 1100, `${p.ms}`);
    assert.equal(lengthRefusal("music", p.ms!, true), null);
  });

  test("an MP3's rate and channels for the budget are the most any of its frames has", async () => {
    const mixed = concat([silentFrames(framesFor(30_000), { mode: 3, kbps: 64 }), silentFrames(framesFor(300_000, 48_000), { rateHz: 48_000 })]);
    const p = await probe(mixed);
    assert.deepEqual([p.channels, p.rateHz], [2, 48_000]);
    near(p.ms, (framesFor(30_000) * 1152 * 1000) / 44_100 + (framesFor(300_000, 48_000) * 1152 * 1000) / 48_000);
    // By the first frame's mono at 44.1 kHz it would fit a phone, and a decoder makes stereo at 48 kHz.
    assert.equal(wholeDecodeFits({ fileBytes: mixed.length, ms: p.ms!, channels: 1, rateHz: 44_100, budget: PHONE }), true);
    assert.equal(wholeDecodeFits({ fileBytes: mixed.length, ms: p.ms!, channels: p.channels!, rateHz: p.rateHz, budget: PHONE }), false);
  });

  test("an unknown length is refused, a media element's length takes the allowance", () => {
    const webm: Probe = { container: "webm", channels: 2, rateHz: 48_000, ms: null, framed: false, copyCandidate: false, wav: null };
    assert.deepEqual(planRead({ probe: webm, ms: null, fileBytes: 10, use: "effect", budget: COMPUTER }), { ok: false, why: { t: "lengthUnknown" } });
    assert.equal(planRead({ probe: webm, ms: 30_050, fileBytes: 10, use: "effect", budget: COMPUTER }).ok, true);
  });
});

describe("lengths against the use", () => {
  test("the caps hold exactly on a source's own length, a framed one takes the allowance over the upper caps only", () => {
    assert.equal(lengthRefusal("effect", 30_000, false), null);
    assert.deepEqual(lengthRefusal("effect", 30_001, false), { t: "useTooLong", use: "effect" });
    assert.equal(lengthRefusal("effect", 30_100, true), null);
    assert.deepEqual(lengthRefusal("effect", 30_101, true), { t: "useTooLong", use: "effect" });
    assert.equal(lengthRefusal("music", 900_000, false), null);
    assert.deepEqual(lengthRefusal("music", 900_001, false), { t: "tooLong" });
    assert.deepEqual(lengthRefusal("loop", 900_001, false), { t: "tooLong" });
    assert.deepEqual(lengthRefusal("music", 29_999, true), { t: "useTooShort", use: "music" });
    assert.deepEqual(lengthRefusal("loop", 1_999, true), { t: "useTooShort", use: "loop" });
    assert.deepEqual(lengthRefusal("effect", 199, true), { t: "tooShort" });
    assert.deepEqual(lengthRefusal("music", 150, false), { t: "tooShort" });
    assert.equal(lengthRefusal("effect", 200, false), null);
    assert.deepEqual(lengthRefusal("effect", Number.NaN, false), { t: "tooShort" });
  });
});
