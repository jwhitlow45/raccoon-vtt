import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import { AssetError } from "../errors.ts";
import { checkVideoBytes } from "./check.ts";
import { audioSpecificConfig, avcCodecString } from "./mp4.ts";
import {
  FFMPEG_AAC_LC,
  SECRETS,
  appleLocationMeta,
  audioEntry,
  av1CBytes,
  avcCBytes,
  bx,
  dOpsBytes,
  defaultSoundTrack,
  defaultVideoTrack,
  esdsBytes,
  fields,
  locationUdta,
  mp4File,
  visualEntry,
  type Mp4Options,
  type Mp4Track,
} from "./videoTestutil.ts";

/**
 * The MP4 header check, one case per check in
 * docs/design/design-v1-animated-maps.md 10 and per 4.5 code, on files the
 * test writer builds box by box.
 */

async function refused(bytes: Buffer, code: string): Promise<void> {
  await assert.rejects(checkVideoBytes(bytes), (err: unknown) => {
    assert.ok(err instanceof AssetError, String(err));
    assert.equal(err.code, code, `refused as ${err.code}${err.cause ? ` (${String(err.cause)})` : ""}`);
    return true;
  });
}

const withSound = (o: Mp4Options = {}, sound: Partial<Mp4Track> & { seconds?: number } = {}) => mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack(sound)], ...o });
const aacEntry = (esds: Buffer) => audioEntry("mp4a", 2, 48000, bx("esds", esds));
const videoWith = (...kids: ReturnType<typeof bx>[]) => defaultVideoTrack({ entry: visualEntry("avc1", 640, 360, "", bx("avcC", avcCBytes()), ...kids) });

/** The mdat payload's bytes, which no edit may touch. */
function mdatOf(bytes: Buffer): Buffer {
  const at = bytes.indexOf("mdat");
  return bytes.subarray(at + 4, at - 4 + bytes.readUInt32BE(at - 4));
}

describe("a plain MP4", () => {
  test("gives its size, codec, peak rate and length, and never touches mdat", async () => {
    const bytes = mp4File();
    const { facts, zeroed } = await checkVideoBytes(bytes);
    assert.deepEqual(facts, { container: "mp4", widthPx: 640, heightPx: 360, video: "avc1.42C01E", fps: 30, durationMs: 2000, kbps: Math.round((bytes.length * 8) / 2000) });
    assert.equal(zeroed.length, bytes.length);
    assert.ok(mdatOf(zeroed).equals(mdatOf(bytes)));
  });

  test("with AAC sound, the sound joins the facts as its own configuration", async () => {
    const { facts } = await checkVideoBytes(withSound());
    assert.equal(facts.audio, "mp4a.40.2");
    assert.equal(facts.audioChannels, 2);
    assert.equal(facts.audioHz, 48000);
  });

  test("Opus in MP4 reads its dOps", async () => {
    const opus: Mp4Track = { ...defaultSoundTrack(), entry: audioEntry("Opus", 2, 48000, bx("dOps", dOpsBytes())), edits: [{ segment: 2000, mediaTime: 312 }], samples: Array.from({ length: 101 }, () => ({ size: 10, delta: 960 })) };
    const { facts } = await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack(), opus] }));
    assert.equal(facts.audio, "opus");
  });

  test("moov after mdat, as cameras write it, reads the same", async () => {
    const { facts } = await checkVideoBytes(mp4File({ moovLast: true, tracks: [defaultVideoTrack(), defaultSoundTrack()] }));
    assert.equal(facts.durationMs, 2000);
  });

  test("an mdat whose size is 0 runs to the end of the file, as the last box", async () => {
    const bytes = Buffer.from(mp4File());
    const at = bytes.indexOf("mdat") - 4;
    bytes.writeUInt32BE(0, at);
    await checkVideoBytes(bytes);
  });

  test("AV1 builds av01.P.LLT.DD from its av1C, which it requires (AM-ASTRA-10)", async () => {
    const av1 = defaultVideoTrack({ entry: visualEntry("av01", 640, 360, "", bx("av1C", av1CBytes())) });
    assert.equal((await checkVideoBytes(mp4File({ tracks: [av1] }))).facts.video, "av01.0.08M.08");
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("av01", 640, 360, "") })] }), "bad_video");
  });

  test("checked again, the stored file gives the same facts and no new edit", async () => {
    const first = await checkVideoBytes(secretMp4());
    const second = await checkVideoBytes(first.zeroed);
    assert.deepEqual(second.facts, first.facts);
    assert.ok(second.zeroed.equals(first.zeroed));
  });
});

/** An MP4 with identifying text in every place 7 names: location atoms, names, padding, an ICC profile, a timecode's reel. */
function secretMp4(): Buffer {
  const free = bx("free", Buffer.from(SECRETS.free));
  const video = defaultVideoTrack({
    entry: visualEntry("avc1", 640, 360, SECRETS.compressor, bx("avcC", avcCBytes()), bx("colr", Buffer.concat([Buffer.from("prof"), Buffer.from(SECRETS.icc)])), bx("uuid", Buffer.from(SECRETS.udta))),
    handlerName: SECRETS.handler,
    extraTrak: [locationUdta(), appleLocationMeta()],
    extraMinf: [bx("udta", Buffer.from(SECRETS.udta))],
  });
  const tmcd: Mp4Track = {
    handler: "tmcd",
    entry: bx("tmcd", Buffer.concat([fields(Buffer.alloc(6), [2, 1], [4, 0], [4, 0], [4, 30000], [4, 1001], [1, 30], [1, 0])]), bx("name", Buffer.concat([fields([2, SECRETS.tmcd.length], [2, 0]), Buffer.from(SECRETS.tmcd)]))),
    timescale: 30000,
    samples: [{ size: 4, delta: 60060 }],
    handlerName: SECRETS.handler,
  };
  return mp4File({
    tracks: [video, defaultSoundTrack({ handlerName: SECRETS.handler }), tmcd],
    beforeMoov: [free, { type: "uuid", usertype: Buffer.alloc(16, 7), head: Buffer.from(SECRETS.udta) }],
    inMoov: [locationUdta(), appleLocationMeta(), bx("skip", Buffer.from(SECRETS.free)), bx("meta", Buffer.from(SECRETS.udta))],
    afterMdat: [bx("wide", Buffer.from(SECRETS.free)), bx("udta", Buffer.from(SECRETS.udta))],
  });
}

describe("metadata is zeroed from an allowlist (section 7)", () => {
  test("no identifying string survives, the length holds and mdat is untouched", async () => {
    const bytes = secretMp4();
    const all = [SECRETS.location, "com.apple.quicktime.location.ISO6709", SECRETS.handler, SECRETS.compressor, SECRETS.free, SECRETS.icc, SECRETS.udta, SECRETS.tmcd];
    for (const s of all) assert.ok(bytes.includes(s), `the fixture holds ${s}`);
    const { zeroed, edits } = await checkVideoBytes(bytes);
    assert.equal(zeroed.length, bytes.length);
    for (const s of all) assert.equal(zeroed.includes(s), false, `${s} survived`);
    assert.ok(mdatOf(zeroed).equals(mdatOf(bytes)));
    for (const z of edits.zeroes) assert.ok(zeroed.subarray(z.start, z.end).every((b) => b === 0));
  });

  test("a dropped box is renamed free, with an all-zero payload of the same length", async () => {
    const bytes = mp4File({ inMoov: [locationUdta()] });
    const at = bytes.indexOf("udta");
    const size = bytes.readUInt32BE(at - 4);
    const { zeroed } = await checkVideoBytes(bytes);
    assert.equal(zeroed.subarray(at, at + 4).toString("latin1"), "free");
    assert.equal(zeroed.readUInt32BE(at - 4), size);
    assert.ok(zeroed.subarray(at + 4, at - 4 + size).every((b) => b === 0));
  });

  test("the creation and modification times in mvhd, tkhd and mdhd are zeroed", async () => {
    const bytes = withSound();
    const stamp = Buffer.from([0x7a, 0x6b, 0x5c, 0x4d, 0x7a, 0x6b, 0x5c, 0x4e]);
    assert.ok(bytes.includes(stamp));
    const { zeroed } = await checkVideoBytes(bytes);
    assert.equal(zeroed.includes(stamp), false);
    for (const box of ["mvhd", "tkhd", "mdhd"]) {
      const at = zeroed.indexOf(box);
      assert.ok(zeroed.subarray(at + 8, at + 16).every((b) => b === 0), box);
    }
  });

  test("an ICC colr goes as free and an nclx colr stays (AMR-4)", async () => {
    const nclx = bx("colr", Buffer.concat([Buffer.from("nclx"), fields([2, 1], [2, 1], [2, 1], [1, 0])]));
    const icc = bx("colr", Buffer.concat([Buffer.from("prof"), Buffer.from(SECRETS.icc)]));
    const { zeroed } = await checkVideoBytes(mp4File({ tracks: [videoWith(nclx, icc)] }));
    assert.ok(zeroed.includes(Buffer.concat([Buffer.from("colrnclx"), fields([2, 1], [2, 1], [2, 1], [1, 0])])));
    assert.equal(zeroed.includes(SECRETS.icc), false);
  });
});

describe("refusals", () => {
  test("MOV and other ISO containers are video_type", async () => {
    await refused(mp4File({ brand: "qt  " }), "video_type");
    await refused(mp4File({ brand: "M4A " }), "video_type");
    await refused(mp4File({ brand: "3gp5" }), "video_type");
  });

  test("HEVC, MPEG-4 Part 2 and AC-3 are video_codec", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("hvc1", 640, 360, "") })] }), "video_codec");
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("mp4v", 640, 360, "") })] }), "video_codec");
    await refused(mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack({ entry: audioEntry("ac-3", 2, 48000) })] }), "video_codec");
  });

  test("a second video, sound or timecode track, or a text track, is video_tracks (AMN-12)", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack(), defaultVideoTrack()] }), "video_tracks");
    await refused(mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack(), defaultSoundTrack()] }), "video_tracks");
    await refused(mp4File({ tracks: [defaultVideoTrack(), { ...defaultSoundTrack(), handler: "text" }] }), "video_tracks");
    await refused(mp4File({ tracks: [defaultVideoTrack(), { ...defaultSoundTrack(), handler: "meta" }] }), "video_tracks");
  });

  test("a fragmented MP4 is video_fragmented", async () => {
    await refused(mp4File({ inMoov: [bx("mvex", undefined, bx("trex", Buffer.alloc(24)))] }), "video_fragmented");
    await refused(mp4File({ afterMdat: [bx("moof", undefined, bx("mfhd", Buffer.alloc(8)))] }), "video_fragmented");
  });

  test("a rotation, a tkhd size unlike the sample entry's, a non-square pasp and a clap are video_geometry", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack({ matrix: [0, 0x10000, 0, -0x10000 >>> 0, 0, 0, 0, 0, 0x40000000] })] }), "video_geometry");
    await refused(mp4File({ tracks: [defaultVideoTrack({ tkhdSize: { width: 853, height: 360 } })] }), "video_geometry");
    await refused(mp4File({ tracks: [videoWith(bx("pasp", fields([4, 4], [4, 3])))] }), "video_geometry");
    await refused(mp4File({ tracks: [videoWith(bx("clap", Buffer.alloc(32)))] }), "video_geometry");
  });

  test("PQ or HLG in an nclx colr is video_hdr", async () => {
    for (const transfer of [16, 18]) await refused(mp4File({ tracks: [videoWith(bx("colr", Buffer.concat([Buffer.from("nclx"), fields([2, 9], [2, transfer], [2, 9], [1, 0])])))] }), "video_hdr");
  });

  test("an edited timeline is video_layout (AM-ASTRA-08)", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack({ edits: [{ segment: 1000, mediaTime: 0 }, { segment: 1000, mediaTime: 15360 }] })] }), "video_layout");
    await refused(mp4File({ tracks: [defaultVideoTrack({ edits: [{ segment: 500, mediaTime: -1 }] })] }), "video_layout");
    await refused(mp4File({ tracks: [defaultVideoTrack({ edits: [{ segment: 1000, mediaTime: 0, rate: 0x20000 }] })] }), "video_layout");
    // One edit that stops a second before the media does.
    await refused(mp4File({ tracks: [defaultVideoTrack({ edits: [{ segment: 1000, mediaTime: 0 }] })] }), "video_layout");
    // One edit from a positive offset that covers the rest is fine.
    await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ edits: [{ segment: 1967, mediaTime: 512 }] })] }));
  });

  test("sound 60 ms past the picture is video_layout, and sound ending well before is fine (AMS-4, AM-ASTRA-30)", async () => {
    await refused(withSound({}, { seconds: 2.06 }), "video_layout");
    await checkVideoBytes(withSound({}, { seconds: 1.2 }));
  });

  test("60 fps with AAC ending 21 ms after the picture is fine (AMN-4)", async () => {
    const video = defaultVideoTrack({ frames: 120, delta: 256 });
    await checkVideoBytes(mp4File({ tracks: [video, defaultSoundTrack({ seconds: 2.021 })] }));
  });

  test("an mvhd duration off the longest track is video_layout", async () => {
    await refused(mp4File({ movieDuration: 2500 }), "video_layout");
  });

  test("a data reference to another file is bad_video", async () => {
    const bytes = Buffer.from(mp4File());
    const at = bytes.indexOf("url ");
    bytes[at + 7] = 0; // the self-contained flag
    await refused(bytes, "bad_video");
  });

  test("a sample the tables put outside mdat is bad_video, so no edit can land on one", async () => {
    const bytes = Buffer.from(mp4File());
    const at = bytes.indexOf("stco");
    bytes.writeUInt32BE(40, at + 12); // the first chunk now starts inside moov
    await refused(bytes, "bad_video");
  });

  test("two moov boxes, none, no mdat, or a moov over 8 MiB are bad_video", async () => {
    const one = mp4File();
    const moovAt = one.indexOf("moov") - 4;
    const moov = one.subarray(moovAt, moovAt + one.readUInt32BE(moovAt));
    await refused(Buffer.concat([one, moov]), "bad_video");
    await refused(one.subarray(0, moovAt), "bad_video");
    await refused(Buffer.concat([one.subarray(0, moovAt + moov.length)]), "bad_video");
    await refused(mp4File({ inMoov: [bx("free", Buffer.alloc(VIDEO_LIMITS.parseMoovBytes))] }), "bad_video");
  });

  test("a box smaller than its header, past its parent, or sized 0 before the last is bad_video", async () => {
    const bytes = mp4File();
    const at = bytes.indexOf("mvhd") - 4;
    const small = Buffer.from(bytes);
    small.writeUInt32BE(4, at);
    await refused(small, "bad_video");
    const long = Buffer.from(bytes);
    long.writeUInt32BE(1_000_000, at);
    await refused(long, "bad_video");
    const zero = Buffer.from(bytes);
    zero.writeUInt32BE(0, at);
    await refused(zero, "bad_video");
    await refused(bytes.subarray(0, bytes.length - 3), "bad_video");
  });

  test("a 64-bit size above 2^53 is bad_video", async () => {
    const bytes = mp4File({ afterMdat: [{ type: "free", large: true }] });
    const at = bytes.lastIndexOf("free");
    const big = Buffer.from(bytes);
    big.writeBigUInt64BE(2n ** 60n, at + 4);
    await refused(big, "bad_video");
    await checkVideoBytes(bytes);
  });

  test("the caps: size, length, rate and frame count", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack({ width: 4097, height: 2000 })] }), "video_size");
    await refused(mp4File({ tracks: [defaultVideoTrack({ width: 3000, height: 3000 })] }), "video_size");
    await refused(mp4File({ tracks: [defaultVideoTrack({ frames: 25 })] }), "video_length");
    await refused(mp4File({ tracks: [defaultVideoTrack({ frames: 140, delta: 219 })] }), "video_fps");
    await refused(mp4File({ tracks: [defaultVideoTrack({ frames: VIDEO_LIMITS.maxFrames + 1, delta: 256 })] }), "video_fps");
  });

  test("the peak rate counts presentation times, with ctts", async () => {
    // B-frames: decode order 0, 2, 1, 4, 3, ... still presents 30 a second.
    const samples = Array.from({ length: 60 }, (_, i) => ({ size: 30, delta: 512, cts: i === 0 ? 512 : i % 2 === 1 ? 1024 : 0 }));
    const { facts } = await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ samples, edits: [{ segment: 2000, mediaTime: 512 }] })] }));
    assert.equal(facts.fps, 30);
  });
});

describe("esds is accepted only in a bounded subset (AM-ASTRA-21, AMR-4, AMQ-3, AM-ASTRA-27)", () => {
  const soundWith = (esds: Buffer) => mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack({ entry: aacEntry(esds) })] });

  test("FFmpeg's AAC-LC 11 90 56 e5 00, with its SBR-absent sync extension, is accepted", async () => {
    assert.deepEqual(audioSpecificConfig(FFMPEG_AAC_LC), { objectType: 2, channels: 2, hz: 48000 });
    await checkVideoBytes(soundWith(esdsBytes()));
  });

  test("plain AAC-LC, HE-AAC and HE-AAC v2 are accepted with their object types", async () => {
    assert.deepEqual(audioSpecificConfig(Buffer.from([0x11, 0x90])), { objectType: 2, channels: 2, hz: 48000 });
    // AOT 5, 24 kHz core, stereo, extension 48 kHz, inner AOT 2, then GASpecificConfig.
    assert.deepEqual(audioSpecificConfig(Buffer.from([0x2b, 0x11, 0x88, 0x00])), { objectType: 5, channels: 2, hz: 48000 });
    assert.deepEqual(audioSpecificConfig(Buffer.from([0xeb, 0x09, 0x88, 0x00])), { objectType: 29, channels: 2, hz: 48000 });
    const he = await checkVideoBytes(soundWith(esdsBytes({ asc: Buffer.from([0x2b, 0x11, 0x88, 0x00]) })));
    assert.equal(he.facts.audio, "mp4a.40.5");
  });

  test("a URL, a dependence or an OCR stream flag is video_sound", async () => {
    for (const flag of [0x40, 0x80, 0x20]) await refused(soundWith(esdsBytes({ esFlags: flag })), "video_sound");
  });

  test("channel configuration 0, which brings a program configuration element and its comment, is video_sound", async () => {
    await refused(soundWith(esdsBytes({ asc: Buffer.from([0x11, 0x80, 0x00]) })), "video_sound");
  });

  test("an explicit SBR-present extension is video_sound", async () => {
    // syncExtensionType 0x2b7, AOT 5, sbrPresentFlag 1, then an extension rate index.
    await refused(soundWith(esdsBytes({ asc: Buffer.from([0x11, 0x90, 0x56, 0xe5, 0x98]) })), "video_sound");
  });

  test("trailing bytes after the AudioSpecificConfig, or another descriptor, are video_sound", async () => {
    await refused(soundWith(esdsBytes({ asc: Buffer.concat([FFMPEG_AAC_LC, Buffer.from([0x41])]) })), "video_sound");
    await refused(soundWith(esdsBytes({ asc: Buffer.from([0x11, 0x90, 0x01]) })), "video_sound");
    await refused(soundWith(esdsBytes({ afterInfo: Buffer.from([0x14, 0x80, 0x80, 0x80, 0x01, 0x01]) })), "video_sound");
  });

  test("MPEG-2 AAC is video_sound (AMQ-3)", async () => {
    for (const oti of [0x66, 0x67, 0x68]) await refused(soundWith(esdsBytes({ oti })), "video_sound");
  });

  test("an mp4a with no esds, or a version 1 sound entry, is video_sound", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack({ entry: audioEntry("mp4a", 2, 48000) })] }), "video_sound");
    const entry = aacEntry(esdsBytes());
    entry.head = Buffer.from(entry.head!);
    entry.head.writeUInt16BE(1, 8);
    await refused(mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack({ entry })] }), "video_sound");
  });
});

describe("avcC (AMS-3)", () => {
  const high = (ext?: Buffer) => avcCBytes(0x64, ext);

  test("FFmpeg's High with its extension, Android MediaMuxer's High without it, and Baseline are accepted", async () => {
    assert.equal(avcCodecString("avc1", high(Buffer.from([0xfd, 0xf8, 0xf8, 0x00]))), "avc1.64C01E");
    assert.equal(avcCodecString("avc1", high()), "avc1.64C01E");
    assert.equal(avcCodecString("avc3", avcCBytes()), "avc3.42C01E");
    for (const record of [high(Buffer.from([0xfd, 0xf8, 0xf8, 0x00])), high(), avcCBytes()]) {
      await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("avc1", 640, 360, "", bx("avcC", record)) })] }));
    }
  });

  test("zero bytes after the record are kept, and anything else is bad_video", async () => {
    const zeros = Buffer.concat([avcCBytes(), Buffer.alloc(4)]);
    const bytes = mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("avc1", 640, 360, "", bx("avcC", zeros)) })] });
    assert.ok((await checkVideoBytes(bytes)).zeroed.includes(zeros));
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("avc1", 640, 360, "", bx("avcC", Buffer.concat([avcCBytes(), Buffer.from([0, 7])]))) })] }), "bad_video");
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("avc1", 640, 360, "", bx("avcC", Buffer.concat([high(Buffer.from([0xfd, 0xf8, 0xf8, 0x00])), Buffer.from([3])]))) })] }), "bad_video");
  });
});
