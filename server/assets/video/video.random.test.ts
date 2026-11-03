import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { fileTypeFromBuffer } from "file-type";
import { runSettings } from "#shared/propertyTestutil.ts";
import { AssetError } from "../errors.ts";
import { capped, checkVideoBytes, containerOf } from "./check.ts";
import { parseMp4 } from "./mp4.ts";
import { defaultSoundTrack, defaultVideoTrack, encodeWebm, mp4File, webmFile, webmWithSecrets, locationUdta, bx, SECRETS } from "./videoTestutil.ts";
import { parseWebm } from "./webm.ts";
import { Budget, BufferSource } from "./window.ts";

/**
 * The header check under random damage (docs/design/design-v1-animated-maps.md
 * 12): any bytes, any truncation and any bit flips of a valid file end in
 * facts or an AssetError with a 4.5 code, within the budget, never reading
 * past the file's end. Every accepted file has its zeroed ranges all zero,
 * its media data untouched, its length kept, and checks again to the same
 * facts with no further edit.
 */

const { seed, runs } = runSettings(process.env);

const VIDEO_CODES = new Set([
  "video_type",
  "video_codec",
  "video_tracks",
  "video_sound",
  "video_vorbis",
  "video_alpha",
  "video_hdr",
  "video_size",
  "video_geometry",
  "video_length",
  "video_fps",
  "video_unfinished",
  "video_fragmented",
  "video_layout",
  "bad_video",
  "too_large",
]);

const BASES: Buffer[] = [
  webmFile(),
  webmFile({ sound: { blocks: Array.from({ length: 100 }, (_, i) => ({ ms: i * 20, tocs: i % 3 ? [0xf8] : [0xf8, 0xf8] })) } }),
  encodeWebm(webmWithSecrets({ codec: "V_VP8" })),
  mp4File(),
  mp4File({ tracks: [defaultVideoTrack(), defaultSoundTrack()], inMoov: [locationUdta()], afterMdat: [bx("free", Buffer.from(SECRETS.free))] }),
  mp4File({ moovLast: true, tracks: [defaultVideoTrack({ chunkSamples: 7 }), defaultSoundTrack({ chunkSamples: 10 })] }),
];

/** A Source that records any read a parser asks for past the file's end. */
class Watched extends BufferSource {
  pastEnd = 0;
  override read(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || offset + length > this.size) this.pastEnd++;
    return super.read(offset, length);
  }
  override readAll(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || offset + length > this.size) this.pastEnd++;
    return super.readAll(offset, length);
  }
}

const seen = { accepted: 0, refused: 0 };

async function examine(bytes: Buffer): Promise<void> {
  const started = performance.now();
  const src = new Watched(bytes);
  let outcome: "accepted" | "refused";
  try {
    const container = containerOf((await fileTypeFromBuffer(bytes))?.ext);
    const budget = new Budget();
    const parsed = container === "webm" ? await parseWebm(src, budget) : await parseMp4(src, budget);
    const facts = capped(parsed, bytes.length);
    outcome = "accepted";
    // The edits never reach into the media data, and applying them keeps the length.
    const zeroed = parsed.edits.applyTo(bytes);
    assert.equal(zeroed.length, bytes.length);
    for (const z of parsed.edits.zeroes) assert.ok(zeroed.subarray(z.start, z.end).every((b) => b === 0), "a zeroed range holds a byte");
    for (const p of parsed.edits.protected) assert.ok(zeroed.subarray(p.start, p.end).equals(bytes.subarray(p.start, p.end)), "media data was written");
    const again = await checkVideoBytes(zeroed);
    assert.deepEqual(again.facts, facts);
    assert.ok(again.zeroed.equals(zeroed), "a second check edited the stored file");
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    outcome = "refused";
    assert.ok(err instanceof AssetError, `threw ${String(err)}`);
    assert.ok(VIDEO_CODES.has(err.code), `refused as ${err.code}`);
  }
  seen[outcome]++;
  assert.equal(src.pastEnd, 0, `${outcome} after reading past the end`);
  assert.ok(performance.now() - started < 5_000, "past the budget");
}

const base = fc.integer({ min: 0, max: BASES.length - 1 }).map((i) => BASES[i]!);
/** A place in a file, unbiased: fast-check's usual lean toward 0 would put most damage on the first header. */
const position = fc.noBias(fc.integer({ min: 0, max: 2 ** 30 }));

describe("the header check under random damage", () => {
  test("any truncation of a valid file", async () => {
    await fc.assert(
      fc.asyncProperty(base, position, async (bytes, cut) => examine(bytes.subarray(0, cut % (bytes.length + 1)))),
      { seed, numRuns: runs ?? 150 },
    );
  });

  test("any bit flips of a valid file", async () => {
    const before = seen.accepted;
    await fc.assert(
      fc.asyncProperty(base, fc.array(fc.tuple(position, fc.integer({ min: 0, max: 7 })), { minLength: 1, maxLength: 3 }), async (bytes, flips) => {
        const damaged = Buffer.from(bytes);
        for (const [where, bit] of flips) damaged[where % damaged.length]! ^= 1 << bit;
        await examine(damaged);
      }),
      { seed, numRuns: runs ?? 400 },
    );
    // Most flips land in media data, which the check never reads, so many damaged files still pass and have their edits checked.
    assert.ok(seen.accepted - before > 80, `only ${seen.accepted - before} accepted`);
  });

  test("any bytes written over a valid file's headers", async () => {
    await fc.assert(
      fc.asyncProperty(base, position, fc.uint8Array({ minLength: 1, maxLength: 12 }), async (bytes, at, junk) => {
        const damaged = Buffer.from(bytes);
        Buffer.from(junk).copy(damaged, at % damaged.length);
        await examine(damaged);
      }),
      { seed, numRuns: runs ?? 300 },
    );
  });

  test("any bytes at all, with a WebM or MP4 start", async () => {
    const starts = [BASES[0]!.subarray(0, 40), BASES[3]!.subarray(0, 32), Buffer.alloc(0)];
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: starts.length - 1 }), fc.uint8Array({ maxLength: 2000 }), async (start, rest) => examine(Buffer.concat([starts[start]!, Buffer.from(rest)]))),
      { seed, numRuns: runs ?? 200 },
    );
  });

  test("the undamaged bases are accepted, so the properties above see accepted files too", async () => {
    for (const bytes of BASES) await checkVideoBytes(bytes);
  });
});
