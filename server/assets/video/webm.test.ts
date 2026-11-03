import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import { AssetError } from "../errors.ts";
import { checkVideoBytes } from "./check.ts";
import {
  OPUS_20MS,
  SECRETS,
  allEbml,
  av1CBytes,
  bin,
  block,
  el,
  encodeEbml,
  encodeWebm,
  findEbml,
  float,
  segmentOf,
  sint,
  str,
  uint,
  webmFile,
  webmTree,
  webmWithSecrets,
  type Ebml,
  type WebmOptions,
} from "./videoTestutil.ts";
import { EBML_ID as I } from "./webm.ts";
import { Budget } from "./window.ts";

/**
 * The WebM header check, one case per check in
 * docs/design/design-v1-animated-maps.md 10 and per 4.5 code, on files the
 * test writer builds byte by byte.
 */

async function refused(bytes: Buffer, code: string): Promise<void> {
  await assert.rejects(checkVideoBytes(bytes), (err: unknown) => {
    assert.ok(err instanceof AssetError, String(err));
    assert.equal(err.code, code, `refused as ${err.code}${err.cause ? ` (${String(err.cause)})` : ""}`);
    return true;
  });
}

function tree(o: WebmOptions = {}, change?: (t: Ebml[]) => void): Buffer {
  const t = webmTree(o);
  change?.(t);
  return encodeWebm(t);
}

const videoOf = (t: Ebml[]) => findEbml(segmentOf(t), I.Tracks, I.TrackEntry, I.Video);
const trackOf = (t: Ebml[]) => findEbml(segmentOf(t), I.Tracks, I.TrackEntry);

/** 20 ms Opus blocks from `from` up to `to` ms. */
function soundBlocks(to: number, from = 0): Array<{ ms: number }> {
  return Array.from({ length: Math.round((to - from) / 20) }, (_, i) => ({ ms: from + i * 20 }));
}

describe("a plain WebM", () => {
  test("gives its size, codec, peak rate and length, and keeps its length and every block", async () => {
    const bytes = webmFile();
    const { facts, zeroed, edits } = await checkVideoBytes(bytes);
    assert.deepEqual(facts, { container: "webm", widthPx: 640, heightPx: 360, video: "vp09.00.21.08", fps: 30, durationMs: 2001, kbps: Math.round((bytes.length * 8) / 2001) });
    assert.equal(zeroed.length, bytes.length);
    assert.ok(edits.protected.length >= 60);
    for (const p of edits.protected) assert.ok(zeroed.subarray(p.start, p.end).equals(bytes.subarray(p.start, p.end)), "a block was written");
  });

  test("with Opus sound, the sound joins the facts as its own configuration", async () => {
    const { facts } = await checkVideoBytes(webmFile({ sound: { blocks: soundBlocks(2000) } }));
    assert.equal(facts.audio, "opus");
    assert.equal(facts.audioChannels, 2);
    assert.equal(facts.audioHz, 48000);
  });

  test("checked again, the stored file gives the same facts and no new edit", async () => {
    const first = await checkVideoBytes(encodeWebm(webmWithSecrets({ sound: { blocks: soundBlocks(2000) } })));
    const second = await checkVideoBytes(first.zeroed);
    assert.deepEqual(second.facts, first.facts);
    assert.ok(second.zeroed.equals(first.zeroed));
  });
});

describe("codec strings", () => {
  test("VP8 is vp8", async () => {
    assert.equal((await checkVideoBytes(webmFile({ codec: "V_VP8" }))).facts.video, "vp8");
  });

  test("VP9 takes profile, level and bit depth from CodecPrivate where present", async () => {
    const cp = Buffer.from([1, 1, 2, 2, 1, 31, 3, 1, 10]);
    assert.equal((await checkVideoBytes(webmFile({ codecPrivate: cp }))).facts.video, "vp09.02.31.10");
  });

  test("VP9 without CodecPrivate reads its key frame, and its level from the size and rate", async () => {
    assert.equal((await checkVideoBytes(webmFile({ width: 1920, height: 1080 }))).facts.video, "vp09.00.40.08");
  });

  test("VP9 whose first frame is not a key frame, with nothing in CodecPrivate, is bad_video", async () => {
    await refused(
      tree({}, (t) => {
        const first = findEbml(segmentOf(t), I.Cluster, I.SimpleBlock);
        first.data = Buffer.concat([first.data!.subarray(0, 4), Buffer.from([0x86, 0, 0, 0, 0, 0])]);
      }),
      "bad_video",
    );
  });

  test("AV1 builds av01.P.LLT.DD from its av1C", async () => {
    assert.equal((await checkVideoBytes(webmFile({ codec: "V_AV1", codecPrivate: av1CBytes() }))).facts.video, "av01.0.08M.08");
  });

  test("AV1 without av1C is bad_video (AM-ASTRA-10)", async () => {
    await refused(webmFile({ codec: "V_AV1" }), "bad_video");
  });

  test("an av1C holding a metadata OBU, which can carry text, is bad_video", async () => {
    await refused(webmFile({ codec: "V_AV1", codecPrivate: av1CBytes(Buffer.from([0x2a, 0x03, 0x04, 0x41, 0x42])) }), "bad_video");
  });

  test("a codec record with bytes left over is bad_video (AMQ-3)", async () => {
    await refused(webmFile({ codecPrivate: Buffer.from([1, 1, 0, 9]) }), "bad_video");
    await refused(webmFile({ sound: { blocks: soundBlocks(2000), codecPrivate: Buffer.concat([webmOpusHead(), Buffer.from([0])]) } }), "bad_video");
  });

  test("H.264 or HEVC in WebM is video_codec", async () => {
    await refused(webmFile({ codec: "V_MPEG4/ISO/AVC" }), "video_codec");
    await refused(webmFile({ codec: "V_MPEGH/ISO/HEVC" }), "video_codec");
  });
});

function webmOpusHead(): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "latin1");
  b[8] = 1;
  b[9] = 2;
  b.writeUInt32LE(48000, 12);
  return b;
}

describe("metadata is zeroed from an allowlist (section 7)", () => {
  test("no identifying string survives, every blanked range is zero and the length holds", async () => {
    const bytes = encodeWebm(webmWithSecrets());
    for (const s of [SECRETS.title, SECRETS.tag, SECRETS.void, SECRETS.name, SECRETS.attachment, SECRETS.chapter, SECRETS.crc, SECRETS.date]) assert.ok(bytes.includes(s), `the fixture holds ${s}`);
    const { zeroed, edits } = await checkVideoBytes(bytes);
    assert.equal(zeroed.length, bytes.length);
    for (const s of [SECRETS.title, SECRETS.tag, SECRETS.void, SECRETS.name, SECRETS.attachment, SECRETS.chapter, SECRETS.crc, SECRETS.date, "raccoon test writer", "LOCATION"]) {
      assert.equal(zeroed.includes(s), false, `${s} survived`);
    }
    assert.ok(edits.zeroes.length > 10);
    for (const z of edits.zeroes) assert.ok(zeroed.subarray(z.start, z.end).every((b) => b === 0), `${z.start} to ${z.end} is not zero`);
  });

  test("a dropped element becomes a Void with an all-zero payload, the same length", async () => {
    const bytes = tree({}, (t) => findEbml(segmentOf(t), I.Info).kids!.push(str(I.Title, SECRETS.title)));
    const at = bytes.indexOf(SECRETS.title) - 3;
    assert.equal(bytes.readUInt16BE(at), I.Title);
    const { zeroed } = await checkVideoBytes(bytes);
    assert.equal(zeroed[at], I.Void);
    // The Title's 2-byte id and 1-byte size became the Void's id and a 2-byte size.
    assert.equal(zeroed.readUInt16BE(at + 1), 0x4000 | SECRETS.title.length);
    assert.ok(zeroed.subarray(at + 3, at + 3 + SECRETS.title.length).every((b) => b === 0));
  });

  test("MuxingApp and WritingApp are kept as empty strings, since the format requires them", async () => {
    const bytes = webmFile();
    const { zeroed } = await checkVideoBytes(bytes);
    const at = bytes.indexOf("raccoon test writer");
    assert.equal(zeroed.readUInt16BE(at - 3), I.MuxingApp);
    assert.ok(zeroed.subarray(at, at + 19).every((b) => b === 0));
  });

  test("a Void the file already holds has its payload zeroed (AM-ASTRA-01)", async () => {
    const bytes = tree({}, (t) => segmentOf(t).kids!.splice(1, 0, bin(I.Void, Buffer.from(SECRETS.void))));
    const { zeroed } = await checkVideoBytes(bytes);
    const at = bytes.indexOf(SECRETS.void);
    assert.equal(zeroed[at - 2], I.Void);
    assert.ok(zeroed.subarray(at, at + SECRETS.void.length).every((b) => b === 0));
  });

  test("CRC-32 elements go, since the zeroing would leave their checksums stale (AM-ASTRA-11)", async () => {
    const bytes = tree({}, (t) => {
      for (const id of [I.Info, I.Tracks, I.Cluster]) findEbml(segmentOf(t), id).kids!.unshift(bin(I.CRC32, Buffer.from([1, 2, 3, 4])));
    });
    const { zeroed } = await checkVideoBytes(bytes);
    assert.equal(zeroed.includes(Buffer.from([I.CRC32, 0x84, 1, 2, 3, 4])), false);
  });

  test("a SeekHead entry pointing at dropped Tags goes with them, and one pointing at Info stays", async () => {
    const bytes = encodeWebm(webmWithSecrets());
    const { zeroed } = await checkVideoBytes(bytes);
    assert.equal(zeroed.includes(Buffer.from([0x53, 0xab, 0x84, 0x12, 0x54, 0xc3, 0x67])), false);
    assert.ok(zeroed.includes(Buffer.from([0x53, 0xab, 0x84, 0x15, 0x49, 0xa9, 0x66])));
  });

  test("a track's Name, Language and CodecName go, and its numbers stay", async () => {
    const bytes = tree({}, (t) => trackOf(t).kids!.push(str(I.Name, SECRETS.name), str(I.Language, "fra")));
    const { zeroed } = await checkVideoBytes(bytes);
    assert.equal(zeroed.includes(SECRETS.name), false);
    assert.equal(zeroed.includes("fra"), false);
    assert.ok(zeroed.includes(encodeEbml(uint(I.TrackUID, 0x1234))));
  });
});

describe("refusals", () => {
  test("Matroska that is not WebM is video_type", async () => {
    await refused(tree({}, (t) => (findEbml(t, I.EBML, I.DocType).data = Buffer.from("matroska"))), "video_type");
  });

  test("Vorbis sound is video_vorbis, whatever the size of its CodecPrivate (AMR-6)", async () => {
    await refused(webmFile({ sound: { blocks: soundBlocks(2000), codec: "A_VORBIS", codecPrivate: Buffer.alloc(5 * 1024, 1) } }), "video_vorbis");
  });

  test("any other CodecPrivate over 4 KiB is bad_video", async () => {
    await refused(webmFile({ codecPrivate: Buffer.alloc(VIDEO_LIMITS.parseValueBytes + 1) }), "bad_video");
  });

  test("sound in another codec is video_codec", async () => {
    await refused(webmFile({ sound: { blocks: soundBlocks(2000), codec: "A_AAC" } }), "video_codec");
  });

  test("a second video or sound track, or a subtitle track, is video_tracks", async () => {
    const extra = (type: number, codec: string) => (t: Ebml[]) => findEbml(segmentOf(t), I.Tracks).kids!.push(el(I.TrackEntry, uint(I.TrackNumber, 9), uint(I.TrackType, type), str(I.CodecID, codec), el(I.Video, uint(I.PixelWidth, 640), uint(I.PixelHeight, 360))));
    await refused(tree({}, extra(1, "V_VP9")), "video_tracks");
    await refused(tree({ sound: { blocks: soundBlocks(2000) } }, extra(2, "A_OPUS")), "video_tracks");
    await refused(tree({}, extra(17, "S_TEXT/UTF8")), "video_tracks");
  });

  test("AlphaMode 1 and BlockAdditions are video_alpha", async () => {
    await refused(tree({}, (t) => videoOf(t).kids!.push(uint(I.AlphaMode, 1))), "video_alpha");
    await refused(
      tree({}, (t) => findEbml(segmentOf(t), I.Cluster).kids!.push(el(I.BlockGroup, block(1, 500, 0, Buffer.from([0x86, 0])), el(I.BlockAdditions, el(0xa6, uint(0xee, 1), bin(0xa5, Buffer.from([1]))))))),
      "video_alpha",
    );
  });

  test("PQ or HLG transfer is video_hdr", async () => {
    for (const transfer of [16, 18]) await refused(tree({}, (t) => videoOf(t).kids!.push(el(I.Colour, uint(I.TransferCharacteristics, transfer)))), "video_hdr");
  });

  test("SDR Colour is kept", async () => {
    const bytes = tree({}, (t) => videoOf(t).kids!.push(el(I.Colour, uint(I.TransferCharacteristics, 1), uint(0x55b1, 1), el(I.MasteringMetadata, float(0x55d9, 1000)))));
    const { zeroed } = await checkVideoBytes(bytes);
    assert.ok(zeroed.includes(encodeEbml(uint(I.TransferCharacteristics, 1))));
  });

  test("sizes outside 256 to 4096 a side or over 8.3 megapixels are video_size", async () => {
    await refused(webmFile({ width: 4097, height: 2000 }), "video_size");
    await refused(webmFile({ width: 3000, height: 3000 }), "video_size");
    await refused(webmFile({ width: 640, height: 255 }), "video_size");
    assert.equal((await checkVideoBytes(webmFile({ width: 3840, height: 2160 }))).facts.widthPx, 3840);
    assert.equal((await checkVideoBytes(webmFile({ width: 2880, height: 2880 }))).facts.heightPx, 2880);
  });

  test("a stretched or cropped picture is video_geometry", async () => {
    await refused(tree({}, (t) => videoOf(t).kids!.push(uint(I.DisplayWidth, 853), uint(I.DisplayHeight, 360))), "video_geometry");
    await refused(tree({}, (t) => videoOf(t).kids!.push(uint(I.DisplayUnit, 3))), "video_geometry");
    await refused(tree({}, (t) => videoOf(t).kids!.push(uint(I.PixelCropTop, 8))), "video_geometry");
    await checkVideoBytes(tree({}, (t) => videoOf(t).kids!.push(uint(I.DisplayWidth, 640), uint(I.DisplayHeight, 360), uint(I.DisplayUnit, 0))));
  });

  test("under 1 second or over 10 minutes is video_length", async () => {
    await refused(webmFile({ frameMs: [0, 33, 66], durationMs: 999 }), "video_length");
    await refused(webmFile({ frameMs: [0, 500], durationMs: 10 * 60_000 + 1000 }), "video_length");
  });

  test("no Duration is video_unfinished, as screen recordings write", async () => {
    await refused(webmFile({ durationMs: null }), "video_unfinished");
  });

  test("an unknown size anywhere is video_unfinished", async () => {
    await refused(tree({}, (t) => (segmentOf(t).unknownSize = true)), "video_unfinished");
    await refused(tree({}, (t) => (findEbml(segmentOf(t), I.Cluster).unknownSize = true)), "video_unfinished");
  });

  test("a last Cluster past the Duration is video_unfinished", async () => {
    // The second Cluster starts at 1000 ms.
    await refused(webmFile({ durationMs: 900 }), "video_unfinished");
  });

  test("ContentEncodings, compression or encryption, are bad_video", async () => {
    await refused(tree({}, (t) => trackOf(t).kids!.push(el(I.ContentEncodings, el(0x6240, uint(0x5031, 0))))), "bad_video");
  });

  test("lacing on the video track is bad_video, since video is never laced", async () => {
    await refused(
      tree({}, (t) => {
        const b = allEbml(segmentOf(t), I.SimpleBlock)[3]!;
        b.data = Buffer.from(b.data!);
        b.data[3]! |= 0x02;
      }),
      "bad_video",
    );
  });

  test("an element past its parent, bytes after the Segment and a truncated file are bad_video", async () => {
    const bytes = webmFile();
    await refused(Buffer.concat([bytes, Buffer.from([0xec, 0x80])]), "bad_video");
    await refused(bytes.subarray(0, bytes.length - 5), "bad_video");
    const lying = Buffer.from(bytes);
    const at = lying.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
    lying[at + 3] = 0xfe; // TimestampScale now claims 126 bytes, past the end of Info
    await refused(lying, "bad_video");
  });

  test("an integer above 2^53, a float that is not finite and a zero TimestampScale are bad_video", async () => {
    await refused(tree({}, (t) => findEbml(segmentOf(t), I.Tracks, I.TrackEntry).kids!.push(bin(I.TrackUID, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])))), "bad_video");
    await refused(tree({}, (t) => (findEbml(segmentOf(t), I.Info, I.Duration).data = Buffer.from([0x7f, 0xf8, 0, 0, 0, 0, 0, 0]))), "bad_video");
    await refused(tree({}, (t) => (findEbml(segmentOf(t), I.Info, I.TimestampScale).data = Buffer.from([0]))), "bad_video");
  });

  test("more than 200,000 element headers is bad_video", async () => {
    const voids = Array.from({ length: VIDEO_LIMITS.parseElementHeaders }, () => bin(I.Void, Buffer.alloc(0)));
    await refused(tree({}, (t) => (segmentOf(t).kids = segmentOf(t).kids!.concat(voids))), "bad_video");
  });

  test("a check past its budget is bad_video", async () => {
    let now = 0;
    const budget = new Budget(5_000, () => (now += 1_000));
    await assert.rejects(checkVideoBytes(webmFile(), { budget }), (err: unknown) => err instanceof AssetError && err.code === "bad_video");
  });

  test("more than 60,000 sound packets is bad_video", async () => {
    const blocks = Array.from({ length: 6_001 }, (_, i) => ({ ms: i / 3, tocs: Array.from({ length: 10 }, () => 0x80) }));
    await refused(webmFile({ frameMs: Array.from({ length: 61 }, (_, i) => i * 33), sound: { blocks } }), "bad_video");
  });
});

describe("the frame rate is measured over every frame (AM-ASTRA-06, AMN-13)", () => {
  const at = (fps: number, seconds: number, from = 0) => Array.from({ length: Math.round(fps * seconds) }, (_, i) => from + Math.round((i * 1000) / fps));

  test("with no DefaultDuration, 24, 25, 30, 50, 59.94 and 60 fps give their peak", async () => {
    for (const [fps, peak] of [[24, 24], [25, 25], [30, 30], [50, 50], [59.94, 60], [60, 60]] as const) {
      const { facts } = await checkVideoBytes(webmFile({ frameMs: at(fps, 2) }));
      assert.equal(facts.fps, peak, `${fps} fps`);
    }
  });

  test("61 frames in a second passes and 62 is video_fps", async () => {
    assert.equal((await checkVideoBytes(webmFile({ frameMs: Array.from({ length: 122 }, (_, i) => Math.floor((i * 1000) / 61)), scale: 1_000_000 }))).facts.fps, 61);
    await refused(webmFile({ frameMs: Array.from({ length: 124 }, (_, i) => Math.floor((i * 1000) / 62)) }), "video_fps");
  });

  test("12 s at 60 fps then 18 s at 10 fps is 60, and a faster later stretch cannot hide behind a slow start", async () => {
    assert.equal((await checkVideoBytes(webmFile({ frameMs: [...at(60, 12), ...at(10, 18, 12_000)], clusterMs: 2000 }))).facts.fps, 60);
    await refused(webmFile({ frameMs: [...at(10, 5), ...at(70, 1, 5000)], clusterMs: 1000 }), "video_fps");
  });

  test("a short first Cluster and 2-byte and 8-byte track VINTs read the same", async () => {
    for (const trackVintLength of [2, 8]) {
      const { facts } = await checkVideoBytes(webmFile({ frameMs: at(30, 2), trackVintLength, clusterMs: 100 }));
      assert.equal(facts.fps, 30);
    }
  });

  test("an invisible block is no frame", async () => {
    const bytes = tree({ frameMs: at(30, 2) }, (t) => {
      const cluster = findEbml(segmentOf(t), I.Cluster);
      for (let k = 0; k < 40; k++) cluster.kids!.push({ id: I.SimpleBlock, data: Buffer.from([0x81, 0x00, 0x10, 0x08, 0x86, 0]) });
    });
    assert.equal((await checkVideoBytes(bytes)).facts.fps, 30);
  });

  test("more than 36,600 frames in all is video_fps", async () => {
    await refused(webmFile({ frameMs: Array.from({ length: VIDEO_LIMITS.maxFrames + 1 }, (_, i) => i * 17), clusterMs: 30_000 }), "video_fps");
  });
});

describe("the sound's length (AMR-3, AMQ-5, AM-ASTRA-28, AM-ASTRA-31)", () => {
  const frames = Array.from({ length: 60 }, (_, i) => Math.round((i * 1000) / 30));
  // The picture ends at 1967 + 34 = 2001 ms, and the default CodecDelay is 6.5 ms.
  const videoEnd = 2001;

  test("sound ending well before the picture is fine", async () => {
    await checkVideoBytes(webmFile({ frameMs: frames, sound: { blocks: soundBlocks(1000) } }));
  });

  test("sound 60 ms past the picture is video_layout, and 40 ms past is fine", async () => {
    // The last 20 ms block starts at 2060 ms and ends at 2073.5 ms once the delay is taken off: 72.5 ms past.
    await refused(webmFile({ frameMs: frames, durationMs: 2100, sound: { blocks: soundBlocks(2080) } }), "video_layout");
    // Here it starts at 2020 ms and ends 32.5 ms past.
    await checkVideoBytes(webmFile({ frameMs: frames, durationMs: 2100, sound: { blocks: soundBlocks(2040) } }));
    assert.equal(videoEnd, 2001);
  });

  test("a laced block's length comes from its packets' TOC bytes", async () => {
    // Three 20 ms packets in each block: the last, at 1980 ms, ends at 2033.5 ms, within 50 ms.
    const laced = Array.from({ length: 34 }, (_, i) => ({ ms: i * 60, tocs: [OPUS_20MS, OPUS_20MS, OPUS_20MS] }));
    await checkVideoBytes(webmFile({ frameMs: frames, sound: { blocks: laced } }));
    // One more, at 2040 ms, ends at 2093.5 ms.
    await refused(webmFile({ frameMs: frames, durationMs: 2100, sound: { blocks: [...laced, { ms: 2040, tocs: [OPUS_20MS, OPUS_20MS, OPUS_20MS] }] } }), "video_layout");
  });

  test("a code 3 packet's frame count byte gives its length", async () => {
    // Code 3 holding 6 frames of 20 ms is 120 ms, the most a packet may hold. The last Cluster starts at 1000 ms.
    const ending = (relative: number) =>
      tree({ frameMs: frames, durationMs: 2200, sound: { blocks: [{ ms: 0 }] } }, (t) => {
        const head = Buffer.alloc(3);
        head.writeInt16BE(relative, 1);
        allEbml(segmentOf(t), I.Cluster).at(-1)!.kids!.push(bin(I.SimpleBlock, Buffer.from([0x82, head[1]!, head[2]!, 0x80, OPUS_20MS | 3, 0x06, 0, 0])));
      });
    // 1900 ms plus 120 ms, less the delay, is 12.5 ms past the picture.
    await checkVideoBytes(ending(900));
    // 1950 ms plus 120 ms is 62.5 ms past.
    await refused(ending(950), "video_layout");
    // A count of 7 would be 140 ms, longer than any packet.
    await refused(
      tree({ frameMs: frames, sound: { blocks: [{ ms: 0 }] } }, (t) => {
        allEbml(segmentOf(t), I.Cluster).at(-1)!.kids!.push(bin(I.SimpleBlock, Buffer.from([0x82, 0, 10, 0x80, OPUS_20MS | 3, 0x07, 0, 0])));
      }),
      "bad_video",
    );
  });

  test("a positive DiscardPadding trims the end, and a negative one leaves it where it is", async () => {
    const tail = (padding: number, startMs: number) => (t: Ebml[]) => {
      const cluster = allEbml(segmentOf(t), I.Cluster).at(-1)!;
      const ts = findEbml(cluster, I.Timestamp).data!.readUIntBE(0, findEbml(cluster, I.Timestamp).data!.length);
      cluster.kids!.push(el(I.BlockGroup, block(2, startMs - ts, 0, Buffer.from([OPUS_20MS, 1, 2, 3])), sint(I.DiscardPadding, padding * 1e6)));
    };
    // A 20 ms packet starting at 2050 ms ends at 2070 - 6.5, 62.5 ms past the picture.
    const base = { frameMs: frames, durationMs: 2100, sound: { blocks: soundBlocks(2000) } };
    await refused(tree(base, tail(0, 2050)), "video_layout");
    await checkVideoBytes(tree(base, tail(15, 2050)));
    await refused(tree(base, tail(-15, 2050)), "video_layout");
    // A negative padding on a block that already ends within 50 ms is fine.
    await checkVideoBytes(tree(base, tail(-15, 2020)));
  });

  test("a BlockGroup's BlockDuration gives a block's length", async () => {
    const bytes = tree({ frameMs: frames, durationMs: 2100, sound: { blocks: soundBlocks(2000) } }, (t) => {
      const cluster = allEbml(segmentOf(t), I.Cluster).at(-1)!;
      const ts = findEbml(cluster, I.Timestamp).data!.readUIntBE(0, findEbml(cluster, I.Timestamp).data!.length);
      cluster.kids!.push(el(I.BlockGroup, block(2, 2000 - ts, 0, Buffer.from([OPUS_20MS, 1])), uint(I.BlockDuration, 100)));
    });
    await refused(bytes, "video_layout");
  });
});

describe("every kept value is read, checked and kept once (AMBUILD-ASTRA-02, AMBUILD-SOL-002, AMBUILD-SOL-006)", () => {
  const PRIVATE = "PRIVATE TITLE Alice Example alice@example.test";
  /** Text short enough to read as a whole number, so only a range or a place can refuse it. */
  const SHORT = Buffer.from("Alice!");
  const cuePoint = (t: Ebml[]) => findEbml(segmentOf(t), I.Cues, I.CuePoint);
  const cuePositions = (t: Ebml[]) => findEbml(cuePoint(t), I.CueTrackPositions);
  const firstCluster = (t: Ebml[]) => findEbml(segmentOf(t), I.Cluster);

  test("a Cue's time holding text is refused, long or short", async () => {
    await refused(tree({}, (t) => (findEbml(cuePoint(t), I.CueTime).data = Buffer.from(PRIVATE))), "bad_video");
    await refused(tree({}, (t) => (findEbml(cuePoint(t), I.CueTime).data = SHORT)), "bad_video");
  });

  test("a Cue must name a track the file has, a Cluster where one starts and a place and block inside it", async () => {
    await refused(tree({}, (t) => (findEbml(cuePositions(t), 0xf7).data = SHORT)), "bad_video");
    await refused(tree({}, (t) => (findEbml(cuePositions(t), 0xf1).at = findEbml(segmentOf(t), I.Tracks))), "bad_video");
    await refused(tree({}, (t) => cuePositions(t).kids!.push({ id: 0xf0, data: SHORT })), "bad_video");
    await refused(tree({}, (t) => cuePositions(t).kids!.push(uint(0x5378, 0))), "bad_video");
    await refused(tree({}, (t) => cuePositions(t).kids!.push(uint(0xb2, 2 ** 40))), "bad_video");
    await refused(tree({}, (t) => cuePositions(t).kids!.push(el(I.CueReference, { id: 0x96, data: SHORT }))), "bad_video");
    // In bounds, each is kept.
    const fine = tree({}, (t) => cuePositions(t).kids!.push(uint(0xf0, 3), uint(0x5378, 1), uint(0xb2, 33), el(I.CueReference, uint(0x96, 0))));
    const { zeroed } = await checkVideoBytes(fine);
    assert.ok(zeroed.includes(encodeEbml(uint(0x5378, 1))));
  });

  test("an element off the Cues' lists becomes a Void, its text gone", async () => {
    const bytes = tree({}, (t) => cuePositions(t).kids!.push(str(0x5ab4, PRIVATE)));
    assert.ok(bytes.includes(PRIVATE));
    assert.equal((await checkVideoBytes(bytes)).zeroed.includes(PRIVATE), false);
  });

  test("a second CodecPrivate, the first holding text, is refused (AMBUILD-SOL-006)", async () => {
    const valid = Buffer.from([1, 1, 0]);
    await refused(tree({ codecPrivate: valid }, (t) => trackOf(t).kids!.splice(4, 0, bin(I.CodecPrivate, Buffer.from(PRIVATE)))), "bad_video");
  });

  test("a second copy of any element its parent holds once is refused", async () => {
    const twice: Array<[string, (t: Ebml[]) => void]> = [
      ["DocType", (t) => findEbml(t, I.EBML).kids!.push(str(I.DocType, PRIVATE))],
      ["TimestampScale", (t) => findEbml(segmentOf(t), I.Info).kids!.push(uint(I.TimestampScale, 1_000_000))],
      ["Duration", (t) => findEbml(segmentOf(t), I.Info).kids!.push(float(I.Duration, 2001))],
      ["TrackNumber", (t) => trackOf(t).kids!.push(uint(I.TrackNumber, 1))],
      ["Video", (t) => trackOf(t).kids!.push(el(I.Video, uint(I.PixelWidth, 1280), uint(I.PixelHeight, 720)))],
      ["PixelWidth", (t) => videoOf(t).kids!.push(uint(I.PixelWidth, 1280))],
      ["a Colour number", (t) => videoOf(t).kids!.push(el(I.Colour, uint(0x55b1, 1), uint(0x55b1, 2)))],
      ["a Cluster's Timestamp", (t) => firstCluster(t).kids!.push(uint(I.Timestamp, 0))],
      ["SeekID", (t) => findEbml(segmentOf(t), I.SeekHead, I.Seek).kids!.unshift(bin(I.SeekID, Buffer.from("Alic")))],
      ["SeekPosition", (t) => findEbml(segmentOf(t), I.SeekHead, I.Seek).kids!.push({ id: I.SeekPosition, data: SHORT })],
      ["CueTime", (t) => cuePoint(t).kids!.push({ id: I.CueTime, data: Buffer.from([0]) })],
      ["CueTrack", (t) => cuePositions(t).kids!.push(uint(0xf7, 1))],
      ["Cues", (t) => segmentOf(t).kids!.push(findEbml(segmentOf(t), I.Cues))],
      ["BlockDuration", (t) => firstCluster(t).kids!.push(el(I.BlockGroup, block(1, 500, 0, Buffer.from([0x86, 0])), uint(I.BlockDuration, 1), uint(I.BlockDuration, 2)))],
    ];
    for (const [name, change] of twice) {
      await assert.rejects(checkVideoBytes(tree({}, change)), (err: unknown) => err instanceof AssetError && err.code === "bad_video", name);
    }
  });

  test("a second Info is refused even when the first had no TimestampScale", async () => {
    await refused(
      tree({}, (t) => {
        const seg = segmentOf(t);
        const info = findEbml(seg, I.Info);
        seg.kids!.splice(seg.kids!.indexOf(info), 0, el(I.Info, str(I.MuxingApp, "")));
      }),
      "bad_video",
    );
  });

  test("a SeekHead entry must point where its element is", async () => {
    await refused(tree({}, (t) => (findEbml(segmentOf(t), I.SeekHead, I.Seek, I.SeekPosition).at = findEbml(segmentOf(t), I.Tracks))), "bad_video");
    await refused(tree({}, (t) => (findEbml(segmentOf(t), I.SeekHead, I.Seek, I.SeekPosition).data = SHORT)), "bad_video");
  });

  test("numbers with a range refuse text in them: the flags, the header's versions, Colour, MasteringMetadata, DefaultDuration and the Audio's channels", async () => {
    await refused(tree({}, (t) => trackOf(t).kids!.push({ id: I.FlagDefault, data: Buffer.from("Al") })), "bad_video");
    await refused(tree({}, (t) => (findEbml(t, I.EBML, I.EBMLVersion).data = Buffer.from([2]))), "bad_video");
    await refused(tree({}, (t) => (findEbml(t, I.EBML, I.DocTypeVersion).data = SHORT)), "bad_video");
    await refused(tree({}, (t) => videoOf(t).kids!.push(el(I.Colour, { id: 0x55bc, data: SHORT }))), "bad_video");
    await refused(tree({}, (t) => videoOf(t).kids!.push(el(I.Colour, el(I.MasteringMetadata, float(0x55d9, -1))))), "bad_video");
    await refused(tree({}, (t) => trackOf(t).kids!.push(uint(I.DefaultDuration, 0))), "bad_video");
    await refused(tree({}, (t) => videoOf(t).kids!.push({ id: I.FlagInterlaced, data: SHORT })), "bad_video");
    const sound = { blocks: soundBlocks(2000) };
    await refused(tree({ sound }, (t) => findEbml(allEbml(segmentOf(t), I.TrackEntry)[1]!, I.Audio, I.Channels).data = Buffer.from([1])), "video_sound");
  });

  test("a Cluster's PrevSize goes, its number with it", async () => {
    const bytes = tree({}, (t) => allEbml(segmentOf(t), I.Cluster)[1]!.kids!.splice(1, 0, { id: I.PrevSize, data: SHORT }));
    assert.ok(bytes.includes(SHORT));
    assert.equal((await checkVideoBytes(bytes)).zeroed.includes(SHORT), false);
  });

  test("a block's reserved flag bits, a third ReferenceBlock and one farther than any timeline are refused", async () => {
    await refused(
      tree({}, (t) => {
        const b = allEbml(segmentOf(t), I.SimpleBlock)[2]!;
        b.data = Buffer.from(b.data!);
        b.data[3]! |= 0x20;
      }),
      "bad_video",
    );
    await refused(tree({}, (t) => firstCluster(t).kids!.push(el(I.BlockGroup, block(1, 500, 0x10, Buffer.from([0x86, 0]))))), "bad_video");
    const refs = (...distances: number[]) => (t: Ebml[]) => firstCluster(t).kids!.push(el(I.BlockGroup, block(1, 500, 0, Buffer.from([0x86, 0])), ...distances.map((d) => sint(I.ReferenceBlock, d))));
    await checkVideoBytes(tree({}, refs(-33, 33)));
    await refused(tree({}, refs(-33, -66, 33)), "bad_video");
    await refused(tree({}, refs(2 ** 40)), "bad_video");
  });
});
