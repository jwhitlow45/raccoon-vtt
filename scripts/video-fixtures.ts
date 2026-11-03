import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { checkVideoBytes } from "../server/assets/video/check.ts";
import { mp4File, mp4WithSecretsFrom, readMp4Recording, readWebmRecording, webmFile, webmWithSecretsFrom } from "../server/assets/video/videoTestutil.ts";

/**
 * Makes the animated map fixtures, e2e/fixtures/map-loop.webm (VP9) and
 * map-loop.mp4 (H.264), each 640 x 360 and 2 s long
 * (docs/design/design-v1-animated-maps.md 12, e2e/fixtures/README.md):
 *
 *   node scripts/video-fixtures.ts
 *
 * Chrome's MediaRecorder records a test pattern drawn on a canvas: color
 * bars, a square that crosses them and the frame's number. A recording is
 * no plain file (the WebM has no length and the MP4 is fragmented, both of
 * which the server refuses), so the test writer rebuilds each one from its
 * frames, as a muxer would, never touching a frame. Then each file must
 * pass the server's header check and play and loop in Chrome, and so must
 * a copy with identifying text added and then cleared by the check.
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

/** Plays the bytes muted and looping in Chrome, and answers its length and whether it came round again. */
async function plays(page: Page, bytes: Buffer, type: string): Promise<{ duration: number; looped: boolean; width: number }> {
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
      const out = { duration: video.duration, looped, width: video.videoWidth };
      video.pause();
      video.remove();
      return out;
    },
    { base64: bytes.toString("base64"), type },
  );
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>fixtures</title>");
  const made = [
    { file: "map-loop.webm", type: "video/webm", bytes: plainWebm(await record(page, "video/webm;codecs=vp9")), secrets: webmWithSecretsFrom },
    { file: "map-loop.mp4", type: "video/mp4", bytes: plainMp4(await record(page, "video/mp4;codecs=avc1.42E01E")), secrets: mp4WithSecretsFrom },
  ];
  for (const m of made) {
    const { facts } = await checkVideoBytes(m.bytes);
    const played = await plays(page, m.bytes, m.type);
    const cleared = (await checkVideoBytes(m.secrets(m.bytes))).zeroed;
    const clearedPlayed = await plays(page, cleared, m.type);
    console.log(m.file, m.bytes.length, "bytes", JSON.stringify(facts), "plays", JSON.stringify(played), "cleared copy plays", JSON.stringify(clearedPlayed));
    for (const p of [played, clearedPlayed]) {
      if (Math.abs(p.duration - SECONDS) > 0.05 || !p.looped || p.width !== 640) throw new Error(`${m.file} did not play and loop as a 2 s, 640 px video: ${JSON.stringify(p)}`);
    }
    await writeFile(`${OUT}${m.file}`, m.bytes);
  }
} finally {
  await browser.close();
}
