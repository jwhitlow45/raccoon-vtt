import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "../propertyTestutil.ts";
import { frameBytes, stripTags, walkMp3 } from "./mp3.ts";
import { apeTag, concat, id3v1, id3v2, lyrics3v1, lyrics3v2, paddingPattern, silentFrames, withTagFrame, type FrameBits, type StreamShape } from "./mp3Testutil.ts";

/**
 * The frame walk under random streams and random damage
 * (docs/design/design-v1-music.md 12). Invariants:
 * - W1: a built stream of one bitrate, rate and mode passes with its frame
 *   count, its length by frames times 1152 over the rate, and each frame's
 *   first byte, whatever its padding, private, copyright, original and mode
 *   extension bits say, with or without a leading tag frame.
 * - W2: a change to a fixed header field of any one frame (sync, version,
 *   layer, protection, bitrate, rate, mode, emphasis) is refused.
 * - W3: a stray byte anywhere, or a cut anywhere but a frame boundary, is refused.
 * - W4: any bytes at all end in facts or a refusal, never a throw, and an
 *   accepted file tiles exactly as the offsets say.
 * - W5: tags put around a stream strip back to that very stream.
 */

const shapes = fc.record({
  rateHz: fc.constantFrom(44_100 as const, 48_000 as const),
  kbps: fc.constantFrom(64, 80, 96, 112, 128, 160, 192),
  mode: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
});

const freeBits = fc.array(
  fc.record({ private: fc.boolean(), copyright: fc.boolean(), original: fc.boolean(), modeExt: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const) }),
  { minLength: 1, maxLength: 16 },
);

function build(shape: Required<Omit<StreamShape, "bits">>, frames: number, bits: FrameBits[]): Uint8Array {
  return silentFrames(frames, { ...shape, bits: (i) => bits[i % bits.length]! });
}

/** The first byte of each frame of a built stream, by its padding pattern. */
function offsetsOf(shape: { rateHz: number; kbps: number }, frames: number, start = 0): number[] {
  const out: number[] = [];
  let at = start;
  for (const padded of paddingPattern(shape.kbps, shape.rateHz, frames)) {
    out.push(at);
    at += frameBytes(shape.kbps, shape.rateHz, padded);
  }
  return out;
}

describe("walkMp3 under random streams", () => {
  test("W1: a stream of one form passes with its frames, its length and its offsets", () => {
    holds(
      fc.property(shapes, fc.integer({ min: 9, max: 600 }), freeBits, fc.boolean(), (shape, frames, bits, tagged) => {
        const stream = build(shape, frames, bits);
        const file = tagged ? withTagFrame(stream) : stream;
        const walk = walkMp3(file);
        assert.ok(walk.ok, walk.ok ? "" : walk.why);
        if (!walk.ok) return;
        assert.equal(walk.facts.frames, frames);
        assert.equal(walk.facts.ms, Math.floor((frames * 1152 * 1000) / shape.rateHz));
        assert.equal(walk.facts.channels, shape.mode === 3 ? 1 : 2);
        assert.deepEqual([...walk.facts.offsets], offsetsOf(shape, frames, file.length - stream.length));
      }),
      150,
    );
  });

  test("W2: a fixed header field changed in any one frame is refused", () => {
    const fields: Array<(h: number) => number> = [
      (h) => h ^ (1 << 22),
      (h) => h ^ (1 << 19),
      (h) => h ^ (1 << 17),
      (h) => h ^ (1 << 16),
      (h) => (h & ~(0xf << 12)) | ((((h >>> 12) & 0xf) % 14) + 1) << 12,
      (h) => h ^ (1 << 10),
      (h) => h ^ (1 << 6),
      (h) => h ^ 1,
    ];
    holds(
      fc.property(shapes, fc.integer({ min: 9, max: 200 }), fc.nat(), fc.nat(fields.length - 1), (shape, frames, pick, field) => {
        const stream = build(shape, frames, [{}]);
        const at = offsetsOf(shape, frames)[pick % frames]!;
        const view = new DataView(stream.buffer);
        const before = view.getUint32(at, false);
        const after = fields[field]!(before) >>> 0;
        fc.pre(after !== before);
        view.setUint32(at, after, false);
        const walk = walkMp3(stream);
        assert.equal(walk.ok, false);
        if (!walk.ok) assert.equal(walk.code, "sound_type", walk.why);
      }),
      300,
    );
  });

  test("W3: a stray byte anywhere, or a cut off a frame boundary, is refused", () => {
    holds(
      fc.property(shapes, fc.integer({ min: 9, max: 120 }), fc.nat(), fc.integer({ min: 0, max: 255 }), (shape, frames, where, byte) => {
        const stream = build(shape, frames, [{}]);
        const at = where % (stream.length + 1);
        const walk = walkMp3(concat(stream.subarray(0, at), new Uint8Array([byte]), stream.subarray(at)));
        assert.equal(walk.ok, false);
      }),
      300,
    );
    holds(
      fc.property(shapes, fc.integer({ min: 9, max: 120 }), fc.nat(), (shape, frames, where) => {
        const stream = build(shape, frames, [{}]);
        const cut = 1 + (where % (stream.length - 1));
        const boundaries = new Set(offsetsOf(shape, frames));
        const walk = walkMp3(stream.subarray(0, cut));
        if (boundaries.has(cut)) return;
        assert.equal(walk.ok, false);
        if (!walk.ok) assert.equal(walk.code, "sound_type", walk.why);
      }),
      300,
    );
  });

  test("W4: any bytes end in facts or a refusal, and accepted ones tile as their offsets say", () => {
    holds(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const walk = walkMp3(bytes);
        if (walk.ok) assert.ok(walk.facts.offsets.length === walk.facts.frames);
        const stripped = stripTags(bytes);
        if (stripped.ok) assert.ok(stripped.bytes.length + stripped.stripped === bytes.length);
      }),
      400,
    );
    // Damage to a real stream, tag frame and all: random bytes overwritten.
    holds(
      fc.property(shapes, fc.integer({ min: 9, max: 100 }), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 8 }), (shape, frames, edits) => {
        const file = withTagFrame(build(shape, frames, [{}]));
        for (const [at, byte] of edits) file[at % file.length] = byte;
        const walk = walkMp3(file);
        if (!walk.ok) return;
        const { offsets } = walk.facts;
        for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i]! > offsets[i - 1]!);
      }),
      400,
    );
  });

  test("W5: tags around a stream strip back to that stream", () => {
    const starts = fc.constantFrom(new Uint8Array(0), id3v2(0), id3v2(300), id3v2(64, { version: 4, footer: true }));
    const ends = fc.array(
      fc.constantFrom(
        () => id3v1(),
        () => apeTag(48),
        () => apeTag(16, { header: false }),
        () => lyrics3v2(),
        () => lyrics3v1("la la"),
      ),
      { maxLength: 3 },
    );
    holds(
      fc.property(shapes, fc.integer({ min: 9, max: 100 }), starts, ends, (shape, frames, start, end) => {
        const stream = build(shape, frames, [{}]);
        const got = stripTags(concat(start, stream, ...end.map((make) => make())));
        assert.ok(got.ok, got.ok ? "" : got.why);
        if (got.ok) assert.deepEqual(got.bytes, stream);
      }),
      200,
    );
  });
});
