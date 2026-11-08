import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { framesFor, silentFrames } from "#shared/audio/mp3Testutil.ts";
import type { SoundUse } from "#shared/sound.ts";
import { ConsoleWatch, openSceneGroup, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { openGroup } from "./helpers/groups.ts";
import { setupHistory } from "./helpers/undoScope.ts";
import { addSound } from "./soundRoom.ts";

/**
 * The Sound panel (docs/design/design-v1-music.md 4.1, 4.3 and 4.6,
 * design-v1-sound-layout.md 4), its Now playing and Library views and the
 * playlist maker's pop-up, on the real server serving the production build
 * with ROOM_SOUND on. Dana the DM is at a desk and Pat on a phone. Sounds are made of
 * frames of silence (shared/audio/mp3Testutil.ts), so no step needs an
 * encoder, and the browsers start with autoplay allowed, since what plays
 * is the engine's and sound.e2e.ts's:
 * - sp-0: the room, Pat, two scenes, and three music tracks, five
 *   background sounds and an effect uploaded and created.
 * - sp-1: the DM's Sound with nothing playing, on Now playing, its sections
 *   in D-261106-091's order and the storage line.
 * - sp-2: a playlist made in the maker's pop-up from Library and played,
 *   then paused, resumed, stepped through Repeat, skipped and stopped from
 *   the panel's player, each one op.
 * - sp-3: Background's toggles, the fifth refused in words, a loop's
 *   volume for everyone under Table sound, and its Stop.
 * - sp-4: the board's built-ins and the room's effect fired, Edit opening
 *   an effect's page with the uses its length rules out.
 * - sp-5: a sound's page refusing the delete of a playing loop, a rename on
 *   Enter, and a track's page reached through Library's Rename or delete…: a played
 *   track deleted with the music playing on, a queued track's change of use
 *   refused, the revealed next's and the playing track's delete refused.
 * - sp-6: a scene's sound saved from what plays with Table sound's Use
 *   what's playing, off with "Play something first." while nothing plays,
 *   started by Move players, and set and cleared in Scenes' own group, the
 *   scene's line following each, with no row that only opens Scenes.
 * - sp-7: Players see what is playing: Pat's card by name and with the
 *   names kept, the background by name and by count, the one switch.
 * - dmb-1: Only DM devices play (docs/design/design-v1-sound-dm-only.md 4
 *   and 5): the switch last in Table sound, its reminder under the player
 *   and in the chip's player, Pat's open panel and This device saying the
 *   DM plays it, the search's row with its value, and Undo setup turning
 *   it off.
 * - sp-8: the X-card's Stop the sound.
 * - sp-9: a second server with the switch off: the one line, Built in, no
 *   Add buttons and no view row, Table sound with Only DM devices play
 *   alone, a built-in fired with it on kept to the DM's devices, and a
 *   sound upload refused.
 * - sp-10: an effect deleted from its page on a second tap, its file with
 *   it.
 * - mfa-1: an effect fired behind a blackout, with nothing else playing:
 *   Stop all sound (a 12-second one) and the X-card's Stop the sound while
 *   it sounds, and neither once it is over.
 * - sfx-1: a 3-second effect does not bring up Stop all sound, while the
 *   X-card's Stop the sound shows for it.
 * - mfa-2: a read of the server's switch that fails says so, never that
 *   the server has no sound files, and Try again asks again.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty-eight, and the
 * switch-off server on plus forty-nine, one file after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 48;
const OFF_PORT = Number(process.env.E2E_PORT ?? 3100) + 49;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-soundpanel-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E sound panel ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneA: "",
  sceneB: randomUUID(),
  sounds: {} as Record<string, string>,
  /** When the last X-card was sent: taps within 10 s of a room's card merge into it and show none. */
  xcardAt: 0,
};

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The sounds sp-0 adds, by name, with their use and length. Music is 30 s at least, so the tracks are 31 s. */
const LIBRARY: { name: string; use: SoundUse; ms: number }[] = [
  { name: "The Prancing Pony", use: "music", ms: 31_000 },
  { name: "Road", use: "music", ms: 32_000 },
  { name: "March", use: "music", ms: 33_000 },
  { name: "Rain", use: "loop", ms: 3_000 },
  { name: "Crowd", use: "loop", ms: 3_000 },
  { name: "Wind", use: "loop", ms: 3_000 },
  { name: "Fire", use: "loop", ms: 3_000 },
  { name: "Drip", use: "loop", ms: 3_000 },
  { name: "Thunder", use: "effect", ms: 1_000 },
];

async function join(context: BrowserContext, name: string, color: string, origin = server.origin): Promise<string> {
  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await context.request.post(`${origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

async function createRoom(page: Page, context: BrowserContext, origin: string, name: string): Promise<{ roomId: string; password: string; ops: OpSocket }> {
  await page.goto(`${origin}/`);
  await page.getByLabel("Room name").fill(name);
  await page.getByLabel("Your name").fill("Dana the DM");
  const password = await page.getByLabel("Player password").inputValue();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
  assert.ok(match, `DM link looks wrong: ${link}`);
  const roomId = match[1]!.replace("-", "");
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  const cookie = (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  return { roomId, password, ops: await OpSocket.open({ origin, roomId, cookie }) };
}

/** Uploads a sound file of frames of silence and creates its sound, as the DM's Add buttons do (4.2 step 6). */
function addEntry(entry: (typeof LIBRARY)[number]): Promise<string> {
  return addSound({ context: dmContext, origin: server.origin, roomId: run.roomId, ops, id: randomUUID(), name: entry.name, use: entry.use, ms: entry.ms });
}

/** The DM's Sound panel, the side panel's tab on the desk, on its Now playing view unless `library` (docs/design/design-v1-sound-layout.md 4.1). */
async function soundPanel(page: Page = dm, library = false): Promise<Locator> {
  // A step that failed with the maker open would leave it over the panel for every step after.
  await closeMaker(page);
  await openSideTab(page, "Sound");
  const panel = page.getByRole("tabpanel", { name: sideTabName("Sound") });
  await showView(panel, library ? "Library" : "Now playing");
  return panel;
}

/** The DM's Sound at any size: the side panel's tab where there is one, or the Panels list's row and its sheet on a phone. */
async function anySoundPanel(page: Page): Promise<Locator> {
  if (await page.getByRole("tablist", { name: "Panels" }).isVisible()) return (await openSideTab(page, "Sound"), page.getByRole("tabpanel", { name: sideTabName("Sound") }));
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Sound"]');
  if (await sheet.isVisible()) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Sound/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** Sound's view row, a radio group named Sound, and the view it picks, waited on. */
async function showView(panel: Locator, name: "Now playing" | "Library"): Promise<void> {
  const radio = panel.getByRole("radiogroup", { name: "Sound", exact: true }).getByRole("radio", { name, exact: true });
  if (!(await radio.isChecked())) await radio.click();
  if (name === "Library") await panel.getByRole("searchbox", { name: "Search music" }).waitFor();
  else await panel.locator("[data-sound-player]").waitFor();
}

/** A player's Sound on a phone: the Panels list's row, then its sheet. */
async function patPanel(): Promise<Locator> {
  const sheet = pat.locator('dialog[data-rvtt-sheet][aria-label="Sound"]');
  if (await sheet.isVisible()) return sheet;
  await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await pat.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Sound/ }).click();
  await sheet.waitFor();
  return sheet;
}

function playing() {
  return dmSocket.state?.playing ?? null;
}

async function until<T>(what: string, read: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  return (await waitFor(what, () => read() || null, ms)) as T;
}

/** Back from a Sound subpage, to the view it left (4.5). */
async function back(panel: Locator): Promise<void> {
  // The side panel's header holds it, above the tab panel.
  await panel.page().getByRole("button", { name: /^Back to Sound/ }).first().click();
  await panel.getByRole("radiogroup", { name: "Sound", exact: true }).waitFor();
}

/** Sound at any size on its Library view (4.4). */
async function library(page: Page = dm): Promise<Locator> {
  const panel = await anySoundPanel(page);
  await showView(panel, "Library");
  return panel;
}

/** The playlist maker's pop-up, by its title: the playlist's name, or New playlist (4.5). */
function maker(name: string, page: Page = dm): Locator {
  return page.getByRole("dialog", { name, exact: true }).filter({ has: page.locator("[data-music-maker]") });
}

async function closeMaker(page: Page = dm): Promise<void> {
  const open = page.locator("dialog[open]").filter({ has: page.locator("[data-music-maker]") });
  if ((await open.count()) === 0) return;
  await open.getByRole("button", { name: /^Close/ }).last().click();
  // With changes it asks first, and the same press again discards.
  const asked = await open.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor({ timeout: 1_000 }).then(() => true, () => false);
  if (asked) await open.getByRole("button", { name: /^Close/ }).last().click();
  await open.waitFor({ state: "detached" });
}

/** A track's page, a Sound subpage, through Library's More, Rename or delete… (4.5). */
async function trackPage(panel: Locator, name: string): Promise<void> {
  await panel.getByRole("list", { name: "Tracks" }).getByRole("button", { name: `More for ${name}`, exact: true }).click();
  await panel.page().getByRole("menuitem", { name: "Rename or delete…", exact: true }).click();
  await panel.page().getByRole("button", { name: /^Back to Sound/ }).first().waitFor();
  assert.equal(await panel.getByRole("textbox", { name: "Name" }).inputValue(), name);
}

describe("the Sound panel", { concurrency: false }, () => {
  before(async () => {
    // startServer passes this process's environment on: every step but sp-9 runs with the switch on.
    process.env.ROOM_SOUND = "1";
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1", args: ["--autoplay-policy=no-user-gesture-required"] });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("sp-0. a DM's room with Pat on a phone, two scenes, and nine sounds", async () => {
    const made = await createRoom(dm, dmContext, server.origin, run.roomName);
    run.roomId = made.roomId;
    run.password = made.password;
    ops = made.ops;
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.sceneA = dmSocket.state!.meta.playerSceneId!;
    await ops.send({ t: "scene.update", sceneId: run.sceneA, patch: { name: "Tavern" } });
    await ops.send({ t: "scene.create", scene: { id: run.sceneB, name: "Forest road", bounds: { w: 20, h: 14 }, fogEnabled: false } });
    for (const entry of LIBRARY) run.sounds[entry.name] = await addEntry(entry);
    await until("the library in the DM's copy", () => Object.keys(dmSocket.state?.sounds ?? {}).length === LIBRARY.length);
    await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state);
    assert.deepEqual(patSocket.state?.sounds ?? {}, {}, "a player holds no library");
  });

  test("sp-1. the DM's Sound with nothing playing: Now playing with the idle line, Effects, Table sound, Background, On this device and the storage line", async () => {
    const panel = await soundPanel();
    assert.equal(await panel.getByRole("radio", { name: "Now playing", exact: true }).isChecked(), true, "it opens on Now playing");
    await panel.locator("[data-music-idle]").getByText(/^No music is playing\. Pick a playlist or a track in Library\.$/).waitFor();
    // The section labels, in D-261106-091's order. Up next has no fold with no music, and the player has no label of its own.
    const sections = panel.locator("section > h3, section > [data-section-label] > h3");
    assert.deepEqual(await sections.allTextContents(), ["Effects", "Table sound", "Background", "On this device"]);
    await panel.getByText("What everyone at the table hears, set here for every device. Each device can turn itself down under On this device.", { exact: true }).waitFor();
    // Music's playlists and tracks are Library's, the second view (4.4).
    assert.equal(await panel.getByRole("list", { name: "Tracks" }).count(), 0, "Library's lists are not on Now playing");
    await panel.getByText(/^Sounds use .+\. Images and sounds share the room's .+, and .+ is free\.$/).waitFor({ timeout: 15_000 });
    await shots.take(dm, "sp-1-dm-panel-silent");
  });

  test("sp-2. a playlist made in the maker's pop-up from Library and played, then paused, resumed, Repeat stepped, skipped and stopped in the panel's player", async () => {
    let panel = await soundPanel(dm, true);
    const create = panel.getByRole("button", { name: "New playlist", exact: true });
    await create.click();
    const made = maker("New playlist");
    await made.waitFor();
    await made.getByRole("textbox", { name: "Name" }).fill("Tavern night");
    for (const track of ["Road", "The Prancing Pony"]) await made.getByRole("button", { name: `Add ${track}`, exact: true }).click();
    await made.getByRole("button", { name: "Move The Prancing Pony, 2 of 2", exact: true }).focus();
    await dm.keyboard.press("ArrowUp");
    await made.getByRole("button", { name: "Move The Prancing Pony, 1 of 2", exact: true }).waitFor();
    // The maker keeps a draft: nothing reaches the room until Create.
    assert.equal(Object.values(dmSocket.state?.playlists ?? {}).length, 0, "no playlist before Create");
    await made.locator("footer").getByRole("button", { name: "Create playlist", exact: true }).click();
    const playlist = await until("Tavern night made", () => Object.values(dmSocket.state?.playlists ?? {}).find((p) => p.name === "Tavern night"));
    assert.deepEqual(playlist.sounds, [run.sounds["The Prancing Pony"], run.sounds.Road], "in the maker's order");
    await made.waitFor({ state: "detached" });
    await waitFor("focus back on New playlist", () => create.evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)), 5_000);
    await panel.getByRole("list", { name: "Playlists" }).getByRole("button", { name: "Play Tavern night", exact: true }).click();
    await until("the playlist playing", () => playing()?.music?.playlistId === playlist.id);

    panel = await soundPanel();
    const player = panel.locator("[data-sound-player]");
    await player.locator("[data-music-track]").filter({ hasText: /^The Prancing Pony$/ }).waitFor();
    await player.locator("[data-music-run]").filter({ hasText: /^Tavern night · 1 of 2$/ }).waitFor();
    await player.locator("[data-music-seek]").filter({ hasText: /^\d:\d\d\s*0:31$/ }).waitFor();
    // Up next folds with the next track beside its name (4.3).
    await panel.locator("[data-music-upnext-summary]").filter({ hasText: /^Next: Road$/ }).waitFor();
    await shots.take(dm, "sp-2-dm-now-playing");

    await player.getByRole("button", { name: "Pause", exact: true }).click();
    await until("paused", () => playing()?.music?.paused !== undefined);
    await player.getByRole("button", { name: "Play", exact: true }).click();
    await until("resumed", () => playing()?.music && playing()?.music?.paused === undefined);
    // Repeat and Stop the music are in the panel's player again (8.1).
    for (const [from, to] of [["Repeat all", "one"], ["Repeat one", "off"], ["Repeat off", "all"]] as const) {
      await player.getByRole("button", { name: from, exact: true }).click();
      await until(`Repeat ${to}`, () => playing()?.music?.repeat === to);
    }
    await player.getByRole("button", { name: "Skip to the next track", exact: true }).click();
    await until("the second track", () => playing()?.music?.now.soundId === run.sounds.Road);
    await player.locator("[data-music-run]").filter({ hasText: /^Tavern night · 2 of 2$/ }).waitFor();
    await player.getByRole("button", { name: "Stop the music", exact: true }).click();
    await until("the music stopped", () => playing() === null || playing()?.music === null);
    await panel.locator("[data-music-idle]").waitFor();
  });

  test("sndfade-1. the playing row's Play is Pause: it pauses the music, Play resumes it where it paused, another row's Play starts that one, and each changes before the server answers", async () => {
    const tracksOf = (p: Locator) => p.getByRole("list", { name: "Tracks" });
    const rowButton = (p: Locator, name: string) => tracksOf(p).getByRole("button", { name, exact: true });
    // The rows are Library's, Sound's second view (docs/design/design-v1-sound-layout.md 4.4).
    let panel = await library();
    await rowButton(panel, "Play Road").click();
    await until("Road playing", () => playing()?.music?.now.soundId === run.sounds.Road && playing()?.music?.paused === undefined);
    await rowButton(panel, "Pause Road").waitFor();
    assert.equal(await rowButton(panel, "Play March").count(), 1, "another row keeps Play");

    // The rows and Now playing at three sizes and two scales, dark then light, within 1 px. Shots at a desk and on a phone.
    const lines: string[] = [];
    for (const scheme of ["dark", "light"] as const) {
      for (const size of [DESK, PHONE, { width: 320, height: 568 }]) {
        for (const scale of [1, 1.3]) {
          await dm.setViewportSize(size);
          await dm.evaluate(([s, sc]) => {
            localStorage.setItem("rvtt.theme", s as string);
            localStorage.setItem("rvtt.uiScale", String(sc));
          }, [scheme, scale] as const);
          await dm.goto(`${server.origin}/r/${run.roomId}`);
          await dm.getByRole("status", { name: "Connected" }).first().waitFor();
          const where = `${size.width}x${size.height} ${scale * 100}% ${scheme}`;
          const p = await anySoundPanel(dm);
          await showView(p, "Now playing");
          const player = p.locator("[data-sound-player]");
          await player.getByRole("button", { name: "Pause", exact: true }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(player), `Now playing ${where}`));
          const device = size.width === DESK.width ? "desk" : "phone";
          if (scale === 1 && size.width !== 320) {
            await player.scrollIntoViewIfNeeded();
            await shots.take(dm, `sndfade-1-now-playing-${device}-${scheme}`);
          }
          await showView(p, "Library");
          await rowButton(p, "Pause Road").waitFor();
          lines.push(...alignmentLines(await measureAlignment(tracksOf(p)), `the Tracks rows ${where}`));
          if (scale === 1 && size.width !== 320) {
            await tracksOf(p).scrollIntoViewIfNeeded();
            await shots.take(dm, `sndfade-1-tracks-${device}-${scheme}`);
          }
        }
      }
    }
    await dm.setViewportSize(DESK);
    await dm.evaluate(() => {
      localStorage.setItem("rvtt.theme", "dark");
      localStorage.setItem("rvtt.uiScale", "1");
    });
    assert.deepEqual(lines, [], "the rows and Now playing out of line");

    // A page whose server frames come 1.5 s late: what its buttons show next comes from its own view of the op.
    const slow = await dmContext.newPage();
    try {
      await slow.routeWebSocket(/\/ws\?room=/, (ws) => {
        const upstream = ws.connectToServer();
        ws.onMessage((m) => upstream.send(m));
        upstream.onMessage((m) => setTimeout(() => ws.send(m), 1_500));
      });
      await slow.goto(`${server.origin}/r/${run.roomId}`);
      await slow.getByRole("status", { name: "Connected" }).first().waitFor();
      panel = await library(slow);
      await rowButton(panel, "Pause Road").waitFor();
      const soon = { timeout: 1_000 };

      // The row's button and the player's turn at once, a switch of view being the page's own, well inside the frames' 1.5 s.
      const pressed = Date.now();
      await rowButton(panel, "Pause Road").click();
      await rowButton(panel, "Play Road").waitFor(soon);
      await showView(panel, "Now playing");
      await panel.locator("[data-sound-player]").getByRole("button", { name: "Play", exact: true }).waitFor(soon);
      assert.ok(Date.now() - pressed < 1_500, `the player turned before the server's frame could (${Date.now() - pressed} ms)`);
      const paused = await until("paused", () => playing()?.music?.paused);
      await shots.take(slow, "sndfade-1-paused");
      await showView(panel, "Library");

      await rowButton(panel, "Play Road").click();
      await rowButton(panel, "Pause Road").waitFor(soon);
      const resumed = await until("resumed", () => (playing()?.music?.paused === undefined ? playing()?.music : null));
      assert.equal(resumed?.now.soundId, run.sounds.Road, "the same track");
      const at = Date.now() - resumed!.now.at;
      assert.ok(at > paused - 500 && at < paused + 3_000, `from where it paused, ${paused} ms in: ${at} ms`);

      await rowButton(panel, "Play March").click();
      await rowButton(panel, "Pause March").waitFor(soon);
      await rowButton(panel, "Play Road").waitFor(soon);
      await until("March playing", () => playing()?.music?.now.soundId === run.sounds.March);

      // A playlist's row: Tavern night from sp-2, its first track The Prancing Pony.
      const lists = panel.getByRole("list", { name: "Playlists" });
      await lists.getByRole("button", { name: "Play Tavern night", exact: true }).click();
      await lists.getByRole("button", { name: "Pause Tavern night", exact: true }).waitFor(soon);
      await rowButton(panel, "Pause The Prancing Pony").waitFor(soon);
      await rowButton(panel, "Play March").waitFor(soon);
      await until("the playlist playing", () => playing()?.music?.playlistId !== undefined && playing()?.music?.paused === undefined);
      await lists.getByRole("button", { name: "Pause Tavern night", exact: true }).click();
      await lists.getByRole("button", { name: "Play Tavern night", exact: true }).waitFor(soon);
      await until("the playlist paused", () => playing()?.music?.paused !== undefined);
      await lists.getByRole("button", { name: "Play Tavern night", exact: true }).click();
      await lists.getByRole("button", { name: "Pause Tavern night", exact: true }).waitFor(soon);
      await until("the playlist resumed", () => playing()?.music?.playlistId !== undefined && playing()?.music?.paused === undefined);
    } finally {
      await slow.close();
      await ops.send({ t: "music.stop" });
    }
    await until("the music stopped", () => playing() === null || playing()?.music === null);
  });

  test("sp-3. Background: four loops at 70%, the fifth refused in words, a volume for everyone and Stop", async () => {
    const panel = await soundPanel();
    const list = panel.getByRole("list", { name: "Background sounds" });
    for (const loop of ["Rain", "Crowd", "Wind", "Fire"]) {
      await list.getByRole("button", { name: loop, exact: true }).click();
      await until(`${loop} playing`, () => Object.values(playing()?.loops ?? {}).some((l) => l.soundId === run.sounds[loop] && l.volume === 70));
      assert.equal(await list.getByRole("button", { name: loop, exact: true }).getAttribute("aria-pressed"), "true");
    }
    await list.getByRole("button", { name: "Drip", exact: true }).click();
    await panel.getByText("Up to four background sounds can play at once. Stop one first.", { exact: true }).waitFor();
    assert.equal(Object.keys(playing()?.loops ?? {}).length, 4, "nothing sent for the fifth");
    const rain = panel.getByLabel("Rain volume for everyone", { exact: true });
    await rain.focus();
    for (let i = 0; i < 10; i++) await dm.keyboard.press("ArrowLeft");
    await until("Rain at 60%", () => Object.values(playing()?.loops ?? {}).some((l) => l.soundId === run.sounds.Rain && l.volume === 60));
    await shots.take(dm, "sp-3-dm-loops");
    await panel.getByRole("button", { name: "Stop Rain", exact: true }).click();
    await until("Rain stopped", () => !Object.values(playing()?.loops ?? {}).some((l) => l.soundId === run.sounds.Rain));
  });

  test("sp-4. the board: a built-in and the room's effect fired for everyone, and Edit opening the effect's page", async () => {
    const panel = await soundPanel();
    await panel.getByRole("button", { name: "Play Crash for everyone", exact: true }).click();
    await until("Crash fired", () => playing()?.effects.some((e) => e.builtin === "crash"));
    await panel.getByRole("button", { name: "Play Thunder for everyone", exact: true }).click();
    await until("Thunder fired", () => playing()?.effects.some((e) => e.soundId === run.sounds.Thunder));
    const effects = panel.getByRole("heading", { name: "Effects", exact: true }).locator("xpath=ancestor::section[1]");
    await effects.getByRole("button", { name: "Edit", exact: true }).click();
    await effects.getByRole("button", { name: /^Thunder/ }).click();
    await dm.getByRole("button", { name: /^Back to Sound/ }).first().waitFor();
    const music = panel.getByRole("radio", { name: "Music", exact: true });
    assert.equal(await music.isDisabled(), true, "a 1-second sound cannot be music");
    await panel.getByText("Music is 30 seconds at least. Background sounds are 2 seconds at least.", { exact: true }).waitFor();
    await shots.take(dm, "sp-4-dm-sound-page");
    await back(panel);
    await effects.getByRole("button", { name: "Done", exact: true }).click();
    await effects.getByRole("button", { name: "Play Thunder for everyone", exact: true }).waitFor();
  });

  test("sp-5. a sound's page refuses the delete of a playing loop and renames on Enter, and a track's page from Library deletes a played track and refuses a queued one's use, the next's delete and the playing one's", async () => {
    const panel = await soundPanel();
    // Crowd plays since sp-3. Its page opens from Background's Edit.
    const background = panel.getByRole("heading", { name: "Background", exact: true }).locator("xpath=ancestor::section[1]");
    await background.getByRole("button", { name: "Edit", exact: true }).click();
    await background.getByRole("button", { name: "Edit Crowd", exact: true }).click();
    await panel.getByRole("button", { name: "Delete", exact: true }).click();
    await panel.getByText("Stop it first. It is playing now.", { exact: true }).waitFor();
    assert.ok(dmSocket.state?.sounds?.[run.sounds.Crowd!], "nothing deleted");
    const name = panel.getByRole("textbox", { name: "Name" });
    await name.fill("Tavern crowd");
    await name.press("Enter");
    await until("the rename", () => dmSocket.state?.sounds?.[run.sounds.Crowd!]?.name === "Tavern crowd");
    await back(panel);
    await background.getByRole("button", { name: "Done", exact: true }).click();

    // A track's page is a Sound subpage, reached from Library's More (docs/design/design-v1-sound-layout.md 4.5, design-v1-music-player.md 6.4).
    // Harbor is two minutes, so March, after it, is only queued until a seek near Harbor's end reveals it.
    run.sounds.Harbor = await addEntry({ name: "Harbor", use: "music", ms: 120_000 });
    const queueId = randomUUID();
    const order = [run.sounds["The Prancing Pony"]!, run.sounds.Harbor, run.sounds.March!];
    await ops.send({ t: "playlist.create", id: queueId, name: "Harbor watch", sounds: order, repeat: "off", fade: 0 });
    await ops.send({ t: "music.play", run: randomUUID(), playlistId: queueId, order, index: 1, repeat: "off", fade: 0 });
    await until("Harbor playing", () => playing()?.music?.now.soundId === run.sounds.Harbor);
    const lib = await soundPanel(dm, true);
    // The Prancing Pony is played under Repeat off: its delete goes ahead, the page goes back to Library, and the music plays on.
    await trackPage(lib, "The Prancing Pony");
    await lib.getByRole("button", { name: "Delete", exact: true }).click();
    await lib.getByRole("button", { name: "Delete The Prancing Pony", exact: true }).click();
    await until("The Prancing Pony gone", () => !dmSocket.state?.sounds?.[run.sounds["The Prancing Pony"]!]);
    await lib.getByRole("searchbox", { name: "Search music" }).waitFor();
    const after = await until("the run without it", () => (playing()?.music?.order?.includes(run.sounds["The Prancing Pony"]!) === false ? playing()?.music : null));
    assert.equal(after?.now.soundId, run.sounds.Harbor, "the music plays on");
    // March is queued: no other use while it is.
    await trackPage(lib, "March");
    await lib.getByRole("radio", { name: "Background", exact: true }).click();
    await lib.getByText("This track is in the queue. Take it out under Up next first.", { exact: true }).waitFor();
    assert.equal(dmSocket.state?.sounds?.[run.sounds.March!]?.use, "music", "nothing sent");
    // Revealed as Harbor's next, it cannot go either.
    const current = playing()!.music!;
    await ops.send({ t: "music.jump", run: randomUUID(), from: current.run, soundId: run.sounds.Harbor, ms: 110_000, on: run.sounds.Harbor });
    await until("March revealed next", () => playing()?.music?.next?.soundId === run.sounds.March);
    await lib.getByRole("button", { name: "Delete", exact: true }).click();
    await lib.getByText("This track plays next. Take it out of Up next first.", { exact: true }).waitFor();
    // Playing, it cannot either. Back finds Library as it was left.
    await back(lib);
    await lib.getByRole("list", { name: "Tracks" }).getByRole("button", { name: "Play March", exact: true }).click();
    await until("March playing", () => playing()?.music?.now.soundId === run.sounds.March);
    await trackPage(lib, "March");
    await lib.getByRole("button", { name: "Delete", exact: true }).click();
    await lib.getByText("This track is playing. Skip it or stop the music first.", { exact: true }).waitFor();
    assert.ok(dmSocket.state?.sounds?.[run.sounds.March!], "nothing deleted");
    await back(lib);
  });

  test("sp-6. a scene's sound: saved from what plays with Table sound's Use what's playing, started by Move players, silence saved and cleared in Scenes, the line following each", async () => {
    const panel = await soundPanel();
    // The DM shows Forest road on their own screen. The players stay in the Tavern.
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
    await scenes.getByRole("button", { name: /^Forest road/ }).first().click();
    await waitFor("the DM on Forest road", () => dmSocket.you?.sceneId === run.sceneB || null);
    await soundPanel();
    // Use what's playing is an action beside what plays, the scene's line its help, and no row only opens Scenes (docs/design/design-v1-sound-layout.md 6.2).
    const table = panel.locator("[data-sound-table]");
    await table.getByText("Forest road has no sound of its own.", { exact: true }).waitFor();
    const use = table.getByRole("button", { name: "Use what's playing", exact: true });
    assert.equal(await use.isEnabled(), true);
    assert.match((await use.getAttribute("aria-describedby")) ?? "", /^sound-scene-/, "Use what's playing says which scene it saves to");
    assert.equal(await panel.getByRole("button", { name: /^Scene sound/ }).count(), 0, "no Scene sound row");
    for (const gone of ["Play it", "Use silence", "Clear"]) assert.equal(await panel.getByRole("button", { name: gone, exact: true }).count(), 0, `${gone} lives in Scenes`);
    await use.click();
    const saved = await until("Forest road's sound", () => dmSocket.state?.scenes[run.sceneB]?.sound);
    assert.equal(saved.music?.soundId, run.sounds.March);
    assert.deepEqual(saved.loops.map((l) => l.soundId).sort(), [run.sounds.Crowd, run.sounds.Fire, run.sounds.Wind].sort());
    await table.getByText(/^Forest road's sound: March, (Tavern crowd|Wind|Fire), (Tavern crowd|Wind|Fire), (Tavern crowd|Wind|Fire)\.$/).waitFor();
    await panel.getByRole("button", { name: "Stop all sound", exact: true }).click();
    await until("silence", () => playing() === null || (playing()?.music === null && Object.keys(playing()?.loops ?? {}).length === 0));
    // Nothing plays: Use what's playing is off and says why.
    await table.getByText("Play something first.", { exact: true }).waitFor();
    assert.equal(await use.isDisabled(), true, "nothing to use");
    assert.deepEqual(alignmentLines(await measureAlignment(table), "Table sound with nothing playing, 1440x900"), []);

    // Move players there: the scene's sound starts behind the move.
    await openSideTab(dm, "Scenes");
    await scenes.getByRole("button", { name: "Move players to Forest road", exact: true }).click();
    // Forest road's fog is off, so the move asks first (features/scenes/SceneList.tsx).
    const anyway = scenes.getByRole("button", { name: "Move anyway", exact: true });
    if (await anyway.waitFor({ timeout: 2_000 }).then(() => true, () => false)) await anyway.click();
    await until("the players on Forest road", () => dmSocket.state?.meta.playerSceneId === run.sceneB);
    await until("its music by the move", () => playing()?.music?.now.soundId === run.sounds.March);
    assert.equal(Object.keys(playing()?.loops ?? {}).length, 3);

    // Use silence and Clear live in Scenes' own Scene sound group, and Table sound's line follows whatever they set.
    const own = await openSceneGroup(scenes, "Scene sound");
    await own.getByText(/^Forest road's sound: March, (Tavern crowd|Wind|Fire), (Tavern crowd|Wind|Fire), (Tavern crowd|Wind|Fire)\.$/).waitFor();
    await own.getByRole("button", { name: "Use silence", exact: true }).click();
    await until("silence saved", () => dmSocket.state?.scenes[run.sceneB]?.sound?.music === null && dmSocket.state?.scenes[run.sceneB]?.sound?.loops.length === 0);
    await own.getByText("Forest road is silent.", { exact: true }).waitFor();
    await shots.take(dm, "sp-6-dm-scene-silent");
    await soundPanel();
    await table.getByText("Forest road is silent.", { exact: true }).waitFor();
    await openSideTab(dm, "Scenes");
    await (await openSceneGroup(scenes, "Scene sound")).getByRole("button", { name: "Clear", exact: true }).click();
    await until("no sound of its own", () => dmSocket.state?.scenes[run.sceneB] && dmSocket.state.scenes[run.sceneB]!.sound === undefined);
    await own.getByText("Forest road has no sound of its own.", { exact: true }).waitFor();
    await soundPanel();
    await table.getByText("Forest road has no sound of its own.", { exact: true }).waitFor();
  });

  test("sp-7. Players see what is playing: Pat's card says only that music plays while it is off, names the track and the background with it on, and the panel has the one switch", async () => {
    const panel = await soundPanel();
    await until("something plays for Pat", () => patSocket.state?.playing?.music);
    const sheet = await patPanel();
    const card = sheet.locator("[data-sound-player-card]");
    await card.getByText("Music is playing", { exact: true }).waitFor();
    await sheet.getByText("3 background sounds are playing.", { exact: true }).waitFor();
    assert.equal((await sheet.innerText()).includes("March"), false, "no track's name on Pat's screen while the DM keeps the names");
    await shots.take(pat, "sp-7-pat-panel-unnamed");
    const names = panel.getByRole("switch", { name: "Players see what is playing" });
    assert.equal(await names.count(), 1, "one switch, in Table sound");
    await names.click();
    await card.getByText("March", { exact: true }).waitFor();
    await sheet.getByText(/^Background: /).waitFor();
    await shots.take(pat, "sp-7-pat-panel-named");
    await names.click();
    await card.getByText("Music is playing", { exact: true }).waitFor();
    assert.equal(await names.getAttribute("aria-checked"), "false");
  });

  test("dmb-1. Only DM devices play: the switch last in Table sound, its reminder under the player and in the chip's player, Pat's open panel and This device saying the DM plays it, the search's row with its value, and Undo setup turning it off", async () => {
    const REMINDER = "Only DM devices play the sound.";
    const DM_PLAYS = "The DM plays the sound on their own device.";
    const panel = await soundPanel();
    const table = panel.locator("[data-sound-table]");
    const names = table.getByRole("switch", { name: "Players see what is playing" });
    const dmOnly = table.getByRole("switch", { name: "Only DM devices play" });
    assert.equal(await dmOnly.getAttribute("aria-checked"), "false", "off in a room that never set it");
    assert.ok((await dmOnly.boundingBox())!.y > (await names.boundingBox())!.y, "after the names switch");
    await until("music plays for Pat", () => patSocket.state?.playing?.music);
    const sheet = await patPanel();
    await sheet.locator("[data-sound-player-card]").waitFor();
    await dmOnly.click();
    await until("the room keeps it", () => dmSocket.state?.meta.settings.soundDmOnly === true);
    assert.equal(await dmOnly.getAttribute("aria-checked"), "true");
    assert.equal(await names.isEnabled(), true, "Players see what is playing stays enabled (D-261107-245)");
    const player = panel.locator("[data-sound-player]");
    await player.getByText(REMINDER, { exact: true }).waitFor();
    assert.ok(playing()?.music, "the DM's own devices keep everything");
    assert.deepEqual(alignmentLines(await measureAlignment(player), "Now playing with Only DM devices play's reminder, 1440x900"), []);
    await dmOnly.scrollIntoViewIfNeeded();
    assert.deepEqual(alignmentLines(await measureAlignment(table), "Table sound with Only DM devices play on, 1440x900"), []);
    await shots.take(dm, "dmb-1-dm-table-sound-on");
    await player.scrollIntoViewIfNeeded();
    await shots.take(dm, "dmb-1-dm-reminder");

    // Pat's panel, left open, says the DM plays it in place of the card, and Pat's socket holds nothing about sound.
    await sheet.getByText(DM_PLAYS, { exact: true }).waitFor();
    await until("Pat's projection without the sound", () => patSocket.state?.meta.settings.soundDmOnly === true && patSocket.state.playing === undefined);
    assert.deepEqual(patSocket.state?.sounds ?? {}, {});
    assert.equal(await sheet.locator("[data-sound-player-card]").count(), 0);
    assert.deepEqual(alignmentLines(await measureAlignment(sheet), "Pat's Sound with Only DM devices play on, 390x844"), []);
    await shots.take(pat, "dmb-1-pat-panel");
    // This device's Sounds says it once, above Room sound.
    await pat.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });
    await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await pat.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    const menu = pat.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
    await menu.getByRole("button", { name: /^This device/ }).click();
    await openGroup(menu, "Sounds");
    const sounds = menu.locator("[data-panel-group]").filter({ has: pat.getByRole("heading", { name: "Sounds", exact: true }) }).last();
    const note = sounds.getByText(DM_PLAYS, { exact: true });
    await note.waitFor();
    assert.ok((await note.boundingBox())!.y < (await sounds.getByRole("switch", { name: "Room sound" }).boundingBox())!.y, "above Room sound");
    await sounds.getByText(/the DM can turn on Only DM devices play in Sound\./).waitFor();
    await sounds.scrollIntoViewIfNeeded();
    assert.deepEqual(alignmentLines(await measureAlignment(sounds), "Pat's This device Sounds with Only DM devices play on, 390x844"), []);
    await shots.take(pat, "dmb-1-pat-this-device");
    await pat.keyboard.press("Escape");

    // The chip's player says it under the player.
    const chip = dm.locator('header[data-rvtt-topbar] [data-chip="nowPlaying"]');
    await chip.waitFor();
    await ((await chip.getAttribute("data-chip-form")) === "full" ? chip.locator("[data-now-open]") : chip).click();
    const now = dm.getByRole("dialog", { name: "Now playing", exact: true });
    await now.locator("[data-now-player]").getByText(REMINDER, { exact: true }).waitFor();
    assert.deepEqual(alignmentLines(await measureAlignment(now), "the chip's player with Only DM devices play on, 1440x900"), []);
    await shots.take(dm, "dmb-1-dm-chip-player");
    await dm.keyboard.press("Escape");
    await now.waitFor({ state: "detached" });

    // The search finds it by the owner's words, with its value now, and lands on the switch.
    await dm.locator('[data-search-open="bar"]').click();
    const search = dm.locator("dialog[data-search-sheet]");
    await search.waitFor();
    await search.locator("[data-search-field]").fill("only play for me");
    const result = search.locator('[data-search-row="setting:sound.table.dmonly"]');
    await result.waitFor();
    assert.match((await result.innerText()).replace(/\s+/g, " "), /Only DM devices play.*On/);
    await shots.take(dm, "dmb-1-dm-search");
    await result.click();
    await waitFor("focus on the switch", async () => ((await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute("data-search"))) === "sound.table.dmonly" ? true : null), 8_000);

    // Undo setup names the step and turns it off, and Pat's card comes back.
    const { sheet: history } = await setupHistory(dm);
    await history.locator("#history-setup-undo").getByText(/^turning on Only DM devices play$/i).waitFor();
    await history.getByRole("button", { name: "Undo setup", exact: true }).click();
    await history.locator("[data-history-result]").filter({ hasText: /^Undid setup: /i }).waitFor();
    await dm.keyboard.press("Escape");
    await history.waitFor({ state: "detached" });
    await until("off again", () => dmSocket.state?.meta.settings.soundDmOnly === undefined);
    await until("Pat's music back", () => patSocket.state?.playing?.music);
    assert.equal(await (await soundPanel()).locator("[data-sound-table]").getByRole("switch", { name: "Only DM devices play" }).getAttribute("aria-checked"), "false");
    await (await patPanel()).locator("[data-sound-player-card]").getByText("Music is playing", { exact: true }).waitFor();
  });

  test("sp-8. the X-card's Stop the sound stops it all", async () => {
    const sent = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
    assert.ok(sent.ok(), `the X-card answered ${sent.status()}`);
    run.xcardAt = Date.now();
    const card = dm.getByRole("dialog", { name: "X-card" });
    await card.waitFor();
    await shots.take(dm, "sp-8-dm-xcard");
    await card.getByRole("button", { name: "Stop the sound", exact: true }).click();
    await until("silence", () => playing() === null || (playing()?.music === null && Object.keys(playing()?.loops ?? {}).length === 0));
    await card.getByRole("button", { name: "Stop the sound", exact: true }).waitFor({ state: "detached" });
    await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  });

  test("sp-10. deleting an effect from its page takes two taps, removes the sound, and its file goes with it", async () => {
    const panel = await soundPanel();
    const effects = panel.getByRole("heading", { name: "Effects", exact: true }).locator("xpath=ancestor::section[1]");
    const assetId = dmSocket.state!.sounds![run.sounds.Thunder!]!.assetId;
    await effects.getByRole("button", { name: "Edit", exact: true }).click();
    await effects.getByRole("button", { name: /^Thunder/ }).click();
    await panel.getByRole("button", { name: "Delete", exact: true }).click();
    await panel.getByText("Delete Thunder? Its file goes too, and it leaves every playlist and scene.", { exact: true }).waitFor();
    assert.ok(dmSocket.state?.sounds?.[run.sounds.Thunder!], "one tap deletes nothing");
    await panel.getByRole("button", { name: "Delete Thunder", exact: true }).click();
    await until("Thunder gone", () => !dmSocket.state?.sounds?.[run.sounds.Thunder!]);
    await panel.getByRole("radiogroup", { name: "Sound", exact: true }).waitFor();
    await waitFor("its file deleted", async () => ((await dmContext.request.get(`${server.origin}/api/assets/${assetId}/full`)).status() === 404 ? true : null), 15_000);
    // The room has no effect of its own left, so Effects offers no Edit, and the board shows the built-ins alone.
    await effects.getByText("No effects added yet.", { exact: true }).waitFor();
    assert.equal(await effects.getByRole("button", { name: /^(Edit|Done)$/ }).count(), 0);
  });

  test("mfa-1. an effect fired behind a blackout keeps Stop all sound and the X-card's Stop the sound while it sounds, and neither once it is over", async () => {
    // sp-8 stopped everything and sp-10 deleted Thunder, so a 12-second Gong (Stop all sound counts an effect from 10 seconds) is the room's one effect, and nothing else plays.
    run.sounds.Gong = await addEntry({ name: "Gong", use: "effect", ms: 12_000 });
    await until("Gong in the DM's copy", () => dmSocket.state?.sounds?.[run.sounds.Gong!]);
    await ops.send({ t: "view.blackout", blackout: true });
    await until("the blackout", () => dmSocket.state?.meta.view.blackout === true);
    try {
      const panel = await soundPanel();
      const stopAll = panel.getByRole("button", { name: "Stop all sound", exact: true });
      assert.equal(await stopAll.count(), 0, "nothing sounds yet");
      await panel.getByRole("button", { name: "Play Gong for everyone", exact: true }).click();
      await until("Gong in the DM's own list", () => playing()?.dmEffects?.some((e) => e.soundId === run.sounds.Gong));
      assert.ok(playing()?.music === null && Object.keys(playing()?.loops ?? {}).length === 0 && playing()?.effects.length === 0, "nothing else");
      await stopAll.waitFor();
      assert.deepEqual(alignmentLines(await measureAlignment(panel), "Now playing with an effect behind a blackout, 1440x900"), []);
      await panel.locator("[data-sound-player]").scrollIntoViewIfNeeded();
      await shots.take(dm, "mfa-1-dm-blackout-effect");
      // Over, it is history: the panel renders again at its end and the button goes.
      await stopAll.waitFor({ state: "detached", timeout: 20_000 });

      // A tap within 10 s of the last card merges into it, so this one waits for its own.
      const wait = run.xcardAt + 10_500 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const sent = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
      assert.ok(sent.ok(), `the X-card answered ${sent.status()}`);
      run.xcardAt = Date.now();
      const card = dm.getByRole("dialog", { name: "X-card" });
      await card.waitFor();
      const stopSound = card.getByRole("button", { name: "Stop the sound", exact: true });
      assert.equal(await stopSound.count(), 0, "nothing sounds");
      await ops.send({ t: "effect.fire", id: "mfa-gong", soundId: run.sounds.Gong! });
      await stopSound.waitFor();
      await shots.take(dm, "mfa-1-dm-xcard-effect");
      await stopSound.click();
      await until("the DM's effect stopped", () => (playing()?.dmEffects ?? []).length === 0);
      await stopSound.waitFor({ state: "detached" });
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
    } finally {
      await ops.send({ t: "view.blackout", blackout: false });
    }
  });

  test("sfx-1. a short effect does not bring up Stop all sound, and the X-card's Stop the sound still shows for it", async () => {
    run.sounds.Chime = await addEntry({ name: "Chime", use: "effect", ms: 3_000 });
    await until("Chime in the DM's copy", () => dmSocket.state?.sounds?.[run.sounds.Chime!]);
    // A tap within 10 s of the last card merges into it, so this one waits for its own.
    const wait = run.xcardAt + 10_500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const panel = await soundPanel();
    const stopAll = panel.getByRole("button", { name: "Stop all sound", exact: true });
    const sent = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
    assert.ok(sent.ok(), `the X-card answered ${sent.status()}`);
    run.xcardAt = Date.now();
    const card = dm.getByRole("dialog", { name: "X-card" });
    await card.waitFor();
    await ops.send({ t: "effect.fire", id: "sfx-chime", soundId: run.sounds.Chime! });
    const stopSound = card.getByRole("button", { name: "Stop the sound", exact: true });
    await stopSound.waitFor();
    assert.equal(await stopAll.count(), 0, "a 3-second effect leaves the player's rows alone");
    // mfa-1 lifted the blackout, so the Chime is in the players' list. An ended effect stays there as history, and only a stop empties it.
    await until("the Chime in the players' list", () => playing()?.effects.some((e) => e.soundId === run.sounds.Chime));
    await stopSound.click();
    await until("every effect stopped", () => (playing()?.effects ?? []).length === 0 && (playing()?.dmEffects ?? []).length === 0);
    await stopSound.waitFor({ state: "detached" });
    await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  });

  test("mfa-2. a failed read of the server's switch says so, never that the server has no sound files, and Try again asks again", async () => {
    const page = await dmContext.newPage();
    try {
      await page.route("**/api/config", (route) => route.abort());
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await openSideTab(page, "Sound");
      const panel = page.getByRole("tabpanel", { name: sideTabName("Sound") });
      await panel.getByText("Couldn't check whether this server offers sound files. The built-in effects still work.", { exact: true }).waitFor();
      assert.equal(await panel.getByText(/doesn't offer sound files/).count(), 0);
      assert.deepEqual(alignmentLines(await measureAlignment(panel), "the switch's failed read, 1440x900"), []);
      await shots.take(page, "mfa-2-dm-switch-failed");
      await page.unroute("**/api/config");
      await panel.getByRole("button", { name: "Try again", exact: true }).click();
      await panel.getByRole("radiogroup", { name: "Sound", exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });

  test("sp-9. with the server's switch off: the one line, Built in and On this device, no view row, and a sound upload refused", async () => {
    process.env.ROOM_SOUND = "0";
    const offAssets = path.join(work, "off-assets");
    const off = await startServer({ port: OFF_PORT, assetDir: offAssets, databaseUrl: DATABASE_URL });
    const context = await browser.newContext({ viewport: DESK });
    const page = await context.newPage();
    const watch = new SocketWatch("off");
    await watch.attach(context, page);
    let roomId = "";
    let socket: OpSocket | null = null;
    try {
      const made = await createRoom(page, context, off.origin, `${run.roomName} off`);
      roomId = made.roomId;
      socket = made.ops;
      const panel = (await openSideTab(page, "Sound"), page.getByRole("tabpanel", { name: sideTabName("Sound") }));
      await panel.getByText("This server doesn't offer sound files. Its owner can turn them on. The built-in effects still work.", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Play Click for everyone", exact: true }).waitFor();
      assert.equal(await panel.getByRole("button", { name: /^Add / }).count(), 0, "no Add buttons");
      assert.equal(await panel.getByRole("radiogroup", { name: "Sound", exact: true }).count(), 0, "nothing can play a file, so no Now playing and no Library");
      assert.equal(await panel.getByRole("searchbox", { name: "Search music" }).count(), 0);
      await shots.take(page, "sp-9-dm-switch-off");
      // Table sound after Effects, with Only DM devices play alone, so a room that kept it can turn it off (docs/design/design-v1-sound-dm-only.md 4).
      const sections = panel.locator("section > h3, section > [data-section-label] > h3");
      assert.deepEqual(await sections.allTextContents(), ["Effects", "Table sound", "On this device"]);
      const table = panel.getByRole("heading", { name: "Table sound", exact: true }).locator("xpath=ancestor::section[1]");
      assert.equal(await table.getByRole("switch").count(), 1, "the one switch");
      const dmOnly = table.getByRole("switch", { name: "Only DM devices play" });
      await dmOnly.click();
      await waitFor("the room keeps it", () => (watch.state?.meta.settings.soundDmOnly === true ? true : null));
      assert.deepEqual(alignmentLines(await measureAlignment(panel), "the switch-off page with Only DM devices play on, 1440x900"), []);
      await table.scrollIntoViewIfNeeded();
      await shots.take(page, "dmb-sp-9-dm-switch-off-dmonly");
      // A built-in fired now stays on the DM's devices.
      await panel.getByRole("button", { name: "Play Click for everyone", exact: true }).click();
      await waitFor("the click in the DM's own list", () => (watch.state?.playing?.dmEffects?.some((e) => e.builtin === "click") ? true : null));
      assert.deepEqual(watch.state?.playing?.effects ?? [], [], "none in the players' list");
      await dmOnly.click();
      await waitFor("off again", () => (watch.state?.meta.settings.soundDmOnly === undefined ? true : null));
      const res = await context.request.put(`${off.origin}/api/rooms/${roomId}/assets?kind=sound`, { headers: { Origin: off.origin, "content-type": "audio/mpeg" }, data: Buffer.from(silentFrames(framesFor(1_000))) });
      assert.equal(res.ok(), false);
      assert.deepEqual(await res.json(), { error: "sound_off" });
    } finally {
      socket?.close();
      if (roomId) await context.request.delete(`${off.origin}/api/rooms/${roomId}`, { headers: { Origin: off.origin }, data: { name: `${run.roomName} off` } }).catch(() => {});
      await context.close();
      await off.stop();
      process.env.ROOM_SOUND = "1";
    }
  });
});
