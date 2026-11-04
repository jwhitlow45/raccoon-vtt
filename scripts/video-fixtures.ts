import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import type { VideoFacts } from "../shared/model.ts";
import { AssetError } from "../server/assets/errors.ts";
import { checkVideoBytes } from "../server/assets/video/check.ts";
import { EBML_ID } from "../server/assets/video/webm.ts";
import {
  ROWS,
  SECRETS,
  clapBox,
  encodeBox,
  iphoneMov,
  mp4File,
  mp4WithSecretsFrom,
  paspBox,
  readMp4Recording,
  readWebmRecording,
  tkhdMatrix,
  uint,
  webmFile,
  webmWithSecretsFrom,
  type Box,
  type Mp4Track,
} from "../server/assets/video/videoTestutil.ts";

/**
 * Makes the animated map fixtures (docs/design/design-v1-animated-maps.md
 * 12, docs/design/design-v1-video-turns.md 14, e2e/fixtures/README.md):
 *
 *   node scripts/video-fixtures.ts           records the two loops, then makes the rest from them
 *   node scripts/video-fixtures.ts derived   makes the rest from the loops already here
 *
 * The loops are map-loop.webm (VP9) and map-loop.mp4 (H.264), each 640 x
 * 360 and 2 s long. Chrome's MediaRecorder records a test pattern drawn on
 * a canvas: color bars, a square that crosses them and the frame's number.
 * A recording is no plain file (the WebM has no length and the MP4 is
 * fragmented, both of which the server refuses), so the test writer
 * rebuilds each one from its frames, as a muxer would, never touching a
 * frame. Then each file must pass the server's header check and play and
 * loop in Chrome, and so must a copy with identifying text added and then
 * cleared by the check.
 *
 * The rest are the loops' own frames under other headers: turned, mirrored,
 * stretched and cropped pictures as phones, cameras, Apple's editors and
 * FFmpeg write them, and an iPhone's MOV. Each must meet the check as the
 * design says, and each one stored must play and loop in Chrome. A turned
 * or stretched MP4 stored is byte for byte the stored plain loop, since the
 * check rewrites only its header.
 */

/**
 * The few browser globals the page code below uses. The server's type
 * program has no DOM library, so the page code reads them from globalThis
 * through this shape, as the e2e tests do.
 */
type Canvas = {
  width: number;
  height: number;
  getContext(kind: "2d", options: { alpha: boolean }): Paint | null;
  captureStream(fps: number): unknown;
};
type Paint = { fillStyle: string; font: string; fillRect(x: number, y: number, w: number, h: number): void; fillText(text: string, x: number, y: number): void };
type Video = {
  muted: boolean;
  loop: boolean;
  playsInline: boolean;
  src: string;
  readonly currentTime: number;
  readonly duration: number;
  readonly error: { readonly code: number } | null;
  readonly videoWidth: number;
  play(): Promise<void>;
  pause(): void;
  remove(): void;
  addEventListener(type: "timeupdate", listener: () => void): void;
};
type Recorder = { ondataavailable: (e: { data: Blob }) => void; onstop: () => void; start(): void; stop(): void };
type Browser = {
  document: { body: { append(el: Canvas | Video): void }; createElement(tag: "canvas"): Canvas; createElement(tag: "video"): Video };
  MediaRecorder: new (stream: unknown, options: { mimeType: string; videoBitsPerSecond: number }) => Recorder;
};

const OUT = fileURLToPath(new URL("../e2e/fixtures/", import.meta.url));
const SECONDS = 2;

async function record(page: Page, mimeType: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (mime) => {
    const { document, MediaRecorder } = globalThis as unknown as Browser;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    document.body.append(canvas);
    // Opaque, or Chrome records the canvas's alpha as a plane of its own, which animated maps refuse.
    const ctx = canvas.getContext("2d", { alpha: false })!;
    const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
    let frame = 0;
    const draw = () => {
      bars.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect((i * 640) / bars.length, 0, 640 / bars.length + 1, 270);
      });
      ctx.fillStyle = "#101010";
      ctx.fillRect(0, 270, 640, 90);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(((frame * 8) % 680) - 40, 290, 40, 40);
      ctx.font = "28px monospace";
      ctx.fillText(String(frame).padStart(3, "0"), 560, 340);
      frame++;
    };
    draw();
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const timer = setInterval(draw, 1000 / 30);
    recorder.start();
    await new Promise((r) => setTimeout(r, 2700));
    const stopped = new Promise<void>((r) => (recorder.onstop = r));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }, mimeType);
  return Buffer.from(base64, "base64");
}

const FRAMES = SECONDS * 30;

/**
 * The recording's first 60 frames from its first key frame, timed at
 * exactly 30 a second and rebuilt as a plain WebM with a Duration and Cues.
 * A recording's frames arrive as the page's timer fires, a little early or
 * late, and a container's timestamps are its own: re-timing them changes no
 * frame and gives every test the same steady 30 fps loop.
 */
function plainWebm(recorded: Buffer): Buffer {
  const rec = readWebmRecording(recorded);
  const start = rec.frames.findIndex((f) => f.key);
  const frames = rec.frames.slice(start, start + FRAMES).map((f, i) => ({ ...f, ms: Math.round((i * 1000) / 30) }));
  if (frames.length !== FRAMES) throw new Error(`the WebM recording held ${frames.length} frames from its first key frame`);
  return webmFile({ width: rec.width, height: rec.height, codec: rec.codecId, ...(rec.codecPrivate ? { codecPrivate: rec.codecPrivate } : {}), frames, durationMs: SECONDS * 1000 });
}

/** The same for the MP4: 60 samples from its first sync sample, 1000 ticks each in a 30000 timescale, in one moov and one mdat. */
function plainMp4(recorded: Buffer): Buffer {
  const rec = readMp4Recording(recorded);
  const start = rec.samples.findIndex((s) => s.key);
  const samples = rec.samples.slice(start, start + FRAMES).map((s) => ({ ...s, delta: 1000, cts: 0 }));
  if (samples.length !== FRAMES || rec.samples.some((s) => s.cts !== 0)) throw new Error("the MP4 recording is not 60 frames in decode order from its first sync sample");
  return mp4File({ tracks: [{ handler: "vide", entry: rec.entry, timescale: 30_000, samples }] });
}

/** Plays the bytes muted and looping in Chrome, and answers its length, whether it came round again and any media error. */
async function plays(page: Page, bytes: Buffer, type: string): Promise<{ duration: number; looped: boolean; width: number; error: number | null }> {
  return page.evaluate(
    async ({ base64, type }) => {
      const { document } = globalThis as unknown as Browser;
      const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      document.body.append(video);
      video.src = URL.createObjectURL(new Blob([raw], { type }));
      await video.play();
      let looped = false;
      let last = 0;
      video.addEventListener("timeupdate", () => {
        if (video.currentTime < last) looped = true;
        last = video.currentTime;
      });
      await new Promise((r) => setTimeout(r, 3200));
      const out = { duration: video.duration, looped, width: video.videoWidth, error: video.error?.code ?? null };
      video.pause();
      video.remove();
      return out;
    },
    { base64: bytes.toString("base64"), type },
  );
}

function playedWell(file: string, p: Awaited<ReturnType<typeof plays>>): void {
  if (Math.abs(p.duration - SECONDS) > 0.05 || !p.looped || p.width !== 640 || p.error !== null) throw new Error(`${file} did not play and loop as a 2 s, 640 px video: ${JSON.stringify(p)}`);
}

/** The MP4 loop's picture as a track to rebuild under other headers. */
function loopTrack(loop: Buffer): Mp4Track {
  const rec = readMp4Recording(loop);
  return { handler: "vide", entry: rec.entry, timescale: rec.timescale, samples: rec.samples };
}

/** The loop's sample entry with its box of `box`'s type swapped for `box` where it lies, or `box` added last where it has none. */
function entryWith(track: Mp4Track, box: Box): Mp4Track {
  const head = track.entry.head!;
  const parts: Buffer[] = [head.subarray(0, 78)];
  let swapped = false;
  for (let at = 78; at + 8 <= head.length; at += head.readUInt32BE(at)) {
    const same = head.subarray(at + 4, at + 8).toString("latin1") === box.type;
    parts.push(same ? encodeBox(box) : head.subarray(at, at + head.readUInt32BE(at)));
    swapped ||= same;
  }
  if (!swapped) parts.push(encodeBox(box));
  return { ...track, entry: { type: track.entry.type, head: Buffer.concat(parts) } };
}

/** What each made file must meet: the geometry the check finds, or its refusal. */
type Expect = { geometry: Partial<Pick<VideoFacts, "turn" | "mirror" | "displayWidthPx">>; samePlain?: boolean } | { refused: string };

/**
 * The loops' frames under other headers (docs/design/design-v1-video-turns.md
 * 14). The pattern's bars and dark strip tell all eight orientations apart.
 */
function derived(mp4: Buffer, webm: Buffer): Array<{ file: string; type: string; bytes: Buffer; expect: Expect }> {
  const track = loopTrack(mp4);
  const [w, h] = [640 * 0x10000, 360 * 0x10000];
  const rec = readWebmRecording(webm);
  return [
    // Android's MediaMuxer: the 90 row with no translation.
    { file: "map-turn-90.mp4", type: "video/mp4", bytes: mp4File({ tracks: [{ ...track, matrix: tkhdMatrix(ROWS.turn90) }] }), expect: { geometry: { turn: 90 }, samePlain: true } },
    // Apple's: the 180 row moved back into view by (W, H).
    { file: "map-turn-180.mp4", type: "video/mp4", bytes: mp4File({ tracks: [{ ...track, matrix: tkhdMatrix(ROWS.turn180, w, h) }] }), expect: { geometry: { turn: 180 }, samePlain: true } },
    // FFmpeg's -display_rotation 90 -display_hflip: counter-clockwise, then a, c and tx negated, with no translation.
    { file: "map-turn-270-mirror.mp4", type: "video/mp4", bytes: mp4File({ tracks: [{ ...track, matrix: tkhdMatrix(ROWS.turn270Mirror) }] }), expect: { geometry: { turn: 270, mirror: true }, samePlain: true } },
    // FFmpeg's MP4 mode: pasp 4:3 beside tkhd's width times the aspect, rounded in 16.16.
    { file: "map-wide.mp4", type: "video/mp4", bytes: mp4File({ tracks: [{ ...entryWith(track, paspBox(4, 3)), tkhdRaw: { width: Math.round((w * 4) / 3), height: h } }] }), expect: { geometry: { displayWidthPx: 853 }, samePlain: true } },
    {
      file: "map-wide.webm",
      type: "video/webm",
      bytes: webmFile({ width: rec.width, height: rec.height, codec: rec.codecId, ...(rec.codecPrivate ? { codecPrivate: rec.codecPrivate } : {}), frames: rec.frames, durationMs: SECONDS * 1000, videoKids: [uint(EBML_ID.DisplayWidth, 853), uint(EBML_ID.DisplayHeight, 360)] }),
      expect: { geometry: { displayWidthPx: 853 } },
    },
    // A real crop of 8 px off the width, which stays refused.
    { file: "map-clap.mp4", type: "video/mp4", bytes: mp4File({ tracks: [entryWith(track, clapBox(632, 1, 360, 1))] }), expect: { refused: "video_geometry" } },
    { file: "map-iphone.mov", type: "video/mp4", bytes: iphoneMov(track), expect: { geometry: { turn: 90 } } },
  ];
}

const loops = process.argv.includes("derived")
  ? { webm: await readFile(`${OUT}map-loop.webm`), mp4: await readFile(`${OUT}map-loop.mp4`) }
  : undefined;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>fixtures</title>");
  const webm = loops?.webm ?? plainWebm(await record(page, "video/webm;codecs=vp9"));
  const mp4 = loops?.mp4 ?? plainMp4(await record(page, "video/mp4;codecs=avc1.42E01E"));
  if (!loops) {
    const made = [
      { file: "map-loop.webm", type: "video/webm", bytes: webm, secrets: webmWithSecretsFrom },
      { file: "map-loop.mp4", type: "video/mp4", bytes: mp4, secrets: mp4WithSecretsFrom },
    ];
    for (const m of made) {
      const { facts } = await checkVideoBytes(m.bytes);
      const played = await plays(page, m.bytes, m.type);
      const cleared = (await checkVideoBytes(m.secrets(m.bytes))).zeroed;
      const clearedPlayed = await plays(page, cleared, m.type);
      console.log(m.file, m.bytes.length, "bytes", JSON.stringify(facts), "plays", JSON.stringify(played), "cleared copy plays", JSON.stringify(clearedPlayed));
      for (const p of [played, clearedPlayed]) playedWell(m.file, p);
      await writeFile(`${OUT}${m.file}`, m.bytes);
    }
  }
  const plainStored = (await checkVideoBytes(mp4)).zeroed;
  for (const d of derived(mp4, webm)) {
    const checked = await checkVideoBytes(d.bytes).catch((err: unknown) => {
      if (err instanceof AssetError) return err;
      throw err;
    });
    if ("refused" in d.expect) {
      if (!(checked instanceof AssetError) || checked.code !== d.expect.refused) throw new Error(`${d.file} was not refused as ${d.expect.refused}`);
      console.log(d.file, d.bytes.length, "bytes, refused as", checked.code);
    } else {
      if (checked instanceof AssetError) throw new Error(`${d.file} was refused as ${checked.code}`);
      const { turn, mirror, displayWidthPx } = checked.facts;
      const geometry = { ...(turn ? { turn } : {}), ...(mirror ? { mirror } : {}), ...(displayWidthPx ? { displayWidthPx } : {}) };
      if (JSON.stringify(geometry) !== JSON.stringify(d.expect.geometry)) throw new Error(`${d.file} checked as ${JSON.stringify(geometry)}, not ${JSON.stringify(d.expect.geometry)}`);
      if (d.expect.samePlain && !checked.zeroed.equals(plainStored)) throw new Error(`${d.file} stored is not the plain loop stored`);
      const left = Object.values(SECRETS).filter((s) => checked.zeroed.includes(s));
      if (left.length > 0) throw new Error(`${d.file} stored still holds ${left.join(", ")}`);
      const played = await plays(page, checked.zeroed, d.type);
      playedWell(d.file, played);
      console.log(d.file, d.bytes.length, "bytes", JSON.stringify(checked.facts), "stored plays", JSON.stringify(played));
    }
    await writeFile(`${OUT}${d.file}`, d.bytes);
  }
} finally {
  await browser.close();
}
