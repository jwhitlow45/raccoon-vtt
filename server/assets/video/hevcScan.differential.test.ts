import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { runSettings } from "#shared/propertyTestutil.ts";
import { HEVC_ENTRIES, scanRanges, videoSampleEntry } from "#shared/video/hevcScan.ts";
import { AssetError } from "../errors.ts";
import { checkVideoBytes } from "./check.ts";
import { avcCBytes, bx, defaultSoundTrack, defaultVideoTrack, iphoneMov, metadataTrack, mp4File, visualEntry, type Mp4Track } from "./videoTestutil.ts";

/**
 * The device's HEVC scan (shared/video/hevcScan.ts, AMROT-O-06)
 * against the server's check on the same bytes, built by the server's own
 * test writer and then damaged at random. The scan refuses a file before it
 * uploads, so it must never call HEVC a file the server would take, and an
 * undamaged HEVC file with its `moov` at either end must be found from its
 * first and last MiB, as the server finds it.
 */

const { seed, runs } = runSettings(process.env);
const MiB = 1024 * 1024;

function scan(bytes: Buffer): string | null {
  return videoSampleEntry(
    scanRanges(bytes.length).map(([start, end]) => ({ start, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset + start, end - start) })),
    bytes.length,
  );
}

async function serverSays(bytes: Buffer): Promise<string> {
  try {
    await checkVideoBytes(bytes);
    return "accepted";
  } catch (err) {
    assert.ok(err instanceof AssetError, String(err));
    return err.code;
  }
}

/** 2 s of video whose samples sum to about `bytes`, so a file passes 2 MiB and its two ends are read apart. */
function video(entry: string, bytes: number): Mp4Track {
  const kids = entry === "avc1" ? [bx("avcC", avcCBytes())] : [];
  return defaultVideoTrack({ entry: visualEntry(entry, 640, 360, "", ...kids), samples: Array.from({ length: 60 }, () => ({ size: Math.ceil(bytes / 60), delta: 512 })) });
}

const ENTRIES = ["hvc1", "hev1", "dvh1", "dvhe", "avc1"] as const;

/** Files as an iPhone, a camera and FFmpeg lay them out: a MOV or an MP4, moov first or last, with sound, metadata tracks and padding. */
const layout = fc.record({
  entry: fc.constantFrom(...ENTRIES),
  mov: fc.boolean(),
  moovLast: fc.boolean(),
  sound: fc.boolean(),
  faces: fc.boolean(),
  media: fc.constantFrom(20_000, 900_000, 3 * MiB),
  padding: fc.constantFrom(0, 600_000),
});

function build(o: { entry: string; mov: boolean; moovLast: boolean; sound: boolean; faces: boolean; media: number; padding: number }): Buffer {
  const faces = metadataTrack({ samples: Array.from({ length: 4 }, () => ({ size: 16, delta: 300 })) });
  return mp4File({
    ...(o.mov ? { brand: "qt  ", compatible: ["qt  "] } : {}),
    moovLast: o.moovLast,
    tracks: [...(o.faces ? [faces] : []), video(o.entry, o.media), ...(o.sound ? [defaultSoundTrack()] : [])],
    ...(o.padding ? { beforeMoov: [bx("free", Buffer.alloc(o.padding))] } : {}),
  });
}

/** Where to damage a file, unbiased, so the headers at either end are hit as often as the media. */
const position = fc.noBias(fc.integer({ min: 0, max: 2 ** 30 }));

const seen = { hevc: 0, decided: 0 };

/** The rule the scan keeps: HEVC only where the server refuses too, and the server's own HEVC entry where it says `video_hevc` and the scan decides. */
async function agrees(bytes: Buffer): Promise<void> {
  const entry = scan(bytes);
  const server = await serverSays(bytes);
  if (entry !== null) seen.decided++;
  if (entry !== null && HEVC_ENTRIES.has(entry)) {
    seen.hevc++;
    assert.notEqual(server, "accepted", `the scan called ${entry} a file the server takes`);
  }
  // A file the server calls HEVC and the scan decides is HEVC to the scan too, so the two read the same track's entry.
  if (server === "video_hevc" && entry !== null) assert.ok(HEVC_ENTRIES.has(entry), `the server says video_hevc and the scan read ${entry}`);
}

describe("the HEVC scan against the server's check (AMROT-O-06)", () => {
  test("every undamaged layout: HEVC is found and the server says video_hevc, H.264 is found and the server takes it", async () => {
    for (const entry of ENTRIES) {
      for (const mov of [false, true]) {
        for (const moovLast of [false, true]) {
          for (const media of [20_000, 3 * MiB]) {
            const o = { entry, mov, moovLast, sound: true, faces: mov, media, padding: 0 };
            const bytes = build(o);
            const label = JSON.stringify({ ...o, bytes: bytes.length });
            assert.equal(scan(bytes), entry, label);
            assert.equal(await serverSays(bytes), entry === "avc1" ? "accepted" : "video_hevc", label);
          }
        }
      }
    }
    assert.equal(scan(iphoneMov()), "avc1", "the Most Compatible iPhone MOV of the fixtures");
  });

  test("any truncation: the scan never calls HEVC a file the server takes", async () => {
    await fc.assert(
      fc.asyncProperty(layout, position, async (o, cut) => {
        const bytes = build(o);
        await agrees(bytes.subarray(0, cut % (bytes.length + 1)));
      }),
      { seed, numRuns: runs ?? 60 },
    );
  });

  test("any bit flips and any overwritten bytes: the scan never calls HEVC a file the server takes", async () => {
    const before = { ...seen };
    const numRuns = runs ?? 120;
    await fc.assert(
      fc.asyncProperty(layout, fc.array(fc.tuple(position, fc.integer({ min: 0, max: 255 }), fc.boolean()), { minLength: 1, maxLength: 6 }), async (o, damage) => {
        const bytes = Buffer.from(build(o));
        // Half the damage lands in the first or last 4 KiB, where the boxes the scan walks start and end.
        for (const [at, value, nearAnEnd] of damage) {
          const i = nearAnEnd ? (at % 2 ? at % 4096 : bytes.length - 1 - (at % 4096)) : at % bytes.length;
          if (i < 0 || i >= bytes.length) continue;
          bytes[i] = value % 2 ? bytes[i]! ^ (1 << (value % 8)) : value;
        }
        await agrees(bytes);
      }),
      { seed, numRuns },
    );
    // The floors scale with the runs, so a short FC_RUNS run does not fail a rate it has too few cases to show.
    // The damage must leave enough files the scan still decides, and calls HEVC, for the rule to have been tried.
    assert.ok(seen.decided - before.decided >= Math.floor(numRuns / 12), `only ${seen.decided - before.decided} damaged files decided`);
    assert.ok(seen.hevc - before.hevc >= Math.floor(numRuns / 24), `only ${seen.hevc - before.hevc} damaged files called HEVC`);
  });
});
