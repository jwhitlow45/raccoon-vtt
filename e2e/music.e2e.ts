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
 * The Music window (docs/design/design-v1-music-player.md 3 to 5 and 11.3),
 * on the real server serving the production build with ROOM_SOUND on, a
 * room of 100 music tracks in four playlists, Tavern night playing at 3 of
 * 12. Sounds are frames of silence (shared/audio/mp3Testutil.ts).
 * - mu-1: Open music at a desk and on a phone, its layouts and tabs.
 * - mu-2: Up next after Play next, Add to queue and Remove.
 * - mu-3: seek by keys and a drag (Repeat one too), Previous twice within a round trip, Play then Seek, Shuffle on and off.
 * - mu-4: drag and keys in Up next.
 * - mu-5: the maker.
 * - mf-1: the maker's Save and Play after another DM's changes.
 * - mu-6: search, sort and Add to playlist.
 * - mu-7: the phone sheet's swipe and Put away sheet.
 * - mu-8: a resize across 900 px.
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

async function ambiance(page: Page = dm): Promise<Locator> {
  if (await page.getByRole("tablist", { name: "Panels" }).isVisible()) {
    await openSideTab(page, "Ambiance");
    return page.getByRole("tabpanel", { name: sideTabName("Ambiance") });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Ambiance"]');
  if (await sheet.isVisible()) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Ambiance/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** The Music window, opened from the Sound group's Open music. */
async function openMusic(page: Page = dm): Promise<Locator> {
  const panel = await ambiance(page);
  await panel.getByRole("button", { name: "Open music", exact: true }).click();
  const win = musicWindow(page);
  await win.waitFor();
  return win;
}

function musicWindow(page: Page = dm): Locator {
  return page.locator("dialog[open]").filter({ has: page.locator("[data-music-window]") });
}

async function closeMusic(page: Page = dm): Promise<void> {
  const win = musicWindow(page);
  if ((await win.count()) === 0) return;
  await win.getByRole("button", { name: /^Close/ }).last().click();
  await win.waitFor({ state: "detached" });
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

/** The Up next rows' names, in order, from the window. */
async function upNextNames(win: Locator): Promise<string[]> {
  return win.getByRole("list", { name: "Up next" }).locator("[data-music-order-row] [data-music-row-name]").allTextContents();
}

async function setScheme(page: Page, scheme: "dark" | "light", scale = 1): Promise<void> {
  await page.evaluate(([s, sc]) => {
    localStorage.setItem("rvtt.theme", s as string);
    localStorage.setItem("rvtt.uiScale", String(sc));
  }, [scheme, scale] as const);
}

/** What has focus in the page: its tag, its name, and whether it is Open music. */
function focused(page: Page = dm): Promise<{ tag: string; label: string | null; openMusic: boolean }> {
  return page.evaluate(() => {
    type El = { tagName: string; getAttribute(n: string): string | null; hasAttribute(n: string): boolean };
    const el = (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement;
    return { tag: el?.tagName ?? "", label: el?.getAttribute("aria-label") ?? null, openMusic: el?.hasAttribute("data-music-open") ?? false };
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
 * two-line one. Those findings alone are left out, and mu-9 measures each
 * such row on its own.
 */
function wrappedRows(line: string, layoutPx: number): boolean {
  return layoutPx < 300 && /: kind-height [\d.]+ px, ul "(Playlists|Tracks)": li /.test(line);
}

/** The DM's page loaded afresh, so a step that failed leaves no window open for the next. */
async function fresh(): Promise<void> {
  await dm.setViewportSize(DESK);
  await reload(dm);
}

async function reload(page: Page): Promise<void> {
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
}

describe("the Music window", { concurrency: false }, () => {
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

  test("mu-1. Open music: a 1040 px dialog at a desk with Library beside Now playing, the tall sheet with two tabs on a phone, on Library with nothing playing", async () => {
    // The Sound group keeps the compact block: Open music, the Next line, and neither Stop the music nor Repeat.
    let panel = await ambiance();
    const block = panel.locator("[data-sound-now]");
    await block.locator("[data-sound-next]").filter({ hasText: `Next: ${nameOf(run.tavern[3]!)}` }).waitFor();
    for (const gone of ["Stop the music", "Repeat all"]) assert.equal(await panel.getByRole("button", { name: gone, exact: true }).count(), 0, `${gone} lives in the window`);
    await shots.take(dm, "mu-1-panel-desk");

    // 1440 x 900: the card 1040 by 760, two columns that scroll on their own, Up next in view with no scroll.
    let win = await openMusic();
    await win.getByRole("heading", { name: "Music", exact: true }).waitFor();
    assert.equal((await focused()).tag, "DIALOG", "it opens with focus on its title, the dialog's name");
    const card = await win.locator("section").first().boundingBox();
    assert.ok(card && Math.abs(card.width - 1040) <= 1 && Math.abs(card.height - 760) <= 1, `the card at 1440 x 900: ${JSON.stringify(card)}`);
    for (const column of ["library", "now"]) assert.equal(await win.locator(`[data-music-column="${column}"]`).evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { overflowY: string } }).getComputedStyle(el).overflowY), "auto", `${column} scrolls on its own`);
    const now = win.locator('[data-music-column="now"]');
    const upNext = now.getByRole("heading", { name: /^Up next/ });
    const inView = async (el: Locator, box: Locator) => {
      const [a, b] = await Promise.all([el.boundingBox(), box.boundingBox()]);
      return a !== null && b !== null && a.y >= b.y && a.y + a.height <= b.y + b.height;
    };
    assert.ok(await inView(upNext, now), "Up next's heading in view at 1440 x 900");
    assert.deepEqual(await upNextNames(win), run.tavern.slice(3).map(nameOf), "Up next: the rest of this pass");
    await win.getByText("Then Tavern night plays again from the top:", { exact: true }).waitFor();
    await win.getByRole("button", { name: `Move ${nameOf(run.tavern[3]!)}, 1 of 11`, exact: true }).waitFor();
    await win.getByRole("button", { name: `Move ${nameOf(run.tavern[0]!)}, 10 of 11`, exact: true }).waitFor();
    await shots.take(dm, "mu-1-window-1440");
    await dm.keyboard.press("Escape");
    await win.waitFor({ state: "detached" });
    assert.equal((await focused()).openMusic, true, "focus back on Open music");

    // 1280 x 720: 1040 by 688, Up next still in view.
    await dm.setViewportSize({ width: 1280, height: 720 });
    win = await openMusic();
    const small = await win.locator("section").first().boundingBox();
    assert.ok(small && Math.abs(small.width - 1040) <= 1 && Math.abs(small.height - 688) <= 1, `the card at 1280 x 720: ${JSON.stringify(small)}`);
    assert.ok(await inView(win.locator('[data-music-column="now"]').getByRole("heading", { name: /^Up next/ }), win.locator('[data-music-column="now"]')), "Up next's heading in view at 1280 x 720");
    await shots.take(dm, "mu-1-window-1280");
    await closeMusic();
    await dm.setViewportSize(DESK);

    // A phone: the tall sheet, a strip of the room above it, Now playing and Library as tabs, on Now playing while music plays.
    const phoneContext = await browser.newContext(PHONE);
    try {
      const phone = await phoneContext.newPage();
      await phone.goto(run.dmLink);
      await phone.getByRole("button", { name: /Dana the DM/ }).click();
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();
      win = await openMusic(phone);
      const sheet = await win.locator("section").first().boundingBox();
      assert.ok(sheet && sheet.y >= 12 && sheet.y <= 60 && Math.abs(sheet.y + sheet.height - 844) <= 1, `the tall sheet: ${JSON.stringify(sheet)}`);
      const tabs = win.getByRole("radiogroup", { name: "Music" });
      assert.equal(await tabs.getByRole("radio", { name: "Now playing" }).isChecked(), true, "on Now playing while music plays");
      await win.locator("[data-music-now]").waitFor();
      await shots.take(phone, "mu-1-phone-now");
      await tabs.getByRole("radio", { name: "Library" }).click();
      await win.getByRole("searchbox", { name: "Search music" }).waitFor();
      await shots.take(phone, "mu-1-phone-library");
      await closeMusic(phone);

      // Nothing playing: it opens on Library.
      await ops.send({ t: "music.stop" });
      await waitFor("the music stopped", () => (music() === null ? true : null));
      win = await openMusic(phone);
      assert.equal(await win.getByRole("radio", { name: "Library" }).isChecked(), true, "on Library with nothing playing");
      await win.getByRole("radio", { name: "Now playing" }).click();
      await win.getByText("No music is playing. Pick a playlist or a track in Library.", { exact: true }).waitFor();
      await closeMusic(phone);
    } finally {
      await phoneContext.close();
      await playTavern();
    }
    panel = await ambiance();
    await panel.locator("[data-sound-next]").waitFor();
  });

  test("mu-2. Up next after Play next, Add to queue and Remove, each one music.queue on the run it was made on", async () => {
    await fresh();
    await playTavern();
    const r = music()!.run;
    const win = await openMusic();
    const tracks = win.getByRole("list", { name: "Tracks" });
    const search = win.getByRole("searchbox", { name: "Search music" });
    const ahead = run.tavern.slice(3).map(nameOf);

    // Play next: a track from Battle goes first in Up next.
    const battle = run.music[30]!;
    await search.fill(nameOf(battle));
    let from = dmSocket.sent.length;
    await tracks.getByRole("button", { name: `More for ${nameOf(battle)}`, exact: true }).click();
    await dm.getByRole("menuitem", { name: /^Play next/ }).click();
    await waitFor("Play next's row first", async () => ((await upNextNames(win))[0] === nameOf(battle) ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue"), [{ t: "music.queue", from: r, edit: { t: "next", soundIds: [battle] } }]);

    // Add to queue: the end of this pass, before Tavern night plays again from the top.
    const travel = run.music[61]!;
    await search.fill(nameOf(travel));
    from = dmSocket.sent.length;
    await tracks.getByRole("button", { name: `More for ${nameOf(travel)}`, exact: true }).click();
    await dm.getByRole("menuitem", { name: /^Add to queue/ }).click();
    await waitFor("Add to queue's row last", async () => ((await upNextNames(win)).at(-1) === nameOf(travel) ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue"), [{ t: "music.queue", from: r, edit: { t: "add", soundIds: [travel] } }]);
    await search.fill("");

    // Remove, from the row's own More in Up next.
    const gone = run.tavern[4]!;
    from = dmSocket.sent.length;
    await win.getByRole("list", { name: "Up next" }).getByRole("button", { name: `More for ${nameOf(gone)}`, exact: true }).click();
    await dm.getByRole("menuitem", { name: "Remove from queue", exact: true }).click();
    const expected = [nameOf(battle), ...ahead.filter((n) => n !== nameOf(gone)), nameOf(travel)];
    await waitFor("the row removed", async () => (JSON.stringify(await upNextNames(win)) === JSON.stringify(expected) ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue"), [{ t: "music.queue", from: r, edit: { t: "remove", soundId: gone } }]);
    // The room agrees with what the window showed at once.
    await waitFor("the room's order", () => {
      const m = music();
      const at = m?.order?.indexOf(m.now.soundId) ?? -1;
      return m && JSON.stringify(m.order!.slice(at + 1).map(nameOf)) === JSON.stringify(expected) ? true : null;
    });
    await win.getByText("Then Tavern night plays again from the top:", { exact: true }).waitFor();
    await shots.take(dm, "mu-2-up-next");
    await closeMusic();
  });

  test("mu-3. a seek by keys, a drag that seeks once at its release, held short of the end under Repeat one, Previous twice within a round trip, Play then Seek before Play's answer, and Shuffle on and off", async () => {
    await fresh();
    await playTavern();
    let win = await openMusic();
    const slider = win.getByRole("slider", { name: "Seek" });
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

    // Repeat one: End is held a second short of the end, less the crossfade.
    await win.getByRole("button", { name: "Repeat all", exact: true }).click();
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
    await closeMusic();

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
      win = await openMusic(slow);
      await win.locator("[data-music-now]").filter({ hasText: nameOf(third) }).waitFor();
      // Previous twice within a round trip: the first restarts track 3, the second goes to track 2, and nothing is refused.
      await win.getByRole("button", { name: "Previous", exact: true }).click();
      await win.getByRole("button", { name: "Previous", exact: true }).click();
      await waitFor("track 2 from its start", () => (music()?.now.soundId === run.tavern[1] && Date.now() - music()!.now.at < 5_000 ? true : null), 6_000);
      await sleep(2_000);
      assert.equal(music()?.now.soundId, run.tavern[1], "still track 2 once both answers are in");
      assert.equal(await slow.getByText(/Try again\./).count(), 0, "no refusal");

      // Play, then Seek before the Play is answered: the seek applies to the new run.
      const boss = run.music[91]!;
      const tab = win.getByRole("radio", { name: "Library", exact: true });
      if ((await tab.count()) > 0) await tab.click();
      await win.getByRole("searchbox", { name: "Search music" }).fill(nameOf(boss));
      await win.getByRole("list", { name: "Tracks" }).getByRole("button", { name: `Play ${nameOf(boss)}`, exact: true }).click();
      const seekNow = win.getByRole("slider", { name: "Seek" });
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
    win = await openMusic();
    await win.getByRole("button", { name: "Shuffle", exact: true }).click();
    const mixed = await waitFor("shuffled", () => (music()?.shuffle === true ? music() : null));
    assert.deepEqual([...mixed.order!].sort(), [...run.tavern].sort(), "the same tracks");
    assert.equal(mixed.order!.indexOf(mixed.now.soundId), 2, "still 3 of 12");
    assert.notDeepEqual(mixed.order, run.tavern, "mixed");
    await win.locator("[data-music-now]").filter({ hasText: "Tavern night · 3 of 12" }).waitFor();
    assert.equal(await win.getByRole("button", { name: "Shuffle", exact: true }).getAttribute("aria-pressed"), "true");
    await shots.take(dm, "mu-3-shuffled");
    await win.getByRole("button", { name: "Shuffle", exact: true }).click();
    await waitFor("in the playlist's order", () => (music()?.shuffle === undefined && JSON.stringify(music()?.order) === JSON.stringify(run.tavern) ? true : null));
    await closeMusic();
  });

  test("mu-4. Up next's keys and drags: a step, the ends, Up past the seam, a drop at the seam, a drag that outlives a volume change, one that ends as a crossfade starts, and drops past the last row at 1 of 12 and under Repeat off", async () => {
    await fresh();
    await playTavern();
    const win = await openMusic();
    const lines = () => upNextNames(win);
    const handle = (id: string, place: number) => win.getByRole("button", { name: `Move ${nameOf(id)}, ${place} of 11`, exact: true });
    const t = run.tavern;

    // Down one place, then End and Home, focus kept on the handle and each move said.
    let from = dmSocket.sent.length;
    await handle(t[3]!, 1).focus();
    await dm.keyboard.press("ArrowDown");
    await handle(t[3]!, 2).waitFor();
    assert.deepEqual((await lines()).slice(0, 2), [nameOf(t[4]!), nameOf(t[3]!)]);
    assert.equal((await focused()).label, `Move ${nameOf(t[3]!)}, 2 of 11`, "focus stays on the handle");
    await win.getByRole("status").filter({ hasText: `${nameOf(t[3]!)} is now 2 of 11.` }).waitFor();
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
    await win.locator("[data-music-now]").filter({ hasText: "Tavern night · 2 of 12" }).waitFor();

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
    await win.locator("[data-music-now]").filter({ hasText: "Tavern night · 2 of 12" }).waitFor();

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
    await drag(idOf(first), 1, async () => (await midOf(win.getByRole("list", { name: "Up next" }).locator("[data-music-order-row]").nth(3))) + 10, async () => {
      await sleep(Math.max(0, next.at - Date.now()) + 600);
    });
    await sleep(800);
    assert.equal(sentOps(from, "music.queue").length, 0, "nothing sent: the crossfade ended the drag");
    await win.locator("[data-music-now]").filter({ hasText: nameOf(next.soundId) }).waitFor();

    // A drag past the last row takes the last place. At 1 of 12 the second list is empty, so that place is the seam, the order's end, and Now playing still reads 1 of 12.
    const rows = win.getByRole("list", { name: "Up next" }).locator("[data-music-order-row]");
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
    await win.locator("[data-music-now]").filter({ hasText: "Tavern night · 1 of 12" }).waitFor();
    from = dmSocket.sent.length;
    await dragFrom(handle(t[1]!, 1));
    await waitFor("the drop", () => (sentOps(from, "music.queue").length === 1 ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[1], to: "passEnd" }]);
    await waitFor("t1 at Up next's end", async () => ((await lines()).at(-1) === nameOf(t[1]!) ? true : null), 3_000);
    await win.locator("[data-music-now]").filter({ hasText: "Tavern night · 1 of 12" }).waitFor();

    // Under Repeat off, to the bottom of Up next: the order's end.
    await playTavern("off");
    from = dmSocket.sent.length;
    await dragFrom(win.getByRole("button", { name: `Move ${nameOf(t[3]!)}, 1 of 9`, exact: true }));
    await waitFor("the drop", () => (sentOps(from, "music.queue").length === 1 ? true : null), 3_000);
    assert.deepEqual(sentOps(from, "music.queue").map((o) => o.edit), [{ t: "move", soundId: t[3], to: "last" }]);
    await waitFor("t3 at Up next's end", async () => ((await lines()).at(-1) === nameOf(t[3]!) ? true : null), 3_000);
    await playTavern();
    await closeMusic();
  });

  test("mu-5. the maker: ten tracks by search, drags up and past the last row, keys, one Create, a rename that Saves its name alone, and a close with changes that asks first", async () => {
    await fresh();
    let win = await openMusic();
    await win.getByRole("button", { name: "New playlist", exact: true }).click();
    await win.getByRole("heading", { name: "New playlist", exact: true }).waitFor();
    await win.getByRole("button", { name: "Back to Music" }).waitFor();
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

    // One Create, one Setup op, then back to Library with the playlist there.
    const before = dmSocket.sent.length;
    await win.locator("footer").getByRole("button", { name: "Create playlist", exact: true }).click();
    await win.getByRole("heading", { name: "Music", exact: true }).waitFor();
    const created = sentOps(before, "playlist.create");
    assert.equal(created.length, 1, "one playlist.create");
    assert.equal(created[0]!.name, "Harbor nights");
    assert.deepEqual(created[0]!.sounds, kept.map(idOf));
    assert.equal(sentOps(before, "playlist.update").length, 0);
    const id = await waitFor("Harbor nights in the room", () => Object.values(dmSocket.state?.playlists ?? {}).find((p) => p.name === "Harbor nights")?.id ?? null);
    run.playlists["Harbor nights"] = id;

    // A rename saves the name alone, so another DM's change to another field stands.
    await win.getByRole("list", { name: "Playlists" }).getByRole("button", { name: /^Harbor nights/ }).click();
    await win.getByRole("heading", { name: "Harbor nights", exact: true }).waitFor();
    await win.getByRole("textbox", { name: "Name" }).fill("Harbor at night");
    const saving = dmSocket.sent.length;
    await win.locator("footer").getByRole("button", { name: "Save", exact: true }).click();
    await win.getByRole("heading", { name: "Music", exact: true }).waitFor();
    const updates = sentOps(saving, "playlist.update");
    assert.deepEqual(updates, [{ t: "playlist.update", id, name: "Harbor at night" }], "Save sends the changed name alone");

    // Leaving with changes asks first, by the close button, Escape and Back, and the same press again discards.
    for (const leave of ["close", "escape", "back"] as const) {
      await win.getByRole("list", { name: "Playlists" }).getByRole("button", { name: /^Harbor at night/ }).click();
      await win.getByRole("heading", { name: "Harbor at night", exact: true }).waitFor();
      await win.getByRole("button", { name: "Shuffle", exact: true }).click();
      const press = async () => {
        if (leave === "close") await win.getByRole("button", { name: /^Close/ }).last().click();
        else if (leave === "escape") await dm.keyboard.press("Escape");
        else await win.getByRole("button", { name: "Back to Music" }).click();
      };
      const sent = dmSocket.sent.length;
      await press();
      await win.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor();
      assert.equal(await win.getByRole("heading", { name: "Harbor at night", exact: true }).count(), 1, `${leave}: the maker stays`);
      if (leave === "close") await shots.take(dm, "mu-5-maker-discard");
      await press();
      if (leave === "back") await win.getByRole("heading", { name: "Music", exact: true }).waitFor();
      else {
        await win.waitFor({ state: "detached" });
        win = await openMusic();
      }
      assert.equal(sentOps(sent, "playlist.update").length, 0, `${leave}: nothing saved`);
    }

    // Delete playlist, on a second tap, from the maker.
    await win.getByRole("list", { name: "Playlists" }).getByRole("button", { name: /^Harbor at night/ }).click();
    await win.getByRole("button", { name: "Delete playlist", exact: true }).click();
    await win.getByRole("button", { name: "Tap again to delete", exact: true }).click();
    await win.getByRole("heading", { name: "Music", exact: true }).waitFor();
    await waitFor("Harbor at night deleted", () => (dmSocket.state?.playlists?.[id] ? null : true));
    delete run.playlists["Harbor nights"];
    await closeMusic();
  });

  test("mf-1. the maker after another DM's changes: a rename keeps the track they added though they deleted one the draft held, and Play, unchanged or after a Save, starts the playlist as it stands", async () => {
    await fresh();
    const id = run.playlists["Battle"]!;
    const stored = () => dmSocket.state?.playlists?.[id];
    const battle = [...stored()!.sounds];
    const playButton = () => musicWindow().locator("[data-music-maker-settings]").getByRole("button", { name: "Play", exact: true });
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
    const win = await openMusic();
    const openMaker = async (name: string) => {
      await win.getByRole("list", { name: "Playlists" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
      await win.getByRole("heading", { name, exact: true }).waitFor();
    };
    await openMaker("Battle");

    // They delete the spare and add a track. A rename then saves the name alone, so their track stays.
    const added = run.music[40]!;
    await ops.send({ t: "sound.delete", id: spare });
    await ops.send({ t: "playlist.add", id, soundId: added });
    await waitFor("their change in the DM's view", () => (JSON.stringify(stored()?.sounds) === JSON.stringify([...battle, added]) ? true : null));
    await win.getByRole("textbox", { name: "Name" }).fill("Battle at sea");
    let from = dmSocket.sent.length;
    await win.locator("footer").getByRole("button", { name: "Save", exact: true }).click();
    await win.getByRole("heading", { name: "Music", exact: true }).waitFor();
    assert.deepEqual(sentOps(from, "playlist.update"), [{ t: "playlist.update", id, name: "Battle at sea" }], "the name alone");
    await waitFor("the rename", () => (stored()?.name === "Battle at sea" ? true : null));
    assert.deepEqual(stored()!.sounds, [...battle, added], "the track they added stays");

    // Play on an unchanged draft after they drop a track, move one and turn Repeat off: it plays the playlist as it stands, never refused.
    await openMaker("Battle at sea");
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
    await musicWindow().getByRole("textbox", { name: "Name" }).fill("Battle at dawn");
    from = dmSocket.sent.length;
    await playButton().click();
    const second = await played(from);
    assert.deepEqual(sentOps(from, "playlist.update"), [{ t: "playlist.update", id, name: "Battle at dawn" }], "the name alone");
    assert.deepEqual([second.order, second.repeat, second.fade], [battle, "off", 10]);
    assert.equal(await dm.getByText(/Try again\./).count(), 0, "no refusal");

    // Battle as it was, and Tavern night playing again, as the steps after expect.
    await ops.send({ t: "playlist.update", id, name: "Battle", sounds: battle, repeat: "all", fade: 5 });
    await closeMusic();
    await playTavern();
  });

  test("mu-6. Library: a search for harbor among 100 tracks, Longest first kept after a reload, and More's Add to queue note", async () => {
    await fresh();
    let win = await openMusic();
    const tracks = win.getByRole("list", { name: "Tracks" });
    await win.getByRole("searchbox", { name: "Search music" }).fill("HÁRBOR");
    await waitFor("ten rows", async () => ((await tracks.locator("[data-music-row]").count()) === 10 ? true : null), 3_000);
    await win.getByRole("heading", { name: /^Tracks/ }).filter({ hasText: "10 of 100" }).waitFor();
    await win.locator("[data-music-sort]").click();
    await dm.getByRole("menuitemradio", { name: "Longest first" }).click();
    await win.locator("[data-music-sort]").filter({ hasText: "Sort: Longest first" }).waitFor();
    const lengths = async () =>
      (await tracks.locator("[data-music-row]").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""))).map((t) => {
        const m = /(\d+):(\d\d)/.exec(t);
        return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
      });
    const sorted = await lengths();
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a), "longest first");
    await shots.take(dm, "mu-6-search");
    await win.getByRole("searchbox", { name: "Search music" }).fill("zzz");
    await win.getByText('No track matches "zzz".', { exact: true }).waitFor();
    await win.getByText('No playlist matches "zzz".', { exact: true }).waitFor();
    await closeMusic();
    await reload(dm);
    win = await openMusic();
    await win.locator("[data-music-sort]").filter({ hasText: "Sort: Longest first" }).waitFor();
    // A track in the queue says so in More, and the playing one says Playing.
    const playingName = nameOf(music()!.now.soundId);
    await win.getByRole("button", { name: `More for ${playingName}`, exact: true }).first().click();
    await dm.getByRole("menuitem", { name: /^Play next/ }).waitFor();
    assert.equal(await dm.getByRole("menuitem", { name: /^Play next/ }).getAttribute("aria-disabled"), "true");
    await shots.take(dm, "mu-6-track-menu");
    await dm.keyboard.press("Escape");
    await win.locator("[data-music-sort]").click();
    await dm.getByRole("menuitemradio", { name: "Name" }).click();
    await closeMusic();
  });

  test("mu-7. on a phone, the tall sheet closes on a swipe down from its header, never from the seek slider or a handle, and a mouse's Put away sheet closes it", async () => {
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
      const win = await openMusic(phone);
      const slider = await win.getByRole("slider", { name: "Seek" }).boundingBox();
      assert.ok(slider);
      await swipe({ x: slider.x + 20, y: slider.y + slider.height / 2 }, 300);
      assert.equal(await win.count(), 1, "a drag along the seek slider moves no sheet");
      const grip = await win.getByRole("button", { name: /^Move .+, 1 of 11$/ }).boundingBox();
      assert.ok(grip);
      await swipe({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, 200);
      assert.equal(await win.count(), 1, "nor a drag on a handle");
      const header = await win.locator("header").first().boundingBox();
      assert.ok(header);
      await swipe({ x: header.x + header.width / 2, y: header.y + header.height / 2 }, 500);
      await win.waitFor({ state: "detached" });
    } finally {
      await phoneContext.close();
    }

    // A mouse on a narrow window: the tall sheet's Down is Put away sheet, and there is no Up.
    await dm.setViewportSize({ width: 500, height: 900 });
    await reload(dm);
    try {
      const win = await openMusic();
      const down = win.getByRole("button", { name: "Put away sheet", exact: true });
      await down.waitFor();
      assert.equal(await win.getByRole("button", { name: "Expand sheet", exact: true }).filter({ visible: true }).count(), 0, "no full stand, so no Up");
      await shots.take(dm, "mu-7-mouse-sheet");
      await down.click();
      await win.waitFor({ state: "detached" });
    } finally {
      await dm.setViewportSize(DESK);
    }
  });

  test("mu-8. the window stays open across 900 px on the same step, the maker's draft kept", async () => {
    await fresh();
    const win = await openMusic();
    await win.getByRole("button", { name: "New playlist", exact: true }).click();
    await win.getByRole("textbox", { name: "Name" }).fill("Across the line");
    await win.getByRole("searchbox", { name: "Search music" }).fill("crypt at dusk");
    await win.getByRole("button", { name: "Add Crypt at dusk", exact: true }).click();
    for (const size of [{ width: 860, height: 900 }, DESK]) {
      await dm.setViewportSize(size);
      await sleep(500);
      const again = musicWindow();
      await again.getByRole("heading", { name: "New playlist", exact: true }).waitFor();
      assert.equal(await again.getByRole("textbox", { name: "Name" }).inputValue(), "Across the line", `the draft at ${size.width} px`);
      if (size.width < 900) {
        await again.getByRole("radio", { name: "Tracks (1)" }).waitFor();
        await shots.take(dm, "mu-8-maker-860");
      } else assert.equal(await again.getByRole("list", { name: "Tracks in order" }).locator("[data-music-row-name]").allTextContents().then((n) => n.join()), "Crypt at dusk");
    }
    const sent = dmSocket.sent.length;
    await musicWindow().getByRole("button", { name: /^Close/ }).last().click();
    await musicWindow().getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor();
    await musicWindow().getByRole("button", { name: /^Close/ }).last().click();
    await musicWindow().waitFor({ state: "detached" });
    assert.equal(sentOps(sent, "playlist.create").length, 0);
  });

  test("mu-9. the compact block, the window wide and in both tabs, Played, the maker, its tabs and the menus at four sizes, 100% and 130%, dark and light: nothing over 1 px out of line", async () => {
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
            const block = (await ambiance()).locator("[data-sound-now]");
            await block.waitFor();
            lines.push(...(await outOfLine(block, `the compact block ${where}`)));
            const win = await openMusic();
            await win.getByRole("list", { name: "Played" }).waitFor();
            const tabs = win.getByRole("radiogroup", { name: "Music" });
            if ((await tabs.count()) > 0) {
              lines.push(...(await outOfLine(win, `Now playing ${where}`)));
              await tabs.getByRole("radio", { name: "Library" }).click();
              await win.getByRole("searchbox", { name: "Search music" }).waitFor();
              lines.push(...(await outOfLine(win, `Library ${where}`)).filter((line) => !wrappedRows(line, size.width / scale)));
              if (size.width / scale < 300) {
                // Those rows measured one by one instead: each row's controls on its middle.
                const rows = win.getByRole("list", { name: "Playlists" }).locator(":scope > li");
                for (let i = 0; i < (await rows.count()); i++) lines.push(...(await outOfLine(rows.nth(i), `Playlists row ${i + 1} ${where}`)));
              }
            } else {
              // Two regions that scroll on their own, side by side, whose middles mean nothing to each other: each is measured as its own root, with the header.
              lines.push(...(await outOfLine(win.locator("header").first(), `the window's header ${where}`)));
              for (const column of ["library", "now"]) lines.push(...(await outOfLine(win.locator(`[data-music-column="${column}"]`), `the window's ${column} column ${where}`)));
            }

            // A track's More and its Add to playlist menu, then the sort.
            const more = win.getByRole("list", { name: "Tracks" }).getByRole("button", { name: /^More for / }).first();
            await more.scrollIntoViewIfNeeded();
            await more.click();
            const menu = dm.getByRole("menu").last();
            await menu.waitFor();
            lines.push(...(await outOfLine(menu, `a track's More ${where}`)));
            await dm.getByRole("menuitem", { name: "Add to playlist…", exact: true }).click();
            await dm.getByRole("menuitem", { name: /^Battle/ }).waitFor();
            lines.push(...(await outOfLine(dm.getByRole("menu").last(), `Add to playlist ${where}`)));
            await dm.keyboard.press("Escape");
            await win.locator("[data-music-sort]").scrollIntoViewIfNeeded();
            await win.locator("[data-music-sort]").click();
            await dm.getByRole("menuitemradio", { name: "Name" }).waitFor();
            lines.push(...(await outOfLine(dm.getByRole("menu").last(), `the sort ${where}`)));
            await dm.keyboard.press("Escape");

            // The maker on Tavern night, and its Add tracks tab where it has one.
            await win.getByRole("list", { name: "Playlists" }).getByRole("button", { name: /^Tavern night/ }).click();
            await win.getByRole("heading", { name: "Tavern night", exact: true }).waitFor();
            lines.push(...(await outOfLine(win, `the maker ${where}`)));
            const add = win.getByRole("radio", { name: "Add tracks", exact: true });
            if ((await add.count()) > 0) {
              await add.click();
              await win.getByRole("searchbox", { name: "Search music" }).waitFor();
              lines.push(...(await outOfLine(win, `the maker's Add tracks ${where}`)));
            }
            if (scale === 1 && (size.width === DESK.width || size.width === 390)) await shots.take(dm, `mu-9-maker-${size.width}-${scheme}`);
            await win.getByRole("button", { name: "Back to Music" }).click();
            await closeMusic();
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
