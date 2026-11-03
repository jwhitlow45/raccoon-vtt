import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, openSideTab, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { addSound, errors, inStep, IPHONE_AUDIO, musicVoice, roomSoundScript, SOUND_TEST_FLAG, soundProbe, soundSays, type SoundProbe } from "./soundRoom.ts";

/**
 * Synced music and sound on every device (docs/design/design-v1-music.md 5
 * and 12), lane SN-C's steps sn-1 to sn-7: sync and a late join with the
 * ask, a crossfade and a pause, what a player's socket carries, a blackout,
 * effects and Stop all, a touch phone's ask and its tap after a reload, and
 * one page per browser with the table display. The sounds are silence
 * built frame by frame (soundRoom.ts), uploaded through the asset route.
 *
 * Each page's engine is read through its test hook (testHook.ts): the root
 * element's `data-sound` ("playing music loops:2", set on change) and,
 * with the flag set before load, `soundVoices` (each voice's sound, aim and
 * place), `soundEffects` and `soundState`. Pages share one machine's
 * clock, so a voice within 100 ms of its aim on two pages puts them within
 * a tenth of a second of each other, before the output latency both share.
 *
 * It runs with `pnpm test:e2e` on its own port, E2E_PORT plus 51, with the
 * server's ROOM_SOUND switch on, in a Chrome that plays without a gesture
 * (`--autoplay-policy=no-user-gesture-required`). sn-6's phones take an
 * iPhone's autoplay rules instead (soundRoom.ts IPHONE_AUDIO) and tap with
 * touch.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 51;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-sound-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const TV = { width: 1280, height: 720 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };

const run = {
  roomId: "",
  roomName: `E2E sound ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  runs: 0,
  ids: { tavern: "snd-tavern", road: "snd-road", crypt: "snd-crypt", rain: "snd-rain", thunder: "snd-thunder", bell: "snd-bell" },
  assets: {} as Record<string, string>,
};

function runId(): string {
  return `run${++run.runs}`;
}

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

async function createRoom(page: Page, context: BrowserContext): Promise<void> {
  await page.goto(`${server.origin}/`);
  await page.getByLabel("Room name").fill(run.roomName);
  await page.getByLabel("Your name").fill("Dana the DM");
  run.password = await page.getByLabel("Player password").inputValue();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
  assert.ok(match, `DM link looks wrong: ${link}`);
  run.roomId = match[1]!.replace("-", "");
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
}

async function openRoom(page: Page): Promise<void> {
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
}

async function playTrack(soundId: string, fade: 0 | 2 | 5 | 10 = 0, repeat: "all" | "one" | "off" = "off"): Promise<string> {
  const id = runId();
  await ops.send({ t: "music.play", run: id, soundId, order: [soundId], repeat, fade });
  return id;
}

/** How far apart two pages' music sounds: each place against its own aim, read as close together as two evaluations go. */
async function placesTogether(a: Page, b: Page): Promise<{ a: SoundProbe; b: SoundProbe; gap: number }> {
  const [pa, pb] = await Promise.all([soundProbe(a), soundProbe(b)]);
  const va = musicVoice(pa);
  const vb = musicVoice(pb);
  assert.ok(va && vb, `both pages play music: ${pa.data} / ${pb.data}`);
  // Each place against its own aim: the aims follow one server clock, so this is how far apart the two sound.
  const gap = Math.abs(va.currentMs - va.aimMs - (vb.currentMs - vb.aimMs));
  return { a: pa, b: pb, gap };
}

async function visible(l: Locator): Promise<boolean> {
  return (await l.count()) > 0 && (await l.first().isVisible());
}

async function closeSheets(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const sheet = page.locator("dialog[data-rvtt-sheet]");
    if (!(await visible(sheet))) return;
    await page.keyboard.press("Escape");
    await sleep(150);
  }
}

async function openMenu(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if (await visible(tabs)) {
    await openSideTab(page, "Menu");
    return page.getByRole("tabpanel", { name: sideTabName("Menu") });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
  if (await visible(sheet)) return sheet;
  await closeSheets(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** This device's Sounds section, opened from the Menu. */
async function thisDeviceSounds(page: Page): Promise<Locator> {
  const menu = await openMenu(page);
  const back = menu.getByRole("button", { name: /^Back to Menu/ });
  if (await visible(back)) await back.click();
  await menu.getByRole("button", { name: /^This device/ }).click();
  const section = menu.locator("section").filter({ has: page.getByRole("heading", { name: "Sounds", exact: true }) }).last();
  await section.scrollIntoViewIfNeeded();
  return section;
}

const SIZES = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
  { name: "320x568", width: 320, height: 568 },
] as const;

describe("synced music and sound", { concurrency: false }, () => {
  before(async () => {
    process.env.ROOM_SOUND = "1";
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1", args: ["--autoplay-policy=no-user-gesture-required"] });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const c of [dmContext, patContext]) await c.addInitScript(SOUND_TEST_FLAG);
    await patContext.addInitScript(roomSoundScript("on"));
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    if (run.roomId && dmContext) {
      try {
        const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("sn-0. the DM's room on a computer with music, a background sound and effects, and Pat on a phone with Room sound on", async () => {
    await createRoom(dm, dmContext);
    run.patId = await join(patContext, "Pat", "#3b82f6");
    const add = (id: string, name: string, use: "music" | "loop" | "effect", ms: number) => addSound({ context: dmContext, origin: server.origin, roomId: run.roomId, ops, id, name, use, ms });
    await add(run.ids.tavern, "Tavern night", "music", 40_000);
    await add(run.ids.road, "Forest road", "music", 31_000);
    await add(run.ids.crypt, "Crypt hymn", "music", 32_000);
    await add(run.ids.rain, "Rain", "loop", 6_000);
    await add(run.ids.thunder, "Thunder", "effect", 25_000);
    await add(run.ids.bell, "Bell", "effect", 2_500);
    await openRoom(pat);
    await waitFor("the DM's snapshot holds the sounds", () => (Object.keys(dmSocket.state?.sounds ?? {}).length === 6 ? true : null));
    for (const s of Object.values(dmSocket.state?.sounds ?? {})) run.assets[s.id] = s.assetId;
    // Nothing plays yet: the engine has not loaded, and the page says only that Room sound is on.
    assert.equal((await soundProbe(pat)).data, "", "no engine before anything plays");
  });

  test("sn-1. the DM plays a track, the DM's page and Pat's start together, and Ana joining 5 s in is asked and starts in place within 6 s", async () => {
    const started = Date.now();
    await playTrack(run.ids.tavern);
    await soundSays(dm, /^playing music/, 5_000);
    await soundSays(pat, /^playing music/, 5_000);
    assert.ok(Date.now() - started < 3_000, `both played within 3 s of the op (${Date.now() - started} ms)`);
    await inStep(dm, 100, 6_000);
    await inStep(pat, 100, 6_000);
    const { gap } = await placesTogether(dm, pat);
    assert.ok(gap <= 100, `the DM's page and Pat's within 0.1 s of each other (${gap.toFixed(0)} ms)`);

    // Ana's phone has no choice yet: the ask, then Play here.
    const anaContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      await anaContext.addInitScript(SOUND_TEST_FLAG);
      await join(anaContext, "Ana", "#22c55e");
      const ana = await anaContext.newPage();
      await sleep(Math.max(0, 5_000 - (Date.now() - started)));
      await openRoom(ana);
      const ask = ana.getByRole("status").filter({ hasText: "The DM is playing sound for the room." });
      await ask.waitFor();
      assert.equal((await soundProbe(ana)).voices.length, 0, "quiet until asked");
      await shots.take(ana, "sn-1-the-ask");
      const lines = alignmentLines(await measureAlignment(ask), "the ask 390x844");
      assert.deepEqual(lines, [], "the ask out of line");
      const tapped = Date.now();
      await ask.getByRole("button", { name: "Play here" }).click();
      await ask.waitFor({ state: "detached" });
      assert.equal(await ana.evaluate(() => localStorage.getItem("rvtt.roomSound")), "on", "Play here turns Room sound on");
      await soundSays(ana, /^playing music/, 5_000);
      await inStep(ana, 100, 6_000);
      assert.ok(Date.now() - tapped < 6_500, `in place within 6 s of the tap (${Date.now() - tapped} ms)`);
      const late = await placesTogether(ana, pat);
      assert.ok(late.gap <= 100, `Ana and Pat within 0.1 s (${late.gap.toFixed(0)} ms)`);
      const v = musicVoice(late.a)!;
      assert.ok(Math.abs(v.aimMs - (Date.now() - started)) < 1_500, `Ana joined at the track's place, ${v.aimMs.toFixed(0)} ms in`);
    } finally {
      await anaContext.close();
    }
  });

  test("sn-2. a pause and a resume land every device at the same place, and a crossfade into the next track crosses on every device", async () => {
    await ops.send({ t: "music.pause" });
    await waitFor("Pat's music to stop", async () => (!/music/.test((await soundProbe(pat)).data) ? true : null), 6_000);
    // The DM's state keeps the paused run whole, so the DM's page has to read the pause itself.
    await waitFor(
      "the DM's music to stop",
      async () => {
        const p = await soundProbe(dm);
        return musicVoice(p) === undefined && !/music/.test(p.data) ? true : null;
      },
      6_000,
    );
    await sleep(3_000);
    await ops.send({ t: "music.resume", run: runId() });
    await soundSays(pat, /^playing music/, 5_000);
    await inStep(dm, 100, 6_000);
    await inStep(pat, 100, 6_000);
    const { gap } = await placesTogether(dm, pat);
    assert.ok(gap <= 100, `resumed within 0.1 s of each other (${gap.toFixed(0)} ms)`);

    // Forest road then Tavern night with a 5 s crossfade: revealed 20 s before Tavern's start, crossed from 26 s, promoted at its end.
    await ops.send({ t: "playlist.create", id: "pl-road", name: "The road", sounds: [run.ids.road, run.ids.tavern], repeat: "off", fade: 5 });
    const startedAt = Date.now();
    await ops.send({ t: "music.play", run: runId(), playlistId: "pl-road", order: [run.ids.road, run.ids.tavern], index: 0, repeat: "off", fade: 5 });
    await soundSays(pat, /^playing music/, 5_000);
    const both = await waitFor(
      "both tracks to sound on Pat's phone in the crossing",
      async () => {
        const p = await soundProbe(pat);
        const sounding = p.voices.filter((v) => v.channel === "music" && v.playing && v.aimMs >= 0).map((v) => v.sound);
        return sounding.includes(run.ids.road) && sounding.includes(run.ids.tavern) ? p : null;
      },
      40_000,
    );
    const into = Date.now() - startedAt;
    assert.ok(into > 24_000 && into < 33_000, `the crossing came ${into} ms in`);
    assert.ok(both.voices.length >= 2);
    const dmBoth = (await soundProbe(dm)).voices.filter((v) => v.channel === "music" && v.playing && v.aimMs >= 0).map((v) => v.sound);
    assert.ok(dmBoth.includes(run.ids.tavern), "the DM's page crosses too");
    await waitFor(
      "only the next track once the crossing ends",
      async () => {
        const sounding = (await soundProbe(pat)).voices.filter((v) => v.channel === "music" && v.aimMs >= 0).map((v) => v.sound);
        return sounding.length === 1 && sounding[0] === run.ids.tavern ? true : null;
      },
      12_000,
    );
    await inStep(pat, 100, 6_000);
  });

  test("sn-3. Pat's socket names no next track before its reveal, and with names shared only the music and loops playing now, never an effect", async () => {
    const before = patSocket.received.length;
    await ops.send({ t: "playlist.create", id: "pl-crypt", name: "Below", sounds: [run.ids.road, run.ids.crypt], repeat: "off", fade: 2 });
    const startedAt = Date.now();
    await ops.send({ t: "music.play", run: runId(), playlistId: "pl-crypt", order: [run.ids.road, run.ids.crypt], index: 0, repeat: "off", fade: 2 });
    await ops.send({ t: "loop.start", id: "loop-rain", soundId: run.ids.rain, volume: 70 });
    await soundSays(pat, /^playing music loops:1/, 6_000);
    // Forest road is 31 s with a 2 s crossfade: the Crypt hymn starts at 29 s, revealed at 9 s.
    await sleep(Math.max(0, 7_000 - (Date.now() - startedAt)));
    const early = patSocket.received.slice(before).join("\n");
    assert.ok(!early.includes(run.ids.crypt) && !early.includes(run.assets[run.ids.crypt]!), "no frame names the next track before its reveal");
    assert.ok(!early.includes("Below") && !early.includes("The road"), "never a playlist's name");
    await waitFor("the reveal", () => (patSocket.received.slice(before).some((f) => f.includes(run.ids.crypt)) ? true : null), 8_000);
    const revealedIn = Date.now() - startedAt;
    assert.ok(revealedIn >= 8_000 && revealedIn <= 12_000, `revealed ${revealedIn} ms in, 20 s before its start`);
    const revealed = patSocket.received.slice(before).join("\n");
    assert.ok(!revealed.includes("Crypt hymn") && !revealed.includes("Forest road") && !revealed.includes("Rain"), "no names while the DM keeps them");

    const named = patSocket.received.length;
    await ops.send({ t: "room.update", settings: { soundNames: true } });
    await ops.send({ t: "effect.fire", id: "fx-names", soundId: run.ids.thunder });
    await waitFor("the names", () => (patSocket.received.slice(named).some((f) => f.includes("Forest road")) ? true : null), 5_000);
    await sleep(800);
    const withNames = patSocket.received.slice(named).join("\n");
    assert.ok(withNames.includes("Forest road") && withNames.includes("Rain"), "the music and the loop playing now are named");
    assert.ok(!withNames.includes("Thunder") && !withNames.includes("Crypt hymn") && !withNames.includes("Bell"), "never an effect's name or the next track's");
    await ops.send({ t: "room.update", settings: { soundNames: false } });
    await ops.send({ t: "loop.stop", id: "loop-rain" });
  });

  test("sn-4. behind a blackout Pat's phone falls silent and never receives an effect fired there, the DM's page plays on, and Pat comes back in place", async () => {
    await playTrack(run.ids.tavern);
    await soundSays(pat, /^playing music/, 5_000);
    await inStep(pat, 100, 6_000);
    const before = patSocket.received.length;
    await ops.send({ t: "view.blackout", blackout: true });
    await waitFor("Pat's sound to go", async () => ((await soundProbe(pat)).data === "playing" ? true : null), 5_000);
    await soundSays(dm, /^playing music/, 2_000);
    await ops.send({ t: "effect.fire", id: "fx-dark", soundId: run.ids.bell });
    await waitFor("the DM's page to start the bell", async () => ((await soundProbe(dm)).effects.started.some((e) => e.id === "fx-dark") ? true : null), 5_000);
    await sleep(1_000);
    assert.ok(!patSocket.received.slice(before).some((f) => f.includes("fx-dark")), "the effect never reaches Pat");
    assert.ok(!(await soundProbe(pat)).effects.started.some((e) => e.id === "fx-dark"));
    await ops.send({ t: "view.blackout", blackout: false });
    await soundSays(pat, /^playing music/, 6_000);
    await inStep(pat, 100, 6_000);
    const { gap } = await placesTogether(dm, pat);
    assert.ok(gap <= 100, `back in place with the DM's page (${gap.toFixed(0)} ms)`);
    assert.ok(!(await soundProbe(pat)).effects.started.some((e) => e.id === "fx-dark"), "and never later");
  });

  test("sn-5. Thunder plays on while nine more effects fire 200 ms apart, and after Stop all nothing starts, a phone's late decode included", async () => {
    await ops.send({ t: "effect.fire", id: "fx-thunder", soundId: run.ids.thunder });
    for (let i = 0; i < 9; i++) {
      await sleep(200);
      await ops.send({ t: "effect.fire", id: `fx-b${i}`, builtin: (["click", "rumble", "crash", "whoosh", "hiss"] as const)[i % 5] });
    }
    await sleep(1_500);
    const mid = await soundProbe(pat);
    assert.equal(mid.effects.started.filter((e) => e.id === "fx-thunder").length, 1, "Thunder started once");
    assert.ok(mid.effects.playing >= 1, "Thunder plays on, kept while it sounds");
    assert.ok(patSocket.state?.playing?.effects.some((e) => e.id === "fx-thunder"), "its entry is kept past the newest 8");

    // The bell's file answers late on Pat's phone, so Stop all comes while it decodes.
    await pat.route(`**/${run.assets[run.ids.bell]}/**`, async (route) => {
      await sleep(2_500);
      await route.continue();
    });
    try {
      await ops.send({ t: "effect.fire", id: "fx-late", soundId: run.ids.bell });
      await sleep(400);
      await ops.send({ t: "sound.stopAll" });
      await waitFor("everything to stop on Pat's phone", async () => {
        const p = await soundProbe(pat);
        return p.effects.playing === 0 && !/music/.test(p.data) ? p : null;
      }, 5_000);
      await sleep(3_000);
      const after = await soundProbe(pat);
      assert.ok(!after.effects.started.some((e) => e.id === "fx-late"), "the late decode starts nothing");
      assert.equal(after.effects.playing, 0);
    } finally {
      await pat.unroute(`**/${run.assets[run.ids.bell]}/**`);
    }
  });

  test("sn-6. on a touch phone with an iPhone's autoplay rules: the ask, Play here plays, Not on this device stays quiet, and opened again the sound waits for a tap", async () => {
    const phone = async () => {
      const c = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await c.addInitScript(SOUND_TEST_FLAG);
      await c.addInitScript(IPHONE_AUDIO);
      return c;
    };
    const boContext = await phone();
    const cyContext = await phone();
    try {
      await join(boContext, "Bo", "#a855f7");
      await join(cyContext, "Cy", "#f97316");
      const bo = await boContext.newPage();
      const cy = await cyContext.newPage();
      await openRoom(bo);
      await openRoom(cy);
      await playTrack(run.ids.tavern, 0, "all");
      const askOf = (p: Page) => p.getByRole("status").filter({ hasText: "The DM is playing sound for the room." });
      await askOf(bo).waitFor();
      await askOf(cy).waitFor();
      await askOf(bo).getByRole("button", { name: "Play here" }).tap();
      await soundSays(bo, /^playing music/, 6_000);
      await inStep(bo, 100, 6_000);
      await askOf(cy).getByRole("button", { name: "Not on this device" }).tap();
      await askOf(cy).waitFor({ state: "detached" });
      await sleep(1_500);
      const quiet = await soundProbe(cy);
      assert.equal(quiet.data, "off");
      assert.equal(errors(quiet).length, 0, "Cy's phone plays nothing");
      assert.equal(await cy.evaluate(() => localStorage.getItem("rvtt.roomSound")), "off");

      // Opened again, Room sound is on, and the page waits for a tap: Play here's tap unlocked the last page load only.
      await bo.reload();
      await bo.getByRole("status", { name: "Connected" }).first().waitFor();
      await soundSays(bo, /^tap/, 8_000);
      assert.equal(await askOf(bo).count(), 0, "no ask once chosen");
      assert.equal(errors(await soundProbe(bo)).length, 0, "nothing plays before the tap");
      await shots.take(bo, "sn-6-waiting-for-a-tap");
      await bo.getByRole("status", { name: "Connected" }).first().tap();
      await soundSays(bo, /^playing music/, 6_000);
      await inStep(bo, 100, 6_000);
    } finally {
      await boContext.close();
      await cyContext.close();
    }
  });

  test("sn-7. one page plays per browser: the DM's tab that played keeps it through tab switches and a stall, the table display opened here takes it, and once its window freezes the DM's page plays", async () => {
    await soundSays(dm, /^playing music/, 5_000);
    const second = await dmContext.newPage();
    await second.goto(`${server.origin}/r/${run.roomId}`);
    await second.getByRole("status", { name: "Connected" }).first().waitFor();
    await soundSays(second, /^other/, 8_000);
    for (let i = 0; i < 4; i++) {
      await (i % 2 === 0 ? second : dm).bringToFront();
      await sleep(700);
      assert.ok((await soundProbe(dm)).state?.owns, `the tab that played keeps it, switch ${i}`);
      assert.ok(!(await soundProbe(second)).state?.owns);
    }
    // The first tab's main thread stalls 8 s while its audio renders on: it keeps the lock, and the other waits.
    const stall = dm.evaluate(() => {
      const end = Date.now() + 8_000;
      while (Date.now() < end) {
        // Busy, as a long task is.
      }
    });
    for (let t = 0; t < 8_000; t += 500) {
      assert.ok(!(await soundProbe(second)).state?.owns, `the other tab never takes it during the stall (${t} ms)`);
      await sleep(500);
    }
    await stall;
    await sleep(1_000);
    assert.ok((await soundProbe(dm)).state?.owns, "the stalled tab plays on");

    // "Open on this device": a table display in this browser takes the sound from the DM's tabs.
    const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
    assert.equal(res.status(), 201, await res.text());
    const { code } = (await res.json()) as { code: string };
    const tv = await dmContext.newPage();
    await tv.setViewportSize(TV);
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await soundSays(tv, /^playing music/, 10_000);
    await waitFor("the DM's tabs to go quiet", async () => (!(await soundProbe(dm)).state?.owns && !(await soundProbe(second)).state?.owns ? true : null), 5_000);
    await inStep(tv, 100, 6_000);
    await shots.take(tv, "sn-7-display-plays");
    // The display's menu: its Sound row.
    await tv.mouse.click(TV.width / 2, TV.height / 2);
    const menu = tv.getByRole("menu", { name: "Table display" });
    const row = menu.getByRole("group", { name: "Sound" });
    await row.waitFor();
    assert.equal(await row.getByRole("menuitemradio", { name: "On" }).getAttribute("aria-checked"), "true");
    assert.deepEqual(alignmentLines(await measureAlignment(row), "the display's Sound row 1280x720"), []);
    await shots.take(tv, "sn-7-display-menu-sound");
    await tv.keyboard.press("Escape");
    // Its window locked: a frozen page lets the lock go (MUS-OPUS-76), and a DM's tab plays. Headless Chrome's
    // Page.setWebLifecycleState "frozen" neither fires `freeze` nor stops a page's timers (checked), so the page gets
    // the two Page Lifecycle events themselves.
    await tv.evaluate(() => (globalThis as unknown as { document: EventTarget }).document.dispatchEvent(new Event("freeze")));
    await waitFor("a DM tab to play", async () => ((await soundProbe(dm)).state?.owns || (await soundProbe(second)).state?.owns ? true : null), 10_000);
    assert.ok(!(await soundProbe(tv)).state?.owns, "the frozen display plays nothing");
    await tv.evaluate(() => (globalThis as unknown as { document: EventTarget }).document.dispatchEvent(new Event("resume")));
    await waitFor("the display to take it back", async () => ((await soundProbe(tv)).state?.owns ? true : null), 10_000);
    await waitFor("the DM's tabs to go quiet again", async () => (!(await soundProbe(dm)).state?.owns && !(await soundProbe(second)).state?.owns ? true : null), 5_000);
    await tv.close();
    await second.close();
  });

  test("sn-8. This device's Sounds: Room sound and, while on, the three sliders, at three sizes and two scales, dark then light, within 1 px", async () => {
    const lines: string[] = [];
    for (const scheme of ["dark", "light"] as const) {
      for (const size of SIZES) {
        for (const scale of [1, 1.3]) {
          await dm.setViewportSize({ width: size.width, height: size.height });
          await dm.evaluate(([s, sc]) => {
            localStorage.setItem("rvtt.theme", s as string);
            localStorage.setItem("rvtt.uiScale", String(sc));
          }, [scheme, scale] as const);
          await openRoom(dm);
          const section = await thisDeviceSounds(dm);
          await section.getByRole("switch", { name: "Room sound" }).or(section.getByRole("checkbox", { name: "Room sound" })).first().waitFor();
          lines.push(...alignmentLines(await measureAlignment(section), `This device's Sounds ${size.name} ${scale * 100}% ${scheme}`));
          await shots.take(dm, `sn-8-this-device-sounds-${size.name}-${scale * 100}-${scheme}`);
          await closeSheets(dm);
        }
      }
    }
    await dm.evaluate(() => {
      localStorage.setItem("rvtt.theme", "dark");
      localStorage.setItem("rvtt.uiScale", "1");
    });
    assert.deepEqual(lines, [], "This device's Sounds out of line");
  });

  test("sn-9. the ask, the display's two cards and its Sound row at three sizes and two scales, within 1 px", async () => {
    await playTrack(run.ids.tavern, 0, "all");
    await soundSays(dm, /^playing music/, 5_000);
    const lines: string[] = [];
    const sized = async (page: Page, size: (typeof SIZES)[number], key: string, scale: number) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate(([k, s]) => localStorage.setItem(k as string, String(s)), [key, scale] as const);
      await page.reload();
    };

    // Eve has no choice yet, so each load asks again.
    const eveContext = await browser.newContext({ viewport: PHONE });
    try {
      await eveContext.addInitScript(SOUND_TEST_FLAG);
      await eveContext.addInitScript(roomSoundScript(null));
      await join(eveContext, "Eve", "#14b8a6");
      const eve = await eveContext.newPage();
      await openRoom(eve);
      for (const size of SIZES) {
        for (const scale of [1, 1.3]) {
          await sized(eve, size, "rvtt.uiScale", scale);
          const ask = eve.getByRole("status").filter({ hasText: "The DM is playing sound for the room." });
          await ask.waitFor();
          lines.push(...alignmentLines(await measureAlignment(ask), `the ask ${size.name} ${scale * 100}%`));
        }
      }
    } finally {
      await eveContext.close();
    }

    // Two displays: one with an iPhone's autoplay rules waits for a tap, one without the mixer can't play.
    const display = async (script: string) => {
      const c = await browser.newContext({ viewport: TV });
      await c.addInitScript(SOUND_TEST_FLAG);
      await c.addInitScript(script);
      const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
      assert.equal(res.status(), 201, await res.text());
      const { code } = (await res.json()) as { code: string };
      const tv = await c.newPage();
      await tv.goto(`${server.origin}/display`);
      await tv.getByLabel("Code from the DM's screen").fill(code);
      await tv.getByRole("button", { name: "Connect" }).click();
      // Paired once the code's form goes, so a reload comes back to the room.
      await tv.getByLabel("Code from the DM's screen").waitFor({ state: "detached" });
      return { c, tv };
    };
    const NO_MIXER = "delete AudioContext.prototype.createMediaElementSource;";
    const waiting = await display(IPHONE_AUDIO);
    const cannot = await display(NO_MIXER);
    try {
      for (const size of SIZES) {
        for (const scale of [1, 1.3]) {
          const where = `${size.name} ${scale * 100}%`;
          await sized(cannot.tv, size, "rvtt.displayUiScale", scale);
          const cannotCard = cannot.tv.locator("[data-display-sound-card]");
          await cannotCard.filter({ hasText: "This TV's browser can't play the room's sound." }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(cannotCard), `the display's can't-play card ${where}`));

          await sized(waiting.tv, size, "rvtt.displayUiScale", scale);
          const tapCard = waiting.tv.locator("[data-display-sound-card]");
          await tapCard.filter({ hasText: "Tap or press a key for sound." }).waitFor({ timeout: 10_000 });
          lines.push(...alignmentLines(await measureAlignment(tapCard), `the display's tap card ${where}`));
          if (size.name === "1440x900" && scale === 1) await shots.take(waiting.tv, "sn-9-display-tap-card");
          // The tap that opens the menu unlocks the sound, and the card goes.
          await waiting.tv.mouse.click(size.width / 2, size.height / 3);
          await soundSays(waiting.tv, /^playing music/, 8_000);
          assert.equal(await tapCard.count(), 0, `the tap card goes once the sound plays, ${where}`);
          const row = waiting.tv.getByRole("menu", { name: "Table display" }).getByRole("group", { name: "Sound" });
          await row.waitFor();
          lines.push(...alignmentLines(await measureAlignment(row), `the display's Sound row ${where}`));
        }
      }
    } finally {
      for (const d of [waiting, cannot]) {
        await d.c.request.delete(`${server.origin}/api/display/session`, { headers: { Origin: server.origin } });
        await d.c.close();
      }
    }
    assert.deepEqual(lines, [], "out of line");
  });
});
