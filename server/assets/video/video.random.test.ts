import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { fileTypeFromBuffer } from "file-type";
import { runSettings } from "#shared/propertyTestutil.ts";
import { AssetError } from "../errors.ts";
import { capped, checkVideoBytes, containerOf } from "./check.ts";
import { parseMp4 } from "./mp4.ts";
import {
  ROWS,
  avcCBytes,
  defaultSoundTrack,
  defaultVideoTrack,
  encodeEbml,
  encodeWebm,
  filler,
  iphoneMov,
  metadataTrack,
  mp4File,
  paspBox,
  projectionEl,
  tkhdMatrix,
  uint,
  visualEntry,
  webmFile,
  webmWithSecrets,
  locationUdta,
  bx,
  SECRETS,
} from "./videoTestutil.ts";
import { EBML_ID, parseWebm } from "./webm.ts";
import { Budget, BufferSource, type Range } from "./window.ts";

/**
 * The header check under random damage (docs/design/design-v1-animated-maps.md
 * 12): any bytes, any truncation and any bit flips of a valid file end in
 * facts or an AssetError with a 4.5 code, within the budget, never reading
 * past the file's end. Every accepted file has its zeroed ranges all zero,
 * its media data untouched but for the scrubbed metadata samples, its length
 * kept, and checks again to the same bytes with the same facts, plain where
 * the file was turned or stretched (docs/design/design-v1-video-turns.md 5).
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
  "video_hevc",
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
  // Turned, stretched and an iPhone's, whose metadata samples the check scrubs (docs/design/design-v1-video-turns.md 4.1, 4.5).
  mp4File({ tracks: [defaultVideoTrack({ matrix: tkhdMatrix(ROWS.turn270Mirror), chunkSamples: 9 }), defaultSoundTrack({ chunkSamples: 13 })] }),
  iphoneMov(defaultVideoTrack({ chunkSamples: 11 })),
  webmFile({ videoKids: [uint(EBML_ID.DisplayWidth, 853)] }),
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
    // The header edits never reach into the media data, only the scrubs do, and applying them keeps the length.
    const zeroed = parsed.edits.applyTo(bytes);
    assert.equal(zeroed.length, bytes.length);
    for (const z of [...parsed.edits.zeroes, ...parsed.edits.scrubs]) assert.ok(zeroed.subarray(z.start, z.end).every((b) => b === 0), "a zeroed range holds a byte");
    const expected = Buffer.from(bytes);
    for (const s of parsed.edits.scrubs) expected.fill(0, s.start, s.end);
    for (const p of parsed.edits.protected) assert.ok(zeroed.subarray(p.start, p.end).equals(expected.subarray(p.start, p.end)), "media data was written");
    for (const k of parsed.edits.kept) assert.ok(zeroed.subarray(k.start, k.end).equals(bytes.subarray(k.start, k.end)), "a kept sample was written");
    const again = await checkVideoBytes(zeroed);
    const { turn: _turn, mirror: _mirror, displayWidthPx: _width, ...plain } = facts;
    assert.deepEqual(again.facts, plain, "the stored file is plain, its facts otherwise the same");
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

// Turned, stretched and dropped (docs/design/design-v1-video-turns.md 14, Property) ------------------------------------

const U = 0x10000;
const CODED = { w: 640, h: 360 };
const W = CODED.w * U;
const H = CODED.h * U;
const W_ONE = 0x40000000;
const SHIFT_TERMS = { "0": () => 0, W: (w: number) => w, H: (_w: number, h: number) => h } as const;

/**
 * 4.1's table written out apart from the parser's copy: a, b, c, d in units
 * of 0x10000, the turn, the mirror and the one translation other than (0, 0)
 * the row may carry, in terms of tkhd's own width and height.
 */
const ROW_TABLE: ReadonlyArray<{ m: readonly [number, number, number, number]; turn: 0 | 90 | 180 | 270; mirror: boolean; shift: readonly ["0" | "W" | "H", "0" | "W" | "H"] | null }> = [
  { m: [1, 0, 0, 1], turn: 0, mirror: false, shift: null },
  { m: [0, 1, -1, 0], turn: 90, mirror: false, shift: ["H", "0"] },
  { m: [-1, 0, 0, -1], turn: 180, mirror: false, shift: ["W", "H"] },
  { m: [0, -1, 1, 0], turn: 270, mirror: false, shift: ["0", "W"] },
  { m: [-1, 0, 0, 1], turn: 0, mirror: true, shift: ["W", "0"] },
  { m: [0, 1, 1, 0], turn: 90, mirror: true, shift: null },
  { m: [1, 0, 0, -1], turn: 180, mirror: true, shift: ["0", "H"] },
  { m: [0, -1, -1, 0], turn: 270, mirror: true, shift: ["H", "W"] },
];

type Header = { matrix: number[]; tkhd: { width: number; height: number }; pasp: readonly [number, number] | null; flags: number; clap: readonly number[] | null };

/** 4.1 by its own words, in BigInt: the geometry a header asks for, or null for `video_geometry`. */
function oracle(h: Header): { turn?: number; mirror?: true; displayWidthPx?: number } | null {
  const [a, b, u, c, d, v, tx, ty, w] = h.matrix.map((x) => x | 0) as [number, number, number, number, number, number, number, number, number];
  if (u !== 0 || v !== 0 || w !== W_ONE) return null;
  const row = ROW_TABLE.find((r) => r.m[0] * U === a && r.m[1] * U === b && r.m[2] * U === c && r.m[3] * U === d);
  if (!row) return null;
  const at = [tx >>> 0, ty >>> 0];
  const moved = row.shift && at[0] === SHIFT_TERMS[row.shift[0]](h.tkhd.width, h.tkhd.height) && at[1] === SHIFT_TERMS[row.shift[1]](h.tkhd.width, h.tkhd.height);
  if (!(at[0] === 0 && at[1] === 0) && !moved) return null;
  if (h.tkhd.height !== H) return null;
  const tw = BigInt(h.tkhd.width);
  let num: bigint;
  let den: bigint;
  if (h.flags & 0x8 && (h.tkhd.width !== W || (h.pasp && h.pasp[0] !== h.pasp[1]))) return null;
  if (!h.pasp) [num, den] = [tw, BigInt(W)];
  else if (h.pasp[0] === h.pasp[1]) {
    if (h.tkhd.width !== W) return null;
    [num, den] = [1n, 1n];
  } else {
    const [ph, pv] = h.pasp.map(BigInt) as [bigint, bigint];
    if (ph < 1n || pv < 1n || ph > 65535n || pv > 65535n) return null;
    const off = tw * pv - BigInt(CODED.w) * ph * BigInt(U);
    if (h.tkhd.width !== W && (off < 0n ? -off : off) > BigInt(U) * pv) return null;
    [num, den] = [ph, pv];
  }
  if (num < 1n || 2n * num < den || num > 2n * den) return null;
  if (h.clap) {
    const [wN, wD, hN, hD, xN, xD, yN, yD] = h.clap as [number, number, number, number, number, number, number, number];
    if (![wD, hD, xD, yD].every((x) => x >= 1) || wN !== CODED.w * wD || hN !== CODED.h * hD || xN !== 0 || yN !== 0) return null;
  }
  const drawn = Number((2n * BigInt(CODED.w) * num + den) / (2n * den));
  return { ...(row.turn ? { turn: row.turn } : {}), ...(row.mirror ? { mirror: true as const } : {}), ...(drawn !== CODED.w ? { displayWidthPx: drawn } : {}) };
}

function headerFile(h: Header): Buffer {
  const pasp = h.pasp ? [paspBox(h.pasp[0], h.pasp[1])] : [];
  const clap = h.clap ? [bx("clap", Buffer.concat(h.clap.map((x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x >>> 0); return b; })))] : [];
  const entry = visualEntry("avc1", CODED.w, CODED.h, "", bx("avcC", avcCBytes()), ...pasp, ...clap);
  return mp4File({ tracks: [defaultVideoTrack({ entry, matrix: h.matrix, tkhdRaw: h.tkhd, tkhdFlags: h.flags })] });
}

const word = fc.oneof(fc.constantFrom(0, U, -U, 2 * U, 1, 46341, -46341), fc.integer({ min: -0x8000_0000, max: 0x7fff_ffff }));
const header: fc.Arbitrary<Header> = fc
  .record({
    rowAt: fc.integer({ min: 0, max: ROW_TABLE.length - 1 }),
    random: fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 }),
    words: fc.array(word, { minLength: 9, maxLength: 9 }),
    uvw: fc.oneof({ arbitrary: fc.constant([0, 0, W_ONE]), weight: 8 }, { arbitrary: fc.constantFrom([1, 0, W_ONE], [0, U, W_ONE], [0, 0, W_ONE + 1], [0, 0, 0]), weight: 1 }),
    move: fc.oneof({ arbitrary: fc.constantFrom("none", "own"), weight: 6 }, { arbitrary: fc.constantFrom("W0", "0H", "HW", "pixel"), weight: 1 }),
    tkhdWidth: fc.oneof(
      { arbitrary: fc.constantFrom(W, Math.round((W * 4) / 3), Math.round((W * 4) / 3) + U, Math.round((W * 10) / 11), 2 * W, W / 2), weight: 6 },
      { arbitrary: fc.constantFrom(Math.round((W * 4) / 3) + 2 * U, W / 2 - U, 2 * W + U, H, 0), weight: 1 },
      { arbitrary: fc.integer({ min: 0, max: 0xffff_ffff }), weight: 1 },
    ),
    tkhdHeight: fc.oneof({ arbitrary: fc.constant(H), weight: 8 }, { arbitrary: fc.constantFrom(H + U, W, H + 1), weight: 1 }),
    pasp: fc.oneof(
      { arbitrary: fc.constant(null), weight: 3 },
      { arbitrary: fc.constantFrom<[number, number]>([1, 1], [4, 3], [10, 11], [2, 1], [1, 2], [0, 0], [3, 4]), weight: 4 },
      { arbitrary: fc.constantFrom<[number, number]>([0, 3], [3, 1], [70_000, 69_999], [40, 33]), weight: 1 },
      { arbitrary: fc.tuple(fc.integer({ min: 0, max: 70_000 }), fc.integer({ min: 0, max: 70_000 })), weight: 1 },
    ),
    flags: fc.oneof({ arbitrary: fc.constantFrom(3, 1, 7), weight: 4 }, { arbitrary: fc.constantFrom(0xb, 0xf), weight: 1 }),
    clap: fc.oneof(
      { arbitrary: fc.constant(null), weight: 6 },
      { arbitrary: fc.constantFrom([640, 1, 360, 1, 0, 1, 0, 1], [1280, 2, 720, 2, 0, 3, 0, 5]), weight: 2 },
      { arbitrary: fc.constantFrom([632, 1, 360, 1, 0, 1, 0, 1], [640, 1, 360, 1, 1, 1, 0, 1], [640, 1, 360, 1, 0, 0, 0, 1], [640, 0, 360, 1, 0, 1, 0, 1]), weight: 1 },
    ),
  })
  .map((g) => {
    const row = ROW_TABLE[g.rowAt]!;
    const tkhd = { width: g.tkhdWidth, height: g.tkhdHeight };
    const own = row.shift ? [SHIFT_TERMS[row.shift[0]](tkhd.width, tkhd.height), SHIFT_TERMS[row.shift[1]](tkhd.width, tkhd.height)] : [0, 0];
    const move = { none: [0, 0], own, W0: [tkhd.width, 0], "0H": [0, tkhd.height], HW: [tkhd.height, tkhd.width], pixel: [U, 0] }[g.move]!;
    const [u, v, w] = g.uvw as [number, number, number];
    const matrix = g.random ? g.words : [row.m[0] * U, row.m[1] * U, u, row.m[2] * U, row.m[3] * U, v, move[0]!, move[1]!, w];
    return { matrix, tkhd, pasp: g.pasp, flags: g.flags, clap: g.clap };
  });

/** The kept tracks' chunks and the mdat payloads of a built file, as its writer placed them. */
type Layout = { mdat?: Range; kept: Range[]; dropped: Range[] };

function chunksOf(offsets: readonly number[], sizes: readonly number[], per: number): Range[] {
  return offsets.map((start, i) => ({ start, end: start + sizes.slice(i * per, (i + 1) * per).reduce((s, x) => s + x, 0) }));
}

describe("turned, stretched and dropped, by property (docs/design/design-v1-video-turns.md 14)", () => {
  test("any matrix, tkhd size, pasp, flags and clap are accepted exactly when 4.1 says, the stored header plain and the file its plain twin's", async () => {
    let accepted = 0;
    await fc.assert(
      fc.asyncProperty(header, async (h) => {
        const want = oracle(h);
        const got = await checkVideoBytes(headerFile(h)).catch((err: unknown) => {
          if (err instanceof AssetError) return err;
          throw err;
        });
        if (want === null) {
          assert.ok(got instanceof AssetError && got.code === "video_geometry", `accepted ${JSON.stringify(h)}`);
          return;
        }
        assert.ok(!(got instanceof AssetError), `refused as ${got instanceof AssetError ? got.code : ""}: ${JSON.stringify(h)}`);
        accepted++;
        const { turn, mirror, displayWidthPx } = got.facts;
        assert.deepEqual({ ...(turn ? { turn } : {}), ...(mirror ? { mirror } : {}), ...(displayWidthPx ? { displayWidthPx } : {}) }, want);
        const twin = headerFile({ ...h, matrix: [U, 0, 0, 0, U, 0, 0, 0, W_ONE], tkhd: { width: W, height: H }, pasp: h.pasp ? [1, 1] : null });
        assert.ok(got.zeroed.equals((await checkVideoBytes(twin)).zeroed), "stored as its plain twin");
        assert.ok((await checkVideoBytes(got.zeroed)).zeroed.equals(got.zeroed), "checked again to the same bytes");
      }),
      { seed, numRuns: runs ?? 400 },
    );
    assert.ok(accepted > 30, `only ${accepted} accepted`);
  });

  test("any WebM display size, unit and Projection pose is accepted exactly when 4.2 says, and a display size unlike the pixels goes", async () => {
    const term = fc.option(fc.oneof(fc.constantFrom(640, 853, 1280, 1281, 320, 319, 0, 65_535, 70_000, 360, 270, 720, 721, 180, 179), fc.integer({ min: 0, max: 70_000 })), { nil: undefined });
    const pose = fc.constantFrom(0, 0, 0, 90, -0.5);
    await fc.assert(
      fc.asyncProperty(term, term, fc.option(fc.constantFrom(0, 0, 1, 3), { nil: undefined }), fc.option(fc.tuple(pose, pose, pose), { nil: undefined }), async (dw, dh, unit, projection) => {
        const kids = [
          ...(dw !== undefined ? [uint(EBML_ID.DisplayWidth, dw)] : []),
          ...(dh !== undefined ? [uint(EBML_ID.DisplayHeight, dh)] : []),
          ...(unit !== undefined ? [uint(EBML_ID.DisplayUnit, unit)] : []),
          ...(projection ? [projectionEl({ yaw: projection[0], pitch: projection[1], roll: projection[2] })] : []),
        ];
        const bytes = webmFile({ videoKids: kids });
        const termOk = (t: number | undefined) => t === undefined || (t >= 1 && t <= 65_535);
        const num = BigInt(dw ?? 640) * 360n;
        const den = BigInt(dh ?? 360) * 640n;
        const fine = (unit ?? 0) === 0 && !(projection && projection.some((p) => p !== 0)) && termOk(dw) && termOk(dh) && 2n * num >= den && num <= 2n * den;
        const got = await checkVideoBytes(bytes).catch((err: unknown) => {
          if (err instanceof AssetError) return err;
          throw err;
        });
        if (!fine) {
          assert.ok(got instanceof AssetError && got.code === "video_geometry", `accepted ${JSON.stringify({ dw, dh, unit, projection })}`);
          return;
        }
        assert.ok(!(got instanceof AssetError), `refused as ${got instanceof AssetError ? got.code : ""}`);
        const drawn = Number((2n * 640n * num + den) / (2n * den));
        assert.equal(got.facts.displayWidthPx, drawn === 640 ? undefined : drawn);
        const unlike = (dw !== undefined && dw !== 640) || (dh !== undefined && dh !== 360);
        for (const [id, value] of [[EBML_ID.DisplayWidth, dw], [EBML_ID.DisplayHeight, dh]] as const) {
          if (value === undefined) continue;
          const at = bytes.indexOf(encodeEbml(uint(id, value)));
          assert.equal(got.zeroed[at] === EBML_ID.Void, unlike, `display element ${id.toString(16)} ${unlike ? "kept" : "voided"}`);
        }
        const again = await checkVideoBytes(got.zeroed);
        assert.ok(again.zeroed.equals(got.zeroed));
        assert.equal(again.facts.displayWidthPx, undefined);
      }),
      { seed, numRuns: runs ?? 300 },
    );
  });

  test("random metadata layouts are accepted only when every chunk lies in one mdat and off the kept samples, and then only the metadata's bytes change", async () => {
    const place = fc.record({ kind: fc.constantFrom("own", "own", "inside", "second", "edge", "moov"), at: fc.nat() });
    const meta = fc.record({ sizes: fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 5 }), per: fc.integer({ min: 1, max: 5 }), places: fc.array(place, { minLength: 5, maxLength: 5 }) });
    let accepted = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 60 }), fc.option(fc.integer({ min: 1, max: 95 }), { nil: undefined }), fc.option(fc.integer({ min: 8, max: 200 }), { nil: undefined }), fc.array(meta, { minLength: 1, maxLength: 3 }), async (videoPer, soundPer, second, metas) => {
        const layout: Layout = { kept: [], dropped: [] };
        const video = defaultVideoTrack({ chunkSamples: videoPer });
        const sound = soundPer === undefined ? [] : [defaultSoundTrack({ chunkSamples: soundPer })];
        const kept = [video, ...sound].map((t) => ({
          ...t,
          chunkOffsets: (l: { mdat: Range; defaults: number[] }) => {
            layout.mdat = l.mdat;
            layout.kept.push(...chunksOf(l.defaults, t.samples.map((s) => s.size), t.chunkSamples!));
            return l.defaults;
          },
        }));
        const dropped = metas.map((m) =>
          metadataTrack({
            samples: m.sizes.map((size) => ({ size, delta: 60 })),
            chunkSamples: m.per,
            chunkOffsets: (l) => {
              const mdatBytes = l.mdat.end - l.mdat.start;
              const offsets = l.defaults.map((own, i) => {
                const p = m.places[i]!;
                if (p.kind === "own") return own;
                if (p.kind === "inside") return l.mdat.start + (p.at % mdatBytes);
                if (p.kind === "second") return l.mdat.end + 8 + (p.at % (second ?? 1));
                if (p.kind === "edge") return l.mdat.end - (p.at % 16);
                return 8 + (p.at % 40);
              });
              layout.dropped.push(...chunksOf(offsets, m.sizes, m.per));
              return offsets;
            },
          }),
        );
        // Each pass of the writer places the chunks again: only the last pass's are the file's.
        const bytes = mp4File({ tracks: [...kept, ...dropped], ...(second ? { afterMdat: [bx("mdat", filler(second, 77))] } : {}) });
        const lastPass = (list: Range[], n: number) => list.slice(list.length - n);
        const keptChunks = lastPass(layout.kept, layout.kept.length / 2);
        const droppedChunks = lastPass(layout.dropped, layout.dropped.length / 2);
        const mdats = [layout.mdat!, ...(second ? [{ start: layout.mdat!.end + 8, end: layout.mdat!.end + 8 + second }] : [])];
        const inOne = (r: Range) => mdats.some((m) => m.start <= r.start && r.end <= m.end);
        const meets = (r: Range) => keptChunks.some((k) => k.start < r.end && r.start < k.end);
        const fine = droppedChunks.every((r) => inOne(r) && !meets(r));
        const got = await checkVideoBytes(bytes).catch((err: unknown) => {
          if (err instanceof AssetError) return err;
          throw err;
        });
        if (!fine) {
          assert.ok(got instanceof AssetError && got.code === "bad_video", `accepted with a chunk outside an mdat or over a kept sample`);
          return;
        }
        assert.ok(!(got instanceof AssetError), `refused as ${got instanceof AssetError ? got.code : ""}`);
        accepted++;
        const expected = Buffer.from(bytes);
        for (const r of droppedChunks) expected.fill(0, r.start, r.end);
        for (const m of mdats) assert.ok(got.zeroed.subarray(m.start, m.end).equals(expected.subarray(m.start, m.end)), "media data other than the metadata's changed");
        assert.ok((await checkVideoBytes(got.zeroed)).zeroed.equals(got.zeroed), "checked again to the same bytes");
      }),
      { seed, numRuns: runs ?? 300 },
    );
    assert.ok(accepted > 30, `only ${accepted} accepted`);
  });
});
