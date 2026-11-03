import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SOUND_LIMITS } from "../limits.ts";
import { frameBytes, stripTags, walkMp3, type Mp3Walk } from "./mp3.ts";
import { apeTag, concat, frameHeader, framesFor, id3v1, id3v2, lyrics3v1, lyrics3v2, paddingPattern, silentFrames, withTagFrame } from "./mp3Testutil.ts";

/** The frame walk and the tag strip (docs/design/design-v1-sound.md 7.1 and 12). */

function facts(walk: Mp3Walk) {
  if (!walk.ok) assert.fail(`refused: ${walk.code}, ${walk.why}`);
  return walk.facts;
}

function refused(walk: Mp3Walk, code: "sound_type" | "sound_length", why?: RegExp): void {
  assert.equal(walk.ok, false, "the walk took it");
  if (walk.ok) return;
  assert.equal(walk.code, code, walk.why);
  if (why) assert.match(walk.why, why);
}

function setHeader(bytes: Uint8Array, at: number, h: number): Uint8Array {
  const out = bytes.slice();
  new DataView(out.buffer).setUint32(at, h >>> 0, false);
  return out;
}

function header(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, false);
}

describe("walkMp3: what it takes", () => {
  test("every rate, bitrate and mode it allows, with its length and each frame's first byte", () => {
    for (const rateHz of [44_100, 48_000] as const) {
      for (const kbps of [64, 80, 96, 112, 128, 160, 192]) {
        for (const mode of [0, 1, 2, 3] as const) {
          const frames = 40;
          const stream = silentFrames(frames, { rateHz, kbps, mode });
          const got = facts(walkMp3(stream));
          assert.deepEqual({ rateHz: got.rateHz, kbps: got.kbps, channels: got.channels, frames: got.frames }, { rateHz, kbps, channels: mode === 3 ? 1 : 2, frames });
          assert.equal(got.ms, Math.floor((frames * 1152 * 1000) / rateHz));
          const pads = paddingPattern(kbps, rateHz, frames);
          let at = 0;
          for (let i = 0; i < frames; i++) {
            assert.equal(got.offsets[i], at);
            at += frameBytes(kbps, rateHz, pads[i]!);
          }
          assert.equal(got.offsets.length, frames);
        }
      }
    }
  });

  test("padding, private, copyright, original and mode extension bits may change from frame to frame", () => {
    const stream = silentFrames(64, { bits: (i) => ({ private: i % 2 === 0, copyright: i % 3 === 0, original: i % 5 === 0, modeExt: (i % 4) as 0 | 1 | 2 | 3 }) });
    assert.equal(facts(walkMp3(stream)).frames, 64);
  });

  test("the lengths: 0.2 s and 15 min 1 s at most, by frames times 1152 over the rate", () => {
    // 8 frames at 44.1 kHz are 208 ms and 7 are 182, 9 at 48 kHz are 216 and 8 are 192.
    assert.equal(facts(walkMp3(silentFrames(8))).ms, 208);
    refused(walkMp3(silentFrames(7)), "sound_length", /shorter/);
    assert.equal(facts(walkMp3(silentFrames(9, { rateHz: 48_000 }))).ms, 216);
    refused(walkMp3(silentFrames(8, { rateHz: 48_000 })), "sound_length", /shorter/);
    for (const rateHz of [44_100, 48_000] as const) {
      const most = Math.floor(((SOUND_LIMITS.fileMaxMs + 1) * rateHz - 1) / 1_152_000);
      const at = facts(walkMp3(silentFrames(most, { rateHz, kbps: 64 })));
      assert.ok(at.ms <= SOUND_LIMITS.fileMaxMs && at.ms > SOUND_LIMITS.fileMaxMs - 30, `${at.ms}`);
      refused(walkMp3(silentFrames(most + 1, { rateHz, kbps: 64 })), "sound_length", /longer/);
    }
  });

  test("a well-formed file too long is sound_length even past every cap the offsets keep", () => {
    refused(walkMp3(silentFrames(framesFor(20 * 60_000), { kbps: 64 })), "sound_length");
  });

  test("tick runs before the walk and every few thousand frames, and what it throws ends the walk", () => {
    let ticks = 0;
    facts(walkMp3(silentFrames(10_000, { kbps: 64 }), { tick: () => void ticks++ }));
    assert.ok(ticks >= 3, `${ticks}`);
    assert.throws(
      () =>
        walkMp3(silentFrames(10_000, { kbps: 64 }), {
          tick: () => {
            if (++ticks > 5) throw new Error("over budget");
          },
        }),
      /over budget/,
    );
  });
});

describe("walkMp3: what it refuses", () => {
  const good = silentFrames(40);
  const h = header(good, 0);
  const rebuilt = (change: (h: number) => number, frame = 0) => {
    let at = 0;
    for (let i = 0; i < frame; i++) at += frameBytes(128, 44_100, ((header(good, at) >>> 9) & 1) === 1);
    return setHeader(good, at, change(header(good, at)));
  };

  test("another version, layer, rate or bitrate, a CRC or emphasis, in the first frame", () => {
    const cases: Array<[string, (h: number) => number, RegExp]> = [
      ["MPEG-2", (x) => x & ~(1 << 19), /MPEG-1/],
      ["MPEG-2.5", (x) => x & ~(3 << 19), /MPEG-1/],
      ["Layer II", (x) => (x & ~(3 << 17)) | (2 << 17), /Layer III/],
      ["Layer I", (x) => x | (3 << 17), /Layer III/],
      ["a CRC", (x) => x & ~(1 << 16), /CRC/],
      ["free format", (x) => x & ~(0xf << 12), /bitrate/],
      ["32 kbps", (x) => (x & ~(0xf << 12)) | (1 << 12), /bitrate/],
      ["56 kbps", (x) => (x & ~(0xf << 12)) | (4 << 12), /bitrate/],
      ["224 kbps", (x) => (x & ~(0xf << 12)) | (12 << 12), /bitrate/],
      ["320 kbps", (x) => (x & ~(0xf << 12)) | (14 << 12), /bitrate/],
      ["the forbidden bitrate", (x) => x | (0xf << 12), /bitrate/],
      ["32 kHz", (x) => (x & ~(3 << 10)) | (2 << 10), /sample rate/],
      ["the reserved rate", (x) => x | (3 << 10), /sample rate/],
      ["emphasis", (x) => x | 1, /emphasis/],
      ["the reserved emphasis", (x) => x | 2, /emphasis/],
    ];
    for (const [name, change, why] of cases) refused(walkMp3(rebuilt(change)), "sound_type", why);
    refused(walkMp3(setHeader(good, 0, h & 0x001f_ffff)), "sound_type", /sync/);
  });

  test("a second bitrate, rate, mode or form mid-file", () => {
    refused(walkMp3(rebuilt((x) => (x & ~(0xf << 12)) | (11 << 12), 20)), "sound_type", /byte/);
    refused(walkMp3(rebuilt((x) => (x & ~(3 << 10)) | (1 << 10), 20)), "sound_type", /byte/);
    refused(walkMp3(rebuilt((x) => x | (3 << 6), 20)), "sound_type", /byte/);
    refused(walkMp3(rebuilt((x) => x & ~(1 << 16), 20)), "sound_type", /CRC/);
    refused(walkMp3(rebuilt((x) => x | 1, 39)), "sound_type", /emphasis/);
  });

  test("a stray byte before, inside or after, and a cut last frame", () => {
    refused(walkMp3(concat(new Uint8Array([0]), good)), "sound_type");
    refused(walkMp3(concat(good, new Uint8Array([0xff]))), "sound_type", /stray/);
    refused(walkMp3(concat(good, new Uint8Array(4))), "sound_type");
    refused(walkMp3(concat(good.subarray(0, 2000), new Uint8Array([0]), good.subarray(2000))), "sound_type");
    refused(walkMp3(good.subarray(0, good.length - 1)), "sound_type", /cut/);
    refused(walkMp3(new Uint8Array(0)), "sound_type");
    refused(walkMp3(good.subarray(0, 3)), "sound_type");
  });

  test("any tag, at the start or the end, even one whose bytes tile as frames", () => {
    refused(walkMp3(concat(id3v2(100), good)), "sound_type");
    for (const tag of [id3v1(), apeTag(40), lyrics3v2(), lyrics3v1()]) refused(walkMp3(concat(good, tag)), "sound_type");
    // The last frame's own bytes spelling an ID3v1 tag, an APE footer or a Lyrics3 end: a browser reads them as one.
    const last = good.length;
    for (const [at, text] of [
      [last - 128, "TAG"],
      [last - 32, "APETAGEX"],
      [last - 9, "LYRICS200"],
    ] as const) {
      const out = good.slice();
      for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
      if (text === "APETAGEX") new DataView(out.buffer).setUint32(last - 24, 2000, true);
      refused(walkMp3(out), "sound_type");
    }
  });
});

describe("walkMp3: the leading tag frame", () => {
  const stream = silentFrames(framesFor(3000));
  const counted = facts(walkMp3(stream)).frames;

  test("an Info or Xing frame with LAME's extension, as LAME writes one, is not counted", () => {
    for (const name of ["Info", "Xing"] as const) {
      const file = withTagFrame(stream, { name });
      const got = facts(walkMp3(file));
      assert.equal(got.frames, counted);
      assert.equal(got.offsets[0], frameBytes(128, 44_100, false));
      // Cutting at the first counted frame leaves the stream without its tag frame.
      assert.deepEqual(file.subarray(got.offsets[0]), stream);
    }
    for (const lame of [null, { name: "Lavf60.1" }, { name: "LAME3.99r" }, { method: 0 }, { method: 8 }]) facts(walkMp3(withTagFrame(stream, { lame })));
    facts(walkMp3(withTagFrame(stream, { frames: null, streamBytes: null, toc: null, quality: null, lame: null })));
    facts(walkMp3(withTagFrame(silentFrames(40, { mode: 3, kbps: 64, rateHz: 48_000 }))));
  });

  test("a frame count, byte count or music length other than the file's", () => {
    refused(walkMp3(withTagFrame(stream, { frames: counted + 1 })), "sound_type", /frame count/);
    refused(walkMp3(withTagFrame(stream, { frames: counted - 1 })), "sound_type", /frame count/);
    refused(walkMp3(withTagFrame(stream, { frames: 1_000_000 })), "sound_type", /frame count/);
    const length = stream.length + frameBytes(128, 44_100, false);
    facts(walkMp3(withTagFrame(stream, { streamBytes: length - frameBytes(128, 44_100, false) })));
    refused(walkMp3(withTagFrame(stream, { streamBytes: length + 1 })), "sound_type", /byte count/);
    refused(walkMp3(withTagFrame(stream, { streamBytes: 10 })), "sound_type", /byte count/);
    refused(walkMp3(withTagFrame(stream, { lame: { musicBytes: length * 2 } })), "sound_type", /music length/);
    // 7 frames are 8,064 samples, all a delay and padding of 4,095 each would trim.
    refused(walkMp3(withTagFrame(silentFrames(7), { lame: { delay: 4095, padding: 4095 } })), "sound_type", /delay/);
  });

  test("a seek table that steps back, or steps through the file as no constant bitrate does", () => {
    const back = Uint8Array.from({ length: 100 }, (_, i) => Math.floor((256 * i) / 100));
    back[50] = back[49]! - 1;
    refused(walkMp3(withTagFrame(stream, { toc: back })), "sound_type", /steps back/);
    const skewed = Uint8Array.from({ length: 100 }, (_, i) => Math.min(255, Math.floor((256 * i) / 100) + (i > 10 ? 8 : 0)));
    refused(walkMp3(withTagFrame(stream, { toc: skewed })), "sound_type", /another bitrate/);
    const text = new TextEncoder().encode("Alice Example alice@example.test".padEnd(100, " "));
    refused(walkMp3(withTagFrame(stream, { toc: text })), "sound_type");
  });

  test("text anywhere in the tag frame that is no field's", () => {
    const tagged = withTagFrame(stream);
    const plant = (at: number, text = "Alice") => {
      const out = tagged.slice();
      for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
      return out;
    };
    // After the fields, which end at 4 + 32 + 8 + 4 + 4 + 100 + 4 + 36 = 192.
    refused(walkMp3(plant(200)), "sound_type", /after its fields/);
    refused(walkMp3(plant(400)), "sound_type", /after its fields/);
    refused(walkMp3(plant(10)), "sound_type", /side information/);
    refused(walkMp3(plant(156, "Alice Ex.")), "sound_type", /after its fields/);
    refused(walkMp3(plant(156, "LAMEAlice")), "sound_type", /encoder name/);
    refused(walkMp3(withTagFrame(stream, { lame: { method: 4 } })), "sound_type", /method/);
    refused(walkMp3(withTagFrame(stream, { lame: { peak: 0xffff_ffff } })), "sound_type", /peak/);
    refused(walkMp3(withTagFrame(stream, { lame: { radio: 0xe000 } })), "sound_type", /replay gain/);
    refused(walkMp3(withTagFrame(stream, { quality: 1000 })), "sound_type", /quality/);
    const flags = tagged.slice();
    flags[43] = 0x1f;
    refused(walkMp3(flags), "sound_type", /undefined flags/);
  });

  test("a VBRI frame, a tag frame's name at the other mode's place, and a second tag frame", () => {
    const vbri = stream.slice();
    for (let i = 0; i < 4; i++) vbri[36 + i] = "VBRI".charCodeAt(i);
    refused(walkMp3(vbri), "sound_type", /VBRI/);
    const misplaced = stream.slice();
    for (let i = 0; i < 4; i++) misplaced[21 + i] = "Xing".charCodeAt(i);
    refused(walkMp3(misplaced), "sound_type", /other channel mode/);
    refused(walkMp3(withTagFrame(withTagFrame(stream))), "sound_type", /second tag frame/);
  });
});

describe("stripTags", () => {
  const stream = silentFrames(40);

  test("an ID3v2 tag at the start and up to three tags at the end, leaving a view of the stream", () => {
    const starts = [new Uint8Array(0), id3v2(0), id3v2(1000, { version: 2 }), id3v2(1000, { version: 4, footer: true })];
    const ends = [[], [id3v1()], [apeTag(64), id3v1()], [lyrics3v2(), id3v1()], [apeTag(64, { header: false }), lyrics3v1(), id3v1()]];
    for (const start of starts) {
      for (const end of ends) {
        const file = concat(start, stream, ...end);
        const got = stripTags(file);
        assert.ok(got.ok, got.ok ? "" : got.why);
        if (!got.ok) continue;
        assert.deepEqual(got.bytes, stream);
        assert.equal(got.stripped, file.length - stream.length);
        assert.equal(got.bytes.buffer, file.buffer, "a view, not a copy");
        facts(walkMp3(got.bytes));
      }
    }
    const plain = stripTags(stream);
    assert.ok(plain.ok && plain.stripped === 0 && plain.bytes.length === stream.length);
  });

  test("a fourth tag at the end, and tags whose sizes run past the file or their bound", () => {
    const why = (bytes: Uint8Array) => {
      const got = stripTags(bytes);
      assert.equal(got.ok, false);
      return got.ok ? "" : got.why;
    };
    assert.match(why(concat(stream, apeTag(10), lyrics3v2(), id3v1(), id3v1())), /more than 3/);
    const past = id3v2(100);
    past[8] = 0x7f;
    assert.match(why(concat(past, stream.subarray(0, 100))), /past the file's end/);
    const huge = id3v2(0);
    huge[6] = 0x08;
    assert.match(why(concat(huge, stream)), /over its bound/);
    const notSyncsafe = id3v2(10);
    notSyncsafe[9] = 0x8a;
    assert.match(why(concat(notSyncsafe, stream)), /syncsafe/);
    assert.match(why(concat(id3v2(10, { version: 3 }).map((b, i) => (i === 3 ? 5 : b)), stream)), /ID3v2\.5/);
    assert.match(why(id3v2(0).subarray(0, 6)), /cut short/);
    const ape = apeTag(64);
    new DataView(ape.buffer).setUint32(ape.length - 20, 1 << 30, true);
    assert.match(why(concat(stream, ape)), /APE tag past/);
    assert.match(why(concat(stream, apeTag(64, { version: 3000 }))), /APE tag version/);
    const headerAtEnd = apeTag(64, { header: false });
    new DataView(headerAtEnd.buffer).setUint32(headerAtEnd.length - 12, 0x2000_0000, true);
    assert.match(why(concat(stream, headerAtEnd)), /header where its footer/);
    const noHeader = apeTag(64);
    noHeader[0] = 0;
    assert.match(why(concat(stream, noHeader)), /header is missing/);
    const digits = lyrics3v2();
    digits[digits.length - 10] = "x".charCodeAt(0);
    assert.match(why(concat(stream, digits)), /six digits/);
    const long = lyrics3v2();
    long[long.length - 15] = "9".charCodeAt(0);
    assert.match(why(concat(stream, long)), /Lyrics3 tag past/);
    assert.match(why(concat(stream, new TextEncoder().encode(`${"x".repeat(30)}LYRICSEND`))), /no start/);
  });

  test("a Lyrics3 v1 tag is found within its 5,100 bytes of lyrics and no further", () => {
    const most = stripTags(concat(stream, lyrics3v1("y".repeat(5100))));
    assert.ok(most.ok && most.bytes.length === stream.length);
    assert.equal(stripTags(concat(stream, lyrics3v1("y".repeat(5101)))).ok, false);
  });
});

test("frameHeader builds only the headers the walk reads", () => {
  assert.equal(frameHeader({ rateHz: 44_100, kbps: 128, padded: false }) >>> 0, 0xfffb_9040);
  assert.throws(() => frameHeader({ rateHz: 22_050, kbps: 128, padded: false }));
});
