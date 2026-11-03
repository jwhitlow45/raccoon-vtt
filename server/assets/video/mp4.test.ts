import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import { AssetError } from "../errors.ts";
import { capped, checkVideoBytes } from "./check.ts";
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
import { Edits } from "./window.ts";

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
    // Two edits, the first covering the media, under an mvhd of the media's length: only the edit count refuses it.
    await refused(mp4File({ movieDuration: 2000, tracks: [defaultVideoTrack({ edits: [{ segment: 2000, mediaTime: 0 }, { segment: 1000, mediaTime: 0 }] })] }), "video_layout");
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
    // AAC-LC at 48 kHz with channel configuration 0 and nothing after it, so only the channel rule refuses it.
    await refused(soundWith(esdsBytes({ asc: Buffer.from([0x11, 0x80]) })), "video_sound");
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

describe("every kept box is read to its last byte (AMBUILD-SOL-003, AMBUILD-SOL-006)", () => {
  const TEXT = "Kept by Mallory Example";
  /** `bytes` with `data` written `offset` bytes after the first `marker`, a box's type. */
  function patched(bytes: Buffer, marker: string, offset: number, data: Buffer | string, nth = 0): Buffer {
    const out = Buffer.from(bytes);
    let at = -1;
    for (let i = 0; i <= nth; i++) at = out.indexOf(marker, at + 1);
    assert.ok(at >= 0, `no ${marker}`);
    (typeof data === "string" ? Buffer.from(data, "latin1") : data).copy(out, at + offset);
    return out;
  }
  /** Text in place, then gone from the stored bytes, the file still accepted. */
  async function cleared(bytes: Buffer, text: string): Promise<Buffer> {
    assert.ok(bytes.includes(text), `the fixture holds ${text}`);
    const { zeroed } = await checkVideoBytes(bytes);
    assert.equal(zeroed.includes(text), false, `${text} survived`);
    return zeroed;
  }
  const full = (version: number, flags = 0) => fields([1, version], [3, flags]);
  const withStbl = (...extra: ReturnType<typeof bx>[]) => mp4File({ tracks: [defaultVideoTrack({ extraStbl: extra })] });

  test("ftyp keeps its major brand, zeroes its minor version and any brand it does not know", async () => {
    const zeroed = await cleared(patched(mp4File(), "ftyp", 8, "Mlry"), "Mlry");
    assert.equal(zeroed.subarray(zeroed.indexOf("ftyp") + 4, zeroed.indexOf("ftyp") + 8).toString("latin1"), "isom");
    await cleared(patched(mp4File(), "ftyp", 16, "Malo"), "Malo");
    await refused(patched(mp4File(), "ftyp", 5, Buffer.from([0x01])), "bad_video");
  });

  test("mvhd's reserved and predefined bytes are zeroed, and its matrix must be the identity", async () => {
    await cleared(patched(mp4File(), "mvhd", 4 + 4 + 22, "Mallory!12"), "Mallory!12");
    await cleared(patched(mp4File(), "mvhd", 4 + 4 + 68, TEXT), TEXT);
    await refused(patched(mp4File(), "mvhd", 4 + 4 + 32, fields([4, 0], [4, 0x10000])), "video_geometry");
  });

  test("tkhd's reserved bytes are zeroed, and a sound track's matrix and size are the identity and none", async () => {
    await cleared(patched(mp4File(), "tkhd", 8 + 20, "Mallory!"), "Mallory!");
    const sound = patched(withSound(), "tkhd", 8 + 36, TEXT.slice(0, 20), 1);
    const zeroed = await cleared(sound, TEXT.slice(0, 20));
    const at = zeroed.indexOf("tkhd", zeroed.indexOf("tkhd") + 1);
    assert.deepEqual([...zeroed.subarray(at + 8 + 36, at + 8 + 44)], [0, 1, 0, 0, 0, 0, 0, 0]);
  });

  test("hdlr's predefined and reserved bytes, where QuickTime names a component and a maker, are zeroed", async () => {
    await cleared(patched(mp4File(), "hdlr", 8, "mhlr"), "mhlr");
    await cleared(patched(mp4File(), "hdlr", 16, "Mallory Inc"), "Mallory Inc");
  });

  test("mdhd's language says und and its predefined bytes are zeroed", async () => {
    const zeroed = await cleared(patched(mp4File(), "mdhd", 8 + 16, "MX"), "MX");
    const at = zeroed.indexOf("mdhd");
    assert.deepEqual([...zeroed.subarray(at + 24, at + 28)], [0x55, 0xc4, 0, 0]);
  });

  test("vmhd's and smhd's fields and every sample entry's reserved bytes are zeroed", async () => {
    await cleared(patched(mp4File(), "vmhd", 8, "MaloryEx"), "MaloryEx");
    await cleared(patched(withSound(), "smhd", 8, "Malo"), "Malo");
    // The second avc1: the first is a compatible brand in ftyp.
    await cleared(patched(mp4File(), "avc1", 4, "Malory", 1), "Malory");
    await cleared(patched(mp4File(), "avc1", 4 + 8, "FFMPMallory!", 1), "FFMPMallory!");
    await cleared(patched(withSound(), "mp4a", 4 + 10, "appl!!"), "appl!!");
  });

  test("a FullBox with a version or a flag its type does not have is refused", async () => {
    await refused(patched(mp4File(), "stts", 5, "Mal"), "bad_video");
    await refused(patched(mp4File(), "mdhd", 4, Buffer.from([2])), "bad_video");
    await refused(patched(mp4File(), "url ", 5, Buffer.from([0, 0, 3])), "bad_video");
  });

  test("a square pasp says 1:1, btrt goes, and an nclx colr's reserved bits must be clear", async () => {
    const zeroed = await cleared(mp4File({ tracks: [videoWith(bx("pasp", Buffer.from("MaloMalo")))] }), "MaloMalo");
    assert.ok(zeroed.includes(Buffer.concat([Buffer.from("pasp"), fields([4, 1], [4, 1])])));
    await cleared(mp4File({ tracks: [videoWith(bx("btrt", Buffer.from("Mallory Exam")))] }), "Mallory Exam");
    await refused(mp4File({ tracks: [videoWith(bx("colr", Buffer.concat([Buffer.from("nclx"), fields([2, 1], [2, 1], [2, 1], [1, 0x41])])))] }), "bad_video");
  });

  test("stss and sdtp are read against the sample count", async () => {
    const stss = (...numbers: number[]) => bx("stss", Buffer.concat([full(0), fields([4, numbers.length]), ...numbers.map((n) => fields([4, n]))]));
    await checkVideoBytes(withStbl(stss(1, 31)));
    await refused(withStbl(stss(1, 61)), "bad_video");
    await refused(withStbl(stss(31, 1)), "bad_video");
    await refused(withStbl(bx("stss", Buffer.concat([full(0), fields([4, 1]), Buffer.from(TEXT)]))), "bad_video");
    const sdtp = (bytes: Buffer) => bx("sdtp", Buffer.concat([full(0), bytes]));
    await checkVideoBytes(withStbl(sdtp(Buffer.alloc(60, 0x24))));
    await refused(withStbl(sdtp(Buffer.alloc(59, 0x24))), "bad_video");
    await refused(withStbl(sdtp(Buffer.concat([Buffer.from(TEXT), Buffer.alloc(60 - TEXT.length, 0x24)]))), "bad_video");
  });

  test("a sample group of a known type is read whole, and one of any other type goes with its mapping", async () => {
    const sgpd = (type: string, ...records: Buffer[]) => bx("sgpd", Buffer.concat([full(1), Buffer.from(type, "latin1"), fields([4, records[0]?.length ?? 0], [4, records.length]), ...records]));
    const sbgp = (type: string, ...runs: Array<[number, number]>) => bx("sbgp", Buffer.concat([full(0), Buffer.from(type, "latin1"), fields([4, runs.length]), ...runs.map(([n, i]) => fields([4, n], [4, i]))]));
    // FFmpeg's AAC roll group: a roll distance of -1 for every sample.
    const roll = [sgpd("roll", Buffer.from([0xff, 0xff])), sbgp("roll", [60, 1])];
    await checkVideoBytes(withStbl(...roll));
    await refused(withStbl(sgpd("roll", Buffer.from("Mallory")), sbgp("roll", [60, 1])), "bad_video");
    await refused(withStbl(sgpd("roll", Buffer.from([0xff, 0xff])), sbgp("roll", [61, 1])), "bad_video");
    await refused(withStbl(sgpd("roll", Buffer.from([0xff, 0xff])), sbgp("roll", [60, 2])), "bad_video");
    await refused(withStbl(...roll, sgpd("roll", Buffer.from([0xff, 0xfe]))), "bad_video");
    // A private type's description holding text is dropped, and so is its mapping.
    await cleared(withStbl(sgpd("priv", Buffer.from(TEXT)), sbgp("priv", [60, 1])), TEXT);
    await cleared(withStbl(sbgp("Mlry", [60, 1])), "Mlry");
  });

  test("cslg must be one of its two layouts, its bounds in order", async () => {
    const cslg = (version: number, ...values: number[]) => bx("cslg", Buffer.concat([full(version), ...values.map((v) => (version === 1 ? fields([8, BigInt(v)]) : fields([4, v >>> 0])))]));
    await checkVideoBytes(withStbl(cslg(0, 0, 0, 512, 0, 30720)));
    await refused(withStbl(cslg(0, 0, 512, 0, 0, 30720)), "bad_video");
    await refused(withStbl(bx("cslg", Buffer.concat([full(0), Buffer.from(TEXT)]))), "bad_video");
  });

  test("an avcC parameter set must be a parameter set, so an SEI holding text is refused", async () => {
    const sei = Buffer.concat([Buffer.from([0x06, 0x05]), Buffer.from(TEXT)]);
    const record = Buffer.concat([avcCBytes().subarray(0, -8), Buffer.from([1]), fields([2, sei.length]), sei]);
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("avc1", 640, 360, "", bx("avcC", record)) })] }), "bad_video");
  });

  test("facts the protocol would refuse are never stored, so the schemas cannot drift (AM-R1-05)", () => {
    const parsed = { container: "mp4" as const, widthPx: 640, heightPx: 360, video: "avc1.42C01E", audio: "mp4a.40.2", audioChannels: 2, audioHz: 48_000, fps: 30, durationMs: 2000, edits: new Edits() };
    assert.equal(capped(parsed, 10_000).audioHz, 48_000);
    assert.throws(() => capped({ ...parsed, audioHz: 2_000_000 }, 10_000), (err: unknown) => err instanceof AssetError && err.code === "bad_video");
    assert.throws(() => capped({ ...parsed, video: "avc1.42C01E;x" }, 10_000), (err: unknown) => err instanceof AssetError && err.code === "bad_video");
  });

  test("an AAC rate outside the table is video_sound (AM-R1-05)", async () => {
    // AAC-LC, rate index 15 then 24 bits of 2,000,000 Hz, stereo.
    const bits = new Array<number>();
    const put = (v: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
    };
    put(2, 5);
    put(15, 4);
    put(2_000_000, 24);
    put(2, 4);
    put(0, 3);
    while (bits.length % 8) bits.push(0);
    const asc = Buffer.from(Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((v, b) => v * 2 + b, 0)));
    await refused(mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack({ entry: aacEntry(esdsBytes({ asc })) })] }), "video_sound");
  });

  test("a second copy of a box its parent holds once is refused", async () => {
    const twice: Array<[string, Partial<Mp4Track>]> = [
      ["edts", { edits: [{ segment: 2000, mediaTime: 0 }], extraTrak: [bx("edts", undefined, bx("elst", Buffer.concat([full(0), fields([4, 0])])))] }],
      ["stss", { extraStbl: [bx("stss", Buffer.concat([full(0), fields([4, 1], [4, 1])])), bx("stss", Buffer.concat([full(0), fields([4, 1], [4, 1])]))] }],
      ["pasp", { entry: visualEntry("avc1", 640, 360, "", bx("avcC", avcCBytes()), bx("pasp", fields([4, 1], [4, 1])), bx("pasp", fields([4, 1], [4, 1]))) }],
      ["dinf", { extraMinf: [bx("dinf", undefined, bx("dref", Buffer.concat([full(0), fields([4, 1])]), bx("url ", full(0, 1))))] }],
      ["vmhd", { extraMinf: [bx("vmhd", Buffer.concat([full(0, 1), Buffer.alloc(8)]))] }],
    ];
    for (const [name, o] of twice) {
      await assert.rejects(checkVideoBytes(mp4File({ tracks: [defaultVideoTrack(o)] })), (err: unknown) => err instanceof AssetError && err.code === "bad_video", name);
    }
  });
});

describe("each track's durations and composition times match its samples (AMBUILD-ASTRA-03)", () => {
  function at(bytes: Buffer, marker: string, offset: number, value: number): Buffer {
    const out = Buffer.from(bytes);
    out.writeUInt32BE(value, out.indexOf(marker) + offset);
    return out;
  }

  test("an mdhd or tkhd duration unlike the samples' is video_layout", async () => {
    // mdhd's duration is 12 bytes into its body, tkhd's 16: 60 samples of 512 ticks are 30720, and 2000 in the movie's timescale.
    assert.equal(mp4File().readUInt32BE(mp4File().indexOf("mdhd") + 20), 30720);
    await refused(at(mp4File(), "mdhd", 20, 10 * 60 * 15360), "video_layout");
    await refused(at(mp4File(), "tkhd", 24, 600_000), "video_layout");
    await checkVideoBytes(at(mp4File(), "mdhd", 20, 30720 + 256));
  });

  test("a composition offset past what a decoder reorders, or before the start, is video_layout", async () => {
    const offsets = (cts: (i: number) => number) => defaultVideoTrack({ samples: Array.from({ length: 60 }, (_, i) => ({ size: 30, delta: 512, cts: cts(i) })) });
    // Every frame shown ten minutes late.
    await refused(mp4File({ tracks: [offsets(() => 10 * 60 * 15360)] }), "video_layout");
    // Sixteen frames late is as far as H.264 holds back.
    await checkVideoBytes(mp4File({ tracks: [offsets((i) => (i === 0 ? 16 * 512 : 0))], movieDuration: 2000 }));
  });

  test("a negative composition offset that shows a frame before the start is video_layout", async () => {
    const bytes = Buffer.from(mp4File({ tracks: [defaultVideoTrack({ samples: Array.from({ length: 60 }, (_, i) => ({ size: 30, delta: 512, cts: i === 0 ? 1 : 0 })) })] }));
    // ctts version 1, its first offset -512.
    const ctts = bytes.indexOf("ctts");
    bytes[ctts + 4] = 1;
    bytes.writeInt32BE(-512, ctts + 16);
    await refused(bytes, "video_layout");
  });

  test("cslg's numbers must lie inside the media's composition times", async () => {
    const cslg = bx("cslg", Buffer.concat([fields([1, 0], [3, 0]), fields([4, 0], [4, 0], [4, 512], [4, 0], [4, 10 * 60 * 15360])]));
    await refused(mp4File({ tracks: [defaultVideoTrack({ extraStbl: [cslg] })] }), "bad_video");
  });
});

describe("sample groups of every version (round 2: AMBUILD-SOL-008)", () => {
  test("sgpd version 2 reads its default length and its per-entry lengths as version 1 does (AMBUILD-SOL-008)", async () => {
    const full = (version: number, flags = 0) => fields([1, version], [3, flags]);
    const sbgp = bx("sbgp", Buffer.concat([full(0), Buffer.from("roll"), fields([4, 1], [4, 60], [4, 1])]));
    // The reviewer's AAC roll group: default_length 2, default index 0, one 2-byte description.
    const fixed = bx("sgpd", Buffer.concat([full(2), Buffer.from("roll"), fields([4, 2], [4, 0], [4, 1]), Buffer.from([0xff, 0xff])]));
    await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ extraStbl: [fixed, sbgp] })] }));
    const perEntry = bx("sgpd", Buffer.concat([full(2), Buffer.from("roll"), fields([4, 0], [4, 0], [4, 1], [4, 2]), Buffer.from([0xff, 0xff])]));
    await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ extraStbl: [perEntry, sbgp] })] }));
  });
});
