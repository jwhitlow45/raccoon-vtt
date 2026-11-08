import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HEVC_ENTRIES, SCAN_BYTES, scanRanges, videoSampleEntry } from "#shared/video/hevcScan.ts";
import { isHevc, readVideoSampleEntry } from "./hevcScan.ts";
import { box, concat, ftypOf, full, moovOf, movie, sampleEntry, stsdOf, text, trak, word, zeros, type Bytes } from "./mp4Boxes.testutil.ts";

const MiB = 1024 * 1024;

/** The scan of these bytes, as the parts it reads from them. */
function entryOf(bytes: Uint8Array): string | null {
  return videoSampleEntry(
    scanRanges(bytes.length).map(([start, end]) => ({ start, bytes: bytes.subarray(start, end) })),
    bytes.length,
  );
}

/** A picked file of `size` bytes that holds `head` at its start and `tail` at its end, and records each part the scan asks for. */
function sparseFile(size: number, head: Uint8Array, tail: Uint8Array) {
  const reads: Array<[number, number]> = [];
  const file = {
    size,
    slice(start = 0, end = size) {
      reads.push([start, end]);
      const out = new Uint8Array(end - start);
      if (start < head.length) out.set(head.subarray(start, Math.min(end, head.length)), 0);
      const tailStart = size - tail.length;
      if (end > tailStart) out.set(tail.subarray(Math.max(0, start - tailStart), end - tailStart), Math.max(0, tailStart - start));
      return new Blob([out]);
    },
  };
  return { file, reads };
}

describe("the HEVC scan before the upload (AMROT-O-06)", () => {
  test("an iPhone's default HEVC MOV of 60 MB, its moov last, is HEVC from its first and last MiB alone", async () => {
    const size = 60 * MiB;
    const ftyp = ftypOf("qt  ");
    const moov = moovOf(trak("vide", "hvc1"), trak("soun", "mp4a"));
    const mdatSize = size - ftyp.length - 8 - moov.length;
    const head = concat(ftyp, box("wide"), word(mdatSize), text("mdat"));
    assert.equal(await readVideoSampleEntry(sparseFile(size, head, moov).file), "hvc1");
    const { file, reads } = sparseFile(size, head, moov);
    assert.equal(await isHevc(file), true);
    assert.deepEqual(reads, [[0, SCAN_BYTES], [size - SCAN_BYTES, size]], "the first and the last MiB, and nothing else");
  });

  test("the parts: the whole file up to 2 MiB, else each end's MiB", () => {
    assert.deepEqual(scanRanges(0), [[0, 0]]);
    assert.deepEqual(scanRanges(500_000), [[0, 500_000]]);
    assert.deepEqual(scanRanges(2 * MiB), [[0, 2 * MiB]]);
    assert.deepEqual(scanRanges(2 * MiB + 1), [[0, MiB], [MiB + 1, 2 * MiB + 1]]);
    assert.deepEqual(scanRanges(64 * MiB), [[0, MiB], [63 * MiB, 64 * MiB]]);
  });

  for (const entry of ["hvc1", "hev1", "dvh1", "dvhe"]) {
    for (const moovLast of [false, true]) {
      for (const brand of ["qt  ", "isom"] as const) {
        test(`${entry} is HEVC with moov ${moovLast ? "last" : "first"} in ${brand === "qt  " ? "a MOV" : "an MP4"} of 3 MiB`, async () => {
          const bytes = movie({ brand, entry, moovLast, media: 3 * MiB });
          assert.equal(entryOf(bytes), entry);
          assert.equal(await isHevc(new Blob([bytes])), true);
        });
      }
    }
  }

  test("the four HEVC entries are the server's", () => {
    assert.deepEqual([...HEVC_ENTRIES].sort(), ["dvh1", "dvhe", "hev1", "hvc1"]);
  });

  test("H.264 and AV1 are never HEVC: avc1, avc3 and av01, moov first or last, under 1 MiB or over 2 MiB", async () => {
    for (const entry of ["avc1", "avc3", "av01"]) {
      for (const moovLast of [false, true]) {
        for (const media of [20_000, 3 * MiB]) {
          const bytes = movie({ brand: "qt  ", entry, moovLast, media });
          const label = `${entry} moov ${moovLast ? "last" : "first"}, ${bytes.length} bytes`;
          assert.equal(entryOf(bytes), entry, `${label}: decided`);
          assert.equal(await isHevc(new Blob([bytes])), false, label);
        }
      }
    }
  });

  test("a file under 1 MiB is read whole and decides", async () => {
    const bytes = movie({ brand: "qt  ", entry: "hvc1", moovLast: true, media: 500_000 });
    assert.ok(bytes.length < MiB);
    assert.equal(await isHevc(new Blob([bytes])), true);
  });

  test("a file over 2 MiB whose stsd sits in neither MiB is not decided, so it uploads as today", async () => {
    // ftyp, 1.5 MiB of media, then moov in the unread middle, then 3 MiB more.
    const bytes = concat(ftypOf("qt  "), box("mdat", zeros(1.5 * MiB)), moovOf(trak("vide", "hvc1")), box("mdat", zeros(3 * MiB)));
    assert.equal(entryOf(bytes), null);
    assert.equal(await isHevc(new Blob([bytes])), false);
    // A moov last that is over a MiB starts before the last MiB, so its header is in the middle too.
    const long = movie({ brand: "qt  ", entry: "hvc1", moovLast: true, media: 3 * MiB, inMoov: [box("free", zeros(1_250_000))] });
    assert.equal(entryOf(long), null);
  });

  test("a moov that runs into the unread middle decides when its first video track lies in one part", () => {
    // moov starts in the first MiB and ends in the last, with every one of its own headers in one or the other.
    const bytes = concat(ftypOf(), moovOf(trak("vide", "hvc1"), box("free", zeros(2_300_000))), box("mdat", zeros(500_000)));
    assert.ok(bytes.length > 2 * MiB);
    assert.equal(entryOf(bytes), "hvc1");
  });

  // Each field is read after its box header, so a header can lie in a part while the field does not.
  for (const [box4, fieldAt, name] of [["hdlr", 8, "handler type"], ["stsd", 4, "entry count"]] as const) {
    test(`a ${box4} whose ${name} straddles the end of the first MiB of a 2 MiB + 1 file is not decided, and does not throw`, async () => {
      const find = (b: Uint8Array) => Buffer.from(b).indexOf(box4);
      const make = (pad: number) => moovOf(box("free", zeros(pad)), trak("vide", "hvc1"));
      const ftyp = ftypOf("qt  ");
      // The box's version and flags end before the first MiB does, the field crosses it.
      const fieldIdx = MiB - 2 - fieldAt - 4;
      const pad = 8 + (fieldIdx - ftyp.length - find(make(8)));
      const moov = make(pad);
      const bytes = concat(ftyp, moov, box("mdat", zeros(2 * MiB + 1 - ftyp.length - moov.length - 8)));
      assert.equal(bytes.length, 2 * MiB + 1);
      const fieldStart = find(bytes) + 4 + fieldAt;
      assert.ok(fieldStart < MiB && fieldStart + 4 > MiB + 1, "the field is in neither part");
      assert.equal(entryOf(bytes), null);
      assert.equal(await isHevc(new Blob([bytes])), false);
    });
  }

  test("the first video track decides: a sound track before it is passed over, and a second video track's entry is not read", () => {
    assert.equal(entryOf(movie({ traks: [trak("soun", "mp4a"), trak("vide", "hvc1")], moovLast: true, media: 3 * MiB })), "hvc1");
    assert.equal(entryOf(movie({ traks: [trak("meta", "hvc1"), trak("vide", "avc1")] })), "avc1", "a metadata track's entry is not the video's");
    assert.equal(entryOf(movie({ traks: [trak("vide", "avc1"), trak("vide", "hvc1")] })), "avc1", "the server refuses a second video track as video_tracks, before its entry");
    assert.equal(entryOf(movie({ traks: [trak("soun", "mp4a")] })), null, "no video track");
  });

  test("a 64-bit mdat and a last box of size 0 are read as the server reads them", () => {
    assert.equal(entryOf(movie({ brand: "qt  ", entry: "hvc1", moovLast: true, largeMdat: true, media: 3 * MiB })), "hvc1");
    const toTheEnd = concat(ftypOf(), moovOf(trak("vide", "hvc1")), word(0), text("mdat"), zeros(3 * MiB));
    assert.equal(entryOf(toTheEnd), "hvc1");
  });

  /** One video track's trak with its stsd as given. */
  const withStsd = (stsd: Bytes) => movie({ traks: [trak("vide", "hvc1", { stsd })] });
  /** A trak whose mdia holds these boxes. */
  const trakOf = (...mdia: Bytes[]) => box("trak", box("tkhd", full(3), zeros(80)), box("mdia", ...mdia));
  const hdlr = (handler = "vide", extra = zeros(13)) => box("hdlr", full(), word(0), text(handler), extra);
  const hevcMinf = () => box("minf", box("stbl", stsdOf(sampleEntry("hvc1"))));
  const hevc = movie({ entry: "hvc1" });
  /** The same box with its size written as 0, "to the end of its parent". */
  const sizeZero = (b: Bytes) => concat(word(0), b.subarray(4));
  const malformed: Array<[string, Uint8Array]> = [
    ["3 bytes after the last box, as am-9's broken MP4", concat(hevc, Uint8Array.of(0, 0, 0))],
    ["a last box whose size runs past the file", concat(ftypOf(), moovOf(trak("vide", "hvc1")), word(4096), text("mdat"), zeros(100))],
    ["a box smaller than its header", concat(ftypOf(), word(4), text("free"), moovOf(trak("vide", "hvc1")), box("mdat", zeros(64)))],
    ["no ftyp first", concat(moovOf(trak("vide", "hvc1")), box("mdat", zeros(64)))],
    ["a second ftyp", concat(ftypOf(), ftypOf(), moovOf(trak("vide", "hvc1")), box("mdat", zeros(64)))],
    ["two moovs", concat(ftypOf(), moovOf(trak("vide", "hvc1")), moovOf(trak("vide", "hvc1")), box("mdat", zeros(64)))],
    ["a moov over the server's 8 MiB, its video track in the first MiB", concat(ftypOf(), moovOf(trak("vide", "hvc1"), box("free", zeros(8 * MiB))), box("mdat", zeros(64)))],
    ["no mdat", concat(ftypOf(), moovOf(trak("vide", "hvc1")))],
    ["a fragmented file's moof", concat(ftypOf(), moovOf(trak("vide", "hvc1")), box("moof", zeros(16)), box("mdat", zeros(64)))],
    ["a 64-bit size past 2^53", concat(ftypOf(), moovOf(trak("vide", "hvc1")), word(1), text("mdat"), word(0x200000), word(0), zeros(64))],
    ["the video trak with size 0 inside moov, which only a top-level box may have", concat(ftypOf(), moovOf(sizeZero(trak("vide", "hvc1"))), box("mdat", zeros(64)))],
    ["an stsd entry whose size runs past the stsd", withStsd(box("stsd", full(), word(1), word(200), text("hvc1"), zeros(70)))],
    ["an stsd that counts 2 entries", withStsd(box("stsd", full(), word(2), sampleEntry("hvc1"), sampleEntry("hvc1")))],
    ["an stsd that counts 1 and holds 2", withStsd(box("stsd", full(), word(1), sampleEntry("hvc1"), sampleEntry("hvc1")))],
    ["an stsd that counts 2 and holds 1", withStsd(box("stsd", full(), word(2), sampleEntry("hvc1")))],
    ["an stsd with a flag set", withStsd(box("stsd", full(1), word(1), sampleEntry("hvc1")))],
    ["an stsd with no entry", withStsd(box("stsd", full(), word(1)))],
    ["an entry shorter than 8 bytes", withStsd(box("stsd", full(), word(1), box("hvc1", zeros(6))))],
    ["two stsds", movie({ traks: [box("trak", box("mdia", hdlr(), box("minf", box("stbl", stsdOf(sampleEntry("hvc1")), stsdOf(sampleEntry("hvc1"))))))] })],
    ["two mdias", movie({ traks: [box("trak", box("mdia", hdlr(), hevcMinf()), box("mdia", hdlr(), hevcMinf()))] })],
    ["no hdlr", movie({ traks: [trakOf(hevcMinf())] })],
    ["two hdlrs", movie({ traks: [trakOf(hdlr(), hdlr(), hevcMinf())] })],
    ["a short hdlr", movie({ traks: [trakOf(hdlr("vide", zeros(4)), hevcMinf())] })],
    ["two minfs", movie({ traks: [trakOf(hdlr(), hevcMinf(), hevcMinf())] })],
  ];
  for (const [label, bytes] of malformed) {
    test(`not decided, so it uploads as today: ${label}`, async () => {
      assert.equal(entryOf(bytes), null);
      assert.equal(await isHevc(new Blob([bytes as Bytes])), false);
    });
  }

  test("each case above is HEVC once its one flaw is gone, so the flaw is what the scan answers to", () => {
    assert.equal(entryOf(hevc), "hvc1");
    assert.equal(entryOf(withStsd(stsdOf(sampleEntry("hvc1")))), "hvc1");
    assert.equal(entryOf(movie({ traks: [trakOf(hdlr(), hevcMinf())] })), "hvc1");
    assert.equal(entryOf(concat(ftypOf(), moovOf(trak("vide", "hvc1")), box("mdat", zeros(64)))), "hvc1");
  });

  test("a file this browser cannot read is not decided", async () => {
    const unreadable = { size: 3 * MiB, slice: () => ({ arrayBuffer: () => Promise.reject(new DOMException("gone", "NotReadableError")) }) as unknown as Blob };
    assert.equal(await readVideoSampleEntry(unreadable), null);
    assert.equal(await isHevc(unreadable), false);
  });

  test("a WebM's first bytes are no box the scan decides on", () => {
    const ebml = concat(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01), zeros(4000));
    assert.equal(entryOf(ebml), null);
  });
});
