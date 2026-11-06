import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { withTagFrame } from "../shared/audio/mp3Testutil.ts";
import { concat, id3v2, mp3Of, toneSamples } from "../client/features/sound/upload/sounds.testutil.ts";
import { committed, longMp3At48, toneWav, wavOfChannels } from "./fixtures/sounds.ts";
import { ConsoleWatch, OpSocket, openSideTab, ROOT, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Adding sounds (docs/design/design-v1-music.md 4.2, 12): the DM's browser
 * reads each file, evens its loudness and makes the room's MP3, copied or
 * encoded in a Worker.
 *
 * su-1 to su-6 drive the reader itself in Chrome, through Vite's dev server
 * (as kit.e2e.ts does), so they need no server: the guards before any
 * decoding, WAVs read in pieces, a 5.1 file mixed, MP3s copied or
 * converted, the pieces' pre-roll against a whole decode, a piece that
 * fails falling back, the length caps exactly at 30 s and 15 minutes, and
 * the time a 10-minute WAV takes. su-7 and su-8 run the production build
 * with the server's ROOM_SOUND switch on: the Sound panel's Add buttons,
 * their rows, a refusal, Cancel, and what the room keeps.
 *
 * The small fixtures are e2e/fixtures/sound-*, made by e2e/fixtures/sounds.ts
 * (its README). The long ones are written to a temporary folder here.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus 50, Vite first and then the
 * server on the same port. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 50;
const ORIGIN = `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);
/** The few shots for the owner, before and after, beside the run's own. */
const OWNER_SHOTS = process.env.SOUND_OWNER_SHOTS ?? null;

const FIXTURES = path.join(ROOT, "e2e", "fixtures");
const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-soundupload-"));
const MB = 1024 * 1024;

let vite: ChildProcess | null = null;
let viteOutput = "";
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleWatch = new ConsoleWatch("reader");

/** A fixture's path, committed or written here. */
function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

function written(name: string, bytes: Uint8Array): string {
  const file = path.join(work, name);
  writeFileSync(file, bytes);
  return file;
}

async function startVite(): Promise<void> {
  vite = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stdout?.on("data", (b: Buffer) => (viteOutput += b.toString("utf8")));
  vite.stderr?.on("data", (b: Buffer) => (viteOutput += b.toString("utf8")));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (vite.exitCode !== null) throw new Error(`Vite exited during startup:\n${viteOutput}`);
    try {
      if ((await fetch(`${ORIGIN}/dev/kit`)).ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Vite did not answer within 30 s:\n${viteOutput}`);
    await sleep(100);
  }
}

async function stopVite(): Promise<void> {
  if (!vite || vite.exitCode !== null) return;
  const exited = new Promise((resolve) => vite!.once("exit", resolve));
  vite.kill("SIGTERM");
  await exited;
}

/**
 * The page's side: the reader's modules from the dev server, a file input
 * to hand it files the way the picker does, and counters on the decoder
 * and the Worker constructor, so a step can show that a refusal came
 * before any decoding. `failDecodeAt` makes that decode call reject, as a
 * piece the browser cannot decode would.
 */
const PAGE_SIDE = `
window.__su = {
  decodes: 0,
  workers: 0,
  failDecodeAt: 0,
  async load() {
    this.read = await import("/features/sound/upload/read.ts");
    this.copy = await import("/features/sound/upload/copy.ts");
    this.loudness = await import("/features/sound/upload/loudness.ts");
    this.pieces = await import("/features/sound/upload/pieces.ts");
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    const self = this;
    OfflineAudioContext.prototype.decodeAudioData = function (buffer) {
      self.decodes++;
      if (self.decodes === self.failDecodeAt) return Promise.reject(new DOMException("a test's failed piece", "EncodingError"));
      return decode.call(this, buffer);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        self.workers++;
      }
    };
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "su-pick";
    document.body.append(input);
  },
  async prepare(index, use, budget) {
    const file = document.getElementById("su-pick").files[index];
    const steps = [];
    const decodes = this.decodes;
    const workers = this.workers;
    const started = performance.now();
    const outcome = await this.read.prepareSound({ file, use, budget, signal: new AbortController().signal, onStep: (s) => steps.push(s.t) });
    const took = performance.now() - started;
    const base = { name: file.name, took, steps: [...new Set(steps)], decodes: this.decodes - decodes, workers: this.workers - workers };
    if (!outcome.ok) return { ...base, ok: false, why: outcome.why };
    const bytes = new Uint8Array(await outcome.prepared.blob.arrayBuffer());
    const check = this.copy.copyable(bytes);
    return {
      ...base,
      ok: true,
      copied: outcome.prepared.copied,
      level: outcome.prepared.level,
      ms: outcome.prepared.ms,
      type: outcome.prepared.blob.type,
      size: bytes.length,
      startsWithTag: bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33,
      walk: check.ok ? { ...check.facts, offsets: undefined, stripped: check.stripped } : { why: check.why },
    };
  },
  async preRoll(index) {
    const file = document.getElementById("su-pick").files[index];
    const check = this.copy.copyable(new Uint8Array(await file.arrayBuffer()));
    if (!check.ok) return { why: check.why };
    const pieces = this.pieces.mp3Pieces(check.facts, check.bytes.length);
    const context = new OfflineAudioContext(1, 1, 44100);
    const whole = (await context.decodeAudioData(check.bytes.slice().buffer)).getChannelData(0);
    const second = pieces[1];
    const decoded = await context.decodeAudioData(check.bytes.slice(second.start, second.end).buffer);
    const kept = decoded.getChannelData(0).subarray(second.drop, second.drop + second.keep);
    const from = pieces[0].keep;
    const span = 44100;
    const error = (lag) => {
      let sum = 0;
      for (let i = 0; i < span; i++) sum += (kept[i] - whole[from + lag + i]) ** 2;
      return Math.sqrt(sum / span);
    };
    let best = 0;
    for (let lag = -1200; lag <= 1200; lag++) if (error(lag) < error(best)) best = lag;
    return { pieces: pieces.length, drop: second.drop, keep: second.keep, decodedLength: decoded.length, bestLag: best, errorAtBest: error(best), errorAtZero: error(0) };
  },
};
`;

/** The reader's page on the dev server, its modules loaded once so Vite's first look at them cannot reload it mid-step. */
async function readerPage(): Promise<void> {
  page = await context.newPage();
  consoleWatch.attach(page);
  await page.goto(`${ORIGIN}/dev/kit`);
  await page.evaluate(PAGE_SIDE);
  await page.evaluate("window.__su.load()");
}

type Prepared = {
  name: string;
  ok: boolean;
  why?: { t: string; channels?: number; use?: string };
  copied?: boolean;
  level?: number;
  ms?: number;
  type?: string;
  size?: number;
  startsWithTag?: boolean;
  walk?: { rateHz?: number; kbps?: number; channels?: number; ms?: number; stripped?: number; why?: string };
  took: number;
  steps: string[];
  decodes: number;
  workers: number;
};

/** Hands the page these files, as the picker would, and reads each, one at a time. */
async function prepareAll(files: string[], use: "music" | "loop" | "effect", budget?: number): Promise<Prepared[]> {
  await page.setInputFiles("#su-pick", files);
  const out: Prepared[] = [];
  for (let i = 0; i < files.length; i++) out.push((await page.evaluate(`window.__su.prepare(${i}, ${JSON.stringify(use)}, ${budget ?? "undefined"})`)) as Prepared);
  return out;
}

const PHONE_BUDGET = 150 * MB;

after(() => rmSync(work, { recursive: true, force: true }));

describe("adding sounds", { concurrency: false }, () => {
  before(async () => {
    for (const name of Object.keys(committed())) assert.ok(existsSync(fixture(name)), `the fixture ${name} (node e2e/fixtures/sounds.ts makes it)`);
    await startVite();
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await readerPage();
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error("[reader] errors", consoleWatch.errors, "warnings", consoleWatch.warnings, viteOutput.slice(-4000));
    await browser?.close();
    await stopVite();
  });

  test("su-1. the committed files: WAVs converted, 5.1 mixed to stereo, the VBR and 320 kbps MP3s converted, the tagged 128 kbps MP3 copied without its tags", async () => {
    const names = ["sound-tone.wav", "sound-surround.wav", "sound-vbr.mp3", "sound-tagged.mp3", "sound-tagged-320.mp3"];
    const results = await prepareAll(names.map(fixture), "effect");
    const [tone, surround, vbr, tagged, fast] = results as [Prepared, Prepared, Prepared, Prepared, Prepared];
    for (const r of results) {
      assert.ok(r.ok, `${r.name}: ${JSON.stringify(r.why)}`);
      assert.equal(r.type, "audio/mpeg");
      assert.ok(r.walk?.kbps !== undefined, `${r.name}'s copy failed the server's walk: ${r.walk?.why}`);
      assert.equal(r.walk?.stripped, 0, `${r.name}'s copy has a tag`);
      assert.equal(r.startsWithTag, false);
      assert.equal(r.ms, r.walk?.ms);
    }
    // A 1 kHz tone at -20 dBFS reads -20 LUFS: +2 dB to -18, in tenths.
    assert.deepEqual([tone.copied, tone.walk?.rateHz, tone.walk?.kbps, tone.walk?.channels], [false, 44_100, 128, 2]);
    assert.ok(Math.abs(tone.level! - 20) <= 5, `the tone's level ${tone.level}`);
    assert.ok(tone.steps.includes("converting"));
    assert.equal(tone.decodes, 0, "a plain WAV is read straight from its PCM, never decoded");
    // The 48 kHz WAV keeps its rate.
    assert.deepEqual([surround.copied, surround.walk?.rateHz, surround.walk?.channels, surround.decodes], [false, 48_000, 2, 0]);
    assert.deepEqual([vbr.copied, vbr.walk?.kbps, vbr.decodes], [false, 128, 1]);
    assert.deepEqual([fast.copied, fast.walk?.kbps], [false, 128]);
    const taggedBytes = readFileSync(fixture("sound-tagged.mp3")).length;
    assert.equal(tagged.copied, true);
    assert.equal(tagged.size, taggedBytes - 4096 - 128, "the copy is the frames alone, both tags gone");
    assert.equal(tagged.workers, 1, "a copied file is measured in the worker, never encoded");
    assert.deepEqual(consoleWatch.errors, []);
  });

  test("su-1b. an Info and LAME frame is dropped with the tags and the file still measured in pieces, and an emphasis file is converted", async () => {
    const frames = mp3Of(toneSamples({ seconds: 75, rateHz: 44_100, channels: 2, tone: { hz: 1000, dbfs: -20 } }), 44_100);
    const tagged = written("info-frame.mp3", concat([id3v2("Info frame", 64 * 1024), withTagFrame(frames)]));
    const emphasis = frames.slice();
    for (let at = 0; at + 4 <= emphasis.length && emphasis[at] === 0xff; ) {
      emphasis[at + 3]! |= 1;
      const padded = (emphasis[at + 2]! >> 1) & 1;
      at += Math.floor((144_000 * 128) / 44_100) + padded;
    }
    const [info, flagged] = await prepareAll([tagged, written("emphasis.mp3", emphasis)], "music");
    assert.ok(info?.ok, JSON.stringify(info));
    assert.deepEqual([info.copied, info.size, info.decodes, info.walk?.stripped], [true, frames.length, 2, 0]);
    assert.ok(flagged?.ok, JSON.stringify(flagged));
    assert.deepEqual([flagged.copied, flagged.decodes, flagged.walk?.kbps], [false, 1, 128]);
    // The same audio measured in pieces past every tag and decoded whole reads the same. The encoder's own copy of a
    // 1 kHz tone at -20 dBFS decodes about 0.4 dB under its source, so the level is near +2.4 dB.
    assert.ok(Math.abs(info.level! - flagged.level!) <= 1, `pieces ${info.level}, whole ${flagged.level}`);
    assert.ok(Math.abs(info.level! - 22) <= 4, `the level ${info.level}`);
  });

  test("su-2. a 48 kHz MP3 in 60-second pieces: each piece's pre-roll of 10,584 samples dropped lines up with a whole decode", async () => {
    const file = written("pieces-48k.mp3", longMp3At48(130));
    await page.setInputFiles("#su-pick", [file]);
    const r = (await page.evaluate("window.__su.preRoll(0)")) as { pieces: number; drop: number; keep: number; decodedLength: number; bestLag: number; errorAtBest: number; errorAtZero: number; why?: string };
    assert.equal(r.why, undefined);
    assert.equal(r.pieces, 3);
    assert.equal(r.drop, 10_584);
    assert.ok(r.decodedLength >= r.drop + r.keep - 1152, `a piece decodes to its pre-roll and its frames: ${JSON.stringify(r)}`);
    assert.equal(r.bestLag, 0, `the kept samples sit where the whole decode has them: ${JSON.stringify(r)}`);
    assert.ok(r.errorAtZero < 0.01, `the piece matches the whole decode: ${JSON.stringify(r)}`);
    const [whole] = await prepareAll([file], "music");
    assert.ok(whole?.ok && whole.copied, JSON.stringify(whole));
    assert.equal(whole.decodes, 3, "three pieces, never the whole file");
  });

  test("su-3. a piece the browser cannot decode falls back to decoding the whole file, converted", async () => {
    const file = written("pieces-fail.mp3", longMp3At48(70));
    await page.evaluate("window.__su.failDecodeAt = window.__su.decodes + 2");
    const [r] = await prepareAll([file], "music");
    await page.evaluate("window.__su.failDecodeAt = 0");
    assert.ok(r?.ok, JSON.stringify(r));
    assert.equal(r.copied, false);
    assert.equal(r.decodes, 3, "the first piece, the failed one, then the whole file");
    assert.deepEqual([r.walk?.rateHz, r.walk?.channels, r.walk?.kbps], [44_100, 1, 64]);
  });

  test("su-4. the caps hold exactly on the source: a 30.000 s effect and a 15:00.000 track are added, a sample more is refused", async () => {
    const mono: Parameters<typeof toneWav>[1] = { channels: 1, rateHz: 44_100, bits: 16, sample: "int" };
    const files = [written("effect-30s.wav", toneWav(30, mono)), written("effect-over.wav", toneWav(30 + 1 / 44_100, mono)), written("music-15min.wav", toneWav(900, mono))];
    await page.setInputFiles("#su-pick", files);
    const effect = (await page.evaluate(`window.__su.prepare(0, "effect")`)) as Prepared;
    const over = (await page.evaluate(`window.__su.prepare(1, "effect")`)) as Prepared;
    const music = (await page.evaluate(`window.__su.prepare(2, "music")`)) as Prepared;
    assert.ok(effect.ok, JSON.stringify(effect));
    assert.ok(effect.ms! > 30_000 && effect.ms! <= 30_100, `the effect's encoded length ${effect.ms}`);
    assert.deepEqual(over.why, { t: "useTooLong", use: "effect" });
    assert.deepEqual([over.decodes, over.workers], [0, 0], "refused before reading a sample");
    assert.ok(music.ok, JSON.stringify(music));
    assert.ok(music.ms! > 900_000 && music.ms! <= 900_100, `the track's encoded length ${music.ms}`);
    console.log(`su-4: a 15-minute mono WAV converted in ${Math.round(music.took)} ms`);
  });

  test("su-5. a 10-minute stereo WAV converts in under a minute on this computer", async () => {
    const file = written("ten-minutes.wav", toneWav(600));
    const [r] = await prepareAll([file], "music");
    assert.ok(r?.ok, JSON.stringify(r));
    assert.equal(r.decodes, 0);
    console.log(`su-5: a 10-minute stereo 44.1 kHz WAV (${Math.round(readFileSync(file).length / MB)} MiB) converted in ${Math.round(r.took)} ms`);
    assert.ok(r.took < 60_000, `${r.took} ms`);
    rmSync(file);
  });

  test("su-6. refused before any decoding: 8 channels, channels it cannot read, and a whole decode past a phone's budget", async () => {
    const quad22 = written("quad-22k.wav", toneWav(180, { channels: 4, rateHz: 22_050, bits: 8, sample: "int" }));
    const files = [written("Mix.wav", wavOfChannels(8)), written("Rain.caf", new TextEncoder().encode("caff".padEnd(4096, "\0"))), quad22];
    await page.setInputFiles("#su-pick", files);
    const eight = (await page.evaluate(`window.__su.prepare(0, "effect")`)) as Prepared;
    const caf = (await page.evaluate(`window.__su.prepare(1, "effect")`)) as Prepared;
    const phone = (await page.evaluate(`window.__su.prepare(2, "music", ${PHONE_BUDGET})`)) as Prepared;
    assert.deepEqual(eight.why, { t: "channels", channels: 8 });
    assert.deepEqual(caf.why, { t: "channelsUnknown" });
    assert.deepEqual(phone.why, { t: "tooBigToRead" });
    for (const r of [eight, caf, phone]) assert.deepEqual([r.decodes, r.workers], [0, 0], `${r.name} reached a decoder`);
    // The same file on a computer decodes whole, mixed from 4 channels at 22.05 kHz.
    const computer = (await page.evaluate(`window.__su.prepare(2, "music")`)) as Prepared;
    assert.ok(computer.ok, JSON.stringify(computer));
    assert.deepEqual([computer.decodes, computer.walk?.rateHz, computer.walk?.channels], [1, 44_100, 2]);
    assert.deepEqual(consoleWatch.errors, []);
  });
});

/*
 * The Sound panel's Add buttons on the production build, with the server's
 * switch on. They need the whole sound stack: the panel, the server's
 * `sound` kind and `sound.create`.
 */
describe("the Add buttons", { concurrency: false }, () => {
  let server: Server;
  let dmContext: BrowserContext;
  let dm: Page;
  let ops: OpSocket | null = null;
  const dmSocket = new SocketWatch("dm");
  const dmConsole = new ConsoleWatch("dm");
  const assetDir = path.join(work, "assets");
  const run = { roomId: "", roomName: `E2E sound upload ${new Date().toISOString().slice(0, 19)}` };

  before(async () => {
    mkdirSync(assetDir, { recursive: true });
    process.env.ROOM_SOUND = "1";
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error("[dm] errors", dmConsole.errors, server?.output().split("\n").slice(-40).join("\n"));
    ops?.close();
    if (run.roomId && dmContext) {
      try {
        await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
  });

  /** The Sound section's part that holds an Add button, by its use. */
  const adder = (use: "music" | "loop" | "effect") => dm.locator(`[data-add-sounds="${use}"]`);

  test("su-7. the DM adds effects: rows read, convert and upload, a refusal stays on its row, and the room holds each sound with its level", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await waitFor("the DM's snapshot", () => dmSocket.state);

    // The Sound panel opens on Now playing, where Effects stands (docs/design/design-v1-sound-layout.md 4.2).
    await openSideTab(dm, "Sound");
    const effects = adder("effect");
    await effects.getByRole("button", { name: "Add effects…" }).waitFor();
    if (OWNER_SHOTS) await shotFor(dm, "before-add-effects");
    await effects.locator('input[type="file"]').setInputFiles([fixture("sound-tone.wav"), fixture("sound-tagged.mp3"), written("Mix.wav", wavOfChannels(8))]);
    // The rows appear at once, in the order picked, each with its own Cancel.
    await effects.getByRole("button", { name: "Cancel sound-tone.wav" }).waitFor();
    await shots.take(dm, "su-7-rows");
    await effects.getByText("Added sound-tone.").waitFor({ timeout: 30_000 });
    await effects.getByText("Mix.wav has 8 channels. Use a mono or stereo file.").waitFor({ timeout: 30_000 });
    if (OWNER_SHOTS) await shotFor(dm, "after-add-effects-refused");
    await shots.take(dm, "su-7-refused");
    assert.deepEqual(alignmentLines(await measureAlignment(effects), "the effects' rows"), []);
    await effects.getByText("Added sound-tagged.").waitFor({ timeout: 30_000 });

    const sounds = await waitFor("both sounds in the room", () => {
      const all = Object.values((dmSocket.state as unknown as { sounds?: Record<string, { name?: string; use: string; level?: number; assetId: string; ms: number }> }).sounds ?? {});
      return all.length === 2 ? all : null;
    });
    const tone = sounds.find((s) => s.name === "sound-tone")!;
    const tagged = sounds.find((s) => s.name === "sound-tagged")!;
    assert.equal(tone.use, "effect");
    assert.ok(Math.abs((tone.level ?? 0) - 20) <= 5, `the tone's level ${tone.level}`);
    // The copy the server keeps is the tagged file's frames alone.
    const res = await dmContext.request.get(`${server.origin}/api/assets/${tagged.assetId}/full`);
    assert.equal(res.status(), 200);
    assert.equal(res.headers()["content-type"], "audio/mpeg");
    assert.equal((await res.body()).length, readFileSync(fixture("sound-tagged.mp3")).length - 4096 - 128);
    // "Added" goes after 3 seconds, the refusal stays until dismissed.
    await effects.getByText("Added sound-tone.").waitFor({ state: "detached", timeout: 6_000 });
    await effects.getByRole("button", { name: "Dismiss Mix.wav" }).click();
    await effects.getByText(/has 8 channels/).waitFor({ state: "detached" });
    assert.deepEqual(dmConsole.errors, []);
  });

  test("su-8. Cancel stops a long file, which never reaches the room", async () => {
    // Add music… is under Library's tracks, Sound's second view (docs/design/design-v1-sound-layout.md 4.4).
    await dm.getByRole("tabpanel", { name: sideTabName("Sound") }).getByRole("radiogroup", { name: "Sound", exact: true }).getByRole("radio", { name: "Library", exact: true }).click();
    const music = adder("music");
    const before = Object.keys((dmSocket.state as unknown as { sounds?: Record<string, unknown> }).sounds ?? {}).length;
    await music.locator('input[type="file"]').setInputFiles([written("Long tavern.wav", toneWav(600))]);
    await music.getByText(/^Converting Long tavern\.wav… \d+%$/).waitFor({ timeout: 30_000 });
    if (OWNER_SHOTS) await shotFor(dm, "after-converting");
    await music.getByRole("button", { name: "Cancel Long tavern.wav" }).click();
    await music.getByText(/Long tavern/).waitFor({ state: "detached" });
    await sleep(1000);
    assert.equal(Object.keys((dmSocket.state as unknown as { sounds?: Record<string, unknown> }).sounds ?? {}).length, before);
  });
});

/** A shot for the owner's folder, at a phone held upright and a computer, never over one already there. */
async function shotFor(page: Page, name: string): Promise<void> {
  if (!OWNER_SHOTS) return;
  mkdirSync(OWNER_SHOTS, { recursive: true });
  const taken = new Set(readdirSync(OWNER_SHOTS));
  let file = `${name}.png`;
  for (let n = 2; taken.has(file); n++) file = `${name}-${n}.png`;
  await page.screenshot({ path: path.join(OWNER_SHOTS, file) });
}
