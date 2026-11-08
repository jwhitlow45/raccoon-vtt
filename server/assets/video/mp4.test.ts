import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import { AssetError } from "../errors.ts";
import { capped, checkVideoBytes } from "./check.ts";
import { audioSpecificConfig, avcCodecString, readSampleSizes } from "./mp4.ts";
import {
  FFMPEG_AAC_LC,
  IDENTITY_MATRIX,
  ROWS,
  SECRETS,
  alisRef,
  appleLocationMeta,
  audioEntry,
  audioEntryV1,
  av1CBytes,
  avcCBytes,
  bx,
  clapBox,
  dOpsBytes,
  defaultSoundTrack,
  defaultVideoTrack,
  esdsBytes,
  fields,
  filler,
  iphoneMov,
  locationUdta,
  metadataTrack,
  mp4File,
  nclcBox,
  paspBox,
  taptBox,
  tkhdMatrix,
  visualEntry,
  waveBox,
  type Box,
  type Mp4Options,
  type Mp4Track,
} from "./videoTestutil.ts";
import { Budget, Edits, Tally } from "./window.ts";

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
  test("a file without ftyp, which the sniff names a MOV, and the ISO containers that are not videos are video_type", async () => {
    const plain = mp4File();
    await refused(plain.subarray(plain.readUInt32BE(0)), "video_type");
    await refused(mp4File({ brand: "M4A " }), "video_type");
    await refused(mp4File({ brand: "3gp5" }), "video_type");
  });

  test("HEVC is video_hevc, and MPEG-4 Part 2 and AC-3 are video_codec", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: visualEntry("hvc1", 640, 360, "") })] }), "video_hevc");
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

  test("a matrix off 4.1's rows, a tkhd size its pasp does not allow, a pasp past 2:1 and a real clap are video_geometry", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack({ matrix: [46341, 46341, 0, -46341 >>> 0, 46341, 0, 0, 0, 0x40000000] })] }), "video_geometry");
    await refused(mp4File({ tracks: [defaultVideoTrack({ tkhdSize: { width: 853, height: 360 } })] }), "video_geometry");
    await refused(mp4File({ tracks: [videoWith(bx("pasp", fields([4, 3], [4, 1])))] }), "video_geometry");
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
describe("the presentation interval comes from the composition times (round 2: AMBUILD-ASTRA-03, AMBUILD-SOL-009)", () => {
  test("one long sample shown 100 minutes late is past the cap, however its durations read", async () => {
    const late: Mp4Track = { ...defaultVideoTrack(), timescale: 1000, samples: [{ size: 30, delta: 600_000, cts: 6_000_000 }] };
    await refused(mp4File({ tracks: [late] }), "video_length");
  });

  test("a 2 s file whose frames show from 533 ms to 2533 ms, with no edit list, is video_layout", async () => {
    // Every frame 8192 ticks (533.33 ms at 15360) late: sixteen frames is a gap at the start, not a B-frame delay.
    const samples = Array.from({ length: 60 }, () => ({ size: 30, delta: 512, cts: 8192 }));
    await refused(mp4File({ tracks: [defaultVideoTrack({ samples })] }), "video_layout");
  });

  test("with no edit list, a first composition time of up to four frames stands in for the edit, and five is a gap (D-261102-732)", async () => {
    const late = (frames: number) => mp4File({ tracks: [defaultVideoTrack({ samples: Array.from({ length: 60 }, () => ({ size: 30, delta: 512, cts: frames * 512 })) })] });
    assert.equal((await checkVideoBytes(late(4))).facts.durationMs, 2000);
    await refused(late(5), "video_layout");
  });

  test("a 30 fps file with two B-frames and no edit list, its first frame 66 ms in, is accepted at the media's length", async () => {
    // Decode order I0 P3 B1 B2 P6 B4 B5 and so on, shown two frames (1024 ticks) late, as x264's B-pyramid does.
    const shown = (i: number) => (i === 0 || i > 57 ? i : i % 3 === 1 ? i + 2 : i - 1);
    const samples = Array.from({ length: 60 }, (_, i) => ({ size: 30, delta: 512, cts: 512 * (shown(i) - i) + 1024 }));
    const { facts } = await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ samples })] }));
    assert.equal(facts.durationMs, 2000);
    assert.equal(facts.fps, 30);
  });

  test("a first composition time past the fixed second is not taken as an implicit edit", async () => {
    // 2 fps, so sixteen frames are 8 s, every frame 1.5 s late: past the second, so it is a gap at the start.
    const samples = Array.from({ length: 6 }, () => ({ size: 30, delta: 7680, cts: 23_040 }));
    await refused(mp4File({ tracks: [defaultVideoTrack({ samples })] }), "video_layout");
    await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ samples: samples.map((x) => ({ ...x, cts: 7680 })) })] }));
  });

  test("an edit list that starts where the composition times start passes, and one that leaves a gap at the start is video_layout", async () => {
    const samples = Array.from({ length: 60 }, () => ({ size: 30, delta: 512, cts: 8192 }));
    await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ samples, edits: [{ segment: 2000, mediaTime: 8192 }] })] }));
    await refused(mp4File({ tracks: [defaultVideoTrack({ samples, edits: [{ segment: 2000, mediaTime: 0 }] })] }), "video_layout");
  });

  test("a first frame shown 500 ms late is a gap at the start, though the last frame ends where the durations say", async () => {
    // The first sample decodes for 8192 ticks and shows at 7680: nothing shows before 500 ms.
    const samples = Array.from({ length: 60 }, (_, i) => ({ size: 30, delta: i === 0 ? 8192 : 512, cts: i === 0 ? 7680 : 0 }));
    await refused(mp4File({ tracks: [defaultVideoTrack({ samples })] }), "video_layout");
    // An edit list that says the media starts at 0 keeps the gap, though its segment is the media's whole 2.5 s.
    await refused(mp4File({ tracks: [defaultVideoTrack({ samples, edits: [{ segment: 2500, mediaTime: 0 }] })] }), "video_layout");
    await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ samples: samples.map((x, i) => (i === 0 ? { ...x, cts: 0 } : x)) })] }));
  });

  test("the reorder allowance is sixteen typical frames, so one long last frame does not widen it", async () => {
    // 59 frames of 512 ticks and a last one of a second: sixteen typical frames are 8192 ticks, not sixteen seconds.
    const samples = (offset: number) => Array.from({ length: 60 }, (_, i) => ({ size: 30, delta: i === 59 ? 15360 : 512, cts: i === 10 ? offset : 0 }));
    await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ samples: samples(8192) })] }));
    await refused(mp4File({ tracks: [defaultVideoTrack({ samples: samples(9000) })] }), "video_layout");
  });
});

// Turned, stretched and cropped pictures, and QuickTime MOV (docs/design/design-v1-video-turns.md 4.1, 4.5, 5 and 13) ------

const U = 0x10000;
const W = 640 * U;
const H = 360 * U;

/** The video `tkhd`'s matrix and size in raw 16.16, read from file bytes: the first `tkhd` is the video's, version 0. */
function videoTkhd(bytes: Buffer): { matrix: number[]; width: number; height: number } {
  const matrix = bytes.indexOf("tkhd") + 4 + 4 + 36;
  return { matrix: Array.from({ length: 9 }, (_, i) => bytes.readUInt32BE(matrix + i * 4)), width: bytes.readUInt32BE(matrix + 36), height: bytes.readUInt32BE(matrix + 40) };
}

/** The stored bytes of the plain loop the writer builds by default, which every header-only rewrite of it must equal. */
const plainStored = async () => (await checkVideoBytes(mp4File())).zeroed;

/** The geometry fields of a check's facts, with the plain ones absent. */
const geometryOf = (facts: { turn?: number; mirror?: true; displayWidthPx?: number }) => ({
  ...(facts.turn !== undefined ? { turn: facts.turn } : {}),
  ...(facts.mirror !== undefined ? { mirror: facts.mirror } : {}),
  ...(facts.displayWidthPx !== undefined ? { displayWidthPx: facts.displayWidthPx } : {}),
});

/**
 * 4.1's table written out here on its own, so the parser's copy in
 * shared/videoGeometry.ts is checked against it: a, b, c, d, the turn, the
 * mirror and the one translation other than (0, 0) the row may carry.
 */
const TABLE: ReadonlyArray<readonly [number, number, number, number, 0 | 90 | 180 | 270, boolean, readonly [number, number] | null]> = [
  [1, 0, 0, 1, 0, false, null],
  [0, 1, -1, 0, 90, false, [H, 0]],
  [-1, 0, 0, -1, 180, false, [W, H]],
  [0, -1, 1, 0, 270, false, [0, W]],
  [-1, 0, 0, 1, 0, true, [W, 0]],
  [0, 1, 1, 0, 90, true, null],
  [1, 0, 0, -1, 180, true, [0, H]],
  [0, -1, -1, 0, 270, true, [H, W]],
];

describe("turned pictures (4.1's matrix)", () => {
  test("Android's portrait, the 90 row with no translation, is turn 90, stored with the identity at the coded size, byte for byte the plain file's", async () => {
    const bytes = mp4File({ tracks: [defaultVideoTrack({ matrix: tkhdMatrix(ROWS.turn90) })] });
    const { facts, zeroed } = await checkVideoBytes(bytes);
    assert.deepEqual(geometryOf(facts), { turn: 90 });
    assert.deepEqual({ w: facts.widthPx, h: facts.heightPx }, { w: 640, h: 360 }, "the coded size stays");
    assert.deepEqual(videoTkhd(zeroed), { matrix: IDENTITY_MATRIX, width: W, height: H });
    assert.ok(mdatOf(zeroed).equals(mdatOf(bytes)));
    assert.ok(zeroed.equals(await plainStored()));
  });

  test("every row of the table, with no translation and with its own, gives the table's turn and mirror", async () => {
    const plain = await plainStored();
    for (const [a, b, c, d, turn, mirror, shift] of TABLE) {
      for (const [tx, ty] of [[0, 0] as const, ...(shift ? [shift] : [])]) {
        const { facts, zeroed } = await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ matrix: tkhdMatrix({ a, b, c, d }, tx, ty) })] }));
        const row = `${[a, b, c, d].join(" ")} at (${tx / U}, ${ty / U})`;
        assert.deepEqual(geometryOf(facts), { ...(turn ? { turn } : {}), ...(mirror ? { mirror: true } : {}) }, row);
        assert.ok(zeroed.equals(plain), `${row} stored plain`);
      }
    }
  });

  test("another row's translation, a translation by a pixel, a scale, a skew, 45 degrees, u, v or w off, a turned mvhd and a turned tkhd size are video_geometry", async () => {
    const cases: Array<[string, Partial<Mp4Track>]> = [
      ["(W, 0) on the 90 row", { matrix: tkhdMatrix(ROWS.turn90, W, 0) }],
      ["(H, 0) on the 180 row", { matrix: tkhdMatrix(ROWS.turn180, H, 0) }],
      ["a pixel's translation", { matrix: tkhdMatrix({ a: 1, b: 0, c: 0, d: 1 }, U, 0) }],
      ["scale 2", { matrix: [2 * U, 0, 0, 0, 2 * U, 0, 0, 0, 0x40000000] }],
      ["a skew", { matrix: [U, U, 0, 0, U, 0, 0, 0, 0x40000000] }],
      ["45 degrees", { matrix: [46341, 46341, 0, -46341, 46341, 0, 0, 0, 0x40000000] }],
      ["u off", { matrix: [U, 0, 1, 0, U, 0, 0, 0, 0x40000000] }],
      ["v off", { matrix: [U, 0, 0, 0, U, 1, 0, 0, 0x40000000] }],
      ["w off", { matrix: [U, 0, 0, 0, U, 0, 0, 0, 0x40000001] }],
      ["tkhd holding the turned size", { matrix: tkhdMatrix(ROWS.turn90), tkhdSize: { width: 360, height: 640 } }],
      ["tkhd a pixel taller", { tkhdSize: { width: 640, height: 361 } }],
    ];
    for (const [what, track] of cases) {
      await assert.rejects(checkVideoBytes(mp4File({ tracks: [defaultVideoTrack(track)] })), (err: unknown) => err instanceof AssetError && err.code === "video_geometry", what);
    }
    // mvhd stays the identity: its matrix turns every track at once, which no browser reads alike (3).
    const bytes = Buffer.from(mp4File());
    const mvhd = bytes.indexOf("mvhd") + 4 + 4 + 36;
    for (const [i, v] of tkhdMatrix(ROWS.turn90).entries()) bytes.writeUInt32BE(v >>> 0, mvhd + i * 4);
    await refused(bytes, "video_geometry");
  });

  test("a turn is checked again on what it shows: 4096 x 2025 turned is 2025 x 4096, inside the caps", async () => {
    const big = defaultVideoTrack({ width: 4096, height: 2025, matrix: tkhdMatrix(ROWS.turn270) });
    assert.equal((await checkVideoBytes(mp4File({ tracks: [big] }))).facts.turn, 270);
  });
});

describe("stretched pictures (4.1's size)", () => {
  const entry = (width: number, height: number, ...kids: Box[]) => visualEntry("avc1", width, height, "", bx("avcC", avcCBytes()), ...kids);
  const stretched = (pasp: Box | null, tkhdRaw: { width: number; height: number } = { width: W, height: H }, o: Partial<Mp4Track> = {}) =>
    mp4File({ tracks: [defaultVideoTrack({ entry: entry(640, 360, ...(pasp ? [pasp] : [])), tkhdRaw, ...o })] });

  test("pasp 4:3 with tkhd at the coded width or at FFmpeg's rounded 16.16, and a tkhd-only stretch, are 853 wide, stored 1:1 at the coded size", async () => {
    const plain = (await checkVideoBytes(stretched(paspBox(1, 1)))).zeroed;
    const plainNoPasp = (await checkVideoBytes(stretched(null))).zeroed;
    const ffmpeg = { width: Math.round((W * 4) / 3), height: H };
    for (const [what, bytes, twin] of [
      ["pasp 4:3, tkhd coded", stretched(paspBox(4, 3)), plain],
      ["pasp 4:3, tkhd stretched", stretched(paspBox(4, 3), ffmpeg), plain],
      ["tkhd stretched alone", stretched(null, ffmpeg), plainNoPasp],
    ] as const) {
      const { facts, zeroed } = await checkVideoBytes(bytes);
      assert.deepEqual(geometryOf(facts), { displayWidthPx: 853 }, what);
      assert.equal(videoTkhd(zeroed).width, W, `${what}: tkhd at the coded width`);
      assert.ok(zeroed.equals(twin), `${what}: stored as the plain twin`);
    }
    assert.ok(plain.includes(Buffer.concat([Buffer.from("pasp"), fields([4, 1], [4, 1])])));
  });

  test("pasp 3:1, 0:3, 70000:1 and 70000:69999, tkhd 2 px off the pasp, a square pasp with a stretched tkhd, and flag 0x8 with any stretch are video_geometry", async () => {
    const ffmpeg = { width: Math.round((W * 4) / 3), height: H };
    for (const [what, bytes] of [
      ["3:1", stretched(paspBox(3, 1))],
      ["0:3", stretched(paspBox(0, 3))],
      ["70000:1", stretched(paspBox(70_000, 1))],
      ["70000:69999", stretched(paspBox(70_000, 69_999))],
      ["2 px off", stretched(paspBox(4, 3), { width: ffmpeg.width + 2 * U, height: H })],
      ["square pasp, tkhd stretched", stretched(paspBox(1, 1), ffmpeg)],
      ["0:0, tkhd stretched", stretched(paspBox(0, 0), ffmpeg)],
      ["flag 0x8 with pasp 4:3", stretched(paspBox(4, 3), { width: W, height: H }, { tkhdFlags: 0xb })],
      ["flag 0x8 with tkhd stretched", stretched(null, ffmpeg, { tkhdFlags: 0xb })],
      ["1:2 past by a tkhd pixel", stretched(null, { width: W / 2 - U, height: H })],
    ] as const) {
      await assert.rejects(checkVideoBytes(bytes), (err: unknown) => err instanceof AssetError && err.code === "video_geometry", what);
    }
    // Within a pixel passes, flag 0x8 on a plain file passes, and 0:0 with the coded width is square, as before.
    assert.equal((await checkVideoBytes(stretched(paspBox(4, 3), { width: ffmpeg.width + U, height: H }))).facts.displayWidthPx, 853);
    assert.equal((await checkVideoBytes(stretched(paspBox(1, 1), { width: W, height: H }, { tkhdFlags: 0xb }))).facts.displayWidthPx, undefined);
    assert.equal((await checkVideoBytes(stretched(paspBox(0, 0)))).facts.displayWidthPx, undefined);
    assert.equal((await checkVideoBytes(stretched(paspBox(2, 1)))).facts.displayWidthPx, 1280, "2:1 itself");
    assert.equal((await checkVideoBytes(stretched(paspBox(1, 2)))).facts.displayWidthPx, 320, "1:2 itself");
  });

  test("stretched past the area cap or past 4096 a side is video_size", async () => {
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: entry(2048, 2048, paspBox(2, 1)), width: 2048, height: 2048 })] }), "video_size");
    await refused(mp4File({ tracks: [defaultVideoTrack({ entry: entry(3000, 1000, paspBox(3, 2)), width: 3000, height: 1000 })] }), "video_size");
    // 2880 x 2160 at 4:3 is 3840 x 2160, the cap itself.
    assert.equal((await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ entry: entry(2880, 2160, paspBox(4, 3)), width: 2880, height: 2160 })] }))).facts.displayWidthPx, 3840);
  });

  test("a clap that crops nothing goes as free, and one that crops 8 px, moves the picture or has no denominator is video_geometry (D-261102-895)", async () => {
    for (const clap of [clapBox(640, 1, 360, 1), clapBox(1280, 2, 720, 2)]) {
      const bytes = stretched(clap);
      const at = bytes.indexOf("clap");
      const { zeroed } = await checkVideoBytes(bytes);
      assert.equal(zeroed.subarray(at, at + 4).toString("latin1"), "free");
      assert.ok(zeroed.subarray(at + 4, at + 36).every((b) => b === 0));
    }
    for (const clap of [clapBox(632, 1, 360, 1), clapBox(640, 1, 352, 1), clapBox(640, 1, 360, 1, 1, 1), clapBox(640, 1, 360, 1, 0, 1, -1, 1), clapBox(640, 1, 360, 1, 0, 0), clapBox(0, 0, 360, 1)]) {
      await refused(stretched(clap), "video_geometry");
    }
    await refused(stretched(bx("clap", Buffer.alloc(36))), "video_geometry");
  });
});

describe("QuickTime MOV (4.5)", () => {
  const STRINGS = [SECRETS.location, SECRETS.face, SECRETS.device, "com.apple.quicktime.location.ISO6709", "com.apple.quicktime.detected-face", "com.apple.quicktime.model"];

  test("an iPhone's Most Compatible MOV is an MP4 turned 90, with no place, face or phone left, its metadata samples zero and every kept sample as it was", async () => {
    const bytes = iphoneMov();
    for (const s of STRINGS) assert.ok(bytes.includes(s), `the fixture holds ${s}`);
    const { facts, zeroed, edits } = await checkVideoBytes(bytes);
    assert.deepEqual({ container: facts.container, audio: facts.audio, ...geometryOf(facts) }, { container: "mp4", audio: "mp4a.40.2", turn: 90 });
    assert.equal(zeroed.length, bytes.length);
    for (const s of STRINGS) assert.equal(zeroed.includes(s), false, `${s} survived`);
    assert.ok(edits.scrubs.length >= 2, "both metadata tracks' samples scrubbed");
    assert.ok(edits.kept.length >= 2, "the picture's and the sound's chunks recorded for the scrub's own guard");
    for (const s of edits.scrubs) assert.ok(zeroed.subarray(s.start, s.end).every((b) => b === 0), "a scrubbed range holds a byte");
    for (const k of edits.kept) assert.ok(zeroed.subarray(k.start, k.end).equals(bytes.subarray(k.start, k.end)), "a kept sample changed");
    // The rest of the media data is as it was too: only the scrubs reach into it.
    const expected = Buffer.from(bytes);
    for (const s of edits.scrubs) expected.fill(0, s.start, s.end);
    assert.ok(mdatOf(zeroed).equals(mdatOf(expected)));
    // The two metadata traks went as free, and the MOV keeps its brand.
    assert.equal(zeroed.toString("latin1").split("trak").length - 1, 2);
    assert.equal(zeroed.subarray(8, 12).toString("latin1"), "qt  ");
    assert.equal(zeroed.subarray(16, 20).toString("latin1"), "qt  ", "qt kept as a compatible brand in a MOV");
    const again = await checkVideoBytes(zeroed);
    assert.ok(again.zeroed.equals(zeroed), "the stored file checks again to the same bytes");
    assert.equal(again.edits.scrubs.length, 0, "and has no metadata track left to scrub");
  });

  const mov = (o: { video?: Partial<Mp4Track>; sound?: Partial<Mp4Track> | null; brand?: string; tracks?: Mp4Track[] } = {}) =>
    mp4File({
      brand: o.brand ?? "qt  ",
      compatible: [o.brand ?? "qt  "],
      tracks: [
        defaultVideoTrack({ dataRefs: [alisRef()], ...o.video }),
        ...(o.sound === null ? [] : [defaultSoundTrack({ entry: audioEntryV1("mp4a", 2, 48000, {}, waveBox()), ...o.sound })]),
        ...(o.tracks ?? []),
      ],
    });
  const v1 = (counts: Parameters<typeof audioEntryV1>[3], ...kids: Box[]) => ({ entry: audioEntryV1("mp4a", 2, 48000, counts, ...(kids.length ? kids : [waveBox()])) });

  test("only under qt: alis, a version 1 sound entry and wave are refused in an ISO file, nclc goes as free there, and qt as a compatible brand is zeroed (D-261102-894)", async () => {
    assert.equal((await checkVideoBytes(mov())).facts.audio, "mp4a.40.2");
    await refused(mov({ brand: "isom", sound: null }), "bad_video");
    await refused(mov({ brand: "isom", video: { dataRefs: undefined } }), "video_sound");
    await refused(mov({ brand: "isom", video: { dataRefs: undefined }, sound: v1({}, bx("esds", esdsBytes())) }), "video_sound");
    const wave = mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack({ entry: audioEntry("mp4a", 2, 48000, waveBox()) })] });
    await refused(wave, "video_sound");
    const nclc = mp4File({ tracks: [videoWith(nclcBox())] });
    const at = nclc.indexOf("colrnclc");
    const { zeroed } = await checkVideoBytes(nclc);
    assert.equal(zeroed.subarray(at, at + 4).toString("latin1"), "free");
    const listed = mp4File({ compatible: ["isom", "qt  "] });
    assert.ok((await checkVideoBytes(listed)).zeroed.subarray(16, 24).equals(Buffer.concat([Buffer.from("isom"), Buffer.alloc(4)])));
    // An uneven tapt in an ISO file is one more unlisted box.
    assert.equal((await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack({ extraTrak: [taptBox([1920, 1080])] })] }))).facts.widthPx, 640);
  });

  test("alis must be the file itself: its flag set and nothing after it", async () => {
    await refused(mov({ video: { dataRefs: [bx("alis", fields([1, 0], [3, 0]))] } }), "bad_video");
    await refused(mov({ video: { dataRefs: [bx("alis", Buffer.concat([fields([1, 0], [3, 1]), Buffer.from(SECRETS.location)]))] } }), "bad_video");
  });

  test("nclc is kept in a MOV and read as nclx is: PQ and HLG are video_hdr, and one beside an nclx is bad_video", async () => {
    const kept = await checkVideoBytes(mov({ video: { entry: visualEntry("avc1", 640, 360, "", bx("avcC", avcCBytes()), nclcBox(1, 1, 1)) } }));
    assert.ok(kept.zeroed.includes(Buffer.concat([Buffer.from("colrnclc"), fields([2, 1], [2, 1], [2, 1])])));
    for (const transfer of [16, 18]) await refused(mov({ video: { entry: visualEntry("avc1", 640, 360, "", bx("avcC", avcCBytes()), nclcBox(9, transfer, 9)) } }), "video_hdr");
    await refused(mov({ video: { entry: visualEntry("avc1", 640, 360, "", bx("avcC", avcCBytes()), nclcBox(0x101, 1, 1)) } }), "bad_video");
    await refused(mov({ video: { entry: visualEntry("avc1", 640, 360, "", bx("avcC", avcCBytes()), bx("colr", Buffer.concat([Buffer.from("nclc"), fields([2, 1], [2, 1], [2, 1], [1, 0])]))) } }), "bad_video");
    const both = visualEntry("avc1", 640, 360, "", bx("avcC", avcCBytes()), nclcBox(), bx("colr", Buffer.concat([Buffer.from("nclx"), fields([2, 1], [2, 1], [2, 1], [1, 0])])));
    await refused(mov({ video: { entry: both } }), "bad_video");
  });

  test("wave is kept only as frma, an empty mp4a, the esds and the terminator, in that order", async () => {
    const esds = bx("esds", esdsBytes());
    const term: Box = { type: "\0\0\0\0" };
    const shapes: Array<[string, Box]> = [
      ["no frma", bx("wave", undefined, bx("mp4a", Buffer.alloc(4)), esds, term)],
      ["frma naming another codec", bx("wave", undefined, bx("frma", Buffer.from("aac ")), bx("mp4a", Buffer.alloc(4)), esds, term)],
      ["mp4a holding text", bx("wave", undefined, bx("frma", Buffer.from("mp4a")), bx("mp4a", Buffer.from("Mal!")), esds, term)],
      ["a box more", waveBox(esdsBytes(), bx("udta", Buffer.from(SECRETS.udta)))],
      ["a box after the terminator", bx("wave", undefined, bx("frma", Buffer.from("mp4a")), bx("mp4a", Buffer.alloc(4)), esds, term, bx("udta", Buffer.from(SECRETS.udta)))],
      ["no terminator", bx("wave", undefined, bx("frma", Buffer.from("mp4a")), bx("mp4a", Buffer.alloc(4)), esds)],
      ["esds first", bx("wave", undefined, esds, bx("frma", Buffer.from("mp4a")), bx("mp4a", Buffer.alloc(4)), term)],
      ["a terminator with a payload", bx("wave", undefined, bx("frma", Buffer.from("mp4a")), bx("mp4a", Buffer.alloc(4)), esds, { type: "\0\0\0\0", head: Buffer.alloc(4) })],
    ];
    for (const [what, wave] of shapes) {
      await assert.rejects(checkVideoBytes(mov({ sound: v1({}, wave) })), (err: unknown) => err instanceof AssetError && err.code === "video_sound", what);
    }
    // The esds in the entry itself is the other way, and in both places is two configurations.
    assert.equal((await checkVideoBytes(mov({ sound: v1({}, esds) }))).facts.audio, "mp4a.40.2");
    await refused(mov({ sound: v1({}, esds, waveBox()) }), "bad_video");
  });

  test("a version 1 entry's counts are bounded and kept, its compression ID 0 or -2, and a version 2 entry is video_sound (D-261102-899)", async () => {
    const counts = { samplesPerPacket: 1024, bytesPerPacket: 2, bytesPerFrame: 4, bytesPerSample: 2 };
    const { zeroed } = await checkVideoBytes(mov({ sound: v1(counts) }));
    assert.ok(zeroed.includes(fields([4, 1024], [4, 2], [4, 4], [4, 2])), "the counts are kept");
    assert.equal((await checkVideoBytes(mov({ sound: v1({ samplesPerPacket: 2048, compressionId: 0 }) }))).facts.audio, "mp4a.40.2");
    for (const [what, bad] of [
      ["1000 samples a packet", { samplesPerPacket: 1000 }],
      ["65536 bytes a frame", { bytesPerFrame: 0x10000 }],
      ["65536 bytes a packet", { bytesPerPacket: 0x10000 }],
      ["65536 bytes a sample", { bytesPerSample: 0x10000 }],
      ["compression ID 1", { compressionId: 1 }],
      ["version 2", { version: 2 }],
    ] as const) {
      await assert.rejects(checkVideoBytes(mov({ sound: v1(bad) })), (err: unknown) => err instanceof AssetError && err.code === "video_sound", what);
    }
  });

  test("a tapt at tkhd's size either way round goes as free, and an uneven one, or one with more or fewer sizes, is video_geometry", async () => {
    for (const tapt of [taptBox([640, 360]), taptBox([360, 640]), taptBox([360, 640], [360, 640], [640, 360])]) {
      const bytes = mov({ video: { extraTrak: [tapt] } });
      const at = bytes.indexOf("tapt");
      const { zeroed } = await checkVideoBytes(bytes);
      assert.equal(zeroed.subarray(at, at + 4).toString("latin1"), "free");
    }
    const sizes = (type: string) => bx(type, fields([4, 0], [4, W], [4, H]));
    for (const tapt of [taptBox([1920, 1080]), taptBox([640, 360], [640, 360], [640, 361]), bx("tapt", undefined, sizes("clef"), sizes("prof")), bx("tapt", undefined, sizes("clef"), sizes("prof"), sizes("enof"), sizes("enof")), bx("tapt", undefined, sizes("clef"), sizes("prof"), sizes("enof"), bx("udta", Buffer.from(SECRETS.udta)))]) {
      await refused(mov({ video: { extraTrak: [tapt] } }), "video_geometry");
    }
  });

  test("an anamorphic MOV's tapt, its enof the coded size either way round beside a clef and prof at tkhd's, goes as free (AMROT-O-05)", async () => {
    const coded = (w: number, h: number) => visualEntry("avc1", w, h, "", bx("avcC", avcCBytes()), bx("pasp", fields([4, 4], [4, 3])));
    for (const enof of [[480, 360], [360, 480]] as Array<[number, number]>) {
      const bytes = mov({ video: { entry: coded(480, 360), tkhdSize: { width: 640, height: 360 }, extraTrak: [taptBox([640, 360], [640, 360], enof)] } });
      const at = bytes.indexOf("tapt");
      const { zeroed } = await checkVideoBytes(bytes);
      assert.equal(zeroed.subarray(at, at + 4).toString("latin1"), "free", `enof ${enof}`);
    }
    // An enof that is neither the coded size nor tkhd's, or a clef or prof unlike tkhd's, is still uneven.
    await refused(mov({ video: { entry: coded(480, 360), tkhdSize: { width: 640, height: 360 }, extraTrak: [taptBox([640, 360], [640, 360], [481, 360])] } }), "video_geometry");
    await refused(mov({ video: { entry: coded(480, 360), tkhdSize: { width: 640, height: 360 }, extraTrak: [taptBox([480, 360], [640, 360], [480, 360])] } }), "video_geometry");
    await refused(mov({ video: { entry: coded(480, 360), tkhdSize: { width: 640, height: 360 }, extraTrak: [taptBox([640, 360], [480, 360], [480, 360])] } }), "video_geometry");
  });

  test("HEVC and Dolby Vision are video_hevc before an uneven tapt or the track count, and ProRes is video_codec", async () => {
    for (const type of ["hvc1", "hev1", "dvh1", "dvhe"]) await refused(mov({ video: { entry: visualEntry(type, 640, 360, "") } }), "video_hevc");
    await refused(mov({ video: { entry: visualEntry("dvh1", 640, 360, ""), extraTrak: [taptBox([1920, 1080])] } }), "video_hevc");
    // Where an iPhone writes it, before mdia, so it is read before the sample entry.
    await refused(mov({ video: { entry: visualEntry("hvc1", 640, 360, ""), beforeMdia: [taptBox([1920, 1080])] } }), "video_hevc");
    await refused(mov({ video: { beforeMdia: [taptBox([1920, 1080])] } }), "video_geometry");
    await refused(mov({ video: { entry: visualEntry("hvc1", 640, 360, "") }, tracks: [defaultSoundTrack(), defaultSoundTrack()] }), "video_hevc");
    await refused(mov({ video: { entry: visualEntry("apcn", 640, 360, "") } }), "video_codec");
  });

  describe("timed metadata tracks, in both brands (D-261102-893)", () => {
    const face = (o: Partial<Mp4Track> = {}) => metadataTrack({ samples: [{ size: 40, delta: 600 }], ...o });
    const withMeta = (...meta: Mp4Track[]) => mp4File({ tracks: [defaultVideoTrack(), ...meta] });

    test("an ISO file's are dropped too, and up to eight of them", async () => {
      const { zeroed, edits } = await checkVideoBytes(withMeta(face(), face()));
      assert.equal(edits.scrubs.length, 2);
      assert.equal(zeroed.toString("latin1").split("trak").length - 1, 1);
      await checkVideoBytes(withMeta(...Array.from({ length: 8 }, () => face())));
      await refused(withMeta(...Array.from({ length: 9 }, () => face())), "video_tracks");
    });

    test("a meta track with another entry, or two entries, is video_tracks", async () => {
      await refused(withMeta({ ...face(), entry: audioEntry("mp4a", 2, 48000, bx("esds", esdsBytes())) }), "video_tracks");
      const two = face();
      const bytes = Buffer.from(withMeta(two));
      const stsd = bytes.indexOf("stsd", bytes.indexOf("mebx") - 40);
      bytes.writeUInt32BE(2, stsd + 8);
      await refused(bytes, "video_tracks");
    });

    test("a metadata chunk over a video sample, across two mdats, outside any mdat, or past 60,000 samples in all is bad_video", async () => {
      await refused(withMeta(face({ chunkOffsets: ({ mdat }) => [mdat.start + 5] })), "bad_video");
      await refused(mp4File({ tracks: [defaultVideoTrack(), face({ chunkOffsets: ({ mdat }) => [mdat.end - 4] })], afterMdat: [bx("mdat", filler(100))] }), "bad_video");
      await refused(withMeta(face({ chunkOffsets: () => [40] })), "bad_video");
      const many = (n: number) => metadataTrack({ samples: Array.from({ length: n }, () => ({ size: 0, delta: 0 })) });
      await checkVideoBytes(withMeta(many(30_000), many(30_000)));
      await refused(withMeta(many(30_000), many(30_001)), "bad_video");
      // A chunk that only touches a video sample, or sits in a second mdat, is its own.
      await checkVideoBytes(withMeta(face({ chunkOffsets: ({ mdat }) => [mdat.start + 120 + 59 * 40] })));
      await checkVideoBytes(mp4File({ tracks: [defaultVideoTrack(), face({ chunkOffsets: ({ mdat }) => [mdat.end + 8] })], afterMdat: [bx("mdat", filler(100))] }));
    });

    test("a metadata track must end by the picture's end: its edits, an empty first one allowed, or its media", async () => {
      await checkVideoBytes(withMeta(face({ edits: [{ segment: 500, mediaTime: -1 }, { segment: 1500, mediaTime: 0 }] })));
      const late = (meta: Mp4Track) => mp4File({ tracks: [defaultVideoTrack(), meta], movieDuration: 2000 });
      await refused(late(face({ samples: [{ size: 40, delta: 2400 }] })), "video_layout");
      await refused(late(face({ edits: [{ segment: 2000, mediaTime: -1 }, { segment: 2000, mediaTime: 0 }] })), "video_layout");
      await refused(withMeta(face({ edits: [{ segment: 500, mediaTime: 0 }, { segment: 500, mediaTime: -1 }] })), "video_layout");
      await refused(withMeta(face({ edits: Array.from({ length: 5 }, () => ({ segment: 100, mediaTime: 0 })) })), "video_layout");
      await refused(withMeta(face({ edits: [{ segment: 500, mediaTime: 0, rate: 0x20000 }] })), "video_layout");
      await refused(withMeta(face({ edits: [{ segment: 500, mediaTime: -2 }] })), "video_layout");
    });

    /*
     * Limits before memory (ANIMROT-ASTRA-01): a 20-byte stsz may claim
     * 60,000 samples, so each limit holds before the tables it guards are
     * read, and a size every sample shares is never spread into a table.
     */

    test("a ninth metadata track, a second picture or a second sound is video_tracks before any of its tables is read (ANIMROT-ASTRA-01)", async () => {
      // The last trak's stsz claims more samples than any track may hold, so reading its tables would answer bad_video.
      const unreadable = (bytes: Buffer) => {
        const out = Buffer.from(bytes);
        out.writeUInt32BE(0xffffffff, out.lastIndexOf("stsz", out.indexOf("mdat")) + 12);
        return out;
      };
      await refused(unreadable(withMeta(...Array.from({ length: 8 }, () => face()))), "bad_video");
      await refused(unreadable(withMeta(...Array.from({ length: 9 }, () => face()))), "video_tracks");
      await refused(unreadable(mp4File({ tracks: [defaultVideoTrack(), defaultVideoTrack()] })), "video_tracks");
      await refused(unreadable(mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack(), defaultSoundTrack()] })), "video_tracks");
      // A handler of no kind kept is refused by name, though its entry would pass for a timecode's.
      const timecodeEntry = bx("tmcd", fields(Buffer.alloc(6), [2, 1], [4, 0], [4, 0], [4, 30000], [4, 1001], [1, 30], [1, 0]));
      await refused(mp4File({ tracks: [defaultVideoTrack(), { handler: "text", entry: timecodeEntry, timescale: 30000, samples: [{ size: 4, delta: 60060 }] }] }), "video_tracks");
      // And a file with no picture at all.
      await refused(mp4File({ tracks: [defaultSoundTrack()] }), "video_tracks");
    });

    test("every dropped track's samples are counted before a size is read, and a shared size stays one number (ANIMROT-ASTRA-01)", () => {
      const tracksCode = (err: unknown) => err instanceof AssetError && err.code === "video_tracks";
      const nearlyFull = () => {
        const tally = new Tally(60_000, "video_tracks");
        tally.add(59_999);
        return tally;
      };
      // Tables cut short, claiming more than the tally has left: the tally refuses before the table is looked at.
      assert.throws(() => readSampleSizes("stsz", fields([4, 0], [4, 2]), nearlyFull()), tracksCode);
      assert.throws(() => readSampleSizes("stz2", fields([3, 0], [1, 16], [4, 2]), nearlyFull()), tracksCode);
      assert.deepEqual(readSampleSizes("stsz", fields([4, 40], [4, 60_000])), { count: 60_000, fixed: 40 });
      assert.deepEqual(readSampleSizes("stsz", fields([4, 0], [4, 2], [4, 7], [4, 9])), { count: 2, table: [7, 9] });
    });

    test("tracks whose samples share one stsz size read as their tables would (ANIMROT-ASTRA-01)", async () => {
      // moov last, so both files hold their samples at the same offsets.
      const file = (sharedSize: boolean) =>
        mp4File({
          moovLast: true,
          tracks: [
            defaultVideoTrack({ samples: Array.from({ length: 60 }, () => ({ size: 40, delta: 512 })), sharedSize }),
            face({ samples: Array.from({ length: 3 }, () => ({ size: 40, delta: 200 })), chunkSamples: 2, sharedSize }),
          ],
        });
      const table = await checkVideoBytes(file(false));
      const shared = await checkVideoBytes(file(true));
      // The bitrate alone differs, since a shared size makes a shorter file.
      assert.deepEqual({ ...shared.facts, kbps: 0 }, { ...table.facts, kbps: 0 });
      assert.deepEqual(shared.edits.scrubs, table.edits.scrubs);
      assert.deepEqual(shared.edits.kept, table.edits.kept);
      assert.equal(shared.edits.scrubs.length, 2);
    });

    test("a chunk claiming more samples than the track has left is bad_video at once, not after a walk of its claim (ANIMROT-ASTRA-01)", async () => {
      class Counting extends Budget {
        looks = 0;
        override check(): void {
          this.looks++;
          super.check();
        }
      }
      for (const sharedSize of [false, true]) {
        const bytes = Buffer.from(mp4File({ tracks: [defaultVideoTrack({ sharedSize: sharedSize || undefined, samples: Array.from({ length: 60 }, () => ({ size: 40, delta: 512 })) })] }));
        // The one stsc run's samples per chunk.
        bytes.writeUInt32BE(0x7fffffff, bytes.indexOf("stsc") + 16);
        const budget = new Counting();
        await assert.rejects(checkVideoBytes(bytes, { budget }), (err: unknown) => err instanceof AssetError && err.code === "bad_video");
        assert.ok(budget.looks < 200, `${budget.looks} looks at the budget`);
      }
    });

    test("thousands of small metadata traks, each claiming 60,000 samples of one shared size, are refused in a small heap (ANIMROT-ASTRA-01)", async () => {
      const claim = metadataTrack({ samples: Array.from({ length: 60_000 }, () => ({ size: 1, delta: 0 })), sharedSize: true });
      const donor = mp4File({ tracks: [defaultVideoTrack(), claim] });
      const at = donor.lastIndexOf("trak", donor.indexOf("mdat")) - 4;
      const trak: Box = { type: "trak", head: donor.subarray(at + 8, at + donor.readUInt32BE(at)) };
      const bytes = mp4File({ tracks: [defaultVideoTrack(), ...Array.from({ length: 8 }, () => face())], inMoov: Array.from({ length: 2_000 }, () => trak) });
      assert.ok(bytes.length < 1_500_000, `${bytes.length} bytes`);
      const dir = await mkdtemp(join(tmpdir(), "rvtt-mp4-"));
      try {
        const path = join(dir, "many.mp4");
        await writeFile(path, bytes);
        // Spread into tables, the claims would need about a gigabyte: far past this heap.
        const code = `
          const { readFile } = await import("node:fs/promises");
          const { checkVideoBytes } = await import(process.env.CHECK);
          try { await checkVideoBytes(await readFile(process.env.VIDEO)); console.log("accepted"); }
          catch (err) { console.log(err.code ?? String(err)); }
        `;
        const r = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", code], {
          env: { ...process.env, CHECK: new URL("./check.ts", import.meta.url).href, VIDEO: path },
          timeout: 30_000,
          encoding: "utf8",
        });
        assert.equal(r.signal, null, "the check ended on its own");
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), "video_tracks");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
