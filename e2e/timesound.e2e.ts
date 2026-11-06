import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { framesFor, silentFrames } from "#shared/audio/mp3Testutil.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { addSound } from "./soundRoom.ts";

/**
 * Time and Sound as panels (docs/design/design-v1-sound-layout.md 3, 4 and
 * 10.3), on the real server serving the production build with ROOM_SOUND
 * on. Dana the DM is at a desk, and on a phone where a step says so. Pat
 * plays on a phone. The Now playing chip is not in this file: it ships
 * with the top bar's own run.
 * - sl-0: the room, Pat, 100 music tracks with Tavern night playing from
 *   its first, and a background sound.
 * - sl-1: the DM's lists: the phone's Run the table, the side panel's row
 *   at 360 and 640 px, and the old Ambiance id in a stored split and a
 *   reload's reopen.
 * - sl-2: Pat's Time and Sound, each listed by its own rule, and each kept
 *   with its one line while open after its reason ends.
 * - sl-3: the clock chip into Time with focus on its tab, the clock's toasts while
 *   Time or the Log is on screen or neither, and the chip from a Sound
 *   subpage below with a name typed and focused.
 * - sl-4: Sound's two views: the start with nothing stored, Up next's fold
 *   kept over a reload, the view, search and scroll reset on each open,
 *   kept through a turn across 900 px, a switch of view at its top, the
 *   idle line's Library link, and Pause in a phone's half sheet.
 * - sl-5: a track's page from a search, and Back to it.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-three, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 53;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-timesound-"));
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
  roomName: `E2E time and sound ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  playlist: randomUUID(),
  music: [] as string[],
  names: [] as string[],
  tavern: [] as string[],
  loop: "",
};

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 568 };
/** Under 900 px, so the side panel's Sound becomes the phone's sheet. */
const NARROW = { width: 860, height: 900 };
const HOUR = 3_600;

const PLACES = ["Tavern", "Harbor", "Forest", "Crypt", "Market", "Mountain pass", "Swamp", "Castle", "Desert", "Sewer"];
const MOODS = ["at dusk", "at night", "in the rain", "theme", "chase", "lament", "festival", "watch", "at dawn", "storm"];
const FOLDS_KEY = "rvtt.soundFolds";

/** A panel in the side panel on the desk, from More where the row has no room for it. */
async function sideTab(title: string, page: Page = dm): Promise<Locator> {
  await openSideTab(page, title);
  return page.getByRole("tabpanel", { name: sideTabName(title) });
}

/** A panel's sheet on a phone, opened from the Panels list unless it shows already. */
async function sheet(page: Page, title: string): Promise<Locator> {
  const box = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  // Just after a turn below 900 px the side panel's open panel becomes the sheet on the next frames.
  if (await box.waitFor({ timeout: 1_000 }).then(() => true, () => false)) return box;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await box.waitFor();
  return box;
}

async function closeSheet(box: Locator): Promise<void> {
  await box.getByRole("button", { name: /^Close / }).first().click();
  await box.waitFor({ state: "detached" });
}

/** The names in a page's Panels list, opened and closed again. */
async function panelsList(page: Page): Promise<string[]> {
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  const region = page.getByRole("region", { name: "Panels" });
  await region.waitFor();
  const items = await region.getByRole("list", { name: "Panels" }).evaluate((ul) =>
    Array.from((ul as unknown as { querySelectorAll(s: string): ArrayLike<{ querySelector(s: string): { textContent: string | null } | null; hasAttribute(n: string): boolean }> }).querySelectorAll(":scope > li")).map((li) => {
      const heading = li.querySelector("h2, h3, h4");
      if (heading) return `# ${heading.textContent?.trim() ?? ""}`;
      if (li.hasAttribute("aria-hidden")) return "---";
      return (li.querySelector("button")?.textContent ?? "").replace(/\d+ unread$/, "").trim();
    }),
  );
  await region.getByRole("button", { name: "Close Panels" }).click();
  await region.waitFor({ state: "detached" });
  return items;
}

/** The view row of the DM's Sound, a radio group named Sound (4.1), and its option by name. */
function view(panel: Locator, name: "Now playing" | "Library"): Locator {
  return panel.getByRole("radiogroup", { name: "Sound", exact: true }).getByRole("radio", { name, exact: true });
}

async function showView(panel: Locator, name: "Now playing" | "Library"): Promise<void> {
  await view(panel, name).click();
  await waitFor(`${name} chosen`, async () => ((await view(panel, name).isChecked()) ? true : null), 5_000);
}

function search(panel: Locator): Locator {
  return panel.getByRole("searchbox", { name: "Search music" });
}

function upNextFold(panel: Locator): Locator {
  return panel.getByRole("button", { name: "Up next", exact: true });
}

/** What a fold's header says beside its name: its summary, which also describes its button. */
function summaryOf(button: Locator): Promise<string> {
  return button.evaluate((el) => {
    const id = (el.getAttribute("aria-describedby") ?? "").split(" ")[0] ?? "";
    return id ? (el.ownerDocument.getElementById(id)?.textContent ?? "") : "";
  });
}

async function forgetFolds(page: Page = dm): Promise<void> {
  await page.evaluate((key) => localStorage.removeItem(key), FOLDS_KEY);
}

function storedFolds(page: Page = dm): Promise<Record<string, boolean>> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, boolean>, FOLDS_KEY);
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
}

/** The box that scrolls `el`'s panel, the sheet's body or the side panel's pane: its offset and how far it can go. */
function scrolled(el: Locator): Promise<{ top: number; max: number }> {
  return el.evaluate((node) => {
    let box = node.parentElement;
    while (box && !/(auto|scroll)/.test(node.ownerDocument.defaultView!.getComputedStyle(box).overflowY)) box = box.parentElement;
    return box ? { top: Math.round(box.scrollTop), max: box.scrollHeight - box.clientHeight } : { top: -1, max: -1 };
  });
}

/** Scrolls the box that scrolls `el`'s panel to its end, as a hand on the wheel does, and returns where it stopped. */
async function toFoot(el: Locator): Promise<number> {
  await el.evaluate((node) => {
    let box = node.parentElement;
    while (box && !/(auto|scroll)/.test(node.ownerDocument.defaultView!.getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  });
  // The keeper writes the offset on the scroll's own event, a frame later.
  await el.page().waitForTimeout(300);
  return (await scrolled(el)).top;
}

/** How far `el` sits inside the box that scrolls it: its bottom's distance above the box's visible bottom (negative when cut), and its top below the box's top. */
function inScroller(el: Locator): Promise<{ bottom: number; top: number }> {
  return el.evaluate((node) => {
    let box = node.parentElement;
    while (box && !/(auto|scroll)/.test(node.ownerDocument.defaultView!.getComputedStyle(box).overflowY)) box = box.parentElement;
    const r = node.getBoundingClientRect();
    const b = (box ?? node.ownerDocument.documentElement).getBoundingClientRect();
    return { bottom: Math.round((b.bottom - r.bottom) * 10) / 10, top: Math.round((r.top - b.top) * 10) / 10 };
  });
}

/** Rain's page, a Sound subpage, from Background's Edit. */
async function openLoopPage(panel: Locator): Promise<void> {
  const background = panel.getByRole("heading", { name: "Background", exact: true }).locator("xpath=ancestor::section[1]");
  const row = background.getByRole("button", { name: /^Edit Rain/ });
  if ((await row.count()) === 0) await background.getByRole("button", { name: "Edit", exact: true }).click();
  await row.click();
  await panel.getByRole("textbox", { name: "Name" }).waitFor();
}

function nameOf(id: string): string {
  return run.names[run.music.indexOf(id)]!;
}

/** Tavern night from its first track. */
async function playTavern(): Promise<void> {
  const id = randomUUID();
  await ops.send({ t: "music.play", run: id, playlistId: run.playlist, order: run.tavern, index: 0, repeat: "all", fade: 5 });
  await waitFor("Tavern night playing", () => (dmSocket.state?.playing?.music?.run === id ? true : null));
}

async function startClock(shown = true): Promise<void> {
  await ops.send({ t: "clock.start", id: randomUUID(), at: 2 * 86_400 + 20 * HOUR, shown, calendar: { kind: "days" } });
  await waitFor("a clock", () => (dmSocket.state?.clock ? true : null));
}

async function stopClock(): Promise<void> {
  if (dmSocket.state?.clock) await ops.send({ t: "clock.stop" });
  await waitFor("no clock", () => (dmSocket.state?.clock == null ? true : null));
}

describe("Time and Sound as panels", { concurrency: false }, () => {
  before(async () => {
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

  test("sl-0. a DM's room with Pat on a phone, 100 music tracks with Tavern night playing, and a background sound", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });

    // 100 tracks on four files, so Library is long enough to scroll far (4.4).
    const assets: { id: string; ms: number }[] = [];
    for (const ms of [95_000, 128_000, 151_000, 174_000]) {
      const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=sound`, { headers: { Origin: server.origin, "content-type": "audio/mpeg" }, data: Buffer.from(silentFrames(framesFor(ms), { kbps: 64 })) });
      assert.ok(res.ok(), `upload answered ${res.status()}`);
      assets.push({ id: ((await res.json()) as { id: string }).id, ms });
    }
    const names = ["The Prancing Pony", "Road to Phandalin", "Night watch"];
    for (const p of PLACES) for (const m of MOODS) if (names.length < 100) names.push(`${p} ${m}`);
    for (let i = 0; i < names.length; i++) {
      const a = assets[i % assets.length]!;
      const id = randomUUID();
      await ops.send({ t: "sound.create", id, assetId: a.id, name: names[i]!, use: "music", ms: a.ms });
      run.music.push(id);
    }
    run.names = names;
    run.tavern = run.music.slice(0, 12);
    await ops.send({ t: "playlist.create", id: run.playlist, name: "Tavern night", sounds: run.tavern, repeat: "all", fade: 5 });
    run.loop = await addSound({ context: dmContext, origin: server.origin, roomId: run.roomId, ops, id: randomUUID(), name: "Rain", use: "loop", ms: 3_000 });
    await waitFor("the library in the DM's copy", () => (Object.keys(dmSocket.state?.sounds ?? {}).length === 101 ? true : null));

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  test("sl-1a. on a phone the DM's Run the table lists DM, Scenes, Sound and Time, and no Ambiance", async (t) => {
    t.after(async () => {
      await dm.setViewportSize(DESK);
      await reload(dm);
    });
    await dm.setViewportSize(PHONE);
    await reload(dm);
    const list = await panelsList(dm);
    const from = list.indexOf("# Run the table");
    assert.deepEqual(list.slice(from, from + 5), ["# Run the table", "DM", "Scenes", "Sound", "Time"]);
    assert.equal(list.includes("Ambiance"), false);
  });

  test("sl-1b. the side panel's row: at 360 px Token to Log with Sound then Time in More, at 640 px Sound the last tab and Time first in More", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.sidePanelWidth"));
      await reload(dm);
    });
    const list = dm.getByRole("tablist", { name: "Panels" });
    const row = () => list.locator('[role="tab"]:not([aria-haspopup])').evaluateAll((els) => els.map((el) => el.getAttribute("data-stop") ?? ""));
    /** More's panels, by their titles, in order. */
    const inMore = async () => {
      await list.locator('[role="tab"][aria-haspopup="menu"]').click();
      const menu = dm.getByRole("menu", { name: "More panels" });
      await menu.waitFor();
      const items = await menu.getByRole("menuitemradio").evaluateAll((els) => els.map((el) => (el.querySelector("span:not([aria-hidden])")?.textContent ?? "").trim()));
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      return items;
    };
    await list.getByRole("tab").first().waitFor();
    assert.deepEqual(await row(), ["token", "tracker", "dice", "log"]);
    const more = await inMore();
    assert.deepEqual(more.slice(more.indexOf("Scenes"), more.indexOf("Scenes") + 3), ["Scenes", "Sound", "Time"]);
    assert.equal(more.includes("Ambiance"), false);

    await dm.evaluate(() => localStorage.setItem("rvtt.sidePanelWidth", "640"));
    await reload(dm);
    await list.getByRole("tab").first().waitFor();
    assert.deepEqual((await row()).slice(-3), ["dm", "scenes", "sound"], "Sound takes the ninth tab, Time waits in More");
    assert.equal((await inMore())[0], "Time");
    await shots.take(dm, "sl-1b-row-640");
  });

  test("sl-1c. Ambiance's old id opens Sound: a stored split under Initiative, and a reload's reopen", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.sidePanelSplit"));
      await reload(dm);
    });
    await dm.evaluate(() => localStorage.setItem("rvtt.sidePanelSplit", JSON.stringify({ dm: { top: "tracker", below: "ambiance" } })));
    await reload(dm);
    const below = dm.getByRole("group", { name: "Sound below", exact: true });
    await view(below, "Now playing").waitFor();
    assert.equal(await view(below, "Now playing").isChecked(), true);
    await dm.evaluate(() => localStorage.removeItem("rvtt.sidePanelSplit"));
    await dm.evaluate((roomId) => sessionStorage.setItem("rvtt.reopen", JSON.stringify({ roomId, panel: "ambiance" })), run.roomId);
    await reload(dm);
    await view(dm.getByRole("tabpanel", { name: sideTabName("Sound") }), "Now playing").waitFor();
  });

  test("sl-2. Pat's Time and Sound: each listed by its own reason, and each kept open with its one line after its reason ends, until closed", async () => {
    await stopClock();
    await ops.send({ t: "sound.stopAll" });
    await waitFor("nothing for Pat", () => (patSocket.state?.clock == null && !patSocket.state?.playing?.music ? true : null));
    let list = await panelsList(pat);
    assert.equal(list.some((n) => n === "Time" || n === "Sound"), false, `nothing shared or playing: neither listed (${list.join(", ")})`);

    // The clock shared, nothing playing: Time alone.
    await startClock();
    await waitFor("Pat's clock", () => (patSocket.state?.clock ? true : null));
    list = await panelsList(pat);
    assert.equal(list.includes("Time"), true, "Time listed");
    assert.equal(list.includes("Sound"), false, "Sound not listed");
    const time = await sheet(pat, "Time");
    await time.locator("[data-clock-date]").waitFor();
    await ops.send({ t: "clock.update", shown: false });
    await time.getByText("The DM isn't sharing the date and time now.", { exact: true }).waitFor();
    assert.deepEqual(alignmentLines(await measureAlignment(time), "Pat's Time, kept, 390x844"), []);
    await shots.take(pat, "sl-2-pat-time-kept");
    await closeSheet(time);
    assert.equal((await panelsList(pat)).includes("Time"), false, "closed, Time leaves the list");

    // Music on: Sound listed, and a card with no name while the DM keeps the names.
    await playTavern();
    await waitFor("Pat's music", () => (patSocket.state?.playing?.music ? true : null));
    const sound = await sheet(pat, "Sound");
    await sound.locator("[data-sound-player-card]").getByText("Music is playing", { exact: true }).waitFor();
    assert.equal((await sound.innerText()).includes(nameOf(run.tavern[0]!)), false, "no track's name while the DM keeps the names");
    assert.deepEqual(alignmentLines(await measureAlignment(sound), "Pat's Sound, 390x844"), []);
    await shots.take(pat, "sl-2-pat-sound-card");
    await ops.send({ t: "sound.stopAll" });
    await sound.getByText("Nothing is playing.", { exact: true }).waitFor();
    await closeSheet(sound);
    assert.equal((await panelsList(pat)).includes("Sound"), false, "closed, Sound leaves the list");
    await ops.send({ t: "clock.update", shown: true });
  });

  test("sl-3a. the clock chip opens Time with focus on its tab, and a clock step comes as a toast only while neither Time nor the Log is on screen", async () => {
    await stopClock();
    await startClock();
    await sideTab("Sound");
    const chip = dm.getByRole("button", { name: /^Time: / });
    await chip.click();
    const time = dm.getByRole("tabpanel", { name: sideTabName("Time") });
    await time.locator("[data-clock-date]").waitFor();
    // The top panel's name takes focus: its chosen tab, here More named Time (docs/design/design-v1-split-panel.md 9.2).
    const tab = dm.getByRole("tablist", { name: "Panels" }).getByRole("tab", { name: sideTabName("Time"), selected: true });
    await waitFor("focus on Time's tab", () => tab.evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)), 5_000);
    await shots.take(dm, "sl-3a-chip-time");

    // Time on screen: the step shows there, and no toast comes.
    await ops.send({ t: "clock.advance", by: HOUR });
    await time.locator("[data-clock-time]").filter({ hasText: /^9:00 PM/ }).waitFor();
    await dm.waitForTimeout(500);
    const toasts = dm.locator("[data-toast]").filter({ hasText: /1 hour passes\. It is now / });
    assert.equal(await toasts.count(), 0, "no toast while Time is on screen");
    // The Log on screen: its line says it.
    await sideTab("Log");
    await ops.send({ t: "clock.advance", by: HOUR });
    await waitFor("the step", () => (dmSocket.state?.clock?.t === 2 * 86_400 + 22 * HOUR ? true : null));
    await dm.waitForTimeout(500);
    assert.equal(await toasts.count(), 0, "no toast while the Log is on screen");
    // Sound on screen: neither shows it, so a toast does.
    await sideTab("Sound");
    await ops.send({ t: "clock.advance", by: HOUR });
    await toasts.filter({ hasText: /Day 3, 11:00 PM/ }).first().waitFor();
  });

  test("sl-3b. the chip with Sound below on a subpage, a name typed and focused: the name saves, Time opens on top, and Sound keeps its subpage", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.sidePanelSplit"));
      await reload(dm);
    });
    await dm.evaluate(() => localStorage.setItem("rvtt.sidePanelSplit", JSON.stringify({ dm: { top: "tracker", below: "sound" } })));
    await reload(dm);
    const below = dm.getByRole("group", { name: "Sound below", exact: true });
    await view(below, "Now playing").waitFor();
    await openLoopPage(below);
    const field = below.getByRole("textbox", { name: "Name" });
    await field.fill("Rain at night");
    assert.equal(await field.evaluate((el) => el === el.ownerDocument.activeElement), true, "the name keeps focus");
    // A dispatched click moves no focus, as Safari's and the chip's own press do not (D-261102-763).
    await dm.getByRole("button", { name: /^Time: / }).dispatchEvent("click");
    await waitFor("Rain at night saved", () => (dmSocket.state?.sounds?.[run.loop]?.name === "Rain at night" ? true : null));
    const time = dm.getByRole("tabpanel", { name: sideTabName("Time") });
    await time.locator("[data-clock-date]").waitFor();
    await below.getByRole("button", { name: /^Back to Sound/ }).waitFor();
    assert.equal(await below.getByRole("textbox", { name: "Name" }).inputValue(), "Rain at night", "Sound below keeps Rain's page");
    await shots.take(dm, "sl-3b-time-over-sound-subpage");
  });

  test("sl-4a. Sound opens with nothing stored on Now playing at its top, the player whole, and Up next folded with the next track", async () => {
    await playTavern();
    await forgetFolds();
    await sideTab("Log");
    const panel = await sideTab("Sound");
    assert.equal(await view(panel, "Now playing").isChecked(), true);
    const player = panel.locator("[data-sound-player]");
    await player.getByRole("button", { name: "Pause", exact: true }).waitFor();
    assert.equal((await scrolled(player)).top, 0, "at its top");
    for (const name of ["Pause", "Skip to the next track", "Stop all sound"]) {
      const at = await inScroller(panel.getByRole("button", { name, exact: true }));
      assert.ok(at.top >= 0 && at.bottom >= 0, `${name} in view without scrolling (${JSON.stringify(at)})`);
    }
    const fold = upNextFold(panel);
    assert.equal(await fold.getAttribute("aria-expanded"), "false", "Up next folded on every width with nothing stored");
    assert.equal(await summaryOf(fold), `Next: ${nameOf(run.tavern[1]!)}`);
    assert.deepEqual(alignmentLines(await measureAlignment(panel), "Sound's Now playing, 1440x900"), []);
    await shots.take(dm, "sl-4a-now-playing");
  });

  test("sl-4b. Up next opened by a tap says its count and is kept open over a reload", async (t) => {
    t.after(() => forgetFolds());
    let panel = await sideTab("Sound");
    await upNextFold(panel).click();
    assert.deepEqual(await storedFolds(), { upnext: true });
    assert.match(await summaryOf(upNextFold(panel)), /^11 tracks · \d+ min$/);
    await panel.getByRole("list", { name: "Up next" }).waitFor();
    await reload(dm);
    panel = await sideTab("Sound");
    assert.equal(await upNextFold(panel).getAttribute("aria-expanded"), "true", "open after a reload");
    await upNextFold(panel).click();
    assert.equal(await upNextFold(panel).getAttribute("aria-expanded"), "false");
  });

  test("sl-4c. Library at the foot of 100 tracks, or with a search, then Sound closed and opened: Now playing at its top and the search empty", async () => {
    let panel = await sideTab("Sound");
    await showView(panel, "Library");
    await panel.getByRole("list", { name: "Tracks" }).locator("[data-music-row]").nth(99).waitFor();
    const foot = await toFoot(search(panel));
    assert.ok(foot > 2_000, `Library is long: its foot at ${foot} px`);
    await sideTab("Log");
    panel = await sideTab("Sound");
    assert.equal(await view(panel, "Now playing").isChecked(), true, "back on Now playing");
    await panel.locator("[data-sound-player]").getByRole("button", { name: "Pause", exact: true }).waitFor();
    assert.equal((await scrolled(panel.locator("[data-sound-player]"))).top, 0, "at its top, never Library's offset");

    await showView(panel, "Library");
    await search(panel).fill("harbor");
    await sideTab("Log");
    panel = await sideTab("Sound");
    assert.equal(await view(panel, "Now playing").isChecked(), true);
    await showView(panel, "Library");
    assert.equal(await search(panel).inputValue(), "", "the search starts empty at each opening");
  });

  test("sl-4d. Library searched and at its foot keeps its view, its search and its place at the foot through a turn across 900 px and back", async (t) => {
    t.after(() => dm.setViewportSize(DESK));
    const want = run.names.filter((n) => n.toLowerCase().includes("at")).length;
    let panel = await sideTab("Sound");
    await showView(panel, "Library");
    await search(panel).fill("at");
    await waitFor(`${want} rows`, async () => ((await panel.getByRole("list", { name: "Tracks" }).locator("[data-music-row]").count()) === want ? true : null), 5_000);
    const foot = await toFoot(search(panel));
    assert.ok(foot > 500, `a long list: its foot at ${foot} px`);

    // The open side panel's Sound becomes the sheet, never opened afresh, which would start it over.
    await dm.setViewportSize(NARROW);
    const narrow = dm.locator('dialog[data-rvtt-sheet][aria-label="Sound"]');
    await search(narrow).waitFor();
    assert.equal(await view(narrow, "Library").isChecked(), true, "still Library as the sheet");
    assert.equal(await search(narrow).inputValue(), "at");
    // The keeper holds a place at the foot as the foot, so the shorter sheet still shows the list's last rows (panels.ts scrollOf), not the side panel's offset.
    const lastInView = async (panel: Locator) => {
      const at = await inScroller(panel.getByRole("list", { name: "Tracks" }).locator("[data-music-row]").last());
      return at.top >= 0 && at.bottom >= 0 ? true : null;
    };
    await waitFor("the sheet on Library's last rows", () => lastInView(narrow), 5_000).catch(async () => assert.fail(`the sheet at ${JSON.stringify(await scrolled(search(narrow)))}, Library left at its foot, ${foot}`));
    // Recorded, not asserted: the place is put back before the storage line under the list has loaded, which can leave a few px under the foot.
    console.log(`sl-4d: the sheet at ${JSON.stringify(await scrolled(search(narrow)))} after the turn`);
    await shots.take(dm, "sl-4d-library-sheet");

    await dm.setViewportSize(DESK);
    panel = dm.getByRole("tabpanel", { name: sideTabName("Sound") });
    await search(panel).waitFor();
    assert.equal(await view(panel, "Library").isChecked(), true, "Library again in the side panel");
    assert.equal(await search(panel).inputValue(), "at");
    await waitFor("the side panel on Library's last rows", () => lastInView(panel), 5_000).catch(async () => assert.fail(`the side panel at ${JSON.stringify(await scrolled(search(panel)))}, Library left at its foot, ${foot}`));
    console.log(`sl-4d: the side panel at ${JSON.stringify(await scrolled(search(panel)))} after the turn back, left at ${foot}`);
    await search(panel).fill("");
  });

  test("sl-4e. Library at its foot, then a switch to Now playing in the open panel: Now playing at its top, and Library again at its top", async () => {
    const panel = await sideTab("Sound");
    await showView(panel, "Library");
    await search(panel).fill("");
    await panel.getByRole("list", { name: "Tracks" }).locator("[data-music-row]").nth(99).waitFor();
    const foot = await toFoot(search(panel));
    assert.ok(foot > 2_000, `Library is long: its foot at ${foot} px`);
    // The search row sticks to the top of the scroller while the list scrolls under it (4.4).
    assert.ok(Math.abs((await inScroller(search(panel))).top) <= 16, `the search stays in view at the foot (${JSON.stringify(await inScroller(search(panel)))})`);
    // A pressed option that moves no scroll, as a key's does: Playwright's own click would first scroll the view row into sight, which is near the top already.
    const pick = async (name: "Now playing" | "Library") => {
      await view(panel, name).dispatchEvent("click");
      await waitFor(`${name} chosen`, async () => ((await view(panel, name).isChecked()) ? true : null), 5_000);
    };
    await pick("Now playing");
    const player = panel.locator("[data-sound-player]");
    await player.getByRole("button", { name: "Pause", exact: true }).waitFor();
    assert.equal((await scrolled(player)).top, 0, "Now playing starts at its top");
    assert.ok((await toFoot(player)) > 200, "Now playing scrolled down");
    await pick("Library");
    await search(panel).waitFor();
    assert.equal((await scrolled(search(panel))).top, 0, "and Library at its top, never Now playing's offset");
  });

  test("sl-4f. with nothing playing, the idle line's Library link moves the view to Library and focus to its search", async () => {
    await ops.send({ t: "sound.stopAll" });
    await waitFor("silence", () => (!dmSocket.state?.playing?.music ? true : null));
    const panel = await sideTab("Sound");
    await showView(panel, "Now playing");
    const idle = panel.locator("[data-music-idle]");
    await idle.getByText(/^No music is playing\. Pick a playlist or a track in Library\.$/).waitFor();
    await shots.take(dm, "sl-4f-idle");
    await idle.getByRole("button", { name: "Library", exact: true }).click();
    await waitFor("Library chosen", async () => ((await view(panel, "Library").isChecked()) ? true : null), 5_000);
    await waitFor("focus on the search", () => search(panel).evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)), 5_000);
  });

  test("sl-4g. a phone's half sheet holds the player's Pause whole at 390 x 844 and 320 x 568, and 130% is recorded", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
      await dm.setViewportSize(DESK);
      await reload(dm);
    });
    await playTavern();
    for (const size of [PHONE, SMALL]) {
      await dm.setViewportSize(size);
      await reload(dm);
      const box = await sheet(dm, "Sound");
      const pause = box.locator("[data-sound-player]").getByRole("button", { name: "Pause", exact: true });
      await pause.waitFor();
      const at = await inScroller(pause);
      assert.ok(at.bottom >= 0, `Pause's foot ${-at.bottom} px under the half sheet at ${size.width} x ${size.height}`);
      assert.deepEqual(alignmentLines(await measureAlignment(box), `Sound's sheet, ${size.width}x${size.height}`), []);
      await shots.take(dm, `sl-4g-pause-${size.width}`);
      await closeSheet(box);
    }
    for (const size of [PHONE, SMALL]) {
      await dm.setViewportSize(size);
      await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
      await reload(dm);
      const box = await sheet(dm, "Sound");
      const at = await inScroller(box.locator("[data-sound-player]").getByRole("button", { name: "Pause", exact: true }));
      // Recorded, not asserted (4.6): at 320 x 568 and 130% Pause falls below the half sheet, as it did before.
      console.log(`sl-4g: Pause at ${size.width} x ${size.height} and 130% sits ${at.bottom} px above the half sheet's foot`);
      await closeSheet(box);
    }
  });

  test("sl-5. a track's page from a search for harbor, and Back to Library with the search and its 10 rows", async () => {
    const panel = await sideTab("Sound");
    await showView(panel, "Library");
    await search(panel).fill("harbor");
    const rows = panel.getByRole("list", { name: "Tracks" }).locator("[data-music-row]");
    await waitFor("ten rows", async () => ((await rows.count()) === 10 ? true : null), 5_000);
    await panel.getByRole("heading", { name: /^Tracks/ }).filter({ hasText: "10 of 100" }).waitFor();
    const track = run.names.find((n) => n.startsWith("Harbor"))!;
    await panel.getByRole("list", { name: "Tracks" }).getByRole("button", { name: `More for ${track}`, exact: true }).click();
    await dm.getByRole("menuitem", { name: "Rename or delete…", exact: true }).click();
    // The side panel's header holds a subpage's Back, above the tab panel.
    const back = dm.getByRole("button", { name: /^Back to Sound/ }).first();
    await back.waitFor();
    assert.equal(await panel.getByRole("textbox", { name: "Name" }).inputValue(), track);
    assert.equal(await view(panel, "Library").count(), 0, "the page stands in for the view row");
    assert.deepEqual(alignmentLines(await measureAlignment(panel), "a track's page, 1440x900"), []);
    await shots.take(dm, "sl-5-track-page");
    await back.click();
    await search(panel).waitFor();
    assert.equal(await view(panel, "Library").isChecked(), true, "Back returns to Library");
    assert.equal(await search(panel).inputValue(), "harbor");
    assert.equal(await rows.count(), 10);
    await search(panel).fill("");
  });

  test("sl-z. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
