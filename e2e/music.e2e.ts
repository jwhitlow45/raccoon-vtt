import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { framesFor, silentFrames } from "#shared/audio/mp3Testutil.ts";
import { seekBoundMs, type MusicRun } from "#shared/sound.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * The music player in the Sound panel (docs/design/design-v1-music-player.md
 * 4 to 6 and 11.3, as docs/design/design-v1-sound-layout.md 4 places it), on
 * the real server serving the production build with ROOM_SOUND on, a room
 * of 100 music tracks in four playlists, Tavern night playing at 3 of 12.
 * Sounds are frames of silence (shared/audio/mp3Testutil.ts).
 * - mu-1: Sound's two views at a desk and on a phone: the player, Up next
 *   folded and open, Library, and the idle line's Library link.
 * - mu-2: Up next after Play next, Add to queue and Remove.
 * - mu-3: seek by keys and a drag (Repeat one too), Previous twice within a round trip, Play then Seek, Shuffle on and off.
 * - mu-4: drag and keys in Up next.
 * - mu-5: the maker's pop-up from Library, and the closes that ask first.
 * - mf-1: the maker's Save and Play after another DM's changes.
 * - mu-6: search, sort and Add to playlist.
 * - mu-7: on a phone, drags on the player that move no sheet, and the
 *   maker's tall sheet: a swipe or Put away sheet closes it with no changes
 *   and springs back with them.
 * - mu-8: the maker open across 900 px.
 * - mu-9: every surface measured at four sizes, two scales and two schemes.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-four. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 54;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-music-"));
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let desk: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");

const DESK = { width: 1440, height: 900 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const run = {
  roomId: "",
  roomName: `E2E music ${new Date().toISOString().slice(0, 19)}`,
  dmLink: "",
  music: [] as string[],
  names: [] as string[],
  playlists: {} as Record<string, string>,
  tavern: [] as string[],
};

const PLACES = ["Tavern", "Harbor", "Forest", "Crypt", "Market", "Mountain pass", "Swamp", "Castle", "Desert", "Sewer"];
const MOODS = ["at dusk", "at night", "in the rain", "theme", "chase", "lament", "festival", "watch", "at dawn", "storm"];
const LENGTHS = [95_000, 128_000, 151_000, 174_000, 196_000, 214_000, 238_000, 262_000];

async function createRoom(page: Page, context: BrowserContext): Promise<void> {
  await page.goto(`${server.origin}/`);
  await page.getByLabel("Room name").fill(run.roomName);
  await page.getByLabel("Your name").fill("Dana the DM");
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  run.dmLink = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(run.dmLink);
  assert.ok(match, `DM link looks wrong: ${run.dmLink}`);
  run.roomId = match[1]!.replace("-", "");
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
}

async function upload(ms: number): Promise<string> {
  const res = await desk.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=sound`, { headers: { Origin: server.origin, "content-type": "audio/mpeg" }, data: Buffer.from(silentFrames(framesFor(ms), { kbps: 64 })) });
  assert.ok(res.ok(), `upload answered ${res.status()}`);
  return ((await res.json()) as { id: string }).id;
}

/** 100 tracks on eight files, as the preview's room (13), and four playlists. */
async function seed(): Promise<void> {
  const assets: { id: string; ms: number }[] = [];
  for (const ms of LENGTHS) assets.push({ id: await upload(ms), ms });
  const names = ["The Prancing Pony", "Road to Phandalin", "Night watch"];
  for (const p of PLACES) for (const m of MOODS) if (names.length < 100) names.push(`${p} ${m}`);
  for (let i = 0; i < names.length; i++) {
    const a = assets[(i * 5) % assets.length]!;
    const id = randomUUID();
    await ops.send({ t: "sound.create", id, assetId: a.id, name: names[i]!, use: "music", ms: a.ms });
    run.music.push(id);
  }
  run.names = names;
  const pick = (from: number, n: number) => run.music.slice(from, from + n);
  run.tavern = [run.music[0]!, ...pick(3, 11)];
  for (const [name, sounds] of [
    ["Tavern night", run.tavern],
    ["Battle", pick(30, 8)],
    ["Travel", [run.music[1]!, ...pick(60, 9)]],
    ["Boss themes", pick(90, 4)],
  ] as const) {
    const id = randomUUID();
    await ops.send({ t: "playlist.create", id, name, sounds: [...sounds], repeat: "all", fade: 5 });
    run.playlists[name] = id;
  }
  await waitFor("the library in the DM's copy", () => Object.keys(dmSocket.state?.sounds ?? {}).length === 100 || null);
}

function music(): MusicRun | null {
  return dmSocket.state?.playing?.music ?? null;
}

function idOf(name: string): string {
  const at = run.names.indexOf(name);
  assert.ok(at >= 0, `no track ${name}`);
  return run.music[at]!;
}

function nameOf(id: string): string {
  return run.names[run.music.indexOf(id)]!;
}

/** Tavern night from its third track, as the preview's room plays it. */
async function playTavern(repeat: "all" | "one" | "off" = "all"): Promise<void> {
  const id = randomUUID();
  await ops.send({ t: "music.play", run: id, playlistId: run.playlists["Tavern night"]!, order: run.tavern, index: 2, repeat, fade: 5 });
  // By its run's id, since a step before may have left the same playlist playing.
  await waitFor("Tavern night playing", () => (music()?.run === id ? true : null));
}

/** The DM's Sound panel: the side panel's tab where there is one, else the phone's sheet from the Panels list. */
async function soundPanel(page: Page = dm): Promise<Locator> {
  if (await page.getByRole("tablist", { name: "Panels" }).isVisible()) {
    await openSideTab(page, "Sound");
    return page.getByRole("tabpanel", { name: sideTabName("Sound") });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Sound"]');
  if (await sheet.isVisible()) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Sound/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** Sound's view row, a radio group named Sound (docs/design/design-v1-sound-layout.md 4.1), and its option by name. */
function view(panel: Locator, name: "Now playing" | "Library"): Locator {
  return panel.getByRole("radiogroup", { name: "Sound", exact: true }).getByRole("radio", { name, exact: true });
}

async function showView(panel: Locator, name: "Now playing" | "Library"): Promise<void> {
  if (!(await view(panel, name).isChecked())) await view(panel, name).click();
  if (name === "Library") await panel.getByRole("searchbox", { name: "Search music" }).waitFor();
  else await panel.locator("[data-sound-player]").waitFor();
}

/** Sound on Now playing, the player and Up next. */
async function nowPlaying(page: Page = dm): Promise<Locator> {
  const panel = await soundPanel(page);
  await showView(panel, "Now playing");
  return panel;
}

/** Sound on Library. */
async function libraryView(page: Page = dm): Promise<Locator> {
  const panel = await soundPanel(page);
  await showView(panel, "Library");
  return panel;
}

/** Up next opened as the DM's tap does where it is folded (4.3), which this device then keeps. */
async function openUpNext(panel: Locator): Promise<void> {
  const fold = panel.getByRole("button", { name: "Up next", exact: true });
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await panel.locator("[data-music-upnext]").waitFor();
}

/** The playlist maker's pop-up, by its title: the playlist's name, or New playlist (4.5). */
function maker(name: string, page: Page = dm): Locator {
  return page.getByRole("dialog", { name, exact: true }).filter({ has: page.locator("[data-music-maker]") });
}

/** Whichever maker is open, whatever its title says now. */
function openMaker(page: Page = dm): Locator {
  return page.locator("dialog[open]").filter({ has: page.locator("[data-music-maker]") });
}

/** Closes the maker if it is open, discarding its changes on the second press. */
async function closeMaker(page: Page = dm): Promise<void> {
  const win = openMaker(page);
  if ((await win.count()) === 0) return;
  await win.getByRole("button", { name: /^Close/ }).last().click();
  const asked = await win.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor({ timeout: 1_000 }).then(() => true, () => false);
  if (asked) await win.getByRole("button", { name: /^Close/ }).last().click();
  await win.waitFor({ state: "detached" });
}

/** A playlist's row in Library, which opens the maker on it. */
async function editPlaylist(panel: Locator, name: string): Promise<Locator> {
  await panel.getByRole("list", { name: "Playlists" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const win = maker(name, panel.page());
  await win.waitFor();
  return win;
}

/** The ops this page sent since `from`, by type. */
function sentOps(from: number, type: string): Record<string, unknown>[] {
  return dmSocket.sent.slice(from).flatMap((f) => {
    try {
      const m = JSON.parse(f) as { t: string; op?: Record<string, unknown> };
      return m.t === "op" && m.op?.t === type ? [m.op] : [];
    } catch {
      return [];
    }
  });
}

/** The Up next rows' names, in order, from the panel. */
async function upNextNames(panel: Locator): Promise<string[]> {
  return panel.getByRole("list", { name: "Up next" }).locator("[data-music-order-row] [data-music-row-name]").allTextContents();
}

async function setScheme(page: Page, scheme: "dark" | "light", scale = 1): Promise<void> {
  await page.evaluate(([s, sc]) => {
    localStorage.setItem("rvtt.theme", s as string);
    localStorage.setItem("rvtt.uiScale", String(sc));
  }, [scheme, scale] as const);
}

/** What has focus in the page: its tag, its name, and the maker's opener mark it carries (music/open.ts MAKER_OPENER). */
function focused(page: Page = dm): Promise<{ tag: string; label: string | null; opener: string | null }> {
  return page.evaluate(() => {
    type El = { tagName: string; getAttribute(n: string): string | null };
    const el = (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement;
    return { tag: el?.tagName ?? "", label: el?.getAttribute("aria-label") ?? null, opener: el?.getAttribute("data-maker-opener") ?? null };
  });
}

/** What is out of line under `root`, at its scroll's top and with each of its scrollers at its end, so rows below the fold are measured too. */
async function outOfLine(root: Locator, what: string): Promise<string[]> {
  const top = alignmentLines(await measureAlignment(root), what);
  const scrolled = await root.evaluate((el) => {
    type El = { scrollTop: number; scrollHeight: number; clientHeight: number };
    const g = globalThis as unknown as { getComputedStyle(e: unknown): { overflowY: string } };
    let any = false;
    for (const s of [el, ...el.querySelectorAll("*")] as unknown as El[]) {
      if (s.scrollHeight <= s.clientHeight + 1 || !["auto", "scroll"].includes(g.getComputedStyle(s).overflowY)) continue;
      s.scrollTop = s.scrollHeight;
      any = true;
    }
    return any;
  });
  if (!scrolled) return top;
  return [...top, ...alignmentLines(await measureAlignment(root), `${what}, scrolled to its end`)];
}

/**
 * Under 300 px a Library row drops its tile and wraps its title and detail
 * (docs/design/design-v1-music-player.md 4.4), so rows whose names wrap to
 * different line counts differ in height. The sweep's same-kind rule groups
 * rows by their lines of words, but a row's words are inside its button,
 * which it measures as one box, so it compares a one-line row with a
 * two-line one. Those findings alone are left out where the rows have no
 * tiles, and mu-9 measures each such row on its own.
 */
function wrappedRows(line: string, tiles: boolean): boolean {
  return !tiles && /: kind-height [\d.]+ px, ul "(Playlists|Tracks)": li /.test(line);
}

/** The DM's page loaded afresh, so a step that failed leaves no maker open for the next. */
async function fresh(): Promise<void> {
  await dm.setViewportSize(DESK);
  await reload(dm);
}

async function reload(page: Page): Promise<void> {
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
}

describe("the music player in the Sound panel", { concurrency: false }, () => {
  before(async () => {
    process.env.ROOM_SOUND = "1";
    server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1", args: ["--autoplay-policy=no-user-gesture-required"] });
    desk = await browser.newContext({ viewport: DESK });
    dm = await desk.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(desk, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(`[dm] errors`, dmConsole.errors, server?.output().split("\n").slice(-40).join("\n"));
    ops?.close();
    if (run.roomId && desk) await desk.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } }).catch(() => {});
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("mu-0. a DM's room with 100 tracks in four playlists, Tavern night at 3 of 12", async () => {
    await createRoom(dm, desk);
    await seed();
    await playTavern();
  });

  test("mu-1. Sound's two views: at a desk the player whole with Stop the music and Repeat, Up next folded with the next track and open with this pass, Library a tap away, the same on a phone, and the idle line's Library link with nothing playing", async () => {
    await dm.evaluate(() => localStorage.removeItem("rvtt.soundFolds"));
    await reload(dm);
    let panel = await soundPanel();
    assert.equal(await view(panel, "Now playing").isChecked(), true, "Sound opens on Now playing");
    const player = panel.locator("[data-sound-player]");
    await player.locator("[data-music-track]").filter({ hasText: nameOf(run.tavern[2]!) }).waitFor();
    await player.locator("[data-music-run]").filter({ hasText: /^Tavern night · 3 of 12$/ }).waitFor();
    // The player J kept, whole in the panel, with Stop all sound on its own row (docs/design/design-v1-sound-layout.md 4.2).
    for (const name of ["Shuffle", "Previous", "Pause", "Skip to the next track", "Repeat all", "Stop the music", "Stop all sound"]) await player.getByRole("button", { name, exact: true }).waitFor();
    await player.locator("[data-music-stop-all]").getByRole("button", { name: "Stop all sound", exact: true }).waitFor();
    const fold = panel.getByRole("button", { name: "Up next", exact: true });
    assert.equal(await fold.getAttribute("aria-expanded"), "false", "Up next folded with nothing stored");
    await panel.locator("[data-music-upnext-summary]").filter({ hasText: `Next: ${nameOf(run.tavern[3]!)}` }).waitFor();
    await shots.take(dm, "mu-1-panel-desk");

    await openUpNext(panel);
    assert.deepEqual(await upNextNames(panel), run.tavern.slice(3).map(nameOf), "Up next: the rest of this pass");
    await panel.locator("[data-music-upnext-summary]").filter({ hasText: /^9 tracks · \d+ min$/ }).waitFor();
    await panel.getByText("Then Tavern night plays again from the top:", { exact: true }).waitFor();
    await panel.getByRole("button", { name: `Move ${nameOf(run.tavern[3]!)}, 1 of 11`, exact: true }).waitFor();
    await panel.getByRole("button", { name: `Move ${nameOf(run.tavern[0]!)}, 10 of 11`, exact: true }).waitFor();
    await shots.take(dm, "mu-1-upnext-desk");

    // Library, one tap from the panel's top: search and sort, the playlists, the tracks.
    await showView(panel, "Library");
    await panel.locator("[data-music-sort]").waitFor();
    await panel.getByRole("list", { name: "Playlists" }).getByRole("button", { name: /^Tavern night/ }).waitFor();
    await panel.getByRole("heading", { name: /^Tracks/ }).filter({ hasText: "100" }).waitFor();
    assert.equal(await panel.locator("[data-music-row]").count(), 104, "four playlists and 100 tracks");
    await shots.take(dm, "mu-1-library-desk");
    await showView(panel, "Now playing");

    // A phone: the same two views in Sound's sheet.
    const phoneContext = await browser.newContext(PHONE);
    try {
      const phone = await phoneContext.newPage();
      await phone.goto(run.dmLink);
      await phone.getByRole("button", { name: /Dana the DM/ }).click();
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();
      let sheet = await soundPanel(phone);
      assert.equal(await view(sheet, "Now playing").isChecked(), true);
      await sheet.locator("[data-sound-player]").getByRole("button", { name: "Pause", exact: true }).waitFor();
      await shots.take(phone, "mu-1-phone-now");
      await showView(sheet, "Library");
      await shots.take(phone, "mu-1-phone-library");
      await sheet.getByRole("button", { name: /^Close / }).first().click();
      await sheet.waitFor({ state: "detached" });

      // Nothing playing: the idle line names Library as a link, which moves the view there and focus to its search.
      await ops.send({ t: "music.stop" });
      await waitFor("the music stopped", () => (music() === null ? true : null));
      sheet = await soundPanel(phone);
      const idle = sheet.locator("[data-music-idle]");
      await idle.getByText(/^No music is playing\. Pick a playlist or a track in Library\.$/).waitFor();
      await idle.getByRole("button", { name: "Library", exact: true }).click();
      const search = sheet.getByRole("searchbox", { name: "Search music" });
      await waitFor("focus on Library's search", () => search.evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)), 5_000);
      assert.equal(await view(sheet, "Library").isChecked(), true);
    } finally {
      await phoneContext.close();
      await playTavern();
    }
    panel = await nowPlaying();
    await panel.locator("[data-music-upnext]").waitFor();
  });

  test("mu-2. Up next after Play next, Add to queue and Remove, each one music.queue on the run it was made on", async () => {
    await fresh();
    await playTavern();
    const r = music()!.run;
    const panel = await libraryView();
    const tracks = panel.getByRole("list", { name: "Tracks" });
    const search = panel.getByRole("searchbox", { name: "Search music" });
    const ahead = run.tavern.slice(3).map(nameOf);
    /** Up next's rows, on Now playing, then Library again with its search kept. */
    const upNext = async (what: string, ok: (names: string[]) => boolean) => {
      await showView(panel, "Now playing");
      await openUpNext(panel);
      await waitFor(what, async () => (ok(await upNextNames(panel)) ? true : null), 3_000);
      await showView(panel, "Library");
    };

    // Play next: a track from Battle goes first in Up next.
    const battle = run.music[30]!;
    await search.fill(nameOf(battle));
    let from = dmSocket.sent.length;
    await tracks.getByRole("button", { name: `More for ${nameOf(battle)}`, exact: true }).click();
    await dm.getByRole("menuitem", { name: /^Play next/ }).click();
    assert.deepEqual(sentOps(from, "music.queue"), [{ t: "music.queue", from: r, edit: { t: "next", soundIds: [battle] } }]);
    await upNext("Play next's row first", (names) => names[0] === nameOf(battle));
    assert.equal(await search.inputValue(), nameOf(battle), "the search kept across the views");

    // Add to queue: the end of this pass, before Tavern night plays again from the top.
    const travel = run.music[61]!;
    await search.fill(nameOf(travel));
    from = dmSocket.sent.length;
    await tracks.getByRole("button", { name: `More for ${nameOf(travel)}`, exact: true }).click();
    await dm.getByRole("menuitem", { name: /^Add to queue/ }).click();
    assert.deepEqual(sentOps(from, "music.queue"), [{ t: "music.queue", from: r, edit: { t: "add", soundIds: [travel] } }]);
    await upNext("Add to queue's row last", (names) => names.at(-1) === nameOf(travel));
    await search.fill("");

    // Remove, from the row's own More in Up next.
    await showView(panel, "Now playing");
    const gone = run.tavern[4]!;
    from = dmSocket.sent.length;
    await panel.getByRole("list", { name: "Up next" }).getByRole("button", { name: `More for ${nameOf(gone)}`, exact: true }).click();
    await dm.getByRole("menuitem", { name: "Remove from queue", exact: true }).click();
    const expected = [nameOf(battle), ...ahead.filter((n) => n !== nameOf(gone)), nameOf(travel)];
    await waitFor("the row removed", async () => (JSON.stringify(await upNextNames(panel)) === JSON.stringify(expected) ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue"), [{ t: "music.queue", from: r, edit: { t: "remove", soundId: gone } }]);
    // The room agrees with what the panel showed at once.
    await waitFor("the room's order", () => {
      const m = music();
      const at = m?.order?.indexOf(m.now.soundId) ?? -1;
      return m && JSON.stringify(m.order!.slice(at + 1).map(nameOf)) === JSON.stringify(expected) ? true : null;
    });
    await panel.getByText("Then Tavern night plays again from the top:", { exact: true }).waitFor();
    await shots.take(dm, "mu-2-up-next");
  });

  test("mu-3. a seek by keys, a drag that seeks once at its release, one that seeks nothing once another DM starts another track, held short of the end under Repeat one, Previous twice within a round trip, Play then Seek before Play's answer, and Shuffle on and off", async () => {
    await fresh();
    await playTavern();
    let panel = await nowPlaying();
    const slider = panel.getByRole("slider", { name: "Seek" });
    const playing = music()!.now.soundId;

    // Keys: five steps of a second, sent once, 400 ms after the last.
    let from = dmSocket.sent.length;
    await slider.focus();
    for (let i = 0; i < 5; i++) await dm.keyboard.press("ArrowRight");
    await waitFor("one seek", () => (sentOps(from, "music.jump").length === 1 ? true : null), 3_000);
    await sleep(600);
    const [seek] = sentOps(from, "music.jump");
    assert.equal(sentOps(from, "music.jump").length, 1, "one music.jump for five keys");
    assert.equal(seek!.on, playing, "on the track it was made on");
    assert.equal(seek!.soundId, playing);
    assert.ok((seek!.ms as number) >= 5_000 && (seek!.ms as number) <= 9_000, `five seconds in: ${seek!.ms}`);
    await waitFor("the room at the seek", () => {
      const m = music();
      return m && m.now.soundId === playing && Math.abs(Date.now() - m.now.at - (seek!.ms as number)) < 2_000 ? true : null;
    });

    // A mouse drag along the slider, begun within 400 ms of a key and held long past it: no seek while the pointer is down, then one at its release, though it lets go off the slider.
    from = dmSocket.sent.length;
    const track = (await slider.boundingBox())!;
    const y = track.y + track.height / 2;
    await slider.focus();
    await dm.keyboard.press("ArrowRight");
    await dm.mouse.move(track.x + track.width * 0.2, y);
    await dm.mouse.down();
    for (let i = 1; i <= 10; i++) await dm.mouse.move(track.x + track.width * (0.2 + 0.03 * i), y);
    await sleep(1_000);
    assert.equal(sentOps(from, "music.jump").length, 0, "nothing while the pointer is down, the key's 400 ms long past");
    await dm.mouse.move(track.x + track.width * 0.5, y + 120);
    await dm.mouse.up();
    await waitFor("the release's seek", () => (sentOps(from, "music.jump").length > 0 ? true : null), 3_000);
    await sleep(800);
    const released = sentOps(from, "music.jump");
    assert.equal(released.length, 1, "one music.jump, at the release");
    assert.equal(released[0]!.soundId, playing);
    const lengthAt = dmSocket.state!.sounds![playing]!.ms;
    assert.ok(Math.abs((released[0]!.ms as number) - lengthAt / 2) < lengthAt * 0.1, `halfway, where it let go: ${released[0]!.ms} of ${lengthAt}`);

    // A drag begun on this track as another DM starts the next: the rest of the press seeks nothing, its release included (MB-SOL-01).
    const other = run.tavern[3]!;
    from = dmSocket.sent.length;
    await dm.mouse.move(track.x + track.width * 0.2, y);
    await dm.mouse.down();
    for (let i = 1; i <= 4; i++) await dm.mouse.move(track.x + track.width * (0.2 + 0.03 * i), y);
    await ops.send({ t: "music.jump", run: randomUUID(), from: music()!.run, soundId: other, ms: 0, on: playing });
    await panel.locator("[data-music-track]").filter({ hasText: nameOf(other) }).waitFor();
    for (let i = 5; i <= 10; i++) await dm.mouse.move(track.x + track.width * (0.2 + 0.03 * i), y);
    await dm.mouse.up();
    await sleep(800);
    assert.equal(sentOps(from, "music.jump").length, 0, "no seek on the track another DM started");
    assert.equal(music()!.now.soundId, other);
    await ops.send({ t: "music.jump", run: randomUUID(), from: music()!.run, soundId: playing, ms: 0, on: other });
    await waitFor("back on the track the steps below seek", () => (music()?.now.soundId === playing ? true : null));

    // Repeat one: End is held a second short of the end, less the crossfade.
    await panel.getByRole("button", { name: "Repeat all", exact: true }).click();
    await waitFor("Repeat one", () => (music()?.repeat === "one" ? true : null));
    const lengthMs = dmSocket.state!.sounds![playing]!.ms;
    const bound = seekBoundMs(music()!, lengthMs);
    assert.equal(bound, lengthMs - 5_000, "Repeat one's bound is the track less its 5 s crossfade");
    from = dmSocket.sent.length;
    await slider.focus();
    await dm.keyboard.press("End");
    await waitFor("the held seek", () => (sentOps(from, "music.jump").length === 1 ? true : null), 3_000);
    assert.equal(sentOps(from, "music.jump")[0]!.ms, bound - 1_000, "held to the bound less 1 s");
    await ops.send({ t: "music.set", repeat: "all" });
    await waitFor("Repeat all", () => (music()?.repeat === "all" ? true : null));

    // A page whose frames come 1.5 s late: its presses act on its own view of the ops before theirs.
    const slow = await desk.newPage();
    try {
      await slow.routeWebSocket(/\/ws\?room=/, (ws) => {
        const upstream = ws.connectToServer();
        ws.onMessage((m) => upstream.send(m));
        upstream.onMessage((m) => setTimeout(() => ws.send(m), 1_500));
      });
      await playTavern();
      const third = run.tavern[2]!;
      await ops.send({ t: "music.jump", run: randomUUID(), from: music()!.run, soundId: third, ms: 40_000, on: third });
      await waitFor("40 s into track 3", () => (music() && Date.now() - music()!.now.at > 39_000 ? true : null));
      await reload(slow);
      panel = await nowPlaying(slow);
      await panel.locator("[data-music-now]").filter({ hasText: nameOf(third) }).waitFor();
      // Previous twice within a round trip: the first restarts track 3, the second goes to track 2, and nothing is refused.
      await panel.getByRole("button", { name: "Previous", exact: true }).click();
      await panel.getByRole("button", { name: "Previous", exact: true }).click();
      await waitFor("track 2 from its start", () => (music()?.now.soundId === run.tavern[1] && Date.now() - music()!.now.at < 5_000 ? true : null), 6_000);
      await sleep(2_000);
      assert.equal(music()?.now.soundId, run.tavern[1], "still track 2 once both answers are in");
      assert.equal(await slow.getByText(/Try again\./).count(), 0, "no refusal");

      // Play, then Seek before the Play is answered: the seek applies to the new run. Library and the player are one tap apart, the switch the page's own.
      const boss = run.music[91]!;
      await showView(panel, "Library");
      await panel.getByRole("searchbox", { name: "Search music" }).fill(nameOf(boss));
      await panel.getByRole("list", { name: "Tracks" }).getByRole("button", { name: `Play ${nameOf(boss)}`, exact: true }).click();
      await showView(panel, "Now playing");
      const seekNow = panel.getByRole("slider", { name: "Seek" });
      await seekNow.focus();
      for (let i = 0; i < 10; i++) await slow.keyboard.press("ArrowRight");
      await waitFor("the boss track ten seconds in", () => {
        const m = music();
        return m && m.now.soundId === boss && Date.now() - m.now.at > 8_000 ? true : null;
      }, 8_000);
      await sleep(2_000);
      assert.equal(await slow.getByText(/Try again\./).count(), 0, "no refusal");
    } finally {
      await slow.close();
    }

    // Shuffle on mixes every other track and keeps 3 of 12. Off puts the playlist's order back.
    await playTavern();
    panel = await nowPlaying();
    await panel.getByRole("button", { name: "Shuffle", exact: true }).click();
    const mixed = await waitFor("shuffled", () => (music()?.shuffle === true ? music() : null));
    assert.deepEqual([...mixed.order!].sort(), [...run.tavern].sort(), "the same tracks");
    assert.equal(mixed.order!.indexOf(mixed.now.soundId), 2, "still 3 of 12");
    assert.notDeepEqual(mixed.order, run.tavern, "mixed");
    await panel.locator("[data-music-now]").filter({ hasText: "Tavern night · 3 of 12" }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Shuffle", exact: true }).getAttribute("aria-pressed"), "true");
    await shots.take(dm, "mu-3-shuffled");
    await panel.getByRole("button", { name: "Shuffle", exact: true }).click();
    await waitFor("in the playlist's order", () => (music()?.shuffle === undefined && JSON.stringify(music()?.order) === JSON.stringify(run.tavern) ? true : null));
  });

  test("mu-4. Up next's keys and drags: a step, the ends, Up past the seam, a drop at the seam, taps that drop nothing and a short drag that does, a drag that outlives a volume change, one that ends as a crossfade starts, and drops past the last row at 1 of 12 and under Repeat off", async () => {
    await fresh();
    await playTavern();
    const panel = await nowPlaying();
    await openUpNext(panel);
    const lines = () => upNextNames(panel);
    const handle = (id: string, place: number) => panel.getByRole("button", { name: `Move ${nameOf(id)}, ${place} of 11`, exact: true });
    const t = run.tavern;

    // Down one place, then End and Home, focus kept on the handle and each move said.
    let from = dmSocket.sent.length;
    await handle(t[3]!, 1).focus();
    await dm.keyboard.press("ArrowDown");
    await handle(t[3]!, 2).waitFor();
    assert.deepEqual((await lines()).slice(0, 2), [nameOf(t[4]!), nameOf(t[3]!)]);
    assert.equal((await focused()).label, `Move ${nameOf(t[3]!)}, 2 of 11`, "focus stays on the handle");
    await panel.getByRole("status").filter({ hasText: `${nameOf(t[3]!)} is now 2 of 11.` }).waitFor();
    await dm.keyboard.press("End");
    await handle(t[3]!, 11).waitFor();
    await dm.keyboard.press("Home");
    await handle(t[3]!, 1).waitFor();
    assert.deepEqual(
      sentOps(from, "music.queue").map((o) => (o.edit as { to: unknown }).to),
      [{ before: t[5] }, "last", "first"],
      "Down names the row it lands before, End and Home the ends",
    );
    await waitFor("the room's order", () => (JSON.stringify(music()?.order) === JSON.stringify(run.tavern) ? true : null));

    // Up from the second list's first row steps past the seam, into Up next before its last row. The track before the playing one moved after it: 2 of 12.
    from = dmSocket.sent.length;
    await handle(t[0]!, 10).scrollIntoViewIfNeeded();
    await handle(t[0]!, 10).focus();
    await dm.keyboard.press("ArrowUp");
    await handle(t[0]!, 9).waitFor();
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[0], to: { before: t[11] } }]);
    assert.deepEqual((await lines()).slice(-2), [nameOf(t[0]!), nameOf(t[11]!)]);
    await panel.locator("[data-music-now]").filter({ hasText: "Tavern night · 2 of 12" }).waitFor();

    // A drag to the seam, the slot after Up next's last row, sends passEnd: the order's end, under Up next.
    const drag = async (id: string, place: number, to: () => Promise<number>, during?: () => Promise<void>) => {
      const grip = handle(id, place);
      await grip.scrollIntoViewIfNeeded();
      const box = (await grip.boundingBox())!;
      const x = box.x + box.width / 2;
      const y0 = box.y + box.height / 2;
      await dm.mouse.move(x, y0);
      await dm.mouse.down();
      await dm.mouse.move(x, y0 + 8);
      if (during) await during();
      const y1 = await to();
      for (let i = 1; i <= 10; i++) await dm.mouse.move(x, y0 + 8 + ((y1 - y0 - 8) * i) / 10);
      await dm.mouse.up();
    };
    const midOf = async (l: Locator) => {
      const b = (await l.boundingBox())!;
      return b.y + b.height / 2;
    };
    // Up next is now t3 to t10, t0 and t11 (places 1 to 10), then t1 (11).
    from = dmSocket.sent.length;
    const seam = async () => ((await midOf(handle(t[11]!, 10))) + (await midOf(handle(t[1]!, 11)))) / 2;
    await drag(t[9]!, 7, seam);
    await waitFor("t9 at Up next's end", async () => ((await lines()).at(-1) === nameOf(t[9]!) ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[9], to: "passEnd" }]);
    await panel.locator("[data-music-now]").filter({ hasText: "Tavern night · 2 of 12" }).waitFor();

    // A tap on a handle, with a finger's jitter under 4 px, drops nothing in either list, though t1, the second list's first row, stands at the seam, where a drop sends passEnd.
    const press = async (grip: Locator, dy: number) => {
      await grip.scrollIntoViewIfNeeded();
      const box = (await grip.boundingBox())!;
      const x = box.x + box.width / 2;
      const y0 = box.y + box.height / 2;
      await dm.mouse.move(x, y0);
      await dm.mouse.down();
      for (let i = 1; i <= 4; i++) await dm.mouse.move(x + 1, y0 + (dy * i) / 4);
      await dm.mouse.up();
    };
    const order = await waitFor("the room holds t9's drop", () => (music()?.order?.at(-1) === t[9] ? music()!.order : null));
    from = dmSocket.sent.length;
    await press(handle(t[1]!, 11), 3);
    await press(handle(t[1]!, 11), -3);
    await press(handle(t[3]!, 1), 3);
    await sleep(600);
    await shots.take(dm, "mu-4-tap");
    assert.equal(sentOps(from, "music.queue").length, 0, "a tap sends nothing");
    assert.deepEqual(music()!.order, order);
    await panel.locator("[data-music-now]").filter({ hasText: "Tavern night · 2 of 12" }).waitFor();
    // Past a tap, a short drag of t1 that stays at its slot drops it at the seam: Up next's end, 2 of 12 becoming 1 of 12.
    await press(handle(t[1]!, 11), -8);
    await waitFor("t1 at Up next's end", async () => ((await lines()).at(-1) === nameOf(t[1]!) ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[1], to: "passEnd" }]);
    await panel.locator("[data-music-now]").filter({ hasText: "Tavern night · 1 of 12" }).waitFor();

    // A volume changed by another DM mid-drag changes nothing the drag holds on to: it drops.
    from = dmSocket.sent.length;
    const top = async () => (await midOf(handle(t[3]!, 1))) - 10;
    await drag(t[5]!, 3, top, async () => {
      await ops.send({ t: "sound.mix", music: 60 });
      await waitFor("the volume", () => (dmSocket.state?.playing?.volume.music === 60 ? true : null));
    });
    await waitFor("the drop", () => (sentOps(from, "music.queue").length === 1 ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[5], to: "first" }]);

    // A crossfade that starts mid-drag ends the drag with nothing sent, though no frame marks it.
    const now = music()!;
    const lengthMs = dmSocket.state!.sounds![now.now.soundId]!.ms;
    await ops.send({ t: "music.jump", run: randomUUID(), from: now.run, soundId: now.now.soundId, ms: lengthMs - 5_000 - 3_000, on: now.now.soundId });
    const next = await waitFor("the next revealed", () => music()?.next ?? null);
    const before = await lines();
    from = dmSocket.sent.length;
    const first = before[0]!;
    await drag(idOf(first), 1, async () => (await midOf(panel.getByRole("list", { name: "Up next" }).locator("[data-music-order-row]").nth(3))) + 10, async () => {
      await sleep(Math.max(0, next.at - Date.now()) + 600);
    });
    await sleep(800);
    assert.equal(sentOps(from, "music.queue").length, 0, "nothing sent: the crossfade ended the drag");
    await panel.locator("[data-music-now]").filter({ hasText: nameOf(next.soundId) }).waitFor();

    // A drag past the last row takes the last place. At 1 of 12 the second list is empty, so that place is the seam, the order's end, and Now playing still reads 1 of 12.
    const rows = panel.getByRole("list", { name: "Up next" }).locator("[data-music-order-row]");
    const pastEnd = async () => (await midOf(rows.last())) + 80;
    const dragFrom = async (grip: Locator) => {
      await grip.evaluate((el) => el.scrollIntoView({ block: "start" }));
      const box = (await grip.boundingBox())!;
      const x = box.x + box.width / 2;
      const y0 = box.y + box.height / 2;
      await dm.mouse.move(x, y0);
      await dm.mouse.down();
      await dm.mouse.move(x, y0 + 8);
      const y1 = await pastEnd();
      assert.ok(y1 < DESK.height, `the last row in sight: ${y1}`);
      for (let i = 1; i <= 10; i++) await dm.mouse.move(x, y0 + 8 + ((y1 - y0 - 8) * i) / 10);
      await dm.mouse.up();
    };
    const fromTop = randomUUID();
    await ops.send({ t: "music.play", run: fromTop, playlistId: run.playlists["Tavern night"]!, order: run.tavern, index: 0, repeat: "all", fade: 5 });
    await waitFor("Tavern night from its first track", () => (music()?.run === fromTop ? true : null));
    await panel.locator("[data-music-now]").filter({ hasText: "Tavern night · 1 of 12" }).waitFor();
    from = dmSocket.sent.length;
    await dragFrom(handle(t[1]!, 1));
    await waitFor("the drop", () => (sentOps(from, "music.queue").length === 1 ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[1], to: "passEnd" }]);
    await waitFor("t1 at Up next's end", async () => ((await lines()).at(-1) === nameOf(t[1]!) ? true : null), 3_000);
    await panel.locator("[data-music-now]").filter({ hasText: "Tavern night · 1 of 12" }).waitFor();

    // Under Repeat off, to the bottom of Up next: the order's end.
    await playTavern("off");
    from = dmSocket.sent.length;
    await dragFrom(panel.getByRole("button", { name: `Move ${nameOf(t[3]!)}, 1 of 9`, exact: true }));
    await waitFor("the drop", () => (sentOps(from, "music.queue").length === 1 ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[3], to: "last" }]);
    await waitFor("t3 at Up next's end", async () => ((await lines()).at(-1) === nameOf(t[3]!) ? true : null), 3_000);
    await playTavern();
  });

  test("mu-5. the maker's pop-up from Library: ten tracks by search, drags up and past the last row, keys, a tap that moves nothing, one Create, a rename that Saves its name alone, and Cancel, the close button, Escape and Back with changes asking first", async () => {
    await fresh();
    const panel = await libraryView();
    const newPlaylist = panel.getByRole("button", { name: "New playlist", exact: true });
    await newPlaylist.click();
    let win = maker("New playlist");
    await win.waitFor();
    assert.equal(await win.getByRole("button", { name: /^Back to / }).count(), 0, "a pop-up of its own, with no back button");
    const name = win.getByRole("textbox", { name: "Name" });
    assert.equal(await name.getAttribute("placeholder"), "Tavern night");
    await name.fill("Harbor nights");
    const search = win.getByRole("searchbox", { name: "Search music" });
    await search.fill("harbor");
    const harbor = run.names.filter((n) => n.startsWith("Harbor"));
    assert.equal(harbor.length, 10);
    for (const n of harbor) await win.getByRole("button", { name: `Add ${n}`, exact: true }).click();
    const order = win.getByRole("list", { name: "Tracks in order" });
    const shown = () => order.locator("[data-music-row-name]").allTextContents();
    assert.deepEqual(await shown(), harbor, "added in the order picked");
    await win.getByText("No track matches \"harbor\".", { exact: true }).waitFor();
    await shots.take(dm, "mu-5-maker-new");

    // A drag by the handle: the fifth row to the top. Then keys: End sends the new first row to the end, Up steps one back.
    const handle = (n: string, place: number) => order.getByRole("button", { name: `Move ${n}, ${place} of 10`, exact: true });
    await handle(harbor[0]!, 1).scrollIntoViewIfNeeded();
    const from = await handle(harbor[4]!, 5).boundingBox();
    const to = await handle(harbor[0]!, 1).boundingBox();
    assert.ok(from && to);
    const x = from.x + from.width / 2;
    await dm.mouse.move(x, from.y + from.height / 2);
    await dm.mouse.down();
    for (let i = 1; i <= 12; i++) await dm.mouse.move(x, from.y + from.height / 2 - ((from.y - to.y + 12) * i) / 12);
    await shots.take(dm, "mu-5-maker-drag");
    await dm.mouse.up();
    const dragged = [harbor[4]!, ...harbor.slice(0, 4), ...harbor.slice(5)];
    await waitFor("the drag's order", async () => (JSON.stringify(await shown()) === JSON.stringify(dragged) ? true : null), 3_000);
    await handle(harbor[4]!, 1).focus();
    await dm.keyboard.press("End");
    const ended = [...harbor.slice(0, 4), ...harbor.slice(5), harbor[4]!];
    await waitFor("End's order", async () => (JSON.stringify(await shown()) === JSON.stringify(ended) ? true : null), 3_000);
    assert.equal((await focused()).label, `Move ${harbor[4]}, 10 of 10`, "focus stays on the handle");
    await dm.keyboard.press("ArrowUp");
    const stepped = [...harbor.slice(0, 4), ...harbor.slice(5, 9), harbor[4]!, harbor[9]!];
    await win.getByRole("status").filter({ hasText: `${harbor[4]} is now 9 of 10.` }).waitFor();
    await order.getByRole("button", { name: `Remove ${harbor[9]}`, exact: true }).click();
    const left = stepped.slice(0, 9);
    assert.deepEqual(await shown(), left);

    // A tap on a handle, with a finger's jitter under 4 px, leaves the draft as it is.
    const tapped = (await order.getByRole("button", { name: `Move ${left[4]}, 5 of 9`, exact: true }).boundingBox())!;
    await dm.mouse.move(tapped.x + tapped.width / 2, tapped.y + tapped.height / 2);
    await dm.mouse.down();
    await dm.mouse.move(tapped.x + tapped.width / 2 + 1, tapped.y + tapped.height / 2 + 3);
    await dm.mouse.up();
    await sleep(300);
    assert.deepEqual(await shown(), left, "a tap moves no row");

    // A drag of the first row past the last takes the last place.
    const top = order.getByRole("button", { name: `Move ${left[0]}, 1 of 9`, exact: true });
    await top.evaluate((el) => el.scrollIntoView({ block: "start" }));
    const grip = (await top.boundingBox())!;
    const bottom = (await order.locator("li").last().boundingBox())!;
    const past = bottom.y + bottom.height + 60;
    assert.ok(past < DESK.height, `the last row in sight: ${past}`);
    await dm.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await dm.mouse.down();
    for (let i = 1; i <= 12; i++) await dm.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + ((past - grip.y - grip.height / 2) * i) / 12);
    await dm.mouse.up();
    const kept = [...left.slice(1), left[0]!];
    await waitFor("the drag's order", async () => (JSON.stringify(await shown()) === JSON.stringify(kept) ? true : null), 3_000);

    // One Create, one Setup op, then the pop-up closes, focus back on New playlist, with the playlist in Library.
    const before = dmSocket.sent.length;
    await win.locator("footer").getByRole("button", { name: "Create playlist", exact: true }).click();
    await win.waitFor({ state: "detached" });
    await waitFor("focus back on New playlist", async () => ((await focused()).opener === "new" ? true : null), 3_000);
    const created = sentOps(before, "playlist.create");
    assert.equal(created.length, 1, "one playlist.create");
    assert.equal(created[0]!.name, "Harbor nights");
    assert.deepEqual(created[0]!.sounds, kept.map(idOf));
    assert.equal(sentOps(before, "playlist.update").length, 0);
    const id = await waitFor("Harbor nights in the room", () => Object.values(dmSocket.state?.playlists ?? {}).find((p) => p.name === "Harbor nights")?.id ?? null);
    run.playlists["Harbor nights"] = id;

    // A rename saves the name alone, so another DM's change to another field stands.
    win = await editPlaylist(panel, "Harbor nights");
    await win.getByRole("textbox", { name: "Name" }).fill("Harbor at night");
    const saving = dmSocket.sent.length;
    await win.locator("footer").getByRole("button", { name: "Save", exact: true }).click();
    await win.waitFor({ state: "detached" });
    const updates = sentOps(saving, "playlist.update");
    assert.deepEqual(updates, [{ t: "playlist.update", id, name: "Harbor at night" }], "Save sends the changed name alone");

    // Leaving with changes asks first, by Cancel, the close button, Escape and the browser's Back (Android's), and the same press again discards (D-261106-020).
    for (const leave of ["cancel", "close", "escape", "back"] as const) {
      win = await editPlaylist(panel, "Harbor at night");
      await win.getByRole("button", { name: "Shuffle", exact: true }).click();
      const press = async () => {
        if (leave === "cancel") await win.locator("footer").getByRole("button", { name: "Cancel", exact: true }).click();
        else if (leave === "close") await win.getByRole("button", { name: /^Close/ }).last().click();
        else if (leave === "escape") await dm.keyboard.press("Escape");
        else await dm.evaluate(() => (globalThis as unknown as { history: { back(): void } }).history.back());
      };
      const sent = dmSocket.sent.length;
      await press();
      await win.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor();
      await dm.waitForTimeout(300);
      assert.equal(await win.count(), 1, `${leave}: the maker stays`);
      if (leave === "close") await shots.take(dm, "mu-5-maker-discard");
      await press();
      await win.waitFor({ state: "detached" });
      assert.equal(sentOps(sent, "playlist.update").length, 0, `${leave}: nothing saved`);
      await waitFor(`${leave}: focus back on the playlist's row`, async () => ((await focused()).opener === `playlist-${id}` ? true : null), 3_000);
    }

    // Delete playlist, on a second tap, from the maker, which closes.
    win = await editPlaylist(panel, "Harbor at night");
    await win.getByRole("button", { name: "Delete playlist", exact: true }).click();
    await win.getByRole("button", { name: "Tap again to delete", exact: true }).click();
    await win.waitFor({ state: "detached" });
    await waitFor("Harbor at night deleted", () => (dmSocket.state?.playlists?.[id] ? null : true));
    delete run.playlists["Harbor nights"];
  });

  test("mf-1. the maker after another DM's changes: a rename keeps the track they added though they deleted one the draft held, and Play, unchanged or after a Save, starts the playlist as it stands", async () => {
    await fresh();
    const id = run.playlists["Battle"]!;
    const stored = () => dmSocket.state?.playlists?.[id];
    const battle = [...stored()!.sounds];
    const playButton = () => openMaker().locator("[data-music-maker-settings]").getByRole("button", { name: "Play", exact: true });
    const played = async (from: number) => {
      const play = await waitFor("one music.play", () => (sentOps(from, "music.play").length === 1 ? sentOps(from, "music.play")[0]! : null), 3_000);
      await waitFor("it plays", () => (music()?.run === play.run ? true : null), 3_000);
      return play;
    };
    // A spare track at Battle's end, which the other DM deletes while the draft holds it.
    const spare = randomUUID();
    await ops.send({ t: "sound.create", id: spare, assetId: await upload(95_000), name: "Spare track", use: "music", ms: 95_000 });
    await ops.send({ t: "playlist.add", id, soundId: spare });
    await waitFor("the spare in Battle", () => (stored()?.sounds.includes(spare) ? true : null));
    const panel = await libraryView();
    let win = await editPlaylist(panel, "Battle");

    // They delete the spare and add a track. A rename then saves the name alone, so their track stays.
    const added = run.music[40]!;
    await ops.send({ t: "sound.delete", id: spare });
    await ops.send({ t: "playlist.add", id, soundId: added });
    await waitFor("their change in the DM's view", () => (JSON.stringify(stored()?.sounds) === JSON.stringify([...battle, added]) ? true : null));
    await win.getByRole("textbox", { name: "Name" }).fill("Battle at sea");
    let from = dmSocket.sent.length;
    await win.locator("footer").getByRole("button", { name: "Save", exact: true }).click();
    await win.waitFor({ state: "detached" });
    assert.deepEqual(sentOps(from, "playlist.update"), [{ t: "playlist.update", id, name: "Battle at sea" }], "the name alone");
    await waitFor("the rename", () => (stored()?.name === "Battle at sea" ? true : null));
    assert.deepEqual(stored()!.sounds, [...battle, added], "the track they added stays");

    // Play on an unchanged draft after they drop a track, move one and turn Repeat off: it plays the playlist as it stands, never refused.
    win = await editPlaylist(panel, "Battle at sea");
    const theirs = [added, ...battle.slice(1)];
    await ops.send({ t: "playlist.update", id, sounds: theirs, repeat: "off" });
    await waitFor("their tracks", () => (stored()?.repeat === "off" ? true : null));
    from = dmSocket.sent.length;
    await playButton().click();
    const first = await played(from);
    assert.equal(sentOps(from, "playlist.update").length, 0, "nothing to save");
    assert.deepEqual([first.order, first.repeat], [theirs, "off"]);

    // Save then Play: they put the tracks back and set Crossfade 10 s, and a rename saves the name alone, then plays their tracks with their Crossfade.
    await ops.send({ t: "playlist.update", id, sounds: battle, fade: 10 });
    await waitFor("their Crossfade", () => (stored()?.fade === 10 ? true : null));
    // The title follows the stored name, so the maker is found by what it is, not by its title.
    await openMaker().getByRole("textbox", { name: "Name" }).fill("Battle at dawn");
    from = dmSocket.sent.length;
    await playButton().click();
    const second = await played(from);
    assert.deepEqual(sentOps(from, "playlist.update"), [{ t: "playlist.update", id, name: "Battle at dawn" }], "the name alone");
    assert.deepEqual([second.order, second.repeat, second.fade], [battle, "off", 10]);
    assert.equal(await dm.getByText(/Try again\./).count(), 0, "no refusal");

    // Battle as it was, and Tavern night playing again, as the steps after expect.
    await ops.send({ t: "playlist.update", id, name: "Battle", sounds: battle, repeat: "all", fade: 5 });
    await closeMaker();
    await playTavern();
  });

  test("mu-6. Library: a search for harbor among 100 tracks, Longest first kept after a reload, and More's Add to queue note", async () => {
    await fresh();
    let panel = await libraryView();
    const tracks = panel.getByRole("list", { name: "Tracks" });
    await panel.getByRole("searchbox", { name: "Search music" }).fill("HÁRBOR");
    await waitFor("ten rows", async () => ((await tracks.locator("[data-music-row]").count()) === 10 ? true : null), 3_000);
    await panel.getByRole("heading", { name: /^Tracks/ }).filter({ hasText: "10 of 100" }).waitFor();
    await panel.locator("[data-music-sort]").click();
    await dm.getByRole("menuitemradio", { name: "Longest first" }).click();
    await panel.locator("[data-music-sort]").filter({ hasText: "Sort: Longest first" }).waitFor();
    const lengths = async () =>
      (await tracks.locator("[data-music-row]").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""))).map((t) => {
        const m = /(\d+):(\d\d)/.exec(t);
        return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
      });
    const sorted = await lengths();
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a), "longest first");
    await shots.take(dm, "mu-6-search");
    await panel.getByRole("searchbox", { name: "Search music" }).fill("zzz");
    await panel.getByText('No track matches "zzz".', { exact: true }).waitFor();
    await panel.getByText('No playlist matches "zzz".', { exact: true }).waitFor();
    await reload(dm);
    panel = await libraryView();
    assert.equal(await panel.getByRole("searchbox", { name: "Search music" }).inputValue(), "", "the search is the page's, never stored");
    await panel.locator("[data-music-sort]").filter({ hasText: "Sort: Longest first" }).waitFor();
    // A track in the queue says so in More, and the playing one says Playing.
    const playingName = nameOf(music()!.now.soundId);
    await panel.getByRole("button", { name: `More for ${playingName}`, exact: true }).first().click();
    await dm.getByRole("menuitem", { name: /^Play next/ }).waitFor();
    assert.equal(await dm.getByRole("menuitem", { name: /^Play next/ }).getAttribute("aria-disabled"), "true");
    await shots.take(dm, "mu-6-track-menu");
    await dm.keyboard.press("Escape");
    await panel.locator("[data-music-sort]").click();
    await dm.getByRole("menuitemradio", { name: "Name" }).click();
  });

  test("mu-7. on a phone, drags on the player's seek slider and an Up next handle move no sheet, and the maker's tall sheet closes on a swipe or Put away sheet with no changes and springs back with them, asking nothing", async () => {
    await fresh();
    const phoneContext = await browser.newContext(PHONE);
    try {
      const phone = await phoneContext.newPage();
      await phone.goto(run.dmLink);
      await phone.getByRole("button", { name: /Dana the DM/ }).click();
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();
      const cdp = await phoneContext.newCDPSession(phone);
      const swipe = async (from: { x: number; y: number }, dy: number) => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
        for (let i = 1; i <= 10; i++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + (dy * i) / 10, id: 1 }] });
          await sleep(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(600);
      };
      const middle = async (el: Locator) => {
        await el.scrollIntoViewIfNeeded();
        const box = await el.boundingBox();
        assert.ok(box);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };

      // Sound's sheet: the player's controls take their own drags.
      const sheet = await nowPlaying(phone);
      const slider = await sheet.getByRole("slider", { name: "Seek" }).boundingBox();
      assert.ok(slider);
      await swipe({ x: slider.x + 20, y: slider.y + slider.height / 2 }, 300);
      assert.equal(await sheet.count(), 1, "a drag along the seek slider moves no sheet");
      await openUpNext(sheet);
      await swipe(await middle(sheet.getByRole("button", { name: /^Move .+, 1 of 11$/ })), 200);
      assert.equal(await sheet.count(), 1, "nor a drag on a handle");

      // The maker's tall sheet with no changes: a swipe down from its header closes it.
      await showView(sheet, "Library");
      await sheet.getByRole("button", { name: "New playlist", exact: true }).click();
      let win = maker("New playlist", phone);
      await win.waitFor();
      await swipe(await middle(win.locator("header").first()), 500);
      await win.waitFor({ state: "detached" });

      // With a change, the same swipe springs back, keeps the draft and asks nothing (D-261106-020).
      await sheet.getByRole("button", { name: "New playlist", exact: true }).click();
      win = maker("New playlist", phone);
      await win.getByRole("textbox", { name: "Name" }).fill("Kept by a swipe");
      await swipe(await middle(win.locator("header").first()), 500);
      assert.equal(await win.count(), 1, "the sheet springs back");
      assert.equal(await win.getByRole("textbox", { name: "Name" }).inputValue(), "Kept by a swipe", "the draft kept");
      assert.equal(await win.getByRole("alert").filter({ hasText: "Throw away your changes?" }).count(), 0, "no question in the middle of a gesture");
      await shots.take(phone, "mu-7-maker-sprung-back");
      await closeMaker(phone);
    } finally {
      await phoneContext.close();
    }

    // A mouse on a narrow window: the tall sheet's Down is Put away sheet, and there is no Up. With no changes it closes, with changes it springs back.
    await dm.setViewportSize({ width: 500, height: 900 });
    await reload(dm);
    try {
      const panel = await libraryView();
      await panel.getByRole("button", { name: "New playlist", exact: true }).click();
      let win = maker("New playlist");
      const down = win.getByRole("button", { name: "Put away sheet", exact: true });
      await down.waitFor();
      assert.equal(await win.getByRole("button", { name: "Expand sheet", exact: true }).filter({ visible: true }).count(), 0, "no full stand, so no Up");
      await shots.take(dm, "mu-7-mouse-sheet");
      await down.click();
      await win.waitFor({ state: "detached" });
      await panel.getByRole("button", { name: "New playlist", exact: true }).click();
      win = maker("New playlist");
      await win.getByRole("textbox", { name: "Name" }).fill("Kept by Put away");
      await win.getByRole("button", { name: "Put away sheet", exact: true }).click();
      await dm.waitForTimeout(600);
      assert.equal(await win.count(), 1, "Put away sheet springs back with a change");
      assert.equal(await win.getByRole("textbox", { name: "Name" }).inputValue(), "Kept by Put away");
      assert.equal(await win.getByRole("alert").filter({ hasText: "Throw away your changes?" }).count(), 0, "and asks nothing");
      await closeMaker();
    } finally {
      await dm.setViewportSize(DESK);
    }
  });

  test("mu-8. the maker stays open across 900 px with its draft kept", async () => {
    await fresh();
    const panel = await libraryView();
    await panel.getByRole("button", { name: "New playlist", exact: true }).click();
    const win = maker("New playlist");
    await win.getByRole("textbox", { name: "Name" }).fill("Across the line");
    await win.getByRole("searchbox", { name: "Search music" }).fill("crypt at dusk");
    await win.getByRole("button", { name: "Add Crypt at dusk", exact: true }).click();
    for (const size of [{ width: 860, height: 900 }, DESK]) {
      await dm.setViewportSize(size);
      await sleep(500);
      await win.waitFor();
      assert.equal(await win.getByRole("textbox", { name: "Name" }).inputValue(), "Across the line", `the draft at ${size.width} px`);
      if (size.width < 900) {
        await win.getByRole("radio", { name: "Tracks (1)" }).waitFor();
        await shots.take(dm, "mu-8-maker-860");
      } else assert.equal(await win.getByRole("list", { name: "Tracks in order" }).locator("[data-music-row-name]").allTextContents().then((n) => n.join()), "Crypt at dusk");
    }
    const sent = dmSocket.sent.length;
    await win.getByRole("button", { name: /^Close/ }).last().click();
    await win.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor();
    await win.getByRole("button", { name: /^Close/ }).last().click();
    await win.waitFor({ state: "detached" });
    assert.equal(sentOps(sent, "playlist.create").length, 0);
  });

  test("mu-9. the player, Up next with Played, Library, the menus, the maker and its tabs at four sizes, 100% and 130%, dark and light: nothing over 1 px out of line", async () => {
    // Repeat off at 3 of 12, so Played holds two rows (4.3).
    await playTavern("off");
    const lines: string[] = [];
    try {
      for (const scheme of ["dark", "light"] as const) {
        for (const size of [DESK, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
          for (const scale of [1, 1.3]) {
            await dm.setViewportSize(size);
            await setScheme(dm, scheme, scale);
            await reload(dm);
            const where = `${size.width}x${size.height} ${scale * 100}% ${scheme}`;
            const panel = await nowPlaying();
            await openUpNext(panel);
            await panel.getByRole("list", { name: "Played" }).waitFor();
            lines.push(...(await outOfLine(panel.locator("[data-sound-player]"), `the player ${where}`)));
            // Up next's label row with its summary, then its lists.
            lines.push(...(await outOfLine(panel.locator("[data-music-upnext-summary]").locator("xpath=ancestor::*[@data-section-label][1]"), `Up next's label ${where}`)));
            lines.push(...(await outOfLine(panel.locator("[data-music-upnext]"), `Up next ${where}`)));
            if (scale === 1 && (size.width === DESK.width || size.width === 390)) await shots.take(dm, `mu-9-now-${size.width}-${scheme}`);

            await showView(panel, "Library");
            const libraryRoot = panel.locator("[data-music-library]");
            const tiles = (await libraryRoot.locator("[data-music-row] [data-music-tile]").count()) > 0;
            lines.push(...(await outOfLine(libraryRoot, `Library ${where}`)).filter((line) => !wrappedRows(line, tiles)));
            if (!tiles) {
              // Those rows measured one by one instead: each row's controls on its middle.
              const rows = panel.getByRole("list", { name: "Playlists" }).locator(":scope > li");
              for (let i = 0; i < (await rows.count()); i++) lines.push(...(await outOfLine(rows.nth(i), `Playlists row ${i + 1} ${where}`)));
            }

            // A track's More and its Add to playlist menu, then the sort.
            const more = panel.getByRole("list", { name: "Tracks" }).getByRole("button", { name: /^More for / }).first();
            await more.scrollIntoViewIfNeeded();
            await more.click();
            const menu = dm.getByRole("menu").last();
            await menu.waitFor();
            lines.push(...(await outOfLine(menu, `a track's More ${where}`)));
            await dm.getByRole("menuitem", { name: "Add to playlist…", exact: true }).click();
            await dm.getByRole("menuitem", { name: /^Battle/ }).waitFor();
            lines.push(...(await outOfLine(dm.getByRole("menu").last(), `Add to playlist ${where}`)));
            await dm.keyboard.press("Escape");
            await panel.locator("[data-music-sort]").scrollIntoViewIfNeeded();
            await panel.locator("[data-music-sort]").click();
            await dm.getByRole("menuitemradio", { name: "Name" }).waitFor();
            lines.push(...(await outOfLine(dm.getByRole("menu").last(), `the sort ${where}`)));
            await dm.keyboard.press("Escape");

            // The maker on Tavern night, and its Add tracks tab where it has one.
            const win = await editPlaylist(panel, "Tavern night");
            lines.push(...(await outOfLine(win, `the maker ${where}`)));
            const add = win.getByRole("radio", { name: "Add tracks", exact: true });
            if ((await add.count()) > 0) {
              await add.click();
              await win.getByRole("searchbox", { name: "Search music" }).waitFor();
              lines.push(...(await outOfLine(win, `the maker's Add tracks ${where}`)));
            }
            if (scale === 1 && (size.width === DESK.width || size.width === 390)) await shots.take(dm, `mu-9-maker-${size.width}-${scheme}`);
            await closeMaker();
          }
        }
      }
    } finally {
      await setScheme(dm, "dark", 1);
      await fresh();
      await playTavern();
    }
    assert.deepEqual(lines, [], "out of line");
  });
});
