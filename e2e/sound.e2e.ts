import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { openGroup } from "./helpers/groups.ts";
import { ConsoleWatch, OpSocket, openSideTab, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { addSound, errors, inStep, IPHONE_AUDIO, musicVoice, readTap, roomSoundScript, SOUND_TAP, SOUND_TEST_FLAG, soundProbe, soundSays, tapGlitches, toneSound, uploadSound, type SoundProbe } from "./soundRoom.ts";

/**
 * Synced music and sound on every device (docs/design/design-v1-music.md 5
 * and 12), steps sn-1 to sn-7b: sync and a late join with the
 * ask, a crossfade and a pause, what a player's socket carries, a blackout,
 * effects and Stop all, a touch phone's ask and its tap after a reload, and
 * one page per browser with the table display, and without Web Locks with
 * a hidden page. sn-10 turns on Only DM devices play
 * (docs/design/design-v1-sound-dm-only.md 5) and off. lp30fix-1 restarts the
 * server while an iPhone's files still load. The sounds are silence
 * built frame by frame (soundRoom.ts), uploaded through the asset route.
 * sndglitch-1, sndfade-1 and sndfade-2 play a tone into a tap, each in the
 * quiet room (`quietRoom`), so they may run in any order.
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

type RoomAccess = { roomId: string; password: string };

async function join(context: BrowserContext, name: string, color: string, room: RoomAccess = run): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${room.roomId}/join`, { headers, data: { password: room.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${room.roomId}/join/complete`, { headers, data: { ticket, name, color } });
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

async function openRoom(page: Page, room: RoomAccess = run): Promise<void> {
  await page.goto(`${server.origin}/r/${room.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
}

async function playTrack(soundId: string, fade: 0 | 2 | 5 | 10 = 0, repeat: "all" | "one" | "off" = "off", via: OpSocket = ops): Promise<string> {
  const id = runId();
  await via.send({ t: "music.play", run: id, soundId, order: [soundId], repeat, fade });
  return id;
}

/**
 * A room of its own for the steps that play a tone into a tap, made once
 * by a DM with no page open. Only the step's own player page plays there,
 * never the DM's or Pat's aloud where the tests run, and the main room's
 * pages stay as the other steps left them, so these steps may run in any
 * order. Each step gets its own op socket, since lp30fix-1 restarts the
 * server, and starts from silence.
 */
const quiet = { roomId: "", password: "quiet room for the tap", context: null as BrowserContext | null, tones: {} as Record<string, string> };

async function quietRoom(): Promise<{ room: RoomAccess; ops: OpSocket }> {
  if (!quiet.context) {
    const context = await browser.newContext();
    const res = await context.request.post(`${server.origin}/api/rooms`, { headers: { Origin: server.origin }, data: { name: `${run.roomName} quiet`, playerPassword: quiet.password, dmName: "Dana the DM" } });
    assert.ok(res.ok(), `creating the quiet room answered ${res.status()}`);
    quiet.roomId = ((await res.json()) as { roomId: string }).roomId;
    quiet.context = context;
  }
  const cookie = (await quiet.context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  const via = await OpSocket.open({ origin: server.origin, roomId: quiet.roomId, cookie });
  await via.send({ t: "sound.stopAll" });
  return { room: quiet, ops: via };
}

/** A tone in the quiet room, added once, and its asset. */
async function quietTone(via: OpSocket, id: string, name: string, use: "music" | "loop", seconds: number): Promise<string> {
  if (!quiet.tones[id]) {
    const row = await uploadSound(quiet.context!, server.origin, quiet.roomId, toneSound(seconds), `${name}.mp3`);
    assert.ok(row.audio, `the server read the tone ${name}`);
    await via.send({ t: "sound.create", id, assetId: row.id, name, use, ms: row.audio.ms });
    quiet.tones[id] = row.id;
  }
  return quiet.tones[id];
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

/** This device's Sounds group, opened from the Menu, and open: This device's groups start folded on a phone (docs/design/design-v1-panel-groups.md 6.2). */
async function thisDeviceSounds(page: Page): Promise<Locator> {
  const menu = await openMenu(page);
  const back = menu.getByRole("button", { name: /^Back to Menu/ });
  if (await visible(back)) await back.click();
  await menu.getByRole("button", { name: /^This device/ }).click();
  await openGroup(menu, "Sounds");
  const section = menu.locator("[data-panel-group]").filter({ has: page.getByRole("heading", { name: "Sounds", exact: true }) }).last();
  await section.scrollIntoViewIfNeeded();
  return section;
}

const SIZES = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
  { name: "320x568", width: 320, height: 568 },
] as const;

/** Devices start a track within this of each other: each voice is placed once and then plays on by itself (D-261102-940). */
const START_MS = 1_000;

/** Web Locks gone before the app's first script, as on a self-host over plain HTTP on a LAN: browsers offer them in a secure context only. */
const NO_LOCKS = "delete Navigator.prototype.locks;";

/**
 * A tab hidden behind another, switched from the test (`__rvttHide`).
 * Headless Chrome reports every tab visible and so never throttles one:
 * bringToFront, a minimized window and a target opened in the background
 * all left `visibilityState` "visible" (checked). So the page says hidden
 * itself, and while hidden its timeouts wait for whole-second wake-ups, as
 * a hidden, silent tab's do in Chrome. Posts are never held back. Without
 * the wake-ups a handoff that took a hidden page's late timers for a stall
 * passes here (checked), as it did before the fix for that.
 */
const HIDDEN_TAB = `(() => {
  let hidden = false;
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => hidden });
  const real = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (!hidden) return real(fn, ms, ...args);
    const due = performance.now() + Math.max(0, Number(ms) || 0);
    return real(fn, Math.ceil(due / 1000) * 1000 - performance.now(), ...args);
  };
  globalThis.__rvttHide = (next) => {
    if (next === hidden) return;
    hidden = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
})();`;

/**
 * Every handoff post a page hears on its room's channel, its own too, with
 * when it came: `__rvttHeard`. The channel's name and the post's fields are
 * handoff.ts's channelName and HandoffPost, written out here since that file
 * needs the DOM's types and the e2e files build without them.
 */
function heardScript(roomId: string): string {
  return `(() => {
  const heard = [];
  const channel = new BroadcastChannel(${JSON.stringify(`rvtt-sound:${roomId}`)});
  channel.onmessage = (e) => heard.push({ at: Date.now(), ...e.data });
  globalThis.__rvttHeard = heard;
  globalThis.__rvttHeardChannel = channel;
})();`;
}

type Heard = { at: number; page: string; owns: boolean; armed: boolean; sentAt: number; bye?: true };

/** handoff.ts LEASE_MS: without Web Locks an owner's audio fades out this long after its last renewal unless renewed again. */
const LEASE_MS = 6_000;

/** A page's own sound passes its output gate, the lease gain, which the audio thread runs while the main thread stalls (handoff.ts HandoffAudio). */
function sounds(probe: SoundProbe): boolean {
  return (probe.state?.lease ?? 0) > 0;
}

/** The longest a hidden page waits to take the sound over once the shown one that played closes: at most 1.45 s in the handoff world, and CI's slack. */
const CLOSE_TAKEOVER_MS = 4_000;

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
    for (const [roomId, name, context] of [
      [run.roomId, run.roomName, dmContext],
      [quiet.roomId, `${run.roomName} quiet`, quiet.context],
    ] as const) {
      if (!roomId || !context) continue;
      try {
        const res = await context.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name } });
        if (!res.ok()) console.error(`Deleting room ${roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("sn-0. the DM's room on a computer with music, a background sound and effects, and Pat on a phone, unmuted", async () => {
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
    // Nothing plays yet: the engine has not loaded, and the page says only that it is unmuted.
    assert.equal((await soundProbe(pat)).data, "", "no engine before anything plays");
  });

  test("sn-1. the DM plays a track, the DM's page and Pat's start together, and Ana joining 5 s in is asked and starts in place within 6 s", async () => {
    const started = Date.now();
    await playTrack(run.ids.tavern);
    await soundSays(dm, /^playing music/, 5_000);
    await soundSays(pat, /^playing music/, 5_000);
    assert.ok(Date.now() - started < 3_000, `both played within 3 s of the op (${Date.now() - started} ms)`);
    await inStep(dm, START_MS, 6_000);
    await inStep(pat, START_MS, 6_000);
    const { gap } = await placesTogether(dm, pat);
    assert.ok(gap <= START_MS, `the DM's page and Pat's within a second of each other (${gap.toFixed(0)} ms)`);

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
      assert.equal(await ana.evaluate(() => localStorage.getItem("rvtt.roomSound")), "on", "Play here unmutes");
      await soundSays(ana, /^playing music/, 5_000);
      await inStep(ana, START_MS, 6_000);
      assert.ok(Date.now() - tapped < 6_500, `in place within 6 s of the tap (${Date.now() - tapped} ms)`);
      const late = await placesTogether(ana, pat);
      assert.ok(late.gap <= START_MS, `Ana and Pat within a second (${late.gap.toFixed(0)} ms)`);
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
    await inStep(dm, START_MS, 6_000);
    await inStep(pat, START_MS, 6_000);
    const { gap } = await placesTogether(dm, pat);
    assert.ok(gap <= START_MS, `resumed within a second of each other (${gap.toFixed(0)} ms)`);

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
    await inStep(pat, START_MS, 6_000);
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
    await inStep(pat, START_MS, 6_000);
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
    await inStep(pat, START_MS, 6_000);
    const { gap } = await placesTogether(dm, pat);
    assert.ok(gap <= START_MS, `back in place with the DM's page (${gap.toFixed(0)} ms)`);
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
      await inStep(bo, START_MS, 6_000);
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
      await inStep(bo, START_MS, 6_000);
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
    await inStep(tv, START_MS, 6_000);
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

  test("sn-7b. without Web Locks, as on a LAN over HTTP: one of the DM's two pages plays, a hidden page takes over a 12 s stall only once the stalled page's lease silenced it, and takes over a closed one within 4 s, never two at once", async () => {
    await soundSays(dm, /^playing music/, 5_000);
    // A context of its own with the DM's sign-in, so its pages' channel reaches no page that has locks.
    const lan = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await dmContext.storageState() });
    try {
      for (const script of [SOUND_TEST_FLAG, NO_LOCKS, HIDDEN_TAB, heardScript(run.roomId)]) await lan.addInitScript(script);
      type Hooks = { __rvttHide(hidden: boolean): void; __rvttHeard: Heard[]; document: { visibilityState: string }; navigator: object };
      const hide = (p: Page, hidden: boolean) => p.evaluate((h) => (globalThis as unknown as Hooks).__rvttHide(h), hidden);
      const shown = (p: Page) => p.evaluate(() => (globalThis as unknown as Hooks).document.visibilityState);
      const heard = (p: Page) => p.evaluate(() => (globalThis as unknown as Hooks).__rvttHeard);
      const a = await lan.newPage();
      await openRoom(a);
      assert.equal(await a.evaluate(() => "locks" in (globalThis as unknown as Hooks).navigator), false, "the page has no Web Locks");
      await soundSays(a, /^playing music/, 10_000);
      const b = await lan.newPage();
      await openRoom(b);
      await soundSays(b, /^other/, 8_000);
      await hide(b, true);
      assert.equal(await shown(b), "hidden");

      const open: Record<string, Page> = { a, b };
      /** Every open page's probe, never two of them sounding at once. */
      const look = async (why: string): Promise<Record<string, SoundProbe>> => {
        const probes = await Promise.all(Object.entries(open).map(async ([name, p]) => [name, await soundProbe(p)] as const));
        const playing = probes.filter(([, p]) => sounds(p)).map(([name]) => name);
        assert.ok(playing.length <= 1, `${why}: two pages sound at once (${playing.join(", ")})`);
        return Object.fromEntries(probes);
      };
      /** For `ms`, at every sample: only `who` plays, and only its sound passes the gate. */
      const only = async (who: string, ms: number, why: string) => {
        const end = Date.now() + ms;
        do {
          for (const [name, p] of Object.entries(await look(why))) {
            assert.equal(p.state?.owns, name === who, `${why}: ${name} ${name === who ? "plays" : "is quiet"} (${p.data})`);
            assert.equal(sounds(p), name === who, `${why}: ${name}'s gate ${name === who ? "open" : "shut"} (lease ${p.state?.lease})`);
          }
          await sleep(250);
        } while (Date.now() < end);
      };
      await only("a", 3_000, "two pages, the second hidden");

      // The shown page that plays stalls 12 s while its audio renders on. Its lease silences it 6 s after its last renewal, and
      // the hidden page may take over only 7 s after that page's last post, so a stall past sn-7's 8 s shows the takeover.
      const STALL_MS = 12_000;
      const stallFrom = Date.now();
      const stall = a.evaluate((ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          // Busy, as a long task is.
        }
      }, STALL_MS);
      try {
        await waitFor("the hidden page to take over in the stall", async () => (sounds(await soundProbe(b)) ? true : null), STALL_MS - 1_000);
      } finally {
        // A failure here waits for the stall's end, so it is not reported as the page closing under the stall.
        await stall;
      }
      await waitFor("the stalled page to give up once it runs", async () => (!(await look("after the stall")).a!.state?.owns ? true : null), 3_000);
      await only("b", 3_000, "after the stall");
      const log = await heard(b);
      const stalled = log.filter((m) => m.owns && m.sentAt < stallFrom).at(-1)?.page;
      const takeover = log.find((m) => m.page !== stalled && m.owns);
      assert.ok(stalled && takeover && takeover.sentAt < stallFrom + STALL_MS, "the hidden page said it plays during the stall");
      const last = log.filter((m) => m.page === stalled && m.sentAt < takeover.sentAt).at(-1)!;
      assert.ok(last.owns && last.armed, "the stalled page's last post renewed an armed lease");
      const gap = takeover.sentAt - last.sentAt;
      assert.ok(gap >= LEASE_MS, `the hidden page took over ${gap} ms after the stalled page's last renewal, once its ${LEASE_MS} ms lease ran out`);
      assert.ok(log.filter((m) => m.page === stalled && m.sentAt > takeover.sentAt).every((m) => !m.owns), "the stalled page never said it plays once the other did");

      // A tab switch: the page that plays is shown and the other hidden, and the sound stays where it is.
      await hide(a, true);
      await hide(b, false);
      await only("b", 2_000, "after a tab switch");

      // The shown page that plays closes: its goodbye lets the hidden page claim at once, its timers on whole seconds.
      delete open.b;
      const closing = Date.now();
      await b.close();
      // Its gate too: the audio thread reports the gain it opened a render later.
      await waitFor("the hidden page to take over the closed one", async () => {
        const probe = (await look("after the close")).a!;
        return probe.state?.owns && sounds(probe) ? true : null;
      }, CLOSE_TAKEOVER_MS + 1_000);
      assert.equal(await shown(a), "hidden", "it took over hidden");
      const after = (await heard(a)).filter((m) => m.at >= closing);
      const bye = after.find((m) => m.bye);
      const took = after.find((m) => bye && m.page !== bye.page && m.owns);
      assert.ok(bye && took, "the closed page's goodbye, then the hidden page's post that it plays");
      assert.ok(took.sentAt - bye.sentAt <= CLOSE_TAKEOVER_MS, `the hidden page took over ${took.sentAt - bye.sentAt} ms after the goodbye`);
      await only("a", 2_000, "after the close");
      console.log(`sn-7b: stall takeover ${gap} ms after the last renewal, close takeover ${took.sentAt - bye.sentAt} ms after the goodbye`);
    } finally {
      await lan.close();
    }
  });

  test("sn-8. This device's Sounds: Volume with its mute toggle, the three sliders, Turn sound and Ping sound, at three sizes and two scales, dark then light, within 1 px", async () => {
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
          await section.getByRole("button", { name: "Mute", exact: true }).waitFor();
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

  test("sn-10. Only DM devices play: Pat's phone and the table display in the DM's browser fall quiet and get no frame about sound, Hal's open ask leaves unpassed and Ivy joining is not asked, the DM's page plays, and turned off everyone joins in place and is asked, as after a blackout", async () => {
    type Post = { kind: string; eligible: boolean; owns: boolean; sentAt: number };
    const askOf = (p: Page) => p.getByRole("status").filter({ hasText: "The DM is playing sound for the room." });
    const evs = (watch: SocketWatch, from: number) => watch.received.slice(from).filter((f) => (JSON.parse(f) as { t: string }).t === "ev");
    await playTrack(run.ids.tavern, 0, "all");
    await soundSays(pat, /^playing music/, 5_000);
    const tavern = run.assets[run.ids.tavern]!;
    assert.equal((await patContext.request.get(`${server.origin}/api/assets/${tavern}/full`)).status(), 200, "Pat may load the track playing");
    const phone = async () => {
      const c = await browser.newContext({ viewport: PHONE });
      await c.addInitScript(SOUND_TEST_FLAG);
      return c;
    };
    const halContext = await phone();
    const ivyContext = await phone();
    const tvSocket = new SocketWatch("tv");
    let tv: Page | null = null;
    try {
      // Hal has no choice yet and is asked.
      await join(halContext, "Hal", "#84cc16");
      const hal = await halContext.newPage();
      await openRoom(hal);
      await askOf(hal).waitFor();
      // The table display in the DM's own browser owns its sound, as sn-7 showed.
      const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
      assert.equal(res.status(), 201, await res.text());
      const { code } = (await res.json()) as { code: string };
      tv = await dmContext.newPage();
      await tv.setViewportSize(TV);
      await tv.addInitScript(heardScript(run.roomId));
      await tvSocket.attach(dmContext, tv);
      await tv.goto(`${server.origin}/display`);
      await tv.getByLabel("Code from the DM's screen").fill(code);
      await tv.getByRole("button", { name: "Connect" }).click();
      const display = tv;
      await waitFor("the display to own this browser's sound", async () => ((await soundProbe(display)).state?.owns && !(await soundProbe(dm)).state?.owns ? true : null), 10_000);

      // On: one batch takes the sound from Pat and the display.
      const on = Date.now();
      await ops.send({ t: "room.update", settings: { soundDmOnly: true } });
      for (const [who, watch] of [["Pat", patSocket], ["the display", tvSocket]] as const) {
        await waitFor(`${who}'s projection without the sound`, () => (watch.state?.meta.settings.soundDmOnly === true && watch.state.playing === undefined ? true : null), 5_000);
        assert.deepEqual(watch.state?.sounds ?? {}, {}, `${who} holds no sound`);
      }
      await askOf(hal).waitFor({ state: "detached", timeout: 3_000 });
      await waitFor("Pat's music to fade out", async () => ((await soundProbe(pat)).data === "playing" ? true : null), 3_000);
      console.log(`sn-10: Pat's music gone ${Date.now() - on} ms after the switch`);
      // The display is no longer eligible, so the DM's page takes the sound and the display shows no card.
      await waitFor("the DM's page to play", async () => ((await soundProbe(dm)).state?.owns && !(await soundProbe(display)).state?.owns ? true : null), 10_000);
      await soundSays(dm, /^playing music/, 5_000);
      const posts = (await display.evaluate(() => (globalThis as unknown as { __rvttHeard: Post[] }).__rvttHeard)).filter((p) => p.kind === "display");
      assert.equal(posts.at(-1)?.eligible, false, "the display's last post says it is not eligible");
      assert.equal(await display.locator("[data-display-sound-card]").count(), 0, "no card on the display");
      assert.equal((await patContext.request.get(`${server.origin}/api/assets/${tavern}/full`)).status(), 404, "the track playing is no longer Pat's to load");
      await shots.take(display, "sn-10-display-quiet");

      // Ivy joins with music playing and is not asked.
      await join(ivyContext, "Ivy", "#06b6d4");
      const ivy = await ivyContext.newPage();
      await openRoom(ivy);
      await sleep(3_000);
      assert.equal(await askOf(ivy).count(), 0, "no ask while only DM devices play");

      // A play, a tick, a skip, a loop and an effect send Pat and the display no frame at all.
      const from = { pat: patSocket.received.length, tv: tvSocket.received.length };
      const started = Date.now();
      await ops.send({ t: "music.play", run: runId(), playlistId: "pl-crypt", order: [run.ids.road, run.ids.crypt], index: 0, repeat: "all", fade: 0 });
      // Forest road is 31 s, so the tick reveals the Crypt hymn to the DM 11 s in.
      await waitFor("the tick's reveal", () => (dmSocket.state?.playing?.music?.next?.soundId === run.ids.crypt ? true : null), 15_000);
      console.log(`sn-10: the reveal ${Date.now() - started} ms in`);
      await ops.send({ t: "music.skip", run: dmSocket.state!.playing!.music!.run });
      await ops.send({ t: "loop.start", id: "loop-dmonly", soundId: run.ids.rain, volume: 70 });
      await ops.send({ t: "effect.fire", id: "fx-dmonly", soundId: run.ids.bell });
      await waitFor("the DM's page to start the bell", async () => ((await soundProbe(dm)).effects.started.some((e) => e.id === "fx-dmonly") ? true : null), 5_000);
      await sleep(1_500);
      assert.deepEqual(evs(patSocket, from.pat), [], "no frame for Pat");
      assert.deepEqual(evs(tvSocket, from.tv), [], "no frame for the display");
      assert.ok(dmSocket.state?.playing?.dmEffects?.some((e) => e.id === "fx-dmonly"), "the effect stays the DM's");

      // Off: Pat joins the music and the loop in place, the display takes this browser's sound back, and Hal and Ivy are asked.
      await ops.send({ t: "room.update", settings: { soundDmOnly: false } });
      await soundSays(pat, /^playing music loops:1/, 6_000);
      await inStep(pat, START_MS, 6_000);
      await waitFor("the display to own this browser's sound again", async () => ((await soundProbe(display)).state?.owns ? true : null), 10_000);
      await inStep(display, START_MS, 6_000);
      const { gap } = await placesTogether(display, pat);
      assert.ok(gap <= START_MS, `Pat in place with the display (${gap.toFixed(0)} ms)`);
      await askOf(hal).waitFor({ timeout: 5_000 });
      await askOf(ivy).waitFor({ timeout: 5_000 });
      assert.ok(!(await soundProbe(pat)).effects.started.some((e) => e.id === "fx-dmonly"), "the effect fired while it was on never sounds on Pat's phone");
      assert.ok(!patSocket.state?.playing?.effects.some((e) => e.id === "fx-dmonly"), "nor reaches it");
      await shots.take(hal, "sn-10-hal-asked-again");

      // The same open ask behind a blackout: it leaves unpassed and comes back once the blackout ends.
      await ops.send({ t: "view.blackout", blackout: true });
      await askOf(hal).waitFor({ state: "detached", timeout: 3_000 });
      await ops.send({ t: "view.blackout", blackout: false });
      await askOf(hal).waitFor({ timeout: 5_000 });
    } finally {
      await ops.send({ t: "room.update", settings: { soundDmOnly: false } }).catch(() => {});
      await ops.send({ t: "view.blackout", blackout: false }).catch(() => {});
      await ops.send({ t: "loop.stop", id: "loop-dmonly" }).catch(() => {});
      await tv?.close();
      await halContext.close();
      await ivyContext.close();
    }
  });

  test("lp30fix-1. the server restarts while an iPhone's tap has its music and background sound still loading, and once back both play in step with no tap", async () => {
    await playTrack(run.ids.tavern, 0, "all");
    await ops.send({ t: "loop.start", id: "loop-restart", soundId: run.ids.rain, volume: 70 });
    await soundSays(dm, /^playing music loops:1/, 6_000);
    const fayContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      for (const script of [SOUND_TEST_FLAG, IPHONE_AUDIO, roomSoundScript("on")]) await fayContext.addInitScript(script);
      await join(fayContext, "Fay", "#ec4899");
      const fay = await fayContext.newPage();
      await openRoom(fay);
      await soundSays(fay, /^tap/, 8_000);
      // The files Fay's tap starts loading are held until the server has stopped, then cut off as a restart cuts them.
      let serverDown = () => {};
      const down = new Promise<void>((resolve) => (serverDown = resolve));
      const held = [run.assets[run.ids.tavern]!, run.assets[run.ids.rain]!];
      const holdFiles = (url: URL) => held.some((id) => url.pathname.includes(id));
      await fayContext.route(holdFiles, async (route) => {
        await down;
        await route.abort("connectionrefused");
      });
      await fay.getByRole("status", { name: "Connected" }).first().tap();
      await soundSays(fay, /^playing music:loading/, 5_000);
      ops.close();
      assert.equal(await server.stop(), 0, "the server shut down cleanly");
      serverDown();
      await soundSays(fay, /music:failed/, 5_000);
      await fayContext.unroute(holdFiles);
      server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
      for (const page of [dm, pat, fay]) await page.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 30_000 });
      const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
      await soundSays(fay, /^playing music loops:1$/, 8_000);
      await inStep(fay, START_MS, 8_000);
      const { gap } = await placesTogether(dm, fay);
      assert.ok(gap <= START_MS, `Fay's phone and the DM's page within a second after the restart (${gap.toFixed(0)} ms)`);
      await shots.take(fay, "lp30fix-1-playing-after-restart");
    } finally {
      await fayContext.close();
      // Only a server that came back takes it.
      await ops.send({ t: "loop.stop", id: "loop-restart" }).catch(() => {});
    }
  });

  // In the quiet room: Gus's page alone plays the tone, into the tap.
  test("sndglitch-1. through a throttled network: once a track plays, nothing seeks it or changes its speed, through wakes, a small slip or a long stall, and the output has no click or dropout", async () => {
    const { room, ops: via } = await quietRoom();
    const toneId = "snd-tone";
    const asset = await quietTone(via, toneId, "Tone", "music", 60);
    const gusContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
    try {
      await gusContext.addInitScript(SOUND_TEST_FLAG);
      await gusContext.addInitScript(roomSoundScript("on"));
      await gusContext.addInitScript(SOUND_TAP);
      // Frames to Gus 100 ms late and none the other way, as a slow downlink.
      await gusContext.routeWebSocket(/\/ws\?room=/, (ws) => {
        const upstream = ws.connectToServer();
        ws.onMessage((m) => upstream.send(m));
        upstream.onMessage((m) => setTimeout(() => ws.send(m), 100));
      });
      await join(gusContext, "Gus", "#eab308", room);
      const gus = await gusContext.newPage();
      // A phone on a fair link: the page and every range of the track through it.
      const cdp = await gusContext.newCDPSession(gus);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1_500_000 / 8, uploadThroughput: 750_000 / 8 });
      await openRoom(gus, room);
      await playTrack(toneId, 0, "off", via);
      await soundSays(gus, /^playing music/, 10_000);
      // Through the slow link it starts within a second or two of its place.
      await inStep(gus, 2 * START_MS, 10_000);
      type Tap = { elements: { paused: boolean; src: string; currentTime: number }[]; self: boolean; ctx: { currentTime: number } };
      const now = () => gus.evaluate(() => (globalThis as unknown as { __soundTap: Tap }).__soundTap.ctx.currentTime);
      await sleep(2_000);
      const from = await now();

      // Shown again three times: each a wake, which once sought every voice to the timeline.
      for (let i = 0; i < 3; i++) {
        await gus.evaluate(() => (globalThis as unknown as { document: EventTarget }).document.dispatchEvent(new Event("visibilitychange")));
        await sleep(1_500);
      }
      // The test moves Gus's element 80 ms ahead, as a slip of the clock's offset or the output's latency would, then
      // 3 s back, as a long stall on a weak link leaves it behind.
      const slip = (ms: number) =>
        gus.evaluate(
          ({ id, ms }) => {
            const tap = (globalThis as unknown as { __soundTap: Tap }).__soundTap;
            const el = tap.elements.find((e) => !e.paused && e.src.includes(id));
            if (!el) return null;
            tap.self = true;
            el.currentTime += ms / 1000;
            tap.self = false;
            return tap.ctx.currentTime;
          },
          { id: asset, ms },
        );
      const ahead = await slip(80);
      assert.ok(ahead !== null, "Gus's page plays the tone");
      await sleep(3_000);
      const behind = await slip(-3_000);
      assert.ok(behind !== null, "Gus's page still plays the tone");
      await sleep(4_000);
      const { log, quanta } = await readTap(gus);
      // Only the tone's own element counts: a spare element warming up through the throttled link may fail its load, which the engine ignores.
      assert.deepEqual(log.filter((c) => c.kind === "error" && (c.src ?? "").includes(asset)), [], "the tone plays on");
      const engine = log.filter((c) => !c.self && c.at > from && (c.kind === "seek" || c.kind === "rate"));
      assert.deepEqual(engine, [], "no seek and no change of speed once the track plays");
      const behindBy = (await soundProbe(gus)).voices.find((v) => v.channel === "music" && v.playing);
      assert.ok(behindBy && behindBy.aimMs - behindBy.currentMs > 2_500, `the stalled track plays on from where it is: ${JSON.stringify(behindBy)}`);
      // The test's own two steps are cuts in the tone: each quarter second is left out.
      const found = tapGlitches(quanta, from, behind + 3.5, [
        [ahead - 0.05, ahead + 0.25],
        [behind - 0.05, behind + 0.25],
      ]);
      assert.ok(found.level > 0.05, `the tone reaches the tap (level ${found.level.toFixed(3)})`);
      assert.deepEqual(found.clicks, [], "no click");
      assert.deepEqual(found.dropouts, [], "no dropout");
    } finally {
      await gusContext.close();
      via.close();
    }
  });

  // In the quiet room: Hal's page alone plays, into the tap.
  test("sndfade-1. the music fades in over 2 s when it starts and when it resumes, and out over 2 s when it pauses and when the last track ends with nothing after it, as a background sound does", async () => {
    const { room, ops: via } = await quietRoom();
    const toneId = "snd-tone-short";
    const loopId = "snd-tone-loop";
    await quietTone(via, toneId, "Short tone", "music", 32);
    await quietTone(via, loopId, "Tone loop", "loop", 10);
    const halContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
    const halSocket = new SocketWatch("hal");
    try {
      await halContext.addInitScript(SOUND_TEST_FLAG);
      await halContext.addInitScript(roomSoundScript("on"));
      await halContext.addInitScript(SOUND_TAP);
      await join(halContext, "Hal", "#a855f7", room);
      const hal = await halContext.newPage();
      await halSocket.attach(halContext, hal);
      await openRoom(hal, room);
      // Repeat off and one track: nothing follows it, so its end fades out.
      await playTrack(toneId, 0, "off", via);
      await soundSays(hal, /^playing music/, 10_000);
      await sleep(6_000);
      await via.send({ t: "music.pause" });
      await sleep(4_000);
      const resumed = runId();
      await via.send({ t: "music.resume", run: resumed });
      // A player's view holds no music while it is paused, so the end is read only once Hal's view has the resumed run.
      await waitFor("Hal's view to resume", () => (halSocket.state?.playing?.music?.run === resumed ? true : null), 10_000);
      await waitFor("the run to end", () => (halSocket.state && (halSocket.state.playing?.music ?? null) === null ? true : null), 40_000);
      await sleep(1_000);
      // A background sound already fades in and out over 2 s: checked on its own span of the tap, at its own level.
      const loopFrom = await hal.evaluate(() => (globalThis as unknown as { __soundTap: { ctx: { currentTime: number } } }).__soundTap.ctx.currentTime);
      await via.send({ t: "loop.start", id: "loop-tone", soundId: loopId, volume: 100 });
      await sleep(6_000);
      await via.send({ t: "loop.stop", id: "loop-tone" });
      await sleep(3_000);
      const { quanta } = await readTap(hal);
      const ramps = fadeRamps(quanta.filter((q) => q.at < loopFrom));
      const loopRamps = fadeRamps(quanta.filter((q) => q.at >= loopFrom));
      console.log(`sndfade-1 ramps ${JSON.stringify(ramps)} loop ${JSON.stringify(loopRamps)}`);
      assert.deepEqual(
        loopRamps.map((r) => [r.rising, r.ms > 1_200 && r.ms < 2_200]),
        [
          [true, true],
          [false, true],
        ],
        `the background sound fades in and out over 2 s: ${JSON.stringify(loopRamps)}`,
      );
      assert.equal(ramps.length, 4, `a start, a pause, a resume and an end: ${JSON.stringify(ramps)}`);
      // A 2 s line crosses from a tenth to nine tenths of the tone's level in 1.6 s. A step does so within a quantum or two.
      const expected = [
        ["start", true],
        ["pause", false],
        ["resume", true],
        ["end", false],
      ] as const;
      expected.forEach(([name, rising], i) => {
        const ramp = ramps[i]!;
        assert.equal(ramp.rising, rising, `the ${name} goes the right way: ${JSON.stringify(ramps)}`);
        assert.ok(ramp.ms > 1_200 && ramp.ms < 2_200, `the ${name} ramps over about 1.6 s of its 2 s: ${ramp.ms.toFixed(0)} ms`);
      });
    } finally {
      await halContext.close();
      via.close();
    }
  });

  // In the quiet room, with the short tone sndfade-1 plays, added here when it ran first: Ivy's page alone plays, into the tap.
  test("sndfade-2. music whose first load is held 3 s still fades in over 2 s once it sounds, not at full", async () => {
    const { room, ops: via } = await quietRoom();
    const asset = await quietTone(via, "snd-tone-short", "Short tone", "music", 32);
    const ivyContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
    try {
      await ivyContext.addInitScript(SOUND_TEST_FLAG);
      await ivyContext.addInitScript(roomSoundScript("on"));
      await ivyContext.addInitScript(SOUND_TAP);
      let releaseAt = 0;
      // Every request for the tone waits until 3 s after the play, as a first load over a weak signal does.
      await ivyContext.route(new RegExp(asset), async (route) => {
        if (Date.now() < releaseAt) await sleep(releaseAt - Date.now());
        await route.continue();
      });
      await join(ivyContext, "Ivy", "#14b8a6", room);
      const ivy = await ivyContext.newPage();
      await openRoom(ivy, room);
      releaseAt = Date.now() + 3_500;
      await playTrack("snd-tone-short", 0, "off", via);
      await sleep(10_000);
      await via.send({ t: "music.stop" });
      await sleep(3_000);
      const ramps = fadeRamps((await readTap(ivy)).quanta);
      console.log(`sndfade-2 ramps ${JSON.stringify(ramps)}`);
      assert.deepEqual(
        ramps.map((r) => [r.rising, r.ms > 1_200 && r.ms < 2_200]),
        [
          [true, true],
          [false, true],
        ],
        `a late start fades in over 2 s, and the stop fades out: ${JSON.stringify(ramps)}`,
      );
    } finally {
      await ivyContext.close();
      via.close();
    }
  });
  test("vol-1. This device's Volume on the DM's page: a level scales the engine's gains, the toggle mutes and unmutes at the kept level, a drag to 0 mutes keeping it, raising it unmutes, and U and the media session's pause and play do the same, the toggle's row within 1 px", async () => {
    // The media session's handlers, kept where the step can call them as the lock screen would.
    await dmContext.addInitScript(MEDIA_HANDLERS);
    await dm.setViewportSize({ width: 1280, height: 800 });
    await dm.evaluate(() => {
      localStorage.setItem("rvtt.roomSound", "on");
      localStorage.removeItem("rvtt.soundMix");
    });
    await openRoom(dm);
    await playTrack(run.ids.tavern, 0, "all");
    await soundSays(dm, /^playing music/, 8_000);
    const sounds = await thisDeviceSounds(dm);
    const mute = sounds.getByRole("button", { name: "Mute", exact: true });
    const volume = sounds.getByRole("slider", { name: "Volume", exact: true });
    const stored = () => dm.evaluate(() => ({ choice: localStorage.getItem("rvtt.roomSound"), volume: (JSON.parse(localStorage.getItem("rvtt.soundMix") ?? "{}") as { volume?: number }).volume ?? null }));
    const gains = async () => {
      const mix = (await soundProbe(dm)).state?.mix;
      assert.ok(mix, "the test hook's mix");
      return mix;
    };
    const shows = async (value: string, text: string, pressed: string) => {
      await waitFor(`the master at ${text}`, async () => ((await volume.inputValue()) === value && (await volume.getAttribute("aria-valuetext")) === text && (await mute.getAttribute("aria-pressed")) === pressed ? true : null));
    };
    await shows("100", "100%", "false");
    const full = await gains();

    // 70% by the keys: each channel's gain at 0.49 of its full one.
    await volume.focus();
    for (let i = 0; i < 6; i++) await dm.keyboard.press("ArrowLeft");
    await shows("70", "70%", "false");
    assert.deepEqual(await stored(), { choice: "on", volume: 70 });
    await waitFor("the gains at 70%", async () => {
      const now = await gains();
      return (["music", "loop", "effects"] as const).every((k) => Math.abs(now[k] - full[k] * 0.49) < 1e-6) ? now : null;
    });
    const row = await toggleRow(sounds);
    assert.ok(Math.abs(row.toggle - row.slider) <= 1 && Math.abs(row.percent - row.slider) <= 1, `the toggle's, slider's and percent's centers: ${JSON.stringify(row)}`);
    assert.ok(Math.abs(row.toggleLeft - row.labelLeft) <= 1, `the toggle's box on the labels' edge: ${JSON.stringify(row)}`);
    assert.deepEqual(alignmentLines(await measureAlignment(sounds), "This device's Sounds at 70%, 1280x800"), []);
    await shots.take(dm, "vol-1-this-device-70");

    // The toggle mutes: the engine stops, the master shows 0, Muted to a reader, and the level is kept.
    await mute.click();
    await soundSays(dm, /^off/, 5_000);
    await shows("0", "Muted", "true");
    assert.deepEqual(await stored(), { choice: "off", volume: 70 });
    assert.deepEqual(alignmentLines(await measureAlignment(sounds), "This device's Sounds muted, 1280x800"), []);
    await shots.take(dm, "vol-1-this-device-muted");
    await mute.click();
    await soundSays(dm, /^playing music/, 5_000);
    await shows("70", "70%", "false");

    // A drag to 0 mutes and keeps the level from the press, after passing lower levels on the way.
    const box = (await volume.boundingBox())!;
    const y = box.y + box.height / 2;
    await dm.mouse.move(box.x + box.width * 0.7, y);
    await dm.mouse.down();
    await dm.mouse.move(box.x + box.width * 0.35, y, { steps: 5 });
    await dm.mouse.move(box.x - 20, y, { steps: 5 });
    await dm.mouse.up();
    await soundSays(dm, /^off/, 5_000);
    await shows("0", "Muted", "true");
    assert.deepEqual(await stored(), { choice: "off", volume: 70 }, "the level from the press, never one on the way or a 0");

    // Raised by a key while muted it unmutes and plays at the new level, and back to 0 it keeps the level it was focused at.
    await volume.blur();
    await volume.focus();
    await dm.keyboard.press("ArrowRight");
    await soundSays(dm, /^playing music/, 5_000);
    await shows("5", "5%", "false");
    await dm.keyboard.press("ArrowLeft");
    await soundSays(dm, /^off/, 5_000);
    assert.deepEqual(await stored(), { choice: "off", volume: 70 }, "the level at the focus, not the 0 a muted slider shows");
    await mute.click();
    await shows("70", "70%", "false");

    // Raised by a click while muted: unmuted at the level clicked.
    await mute.click();
    await soundSays(dm, /^off/, 5_000);
    await dm.mouse.click(box.x + box.width / 2, y);
    await soundSays(dm, /^playing music/, 5_000);
    const clicked = (await stored()).volume!;
    assert.ok(clicked >= 40 && clicked <= 60 && (await stored()).choice === "on", `unmuted at the level clicked: ${clicked}`);

    // U mutes and unmutes, with focus on the slider too.
    await dm.keyboard.press("u");
    await soundSays(dm, /^off/, 5_000);
    await shows("0", "Muted", "true");
    await dm.keyboard.press("u");
    await soundSays(dm, /^playing music/, 5_000);
    await shows(String(clicked), `${clicked}%`, "false");

    // The lock screen's pause mutes, and its play unmutes at the kept level.
    const media = (action: "pause" | "play") => dm.evaluate((a) => (globalThis as unknown as { __rvttMedia: Record<string, () => void> }).__rvttMedia[a]!(), action);
    await media("pause");
    await soundSays(dm, /^off/, 5_000);
    assert.deepEqual(await stored(), { choice: "off", volume: clicked });
    await media("play");
    await soundSays(dm, /^playing music/, 5_000);
    await shows(String(clicked), `${clicked}%`, "false");

    // Back to the first level for the steps after.
    await volume.focus();
    await dm.keyboard.press("End");
    await shows("100", "100%", "false");
    await ops.send({ t: "sound.stopAll" });
  });
});

type Ramp = { rising: boolean; at: number; ms: number };

/** The media session's action handlers as the page sets them, on `__rvttMedia`, so a step can press the lock screen's pause and play. */
const MEDIA_HANDLERS = `(() => {
  const session = navigator.mediaSession;
  if (!session) return;
  const set = session.setActionHandler.bind(session);
  globalThis.__rvttMedia = {};
  session.setActionHandler = (action, handler) => {
    globalThis.__rvttMedia[action] = handler;
    return set(action, handler);
  };
})();`;

/** The master row of This device's volume controls: the vertical centers of the mute toggle, the slider and its percent, and the toggle's and the labels' left edges. */
async function toggleRow(sounds: Locator): Promise<{ toggle: number; slider: number; percent: number; toggleLeft: number; labelLeft: number }> {
  return sounds.locator("[data-device-sound]").evaluate((root) => {
    type El = { getBoundingClientRect(): { top: number; height: number; left: number }; nextElementSibling: El | null; querySelector(s: string): El | null };
    const r = root as unknown as El;
    const mid = (el: El) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
    const toggle = r.querySelector("[data-volume-mute]")!;
    const slider = r.querySelector('input[aria-label="Volume"]')!;
    const percent = slider.nextElementSibling!;
    const label = r.querySelector("label")!;
    return { toggle: mid(toggle), slider: mid(slider), percent: mid(percent), toggleLeft: toggle.getBoundingClientRect().left, labelLeft: label.getBoundingClientRect().left };
  });
}

/**
 * Each passage of the tap's level from under a tenth of the tone's full
 * level to over nine tenths, or back, with how long it took. A start at
 * full or a cut crosses within a few quanta, and a 2 s linear fade in 1.6 s.
 */
function fadeRamps(quanta: readonly { at: number; level: number }[]): Ramp[] {
  const levels = quanta.map((q) => q.level).sort((a, b) => a - b);
  const full = levels[Math.floor(levels.length * 0.95)] ?? 0;
  const out: Ramp[] = [];
  let zone: "low" | "high" | null = null;
  let lastLow = 0;
  let lastHigh = 0;
  for (const q of quanta) {
    if (q.level <= 0.1 * full) {
      if (zone === "high") out.push({ rising: false, at: q.at, ms: (q.at - lastHigh) * 1000 });
      zone = "low";
      lastLow = q.at;
    } else if (q.level >= 0.9 * full) {
      if (zone === "low") out.push({ rising: true, at: q.at, ms: (q.at - lastLow) * 1000 });
      zone = "high";
      lastHigh = q.at;
    }
  }
  return out;
}
