import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import yauzl from "yauzl";
import yazl from "yazl";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { openGroup } from "./helpers/groups.ts";
import { addSound } from "./soundRoom.ts";

/**
 * Ambiance (docs/design/design-v1-panel-groups.md 4 to 6 and 10), on the real
 * server serving the production build with ROOM_SOUND on. Dana the DM is at
 * a desk, and on a phone where a step says so. Pat plays on a phone.
 * - am-0: the room, Pat, a scene named Goblin cave, a playlist of two
 *   tracks and a background sound.
 * - am-1: the starts with nothing stored, with and without a clock, the
 *   clock started from the open form and a turn across 900 px, Time folded
 *   by hand with no clock, a reload with Ambiance open under Initiative,
 *   and Pause inside a phone's half sheet.
 * - am-2: a fold this device tapped, kept over a reload.
 * - am-3: the top bar's chip with Time folded, and from a Sound subpage with
 *   a name typed and focused, and Back keeping Other amount and the start
 *   form as they were left.
 * - am-5: the folded summaries and the Weather row follow the room, and a
 *   clock step comes as a toast while a Sound subpage covers an open Time.
 * - am-6: Pat's Ambiance: listed, kept sections, a turn across 900 px, a
 *   restored split with Sound's old id, a reload that asks for Time's, and
 *   the chip's press after press with Time scrolled out of the pane.
 * - am-4: the Weather and Scene sound rows into Scenes, on a phone at 100%
 *   and at 320 x 568 and 130%, with two panels, and on a tall sheet under
 *   900 px with little under each group. Then a room with no
 *   scene, imported from this room's backup with its scenes taken out: the
 *   Weather row only opens Scenes, New scene starts open there and a fold
 *   of it is kept, and the first scene made sets nothing off.
 * The DM panel's and This device's folds (the design's am-7 and am-8) are
 * covered where those surfaces are built: joinrequests, paste, shortcuts.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-three, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 53;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-ambiance-"));
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
  roomName: `E2E ambiance ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  scene: "",
  other: randomUUID(),
  playlist: randomUUID(),
  music: [] as string[],
  loop: "",
  bare: "",
};

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 568 };
/** A tablet held upright: a sheet, not the side panel, and a tall one. */
const TABLET = { width: 820, height: 1180 };
const HOUR = 3_600;

const FOLDS_KEY = "rvtt.ambianceFolds";

/** The DM's Ambiance in the side panel on the desk. */
async function ambiance(page: Page = dm): Promise<Locator> {
  await openSideTab(page, "Ambiance");
  const panel = page.getByRole("tabpanel", { name: sideTabName("Ambiance") });
  // The panel's code loads the first time it opens.
  await panel.locator("[data-group-name], p").first().waitFor();
  return panel;
}

/** Ambiance's sheet on a phone, opened from the Panels list unless it shows. */
async function ambianceSheet(page: Page): Promise<Locator> {
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Ambiance"]');
  // Just after a turn below 900 px the side panel's open Ambiance becomes the sheet on the next frames.
  if (await sheet.waitFor({ timeout: 1_000 }).then(() => true, () => false)) {
    await sheet.locator("[data-group-name], p").first().waitFor();
    return sheet;
  }
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Ambiance/ }).click();
  await sheet.locator("[data-group-name], p").first().waitFor();
  return sheet;
}

async function closeSheet(sheet: Locator): Promise<void> {
  await sheet.getByRole("button", { name: /^Close / }).first().click();
  await sheet.waitFor({ state: "detached" });
}

/** A group's fold, by its name. */
const fold = (panel: Locator, name: string) => panel.locator("[data-group-fold]").filter({ has: panel.page().locator("[data-group-name]", { hasText: new RegExp(`^${name}$`) }) });

async function expanded(panel: Locator, name: string): Promise<boolean> {
  return (await fold(panel, name).getAttribute("aria-expanded")) === "true";
}

/** What a group's header says beside its name: its summary, which also describes its button. */
function summaryOf(button: Locator): Promise<string> {
  return button.evaluate((el) => {
    const id = (el.getAttribute("aria-describedby") ?? "").split(" ")[0] ?? "";
    return id ? (el.ownerDocument.getElementById(id)?.textContent ?? "") : "";
  });
}

async function summaryIs(button: Locator, want: string): Promise<void> {
  await waitFor(`the summary "${want}"`, async () => ((await summaryOf(button)) === want ? true : null), 10_000).catch(async () => assert.equal(await summaryOf(button), want));
}

/** Nothing this device stored of Ambiance's folds, as a device that never tapped one. */
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

/** The box that scrolls `el`'s panel: the sheet's body or the side panel's pane. Scrolls it by `by` px, or to its end with Infinity. */
function scrollPanel(el: Locator, by: number): Promise<void> {
  return el.evaluate((node, by) => {
    let box = node.parentElement;
    while (box && !/(auto|scroll)/.test(node.ownerDocument.defaultView!.getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box) box.scrollTop = by === Infinity ? box.scrollHeight : box.scrollTop + by;
  }, by);
}

/** Every box around `el`'s scroller that is scrolled, and the page's own scroll: none, where only the panel's body moved. */
function framesScrolled(el: Locator): Promise<string[]> {
  return el.evaluate((node) => {
    const win = node.ownerDocument.defaultView!;
    let box = node.parentElement;
    while (box && !/(auto|scroll)/.test(win.getComputedStyle(box).overflowY)) box = box.parentElement;
    const out: string[] = [];
    for (let at = box?.parentElement ?? null; at; at = at.parentElement) if (at.scrollTop !== 0) out.push(`${at.tagName.toLowerCase()} ${at.scrollTop}`);
    if (win.scrollY !== 0) out.push(`the page ${win.scrollY}`);
    return out;
  });
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

async function playMusic(): Promise<void> {
  await ops.send({ t: "sound.stopAll" });
  await ops.send({ t: "music.play", run: randomUUID(), playlistId: run.playlist, order: run.music, index: 0, repeat: "all", fade: 5 });
  await waitFor("the music in the DM's copy", () => (dmSocket.state?.playing?.music ? true : null));
}

async function startClock(shown = true): Promise<void> {
  await ops.send({ t: "clock.start", id: randomUUID(), at: 2 * 86_400 + 20 * HOUR, shown, calendar: { kind: "days" } });
  await waitFor("a clock", () => (dmSocket.state?.clock ? true : null));
}

async function stopClock(): Promise<void> {
  if (dmSocket.state?.clock) await ops.send({ t: "clock.stop" });
  await waitFor("no clock", () => (dmSocket.state?.clock == null ? true : null));
}

/** A zip's entries by name, folders left out. */
async function unzip(data: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((ok, no) => yauzl.fromBuffer(data, { lazyEntries: true }, (err, z) => (err || !z ? no(err) : ok(z))));
  const out = new Map<string, Buffer>();
  await new Promise<void>((ok, no) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith("/")) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return no(err);
        const parts: Buffer[] = [];
        stream.on("data", (c: Buffer) => parts.push(c));
        stream.on("error", no);
        stream.on("end", () => {
          out.set(entry.fileName, Buffer.concat(parts));
          zip.readEntry();
        });
      });
    });
    zip.on("error", no);
    zip.on("end", () => ok());
    zip.readEntry();
  });
  return out;
}

function zipOf(entries: Map<string, Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  return new Promise((ok, no) => {
    const parts: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => parts.push(c));
    zip.outputStream.on("error", no);
    zip.outputStream.on("end", () => ok(Buffer.concat(parts)));
  });
}

/**
 * A room with no scene, for the DM's session (panel-groups 6.1, scenes-reorg 7).
 * No op empties a room (shared/reducer/room.ts keeps the last scene), but a
 * backup can hold none, so this room's backup is imported with its scenes and
 * everything on them taken out.
 */
async function noSceneRoom(): Promise<string> {
  const exported = await dmContext.request.get(`${server.origin}/api/rooms/${run.roomId}/export`);
  assert.ok(exported.ok(), `the backup answered ${exported.status()}`);
  const entries = await unzip(await exported.body());
  const room = JSON.parse(entries.get("room.json")!.toString("utf8")) as { state: Record<string, unknown> & { scenes: Record<string, unknown>; meta: { playerSceneId: string | null } } };
  const sceneIds = Object.keys(room.state.scenes);
  const onAScene = (id: string, entry: unknown) => sceneIds.some((s) => id.includes(s)) || (!!entry && typeof entry === "object" && sceneIds.includes((entry as { sceneId?: string }).sceneId ?? ""));
  for (const [key, value] of Object.entries(room.state)) {
    if (key === "members" || key === "meta" || !value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) if (onAScene(id, entry)) delete (value as Record<string, unknown>)[id];
  }
  room.state.scenes = {};
  room.state.meta.playerSceneId = null;
  entries.set("room.json", Buffer.from(JSON.stringify(room)));
  const form = Buffer.from(JSON.stringify({ playerPassword: run.password, dmName: "Dana the DM" })).toString("base64url");
  const res = await dmContext.request.post(`${server.origin}/api/rooms/import`, { headers: { Origin: server.origin, "content-type": "application/zip", "x-import-form": form }, data: await zipOf(entries) });
  assert.ok(res.ok(), `the import answered ${res.status()}: ${await res.text()}`);
  return ((await res.json()) as { roomId: string }).roomId;
}

describe("Ambiance", { concurrency: false }, () => {
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
    for (const roomId of [run.roomId, run.bare]) {
      if (!roomId || !dmContext) continue;
      try {
        const res = await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("am-0. a DM's room with Pat on a phone, Goblin cave, a playlist and a background sound", async () => {
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
    run.scene = dmSocket.state!.meta.playerSceneId!;
    await ops.send({ t: "scene.update", sceneId: run.scene, patch: { name: "Goblin cave" } });
    await ops.send({ t: "scene.create", scene: { id: run.other, name: "Crypt", bounds: { w: 20, h: 14 } } });
    const add = (name: string, use: "music" | "loop", ms: number) => addSound({ context: dmContext, origin: server.origin, roomId: run.roomId, ops, id: randomUUID(), name, use, ms });
    run.music = [await add("Harbor at dusk", "music", 31_000), await add("Road", "music", 32_000)];
    run.loop = await add("Rain", "loop", 3_000);
    await ops.send({ t: "playlist.create", id: run.playlist, name: "Tavern night", sounds: run.music, repeat: "all", fade: 5 });

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

  test("am-1a. the desk with nothing stored and no clock: Time open on its start form, the Weather row, Sound open, no line under the header", async () => {
    await forgetFolds();
    const panel = await ambiance();
    assert.deepEqual(await panel.locator("[data-group-name]").allTextContents(), ["Time", "Weather", "Sound"]);
    assert.equal(await expanded(panel, "Time"), true);
    await panel.getByRole("button", { name: "Start the clock", exact: true }).waitFor();
    assert.equal(await expanded(panel, "Sound"), true);
    const row = panel.locator("[data-group-open]");
    assert.equal(await row.getAttribute("aria-label"), "Weather: Clear, in Goblin cave's settings");
    assert.equal(await row.getAttribute("aria-expanded"), null, "the Weather row never folds");
    assert.equal(await panel.locator("[data-panel-group]").first().evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).borderTopStyle), "none", "no line under the panel's header");
    assert.deepEqual(alignmentLines(await measureAlignment(panel), "Ambiance with no clock, 1440x900"), []);
    await shots.take(dm, "am-1a-desk-no-clock");
  });

  test("am-1b. the clock started from the open form keeps Time open through a turn across 900 px, until Ambiance closes", async () => {
    // Ambiance open in the side panel stays open as the phone's sheet.
    await dm.setViewportSize(PHONE);
    const sheet = dm.locator('dialog[data-rvtt-sheet][aria-label="Ambiance"]');
    await sheet.locator("[data-group-name]").first().waitFor();
    assert.equal(await expanded(sheet, "Time"), true);
    await sheet.getByRole("button", { name: "Start the clock", exact: true }).click();
    await waitFor("a clock", () => (dmSocket.state?.clock ? true : null));
    await sheet.locator("[data-clock-date]").waitFor();
    assert.equal(await expanded(sheet, "Time"), true, "starting the clock folds nothing under the DM's finger");
    await dm.setViewportSize(DESK);
    const panel = dm.getByRole("tabpanel", { name: sideTabName("Ambiance") });
    await panel.locator("[data-clock-date]").waitFor();
    assert.equal(await expanded(panel, "Time"), true, "a turn across 900 px keeps the held start");
    await openSideTab(dm, "Log");
    const again = await ambiance();
    assert.equal(await expanded(again, "Time"), false, "closed and opened again with a clock running: folded");
    assert.equal(await summaryOf(fold(again, "Time")), "Day 1, 8:00 AM", "the chip's text");
    assert.equal(await expanded(again, "Sound"), true);
    assert.deepEqual(await storedFolds(), {}, "nothing written");
    await shots.take(dm, "am-1b-desk-clock");
  });

  test("am-1c. a phone's half sheet at the compact start holds Pause whole at 320 x 568 and 390 x 844, and 130% is recorded", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
      await dm.setViewportSize(DESK);
      await reload(dm);
    });
    await playMusic();
    for (const size of [PHONE, SMALL]) {
      await dm.setViewportSize(size);
      const sheet = await ambianceSheet(dm);
      assert.equal(await expanded(sheet, "Time"), false);
      const pause = sheet.getByRole("button", { name: "Pause", exact: true });
      await pause.waitFor();
      const at = await inScroller(pause);
      assert.ok(at.bottom >= 0, `Pause's foot ${-at.bottom} px under the half sheet at ${size.width} x ${size.height}`);
      await shots.take(dm, `am-1c-pause-${size.width}`);
      await closeSheet(sheet);
    }
    for (const size of [PHONE, SMALL]) {
      await dm.setViewportSize(size);
      await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
      await reload(dm);
      const sheet = await ambianceSheet(dm);
      const at = await inScroller(sheet.getByRole("button", { name: "Pause", exact: true }));
      // Recorded, not asserted (10): at 320 x 568 and 130% Pause falls below the sheet, as any long panel does there.
      console.log(`am-1c: Pause at ${size.width} x ${size.height} and 130% sits ${at.bottom} px above the half sheet's foot`);
      await closeSheet(sheet);
    }
    await dm.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
  });

  test("am-1d. a reload with Initiative over Ambiance and a clock running: Time folded from the snapshot on, and Pause, Stop the music and Stop all sound in view", async () => {
    await forgetFolds();
    await dm.evaluate(() => localStorage.setItem("rvtt.sidePanelSplit", JSON.stringify({ dm: { top: "tracker", below: "ambiance" } })));
    await reload(dm);
    const pane = dm.getByRole("group", { name: "Ambiance below", exact: true });
    await pane.getByRole("button", { name: "Pause", exact: true }).waitFor();
    assert.equal(await expanded(pane, "Time"), false, "never held open by a read before the snapshot");
    for (const name of ["Pause", "Stop the music", "Stop all sound"]) {
      const at = await inScroller(pane.getByRole("button", { name, exact: true }));
      assert.ok(at.bottom >= 0 && at.top >= 0, `${name} in view without scrolling (${JSON.stringify(at)})`);
    }
    assert.deepEqual(alignmentLines(await measureAlignment(pane), "Initiative over Ambiance, 1440x900"), []);
    await shots.take(dm, "am-1d-initiative-over-ambiance");
    await dm.evaluate(() => localStorage.removeItem("rvtt.sidePanelSplit"));
    await reload(dm);
  });

  test("am-1e. with no clock, Time folded by hand stays folded when Ambiance is closed and opened again, saying Not started", async () => {
    await stopClock();
    await forgetFolds();
    await openSideTab(dm, "Log");
    const panel = await ambiance();
    assert.equal(await expanded(panel, "Time"), true, "no clock: open on the start form");
    await fold(panel, "Time").click();
    assert.equal(await expanded(panel, "Time"), false);
    await panel.getByRole("button", { name: "Play Crash for everyone", exact: true }).click();
    await openSideTab(dm, "Log");
    const again = await ambiance();
    assert.equal(await expanded(again, "Time"), false, "the DM's own fold wins over the start");
    assert.equal(await summaryOf(fold(again, "Time")), "Not started");
    assert.deepEqual(await storedFolds(), { time: false });
    await forgetFolds();
  });

  test("am-2. a fold this device tapped is kept over a reload", async () => {
    const panel = await ambiance();
    await fold(panel, "Sound").click();
    assert.deepEqual(await storedFolds(), { sound: false });
    await reload(dm);
    const again = await ambiance();
    assert.equal(await expanded(again, "Sound"), false);
    await summaryIs(fold(again, "Sound"), "Tavern night · 1 of 2");
    await fold(again, "Sound").click();
    await forgetFolds();
  });

  test("am-3a. the chip with Time folded opens Ambiance with Time open and at the top, never written", async () => {
    await startClock();
    await forgetFolds();
    await openSideTab(dm, "Log");
    const chip = dm.getByRole("button", { name: /^Time: / });
    await chip.click();
    const panel = dm.getByRole("tabpanel", { name: sideTabName("Ambiance") });
    await panel.waitFor();
    await waitFor("Time revealed", async () => ((await expanded(panel, "Time")) ? true : null));
    const head = await inScroller(fold(panel, "Time"));
    assert.ok(Math.abs(head.top) <= 8, `Time's header at the top of the body (${head.top} px)`);
    assert.deepEqual(await storedFolds(), {}, "a request writes nothing");
    await openSideTab(dm, "Log");
    assert.equal(await expanded(await ambiance(), "Time"), false, "closed and opened again: folded");
  });

  test("am-3b. the chip from a Sound subpage saves a typed playlist name and a typed sound name, then shows the first page with Time revealed", async () => {
    const chip = dm.getByRole("button", { name: /^Time: / });
    for (const page of [
      { open: /^Tavern night/, name: "Tavern night at dusk", saved: () => dmSocket.state?.playlists?.[run.playlist]?.name === "Tavern night at dusk" },
      { open: /^Road/, name: "Road at night", saved: () => dmSocket.state?.sounds?.[run.music[1]!]?.name === "Road at night" },
    ]) {
      const panel = await ambiance();
      await openSideTab(dm, "Log");
      await ambiance();
      await panel.getByRole("button", { name: page.open }).first().click();
      await dm.getByRole("button", { name: /^Back to Ambiance/ }).first().waitFor();
      const field = panel.getByRole("textbox", { name: "Name" });
      await field.fill(page.name);
      assert.equal(await field.evaluate((el) => el === el.ownerDocument.activeElement), true, "the name keeps focus");
      // A dispatched click moves no focus, as Safari's and the chip's own press do not (4.3, D-261102-763).
      await chip.dispatchEvent("click");
      await waitFor(`${page.name} saved`, () => (page.saved() ? true : null));
      await panel.getByRole("heading", { name: "Music", exact: true }).waitFor();
      assert.equal(await expanded(panel, "Time"), true, "Time revealed on the first page");
    }
  });

  test("am-3c. Back from a Sound subpage finds Other amount, and with no clock the start form, as they were left", async () => {
    const panel = await ambiance();
    await openGroup(panel, "Time");
    await panel.getByRole("button", { name: "Other amount…", exact: true }).click();
    await panel.getByLabel("Amount", { exact: true }).fill("3");
    await panel.getByRole("button", { name: /^Tavern night/ }).first().click();
    await dm.getByRole("button", { name: /^Back to Ambiance/ }).first().click();
    await panel.getByRole("heading", { name: "Music", exact: true }).waitFor();
    assert.equal(await panel.getByLabel("Amount", { exact: true }).inputValue(), "3");
    await stopClock();
    await panel.getByLabel("Day", { exact: true }).fill("5");
    await panel.getByRole("button", { name: /^Tavern night/ }).first().click();
    await dm.getByRole("button", { name: /^Back to Ambiance/ }).first().click();
    await panel.getByRole("heading", { name: "Music", exact: true }).waitFor();
    assert.equal(await panel.getByLabel("Day", { exact: true }).inputValue(), "5");
    await shots.take(dm, "am-3c-back-keeps-the-form");
    await forgetFolds();
  });

  test("am-5. folded, Time and Sound say what they hold, and the Weather row follows the scene in view", async (t) => {
    t.after(() => forgetFolds());
    await startClock();
    const panel = await ambiance();
    await openGroup(panel, "Time");
    await fold(panel, "Time").click();
    await fold(panel, "Sound").click();
    const time = fold(panel, "Time");
    const sound = fold(panel, "Sound");
    await summaryIs(time, "Day 3, 8:00 PM");
    // A step from another device: Ambiance shows with Time folded, so the clock's line comes as a toast (calendar 4.7).
    await ops.send({ t: "clock.advance", by: HOUR });
    await summaryIs(time, "Day 3, 9:00 PM");
    await dm.getByText(/^1 hour passes\. It is now Day 3, 9:00 PM/).first().waitFor();
    await ops.send({ t: "clock.update", shown: false });
    await summaryIs(time, "Day 3, 9:00 PM · Hidden");
    await ops.send({ t: "clock.update", shown: true });
    // With Time open on screen the step shows there, and no toast comes.
    await fold(panel, "Time").click();
    await ops.send({ t: "clock.advance", by: HOUR });
    await panel.locator("[data-clock-time]").filter({ hasText: /^10:00 PM/ }).waitFor();
    await dm.waitForTimeout(500);
    assert.equal(await dm.getByText(/^1 hour passes\. It is now Day 3, 10:00 PM/).count(), 0, "no toast while Time is open in Ambiance");
    await fold(panel, "Time").click();
    await summaryIs(time, "Day 3, 10:00 PM");

    await playMusic();
    // am-3b renamed the playlist.
    await summaryIs(sound, "Tavern night at dusk · 1 of 2");
    await ops.send({ t: "music.pause" });
    await summaryIs(sound, "Tavern night at dusk · 1 of 2 · Paused");
    await ops.send({ t: "loop.start", id: randomUUID(), soundId: run.loop, volume: 70 });
    await summaryIs(sound, "Tavern night at dusk · 1 of 2 · Paused · 1 background sound");
    await ops.send({ t: "music.stop" });
    await summaryIs(sound, "1 background sound");
    await ops.send({ t: "sound.stopAll" });
    await summaryIs(sound, "Nothing is playing");

    const row = panel.locator("[data-group-open]");
    await ops.send({ t: "scene.update", sceneId: run.scene, patch: { weather: { kind: "rain", heavy: true, wind: "strong" } } });
    await summaryIs(row, "Heavy rain · Strong wind");
    assert.equal(await row.getAttribute("aria-label"), "Weather: Heavy rain · Strong wind, in Goblin cave's settings");
    await shots.take(dm, "am-5-folded-summaries");
    // The DM looks at another scene: the row follows the DM's own.
    await openSideTab(dm, "Scenes");
    await dm.getByRole("tabpanel", { name: sideTabName("Scenes") }).getByRole("button", { name: /^Crypt/ }).first().click();
    await waitFor("the DM on Crypt", () => (dmSocket.you?.sceneId === run.other ? true : null));
    const again = await ambiance();
    await summaryIs(again.locator("[data-group-open]"), "Clear");
    assert.equal(await again.locator("[data-group-open]").getAttribute("aria-label"), "Weather: Clear, in Crypt's settings");
    assert.deepEqual(alignmentLines(await measureAlignment(again), "Ambiance folded, 1440x900"), []);
    await openSideTab(dm, "Scenes");
    await dm.getByRole("tabpanel", { name: sideTabName("Scenes") }).getByRole("button", { name: /^Goblin cave/ }).first().click();
    await waitFor("the DM back on Goblin cave", () => (dmSocket.you?.sceneId === run.scene ? true : null));
    await forgetFolds();
  });

  test("am-5b. with Time open and a Sound subpage in its place, a clock step from another device comes as a toast", async (t) => {
    t.after(() => forgetFolds());
    if (!dmSocket.state?.clock) await startClock();
    await openSideTab(dm, "Log");
    const panel = await ambiance();
    await openGroup(panel, "Time");
    await openGroup(panel, "Sound");
    await panel.getByRole("button", { name: /^Tavern night/ }).first().click();
    await dm.getByRole("button", { name: /^Back to Ambiance/ }).first().waitFor();
    assert.equal(await panel.locator("[data-clock-date]").count(), 0, "the subpage stands in for Time");
    await ops.send({ t: "clock.advance", by: 2 * HOUR });
    await dm.getByText(/^2 hours pass\. It is now /).first().waitFor();
    await dm.getByRole("button", { name: /^Back to Ambiance/ }).first().click();
    await panel.getByRole("heading", { name: "Music", exact: true }).waitFor();
    assert.equal(await expanded(panel, "Time"), true, "Time's fold stayed open under the subpage");
  });

  test("am-1f. Ambiance measured at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, folded and open: nothing over 1 px", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
      await forgetFolds();
      await dm.setViewportSize(DESK);
      await reload(dm);
    });
    if (!dmSocket.state?.clock) await startClock();
    await playMusic();
    await ops.send({ t: "loop.start", id: randomUUID(), soundId: run.loop, volume: 70 });
    for (const scale of ["1", "1.3"]) {
      for (const size of [DESK, PHONE, SMALL]) {
        await dm.setViewportSize(size);
        await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", s), scale);
        await forgetFolds();
        await reload(dm);
        const wide = size.width / Number(scale) >= 900;
        const root = wide ? await ambiance() : await ambianceSheet(dm);
        const where = `${size.width}x${size.height} at ${Number(scale) * 100}%`;
        assert.deepEqual(alignmentLines(await measureAlignment(root), `Ambiance at its start, ${where}`), []);
        await fold(root, "Sound").click();
        assert.deepEqual(alignmentLines(await measureAlignment(root), `Ambiance all folded, ${where}`), []);
        await fold(root, "Time").click();
        await fold(root, "Sound").click();
        assert.deepEqual(alignmentLines(await measureAlignment(root), `Ambiance all open, ${where}`), []);
        await shots.take(dm, `am-1f-${size.width}-${scale}`);
      }
    }
  });

  test("am-6a. Pat's Ambiance is listed while the clock is shared or something plays, keeps a section once shown, and holds no folds", async () => {
    await stopClock();
    await ops.send({ t: "sound.stopAll" });
    const panels = pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ });
    const list = pat.getByRole("region", { name: "Panels" });
    await panels.click();
    assert.equal(await list.getByRole("button", { name: /^Ambiance/ }).count(), 0, "nothing shared or playing: not listed");
    await pat.keyboard.press("Escape");
    await startClock();
    await waitFor("Pat's clock", () => (patSocket.state?.clock ? true : null));
    const sheet = await ambianceSheet(pat);
    await sheet.locator("[data-clock-date]").waitFor();
    assert.deepEqual(await sheet.locator("[data-group-name]").allTextContents(), ["Time"]);
    assert.equal(await sheet.locator("[data-group-fold], [data-group-open]").count(), 0, "no folds and no Weather row for a player");
    await playMusic();
    await waitFor("Sound under Time", async () => ((await sheet.locator("[data-group-name]").allTextContents()).join() === "Time,Sound" ? true : null));
    assert.deepEqual(alignmentLines(await measureAlignment(sheet), "Pat's Ambiance, 390x844"), []);
    await ops.send({ t: "clock.update", shown: false });
    await sheet.getByText("The DM isn't sharing the date and time now.", { exact: true }).waitFor();
    await shots.take(pat, "am-6a-pat-kept-time");
    // Across 900 px the panel remounts in the side panel, and the kept Time goes with it.
    await pat.setViewportSize({ width: 1024, height: 768 });
    const side = pat.getByRole("tabpanel", { name: sideTabName("Ambiance") });
    await side.getByText("The DM isn't sharing the date and time now.", { exact: true }).waitFor();
    await openSideTab(pat, "Log");
    await ops.send({ t: "sound.stopAll" });
    await waitFor("no Ambiance tab", async () => ((await pat.getByRole("tablist", { name: "Panels" }).getByRole("tab", { name: sideTabName("Ambiance") }).count()) === 0 ? true : null));
    await ops.send({ t: "clock.update", shown: true });
  });

  test("am-6b. a restored split with Sound's old id, and a reload asking for Time's, open Pat's Ambiance on its one line with nothing to show", async () => {
    await stopClock();
    await pat.evaluate(() => localStorage.setItem("rvtt.sidePanelSplit", JSON.stringify({ player: { top: "tracker", below: "sound" } })));
    await reload(pat);
    const below = pat.getByRole("group", { name: "Ambiance below", exact: true });
    await below.getByText("The DM isn't sharing the date and time or playing sound now.", { exact: true }).waitFor();
    assert.deepEqual(alignmentLines(await measureAlignment(below), "Pat's empty Ambiance, 1024x768"), []);
    assert.equal(await below.locator("[data-panel-group]").count(), 0);
    await shots.take(pat, "am-6b-pat-empty");
    await pat.evaluate(() => localStorage.removeItem("rvtt.sidePanelSplit"));
    await pat.evaluate((roomId) => sessionStorage.setItem("rvtt.reopen", JSON.stringify({ roomId, panel: "time" })), run.roomId);
    await reload(pat);
    await pat.getByRole("tabpanel", { name: sideTabName("Ambiance") }).getByText("The DM isn't sharing the date and time or playing sound now.", { exact: true }).waitFor();
    await pat.setViewportSize(PHONE);
    await reload(pat);
  });

  test("am-6c. Pat's clock chip, press after press with Time scrolled above the pane, brings Time's header to the top", async (t) => {
    t.after(async () => {
      await ops.send({ t: "sound.stopAll" });
      await stopClock();
      await pat.setViewportSize(PHONE);
    });
    await startClock();
    await playMusic();
    await waitFor("Pat's clock and music", () => (patSocket.state?.clock && patSocket.state.playing?.music ? true : null));
    // The chip is in the bar from 900 px up. A short window, so Time and Sound overflow the side panel.
    await pat.setViewportSize({ width: 1024, height: 480 });
    const chip = pat.getByRole("button", { name: /^Time: / });
    await chip.click();
    const sheet = pat.getByRole("tabpanel", { name: sideTabName("Ambiance") });
    const time = sheet.locator("[data-panel-group]").filter({ has: pat.locator("[data-group-name]", { hasText: /^Time$/ }) });
    await sheet.locator("[data-group-name]", { hasText: /^Sound$/ }).waitFor();
    for (let press = 1; press <= 3; press++) {
      await scrollPanel(time, Infinity);
      const away = await inScroller(time);
      assert.ok(away.top < -8, `press ${press}: Time's header above the pane before the chip (${away.top} px)`);
      await chip.click();
      await waitFor(`press ${press}: Time's header at the top`, async () => (Math.abs((await inScroller(time)).top) <= 8 ? true : null), 5_000).catch(async () => assert.fail(`press ${press}: Time's header ${(await inScroller(time)).top} px from the top of the body`));
    }
    await shots.take(pat, "am-6c-pat-chip-brings-time");
  });

  test("am-4a. the Weather row on a phone and at 320 x 568 and 130%: Scenes takes the sheet with Light and weather open, never written, the Weather select focused and whole in view", async (t) => {
    t.after(() => dm.evaluate(() => localStorage.removeItem("rvtt.uiScale")));
    for (const [size, scale] of [[PHONE, "1"], [SMALL, "1.3"]] as const) {
      await dm.setViewportSize(size);
      await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", s), scale);
      await reload(dm);
      const sheet = await ambianceSheet(dm);
      await sheet.locator("[data-group-open]").click();
      const scenes = dm.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]');
      await scenes.waitFor();
      const light = scenes.getByRole("button", { name: "Light and weather", exact: true });
      await light.waitFor();
      assert.equal(await light.getAttribute("aria-expanded"), "true");
      const select = scenes.getByRole("combobox", { name: "Weather", exact: true });
      await waitFor("the Weather select focused", () => select.evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)));
      const at = await inScroller(select);
      assert.ok(at.top >= 0 && at.bottom >= 0, `the Weather select whole in the sheet at ${size.width} x ${size.height} and ${Number(scale) * 100}% (${JSON.stringify(at)})`);
      const stored = await dm.evaluate(() => JSON.parse(localStorage.getItem("rvtt.sceneSettingsFolds") ?? "{}") as Record<string, boolean>);
      assert.equal(stored.light, undefined, "a reveal is never written");
      await shots.take(dm, `am-4a-weather-opens-scenes-${size.width}-${scale}`);
      await closeSheet(scenes);
    }
    // A reveal over a stored fold lasts until Scenes closes: a reload finds the fold as stored.
    await dm.evaluate(() => localStorage.setItem("rvtt.sceneSettingsFolds", JSON.stringify({ light: false })));
    await reload(dm);
    await (await ambianceSheet(dm)).locator("[data-group-open]").click();
    const scenes = dm.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]');
    await waitFor("Light and weather revealed", async () => ((await scenes.getByRole("button", { name: "Light and weather", exact: true }).getAttribute("aria-expanded")) === "true" ? true : null));
    await reload(dm);
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Scenes/ }).click();
    const light = scenes.getByRole("button", { name: "Light and weather", exact: true });
    await light.waitFor();
    assert.equal(await light.getAttribute("aria-expanded"), "false", "the stored fold, after a reload");
    await dm.evaluate(() => localStorage.removeItem("rvtt.sceneSettingsFolds"));
    await closeSheet(scenes);
  });

  test("am-4b. with two panels the Weather and Scene sound rows open Scenes in the other pane, each group open and focused, and Ambiance stays", async () => {
    await dm.setViewportSize(DESK);
    await forgetFolds();
    await dm.evaluate(() => localStorage.setItem("rvtt.sidePanelSplit", JSON.stringify({ dm: { top: "tracker", below: "ambiance" } })));
    await reload(dm);
    const below = dm.getByRole("group", { name: "Ambiance below", exact: true });
    const top = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
    await below.locator("[data-group-open]").click();
    await top.waitFor();
    const select = top.getByRole("combobox", { name: "Weather", exact: true });
    await waitFor("the Weather select focused", () => select.evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)));
    assert.equal(await top.getByRole("button", { name: "Light and weather", exact: true }).getAttribute("aria-expanded"), "true");
    await below.getByRole("button", { name: "Scene sound, in Scenes", exact: true }).click();
    await below.waitFor();
    const group = top.getByRole("button", { name: "Scene sound", exact: true });
    assert.equal(await group.getAttribute("aria-expanded"), "true");
    await waitFor("Scene sound's fold focused", () => group.evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)));
    await shots.take(dm, "am-4b-two-panels");
    await dm.evaluate(() => localStorage.removeItem("rvtt.sidePanelSplit"));
  });

  test("am-4d. a tall sheet under 900 px with little under each group: the Scene sound and Weather rows move only Scenes' body, its header in view, and send no wheel", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.sceneSettingsFolds"));
      await dm.setViewportSize(DESK);
      await reload(dm);
    });
    await dm.setViewportSize(TABLET);
    await forgetFolds();
    await dm.evaluate(() => localStorage.removeItem("rvtt.sceneSettingsFolds"));
    await reload(dm);
    const scenes = dm.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]');
    for (const row of ["Scene sound", "Weather"] as const) {
      const sheet = await ambianceSheet(dm);
      // The request takes the scroller over with its own event: a wheel would also reach every wheel listener on the page, the keyboard's own among them (lib/keyboardInset.ts).
      await dm.evaluate(() => {
        const g = globalThis as unknown as { rvttWheels?: number; document: { addEventListener(type: string, f: () => void, o: { capture: boolean }): void } };
        g.rvttWheels = 0;
        g.document.addEventListener("wheel", () => void (g.rvttWheels = (g.rvttWheels ?? 0) + 1), { capture: true });
      });
      if (row === "Weather") await sheet.locator("[data-group-open]").click();
      else await sheet.getByRole("button", { name: "Scene sound, in Scenes", exact: true }).click();
      const focused = row === "Weather" ? scenes.getByRole("combobox", { name: "Weather", exact: true }) : scenes.getByRole("button", { name: "Scene sound", exact: true });
      await waitFor(`${row}: focus taken`, () => focused.evaluate((el) => (el === el.ownerDocument.activeElement ? true : null)));
      const head = scenes.getByRole("button", { name: row === "Weather" ? "Light and weather" : "Scene sound", exact: true });
      assert.deepEqual(await framesScrolled(head), [], `${row}: nothing around Scenes' body scrolled`);
      assert.equal(await dm.evaluate(() => (globalThis as unknown as { rvttWheels?: number }).rvttWheels), 0, `${row}: no wheel event sent`);
      const close = await scenes.getByRole("button", { name: /^Close / }).first().boundingBox();
      assert.ok(close && close.y >= 0, `${row}: the sheet's header in view (${JSON.stringify(close)})`);
      const at = await inScroller(focused);
      assert.ok(at.top >= 0 && at.bottom >= 0, `${row}: ${row === "Weather" ? "the Weather select" : "the group's fold"} whole in the sheet (${JSON.stringify(at)})`);
      await shots.take(dm, `am-4d-tall-sheet-${row === "Weather" ? "weather" : "scene-sound"}`);
      await closeSheet(scenes);
    }
  });

  test("am-4c. a room with no scene: the Weather row says No scene and only opens Scenes, New scene starts open and a fold of it is kept, and the first scene made scrolls to nothing", async (t) => {
    t.after(async () => {
      await dm.evaluate(() => localStorage.removeItem("rvtt.sceneSettingsFolds"));
      await dm.setViewportSize(DESK);
    });
    run.bare = await noSceneRoom();
    await dm.setViewportSize(PHONE);
    await dm.goto(`${server.origin}/r/${run.bare}`);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.getByText("Create a scene to get started.", { exact: true }).waitFor();
    await dm.evaluate((key) => {
      localStorage.removeItem(key);
      localStorage.removeItem("rvtt.sceneSettingsFolds");
    }, FOLDS_KEY);
    await reload(dm);
    const scenes = dm.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]');
    const newScene = scenes.getByRole("button", { name: "New scene", exact: true });
    const sceneFolds = () => dm.evaluate(() => JSON.parse(localStorage.getItem("rvtt.sceneSettingsFolds") ?? "{}") as Record<string, boolean>);

    // The row names no scene and opens Scenes alone: no target, no reveal (scenes-reorg 7, D-261102-934).
    const sheet = await ambianceSheet(dm);
    const row = sheet.locator("[data-group-open]");
    assert.equal(await row.getAttribute("aria-label"), "Weather: no scene, in Scenes");
    await summaryIs(row, "No scene");
    assert.equal(await sheet.getByRole("button", { name: "Scene sound, in Scenes", exact: true }).count(), 0, "no Scene sound row with no scene in view");
    await shots.take(dm, "am-4c-no-scene-ambiance");
    await row.click();
    await newScene.waitFor();
    assert.equal(await newScene.getAttribute("aria-expanded"), "true", "New scene starts open while the room has no scene");
    assert.equal(await scenes.getByRole("button", { name: "Light and weather", exact: true }).count(), 0);
    assert.deepEqual(await sceneFolds(), {}, "nothing written");
    await shots.take(dm, "am-4c-no-scene-scenes");

    // Folded by hand, New scene stays folded when Scenes is closed and opened again.
    await newScene.click();
    assert.deepEqual(await sceneFolds(), { new: false });
    await closeSheet(scenes);
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Scenes/ }).click();
    await newScene.waitFor();
    assert.equal(await newScene.getAttribute("aria-expanded"), "false", "the DM's own fold wins over the start");
    await newScene.click();
    await closeSheet(scenes);

    // The row once more with Scenes left open, then a first battle mat: the new scene's settings take no target, so nothing scrolls to Weather or takes focus.
    // On a short phone the form that starts over after Create still leaves the body scrolled, the one place a browser's own scroll anchoring could move it.
    await dm.setViewportSize(SMALL);
    await (await ambianceSheet(dm)).locator("[data-group-open]").click();
    await newScene.waitFor();
    const form = newScene.locator("xpath=ancestor::*[@data-panel-group][1]");
    const body = form.locator("xpath=ancestor::*[@data-pane-body][1]");
    await form.getByRole("radio", { name: "Battle mat", exact: true }).click();
    await form.getByRole("textbox", { name: "Scene name" }).fill("First mat");
    // The body's offset once Create's commit has drawn the form over, read in the click's own task, before the server's answer can draw the settings.
    await body.evaluate((box) => {
      const win = box.ownerDocument.defaultView as unknown as { startedOver?: number; addEventListener(type: string, fn: () => void, options: { once: boolean }): void };
      win.addEventListener("click", () => queueMicrotask(() => (win.startedOver = box.scrollTop)), { once: true });
    });
    await form.getByRole("button", { name: "Create", exact: true }).click();
    const made = await waitFor("the first scene", () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s.name === "First mat"), 30_000);
    await waitFor("the DM on First mat", () => (dmSocket.you?.sceneId === made.id ? true : null));
    const light = scenes.getByRole("button", { name: "Light and weather", exact: true });
    await light.waitFor();
    await dm.waitForTimeout(500);
    const select = scenes.getByRole("combobox", { name: "Weather", exact: true });
    assert.equal(await select.evaluate((el) => el === el.ownerDocument.activeElement), false, "the Weather select never takes focus");
    const offsets = await body.evaluate((box) => ({ startedOver: (box.ownerDocument.defaultView as unknown as { startedOver?: number }).startedOver ?? null, now: box.scrollTop }));
    assert.ok(offsets.startedOver !== null && offsets.startedOver > 0, `the body still scrolled once the form started over (${JSON.stringify(offsets)})`);
    assert.ok(Math.abs(offsets.now - offsets.startedOver) <= 1, `Scenes' body stayed where the form started over as the first scene's settings drew (${JSON.stringify(offsets)})`);
    assert.ok((await inScroller(light)).top > 8, "Scenes never scrolled Light and weather to its top");
    assert.equal(await newScene.getAttribute("aria-expanded"), "true", "New scene stays open until Scenes closes");
    await shots.take(dm, "am-4c-first-scene");
    await closeSheet(scenes);
  });

  test("am-z. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
